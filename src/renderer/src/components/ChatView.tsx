/**
 * ChatView — conversation stream + composer for the active session.
 * Right side hosts one auxiliary panel at a time (workspace files /
 * sidechat branch / plan preview) plus a collapsible icon rail with
 * hover-peek flyout (item 3/4/8).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  FileDiff,
  FolderTree,
  MessagesSquare,
  PanelRightClose,
  PanelRightOpen,
  SquareTerminal,
} from 'lucide-react';

import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import MessageItem from './MessageItem';
import Composer from './Composer';
import PermissionSheet from './PermissionSheet';
import PlanWidget from './PlanWidget';
import WorkspacePanel, { type PanelTab } from './workspace/WorkspacePanel';
import SideChatPanel from './SideChatPanel';
import PlanDocPanel from './PlanDocPanel';

type RightPanel = 'workspace' | 'sidechat' | 'plan' | null;

export default function ChatView({ sessionId }: { sessionId: string }): JSX.Element {
  const t = useT();
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const creating = useChatStore((s) => s.creating);
  const railCollapsed = useChatStore((s) => s.railCollapsed);
  const toggleRail = useChatStore((s) => s.toggleRail);
  const sidechatId = useChatStore((s) => s.sidechats[sessionId]);
  const planPreviewId = useChatStore((s) => s.planPreview[sessionId]);
  const openSidechat = useChatStore((s) => s.openSidechat);
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>('files');
  const [railPeek, setRailPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const messages = ui?.messages ?? [];
  const isWork = meta?.chatMode === 'work';

  // Auto-follow the stream unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Plan 模式产出计划后自动弹出右侧 md 预览（item 8）。
  useEffect(() => {
    if (planPreviewId) setRightPanel('plan');
  }, [planPreviewId]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const openWorkspaceTab = (tab: PanelTab): void => {
    if (rightPanel === 'workspace' && panelTab === tab) {
      setRightPanel(null);
      return;
    }
    setPanelTab(tab);
    setRightPanel('workspace');
  };

  const onSidechat = async (): Promise<void> => {
    if (rightPanel === 'sidechat') {
      setRightPanel(null);
      return;
    }
    await openSidechat(sessionId);
    setRightPanel('sidechat');
  };

  const peekEnter = (): void => {
    clearTimeout(peekTimer.current);
    setRailPeek(true);
  };
  const peekLeave = (): void => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setRailPeek(false), 250);
  };

  const planMsg = planPreviewId
    ? messages.find((m) => m.id === planPreviewId && m.kind === 'text')
    : undefined;

  const railButtons = (
    <>
      {isWork && (
        <>
          <RailButton
            title={t('railFiles')}
            active={rightPanel === 'workspace' && panelTab === 'files'}
            onClick={() => openWorkspaceTab('files')}
          >
            <FolderTree size={16} />
          </RailButton>
          <RailButton
            title={t('railChanges')}
            active={rightPanel === 'workspace' && panelTab === 'changes'}
            onClick={() => openWorkspaceTab('changes')}
          >
            <FileDiff size={16} />
          </RailButton>
          <RailButton
            title={t('railAgents')}
            active={rightPanel === 'workspace' && panelTab === 'agents'}
            onClick={() => openWorkspaceTab('agents')}
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
          active={rightPanel === 'sidechat'}
          disabled={creating || meta.status === 'starting'}
          onClick={() => void onSidechat()}
        >
          <MessagesSquare size={16} />
        </RailButton>
      )}
      <div className="flex-1" />
      <RailButton title={t('collapseRail')} onClick={toggleRail}>
        <PanelRightClose size={15} />
      </RailButton>
    </>
  );

  return (
    <div className="relative flex h-full min-w-0">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <span className="min-w-0 truncate text-sm font-medium">{meta?.title ?? '会话'}</span>
          {isWork && meta && (
            <span className="truncate rounded-md bg-bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft">{meta.cwd}</span>
          )}
          <div className="flex-1" />
          <Heartbeat sessionId={sessionId} busy={meta?.status === 'running' || meta?.status === 'awaiting'} />
        </header>

        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
            {messages.length === 0 && (
              <div className="py-16 text-center text-ui text-ink-faint">
                {meta?.status === 'starting' ? '引擎启动中…' : '发送第一条消息开始对话'}
              </div>
            )}
            {messages.map((m) => (
              <MessageItem key={m.id} msg={m} sessionId={sessionId} />
            ))}
          </div>
        </div>

        <PlanWidget sessionId={sessionId} />
        <PermissionSheet sessionId={sessionId} />
        <Composer sessionId={sessionId} />
      </div>

      {/* 右侧辅助面板（一次一个）：工作区 / sidechat / 计划预览 */}
      {rightPanel === 'workspace' && isWork && meta && (
        <WorkspacePanel sessionId={sessionId} root={meta.cwd} tab={panelTab} onTabChange={setPanelTab} />
      )}
      {rightPanel === 'sidechat' && sidechatId && (
        <SideChatPanel sessionId={sidechatId} onClose={() => setRightPanel(null)} />
      )}
      {rightPanel === 'plan' && planMsg && planMsg.kind === 'text' && (
        <PlanDocPanel
          sessionId={sessionId}
          text={planMsg.text}
          onClose={() => {
            setRightPanel(null);
            useChatStore.getState().setPlanPreview(sessionId, undefined);
          }}
        />
      )}

      {/* 右侧快捷图标 rail — 支持折叠 + 悬停浮出（item 3） */}
      {!railCollapsed ? (
        <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-line bg-bg-panel/60 py-2.5 transition-all duration-200">
          {railButtons}
        </div>
      ) : (
        <>
          {/* 折叠态：右缘悬浮小把手，悬停浮出、点击常驻 */}
          <div className="absolute right-0 top-14 z-30" onMouseEnter={peekEnter} onMouseLeave={peekLeave}>
            <button
              title={t('expandRail')}
              onClick={toggleRail}
              className="flex h-8 w-6 items-center justify-center rounded-l-lg border border-r-0 border-line bg-bg-panel text-ink-faint shadow-sm transition hover:text-ink"
            >
              <PanelRightOpen size={14} />
            </button>
          </div>
          <div
            onMouseEnter={peekEnter}
            onMouseLeave={peekLeave}
            className={`absolute bottom-0 right-0 top-0 z-20 flex w-11 flex-col items-center gap-1 border-l border-line bg-bg-panel py-2.5 shadow-lg transition-transform duration-200 ease-out ${
              railPeek ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            {railButtons}
          </div>
        </>
      )}
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
