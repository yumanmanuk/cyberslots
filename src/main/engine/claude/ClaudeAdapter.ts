/**
 * ClaudeAdapter — drives one persistent `claude` child process in
 * bidirectional stream-json mode over stdio and translates its NDJSON
 * event stream into engine-agnostic `EngineEvent`s.
 *
 * 与 antigravity headless（每回合一进程）不同：Claude Code 的
 * `--input-format stream-json --output-format stream-json` 是「常驻进程 +
 * 多回合」模型，一个进程活到会话关闭，逐条 user 消息驱动一个回合，
 * 每回合以一条 `result` 事件收尾。协议要点（scripts/probe-claude.mjs 实测，
 * CLI 2.1.220 校对）：
 *
 *   spawn:  claude -p --input-format stream-json --output-format stream-json
 *           --include-partial-messages --verbose
 *           --permission-prompt-tool stdio --model <m> [--permission-mode <pm>]
 *           [--resume <sessionId>] [--add-dir <root>...]
 *
 *   下行事件（stdout NDJSON）：
 *     system/init         → session_id / model / tools / slash_commands / permissionMode
 *     stream_event        → Anthropic SSE 原始块（content_block_delta 的
 *                           text_delta / thinking_delta / input_json_delta）
 *     assistant / user    → 完整消息块（tool_use / tool_result / text / thinking）
 *     control_request(can_use_tool) → 权限询问，须回 control_response(allow/deny)
 *     result              → 回合终态（usage / total_cost_usd / is_error）
 *
 *   上行（stdin NDJSON）：
 *     user message        → {type:'user', message:{role,content:[...]}}
 *     control_request      → interrupt / set_permission_mode / set_model
 *     control_response      → 对 can_use_tool 的授权裁决
 *
 * 认证真源是 CLI 自身（OAuth token / ANTHROPIC_API_KEY），本适配器不感知。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type {
  EngineEvent,
  PermissionMode,
  PermissionOptionView,
  PlanEntry,
  ToolCallContent,
  UsageInfo,
} from '@shared/types';
import type { EngineAdapter, EngineEventSink } from '../EngineAdapter';
import { readInlineImage } from '../attachments';
import { L } from '../../i18n';
import { killEngineTree } from '../killTree';
import { compatAudit } from '../compatAudit';
import { log } from '../../log/logger';
import { claudeSpawnEnv, resolveClaudeCli } from './resolveClaude';

const INIT_TIMEOUT_MS = 30_000;

/** 权限模式 → Claude Code CLI --permission-mode。
 *  cyberslots 的四档语义向 Claude 的六档映射：
 *   default→default（逐次审批）、plan→plan（只读规划）、
 *   auto→acceptEdits（自动接受编辑，仍走 can_use_tool 便于台账）、
 *   yolo→bypassPermissions（完全放行）。 */
const MODE_MAP: Record<PermissionMode, string> = {
  default: 'default',
  plan: 'plan',
  auto: 'acceptEdits',
  yolo: 'bypassPermissions',
};

/** 可选模型别名（`claude` 接受别名或全名；启动时静态下发填充选择器）。 */
export const CLAUDE_MODEL_SLUGS = ['default', 'sonnet', 'opus', 'haiku'];

/** effort → Claude --effort（low/medium/high/xhigh/max）。 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ClaudeAdapterOptions {
  cwd: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  /** Resume an existing engine session (Claude session UUID). */
  resumeSessionId?: string;
  /** 空会话恢复失败静默降级（无客户端历史时）。 */
  quietResumeFallback?: boolean;
  /** Optional explicit path to claude CLI / cli.js (settings override). */
  cliEntry?: string;
  /** 多根工作区的其余根目录 → --add-dir 放行（首个根是进程 cwd）。 */
  extraDirs?: string[];
  /** effort（reasoning 深度）；空 = 引擎默认。 */
  effort?: string;
  /** 无人值守（赛马角色会话）：自动放行一切 can_use_tool（含 ExitPlanMode），
   *  防因无人应答权限/计划审批而死锁。 */
  unattended?: boolean;
  /** 原生分叉：从此父会话 id 以 --fork-session 分叉（首个 prompt 处生新 id）。 */
  forkFromSessionId?: string;
  /** 额外 MCP 服务器配置文件路径 → --mcp-config（claude 自身的 ~/.claude MCP 仍自动加载）。 */
  mcpConfigPath?: string;
}

interface PendingPermission {
  resolve: (decision: { behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }) => void;
  toolName: string;
  input: unknown;
}

