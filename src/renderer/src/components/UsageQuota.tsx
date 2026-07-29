/**
 * UsageQuota — 用量/余量共享 UI：
 * - useProviderQuotas：供应商套餐余量查询 hook（主进程代查带缓存）
 * - QuotaRow：单个供应商余量行（kimi/minimax 时间窗徽章、deepseek 余额）
 * - UsageQuickButton：侧栏底部入口（悬浮 → 今日用量精简小窗；点击 → 用量大窗）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleGauge, Clock } from 'lucide-react';

import type { ProviderQuotaInfo, QuotaProviderId, UsageStatsResult } from '@shared/types';
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
                 倒计时纵向对齐（百分比位数不同不再抽动后续列）。 */
              <span key={tier.name} className="flex w-52 items-center whitespace-nowrap">
                <span className="w-12 text-ink-faint">{tier.name === 'five_hour' ? t('quota5h') : t('quota7d')}</span>
                <span className={`w-12 font-semibold tabular-nums ${utilColor(tier.utilization)}`}>
                  {Math.round(tier.utilization)}%
                </span>
                {cd && (
                  <span className="flex items-center gap-0.5 text-ink-faint">
                    <Clock size={12} />
                    {cd}
                  </span>
                )}
              </span>
            ) : (
              /* 紧凑模式（悬浮小窗）：每个时间窗独占一行，同样定宽成列 —
                 Kimi/MiniMax 两行的标签/百分比/倒计时跨供应商纵向对齐。 */
              <span key={tier.name} className="flex items-center whitespace-nowrap">
                <span className="w-11 text-ink-faint">{tier.name === 'five_hour' ? t('quota5h') : t('quota7d')}</span>
                <span className={`w-11 font-semibold tabular-nums ${utilColor(tier.utilization)}`}>
                  {Math.round(tier.utilization)}%
                </span>
                {cd && (
                  <span className="flex items-center gap-0.5 text-ink-faint">
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
          <FlyRow label={t('usageTotalRequests')} value={totals ? fmtInt(totals.requests) : '…'} />
          <FlyRow label={t('usageTotalTokens')} value={totals ? fmtShort(totals.totalTokens, lang) : '…'} />
          <FlyRow label={`↑ ${t('usageUp')}`} value={totals ? fmtShort(totals.inputTokens, lang) : '…'} />
          <FlyRow label={`↓ ${t('usageDown')}`} value={totals ? fmtShort(totals.outputTokens, lang) : '…'} />
          {quotas === undefined ? (
            <div className="mt-2.5 flex items-center gap-1.5 border-t border-line pt-2.5 text-[11px] text-ink-faint">
              <BrandSpinner size={11} /> {t('quotaLoading')}
            </div>
          ) : quotas.length > 0 ? (
            <div className="mt-2.5 flex flex-col gap-2 border-t border-line pt-2.5">
              {quotas.map((q) => (
                <QuotaRow key={q.provider} q={q} />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function FlyRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between text-[11.5px] leading-6">
      <span className="text-ink-faint">{label}</span>
      <span className="font-medium tabular-nums text-ink">{value}</span>
    </div>
  );
}
