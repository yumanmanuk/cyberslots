/**
 * SideChatPanel — a read-only fork of the main conversation, hosted as
 * a tab in RightDock (item 4). Model and reasoning-effort are
 * switchable; the branch stays in plan (read-only) mode so it can
 * answer questions but never writes files or runs commands. 只读提示
 * 不再常驻——悬浮 dock 里的 sidechat tab 时以 tooltip 展示。
 * 面板宽度由 RightDock 统一管理（dock 左缘把手拖拽），此处只受控渲染。
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, Square } from 'lucide-react';

import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import MessageList from './MessageList';
import PermissionSheet from './PermissionSheet';
import { EffortPicker } from './Composer';

/** kimi 分支的只读护栏：kimi 没有 read-only sandbox，靠每条消息前置
 *  硬指令约束（codex 分支用 plan/read-only 模式，无需此护栏）。 */
const SIDECHAT_GUARD =
  '【只读分支约束】本消息来自只读 sidechat：只允许阅读文件与回答问题，禁止一切写入/编辑/执行命令/创建计划文件等有副作用操作，也不要进入任何 Plan 工作流，直接用文字作答。';

export default function SideChatPanel({ sessionId, width }: { sessionId: string; width: number }): JSX.Element {
  const t = useT();
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const sendKey = useChatStore((s) => s.settings?.sendKey ?? 'enter');
  // 未发送草稿按分支会话保留（卸载时写回 store，与主 Composer 同机制）。
  const [text, setText] = useState(() => useChatStore.getState().drafts[sessionId] ?? '');
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    return () => {
      useChatStore.setState((s) => ({ drafts: { ...s.drafts, [sessionId]: textRef.current } }));
    };
  }, [sessionId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const messages = ui?.messages ?? [];
  // 分支起始继承的历史仅作上下文（引擎侧仍完整可见），面板不重复渲染主对话——
  // 只显示分支内新产生的问答；forkSeedCount 为 fork 时的历史条数。
  const seed = meta?.forkSeedCount ?? 0;
  const visible = seed > 0 ? messages.slice(seed) : messages;
  const sending = useChatStore((s) => !!s.sending[sessionId]);
  const busy = meta?.status === 'running' || meta?.status === 'awaiting' || sending;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 同 ChatView：折叠块 200ms 高度动画期间用 ResizeObserver 逐帧贴底。
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const send = (): void => {
    const value = text.trim();
    // 启动中不拦 — 主进程 prompt 会等引擎就绪后投递（与主 Composer 一致）。
    if (!value || busy) return;
    setText('');
    // kimi/opencode 无 read-only 硬隔离（plan agent 会写计划文件），
    // 用只读指令前缀软约束；codex 已由 plan 模式沙箱硬隔离。
    const guard = meta?.engine === 'kimi' || meta?.engine === 'opencode' ? SIDECHAT_GUARD : undefined;
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
    <aside className="flex shrink-0 flex-col bg-bg-panel/50" style={{ width }}>
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={contentRef} className="flex flex-col gap-3 px-3 py-3 text-[13px]">
          {visible.length === 0 && !busy ? (
            <p className="px-1 py-8 text-center text-[12px] leading-5 text-ink-faint">{t('sidechatEmpty')}</p>
          ) : (
            <MessageList sessionId={sessionId} messages={visible} />
          )}
        </div>
      </div>

      <PermissionSheet sessionId={sessionId} />

      {/* mini composer：与主输入框同规格（圆角/字号/内距/按钮尺寸），pb-5 与底缘对齐 */}
      <div className="shrink-0 px-3 pb-5 pt-1">
        <div className="rounded-2xl border border-line bg-bg-input shadow-sm">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={Math.min(5, Math.max(2, text.split('\n').length))}
            placeholder={t('sidechatPlaceholder')}
            className="no-scrollbar w-full resize-none bg-transparent px-4 pb-1 pt-3 text-body outline-none placeholder:text-ink-faint"
          />
          <div className="flex items-center gap-1.5 px-3 pb-2.5">
            <MiniModelPicker sessionId={sessionId} />
            {(meta?.engine === 'codex' || meta?.engine === 'opencode' || meta?.engine === 'kimi') && <EffortPicker sessionId={sessionId} align="left" />}
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
