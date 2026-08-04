/**
 * AntigravityAdapter — drives the `agy` CLI in headless mode
 * (`agy -p <prompt> --output-format stream-json`) and translates its
 * NDJSON event stream (init → step_update* → result) into engine-agnostic
 * `EngineEvent`s.
 *
 * 与 ACP 引擎（kimi/omp）不同：agy headless 是「每回合一个进程」模型，
 * 无常驻会话。会话连续性靠 conversation_id：首个 prompt 从 result/init
 * 拿到 cid 存下并回填 engineSessionId；后续 prompt 带 `--conversation <cid>`
 * 续接（跨账号本地重放，见 docs/antigravity-integration.md §3.8）。
 *
 * 认证真源是 Windows keyring 条目 gemini:antigravity（每次调用实时读，
 * 无缓存）；账号切换由 agyAccounts.switchAgyAccount 覆写 keyring 完成，
 * 本适配器无需感知——下一个 prompt 进程自然以新账号启动。
 *
 * 事件形态见 docs/antigravity cli v1.1.8/headless-mode.md（用凭据实测校对）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { EngineEvent, GoalControlAction, GoalInfo, PermissionMode, ToolCallContent, UsageInfo } from '@shared/types';
import type { EngineAdapter, EngineEventSink } from '../EngineAdapter';
import { L } from '../../i18n';
import { compatAudit } from '../compatAudit';
import { killEngineTree } from '../killTree';
import { log } from '../../log/logger';
import { queryActiveAgyQuota } from './agyAccounts';
import { agySupportsGoalCommand, resolveAgyCli } from './resolveAntigravity';

/** 一张开着的 agy 子代理卡 — headless 不回传子代理内部活动流（subagent_info
 *  只有 log_uri 指针），卡面只能表达「已派发 / 运行中」，回合结束统一收卡。 */
interface AgySubagentCard {
  toolCallId: string;
  title: string;
  /** 开卡进度行 — 终态 upsert 必须原样保留，否则渲染层 isTaskTool 失配、卡片退化成普通工具行。 */
  line: string;
  /** 派发时的任务描述（tool_info.parameters 提取，展开卡可见；过长已截断）。 */
  task?: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
/** 可选模型 slug（取自 `agy models` 实测，见 headless-mode.md）——启动时发给渲染层
 *  填充 composer 模型选择器。adapter 接受任意合法 slug。 */
export const AGY_MODEL_SLUGS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gemini-3.1-pro-high',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.5-flash-medium',
];
/** 长任务上限（headless 默认 5m，编码任务放宽）。 */
const PRINT_TIMEOUT = '30m';
/** goal 回合上限：goal 语义是「长跑任务（如过夜）」，进程内由 agy 的
 *  goal_stop_hook 强制续跑直到模型自报完成，超时放宽到 12h
 *  （用户可随时 pause/clear 杀进程）。 */
const GOAL_PRINT_TIMEOUT = '12h';

export interface AntigravityAdapterOptions {
  cwd: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  /** 续接：上一次的 conversation_id（= engineSessionId）。 */
  resumeSessionId?: string;
  quietResumeFallback?: boolean;
  cliPath?: string;
  /** 工作态会话的项目根；非空则首个 prompt 注入工作目录上下文（headless agent 不自述工作区）。 */
  workDir?: string;
}

export class AntigravityAdapter implements EngineAdapter {
  private child: ChildProcess | undefined;
  private conversationId: string;
  private modelId: string;
  private mode: PermissionMode;
  private turnId = 0;
  private disposed = false;
  private promptActive = false;
  /** 本回合是否已收到 result 事件 —— close 处理器据此判断是否需要补发
   *  兜底 turn.ended。用 promptActive 判断会被异步额度 probe 窗口期误判
   *  （result 已收但 probe 未完，promptActive 仍 true → 重复发 turn.ended，
   *  且该重复不带 quotaExhausted，抢在 probe 之前触发编排器 → 盲目重试
   *  耗尽账号）。 */
  private gotResult = false;
  private stdoutBuf = '';
  private workDirInjected = false;
  private readonly stderrTail: string[] = [];
  /** 开着的子代理卡（key = 子代理 conversation_id，或步序兜底）。 */
  private readonly subagentCards = new Map<string, AgySubagentCard>();
  /** 当前 goal 快照（cyberslots 侧真源 —— headless stream-json 没有 goal
   *  事件，agy 的 GoalState 存在会话里不外发）。null = 无 goal。 */
  private goal: GoalInfo | null = null;
  /** goal 计时：暂停不清零 —— goalAccumMs 存已累计的 active 时长，
   *  goalResumedAt 是本轮 active 起点（status≠active 时为 0）。 */
  private goalAccumMs = 0;
  private goalResumedAt = 0;

