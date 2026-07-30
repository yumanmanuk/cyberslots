/**
 * KimiAdapter — drives one `kimi acp` child process over the Agent
 * Client Protocol (ndjson JSON-RPC on stdio) and translates the ACP
 * event surface into engine-agnostic `EngineEvent`s.
 *
 * Protocol surface verified against kimi CLI 0.29.1 in phase 0
 * (docs/phase0-findings.md): initialize / session/new / session/prompt /
 * unstable_setSessionModel / setSessionMode / cancel, update kinds
 * agent_message_chunk · agent_thought_chunk · tool_call(_update) ·
 * plan · available_commands_update · config_option_update · usage_update.
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
import { kimiSpawnEnv, resolveKimiCli } from './resolveKimi';

const INIT_TIMEOUT_MS = 30_000;

/** 已知且刻意不渲染的 update kind — 不进兼容审计（不是协议漂移）。 */
const KNOWN_IGNORED_UPDATES = new Set(['user_message_chunk', 'session_info_update', 'plan_removed']);

/** AskUserQuestion bridge namespace (acp-adapter/src/question.ts). */
const QUESTION_OPTION_RE = /^q\d+_(opt_\d+|skip)$/;

export interface KimiAdapterOptions {
  /** 路由镜像 home（设 KIMI_CODE_HOME）；缺省 = 用户自己的 ~/.kimi-code。 */
  kimiHome?: string;
  /** Session working directory. */
  cwd: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  /** Resume an existing engine session instead of creating a new one. */
  resumeSessionId?: string;
  /** 会话没有客户端历史时恢复失败静默降级（空会话无上下文可丢）。 */
  quietResumeFallback?: boolean;
  /** Optional explicit path to kimi dist/main.mjs (settings override). */
  cliEntry?: string;
}

interface PendingPermission {
  resolve: (r: RequestPermissionResponse) => void;
}

