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
} from '@shared/types';
import type { EngineAdapter, EngineEventSink } from '../EngineAdapter';
import { NdjsonRpc } from './rpc';
import { codexSpawnEnv, resolveCodexCli } from './resolveCodex';

const INIT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 3_000;

type Json = Record<string, unknown>;

export interface CodexAdapterOptions {
  /** App-managed CODEX_HOME (config.toml points at the embedded proxy). */
  codexHome: string;
  cwd: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  /** Resume an existing thread instead of starting a new one. */
  resumeThreadId?: string;
  /** Optional explicit path to codex bin/codex.js (settings override). */
  cliEntry?: string;
  /** Model aliases to surface in the model picker (from app settings). */
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
    const spec = resolveCodexCli(['app-server'], this.opts.cliEntry);
    const child = spawn(spec.command, spec.args, {
      cwd: this.opts.cwd,
      shell: spec.shell ?? false,
      env: codexSpawnEnv(this.opts.codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
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
      modelProvider: 'cyberslots',
      cwd: this.opts.cwd,
      approvalPolicy: modeCfg.approvalPolicy,
      sandbox: modeCfg.sandbox,
    };
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
        this.emit({
          type: 'error',
          source: 'engine',
          message: `线程恢复失败，已新建线程继续: ${errorMessage(err)}`,
        });
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
    const child = this.child;
    if (child && child.exitCode === null && !child.killed) {
      child.kill();
      const killer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      killer.unref();
    }
    this.child = undefined;
    this.rpc = undefined;
  }

  // ------------------------------------------------------------- actions

  async prompt(text: string, attachments?: string[], effort?: string): Promise<void> {
    const rpc = this.requireRpc();
    const turnId = ++this.turnId;
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
      await rpc.request('thread/goal/clear', { threadId: this.threadId });
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
    // Completed goals are announced then treated as cleared client-side.
    this.emit({ type: 'goal.update', goal: goal.status === 'complete' ? null : goal });
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
      case 'item/completed':
        this.onItem(params.item as Json | undefined, turnId);
        return;
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
        const total = usage?.total as Json | undefined;
        const used = Number(total?.totalTokens ?? 0);
        const size = Number(usage?.modelContextWindow ?? 0);
        this.emit({ type: 'usage.update', used, size });
        return;
      }
      case 'thread/goal/updated':
        this.emitGoal((params.goal as Json | undefined) ?? null);
        return;
      case 'thread/goal/cleared':
        this.emit({ type: 'goal.update', goal: null });
        return;
      case 'turn/completed': {
        const turn = params.turn as Json | undefined;
        const status = String(turn?.status ?? 'completed');
        const err = turn?.error as Json | undefined;
        if (status === 'failed' && err) {
          this.emit({ type: 'error', turnId, source: 'provider', message: String(err.message ?? 'turn failed') });
        }
        this.emit({ type: 'turn.ended', turnId, stopReason: status === 'completed' ? 'end_turn' : status });
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
      return new Promise((resolve) => {
        this.pendingApprovals.set(requestId, {
          resolve: (decision) => resolve({ decision }),
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
