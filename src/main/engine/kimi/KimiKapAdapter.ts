/**
 * KimiKapAdapter — drives one kimi session over the KAP surface
 * (kap-server: REST /api/v1 + WebSocket event stream) and translates
 * the ~48-kind KAP event vocabulary into engine-agnostic `EngineEvent`s.
 *
 * 与 KimiAdapter（ACP/stdio 窄面）互为备选：本通道原生具备 goal /
 * steer / fork / compact / 真实 usage（turn.step.completed）/ 独立
 * thinking.delta —— ACP 下靠模拟或缺失的能力这里全部走原生。
 * server 进程由 KapServerHost 单例共享（一 server 多会话）。
 *
 * 协议事实（kimi-code 源码逐项核实）：
 *  - REST 信封 { code, msg, data, request_id }，code 0 = 成功。
 *  - goal / plan / permission 的写路径是 POST /sessions/{id}/profile
 *    的 agent_config（prompts 路由只消费 model/thinking/permission）。
 *  - WS 鉴权走子协议 `kimi-code.bearer.<token>`；事件信封带 seq/epoch，
 *    volatile 事件（*.delta 等）不推进 seq、断线不重放。
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import WebSocket from 'ws';

import type {
  EngineEvent,
  GoalControlAction,
  GoalInfo,
  PermissionMode,
  PermissionOptionView,
  PlanEntry,
  ToolCallContent,
  UsageInfo,
} from '@shared/types';
import type { EngineAdapter, EngineEventSink } from '../EngineAdapter';
import { L } from '../../i18n';
import { compatAudit } from '../compatAudit';
import type { KapServerHost, KapServerInfo } from './KapServerHost';

type Json = Record<string, unknown>;

const WS_RECONNECT_MIN_MS = 1_000;
const WS_RECONNECT_MAX_MS = 10_000;

/** 已知且刻意不渲染的 KAP 事件 — 不进兼容审计（不是协议漂移）。 */
const KNOWN_IGNORED_EVENTS = new Set([
  'prompt.submitted',
  'prompt.steered',
  'turn.step.started',
  'turn.step.retrying',
  'turn.step.interrupted',
  'tool.call.delta',
  'tool.list.updated',
  'shell.started',
  'shell.output',
  'shell.completed',
  'session.meta.updated',
  'event.session.created',
  'event.session.status_changed',
  'event.workspace.created',
  'event.workspace.updated',
  'event.workspace.deleted',
  'event.config.changed',
  'event.model_catalog.changed',
  'mcp.server.status',
  'skill.activated',
  'plugin_command.activated',
  'hook.result',
  'cron.fired',
  'task.started',
  'task.terminated',
  'background.task.started',
  'background.task.terminated',
  'warning',
]);

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 子代理卡进度行节流间隔 — assistant.delta 频率很高，逐条转发会刷爆
 *  IPC/渲染；尾条在子代理终态事件时强制冲刷，不丢最后一行。 */
const SUBAGENT_PROGRESS_THROTTLE_MS = 300;

interface SubagentView {
  toolCallId: string;
  title: string;
  /** 正文累积缓冲（取末行作进度行）。 */
  buf: string;
  /** 待发的最新进度行（节流窗口内只留最后一条）。 */
  line?: string;
  lastEmit: number;
  pending?: NodeJS.Timeout;
}

/** 一次 question 下发的全量子问题 + 已收集答案（按子问题 id 记账）。 */
interface QuestionFlow {
  qid: string;
  items: Json[];
  answers: Json;
}

export interface KimiKapAdapterOptions {
  host: KapServerHost;
  /** 路由镜像 home（KIMI_CODE_HOME）；缺省 = 用户自己的 ~/.kimi-code。 */
  kimiHome?: string;
  cwd: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  quietResumeFallback?: boolean;
}

/** 回合内 usage 累计（turn.step.completed 逐步进账 = 真实 API 调用粒度）。 */
interface TurnStats {
  input: number;
  output: number;
  cached: number;
  calls: number;
}

interface ActivePrompt {
  promptId: string;
  localTurn: number;
  /** 引擎侧回合 id（首个 turn.started 时补记）— skill 激活回合无
   *  prompt id，靠它在 turn.ended 时解挂等待。 */
  engineTurnId?: number;
  resolve: (reason: string) => void;
}

export class KimiKapAdapter implements EngineAdapter {
  private server: KapServerInfo | undefined;
  private ws: WebSocket | undefined;
  private sessionId = '';
  private turnId = 0;
  private disposed = false;
  private mode: PermissionMode;

  private active: ActivePrompt | undefined;
  /** 引擎自发回合（goal continuation / 压缩 / cron）— 不经 prompt() 发起，
   *  也要补全 turn 生命周期，否则 UI 状态装死（同 CodexAdapter 的教训）。 */
  private bgTurn: { engineTurnId: number; localTurn: number } | undefined;
  /** 手动 compact 的合成回合（compaction.* 事件无 turn 边界）。 */
  private compactTurn: number | undefined;

  private stats: TurnStats = { input: 0, output: 0, cached: 0, calls: 0 };
  private lastCtx: { used: number; size: number } | undefined;
  private curModel = '';
  private modelCatalog: string[] = [];
  /** 会话可用 skill 名（斜杠命令拦截用；/name 命中则走 :activate）。 */
  private skillNames = new Set<string>();
  private mainAgentId: string | undefined;
  private curSwarm = false;
  /** 活子代理（agentId → 卡视图）— swarm/task 并行进度可视化。 */
  private readonly subagents = new Map<string, SubagentView>();

  /** WS 游标（durable 事件推进；重连时带上续订）。 */
  private lastSeq = 0;
  private epoch: string | undefined;
  private wsBackoff = WS_RECONNECT_MIN_MS;

  private readonly pendingApprovals = new Set<string>();
  /** 待答问题流：一个 question_id 可携 1-4 个子问题，逐问出卡收集，
   *  答案最后一次性合并 POST（KAP 协议要求整体提交）。 */
  private readonly questionFlows = new Map<string, QuestionFlow>();
  /** 子问题卡 requestId（`${qid}#${idx}`）→ 所属流 + 序号。 */
  private readonly questionSteps = new Map<string, { flow: QuestionFlow; idx: number }>();
  /** 已投射为计划面板的 TodoList 工具调用 id — 其 tool.result 不再出卡。 */
  private readonly planToolCalls = new Set<string>();

  constructor(
    private readonly opts: KimiKapAdapterOptions,
    private readonly emit: EngineEventSink,
  ) {
    this.mode = opts.permissionMode ?? 'default';
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ engineSessionId: string }> {
    this.emit({ type: 'session.status', status: 'starting' });
    this.server = await this.opts.host.ensure(this.opts.kimiHome);

    this.sessionId = await this.openSession();
    await this.connectWs();

    // 模型目录 + 会话状态 + skill 目录（best effort，不阻断启动）。
    await this.refreshCatalog().catch(() => undefined);
    await this.refreshStatus().catch(() => undefined);
    await this.refreshSkills().catch(() => undefined);
    // 显式绑定模型到 agent profile：交互式 prompt 缺 model 会回落引擎默认，
    // 但 goal 续跑等引擎自发回合不走 prompts 路由、不回落，profile 未绑模型
    // 会「Model not set」（实测：不选模型发 goal 不跑、暂停续跑报错，手点模型后才好）。
    // opts.modelId 优先（用户显式选择），否则绑 status 回报的当前/默认模型。
    const boundModel = this.opts.modelId || this.curModel;
    if (boundModel) await this.setModel(boundModel).catch(() => undefined);
    if (this.mode !== 'default') await this.setMode(this.mode).catch(() => undefined);

    this.emit({ type: 'session.status', status: 'idle' });
    return { engineSessionId: this.sessionId };
  }

