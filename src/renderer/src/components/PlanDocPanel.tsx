/**
 * PlanDocPanel — right-side markdown preview for plan-mode output:
 * full rendered plan with copy / download / implement.
 *
 * 批注功能：
 *  1. 选中文字 → 自动弹出批注输入框
 *  2. 确认后被批注文字添加高亮背景色 + 右侧小图标
 *  3. 点击图标可编辑 / 删除批注
 *  4. 积累批注后点「根据批注重审方案」发给 AI 重新规划
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Download, MessageSquare, NotebookText, Play, RefreshCw, Trash2, X } from 'lucide-react';

import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import { downloadMarkdown, extractPlanTitle } from '../planDoc';
import MdLink from './MdLink';
import MdPre from './MdCodeBlock';

// ── Types ──────────────────────────────────────────────────────

interface PlanAnnotation {
  id: string;
  selectedText: string;
  comment: string;
}

interface PopupState {
  top: number;
  left: number;
  selectedText: string;
  /** 非空 = 编辑已有批注；空 = 新建。 */
  editingId?: string;
}

interface HighlightInfo {
  id: string;
  rects: { top: number; left: number; width: number; height: number }[];
  iconTop: number;
  iconRight: number;
}

// ── Helpers ────────────────────────────────────────────────────

/** 在容器的 DOM 文本节点中查找 searchText，返回对应的 Range；
 *  先尝试精确匹配单节点，再尝试跨节点拼接匹配（选区跨段落时 toString 含 \n，
 *  但 DOM 文本节点间无换行符，因此需要 whitespace-normalized 的 fallback）。 */
function findTextRange(container: HTMLElement, searchText: string): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Text | null;
  while ((n = walker.nextNode() as Text | null)) nodes.push(n);

  // 精确匹配（单节点 —— 覆盖 90% 场景）
  for (const tn of nodes) {
    const c = tn.textContent ?? '';
    const idx = c.indexOf(searchText);
    if (idx >= 0) {
      const r = document.createRange();
      r.setStart(tn, idx);
      r.setEnd(tn, idx + searchText.length);
      return r;
    }
  }

  // 跨节点匹配：拼接所有文本字符 → 逐字符映射回 node+offset → 搜索。
  const charMap: { node: Text; offset: number }[] = [];
  let full = '';
  for (const tn of nodes) {
    const c = tn.textContent ?? '';
    for (let i = 0; i < c.length; i++) {
      charMap.push({ node: tn, offset: i });
      full += c[i];
    }
  }

  // 先精确搜索拼接后全文
  let idx = full.indexOf(searchText);
  if (idx >= 0 && idx + searchText.length <= charMap.length) {
    const r = document.createRange();
    r.setStart(charMap[idx]!.node, charMap[idx]!.offset);
    const e = charMap[idx + searchText.length - 1]!;
    r.setEnd(e.node, e.offset + 1);
    return r;
  }

  // whitespace-normalized 降级（选区含 \n 但 DOM 无 \n 的情况）
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const ns = norm(searchText);
  if (!ns) return null;
  const nf = norm(full);
  idx = nf.indexOf(ns);
  if (idx < 0) return null;

  // 建立 normalized→original 下标映射
  const nToO: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < full.length; i++) {
    const isSpace = /\s/.test(full[i]!);
    if (isSpace) { if (!prevSpace) nToO.push(i); prevSpace = true; }
    else { nToO.push(i); prevSpace = false; }
  }
  // 掐掉 trim 产生的偏移
  const trimStart = full.length - full.trimStart().length;
  const trimmedNToO = nToO.filter((o) => o >= trimStart);
  if (idx + ns.length > trimmedNToO.length) return null;
  const oStart = trimmedNToO[idx]!;
  const oEnd = trimmedNToO[idx + ns.length - 1]!;
  if (oStart >= charMap.length || oEnd >= charMap.length) return null;
  const r = document.createRange();
  r.setStart(charMap[oStart]!.node, charMap[oStart]!.offset);
  r.setEnd(charMap[oEnd]!.node, charMap[oEnd]!.offset + 1);
  return r;
}

