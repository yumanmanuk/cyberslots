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
  ToolCallContent,
  ToolCallStatus,
  UsageInfo,
} from '@shared/types';
import type { EngineAdapter, EngineEventSink } from '../EngineAdapter';
import { L } from '../../i18n';
import { ThinkSplitter } from '../thinkSplitter';
import { compatAudit } from '../compatAudit';
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
  /** 多根工作区的其余根目录。opencode 引擎侧无多根概念（单
   *  directory/worktree 边界），根外访问走 external_directory 权限
   *  审批（默认 ask）—— 这里通过会话级 permission ruleset 预放行，
   *  免去每次访问额外目录都弹权限卡。 */
  extraDirs?: string[];
}

/** permissionMode → opencode agent（auto/yolo 附加自动应答权限）。 */
function agentFor(mode: PermissionMode): string {
  return mode === 'plan' ? 'plan' : 'build';
}

/** 权限选项现用现算 — 标签随当前界面语言（模块级常量会冻结启动时语言）。 */
function permissionOptions(): PermissionOptionView[] {
  return [
    { optionId: 'once', name: L('允许一次', 'Allow once'), kind: 'allow_once' },
    { optionId: 'always', name: L('本会话总是允许', 'Always allow in this session'), kind: 'allow_always' },
    { optionId: 'reject', name: L('拒绝', 'Reject'), kind: 'reject_once' },
  ];
}