  constructor(
    private readonly opts: AntigravityAdapterOptions,
    private readonly emit: EngineEventSink,
  ) {
    this.conversationId = opts.resumeSessionId ?? '';
    this.modelId = opts.modelId || DEFAULT_MODEL;
    this.mode = opts.permissionMode ?? 'default';
    // goal 依赖 print 模式的斜杠命令展开（agy ≥1.1.9，见 resolveAntigravity
    // 的版本门注释）。旧版摘掉 goal 方法（实例属性遮蔽原型方法），
    // SessionManager 的能力快照（!!adapter.setGoal）自动为 false，
    // UI 走「不支持」提示路径，不误报能力。
    if (!agySupportsGoalCommand(opts.cliPath)) {
      this.setGoal = undefined as unknown as AntigravityAdapter['setGoal'];
      this.controlGoal = undefined as unknown as AntigravityAdapter['controlGoal'];
    }
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ engineSessionId: string }> {
    this.emit({ type: 'session.status', status: 'starting' });
    // agy history lives in a local per-CLI sqlite (~/.gemini/antigravity-cli/
    // conversations/<cid>.db -- docs/antigravity-integration.md section 3.8).
    // When the db file is gone (cache cleared), --conversation <cid> cannot
    // restore anything: drop the stale id up front so the session starts
    // fresh instead of failing on the first prompt.
    if (this.conversationId && !conversationDbExists(this.conversationId)) {
      const stale = this.conversationId;
      log.warn('engine.antigravity', 'conversation db missing, falling back to a fresh session', { staleSessionId: stale });
      this.conversationId = '';
      if (!this.opts.quietResumeFallback) {
        this.emit({ type: 'error', source: 'engine', message: `${L('会话恢复失败，已新建会话继续（历史上下文不在引擎侧）', 'Session resume failed — started a new session (history context is not engine-side)')}: ${stale}` });
      }
    }
    // headless 无常驻会话可开：仅确认 CLI 可解析，随即 idle。cid 在首个
    // prompt 后回填。engineSessionId 先返回已知 cid（续接）或空串。
    // 发出可选模型列表（headless 无运行时 model 事件，静态下发）— 否则 composer 模型选择器不显示。
    this.emit({ type: 'models.update', current: this.modelId, available: AGY_MODEL_SLUGS });
    // 同步当前权限模式（否则 UI 回落显示 default，与实际默认 auto 不符）。
    this.emit({ type: 'modes.update', current: this.mode, available: ['default', 'plan', 'auto', 'yolo'] });
    // goal 快照是 adapter 内存态（agy 侧 GoalState 随进程消亡，无回放面）——
    // 重启/重建 adapter 时显式清空，冲掉渲染层可能残留的旧 GoalBar。
    this.emitGoalUpdate();
    this.emit({ type: 'session.status', status: 'idle' });
    return { engineSessionId: this.conversationId };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.child) killEngineTree(this.child);
    this.child = undefined;
  }

  /** 回合收尾唯一放行点：关并发闸门（promptActive=false）+ 回 idle。
   *  两个到达路径：close 的 finish（仅 result 未到时）与 handleResult 的
   *  .then()（发完唯一的 turn.ended 后）。防重入。 */
  private settleTurn(): void {
    if (!this.promptActive) return;
    this.promptActive = false;
    if (!this.disposed) this.emit({ type: 'session.status', status: 'idle' });
  }

  // ------------------------------------------------------------- actions

  async prompt(text: string, attachments?: string[], effort?: string, printTimeout = PRINT_TIMEOUT): Promise<void> {
    if (this.disposed) throw new Error('antigravity session disposed');
    // 并发重入总闸：上一回合未收尾期间（子进程在跑；或 result 已收但额度
    // probe 未完 —— 收尾放行点在 handleResult 的 .then()，probe 窗口内
    // promptActive 保持 true）再发新 prompt 会覆盖 this.child、自增
    // turnId 起 rogue 回合 —— 编排器仍挂着的 onTurnEnded 回调会误收新
    // 回合的 turn.ended，把「继续」那段 transcript 当成交卷产物落盘 →
    // 假冲线；且 rogue 回合同样撞额度，与原回合 probe 完成后的 quota
    // 错误并发触发切号被互斥/熔断挡掉 → 没自动切号。
    // 用 superseded 语义：编排器消费方（runRacerTurn/runTurnWithRetry/
    // safe）一律静默吞掉，不弹横幅；渲染层自动补发（切号/重试「继续」）
    // 经 catchAutoResume 吞掉，原回合 probe 收尾后由正当路径接回。
    if (this.promptActive) {
      log.warn('engine.antigravity', 'prompt rejected: previous turn still active (superseded)', {
        turnId: this.turnId,
        childAlive: !!this.child,
      });
      throw new Error(L('agy 上一回合尚未收尾，拒绝并发 prompt [superseded]', 'agy previous turn still active — concurrent prompt rejected [superseded]'));
    }
    const turnId = ++this.turnId;
    this.promptActive = true;
    this.gotResult = false;
    this.stdoutBuf = '';
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'session.status', status: 'running' });
    const started = Date.now();

    // 首个 prompt 注入工作目录上下文（headless agent 不把进程 cwd 当工作区自述，
    // 不告知就会回“未设置工作区”）；续接会话已有历史不重复注。
    let promptText = text;
    if (this.opts.workDir && !this.workDirInjected && !this.conversationId) {
      const ctx = `【当前工作目录（项目根）：${this.opts.workDir}】\n你可用工具直接读写该目录下的文件；分析项目时先列该目录。`;
      // 斜杠命令（如 /goal）必须占据 prompt 开头才会被 CLI 展开（1.1.9 起
      // print 模式支持）——命令文本把目录上下文尾挂，成为命令参数的一部分。
      promptText = promptText.startsWith('/') ? `${promptText}\n\n${ctx}` : `${ctx}\n\n${promptText}`;
      this.workDirInjected = true;
    }
    if (attachments?.length) promptText += `\n\n附件路径：\n${attachments.join('\n')}`;
    const args = this.buildArgs(promptText, effort, printTimeout);
    const spec = resolveAgyCli(args, this.opts.cliPath);

    await new Promise<void>((resolve) => {
      const child = spawn(spec.command, spec.args, {
        cwd: this.opts.cwd,
        shell: spec.shell ?? false,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      log.debug('engine.antigravity', 'headless turn spawned', {
        command: spec.command,
        pid: child.pid,
        turnId,
        resumed: !!this.conversationId,
      });
      const cstdout = child.stdout!;
      const cstderr = child.stderr!;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.child = undefined;
        // result 未到（崩退/认证失败/spawn 失败）→ 立即收尾放行。result 已收
        // （额度 probe 可能在途）→ 放行交给 handleResult 的 .then()：它发完
        // 唯一的 turn.ended 才 settleTurn。否则 close 远早于 probe 完成，
        // probe 窗口期并发闸门形同虚设，旧 probe 的 .then() 还会踩掉新回合
        // 的闸门、用旧 turnId 误发事件。
        if (!this.gotResult) this.settleTurn();
        resolve();
      };

      cstdout.setEncoding('utf8');
      cstdout.on('data', (d: string) => this.onStdout(d, turnId));
      cstderr.setEncoding('utf8');
      cstderr.on('data', (d: string) => {
        for (const line of d.split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > 60) this.stderrTail.shift();
        }
      });
      child.on('error', (err) => {
        log.error('engine.antigravity', 'agy spawn failed', { command: spec.command, turnId }, err);
        this.emit({ type: 'error', turnId, source: 'client', message: `${L('无法启动 agy CLI', 'Failed to launch the agy CLI')}: ${err.message}` });
        // goal 回合 spawn 失败（prompt 的 Promise 恒 resolve，launchGoalTurn 的
        // catch 到不了这里）→ 同样落 blocked。
        if (this.goal?.status === 'active') {
          this.stopGoalClock();
          this.goal = { ...this.goal, status: 'blocked', timeUsedSeconds: this.goalTimeSeconds() };
          this.emitGoalUpdate();
        }
        this.emit({ type: 'turn.ended', turnId, stopReason: 'error' });
        finish();
      });
      child.on('close', (code) => {
        // 收尾残留行。
        this.flushStdout(turnId);
        // 仅当【没收到 result】才补发兜底 turn.ended。用 promptActive 判断会被
        // 异步额度 probe 窗口期误判（result 已收但 probe 未完，promptActive 仍
        // true → 重复发 turn.ended，且该重复不带 quotaExhausted，抢在 probe
        // 之前触发编排器 → 盲目重试耗尽账号）。gotResult 精确反映 result 是否
        // 已到：result 到了（无论 probe 是否完）都由 handleResult 的 .then()
        // 负责发唯一的 turn.ended（带 quotaExhausted），close 不再补发。
        // 已 settled（'error' 事件先到并 finish 过）则不重复发 turn.ended。
        if (!settled && code !== 0 && !this.gotResult) {
          // 非 0 退出且 result 未到（子进程崩退/认证失败 stderr 直退）→ 补一条错误 + turn.ended。
          const tail = this.stderrTail.slice(-8).join('\n');
          log.warn('engine.antigravity', 'agy turn exited non-zero', { code, turnId, stderrTail: tail.replace(/\n/g, ' | ') });
          this.emit({
            type: 'error',
            turnId,
            source: classifyError(tail),
            message: `${L('agy 退出', 'agy exited with')} code=${code}\n${tail}`.trim(),
          });
          this.settleSubagents(turnId, false);
          // goal 回合崩退（无 result）→ GoalBar 落 blocked，不能永远「进行中」。
          if (this.goal?.status === 'active') {
            this.stopGoalClock();
            this.goal = { ...this.goal, status: 'blocked', timeUsedSeconds: this.goalTimeSeconds() };
            this.emitGoalUpdate();
          }
          this.emit({ type: 'turn.ended', turnId, stopReason: 'error', durationMs: Date.now() - started });
        }
        finish();
      });
      // 保存 started 供 result 计算（闭包内引用）。
      this.turnStartedAt = started;
    });
  }

  private turnStartedAt = 0;

  private buildArgs(promptText: string, effort?: string, printTimeout = PRINT_TIMEOUT): string[] {
    const args = ['-p', promptText, '--output-format', 'stream-json', '--print-timeout', printTimeout];
    if (this.modelId) args.push('--model', this.modelId);
    // effort 仅对档位独立的 claude 系有效；gemini flash slug 已含档位（坑①）、
    // claude …-thinking slug 同理档位烧死（实测 --effort 直报 not supported），
    // 两类都不能再带 --effort，否则 agy 拒启、回合秒死。
    if (effort && /^claude/i.test(this.modelId) && !/thinking/i.test(this.modelId)) args.push('--effort', effort);
    if (this.conversationId) args.push('--conversation', this.conversationId);
    // 赛马全自动（auto/yolo）免交互批准；default/plan 尊重 settings（软拒绝）。
    if (this.mode === 'yolo' || this.mode === 'auto') args.push('--dangerously-skip-permissions');
    return args;
  }

  async cancel(): Promise<void> {
    if (this.child) {
      killEngineTree(this.child);
      this.child = undefined;
    }
  }

  async setModel(modelId: string): Promise<void> {
    this.modelId = modelId;
    this.emit({ type: 'models.update', current: modelId, available: AGY_MODEL_SLUGS });
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    this.emit({ type: 'modes.update', current: mode, available: ['default', 'plan', 'auto', 'yolo'] });
  }

  answerPermission(): void {
    // headless 无交互式权限请求（由策略/flag 决定），无需处理。
  }

  // ------------------------------------------------------------------ goal

  /** goal 模式：借 agy 的 /goal 斜杠命令（1.1.9 起 print 模式展开）。发出后
   *  由 agy 进程内的 goal_stop_hook 强制续跑、审计直到模型自报完成 ——
   *  cyberslots 不需要自驱循环，goal 回合就是「一次超长 headless 运行」，
   *  过程事件（text/tool/子代理卡）复用现有解析管线。 */
  async setGoal(objective: string): Promise<void> {
    const text = objective.trim();
    if (!text) throw new Error(L('goal 目标不能为空', 'Goal objective must not be empty'));
    this.launchGoalTurn(text, true);
  }

  /** pause/clear = 杀 goal 回合进程（headless 无进程内暂停面，同用户停止）；
   *  resume = 续接会话重发 /goal（agy 的 GoalState 存于会话，续跑自然接上）。 */
  async controlGoal(action: GoalControlAction): Promise<void> {
    if (!this.goal) return;
    if (action === 'clear') {
      await this.cancel();
      this.goal = null;
      this.goalAccumMs = 0;
      this.goalResumedAt = 0;
      this.emitGoalUpdate();
      return;
    }
    if (action === 'pause') {
      this.stopGoalClock();
      this.goal = { ...this.goal, status: 'paused', timeUsedSeconds: this.goalTimeSeconds() };
      await this.cancel();
      this.emitGoalUpdate();
      return;
    }
    // resume
    this.launchGoalTurn(this.goal.objective, false);
  }

  /** 发 goal 回合（set=新目标 / 续跑）。不 await 整回合 —— goal 运行可达
   *  数小时，prompt 的 Promise 要到进程 close 才 resolve，IPC 不能挂着；
   *  运行期失败走 error/turn.ended 事件流。 */
  private launchGoalTurn(objective: string, fresh: boolean): void {
    if (this.disposed) throw new Error('antigravity session disposed');
    // 预检并发闸门（与 prompt 的 superseded 守卫同语义）：goal 回合运行期
    // 间任何新 prompt（含 resume 重入）都必须显式报错，不能静默排队。
    if (this.promptActive) {
      throw new Error(L('agy 上一回合尚未收尾，拒绝并发 prompt [superseded]', 'agy previous turn still active — concurrent prompt rejected [superseded]'));
    }
    if (fresh || !this.goal) {
      // 替换语义（对齐 codex 的 clear+set）：新目标直接覆盖旧 goal 重新计账。
      this.goal = { objective, status: 'active', tokensUsed: 0, timeUsedSeconds: 0 };
      this.goalAccumMs = 0;
    } else {
      this.goal = { ...this.goal, status: 'active' };
    }
    this.goalResumedAt = Date.now();
    this.emitGoalUpdate();
    void this.prompt(`/goal ${objective}`, undefined, undefined, GOAL_PRINT_TIMEOUT).catch((err) => {
      // 只能捕获 spawn 前的同步失败（prompt 的 Promise 恒 resolve）；运行期
      // 失败由 handleResult/close 的事件路径上报，这里把 GoalBar 落到 blocked。
      log.warn('engine.antigravity', 'goal turn failed to launch', err);
      if (this.goal?.status === 'active' && this.goal.objective === objective) {
        this.stopGoalClock();
        this.goal = { ...this.goal, status: 'blocked', timeUsedSeconds: this.goalTimeSeconds() };
        this.emitGoalUpdate();
      }
    });
  }

  private stopGoalClock(): void {
    this.goalAccumMs += this.goalResumedAt ? Date.now() - this.goalResumedAt : 0;
    this.goalResumedAt = 0;
  }

  private goalTimeSeconds(): number {
    const ms = this.goalAccumMs + (this.goalResumedAt ? Date.now() - this.goalResumedAt : 0);
    return Math.round(ms / 1000);
  }

  private emitGoalUpdate(): void {
    if (this.disposed) return;
    this.emit({ type: 'goal.update', goal: this.goal ? { ...this.goal } : null });
  }

  // ------------------------------------------------------- stream parsing

  private onStdout(chunk: string, turnId: number): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line) this.handleLine(line, turnId);
    }
  }

  private flushStdout(turnId: number): void {
    const line = this.stdoutBuf.trim();
    this.stdoutBuf = '';
    if (line) this.handleLine(line, turnId);
  }

  private handleLine(line: string, turnId: number): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // 非 JSON 行（诊断噪音）忽略
    }
    switch (ev.event) {
      case 'init':
        this.captureCid((ev.init as Record<string, unknown> | undefined)?.conversation_id ?? ev.conversation_id);
        return;
      case 'step_update':
        this.handleStep(ev.step_update as Record<string, unknown> | undefined, turnId);
        return;
      case 'result':
        this.handleResult(ev.result as Record<string, unknown> | undefined, turnId);
        return;
      default:
        // 信封级未知事件 → 兼容审计（kimi/omp 同款留痕；agy 此前没接，
        // 协议漂移不可见 —— 2026-08-03 子代理步静默丢失正是栽在这）。
        compatAudit.record('antigravity', 'unknown-event', `agy:event.${String(ev.event ?? '(missing)')}`, ev);
        return;
    }
  }

  private handleStep(step: Record<string, unknown> | undefined, turnId: number): void {
    if (!step) return;
    this.captureCid(step.conversation_id);
    const type = String(step.step_type ?? '');
    // 子代理步优先于 step_type 分派：invoke 步带 subagent_info 而非 tool_info，
    // step_type 甚至不是 'tool'（2026-08-03 实测落到 default 被静默丢弃，
    // 界面上完全看不到子代理派发）。define_subagent 例外：它是普通工具步
    // （tool_info.output 有信息量），保持工具明细行。
    const isDefine = type === 'tool' && step.tool_name === 'define_subagent';
    if (!isDefine && (step.subagent_info || (type === 'tool' && step.tool_name === 'invoke_subagent'))) {
      this.handleSubagentStep(step, turnId);
      return;
    }
    switch (type) {
      case 'agent_response': {
        const delta = str(step.text_delta);
        if (delta) this.emit({ type: 'text.delta', turnId, text: delta });
        return;
      }
      case 'tool': {
        const info = (step.tool_info ?? {}) as Record<string, unknown>;
        const name = str(step.tool_name) ?? str(info.name);
        const kind = mapToolKind(name);
        // 从 parameters 提取命令行/文件路径充当标题 —— 裸工具名（view_file/
        // run_command）在展开明细里没有信息量，对齐 kimi/codex 的观感
        // （「Read duration.js」而非「Read view_file」）。
        const subject = toolSubject(info, kind);
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: `${turnId}:${String(step.step_index ?? this.turnId)}`,
          title: subject ?? name,
          toolKind: kind,
          toolName: name,
          status: str((info.error as Record<string, unknown>)?.type) ? 'failed' : 'completed',
          content: mapToolContent(info),
          locations: kind === 'read' && subject ? [subject] : undefined,
        });
        return;
      }
      case 'error_message': {
        const msg = str(step.text) ?? str(step.message) ?? describeEmptyError(step);
        this.emit({ type: 'error', turnId, source: 'engine', message: msg });
        return;
      }
      default:
        // user_input / checkpoint 是留档的已知类型（无 UI 影响），其余未知
        // 类型进兼容审计 —— 此前一律静默，子代理步丢了都无迹可查。
        if (type !== 'user_input' && type !== 'checkpoint') {
          compatAudit.record('antigravity', 'unknown-event', `agy:step_type.${type || '(missing)'}`, step);
        }
        return;
    }
  }

  /** 子代理派发步 → kimi 同款任务卡（TaskCard）。agy 是异步委派模型：
   *  define_subagent 定义 → invoke_subagent 派发（立即返回，步 DONE 只是
   *  「派发已受理」而非子代理完成）→ schedule/wait 收结果。headless 不回传
   *  子代理内部活动流，卡片在回合内保持 in_progress，结果由主代理文本转述。 */
  private handleSubagentStep(step: Record<string, unknown>, turnId: number): void {
    const toolErr = (step.tool_info as Record<string, unknown> | undefined)?.error;
    const failed = String(step.step_type ?? '') === 'error_message' || !!toolErr;
    for (const sub of normalizeSubagentInfos(step)) {
      const existing = this.subagentCards.get(sub.key);
      if (!existing) {
        const card: AgySubagentCard = {
          toolCallId: `subagent:${sub.key}`,
          title: sub.title,
          line: L('已派发，子代理后台运行中（headless 不回传过程流）', 'Dispatched — running in background (no inner stream in headless mode)'),
          task: sub.task,
        };
        this.subagentCards.set(sub.key, card);
        const content: ToolCallContent = { progress: { line: card.line } };
        if (card.task) content.text = card.task;
        this.emit({
          type: 'tool.upsert',
          turnId,
          toolCallId: card.toolCallId,
          title: card.title,
          toolName: 'subagent',
          toolKind: 'task',
          status: failed ? 'failed' : 'in_progress',
          content,
        });
        continue;
      }
      if (failed) {
        this.subagentCards.delete(sub.key);
        const content: ToolCallContent = { progress: { line: L('子代理失败', 'Subagent failed') } };
        if (existing.task) content.text = existing.task;
        this.emit({ type: 'tool.upsert', turnId, toolCallId: existing.toolCallId, status: 'failed', content });
      }
      // 同 key 的非失败后续 sighting（如 invoke 步自身的 DONE 重发）忽略——
      // 那只是派发受理回执，不代表子代理跑完。
    }
  }

  /** 回合终了统一收卡：headless 没有子代理终态信号，开着会永远「Delegating…」。 */
  private settleSubagents(turnId: number, ok: boolean): void {
    if (this.subagentCards.size === 0) return;
    const line = ok
      ? L('回合结束，子代理结果由主代理转述', 'Turn ended — subagent results are relayed by the main agent')
      : L('回合异常终止', 'Turn terminated abnormally');
    for (const card of this.subagentCards.values()) {
      const content: ToolCallContent = { progress: { line } };
      if (card.task) content.text = card.task;
      this.emit({
        type: 'tool.upsert',
        turnId,
        toolCallId: card.toolCallId,
        status: ok ? 'completed' : 'failed',
        content,
      });
    }
    this.subagentCards.clear();
  }

  private handleResult(result: Record<string, unknown> | undefined, turnId: number): void {
    if (!result) return;
    this.gotResult = true;
    this.captureCid(result.conversation_id);
    const status = String(result.status ?? '');
    const failed = status === 'ERROR' || status === 'INVALID';
    const msg = failed ? str(result.error) || L('运行失败', 'Run failed') : '';
    // agy 把模型侧一切失败（429 额度耗尽/401/过载…）统一包装成
    // “Agent execution terminated due to error.”，真实原因只写 cli.log 不进
    // stdout/stderr（2026-07 实测）→ 命中该泛化文案时必须在【发 turn.ended
    // 之前】坐实额度：否则赛马编排器先拿到终态、1.5s 后就盲目重发，额度核实
    // 还在半路，重试必撞同一没额度账号。await 核实后把结论随 turn.ended
    // 一起带下去（quotaExhausted），编排器据此不自动重试、改走切号补跑。
    const needsCheck = failed && /agent execution terminated/i.test(msg);
    // needsCheck 的泛化错误延迟到 probe 出结论后在下方 .then() 发（耗尽 →
    // 只发带 quotaExhausted 的额度错误；未耗尽 → 补发本条无标记错误）。
    // 现在就发会让渲染层拿它启动非额度 1.5s 重试，与 probe 后的切号路径
    // 并发打架（rogue「继续」烧在尚未切换的死账号上，切号后的正当接回又
    // 可能被并发闸门拒掉）。非 needsCheck 的失败结论已定，照常即发。
    if (failed && !needsCheck) this.emit({ type: 'error', turnId, source: classifyError(msg), message: msg });
    void (needsCheck ? this.probeQuotaExhaustion(turnId) : Promise.resolve(false)).then((quotaExhausted) => {
      if (this.disposed) return;
      if (turnId !== this.turnId) {
        // 防御（正常路径到不了 —— 并发闸门覆盖整个 probe 窗口）：宁可挂起
        // 旧回合的等待（剔除/重跑可唤醒），也不把旧 turnId 事件误投新回合、
        // 踩掉新回合的闸门。
        log.warn('engine.antigravity', 'stale turn result dropped', { turnId, currentTurnId: this.turnId });
        return;
      }
      if (quotaExhausted) this.emitQuotaError(turnId);
      else if (needsCheck) this.emit({ type: 'error', turnId, source: classifyError(msg), message: msg });
      const u = (result.usage ?? {}) as Record<string, unknown>;
      const usage: UsageInfo = {
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        totalTokens: num(u.total_tokens),
        cachedInputTokens: num(u.cache_read_tokens),
      };
      const durationMs = num(result.duration_seconds) != null ? Math.round(num(result.duration_seconds)! * 1000) : Date.now() - this.turnStartedAt;
      const stopReason = status === 'SUCCESS' ? 'end_turn' : status.toLowerCase() || 'end_turn';
      // goal 回合落幕 → 结算 goal 终态。agy 单进程跑到自报完成才停（SUCCESS），
      // 失败按因由映射（额度→usageLimited，其余→blocked）；pause/clear 已落
      // 的终态不被迟到的 result 翻案。token/时长累计进快照供 GoalBar 直读。
      if (this.goal) {
        this.stopGoalClock();
        const goalStatus = this.goal.status !== 'active'
          ? this.goal.status
          : quotaExhausted
            ? 'usageLimited'
            : status === 'SUCCESS'
              ? 'complete'
              : 'blocked';
        this.goal = {
          ...this.goal,
          status: goalStatus,
          tokensUsed: this.goal.tokensUsed + (usage.totalTokens ?? 0),
          timeUsedSeconds: this.goalTimeSeconds(),
        };
        this.emitGoalUpdate();
        // 对齐 codex：complete 事件透传后本地不保留（渲染层发完成公告并收条）。
        if (goalStatus === 'complete') this.goal = null;
      }
      this.emit({ type: 'turn.ended', turnId, stopReason, usage, durationMs, quotaExhausted });
      // 回合终了统一收子代理卡（headless 无子代理终态信号，不收会永远 Delegating…）。
      this.settleSubagents(turnId, status === 'SUCCESS');
      // result 是权威终态，这里是该路径的回合收尾放行点（close 的 finish 见
      // gotResult 已跳过）：发完唯一的 turn.ended 才关闸门回 idle。close 的
      // 非 0 兜底只为「没收到 result 就退了」服务。
      this.settleTurn();
    });
  }

  /** ERROR 文案泛化时的额度核实（仅探测，不 emit）：查当前活动账号
   *  （force 绕缓存 + ignoreCooling 绕冷却跳过 — 坐实探测必须拿真实数据，
   *  冷却占位会毁掉信号二分），任一时间窗额度归零视为坐实。坐实即把
   *  resetTime/email 暂存随事件下发（渲染层省一次真实 Google 重查）。
   *  尽力而为 —— 查询失败/未导入/未耗尽都返回 false，按普通错误处理。 */
  private async probeQuotaExhaustion(turnId: number): Promise<boolean> {
    try {
      const q = await queryActiveAgyQuota(true, { ignoreCooling: true });
      if (this.disposed || !q.ok) return false;
      const exhausted = q.groups.filter((g) => g.utilization >= 99.95);
      if (exhausted.length === 0) return false;
      this.pendingQuotaEmail = q.email;
      const maxReset = Math.max(...exhausted.map((g) => g.resetsInSeconds ?? 0));
      this.pendingQuotaResetSec = maxReset > 0 ? maxReset : undefined;
      this.pendingQuotaWindows = exhausted
        .map((g) => L(`${g.group}额度${g.resetsInSeconds != null ? `（${fmtReset(g.resetsInSeconds)}后重置）` : ''}`, `${g.group} quota${g.resetsInSeconds != null ? ` (resets in ${fmtReset(g.resetsInSeconds)})` : ''}`))
        .join(L('、', ', '));
      log.info('engine.antigravity', 'quota exhaustion confirmed before turn.ended', { turnId, email: q.email, windows: this.pendingQuotaWindows });
      return true;
    } catch (err) {
      log.warn('engine.antigravity', 'quota probe failed', { turnId }, err);
      return false;
    }
  }

  private pendingQuotaEmail: string | undefined;
  private pendingQuotaWindows = '';
  private pendingQuotaResetSec: number | undefined;

  /** 坐实额度耗尽后补报 provider 级错误（带重置时间，供用户决策切号）；
   *  结构化标记 quotaExhausted 驱动渲染层自动切号/兜底弹窗；
   *  quotaEmail/quotaResetsInSeconds 随事件下发（渲染层免重查）。 */
  private emitQuotaError(turnId: number): void {
    const email = this.pendingQuotaEmail;
    const windows = this.pendingQuotaWindows;
    const resetSec = this.pendingQuotaResetSec;
    this.pendingQuotaEmail = undefined;
    this.pendingQuotaWindows = '';
    this.pendingQuotaResetSec = undefined;
    this.emit({
      type: 'error',
      turnId,
      source: 'provider',
      message: L(
        `当前账号${email ? ` ${email}` : ''}的 ${windows} 已耗尽，请切换账号后重试。`,
        `The ${windows} of the current account${email ? ` ${email}` : ''} is exhausted — switch accounts and retry.`,
      ),
      quotaExhausted: true,
      quotaEmail: email,
      quotaResetsInSeconds: resetSec,
    });
  }

  /** 首次拿到 conversation_id 时回填 engineSessionId（供续接与持久化）。 */
  private captureCid(raw: unknown): void {
    const cid = str(raw);
    if (cid && cid !== this.conversationId) {
      this.conversationId = cid;
      this.emit({ type: 'session.meta', patch: { engineSessionId: cid } });
    }
  }
}

