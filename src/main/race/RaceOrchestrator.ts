/**
 * RaceOrchestrator — drives a RaceGroup through its stage machine:
 *
 *   planning(A∥B) → rebuttal(A⇄B, plans frozen) → judging(fuse→annotate/revise)
 *     → building → auditing → (repair↺auditing, bounded) → done
 *
 * It owns race state and control flow only. All session side effects go
 * through the injected `RaceSessionHost` seam, so the orchestrator is
 * decoupled from SessionManager and unit-testable in isolation.
 *
 * Invariant: only the Builder role writes to disk; every other role runs
 * read-only (plan mode / kimi read-only guard), so concurrent role sessions
 * in the same cwd never collide.
 */

import { randomUUID } from 'node:crypto';

import type { EngineId, PermissionMode, UsageInfo } from '@shared/types';
import type {
  RaceAdoptStrategy,
  RaceArtifacts,
  RaceCreateRequest,
  RaceEvent,
  RaceGroup,
  RaceRole,
  RaceRoleConfig,
  RaceStage,
  RaceWorkStage,
  RacerRole,
} from '@shared/race';
import { RACER_ROLES, resolveRoleMode } from '@shared/race';
import { log } from '../log/logger';
import {
  auditPrompt,
  builderPrompt,
  continuePrompt,
  judgeFusePrompt,
  judgeRevisePrompt,
  parseAuditVerdict,
  planPrompt,
  rebuttalPrompt,
  repairPrompt,
  roleSessionTitle,
  withGuard,
} from './racePrompts';
import { L } from '../i18n';

/** Session spawn spec handed to the host. */
export interface RaceSpawnSpec {
  engine: EngineId;
  cwd: string;
  modelId: string;
  permissionMode: PermissionMode;
  title: string;
  /** 所属赛马 id —— 角色会话的侧栏隐藏标记（寄生于宿主对话）。 */
  raceId: string;
}

/**
 * The seam between the orchestrator and the session/engine layer.
 * Implemented by a thin adapter over SessionManager (see main wiring).
 */
export interface RaceSessionHost {
  /** Create a role session; resolves to its app-level session id. */
  spawn(spec: RaceSpawnSpec): Promise<string>;
  /** Dispatch a prompt to a session (awaits engine readiness internally). */
  prompt(sessionId: string, text: string, effort?: string): Promise<void>;
  /** 取消会话当前回合（剔除选手时就地叫停其运行中回合）。 */
  cancelTurn(sessionId: string): void;
  /** Fold a session's assistant output into plain text (for hand-off). */
  transcript(sessionId: string): string;
  /** A textual digest of the builder's file changes (for the auditor). */
  changesDigest(sessionId: string): Promise<string>;
  /** Subscribe to one turn completion on a session; returns unsubscribe.
   *  usage 为本次交卷所含全部内部回合的 token 用量累计（可缺省）；
   *  quotaExhausted 标记本次失败是否坐实为额度耗尽（引擎在 turn.ended
   *  前完成核实）。 */
  onTurnEnded(sessionId: string, cb: (stopReason: string, usage?: UsageInfo, quotaExhausted?: boolean) => void): () => void;
  /** Push a race-level event to the renderer. */
  emit(raceId: string, event: RaceEvent): void;
  /** Persist the current set of race groups. */
  persist(groups: RaceGroup[]): void;
}

/** Transient per-race artifacts — superseded: 产物现在直接落在
 *  RaceGroup.artifacts（持久化 + race.artifacts 事件推送裁判预览）。 */

const DEFAULT_MAX_REPAIR = 3;

/** runTurn 拒绝错误里的额度耗尽哨兵：嵌在 message 里传给 runTurnWithRetry
 *  （Error 无自定义字段，避免靠英文文案匹配）。 */
const QUOTA_FLAG = ' [quotaExhausted]';

export class RaceOrchestrator {
  private readonly groups = new Map<string, RaceGroup>();
  /** 选手阶段链（规划/反驳）存活标记：链活着时单选手重试不代为推进阶段。 */
  private readonly chainActive = new Set<string>();
  /** 进行中的泳道级重试（`raceId:role`）：链收尾时若缺产物的选手正被
   *  重试接管，链让位退出而非抛旧错（防“重试在跑却弹异常横幅”）。 */
  private readonly retrying = new Set<string>();
  /** 进行中回合等待的唤醒句柄（sessionId → abort）：剔除僵死选手时
   *  主动 reject 其等待，防止阶段链永久挂起。 */
  private readonly pendingTurns = new Map<string, () => void>();
  /** 代际计数：重跑规划（restartPlanning）会 bump，旧阶段链收尾时
   *  发现代际不符 → 静默退出，不报错不推进（防旧链尸变干扰新链）。 */
  private readonly gen = new Map<string, number>();
  /** 当前阶段的计时起点（raceId → ms）：阶段切换时结转墙钟增量进
   *  stats；仅内存态，重启后由 resume 重新起表（停机时段不计时）。 */
  private readonly stageEnteredAt = new Map<string, number>();

  constructor(private readonly host: RaceSessionHost, persisted?: RaceGroup[]) {
    for (const g of persisted ?? []) this.groups.set(g.id, g);
  }

