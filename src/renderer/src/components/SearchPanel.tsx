/**
 * SearchPanel — 侧栏全局搜索面板。搜索会话标题和消息内容，
 * 结果列表展示匹配摘要（关键词高亮），点击跳转到对应位置。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

import type { SearchHit } from '@shared/ipc';
import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import { EngineIcon } from './EngineIcon';
import { BrandSpinner } from './brand';

/** 搜索防抖延迟（毫秒）。 */
const DEBOUNCE_MS = 250;

let nonceCounter = 0;

export default function SearchPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT();
  const sessions = useChatStore((s) => s.sessions);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // 自动聚焦
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 防抖搜索
  const doSearch = useCallback((q: string) => {
    clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const hits = await window.cyberslots.sessionSearch({ query: q, limit: 50 });
        setResults(hits);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, DEBOUNCE_MS);
  }, []);

  const onChange = (value: string): void => {
    setQuery(value);
    doSearch(value);
  };

  const onHitClick = (hit: SearchHit): void => {
    // 切到目标会话
    useChatStore.getState().selectSession(hit.sessionId);
    // 设置搜索高亮（ChatView 消费后滚动 + 高亮）
    if (hit.messageId) {
      useChatStore.setState({
        searchHighlight: {
          sessionId: hit.sessionId,
          messageId: hit.messageId,
          query: query.trim(),
          nonce: ++nonceCounter,
        },
      });
    }
    onClose();
  };

  // 根据 sessionId 查找会话元数据
  const findMeta = (id: string) => sessions.find((m) => m.id === id);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 搜索输入框 */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Search size={14} className="shrink-0 text-ink-faint" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        {query && (
          <button
            onClick={() => { setQuery(''); setResults([]); inputRef.current?.focus(); }}
            className="shrink-0 rounded-md p-0.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* 结果列表 */}
      <div className="scroll-quiet flex-1 overflow-y-auto px-2 py-1">
        {searching && query.trim() && (
          <div className="flex items-center justify-center py-6">
            <BrandSpinner size={16} />
          </div>
        )}
        {!searching && query.trim() && results.length === 0 && (
          <div className="py-6 text-center text-xs text-ink-faint">{t('searchNoResults')}</div>
        )}
        {results.map((hit, i) => {
          const meta = findMeta(hit.sessionId);
          if (!meta) return null;
          return (
            <button
              key={`${hit.sessionId}-${hit.messageId ?? 'title'}-${i}`}
              onClick={() => onHitClick(hit)}
              className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-bg-hover"
            >
              <div className="flex items-center gap-2">
                <EngineIcon engine={meta.engine} size={13} className="shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-ui font-medium text-ink">
                  <HighlightText text={meta.title} query={query} />
                </span>
                <span className="shrink-0 text-[10px] text-ink-faint">
                  {hit.kind === 'title' ? t('searchTitleMatch') : t('searchContentMatch')}
                </span>
              </div>
              {hit.kind === 'content' && (
                <div className="line-clamp-2 pl-[21px] text-xs leading-relaxed text-ink-soft">
                  <HighlightText text={hit.snippet} query={query} />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 匹配关键词高亮组件：将文本中所有匹配 query 的部分用 accent 色高亮。 */
function HighlightText({ text, query }: { text: string; query: string }): JSX.Element {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;

  const parts: JSX.Element[] = [];
  const lower = text.toLowerCase();
  let cursor = 0;

  while (cursor < text.length) {
    const idx = lower.indexOf(q, cursor);
    if (idx < 0) {
      parts.push(<span key={cursor}>{text.slice(cursor)}</span>);
      break;
    }
    if (idx > cursor) {
      parts.push(<span key={cursor}>{text.slice(cursor, idx)}</span>);
    }
    parts.push(
      <mark key={`m${idx}`} className="rounded-sm bg-accent/20 text-accent">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    cursor = idx + q.length;
  }

  return <>{parts}</>;
}
