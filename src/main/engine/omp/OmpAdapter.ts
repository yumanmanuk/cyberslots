/**
 * OmpAdapter — drives one `omp acp` child process (oh-my-pi over the
 * Agent Client Protocol, ndjson JSON-RPC on stdio) and translates its
 * event surface into engine-agnostic `EngineEvent`s.
 *
 * omp is a batteries-included fork of pi: 32 tools, subagents (task),
 * LSP, hashline edits. Its ACP surface is the same shape as kimi's
 * (agent_message_chunk / agent_thought_chunk / tool_call / plan /
 * available_commands_update / current_mode_update / config_option_update),
 * so this adapter mirrors KimiAdapter, plus omp-specific handling:
 *
 *  - Approval + fine thinking levels are NOT on the ACP runtime surface
 *    (probe-omp-findings §3): they ride spawn flags (--approval-mode /
 *    --auto-approve / --thinking / --model). set_mode only toggles
 *    plan<->default; runtime thinking only off/auto.
 *  - Native fork/resume advertised (sessionCapabilities) — no history
 *    replay fallback needed.
 *  - Background turns (async task/jobs results injected after a turn)
 *    are closed with stopReason='background', mirroring codex, so the
 *    race orchestrator doesn't mistake them for a player's submission.
 *  - Virtual URLs (agent://, pr://, conflict://, local://, xd://) are
 *    stripped from tool locations so ChangeTracker never treats them as
 *    real files (probe-omp-findings §7).
 *
 * Verified against omp/17.1.8 (scripts/probe-omp.mjs). prompt event
 * stream shapes are pi-family standard ACP; re-verify with credentials.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

import type {
  EngineEvent,
  PermissionMode,
  PermissionOptionView,
  PlanEntry,
  ToolCallContent,
  ToolCallStatus,
  UsageInfo,
} from '@shared/types';
import type { EngineAdapter, EngineEventSink } from '../EngineAdapter';
import { ThinkSplitter } from '../thinkSplitter';
import { killEngineTree } from '../killTree';
import { compatAudit } from '../compatAudit';
import { resolveOmpCli } from './resolveOmp';

const INIT_TIMEOUT_MS = 30_000;
/** 后台自发回合的静默收尾窗口（无更多事件即判定该 background 回合结束）。 */
const BACKGROUND_QUIET_MS = 1_500;

/** GUI 语境下不适用/危险的斜杠命令（probe-omp-findings §6）。 */
const COMMAND_BLACKLIST = new Set([
  'share', // 发加密链接上公网
  'export', // 导 HTML 文件
  'stats', // 起本地 dashboard
  'computer', // 桌面控制
  'browser', // 浏览器模式切换
  'join', // 加入 collab
  'collab',
  'say', // TTS 播放
  'quit',
  'exit',
]);

/** AskUserQuestion bridge namespace (pi ask tool → q<N>_opt_<M>/skip). */
const QUESTION_OPTION_RE = /^q\d+_(opt_\d+|skip)$/;

/** 非文件系统路径前缀（omp 内部 URL scheme），不喂给 ChangeTracker。 */
const VIRTUAL_URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** permissionMode → spawn flag（approval 精细控制不在 ACP 运行时面）。 */
function approvalArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case 'auto':
      return ['--approval-mode', 'write'];
    case 'yolo':
      return ['--auto-approve'];
    default:
      // default / plan：走 always-ask（写操作触发 request_permission 弹卡）；
      // plan 只读态在 start 后经 set_mode('plan') 施加。
      return ['--approval-mode', 'always-ask'];
  }
}

export interface OmpAdapterOptions {
  cwd: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  /** Resume an existing engine session instead of creating a new one. */
  resumeSessionId?: string;
  /** 会话没有客户端历史时恢复失败静默降级（空会话无上下文可丢）。 */
  quietResumeFallback?: boolean;
  /** Optional explicit path to omp.exe (settings override). */
  cliPath?: string;
  /** spawn --thinking 精细档（赛马 per-role effort 承载；缺省 = 不传）。 */
  thinking?: string;
  /** spawn --tools 白名单（收敛工具面；缺省 = 全量）。 */
  tools?: string[];
}

