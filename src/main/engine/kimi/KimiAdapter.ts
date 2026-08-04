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
import { pathToFileURL } from 'node:url';

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
import { L } from '../../i18n';
import { ThinkSplitter } from '../thinkSplitter';
import { readInlineImage } from '../attachments';
import { killEngineTree } from '../killTree';
import { compatAudit } from '../compatAudit';
import { log } from '../../log/logger';
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
  /** 无人值守（赛马角色会话）：自动批准权限/计划请求，防无人应答死锁
   * （对齐 ClaudeAdapter unattended；只读约束由 READONLY_GUARD 提示词承载）。 */
  unattended?: boolean;
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
  /** compact() 触发的 /compact 回合标记 — 见 prompt() 的 compactTurn。 */
  private compactTurnActive = false;
  /** Latest usage_update snapshot — folded into turn.ended stats. */
  private lastUsage: { used: number; size: number } | undefined;
  /** 本回合流出的正文字符数 — kimi ACP 实测不推 usage_update
   *  （scripts/probe-usage.mjs），下行 token 只能估算（UI 带 ~）。 */
  private turnOutputChars = 0;
  /** ACP initialize 声明的图片 prompt 能力（promptCapabilities.image）。
   *  仅在显式 true 时内联 image 块；未声明/旧版保持 resource_link 路径引用。 */
  private imagePromptCap = false;
  private readonly splitter = new ThinkSplitter();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly stderrTail: string[] = [];

  constructor(
    private readonly opts: KimiAdapterOptions,
    private readonly emit: EngineEventSink,
  ) {
    this.mode = opts.permissionMode ?? 'default';
  }

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
    log.info('engine.kimi', 'engine spawned', {
      command: spec.command,
      args: spec.args.join(' '),
      cwd: this.opts.cwd,
      pid: child.pid,
      resumed: !!this.opts.resumeSessionId,
    });

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
      log.warn('engine.kimi', 'engine exited unexpectedly', {
        code,
        signal: signal ?? 'none',
        pid: child.pid,
        stderrTail: this.stderrTail.slice(-8).join(' | '),
      });
      this.emit({
        type: 'error',
        source: 'engine',
        message: `${L('kimi 进程意外退出', 'kimi process exited unexpectedly')} (code=${code} signal=${signal ?? 'none'})\n${this.stderrTail.slice(-8).join('\n')}`,
      });
      this.emit({ type: 'session.status', status: 'error', detail: 'engine-exited' });
    });
    child.on('error', (err) => {
      if (this.disposed) return;
      log.error('engine.kimi', 'engine spawn failed', { command: spec.command }, err);
      this.emit({ type: 'error', source: 'client', message: `${L('无法启动 kimi CLI', 'Failed to launch the kimi CLI')}: ${err.message}` });
      this.emit({ type: 'session.status', status: 'error', detail: 'spawn-failed' });
    });

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    this.client = new ClientSideConnection(() => this.buildClient(), stream);

    const initRes = await withTimeout(
      this.client.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }),
      INIT_TIMEOUT_MS,
      'ACP initialize',
    );
    this.imagePromptCap =
      (initRes as { agentCapabilities?: { promptCapabilities?: { image?: boolean } } })
        .agentCapabilities?.promptCapabilities?.image === true;

    const sess = await this.openSession();
    this.sessionId = sess.sessionId;
    this.applyConfigOptions(sess.configOptions);

    if (this.opts.modelId) await this.setModel(this.opts.modelId).catch(() => undefined);
    if (this.opts.permissionMode && this.opts.permissionMode !== 'default') {
      // 失败留痕（此前静默 catch）：ACP 不回声档位，丢档无任何痕迹。
      await this.setMode(this.opts.permissionMode).catch((err) => {
        const detail = errorMessage(err);
        log.warn('engine.kimi', 'startup setMode failed (acp) — session may stay manual', { mode: this.opts.permissionMode, detail });
        compatAudit.record('kimi', 'rejected-method', 'acp startup setMode', detail);
      });
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
            message: `${L('会话恢复失败，已新建会话继续（历史上下文不在引擎侧）', 'Session resume failed — started a new session (history context is not engine-side)')}: ${errorMessage(err)}`,
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

  async prompt(text: string, attachments?: string[], effort?: string): Promise<void> {
    const client = this.requireClient();
    // effort → ACP thinking config option（kimi CLI 0.30 新增，id='thinking'，
    // 值域 = off + 模型 support_efforts）；旧版/档位不在值域时静默忽略，
    // 会话继续跑当前档 — 不因思考深度阻断提问。
    await this.applyThinking(effort).catch(() => undefined);
    // /compact 命令回合（compact() 触发或用户手输）：kimi ACP 端执行压缩后不推
    // usage_update，若按普通回合收尾，chatStore 会拿旧 usage 重复触发自动压缩
    // → 死循环。标 background 复用「自发回合不再触压缩」的现有防护。
    const compactTurn = this.compactTurnActive || /^\/compact(?:\s|$)/.test(text.trim());
    const turnId = ++this.turnId;
    this.splitter.reset();
    this.promptActive = true;
    this.turnOutputChars = 0;
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'session.status', status: 'running' });
    const started = Date.now();
    try {
      // 附件装配（kimi-code acp-adapter 源码 + 探针 0.31.0 双证）：图片
      // 走 ACP 原生 image 块（base64 内联，服务端转 image_url 并压缩/格式
      // 门控）；resource_link 在 kimi 侧只投影成裸路径文本（模型需再调
      // ReadMediaFile 才能看到图）—— 非图片/读失败/旧版无 image 能力时
      // 退化 resource_link 路径引用。
      // 空文本块有毒：kimi ACP 实测空 text 块直接 Internal error，
      //  上游 API 对空 text content 亦一律 400 —— 正文空白时不发文本块。
      const blocks: Array<Record<string, unknown>> = [];
      if (text.trim()) blocks.push({ type: 'text', text });
      for (const path of attachments ?? []) {
        const img = this.imagePromptCap ? readInlineImage(path) : undefined;
        if (img) {
          blocks.push({ type: 'image', data: img.data, mimeType: img.mediaType });
        } else {
          blocks.push({ type: 'resource_link', uri: pathToFileURL(path).href, name: path });
        }
      }
      // 无正文且无附件理论上不可达（Composer 已挡），兜底防空 prompt。
      if (blocks.length === 0) blocks.push({ type: 'text', text });
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
        stopReason: compactTurn ? 'background' : res.stopReason,
        backgroundKind: compactTurn ? 'compact' : undefined,
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

  /** effort → ACP thinking config option（session/set_config_option）。
   *  0.30 wire 字段名是 configId（探针实测 optionId 报 Invalid params，
   *  scripts/probe-kimi-thinking.mjs），顺带 optionId 兼容中间版本。
   *  被拒 = 旧版 CLI 无此选项或档位不在当前模型值域 — 留兼容账后放弃，
   *  不降级重试（kimi 档位是 config.toml 静态声明，重试无意义）。 */
  private async applyThinking(effort?: string): Promise<void> {
    if (!effort) return; // 未指定 = 跟随会话当前档，不下发
    const client = this.requireClient();
    const set = (idField: 'configId' | 'optionId'): Promise<unknown> =>
      client.setSessionConfigOption({ sessionId: this.sessionId, [idField]: 'thinking', value: effort } as never);
    try {
      await set('configId');
    } catch {
      try {
        await set('optionId');
      } catch (err) {
        compatAudit.record('kimi', 'rejected-method', 'setSessionConfigOption(thinking)', errorMessage(err));
      }
    }
  }

  async setModel(modelId: string): Promise<void> {
    const client = this.requireClient();
    try {
      await client.unstable_setSessionModel({ sessionId: this.sessionId, modelId });
    } catch (err) {
      // 降级路径本身正常（旧版无此实验方法），但要留账：新版引擎若砍掉
      // 此方法，这里是唯一能看到信号的地方。
      compatAudit.record('kimi', 'rejected-method', 'unstable_setSessionModel', errorMessage(err));
      // 0.30 wire 字段名 configId；旧版 optionId — 两段式降级同 applyThinking。
      await client
        .setSessionConfigOption({ sessionId: this.sessionId, configId: 'model', value: modelId } as never)
        .catch(() =>
          client.setSessionConfigOption({ sessionId: this.sessionId, optionId: 'model', value: modelId } as never),
        );
    }
  }

  /** 客户端权威档位（构造注入 / 最后 setMode 目标）——防引擎回声降级，
   *  对齐 KimiKapAdapter.desiredMode（KAP 曾因顺从 manual 回声丢档，2026-08-03
   *  赛马 kimi 选手卡审批事故）。 */
  private mode: PermissionMode;

  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    await this.requireClient().setSessionMode({ sessionId: this.sessionId, modeId: mode });
    // kimi ACP does not always emit current_mode_update after setSessionMode;
    // anchor the UI/main-process mode here so new sessions do not stay manual.
    this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan', 'auto', 'yolo'] });
  }

  /** Native sidechat fork via ACP unstable_forkSession.
   *  Probed on kimi CLI 0.29.1: responds -32601 "Method not found" —
   *  callers must treat null as "unsupported" and fall back to history
   *  replay (scripts/probe-fork.mjs). Kept as the preferred path so newer
   *  CLIs upgrade to a true engine-side fork automatically.
   *  复核 kimi-code 源码 @ 0.31.0 (071d56940)：acp-adapter 的 sessionCapabilities
   *  仍只声明 list/resume，无 fork — 降级路径继续有效。 */
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
    this.compactTurnActive = true;
    try {
      await this.prompt('/compact');
    } finally {
      this.compactTurnActive = false;
    }
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
        // TodoList 识别（rawInput.todos 入参 / v1 描述标题如 "Updating todo
        // list"）→ 补 toolName：渲染层按 'todo' 隐藏工具卡，避免与 acp-adapter
        // 额外投射的 'plan' 面板双显（acp-adapter 对 TodoList 两张都发）。
        const rawInput = u.rawInput as Record<string, unknown> | undefined;
        const isTodoList = Array.isArray(rawInput?.todos) || /todo list/i.test(String(u.title ?? ''));
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: String(u.toolCallId ?? ''),
          title: u.title == null ? undefined : String(u.title),
          toolKind: u.kind == null ? undefined : String(u.kind),
          toolName: isTodoList ? 'TodoList' : undefined,
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
        if (mode) this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan', 'auto', 'yolo'] });
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
    const title = p.toolCall?.title ? String(p.toolCall.title) : isQuestion ? L('模型提问', 'Model question') : L('请求授权', 'Authorization request');

    // 无人值守（赛马角色会话）：自动放行首个 allow 档，防无人应答死锁
    //（对齐 ClaudeAdapter unattended / OmpAdapter）。
    if (this.opts.unattended) {
      const auto = options.find((o) => o.kind.startsWith('allow'))?.optionId ?? options[0]?.optionId;
      log.debug('engine.kimi', 'unattended auto-approve (acp)', { title: title.slice(0, 80), optionId: auto });
      return Promise.resolve(
        auto === undefined
          ? ({ outcome: { outcome: 'cancelled' } } as RequestPermissionResponse)
          : ({ outcome: { outcome: 'selected', optionId: auto } } as RequestPermissionResponse),
      );
    }

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
            message: L(
              'Kimi CLI 没有可用模型（config.toml 无 provider/模型）。请在终端运行 `kimi login` 重新登录（需会员权益有效），或在 ~/.kimi-code/config.toml 手动配置 provider 与 default_model，然后重开会话。',
              'Kimi CLI has no usable models (no provider/models in config.toml). Run `kimi login` in a terminal to re-login (requires an active membership), or configure provider and default_model in ~/.kimi-code/config.toml manually, then reopen the session.',
            ),
          });
        }
      } else if (id === 'mode') {
        // 引擎回声与客户端强制档（race/headless 的 auto/yolo/plan）矛盾时以
        // 客户端为准并重新断言（对齐 KimiKapAdapter.syncModeFromEngine）——
        // 顺从 default 回声会把 meta 弹回并持久化，重启后永远 manual。
        const reported = current as PermissionMode;
        if (this.mode !== 'default' && reported !== this.mode) {
          this.emit({ type: 'modes.update', current: this.mode, available: values as PermissionMode[] });
          const mode = this.mode;
          void this.requireClient()
            .setSessionMode({ sessionId: this.sessionId, modeId: mode })
            .catch((err) => {
              const detail = errorMessage(err);
              log.warn('engine.kimi', 're-assert mode failed (acp)', { mode, detail });
              compatAudit.record('kimi', 'rejected-method', 'acp re-assert setSessionMode', detail);
            });
        } else {
          this.emit({ type: 'modes.update', current: reported, available: values as PermissionMode[] });
        }
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

/** 粗粒度 token 估算：混合中英文按 ≈ 1 token / 1.7 字符。只用于
 *  无真实 usage 时的展示兜底，UI 会带 ~ 标注。 */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 1.7));
}

function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(L(`${tag} 超时 (${ms}ms)`, `${tag} timed out (${ms}ms)`))), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
