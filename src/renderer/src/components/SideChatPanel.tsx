/**
 * SideChatPanel — a read-only fork of the main conversation, opened
 * against the right rail (item 4). Model and reasoning-effort are
 * switchable; the branch stays in plan (read-only) mode so it can
 * answer questions but never writes files or runs commands.
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, MessagesSquare, Square, X } from 'lucide-react';

import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import MessageItem from './MessageItem';
import PermissionSheet from './PermissionSheet';
import { EffortPicker } from './Composer';

/** 可拖拽宽度范围 + localStorage 持久。 */
const MIN_W = 300;
const MAX_W = 720;
const DEFAULT_W = 380;

/** kimi 分支的只读护栏：kimi 没有 read-only sandbox，靠每条消息前置
 *  硬指令约束（codex 分支用 plan/read-only 模式，无需此护栏）。 */
const SIDECHAT_GUARD =
  '【只读分支约束】本消息来自只读 sidechat：只允许阅读文件与回答问题，禁止一切写入/编辑/执行命令/创建计划文件等有副作用操作，也不要进入任何 Plan 工作流，直接用文字作答。';

export default function SideChatPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }): JSX.Element {
  const t = useT();
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const sendKey = useChatStore((s) => s.settings?.sendKey ?? 'enter');
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // 面板宽度：左缘拖拽调整，拖动中直接设 width（无过渡），松手持久化。
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('cs.sidechatWidth'));
    return Number.isFinite(saved) && saved >= MIN_W && saved <= MAX_W ? saved : DEFAULT_W;
  });
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  const messages = ui?.messages ?? [];
  const busy = meta?.status === 'running' || meta?.status === 'awaiting';

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = (): void => {
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    const guard = meta?.engine === 'kimi' ? SIDECHAT_GUARD : undefined;
    void useChatStore.getState().sendPromptTo(sessionId, value, undefined, guard);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (sendKey === 'ctrl-enter') {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        send();
      }
      return;
    }
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <aside className="panel-in relative flex shrink-0 flex-col border-l border-line bg-bg-panel/50" style={{ width }}>
      {/* 左缘拖拽把手 — 悬停/拖动时高亮成细线 */}
      <div
        onPointerDown={(e) => {
          drag.current = { startX: e.clientX, startW: width };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setWidth(Math.min(MAX_W, Math.max(MIN_W, d.startW + (d.startX - e.clientX))));
        }}
        onPointerUp={() => {
          if (!drag.current) return;
          drag.current = null;
          localStorage.setItem('cs.sidechatWidth', String(width));
        }}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize touch-none transition-colors duration-150 hover:bg-accent/40 active:bg-accent/60"
      />
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-2.5">
        <MessagesSquare size={14} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-medium">{t('sidechatTitle')}</div>
          <div className="truncate text-[10.5px] text-ink-faint">{t('sidechatHint')}</div>
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
          <X size={14} />
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="flex flex-col gap-3 px-3 py-3 text-[13px]">
          {messages.map((m) => (
            <MessageItem key={m.id} msg={m} sessionId={sessionId} />
          ))}
        </div>
      </div>

      <PermissionSheet sessionId={sessionId} />

      {/* mini composer：与主输入框同规格（圆角/字号/内距/按钮尺寸），pb-5 与底缘对齐 */}
      <div className="shrink-0 px-3 pb-5 pt-1">
        <div className="rounded-2xl border border-line bg-bg-input shadow-sm transition focus-within:border-ink-faint">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={Math.min(5, Math.max(1, text.split('\n').length))}
            placeholder={t('sidechatPlaceholder')}
            className="w-full resize-none bg-transparent px-4 pb-1 pt-3 text-body outline-none placeholder:text-ink-faint"
          />
          <div className="flex items-center gap-1.5 px-3 pb-2.5">
            <MiniModelPicker sessionId={sessionId} />
            {meta?.engine === 'codex' && <EffortPicker sessionId={sessionId} align="left" />}
            <div className="flex-1" />
            {busy ? (
              <button
                onClick={() => void useChatStore.getState().cancelSession(sessionId)}
                title={t('stop')}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-bg transition hover:opacity-80"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!text.trim()}
                title={t('send')}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition hover:opacity-90 disabled:opacity-30"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function MiniModelPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const uiModels = useChatStore((s) => s.ui[sessionId]?.models);
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const catalog = useChatStore((s) => s.codexCatalog);
  const [open, setOpen] = useState(false);
  // 同主 Composer：引擎未运行时用持久化 meta.modelId + catalog 兑底。
  const current = uiModels?.current || meta?.modelId || '';
  const available = uiModels?.available.length
    ? uiModels.available
    : meta?.engine === 'codex' && catalog.length
      ? catalog.map((c) => c.slug)
      : current
        ? [current]
        : [];
  if (!current && !available.length) return null;
  const displayOf = (id: string): string => catalog.find((c) => c.slug === id)?.displayName ?? id;
  return (
    <MiniDropdown
      open={open}
      setOpen={setOpen}
      label={displayOf(current || available[0]!)}
      items={available}
      active={current}
      onPick={(m) => void window.cyberslots.sessionSetModel(sessionId, m)}
    />
  );
}

function MiniDropdown({
  open,
  setOpen,
  label,
  items,
  active,
  onPick,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  label: string;
  items: string[];
  active: string;
  onPick: (item: string) => void;
}): JSX.Element {
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex max-w-36 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-soft transition hover:bg-bg-hover"
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-7 left-0 z-20 min-w-32 rounded-lg border border-line bg-bg-input py-1 shadow-lg">
            {items.map((item) => (
              <button
                key={item}
                onClick={() => {
                  setOpen(false);
                  onPick(item);
                }}
                className={`block w-full px-2.5 py-1 text-left text-[11.5px] transition hover:bg-bg-hover ${item === active ? 'font-semibold text-accent' : 'text-ink'
                  }`}
              >
                {item}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
