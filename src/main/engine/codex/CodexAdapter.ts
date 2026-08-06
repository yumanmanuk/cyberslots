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
import { L } from '../../i18n';
import { killEngineTree } from '../killTree';
import { compatAudit } from '../compatAudit';
import { log } from '../../log/logger';
import { NdjsonRpc } from './rpc';
import { codexSpawnEnv, resolveCodexCli } from './resolveCodex';

const INIT_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

/** 已知且刻意不渲染的通知 — 不进兼容审计；各类 *Delta 流另按后缀豁免
 *（内容面要么已由其它通知覆盖、要么刻意不渲染）。 */
const KNOWN_IGNORED_NOTIFICATIONS = new Set(['thread/started']);

/** 已知且刻意不渲染的 item 类型（由 delta 通知覆盖）。 */
const KNOWN_IGNORED_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning']);

export interface CodexAdapterOptions {
  cwd: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  /** Resume an existing thread instead of starting a new one. */
  resumeThreadId?: string;
  /** 会话没有客户端历史时恢复失败静默降级（空会话的 rollout 常不存在，报错纯噪音）。 */
  quietResumeFallback?: boolean;
  /** 无人值守（赛马角色会话）：自动批准权限/计划请求，防无人应答死锁
   * （对齐 ClaudeAdapter unattended；只读约束由 READONLY_GUARD 提示词承载）。 */
  unattended?: boolean;
  /** Optional explicit path to codex bin/codex.js (settings override). */
  cliEntry?: string;
  /** 路由开启时的 `-c key=value` 命令行覆盖（零文件写入）。 */
  configOverrideArgs?: string[];
  /** 多根工作区的其余根目录 — 并入 workspace-write 沙盒的额外可写根
   *  （提示注入只让模型「知道」目录，沙盒放行必须走这里）。 */
  extraWritableRoots?: string[];
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

/** SandboxMode（kebab-case，thread/start 的 `sandbox` 字段）→ SandboxPolicy
 *  的 serde tag（camelCase，thread/settings/update 的 `sandboxPolicy.type`）。
 *  两套命名是 codex 协议的地面真值（app-server-protocol v2 permissions.rs），
 *  混用会反序列化失败被静默吞掉 — 模式热切等于没同步。 */
const SANDBOX_POLICY_TAG: Record<string, string> = {
  'workspace-write': 'workspaceWrite',
  'read-only': 'readOnly',
  'danger-full-access': 'dangerFullAccess',
};

export class CodexAdapter implements EngineAdapter {
  /** steer 被 RPC 接受后，引擎会在真正消费该输入（drain pending input 并产出
   *  userMessage item）时异步确认 —— SessionManager 据此延迟 user.echo。 */
  readonly steerConfirmable = true;

