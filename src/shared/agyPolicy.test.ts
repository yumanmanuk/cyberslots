/**
 * agyPolicy 纯函数单测（步骤7.2）：熔断滑动窗口（含第 N+1 次拒绝）、
 * 耗尽冷却 blocked 表（写入硬约束/到期/恢复清除）、20pp 起跑预切、
 * 选号门槛（blocked 第四道）。时间一律注入，不依赖真实时钟。
 */
import { describe, expect, it } from 'vitest';

import {
  AGY_AUTOSWITCH_RATE_LIMIT,
  AGY_AUTOSWITCH_RATE_WINDOW_MS,
  blockedEmailsOf,
  blockedRecordOf,
  blockedUntil,
  clearBlockedIfRecovered,
  clearRateWindow,
  createRateWindow,
  markBlockedIfExhausted,
  pickAgyPreSwitchTarget,
  pickAgySwitchTarget,
  rateWindowLimited,
  recordRateWindowHit,
  shortBoardRemaining,
  shouldPreSwitch,
  type BlockedMap,
} from './agyPolicy';
import type { AgyQuotaGroup, AgyQuotaInfo } from './types';

const T0 = 1_700_000_000_000;

function group(utilization: number, resetsInSeconds?: number, label: string = '5小时'): AgyQuotaGroup {
  return { group: label, utilization, resetsInSeconds };
}

function quota(email: string, groups: AgyQuotaGroup[], ok = true): AgyQuotaInfo {
  return { email, accountId: email, ok, groups, queriedAt: T0 };
}

describe('熔断滑动窗口（10min ≤3 次）', () => {
  it('窗口内第 N+1 次判拒', () => {
    const w = createRateWindow();
    for (let i = 0; i < AGY_AUTOSWITCH_RATE_LIMIT; i++) {
      expect(rateWindowLimited(w, T0 + i * 1000)).toBe(false);
      recordRateWindowHit(w, T0 + i * 1000);
    }
    expect(rateWindowLimited(w, T0 + AGY_AUTOSWITCH_RATE_LIMIT * 1000)).toBe(true);
  });

  it('窗口外旧命中惰性剪枝后放行', () => {
    const w = createRateWindow();
    for (let i = 0; i < AGY_AUTOSWITCH_RATE_LIMIT; i++) recordRateWindowHit(w, T0);
    const later = T0 + AGY_AUTOSWITCH_RATE_WINDOW_MS + 1;
    expect(rateWindowLimited(w, later)).toBe(false);
    expect(w.hits).toHaveLength(0);
  });

  it('清零后立即可用（agy 引擎非 error 收尾语义）', () => {
    const w = createRateWindow();
    for (let i = 0; i < AGY_AUTOSWITCH_RATE_LIMIT; i++) recordRateWindowHit(w, T0);
    expect(rateWindowLimited(w, T0)).toBe(true);
    clearRateWindow(w);
    expect(rateWindowLimited(w, T0)).toBe(false);
  });
});

