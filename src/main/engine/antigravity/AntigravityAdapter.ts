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

import type { EngineEvent, PermissionMode, ToolCallContent, UsageInfo } from '@shared/types';
import type { EngineAdapter, EngineEventSink } from '../EngineAdapter';
import { L } from '../../i18n';
import { killEngineTree } from '../killTree';
import { queryActiveAgyQuota } from './agyAccounts';
import { resolveAgyCli } from './resolveAntigravity';

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

export interface AntigravityAdapterOptions {
  cwd: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  /** 续接：上一次的 conversation_id（= engineSessionId）。 */
  resumeSessionId?: string;
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
  private stdoutBuf = '';
  private workDirInjected = false;
  private readonly stderrTail: string[] = [];

  constructor(
    private readonly opts: AntigravityAdapterOptions,
    private readonly emit: EngineEventSink,
  ) {
    this.conversationId = opts.resumeSessionId ?? '';
    this.modelId = opts.modelId || DEFAULT_MODEL;
    this.mode = opts.permissionMode ?? 'default';
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ engineSessionId: string }> {
    this.emit({ type: 'session.status', status: 'starting' });
    // headless 无常驻会话可开：仅确认 CLI 可解析，随即 idle。cid 在首个
    // prompt 后回填。engineSessionId 先返回已知 cid（续接）或空串。
    // 发出可选模型列表（headless 无运行时 model 事件，静态下发）— 否则 composer 模型选择器不显示。
    this.emit({ type: 'models.update', current: this.modelId, available: AGY_MODEL_SLUGS });
    // 同步当前权限模式（否则 UI 回落显示 default，与实际默认 auto 不符）。
    this.emit({ type: 'modes.update', current: this.mode, available: ['default', 'plan', 'auto', 'yolo'] });
    this.emit({ type: 'session.status', status: 'idle' });
    return { engineSessionId: this.conversationId };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.child) killEngineTree(this.child);
    this.child = undefined;
  }

  // ------------------------------------------------------------- actions

  async prompt(text: string, attachments?: string[], effort?: string): Promise<void> {
    if (this.disposed) throw new Error('antigravity session disposed');
    const turnId = ++this.turnId;
    this.promptActive = true;
    this.stdoutBuf = '';
    this.emit({ type: 'turn.started', turnId });
    this.emit({ type: 'session.status', status: 'running' });
    const started = Date.now();

    // 首个 prompt 注入工作目录上下文（headless agent 不把进程 cwd 当工作区自述，
    // 不告知就会回“未设置工作区”）；续接会话已有历史不重复注。
    let promptText = text;
    if (this.opts.workDir && !this.workDirInjected && !this.conversationId) {
      promptText = `【当前工作目录（项目根）：${this.opts.workDir}】\n你可用工具直接读写该目录下的文件；分析项目时先列该目录。\n\n${promptText}`;
      this.workDirInjected = true;
    }
    if (attachments?.length) promptText += `\n\n附件路径：\n${attachments.join('\n')}`;
    const args = this.buildArgs(promptText, effort);
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
      const cstdout = child.stdout!;
      const cstderr = child.stderr!;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.promptActive = false;
        this.child = undefined;
        if (!this.disposed) this.emit({ type: 'session.status', status: 'idle' });
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
        this.emit({ type: 'error', turnId, source: 'client', message: `${L('无法启动 agy CLI', 'Failed to launch the agy CLI')}: ${err.message}` });
        this.emit({ type: 'turn.ended', turnId, stopReason: 'error' });
        finish();
      });
      child.on('close', (code) => {
        // 收尾残留行。
        this.flushStdout(turnId);
        if (code !== 0 && this.promptActive) {
          // 非 0 退出但没收到 result（如认证失败/额度耗尽）→ 补一条错误 + turn.ended。
          const tail = this.stderrTail.slice(-8).join('\n');
          this.emit({
            type: 'error',
            turnId,
            source: classifyError(tail),
            message: `${L('agy 退出', 'agy exited with')} code=${code}\n${tail}`.trim(),
          });
          this.emit({ type: 'turn.ended', turnId, stopReason: 'error', durationMs: Date.now() - started });
        }
        finish();
      });
      // 保存 started 供 result 计算（闭包内引用）。
      this.turnStartedAt = started;
    });
  }

  private turnStartedAt = 0;

  private buildArgs(promptText: string, effort?: string): string[] {
    const args = ['-p', promptText, '--output-format', 'stream-json', '--print-timeout', PRINT_TIMEOUT];
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
        return;
    }
  }

  private handleStep(step: Record<string, unknown> | undefined, turnId: number): void {
    if (!step) return;
    this.captureCid(step.conversation_id);
    const type = String(step.step_type ?? '');
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
        return; // user_input / checkpoint / 未知 → 无 UI 影响
    }
  }

  private handleResult(result: Record<string, unknown> | undefined, turnId: number): void {
    if (!result) return;
    this.captureCid(result.conversation_id);
    const status = String(result.status ?? '');
    if (status === 'ERROR' || status === 'INVALID') {
      const msg = str(result.error) || L('运行失败', 'Run failed');
      this.emit({ type: 'error', turnId, source: classifyError(msg), message: msg });
      // agy 把模型侧一切失败（429 额度耗尽/401/过载…）统一包装成
      // “Agent execution terminated due to error.”，真实原因只写 cli.log 不进
      // stdout/stderr（2026-07 实测）→ 命中该泛化文案时异步查活动账号额度核实，
      // 坐实归零才补报「额度耗尽」，避免把过载/网络错误误判成额度。
      if (/agent execution terminated/i.test(msg)) void this.reportQuotaExhaustion(turnId);
    }
    const u = (result.usage ?? {}) as Record<string, unknown>;
    const usage: UsageInfo = {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      totalTokens: num(u.total_tokens),
      cachedInputTokens: num(u.cache_read_tokens),
    };
    const durationMs = num(result.duration_seconds) != null ? Math.round(num(result.duration_seconds)! * 1000) : Date.now() - this.turnStartedAt;
    const stopReason = status === 'SUCCESS' ? 'end_turn' : status.toLowerCase() || 'end_turn';
    this.emit({ type: 'turn.ended', turnId, stopReason, usage, durationMs });
    // result 是权威终态：close 的非 0 兜底只为「没收到 result 就退了」服务，
    // 这里标记已收尾，否则 ERROR result + exit 1 会再补一条冗余的「agy 退出 code=1」
    // 和重复的 turn.ended。
    this.promptActive = false;
  }

  /** ERROR result 文案泛化时的额度核实：查当前活动账号（force 绕缓存），
   *  任一时间窗额度归零则补报 provider 级错误（带重置时间，供用户决策切号）。
   *  尽力而为 — 查询失败/未导入/未耗尽都保持沉默，原错误已展示。 */
  private async reportQuotaExhaustion(turnId: number): Promise<void> {
    try {
      const q = await queryActiveAgyQuota(true);
      if (this.disposed || !q.ok) return;
      const exhausted = q.groups.filter((g) => g.utilization >= 99.95);
      if (exhausted.length === 0) return;
      const windows = exhausted
        .map((g) => L(`${g.group}额度${g.resetsInSeconds != null ? `（${fmtReset(g.resetsInSeconds)}后重置）` : ''}`, `${g.group} quota${g.resetsInSeconds != null ? ` (resets in ${fmtReset(g.resetsInSeconds)})` : ''}`))
        .join(L('、', ', '));
      this.emit({
        type: 'error',
        turnId,
        source: 'provider',
        message: L(
          `当前账号${q.email ? ` ${q.email}` : ''}的 ${windows} 已耗尽，请切换账号后重试。`,
          `The ${windows} of the current account${q.email ? ` ${q.email}` : ''} is exhausted — switch accounts and retry.`,
        ),
        // 结构化标记：渲染层据此触发自动切号/兜底弹窗（不靠文案字符串匹配）。
        quotaExhausted: true,
      });
    } catch {
      /* 额度核实失败不打扰用户 */
    }
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