  private child: ChildProcessWithoutNullStreams | undefined;
  private rpc: NdjsonRpc | undefined;
  private threadId = '';
  private activeCodexTurnId = '';
  /** 已注入、等待引擎确认消费的 client_user_message_id 集合。 */
  private readonly pendingSteerIds = new Set<string>();
  private turnId = 0;
  private disposed = false;
  private modelId: string;
  private mode: PermissionMode;
  private turnDone: (() => void) | undefined;
  /** 引擎自发回合（goal continuation / compact / review）进行中标记 —
   *  这类回合不经 prompt() 发起，此前完全隐身：状态不推进、结束事件被吞，
   *  UI 会卡在「执行中/等待授权」且中止看似无效。 */
  private backgroundTurnActive = false;
  private backgroundCodexTurnId = '';
  /** 中止点在 turn id 未就绪的空窗期（turn/start 响应未回）— 记账，
   *  id 一到立即补发 turn/interrupt，否则那一下停止等于白点。 */
  private cancelRequested = false;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly stderrTail: string[] = [];
  /** 最近一次补全的 token 明细（thread/tokenUsage `last`）— 仅用于
   *  contextUsed/contextMax；回合统计按 `total` 差值累计（见下）。 */
  private lastTurnUsage: UsageInfo | undefined;
  /** thread 级累计 token（`total` 最新快照，跨回合单调递增）。 */
  private latestTotalUsage: UsageBreakdown | undefined;
  /** 本回合开始时的 `total` 基线 — 与结束时的差值 = 整回合全部 API 调用之和。 */
  private turnUsageBaseline: UsageBreakdown | undefined;
  /** 本回合的 API 调用计数 — 每次补全完成都会推一条带 `last` 的
   *  tokenUsage 更新，逐条累计即真实请求数（仅 prompt 回合）。 */
  private turnApiCalls = 0;
  private turnStartedAt = 0;
  /** 回合内"非 API"区间（工具执行 / 等待审批）的并集累计 ms — t/s 只按 API 时间算。 */
  private turnBusyMs = 0;
  private busySince = 0;
  private readonly busyKeys = new Set<string>();
  /** 最近一份 goal 快照 — GoalBar/完成公告的数据源；complete 时置 null
   *  （公告由渲染层发；引擎 DB 里的 complete 残留行由 setGoal 先 clear 兜掉）。 */
  private lastGoal: GoalInfo | null = null;
  /** setGoal replace 进行中 —— 窗口内 thread/goal/cleared 通知要吞掉（防 GoalBar 闪烁）。 */
  private replacingGoal = false;
  /** background 回合的本地回合号 — turn.started 时自增分配，结束按它发
   *  turn.ended（不能读 this.turnId：竞态下它已是排队 prompt 回合的号）。 */
  private backgroundLocalTurnId = 0;
  /** background 回合是 compact（compact() 自记，不发 showStats 统计行）。 */
  private backgroundIsCompact = false;
  /** compact() 已调用、对应 background 回合未开始的待消费标记（带时间戳：
   *  超窗未消费即作废 —— 引擎吞掉请求时不误标下一个 goal 续跑回合）。 */
  private compactPending = false;
  private compactPendingAt = 0;
  /** background 回合开始时的 `total` 基线 — 结束差值 = 该回合 token
   *  （独立变量，不与 prompt 回合的 turnUsageBaseline 互相污染）。 */
  private bgUsageBaseline: UsageBreakdown | undefined;
  /** background 回合的 API 调用计数（tokenUsage 推送逐条累计）。 */
  private bgApiCalls = 0;
  /** 上一次上报的上下文占用（token）— 压缩前后对比用。 */
  private lastContextUsed = 0;
  /** 压缩开始时的占用快照 + 待回填的压缩行 id（真实释放量要等压缩后的 tokenUsage）。 */
  private compactBeforeUsed: number | undefined;
  private compactReportId: string | undefined;

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
    const spec = resolveCodexCli(
      [...(this.opts.configOverrideArgs ?? []), ...this.writableRootsArgs(), 'app-server'],
      this.opts.cliEntry,
    );
    const child = spawn(spec.command, spec.args, {
      cwd: this.opts.cwd,
      shell: spec.shell ?? false,
      env: codexSpawnEnv(spec.managedRoot),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, // 防止 Windows 下闪出 cmd 控制台窗口
    });
    this.child = child;
    log.info('engine.codex', 'engine spawned', {
      command: spec.command,
      args: spec.args.join(' '),
      cwd: this.opts.cwd,
      pid: child.pid,
      resumed: !!this.opts.resumeThreadId,
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
      this.rpc?.close('engine exited');
      if (this.disposed) return;
      log.warn('engine.codex', 'engine exited unexpectedly', {
        code,
        signal: signal ?? 'none',
        pid: child.pid,
        stderrTail: this.stderrTail.slice(-8).join(' | '),
      });
      this.emit({
        type: 'error',
        source: 'engine',
        message: `${L('codex 进程意外退出', 'codex process exited unexpectedly')} (code=${code} signal=${signal ?? 'none'})\n${this.stderrTail.slice(-8).join('\n')}`,
      });
      this.emit({ type: 'session.status', status: 'error', detail: 'engine-exited' });
    });
    child.on('error', (err) => {
      if (this.disposed) return;
      log.error('engine.codex', 'engine spawn failed', { command: spec.command }, err);
      this.emit({ type: 'error', source: 'client', message: `${L('无法启动 codex CLI', 'Failed to launch the codex CLI')}: ${err.message}` });
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
        // thread/settings/update（setMode 热同步线程策略）属实验面 API，需显式 opt-in。
        capabilities: { experimentalApi: true },
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
    // 多根工作区的原生通道（codex ≥ 0.144 实验字段，需 experimentalApi，上面
    // initialize 已开）：替换语义，必须含 cwd。旧版 codex 不认识此字段会
    // 静默忽略 — 那时靠 spawn 级 `-c writable_roots` 覆盖兑底（两者等效）。
    const extraRoots = this.opts.extraWritableRoots ?? [];
    if (extraRoots.length) threadParams.runtimeWorkspaceRoots = [this.opts.cwd, ...extraRoots];
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

  /** 多根工作区 → `-c sandbox_workspace_write.writable_roots=[...]` 覆盖。
   *  值按 TOML 数组拼；JSON.stringify 的反斜杠转义与 TOML basic string
   *  兼容，Windows 路径直接可用。danger-full-access / read-only 下无害
   *  （只影响 workspace-write 策略的构造），所以不按模式区分。 */
  private writableRootsArgs(): string[] {
    const roots = this.opts.extraWritableRoots ?? [];
    if (!roots.length) return [];
    return ['-c', `sandbox_workspace_write.writable_roots=[${roots.map((r) => JSON.stringify(r)).join(',')}]`];
  }

  private async openThread(method: string, params: Json): Promise<string> {
    try {
      const res = await withTimeout(this.rpc!.request<Json>(method, params), INIT_TIMEOUT_MS, method);
      const thread = res.thread as Json | undefined;
      const id = String(thread?.id ?? '');
      if (!id) throw new Error(L(`${method} 未返回 thread id`, `${method} returned no thread id`));
      return id;
    } catch (err) {
      if (method === 'thread/resume') {
        // 空会话不弹红色报错 — 无上下文可丢，降级对用户无感。
        if (!this.opts.quietResumeFallback) {
          this.emit({
            type: 'error',
            source: 'engine',
            message: `${L('线程恢复失败，已新建线程继续', 'Thread resume failed — started a new thread to continue')}: ${errorMessage(err)}`,
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
    this.pendingSteerIds.clear();
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
    // 空文本 item 有毒：上游 API 对空 text content 一律 400
    //（探针实测 text content is empty）—— 正文空白且有附件时不发文本块。
    const input: Json[] = [];
    if (text.trim()) input.push({ type: 'text', text });
    for (const path of attachments ?? []) {
      // 图片白名单对齐 provider 可消化格式（bmp 不在列 —— API 会拒且坏图
      //  污染会话历史；bmp 退化路径文本，交给引擎 view_image 类工具）。
      if (/\.(png|jpe?g|gif|webp)$/i.test(path)) input.push({ type: 'localImage', path });
      else input.push({ type: 'text', text: `[附件] ${path}` });
    }
    await this.runTurn(input, effort);
  }

  /** 原生技能注入回合：{type:'skill'} 输入项 — codex core 直读 SKILL.md
   *  全文注入（<skill> 片段），与 TUI $mention 等效；技能无参数语义，
   *  用户参数按 TUI 习惯以 `$name args` 文本随行。 */
  async promptSkill(name: string, path: string, args: string): Promise<void> {
    const input: Json[] = [
      { type: 'skill', name, path },
      { type: 'text', text: args ? `${name} ${args}` : `${name}` },
    ];
    await this.runTurn(input, undefined);
  }

  /** 共享回合生命周期：turn/start → turn/completed（prompt 与 promptSkill 共用）。 */
  private async runTurn(input: Json[], effort?: string): Promise<void> {
    const rpc = this.requireRpc();
    const turnId = ++this.turnId;
    this.lastTurnUsage = undefined;
    this.turnUsageBaseline = this.latestTotalUsage;
    this.turnApiCalls = 0;
    this.turnBusyMs = 0;
    this.busyKeys.clear();
    this.turnStartedAt = Date.now();
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'session.status', status: 'running' });

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
      this.flushPendingCancel();
      await done; // resolved by turn/completed
    } catch (err) {
      this.emit({ type: 'error', turnId, source: classifyError(err), message: errorMessage(err) });
      this.emit({ type: 'turn.ended', turnId, stopReason: 'error' });
    } finally {
      this.turnDone = undefined;
      this.activeCodexTurnId = '';
      this.cancelRequested = false;
      if (!this.disposed) this.emit({ type: 'session.status', status: 'idle' });
    }
  }

  async cancel(): Promise<void> {
    // 先取消挂起的审批：中断时若还挂着 approval，引擎可能停在等待授权上，
    // turn/interrupt 也救不回（「停止没反应」的另一形态）。answerPermission(undefined)
    // 走既有 cancel 决策 + permission.resolved 收尾。
    for (const requestId of [...this.pendingApprovals.keys()]) this.answerPermission(requestId);
    if (!this.activeCodexTurnId) {
      // 回合在跑但 turn id 还没到（排队消息刚派发/自发回合刚起步）：
      // 记账等 id 到达后补发中断 — 此前直接 return，停止点了等于没点。
      if (this.turnDone || this.backgroundTurnActive) this.cancelRequested = true;
      return;
    }
    this.cancelRequested = false;
    await this.requireRpc().request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeCodexTurnId,
    });
  }

  /** turn id 迟到时补发空窗期记账的中止；失败显性化（无调用方可接异常）。 */
  private flushPendingCancel(): void {
    if (!this.cancelRequested || !this.activeCodexTurnId) return;
    void this.cancel().catch((err) => {
      this.emit({ type: 'error', source: 'engine', message: `${L('中止失败：', 'Cancel failed: ')}${errorMessage(err)}` });
    });
  }

  async setModel(modelId: string): Promise<void> {
    // Applied on the next turn/start; codex has no hot-switch RPC.
    this.modelId = modelId;
    this.emitModels();
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    // 热同步线程级策略：goal continuation 等引擎自发回合不走 turn/start
    // 传参，只认线程存量设置 — 不同步的话，切到 YOLO 后续跑回合仍会按
    // 旧策略弹授权（沙箱受限命令）。失败静默：prompt 回合有 turn/start 兜底。
    const modeCfg = MODE_MAP[mode];
    // sandboxPolicy 的 tag 是 camelCase（与 thread/start 的 kebab-case `sandbox`
    // 不同套命名）；对象整体替换线程策略 — workspace-write 必须带上多根
    // 的额外可写根，否则热切一次模式就把开线程时的可写根丢掉。
    const sandboxPolicy: Json = { type: SANDBOX_POLICY_TAG[modeCfg.sandbox] ?? modeCfg.sandbox };
    const roots = this.opts.extraWritableRoots ?? [];
    if (modeCfg.sandbox === 'workspace-write' && roots.length) sandboxPolicy.writableRoots = roots;
    try {
      await this.requireRpc().request('thread/settings/update', {
        threadId: this.threadId,
        approvalPolicy: modeCfg.approvalPolicy,
        sandboxPolicy,
      });
    } catch {
      /* 旧版 codex 无此实验方法 — 忽略 */
    }
    this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan', 'auto', 'yolo'] });
  }

  answerPermission(requestId: string, optionId?: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.pendingApprovals.delete(requestId);
    pending.resolve(optionId ?? 'cancel');
    this.emit({ type: 'permission.resolved', requestId, optionId });
    // 无论哪类回合都要把状态从 awaiting 拉回来 — 此前只认 prompt 回合
    // （turnDone），goal continuation 里答完授权后右上角永远卡「等待授权」。
    if (this.turnDone || this.backgroundTurnActive) {
      this.emit({ type: 'session.status', status: 'running' });
    } else if (!this.disposed) {
      this.emit({ type: 'session.status', status: 'idle' });
    }
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
    try {
      await this.requireRpc().request('thread/compact/start', { threadId: this.threadId });
      // 标记：下一个 background 回合是压缩 — endBackgroundTurn 不发 showStats。
      this.compactPending = true;
      this.compactPendingAt = Date.now();
    } catch (err) {
      // 显性化压缩失败（如回合进行中被引擎拒绝），不再静默。
      this.emit({ type: 'error', source: classifyError(err), message: `${L('压缩失败：', 'Compaction failed: ')}${errorMessage(err)}` });
      throw err;
    }
  }

  /** Native mid-turn steering (turn/steer). Review/compact turns reject it. */
  async steer(text: string, attachments?: string[], messageId?: string): Promise<boolean> {
    if (!this.activeCodexTurnId) return false;
    try {
      // 与 prompt 同一套输入装配：图片走 localImage 块，其余退化为路径附注，
      // 保证 steer 注入时附件不再被静默丢弃。
      const input: Json[] = [];
      if (text.trim()) input.push({ type: 'text', text });
      for (const path of attachments ?? []) {
        if (/\.(png|jpe?g|gif|webp)$/i.test(path)) input.push({ type: 'localImage', path });
        else input.push({ type: 'text', text: `[附件] ${path}` });
      }
      // 先登记再发请求：item/started 通知可能早于 turn/steer 响应到达，
      // 晚登记会让确认锚点错过该通知（退化为 60s 超时兜底回显）。
      if (messageId) this.pendingSteerIds.add(messageId);
      await this.requireRpc().request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.activeCodexTurnId,
        clientUserMessageId: messageId ?? null,
        input,
      });
      return true;
    } catch (err) {
      if (messageId) this.pendingSteerIds.delete(messageId);
      // ActiveTurnNotSteerable（review/compact）等 — 调用方降级排队；留痕便于排查。
      log.warn('engine.codex', 'turn/steer rejected', {
        threadId: this.threadId,
        turnId: this.activeCodexTurnId,
        error: errorMessage(err),
      });
      return false;
    }
  }