describe('耗尽冷却 blocked 表', () => {
  it('写入硬约束：仅 ≥99.95 耗尽分组落 blocked 且只标记该 email；resetTime 取最大重置秒数', () => {
    const map: BlockedMap = new Map();
    expect(markBlockedIfExhausted(map, 'a@x', [group(50)], T0)).toBeUndefined();
    expect(map.size).toBe(0);
    expect(markBlockedIfExhausted(map, 'a@x', [group(99.95, 600), group(100, 1200)], T0)).toBe(T0 + 1_200_000);
    expect(blockedUntil(map, 'a@x', T0)).toBe(T0 + 1_200_000);
    expect(map.has('b@x')).toBe(false);
  });

  it('解析不到 resetTime 降级 30min', () => {
    const map: BlockedMap = new Map();
    expect(markBlockedIfExhausted(map, 'a@x', [group(100)], T0)).toBe(T0 + 30 * 60 * 1000);
  });

  it('到期惰性失效（顺手清除）', () => {
    const map: BlockedMap = new Map();
    markBlockedIfExhausted(map, 'a@x', [group(100, 60)], T0);
    expect(blockedUntil(map, 'a@x', T0 + 59_000)).toBe(T0 + 60_000);
    expect(blockedUntil(map, 'a@x', T0 + 61_000)).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('恢复即清；0 组 = 数据不可解读不动表', () => {
    const map: BlockedMap = new Map();
    markBlockedIfExhausted(map, 'a@x', [group(100, 600)], T0);
    clearBlockedIfRecovered(map, 'a@x', []);
    expect(map.has('a@x')).toBe(true);
    clearBlockedIfRecovered(map, 'a@x', [group(42)]);
    expect(map.has('a@x')).toBe(false);
  });

  it('blockedRecordOf / blockedEmailsOf 只含未到期条目', () => {
    const map: BlockedMap = new Map();
    markBlockedIfExhausted(map, 'a@x', [group(100, 600)], T0);
    map.set('old@x', T0 - 1);
    const rec = blockedRecordOf(map, T0);
    expect(rec).toEqual({ 'a@x': T0 + 600_000 });
    const emails = blockedEmailsOf(rec, T0);
    expect(emails.has('a@x')).toBe(true);
    expect(emails.has('old@x')).toBe(false);
    expect(blockedEmailsOf(undefined, T0).size).toBe(0);
    expect(blockedRecordOf(new Map(), T0)).toBeUndefined();
  });
});

describe('20pp 起跑预切', () => {
  it('shortBoardRemaining 取最差窗余量；空组 -1', () => {
    expect(shortBoardRemaining([group(70), group(40, undefined, '7天')])).toBe(30);
    expect(shortBoardRemaining([])).toBe(-1);
  });

  it('shouldPreSwitch 滞后阈值边界', () => {
    expect(shouldPreSwitch(10, 30)).toBe(true);
    expect(shouldPreSwitch(10, 29.9)).toBe(false);
    expect(shouldPreSwitch(50, 30)).toBe(false);
  });

  it('缓存 miss（空池）→ 跳过预切', () => {
    expect(pickAgyPreSwitchTarget([], 'cur@x', new Set())).toBeUndefined();
  });

  it('落后 <20pp 不切；≥20pp 切池内短板最厚者', () => {
    const active = quota('cur@x', [group(70)]); // 短板余量 30
    const mild = quota('mild@x', [group(55)]); // 余量 45（差 15pp）
    expect(pickAgyPreSwitchTarget([active, mild], 'cur@x', new Set())).toBeUndefined();
    const good = quota('good@x', [group(60)]); // 余量 40
    const best = quota('best@x', [group(10)]); // 余量 90（差 60pp）
    expect(pickAgyPreSwitchTarget([active, good, best], 'cur@x', new Set())?.email).toBe('best@x');
  });

  it('当前账号已 blocked → 不论差距直接切最优非冷却候选；候选全冷却/无数据 → 不切', () => {
    const active = quota('cur@x', [group(70)]);
    const better = quota('b@x', [group(65)]); // 只差 5pp，但 active 已 blocked
    expect(pickAgyPreSwitchTarget([active, better], 'cur@x', new Set(['cur@x']))?.email).toBe('b@x');
    expect(pickAgyPreSwitchTarget([active, better], 'cur@x', new Set(['cur@x', 'b@x']))).toBeUndefined();
    expect(pickAgyPreSwitchTarget([active, quota('bad@x', [], false)], 'cur@x', new Set(['cur@x']))).toBeUndefined();
  });
});

describe('选号门槛 pickAgySwitchTarget', () => {
  it('第四道门槛：blocked 未到期候选被跳过；全冷却 → 无目标', () => {
    const quotas = [
      quota('cur@x', [group(0)]),
      quota('hot@x', [group(0)]), // 余量最厚但在冷却
      quota('ok@x', [group(50)]),
    ];
    expect(pickAgySwitchTarget(quotas, 'cur@x', 15, 5, new Set(['hot@x']))?.email).toBe('ok@x');
    expect(pickAgySwitchTarget(quotas, 'cur@x', 15, 5, new Set(['hot@x', 'ok@x']))).toBeUndefined();
  });

  it('窗口阈值独立：任一窗剩余低于对应阈值即淘汰；合格池短板排序不变', () => {
    const quotas = [
      quota('cur@x', [group(0)]),
      quota('thin5h@x', [group(90, undefined, '5小时'), group(0, undefined, '7天')]), // 5h 余 10 < 15 → 淘汰
      quota('thin7d@x', [group(0, undefined, '5小时'), group(96, undefined, '7天')]), // 7d 余 4 < 5 → 淘汰
      quota('ok@x', [group(50, undefined, '5小时'), group(80, undefined, '7天')]),
    ];
    expect(pickAgySwitchTarget(quotas, 'cur@x', 15, 5)?.email).toBe('ok@x');
  });

  it('ok=false / 当前账号 / 空组候选一律排除', () => {
    const quotas = [quota('cur@x', [group(0)]), quota('dead@x', [], false), quota('empty@x', [])];
    expect(pickAgySwitchTarget(quotas, 'cur@x', 15, 5)).toBeUndefined();
  });
});
