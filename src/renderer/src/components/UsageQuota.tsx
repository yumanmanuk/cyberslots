/**
 * UsageQuota — 用量/余量共享 UI：
 * - useProviderQuotas：供应商套餐余量查询 hook（主进程代查带缓存）
 * - QuotaRow：单个供应商余量行（kimi/minimax 时间窗徽章、deepseek 余额）
 * - UsageQuickButton：侧栏底部入口（悬浮 → 今日用量精简小窗；点击 → 用量大窗）
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleGauge, Clock } from 'lucide-react';

import type { AgyActiveQuota, ProviderQuotaInfo, QuotaProviderId, UsageStatsResult } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { BrandSpinner } from './brand';
import { useT } from '../i18n';

export const QUOTA_LABELS: Record<QuotaProviderId, string> = {
  kimi: 'Kimi',
  minimax: 'MiniMax',
  deepseek: 'DeepSeek',
};

// -------------------------------------------------------------- helpers

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 大数短格式：zh 用 万/亿，en 用 k/M/B。 */
export function fmtShort(n: number, lang: 'zh' | 'en'): string {
  if (lang === 'zh') {
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
    return fmtInt(n);
  }
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return fmtInt(n);
}

/** 重置倒计时（cc-switch 同款）：>24h 显示 Nd Nh，否则 Nh Nm / Nm。 */
function countdown(resetsAt?: number): string | null {
  if (!resetsAt) return null;
  const diff = resetsAt - Date.now();
  if (diff <= 0) return null;
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours > 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

/** 已用百分比 → 颜色（离上限越近越警示）。 */
function utilColor(u: number): string {
  if (u >= 90) return 'text-err';
  if (u >= 70) return 'text-warn';
  return 'text-ok';
}

/** 剩余百分比 → 颜色（与 Antigravity 切号弹窗一致：>30 绿 / 10–30 橙 / <10 红）。 */
function remainColor(remain: number): string {
  if (remain > 30) return 'text-ok';
  if (remain > 10) return 'text-warn';
  return 'text-err';
}

/** Antigravity 分组名已在主进程归一为时间窗标签（5小时/7天），直接展示。 */

function currencySymbol(c: string): string {
  if (c === 'CNY' || c === 'RMB') return '¥';
  if (c === 'USD') return '$';
  return `${c} `;
}

// ----------------------------------------------------------------- hook

/** 供应商余量：active 期间拉取一次（主进程 5 分钟缓存兜底重复调用）。
 *  undefined = 加载中；[] = 无已配置 key 的供应商。
 *  refreshing 驱动刷新按钮旋转动效 — 请求期间持续转，完成即停。 */
export function useProviderQuotas(active: boolean): {
  quotas: ProviderQuotaInfo[] | undefined;
  refreshing: boolean;
  refresh: (force?: boolean) => void;
} {
  const [quotas, setQuotas] = useState<ProviderQuotaInfo[] | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback((force = false): void => {
    setRefreshing(true);
    // 最短旋转 600ms — 命中缓存瞬回时图标也能完整转一下，
    // 用户能确认动作确实执行过。
    const minSpin = new Promise((r) => setTimeout(r, 600));
    const query = window.cyberslots
      .providerQuota(force)
      .then(setQuotas)
      .catch(() => setQuotas([]));
    void Promise.all([query, minSpin]).finally(() => setRefreshing(false));
  }, []);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);
  return { quotas, refreshing, refresh };
}

/** 当前活动 Antigravity 账号的额度（只 1 次往返，与切号弹窗扫全账号解耦）。
 *  undefined = 加载中；无活动账号时 email 为空（渲染侧据此隐藏行，同 providerQuota 只显已配置供应商）。 */
export function useActiveAgyQuota(active: boolean): {
  quota: AgyActiveQuota | undefined;
  refreshing: boolean;
  refresh: (force?: boolean) => void;
} {
  const [quota, setQuota] = useState<AgyActiveQuota | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback((force = false): void => {
    setRefreshing(true);
    const minSpin = new Promise((r) => setTimeout(r, 600));
    const query = window.cyberslots
      .agyActiveQuota(force)
      .then(setQuota)
      .catch(() => setQuota({ ok: false, groups: [], queriedAt: Date.now() }));
    void Promise.all([query, minSpin]).finally(() => setRefreshing(false));
  }, []);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);
  return { quota, refreshing, refresh };
}

// ------------------------------------------------------------ quota row

/** 单个供应商余量行：kimi/minimax = 「5小时: X% ⏱4h7m · 7天: Y% ⏱1d2h」，
 *  deepseek = 「余额 ¥123.45」。roomy = 大窗宽松排版（字号/间距加大），
 *  缺省为悬浮小窗的紧凑排版。 */
