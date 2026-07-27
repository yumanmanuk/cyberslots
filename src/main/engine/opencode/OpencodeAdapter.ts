/**
 * OpencodeAdapter — 每会话一个实例，驱动共享的 opencode serve（HTTP +
 * SSE，探针 scripts/probe-opencode.mjs 对 1.17.18 实测契约），把
 * opencode 事件流翻译为引擎无关的 `EngineEvent`。
 *
 * 关键契约（探针地面真值）：
 * - 回合结束信号 = SSE `session.idle`（HTTP POST message 响应只作错误通道）；
 * - `message.part.updated` 是全量快照非增量 —— 按 partID 记录已发长度自算 delta；
 * - permission 应答 = POST /session/{id}/permissions/{permissionID}
 *   body {response: once|always|reject}；
 * - 模型逐条 prompt 在 body 里带（providerID/modelID 拆自复合 slug）。
 */

import type {
  EngineEvent,
  OpencodeCatalog,
  PermissionMode,
  PermissionOptionView,
  PlanEntry,
  ToolCallStatus,
  UsageInfo,
} from '@shared/types';
import type { EngineAdapter, EngineEventSink } from '../EngineAdapter';
import type { OpencodeEventHub, OpencodeSseEvent } from './OpencodeEventHub';
import type { OpencodeServerHost } from './OpencodeServerHost';

type Json = Record<string, unknown>;

export interface OpencodeAdapterOptions {
  cwd: string;
  /** 复合模型 id：`providerID/modelID`（空 = 首选 zen 免费模型）。 */
  modelId?: string;
  permissionMode?: PermissionMode;
  /** Resume an existing opencode session (server-side persisted). */
  resumeSessionId?: string;
  /** 会话没有客户端历史时恢复失败静默降级。 */
  quietResumeFallback?: boolean;
}

/** permissionMode → opencode agent（auto/yolo 附加自动应答权限）。 */
function agentFor(mode: PermissionMode): string {
  return mode === 'plan' ? 'plan' : 'build';
}

