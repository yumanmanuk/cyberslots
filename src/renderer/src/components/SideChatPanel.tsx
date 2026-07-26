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

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

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
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-bg-panel/40">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
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

      {/* mini composer：模型 + 思考深度 + 发送/停止 */}
      <div className="shrink-0 border-t border-line p-2.5">
        <div className="rounded-xl border border-line bg-bg-input transition focus-within:border-ink-faint">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={Math.min(5, Math.max(1, text.split('\n').length))}
            placeholder={t('sidechatPlaceholder')}
            className="w-full resize-none bg-transparent px-3 pb-1 pt-2 text-[12.5px] outline-none placeholder:text-ink-faint"
          />
          <div className="flex items-center gap-1 px-2 pb-1.5">
            <MiniModelPicker sessionId={sessionId} />
            {meta?.engine === 'codex' && <MiniEffortPicker sessionId={sessionId} />}
            <div className="flex-1" />
            {busy ? (
              <button
                onClick={() => void useChatStore.getState().cancelSession(sessionId)}
                title={t('stop')}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-bg transition hover:opacity-80"
              >
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!text.trim()}
                title={t('send')}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white transition hover:opacity-90 disabled:opacity-30"
              >
                <ArrowUp size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function MiniModelPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const models = useChatStore((s) => s.ui[sessionId]?.models);
  const [open, setOpen] = useState(false);
  if (!models?.current) return null;
  return (
    <MiniDropdown
      open={open}
      setOpen={setOpen}
      label={models.current}
      items={models.available}
      active={models.current}
      onPick={(m) => void window.cyberslots.sessionSetModel(sessionId, m)}
    />
  );
}

function MiniEffortPicker({ sessionId }: { sessionId: string }): JSX.Element {
  const effort = useChatStore((s) => s.efforts[sessionId] ?? 'medium');
  const [open, setOpen] = useState(false);
  return (
    <MiniDropdown
      open={open}
      setOpen={setOpen}
      label={effort}
      items={EFFORTS}
      active={effort}
      onPick={(e) => useChatStore.setState((s) => ({ efforts: { ...s.efforts, [sessionId]: e } }))}
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
                className={`block w-full px-2.5 py-1 text-left text-[11.5px] transition hover:bg-bg-hover ${
                  item === active ? 'font-semibold text-accent' : 'text-ink'
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