export class ClaudeAdapter implements EngineAdapter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private sessionId = '';
  private turnId = 0;
  private disposed = false;
  private promptActive = false;
  private mode: PermissionMode;
  private modelId: string;
  private effort: string | undefined;
  /** 已通过 /effort 斜杠命令生效的思考档（避免重复下发）。 */
  private appliedEffort: string | undefined;
  /** 内部静默命令（如 /effort）进行中：此时抑制一切 UI 事件，
   *  下一条 result 典现它而不当作真回合收尾。 */
  private internalCommandDone: (() => void) | undefined;
  private stdoutBuf = '';
  private readonly stderrTail: string[] = [];
  /** 本回合结束的 resolve（result 事件到达时兑现）。 */
  private turnDone: (() => void) | undefined;
  /** compact() 触发的 /compact 回合标记 — 见 prompt() 的 compactPromptActive。 */
  private compactTurnActive = false;
  /** 当前回合是否为 /compact 命令回合（含用户手输）：background 收尾 + 进度提示。 */
  private compactPromptActive = false;
  /** compact 回合内 compacting 提示只发一次。 */
  private compactStatusSeen = false;
  /** result.modelUsage 里的 contextWindow（usage.update 的 size 来源，2.1.x 实测携带）。 */
  private lastContextSize = 0;
  /** 最近一次主线程 API 调用的上下文占用（assistant 消息 usage 的
   *  input + cache_read + cache_creation）。Claude Code 的 result.usage 是
   *  回合内多次 API 调用的累计值，不能当上下文占用；必须取最后一次
   *  assistant 消息的单次 usage（2.1.220 源码验证，状态栏同口径）。 */
  private lastApiInputTokens = 0;
  /** 待应答的 can_use_tool 权限请求（requestId → pending）。 */
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  /** tool_use_id → 前端展示用 toolCallId（保持 upsert 稳定）。 */
  private readonly toolCallSeen = new Set<string>();
  /** Claude 2.1.x Task* 清单（跨回合持久；引擎不推快照，客户端增量聚合）。 */
  private readonly taskEntries = new Map<string, PlanEntry>();
  /** TaskCreate tool_use_id → 暂存（引擎分配的数字 id 在 tool_result 文本里）。 */
  private readonly pendingTaskCreates = new Map<string, { subject: string; description?: string }>();
  /** Task* 工具调用 id — 其 tool_use/tool_result 不出工具卡（已投射计划面板）。 */
  private readonly taskToolCalls = new Set<string>();
  /** 本回合累计输出字符数（result 无 usage 时兜底估算）。 */
  private turnOutputChars = 0;
  private lastUsage: UsageInfo | undefined;
  private started = false;
  /** interrupt 落在 turn 未开跑的空窗：记账，回合一开立即补发。 */
  private cancelRequested = false;
  /** 是否已发出模型/模式列表（避免重复）。 */
  private announcedMeta = false;
  /** 新会话由我方生成确定性 session-id（传 --session-id）；续接/分叉不置。 */
  private ownSessionId = false;
  /** MCP 服务器失败提示只发一次（init 每回合重发，防刷屏）。 */
  private mcpFailureReported = false;

  constructor(
    private readonly opts: ClaudeAdapterOptions,
    private readonly emit: EngineEventSink,
  ) {
    this.mode = opts.permissionMode ?? 'default';
    this.modelId = opts.modelId || 'default';
    this.effort = opts.effort || undefined;
    // opts.effort 随 --effort 启动旗标生效（若有），视为已生效初值。
    this.appliedEffort = opts.effort || undefined;
    // 会话 id 优先级：续接（resume）> 父会话（fork）> 新建。
    // 新会话我方预生成确定性 UUID 传 --session-id，使 engineSessionId 即使
    // 首回合未完成也可持久化/续接（scripts/probe-claude-features.mjs 实测采纳）。
    if (opts.resumeSessionId) {
      this.sessionId = opts.resumeSessionId;
    } else if (opts.forkFromSessionId) {
      this.sessionId = ''; // 分叉新 id 由首个 result 回填
    } else {
      this.sessionId = randomUUID();
      this.ownSessionId = true;
    }
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ engineSessionId: string }> {
    this.emit({ type: 'session.status', status: 'starting' });
    this.spawnProcess();
    // 常驻进程 spawn 后立即 idle；session_id 由首个 init 事件回填。
    // 静态下发模型/权限模式列表（Claude 无独立的运行时枚举事件）。
    this.announceMeta();
    this.emit({ type: 'session.status', status: 'idle' });
    this.started = true;
    return { engineSessionId: this.sessionId };
  }

  private announceMeta(): void {
    if (this.announcedMeta) return;
    this.announcedMeta = true;
    this.emit({ type: 'models.update', current: this.modelId, available: CLAUDE_MODEL_SLUGS });
    this.emit({ type: 'modes.update', current: this.mode, available: ['default', 'plan', 'auto', 'yolo'] });
  }

  private spawnProcess(): void {
    const args = this.buildSpawnArgs();
    const spec = resolveClaudeCli(args, this.opts.cliEntry);
    const child = spawn(spec.command, spec.args, {
      cwd: this.opts.cwd,
      shell: spec.shell ?? false,
      env: claudeSpawnEnv(spec),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, // 防止 Windows 下闪出 cmd 控制台窗口
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    log.info('engine.claude', 'engine spawned', {
      command: spec.command,
      args: spec.args.join(' '),
      cwd: this.opts.cwd,
      pid: child.pid,
      resumed: !!this.opts.resumeSessionId && !this.ownSessionId,
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onStdout(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      for (const line of d.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 60) this.stderrTail.shift();
      }
    });
    child.on('error', (err) => {
      if (this.disposed) return;
      log.error('engine.claude', 'engine spawn failed', { command: spec.command }, err);
      this.emit({ type: 'error', source: 'client', message: `${L('无法启动 claude CLI', 'Failed to launch the claude CLI')}: ${err.message}` });
      this.emit({ type: 'session.status', status: 'error', detail: 'spawn-failed' });
    });
    child.on('exit', (code, signal) => {
      if (this.disposed) return;
      // 空会话静默降级：--resume 目标在引擎侧无落盘（空会话从未对话、或
      // 首条 prompt 因故未送达），无上下文可丢 —— 换新 sessionId 重开进程，
      // 对用户无感（kimi/opencode 已有同款兜底，此处补齐消费）。
      if (
        this.opts.resumeSessionId &&
        this.opts.quietResumeFallback &&
        !this.promptActive &&
        code !== 0 &&
        this.stderrTail.some((l) => l.includes('No conversation found'))
      ) {
        log.warn('engine.claude', 'resume target missing, falling back to a fresh session', {
          staleSessionId: this.sessionId,
          code,
          signal: signal ?? 'none',
        });
        this.sessionId = randomUUID();
        this.ownSessionId = true;
        this.stderrTail.length = 0;
        this.child = undefined;
        this.spawnProcess();
        // 新 engineSessionId 回填 meta 并落盘 —— 否则下次唤醒仍 resume 失效旧 id。
        this.emit({ type: 'session.meta', patch: { engineSessionId: this.sessionId } });
        return;
      }
      log.warn('engine.claude', 'engine exited unexpectedly', {
        code,
        signal: signal ?? 'none',
        pid: child.pid,
        promptActive: this.promptActive,
        stderrTail: this.stderrTail.slice(-8).join(' | '),
      });
      // 进程意外退出：结束进行中的回合，避免 UI 永久转圈。
      if (this.promptActive) {
        const tail = this.stderrTail.slice(-8).join('\n');
        this.emit({
          type: 'error',
          source: classifyExit(tail),
          message: `${L('claude 进程意外退出', 'claude process exited unexpectedly')} (code=${code} signal=${signal ?? 'none'})\n${tail}`.trim(),
        });
        this.finishTurn('error');
      }
      this.emit({ type: 'session.status', status: 'error', detail: 'engine-exited' });
      this.child = undefined;
    });
  }

  private buildSpawnArgs(): string[] {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-prompt-tool', 'stdio',
      // 子代理（Task）的文本/思考/工具以带 parent_tool_use_id 的消息转发，
      // 使子代理执行过程实时可见（scripts/probe-claude-features.mjs 实测）。
      '--forward-subagent-text',
    ];
    if (this.modelId && this.modelId !== 'default') args.push('--model', this.modelId);
    args.push('--permission-mode', MODE_MAP[this.mode] ?? 'default');
    if (this.effort) args.push('--effort', this.effort);
    // 额外 MCP 服务器（claude 自身的 ~/.claude MCP 无论如何都自动加载）。
    if (this.opts.mcpConfigPath) args.push('--mcp-config', this.opts.mcpConfigPath);
    // 会话接续三选一：
    //  分叉：--resume <父> --fork-session（首个 result 回填新 id）；
    //  新建：--session-id <我方 UUID>（确定性会话号）；
    //  续接：--resume <已有 id>。
    if (this.opts.forkFromSessionId) {
      args.push('--resume', this.opts.forkFromSessionId, '--fork-session');
    } else if (this.ownSessionId && this.sessionId) {
      args.push('--session-id', this.sessionId);
    } else if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }
    // 多根工作区：其余根目录并入允许访问范围（首个根是进程 cwd）。
    for (const dir of this.opts.extraDirs ?? []) args.push('--add-dir', dir);
    return args;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // 清空待应答权限（拒绝，避免引擎侧永久挂起）。
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'session disposed' });
      this.pendingPermissions.delete(id);
    }
    if (this.turnDone) {
      this.turnDone();
      this.turnDone = undefined;
    }
    // 兼现挂起的内部命令等待（如 /effort 未回 result 就 dispose）。
    if (this.internalCommandDone) {
      this.internalCommandDone();
      this.internalCommandDone = undefined;
    }
    if (this.child) killEngineTree(this.child);
    this.child = undefined;
  }

  // ------------------------------------------------------------- actions

  async prompt(text: string, attachments?: string[], effort?: string): Promise<void> {
    if (this.disposed) throw new Error('claude session disposed');
    // 并发防护：stream-json stdin 交错两条 user 消息会污染进行中的回合
    //（正常路径不会触发 —— UI busy 禁用 + 排队机制；双保险）。
    if (this.promptActive) throw new Error(L('回合进行中，无法发送', 'Turn in flight — cannot send'));
    if (!this.child) this.spawnProcess();
    // effort 热切：Claude 的思考档是运行时斜杠命令 `/effort <level>`
    // （非 control 协议，非 spawn 旗标 —— scripts/probe-claude-effort.mjs 实测）。
    // 仅在与已生效档不同时，先发一条内部静默 /effort 回合再跑正文。
    if (effort && CLAUDE_EFFORTS.includes(effort) && effort !== this.appliedEffort) {
      await this.applyEffort(effort);
    }

    // /compact 命令回合（compact() 触发或用户手输）：标 background 收尾，
    // 防 chatStore 拿旧 usage 重复触发自动压缩；引擎 auto-compact 在普通
    // 回合内部发生，不走这里。
    this.compactPromptActive = this.compactTurnActive || /^\/compact(?:\s|$)/.test(text.trim());
    this.compactStatusSeen = false;
    const turnId = ++this.turnId;
    this.promptActive = true;
    this.turnOutputChars = 0;
    this.toolCallSeen.clear();
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'session.status', status: 'running' });
    const startedAt = Date.now();

    // 组装 user 消息内容块：文本 + 附件（图片走 image 块，其余走文本引用）。
    const content = this.buildUserContent(text, attachments);
    this.send({ type: 'user', message: { role: 'user', content } });

    // 若在 turn 开跑前用户已点停止，立刻补发 interrupt。
    if (this.cancelRequested) {
      this.cancelRequested = false;
      this.sendInterrupt();
    }

    await new Promise<void>((resolve) => {
      this.turnDone = () => {
        this.turnDone = undefined;
        this.promptActive = false;
        if (!this.disposed) this.emit({ type: 'session.status', status: 'idle' });
        resolve();
      };
      // 兜底超时：进程僵死时不永久挂起（30min，与长任务上限对齐）。
      const timer = setTimeout(() => {
        if (this.turnDone) {
          this.emit({ type: 'error', turnId, source: 'client', message: L('claude 回合超时（30min），已中止', 'claude turn timed out (30min) — aborted') });
          this.finishTurn('error', startedAt);
        }
      }, 30 * 60_000);
      timer.unref?.();
    });
  }

  /** 组装 Anthropic content blocks：文本 + 原生 image 块（base64）。
   *  协议事实（探针实测 CLI 2.1.220）：stream-json 输入接受
   *  {type:image, source:{type:base64, media_type, data}}，图片直接进模型
   *  上下文 —— 零工具往返、任何权限模式可用（工作区外的粘贴临时文件不再
   *  触发 Read 审批）；空 text 块 + 图片块亦被正常接受。
   *  非图片附件保持路径引用（引擎 Read 工具按需读取）；白名单外格式
   * （bmp 等）与读取失败的图片同样退化为路径引用，不污染会话历史。 */
  private buildUserContent(text: string, attachments?: string[]): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    const pathRefs: string[] = [];
    const images: Array<Record<string, unknown>> = [];
    for (const path of attachments ?? []) {
      const img = readInlineImage(path);
      if (img) {
        images.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      } else {
        pathRefs.push(path);
      }
    }
    let body = text;
    if (pathRefs.length) body += '\n\n附件路径：\n' + pathRefs.join('\n');
    // ? text ????kimi ACP Internal error / codex ?? 400 ?????
    // ????????????????????????????????
    if (body.trim() || images.length === 0) blocks.push({ type: 'text', text: body });
    blocks.push(...images);
    return blocks;
  }

  async cancel(): Promise<void> {
    if (!this.promptActive) {
      // 空窗期点停止：记账，下个回合一开跑立即补发 interrupt。
      this.cancelRequested = true;
      return;
    }
    this.sendInterrupt();
  }

  /** 发一条内部静默 `/effort <level>` 回合热切思考档：
   *  不发 turn.started/turn.ended，不泄露其 text/thinking（internalCommandDone
   *  置位期间流事件均被 handleStreamEvent/handleMessage 抑制），
   *  等到其 result 到达即兼现。失败（超时/进程死）不阻断正文，
   *  只是档位未切换。 */
  private async applyEffort(effort: string): Promise<void> {
    if (!this.child || this.disposed) return;
    this.appliedEffort = effort;
    this.effort = effort;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.internalCommandDone = undefined;
        resolve();
      };
      this.internalCommandDone = done;
      this.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `/effort ${effort}` }] } });
      // 斜杠命令很快回 result，8s 兑底防旧版无此命令时永远挂起。
      const timer = setTimeout(done, 8_000);
      timer.unref?.();
    });
  }

  private sendInterrupt(): void {
    this.send({ type: 'control_request', request_id: `int-${randomUUID().slice(0, 8)}`, request: { subtype: 'interrupt' } });
  }

  async setModel(modelId: string): Promise<void> {
    this.modelId = modelId;
    this.emit({ type: 'models.update', current: modelId, available: CLAUDE_MODEL_SLUGS });
    // 运行中热切：发 control_request(set_model)；未起进程则下次 spawn 生效。
    if (this.child) {
      this.send({
        type: 'control_request',
        request_id: `model-${randomUUID().slice(0, 8)}`,
        request: { subtype: 'set_model', model: modelId === 'default' ? undefined : modelId },
      });
    }
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan', 'auto', 'yolo'] });
    if (this.child) {
      this.send({
        type: 'control_request',
        request_id: `mode-${randomUUID().slice(0, 8)}`,
        request: { subtype: 'set_permission_mode', mode: MODE_MAP[mode] ?? 'default' },
      });
    }
  }

  /** 上下文压缩：走 Claude 原生 /compact 斜杠命令（stream-json 输入实测
   *  2.1.220 识别并执行压缩；回合以 background 收尾，防自动压缩连环触发）。 */
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
    // optionId 语义：allow_once/allow_always → allow；其余/undefined → deny。
    const allow = optionId === 'allow' || optionId === 'allow_once' || optionId === 'allow_always';
    pending.resolve(
      allow
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: optionId === undefined ? L('用户取消', 'User cancelled') : L('用户拒绝', 'User rejected') },
    );
    this.emit({ type: 'permission.resolved', requestId, optionId });
    if (this.promptActive) this.emit({ type: 'session.status', status: 'running' });
  }

  // ------------------------------------------------------- stream parsing

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // 非 JSON（banner/日志）忽略；以 { 开头却解不动 = 畸形帧，留账。
      if (line.startsWith('{')) compatAudit.record('claude', 'parse-error', 'stdout-malformed-json', line);
      return;
    }
    const type = String(ev.type ?? '');
    switch (type) {
      case 'system':
        this.handleSystem(ev);
        return;
      case 'stream_event':
        this.handleStreamEvent(ev.event as Record<string, unknown> | undefined);
        return;
      case 'assistant':
      case 'user':
        // parent_tool_use_id 非空 = 子代理（Task）转发的消息，工具标题加前缀区分。
        this.handleMessage(type, ev.message as Record<string, unknown> | undefined, str(ev.parent_tool_use_id));
        return;
      case 'control_request':
        this.handleControlRequest(ev);
        return;
      case 'control_response':
        // 我方 control_request 的回执（set_model/set_mode/interrupt）— 无 UI 影响。
        return;
      case 'result':
        this.handleResult(ev);
        return;
      default:
        compatAudit.record('claude', 'unknown-event', `type:${type}`, ev);
        return;
    }
  }

  private handleSystem(ev: Record<string, unknown>): void {
    const subtype = String(ev.subtype ?? '');
    this.captureSession(ev.session_id);
    if (subtype === 'init') {
      // 会话已实例化：后续重 spawn（进程死后重起）改走 --resume，
      // 否则再传同一 --session-id 会报「会话已存在」。
      this.ownSessionId = false;
      // MCP 服务器状态回显：失败的服务器发一次非致命提示（已连接的工具直接可用）。
      this.reportMcpStatus(ev.mcp_servers);
      // slash_commands 由 init 携带（每回合重发，去重交给渲染层）。
      // 过滤 TUI 专属命令（headless 下无效/有害的交互式入口，2.1.220 实测清单）：
      //   color/theme/config → 交互式设置面板；heapdump → 写诊断快照文件；
      //   team-onboarding → 交互式引导；__ 前缀 → CLI 内部命令（如 __remote-workflow）。
      // clear/model/compact/effort 等 headless 实测有效，保留。
      const TUI_ONLY = new Set(['color', 'theme', 'config', 'heapdump', 'team-onboarding']);
      const cmds = (Array.isArray(ev.slash_commands) ? (ev.slash_commands as unknown[]) : [])
        .map((c) => String(c))
        .filter((n) => !TUI_ONLY.has(n) && !n.startsWith('__'));
      if (cmds.length) {
        this.emit({
          type: 'commands.update',
          commands: cmds.map((name) => ({ name })),
        });
      }
      // 注：不用 init.model 覆写 this.modelId — init.model 是引擎解析出的
      // 后端模型全名（代理场景下可能是 minimax/kimi 等上游名），而非
      // 用户选的别名；覆写会把选择器当前值冲成列表外的陆生值。
      // 模型选择以 start() 静态下发 + setModel() 用户显选为准。
    }
    if (subtype === 'status' && this.compactPromptActive) {
      // /compact 回合的进度反馈：compacting → 提示一次；失败有 claude 自己的
      // assistant 文本兜底（"Not enough messages to compact."），不重复发。
      // 引擎 auto-compact 在普通回合内部发生（compactPromptActive=false），
      // 其 status 一律静默，不污染正文与赛马 transcript。
      if (ev.status === 'compacting' && !this.compactStatusSeen) {
        this.compactStatusSeen = true;
        this.emit({ type: 'text.delta', turnId: this.turnId, text: L('正在压缩上下文…', 'Compacting context…') });
      }
      return;
    }
    if (subtype === 'compact_boundary' && this.compactPromptActive) {
      // 压缩成功边界（transcript 级标记，compactMetadata 带 pre/postTokens）→ X→Y 展示。
      const meta = (ev.compactMetadata ?? {}) as Record<string, unknown>;
      const pre = num(meta.preTokens);
      const post = num(meta.postTokens);
      this.emit({
        type: 'text.delta',
        turnId: this.turnId,
        text:
          pre != null && post != null
            ? L('已压缩上下文：' + pre + ' → ' + post + ' tokens', 'Context compacted: ' + pre + ' → ' + post + ' tokens')
            : L('已压缩上下文', 'Context compacted'),
      });
      return;
    }
    // 引擎 auto-compact（内部阈值，普通回合内发生）：留一条完成态工具行作解释
    //（result usage 随后骤降，ContextRing 不会降得莫名其妙）。只发 completed ——
    // in_progress 会进 trackTurnText 重置分支污染赛马 transcript，text.delta
    // 同理；进行中状态一律静默。
    if (!this.compactPromptActive && (subtype === 'compact_boundary' || subtype === 'compact_result')) {
      const meta = (ev.compactMetadata ?? {}) as Record<string, unknown>;
      const pre = num(meta.preTokens);
      const post = num(meta.postTokens);
      this.emit({
        type: 'tool.upsert',
        turnId: this.turnId,
        toolCallId: 'auto-compact-' + String(this.turnId),
        title:
          pre != null && post != null
            ? L('已自动压缩上下文：' + pre + ' → ' + post + ' tokens', 'Context auto-compacted: ' + pre + ' → ' + post + ' tokens')
            : L('已自动压缩上下文', 'Context auto-compacted'),
        toolKind: 'other',
        status: 'completed',
      });
      return;
    }
    // system/status / thinking_tokens / notification 等 — 无 UI 影响。
  }

  /** init.mcp_servers = [{name,status}]（scripts/probe-claude-features.mjs 实测）：
   *  失败的服务器发一次非致命 error 提示（已连接的其 mcp__ 工具直接能用）。 */
  private reportMcpStatus(raw: unknown): void {
    if (this.mcpFailureReported || !Array.isArray(raw)) return;
    const failed = (raw as Array<Record<string, unknown>>)
      .filter((s) => String(s.status ?? '') === 'failed')
      .map((s) => String(s.name ?? '?'));
    if (failed.length) {
      this.mcpFailureReported = true;
      this.emit({
        type: 'error',
        source: 'client',
        message: L(
          `MCP 服务器连接失败：${failed.join('、')}（不影响其余功能，检查其命令/环境后重开会话）。`,
          `MCP server connection failed: ${failed.join(', ')} (other features unaffected — check its command/env, then reopen the session).`,
        ),
      });
    }
  }

  /** stream_event：Anthropic SSE 原始块。只取增量 delta 做流式展示，
   *  完整块（assistant/user）另走 handleMessage（工具调用/最终文本）。 */
  private handleStreamEvent(event: Record<string, unknown> | undefined): void {
    if (!event) return;
    // 内部 /effort 等静默命令进行中：不泄露其流式输出。
    if (this.internalCommandDone) return;
    const turnId = this.turnId;
    const etype = String(event.type ?? '');
    if (etype !== 'content_block_delta') return; // start/stop/message_* 由完整块覆盖
    const delta = event.delta as Record<string, unknown> | undefined;
    if (!delta) return;
    const dtype = String(delta.type ?? '');
    if (dtype === 'text_delta') {
      const text = String(delta.text ?? '');
      if (text) {
        this.turnOutputChars += text.length;
        this.emit({ type: 'text.delta', turnId, text });
      }
    } else if (dtype === 'thinking_delta') {
      const text = String(delta.thinking ?? '');
      if (text) this.emit({ type: 'thinking.delta', turnId, text });
    }
    // input_json_delta（工具参数流）不逐字渲染 — 等 assistant 完整块的 tool_use。
  }

  /** 完整消息块：assistant 的 tool_use / 最终 text；user 的 tool_result。
   *  subagentId 非空 = 子代理（Task）转发，工具标题加 ↳ 前缀区分。 */
  private handleMessage(role: string, message: Record<string, unknown> | undefined, subagentId?: string): void {
    if (!message) return;
    // 内部静默命令进行中：不泄露其工具/文本块。
    if (this.internalCommandDone) return;
    // 主线程 assistant 完整消息携带本次 API 调用的单次 usage：
    // result.usage 是回合累计，不能用于 ContextRing/自动压缩的 used。
    if (role === 'assistant' && !subagentId) {
      const mu = (message.usage ?? {}) as Record<string, unknown>;
      const input = num(mu.input_tokens) ?? 0;
      const cacheRead = num(mu.cache_read_input_tokens) ?? 0;
      const cacheCreate = num(mu.cache_creation_input_tokens) ?? 0;
      const output = num(mu.output_tokens) ?? 0;
      if (input + cacheRead + cacheCreate + output > 0) {
        this.lastApiInputTokens = input + cacheRead + cacheCreate;
      }
    }
    const turnId = this.turnId;
    const content = message.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      const btype = String(block.type ?? '');
      if (btype === 'tool_use') {
        this.emitToolUse(block, turnId, subagentId);
      } else if (btype === 'tool_result') {
        this.emitToolResult(block, turnId);
      } else if (btype === 'text' && role === 'assistant') {
        // 流式 delta 已逐字推送；完整 text 块不重复 emit（防双显）。
        // plan 模式下的最终文本 = 计划文档，由 stopReason 驱动的 UI 处理。
        return;
      }
    }
  }

  private emitToolUse(block: Record<string, unknown>, turnId: number, subagentId?: string): void {
    const id = String(block.id ?? '');
    const name = String(block.name ?? '');
    const input = (block.input ?? {}) as Record<string, unknown>;
    const kind = mapToolKind(name);
    const subject = toolSubject(name, input);
    // ExitPlanMode 工具 = 计划提交，额外推一条 plan.update（用 plan 文本）。
    if (name === 'ExitPlanMode' || name === 'exit_plan_mode') {
      const planText = String(input.plan ?? '');
      if (planText) this.emit({ type: 'plan.update', turnId, entries: parsePlanEntries(planText) });
    }
    // TodoWrite 工具 = 任务清单 → plan.update（与 kimi/codex 的 plan 观感对齐）。
    // （2.1.x 旧版工具；当前 CLI 已被下方 Task* 工具族取代，保留兼容旧版。）
    if ((name === 'TodoWrite' || name === 'todo_write') && Array.isArray(input.todos)) {
      const entries = (input.todos as Array<Record<string, unknown>>).map((td) => ({
        content: String(td.content ?? td.activeForm ?? ''),
        status: normalizeTodoStatus(String(td.status ?? 'pending')),
      }));
      if (entries.length) this.emit({ type: 'plan.update', turnId, entries });
    }
    // Claude 2.1.220 实测：TodoWrite 已从工具表移除，任务清单改由 Task* 工具族
    // 增量维护（TaskCreate {subject,description} / TaskUpdate {taskId,status|
    // deleted} / TaskList / TaskGet）——跨回合持久、免权限、主/子代理共享同一
    // 编号空间，引擎不推快照（子代理转发的消息同样进这里，不可按 subagentId
    // 过滤）。聚合投射计划面板，工具卡不再出（对齐 kimi/codex 的 plan 观感）。
    if (name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskGet' || name === 'TaskList') {
      this.handleTaskToolUse(id, name, input, turnId);
      return;
    }
    this.toolCallSeen.add(id);
    // 子代理工具加 ↳ 前缀（时间线里一眼辨认是子代理在干活）。
    const baseTitle = subject ?? name;
    const title = subagentId ? `↳ ${baseTitle}` : baseTitle;
    this.emit({
      type: 'tool.upsert',
      turnId,
      toolCallId: id,
      title,
      toolKind: kind,
      toolName: name,
      status: 'in_progress',
      content: toolInputContent(name, input),
      locations: kind === 'read' && subject ? [subject] : undefined,
    });
  }

  /** Task* 工具（2.1.x 任务清单）：不出工具卡，聚合维护 taskEntries 投射 plan.update。 */
  private handleTaskToolUse(id: string, name: string, input: Record<string, unknown>, turnId: number): void {
    this.taskToolCalls.add(id); // tool_result 处跳过工具卡并做结果合并
    if (name === 'TaskCreate') {
      // 引擎分配的数字 id 只出现在 tool_result 文本（"Task #N created successfully"）。
      this.pendingTaskCreates.set(id, { subject: String(input.subject ?? ''), description: str(input.description) });
      return;
    }
    if (name === 'TaskUpdate') {
      const taskId = str(input.taskId);
      if (!taskId) return;
      const status = str(input.status);
      const subject = str(input.subject);
      if (status === 'deleted') {
        this.taskEntries.delete(taskId);
      } else {
        const prev = this.taskEntries.get(taskId);
        this.taskEntries.set(taskId, {
          content: subject ?? prev?.content ?? `#${taskId}`,
          status: status ? normalizeTodoStatus(status) : prev?.status ?? 'pending',
        });
      }
      this.emitTasksPlan(turnId);
    }
    // TaskGet / TaskList：此处只抑制工具卡；TaskList 的快照合并在 tool_result 做。
  }

  /** Task* 的 tool_result：TaskCreate 回填引擎分配 id；TaskList 文本快照作清单真源。 */
  private applyTaskResult(toolUseId: string, content: string, turnId: number): void {
    const created = this.pendingTaskCreates.get(toolUseId);
    if (created) {
      this.pendingTaskCreates.delete(toolUseId);
      // "Task #N created successfully: <subject>" — 数字 id 只在这份文本里。
      const m = /#(\d+)/.exec(content);
      if (m?.[1]) {
        this.taskEntries.set(m[1], { content: created.subject || `#${m[1]}`, status: 'pending' });
        this.emitTasksPlan(turnId);
      }
      return;
    }
    // TaskList 结果逐行 "#N [status] subject"（实测 2.1.220）——全量快照，
    // 覆盖增量视图（含会话恢复后旧任务的回填与 deleted 的权威清理）。
    const lines = [...content.matchAll(/^\s*#(\d+)\s+\[(pending|in_progress|completed)\]\s+(.+)$/gm)];
    if (lines.length) {
      this.taskEntries.clear();
      for (const m of lines) {
        this.taskEntries.set(m[1]!, { content: m[3]!.trim(), status: normalizeTodoStatus(m[2]!) });
      }
      this.emitTasksPlan(turnId);
    }
  }

  /** 当前 Task* 清单（数字 id 升序）→ plan.update。 */
  private emitTasksPlan(turnId: number): void {
    const entries = [...this.taskEntries.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, e]) => e);
    this.emit({ type: 'plan.update', turnId, entries });
  }

  private emitToolResult(block: Record<string, unknown>, turnId: number): void {
    const id = String(block.tool_use_id ?? '');
    if (!id) return;
    const isError = block.is_error === true;
    const content = extractResultText(block.content);
    // Task* 工具：已投射计划面板，不出发卡；成功结果合并进清单。
    if (this.taskToolCalls.delete(id)) {
      if (!isError && content) this.applyTaskResult(id, content, turnId);
      else this.pendingTaskCreates.delete(id);
      return;
    }
    this.emit({
      type: 'tool.upsert',
      turnId,
      toolCallId: id,
      status: isError ? 'failed' : 'completed',
      content: content ? { text: content.slice(0, 4000) } : undefined,
    });
  }

  /** control_request(can_use_tool)：权限询问。
   *  优先级：
   *   - yolo / unattended(赛马) → 一律自动放行（防无人值守死锁）；
   *   - ExitPlanMode 且 交互模式(default/plan) → 弹「计划审批」卡（允许=批准并执行）；
   *   - default → 弹普通权限卡；
   *   - plan/auto(交互) → 自动放行（plan 只读工具 / acceptEdits 编辑）。 */
  private handleControlRequest(ev: Record<string, unknown>): void {
    const request = ev.request as Record<string, unknown> | undefined;
    const requestId = String(ev.request_id ?? '');
    if (!request || String(request.subtype ?? '') !== 'can_use_tool') {
      // 其他 server→client 控制请求（目前只知 can_use_tool）— 留账。
      compatAudit.record('claude', 'unknown-event', `control_request:${String(request?.subtype ?? '?')}`, ev);
      return;
    }
    const toolName = String(request.tool_name ?? '');
    const input = request.input;
    const isExitPlan = /^exit_?plan_?mode$/i.test(toolName);
    // 无人值守（赛马）或 yolo：一律自动放行（含计划审批）。
    if (this.mode === 'yolo' || this.opts.unattended) {
      this.respondPermission(requestId, { behavior: 'allow', updatedInput: input });
      return;
    }
    // ExitPlanMode 在交互模式（default/plan）下 = 计划审批门：弹专门卡让用户
    // 拍板后才退出 plan 模式执行（允许=批准，拒绝=继续停在 plan）。
    if (isExitPlan && (this.mode === 'default' || this.mode === 'plan')) {
      this.surfacePermission(requestId, toolName, input, L('批准计划并开始执行？', 'Approve the plan and start executing?'));
      return;
    }
    // 非 default（即 plan/auto交互）且非 ExitPlanMode：自动放行
    // （plan 只读工具无写入风险 / acceptEdits 编辑自动接受）。
    if (this.mode !== 'default') {
      this.respondPermission(requestId, { behavior: 'allow', updatedInput: input });
      return;
    }
    // default 交互：弹普通权限卡。
    this.surfacePermission(requestId, toolName, input, L(`请求使用工具：${toolName}`, `Requesting tool: ${toolName}`));
  }

  /** 推一条 permission.request 并挂起等用户裁决。 */
  private surfacePermission(requestId: string, toolName: string, input: unknown, title: string): void {
    const uiId = randomUUID();
    this.pendingPermissions.set(uiId, {
      resolve: (decision) => this.respondPermission(requestId, decision),
      toolName,
      input,
    });
    const options: PermissionOptionView[] = [
      { optionId: 'allow_once', name: L('允许', 'Allow'), kind: 'allow_once' },
      { optionId: 'reject_once', name: L('拒绝', 'Reject'), kind: 'reject_once' },
    ];
    this.emit({
      type: 'permission.request',
      turnId: this.turnId,
      requestId: uiId,
      isQuestion: false,
      title,
      options,
    });
    this.emit({ type: 'session.status', status: 'awaiting' });
  }

  private respondPermission(requestId: string, decision: { behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }): void {
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: decision },
    });
  }

  private handleResult(ev: Record<string, unknown>): void {
    this.captureSession(ev.session_id);
    // 内部静默命令（/effort 等）的 result：兼现其等待，不当真回合收尾（不发 turn.ended）。
    if (this.internalCommandDone) {
      this.internalCommandDone();
      return;
    }
    const turnId = this.turnId;
    const isError = ev.is_error === true;
    const subtype = String(ev.subtype ?? '');
    if (isError) {
      const msg = String(ev.result ?? ev.error ?? subtype ?? L('运行失败', 'Run failed'));
      // interrupt 产生的 error_during_execution 不当真错报（用户主动中断）。
      if (subtype !== 'error_during_execution') {
        this.emit({ type: 'error', turnId, source: classifyResultError(msg), message: msg });
      }
    }
    const u = (ev.usage ?? {}) as Record<string, unknown>;
    // Anthropic 的 input_tokens 不含缓存（cache_read/cache_creation 单列），归一成
    // codex 语义：inputTokens = 总输入（含缓存），cachedInputTokens 为其子集。
    const cacheRead = num(u.cache_read_input_tokens) ?? 0;
    const totalInput = (num(u.input_tokens) ?? 0) + cacheRead + (num(u.cache_creation_input_tokens) ?? 0);
    const output = num(u.output_tokens) ?? 0;
    const usage: UsageInfo = {
      inputTokens: totalInput || undefined,
      outputTokens: num(u.output_tokens),
      cachedInputTokens: cacheRead || undefined,
      totalTokens: totalInput + output > 0 ? totalInput + output : undefined,
    };
    // contextWindow 来自 result.modelUsage（2.1.x 实测携带）；缺失时沿用上次的值。
    // 没有它 size=0 会让应用层自动压缩判定（used/size）与 ContextRing 永远失效。
    const modelUsage = (ev.modelUsage ?? {}) as Record<string, Record<string, unknown> | undefined>;
    for (const mu of Object.values(modelUsage)) {
      const cw = num(mu?.contextWindow);
      if (cw && cw > 0) this.lastContextSize = cw;
    }
    // compact 失败（"Not enough messages to compact."）的 result usage 全 0：
    // 发 used=0 会把 ContextRing 瞬显成空窗，跳过这次更新保持旧读数。
    const usageAllZero = totalInput + output === 0;
    if (!usageAllZero && (typeof ev.total_cost_usd === 'number' || this.lastContextSize > 0)) {
      // 成本走 usage.update（与其他引擎口径一致；ContextRing/用量统计用）。
      // used 用最后一次 assistant 消息的单次 API usage；无 assistant usage
      // 时才退回 result 累计值（仅兜底，可能被工具循环放大）。
      this.emit({
        type: 'usage.update',
        used: this.lastApiInputTokens > 0 ? this.lastApiInputTokens : (usage.inputTokens ?? 0),
        size: this.lastContextSize,
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
      });
    }
    this.lastUsage = usage;
    const durationMs = num(ev.duration_ms);
    const stopReason = isError
      ? subtype === 'error_during_execution'
        ? 'interrupted'
        : 'error'
      : this.compactPromptActive
        ? 'background'
        : 'end_turn';
    this.finishTurn(stopReason, undefined, usage, durationMs);
  }

  /** 统一的回合收尾：推 turn.ended 并兼现 turnDone。 */
  private finishTurn(stopReason: string, startedAt?: number, usage?: UsageInfo, durationMs?: number): void {
    if (!this.promptActive && !this.turnDone) return;
    const finalUsage = usage ?? this.lastUsage ?? (this.turnOutputChars ? { outputTokens: estimateTokens(this.turnOutputChars), approx: true } : undefined);
    this.emit({
      type: 'turn.ended',
      turnId: this.turnId,
      stopReason,
      // compact 回合收尾时该标记仍为 true（本函数末尾才重置）→ 渲染层据此补发队列。
      backgroundKind: this.compactPromptActive ? 'compact' : undefined,
      usage: finalUsage,
      durationMs: durationMs ?? (startedAt ? Date.now() - startedAt : undefined),
    });
    this.compactPromptActive = false;
    if (this.turnDone) this.turnDone();
  }

  /** 首次拿到 session_id 时回填 engineSessionId（供续接与持久化）。 */
  private captureSession(raw: unknown): void {
    const sid = typeof raw === 'string' && raw ? raw : undefined;
    if (sid && sid !== this.sessionId) {
      this.sessionId = sid;
      this.emit({ type: 'session.meta', patch: { engineSessionId: sid } });
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.child || this.disposed) return;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      /* child gone — exit 事件会收尾回合 */
    }
  }
}

