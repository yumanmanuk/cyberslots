/**
 * UsageView — 用量统计全屏覆盖层（侧栏左下角入口）。数据来自主进程对
 * messages/*.json 中 turn_end 统计行的聚合（usageStats IPC）：只看
 * 上行/下行 token 与请求次数，不含任何费用口径。顶部支持按引擎筛选
 * 与时间范围选择（预设 + 日历自定义），下方为汇总卡片 + 自绘 SVG 趋势图。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gauge,
  LayoutGrid,
  RefreshCw,
  Sparkles,
  Zap,
} from 'lucide-react';

import type { EngineId, UsageBucket, UsageStatsResult } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { BrandHero, BrandSpinner } from './brand';
import { useT, type MsgKey } from '../i18n';
import { EngineIcon, ENGINE_LABELS } from './EngineIcon';
import { fmtInt, fmtShort, OmpAccountsGrid, QuotaRow, useOmpQuota, useProviderQuotas } from './UsageQuota';

// kimi 不参与用量统计（无可靠的真实 token 上报），筛选器列其余引擎
// （omp 走 pi-ai 的真实 usage 上报，antigravity 走 agy result.usage，
//   claude 走 result.usage + total_cost_usd，均计入统计）。
const ENGINES: EngineId[] = ['codex', 'opencode', 'omp', 'antigravity', 'claude'];

// 趋势图序列色 — 固定品牌色（明暗主题下均有足够对比度），与 cc-switch 同源。
const COLOR_INPUT = '#3b82f6';
const COLOR_OUTPUT = '#22c55e';
const COLOR_CACHE = '#a855f7';
const COLOR_REQ = '#f97316';

const DAY_MS = 86_400_000;
const REFRESH_MS = 30_000;

// ---------------------------------------------------------------- range

type RangePreset = 'today' | '1d' | '7d' | '14d' | '30d' | 'custom';

interface RangeSel {
  preset: RangePreset;
  start?: number;
  end?: number;
  /** custom 模式下结束时间跟随当前时刻（查询时解析为 now）。 */
  liveEnd?: boolean;
}

const PRESETS: Array<{ id: Exclude<RangePreset, 'custom'>; key: MsgKey | null }> = [
  { id: 'today', key: 'usagePresetToday' },
  { id: '1d', key: null },
  { id: '7d', key: null },
  { id: '14d', key: null },
  { id: '30d', key: null },
];

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function resolveRange(sel: RangeSel, now = Date.now()): { start: number; end: number } {
  switch (sel.preset) {
    case 'today':
      return { start: dayStart(now), end: now };
    case '1d':
      return { start: now - DAY_MS, end: now };
    case '7d':
      return { start: dayStart(now - 6 * DAY_MS), end: now };
    case '14d':
      return { start: dayStart(now - 13 * DAY_MS), end: now };
    case '30d':
      return { start: dayStart(now - 29 * DAY_MS), end: now };
    case 'custom':
      return { start: sel.start ?? now - DAY_MS, end: sel.liveEnd ? now : (sel.end ?? now) };
  }
}

// ---------------------------------------------------------------- format

