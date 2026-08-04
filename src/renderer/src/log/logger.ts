/**
 * 渲染进程日志 — 与主进程同一套结构化 JSONL 格式，经 IPC 批量转发
 * 由主进程落盘（userData/logs/renderer-YYYY-MM-DD.jsonl）。
 *
 * 设计：
 * - buffer + 短节流批量发送（避免高频 IPC）；error 级立即冲刷；
 *   页面隐藏/关闭前尽力冲刷。
 * - dev 下镜像 console（生产 console 无人看，只留文件）。
 * - 只记本程序 UI 侧关键路径：全局未捕获异常、IPC 调用失败、
 *   关键用户操作。引擎事件流（text.delta 等）禁止入日志。
 */

export type RLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RLogData {
  [key: string]: unknown;
}

interface PendingEntry {
  ts: number;
  level: RLogLevel;
  scope: string;
  msg: string;
  data?: RLogData;
  err?: { name?: string; message: string; stack?: string };
}

const FLUSH_MS = 600;
const BUFFER_LIMIT = 100;

// dev = electron-vite 热更服务（http://localhost）；生产加载 file:// 产物。
const isDev = window.location.protocol !== 'file:';
let buffer: PendingEntry[] = [];
let flushTimer: number | undefined;

function serializeErr(err: unknown): { name?: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { message: typeof err === 'string' ? err : String(err) };
}

function mirror(level: RLogLevel, scope: string, msg: string, data?: RLogData, err?: unknown): void {
  if (!isDev) return;
  const text = `[${scope}] ${msg}`;
  const extra: unknown[] = [];
  if (data !== undefined) extra.push(data);
  if (err !== undefined) extra.push(err);
  if (level === 'error') console.error(text, ...extra);
  else if (level === 'warn') console.warn(text, ...extra);
  else console.log(text, ...extra);
}

function flush(): void {
  if (flushTimer !== undefined) {
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    window.cyberslots.logWrite(batch);
  } catch {
    /* 日志通道故障静默 —— 不能反过来影响业务 */
  }
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(flush, FLUSH_MS);
}

function push(level: RLogLevel, scope: string, msg: string, data?: RLogData, err?: unknown): void {
  mirror(level, scope, msg, data, err);
  buffer.push({
    ts: Date.now(),
    level,
    scope,
    msg,
    ...(data !== undefined ? { data } : {}),
    ...(err !== undefined ? { err: serializeErr(err) } : {}),
  });
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
  if (level === 'error') flush();
  else scheduleFlush();
}

/** 渲染进程日志入口。scope 建议：app / chat / race / ui.error … */
export const rlog = {
  debug: (scope: string, msg: string, data?: RLogData): void => push('debug', scope, msg, data),
  info: (scope: string, msg: string, data?: RLogData): void => push('info', scope, msg, data),
  warn: (scope: string, msg: string, data?: RLogData): void => push('warn', scope, msg, data),
  error: (scope: string, msg: string, data?: RLogData, err?: unknown): void => push('error', scope, msg, data, err),
  /** 立即冲刷缓冲（页面隐藏/关闭前调用）。 */
  flush,
};

/** 安装全局未捕获异常钩子（ErrorBoundary 之外的最后一道网）。 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (e) => {
    rlog.error('ui.error', 'uncaught error', { source: e.filename, line: e.lineno }, e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    rlog.error('ui.error', 'unhandled rejection', undefined, e.reason);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