export function QuotaRow({ q, roomy }: { q: ProviderQuotaInfo; roomy?: boolean }): JSX.Element {
  const t = useT();
  return (
    <div className={`flex items-center ${roomy ? 'gap-5 text-ui leading-7' : 'gap-2 text-[11.5px] leading-5'}`}>
      <span className={`shrink-0 font-medium text-ink-soft ${roomy ? 'w-24' : 'w-[68px]'}`}>{QUOTA_LABELS[q.provider]}</span>
      {!q.ok ? (
        <span className="min-w-0 truncate text-ink-faint" title={q.error}>
          {t('quotaFailed')}
        </span>
      ) : q.balances ? (
        <span className="tabular-nums text-ink">
          <span className={`text-ink-faint ${roomy ? 'mr-2.5' : 'mr-1'}`}>{t('quotaBalance')}</span>
          {q.balances.map((b) => `${currencySymbol(b.currency)}${b.amount.toFixed(2)}`).join(' · ')}
        </span>
      ) : (
        <span className={`flex min-w-0 ${roomy ? 'flex-wrap items-center gap-x-8 gap-y-0.5' : 'flex-col gap-1'}`}>
          {(q.tiers ?? []).map((tier) => {
            const cd = countdown(tier.resetsAt);
            return roomy ? (
              /* 宽松模式：各段定宽成列 — 多个供应商行的窗口标签/百分比/
                 倒计时纵向对齐（百分比列右对齐，% 号跨行对齐）。 */
              <span key={tier.name} className="flex w-52 items-center whitespace-nowrap">
                <span className="w-12 text-ink-faint">{tier.name === 'five_hour' ? t('quota5h') : t('quota7d')}</span>
                <span className={`w-12 text-right font-semibold tabular-nums ${utilColor(tier.utilization)}`}>
                  {Math.round(tier.utilization)}%
                </span>
                {cd && (
                  <span className="ml-2 flex items-center gap-0.5 text-ink-faint">
                    <Clock size={12} />
                    {cd}
                  </span>
                )}
              </span>
            ) : (
              /* 紧凑模式（悬浮小窗）：每个时间窗独占一行，同样定宽成列 —
                 标签/百分比/倒计时跨供应商纵向对齐（百分比列右对齐）。 */
              <span key={tier.name} className="flex items-center whitespace-nowrap">
                <span className="w-11 text-ink-faint">{tier.name === 'five_hour' ? t('quota5h') : t('quota7d')}</span>
                <span className={`w-11 text-right font-semibold tabular-nums ${utilColor(tier.utilization)}`}>
                  {Math.round(tier.utilization)}%
                </span>
                {cd && (
                  <span className="ml-1.5 flex items-center gap-0.5 text-ink-faint">
                    <Clock size={10} />
                    {cd}
                  </span>
                )}
              </span>
            );
          })}
          {(q.tiers ?? []).length === 0 && <span className="text-ink-faint">—</span>}
        </span>
      )}
    </div>
  );
}

/** 当前活动 Antigravity 账号行：首行显账号邮箱，下方列 Claude 组的
 *  5小时/7天额度剩余量（Gemini 组及分组名已在主进程数据源裁掉）。
 *  roomy = 大窗宽松排版，缺省为悬浮小窗紧凑排版。
 *  布局与 QuotaRow 的 kimi/minimax 行严格对齐：供应商名列宽、时间窗
 *  标签/百分比/倒计时列宽均复用同一套尺寸，额度行缩进 = 名列宽 + 行内 gap，
 *  保证跨供应商纵向成列。
 *  百分比为“剩余”语义（区别于 kimi/minimax 的“已用”），故显式加“剩”前缀。 */