/** 已知且刻意不渲染的 SSE 事件/part 类型 — 不进兼容审计。 */
const KNOWN_IGNORED_SSE = new Set(['session.status', 'session.diff', 'session.updated', 'message.part.removed', 'message.removed']);
const KNOWN_IGNORED_PARTS = new Set(['step-start', 'snapshot', 'patch', 'file']);

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
  /** 已回填真实思考时长的 reasoning partID（time.end 只报一次）。 */
  private readonly reasoningEndSent = new Set<string>();
  /** MiniMax-M3 等模型把 `<think>` 内联在 text part 里（opencode 不拆），二次分流。 */
  private readonly splitter = new ThinkSplitter();
  /** messageID → role（过滤用户消息 echo 的 part 事件）。 */
  private readonly messageRoles = new Map<string, string>();
  /** 本回合 assistant 消息的 token/cost 快照（message.updated 持续刷新）。 */
  private turnTokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } | undefined;
  private turnCost = 0;
  /** 本回合 API 调用计数 — 每个 step-finish = 一次 LLM 请求完成。 */
  private turnApiCalls = 0;
  private readonly pendingPermissions = new Set<string>();
  /** 服务端命令名拦截表（小写）：GET /command 拉取，prompt 时命中改走原生命令端点。 */
  private serverCommands = new Set<string>();

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
      if (this.turnDone) {
        // 回合进行中服务器停机 = 真错误：报错 + 结束等待防队列卡死。
        this.emit({ type: 'error', source: 'engine', message: L('opencode server 进程退出，当前回合中断（下次发送自动重启续接）', 'opencode server exited — current turn interrupted (auto-restarts on next send)') });
        this.emit({ type: 'session.status', status: 'error', detail: 'server-exited' });
        this.finishTurn('error');
      } else {
        // 空闲时停机（如强制刷新模型目录重启 serve）= 懒唤醒态，
        // 非错误 —— 下次 prompt 的 ensureLive 自动重连续接。
        this.emit({ type: 'session.status', status: 'closed', detail: 'server-stopped' });
      }
    });

    this.catalog = await this.host.getCatalog();

    // 恢复：opencode 会话服务端持久化，GET 验证存在即可续接。
    let sid = '';
    let resumed = false;
    if (this.opts.resumeSessionId) {
      const res = await this.api(`/session/${this.opts.resumeSessionId}`);
      if (res.ok) {
        sid = this.opts.resumeSessionId;
        resumed = true;
      } else if (!this.opts.quietResumeFallback) {
        this.emit({ type: 'error', source: 'engine', message: L(`会话恢复失败（HTTP ${res.status}），已新建会话继续`, `Session resume failed (HTTP ${res.status}) — started a new session to continue`) });
      }
    }
    if (!sid) {
      sid = await this.createSession();
    }
    this.sessionID = sid;
    // 恢复路径不经建会 body —— 额外目录的预放行改走 PATCH 合并
    //（目录集可能在两次启动间变过；merge 语义重复无害）。
    if (resumed) await this.grantExtraDirs(sid);
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
    // 服务端命令清单（opencode.json/插件/md 命令全集，目录扫描覆盖不到
    // 前两类）→ 斜杠面板「引擎命令」组 + prompt 拦截表。best effort。
    await this.refreshCommands().catch(() => undefined);
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
    // 服务端已知命令拦截：server 不解析 message 文本里的斜杠（TUI 职责），
    // 命中清单即改走原生命令端点；带附件时不拦截（command 端点无 parts 字段）。
    const slash = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (slash && !attachments?.length && this.serverCommands.has(slash[1]!.toLowerCase())) {
      await this.command(slash[1]!, (slash[2] ?? '').trim());
      return;
    }
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
    await this.runTurn(`/session/${this.sessionID}/message`, body);
  }

  /** 原生斜杠命令回合：POST /session/{id}/command，服务端展开命令模板
   *  （opencode server 不解析 message 文本里的斜杠 — TUI 侧职责，
   *  此处由 SessionManager 的发送侧斜杠路由调度进来）。 */
  async command(name: string, args: string): Promise<void> {
    await this.ensureLive();
    const { providerID, modelID } = this.parseModel();
    const body: Json = { command: name, arguments: args, agent: agentFor(this.mode) };
    if (providerID && modelID) body.model = { providerID, modelID };
    await this.runTurn(`/session/${this.sessionID}/command`, body);
  }

  /** 服务端命令清单：GET /command → commands.update（斜杠面板）+ 拦截表。 */
  private async refreshCommands(): Promise<void> {
    const res = await this.api('/command');
    if (!res.ok || !Array.isArray(res.json)) return;
    const commands = (res.json as Array<Record<string, unknown>>)
      .map((c) => ({
        name: String(c.name ?? ''),
        description: c.description == null ? undefined : String(c.description),
      }))
      .filter((c) => c.name);
    this.serverCommands = new Set(commands.map((c) => c.name.toLowerCase()));
    if (commands.length) this.emit({ type: 'commands.update', commands });
  }

  /** 共享回合生命周期：HTTP 响应会阻塞到回合完成，但只作错误通道 ——
   *  resolve 一律以 SSE session.idle 为准（防时序卡死队列）。 */
  private async runTurn(path: string, body: Json): Promise<void> {
    const turnId = ++this.turnId;
    this.turnHadError = false;
    this.splitter.reset();
    this.turnTokens = undefined;
    this.turnCost = 0;
    this.turnApiCalls = 0;
    this.turnStartedAt = Date.now();
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'session.status', status: 'running' });

    try {
      const done = new Promise<void>((resolve) => {
        this.turnDone = resolve;
      });
      void this.api(path, { method: 'POST', body: JSON.stringify(body) })
        .then((res) => {
          if (!res.ok) {
            this.emit({ type: 'error', turnId, source: 'engine', message: L(`发送失败 (HTTP ${res.status})`, `Send failed (HTTP ${res.status})`) });
            this.finishTurn('error');
          }
        })
        .catch((err) => {
          this.emit({ type: 'error', turnId, source: 'client', message: `${L('发送失败', 'Send failed')}: ${errMsg(err)}` });
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
      if (!res.ok) {
        // 非 2xx = server 版本不支持/禁用了 fork — 降级静默，证据入账。
        compatAudit.record('opencode', 'rejected-method', 'POST /session/:id/fork', `HTTP ${res.status}`);
        return null;
      }
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
      this.sessionID = await this.createSession();
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
              cacheWrite: num(cache.write),
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
        const message = String(data.message ?? error?.name ?? L('未知引擎错误', 'Unknown engine error'));
        this.turnHadError = true;
        this.emit({ type: 'error', turnId: this.turnId, source: 'provider', message });
        return;
      }
      case 'permission.updated':
      case 'permission.asked': {
        // 1.17.x 发 permission.updated（Permission 对象）；1.18.x 改名
        // permission.asked（Request 对象，无 title、tool 下挂 callID）。
        // 两套字段兼容取值，避免升级 server 后权限卡消失。
        const id = String(props.id ?? '');
        if (!id) return;
        if (this.mode === 'auto' || this.mode === 'yolo') {
          this.pendingPermissions.add(id);
          this.answerPermission(id, this.mode === 'yolo' ? 'always' : 'once');
          return;
        }
        const tool = (props.tool ?? {}) as Json;
        this.pendingPermissions.add(id);
        this.emit({
          type: 'permission.request',
          turnId: this.turnId,
          requestId: id,
          isQuestion: false,
          title: String(props.title ?? props.type ?? props.permission ?? L('权限请求', 'Permission request')),
          toolCallId: firstString(props.callID, tool.callID),
          options: permissionOptions(),
        });
        this.emit({ type: 'session.status', status: 'awaiting' });
        return;
      }
      case 'permission.replied': {
        // 他端应答（或本端确认回声）— 解除挂起态。
        // 1.17.x 字段 permissionID/response；1.18.x 改 requestID/reply。
        const id = firstString(props.permissionID, props.requestID) ?? '';
        if (id && this.pendingPermissions.delete(id)) {
          this.emit({ type: 'permission.resolved', requestId: id, optionId: firstString(props.response, props.reply) });
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
        // session.status/diff/updated 等已知事件静默；真正未知的类型进
        // 兼容审计（版本漂移防御 + 维护者可见）。
        if (!KNOWN_IGNORED_SSE.has(evt.type)) {
          compatAudit.record('opencode', 'unknown-event', `sse:${evt.type}`, evt);
        }
        return;
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
          for (const p of this.splitter.push(full.slice(sent))) {
            this.emit({ type: p.kind === 'thinking' ? 'thinking.delta' : 'text.delta', turnId, text: p.text });
          }
        }
        return;
      }
      case 'reasoning': {
        const full = String(part.text ?? '');
        const sent = this.partSent.get(partID) ?? 0;
        // 引擎报的真实思考起止时间（SSE 快照常整段突发送达，渲染端
        // 墙钟会把几秒的思考算成几十毫秒 — 时长以 part.time 为准）。
        const time = (part.time ?? {}) as Json;
        const durationMs =
          typeof time.start === 'number' && typeof time.end === 'number' && time.end > time.start
            ? time.end - time.start
            : undefined;
        const delta = full.length > sent ? full.slice(sent) : '';
        // 无新增量且无新时长可报 → 静默；纯时长回填用空 delta 携带。
        if (!delta && (durationMs === undefined || this.reasoningEndSent.has(partID))) return;
        this.partSent.set(partID, full.length);
        if (durationMs !== undefined) this.reasoningEndSent.add(partID);
        this.emit({ type: 'thinking.delta', turnId, text: delta, durationMs });
        return;
      }
      case 'tool': {
        const state = (part.state ?? {}) as Json;
        const input = (state.input ?? {}) as Json;
        const meta = (state.metadata ?? {}) as Json;
        const tool = String(part.tool ?? 'tool');
        const status = String(state.status ?? 'pending');
        // 运行中 shell 把实时输出推在 metadata.output；完成后才有 state.output。
        const output =
          status === 'error'
            ? String(state.error ?? '')
            : state.output
              ? String(state.output)
              : meta.output
                ? String(meta.output)
                : '';
        const loc = firstString(input.filePath, input.path, input.file);
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: String(part.callID ?? partID),
          title:
            firstString(state.title, input.command, input.pattern) ??
            (loc ? String(loc).split(/[\\/]/).pop()! : tool),
          toolKind: mapToolKind(tool),
          toolName: tool,
          status: mapToolStatus(status),
          content: buildToolContent(tool, output, input, meta),
          locations: loc ? [loc] : undefined,
        });
        return;
      }
      case 'step-finish': {
        // 消息级 tokens 由 message.updated 提供；这里计 API 调用次数并刷上下文占用。
        this.turnApiCalls += 1;
        const tokens = (part.tokens ?? {}) as Json;
        const cache = (tokens.cache ?? {}) as Json;
        const used = num(tokens.input) + num(tokens.output) + num(tokens.reasoning) + num(cache.read) + num(cache.write);
        const max = this.entryOf(this.modelId)?.contextWindow ?? 0;
        if (used > 0) this.emit({ type: 'usage.update', used, size: max });
        return;
      }
      default:
        // step-start / snapshot / patch / file 等已知 part 静默；未知的入账。
        if (!KNOWN_IGNORED_PARTS.has(String(part.type ?? ''))) {
          compatAudit.record('opencode', 'unknown-event', `part:${String(part.type ?? '')}`, part);
        }
        return;
    }
  }

  private finishTurn(stopReason: string): void {
    const done = this.turnDone;
    if (!done) return;
    this.turnDone = undefined;
    for (const p of this.splitter.flush()) {
      this.emit({ type: p.kind === 'thinking' ? 'thinking.delta' : 'text.delta', turnId: this.turnId, text: p.text });
    }
    const t = this.turnTokens;
    // opencode 的 tokens.input 不含缓存部分（cache.read/write 单列），这里归一成
    // codex 语义：inputTokens = 总输入（含缓存），cachedInputTokens 为其子集。
    const totalInput = t ? t.input + t.cacheRead + t.cacheWrite : 0;
    const usage: UsageInfo | undefined = t
      ? {
          inputTokens: totalInput,
          outputTokens: t.output + t.reasoning,
          totalTokens: totalInput + t.output + t.reasoning,
          cachedInputTokens: t.cacheRead || undefined,
          apiCalls: this.turnApiCalls || undefined,
          contextUsed: totalInput + t.output + t.reasoning,
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

  /** 额外根目录 → 会话级 external_directory allow 规则。pattern 用正斜杠
   *  `dir/*`：opencode 的 Wildcard.match 把 `*` 展开为跨斜杠的 `.*` 且
   *  双侧反斜杠归一化，整棵子树（含嵌套子目录的请求 glob）都命中。 */
  private extraDirRules(): Json[] {
    return (this.opts.extraDirs ?? []).map((dir) => ({
      permission: 'external_directory',
      pattern: `${dir.replaceAll('\\', '/').replace(/\/+$/, '')}/*`,
      action: 'allow',
    }));
  }

  /** 新建会话；多根工作区时建会 body 直接携带预放行规则（会话级
   *  ruleset 经 merge 后优先于 agent 默认的 external_directory ask）。
   *  旧版 server 不认 permission 字段时退回空 body 重试，不阻断建会。 */
  private async createSession(): Promise<string> {
    const rules = this.extraDirRules();
    let res = await this.api('/session', {
      method: 'POST',
      body: rules.length ? JSON.stringify({ permission: rules }) : '{}',
    });
    if (!res.ok && rules.length) {
      res = await this.api('/session', { method: 'POST', body: '{}' });
    }
    if (!res.ok) throw new Error(L(`opencode 建会话失败 (HTTP ${res.status})`, `opencode session creation failed (HTTP ${res.status})`));
    const sid = String((res.json as Json)?.id ?? '');
    if (!sid) throw new Error(L('opencode 建会话未返回 id', 'opencode session creation returned no id'));
    return sid;
  }

  /** 已存会话（resume）补预放行：PATCH /session/{id} 的 permission
   *  服务端与现有规则 merge。失败静默 —— 兜底路径是权限卡照弹。 */
  private async grantExtraDirs(sid: string): Promise<void> {
    const rules = this.extraDirRules();
    if (!rules.length) return;
    await this.api(`/session/${sid}`, { method: 'PATCH', body: JSON.stringify({ permission: rules }) }).catch(() => undefined);
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
  if (t.includes('grep') || t.includes('glob')) return 'search';
  if (t.includes('read') || t.includes('list')) return 'read';
  if (t.includes('fetch') || t.includes('search') || t.includes('web')) return 'fetch';
  if (t.includes('todo')) return 'think';
  return 'other';
}

/** 从工具 state.metadata / input 提炼 UI 徽章数据：行数变更、A/M 判定、
 *  搜索命中数、shell 退出码（opencode edit 带 filediff，write 带 exists）。 */
function buildToolContent(tool: string, output: string, input: Json, meta: Json): ToolCallContent | undefined {
  const c: ToolCallContent = {};
  if (output) c.text = output.slice(0, 20_000);
  const fd = meta.filediff as Json | undefined;
  if (fd && typeof fd === 'object') {
    c.additions = num(fd.additions);
    c.deletions = num(fd.deletions);
    if (fd.patch) c.patch = String(fd.patch).slice(0, 40_000);
  } else if (typeof meta.diff === 'string' && meta.diff) {
    c.patch = meta.diff.slice(0, 40_000);
  }
  const t = tool.toLowerCase();
  if (t.includes('write')) {
    c.changeKind = meta.exists === false ? 'add' : 'modify';
    // write 不返回行数统计 — 新建文件时用入参内容行数兑底。
    if (c.additions == null && c.changeKind === 'add' && typeof input.content === 'string') {
      c.additions = input.content.split('\n').length;
    }
  } else if (t.includes('edit') || t.includes('patch')) {
    c.changeKind = String(input.oldString ?? ' ') === '' ? 'add' : 'modify';
  }
  if (meta.matches != null) c.matches = num(meta.matches);
  else if (meta.count != null) c.matches = num(meta.count);
  if (typeof meta.exit === 'number') c.exitCode = meta.exit;
  return Object.keys(c).length > 0 ? c : undefined;
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