interface PendingPermission {
  resolve: (r: RequestPermissionResponse) => void;
}

export class OmpAdapter implements EngineAdapter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: ClientSideConnection | undefined;
  private sessionId = '';
  private turnId = 0;
  private disposed = false;
  private promptActive = false;
  private mode: PermissionMode;
  private lastUsage: { used: number; size: number } | undefined;
  private turnOutputChars = 0;
  /** 后台自发回合（异步 task/jobs 结果注入）进行中标记 + 静默收尾计时器。 */
  private backgroundTurnId = 0;
  private backgroundTimer: NodeJS.Timeout | undefined;
  private readonly splitter = new ThinkSplitter();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly stderrTail: string[] = [];

  constructor(
    private readonly opts: OmpAdapterOptions,
    private readonly emit: EngineEventSink,
  ) {
    this.mode = opts.permissionMode ?? 'default';
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ engineSessionId: string }> {
    this.emit({ type: 'session.status', status: 'starting' });
    const args = ['acp', ...approvalArgs(this.mode)];
    if (this.opts.modelId) args.push('--model', this.opts.modelId);
    if (this.opts.thinking) args.push('--thinking', this.opts.thinking);
    if (this.opts.tools?.length) args.push('--tools', this.opts.tools.join(','));
    const spec = resolveOmpCli(args, this.opts.cliPath);

    const child = spawn(spec.command, spec.args, {
      cwd: this.opts.cwd,
      shell: spec.shell ?? false,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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
      if (this.disposed) return;
      this.emit({
        type: 'error',
        source: 'engine',
        message: `omp 进程意外退出 (code=${code} signal=${signal ?? 'none'})\n${this.stderrTail.slice(-8).join('\n')}`,
      });
      this.emit({ type: 'session.status', status: 'error', detail: 'engine-exited' });
    });
    child.on('error', (err) => {
      if (this.disposed) return;
      this.emit({ type: 'error', source: 'client', message: `无法启动 omp CLI: ${err.message}` });
      this.emit({ type: 'session.status', status: 'error', detail: 'spawn-failed' });
    });

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    this.client = new ClientSideConnection(() => this.buildClient(), stream);

    await withTimeout(
      this.client.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }),
      INIT_TIMEOUT_MS,
      'ACP initialize',
    );

    const sess = await this.openSession();
    this.sessionId = sess.sessionId;
    this.applyConfigOptions(sess.configOptions);

    // plan 只读态：ACP set_mode 支持 plan<->default；auto/yolo 的自动批准
    // 已由 spawn flag 施加，运行时视为 default。
    if (this.mode === 'plan') {
      await this.applyMode('plan').catch(() => undefined);
    }

    this.emit({ type: 'session.status', status: 'idle' });
    return { engineSessionId: this.sessionId };
  }

  /** Resume the persisted engine session when possible, else start fresh. */
  private async openSession(): Promise<{ sessionId: string; configOptions?: unknown }> {
    const client = this.client!;
    if (this.opts.resumeSessionId) {
      try {
        const res = await withTimeout(
          client.loadSession({
            sessionId: this.opts.resumeSessionId,
            cwd: this.opts.cwd,
            mcpServers: [],
          } as never),
          INIT_TIMEOUT_MS,
          'ACP session/load',
        );
        return {
          sessionId: this.opts.resumeSessionId,
          configOptions: (res as { configOptions?: unknown }).configOptions,
        };
      } catch (err) {
        if (!this.opts.quietResumeFallback) {
          this.emit({
            type: 'error',
            source: 'engine',
            message: `会话恢复失败，已新建会话继续（历史上下文不在引擎侧）: ${errorMessage(err)}`,
          });
        }
      }
    }
    const sess = await withTimeout(
      client.newSession({ cwd: this.opts.cwd, mcpServers: [] }),
      INIT_TIMEOUT_MS,
      'ACP session/new',
    );
    return sess as { sessionId: string; configOptions?: unknown };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.pendingPermissions.delete(id);
    }
    if (this.child) killEngineTree(this.child);
    this.child = undefined;
    this.client = undefined;
  }

  // ------------------------------------------------------------- actions

  async prompt(text: string, attachments?: string[], effort?: string): Promise<void> {
    const client = this.requireClient();
    // 新回合开始前先收尾未结束的后台自发回合，避免两个回合交叠。
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.closeBackgroundTurn();
    // effort → ACP thinking（只吃 off/auto）；精细档由 spawn --thinking 承载。
    await this.applyThinking(effort).catch(() => undefined);

    const turnId = ++this.turnId;
    this.splitter.reset();
    this.promptActive = true;
    this.turnOutputChars = 0;
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'session.status', status: 'running' });
    const started = Date.now();
    try {
      const blocks: Array<Record<string, unknown>> = [{ type: 'text', text }];
      for (const path of attachments ?? []) {
        blocks.push({ type: 'resource_link', uri: pathToFileUri(path), name: path });
      }
      const res = await client.prompt({ sessionId: this.sessionId, prompt: blocks as never });
      for (const part of this.splitter.flush()) {
        this.emit({ type: part.kind === 'thinking' ? 'thinking.delta' : 'text.delta', turnId, text: part.text });
      }
      // 优先级：prompt 响应的真实 usage（实测 17.1.8 带 inputTokens/
      // outputTokens/totalTokens/cachedReadTokens）> usage_update 快照 > 估算。
      const resUsage = (res as { usage?: Record<string, unknown> }).usage;
      const usage: UsageInfo = resUsage
        ? {
            inputTokens: numOrU(resUsage.inputTokens),
            outputTokens: numOrU(resUsage.outputTokens),
            totalTokens: numOrU(resUsage.totalTokens),
            cachedInputTokens: numOrU(resUsage.cachedReadTokens),
            contextUsed: this.lastUsage?.used,
            contextMax: this.lastUsage?.size || undefined,
          }
        : this.lastUsage
          ? { contextUsed: this.lastUsage.used, contextMax: this.lastUsage.size || undefined }
          : { outputTokens: estimateTokens(this.turnOutputChars), approx: true };
      this.emit({ type: 'turn.ended', turnId, stopReason: res.stopReason, usage, durationMs: Date.now() - started });
    } catch (err) {
      this.emit({ type: 'error', turnId, source: classifyError(err), message: errorMessage(err) });
      this.emit({ type: 'turn.ended', turnId, stopReason: 'error' });
    } finally {
      this.promptActive = false;
      if (!this.disposed) this.emit({ type: 'session.status', status: 'idle' });
    }
  }

  async cancel(): Promise<void> {
    if (!this.promptActive) return;
    await this.requireClient().cancel({ sessionId: this.sessionId });
  }

  async setModel(modelId: string): Promise<void> {
    const client = this.requireClient();
    try {
      await client.unstable_setSessionModel({ sessionId: this.sessionId, modelId });
    } catch {
      await client.setSessionConfigOption({ sessionId: this.sessionId, optionId: 'model', value: modelId } as never);
    }
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    await this.applyMode(mode);
  }

  /** ACP set_mode 只认 plan/default；auto/yolo 折叠为 default（自动批准靠 spawn flag，需重开生效）。 */
  private async applyMode(mode: PermissionMode): Promise<void> {
    const modeId = mode === 'plan' ? 'plan' : 'default';
    await this.requireClient().setSessionMode({ sessionId: this.sessionId, modeId });
  }

  /** effort → ACP thinking config option。档位是动态的（实测：带模型后
   *  configOptions 扩展出目录 thinking[] 的精细档，如 high/max）：
   *  先原值直发，被拒（档位不在当前模型值域）时降级 auto。 */
  private async applyThinking(effort?: string): Promise<void> {
    if (!effort) return; // 未指定 = 跟随会话当前档，不下发
    const client = this.requireClient();
    const setThinking = (value: string): Promise<unknown> =>
      client.setSessionConfigOption({ sessionId: this.sessionId, optionId: 'thinking', value } as never);
    try {
      await setThinking(effort);
    } catch {
      if (effort !== 'off' && effort !== 'auto') await setThinking('auto');
    }
  }

  /** Native sidechat fork — omp advertises sessionCapabilities.fork
   *  (probe-omp-findings §2); session/fork returns a fresh sessionId. */
  async fork(): Promise<{ engineSessionId: string } | null> {
    const client = this.requireClient();
    try {
      const res = await withTimeout(
        client.unstable_forkSession({ sessionId: this.sessionId, cwd: this.opts.cwd, mcpServers: [] } as never),
        INIT_TIMEOUT_MS,
        'ACP session/fork',
      );
      const forkedId = String((res as { sessionId?: unknown }).sessionId ?? '');
      return forkedId ? { engineSessionId: forkedId } : null;
    } catch (err) {
      // omp 实报 fork 能力（probe ⑧）— 被拒即协议漂移信号，入账。
      compatAudit.record('omp', 'rejected-method', 'unstable_forkSession', errorMessage(err));
      return null;
    }
  }

  /** Context compaction rides the native /compact-style flow as a turn. */
  async compact(): Promise<void> {
    await this.prompt('/compact');
  }

  answerPermission(requestId: string, optionId?: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve(
      optionId === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId } },
    );
    this.emit({ type: 'permission.resolved', requestId, optionId });
    if (this.promptActive) this.emit({ type: 'session.status', status: 'running' });
  }

  // ------------------------------------------------------- ACP callbacks

  private buildClient(): Client {
    return {
      sessionUpdate: async (n: SessionNotification) => this.onSessionUpdate(n),
      requestPermission: async (p: RequestPermissionRequest) => this.onRequestPermission(p),
      readTextFile: async () => {
        throw new Error('fs.readTextFile capability not enabled');
      },
      writeTextFile: async () => {
        throw new Error('fs.writeTextFile capability not enabled');
      },
    } as unknown as Client;
  }

  private onSessionUpdate(n: SessionNotification): void {
    const u = n.update as Record<string, unknown> & { sessionUpdate: string };
    // 内容/工具类事件在无活跃 prompt 时到达 = 引擎自发回合（异步 task 结果注入）。
    const contentish = ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'plan_update'];
    if (!this.promptActive && contentish.includes(u.sessionUpdate)) {
      this.ensureBackgroundTurn();
    }
    const turnId = this.promptActive ? this.turnId : this.backgroundTurnId || this.turnId;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(u);
        if (!text) return;
        this.turnOutputChars += text.length;
        if (this.promptActive) {
          for (const part of this.splitter.push(text)) {
            this.emit({ type: part.kind === 'thinking' ? 'thinking.delta' : 'text.delta', turnId, text: part.text });
          }
        } else {
          this.emit({ type: 'text.delta', turnId, text });
        }
        return;
      }
      case 'agent_thought_chunk': {
        const text = contentText(u);
        if (text) this.emit({ type: 'thinking.delta', turnId, text });
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: String(u.toolCallId ?? ''),
          title: u.title == null ? undefined : String(u.title),
          toolKind: u.kind == null ? undefined : String(u.kind),
          toolName: extractToolName(u),
          status: u.status == null ? undefined : (mapStatus(String(u.status)) as ToolCallStatus),
          content: mapToolContent(u),
          locations: mapLocations(u.locations),
        });
        return;
      }
      case 'plan':
      case 'plan_update': {
        const entries = mapPlanEntries(u.entries);
        if (entries) this.emit({ type: 'plan.update', turnId, entries });
        return;
      }
      case 'available_commands_update': {
        const cmds = Array.isArray(u.availableCommands) ? u.availableCommands : [];
        this.emit({
          type: 'commands.update',
          commands: cmds
            .map((c: Record<string, unknown>) => ({
              name: String(c.name ?? ''),
              description: c.description == null ? undefined : String(c.description),
              hint:
                (c.input as { hint?: unknown } | undefined)?.hint == null
                  ? undefined
                  : String((c.input as { hint?: unknown }).hint),
            }))
            .filter((c) => c.name && !COMMAND_BLACKLIST.has(c.name)),
        });
        return;
      }
      case 'config_option_update': {
        this.applyConfigOptions(u.configOptions);
        return;
      }
      case 'current_mode_update': {
        const mode = String(u.currentModeId ?? '') as PermissionMode;
        if (mode) this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan'] });
        return;
      }
      case 'usage_update': {
        const cost = u.cost as { amount?: number } | null | undefined;
        this.lastUsage = { used: Number(u.used ?? 0), size: Number(u.size ?? 0) };
        this.emit({
          type: 'usage.update',
          used: Number(u.used ?? 0),
          size: Number(u.size ?? 0),
          costUsd: typeof cost?.amount === 'number' ? cost.amount : undefined,
        });
        return;
      }
      default:
        // user_message_chunk 等已知无 UI 影响的 kind 静默；真正未知的进审计。
        if (!['user_message_chunk', 'session_info_update', 'plan_removed'].includes(u.sessionUpdate)) {
          compatAudit.record('omp', 'unknown-event', `sessionUpdate:${u.sessionUpdate}`, u);
        }
        return;
    }
  }

  /** 开启（或续期）一个后台自发回合：首个事件补 turn.started，静默 1.5s 后补 background 收尾。 */
  private ensureBackgroundTurn(): void {
    if (!this.backgroundTurnId) {
      this.backgroundTurnId = ++this.turnId;
      this.emit({ type: 'turn.started', turnId: this.backgroundTurnId });
    }
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = setTimeout(() => this.closeBackgroundTurn(), BACKGROUND_QUIET_MS);
  }

  private closeBackgroundTurn(): void {
    if (!this.backgroundTurnId) return;
    const turnId = this.backgroundTurnId;
    this.backgroundTurnId = 0;
    this.backgroundTimer = undefined;
    // stopReason='background'：赛马 onTurnEnded 过滤、通知抑制均据此对齐 codex。
    this.emit({ type: 'turn.ended', turnId, stopReason: 'background' });
  }

  private onRequestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = randomUUID();
    const options: PermissionOptionView[] = (p.options ?? []).map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: String(o.kind ?? 'allow_once'),
    }));
    const isQuestion = options.length > 0 && options.every((o) => QUESTION_OPTION_RE.test(o.optionId));
    const title = p.toolCall?.title ? String(p.toolCall.title) : isQuestion ? '模型提问' : '请求授权';

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(requestId, { resolve });
      this.emit({
        type: 'permission.request',
        turnId: this.turnId,
        requestId,
        isQuestion,
        title,
        toolCallId: p.toolCall?.toolCallId ? String(p.toolCall.toolCallId) : undefined,
        options,
      });
      this.emit({ type: 'session.status', status: 'awaiting' });
    });
  }

  // -------------------------------------------------------------- helpers

  private applyConfigOptions(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const opt of raw as Array<Record<string, unknown>>) {
      const id = String(opt.id ?? '');
      const current = String(opt.currentValue ?? '');
      const values = Array.isArray(opt.options)
        ? (opt.options as Array<Record<string, unknown>>).map((o) => String(o.value ?? ''))
        : [];
      if (id === 'model') {
        this.emit({ type: 'models.update', current, available: values });
      } else if (id === 'mode') {
        this.emit({
          type: 'modes.update',
          current: current as PermissionMode,
          available: values as PermissionMode[],
        });
      }
    }
  }

  private requireClient(): ClientSideConnection {
    if (!this.client || this.disposed) throw new Error('omp session is not running');
    return this.client;
  }
}