  // ----------------------------------------------------------------- goal
  // Fully native: codex persists one goal per thread (thread/goal/set|clear)
  // and pushes thread/goal/updated with real usage counters. No prompt
  // bridging — kimi's ACP surface has no goal API, so the UI only shows
  // goal controls for codex sessions.

  async setGoal(objective: string): Promise<void> {
    const rpc = this.requireRpc();
    // 官方 replace 语义（TUI /goal 设新目标 = clear + set）：先清存量 goal
    // —— 含 complete 残留行（codex 完成不删行）。否则带新 objective 的 set
    // 走 update 路径，新目标继承旧 tokens/time/createdAt/tokenBudget。
    // 无 goal 时 clear 返回 cleared:false、不报错不推通知（已实测），放心调。
    // replacingGoal 窗口内吞掉前置清理推的 cleared —— 否则乐观 GoalBar 被清、
    // 新快照到达才恢复，闪一帧。通知与响应同连接 FIFO：cleared 必在 clear
    // 响应之前或紧随其后到达（set 尚未发出），窗口外不存在误吞。
    this.replacingGoal = true;
    try {
      await rpc.request('thread/goal/clear', { threadId: this.threadId }).catch((err) => {
        // 老版本无此实验方法 —— 退化为 update 语义（新目标继承旧计数），审计留痕。
        compatAudit.record('codex', 'rejected-method', 'thread/goal/clear', errorMessage(err));
      });
      const res = await rpc.request<Json>('thread/goal/set', {
        threadId: this.threadId,
        objective,
        status: 'active',
      });
      this.emitGoal((res.goal as Json | undefined) ?? null);
    } finally {
      this.replacingGoal = false;
    }
  }

