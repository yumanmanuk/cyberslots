/**
 * OpencodeModelPicker — opencode 会话专用的完整版模型选择器
 * （openchamber 风格）：搜索 / 收藏 / RECENT / provider 分组 /
 * 底部能力详情条。数据源 = opencodeCatalogGet（/config/providers，
 * 只含已连接+启用的模型；不做「未连接置灰」）。
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Image as ImageIcon, RefreshCw, Search, Star } from 'lucide-react';

import type { OpencodeModelEntry } from '@shared/types';
import { useChatStore } from '../store/chatStore';

const RECENT_KEY = 'cs.opencodeRecentModels';
const FAV_KEY = 'cs.opencodeFavModels';
const RECENT_MAX = 5;

function readList(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]): void {
  localStorage.setItem(key, JSON.stringify(list));
}

export default function OpencodeModelPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const uiModels = useChatStore((s) => s.ui[sessionId]?.models);
  const catalog = useChatStore((s) => s.opencodeCatalog);
  const loadCatalog = useChatStore((s) => s.loadOpencodeCatalog);
  const setModel = useChatStore((s) => s.setModel);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readList(RECENT_KEY));
  const [favs, setFavs] = useState<string[]>(() => readList(FAV_KEY));

  // 懒加载目录（拉取会按需启动 opencode server —— 与会话启动同一进程，无额外开销）。
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const models = useMemo(() => catalog?.models ?? [], [catalog]);
  const bySlug = useMemo(() => new Map(models.map((m) => [m.slug, m])), [models]);
  // 恢复态兜底：models.update 未到时用持久化的 meta.modelId。
  const current = uiModels?.current || meta?.modelId || '';

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? models.filter(
          (m) =>
            m.slug.toLowerCase().includes(q) ||
            (m.displayName ?? '').toLowerCase().includes(q) ||
            m.providerName.toLowerCase().includes(q),
        )
        : models,
    [models, q],
  );
  /** provider 分组（保持 catalog 顺序）。 */
  const groups = useMemo(() => {
    const out = new Map<string, OpencodeModelEntry[]>();
    for (const m of filtered) {
      const list = out.get(m.providerName) ?? [];
      list.push(m);
      out.set(m.providerName, list);
    }
    return out;
  }, [filtered]);

  if (!current && !models.length && !catalog?.error) {
    // 目录还没加载且无持久化模型 — 显示占位（保持控件条布局稳定）。
    return (
      <button className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui text-ink-faint" disabled>
        <span className="animate-pulse">模型加载中…</span>
      </button>
    );
  }

  const activeEntry = bySlug.get(current);
  const detailSlug = hover ?? current;
  const detail = bySlug.get(detailSlug);

  const pick = (slug: string): void => {
    setOpen(false);
    void setModel(slug);
    const nextRecent = [slug, ...recent.filter((s) => s !== slug)].slice(0, RECENT_MAX);
    setRecent(nextRecent);
    writeList(RECENT_KEY, nextRecent);
    // 换模型后：已显式选过的思考深度不被新模型支持时重置为其默认档。
    const efforts = bySlug.get(slug)?.efforts;
    const cur = useChatStore.getState().efforts[sessionId];
    if (cur && !(efforts ?? []).includes(cur)) {
      useChatStore.setState((s) => {
        const next = { ...s.efforts };
        delete next[sessionId];
        return { efforts: next };
      });
    }
  };

  const toggleFav = (slug: string): void => {
    const next = favs.includes(slug) ? favs.filter((s) => s !== slug) : [...favs, slug];
    setFavs(next);
    writeList(FAV_KEY, next);
  };

  const row = (m: OpencodeModelEntry): JSX.Element => (
    <div
      key={m.slug}
      onMouseEnter={() => setHover(m.slug)}
      onMouseLeave={() => setHover(null)}
      className={`group flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-ui transition hover:bg-bg-hover ${m.slug === current ? 'font-semibold text-accent' : 'text-ink'
        }`}
      onClick={() => pick(m.slug)}
    >
      <span className="min-w-0 flex-1 truncate">{m.displayName ?? m.modelID}</span>
      <span className="flex shrink-0 items-center gap-1 text-[10px] text-ink-faint">
        {m.contextWindow ? fmtCtx(m.contextWindow) : ''}
        {m.inputModalities?.includes('image') && <ImageIcon size={10} />}
        {(m.costInput ?? 1) === 0 && (m.costOutput ?? 1) === 0 && (
          <span className="rounded bg-ok/15 px-1 py-px text-[9px] font-medium text-ok">免费</span>
        )}
      </span>
      <button
        title={favs.includes(m.slug) ? '取消收藏' : '收藏'}
        onClick={(e) => {
          e.stopPropagation();
          toggleFav(m.slug);
        }}
        className={`shrink-0 rounded p-0.5 transition ${favs.includes(m.slug) ? 'text-warn' : 'text-ink-faint/40 opacity-0 hover:text-warn group-hover:opacity-100'
          }`}
      >
        <Star size={11} fill={favs.includes(m.slug) ? 'currentColor' : 'none'} />
      </button>
    </div>
  );

  const favModels = favs.map((s) => bySlug.get(s)).filter((m): m is OpencodeModelEntry => !!m && filtered.includes(m));
  const recentModels = recent
    .map((s) => bySlug.get(s))
    .filter((m): m is OpencodeModelEntry => !!m && filtered.includes(m));

  return (
    <div className="relative min-w-0">
      <button
        onClick={() => setOpen(!open)}
        title={activeEntry?.displayName ?? current}
        className="flex w-full min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
      >
        <span className="min-w-0 truncate font-medium">{activeEntry?.displayName ?? (current || '选择模型')}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-9 right-0 z-20 flex w-80 flex-col overflow-hidden rounded-xl border border-line bg-bg-input shadow-lg">
            {/* 搜索框 */}
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Search size={12} className="shrink-0 text-ink-faint" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索模型…"
                className="w-full bg-transparent text-ui outline-none placeholder:text-ink-faint"
              />
              <button
                title="刷新模型目录"
                onClick={() => void loadCatalog(true)}
                className="shrink-0 rounded p-0.5 text-ink-faint transition hover:text-ink"
              >
                <RefreshCw size={11} />
              </button>
            </div>
            {/* 列表 */}
            <div className="max-h-72 overflow-y-auto py-1">
              {catalog?.error && (
                <div className="px-3 py-2 text-[11px] leading-5 text-err">
                  模型目录加载失败：{catalog.error}
                </div>
              )}
              {!catalog && <div className="animate-pulse px-3 py-2 text-[11px] text-ink-faint">加载中…</div>}
              {favModels.length > 0 && !q && (
                <>
                  <GroupTitle label="收藏" />
                  {favModels.map(row)}
                </>
              )}
              {recentModels.length > 0 && !q && (
                <>
                  <GroupTitle label="最近使用" />
                  {recentModels.map(row)}
                </>
              )}
              {[...groups.entries()].map(([provider, list]) => (
                <div key={provider}>
                  <GroupTitle label={provider} />
                  {list.map(row)}
                </div>
              ))}
              {catalog && !filtered.length && !catalog.error && (
                <div className="px-3 py-2 text-[11px] text-ink-faint">无匹配模型</div>
              )}
            </div>
            {/* 详情条（hover/当前模型的能力、模态、价格、上下文） */}
            {detail && (
              <div className="space-y-0.5 border-t border-line bg-bg-panel/60 px-3 py-2 text-[10.5px] leading-4 text-ink-soft">
                <DetailRow k="能力" v={[detail.toolCall && 'Tool calling', detail.reasoning && 'Reasoning', detail.attachment && '附件'].filter(Boolean).join(' · ') || '—'} />
                <DetailRow k="输入/输出" v={`${(detail.inputModalities ?? ['text']).join(',')} → ${(detail.outputModalities ?? ['text']).join(',')}`} />
                <DetailRow k="价格 $/1M" v={detail.costInput === 0 && detail.costOutput === 0 ? '免费' : `In $${detail.costInput ?? '?'} · Out $${detail.costOutput ?? '?'}`} />
                {detail.contextWindow ? <DetailRow k="上下文" v={fmtCtx(detail.contextWindow)} /> : null}
              </div>
            )}
            {/* provider 引导（不做连接管理 — 委托 opencode 自身） */}
            <div className="border-t border-line px-3 py-1.5 text-[10px] text-ink-faint">
              连接更多 provider：在终端运行 <span className="font-mono">opencode auth login</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function GroupTitle({ label }: { label: string }): JSX.Element {
  return (
    <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{label}</div>
  );
}

function DetailRow({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0 text-ink-faint">{k}</span>
      <span className="min-w-0 truncate text-right">{v}</span>
    </div>
  );
}

function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${n % 1_000_000 === 0 ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}
