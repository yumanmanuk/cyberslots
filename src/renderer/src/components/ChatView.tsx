/**
 * ChatView — conversation stream + composer for the active session.
 * A slim vertical icon rail on the right edge gives one-click access
 * to files / change review / agents / terminal / branch (qoder-style
 * quick entries); the workspace panel opens against it.
 */

import { useEffect, useRef, useState } from 'react';
import { Bot, FileDiff, FolderTree, GitBranch, PanelRightClose, SquareTerminal } from 'lucide-react';

import { useChatStore, type SessionUiState } from '../store/chatStore';
import { useT } from '../i18n';
import MessageItem from './MessageItem';
import Composer from './Composer';
import PermissionSheet from './PermissionSheet';
import PlanWidget from './PlanWidget';
import WorkspacePanel, { type PanelTab } from './workspace/WorkspacePanel';

export default function ChatView({ sessionId }: { sessionId: string }): JSX.Element {
  const t = useT();
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const creating = useChatStore((s) => s.creating);
  const forkSession = useChatStore((s) => s.forkSession);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>('files');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const messages = ui?.messages ?? [];
  const isWork = meta?.chatMode === 'work';

  // Auto-follow the stream unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const openPanel = (tab: PanelTab): void => {
    if (panelOpen && panelTab === tab) {
      setPanelOpen(false);
      return;
    }
    setPanelTab(tab);
    setPanelOpen(true);
  };

  return (
    <div className="flex h-full min-w-0">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <span className="min-w-0 truncate text-sm font-medium">{meta?.title ?? '会话'}</span>
          {isWork && meta && (
            <span className="truncate rounded-md bg-bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft">{meta.cwd}</span>
          )}
          <div className="flex-1" />
          <Heartbeat sessionId={sessionId} busy={meta?.status === 'running' || meta?.status === 'awaiting'} />
          <UsageBar ui={ui} />
        </header>

        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            {messages.length === 0 && (
              <div className="py-16 text-center text-ui text-ink-faint">
                {meta?.status === 'starting' ? '引擎启动中…' : '发送第一条消息开始对话'}
              </div>
            )}
            {messages.map((m) => (
              <MessageItem key={m.id} msg={m} />
            ))}
          </div>
        </div>

        <PlanWidget sessionId={sessionId} />
        <PermissionSheet sessionId={sessionId} />
        <Composer sessionId={sessionId} />
      </div>

      {isWork && panelOpen && meta && (
        <WorkspacePanel sessionId={sessionId} root={meta.cwd} tab={panelTab} onTabChange={setPanelTab} />
      )}

      {/* 右侧快捷图标 rail */}
      <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-line bg-bg-panel/60 py-2.5">
        {isWork && (
          <>
            <RailButton
              title={t('railFiles')}
              active={panelOpen && panelTab === 'files'}
              onClick={() => openPanel('files')}
            >
              <FolderTree size={16} />
            </RailButton>
            <RailButton
              title={t('railChanges')}
              active={panelOpen && panelTab === 'changes'}
              onClick={() => openPanel('changes')}
            >
              <FileDiff size={16} />
            </RailButton>
            <RailButton
              title={t('railAgents')}
              active={panelOpen && panelTab === 'agents'}
              onClick={() => openPanel('agents')}
            >
              <Bot size={16} />
            </RailButton>
            <div className="my-1 h-px w-5 bg-line" />
            <RailButton title={t('railTerminal')} onClick={() => void window.cyberslots.openIn('terminal', meta!.cwd)}>
              <SquareTerminal size={16} />
            </RailButton>
          </>
        )}
        {meta && (
          <RailButton
            title={t('railBranch')}
            disabled={creating || meta.status === 'starting'}
            onClick={() => void forkSession(sessionId)}
          >
            <GitBranch size={16} />
          </RailButton>
        )}
        {isWork && panelOpen && (
          <>
            <div className="flex-1" />
            <RailButton title={t('workPanelToggle')} onClick={() => setPanelOpen(false)}>
              <PanelRightClose size={16} />
            </RailButton>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Heartbeat — liveness indicator for the running turn. Network drops
 * rarely raise an error, they just go silent; this surfaces "seconds
 * since the last engine event" and escalates color when it stalls.
 */
function Heartbeat({ sessionId, busy }: { sessionId: string; busy: boolean }): JSX.Element | null {
  const t = useT();
  const lastActivityAt = useChatStore((s) => s.ui[sessionId]?.lastActivityAt);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  if (!busy || !lastActivityAt) return null;
  const idleSec = Math.floor((Date.now() - lastActivityAt) / 1000);

  let dot = 'bg-ok animate-pulse';
  let label = t('hbWorking');
  let tone = 'text-ink-faint';
  if (idleSec >= 45) {
    dot = 'bg-err';
    label = `${t('hbStalled')} ${idleSec}s`;
    tone = 'text-err';
  } else if (idleSec >= 12) {
    dot = 'bg-warn';
    label = `${t('hbWaiting')} ${idleSec}s`;
    tone = 'text-warn';
  }

  return (
    <div className="flex items-center gap-1.5" title={`距上次引擎事件 ${idleSec}s`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className={`text-[11px] tabular-nums ${tone}`}>{label}</span>
    </div>
  );
}

function RailButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition disabled:opacity-40 ${
        active ? 'bg-accent-soft text-accent' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function UsageBar({ ui }: { ui: SessionUiState | undefined }): JSX.Element | null {
  const usage = ui?.usage;
  if (!usage || usage.size <= 0) return null;
  const pct = Math.min(100, Math.round((usage.used / usage.size) * 100));
  return (
    <div className="flex items-center gap-2" title={`上下文 ${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens`}>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-bg-active">
        <div
          className={`h-full rounded-full ${pct > 85 ? 'bg-err' : pct > 65 ? 'bg-warn' : 'bg-ok'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-ink-faint">{pct}%</span>
    </div>
  );
}