// ------------------------------------------------------------------ utils

/** Claude 工具名 → 统一 toolKind（与 kimi/codex 同口径，供渲染层折叠分组）。 */
function mapToolKind(name: string): string {
  const t = name.toLowerCase();
  if (t === 'bash' || t.includes('command') || t.includes('shell') || t.includes('exec')) return 'execute';
  if (t === 'edit' || t === 'write' || t === 'notebookedit' || t.includes('edit') || t.includes('write')) return 'edit';
  if (t === 'read' || t === 'notebookread' || t.includes('read')) return 'read';
  if (t === 'grep' || t === 'glob' || t.includes('search') || t.includes('find')) return 'search';
  if (t === 'webfetch' || t === 'websearch' || t.includes('web') || t.includes('fetch')) return 'fetch';
  if (t === 'task' || t.includes('agent')) return 'other';
  return 'other';
}

/** 从工具参数提取展示主体（命令行 / 文件路径 / 查询词）。 */
function toolSubject(name: string, input: Record<string, unknown>): string | undefined {
  const kind = mapToolKind(name);
  if (kind === 'execute') return str(input.command) ?? str(input.cmd);
  const known = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path) ?? str(input.pattern) ?? str(input.query) ?? str(input.url);
  if (known) return known;
  return undefined;
}

