/**
 * agyPolicy — Antigravity 切号策略纯函数（main / renderer / vitest 三方共用）。
 *
 * 无任何运行时依赖（不引 electron / react / electron-store），时间一律由
 * 调用方注入（now 参数），保证可单测。承载：
 *  - 连续切号熔断滑动窗口（会话级 + 全局级各持一份 RateWindow）；
 *  - 耗尽冷却 blocked 表（email → blockedUntil；唯一写入需坐实 ≥99.95 证据）；
 *  - 起跑前预切 20pp 滞后判断；
 *  - 选号门槛 pickAgySwitchTarget（三道旧门槛 + blocked 第四道）。
 */

import type { AgyQuotaGroup, AgyQuotaInfo } from './types';

// ------------------------------------------------------------- 连续切号熔断

export const AGY_AUTOSWITCH_RATE_WINDOW_MS = 10 * 60 * 1000; // 10 分钟滑动窗口
export const AGY_AUTOSWITCH_RATE_LIMIT = 3; // 窗口内最多 3 次自动切号

/** 一份熔断滑动窗口（会话级/全局级各持一份）。 */
export interface RateWindow {
  hits: number[];
}

export function createRateWindow(): RateWindow {
  return { hits: [] };
}

function pruneHits(hits: number[], now: number, windowMs: number): void {
  while (hits.length > 0 && hits[0]! < now - windowMs) hits.shift();
}

/** 窗口内成功命中数是否已达上限（第 N+1 次判拒）。命中只记成功的自动切号。 */
export function rateWindowLimited(
  w: RateWindow,
  now: number,
  limit: number = AGY_AUTOSWITCH_RATE_LIMIT,
  windowMs: number = AGY_AUTOSWITCH_RATE_WINDOW_MS,
): boolean {
  pruneHits(w.hits, now, windowMs);
  return w.hits.length >= limit;
}

export function recordRateWindowHit(w: RateWindow, now: number, windowMs: number = AGY_AUTOSWITCH_RATE_WINDOW_MS): void {
  pruneHits(w.hits, now, windowMs);
  w.hits.push(now);
}

/** agy 引擎非 error 收尾清零（证明当前账号恢复正常工作）。 */
export function clearRateWindow(w: RateWindow): void {
  w.hits.length = 0;
}

// -------------------------------------------------- 耗尽冷却 blocked 表

export const AGY_BLOCK_FALLBACK_MS = 30 * 60 * 1000; // 坐实耗尽但解析不到 resetTime 时降级 30min
export const AGY_EXHAUSTION_UTILIZATION = 99.95;

/** email → blockedUntil（ms）。 */
export type BlockedMap = Map<string, number>;

/** 到期惰性失效：返回未到期 blockedUntil；过期顺手清除并返回 undefined。 */
export function blockedUntil(map: BlockedMap, email: string, now: number): number | undefined {
  const until = map.get(email);
  if (until === undefined) return undefined;
  if (until <= now) {
    map.delete(email);
    return undefined;
  }
  return until;
}

/** 写入硬约束：仅分组数据实际含 ≥99.95 耗尽分组才落 blocked，且只标记
 *  这一个 email；blockedUntil 取耗尽分组的最大重置秒数，解析不到降级
 *  30min。返回 blockedUntil；无坐实证据返回 undefined 且不动表。 */
export function markBlockedIfExhausted(
  map: BlockedMap,
  email: string,
  groups: AgyQuotaGroup[],
  now: number,
  fallbackMs: number = AGY_BLOCK_FALLBACK_MS,
): number | undefined {
  const exhausted = groups.filter((g) => g.utilization >= AGY_EXHAUSTION_UTILIZATION);
  if (exhausted.length === 0) return undefined;
  const maxReset = Math.max(...exhausted.map((g) => g.resetsInSeconds ?? 0));
  const until = now + (maxReset > 0 ? maxReset * 1000 : fallbackMs);
  map.set(email, until);
  return until;
}