// ------------------------------------------------------------------ utils

function contentText(u: Record<string, unknown>): string {
  const c = u.content as { type?: string; text?: string } | undefined;
  return c?.type === 'text' && typeof c.text === 'string' ? c.text : '';
}

/** omp tool_call 的原始工具名（rawInput.name / title 兜底）供明细行动词。 */
function extractToolName(u: Record<string, unknown>): string | undefined {
  const raw = u.rawInput as { name?: unknown } | undefined;
  if (raw?.name) return String(raw.name);
  const name = u.toolName ?? u.name;
  return name == null ? undefined : String(name);
}

/** omp/pi 的 tool status → cyberslots ToolCallStatus（含两阶段 proposed）。 */
function mapStatus(s: string): string {
  switch (s) {
    case 'proposed':
    case 'awaiting_confirmation':
      return 'proposed';
    case 'in_progress':
    case 'running':
      return 'in_progress';
    case 'completed':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return s;
  }
}

function mapToolContent(u: Record<string, unknown>): ToolCallContent | undefined {
  const raw = u.content;
  const out: ToolCallContent = {};
  const texts: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw as Array<Record<string, unknown>>) {
      if (item.type === 'diff') {
        out.diff = {
          path: String(item.path ?? ''),
          oldText: item.oldText == null ? undefined : String(item.oldText),
          newText: item.newText == null ? undefined : String(item.newText),
        };
      } else if (item.type === 'content') {
        const inner = item.content as { type?: string; text?: string } | undefined;
        if (inner?.type === 'text' && inner.text) texts.push(inner.text);
      }
    }
  }
  // hashline / ast_edit 的统一 patch 文本（若引擎在 update 顶层给出）。
  if (typeof u.patch === 'string') out.patch = u.patch;
  // 子代理（task）进度流：最新进度行 + 尾部输出（probe 待凭据补测形态）。
  const prog = u.progress as { line?: unknown; tail?: unknown } | undefined;
  if (prog && (prog.line != null || Array.isArray(prog.tail))) {
    out.progress = {
      line: prog.line == null ? '' : String(prog.line),
      tail: Array.isArray(prog.tail) ? (prog.tail as unknown[]).map((t) => String(t)) : undefined,
    };
  }
  // 工具输出图片（generate_image / inspect_image 结果）。
  const imgs = collectImages(raw);
  if (imgs.length) out.images = imgs;
  if (texts.length > 0) out.text = texts.join('\n');
  return out.text || out.diff || out.patch || out.progress || out.images ? out : undefined;
}