  async controlGoal(action: GoalControlAction): Promise<void> {
    const rpc = this.requireRpc();
    if (action === 'clear') {
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
    // `complete` passes through untouched — the renderer announces the
    // completion (objective + elapsed) before clearing its local state.
    this.emit({ type: 'goal.update', goal });
  }

  // -------------------------------------------------------- notifications

  private onNotification(method: string, params: Json): void {
    const turnId = this.turnId;
    switch (method) {
      case 'turn/started': {
        // 捕获真实回合 id：turn/start 的响应可能迟于流式事件到达，
        // 只靠响应会让 activeCodexTurnId 短暂为空 → cancel/steer 变哑弹。
        const startedTurn = params.turn as Json | undefined;
        if (startedTurn?.id) this.activeCodexTurnId = String(startedTurn.id);
        this.flushPendingCancel();
        // 引擎自发回合补全生命周期：推进 running（否则输入框/心跳全程装死），
        // 并发 turn.started 让主进程拍变更基线快照。
        if (!this.turnDone && !this.backgroundTurnActive) {
          this.backgroundTurnActive = true;
          this.backgroundCodexTurnId = String(startedTurn?.id ?? '');
          this.backgroundLocalTurnId = ++this.turnId;
          // 120s 有效窗：引擎吞掉 compact 请求时标记不残留，防误标后续
          // goal 续跑（showStats 被吞）；contextCompaction item 到来时还有兜底。
          this.backgroundIsCompact = this.compactPending && Date.now() - this.compactPendingAt < 120_000;
          this.compactPending = false;
          this.bgUsageBaseline = this.latestTotalUsage;
          this.bgApiCalls = 0;
          this.emit({ type: 'turn.started', turnId: this.backgroundLocalTurnId });
          this.emit({ type: 'session.status', status: 'running' });
        }
        return;
      }
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
          if (this.turnDone) this.turnApiCalls += 1;
          else if (this.backgroundTurnActive) this.bgApiCalls += 1;
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
        this.lastContextUsed = used;
        this.emit({ type: 'usage.update', used, size });
        // 压缩完成后的首个 usage 更新 → 用 X→Y 回填压缩行标题（真实释放量）。
        if (this.compactReportId && this.compactBeforeUsed != null && used < this.compactBeforeUsed) {
          this.emit({
            type: 'tool.upsert',
            turnId: this.turnId,
            toolCallId: this.compactReportId,
            title: L(`已压缩上下文：${fmtTokensK(this.compactBeforeUsed)} → ${fmtTokensK(used)} tokens`, `Context compacted: ${fmtTokensK(this.compactBeforeUsed)} → ${fmtTokensK(used)} tokens`),
            toolKind: 'other',
            status: 'completed',
          });
          this.compactReportId = undefined;
          this.compactBeforeUsed = undefined;
        }
        return;
      }
      case 'thread/goal/updated':
        this.emitGoal((params.goal as Json | undefined) ?? null);
        return;
      case 'thread/goal/cleared': {
        // setGoal replace 前置清理推的 cleared 在窗口内吞掉（理由见 setGoal）。
        if (this.replacingGoal) return;
        // 实测 codex 完成必推 updated(complete)、从不在完成时清行 —— cleared
        // 只来自用户 clear / resume 无 goal 快照，一律按「无 goal」处理；
        // 不合成完成公告（前提不成立，会误报）。
        this.lastGoal = null;
        this.emit({ type: 'goal.update', goal: null });
        return;
      }
      case 'turn/completed': {
        const turn = params.turn as Json | undefined;
        // 回合收尾：未消费的 steer 确认锚点作废（pending input 被中断清理 /
        // 引擎吞掉），后续 item 不再匹配；回显由 SessionManager 超时兜底。
        this.pendingSteerIds.clear();
        // 引擎自发回合（goal continuation / compact / review，非 prompt 发起）
        // 不产出统计行（usage 基线是 prompt 回合口径，算了也是错的），但必须
        // 收尾状态机 — 此前直接吞事件导致 UI 永远停在「执行中/等待授权」。
        if (!this.turnDone) {
          if (this.backgroundTurnActive) this.endBackgroundTurn(turn);
          return;
        }
        // prompt 回合等待期间冒出的自发回合结束（理论竞态）：按 id 区分，
        // 不能让它误结算 prompt 回合。
        if (this.backgroundTurnActive && this.backgroundCodexTurnId && String(turn?.id ?? '') === this.backgroundCodexTurnId) {
          this.endBackgroundTurn(turn);
          return;
        }
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
          ? { ...this.lastTurnUsage, ...summed, apiCalls: this.turnApiCalls || undefined }
          : this.lastTurnUsage
            ? { ...this.lastTurnUsage, apiCalls: this.turnApiCalls || undefined }
            : undefined;
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
        this.emit({ type: 'error', turnId, source: 'provider', message: String(err?.message ?? L('未知引擎错误', 'Unknown engine error')) });
        return;
      }
      default:
        // thread/started 等已知不渲染的通知静默；其余未知 method 进审计
        //（rejected-method/-32601 在 rpc 层集中入账，这里只管通知面）。
        if (!KNOWN_IGNORED_NOTIFICATIONS.has(method) && !method.endsWith('Delta')) {
          compatAudit.record('codex', 'unknown-event', `notification:${method}`, params);
        }
        return;
    }
  }

