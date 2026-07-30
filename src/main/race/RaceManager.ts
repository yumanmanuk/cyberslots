/**
 * RaceManager — composition root for the race feature. It owns the
 * RaceOrchestrator and implements `RaceSessionHost` by delegating to
 * SessionManager (role sessions) and the renderer bridge (race events),
 * plus persisting race groups to disk.
 *
 * This is the ONLY place that couples the (pure) orchestrator to the
 * concrete session layer and Electron IPC, keeping both sides testable.
 */

import { app } from 'electron';
import type { WebContents } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { IPC } from '@shared/ipc';
import type { EngineEvent, UsageInfo } from '@shared/types';
import type { RaceAdoptStrategy, RaceCreateRequest, RaceEvent, RaceEventEnvelope, RaceGroup, RaceRole, RaceRoleConfig } from '@shared/race';
import type { SessionManager } from '../engine/SessionManager';
import { RaceOrchestrator, type RaceSessionHost, type RaceSpawnSpec } from './RaceOrchestrator';

export class RaceManager implements RaceSessionHost {
  private target: WebContents | undefined;
  private readonly orchestrator: RaceOrchestrator;

  constructor(private readonly sessions: SessionManager) {
    this.orchestrator = new RaceOrchestrator(this, this.loadPersisted());
  }

  /** Renderer webContents that receives race events. */
  attach(target: WebContents): void {
    this.target = target;
  }

  // ---------------------------------------------------- public API (IPC)

  create(req: RaceCreateRequest): RaceGroup {
    return this.orchestrator.create(req);
  }

  list(): RaceGroup[] {
    return this.orchestrator.list();
  }

  get(raceId: string): RaceGroup | null {
    return this.orchestrator.get(raceId) ?? null;
  }

  /** 用户选定采纳策略（+可选评语）→ 裁判产出最终方案。 */
  adopt(raceId: string, strategy: RaceAdoptStrategy, comment?: string): void {
    this.orchestrator.adoptStrategy(raceId, strategy, comment);
  }

  revise(raceId: string, annotation: string): void {
    this.orchestrator.reviseJudge(raceId, annotation);
  }

  finalize(raceId: string): void {
    this.orchestrator.finalize(raceId);
  }

  /** 重启后继续被打断的赛马（重跑当前阶段）。 */
  resume(raceId: string): void {
    this.orchestrator.resume(raceId);
  }

  /** 重试前调整选手配置（仅 racerA/racerB）。 */
  updateRole(raceId: string, role: RaceRole, cfg: RaceRoleConfig): void {
    this.orchestrator.updateRole(raceId, role, cfg);
  }

  /** 单选手重试：只补跑该选手当前阶段回合。 */
  retryRacer(raceId: string, role: RaceRole): void {
    this.orchestrator.retryRacer(raceId, role);
  }

  /** ④a 反悔：撤回采纳决策，回到选策略关口（约束在编排器）。 */
  revokeAdopt(raceId: string): void {
    this.orchestrator.revokeAdopt(raceId);
  }

  /** ✂ 剔除选手（标记式；约束与竞态处理在编排器）。 */
  eliminateRacer(raceId: string, role: RaceRole): void {
    this.orchestrator.eliminateRacer(raceId, role);
  }

  /** 取消会话当前回合（剔除选手时就地叫停；区别于整场 cancel）。 */
  cancelTurn(sessionId: string): void {
    void this.sessions.cancel(sessionId);
  }

  /** 裁判选策略前回退：清空产物重跑双规划。 */
  restartPlanning(raceId: string): void {
    this.orchestrator.restartPlanning(raceId);
  }

  cancel(raceId: string): void {
    this.orchestrator.cancel(raceId);
  }

  // ------------------------------------------------ RaceSessionHost impl

  async spawn(spec: RaceSpawnSpec): Promise<string> {
    const meta = await this.sessions.create({
      engine: spec.engine,
      cwd: spec.cwd,
      modelId: spec.modelId,
      permissionMode: spec.permissionMode,
      title: spec.title,
      raceId: spec.raceId,
    });
    return meta.id;
  }