/** 双解封之「恢复即清」：分组数据健康（无 ≥99.95 耗尽）→ 清除冷却标记。
 *  0 组 = 数据不可解读（解析漂移），不动表。 */
export function clearBlockedIfRecovered(map: BlockedMap, email: string, groups: AgyQuotaGroup[]): void {
  if (groups.length === 0) return;
  if (groups.every((g) => g.utilization < AGY_EXHAUSTION_UTILIZATION)) map.delete(email);
}

/** 快照 blocked 表（Record 形态）→ 未到期冷却邮箱集（按时间戳惰性过滤）。 */
export function blockedEmailsOf(blocked: Record<string, number> | undefined, now: number): Set<string> {
  const out = new Set<string>();
  for (const [email, until] of Object.entries(blocked ?? {})) if (until > now) out.add(email);
  return out;
}

/** BlockedMap → 快照 Record（只含未到期条目；空表返回 undefined）。 */
export function blockedRecordOf(map: BlockedMap, now: number): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const email of [...map.keys()]) {
    const until = blockedUntil(map, email, now);
    if (until !== undefined) out[email] = until;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ------------------------------------------------------- 起跑前预切（20pp）

export const AGY_PRE_SWITCH_LAG_PP = 20; // 滞后阈值（百分点），防敏感误切

/** 短板窗余量（百分点）：最差一扇时间窗的剩余。0 组返回 -1（无数据）。 */
export function shortBoardRemaining(groups: AgyQuotaGroup[]): number {
  if (groups.length === 0) return -1;
  return Math.min(...groups.map((g) => 100 - g.utilization));
}

/** 20pp 滞后判断：池内最优短板余量领先当前账号 ≥ lagPp 个百分点才预切。 */
export function shouldPreSwitch(
  activeShortBoard: number,
  poolBestShortBoard: number,
  lagPp: number = AGY_PRE_SWITCH_LAG_PP,
): boolean {
  return poolBestShortBoard - activeShortBoard >= lagPp;
}

// ------------------------------------------------------------- 选号门槛

/** 时间窗标签 → 对应阈值：5小时/7天各自独立配置（主进程已把分组名归一
 *  为时间窗标签）；未知窗标签（后端新增分组等）取两者中较低的阈值 ——
 *  宽松兜底，避免误触发切号/误杀候选账号。 */
export function agyWindowThreshold(group: string, t5h: number, t7d: number): number {
  return group === '5小时' ? t5h : group === '7天' ? t7d : Math.min(t5h, t7d);
}

/** 从额度快照挑一个可切换的目标账号。四道硬门槛：查得到(ok) + 非当前账号
 *  + 未过期的 blocked 冷却 + 每个时间窗剩余都 ≥ 各自阈值（5小时/7天独立
 *  门槛，任一窗低就快堵）。合格池按「短板窗」min(各窗剩余 - 各窗阈值)
 *  最厚优先 —— 两窗尺度不同，可用寿命由更贴近自身阈值的窗决定，相对余量
 *  最厚 = 切过去最耐用、最不易立刻再触发。无合格返回 undefined。 */
export function pickAgySwitchTarget(
  quotas: AgyQuotaInfo[],
  currentEmail: string | undefined,
  t5h: number,
  t7d: number,
  blockedEmails?: Set<string>,
): AgyQuotaInfo | undefined {
  const margin = (g: AgyQuotaGroup): number => 100 - g.utilization - agyWindowThreshold(g.group, t5h, t7d);
  const minMargin = (q: AgyQuotaInfo): number => Math.min(...q.groups.map(margin));
  const eligible = quotas.filter(
    (q) =>
      q.ok &&
      q.email !== currentEmail &&
      !blockedEmails?.has(q.email) &&
      q.groups.length > 0 &&
      q.groups.every((g) => margin(g) >= 0),
  );
  if (eligible.length === 0) return undefined;
  return [...eligible].sort((a, b) => minMargin(b) - minMargin(a))[0];
}