/** 从 tool content 数组里提取图片（data URI 或 file 路径）。 */
function collectImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (item.type === 'image') {
      const data = item.data ?? item.uri;
      const mime = String(item.mimeType ?? 'image/png');
      if (typeof data === 'string' && data) {
        out.push(data.startsWith('data:') || VIRTUAL_URI_RE.test(data) ? data : `data:${mime};base64,${data}`);
      }
    }
  }
  return out;
}

function mapLocations(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const paths = (raw as Array<Record<string, unknown>>)
    .map((l) => String(l.path ?? ''))
    .filter((p) => p && !VIRTUAL_URI_RE.test(p)); // 剔除 agent:// / pr:// 等虚拟 URL
  return paths.length > 0 ? paths : undefined;
}

function mapPlanEntries(raw: unknown): PlanEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return (raw as Array<Record<string, unknown>>).map((e) => ({
    content: String(e.content ?? ''),
    status: (String(e.status ?? 'pending') as PlanEntry['status']) || 'pending',
    priority: e.priority == null ? undefined : String(e.priority),
  }));
}

function classifyError(err: unknown): 'client' | 'engine' | 'provider' {
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes('auth') || msg.includes('credential') || msg.includes('api key')) return 'provider';
  if (msg.includes('timeout') || msg.includes('spawn')) return 'client';
  return 'engine';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function pathToFileUri(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 1.7));
}

function numOrU(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag} 超时 (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