  prompt(sessionId: string, text: string, effort?: string): Promise<void> {
    // 编排器直发的 prompt 在会话历史里回显为用户气泡（仅预览截断，
    // 完整内容照常发给引擎），否则重启后打开角色会话只见独白。
    const echo =
      text.length > 2000 ? `${text.slice(0, 2000)}\n…（预览截断 · 完整指令已完整发送给引擎）` : text;
    // 同回合重试（中止/报错后重跑）：与上一条用户回显完全相同时，
    // 重复堆大段指令没有阅读价值 → 改发一行重试标记（历史只增不减，
    // 失败回合的诊断信息保留；指令仍完整发给引擎）。
    const lastUser = [...this.sessions.getMessages(sessionId)].reverse().find((m) => m.kind === 'user');
    this.sessions.announceUser(
      sessionId,
      lastUser?.text === echo ? '↻ 已按相同指令重试本回合（指令原文见上一条，不再重复展示）' : echo,
    );
    return this.sessions.prompt(sessionId, text, undefined, effort);
  }

  transcript(sessionId: string): string {
    return this.sessions.transcript(sessionId);
  }

  changesDigest(sessionId: string): Promise<string> {
    return this.sessions.changesDigest(sessionId);
  }

  /** 回合完成判定 —— codex 对大 prompt 会拆多个内部回合（探索回合
   *  正常收束后自发续跑出真正产物），故不能拿第一个 turn.ended 当
   *  交卷：收束后等一段静默期，期间引擎又开新回合就继续等；真安静
   *  了才交卷（此时 transcript 才是最终产物）。异常收束（error/
   *  cancelled/interrupted）不等静默，立即上报。
   *  附带记账：逐内部回合累计 usage，交卷时一并上报（供赛马阶段
   *  统计）；含 approx 估算则整体标 approx，由编排器拒记（kimi 不计）。 */
  onTurnEnded(sessionId: string, cb: (stopReason: string, usage?: UsageInfo) => void): () => void {
    let settle: NodeJS.Timeout | undefined;
    const acc: UsageInfo = { inputTokens: 0, outputTokens: 0 };
    const fold = (usage?: UsageInfo): void => {
      if (!usage) return;
      acc.inputTokens = (acc.inputTokens ?? 0) + (usage.inputTokens ?? 0);
      acc.outputTokens = (acc.outputTokens ?? 0) + (usage.outputTokens ?? 0);
      if (usage.approx) acc.approx = true;
    };
    const off = this.sessions.subscribe(sessionId, (event: EngineEvent) => {
      if (event.type === 'turn.started') {
        // 引擎续跑（自发回合/内部第二回合）→ 撤回待定的交卷。
        if (settle) clearTimeout(settle);
        settle = undefined;
        return;
      }
      if (event.type !== 'turn.ended') return;
      fold(event.usage);
      const reason = event.stopReason;
      if (reason === 'error' || reason === 'cancelled' || reason === 'interrupted') {
        if (settle) clearTimeout(settle);
        cb(reason, acc);
        return;
      }
      // 正常/background 收束：静默 2s 后才算交卷（background 收束同样
      // 可能是最终产物所在回合 —— 不再一律忽略）。
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => cb('end_turn', acc), 2000);
    });
    return () => {
      if (settle) clearTimeout(settle);
      off();
    };
  }

  emit(raceId: string, event: RaceEvent): void {
    const envelope: RaceEventEnvelope = { raceId, event, ts: Date.now() };
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(IPC.raceEvent, envelope);
    }
  }

  persist(groups: RaceGroup[]): void {
    try {
      writeFileSync(this.storeFile, JSON.stringify(groups, null, 2), 'utf8');
    } catch (err) {
      console.error('[race] persist failed:', err);
    }
  }

  // ---------------------------------------------------------------- private

  private get storeFile(): string {
    return join(app.getPath('userData'), 'races.json');
  }

  private loadPersisted(): RaceGroup[] {
    try {
      if (!existsSync(this.storeFile)) return [];
      const groups = JSON.parse(readFileSync(this.storeFile, 'utf8')) as RaceGroup[];
      // 赛马寄生于宿主对话：无宿主（旧数据）或宿主已删 → 收敛为已结束；
      // judging 纯等待态原样恢复；其余回合进行中被打断 → 标记
      // interrupted，由用户在赛马视图点「继续赛马」重跑（不自动）。
      const alive = new Set(this.sessions.list().map((s) => s.id));
      return groups.map((g) => {
        if (g.stage === 'done') return g;
        if (!g.parentSessionId || !alive.has(g.parentSessionId)) return { ...g, stage: 'done' as const };
        const waitingUser =
          g.stage === 'judging' &&
          (!g.adopt || (!!g.finalPlan && g.annotations.length < g.finalPlanVersion));
        return { ...g, interrupted: !waitingUser };
      });
    } catch (err) {
      console.error('[race] load failed:', err);
      return [];
    }
  }
}
