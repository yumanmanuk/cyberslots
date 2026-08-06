/**
 * ompQuota — 调 `omp usage --json --provider google-antigravity` 拉取
 * 所有已登录 Google 账号的 Claude 系列额度（5h + 7d），无需活跃会话。
 *
 * 带 5 min TTL 缓存；force=true 跳过缓存。
 */

import { spawn } from 'node:child_process';

import type { OmpAccountQuota, OmpQuota, OmpQuotaWindow } from '@shared/types';
import { resolveOmpCli } from '../engine/omp/resolveOmp';
import { log } from '../log/logger';

const TTL_MS = 5 * 60_000;
let cache: { at: number; data: OmpQuota } | undefined;
let inflight: Promise<OmpQuota> | undefined;

export function queryOmpQuota(force = false): Promise<OmpQuota> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = fetchAndParse().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

function fetchAndParse(): Promise<OmpQuota> {
  const now = Date.now();
  const { promise, resolve } = Promise.withResolvers<OmpQuota>();

  const spec = resolveOmpCli(['usage', '--json', '--provider', 'google-antigravity']);
  const child = spawn(spec.command, spec.args, {
    shell: spec.shell ?? false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { out += d; });

  const fail = (reason: string): void => {
    log.warn('usage.omp', 'queryOmpQuota failed', { reason });
    const result: OmpQuota = { ok: false, error: reason, accounts: [], queriedAt: now };
    cache = { at: now, data: result };
    resolve(result);
  };

  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* ignore */ }
    fail('omp usage --json timed out');
  }, 20_000);

  child.on('error', (e) => {
    clearTimeout(timer);
    fail(`omp CLI spawn error: ${e.message}`);
  });

  child.on('close', () => {
    clearTimeout(timer);
    try {
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const result = normalizeCliResponse(parsed, now);
      cache = { at: now, data: result };
      resolve(result);
    } catch {
      fail('omp usage --json parse error');
    }
  });

  return promise;
}

type Json = Record<string, unknown>;

/** 解析一条 report 的 limits，返回 Claude counter 各时间窗余量。 */
function extractWindows(limits: Json[], now: number): OmpQuotaWindow[] {
  const windows: OmpQuotaWindow[] = [];
  for (const limit of limits) {
    const id = typeof limit.id === 'string' ? limit.id : '';
    // 只保留 Anthropic/Claude 后端 counter
    if (!id.toLowerCase().includes(':anthropic:')) continue;

    const win = (typeof limit.window === 'object' && limit.window ? limit.window : {}) as Json;
    const windowId = typeof win.id === 'string' && win.id ? win.id
      : typeof win.label === 'string' && win.label ? win.label : 'default';

    // 同 windowId 去重（每账号每窗口只取第一条）
    if (windows.some((w) => w.windowId === windowId)) continue;

    const amount = (typeof limit.amount === 'object' && limit.amount ? limit.amount : {}) as Json;
    const remainingFraction = typeof amount.remainingFraction === 'number' && Number.isFinite(amount.remainingFraction)
      ? amount.remainingFraction : undefined;
    const resetsAt = typeof win.resetsAt === 'number' && win.resetsAt > now ? win.resetsAt : undefined;

    windows.push({
      windowId,
      windowLabel: typeof win.label === 'string' && win.label ? win.label : windowId,
      remainingFraction,
      resetsAt,
      status: typeof limit.status === 'string' ? limit.status : 'ok',
    });
  }

  // daily/5h 在前，weekly/7d 在后
  return windows.sort((a, b) => windowRank(a.windowId) - windowRank(b.windowId));
}

function windowRank(id: string): number {
  const lower = id.toLowerCase();
  if (lower === 'daily' || lower === '5h' || lower === '5hour') return 0;
  if (lower === 'weekly' || lower === '7d' || lower === '7day') return 1;
  return 2;
}

/**
 * `omp usage --json --provider google-antigravity` 输出 → OmpQuota。
 *
 * 每个登录的 Google 账号对应一条 report（metadata.email 不同），
 * 全部迭代，每条转为一个 OmpAccountQuota。
 */
function normalizeCliResponse(raw: Json, now: number): OmpQuota {
  const reports = Array.isArray(raw.reports) ? (raw.reports as Json[]) : [];

  const accounts: OmpAccountQuota[] = [];
  for (const report of reports) {
    if (typeof report.provider !== 'string' || report.provider !== 'google-antigravity') continue;

    const meta = (typeof report.metadata === 'object' && report.metadata ? report.metadata : {}) as Json;
    const email = typeof meta.email === 'string' && meta.email ? meta.email : undefined;
    const limits = Array.isArray(report.limits) ? (report.limits as Json[]) : [];

    const windows = extractWindows(limits, now);
    // 只收录有至少一条时间窗数据的账号（无 Claude quota 的账号不展示）
    if (windows.length > 0) accounts.push({ email, windows });
  }

  return { ok: true, accounts, queriedAt: now };
}