export class KimiAdapter implements EngineAdapter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: ClientSideConnection | undefined;
  private sessionId = '';
  private turnId = 0;
  private disposed = false;
  private promptActive = false;
  /** Latest usage_update snapshot — folded into turn.ended stats. */
  private lastUsage: { used: number; size: number } | undefined;
  /** 本回合流出的正文字符数 — kimi ACP 实测不推 usage_update
   *  （scripts/probe-usage.mjs），下行 token 只能估算（UI 带 ~）。 */
  private turnOutputChars = 0;
  private readonly splitter = new ThinkSplitter();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly stderrTail: string[] = [];

  constructor(
    private readonly opts: KimiAdapterOptions,
    private readonly emit: EngineEventSink,
  ) {}

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ engineSessionId: string }> {
    this.emit({ type: 'session.status', status: 'starting' });
    const spec = resolveKimiCli(['acp'], this.opts.cliEntry);
    const child = spawn(spec.command, spec.args, {
      cwd: this.opts.cwd,
      shell: spec.shell ?? false,
      env: kimiSpawnEnv(this.opts.kimiHome),
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
      if (this.disposed) return;
      this.emit({
        type: 'error',
        source: 'engine',
        message: `kimi 进程意外退出 (code=${code} signal=${signal ?? 'none'})\n${this.stderrTail.slice(-8).join('\n')}`,
      });
      this.emit({ type: 'session.status', status: 'error', detail: 'engine-exited' });
    });
    child.on('error', (err) => {
      if (this.disposed) return;
      this.emit({ type: 'error', source: 'client', message: `无法启动 kimi CLI: ${err.message}` });
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

    if (this.opts.modelId) await this.setModel(this.opts.modelId).catch(() => undefined);
    if (this.opts.permissionMode && this.opts.permissionMode !== 'default') {
      await this.setMode(this.opts.permissionMode).catch(() => undefined);
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
          client.resumeSession({
            sessionId: this.opts.resumeSessionId,
            cwd: this.opts.cwd,
            mcpServers: [],
          } as never),
          INIT_TIMEOUT_MS,
          'ACP session/resume',
        );
        return { sessionId: this.opts.resumeSessionId, configOptions: (res as { configOptions?: unknown }).configOptions };
      } catch (err) {
        // 空会话不弹红色报错 — 无上下文可丢，降级对用户无感。
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
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.pendingPermissions.delete(id);
    }
    // 树杀：孙进程继承了 SingletonLock 句柄，残留会堵死下次启动。
    if (this.child) killEngineTree(this.child);
    this.child = undefined;
    this.client = undefined;
  }

  // ------------------------------------------------------------- actions

  async prompt(text: string, attachments?: string[]): Promise<void> {
    const client = this.requireClient();
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
      const res = await client.prompt({
        sessionId: this.sessionId,
        prompt: blocks as never,
      });
      for (const part of this.splitter.flush()) {
        this.emit({ type: part.kind === 'thinking' ? 'thinking.delta' : 'text.delta', turnId, text: part.text });
      }
      // 真实 usage 优先；没有就给字符数估算的下行 token（approx 标记）。
      const usage: UsageInfo = this.lastUsage
        ? { contextUsed: this.lastUsage.used, contextMax: this.lastUsage.size || undefined }
        : { outputTokens: estimateTokens(this.turnOutputChars), approx: true };
      this.emit({
        type: 'turn.ended',
        turnId,
        stopReason: res.stopReason,
        usage,
        durationMs: Date.now() - started,
      });
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
    } catch (err) {
      // 降级路径本身正常（旧版无此实验方法），但要留账：新版引擎若砍掉
      // 此方法，这里是唯一能看到信号的地方。
      compatAudit.record('kimi', 'rejected-method', 'unstable_setSessionModel', errorMessage(err));
      await client.setSessionConfigOption({
        sessionId: this.sessionId,
        optionId: 'model',
        value: modelId,
      } as never);
    }
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.requireClient().setSessionMode({ sessionId: this.sessionId, modeId: mode });
  }

  /** Native sidechat fork via ACP unstable_forkSession.
   *  Probed on kimi CLI 0.29.1: responds -32601 "Method not found" —
   *  callers must treat null as "unsupported" and fall back to history
   *  replay (scripts/probe-fork.mjs). Kept as the preferred path so newer
   *  CLIs upgrade to a true engine-side fork automatically. */
  async fork(): Promise<{ engineSessionId: string } | null> {
    const client = this.requireClient();
    try {
      const res = await withTimeout(
        client.unstable_forkSession({
          sessionId: this.sessionId,
          cwd: this.opts.cwd,
          mcpServers: [],
        } as never),
        INIT_TIMEOUT_MS,
        'ACP session/fork',
      );
      const forkedId = String((res as { sessionId?: unknown }).sessionId ?? '');
      return forkedId ? { engineSessionId: forkedId } : null;
    } catch (err) {
      // Method not found / timeout → unsupported；降级静默但证据入账。
      compatAudit.record('kimi', 'rejected-method', 'unstable_forkSession', errorMessage(err));
      return null;
    }
  }

  /** Context compaction rides the CLI's native /compact slash command
   *  (listed in available_commands, phase 0). Runs as a normal turn. */
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
    const turnId = this.turnId;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(u);
        if (!text) return;
        this.turnOutputChars += text.length;
        for (const part of this.splitter.push(text)) {
          this.emit({ type: part.kind === 'thinking' ? 'thinking.delta' : 'text.delta', turnId, text: part.text });
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
          status: u.status == null ? undefined : (String(u.status) as ToolCallStatus),
          content: mapToolContent(u.content),
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
          commands: cmds.map((c: Record<string, unknown>) => ({
            name: String(c.name ?? ''),
            description: c.description == null ? undefined : String(c.description),
          })),
        });
        return;
      }
      case 'config_option_update': {
        this.applyConfigOptions(u.configOptions);
        return;
      }
      case 'current_mode_update': {
        const mode = String(u.currentModeId ?? '') as PermissionMode;
        if (mode) this.emit({ type: 'modes.update', current: mode, available: [] });
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
        // user_message_chunk / session_info_update / plan_removed — no UI impact yet.
        // 真正未知的 kind = 引擎升级新增能力信号 → 进兼容审计。
        if (!KNOWN_IGNORED_UPDATES.has(u.sessionUpdate)) {
          compatAudit.record('kimi', 'unknown-event', `sessionUpdate:${u.sessionUpdate}`, u);
        }
        return;
    }
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
        // 登录失效/会员权益不可用时 CLI 返回空模型列表，且 prompt 会静默
        // end_turn（实测 0.29.1，scripts/probe-debug.mjs）— 提前把可诊断错误抛给 UI。
        if (!current && values.length === 0) {
          this.emit({
            type: 'error',
            source: 'provider',
            message:
              'Kimi CLI 没有可用模型（config.toml 无 provider/模型）。请在终端运行 `kimi login` 重新登录（需会员权益有效），或在 ~/.kimi-code/config.toml 手动配置 provider 与 default_model，然后重开会话。',
          });
        }
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
    if (!this.client || this.disposed) throw new Error('Kimi session is not running');
    return this.client;
  }
}

// ------------------------------------------------------------------ utils

function contentText(u: Record<string, unknown>): string {
  const c = u.content as { type?: string; text?: string } | undefined;
  return c?.type === 'text' && typeof c.text === 'string' ? c.text : '';
}

function mapToolContent(raw: unknown): ToolCallContent | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ToolCallContent = {};
  const texts: string[] = [];
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
  if (texts.length > 0) out.text = texts.join('\n');
  return out.text || out.diff ? out : undefined;
}

function mapLocations(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const paths = (raw as Array<Record<string, unknown>>)
    .map((l) => String(l.path ?? ''))
    .filter(Boolean);
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
  if (msg.includes('auth')) return 'provider';
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

/** 粗粒度 token 估算：混合中英文按 ≈ 1 token / 1.7 字符。只用于
 *  无真实 usage 时的展示兜底，UI 会带 ~ 标注。 */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 1.7));
}

function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag} 超时 (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