  /** 引擎自发回合收尾：发 stopReason='background' 的结束事件（关闭流式
   *  caret、清残留授权卡）并恢复 idle；不产统计行，消费方（通知/赛马/
   *  自动压缩）按 stopReason 过滤。 */
  private endBackgroundTurn(turn: Json | undefined): void {
    this.backgroundTurnActive = false;
    const bgCodexId = this.backgroundCodexTurnId;
    this.backgroundCodexTurnId = '';
    // 仅当活动 turn id 仍属于该 background 回合才清空 —— 竞态下它可能已是
    // 排队 prompt 回合的 id，清掉会让那回合的 cancel/steer 变哑弹。
    if (this.activeCodexTurnId && this.activeCodexTurnId === bgCodexId) this.activeCodexTurnId = '';
    this.cancelRequested = false;
    // 本地回合号用自己的（竞态时 this.turnId 已属排队 prompt 回合）。
    const localTurn = this.backgroundLocalTurnId || this.turnId;
    this.backgroundLocalTurnId = 0;
    const status = String(turn?.status ?? 'completed');
    const err = turn?.error as Json | undefined;
    if (status === 'failed' && err) {
      this.emit({ type: 'error', turnId: localTurn, source: 'provider', message: String(err.message ?? 'turn failed') });
    }
    // goal 续跑是用户要看/要复制的真实回答 → showStats 让渲染层照常出统计行
    // （复制 + token + 参与 Worked-for 回合折叠，与 kimi KAP 通道对齐）；
    // 压缩等内部回合不发。token 用回合前后 thread 级 `total` 差值（同 prompt 口径）。
    const isCompact = this.backgroundIsCompact;
    this.backgroundIsCompact = false;
    const summed =
      this.latestTotalUsage && this.bgUsageBaseline ? diffBreakdown(this.latestTotalUsage, this.bgUsageBaseline) : undefined;
    this.bgUsageBaseline = undefined;
    const usage: UsageInfo | undefined = summed
      ? { ...this.lastTurnUsage, ...summed, apiCalls: this.bgApiCalls || undefined }
      : this.lastTurnUsage
        ? { ...this.lastTurnUsage, apiCalls: this.bgApiCalls || undefined }
        : undefined;
    this.emit({
      type: 'turn.ended',
      turnId: localTurn,
      stopReason: 'background',
      // goal 不活跃（完成/清除/暂停）= 引擎不会再自起下一轮 → 标 goal-idle，
      // 渲染层据此补发排队消息（否则消息滞留到用户下次操作，顺序还会倒置）。
      backgroundKind: isCompact ? 'compact' : this.lastGoal?.status === 'active' ? undefined : 'goal-idle',
      showStats: isCompact ? undefined : true,
      usage,
      durationMs: this.turnDurationMs(turn),
    });
    // prompt 回合在飞（排队消息撞进续跑）时不发 idle —— 那回合自己收尾。
    if (!this.turnDone && !this.disposed) this.emit({ type: 'session.status', status: 'idle' });
  }

