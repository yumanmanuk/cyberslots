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
 *    plan<->default; runtime thinking only off/auto. Switching the
 *    approval bucket (ask/write/yolo) mid-session respawns the process
 *    with the new flags and resumes the same session via session/resume
 *    (session/load replays the full history -- never use it for revive).
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

/** 审批档（spawn flag 粒度）：default/plan 同档（always-ask 弹卡）；
 *  auto=write 自动批写，yolo=--auto-approve 全放行。档位变化只能换 flag
 *  重启进程生效（probe-omp-findings §3：approval 不在 ACP 运行时面）。 */
type ApprovalBucket = 'ask' | 'write' | 'yolo';

function approvalBucket(mode: PermissionMode): ApprovalBucket {
  switch (mode) {
    case 'auto':
      return 'write';
    case 'yolo':
      return 'yolo';
    default:
      return 'ask';
  }
}

/** permissionMode → spawn flag（approval 精细控制不在 ACP 运行时面）。 */
function approvalArgs(mode: PermissionMode): string[] {
  switch (approvalBucket(mode)) {
    case 'write':
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
  /** 无人值守（赛马角色会话）：自动批准权限/计划请求，防无人应答死锁
   * （对齐 ClaudeAdapter unattended；只读约束由 READONLY_GUARD 提示词承载）。 */
  unattended?: boolean;
  /** Optional explicit path to omp.exe (settings override). */
  cliPath?: string;
  /** spawn --thinking 精细档（赛马 per-role effort 承载；缺省 = 不传）。 */
  thinking?: string;
  /** spawn --tools 白名单（收敛工具面；缺省 = 全量）。 */
  tools?: string[];
  /** 多根工作区的其余根目录 → 可重复 `--add-dir` spawn flag（omp 原生
   *  multi-root：进路径白名单 + 系统提示词 <workspace-roots> 区块，
   *  并随会话 header 持久化、resume 后合并恢复）。 */
  extraDirs?: string[];
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
  /** compact() 触发的 /compact 回合标记 — 见 prompt() 的 compactTurn。 */
  private compactTurnActive = false;
  private mode: PermissionMode;
  /** 当前生效模型（setModel 运行时改；respawn 时随 --model 重新下发）。 */
  private currentModelId: string | undefined;
  /** start()/respawn 消费的引擎会话恢复 id（omp 原生 session/resume 续接）。 */
  /** ACP session/resume capability (agentCapabilities.sessionCapabilities.resume).
   *  resume hydrates like load but does NOT replay history; load streams the
   *  entire history back as chunk notifications (omp #replaySessionHistory),
   *  which ensureBackgroundTurn would fold into a NEW background turn and
   *  persist duplicated history on every resume -- prefer resume, never load. */
  private resumeCap = false;
  /** Legacy-omp fallback marker: while a session/load call is in flight its
   *  history-replay notifications are dropped (see loadSessionSuppressed). */
  private suppressReplay = false;
  private resumeSessionId: string | undefined;
  private lastUsage: { used: number; size: number } | undefined;
  private turnOutputChars = 0;
  /** 后台自发回合（异步 task/jobs 结果注入）进行中标记 + 静默收尾计时器。 */
  private backgroundTurnId = 0;
  private backgroundTimer: NodeJS.Timeout | undefined;
  /** 最近一次 config_option_update 里的模型值域 — setModel 乐观回发用。 */
  private modelValues: string[] = [];
  /** ACP initialize 声明的图片 prompt 能力（promptCapabilities.image）。
   *  仅在显式 true 时内联 image 块；未声明/旧版保持 resource_link 路径引用。 */
  private imagePromptCap = false;
  private readonly splitter = new ThinkSplitter();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly stderrTail: string[] = [];

  constructor(
    private readonly opts: OmpAdapterOptions,
    private readonly emit: EngineEventSink,
  ) {
    this.mode = opts.permissionMode ?? 'default';
    this.currentModelId = opts.modelId;
    this.resumeSessionId = opts.resumeSessionId;
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ engineSessionId: string }> {
    this.emit({ type: 'session.status', status: 'starting' });
    const args = ['acp', ...approvalArgs(this.mode)];
    if (this.currentModelId) args.push('--model', this.currentModelId);
    if (this.opts.thinking) args.push('--thinking', this.opts.thinking);
    if (this.opts.tools?.length) args.push('--tools', this.opts.tools.join(','));
    // 多根工作区：omp 的 ACP session/new 无多根字段，但 acp 子命令接受
    // 进程级可重复 --add-dir（baseOptions → 该进程创建/加载的每个会话）。
    // 本适配器每会话一个 omp 进程，故进程级即会话级。
    for (const dir of this.opts.extraDirs ?? []) args.push('--add-dir', dir);
    const spec = resolveOmpCli(args, this.opts.cliPath);

    const child = spawn(spec.command, spec.args, {
      cwd: this.opts.cwd,
      shell: spec.shell ?? false,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    log.info('engine.omp', 'engine spawned', {
      command: spec.command,
      args: spec.args.join(' '),
      cwd: this.opts.cwd,
      pid: child.pid,
      resumed: !!this.resumeSessionId,
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
      // respawn 主动杀掉的旧进程不算意外退出（this.child 已指向新进程/置空）。
      if (this.disposed || this.child !== child) return;
      log.warn('engine.omp', 'engine exited unexpectedly', {
        code,
        signal: signal ?? 'none',
        pid: child.pid,
        stderrTail: this.stderrTail.slice(-8).join(' | '),
      });
      this.emit({
        type: 'error',
        source: 'engine',
        message: `${L('omp 进程意外退出', 'omp process exited unexpectedly')} (code=${code} signal=${signal ?? 'none'})\n${this.stderrTail.slice(-8).join('\n')}`,
      });
      this.emit({ type: 'session.status', status: 'error', detail: 'engine-exited' });
    });
    child.on('error', (err) => {
      if (this.disposed || this.child !== child) return;
      log.error('engine.omp', 'engine spawn failed', { command: spec.command }, err);
      this.emit({ type: 'error', source: 'client', message: `${L('无法启动 omp CLI', 'Failed to launch the omp CLI')}: ${err.message}` });
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
    this.resumeCap =
      (initRes as { agentCapabilities?: { sessionCapabilities?: { resume?: unknown } } })
        .agentCapabilities?.sessionCapabilities?.resume != null;

    const sess = await this.openSession();
    this.sessionId = sess.sessionId;
    this.applyConfigOptions(sess.configOptions);

    // plan 只读态：ACP set_mode 支持 plan<->default；auto/yolo 的自动批准
    // 已由 spawn flag 施加，运行时视为 default。
    if (this.mode === 'plan') {
      // 失败留痕（此前静默 catch，与 kimi 启动丢档同族）：plan 没应用上时
      // 选手是 always-ask + unattended 自动批准 = 实质可写。
      await this.applyMode('plan').catch((err) => {
        const detail = errorMessage(err);
        log.warn('engine.omp', 'startup apply plan mode failed — session stays default', { sessionId: this.sessionId, detail });
        compatAudit.record('omp', 'rejected-method', 'omp startup setSessionMode(plan)', detail);
      });
    }
    // ACP approval mode is carried by spawn flags, so engine mode echoes do not
    // include auto/yolo; anchor the UI once at startup instead of manual.
    this.emit({ type: 'modes.update', current: this.mode, available: ['default', 'plan', 'auto', 'yolo'] });

    this.emit({ type: 'session.status', status: 'idle' });
    return { engineSessionId: this.sessionId };
  }

  /** Resume the persisted engine session when possible, else start fresh. */
  private async openSession(): Promise<{ sessionId: string; configOptions?: unknown }> {
    const client = this.client!;
    if (this.resumeSessionId) {
      try {
        const params = { sessionId: this.resumeSessionId, cwd: this.opts.cwd, mcpServers: [] };
        const res = await withTimeout(
          this.resumeCap ? client.resumeSession(params as never) : this.loadSessionSuppressed(params),
          INIT_TIMEOUT_MS,
          this.resumeCap ? 'ACP session/resume' : 'ACP session/load (replay suppressed)',
        );
        return {
          sessionId: this.resumeSessionId,
          configOptions: (res as { configOptions?: unknown }).configOptions,
        };
      } catch (err) {
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

  /** Legacy fallback for omp builds without session/resume: session/load
   *  synchronously replays the full history as chunk notifications BEFORE
   *  resolving (omp acp-agent.ts loadSession awaits #replaySessionHistory),
   *  so a suppression window around the call drops the replayed stream.
   *  Client-side history is restored from local persistence instead. */
  private async loadSessionSuppressed(params: { sessionId: string; cwd: string; mcpServers: unknown[] }): Promise<unknown> {
    this.suppressReplay = true;
    try {
      return await this.client!.loadSession(params as never);
    } finally {
      this.suppressReplay = false;
    }
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

    // /compact 命令回合（compact() 触发或用户手输）：omp 的 ACP 内建命令路径
    // 执行压缩后不推 usage_update（实测 17.1.8：usage_update 仅 agent_end 发），
    // 若按普通回合(end_turn)收尾，chatStore 会拿着旧 usage 再次触发自动压缩
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
      // 附件装配（探针实测 omp 17.1.8）：图片走 ACP 原生 image 块
      //（base64 内联，模型直接可见 —— resource_link 在 omp 侧只退化成
      //  纯文本路径，模型看不到图）；非图片/读失败/旧版无 image 能力时
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
      if (blocks.length === 0) blocks.push({ type: 'text', text });
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

  async setModel(modelId: string): Promise<void> {
    const client = this.requireClient();
    try {
      await client.unstable_setSessionModel({ sessionId: this.sessionId, modelId });
    } catch (err) {
      // 降级路径本身正常（旧版无此实验方法），但要留账：新版引擎若砍掉
      // 此方法，这里是唯一能看到信号的地方。
      compatAudit.record('omp', 'rejected-method', 'unstable_setSessionModel', errorMessage(err));
      // 新版 pi 系 wire 字段名 configId；旧版 optionId — 两段式降级同 kimi。
      await client
        .setSessionConfigOption({ sessionId: this.sessionId, configId: 'model', value: modelId } as never)
        .catch(() =>
          client.setSessionConfigOption({ sessionId: this.sessionId, optionId: 'model', value: modelId } as never),
        );
    }
    // 引擎不保证回推 config_option_update（probe-omp-findings §3：运行时面
    // 可能根本没有 model 项）— 成功后乐观回发，否则选择器停留在旧值。
    this.currentModelId = modelId;
    this.emit({ type: 'models.update', current: modelId, available: this.modelValues });
  }

  async setMode(mode: PermissionMode): Promise<void> {
    const prev = this.mode;
    this.mode = mode;
    // 审批档变化只能换 spawn flag 生效（approval 不在 ACP 运行时面）——
    // 带新 flag 重启进程，loadSession 按原 sessionId 续接上下文。
    if (approvalBucket(prev) !== approvalBucket(mode) && this.sessionId) {
      await this.respawnForApproval();
      return;
    }
    await this.applyMode(mode);
    this.emit({ type: 'modes.update', current: this.mode, available: ['default', 'plan', 'auto', 'yolo'] });
  }

  /** ACP set_mode 只认 plan/default；auto/yolo 折叠为 default（自动批准靠 spawn flag，需重开生效）。 */
  private async applyMode(mode: PermissionMode): Promise<void> {
    const modeId = mode === 'plan' ? 'plan' : 'default';
    await this.requireClient().setSessionMode({ sessionId: this.sessionId, modeId });
  }

  /** 审批档切换：--approval-mode/--auto-approve 是进程级 flag，只能换参数
   *  重启进程；会话上下文走 omp 原生 session/resume 按原 id 续接，无需历史重放。 */
  private async respawnForApproval(): Promise<void> {
    // 回合进行中先中断 —— 重启进程回合必丢，主动 cancel 给个干净收尾。
    if (this.promptActive) await this.cancel().catch(() => undefined);
    // 挂起的审批卡随旧进程一起作废。
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.pendingPermissions.delete(id);
    }
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.closeBackgroundTurn();
    const old = this.child;
    // 先摘引用再杀：旧进程的 exit/error 监听凭 this.child !== child 守卫忽略。
    this.child = undefined;
    this.client = undefined;
    if (old) killEngineTree(old);
    log.info('engine.omp', 'respawning for approval mode change', { mode: this.mode, pid: old?.pid ?? 0 });
    this.resumeSessionId = this.sessionId;
    try {
      await this.start();
    } catch (err) {
      log.error('engine.omp', 'approval-mode respawn failed', { mode: this.mode }, err);
      this.emit({
        type: 'error',
        source: 'client',
        message: `${L('切换权限模式失败（引擎重启未完成）', 'Failed to switch permission mode (engine restart incomplete)')}: ${errorMessage(err)}`,
      });
      this.emit({ type: 'session.status', status: 'error', detail: 'respawn-failed' });
      throw err;
    }
    // 回发档位落定：loadSession 期间 config_option_update 的 mode 回声已经
    // uiMode 过滤，这里再锚定一次，确保 UI/元数据停在用户选择的档位。
    this.emit({ type: 'modes.update', current: this.mode, available: ['default', 'plan', 'auto', 'yolo'] });
  }

  /** ACP mode 回声 → cyberslots 档位。omp 的 ACP 面只有 default/plan；
   *  auto/yolo 由 spawn flag 承载，回声不含审批档信息 —— 以适配器档位
   *  为准，否则切 auto/yolo 后引擎一声 default 回声就把 UI 弹回手动审批。 */
  private uiMode(engineMode: string): PermissionMode {
    if (engineMode === 'plan') return 'plan';
    // 强制档（plan/auto/yolo）一律以适配器为准：resume 时引擎侧档位未持久
    // 化会回声 default，顺从就把 meta.permissionMode 弹回 default 并持久化，
    // 下次重启丢失 plan 只读档（赛马选手变可写）—— 与 kimi KAP 丢档同族
    //（2026-08-03 omp 选手 meta 实测被持久化为 default）。交互 default 档
    // 时 this.mode 与回声一致，不受影响。
    return this.mode;
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
    // Drop the session/load history-replay window (legacy fallback path).
    if (this.suppressReplay) return;
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
        const toolName = extractToolName(u);
        const content = mapToolContent(u);
        // task 子代理在 omp 下强制 yolo（headless 不受主会话审批约束）——
        // 显式标注给 UI，TaskCard 据此显「免审批」，不再对全部引擎误显。
        const isTask = (toolName ?? '').toLowerCase() === 'task';
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: String(u.toolCallId ?? ''),
          title: u.title == null ? undefined : String(u.title),
          toolKind: u.kind == null ? undefined : String(u.kind),
          toolName,
          status: u.status == null ? undefined : (mapStatus(String(u.status)) as ToolCallStatus),
          content: isTask ? { ...(content ?? {}), autoApproved: true } : content,
          locations: mapLocations(u.locations),
        });
        return;
      }
      // omp 实际只发 'plan'（全量快照；acp-event-mapper 无 plan_update/
      // plan_removed 发送点 —— 清空以 entries:[] 表达）。'plan_update' 分支
      // 留作 ACP 协议容忍，非 omp 行为。
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
        const raw = String(u.currentModeId ?? '');
        if (raw) this.emit({ type: 'modes.update', current: this.uiMode(raw), available: ['default', 'plan'] });
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
        // user_message_chunk 等已知无 UI 影响的 kind 静默；plan_removed 在 omp
        // 源码中无发送点（容忍 ACP 协议词汇才列入）；真正未知的进审计。
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
    // backgroundKind='task'：一次性自发工作、没有「下一轮」→ 渲染层补发排队消息。
    //（若紧接的 prompt() 已在开新回合，补发的消息会因 busy 重入队，无副作用。）
    this.emit({ type: 'turn.ended', turnId, stopReason: 'background', backgroundKind: 'task' });
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
    //（对齐 ClaudeAdapter unattended；plan 只读档拦执行/写操作是赛马
    //  死锁高发位 —— 2026-08-03 omp 选手跑探针脚本卡审批事故）。
    if (this.opts.unattended) {
      const auto = options.find((o) => o.kind.startsWith('allow'))?.optionId ?? options[0]?.optionId;
      log.debug('engine.omp', 'unattended auto-approve', { title: title.slice(0, 80), optionId: auto });
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
        this.modelValues = values;
        this.emit({ type: 'models.update', current, available: values });
      } else if (id === 'mode') {
        this.emit({
          type: 'modes.update',
          current: this.uiMode(current),
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

function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 1.7));
}

function numOrU(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(L(`${tag} 超时 (${ms}ms)`, `${tag} timed out (${ms}ms)`))), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