function clampedQuote(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ── Component ──────────────────────────────────────────────────

export default function PlanDocPanel({
  sessionId,
  text,
  width,
  onClose,
}: {
  sessionId: string;
  text: string;
  width: number;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const setMode = useChatStore((s) => s.setMode);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const title = extractPlanTitle(text) ?? t('planDocTitle');

  // ── Annotations ──────────────────────────────────────────────
  const [annotations, setAnnotations] = useState<PlanAnnotation[]>([]);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [highlights, setHighlights] = useState<HighlightInfo[]>([]);
  /** 阻止 mouseup 触发新选区弹窗（点击图标时）。 */
  const suppressNextMouseUp = useRef(false);
  /** 尺寸变化计数器 → 触发高亮重算。 */
  const [resizeTick, setResizeTick] = useState(0);

  // Plan 文本换代 → 清空旧批注。
  const prevTextRef = useRef(text);
  useEffect(() => {
    if (text !== prevTextRef.current) {
      prevTextRef.current = text;
      setAnnotations([]);
      setPopup(null);
    }
  }, [text]);

  // 弹窗出现时自动聚焦 textarea。
  useEffect(() => {
    if (popup) setTimeout(() => inputRef.current?.focus(), 0);
  }, [popup]);

  // 面板宽度变化 → 重算高亮位置。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setResizeTick((c) => c + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Highlight rect calculation ───────────────────────────────
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || annotations.length === 0) { setHighlights([]); return; }
    const cRect = container.getBoundingClientRect();
    const results: HighlightInfo[] = [];
    for (const ann of annotations) {
      const range = findTextRange(container, ann.selectedText);
      if (!range) continue;
      const clientRects = range.getClientRects();
      const rects: HighlightInfo['rects'] = [];
      for (let i = 0; i < clientRects.length; i++) {
        const r = clientRects[i]!;
        rects.push({
          top: r.top - cRect.top + container.scrollTop,
          left: r.left - cRect.left,
          width: r.width,
          height: r.height,
        });
      }
      if (rects.length === 0) continue;
      const first = rects[0]!;
      results.push({
        id: ann.id,
        rects,
        iconTop: first.top + (first.height - 16) / 2,
        iconRight: 6,
      });
    }
    setHighlights(results);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, text, resizeTick]);

  // ── Selection → popup ────────────────────────────────────────
  const handleContentMouseUp = useCallback(() => {
    if (suppressNextMouseUp.current) { suppressNextMouseUp.current = false; return; }
    if (popup) return; // 弹窗已打开，不覆盖
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const selectedText = sel.toString().trim();
    if (!selectedText || !scrollRef.current || !panelRef.current) return;
    const range = sel.getRangeAt(0);
    if (!scrollRef.current.contains(range.commonAncestorContainer)) return;
    const rect = range.getBoundingClientRect();
    const panelRect = panelRef.current.getBoundingClientRect();
    setPopup({
      top: rect.bottom - panelRect.top + 6,
      left: Math.max(8, Math.min(rect.left - panelRect.left, panelRect.width - 280)),
      selectedText,
    });
    setInputValue('');
  }, [popup]);

  // 点击弹窗外部关闭。
  useEffect(() => {
    if (!popup) return;
    const handler = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.('[data-annotation-popup]')) return;
      setPopup(null);
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 80);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler); };
  }, [popup]);

  // Escape 关闭弹窗。
  useEffect(() => {
    if (!popup) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopup(null); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [popup]);

  // ── Annotation CRUD ──────────────────────────────────────────
  const saveAnnotation = (): void => {
    if (!popup || !inputValue.trim()) return;
    if (popup.editingId) {
      // 编辑
      setAnnotations((prev) =>
        prev.map((a) => (a.id === popup.editingId ? { ...a, comment: inputValue.trim() } : a)),
      );
    } else {
      // 新建
      setAnnotations((prev) => [
        ...prev,
        { id: crypto.randomUUID(), selectedText: popup.selectedText, comment: inputValue.trim() },
      ]);
    }
    setPopup(null);
    setInputValue('');
    window.getSelection()?.removeAllRanges();
  };

  const removeAnnotation = (id: string): void => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    if (popup?.editingId === id) setPopup(null);
  };

  const openEditPopup = (id: string): void => {
    const ann = annotations.find((a) => a.id === id);
    if (!ann || !panelRef.current) return;
    // 利用高亮位置定位编辑弹窗
    const hi = highlights.find((h) => h.id === id);
    const panelRect = panelRef.current.getBoundingClientRect();
    const scrollEl = scrollRef.current;
    let top: number;
    let left: number;
    if (hi && hi.rects.length > 0 && scrollEl) {
      // 把高亮位置（scroll-content 坐标系）转回 aside 坐标系
      const scrollRect = scrollEl.getBoundingClientRect();
      const firstRect = hi.rects[0]!;
      const viewTop = firstRect.top - scrollEl.scrollTop + scrollRect.top - panelRect.top;
      top = viewTop + (firstRect.height ?? 0) + 4;
      left = Math.max(8, firstRect.left);
    } else {
      top = 60;
      left = 8;
    }
    setPopup({ top, left: Math.min(left, width - 280), selectedText: ann.selectedText, editingId: id });
    setInputValue(ann.comment);
    suppressNextMouseUp.current = true;
  };

  // ── Actions ──────────────────────────────────────────────────
  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const implement = (): void => {
    onClose();
    void setMode('default');
    setTimeout(() => void useChatStore.getState().sendPromptTo(sessionId, t('planImplementPrompt')), 300);
  };

  const reviewWithAnnotations = (): void => {
    const list = annotations
      .map((a, i) => `${i + 1}. 「${a.selectedText}」— ${a.comment}`)
      .join('\n');
    const prompt = t('planReviewPrompt', { annotations: list });
    setAnnotations([]);
    void useChatStore.getState().sendPromptTo(sessionId, prompt);
  };

  // ── Render ───────────────────────────────────────────────────

  return (
    <aside ref={panelRef} className="relative flex min-h-0 shrink flex-col bg-bg-panel/50" style={{ width }}>
      {/* ── Header ── */}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-2.5">
        <NotebookText size={14} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium" title={title}>
          {title}
        </span>
        {annotations.length > 0 && (
          <span className="rounded-full bg-accent/15 px-1.5 py-px text-[10px] tabular-nums text-accent">
            {annotations.length}
          </span>
        )}
        <button title={t('planCopy')} onClick={copy} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
          {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
        </button>
        <button title={t('planDownload')} onClick={() => downloadMarkdown(title, text)} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
          <Download size={13} />
        </button>
        <button onClick={onClose} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
          <X size={14} />
        </button>
      </div>

      {/* ── Scrollable content with highlights ── */}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto"
        onMouseUp={handleContentMouseUp}
      >
        {/* 高亮背景层（pointer-events-none, 在文字下方） */}
        {highlights.flatMap((h) =>
          h.rects.map((r, i) => (
            <div
              key={`${h.id}-${i}`}
              className="pointer-events-none absolute rounded-sm"
              style={{
                top: r.top,
                left: r.left,
                width: r.width,
                height: r.height,
                background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
              }}
            />
          )),
        )}

        {/* Markdown 内容（z-[1]：在高亮之上以保持可选中） */}
        <div className="relative z-[1] md-body px-4 py-3 text-[13px]">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MdLink, pre: MdPre }}>{text}</ReactMarkdown>
        </div>

        {/* 批注图标（z-10：在内容之上，可点击） */}
        {highlights.map((h) => {
          const ann = annotations.find((a) => a.id === h.id);
          return (
            <button
              key={`icon-${h.id}`}
              title={ann?.comment}
              className="absolute z-10 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-accent/40 bg-accent/20 text-accent shadow-sm transition hover:bg-accent/30 hover:shadow"
              style={{ top: h.iconTop, right: h.iconRight }}
              onMouseUp={(e) => e.stopPropagation()}
              onClick={() => openEditPopup(h.id)}
            >
              <MessageSquare size={9} />
            </button>
          );
        })}
      </div>

      {/* ── Popup（绝对定位在 aside 内） ── */}
      {popup && (
        <div
          data-annotation-popup
          className="absolute z-30 rounded-lg border border-line bg-bg-input shadow-lg"
          style={{ top: popup.top, left: popup.left, maxWidth: Math.min(width - 16, 320), minWidth: 220 }}
        >
          <div className="flex flex-col gap-2 p-2.5">
            <div className="line-clamp-2 text-[11px] text-ink-faint">
              「{clampedQuote(popup.selectedText)}」
            </div>
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveAnnotation(); }
              }}
              placeholder={t('planAnnotatePlaceholder')}
              className="min-h-[48px] resize-none rounded-md border border-line bg-bg px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
              rows={2}
            />
            <div className="flex items-center gap-1.5">
              {popup.editingId && (
                <button
                  onClick={() => removeAnnotation(popup.editingId!)}
                  className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-warn"
                  title={t('close')}
                >
                  <Trash2 size={12} />
                </button>
              )}
              <span className="flex-1" />
              <button
                onClick={() => setPopup(null)}
                className="rounded-md px-2.5 py-1 text-[11px] text-ink-faint transition hover:bg-bg-hover hover:text-ink"
              >
                {t('cancel')}
              </button>
              <button
                onClick={saveAnnotation}
                disabled={!inputValue.trim()}
                className="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white transition hover:opacity-90 disabled:opacity-40"
              >
                {t('planConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <div className="flex shrink-0 flex-col gap-2 p-2.5">
        {annotations.length > 0 && (
          <button
            onClick={reviewWithAnnotations}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-accent bg-accent/10 py-2 text-ui font-medium text-accent transition hover:bg-accent/20"
          >
            <RefreshCw size={13} /> {t('planReviewAnnotations')}
          </button>
        )}
        <button
          onClick={implement}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-ui font-medium text-white transition hover:opacity-90"
        >
          <Play size={13} /> {t('planImplement')}
        </button>
      </div>
    </aside>
  );
}