// ------------------------------------------------------------------ utils

/** Antigravity 工具名 → 统一 toolKind。渲染层靠它把连续的同类调用
 *  聚成可折叠组（read/search/fetch → Explored、execute → Ran），
 *  缺省 other 会导致每条工具调用平铺不收束。 */
function mapToolKind(name: string | undefined): string {
  const t = (name ?? '').toLowerCase();
  if (t.includes('command') || t.includes('shell') || t.includes('bash')) return 'execute';
  if (t.includes('write') || t.includes('edit') || t.includes('replace') || t.includes('patch')) return 'edit';
  if (t.includes('web') || t.includes('url') || t.includes('fetch') || t.includes('browser')) return 'fetch';
  if (t.includes('grep') || t.includes('search') || t.includes('find')) return 'search';
  if (t.includes('view') || t.includes('read') || t.includes('list')) return 'read';
  return 'other';
}

/** 从 tool_info.parameters 提取展示主体（命令行 / 文件路径 / 查询词）。
 *  agy 参数字段命名无权威留档 → 已知键优先，兼容大小写变体；都对不上时
 *  兜底扫描任意含路径分隔符的短字符串值（防把整段文本当路径）。 */
function toolSubject(info: Record<string, unknown>, kind: string): string | undefined {
  const params = (info.parameters ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = str(params[k]);
      if (v) return v;
    }
    return undefined;
  };
  if (kind === 'execute') return pick('CommandLine', 'command', 'Command', 'cmd');
  const known = pick(
    'AbsolutePath',
    'absolute_path',
    'TargetFile',
    'target_file',
    'FilePath',
    'file_path',
    'path',
    'Path',
    'SearchDirectory',
    'Query',
    'query',
    'Url',
    'url',
  );
  if (known) return known;
  for (const v of Object.values(params)) {
    if (typeof v === 'string' && v.length > 0 && v.length <= 260 && /[\\/]/.test(v) && !/\s{2,}|\n/.test(v)) return v;
  }
  return undefined;
}