/** 工具参数 → 展示内容（edit 类提取 diff，bash 提取命令）。 */
function toolInputContent(name: string, input: Record<string, unknown>): ToolCallContent | undefined {
  const out: ToolCallContent = {};
  const kind = mapToolKind(name);
  if (kind === 'edit') {
    const path = str(input.file_path) ?? str(input.path) ?? '';
    const oldText = str(input.old_string);
    const newText = str(input.new_string) ?? str(input.content);
    if (path && (oldText != null || newText != null)) {
      out.diff = { path, oldText: oldText ?? undefined, newText: newText ?? undefined };
    }
  } else if (kind === 'execute') {
    const cmd = str(input.command) ?? str(input.cmd);
    if (cmd) out.text = cmd;
  }
  return out.text || out.diff ? out : undefined;
}

/** tool_result content 可能是字符串或块数组 — 抽出文本。 */
function extractResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content as Array<Record<string, unknown>>) {
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    }
    return parts.length ? parts.join('\n') : undefined;
  }
  return undefined;
}

/** ExitPlanMode 的 plan 文本 → 按行拆成 PlanEntry（markdown 列表/普通行）。 */
function parsePlanEntries(plan: string): PlanEntry[] {
  const lines = plan.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const entries: PlanEntry[] = [];
  for (const line of lines) {
    const m = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (m && m[1]) entries.push({ content: m[1], status: 'pending' });
  }
  // 无列表结构时整段作一条。
  if (!entries.length && plan.trim()) entries.push({ content: plan.trim().slice(0, 200), status: 'pending' });
  return entries;
}

/** TodoWrite status → PlanEntry status。 */
function normalizeTodoStatus(s: string): PlanEntry['status'] {
  if (s === 'in_progress') return 'in_progress';
  if (s === 'completed') return 'completed';
  return 'pending';
}

function classifyExit(tail: string): 'client' | 'engine' | 'provider' {
  const m = tail.toLowerCase();
  if (m.includes('unauthenticated') || m.includes('401') || m.includes('403') || m.includes('login')) return 'provider';
  if (m.includes('quota') || m.includes('rate limit') || m.includes('429') || m.includes('overloaded')) return 'provider';
  if (m.includes('spawn') || m.includes('enoent')) return 'client';
  return 'engine';
}

function classifyResultError(msg: string): 'client' | 'engine' | 'provider' {
  const m = msg.toLowerCase();
  if (m.includes('auth') || m.includes('401') || m.includes('403') || m.includes('login') || m.includes('credit')) return 'provider';
  if (m.includes('quota') || m.includes('rate') || m.includes('429') || m.includes('overloaded') || m.includes('usage limit')) return 'provider';
  return 'engine';
}

/** 粗粒度 token 估算（混合中英文≈ 1 token / 1.7 字符）— 仅无真实 usage 时兑底。 */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 1.7));
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
