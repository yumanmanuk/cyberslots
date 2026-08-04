/**
 * providerQuota — 供应商套餐余量/余额查询（参照 cc-switch 的接口口径）：
 * - Kimi For Coding：GET api.kimi.com/coding/v1/usages（5小时窗 + 周窗）
 * - MiniMax Coding Plan：GET api.minimax{i.com,io}/v1/api/openplatform/coding_plan/remains
 * - DeepSeek：GET api.deepseek.com/user/balance（无 token plan，查余额）
 *
 * apiKey 从三个引擎的本地配置探测（kimi config.toml / codex env_key 环境
 * 变量 / opencode 配置与 auth.json），全程只在主进程使用，从不跨进 renderer。
 * 结果带 5 分钟 TTL 缓存 + in-flight 去重（force 跳过缓存）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as tomlParse } from 'smol-toml';

import type { ProviderQuotaInfo, QuotaProviderId, QuotaTierInfo } from '@shared/types';
import { codexHomeDir, kimiHomeDir } from '../config/engineConfigs';
import { L } from '../i18n';
import { log } from '../log/logger';

type Json = Record<string, unknown>;

interface DetectedKey {
  key: string;
  /** minimax 国际站（api.minimax.io）。 */
  intl?: boolean;
}

const TTL_MS = 5 * 60_000;
let cache: { at: number; data: ProviderQuotaInfo[] } | undefined;
let inflight: Promise<ProviderQuotaInfo[]> | undefined;

export function getProviderQuotas(force = false): Promise<ProviderQuotaInfo[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = queryAll().then(
    (data) => {
      cache = { at: Date.now(), data };
      inflight = undefined;
      return data;
    },
    (err) => {
      inflight = undefined;
      throw err;
    },
  );
  return inflight;
}

async function queryAll(): Promise<ProviderQuotaInfo[]> {
  const keys = detectKeys();
  const jobs: Array<Promise<ProviderQuotaInfo>> = [];
  for (const [provider, det] of keys) {
    jobs.push(
      queryOne(provider, det).catch((err): ProviderQuotaInfo => {
        log.warn('quota', 'provider quota query failed', { provider }, err);
        return {
          provider,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          queriedAt: Date.now(),
        };
      }),
    );
  }
  return Promise.all(jobs);
}

function queryOne(provider: QuotaProviderId, det: DetectedKey): Promise<ProviderQuotaInfo> {
  switch (provider) {
    case 'kimi':
      return queryKimi(det.key);
    case 'minimax':
      return queryMinimax(det.key, det.intl ?? false);
    case 'deepseek':
      return queryDeepseek(det.key);
  }
}

// ------------------------------------------------------------ key 探测

/** 按 baseUrl 域名归类（与 cc-switch 的 detect_provider 同口径）。 */
function classifyUrl(rawUrl: string): { p: QuotaProviderId; intl?: boolean } | undefined {
  const url = rawUrl.toLowerCase();
  if (url.includes('api.kimi.com')) return { p: 'kimi' };
  if (url.includes('api.minimaxi.com')) return { p: 'minimax' };
  if (url.includes('api.minimax.io')) return { p: 'minimax', intl: true };
  if (url.includes('api.deepseek.com')) return { p: 'deepseek' };
  return undefined;
}

/** opencode 侧按 provider id 归类（配置无 baseURL 时的兜底）。 */
function classifyId(id: string): QuotaProviderId | undefined {
  const low = id.toLowerCase();
  if (low === 'deepseek') return 'deepseek';
  if (low === 'minimax') return 'minimax';
  if (low === 'kimi' || low.startsWith('kimi-')) return 'kimi';
  return undefined;
}

/** opencode 配置里 apiKey 常见 `{env:NAME}` 模板 — 解析为环境变量值。 */
function resolveEnvTemplate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = /^\{env:([^}]+)\}$/.exec(v.trim());
  if (m?.[1]) return process.env[m[1]] || undefined;
  return v;
}

function detectKeys(): Map<QuotaProviderId, DetectedKey> {
  const found = new Map<QuotaProviderId, DetectedKey>();
  const offer = (p: QuotaProviderId | undefined, key: string | undefined, intl?: boolean): void => {
    if (!p || !key?.trim() || found.has(p)) return;
    found.set(p, { key: key.trim(), intl });
  };

  // kimi CLI：~/.kimi-code/config.toml 的 providers.*.{base_url,api_key}
  try {
    const path = join(kimiHomeDir(), 'config.toml');
    if (existsSync(path)) {
      const doc = tomlParse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Json;
      for (const p of Object.values((doc.providers ?? {}) as Record<string, Json>)) {
        const hit = classifyUrl(str(p.base_url) ?? '');
        offer(hit?.p, str(p.api_key), hit?.intl);
      }
    }
  } catch {
    /* 配置损坏不阻断探测 */
  }

  // codex CLI：~/.codex/config.toml 的 model_providers（key 在 env_key 环境变量）
  try {
    const path = join(codexHomeDir(), 'config.toml');
    if (existsSync(path)) {
      const doc = tomlParse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Json;
      for (const p of Object.values((doc.model_providers ?? {}) as Record<string, Json>)) {
        const hit = classifyUrl(str(p.base_url) ?? '');
        const envKey = str(p.env_key);
        offer(hit?.p, envKey ? process.env[envKey] : undefined, hit?.intl);
      }
    }
  } catch {
    /* ignore */
  }

  // opencode：全局 opencode.json 的 provider.*.options + auth.json
  try {
    const cfgDir = join(homedir(), '.config', 'opencode');
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const path = join(cfgDir, name);
      if (!existsSync(path)) continue;
      const doc = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Json;
      for (const [id, p] of Object.entries((doc.provider ?? {}) as Record<string, Json>)) {
        const opts = (p.options ?? {}) as Json;
        const hit = classifyUrl(str(opts.baseURL) ?? '');
        offer(hit?.p ?? classifyId(id), resolveEnvTemplate(str(opts.apiKey)), hit?.intl);
      }
      break;
    }
  } catch {
    /* jsonc 带注释等解析失败 — 跳过 */
  }
  try {
    const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
    if (existsSync(authPath)) {
      const doc = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, Json>;
      for (const [id, entry] of Object.entries(doc)) {
        if (str(entry.type) === 'api') offer(classifyId(id), str(entry.key));
      }
    }
  } catch {
    /* ignore */
  }

  return found;
}