function mapToolContent(info: Record<string, unknown>): ToolCallContent | undefined {
  const out: ToolCallContent = {};
  const output = str(info.output);
  if (output) out.text = output.slice(0, 4000);
  const params = info.parameters as Record<string, unknown> | undefined;
  const cmd = params ? str(params.CommandLine) ?? str(params.command) : undefined;
  if (cmd && !out.text) out.text = cmd;
  const err = info.error as Record<string, unknown> | undefined;
  if (err && str(err.message)) out.text = `${out.text ?? ''}\n[error] ${str(err.message)}`.trim();
  return out.text ? out : undefined;
}

/** step → 子代理列表（开卡用）。两种留档口径防御式兼容：
 *  ① integration 实测：subagent_info 直接是单子代理对象（type_name/role/conversation_id/log_uri）；
 *  ② headless-mode.md：subagent_info.subagents[] 列出每个子代理。
 *  都没有（协议漂移，invoke_subagent 退化成普通 tool 步）时从 tool_info.parameters 兜底。 */
function normalizeSubagentInfos(step: Record<string, unknown>): Array<{ key: string; title: string; task?: string }> {
  const info = step.subagent_info as Record<string, unknown> | undefined;
  const rawList: unknown[] = Array.isArray(info?.subagents) ? (info.subagents as unknown[]) : info ? [info] : [];
  const params = ((step.tool_info as Record<string, unknown> | undefined)?.parameters ?? {}) as Record<string, unknown>;
  const rawTask = str(params.task) ?? str(params.prompt) ?? str(params.description) ?? str(params.instruction) ?? str(params.message);
  const task = rawTask && rawTask.length > 2000 ? `${rawTask.slice(0, 2000)}…` : rawTask;
  const stepIdx = String(step.step_index ?? 'x');
  if (rawList.length === 0) {
    // 无 subagent_info 的漂移形态：以步序为 key 开一张信息不全的卡，胜过静默丢弃。
    const title = str(params.name) ?? str(params.subagent) ?? str(params.agent) ?? L('子代理', 'Subagent');
    return task ? [{ key: `invoke:${stepIdx}`, title, task }] : [{ key: `invoke:${stepIdx}`, title }];
  }
  return rawList.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const key = str(s.conversation_id) ?? `step:${stepIdx}:${i}`;
    const title = str(s.role) ?? str(s.type_name) ?? str(s.name) ?? L('子代理', 'Subagent');
    return task ? { key, title, task } : { key, title };
  });
}

