/**
 * CodexAdapter — drives one `codex app-server` child process (JSON-RPC
 * v2 thread/turn/item surface, verified against codex CLI 0.145.0 docs)
 * and translates its event stream into engine-agnostic `EngineEvent`s.
 *
 * The model provider is always the embedded ai-server proxy
 * ("cyberslots" in the app-managed CODEX_HOME/config.toml): routing to
 * kimi/minimax hides in the model name, so codex never sees a real key.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type {
  EngineEvent,
  GoalControlAction,
  GoalInfo,
  PermissionMode,
  PermissionOptionView,
  PlanEntry,
  ToolCallStatus,
  UsageInfo,
} from '@shared/types';
import type { EngineAdapter, EngineEventSink } from '../EngineAdapter';
import { killEngineTree } from '../killTree';
import { NdjsonRpc } from './rpc';
import { codexSpawnEnv, resolveCodexCli } from './resolveCodex';

const INIT_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

export interface CodexAdapterOptions {
  cwd: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  /** Resume an existing thread instead of starting a new one. */
  resumeThreadId?: string;
  /** 会话没有客户端历史时恢复失败静默降级（空会话的 rollout 常不存在，报错纯噪音）。 */
  quietResumeFallback?: boolean;
  /** Optional explicit path to codex bin/codex.js (settings override). */
  cliEntry?: string;
  /** 路由开启时的 `-c key=value` 命令行覆盖（零文件写入）。 */
  configOverrideArgs?: string[];
  /** 路由开启时指定的 model_provider；缺省 = 用户配置默认。 */
  modelProvider?: string;
  /** Model aliases to surface in the model picker. */
  availableModels?: string[];
}

interface PendingApproval {
  resolve: (decision: string) => void;
}

