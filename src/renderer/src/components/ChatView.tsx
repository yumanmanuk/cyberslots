/**
 * ChatView — conversation stream + composer for the active session.
 * Header carries session title, model badge and context-usage bar.
 */

import { useEffect, useRef, useState } from 'react';
import { GitBranch, PanelRightClose, PanelRightOpen } from 'lucide-react';

import { useChatStore, type SessionUiState } from '../store/chatStore';
import MessageItem from './MessageItem';
import Composer from './Composer';
import PermissionSheet from './PermissionSheet';
import PlanWidget from './PlanWidget';
import WorkspacePanel from './workspace/WorkspacePanel';

export default function ChatView({ sessionId }: { sessionId: string }): JSX.Element {
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const creating = useChatStore((s) => s.creating);
  const forkSession = useChatStore((s) => s.forkSession);
  const [panelOpen, setPanelOpen] = useState(true);
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

  return (
    <div className="flex h-full min-w-0">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <span className="min-w-0 truncate text-sm font-medium">{meta?.title ?? '会话'}</span>
          {isWork && meta && (
            <span className="truncate rounded bg-bg-panel px-2 py-0.5 font-mono text-[11px] text-ink-soft">{meta.cwd}</span>
          )}
          <div className="flex-1" />
          <UsageBar ui={ui} />
          {meta?.engine === 'kimi' && (
            <button
              title="开分支（sidechat）：基于当前会话状态另开一条独立对话"
              disabled={creating || meta.status === 'starting'}
              onClick={() => void forkSession(sessionId)}
              className="rounded-md p-1.5 text-ink-soft hover:bg-bg-hover hover:text-ink disabled:opacity-40"
            >
              <GitBranch size={15} />
            </button>
          )}
          {isWork && (
            <button
              title={panelOpen ? '收起工作区面板' : '展开工作区面板'}
              onClick={() => setPanelOpen(!panelOpen)}
              className="rounded-md p-1.5 text-ink-soft hover:bg-bg-hover hover:text-ink"
            >
              {panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          )}
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

      {isWork && panelOpen && meta && <WorkspacePanel sessionId={sessionId} root={meta.cwd} />}
    </div>
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
