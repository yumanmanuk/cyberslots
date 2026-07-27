/**
 * ChatView — conversation stream + composer for the active session.
 * Right side hosts one auxiliary panel at a time (workspace files /
 * sidechat branch / plan preview). The icon rail is persistent; its top
 * button folds/expands that panel area (item 3/4/8).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  FileDiff,
  FolderTree,
  Loader2,
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
import WorkspacePanel, { type PanelTab } from './workspace/WorkspacePanel';
import SideChatPanel from './SideChatPanel';
import PlanDocPanel from './PlanDocPanel';
import TurnRail from './TurnRail';

type RightPanel = 'workspace' | 'sidechat' | 'plan' | null;

export default function ChatView({ sessionId }: { sessionId: string }): JSX.Element {
  const t = useT();
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const creating = useChatStore((s) => s.creating);
  const sidechatId = useChatStore((s) => s.sidechats[sessionId]);
  const planPreviewId = useChatStore((s) => s.planPreview[sessionId]);
  const openSidechat = useChatStore((s) => s.openSidechat);
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>('files');
  const [lastPanel, setLastPanel] = useState<Exclude<RightPanel, null>>('workspace');
  const [sidechatOpening, setSidechatOpening] = useState(false);
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

  // 记住最近打开的面板，折叠后顶部按钮可一键展开回原面板。
  useEffect(() => {
    if (rightPanel) setLastPanel(rightPanel);
  }, [rightPanel]);

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
    // 分支可能要先拉起引擎（fork/预热），期间 rail 图标转 loading。
    setSidechatOpening(true);
    try {
      await openSidechat(sessionId);
      setRightPanel('sidechat');
    } finally {
      setSidechatOpening(false);
    }
  };

  const planMsg = planPreviewId
    ? messages.find((m) => m.id === planPreviewId && m.kind === 'text')
    : undefined;

  // 顶部按钮：折叠/展开右侧工作区面板（图标 rail 本身常驻不折叠）。
  const toggleRightPanel = async (): Promise<void> => {
    if (rightPanel) {
      // 折叠 plan 面板时清掉预览标记，否则上面的 effect 会立刻重新弹出。
      if (rightPanel === 'plan') useChatStore.getState().setPlanPreview(sessionId, undefined);
      setRightPanel(null);
      return;
    }
    if (lastPanel === 'workspace' && isWork) {
      setRightPanel('workspace');
      return;
    }
    if (lastPanel === 'sidechat' && meta) {
      setSidechatOpening(true);
      try {
        await openSidechat(sessionId);
        setRightPanel('sidechat');
      } finally {
        setSidechatOpening(false);
      }
      return;
    }
    if (lastPanel === 'plan' && planMsg) {
      setRightPanel('plan');
      return;
    }
    // 回退：work 会话优先工作区，普通会话展开 sidechat。
    if (isWork) {
      setRightPanel('workspace');
    } else if (meta) {
      setSidechatOpening(true);
      try {
        await openSidechat(sessionId);
        setRightPanel('sidechat');
      } finally {
        setSidechatOpening(false);
      }
    }
  };

  const railButtons = (
    <>
      <RailButton
        title={rightPanel ? t('collapseRail') : t('expandRail')}
        active={!!rightPanel}
        onClick={() => void toggleRightPanel()}
      >
        {rightPanel ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
      </RailButton>
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
          disabled={creating || sidechatOpening || meta.status === 'starting'}
          onClick={() => void onSidechat()}
        >
          {sidechatOpening ? <Loader2 size={16} className="animate-spin text-accent" /> : <MessagesSquare size={16} />}
        </RailButton>
      )}
    </>
  );

  return (
    <div className="relative flex h-full min-w-0">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 px-5">
          <span className="min-w-0 truncate text-sm font-medium">{meta?.title ?? '会话'}</span>
          {isWork && meta && (
            <span className="truncate rounded-md bg-bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft">{meta.cwd}</span>
          )}
          <div className="flex-1" />
          <Heartbeat sessionId={sessionId} busy={meta?.status === 'running' || meta?.status === 'awaiting'} awaiting={meta?.status === 'awaiting'} />
        </header>

        {/* 消息滚动区 — relative 供刻度条测量锚点；左缘叠加 codex 同款回合导航刻度 */}
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="relative h-full overflow-y-auto">
            <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 px-6 py-6">
              {messages.length === 0 && (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink-faint">
                  {meta?.status === 'starting' ? (
                    <>
                      <Loader2 size={20} className="animate-spin text-accent" />
                      <span className="text-[14px]">引擎启动中…</span>
                    </>
                  ) : (
                    <span className="text-[14px]">发送第一条消息开始对话</span>
                  )}
                </div>
              )}
              {messages.map((m) =>
                m.kind === 'plan' ? null : (
                  <div key={m.id} data-msg-id={m.id}>
                    <MessageItem msg={m} sessionId={sessionId} />
                  </div>
                ),
              )}
            </div>
          </div>
          <TurnRail sessionId={sessionId} scrollRef={scrollRef} />
        </div>

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

      {/* 右侧快捷图标 rail — 常驻不折叠；顶部按钮切换旁边的工作区面板 */}
      <div className="flex w-11 shrink-0 flex-col items-center gap-1 py-2.5">
        {railButtons}
      </div>
    </div>
  );
}

/**
 * Heartbeat — liveness indicator for the running turn. Network drops
 * rarely raise an error, they just go silent; this surfaces "seconds
 * since the last engine event" and escalates color when it stalls.
 */
function Heartbeat({ sessionId, busy, awaiting }: { sessionId: string; busy: boolean; awaiting?: boolean }): JSX.Element | null {
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

  // 等待授权不是停滞 — 引擎在等用户点按钮，不走静默升级逻辑。
  if (awaiting) {
    return (
      <div className="flex items-center gap-1.5" title={t('hbAwaitingPerm')}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
        <span className="text-[11px] text-warn">{t('hbAwaitingPerm')}</span>
      </div>
    );
  }

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
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition disabled:opacity-40 ${active ? 'bg-accent-soft text-accent' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
        }`}
    >
      {children}
    </button>
  );
}