const pad2 = (n: number): string => String(n).padStart(2, '0');
const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
};
const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtDT = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${fmtTime(ms)}`;
};

/** 轴刻度上限取整到 1/2/5×10^k，避免顶格贴边。 */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  const mm = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return mm * p;
}

function fmtAxis(v: number): string {
  if (v >= 1_000_000) return `${Math.round(v / 100_000) / 10}M`;
  if (v >= 1000) return `${Math.round(v / 100) / 10}k`;
  return String(Math.round(v));
}

// ---------------------------------------------------------------- view

export default function UsageView(): JSX.Element | null {
  const t = useT();
  const open = useChatStore((s) => s.usageOpen);
  const lang = useChatStore((s) => s.settings?.language ?? 'zh');
  const [engine, setEngine] = useState<EngineId | 'all'>('all');
  const [range, setRange] = useState<RangeSel>({ preset: 'today' });
  const [data, setData] = useState<UsageStatsResult | null>(null);
  // 已配 key 供应商的套餐余量/余额（kimi/minimax/deepseek）
  const { quotas, refreshing: quotaRefreshing, refresh: refreshQuotas } = useProviderQuotas(open);
  // Antigravity 余量已暂隐藏：不再拉取/展示当前活动账号额度（恢复时取消下面注释并加回 AgyQuotaRow）
  // const { quota: agyActive, refreshing: agyRefreshing, refresh: refreshAgy } = useActiveAgyQuota(open);
  const { quota: ompActive, refreshing: ompRefreshing, refresh: refreshOmp } = useOmpQuota(open);

  const load = useCallback(async (): Promise<void> => {
    const { start, end } = resolveRange(range);
    try {
      setData(
        await window.cyberslots.usageStats({
          startTs: start,
          endTs: end,
          engine: engine === 'all' ? undefined : engine,
        }),
      );
    } catch {
      // 保留上一次数据，静默失败（主进程异常时不至于白屏）
    }
  }, [engine, range]);

  // 打开期间 30s 自动刷新（today/liveEnd 的 end 会随查询时刻推进）。
  useEffect(() => {
    if (!open) return;
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [open, load]);

  if (!open) return null;

  const close = (): void => useChatStore.setState({ usageOpen: false });

  const totals = data?.totals;
  const freshInput = Math.max(0, (totals?.inputTokens ?? 0) - (totals?.cachedTokens ?? 0));
  const hitRate = totals && totals.inputTokens > 0 ? totals.cachedTokens / totals.inputTokens : 0;
  const hitPercent = Math.max(0, Math.min(100, hitRate * 100));

  const rangeLabel =
    range.preset === 'custom'
      ? `${fmtDT(resolveRange(range).start)} – ${range.liveEnd ? '…' : fmtDT(resolveRange(range).end)}`
      : range.preset === 'today'
        ? t('usagePresetToday')
        : range.preset;

  const segCls = (on: boolean): string =>
    `flex h-7 items-center justify-center rounded-md px-2.5 transition ${on ? 'bg-bg-active text-ink shadow-sm' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
    }`;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg-canvas">
      <div className="px-6 pb-2 pt-3">
        <button
          onClick={close}
          className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-ui text-ink-soft transition hover:bg-bg-hover hover:text-ink"
        >
          <ArrowLeft size={15} /> {t('back')}
        </button>
      </div>

      <div className="scroll-quiet flex-1 overflow-y-auto px-6 pb-10">
        <div className="mx-auto w-full max-w-5xl">
          {/* 标题 + 筛选顶栏 */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-[20px] font-semibold text-ink">{t('usageEntry')}</h1>
              <p className="mt-0.5 text-ui text-ink-faint">{t('usageSubtitle')}</p>
            </div>
            <div className="flex items-center gap-2">
              {/* 引擎筛选 — 全部 / 单引擎 */}
              <div className="flex items-center gap-0.5 rounded-lg border border-line bg-bg-input p-0.5">
                <button title={t('usageAllEngines')} onClick={() => setEngine('all')} className={segCls(engine === 'all')}>
                  <LayoutGrid size={14} />
                </button>
                {ENGINES.map((e) => (
                  <button key={e} title={ENGINE_LABELS[e]} onClick={() => setEngine(e)} className={segCls(engine === e)}>
                    <EngineIcon engine={e} size={14} />
                  </button>
                ))}
              </div>
              <RangePicker sel={range} label={rangeLabel} onApply={setRange} />
            </div>
          </div>

          {/* 汇总卡片 */}
          <div className="mt-5 rounded-2xl border border-line bg-bg-panel p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-ui text-ink-faint">
                  <Zap size={14} className="text-accent" /> {t('usageTotalTokens')}
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-[30px] font-semibold leading-none tabular-nums text-ink">
                    {fmtInt(totals?.totalTokens ?? 0)}
                  </span>
                  {(totals?.totalTokens ?? 0) >= 10_000 && (
                    <span className="text-ui text-ink-faint">≈ {fmtShort(totals?.totalTokens ?? 0, lang)}</span>
                  )}
                </div>
              </div>
              <div className="rounded-xl border border-line bg-bg-input px-4 py-2.5 text-right">
                <div className="text-[11px] text-ink-faint">{t('usageTotalRequests')}</div>
                <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[17px] font-semibold tabular-nums text-ink">
                  <Activity size={14} className="text-info" /> {fmtInt(totals?.requests ?? 0)}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MiniStat icon={<ArrowDownToLine size={13} />} label={t('usageFreshInput')} value={fmtShort(freshInput, lang)} color={COLOR_INPUT} />
              <MiniStat icon={<ArrowUpFromLine size={13} />} label={t('usageOutput')} value={fmtShort(totals?.outputTokens ?? 0, lang)} color={COLOR_OUTPUT} />
              <MiniStat icon={<Sparkles size={13} />} label={t('usageCacheRead')} value={fmtShort(totals?.cachedTokens ?? 0, lang)} color={COLOR_CACHE} />
              <div className="rounded-xl border border-line bg-bg-input p-3.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-ink-faint">{t('usageCacheHitRate')}</span>
                  <span className="font-semibold tabular-nums text-ok">{hitPercent.toFixed(hitPercent >= 99.95 ? 0 : 1)}%</span>
                </div>
                <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-bg-active">
                  <div className="h-full rounded-full bg-ok transition-[width] duration-500" style={{ width: `${hitPercent}%` }} />
                </div>
              </div>
            </div>
          </div>

          {/* 套餐余量 — kimi/minimax/deepseek key 时展示（Antigravity 余量暂隐藏；恢复时条件加回 `|| agyActive?.email`） */}
          {(quotas && quotas.length > 0) && (
            <div className="mt-4 rounded-2xl border border-line bg-bg-panel p-5">
              <div className="mb-2.5 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                  <Gauge size={15} className="text-accent" /> {t('quotaTitle')}
                </h2>
                <button
                  title={t('quotaRefresh')}
                  onClick={() => refreshQuotas(true)}
                  disabled={quotaRefreshing}
                  className="rounded-md p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink disabled:pointer-events-none"
                >
                  {quotaRefreshing ? <BrandSpinner size={13} /> : <RefreshCw size={13} />}
                </button>
              </div>
              <div className="flex flex-col gap-2.5">
                {quotas?.filter((q) => q.provider !== 'deepseek').map((q) => (
                  <QuotaRow key={q.provider} q={q} roomy />
                ))}
                {/* Antigravity 余量行（暂隐藏）：{agyActive?.email && <AgyQuotaRow data={agyActive} roomy />} */}
                {quotas?.filter((q) => q.provider === 'deepseek').map((q) => (
                  <QuotaRow key={q.provider} q={q} roomy />
                ))}
              </div>
            </div>
          )}

          {/* Oh My Pi 账号额度卡片网格 */}
          {ompActive?.ok && ompActive.accounts.length > 0 && (
            <div className="mt-4 rounded-2xl border border-line bg-bg-panel p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[15px] font-semibold text-ink">Oh My Pi</h2>
                <button
                  title={t('quotaRefresh')}
                  onClick={() => refreshOmp(true)}
                  disabled={ompRefreshing}
                  className="rounded-md p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink disabled:pointer-events-none"
                >
                  {ompRefreshing ? <BrandSpinner size={13} /> : <RefreshCw size={13} />}
                </button>
              </div>
              <OmpAccountsGrid data={ompActive} />
            </div>
          )}

          {/* 使用趋势 */}
          <div className="mt-4 rounded-2xl border border-line bg-bg-panel p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-ink">{t('usageTrend')}</h2>
              <span className="text-ui text-ink-faint">{rangeLabel}</span>
            </div>
            {/* 统计未到达前占位同高度 — 面板级等待用 BrandHero，不让图表区塌陷成无指示空白 */}
            {data ? (
              <TrendChart result={data} lang={lang} />
            ) : (
              <div className="flex h-[280px] items-center justify-center">
                <BrandHero size={56} />
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-[11.5px] text-ink-soft">
              <LegendDot color={COLOR_INPUT} label={t('usageInputSeries')} />
              <LegendDot color={COLOR_OUTPUT} label={t('usageOutputSeries')} />
              <LegendDot color={COLOR_CACHE} label={t('usageCacheSeries')} />
              <LegendDot color={COLOR_REQ} label={t('usageReqSeries')} dashed />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-bg-input p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        <span style={{ color }}>{icon}</span> {label}
      </div>
      <div className="mt-1 text-[17px] font-semibold tabular-nums text-ink">{value}</div>
    </div>
  );
}

function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      {dashed ? (
        <svg width="14" height="4"><line x1="0" y1="2" x2="14" y2="2" stroke={color} strokeWidth="2" strokeDasharray="3 2" /></svg>
      ) : (
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      )}
      {label}
    </span>
  );
}

// ---------------------------------------------------------------- chart

interface ChartPoint {
  x: number;
  yIn: number;
  yOut: number;
  yCache: number;
  yReq: number;
}

/** 折线/面积趋势图 — 自绘 SVG（项目无图表库依赖）。左轴 tokens、右轴请求次数。 */
function TrendChart({ result, lang }: { result: UsageStatsResult; lang: 'zh' | 'en' }): JSX.Element {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const H = 280;
  const PAD = { l: 48, r: 44, t: 14, b: 26 };
  const buckets = result.buckets;
  const n = buckets.length;
  const hourly = result.bucketMs < DAY_MS;

  const { maxTok, maxReq, points } = useMemo(() => {
    let mt = 0;
    let mr = 0;
    for (const b of buckets) {
      mt = Math.max(mt, Math.max(0, b.inputTokens - b.cachedTokens), b.outputTokens, b.cachedTokens);
      mr = Math.max(mr, b.requests);
    }
    const maxT = niceCeil(mt);
    const maxR = niceCeil(mr);
    const plotW = Math.max(0, width - PAD.l - PAD.r);
    const plotH = H - PAD.t - PAD.b;
    const pts: ChartPoint[] = buckets.map((b, i) => {
      const frac = n <= 1 ? 0.5 : i / (n - 1);
      return {
        x: PAD.l + frac * plotW,
        yIn: PAD.t + (1 - Math.max(0, b.inputTokens - b.cachedTokens) / maxT) * plotH,
        yOut: PAD.t + (1 - b.outputTokens / maxT) * plotH,
        yCache: PAD.t + (1 - b.cachedTokens / maxT) * plotH,
        yReq: PAD.t + (1 - b.requests / maxR) * plotH,
      };
    });
    return { maxTok: maxT, maxReq: maxR, points: pts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, width, n]);

  const baseY = H - PAD.b;
  const first = points[0];
  const last = points[points.length - 1];

  const areaOf = (path: string): string =>
    path && first && last ? `${path} L${last.x},${baseY} L${first.x},${baseY} Z` : '';

  const pIn = smoothPath(points.map((p) => ({ x: p.x, y: p.yIn })));
  const pOut = smoothPath(points.map((p) => ({ x: p.x, y: p.yOut })));
  const pCache = smoothPath(points.map((p) => ({ x: p.x, y: p.yCache })));
  const pReq = smoothPath(points.map((p) => ({ x: p.x, y: p.yReq })));

  const bucketLabel = (ts: number): string =>
    hourly ? `${pad2(new Date(ts).getMonth() + 1)}/${pad2(new Date(ts).getDate())} ${pad2(new Date(ts).getHours())}:00` : `${pad2(new Date(ts).getMonth() + 1)}/${pad2(new Date(ts).getDate())}`;

  // X 轴稀疏刻度（约 6 个）
  const xTicks = useMemo(() => {
    const step = Math.max(1, Math.ceil(n / 6));
    const out: Array<{ x: number; label: string }> = [];
    for (let i = 0; i < n; i += step) {
      const b = buckets[i];
      const p = points[i];
      if (b && p) out.push({ x: p.x, label: bucketLabel(b.ts) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, points, n, hourly]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (!n || !width) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const plotW = Math.max(1, width - PAD.l - PAD.r);
    const frac = Math.max(0, Math.min(1, (mx - PAD.l) / plotW));
    setHover(Math.round(frac * (n - 1)));
  };

  const hovered = hover != null ? buckets[hover] : undefined;
  const hoverPt = hover != null ? points[hover] : undefined;
  const empty = result.totals.requests === 0;

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      {width > 0 && (
        <svg width={width} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="usage-grad-in" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLOR_INPUT} stopOpacity={0.18} />
              <stop offset="95%" stopColor={COLOR_INPUT} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="usage-grad-out" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLOR_OUTPUT} stopOpacity={0.18} />
              <stop offset="95%" stopColor={COLOR_OUTPUT} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="usage-grad-cache" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLOR_CACHE} stopOpacity={0.18} />
              <stop offset="95%" stopColor={COLOR_CACHE} stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* 横向网格 + 左右轴刻度 */}
          {[0, 1, 2, 3, 4].map((i) => {
            const y = PAD.t + (i / 4) * (H - PAD.t - PAD.b);
            const vTok = maxTok * (1 - i / 4);
            const vReq = maxReq * (1 - i / 4);
            return (
              <g key={i}>
                <line x1={PAD.l} y1={y} x2={width - PAD.r} y2={y} stroke="var(--line)" strokeDasharray="3 3" opacity={0.6} />
                <text x={PAD.l - 6} y={y + 3.5} textAnchor="end" fontSize={10.5} fill="var(--ink-faint)">
                  {fmtAxis(vTok)}
                </text>
                <text x={width - PAD.r + 6} y={y + 3.5} textAnchor="start" fontSize={10.5} fill={COLOR_REQ} opacity={0.85}>
                  {fmtAxis(vReq)}
                </text>
              </g>
            );
          })}

          {/* X 轴标签 */}
          {xTicks.map((tk, i) => (
            <text key={i} x={tk.x} y={H - 8} textAnchor="middle" fontSize={10.5} fill="var(--ink-faint)">
              {tk.label}
            </text>
          ))}

          {/* 面积 + 折线 */}
          {!empty && (
            <>
              <path d={areaOf(pCache)} fill="url(#usage-grad-cache)" />
              <path d={areaOf(pIn)} fill="url(#usage-grad-in)" />
              <path d={areaOf(pOut)} fill="url(#usage-grad-out)" />
              <path d={pCache} fill="none" stroke={COLOR_CACHE} strokeWidth={2} />
              <path d={pIn} fill="none" stroke={COLOR_INPUT} strokeWidth={2} />
              <path d={pOut} fill="none" stroke={COLOR_OUTPUT} strokeWidth={2} />
              <path d={pReq} fill="none" stroke={COLOR_REQ} strokeWidth={1.8} strokeDasharray="4 3" />
            </>
          )}

          {/* 悬停参考线 + 数据点 */}
          {hovered && hoverPt && (
            <g>
              <line x1={hoverPt.x} y1={PAD.t} x2={hoverPt.x} y2={baseY} stroke="var(--ink-faint)" strokeDasharray="3 3" opacity={0.7} />
              <circle cx={hoverPt.x} cy={hoverPt.yIn} r={3} fill={COLOR_INPUT} />
              <circle cx={hoverPt.x} cy={hoverPt.yOut} r={3} fill={COLOR_OUTPUT} />
              <circle cx={hoverPt.x} cy={hoverPt.yCache} r={3} fill={COLOR_CACHE} />
              <circle cx={hoverPt.x} cy={hoverPt.yReq} r={3} fill={COLOR_REQ} />
            </g>
          )}
        </svg>
      )}

      {/* 空态提示 */}
      {empty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-ui text-ink-faint">
          {t('usageNoData')}
        </div>
      )}

      {/* 悬停浮层 */}
      {hovered && hoverPt && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-line bg-bg-input px-3 py-2 shadow-lg"
          style={{ left: Math.max(4, Math.min(hoverPt.x - 78, width - 176)), top: 4 }}
        >
          <div className="mb-1 text-[11px] font-medium text-ink">{bucketLabel(hovered.ts)}</div>
          <TooltipRow color={COLOR_INPUT} label={t('usageInputSeries')} value={fmtShort(Math.max(0, hovered.inputTokens - hovered.cachedTokens), lang)} />
          <TooltipRow color={COLOR_OUTPUT} label={t('usageOutputSeries')} value={fmtShort(hovered.outputTokens, lang)} />
          <TooltipRow color={COLOR_CACHE} label={t('usageCacheSeries')} value={fmtShort(hovered.cachedTokens, lang)} />
          <TooltipRow color={COLOR_REQ} label={t('usageReqSeries')} value={fmtInt(hovered.requests)} />
        </div>
      )}
    </div>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-ink-soft">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      <span>{label}</span>
      <span className="ml-auto pl-3 font-medium tabular-nums text-ink">{value}</span>
    </div>
  );
}

/** 相邻点间用对称三次贝塞尔平滑（控制点取中点，纵向不越界）。 */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  const head = pts[0];
  if (!head) return '';
  let d = `M${head.x},${head.y}`;
  let prev = head;
  for (const p of pts.slice(1)) {
    const mx = (prev.x + p.x) / 2;
    d += ` C${mx},${prev.y} ${mx},${p.y} ${p.x},${p.y}`;
    prev = p;
  }
  return d;
}

// ---------------------------------------------------------------- picker

/** 时间范围选择器 — 预设快捷键 + 起止日期时间 + 日历面板（参照 cc-switch 交互）。 */
function RangePicker({ sel, label, onApply }: { sel: RangeSel; label: string; onApply: (s: RangeSel) => void }): JSX.Element {
  const t = useT();
  const lang = useChatStore((s) => s.settings?.language ?? 'zh');
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(0);
  const [draftEnd, setDraftEnd] = useState(0);
  const [liveEnd, setLiveEnd] = useState(false);
  const [field, setField] = useState<'start' | 'end'>('start');
  const [month, setMonth] = useState(() => new Date());
  const [err, setErr] = useState(false);

  // 打开时以当前选择初始化草稿
  useEffect(() => {
    if (!open) return;
    const r = resolveRange(sel);
    setDraftStart(r.start);
    setDraftEnd(r.end);
    setLiveEnd(sel.preset === 'custom' ? (sel.liveEnd ?? false) : false);
    setField('start');
    const s = new Date(r.start);
    setMonth(new Date(s.getFullYear(), s.getMonth(), 1));
    setErr(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // liveEnd 勾选期间结束时间每秒跟随当前时刻
  useEffect(() => {
    if (!open || !liveEnd) return;
    setDraftEnd(Date.now());
    const id = window.setInterval(() => setDraftEnd(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open, liveEnd]);

  const days = useMemo(() => calendarDays(month), [month]);
  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'narrow' });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 7 + i)));
  }, [lang]);

  const pickDay = (day: Date): void => {
    setErr(false);
    if (liveEnd) {
      setDraftStart(setDateKeepTime(draftStart, day));
      return;
    }
    const next = setDateKeepTime(field === 'start' ? draftStart : draftEnd, day);
    if (field === 'start') {
      setDraftStart(next);
      if (next > draftEnd) setDraftEnd(next);
      setField('end');
    } else if (next < draftStart) {
      setDraftStart(next);
      setField('end');
    } else {
      setDraftEnd(next);
    }
    if (day.getMonth() !== month.getMonth() || day.getFullYear() !== month.getFullYear()) {
      setMonth(new Date(day.getFullYear(), day.getMonth(), 1));
    }
  };

  const apply = (): void => {
    if (draftStart > draftEnd) {
      setErr(true);
      return;
    }
    onApply({ preset: 'custom', start: draftStart, end: draftEnd, liveEnd });
    setOpen(false);
  };

  const startDay = dayStart(draftStart);
  const endDay = dayStart(draftEnd);
  const todayMs = dayStart(Date.now());

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={label}
        className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-ui transition ${sel.preset === 'custom' ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-bg-input text-ink-soft hover:text-ink'
          }`}
      >
        <CalendarDays size={14} />
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDown size={13} className="opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1.5 w-[540px] rounded-xl border border-line bg-bg-input p-3.5 shadow-lg">
            {/* 预设快捷键 */}
            <div className="flex flex-wrap gap-1.5 border-b border-line pb-2.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onApply({ preset: p.id });
                    setOpen(false);
                  }}
                  className={`rounded-lg px-2.5 py-1 text-ui transition ${sel.preset === p.id ? 'bg-accent font-medium text-white' : 'bg-bg-hover text-ink-soft hover:text-ink'
                    }`}
                >
                  {p.key ? t(p.key) : p.id}
                </button>
              ))}
            </div>

            <div className="mt-3 flex gap-4">
              {/* 左列：起止时间字段 */}
              <div className="flex w-[200px] shrink-0 flex-col gap-2">
                <p className="text-[11px] text-ink-faint">{t('usageRangeHint')}</p>
                <TimeField
                  label={t('usageStartTime')}
                  ts={draftStart}
                  active={field === 'start' || liveEnd}
                  onFocus={() => setField('start')}
                  onTime={(h, m) => setDraftStart(setTimeOfDay(draftStart, h, m))}
                />
                <TimeField
                  label={t('usageEndTime')}
                  ts={draftEnd}
                  active={field === 'end' && !liveEnd}
                  disabled={liveEnd}
                  onFocus={() => !liveEnd && setField('end')}
                  onTime={(h, m) => setDraftEnd(setTimeOfDay(draftEnd, h, m))}
                />
                <button onClick={() => setLiveEnd(!liveEnd)} className="mt-0.5 flex items-center gap-2 text-left text-[11.5px] text-ink-soft transition hover:text-ink">
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${liveEnd ? 'border-accent bg-accent text-white' : 'border-line bg-bg'
                      }`}
                  >
                    {liveEnd && <Check size={11} />}
                  </span>
                  {t('usageLiveEnd')}
                </button>
                {err && <p className="text-[11px] text-err">{t('usageInvalidRange')}</p>}
                <div className="mt-auto flex gap-2 pt-2">
                  <button onClick={() => setOpen(false)} className="flex-1 rounded-lg px-3 py-1.5 text-ui text-ink-soft transition hover:bg-bg-hover hover:text-ink">
                    {t('cancel')}
                  </button>
                  <button onClick={apply} className="flex-1 rounded-lg bg-accent px-3 py-1.5 text-ui font-medium text-white transition hover:opacity-90">
                    {t('usageConfirm')}
                  </button>
                </div>
              </div>

              {/* 右列：日历 */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between px-1">
                  <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
                    <ChevronLeft size={14} />
                  </button>
                  <span className="text-ui font-medium text-ink">
                    {lang === 'zh' ? `${month.getFullYear()}年${month.getMonth() + 1}月` : month.toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}
                  </span>
                  <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
                    <ChevronRight size={14} />
                  </button>
                </div>
                <div className="mt-1.5 grid grid-cols-7 gap-y-0.5">
                  {weekdays.map((w, i) => (
                    <div key={i} className="flex h-7 items-center justify-center text-[10.5px] text-ink-faint">
                      {w}
                    </div>
                  ))}
                  {days.map((d) => {
                    const ms = d.getTime();
                    const inMonth = d.getMonth() === month.getMonth();
                    const isStart = ms === startDay;
                    const isEnd = ms === endDay;
                    const inRange = ms > startDay && ms < endDay;
                    return (
                      <button
                        key={ms}
                        onClick={() => pickDay(d)}
                        className={`mx-auto flex h-7 w-7 items-center justify-center rounded-md text-[11.5px] tabular-nums transition ${isStart || isEnd
                          ? 'bg-accent font-medium text-white'
                          : inRange
                            ? 'bg-accent-soft text-accent'
                            : ms === todayMs
                              ? 'font-semibold text-accent hover:bg-bg-hover'
                              : inMonth
                                ? 'text-ink hover:bg-bg-hover'
                                : 'text-ink-faint opacity-50 hover:bg-bg-hover'
                          }`}
                      >
                        {d.getDate()}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TimeField({
  label,
  ts,
  active,
  disabled,
  onFocus,
  onTime,
}: {
  label: string;
  ts: number;
  active: boolean;
  disabled?: boolean;
  onFocus: () => void;
  onTime: (h: number, m: number) => void;
}): JSX.Element {
  return (
    <div
      onClick={onFocus}
      className={`cursor-pointer rounded-xl border px-3 py-2 transition ${active ? 'border-accent bg-accent-soft/30' : 'border-line bg-bg'
        } ${disabled ? 'opacity-60' : ''}`}
    >
      <div className="text-[11px] text-ink-faint">{label}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="text-ui tabular-nums text-ink">{fmtDate(ts)}</span>
        <input
          type="time"
          disabled={disabled}
          value={fmtTime(ts)}
          onChange={(e) => {
            const [h, m] = e.target.value.split(':').map(Number);
            if (Number.isFinite(h) && Number.isFinite(m)) onTime(h ?? 0, m ?? 0);
          }}
          className="rounded-md border border-line bg-bg-input px-1 py-0.5 text-[11.5px] tabular-nums text-ink outline-none"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------- date helpers

/** 6 行 × 7 列日历网格（从所在周的周日起排 42 天）。 */
function calendarDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/** 替换时间戳的日期部分，保留原时分。 */
function setDateKeepTime(ts: number, day: Date): number {
  const d = new Date(ts);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), d.getHours(), d.getMinutes()).getTime();
}

/** 替换时间戳的时分部分。 */
function setTimeOfDay(ts: number, h: number, m: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
}