export function AgyQuotaRow({ data, roomy }: { data: AgyActiveQuota; roomy?: boolean }): JSX.Element {
  const t = useT();
  // 缩进 = QuotaRow 供应商名列宽（roomy w-24=96px / 紧凑 68px）+ 行内 gap（20px / 8px）
  const indent = roomy ? 'pl-[116px]' : 'pl-[76px]';
  return (
    <div className={roomy ? 'text-ui leading-7' : 'text-[11.5px] leading-5'}>
      <div className={`flex items-center ${roomy ? 'gap-5' : 'gap-2'}`}>
        <span className={`shrink-0 font-medium text-ink-soft ${roomy ? 'w-24' : 'w-[68px]'}`}>Antigravity</span>
        {data.email ? (
          <span className="min-w-0 flex-1 truncate text-ink-faint" title={data.email}>
            {data.email}
          </span>
        ) : null}
      </div>
      {!data.ok ? (
        <div className={`truncate text-ink-faint ${indent}`} title={data.error}>
          {t('quotaFailed')}
        </div>
      ) : data.groups.length > 0 ? (
        <div className={`flex min-w-0 ${roomy ? 'flex-wrap items-center gap-x-8 gap-y-0.5' : 'flex-col gap-1'} ${indent}`}>
          {data.groups.map((g) => {
            const remain = Math.max(0, Math.round(100 - g.utilization));
            const cd = countdown(g.resetsInSeconds ? Date.now() + g.resetsInSeconds * 1000 : undefined);
            return roomy ? (
              /* 宽松模式：与 QuotaRow 同宽成列（w-52 块 + w-12/w-12 子列，百分比右对齐） */
              <span key={g.group} className="flex w-52 items-center whitespace-nowrap">
                <span className="w-12 text-ink-faint">{g.group}</span>
                <span className={`w-12 text-right font-semibold tabular-nums ${remainColor(remain)}`}>
                  <span className="text-[0.85em] font-normal text-ink-faint">{t('quotaLeft')}</span>
                  {remain}%
                </span>
                {cd && (
                  <span className="ml-2 flex items-center gap-0.5 text-ink-faint">
                    <Clock size={12} />
                    {cd}
                  </span>
                )}
              </span>
            ) : (
              /* 紧凑模式（悬浮小窗）：与 QuotaRow 同宽成列（w-11/w-11 子列，百分比右对齐） */
              <span key={g.group} className="flex items-center whitespace-nowrap">
                <span className="w-11 text-ink-faint">{g.group}</span>
                <span className={`w-11 text-right font-semibold tabular-nums ${remainColor(remain)}`}>
                  <span className="text-[0.85em] font-normal text-ink-faint">{t('quotaLeft')}</span>
                  {remain}%
                </span>
                {cd && (
                  <span className="ml-1.5 flex items-center gap-0.5 text-ink-faint">
                    <Clock size={10} />
                    {cd}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      ) : (
        <div className={`text-ink-faint ${indent}`}>—</div>
      )}
    </div>
  );
}

// ------------------------------------------------------ sidebar flyout

/** 侧栏底部用量入口：悬浮展示今日用量精简小窗（请求次数 + 总/上行/下行
 *  token + 已配 key 供应商的余量），点击打开用量统计大窗。 */
export function UsageQuickButton(): JSX.Element {
  const t = useT();
  const lang = useChatStore((s) => s.settings?.language ?? 'zh');
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const [today, setToday] = useState<UsageStatsResult | null>(null);
  const { quotas } = useProviderQuotas(open);
  const { quota: agyQuota } = useActiveAgyQuota(open);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // 悬浮打开时拉当天聚合（kimi 已在主进程侧排除）
  useEffect(() => {
    if (!open) return;
    const now = Date.now();
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    void window.cyberslots
      .usageStats({ startTs: d.getTime(), endTs: now })
      .then(setToday)
      .catch(() => undefined);
  }, [open]);

  const show = (): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 180);
  };
  const hide = (): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 160);
  };
  const openBig = (): void => {
    window.clearTimeout(timer.current);
    setOpen(false);
    useChatStore.setState({ usageOpen: true });
  };

  const totals = today?.totals;
  /* totals 未到达时的占位 — 孤立「…」无动效不合规范，统一用行内品牌 spinner */
  const pending = <BrandSpinner size={11} />;

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      <button
        title={t('usageEntry')}
        onClick={openBig}
        className="rounded-md p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
      >
        {/* 圆形仪表盘 — 比折线图更能传达「用量/额度」语义 */}
        <CircleGauge size={15} />
      </button>
      {open && (
        /* fixed 锚在侧栏左下角上方 — 小窗比按钮宽得多，absolute right-0 对齐按钮
           会向左伸出窗口左缘被裁（实测）；锚定后完整落在侧栏区域内。 */
        <div className="fixed bottom-11 left-2 z-50 w-64 rounded-xl border border-line bg-bg-input p-3.5 shadow-lg">
          <div className="mb-2 text-[11px] font-semibold text-ink">{t('usageTodayTitle')}</div>
          <FlyRow label={t('usageTotalRequests')} value={totals ? fmtInt(totals.requests) : pending} />
          <FlyRow label={t('usageTotalTokens')} value={totals ? fmtShort(totals.totalTokens, lang) : pending} />
          <FlyRow label={`↑ ${t('usageUp')}`} value={totals ? fmtShort(totals.inputTokens, lang) : pending} />
          <FlyRow label={`↓ ${t('usageDown')}`} value={totals ? fmtShort(totals.outputTokens, lang) : pending} />
          {quotas === undefined ? (
            <div className="mt-2.5 flex items-center gap-1.5 border-t border-line pt-2.5 text-[11px] text-ink-faint">
              <BrandSpinner size={11} /> {t('quotaLoading')}
            </div>
          ) : quotas.length > 0 || agyQuota?.email ? (
            <div className="mt-2.5 flex flex-col gap-2 border-t border-line pt-2.5">
              {/* 排序：时间窗额度类（kimi/minimax）→ Antigravity → 余额类（deepseek）垫底 */}
              {quotas
                .filter((q) => q.provider !== 'deepseek')
                .map((q) => (
                  <QuotaRow key={q.provider} q={q} />
                ))}
              {/* 当前活动 agy 账号 + Claude 组 5小时/7天剩余量（Gemini 组源头已过滤；无活动账号则不显） */}
              {agyQuota?.email && <AgyQuotaRow data={agyQuota} />}
              {quotas
                .filter((q) => q.provider === 'deepseek')
                .map((q) => (
                  <QuotaRow key={q.provider} q={q} />
                ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function FlyRow({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between text-[11.5px] leading-6">
      <span className="text-ink-faint">{label}</span>
      <span className="font-medium tabular-nums text-ink">{value}</span>
    </div>
  );
}
