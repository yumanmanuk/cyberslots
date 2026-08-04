/**
 * CyberSlots 日志系统 — 主进程核心。
 *
 * 设计约定：
 * - 结构化 JSONL（每行一条记录），按天切分：
 *     userData/logs/main-YYYY-MM-DD.jsonl      主进程
 *     userData/logs/renderer-YYYY-MM-DD.jsonl  渲染进程（经 IPC 转发，同格式）
 *     userData/logs/compat-audit.jsonl         引擎兼容性审计（独立通道，不动）
 * - 日志边界：引擎 CLI 自己落的日志归引擎（不进本系统）；本系统只记
 *   「本程序侧」行为 —— 生命周期、spawn/exit、协议异常摘要、持久化失败、
 *   关键用户操作。引擎 stdout 全文不灌入（量大且属引擎内容），仅在
 *   意外退出时摘录 stderr 尾部供排障。
 * - 级别：debug（默认不落盘，CS_LOG_LEVEL=debug 开启）/ info / warn / error。
 * - 同步落盘（appendFileSync）：崩溃前不丢日志优先于极致性能；
 *   调用侧务必只记摘要、不记高频大数据（text.delta 等事件流禁止入日志）。
 * - 保留期 RETENTION_DAYS 天，启动时清理过期分片。
 * - 脱敏：data 中 key/token/secret/password/authorization 字段递归打码。
 * - 日志系统自身故障绝不外抛（写盘失败只 console 提示一次）。
 */

import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 结构化上下文（必须可 JSON 序列化；只放摘要，不放正文/payload）。 */
export type LogData = Record<string, unknown>;

/** 渲染进程经 IPC 转发的单条日志（ts 由渲染侧打，保证时序真实）。 */
export interface RendererLogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: LogData;
  err?: { name?: string; message: string; stack?: string };
}

const RETENTION_DAYS = 14;
/** data 序列化长度上限 —— 超长说明调用侧误把正文塞进了日志，截断自保。 */
const DATA_MAX_CHARS = 4096;
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 文件落盘级别（debug 默认只进 console；CS_LOG_LEVEL=debug 全开）。 */
const FILE_LEVEL: LogLevel = process.env.CS_LOG_LEVEL === 'debug' ? 'debug' : 'info';

const SENSITIVE_KEY = /key|token|secret|password|authorization|credential/i;
const REDACTED = '<redacted>';

let dirReady = false;
let writeFailureReported = false;

/** 日志根目录（userData/logs）。app ready 前不可调用写路径。 */
export function logDir(): string {
  return join(app.getPath('userData'), 'logs');
}

function dayKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地时区 ISO 串（带偏移），肉眼友好且可机读。 */
function tsString(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/** 递归脱敏：敏感字段名整体打码；字符串值保留（调用侧自律不放正文）。 */
function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
  if (typeof value !== 'object') return value;
  if (depth > 4) return '<deep>';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : sanitize(v, depth + 1);
  }
  return out;
}

function serializeErr(err: unknown): { name?: string; message: string; stack?: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return { name: err.name, message: err.message, stack: err.stack, ...(code ? { code } : {}) };
  }
  return { message: typeof err === 'string' ? err : JSON.stringify(err) };
}

function writeLine(file: string, line: string): void {
  try {
    if (!dirReady) {
      mkdirSync(logDir(), { recursive: true });
      dirReady = true;
    }
    appendFileSync(file, line + '\n', 'utf8');
  } catch (err) {
    // 日志写失败绝不外抛（避免反过来弄崩业务链路），console 只报一次。
    if (!writeFailureReported) {
      writeFailureReported = true;
      console.error('[log] write failed (further failures muted):', err);
    }
  }
}

function mirror(level: LogLevel, scope: string, msg: string, data?: LogData, err?: unknown): void {
  const text = `[${scope}] ${msg}`;
  const extra: unknown[] = [];
  if (data !== undefined) extra.push(data);
  if (err !== undefined) extra.push(err);
  if (level === 'error') console.error(text, ...extra);
  else if (level === 'warn') console.warn(text, ...extra);
  else console.log(text, ...extra);
}

function buildLine(ts: Date, level: LogLevel, scope: string, msg: string, data?: LogData, err?: unknown): string {
  const line: Record<string, unknown> = { ts: tsString(ts), level, scope, msg };
  if (data !== undefined) {
    let json = JSON.stringify(sanitize(data));
    if (json && json.length > DATA_MAX_CHARS) json = json.slice(0, DATA_MAX_CHARS) + '…';
    line.data = JSON.parse(json) as unknown;
  }
  if (err !== undefined) line.err = serializeErr(err);
  return JSON.stringify(line);
}

function record(
  stream: 'main' | 'renderer',
  ts: Date,
  level: LogLevel,
  scope: string,
  msg: string,
  data?: LogData,
  err?: unknown,
): void {
  if (stream === 'main') mirror(level, scope, msg, data, err);
  if (LEVEL_ORDER[level] < LEVEL_ORDER[FILE_LEVEL]) return;
  writeLine(join(logDir(), `${stream}-${dayKey(ts)}.jsonl`), buildLine(ts, level, scope, msg, data, err));
}

/** 主进程日志入口。scope 建议分层：app.startup / session / engine.codex /
 *  race / cron / fs / settings / ipc / host.opencode … */
export const log = {
  debug: (scope: string, msg: string, data?: LogData): void => record('main', new Date(), 'debug', scope, msg, data),
  info: (scope: string, msg: string, data?: LogData): void => record('main', new Date(), 'info', scope, msg, data),
  warn: (scope: string, msg: string, data?: LogData, err?: unknown): void =>
    record('main', new Date(), 'warn', scope, msg, data, err),
  error: (scope: string, msg: string, data?: LogData, err?: unknown): void =>
    record('main', new Date(), 'error', scope, msg, data, err),
};

/** 渲染进程批量日志落盘（IPC 转发入口；信任边界内做最基本字段校验）。 */
export function writeRendererLogs(entries: RendererLogEntry[]): void {
  if (!Array.isArray(entries)) return;
  for (const e of entries.slice(0, 200)) {
    if (!e || typeof e.msg !== 'string' || typeof e.scope !== 'string') continue;
    const level: LogLevel = e.level in LEVEL_ORDER ? e.level : 'info';
    if (LEVEL_ORDER[level] < LEVEL_ORDER[FILE_LEVEL]) continue;
    const ts = typeof e.ts === 'number' ? new Date(e.ts) : new Date();
    writeLine(join(logDir(), `renderer-${dayKey(ts)}.jsonl`), buildLine(ts, level, e.scope, e.msg, e.data, e.err));
  }
}

/** 清理 RETENTION_DAYS 之前的分片（仅本系统 main-/renderer- 前缀，不碰
 *  compat-audit.jsonl —— 它是审计样本库，生命周期独立）。 */
function sweepOldShards(): void {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffKey = dayKey(cutoff);
    for (const name of readdirSync(logDir())) {
      const m = /^(main|renderer)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (m && m[2] && m[2] < cutoffKey) {
        unlinkSync(join(logDir(), name));
        mirror('info', 'log', `swept old shard: ${name}`);
      }
    }
  } catch (err) {
    console.error('[log] sweep failed:', err);
  }
}

/** 启动初始化：建目录、清旧分片、写启动行。必须在 app ready 之后调用。 */
export function initLogger(): void {
  if (!existsSync(logDir())) mkdirSync(logDir(), { recursive: true });
  dirReady = true;
  sweepOldShards();
  log.info('app.startup', 'logger ready', {
    dir: logDir(),
    fileLevel: FILE_LEVEL,
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
  });
}