const PERMISSION_OPTIONS: PermissionOptionView[] = [
  { optionId: 'once', name: '允许一次', kind: 'allow_once' },
  { optionId: 'always', name: '本会话总是允许', kind: 'allow_always' },
  { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
];

export class OpencodeAdapter implements EngineAdapter {
  private sessionID = '';
  private turnId = 0;
  private disposed = false;
  private modelId: string;
  private mode: PermissionMode;
  private catalog: OpencodeCatalog = { models: [], defaults: {} };
  /** server 代次绑定 — 进程更替后 prompt 前重订阅/验会话。 */
  private boundGen = -1;
  private hubUnsub: (() => void) | undefined;
  private hostExitUnsub: (() => void) | undefined;
  private turnDone: (() => void) | undefined;
  private turnHadError = false;
  private turnStartedAt = 0;
  /** partID → 已下发字符数（part.updated 全量快照 → 自算增量）。 */
  private readonly partSent = new Map<string, number>();
  /** messageID → role（过滤用户消息 echo 的 part 事件）。 */
  private readonly messageRoles = new Map<string, string>();
  /** 本回合 assistant 消息的 token/cost 快照（message.updated 持续刷新）。 */
  private turnTokens: { input: number; output: number; reasoning: number; cacheRead: number } | undefined;
  private turnCost = 0;
  private readonly pendingPermissions = new Set<string>();

  constructor(
    private readonly opts: OpencodeAdapterOptions,
    private readonly host: OpencodeServerHost,
    private readonly hub: OpencodeEventHub,
    private readonly emit: EngineEventSink,
  ) {
    this.modelId = opts.modelId ?? '';
    this.mode = opts.permissionMode ?? 'default';
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ engineSessionId: string }> {
    this.emit({ type: 'session.status', status: 'starting' });
    await this.host.ensure();
    this.hostExitUnsub = this.host.onExit(() => {
      if (this.disposed) return;
      this.emit({ type: 'error', source: 'engine', message: 'opencode server 进程意外退出（下次发送时自动重启续接）' });
      this.emit({ type: 'session.status', status: 'error', detail: 'server-exited' });
      // 若正处回合中，结束等待避免队列卡死。
      this.finishTurn('error');
    });

    this.catalog = await this.host.getCatalog();

    // 恢复：opencode 会话服务端持久化，GET 验证存在即可续接。
    let sid = '';
    if (this.opts.resumeSessionId) {
      const res = await this.api(`/session/${this.opts.resumeSessionId}`);
      if (res.ok) {
        sid = this.opts.resumeSessionId;
      } else if (!this.opts.quietResumeFallback) {
        this.emit({ type: 'error', source: 'engine', message: `会话恢复失败（HTTP ${res.status}），已新建会话继续` });
      }
    }
    if (!sid) {
      const res = await this.api('/session', { method: 'POST', body: '{}' });
      if (!res.ok) throw new Error(`opencode 建会话失败 (HTTP ${res.status})`);
      sid = String((res.json as Json)?.id ?? '');
      if (!sid) throw new Error('opencode 建会话未返回 id');
    }
    this.sessionID = sid;
    this.subscribe();

    // 模型合法性兑底：合法 slug 必含 '/'（providerID/modelID）——跨引擎
    // fork 继承的旧引擎别名（如 'minimax-m3'）无 '/' 直接视为无效，
    // 否则 prompt 不带 model，server 会静默用自己的默认模型；
    // catalog 可用时未命中条目也重置。重置首选 zen 免费模型（免登录）。
    const modelValid =
      this.modelId.includes('/') && (!this.catalog.models.length || !!this.entryOf(this.modelId));
    if (!modelValid) {
      const free = this.catalog.models.find((m) => m.providerID === 'opencode' && (m.costInput ?? 1) === 0);
      this.modelId = (free ?? this.catalog.models[0])?.slug ?? '';
    }
    this.emitModels();
    this.emit({ type: 'modes.update', current: this.mode, available: ['default', 'plan', 'auto', 'yolo'] });
    this.emit({ type: 'session.status', status: 'idle' });
    return { engineSessionId: this.sessionID };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.hubUnsub?.();
    this.hubUnsub = undefined;
    this.hostExitUnsub?.();
    this.hostExitUnsub = undefined;
    this.pendingPermissions.clear();
    this.turnDone?.();
    this.turnDone = undefined;
    // 共享 server 不杀 —— host 生命周期由主进程退出流程管理。
  }

  // ------------------------------------------------------------- actions

  async prompt(text: string, attachments?: string[], effort?: string): Promise<void> {
    await this.ensureLive();
    const turnId = ++this.turnId;
    this.turnHadError = false;
    this.turnTokens = undefined;
    this.turnCost = 0;
    this.turnStartedAt = Date.now();
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'session.status', status: 'running' });

    // 附件与 kimi 同策：文本注入路径（file part 的 url 语义未经探针验证）。
    let full = text;
    for (const path of attachments ?? []) full += `\n[附件] ${path}`;

    const { providerID, modelID } = this.parseModel();
    const body: Json = {
      parts: [{ type: 'text', text: full }],
      agent: agentFor(this.mode),
    };
    if (providerID && modelID) body.model = { providerID, modelID };
    if (effort) body.variant = effort;

    try {
      const done = new Promise<void>((resolve) => {
        this.turnDone = resolve;
      });
      // HTTP 响应会阻塞到回合完成，但只作错误通道 —— resolve 一律以
      // SSE session.idle 为准（防时序卡死队列）。
      void this.api(`/session/${this.sessionID}/message`, { method: 'POST', body: JSON.stringify(body) })
        .then((res) => {
          if (!res.ok) {
            this.emit({ type: 'error', turnId, source: 'engine', message: `发送失败 (HTTP ${res.status})` });
            this.finishTurn('error');
          }
        })
        .catch((err) => {
          this.emit({ type: 'error', turnId, source: 'client', message: `发送失败: ${errMsg(err)}` });
          this.finishTurn('error');
        });
      await done;
    } finally {
      this.turnDone = undefined;
      if (!this.disposed) this.emit({ type: 'session.status', status: 'idle' });
    }
  }

  async cancel(): Promise<void> {
    if (!this.sessionID) return;
    await this.api(`/session/${this.sessionID}/abort`, { method: 'POST', body: '{}' });
  }

  async setModel(modelId: string): Promise<void> {
    // 下一次 prompt 生效（opencode 无会话级热切换端点）。
    this.modelId = modelId;
    this.emitModels();
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan', 'auto', 'yolo'] });
    // 切到 auto/yolo 时自动应答所有挂起的权限请求。
    if (mode === 'auto' || mode === 'yolo') {
      for (const id of [...this.pendingPermissions]) {
        this.answerPermission(id, mode === 'yolo' ? 'always' : 'once');
      }
    }
  }

  answerPermission(requestId: string, optionId?: string): void {
    if (!this.pendingPermissions.delete(requestId)) return;
    const response = optionId === 'once' || optionId === 'always' || optionId === 'reject' ? optionId : 'reject';
    void this.api(`/session/${this.sessionID}/permissions/${requestId}`, {
      method: 'POST',
      body: JSON.stringify({ response }),
    }).catch(() => undefined);
    this.emit({ type: 'permission.resolved', requestId, optionId });
    if (this.turnDone) this.emit({ type: 'session.status', status: 'running' });
  }

  /** Native fork（服务端复制历史）— sidechat 直接续接。 */
  async fork(): Promise<{ engineSessionId: string } | null> {
    try {
      const res = await this.api(`/session/${this.sessionID}/fork`, { method: 'POST', body: '{}' });
      if (!res.ok) return null;
      const id = String((res.json as Json)?.id ?? '');
      return id ? { engineSessionId: id } : null;
    } catch {
      return null;
    }
  }

  /** Native compaction（summarize），进度走正常事件流。 */
  async compact(): Promise<void> {
    const { providerID, modelID } = this.parseModel();
    await this.api(`/session/${this.sessionID}/summarize`, {
      method: 'POST',
      body: JSON.stringify(providerID && modelID ? { providerID, modelID } : {}),
    });
  }

  // -------------------------------------------------------------- events

  private subscribe(): void {
    this.hubUnsub?.();
    this.hubUnsub = this.hub.subscribe(this.opts.cwd, this.sessionID, (evt) => this.onSse(evt));
    this.boundGen = this.host.gen;
  }

  /** prompt 前置：server 代次变了（崩溃重启）→ 验会话 + 重订阅。 */
  private async ensureLive(): Promise<void> {
    await this.host.ensure();
    if (this.host.gen === this.boundGen) return;
    this.catalog = await this.host.getCatalog();
    const res = await this.api(`/session/${this.sessionID}`);
    if (!res.ok) {
      // 服务端会话丢失（数据目录变化等）— 重建并同步 engineSessionId。
      const created = await this.api('/session', { method: 'POST', body: '{}' });
      if (!created.ok) throw new Error(`opencode 会话重建失败 (HTTP ${created.status})`);
      this.sessionID = String((created.json as Json)?.id ?? '');
      this.emit({ type: 'session.meta', patch: { engineSessionId: this.sessionID } });
    }
    this.subscribe();
  }

  private onSse(evt: OpencodeSseEvent): void {
    if (this.disposed) return;
    const props = evt.properties as Json;
    switch (evt.type) {
      case 'message.updated': {
        const info = props.info as Json | undefined;
        if (!info) return;
        const mid = String(info.id ?? '');
        const role = String(info.role ?? '');
        if (mid) this.messageRoles.set(mid, role);
        if (role === 'assistant') {
          const tokens = info.tokens as Json | undefined;
          if (tokens) {
            const cache = (tokens.cache ?? {}) as Json;
            this.turnTokens = {
              input: num(tokens.input),
              output: num(tokens.output),
              reasoning: num(tokens.reasoning),
              cacheRead: num(cache.read),
            };
          }
          this.turnCost = num(info.cost) || this.turnCost;
        }
        return;
      }
      case 'message.part.updated':
        this.onPart(props.part as Json | undefined);
        return;
      case 'session.idle':
        // 回合结束的唯一 resolve 信号（探针实测 error → idle 顺序）。
        this.finishTurn(this.turnHadError ? 'error' : 'end_turn');
        return;
      case 'session.error': {
        const error = props.error as Json | undefined;
        const data = (error?.data ?? {}) as Json;
        const message = String(data.message ?? error?.name ?? '未知引擎错误');
        this.turnHadError = true;
        this.emit({ type: 'error', turnId: this.turnId, source: 'provider', message });
        return;
      }
      case 'permission.updated': {
        // Permission 对象本体（id 以 per 开头）。auto/yolo → 静默自动应答。
        const id = String(props.id ?? '');
        if (!id) return;
        if (this.mode === 'auto' || this.mode === 'yolo') {
          this.pendingPermissions.add(id);
          this.answerPermission(id, this.mode === 'yolo' ? 'always' : 'once');
          return;
        }
        this.pendingPermissions.add(id);
        this.emit({
          type: 'permission.request',
          turnId: this.turnId,
          requestId: id,
          isQuestion: false,
          title: String(props.title ?? props.type ?? '权限请求'),
          toolCallId: props.callID ? String(props.callID) : undefined,
          options: PERMISSION_OPTIONS,
        });
        this.emit({ type: 'session.status', status: 'awaiting' });
        return;
      }
      case 'permission.replied': {
        // 他端应答（或本端确认回声）— 解除挂起态。
        const id = String(props.permissionID ?? '');
        if (id && this.pendingPermissions.delete(id)) {
          this.emit({ type: 'permission.resolved', requestId: id, optionId: String(props.response ?? '') });
          if (this.turnDone) this.emit({ type: 'session.status', status: 'running' });
        }
        return;
      }
      case 'todo.updated': {
        const todos = Array.isArray(props.todos) ? (props.todos as Json[]) : [];
        const entries: PlanEntry[] = todos
          .filter((t) => String(t.status ?? '') !== 'cancelled')
          .map((t) => ({
            content: String(t.content ?? ''),
            status: mapTodoStatus(String(t.status ?? 'pending')),
            priority: t.priority ? String(t.priority) : undefined,
          }));
        this.emit({ type: 'plan.update', turnId: this.turnId, entries });
        return;
      }
      default:
        return; // session.status/diff/updated 等 — 未知事件静默忽略（版本漂移防御）
    }
  }

  /** part 全量快照 → 增量事件。用户消息的 part 回声按 role 过滤。 */
  private onPart(part: Json | undefined): void {
    if (!part) return;
    const mid = String(part.messageID ?? '');
    const role = this.messageRoles.get(mid);
    if (role !== 'assistant') return; // user echo 或 role 未知（实测 message.updated 先于 part）
    const partID = String(part.id ?? '');
    const turnId = this.turnId;
    switch (part.type) {
      case 'text': {
        const full = String(part.text ?? '');
        const sent = this.partSent.get(partID) ?? 0;
        if (full.length > sent) {
          this.partSent.set(partID, full.length);
          this.emit({ type: 'text.delta', turnId, text: full.slice(sent) });
        }
        return;
      }
      case 'reasoning': {
        const full = String(part.text ?? '');
        const sent = this.partSent.get(partID) ?? 0;
        if (full.length > sent) {
          this.partSent.set(partID, full.length);
          this.emit({ type: 'thinking.delta', turnId, text: full.slice(sent) });
        }
        return;
      }
      case 'tool': {
        const state = (part.state ?? {}) as Json;
        const input = (state.input ?? {}) as Json;
        const tool = String(part.tool ?? 'tool');
        const status = String(state.status ?? 'pending');
        const output = status === 'error' ? String(state.error ?? '') : state.output ? String(state.output) : '';
        const loc = firstString(input.filePath, input.path, input.file);
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: String(part.callID ?? partID),
          title: state.title ? String(state.title) : tool,
          toolKind: mapToolKind(tool),
          status: mapToolStatus(status),
          content: output ? { text: output.slice(0, 20_000) } : undefined,
          locations: loc ? [loc] : undefined,
        });
        return;
      }
      case 'step-finish': {
        // 消息级 tokens 由 message.updated 提供；这里只刷上下文占用。
        const tokens = (part.tokens ?? {}) as Json;
        const cache = (tokens.cache ?? {}) as Json;
        const used = num(tokens.input) + num(tokens.output) + num(tokens.reasoning) + num(cache.read);
        const max = this.entryOf(this.modelId)?.contextWindow ?? 0;
        if (used > 0) this.emit({ type: 'usage.update', used, size: max });
        return;
      }
      default:
        return; // step-start / snapshot / patch / file …
    }
  }

  private finishTurn(stopReason: string): void {
    const done = this.turnDone;
    if (!done) return;
    this.turnDone = undefined;
    const t = this.turnTokens;
    const usage: UsageInfo | undefined = t
      ? {
          inputTokens: t.input,
          outputTokens: t.output + t.reasoning,
          totalTokens: t.input + t.output + t.reasoning + t.cacheRead,
          cachedInputTokens: t.cacheRead || undefined,
          contextUsed: t.input + t.output + t.reasoning + t.cacheRead,
          contextMax: this.entryOf(this.modelId)?.contextWindow,
        }
      : undefined;
    if (this.turnCost > 0) {
      this.emit({
        type: 'usage.update',
        used: usage?.contextUsed ?? 0,
        size: usage?.contextMax ?? 0,
        costUsd: this.turnCost,
      });
    }
    this.emit({
      type: 'turn.ended',
      turnId: this.turnId,
      stopReason,
      usage,
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined,
    });
    done();
  }

  // -------------------------------------------------------------- helpers

  private emitModels(): void {
    this.emit({
      type: 'models.update',
      current: this.modelId,
      available: this.catalog.models.map((m) => m.slug),
    });
  }

  private entryOf(slug: string): (typeof this.catalog.models)[number] | undefined {
    return this.catalog.models.find((m) => m.slug === slug);
  }

  private parseModel(): { providerID: string; modelID: string } {
    const idx = this.modelId.indexOf('/');
    if (idx <= 0) return { providerID: '', modelID: '' };
    return { providerID: this.modelId.slice(0, idx), modelID: this.modelId.slice(idx + 1) };
  }

  private async api(path: string, init?: { method?: string; body?: string }): Promise<{ ok: boolean; status: number; json: unknown }> {
    const res = await fetch(`${this.host.url}${path}`, {
      method: init?.method ?? 'GET',
      body: init?.body,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...this.host.headers(this.opts.cwd),
      },
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { ok: res.ok, status: res.status, json };
  }
}

// ------------------------------------------------------------------ utils

function mapToolKind(tool: string): string {
  const t = tool.toLowerCase();
  if (t.includes('bash') || t.includes('shell')) return 'execute';
  if (t.includes('edit') || t.includes('write') || t.includes('patch')) return 'edit';
  if (t.includes('read') || t.includes('grep') || t.includes('glob') || t.includes('list')) return 'read';
  if (t.includes('fetch') || t.includes('search') || t.includes('web')) return 'fetch';
  if (t.includes('todo')) return 'think';
  return 'other';
}

function mapToolStatus(s: string): ToolCallStatus {
  switch (s) {
    case 'running':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'error':
      return 'failed';
    default:
      return 'pending';
  }
}

function mapTodoStatus(s: string): PlanEntry['status'] {
  if (s === 'in_progress') return 'in_progress';
  if (s === 'completed') return 'completed';
  return 'pending';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