  list(): RaceGroup[] {
    return [...this.groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(raceId: string): RaceGroup | undefined {
    return this.groups.get(raceId);
  }

  /** Start a new race: create the record and kick off planning. */
  create(req: RaceCreateRequest): RaceGroup {
    const now = Date.now();
    const g: RaceGroup = {
      id: randomUUID(),
      prompt: req.prompt,
      cwd: req.cwd,
      roles: req.roles,
      stage: 'planning',
      sessions: {},
      finalPlanVersion: 1,
      annotations: [],
      repairRound: 0,
      maxRepairRounds: req.maxRepairRounds ?? DEFAULT_MAX_REPAIR,
      parentSessionId: req.parentSessionId,
      contextSeed: req.contextSeed,
      createdAt: now,
      updatedAt: now,
    };
    this.groups.set(g.id, g);
    this.touch(g);
    log.info('race', 'race created', {
      raceId: g.id,
      cwd: g.cwd,
      promptChars: g.prompt.length,
      roles: Object.fromEntries(Object.entries(g.roles).map(([r, c]) => [r, `${c.engine}${c.modelId ? ':' + c.modelId : ''}`])),
      maxRepairRounds: g.maxRepairRounds,
      parentSessionId: g.parentSessionId,
    });
    this.setStage(g, 'planning');
    void this.safe(g.id, () => this.runPlanning(g));
    return g;
  }

  /** 用户选定采纳策略（4 选 1 + 可选评语）→ 裁判据此产出最终方案 v1。 */
  adoptStrategy(raceId: string, strategy: RaceAdoptStrategy, comment?: string): void {
    const g = this.groups.get(raceId);
    if (!g || g.stage !== 'judging' || g.adopt) return;
    g.adopt = { strategy, comment };
    this.touch(g);
    void this.safe(raceId, () => this.runFuse(g));
  }

  /** 裁判按已定策略出方案（adoptStrategy 与重启恢复共用）。 */
  private async runFuse(g: RaceGroup): Promise<void> {
    const adopt = g.adopt;
    if (!adopt) return;
    const judgeId = await this.ensureRole(g, 'judge');
    const cfg = g.roles.judge;
    const art = g.artifacts ?? {};
    const plan = await this.runTurnWithRetry(
      g,
      judgeId,
      withGuard(
        judgeFusePrompt(
          g.prompt,
          this.racersOf(g).map((r) => ({
            label: this.racerLetter(r),
            plan: art[this.planKeyOf(r)] ?? '',
            rebuttal: art[this.rebutKeyOf(r)] ?? '',
          })),
          adopt.strategy,
          adopt.comment,
          (g.eliminated ?? []).map((r) => this.racerLetter(r)),
        ),
        this.needsGuard('judge', cfg),
      ),
      cfg,
    );
    // 首次出方案为 v1；手动重新出方案（rerunJudge，如换裁判后）时 v+1
    // 覆盖展示（旧方案文本在弃用的旧裁判会话历史中仍可回看）。
    const version = g.finalPlan ? g.finalPlanVersion + 1 : 1;
    g.finalPlan = plan;
    g.finalPlanVersion = version;
    this.touch(g);
    this.host.emit(g.id, { type: 'race.finalPlan', version, text: plan });
  }

  /** 让裁判按既定采纳策略重新出方案（换裁判引擎后手动重跑）：叫停
   *  进行中的裁判回合，弃用旧会话后重跑 fuse；新方案以 v+1 覆盖
   *  展示。仅裁判环节且已选策略时可用。 */
  rerunJudge(raceId: string): void {
    const g = this.groups.get(raceId);
    if (!g || g.stage !== 'judging' || !g.adopt) return;
    const judgeId = g.sessions.judge;
    if (judgeId) {
      this.host.cancelTurn(judgeId);
      this.pendingTurns.get(judgeId)?.();
      this.pendingTurns.delete(judgeId);
      // 白纸重来：弃用旧裁判会话（只断引用不删数据，旧会话及历史
      // 照常持久化可回看），runFuse 里 ensureRole 以原配置重建全新
      // 会话 —— 避免上一版方案留在上文锚定新输出（与重跑规划、换
      // 引擎重建同义；fuse 提示词自包含全部输入，换会话不丢上下文）。
      delete g.sessions.judge;
      this.touch(g);
    }
    void this.safe(g.id, () => this.runFuse(g));
  }

  /** Judge revision loop: apply a user annotation and re-fuse. */
  reviseJudge(raceId: string, annotation: string): void {
    const g = this.groups.get(raceId);
    if (!g || g.stage !== 'judging') return;
    g.annotations.push(annotation);
    this.touch(g);
    void this.safe(raceId, () => this.runRevise(g, annotation));
  }

  /** 按批注修订方案（reviseJudge 与重启恢复共用）。 */
  private async runRevise(g: RaceGroup, annotation: string): Promise<void> {
    const judgeId = await this.ensureRole(g, 'judge');
    const cfg = g.roles.judge;
    const plan = await this.runTurnWithRetry(
      g,
      judgeId,
      withGuard(judgeRevisePrompt(g.finalPlan ?? '', annotation), this.needsGuard('judge', cfg)),
      cfg,
    );
    g.finalPlan = plan;
    g.finalPlanVersion += 1;
    this.touch(g);
    this.host.emit(g.id, { type: 'race.finalPlan', version: g.finalPlanVersion, text: plan });
  }

  /** ④a 反悔：撤回采纳决策（仅裁判尚未出方案时）—— 叫停裁判进行中
   *  的回合，回到「选择采纳策略」关口重选；已出方案后不提供
   *  （那时用批注修订道义更顺）。 */
  revokeAdopt(raceId: string): void {
    const g = this.groups.get(raceId);
    if (!g || g.stage !== 'judging' || !g.adopt || g.finalPlan) return;
    const judgeId = g.sessions.judge;
    if (judgeId) {
      this.host.cancelTurn(judgeId);
      // 先同步唤醒（superseded 静默路径），后到的 cancelled 事件无人
      // 监听 → 不会误弹错误横幅。
      this.pendingTurns.get(judgeId)?.();
      this.pendingTurns.delete(judgeId);
    }
    g.adopt = undefined;
    this.touch(g);
    // 复播阶段事件：前端顺带清错误横幅；快照由 store 动作 refresh。
    this.host.emit(g.id, { type: 'race.stage', stage: 'judging' });
  }

  /** User approved the final plan → hand off to the Builder. */
  finalize(raceId: string): void {
    const g = this.groups.get(raceId);
    if (!g || g.stage !== 'judging' || !g.finalPlan) return;
    // 同步先切阶段：堵住双击/重复 IPC 导致的 Builder 双发 prompt。
    this.setStage(g, 'building');
    void this.safe(raceId, () => this.runBuilding(g));
  }

  /** 重试前调整角色配置（选手 A/B/C 与裁判）；引擎/模型变更时弃用
   *  旧会话（保留为普通会话），重跑阶段时以新配置重建。 */
  updateRole(raceId: string, role: RaceRole, cfg: RaceRoleConfig): void {
    const g = this.groups.get(raceId);
    if (!g || g.stage === 'done') return;
    if (role === 'judge') return this.updateJudge(g, cfg);
    if (!(RACER_ROLES as readonly string[]).includes(role)) return;
    const racer = role as RacerRole;
    const prev = g.roles[racer];
    if (!prev || g.eliminated?.includes(racer)) return; // 未参赛/已剔除不接受调整
    if (prev.engine === cfg.engine && prev.modelId === cfg.modelId && prev.effort === cfg.effort) return;
    const respawn = prev.engine !== cfg.engine || prev.modelId !== cfg.modelId;
    g.roles = { ...g.roles, [racer]: cfg };
    if (respawn) delete g.sessions[racer]; // effort 只影响下次 prompt，不必重建
    // 调整了谁，谁当前阶段的产物作废 → 重试时只重跑该选手（其余产物保留跳过）。
    const art = { ...g.artifacts };
    if (g.stage === 'planning') {
      delete art[this.planKeyOf(racer)];
      delete art[this.rebutKeyOf(racer)];
    } else if (g.stage === 'rebuttal') {
      delete art[this.rebutKeyOf(racer)];
    }
    g.artifacts = art;
    this.touch(g);
    this.host.emit(g.id, { type: 'race.artifacts', artifacts: art });
    // 符合直觉：改完配置就是为了让它跑。阶段链已停摆（错误态）且
    // 处在选手阶段 → 自动重跑该选手当前回合（新引擎/模型重建会话）；
    // 链还活着则不插手，等它自己收尾。judging 阶段仍需配合「↩ 重跑规划」。
    if (!this.chainActive.has(g.id) && (g.stage === 'planning' || g.stage === 'rebuttal')) {
      this.retryRacer(raceId, racer);
    }
  }

  /** 裁判同样支持改引擎/模型/思考档后重新执行：出方案（fuse）/按批注
   *  修订（revise）进行中或已报错时，保存即叫停旧回合并按新配置自动
   *  重跑该步（fuse/revise 提示词自包含全部输入，换会话不丢上下文）；
   *  纯等待态（等选策略/等批注）只落配置，下一步自然生效。 */
  private updateJudge(g: RaceGroup, cfg: RaceRoleConfig): void {
    const prev = g.roles.judge;
    if (prev.engine === cfg.engine && prev.modelId === cfg.modelId && prev.effort === cfg.effort) return;
    const respawn = prev.engine !== cfg.engine || prev.modelId !== cfg.modelId;
    g.roles = { ...g.roles, judge: cfg };
    const judgeId = g.sessions.judge;
    const running = judgeId ? this.pendingTurns.has(judgeId) : false;
    if (respawn && judgeId) {
      // 换引擎/模型：叫停旧回合（superseded 静默退场，不弹错误横幅），
      // 弃用旧会话（仅断引用，会话及历史照常保留可查）。
      this.host.cancelTurn(judgeId);
      this.pendingTurns.get(judgeId)?.();
      this.pendingTurns.delete(judgeId);
      delete g.sessions.judge;
    }
    this.touch(g);
    if (g.stage !== 'judging') return; // 裁判环节之外只落配置
    // 仅思考档变更且旧回合还在跑 → 不打断，新档位下一回合生效。
    if (!respawn && running) return;
    if (g.adopt && !g.finalPlan) {
      void this.safe(g.id, () => this.runFuse(g));
    } else if (g.finalPlan && g.annotations.length >= g.finalPlanVersion) {
      void this.safe(g.id, () => this.runRevise(g, g.annotations[g.annotations.length - 1]!));
    }
  }

  /** 单选手重试：只补跑该选手当前阶段回合（另一侧产物/进行中回合不受
   *  影响）；若补齐后双产物齐且阶段链已死，由此处代为推进下一阶段。
   *  重试 = 清历史重做：先弃用旧会话（只断引用不删数据，侧栏可回看），
   *  ensureRole 以原配置重建全新会话白纸重跑，避免旧失败尝试锚定新回合。 */
  retryRacer(raceId: string, role: RaceRole): void {
    const g = this.groups.get(raceId);
    if (!g || (g.stage !== 'planning' && g.stage !== 'rebuttal')) return;
    if (!(RACER_ROLES as readonly string[]).includes(role)) return;
    const racer = role as RacerRole;
    if (!g.roles[racer] || g.eliminated?.includes(racer)) return;
    const key = g.stage === 'planning' ? this.planKeyOf(racer) : this.rebutKeyOf(racer);
    if (g.artifacts?.[key]) return;
    const tag = `${raceId}:${racer}`;
    if (this.retrying.has(tag)) return; // 防重复点击双发
    this.retrying.add(tag);
    // 弃用旧会话清历史：stage prompt 自包含任务+对手产物，不依赖旧对话记忆。
    const old = g.sessions[racer];
    if (old) {
      this.host.cancelTurn(old);
      this.pendingTurns.get(old)?.();
      this.pendingTurns.delete(old);
      delete g.sessions[racer];
    }
    this.clearInterrupted(g);
    void this.safe(raceId, async () => {
      const sessionId = await this.ensureRole(g, racer);
      await this.runRacerTurn(g, racer, sessionId, key, this.racerStagePrompt(g, racer));
      this.advanceIfChainDead(g);
    }).finally(() => this.retrying.delete(tag));
  }

  /** 额度耗尽切号后的断点续跑：【保留会话 + conversation_id】发「继续」
   *  让该选手从断点接续（agy 额度小，切号是常规续命操作，不是重做 —— 已烧
   *  的额度与产出不该作废）。续跑失败（如 conversation db 已被清、断点已脏）
   *  兜底回退白纸重跑当前阶段。只补跑缺产物的那名选手，不动其余。 */
  retryRacerIfMissing(raceId: string, role: RaceRole): void {
    const g = this.groups.get(raceId);
    if (!g || (g.stage !== 'planning' && g.stage !== 'rebuttal')) return;
    if (!(RACER_ROLES as readonly string[]).includes(role)) return;
    const racer = role as RacerRole;
    const key = g.stage === 'planning' ? this.planKeyOf(racer) : this.rebutKeyOf(racer);
    if (g.artifacts?.[key]) return; // 已有产物（切号期间对手/自己补齐）→ 不重跑
    const tag = `${raceId}:${racer}`;
    if (this.retrying.has(tag)) return;
    this.retrying.add(tag);
    const sid = g.sessions[racer];
    this.clearInterrupted(g);
    void this.safe(raceId, async () => {
      if (sid) {
        // 续接模式：不重建会话，agy 下一次 prompt 带 --conversation 续上。
        try {
          await this.runRacerTurn(g, racer, sid, key, continuePrompt());
          this.advanceIfChainDead(g);
          return;
        } catch (err) {
          // 被剔除/被打断是预期内静默退场，不兜底重跑（新链会接管）。
          const msg = err instanceof Error ? err.message : String(err);
          if (g.eliminated?.includes(racer) || msg.includes('superseded')) return;
          log.warn('race', 'quota-resume continue failed, falling back to a fresh re-run', { raceId, racer }, err);
          delete g.sessions[racer]; // 断点已不可续 → 弃旧会话，走白纸重跑
        }
      }
      // 兜底白纸重跑（无会话可续 / 续接失败）。
      const sessionId = await this.ensureRole(g, racer);
      await this.runRacerTurn(g, racer, sessionId, key, this.racerStagePrompt(g, racer));
      this.advanceIfChainDead(g);
    }).finally(() => this.retrying.delete(tag));
  }

  /** 摘掉打断标记（重试/续跑 = 恢复运行），免得链被此路径拉活后
   *  「继续赛马」横幅卡死（resume 的防双发守卫会早退不再清它）。 */
  private clearInterrupted(g: RaceGroup): void {
    if (g.interrupted) {
      g.interrupted = false;
      this.touch(g);
    }
  }

  /** 阶段链已死且当前阶段产物已齐 → 代为推进下一阶段（链活着则由它推进）。 */
  private advanceIfChainDead(g: RaceGroup): void {
    if (this.chainActive.has(g.id)) return;
    if (g.stage === 'planning' && this.stageComplete(g, 'plan')) {
      void this.runRebuttal(g);
    } else if (g.stage === 'rebuttal' && this.stageComplete(g, 'rebuttal')) {
      void this.runJudging(g);
    }
  }

  /** 对双方方案不满意 → 清空产物回炉重赛（仅裁判选策略前允许；
   *  出方案/执行之后不提供回退）。重赛 = 重新参赛：弃用各选手旧
   *  会话（保留可回看，不删数据），以原配置重建全新会话白纸重来，
   *  不带上一轮记忆（避免旧思路锚定，与调整引擎后的重跑行为对齐）。 */
  restartPlanning(raceId: string): void {
    const g = this.groups.get(raceId);
    if (!g) return;
    if (g.stage !== 'planning' && g.stage !== 'rebuttal' && g.stage !== 'judging') return;
    if (g.adopt || g.finalPlan) return;
    // 开新代：旧阶段链（若还活着）收尾时会因代际不符静默退出；
    // 同时叫停各在场选手的运行中回合并唤醒僵死等待，避免旧回合
    // 的产出污染新一轮（产物已清空，旧回合落盘也无害，但白烧 token）。
    this.gen.set(g.id, (this.gen.get(g.id) ?? 0) + 1);
    for (const r of this.racersOf(g)) {
      const sid = g.sessions[r];
      if (!sid) continue;
      this.host.cancelTurn(sid);
      this.pendingTurns.get(sid)?.();
      this.pendingTurns.delete(sid);
      // 只断引用不删会话 —— 旧会话及其全部历史照常持久化，
      // ensureRole 重跑时会以原引擎/模型 spawn 全新会话。
      delete g.sessions[r];
    }
    this.chainActive.delete(g.id);
    g.artifacts = {};
    g.interrupted = false;
    this.touch(g);
    this.host.emit(g.id, { type: 'race.artifacts', artifacts: g.artifacts });
    this.setStage(g, 'planning');
    void this.safe(g.id, () => this.runPlanning(g));
  }

  /** Abort a race (best-effort): mark done; role sessions are left intact. */
  cancel(raceId: string): void {
    const g = this.groups.get(raceId);
    if (!g) return;
    this.finish(g, false);
  }

  /**
   * 重启后继续被打断的赛马：重跑当前阶段（复用已有角色会话，
   * ensureRuntime 会自动复活引擎进程）。judging 纯等待态无需重跑，
   * 仅重发事件让 UI 对齐。由用户手动触发，不自动（防重启风暴）。
   */
  resume(raceId: string): void {
    const g = this.groups.get(raceId);
    if (!g || g.stage === 'done') return;
    // 先摘打断标记并持久化 —— 即使下面因链还活着而不重跑，也必须消掉
    // 「继续赛马」横幅，否则快照刷新会让横幅复活、可无限点击。
    const wasInterrupted = !!g.interrupted;
    g.interrupted = false;
    // 选手阶段链还活着（回合在跑）时重入会对同一会话双发 prompt ——
    // 此时无需恢复，只消横幅（防误点/重启横幅残留的重复触发）。
    if ((g.stage === 'planning' || g.stage === 'rebuttal') && this.chainActive.has(g.id)) {
      if (wasInterrupted) this.touch(g);
      return;
    }
    // 重启后计时表已丢 → 从继续时刻重新起表（停机时段不计用时）；
    // 本进程内表还活着（错误重试路径）则不重置，墙钟连续累计。
    if (this.isWorkStage(g.stage) && !this.stageEnteredAt.has(g.id)) {
      this.stageEnteredAt.set(g.id, Date.now());
    }
    this.touch(g);
    void this.safe(raceId, async () => {
      switch (g.stage) {
        case 'planning':
          return this.runPlanning(g);
        case 'rebuttal':
          return this.runRebuttal(g);
        case 'judging': {
          // 裁判出方案/修订中被打断 → 重跑那一步；纯等待态 → 重发事件即可。
          if (g.adopt && !g.finalPlan) return this.runFuse(g);
          if (g.finalPlan && g.annotations.length >= g.finalPlanVersion) {
            return this.runRevise(g, g.annotations[g.annotations.length - 1]!);
          }
          this.host.emit(g.id, { type: 'race.stage', stage: g.stage });
          if (g.finalPlan) {
            this.host.emit(g.id, { type: 'race.finalPlan', version: g.finalPlanVersion, text: g.finalPlan });
          }
          return;
        }
        case 'building':
          return this.runBuilding(g);
        case 'auditing':
        case 'repairing':
          // 修复中断 → 直接重审：若仍有问题会自然进入下一轮修复。
          return this.runAuditing(g);
        default:
          return;
      }
    });
  }

  // ------------------------------------------------------------- stages

  private async runPlanning(g: RaceGroup): Promise<void> {
    this.chainActive.add(g.id);
    const myGen = this.gen.get(g.id) ?? 0;
    const racers = this.racersOf(g);
    const ids = await Promise.all(racers.map((r) => this.ensureRole(g, r)));
    // 逐选手落盘：一方失败/被中止不影响其余产物，重试只补跑缺失方。
    const failures = await this.settleRacers(
      racers.map((r, i) => this.runRacerTurn(g, r, ids[i]!, this.planKeyOf(r), this.racerStagePrompt(g, r))),
    );
    // 重跑规划已开新代 → 本链是旧代尸变，静默退出（新链自行推进）。
    if ((this.gen.get(g.id) ?? 0) !== myGen) return;
    // 泳道级重试可能已并行补齐产物 —— 产物齐就静默推进，不报旧错。
    if (!this.stageComplete(g, 'plan')) {
      // 缺产物的选手正被泳道级重试补跑 → 链让位退出（删存活标记，
      // 使重试收尾时接棒推进），不把上一回合的旧错抛成新横幅。
      const pendingRetry = this.racersOf(g).some(
        (r) => !g.artifacts?.[this.planKeyOf(r)] && this.retrying.has(`${g.id}:${r}`),
      );
      if (pendingRetry) {
        this.chainActive.delete(g.id);
        return;
      }
      // 重试恰在两次检查的缝隙间完成 → 复查一次再决定抛错。
      if (this.stageComplete(g, 'plan')) {
        await this.runRebuttal(g);
        return;
      }
      throw new Error(failures.join('；') || L('双规划未完成', 'Dual planning incomplete'));
    }
    await this.runRebuttal(g);
  }

  private async runRebuttal(g: RaceGroup): Promise<void> {
    this.setStage(g, 'rebuttal');
    this.chainActive.add(g.id);
    const myGen = this.gen.get(g.id) ?? 0;
    const racers = this.racersOf(g);
    const ids = await Promise.all(racers.map((r) => this.ensureRole(g, r)));
    const failures = await this.settleRacers(
      racers.map((r, i) => this.runRacerTurn(g, r, ids[i]!, this.rebutKeyOf(r), this.racerStagePrompt(g, r))),
    );
    if ((this.gen.get(g.id) ?? 0) !== myGen) return; // 旧代链静默退出
    if (!this.stageComplete(g, 'rebuttal')) {
      const pendingRetry = this.racersOf(g).some(
        (r) => !g.artifacts?.[this.rebutKeyOf(r)] && this.retrying.has(`${g.id}:${r}`),
      );
      if (pendingRetry) {
        this.chainActive.delete(g.id);
        return;
      }
      if (this.stageComplete(g, 'rebuttal')) {
        await this.runJudging(g);
        return;
      }
      throw new Error(failures.join('；') || L('交叉反驳未完成', 'Cross-rebuttal incomplete'));
    }
    await this.runJudging(g);
  }

  /** 当前阶段下该选手的回合提示词（规划/反驳共用，含只读护栏）。 */
  private racerStagePrompt(g: RaceGroup, role: RacerRole): string {
    const art = g.artifacts ?? {};
    const cfg = g.roles[role]!;
    if (g.stage === 'rebuttal') {
      const own = art[this.planKeyOf(role)] ?? '';
      const opponents = this.racersOf(g)
        .filter((o) => o !== role)
        .map((o) => ({ label: this.racerLetter(o), plan: art[this.planKeyOf(o)] ?? '' }));
      return withGuard(rebuttalPrompt(own, opponents), this.needsGuard(role, cfg));
    }
    // 从对话中发起时可携带父对话摘录 —— 仅作背景资料注入规划回合。
    const task = g.contextSeed
      ? `${g.prompt}\n\n【发起对话背景摘录 · 仅供理解需求背景，非任务本身】\n${g.contextSeed}`
      : g.prompt;
    return withGuard(planPrompt(task), this.needsGuard(role, cfg));
  }

  /** ✂ 剔除选手（标记式，不删数据）：仅三人及以上在场且裁判选
   *  策略前允许，剩余必须 ≥2。被剔者运行中回合就地取消（其失败由
   *  runRacerTurn 的剔除静默分支吞掉）；链已死且剩余产物齐时代为推进。 */
  eliminateRacer(raceId: string, role: RaceRole): void {
    const g = this.groups.get(raceId);
    if (!g) return;
    const window =
      g.stage === 'planning' || g.stage === 'rebuttal' || (g.stage === 'judging' && !g.adopt);
    if (!window) return;
    if (!(RACER_ROLES as readonly string[]).includes(role)) return;
    const racer = role as RacerRole;
    if (!g.roles[racer] || g.eliminated?.includes(racer)) return;
    if (this.racersOf(g).length <= 2) return; // 铁规：剩余 ≥2
    g.eliminated = [...(g.eliminated ?? []), racer];
    this.touch(g);
    this.host.emit(g.id, { type: 'race.eliminated', role: racer });
    const sessionId = g.sessions[racer];
    if (sessionId) {
      this.host.cancelTurn(sessionId);
      // 僵死等待（会话已 idle、不会再有任何事件）也要主动唤醒，
      // 否则阶段链永远挂在被剔者身上（cancelTurn 对 idle 会话是空操作）。
      this.pendingTurns.get(sessionId)?.();
      this.pendingTurns.delete(sessionId);
    }
    // 阶段链活着 → 由它自己收尾（stageComplete 已按新参赛集判定）；
    // 链已死（错误横幅态）且剩余产物齐 → 代为推进，与泳道级重试同款。
    if (this.chainActive.has(g.id)) return;
    if (g.stage === 'planning' && this.stageComplete(g, 'plan')) {
      void this.safe(g.id, () => this.runRebuttal(g));
    } else if (g.stage === 'rebuttal' && this.stageComplete(g, 'rebuttal')) {
      void this.safe(g.id, () => this.runJudging(g));
    }
  }

  /** ✂ 剔除选手后的参赛下限检查由前端按钮可见性兼顾；此处为最终门禁。 */
  private async runRacerTurn(
    g: RaceGroup,
    role: RacerRole,
    sessionId: string,
    key: keyof RaceArtifacts,
    text: string,
  ): Promise<void> {
    if (g.artifacts?.[key]) return;
    const cfg = g.roles[role];
    if (!cfg) return;
    let out: string;
    try {
      // 自动重试发「继续」断点续跑而非重发整段指令：选手阶段提示词还在
      // 引擎会话里，模型侧瞬时错（agy 的 agent error 高发）接着断点干即可。
      out = await this.runTurnWithRetry(g, sessionId, text, cfg, continuePrompt());
    } catch (err) {
      // 回合进行中被剔除，或被主动打断（剔除唤醒/重跑规划叫停）
      // → 都是预期内，静默退场不上浮（新代链/推进者会接管）。
      const msg = err instanceof Error ? err.message : String(err);
      if (g.eliminated?.includes(role) || msg.includes('superseded')) return;
      throw err;
    }
    if (!out.trim()) {
      // 慢热引擎的收尾 flush 可能晚于交卷判定（turn.ended + 静默窗）——
      // 空产物先宽限复读再判异常，避免「只是慢」被误报成「未产出内容」。
      for (let recheck = 0; recheck < 2 && !out.trim(); recheck++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (g.eliminated?.includes(role)) return; // 宽限期间被剔除 → 静默退场
        out = this.host.transcript(sessionId);
      }
      if (!out.trim()) {
        if (g.eliminated?.includes(role)) return;
        throw new Error(L(
          `${this.racerLabel(role)} 未产出内容（回合异常），可重试当前阶段（可先调整其引擎/模型）`,
          `${this.racerLabel(role)} produced no output (abnormal turn) — retry the current stage (optionally adjust its engine/model first)`,
        ));
      }
    }
    // 即使刚被剔除也照常落盘（数据只增不减）：racersOf 已不含它，
    // 产物不会进裁判输入，仅作历史可查。
    g.artifacts = { ...g.artifacts, [key]: out };
    this.touch(g);
    this.host.emit(g.id, { type: 'race.artifacts', artifacts: g.artifacts });
  }

  /** 等各方都收尾（健康选手不被其它选手的失败中断），返回失败信息。 */
  private async settleRacers(turns: Promise<void>[]): Promise<string[]> {
    const results = await Promise.allSettled(turns);
    return results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)));
  }

  // ------------------------------------------------- racer set helpers

  /** 本场参赛选手（A/B 必有；C 仅在发起时启用才存在；剔除者退场）。 */
  private racersOf(g: RaceGroup): RacerRole[] {
    return RACER_ROLES.filter((r) => !!g.roles[r] && !g.eliminated?.includes(r));
  }

  private planKeyOf(r: RacerRole): 'planA' | 'planB' | 'planC' {
    return r === 'racerA' ? 'planA' : r === 'racerB' ? 'planB' : 'planC';
  }

  private rebutKeyOf(r: RacerRole): 'rebuttalA' | 'rebuttalB' | 'rebuttalC' {
    return r === 'racerA' ? 'rebuttalA' : r === 'racerB' ? 'rebuttalB' : 'rebuttalC';
  }

  private racerLetter(r: RacerRole): string {
    return r === 'racerA' ? 'A' : r === 'racerB' ? 'B' : 'C';
  }

  private racerLabel(r: RacerRole): string {
    return L(`选手 ${this.racerLetter(r)}`, `Racer ${this.racerLetter(r)}`);
  }

  /** 本阶段产物是否已齐（所有参赛选手都落盘）。 */
  private stageComplete(g: RaceGroup, kind: 'plan' | 'rebuttal'): boolean {
    const art = g.artifacts ?? {};
    return this.racersOf(g).every((r) => !!art[kind === 'plan' ? this.planKeyOf(r) : this.rebutKeyOf(r)]);
  }

  private async runJudging(g: RaceGroup): Promise<void> {
    this.chainActive.delete(g.id); // 选手阶段链结束
    this.setStage(g, 'judging');
    // 只预热裁判会话，不出方案 —— 等用户先选定采纳策略（adoptStrategy），
    // 再按策略 + 评语产出最终方案；之后进入批注/修订循环直到定稿。
    await this.ensureRole(g, 'judge');
  }

  private async runBuilding(g: RaceGroup): Promise<void> {
    this.setStage(g, 'building');
    const builderId = await this.ensureRole(g, 'builder');
    const cfg = g.roles.builder;
    // Builder writes — no read-only guard.
    await this.runTurnWithRetry(g, builderId, builderPrompt(g.finalPlan ?? ''), cfg);
    await this.runAuditing(g);
  }

  private async runAuditing(g: RaceGroup): Promise<void> {
    this.setStage(g, 'auditing');
    const builderId = g.sessions.builder!;
    const digest = await this.host.changesDigest(builderId);
    const auditorId = await this.ensureRole(g, 'auditor');
    const cfg = g.roles.auditor;
    const out = await this.runTurnWithRetry(
      g,
      auditorId,
      withGuard(auditPrompt(g.finalPlan ?? '', digest), this.needsGuard('auditor', cfg)),
      cfg,
    );
    const verdict = parseAuditVerdict(out);
    g.audit = verdict;
    this.touch(g);
    this.host.emit(g.id, {
      type: 'race.audit',
      passed: verdict.passed,
      issues: verdict.issues,
      repairRound: g.repairRound,
    });
    if (verdict.passed) return this.finish(g, true);
    if (g.repairRound >= g.maxRepairRounds) return this.finish(g, false);
    await this.runRepair(g, verdict.issues);
  }

  private async runRepair(g: RaceGroup, issues: string[]): Promise<void> {
    g.repairRound += 1;
    this.setStage(g, 'repairing');
    const builderId = g.sessions.builder!;
    const cfg = g.roles.builder;
    await this.runTurnWithRetry(g, builderId, repairPrompt(issues), cfg);
    await this.runAuditing(g);
  }

  private finish(g: RaceGroup, delivered: boolean): void {
    this.setStage(g, 'done');
    this.host.emit(g.id, { type: 'race.done', delivered });
  }

  // ------------------------------------------------------------- helpers

  /** 取角色已有会话，没有才新建（重启恢复/重跑阶段时不重复 spawn）。 */
  private async ensureRole(g: RaceGroup, role: RaceRole): Promise<string> {
    const existing = g.sessions[role];
    if (existing) return existing;
    return this.spawnRole(g, role);
  }

  /** Spawn a role's session, record it, and announce to the renderer. */
  private async spawnRole(g: RaceGroup, role: RaceRole): Promise<string> {
    const cfg = g.roles[role];
    if (!cfg) throw new Error(L(`角色未配置：${role}`, `Role not configured: ${role}`));
    const id = await this.host.spawn({
      engine: cfg.engine,
      cwd: g.cwd,
      modelId: cfg.modelId,
      permissionMode: resolveRoleMode(role, cfg),
      title: roleSessionTitle(role, g.prompt),
      raceId: g.id,
    });
    g.sessions[role] = id;
    this.touch(g);
    this.host.emit(g.id, { type: 'race.role', role, sessionId: id });
    return id;
  }

  /** 瞬时错误自动重试一次（用户主动中止/打断/剔除不重试 —— 对
   *  被剔者重发 prompt 是灾难）；仍失败才上浮 race.error 交给用户。
   *  retryText 非空时重试改发它而不是原指令 —— 断点续跑（如 agy 高频的
   *  “Agent execution terminated” 模型侧瞬时错）：会话上下文还在引擎侧，
   *  发「继续」让模型接着断点干，比重发整段指令从头再跑省 token 且不丢
   *  已完成的半段产物。 */
  private async runTurnWithRetry(g: RaceGroup, sessionId: string, text: string, cfg: RaceRoleConfig, retryText?: string): Promise<string> {
    try {
      return await this.runTurn(g, sessionId, text, cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 用户主动中止/打断/被主动唤醒（剔除或重跑规划）不自动重试。
      if (msg.includes('cancelled') || msg.includes('interrupted') || msg.includes('superseded')) throw err;
      // 额度耗尽不盲目重试：重发必撞同一没额度账号（2026-08 实测 1.5s 内
      // 重发即再失败）。把复活交给渲染层切号后的 retryRacer 精确补跑。
      if (this.quotaErr(err)) throw err;
      await new Promise((r) => setTimeout(r, 1500));
      return this.runTurn(g, sessionId, retryText ?? text, cfg);
    }
  }

  /** 从 runTurn 的拒绝错误里识别额度终态（message 内嵌 quotaExhausted 哨兵）。 */
  private quotaErr(err: unknown): boolean {
    return err instanceof Error && err.message.includes(QUOTA_FLAG);
  }

  /** Prompt a session and resolve with its transcript once the turn ends.
   *  等待登记到 pendingTurns：剔除僵死选手时可主动唤醒（reject），
   *  否则阶段链会永远挂在一个不再产生任何事件的会话上。 */
  private runTurn(g: RaceGroup, sessionId: string, text: string, cfg: RaceRoleConfig): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const off = this.host.onTurnEnded(sessionId, (stopReason, usage, quotaExhausted) => {
        this.pendingTurns.delete(sessionId);
        off();
        // 成败失败都记账 —— 异常收束的回合 token 也真实烧掉了。
        this.recordUsage(g, cfg.engine, usage);
        // 出错/被中止的回合不算产出 —— 阻断阶段推进，交给用户重试。
        if (stopReason === 'error' || stopReason === 'cancelled' || stopReason === 'interrupted') {
          reject(new Error(
            L(
              `角色回合异常结束（${stopReason}），可重试当前阶段（可先调整选手配置）`,
              `Role turn ended abnormally (${stopReason}) — retry the current stage (optionally adjust the racer config first)`,
            ) + (quotaExhausted ? QUOTA_FLAG : ''),
          ));
          return;
        }
        resolve(this.host.transcript(sessionId));
      });
      this.pendingTurns.set(sessionId, () => {
        off();
        // 中性打断语义：剔除僵死选手、重跑规划叫停旧链都走这里，
        // 消费方（runRacerTurn）一律静默，不弹横幅。
        reject(new Error(L('角色回合等待被打断（superseded：剔除或重跑）', 'Role turn wait superseded (eliminated or re-run)')));
      });
      this.host.prompt(sessionId, text, cfg.effort).catch((err) => {
        this.pendingTurns.delete(sessionId);
        off();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** kimi/agy 的只读角色需要提示词护栏（两者都没有只读沙箱，
   *  赛马里以 auto 自动批准跑，靠 READONLY_GUARD 兑底）。 */
  private needsGuard(role: RaceRole, cfg: RaceRoleConfig): boolean {
    return role !== 'builder' && (cfg.engine === 'kimi' || cfg.engine === 'antigravity');
  }

  private setStage(g: RaceGroup, stage: RaceStage): void {
    this.settleStageTimer(g); // 先结转上一阶段的墙钟增量
    log.info('race', 'stage transition', { raceId: g.id, from: g.stage, to: stage, repairRound: g.repairRound });
    g.stage = stage;
    // 阶段被编排器驱动 = 本进程已在实际运行 —— 打断标记随之失效（剔除
    // 选手/调参自动重跑等旁路拉活链条时也能自愈，不留假横幅）。
    g.interrupted = false;
    if (this.isWorkStage(stage)) this.stageEnteredAt.set(g.id, Date.now());
    else this.stageEnteredAt.delete(g.id);
    this.touch(g);
    this.host.emit(g.id, { type: 'race.stage', stage });
  }

  // ------------------------------------------------------ stats bookkeeping

  private isWorkStage(stage: RaceStage): stage is RaceWorkStage {
    return stage !== 'config' && stage !== 'done';
  }

  /** 结转当前阶段的墙钟增量进 stats（阶段切换/收尾时调用）。 */
  private settleStageTimer(g: RaceGroup): void {
    const started = this.stageEnteredAt.get(g.id);
    if (started === undefined || !this.isWorkStage(g.stage)) return;
    this.stageEnteredAt.delete(g.id);
    this.bumpStats(g, g.stage, { durationMs: Date.now() - started });
  }

  /** 角色回合 token 记账。kimi code 会话无真实 token 上报（仅字符数
   *  估算 approx），与主进程用量统计同口径 —— 一律不参与统计。 */
  private recordUsage(g: RaceGroup, engine: EngineId, usage?: UsageInfo): void {
    if (engine === 'kimi' || !usage || usage.approx) return;
    if (!this.isWorkStage(g.stage)) return;
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    if (!inputTokens && !outputTokens) return;
    this.bumpStats(g, g.stage, { inputTokens, outputTokens });
  }

  /** 往某阶段的累计桶加增量，随后持久化并推 race.stats。 */
  private bumpStats(
    g: RaceGroup,
    stage: RaceWorkStage,
    delta: { durationMs?: number; inputTokens?: number; outputTokens?: number },
  ): void {
    const prev = g.stats?.[stage] ?? { durationMs: 0, inputTokens: 0, outputTokens: 0 };
    g.stats = {
      ...g.stats,
      [stage]: {
        durationMs: prev.durationMs + (delta.durationMs ?? 0),
        inputTokens: prev.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: prev.outputTokens + (delta.outputTokens ?? 0),
      },
    };
    this.touch(g);
    this.host.emit(g.id, { type: 'race.stats', stats: g.stats });
  }

  private touch(g: RaceGroup): void {
    g.updatedAt = Date.now();
    this.host.persist(this.list());
  }

  /** Wrap an async stage chain; surface failures as a race error event. */
  private async safe(raceId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.chainActive.delete(raceId); // 链已死 —— 单选手重试成功后可代为推进
      const message = err instanceof Error ? err.message : String(err);
      // 被主动打断（撤回决策/重跑规划/剔除唤醒）不是错误，不弹横幅。
      if (message.includes('superseded')) return;
      log.error('race', 'stage chain failed', { raceId }, err);
      this.host.emit(raceId, { type: 'race.error', message });
    }
  }
}