  /** Resume the persisted engine session when possible, else start fresh. */
  private async openSession(): Promise<string> {
    if (this.opts.resumeSessionId) {
      try {
        const sess = await this.api<Json>('GET', `/sessions/${this.opts.resumeSessionId}`);
        return String(sess.id ?? this.opts.resumeSessionId);
      } catch (err) {
        // 空会话不弹红色报错 — 无上下文可丢，降级对用户无感。
        // （跨通道切换 ACP→KAP 的旧 id 也走这里：两侧引擎代际不同。）
        if (!this.opts.quietResumeFallback) {
          this.emit({
            type: 'error',
            source: 'engine',
            message: `${L('会话恢复失败，已新建会话继续（历史上下文不在引擎侧）', 'Session resume failed — started a new session (history context is not engine-side)')}: ${errorMessage(err)}`,
          });
        }
      }
    }
    const body: Json = { metadata: { cwd: this.opts.cwd } };
    const agentConfig: Json = {};
    if (this.opts.modelId) agentConfig.model = this.opts.modelId;
    if (this.mode !== 'default') {
      agentConfig.permission_mode = mapModeToKap(this.mode);
      agentConfig.plan_mode = this.mode === 'plan';
    }
    if (Object.keys(agentConfig).length) body.agent_config = agentConfig;
    try {
      const sess = await this.api<Json>('POST', '/sessions', body);
      return String(sess.id ?? '');
    } catch (err) {
      // agent_config 可能因模型别名不合法被整体拒 — 裸建兜底。
      if (!body.agent_config) throw err;
      const sess = await this.api<Json>('POST', '/sessions', { metadata: { cwd: this.opts.cwd } });
      return String(sess.id ?? '');
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const view of this.subagents.values()) {
      if (view.pending) clearTimeout(view.pending);
    }
    this.subagents.clear();
    if (this.active) {
      // 尽力中止在途回合；共享 server 不归本 adapter 停。
      void this.api('POST', `/sessions/${this.sessionId}/prompts/${this.active.promptId}:abort`, {}).catch(
        () => undefined,
      );
      this.active.resolve('cancelled');
      this.active = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }

  // ------------------------------------------------------------- actions

  async prompt(text: string, attachments?: string[], effort?: string): Promise<void> {
    // 斜杠命令拦截 — KAP 的 prompts 路由不解析斜杠（与 ACP 不同，CLI
    // 内置命令在 KAP 下是 REST 一等 API / skill 激活端点）：
    //   /compact → POST :compact（compaction 事件自己合成回合）；
    //   /<skill> → POST skills/{name}:activate（skill_activation 回合）；
    //   未命中 → 原文作普通 prompt 交给模型。
    const slash = /^\/([A-Za-z0-9_:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (slash && !attachments?.length) {
      const [, name = '', args] = slash;
      if (name === 'compact') {
        await this.compact();
        return;
      }
      if (this.skillNames.has(name)) {
        await this.runSkill(name, args?.trim() || undefined);
        return;
      }
    }
    const localTurn = ++this.turnId;
    this.stats = { input: 0, output: 0, cached: 0, calls: 0 };
    this.emit({ type: 'turn.started', turnId: localTurn });
    this.emit({ type: 'session.status', status: 'running' });
    const started = Date.now();
    // 先占 active 槽再提交 — WS 的 turn.started 可能跑赢 HTTP 响应，
    // 不先占位会被误认为引擎自发回合（bgTurn）导致双回合错乱。
    const done = new Promise<string>((resolve) => {
      this.active = { promptId: '', localTurn, resolve };
    });
    try {
      const body: Json = { content: await this.buildContent(text, attachments) };
      if (effort) body.thinking = effort;
      const submitted = await this.api<Json>('POST', `/sessions/${this.sessionId}/prompts`, body);
      if (this.active?.localTurn === localTurn) this.active.promptId = String(submitted.prompt_id ?? '');

      const reason = await done;

      const usage: UsageInfo = {
        inputTokens: this.stats.input || undefined,
        outputTokens: this.stats.output || undefined,
        cachedInputTokens: this.stats.cached || undefined,
        apiCalls: this.stats.calls || undefined,
        contextUsed: this.lastCtx?.used,
        contextMax: this.lastCtx?.size || undefined,
      };
      this.emit({
        type: 'turn.ended',
        turnId: localTurn,
        stopReason: mapStopReason(reason),
        usage,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      this.emit({ type: 'error', turnId: localTurn, source: classifyError(err), message: errorMessage(err) });
      this.emit({ type: 'turn.ended', turnId: localTurn, stopReason: 'error' });
    } finally {
      this.active = undefined;
      if (!this.disposed && !this.bgTurn) this.emit({ type: 'session.status', status: 'idle' });
    }
  }

  async cancel(): Promise<void> {
    if (this.active) {
      // skill 激活回合无 prompt id — 用会话级 abort；40903 = 已结束（幂等）静默。
      if (this.active.promptId && !this.active.promptId.startsWith('skill:')) {
        await this.api('POST', `/sessions/${this.sessionId}/prompts/${this.active.promptId}:abort`, {}).catch(
          () => undefined,
        );
      } else {
        await this.api('POST', `/sessions/${this.sessionId}:abort`, {}).catch(() => undefined);
      }
      return;
    }
    if (this.bgTurn || this.compactTurn !== undefined) {
      await this.api('POST', `/sessions/${this.sessionId}:abort`, {}).catch(() => undefined);
    }
  }

  async setModel(modelId: string): Promise<void> {
    await this.api('POST', `/sessions/${this.sessionId}/profile`, { agent_config: { model: modelId } });
    this.curModel = modelId;
    this.emit({ type: 'models.update', current: modelId, available: this.modelCatalog });
  }

  async setMode(mode: PermissionMode): Promise<void> {
    // plan 在 KAP 是独立开关（plan_mode），与 permission_mode 正交；
    // 写路径是 profile 的 agent_config（prompts 路由不消费 plan_mode）。
    await this.api('POST', `/sessions/${this.sessionId}/profile`, {
      agent_config: { permission_mode: mapModeToKap(mode), plan_mode: mode === 'plan' },
    });
    this.mode = mode;
    this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan', 'auto', 'yolo'] });
  }

  /** Native swarm：profile agent_config.swarm_mode（v2 IAgentSwarmService
   *  enter('manual')/exit）。引擎自发退出（auto-exit）经 agent.status.updated
   *  的 swarmMode 回声同步，UI 不会卡在假开启态。 */
  async setSwarm(active: boolean): Promise<void> {
    await this.api('POST', `/sessions/${this.sessionId}/profile`, {
      agent_config: { swarm_mode: active },
    });
    this.curSwarm = active;
    this.emit({ type: 'swarm.update', active });
  }

  /** Native mid-turn steer：排队 prompt + prompts:steer 并入活跃回合。 */
  async steer(text: string): Promise<boolean> {
    if (!this.active && !this.bgTurn) return false;
    const submitted = await this.api<Json>('POST', `/sessions/${this.sessionId}/prompts`, {
      content: [{ type: 'text', text }],
    });
    const promptId = String(submitted.prompt_id ?? '');
    if (String(submitted.status ?? '') === 'queued') {
      // 回合刚结束的竞态：steer 失败时排队项会自成一回合 — 消息未丢，仍算送达。
      await this.api('POST', `/sessions/${this.sessionId}/prompts:steer`, { prompt_ids: [promptId] }).catch((err) =>
        compatAudit.record('kimi', 'rejected-method', 'kap prompts:steer', errorMessage(err)),
      );
    }
    return true;
  }

  /** Native fork：POST /sessions/{id}:fork → 新会话 id（引擎侧真分支）。 */
  async fork(): Promise<{ engineSessionId: string } | null> {
    try {
      const sess = await this.api<Json>('POST', `/sessions/${this.sessionId}:fork`, {});
      const id = String(sess.id ?? '');
      return id ? { engineSessionId: id } : null;
    } catch (err) {
      compatAudit.record('kimi', 'rejected-method', 'kap sessions:fork', errorMessage(err));
      return null;
    }
  }

  /** Native compact：一等 API + compaction.* 事件（合成回合驱动 UI）。 */
  async compact(): Promise<void> {
    await this.api('POST', `/sessions/${this.sessionId}:compact`, {});
  }

  /** /skill 斜杠命令 → 原生 skill 激活（POST :activate）。回合以
   *  skill_activation origin 自发开启、无 prompt id — 占 active 槽以
   *  engineTurnId 对齐等待，保持与普通 prompt 一致的忙碌/排队语义。 */
  private async runSkill(name: string, args?: string): Promise<void> {
    const localTurn = ++this.turnId;
    this.stats = { input: 0, output: 0, cached: 0, calls: 0 };
    this.emit({ type: 'turn.started', turnId: localTurn });
    this.emit({ type: 'session.status', status: 'running' });
    const started = Date.now();
    // 先占槽后提交（同 prompt）：turn.started 可能跑赢 :activate 响应。
    const done = new Promise<string>((resolve) => {
      this.active = { promptId: `skill:${name}`, localTurn, resolve };
    });
    try {
      await this.api(
        'POST',
        `/sessions/${this.sessionId}/skills/${encodeURIComponent(name)}:activate`,
        args ? { args } : {},
      );
      const reason = await done;
      this.emit({
        type: 'turn.ended',
        turnId: localTurn,
        stopReason: mapStopReason(reason),
        usage: {
          inputTokens: this.stats.input || undefined,
          outputTokens: this.stats.output || undefined,
          cachedInputTokens: this.stats.cached || undefined,
          apiCalls: this.stats.calls || undefined,
          contextUsed: this.lastCtx?.used,
          contextMax: this.lastCtx?.size || undefined,
        },
        durationMs: Date.now() - started,
      });
    } catch (err) {
      this.emit({ type: 'error', turnId: localTurn, source: classifyError(err), message: errorMessage(err) });
      this.emit({ type: 'turn.ended', turnId: localTurn, stopReason: 'error' });
    } finally {
      this.active = undefined;
      if (!this.disposed && !this.bgTurn) this.emit({ type: 'session.status', status: 'idle' });
    }
  }

  // ----------------------------------------------------------------- goal
  // Fully native: agent-core-v2 goal service（CreateGoal/UpdateGoal 工具 +
  // goal driver 自动续跑），写路径 = profile agent_config 的 goal_objective /
  // goal_control，状态经 goal.updated 事件 + GET /sessions/{id}/goal 推拉。

  async setGoal(objective: string): Promise<void> {
    // 同一次 profile 更新里带上 model — applyAgentConfig 先 setModel 再
    // createGoal，保证 goal driver 启动初始续跑回合时 profile 已绑模型
    // （否则引擎自发回合「Model not set」，goal 建了却不跑）。
    const cfg: Json = { goal_objective: objective };
    if (this.curModel) cfg.model = this.curModel;
    await this.api('POST', `/sessions/${this.sessionId}/profile`, { agent_config: cfg });
    // WS 也会推 goal.updated — 这里主动拉一次保证 GoalBar 无空窗。
    const snap = await this.api<Json | null>('GET', `/sessions/${this.sessionId}/goal`).catch(() => null);
    this.emitGoal(snap);
  }

  async controlGoal(action: GoalControlAction): Promise<void> {
    const control = action === 'clear' ? 'cancel' : action;
    const cfg: Json = { goal_control: control };
    // resume 会重启续跑回合 — 一并确保 model 绑定（同 setGoal 的理由）。
    if (action === 'resume' && this.curModel) cfg.model = this.curModel;
    await this.api('POST', `/sessions/${this.sessionId}/profile`, { agent_config: cfg });
    if (action === 'clear') {
      this.emit({ type: 'goal.update', goal: null });
      return;
    }
    const snap = await this.api<Json | null>('GET', `/sessions/${this.sessionId}/goal`).catch(() => null);
    this.emitGoal(snap);
  }

  private emitGoal(raw: Json | null | undefined): void {
    if (!raw) {
      this.emit({ type: 'goal.update', goal: null });
      return;
    }
    const budget = (raw.budget ?? {}) as Json;
    const goal: GoalInfo = {
      objective: String(raw.objective ?? ''),
      status: String(raw.status ?? 'active') as GoalInfo['status'],
      tokensUsed: Number(raw.tokensUsed ?? 0),
      timeUsedSeconds: Math.round(Number(raw.wallClockMs ?? 0) / 1000),
      tokenBudget: budget.tokenBudget == null ? undefined : Number(budget.tokenBudget),
    };
    this.emit({ type: 'goal.update', goal });
  }

  // -------------------------------------------------- approvals/questions

  answerPermission(requestId: string, optionId?: string): void {
    if (this.pendingApprovals.has(requestId)) {
      this.pendingApprovals.delete(requestId);
      const body: Json =
        optionId === undefined
          ? { decision: 'cancelled' }
          : optionId === 'reject'
            ? { decision: 'rejected' }
            : optionId === 'approve_session'
              ? { decision: 'approved', scope: 'session' }
              : { decision: 'approved' };
      void this.api('POST', `/sessions/${this.sessionId}/approvals/${requestId}`, body).catch((err) =>
        compatAudit.record('kimi', 'rejected-method', 'kap approvals resolve', errorMessage(err)),
      );
    } else if (this.questionSteps.has(requestId)) {
      const { flow, idx } = this.questionSteps.get(requestId)!;
      this.questionSteps.delete(requestId);
      const item = flow.items[idx] ?? {};
      const subId = String(item.id ?? `q${idx}`);
      // 记账本问答案：跳过/取消 → skipped；multi_select 问题用 multi 形态
      //（UI 单选，取一项），其余 single。
      flow.answers[subId] =
        !optionId || optionId === 'skip'
          ? { kind: 'skipped' }
          : item.multi_select === true
            ? { kind: 'multi', option_ids: [optionId] }
            : { kind: 'single', option_id: optionId };
      this.emit({ type: 'permission.resolved', requestId, optionId });
      // 还有后续子问题 → 继续出下一张卡（保持 awaiting）；否则整体提交。
      if (idx + 1 < flow.items.length) {
        this.surfaceQuestionStep(flow, idx + 1);
        return;
      }
      this.questionFlows.delete(flow.qid);
      void this.api('POST', `/sessions/${this.sessionId}/questions/${flow.qid}`, {
        answers: flow.answers,
        method: 'click',
      }).catch((err) => compatAudit.record('kimi', 'rejected-method', 'kap questions resolve', errorMessage(err)));
      if (this.active || this.bgTurn) this.emit({ type: 'session.status', status: 'running' });
      return;
    } else {
      return;
    }
    this.emit({ type: 'permission.resolved', requestId, optionId });
    if (this.active || this.bgTurn) this.emit({ type: 'session.status', status: 'running' });
  }

  private async pullApprovals(): Promise<void> {
    const data = await this.api<Json>('GET', `/sessions/${this.sessionId}/approvals?status=pending`);
    for (const item of (Array.isArray(data.items) ? data.items : []) as Json[]) {
      this.surfaceApproval(item);
    }
  }

  private surfaceApproval(item: Json): void {
    const requestId = String(item.approval_id ?? '');
    if (!requestId || this.pendingApprovals.has(requestId)) return;
    this.pendingApprovals.add(requestId);
    const toolName = String(item.tool_name ?? L('工具', 'tool'));
    const action = item.action == null ? '' : String(item.action);
    // tool_input_display 是结构化 display 块（非纯文本）— 按 kind 摘要，
    // 直接 String() 会变 [object Object]。
    const display = displaySummary(item.tool_input_display);
    const options: PermissionOptionView[] = [
      { optionId: 'approve', name: L('允许', 'Allow'), kind: 'allow_once' },
      { optionId: 'approve_session', name: L('本会话总是允许', 'Always allow in this session'), kind: 'allow_always' },
      { optionId: 'reject', name: L('拒绝', 'Reject'), kind: 'reject_once' },
    ];
    this.emit({
      type: 'permission.request',
      turnId: this.currentTurn(),
      requestId,
      isQuestion: false,
      title: [toolName, action, display && display.slice(0, 120)].filter(Boolean).join(' · '),
      // 富确认正文：plan_review 计划全文 / goal_start objective / 长命令。
      body: displayBody(item.tool_input_display),
      toolCallId: item.tool_call_id == null ? undefined : String(item.tool_call_id),
      options,
    });
    this.emit({ type: 'session.status', status: 'awaiting' });
  }

  private async pullQuestions(): Promise<void> {
    const data = await this.api<Json>('GET', `/sessions/${this.sessionId}/questions?status=pending`);
    for (const item of (Array.isArray(data.items) ? data.items : []) as Json[]) {
      const qid = String(item.question_id ?? '');
      if (!qid || this.questionFlows.has(qid)) continue;
      const items = Array.isArray(item.questions) ? (item.questions as Json[]) : [];
      if (items.length === 0) continue;
      const flow: QuestionFlow = { qid, items, answers: {} };
      this.questionFlows.set(qid, flow);
      this.surfaceQuestionStep(flow, 0);
    }
  }

  /** 逐问出卡：子问题 idx → 一张 ask_user 卡（多问时标题带 (n/N) 进度）。 */
  private surfaceQuestionStep(flow: QuestionFlow, idx: number): void {
    const item = flow.items[idx] ?? {};
    const requestId = `${flow.qid}#${idx}`;
    this.questionSteps.set(requestId, { flow, idx });
    const rawOpts = Array.isArray(item.options) ? (item.options as Json[]) : [];
    const options: PermissionOptionView[] = rawOpts.map((o) => ({
      optionId: String(o.id ?? ''),
      name: String(o.label ?? ''),
      kind: 'allow_once',
    }));
    options.push({ optionId: 'skip', name: L('跳过', 'Skip'), kind: 'reject_once' });
    const prefix = flow.items.length > 1 ? `(${idx + 1}/${flow.items.length}) ` : '';
    // header/body 是问题的补充说明 — 进富正文区滚动展示。
    const detail = [item.header, item.body]
      .filter((x): x is string => typeof x === 'string' && !!x.trim())
      .join('\n\n');
    this.emit({
      type: 'permission.request',
      turnId: this.currentTurn(),
      requestId,
      isQuestion: true,
      title: `${prefix}${String(item.question ?? L('模型提问', 'Model question'))}`,
      body: detail || undefined,
      options,
    });
    this.emit({ type: 'session.status', status: 'awaiting' });
  }

  // ------------------------------------------------------------ WS stream

  private connectWs(): Promise<void> {
    const info = this.requireServer();
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${info.origin.replace(/^http/, 'ws')}/api/v1/ws`, [
        `kimi-code.bearer.${info.token}`,
      ]);
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'client_hello', id: randomUUID(), payload: { client_id: randomUUID() } }));
        const cursors =
          this.lastSeq > 0 ? { [this.sessionId]: { seq: this.lastSeq, epoch: this.epoch } } : undefined;
        ws.send(
          JSON.stringify({ type: 'subscribe', id: randomUUID(), payload: { session_ids: [this.sessionId], cursors } }),
        );
        this.wsBackoff = WS_RECONNECT_MIN_MS;
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      ws.on('message', (raw) => {
        try {
          this.onWsMessage(JSON.parse(String(raw)) as Json);
        } catch (err) {
          compatAudit.record('kimi', 'parse-error', 'kap ws message', errorMessage(err));
        }
      });
      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`KAP WebSocket 连接失败: ${err.message}`));
        }
      });
      ws.on('close', () => {
        if (this.ws !== ws) return;
        this.ws = undefined;
        if (!this.disposed) this.scheduleReconnect();
      });
    });
  }

  /** 断线重连：指数退避 + 游标续订；server 换代（端口漂移）时经 host 重定位。 */
  private scheduleReconnect(): void {
    const delay = this.wsBackoff;
    this.wsBackoff = Math.min(this.wsBackoff * 2, WS_RECONNECT_MAX_MS);
    setTimeout(() => {
      if (this.disposed || this.ws) return;
      void this.opts.host
        .ensure(this.opts.kimiHome)
        .then((server) => {
          this.server = server;
          return this.connectWs();
        })
        .then(() => {
          void this.refreshStatus().catch(() => undefined);
          void this.reconcileActivePrompt().catch(() => undefined);
        })
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  /** 断线窗口可能丢 prompt.completed（durable 但缓冲可溢出）— 重连后
   *  对账：引擎侧已无我方在途 prompt 则解挂等待，防回合永久悬挂。 */
  private async reconcileActivePrompt(): Promise<void> {
    if (!this.active) return;
    const data = await this.api<Json>('GET', `/sessions/${this.sessionId}/prompts`);
    const activeRemote = data.active as Json | null | undefined;
    if (!activeRemote || String(activeRemote.prompt_id ?? '') !== this.active.promptId) {
      this.active.resolve('completed');
    }
  }

  private onWsMessage(msg: Json): void {
    const type = String(msg.type ?? '');
    // 控制帧（无 seq 字段）
    if (msg.seq === undefined) {
      if (type === 'ping') {
        this.ws?.send(JSON.stringify({ type: 'pong', payload: msg.payload ?? {} }));
      } else if (type === 'resync_required') {
        // durable 缓冲溢出/epoch 变化 — 消息流靠本地持久化，无需重放；
        // 对齐游标 + 刷一次状态即可继续。
        const p = (msg.payload ?? {}) as Json;
        if (p.current_seq != null) this.lastSeq = Number(p.current_seq);
        if (p.epoch != null) this.epoch = String(p.epoch);
        void this.refreshStatus().catch(() => undefined);
      }
      // server_hello / ack / error 控制帧无需处理（错误经 close 兜底）。
      return;
    }
    // 事件信封
    if (msg.session_id !== undefined && msg.session_id !== this.sessionId) return;
    if (msg.volatile !== true) {
      this.lastSeq = Number(msg.seq ?? this.lastSeq);
      if (msg.epoch != null) this.epoch = String(msg.epoch);
    }
    this.onEvent(type, (msg.payload ?? {}) as Json);
  }

  private onEvent(type: string, p: Json): void {
    // 主 agent id 取首个回合的 agentId；子代理的流（agentId 在 subagents
    // 表里）路由到并行任务卡的进度行，其余非主 agent 事件不混入主流。
    const agentId = p.agentId == null ? undefined : String(p.agentId);
    if (this.mainAgentId === undefined && type === 'turn.started' && agentId) this.mainAgentId = agentId;
    const sub = agentId ? this.subagents.get(agentId) : undefined;
    if (sub) {
      this.onSubagentStream(type, p, sub);
      return;
    }
    const fromMain = !this.mainAgentId || !agentId || agentId === this.mainAgentId;
    const turnId = this.currentTurn();

    switch (type) {
      case 'subagent.spawned':
      case 'subagent.started':
      case 'subagent.suspended':
      case 'subagent.completed':
      case 'subagent.failed':
        // 生命周期事件由发起方 agent 发出（携 subagentId 字段），不按
        // fromMain 门控 — 嵌套子代理也照常出卡。
        this.onSubagentLifecycle(type, p);
        return;
      case 'turn.started': {
        if (!fromMain) return;
        // 我方发起的回合（prompt / skill 激活）：补记引擎回合 id。
        if (this.active) {
          if (this.active.engineTurnId === undefined) this.active.engineTurnId = Number(p.turnId ?? -1);
          return;
        }
        if (this.bgTurn || this.compactTurn !== undefined) return;
        // 引擎自发回合（goal continuation / cron / 注入）：补全生命周期。
        this.bgTurn = { engineTurnId: Number(p.turnId ?? -1), localTurn: ++this.turnId };
        this.stats = { input: 0, output: 0, cached: 0, calls: 0 };
        this.emit({ type: 'turn.started', turnId: this.bgTurn.localTurn });
        this.emit({ type: 'session.status', status: 'running' });
        return;
      }
      case 'turn.ended': {
        if (!fromMain) return;
        const engineTid = Number(p.turnId ?? -2);
        // skill 激活回合没有 prompt.completed — 靠引擎回合 id 解挂。
        if (
          this.active?.promptId.startsWith('skill:') &&
          this.active.engineTurnId !== undefined &&
          this.active.engineTurnId === engineTid
        ) {
          this.active.resolve(String(p.reason ?? 'completed'));
          return;
        }
        if (this.bgTurn && engineTid === this.bgTurn.engineTurnId) {
          const local = this.bgTurn.localTurn;
          this.bgTurn = undefined;
          this.emit({
            type: 'turn.ended',
            turnId: local,
            // background：goal 有独立完成通知、不派发队列/不触压缩；但 goal 续跑是
            // 用户要看/要复制的真实回答 — showStats 让渲染层照常出统计行（复制 + token）。
            stopReason: 'background',
            showStats: true,
            usage: {
              inputTokens: this.stats.input || undefined,
              outputTokens: this.stats.output || undefined,
              cachedInputTokens: this.stats.cached || undefined,
              apiCalls: this.stats.calls || undefined,
              contextUsed: this.lastCtx?.used,
              contextMax: this.lastCtx?.size || undefined,
            },
            durationMs: p.durationMs == null ? undefined : Number(p.durationMs),
          });
          if (!this.active) this.emit({ type: 'session.status', status: 'idle' });
        }
        return;
      }
      case 'assistant.delta': {
        if (fromMain && p.delta) this.emit({ type: 'text.delta', turnId, text: String(p.delta) });
        return;
      }
      case 'thinking.delta': {
        if (fromMain && p.delta) this.emit({ type: 'thinking.delta', turnId, text: String(p.delta) });
        return;
      }
      case 'tool.call.started': {
        if (!fromMain) return;
        const display = p.display as Json | undefined;
        // TodoList 结构化显示 → 计划面板（与 ACP 'plan' update 同源信号：
        // acp-adapter 的 planFromDisplayBlock 也是从这个 display 投射的）。
        if (display?.kind === 'todo_list') {
          const entries = mapTodoEntries(display.items);
          if (entries) this.emit({ type: 'plan.update', turnId, entries });
          this.planToolCalls.add(String(p.toolCallId ?? ''));
          return;
        }
        const view = displayView(display);
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: String(p.toolCallId ?? ''),
          title: view.title ?? (p.description == null ? String(p.name ?? '') : String(p.description)),
          toolName: p.name == null ? undefined : String(p.name),
          toolKind: view.toolKind,
          status: 'in_progress',
          content: view.content,
          locations: view.locations,
        });
        return;
      }
      case 'tool.progress': {
        if (!fromMain) return;
        const update = (p.update ?? {}) as Json;
        const line = update.text == null ? '' : String(update.text);
        if (!line) return;
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: String(p.toolCallId ?? ''),
          content: { progress: { line: line.split(/\r?\n/).pop() ?? line } },
        });
        return;
      }
      case 'tool.result': {
        if (!fromMain) return;
        const toolCallId = String(p.toolCallId ?? '');
        // TodoList 已投射为计划面板 — 结果不出孤儿工具卡。
        if (this.planToolCalls.delete(toolCallId)) return;
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId,
          status: p.isError === true ? 'failed' : 'completed',
          content: { text: stringifyOutput(p.output) },
        });
        return;
      }
      case 'turn.step.completed': {
        if (!fromMain) return;
        const u = p.usage as Json | undefined;
        if (u) {
          const cacheRead = Number(u.inputCacheRead ?? 0);
          this.stats.input += Number(u.inputOther ?? 0) + cacheRead + Number(u.inputCacheCreation ?? 0);
          this.stats.output += Number(u.output ?? 0);
          this.stats.cached += cacheRead;
          this.stats.calls += 1;
        }
        return;
      }
      case 'agent.status.updated':
        this.onAgentStatus(p, fromMain);
        return;
      case 'event.session.work_changed': {
        const pending = String(p.pending_interaction ?? 'none');
        if (pending === 'approval') void this.pullApprovals().catch(() => undefined);
        else if (pending === 'question') void this.pullQuestions().catch(() => undefined);
        return;
      }
      case 'goal.updated': {
        this.emitGoal((p.snapshot ?? null) as Json | null);
        return;
      }
      case 'prompt.completed': {
        if (this.active && String(p.promptId ?? '') === this.active.promptId) {
          this.active.resolve(String(p.reason ?? 'completed'));
        }
        return;
      }
      case 'prompt.aborted': {
        if (this.active && String(p.promptId ?? '') === this.active.promptId) {
          this.active.resolve('aborted');
        }
        return;
      }
      case 'compaction.started': {
        if (this.compactTurn === undefined && !this.active && !this.bgTurn) {
          this.compactTurn = ++this.turnId;
          this.emit({ type: 'turn.started', turnId: this.compactTurn });
          this.emit({ type: 'session.status', status: 'running' });
          this.emit({ type: 'text.delta', turnId: this.compactTurn, text: L('正在压缩上下文…', 'Compacting context…') });
        }
        return;
      }
      case 'compaction.completed': {
        const r = (p.result ?? {}) as Json;
        if (this.compactTurn !== undefined) {
          this.emit({
            type: 'text.delta',
            turnId: this.compactTurn,
            text: `\n${L('上下文压缩完成：', 'Context compaction finished: ')}${fmtTokens(Number(r.tokensBefore ?? 0))} → ${fmtTokens(Number(r.tokensAfter ?? 0))} tokens`,
          });
          this.emit({ type: 'turn.ended', turnId: this.compactTurn, stopReason: 'background' });
          this.compactTurn = undefined;
          if (!this.active && !this.bgTurn) this.emit({ type: 'session.status', status: 'idle' });
        }
        void this.refreshStatus().catch(() => undefined);
        return;
      }
      case 'compaction.blocked':
      case 'compaction.cancelled': {
        if (this.compactTurn !== undefined) {
          this.emit({ type: 'turn.ended', turnId: this.compactTurn, stopReason: 'cancelled' });
          this.compactTurn = undefined;
          if (!this.active && !this.bgTurn) this.emit({ type: 'session.status', status: 'idle' });
        }
        return;
      }
      case 'error': {
        const code = String(p.code ?? '');
        this.emit({
          type: 'error',
          turnId,
          source: code.startsWith('provider.') ? 'provider' : 'engine',
          message: String(p.message ?? (code || L('未知错误', 'Unknown error'))),
          quotaExhausted: code.includes('rate_limit') || code.includes('quota'),
        });
        return;
      }
      default:
        if (!KNOWN_IGNORED_EVENTS.has(type)) {
          compatAudit.record('kimi', 'unknown-event', `kap:${type}`, p);
        }
    }
  }

  /** agent.status.updated（volatile）：上下文水位 / 模型 / 模式热同步 +
   *  awaiting_approval 内嵌审批直达（比 work_changed → 拉取快一拍）。 */
  private onAgentStatus(p: Json, fromMain: boolean): void {
    if (!fromMain) return;
    const used = p.contextTokens == null ? undefined : Number(p.contextTokens);
    const size = p.maxContextTokens == null ? undefined : Number(p.maxContextTokens);
    if (used !== undefined && size !== undefined && (this.lastCtx?.used !== used || this.lastCtx?.size !== size)) {
      this.lastCtx = { used, size };
      this.emit({ type: 'usage.update', used, size });
    }
    const model = p.model == null ? '' : String(p.model);
    if (model && model !== this.curModel) {
      this.curModel = model;
      this.emit({ type: 'models.update', current: model, available: this.modelCatalog });
    }
    if (p.permission != null || p.planMode != null) {
      const mode = mapKapToMode(String(p.permission ?? 'manual'), p.planMode === true);
      if (mode !== this.mode) {
        this.mode = mode;
        this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan', 'auto', 'yolo'] });
      }
    }
    // swarm 回声：含引擎自发退出（auto-exit）与模型经 AgentSwarm 工具自行进入。
    if (p.swarmMode != null && (p.swarmMode === true) !== this.curSwarm) {
      this.curSwarm = p.swarmMode === true;
      this.emit({ type: 'swarm.update', active: this.curSwarm });
    }
    const phase = p.phase as Json | undefined;
    if (phase?.kind === 'awaiting_approval') {
      const inline = phase.approval as Json | undefined;
      if (inline?.approval_id != null) this.surfaceApproval(inline);
      else void this.pullApprovals().catch(() => undefined);
    }
  }

  // -------------------------------------------------- subagent 可视化
  // swarm/task 并行子代理 → 每人一张任务卡（TUI 网格的桌面等价物）：
  // spawned 开卡，自身流（assistant/thinking/工具）节流成卡内进度行，
  // completed/failed 收卡带结果摘要。复用 omp 子代理的 progress 卡机制。

  private onSubagentLifecycle(type: string, p: Json): void {
    const id = String(p.subagentId ?? '');
    if (!id) return;
    const turnId = this.currentTurn();
    if (type === 'subagent.spawned') {
      const idx = p.swarmIndex == null ? undefined : Number(p.swarmIndex);
      const name = String(p.subagentName ?? L('子代理', 'subagent'));
      const desc = p.description == null ? '' : String(p.description);
      const title = `${idx == null ? '' : `#${String(idx + 1).padStart(2, '0')} `}${name}${desc ? ` · ${desc}` : ''}`;
      const view: SubagentView = { toolCallId: `subagent:${id}`, title, buf: '', lastEmit: 0 };
      this.subagents.set(id, view);
      this.emit({
        type: 'tool.upsert',
        turnId,
        toolCallId: view.toolCallId,
        title,
        toolName: 'subagent',
        toolKind: 'task',
        status: 'in_progress',
      });
      return;
    }
    const view = this.subagents.get(id);
    if (!view) return;
    if (type === 'subagent.started') return; // spawned 已开卡
    if (type === 'subagent.suspended') {
      this.pushSubagentLine(view, `${L('已挂起：', 'Suspended: ')}${String(p.reason ?? '')}`, true);
      return;
    }
    // 终态：completed / failed — 清节流器、收卡。
    if (view.pending) clearTimeout(view.pending);
    this.subagents.delete(id);
    const ok = type === 'subagent.completed';
    // 子代理的 token 消耗也是真实成本 — 并入当前回合统计。
    const u = p.usage as Json | undefined;
    if (u) {
      const cacheRead = Number(u.inputCacheRead ?? 0);
      this.stats.input += Number(u.inputOther ?? 0) + cacheRead + Number(u.inputCacheCreation ?? 0);
      this.stats.output += Number(u.output ?? 0);
      this.stats.cached += cacheRead;
    }
    const summary = ok ? String(p.resultSummary ?? '') : String(p.error ?? '');
    this.emit({
      type: 'tool.upsert',
      turnId,
      toolCallId: view.toolCallId,
      status: ok ? 'completed' : 'failed',
      content: summary ? { text: summary.length > 2000 ? `${summary.slice(0, 2000)}…` : summary } : undefined,
    });
  }

  /** 子代理自身的事件流（按 agentId 路由到这）→ 卡内进度行。 */
  private onSubagentStream(type: string, p: Json, view: SubagentView): void {
    if (type === 'assistant.delta' || type === 'thinking.delta') {
      view.buf = (view.buf + String(p.delta ?? '')).slice(-2000);
      const line = lastLine(view.buf);
      if (line) this.pushSubagentLine(view, line, false);
      return;
    }
    if (type === 'tool.call.started') {
      const summary = displaySummary(p.display) || String(p.name ?? '');
      if (summary) this.pushSubagentLine(view, `⚙ ${summary}`, true);
      view.buf = '';
      return;
    }
    if (type === 'turn.step.completed') {
      // 子代理逐步 usage 并入回合统计（真实 API 成本）。
      const u = p.usage as Json | undefined;
      if (u) {
        const cacheRead = Number(u.inputCacheRead ?? 0);
        this.stats.input += Number(u.inputOther ?? 0) + cacheRead + Number(u.inputCacheCreation ?? 0);
        this.stats.output += Number(u.output ?? 0);
        this.stats.cached += cacheRead;
        this.stats.calls += 1;
      }
    }
    // 其余（tool.result / turn.* 等）不进卡 — 噪音。
  }

  /** 进度行节流：窗口内只留最新一条，尾条到时必发；force = 立发。 */
  private pushSubagentLine(view: SubagentView, line: string, force: boolean): void {
    view.line = line.slice(0, 160);
    const emitNow = (): void => {
      view.lastEmit = Date.now();
      if (view.pending) {
        clearTimeout(view.pending);
        view.pending = undefined;
      }
      this.emit({
        type: 'tool.upsert',
        turnId: this.currentTurn(),
        toolCallId: view.toolCallId,
        content: { progress: { line: view.line! } },
      });
    };
    const elapsed = Date.now() - view.lastEmit;
    if (force || elapsed >= SUBAGENT_PROGRESS_THROTTLE_MS) {
      emitNow();
    } else if (!view.pending) {
      view.pending = setTimeout(emitNow, SUBAGENT_PROGRESS_THROTTLE_MS - elapsed);
    }
  }

  // -------------------------------------------------------------- helpers

  private currentTurn(): number {
    return this.active?.localTurn ?? this.bgTurn?.localTurn ?? this.compactTurn ?? this.turnId;
  }

  private async refreshCatalog(): Promise<void> {
    const data = await this.api<Json | Json[]>('GET', '/models');
    const items = Array.isArray(data) ? data : Array.isArray((data as Json).items) ? ((data as Json).items as Json[]) : [];
    this.modelCatalog = items.map((m) => String(m.model ?? '')).filter(Boolean);
  }

  /** skill 目录 → 斜杠菜单（commands.update，与 ACP available_commands 同位）
   *  + 本地拦截表（/name 命中则走 :activate 而非当普通正文）。 */
  private async refreshSkills(): Promise<void> {
    const data = await this.api<Json>('GET', `/sessions/${this.sessionId}/skills`);
    const skills = (Array.isArray(data.skills) ? data.skills : []) as Json[];
    this.skillNames = new Set(skills.map((s) => String(s.name ?? '')).filter(Boolean));
    this.emit({
      type: 'commands.update',
      commands: [
        { name: 'compact', description: L('压缩上下文（原生 API）', 'Compact context (native API)') },
        ...skills.map((s) => ({
          name: String(s.name ?? ''),
          description: s.description == null ? undefined : String(s.description),
        })),
      ],
    });
  }

  private async refreshStatus(): Promise<void> {
    const s = await this.api<Json>('GET', `/sessions/${this.sessionId}/status`);
    this.curModel = s.model == null ? this.curModel : String(s.model);
    this.emit({ type: 'models.update', current: this.curModel, available: this.modelCatalog });
    const mode = mapKapToMode(String(s.permission ?? 'manual'), s.plan_mode === true);
    this.mode = mode;
    this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan', 'auto', 'yolo'] });
    this.curSwarm = s.swarm_mode === true;
    this.emit({ type: 'swarm.update', active: this.curSwarm });
    const used = Number(s.context_tokens ?? 0);
    const size = Number(s.max_context_tokens ?? 0);
    if (size > 0) {
      this.lastCtx = { used, size };
      this.emit({ type: 'usage.update', used, size });
    }
    // 活跃 goal（重连/懒唤醒后 GoalBar 复位）。
    const goal = await this.api<Json | null>('GET', `/sessions/${this.sessionId}/goal`).catch(() => null);
    if (goal) this.emitGoal(goal);
  }

  /** 附件装配：图片内联 base64（KAP image 块）；其余文件经 POST /files
   *  真上传拿 file_id 进模型附件通道；上传/读取失败退化为路径附注
   *（kimi 文件工具接受绝对路径，兜底不丢信息）。 */
  private async buildContent(text: string, attachments?: string[]): Promise<Json[]> {
    const blocks: Json[] = [];
    const notes: string[] = [];
    for (const path of attachments ?? []) {
      const mime = IMAGE_MIME[extname(path).toLowerCase()];
      if (mime) {
        try {
          blocks.push({
            type: 'image',
            source: { kind: 'base64', media_type: mime, data: readFileSync(path).toString('base64') },
          });
          continue;
        } catch {
          /* 读失败 → 退化路径附注 */
        }
      } else {
        try {
          const meta = await this.uploadFile(path);
          blocks.push({
            type: 'file',
            file_id: meta.id,
            name: meta.name,
            media_type: meta.media_type,
            size: meta.size,
          });
          continue;
        } catch (err) {
          compatAudit.record('kimi', 'rejected-method', 'kap files upload', errorMessage(err));
        }
      }
      notes.push(`[附件] ${path}`);
    }
    const fullText = notes.length ? `${text}\n\n${notes.join('\n')}` : text;
    blocks.unshift({ type: 'text', text: fullText });
    return blocks;
  }

  /** multipart 上传（字段名 file，@fastify/multipart 单文件）→ FileMeta
   *  {id,name,media_type,size}；不走 api()（那边强制 JSON content-type）。 */
  private async uploadFile(
    path: string,
  ): Promise<{ id: string; name: string; media_type: string; size: number }> {
    const info = this.requireServer();
    const bytes = readFileSync(path);
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: guessMime(path) }), basename(path));
    const res = await fetch(`${info.origin}/api/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.token}` },
      body: fd,
    });
    const env = (await res.json()) as { code?: number; msg?: string; data?: Json };
    if (env.code !== 0 || !env.data) {
      throw new Error(`KAP POST /files → ${env.msg ?? `HTTP ${res.status}`} (code ${env.code ?? res.status})`);
    }
    const d = env.data;
    return {
      id: String(d.id ?? ''),
      name: String(d.name ?? basename(path)),
      media_type: String(d.media_type ?? 'application/octet-stream'),
      size: Number(d.size ?? bytes.length),
    };
  }

  /** REST 请求 + 信封解包（{code,msg,data}，code 0 = 成功）。 */
  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const info = this.requireServer();
    const res = await fetch(`${info.origin}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${info.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let env: { code?: number; msg?: string; data?: unknown };
    try {
      env = (await res.json()) as typeof env;
    } catch {
      throw new Error(L(`KAP ${method} ${path} → HTTP ${res.status}（非 JSON 响应）`, `KAP ${method} ${path} → HTTP ${res.status} (non-JSON response)`));
    }
    if (env.code !== 0) {
      throw new Error(`KAP ${method} ${path} → ${env.msg ?? 'error'} (code ${env.code ?? res.status})`);
    }
    return env.data as T;
  }

  private requireServer(): KapServerInfo {
    if (!this.server || this.disposed) throw new Error('Kimi KAP session is not running');
    return this.server;
  }
}

// ------------------------------------------------------------------ utils

/** cyberslots PermissionMode → KAP permission_mode（plan 是独立开关）。 */
function mapModeToKap(mode: PermissionMode): 'manual' | 'auto' | 'yolo' {
  return mode === 'auto' ? 'auto' : mode === 'yolo' ? 'yolo' : 'manual';
}

function mapKapToMode(permission: string, planMode: boolean): PermissionMode {
  if (planMode) return 'plan';
  if (permission === 'auto') return 'auto';
  if (permission === 'yolo') return 'yolo';
  return 'default';
}

function mapStopReason(reason: string): string {
  if (reason === 'completed') return 'end_turn';
  if (reason === 'aborted') return 'cancelled';
  if (reason === 'failed') return 'error';
  return reason || 'end_turn';
}

/** 非图片附件的 MIME 猜测（上传时给 Blob 标类型）。 */
function guessMime(path: string): string {
  const ext = extname(path).toLowerCase();
  return (
    IMAGE_MIME[ext] ??
    {
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.csv': 'text/csv',
      '.pdf': 'application/pdf',
      '.html': 'text/html',
      '.xml': 'application/xml',
    }[ext] ??
    'application/octet-stream'
  );
}

function stringifyOutput(output: unknown): string | undefined {
  if (output == null) return undefined;
  if (typeof output === 'string') return output.length > 4000 ? `${output.slice(0, 4000)}…` : output;
  try {
    const s = JSON.stringify(output);
    return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
  } catch {
    return String(output);
  }
}

/** TodoList display → 计划面板条目（对齐 acp-adapter 的 mapTodoStatus：
 *  done → completed，未知状态安全回落 pending）。 */
function mapTodoEntries(raw: unknown): PlanEntry[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return (raw as Json[]).map((item) => {
    const status = String(item.status ?? 'pending');
    return {
      content: String(item.title ?? ''),
      status: status === 'done' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending',
    } as PlanEntry;
  });
}

/** 结构化 ToolInputDisplay → 工具卡投影（标题/diff/位置）。 */
function displayView(display: Json | undefined): {
  title?: string;
  toolKind?: string;
  content?: ToolCallContent;
  locations?: string[];
} {
  if (!display) return {};
  const kind = String(display.kind ?? '');
  switch (kind) {
    case 'command':
      return { title: String(display.command ?? ''), toolKind: 'execute' };
    case 'file_io': {
      const path = String(display.path ?? '');
      const op = String(display.operation ?? '');
      const view: ReturnType<typeof displayView> = {
        title: `${op} ${path}`.trim(),
        toolKind: op === 'read' ? 'read' : op === 'glob' || op === 'grep' ? 'search' : 'edit',
        locations: path ? [path] : undefined,
      };
      if (display.before != null || display.after != null) {
        view.content = {
          diff: {
            path,
            oldText: display.before == null ? undefined : String(display.before),
            newText: display.after == null ? undefined : String(display.after),
          },
        };
      }
      return view;
    }
    case 'diff': {
      const path = String(display.path ?? '');
      return {
        title: `edit ${path}`,
        toolKind: 'edit',
        locations: path ? [path] : undefined,
        content: { diff: { path, oldText: String(display.before ?? ''), newText: String(display.after ?? '') } },
      };
    }
    case 'search':
      return { title: `search ${String(display.query ?? '')}`, toolKind: 'search' };
    case 'url_fetch':
      return { title: String(display.url ?? ''), toolKind: 'fetch' };
    case 'agent_call':
      return {
        title: `${L('子代理', 'Subagent')} ${String(display.agent_name ?? '')}`,
        toolKind: 'task',
        content: { text: String(display.prompt ?? '') },
      };
    case 'skill_call':
      return { title: `skill ${String(display.skill_name ?? '')}` };
    case 'plan_review':
      return { title: L('计划评审', 'Plan review'), content: { text: String(display.plan ?? '') } };
    case 'goal_start':
      return { title: `${L('Goal 启动确认：', 'Goal start confirmation: ')}${String(display.objective ?? '')}` };
    case 'generic':
      return { title: String(display.summary ?? '') };
    default:
      return {};
  }
}

/** display 块的富确认正文（审批卡可滚动区）：计划全文 / Goal objective /
 *  多行长命令 / diff 摘要。短内容不出正文（标题已够）。 */
function displayBody(raw: unknown): string | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const d = raw as Json;
  const kind = String(d.kind ?? '');
  if (kind === 'plan_review') {
    const plan = String(d.plan ?? '');
    return plan || undefined;
  }
  if (kind === 'goal_start') {
    const objective = String(d.objective ?? '');
    const criterion = d.completionCriterion == null ? '' : String(d.completionCriterion);
    const body = criterion ? `${objective}\n\n${L('完成判据：', 'Completion criterion: ')}${criterion}` : objective;
    return body || undefined;
  }
  if (kind === 'command') {
    const command = String(d.command ?? '');
    // 短单行命令标题里已完整展示，只有长/多行命令才值得开正文区。
    return command.length > 120 || command.includes('\n') ? command : undefined;
  }
  if (kind === 'diff' || (kind === 'file_io' && (d.before != null || d.after != null))) {
    const path = String(d.path ?? '');
    return `${L('将编辑文件：', 'Will edit file: ')}${path}`;
  }
  return undefined;
}

/** display 块的单行摘要（审批卡标题用）。 */
function displaySummary(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw !== 'object') return String(raw);
  const d = raw as Json;
  const kind = String(d.kind ?? '');
  if (kind === 'command') return String(d.command ?? '');
  if (kind === 'file_io') return `${String(d.operation ?? '')} ${String(d.path ?? '')}`.trim();
  if (kind === 'diff') return `edit ${String(d.path ?? '')}`;
  if (kind === 'search') return `search ${String(d.query ?? '')}`;
  if (kind === 'url_fetch') return String(d.url ?? '');
  if (kind === 'agent_call') return `${L('子代理', 'Subagent')} ${String(d.agent_name ?? '')}`;
  if (kind === 'skill_call') return `skill ${String(d.skill_name ?? '')}`;
  if (kind === 'plan_review') return L('退出计划评审', 'Exit plan review');
  if (kind === 'goal_start') return `${L('启动 Goal：', 'Start Goal: ')}${String(d.objective ?? '')}`;
  if (kind === 'generic') return String(d.summary ?? '');
  return kind;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 缓冲区末尾的最后一行非空文本（子代理卡进度行）。 */
function lastLine(buf: string): string {
  const lines = buf.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line) return line;
  }
  return '';
}

function classifyError(err: unknown): 'client' | 'engine' | 'provider' {
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes('auth') || msg.includes('401')) return 'provider';
  if (msg.includes('timeout') || msg.includes('fetch failed') || msg.includes('econnrefused')) return 'client';
  return 'engine';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