function classifyError(msg: string): 'client' | 'engine' | 'provider' {
  const m = msg.toLowerCase();
  if (m.includes('unauthenticated') || m.includes('permission_denied') || m.includes('401') || m.includes('403'))
    return 'provider';
  if (m.includes('resource_exhausted') || m.includes('quota') || m.includes('429')) return 'provider';
  if (m.includes('spawn') || m.includes('timeout')) return 'client';
  return 'engine';
}

/** error_message 步无 text/message 时的兜底描述：拼 step_index/state + 精简原始 JSON，
 *  比孤立的「模型报告错误」更利于定位（暴露 headless 偶发空错误步到底带了什么字段）。 */
function describeEmptyError(step: Record<string, unknown>): string {
  const meta: string[] = [];
  if (step.step_index != null) meta.push(`step ${String(step.step_index)}`);
  const state = str(step.state);
  if (state) meta.push(state);
  const head = meta.length ? L(`模型报告错误（${meta.join(' · ')}）`, `Model reported an error (${meta.join(' · ')})`) : L('模型报告错误', 'Model reported an error');
  // 序列化原始 step（剔除冗长/无意义字段），截断防刷屏 — 已知为空的 text/message 不重复展示。
  try {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step)) {
      if (k === 'conversation_id' || k === 'text_delta' || k === 'text' || k === 'message') continue;
      rest[k] = v;
    }
    const json = JSON.stringify(rest);
    if (json && json !== '{}') return `${head}\n${json.slice(0, 500)}`;
  } catch {
    /* 序列化异常（循环引用等）忽略 */
  }
  return head;
}

/** 秒 → 「2小时2分」式人话（与 IDE 的 “Resets in 2h7m” 对齐）。 */
function fmtReset(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? L(`${h}小时${m}分`, `${h}h ${m}m`) : L(`${h}小时`, `${h}h`);
  return m > 0 ? L(`${m}分钟`, `${m}m`) : L('不到1分钟', 'under a minute');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ----------------------------------------------------- conversation db probe

/** agy stores conversation history in a local sqlite per conversation; when
 *  the file is absent the id cannot be resumed. Probe failure returns true
 *  (must never nuke a resumable id on a filesystem hiccup). */
function conversationDbExists(cid: string): boolean {
  try {
    return existsSync(join(homedir(), '.gemini', 'antigravity-cli', 'conversations', `${cid}.db`));
  } catch {
    return true;
  }
}