  /** Map codex ThreadItem lifecycle into tool.upsert / message events. */
  private onItem(item: Json | undefined, turnId: number): void {
    if (!item) return;
    const id = String(item.id ?? '');
    switch (item.type) {
      case 'userMessage': {
        // steer 确认锚点：pending input 被引擎 drain 时会产出带
        // client_user_message_id 的 userMessage item —— 此刻才真正发给 LLM，
        // 此前 turn/steer 只是被接受。其余 userMessage 继续忽略（由 delta 覆盖）。
        const clientId = String(item.clientId ?? '');
        if (clientId && this.pendingSteerIds.delete(clientId)) {
          this.emit({ type: 'steer.confirmed', turnId, messageId: clientId });
        }
        return;
      }
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
          title: paths.length ? `${L('修改', 'Edit')} ${paths.map((p) => p.split(/[\\/]/).pop()).join(', ')}` : L('修改文件', 'Edit files'),
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
          title: `${L('搜索', 'Search')}: ${String(item.query ?? '')}`,
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
      case 'contextCompaction': {
        // 压缩渲染为一条工具行；完成后的真实释放量由下一次 tokenUsage 回填。
        // 仅 completed 才 upsert：in_progress 会命中 SessionManager.trackTurnText
        // 的「新工具活动重置」分支，把赛马 transcript 清成空串（压缩无实质产物）。
        const status = mapItemStatus(String(item.status ?? 'inProgress'));
        // 引擎侧事实兜底：background 回合内出现压缩 item 即认定为压缩回合，
        // 不依赖 compactPending 的新鲜度（其有效窗过期/漏标的场景）。
        if (this.backgroundTurnActive) this.backgroundIsCompact = true;
        if (status !== 'completed') {
          this.compactBeforeUsed = this.lastContextUsed || undefined;
          return;
        }
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: id,
          title: L('已压缩上下文', 'Context compacted'),
          toolKind: 'other',
          status,
        });
        this.compactReportId = id;
        return;
      }
      default:
        // userMessage / agentMessage / reasoning 由 delta 通知覆盖；其余未知
        // item 类型 = 引擎新增能力信号，入账。
        if (!KNOWN_IGNORED_ITEMS.has(String(item.type ?? ''))) {
          compatAudit.record('codex', 'unknown-event', `item:${String(item.type ?? '')}`, item);
        }
        return;
    }
  }

  // ------------------------------------------------------ server requests

  private onServerRequest(method: string, params: Json): Promise<unknown> {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const isExec = method.startsWith('item/commandExecution');
      const requestId = randomUUID();
      const title = isExec
        ? `${L('执行命令', 'Run command')}: ${String(params.command ?? L('(见工具卡片)', '(see tool card)'))}`
        : `${L('写入文件', 'Write file')}${params.reason ? `（${String(params.reason)}）` : ''}`;
      const options: PermissionOptionView[] = [
        { optionId: 'accept', name: L('允许一次', 'Allow once'), kind: 'allow_once' },
        { optionId: 'acceptForSession', name: L('本会话总是允许', 'Always allow in this session'), kind: 'allow_always' },
        { optionId: 'decline', name: L('拒绝', 'Reject'), kind: 'reject_once' },
      ];
      // 无人值守（赛马角色会话）：自动接受，防无人应答死锁（对齐 claude unattended）。
      if (this.opts.unattended) {
        log.debug('engine.codex', 'unattended auto-approve', { method, title: title.slice(0, 80) });
        return Promise.resolve({ decision: 'accept' });
      }
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
    // 未知 server request：回 -32603 拒绝（引擎侧自行降级），同时入账 —
    // 新增审批类型不适配会卡掉对应功能，这是唯一可见信号。
    compatAudit.record('codex', 'unknown-event', `serverRequest:${method}`, params);
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

function fmtTokensK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
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
    timer = setTimeout(() => reject(new Error(L(`${tag} 超时 (${ms}ms)`, `${tag} timed out (${ms}ms)`))), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