// ------------------------------------------------------------ 查询实现

async function fetchJson(url: string, key: string): Promise<Json> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) throw new Error(L('API key 无效或已过期', 'API key invalid or expired'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Json;
  } finally {
    clearTimeout(timer);
  }
}

/** 重置时间归一为 ms：兼容 ISO 字符串与秒/毫秒时间戳（cc-switch 同款）。 */
function toMs(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof v === 'number' && v > 0) return v < 1_000_000_000_000 ? v * 1000 : v;
  return undefined;
}

function parseF64(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** limit/remaining → 已用百分比 tier。 */
function tierFromLimit(name: QuotaTierInfo['name'], d: Json): QuotaTierInfo {
  const limit = parseF64(d.limit) ?? 1;
  const remaining = parseF64(d.remaining) ?? 0;
  const used = Math.max(0, limit - remaining);
  return {
    name,
    utilization: limit > 0 ? Math.min(100, (used / limit) * 100) : 0,
    resetsAt: toMs(d.resetTime),
  };
}

/** Kimi For Coding：limits[].detail = 5小时窗，顶层 usage = 周窗。 */
async function queryKimi(key: string): Promise<ProviderQuotaInfo> {
  const body = await fetchJson('https://api.kimi.com/coding/v1/usages', key);
  const tiers: QuotaTierInfo[] = [];
  if (Array.isArray(body.limits)) {
    for (const li of body.limits as Json[]) {
      const detail = li.detail as Json | undefined;
      if (detail) tiers.push(tierFromLimit('five_hour', detail));
    }
  }
  const usage = body.usage as Json | undefined;
  if (usage) tiers.push(tierFromLimit('weekly', usage));
  return { provider: 'kimi', ok: true, tiers, queriedAt: Date.now() };
}

/** MiniMax Coding Plan：model_remains 里 model_name=general 的条目；
 *  接口给「剩余百分比」，反转为已用百分比。 */
async function queryMinimax(key: string, intl: boolean): Promise<ProviderQuotaInfo> {
  const domain = intl ? 'api.minimax.io' : 'api.minimaxi.com';
  const body = await fetchJson(`https://${domain}/v1/api/openplatform/coding_plan/remains`, key);
  const baseResp = body.base_resp as Json | undefined;
  const code = parseF64(baseResp?.status_code) ?? 0;
  if (code !== 0) throw new Error(str(baseResp?.status_msg) ?? `API error (code ${code})`);

  const tiers: QuotaTierInfo[] = [];
  const remains = Array.isArray(body.model_remains) ? (body.model_remains as Json[]) : [];
  const item = remains.find((r) => str(r.model_name) === 'general');
  if (item) {
    const fiveHourRemain = parseF64(item.current_interval_remaining_percent);
    if (fiveHourRemain !== undefined) {
      tiers.push({ name: 'five_hour', utilization: 100 - fiveHourRemain, resetsAt: toMs(item.end_time) });
    }
    // 周窗仅当 status=1 时存在（status=3 等表示套餐无周限额）
    if (parseF64(item.current_weekly_status) === 1) {
      const weeklyRemain = parseF64(item.current_weekly_remaining_percent);
      if (weeklyRemain !== undefined) {
        tiers.push({ name: 'weekly', utilization: 100 - weeklyRemain, resetsAt: toMs(item.weekly_end_time) });
      }
    }
  }
  return { provider: 'minimax', ok: true, tiers, queriedAt: Date.now() };
}

/** DeepSeek：无 token plan，查账户余额（balance_infos 按币种）。 */
async function queryDeepseek(key: string): Promise<ProviderQuotaInfo> {
  const body = await fetchJson('https://api.deepseek.com/user/balance', key);
  const balances: Array<{ currency: string; amount: number }> = [];
  if (Array.isArray(body.balance_infos)) {
    for (const info of body.balance_infos as Json[]) {
      balances.push({
        currency: str(info.currency) ?? 'CNY',
        amount: parseF64(info.total_balance) ?? 0,
      });
    }
  }
  return { provider: 'deepseek', ok: true, balances, queriedAt: Date.now() };
}

// ---------------------------------------------------------------- utils

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