/** permissionMode → codex approvalPolicy + sandbox mapping. */
const MODE_MAP: Record<PermissionMode, { approvalPolicy: string; sandbox: string }> = {
  default: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  auto: { approvalPolicy: 'never', sandbox: 'workspace-write' },
  yolo: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

export class CodexAdapter implements EngineAdapter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private rpc: NdjsonRpc | undefined;
  private threadId = '';
  private activeCodexTurnId = '';
  private turnId = 0;
  private disposed = false;
  private modelId: string;
  private mode: PermissionMode;
  private turnDone: (() => void) | undefined;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly stderrTail: string[] = [];
  /** 最近一次补全的 token 明细（thread/tokenUsage `last`）— 仅用于
   *  contextUsed/contextMax；回合统计按 `total` 差值累计（见下）。 */
  private lastTurnUsage: UsageInfo | undefined;
  /** thread 级累计 token（`total` 最新快照，跨回合单调递增）。 */
  private latestTotalUsage: UsageBreakdown | undefined;
  /** 本回合开始时的 `total` 基线 — 与结束时的差值 = 整回合全部 API 调用之和。 */
  private turnUsageBaseline: UsageBreakdown | undefined;
  private turnStartedAt = 0;
  /** 回合内"非 API"区间（工具执行 / 等待审批）的并集累计 ms — t/s 只按 API 时间算。 */
  private turnBusyMs = 0;
  private busySince = 0;
  private readonly busyKeys = new Set<string>();
  /** Last goal snapshot — lets us synthesize the completion announcement
   *  if the engine clears the goal without pushing a `complete` update. */
  private lastGoal: GoalInfo | null = null;
  private lastGoalAt = 0;
  private userClearedGoal = false;

  constructor(
    private readonly opts: CodexAdapterOptions,
    private readonly emit: EngineEventSink,
  ) {
    this.modelId = opts.modelId ?? '';
    this.mode = opts.permissionMode ?? 'default';
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ engineSessionId: string }> {
    this.emit({ type: 'session.status', status: 'starting' });
    // 路由覆盖是 root 级 `-c` 参数，必须排在 app-server 子命令之前。
    const spec = resolveCodexCli([...(this.opts.configOverrideArgs ?? []), 'app-server'], this.opts.cliEntry);
    const child = spawn(spec.command, spec.args, {
      cwd: this.opts.cwd,
      shell: spec.shell ?? false,
      env: codexSpawnEnv(spec.managedRoot),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, // 防止 Windows 下闪出 cmd 控制台窗口
    });
    this.child = child;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      for (const line of d.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 60) this.stderrTail.shift();
      }
    });
    child.on('exit', (code, signal) => {
      this.rpc?.close('engine exited');
      if (this.disposed) return;
      this.emit({
        type: 'error',
        source: 'engine',
        message: `codex 进程意外退出 (code=${code} signal=${signal ?? 'none'})\n${this.stderrTail.slice(-8).join('\n')}`,
      });
      this.emit({ type: 'session.status', status: 'error', detail: 'engine-exited' });
    });
    child.on('error', (err) => {
      if (this.disposed) return;
      this.emit({ type: 'error', source: 'client', message: `无法启动 codex CLI: ${err.message}` });
      this.emit({ type: 'session.status', status: 'error', detail: 'spawn-failed' });
    });

    this.rpc = new NdjsonRpc(
      child.stdin,
      child.stdout,
      (method, params) => this.onNotification(method, params),
      (method, params) => this.onServerRequest(method, params),
    );

    await withTimeout(
      this.rpc.request('initialize', {
        clientInfo: { name: 'cyberslots', title: 'CyberSlots', version: '0.1.0' },
      }),
      INIT_TIMEOUT_MS,
      'codex initialize',
    );
    this.rpc.notify('initialized');

    const modeCfg = MODE_MAP[this.mode];
    const threadParams: Json = {
      cwd: this.opts.cwd,
      approvalPolicy: modeCfg.approvalPolicy,
      sandbox: modeCfg.sandbox,
    };
    if (this.opts.modelProvider) threadParams.modelProvider = this.opts.modelProvider;
    if (this.modelId) threadParams.model = this.modelId;

    const thread = this.opts.resumeThreadId
      ? await this.openThread('thread/resume', { threadId: this.opts.resumeThreadId, ...threadParams })
      : await this.openThread('thread/start', threadParams);
    this.threadId = thread;

    this.emitModels();
    this.emit({ type: 'modes.update', current: this.mode, available: ['default', 'plan', 'auto', 'yolo'] });
    this.emit({ type: 'session.status', status: 'idle' });
    return { engineSessionId: this.threadId };
  }

  private async openThread(method: string, params: Json): Promise<string> {
    try {
      const res = await withTimeout(this.rpc!.request<Json>(method, params), INIT_TIMEOUT_MS, method);
      const thread = res.thread as Json | undefined;
      const id = String(thread?.id ?? '');
      if (!id) throw new Error(`${method} 未返回 thread id`);
      return id;
    } catch (err) {
      if (method === 'thread/resume') {
        // 空会话不弹红色报错 — 无上下文可丢，降级对用户无感。
        if (!this.opts.quietResumeFallback) {
          this.emit({
            type: 'error',
            source: 'engine',
            message: `线程恢复失败，已新建线程继续: ${errorMessage(err)}`,
          });
        }
        const { threadId: _drop, ...rest } = params;
        return this.openThread('thread/start', rest);
      }
      throw err;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [id, pending] of this.pendingApprovals) {
      pending.resolve('cancel');
      this.pendingApprovals.delete(id);
    }
    this.rpc?.close('disposed');
    // 树杀：孙进程继承了 SingletonLock 句柄，残留会堵死下次启动。
    if (this.child) killEngineTree(this.child);
    this.child = undefined;
    this.rpc = undefined;
  }

  // ------------------------------------------------------------- actions

  async prompt(text: string, attachments?: string[], effort?: string): Promise<void> {
    const rpc = this.requireRpc();
    const turnId = ++this.turnId;
    this.lastTurnUsage = undefined;
    this.turnUsageBaseline = this.latestTotalUsage;
    this.turnBusyMs = 0;
    this.busyKeys.clear();
    this.turnStartedAt = Date.now();
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'session.status', status: 'running' });

    const input: Json[] = [{ type: 'text', text }];
    for (const path of attachments ?? []) {
      if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) input.push({ type: 'localImage', path });
      else input.push({ type: 'text', text: `[附件] ${path}` });
    }
    const modeCfg = MODE_MAP[this.mode];
    const params: Json = {
      threadId: this.threadId,
      input,
      approvalPolicy: modeCfg.approvalPolicy,
    };
    if (this.modelId) params.model = this.modelId;
    if (effort) params.effort = effort;

    try {
      const done = new Promise<void>((resolve) => {
        this.turnDone = resolve;
      });
      const res = await rpc.request<Json>('turn/start', params);
      const turn = res.turn as Json | undefined;
      this.activeCodexTurnId = String(turn?.id ?? '');
      await done; // resolved by turn/completed
    } catch (err) {
      this.emit({ type: 'error', turnId, source: classifyError(err), message: errorMessage(err) });
      this.emit({ type: 'turn.ended', turnId, stopReason: 'error' });
    } finally {
      this.turnDone = undefined;
      this.activeCodexTurnId = '';
      if (!this.disposed) this.emit({ type: 'session.status', status: 'idle' });
    }
  }

  async cancel(): Promise<void> {
    if (!this.activeCodexTurnId) return;
    await this.requireRpc().request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeCodexTurnId,
    });
  }

  async setModel(modelId: string): Promise<void> {
    // Applied on the next turn/start; codex has no hot-switch RPC.
    this.modelId = modelId;
    this.emitModels();
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan', 'auto', 'yolo'] });
  }

  answerPermission(requestId: string, optionId?: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.pendingApprovals.delete(requestId);
    pending.resolve(optionId ?? 'cancel');
    this.emit({ type: 'permission.resolved', requestId, optionId });
    if (this.turnDone) this.emit({ type: 'session.status', status: 'running' });
  }

  /** Native sidechat: codex thread/fork copies stored history engine-side. */
  async fork(): Promise<{ engineSessionId: string } | null> {
    try {
      const res = await withTimeout(
        this.requireRpc().request<Json>('thread/fork', { threadId: this.threadId }),
        INIT_TIMEOUT_MS,
        'thread/fork',
      );
      const id = String((res.thread as Json | undefined)?.id ?? '');
      return id ? { engineSessionId: id } : null;
    } catch {
      return null;
    }
  }

  /** Native compaction; progress streams through normal turn/item events. */
  async compact(): Promise<void> {
    await this.requireRpc().request('thread/compact/start', { threadId: this.threadId });
  }

  /** Native mid-turn steering (turn/steer). Review/compact turns reject it. */
  async steer(text: string): Promise<boolean> {
    if (!this.activeCodexTurnId) return false;
    try {
      await this.requireRpc().request('turn/steer', {
        threadId: this.threadId,
        turnId: this.activeCodexTurnId,
        input: [{ type: 'text', text }],
      });
      return true;
    } catch {
      return false; // ActiveTurnNotSteerable etc. — caller re-queues
    }
  }

  // ----------------------------------------------------------------- goal
  // Fully native: codex persists one goal per thread (thread/goal/set|clear)
  // and pushes thread/goal/updated with real usage counters. No prompt
  // bridging — kimi's ACP surface has no goal API, so the UI only shows
  // goal controls for codex sessions.

  async setGoal(objective: string): Promise<void> {
    const res = await this.requireRpc().request<Json>('thread/goal/set', {
      threadId: this.threadId,
      objective,
      status: 'active',
    });
    this.emitGoal((res.goal as Json | undefined) ?? null);
  }

  async controlGoal(action: GoalControlAction): Promise<void> {
    const rpc = this.requireRpc();
    if (action === 'clear') {
      this.userClearedGoal = true;
      await rpc.request('thread/goal/clear', { threadId: this.threadId });
      this.lastGoal = null;
      this.emit({ type: 'goal.update', goal: null });
      return;
    }
    const res = await rpc.request<Json>('thread/goal/set', {
      threadId: this.threadId,
      status: action === 'pause' ? 'paused' : 'active',
    });
    this.emitGoal((res.goal as Json | undefined) ?? null);
  }

  private emitGoal(raw: Json | null): void {
    if (!raw) {
      this.lastGoal = null;
      this.emit({ type: 'goal.update', goal: null });
      return;
    }
    const goal: GoalInfo = {
      objective: String(raw.objective ?? ''),
      status: String(raw.status ?? 'active') as GoalInfo['status'],
      tokensUsed: Number(raw.tokensUsed ?? 0),
      timeUsedSeconds: Number(raw.timeUsedSeconds ?? 0),
      tokenBudget: raw.tokenBudget == null ? undefined : Number(raw.tokenBudget),
    };
    this.lastGoal = goal.status === 'complete' ? null : goal;
    this.lastGoalAt = Date.now();
    // `complete` passes through untouched — the renderer announces the
    // completion (objective + elapsed) before clearing its local state.
    this.emit({ type: 'goal.update', goal });
  }

  // -------------------------------------------------------- notifications

  private onNotification(method: string, params: Json): void {
    const turnId = this.turnId;
    switch (method) {
      case 'item/agentMessage/delta':
        this.emit({ type: 'text.delta', turnId, text: String(params.delta ?? '') });
        return;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.emit({ type: 'thinking.delta', turnId, text: String(params.delta ?? '') });
        return;
      case 'item/started':
      case 'item/completed': {
        const item = params.item as Json | undefined;
        this.trackBusy(item, method === 'item/started');
        this.onItem(item, turnId);
        return;
      }
      case 'turn/plan/updated': {
        const raw = Array.isArray(params.plan) ? (params.plan as Json[]) : [];
        const entries: PlanEntry[] = raw.map((p) => ({
          content: String(p.step ?? ''),
          status: p.status === 'inProgress' ? 'in_progress' : (String(p.status ?? 'pending') as PlanEntry['status']),
        }));
        this.emit({ type: 'plan.update', turnId, entries });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage as Json | undefined;
        // 上下文占用以 `last`（最近一次补全的窗口内 token 数）为准 —
        // `total` 是跨回合累计值，会把占用比例越算越大（codex TUI 同此口径）。
        const last = usage?.last as Json | undefined;
        const total = usage?.total as Json | undefined;
        const used = Number(last?.totalTokens ?? total?.totalTokens ?? 0);
        const size = Number(usage?.modelContextWindow ?? 0);
        if (last) {
          this.lastTurnUsage = {
            inputTokens: Number(last.inputTokens ?? 0),
            cachedInputTokens: Number(last.cachedInputTokens ?? 0),
            outputTokens: Number(last.outputTokens ?? 0),
            totalTokens: Number(last.totalTokens ?? 0),
            contextUsed: used,
            contextMax: size || undefined,
          };
        }
        const totalNow = toBreakdown(total);
        if (totalNow) {
          // 恢复线程后的首个回合没有基线：`total` 含历史累计，
          // 用 total − last 反推本回合开始前的累计值作基线。
          if (this.turnDone && this.turnUsageBaseline === undefined) {
            const lastBd = toBreakdown(last);
            this.turnUsageBaseline = lastBd ? diffBreakdown(totalNow, lastBd) : totalNow;
          }
          this.latestTotalUsage = totalNow;
        }
        this.emit({ type: 'usage.update', used, size });
        return;
      }
      case 'thread/goal/updated':
        this.emitGoal((params.goal as Json | undefined) ?? null);
        return;
      case 'thread/goal/cleared': {
        // Engine-initiated clear right after an active goal (and not by the
        // user) means the goal finished — synthesize the completion so the
        // UI can announce objective + elapsed even without a `complete` push.
        const finished = !this.userClearedGoal && this.lastGoal && this.lastGoal.status === 'active';
        if (finished) {
          // Top up the elapsed time since the last snapshot so "用时" is accurate.
          const extraSec = this.lastGoalAt ? Math.round((Date.now() - this.lastGoalAt) / 1000) : 0;
          this.emit({
            type: 'goal.update',
            goal: { ...this.lastGoal!, status: 'complete', timeUsedSeconds: this.lastGoal!.timeUsedSeconds + extraSec },
          });
        }
        this.userClearedGoal = false;
        this.lastGoal = null;
        this.emit({ type: 'goal.update', goal: null });
        return;
      }
      case 'turn/completed': {
        // 引擎自发回合（compact/review 等，非 prompt 发起）不产出统计行，
        // 否则压缩等开销会被算进上一回合，还会误触未读/「任务完成」通知。
        if (!this.turnDone) return;
        const turn = params.turn as Json | undefined;
        const status = String(turn?.status ?? 'completed');
        const err = turn?.error as Json | undefined;
        if (status === 'failed' && err) {
          this.emit({ type: 'error', turnId, source: 'provider', message: String(err.message ?? 'turn failed') });
        }
        // 协议的 Turn 不携带 usage（0.145.0）——一轮问答通常有多次 API
        // 调用（工具循环），按 thread 级 `total` 在回合前后的差值累计；
        // `last` 只是最后一次调用，仅保留其 contextUsed/contextMax。
        const summed =
          this.latestTotalUsage && this.turnUsageBaseline
            ? diffBreakdown(this.latestTotalUsage, this.turnUsageBaseline)
            : undefined;
        const usage: UsageInfo | undefined = summed
          ? { ...this.lastTurnUsage, ...summed }
          : this.lastTurnUsage;
        // 纯 API/模型耗时 = 本地墙钟 − 非 API 区间并集（须同钟相减，
        // 故不用引擎的 turn.durationMs）。
        this.busyFlush();
        const wallMs = this.turnStartedAt ? Date.now() - this.turnStartedAt : 0;
        const apiDurationMs = wallMs > 0 ? Math.max(0, wallMs - this.turnBusyMs) : undefined;
        this.emit({
          type: 'turn.ended',
          turnId,
          stopReason: status === 'completed' ? 'end_turn' : status,
          usage,
          durationMs: this.turnDurationMs(turn),
          apiDurationMs,
        });
        this.turnDone?.();
        return;
      }
      case 'error': {
        const err = params.error as Json | undefined;
        this.emit({ type: 'error', turnId, source: 'provider', message: String(err?.message ?? '未知引擎错误') });
        return;
      }
      default:
        return; // thread/started, item deltas we don't render yet, etc.
    }
  }

  /** Map codex ThreadItem lifecycle into tool.upsert / message events. */
  private onItem(item: Json | undefined, turnId: number): void {
    if (!item) return;
    const id = String(item.id ?? '');
    switch (item.type) {
      case 'commandExecution': {
        const status = mapItemStatus(String(item.status ?? 'inProgress'));
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: id,
          title: String(item.command ?? 'command'),
          toolKind: 'execute',
          status,
          content: item.aggregatedOutput ? { text: String(item.aggregatedOutput) } : undefined,
        });
        return;
      }
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
        const paths = changes.map((c) => String(c.path ?? '')).filter(Boolean);
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: id,
          title: paths.length ? `修改 ${paths.map((p) => p.split(/[\\/]/).pop()).join(', ')}` : '修改文件',
          toolKind: 'edit',
          status: mapItemStatus(String(item.status ?? 'inProgress')),
          locations: paths.length ? paths : undefined,
        });
        return;
      }
      case 'mcpToolCall':
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: id,
          title: `${String(item.server ?? 'mcp')}.${String(item.tool ?? '')}`,
          toolKind: 'other',
          status: mapItemStatus(String(item.status ?? 'inProgress')),
        });
        return;
      case 'webSearch':
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: id,
          title: `搜索: ${String(item.query ?? '')}`,
          toolKind: 'fetch',
          status: 'completed',
        });
        return;
      case 'collabToolCall':
      case 'collabAgentToolCall':
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: id,
          title: `Agent ${String(item.tool ?? '')}`,
          toolKind: 'other',
          status: mapItemStatus(String(item.status ?? 'inProgress')),
        });
        return;
      default:
        return; // userMessage / agentMessage / reasoning — covered by deltas
    }
  }

  // ------------------------------------------------------ server requests

  private onServerRequest(method: string, params: Json): Promise<unknown> {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const isExec = method.startsWith('item/commandExecution');
      const requestId = randomUUID();
      const title = isExec
        ? `执行命令: ${String(params.command ?? '(见工具卡片)')}`
        : `写入文件${params.reason ? `（${String(params.reason)}）` : ''}`;
      const options: PermissionOptionView[] = [
        { optionId: 'accept', name: '允许一次', kind: 'allow_once' },
        { optionId: 'acceptForSession', name: '本会话总是允许', kind: 'allow_always' },
        { optionId: 'decline', name: '拒绝', kind: 'reject_once' },
      ];
      const busyKey = `approval:${requestId}`;
      this.busyAdd(busyKey);
      return new Promise((resolve) => {
        this.pendingApprovals.set(requestId, {
          resolve: (decision) => {
            this.busyRemove(busyKey);
            resolve({ decision });
          },
        });
        this.emit({
          type: 'permission.request',
          turnId: this.turnId,
          requestId,
          isQuestion: false,
          title,
          toolCallId: params.itemId ? String(params.itemId) : undefined,
          options,
        });
        this.emit({ type: 'session.status', status: 'awaiting' });
      });
    }
    return Promise.reject(new Error(`unsupported server request: ${method}`));
  }

  // -------------------------------------------------------------- helpers

  /** 工具执行区间计入"非 API"时间。重叠（并行工具 / 审批先于执行）
   *  由 busyAdd/busyRemove 的计数并集天然去重。 */
  private trackBusy(item: Json | undefined, started: boolean): void {
    if (!item) return;
    switch (item.type) {
      case 'commandExecution':
      case 'fileChange':
      case 'mcpToolCall':
      case 'collabToolCall':
      case 'collabAgentToolCall': {
        const key = `tool:${String(item.id ?? '')}`;
        if (started) this.busyAdd(key);
        else this.busyRemove(key);
        return;
      }
      default:
        return; // webSearch 在 API 调用内发生；reasoning/agentMessage 是模型时间
    }
  }

  private busyAdd(key: string): void {
    if (!this.turnDone) return; // 只统计 prompt 回合
    if (this.busyKeys.size === 0) this.busySince = Date.now();
    this.busyKeys.add(key);
  }

  private busyRemove(key: string): void {
    if (!this.busyKeys.delete(key)) return;
    if (this.busyKeys.size === 0) this.turnBusyMs += Date.now() - this.busySince;
  }

  /** 回合结束（含取消）时收尾未闭合的区间。 */
  private busyFlush(): void {
    if (this.busyKeys.size === 0) return;
    this.turnBusyMs += Date.now() - this.busySince;
    this.busyKeys.clear();
  }

  /** 优先用引擎实测的 turn.durationMs（不含 IPC 间隙），缺失时退回本地计时。 */
  private turnDurationMs(turn: Json | undefined): number | undefined {
    const engineMs = Number(turn?.durationMs ?? 0);
    if (engineMs > 0) return engineMs;
    return this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined;
  }

  private emitModels(): void {
    this.emit({
      type: 'models.update',
      current: this.modelId,
      available: this.opts.availableModels ?? [],
    });
  }

  private requireRpc(): NdjsonRpc {
    if (!this.rpc || this.disposed) throw new Error('Codex session is not running');
    return this.rpc;
  }
}

// ------------------------------------------------------------------ utils

interface UsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function toBreakdown(raw: Json | undefined): UsageBreakdown | undefined {
  if (!raw) return undefined;
  return {
    inputTokens: Number(raw.inputTokens ?? 0),
    cachedInputTokens: Number(raw.cachedInputTokens ?? 0),
    outputTokens: Number(raw.outputTokens ?? 0),
  };
}

/** a − b（逐字段，下限 0）—— 容错乱序/重放导致的短暂回退。 */
function diffBreakdown(a: UsageBreakdown, b: UsageBreakdown): UsageBreakdown {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  };
}

function mapItemStatus(s: string): ToolCallStatus {
  switch (s) {
    case 'inProgress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'declined':
      return 'failed';
    default:
      return 'pending';
  }
}

function classifyError(err: unknown): 'client' | 'engine' | 'provider' {
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes('auth') || msg.includes('401')) return 'provider';
  if (msg.includes('timeout') || msg.includes('spawn')) return 'client';
  return 'engine';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag} 超时 (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
