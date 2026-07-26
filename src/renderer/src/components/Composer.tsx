/**
 * Composer — floating rounded input card (codex desktop style):
 * textarea + model selector + permission-mode selector + send/stop.
 * Enter sends, Shift+Enter breaks line.
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, Square } from 'lucide-react';

import type { PermissionMode } from '@shared/types';
import { useChatStore } from '../store/chatStore';

const MODE_LABELS: Record<PermissionMode, string> = {
  default: '手动审批',
  plan: '只读规划',
  auto: '全自动',
  yolo: 'YOLO',
};

export default function Composer({ sessionId }: { sessionId: string }): JSX.Element {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  const cancel = useChatStore((s) => s.cancel);

  const busy = meta?.status === 'running' || meta?.status === 'awaiting';

  const send = (): void => {
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    void sendPrompt(value);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="shrink-0 px-6 pb-5 pt-1">
      <div className="mx-auto max-w-3xl rounded-2xl border border-line bg-bg-input shadow-sm focus-within:border-ink-faint">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          placeholder={busy ? '执行中…（可等待或点停止）' : '输入消息，Enter 发送，Shift+Enter 换行'}
          className="w-full resize-none bg-transparent px-4 pb-1 pt-3 text-body outline-none placeholder:text-ink-faint"
        />
        <div className="flex items-center gap-2 px-3 pb-2.5">
          <ModelPicker sessionId={sessionId} />
          <ModePicker sessionId={sessionId} />
          <div className="flex-1" />
          {busy ? (
            <button
              onClick={() => void cancel()}
              title="停止"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-bg transition hover:opacity-80"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!text.trim()}
              title="发送"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition hover:opacity-90 disabled:opacity-30"
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
      {ui?.modes.current === 'plan' && (
        <div className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-ink-faint">只读规划模式 — 不会执行任何工具</div>
      )}
    </div>
  );
}

function ModelPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const ui = useChatStore((s) => s.ui[sessionId]);
  const setModel = useChatStore((s) => s.setModel);
  const [open, setOpen] = useState(false);
  const models = ui?.models;
  if (!models?.current) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui text-ink-soft hover:bg-bg-hover"
      >
        <span className="font-medium">{models.current}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)}>
          {models.available.map((m) => (
            <DropdownItem
              key={m}
              active={m === models.current}
              onClick={() => {
                setOpen(false);
                void setModel(m);
              }}
            >
              {m}
            </DropdownItem>
          ))}
        </Dropdown>
      )}
    </div>
  );
}

function ModePicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const ui = useChatStore((s) => s.ui[sessionId]);
  const setMode = useChatStore((s) => s.setMode);
  const [open, setOpen] = useState(false);
  const modes = ui?.modes;
  if (!modes || modes.available.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui text-ink-soft hover:bg-bg-hover"
      >
        {MODE_LABELS[modes.current] ?? modes.current}
        <ChevronDown size={12} />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)}>
          {modes.available.map((m) => (
            <DropdownItem
              key={m}
              active={m === modes.current}
              onClick={() => {
                setOpen(false);
                void setMode(m);
              }}
            >
              {MODE_LABELS[m] ?? m}
            </DropdownItem>
          ))}
        </Dropdown>
      )}
    </div>
  );
}

function Dropdown({ children, onClose }: { children: React.ReactNode; onClose: () => void }): JSX.Element {
  // Close on Escape as well as outside click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute bottom-9 left-0 z-20 min-w-40 rounded-xl border border-line bg-bg-input py-1 shadow-lg">
        {children}
      </div>
    </>
  );
}

function DropdownItem({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-ui hover:bg-bg-hover ${active ? 'font-semibold text-accent' : 'text-ink'}`}
    >
      {children}
    </button>
  );
}
