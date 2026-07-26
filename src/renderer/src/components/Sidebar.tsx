/**
 * Sidebar — session list (codex desktop style: slim, grouped, time badges)
 * plus the "new session" entry.
 */

import { CalendarClock, Plus, Settings, Trash2, Loader2, CircleDot } from 'lucide-react';

import { useChatStore } from '../store/chatStore';
import type { SessionMeta } from '@shared/types';

/** Order sessions so fork branches nest right under their parent. */
function arrange(sessions: SessionMeta[]): Array<{ meta: SessionMeta; depth: number }> {
  const byParent = new Map<string, SessionMeta[]>();
  const ids = new Set(sessions.map((s) => s.id));
  const roots: SessionMeta[] = [];
  for (const s of sessions) {
    if (s.parentId && ids.has(s.parentId)) {
      const list = byParent.get(s.parentId) ?? [];
      list.push(s);
      byParent.set(s.parentId, list);
    } else {
      roots.push(s);
    }
  }
  const out: Array<{ meta: SessionMeta; depth: number }> = [];
  const walk = (meta: SessionMeta, depth: number): void => {
    out.push({ meta, depth });
    for (const child of byParent.get(meta.id) ?? []) walk(child, Math.min(depth + 1, 3));
  };
  for (const r of roots) walk(r, 0);
  return out;
}

export default function Sidebar(): JSX.Element {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const selectSession = useChatStore((s) => s.selectSession);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-bg-panel">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <span className="text-ui font-semibold tracking-wide text-ink-soft">赛博老虎机</span>
        <div className="flex items-center">
          <button
            title="定时任务"
            onClick={() => useChatStore.setState({ cronOpen: true })}
            className="rounded-md p-1.5 text-ink-soft hover:bg-bg-hover hover:text-ink"
          >
            <CalendarClock size={15} />
          </button>
          <button
            title="设置"
            onClick={() => useChatStore.setState({ settingsOpen: true })}
            className="rounded-md p-1.5 text-ink-soft hover:bg-bg-hover hover:text-ink"
          >
            <Settings size={15} />
          </button>
          <button
            title="新会话"
            onClick={() => useChatStore.setState({ activeSessionId: null })}
            className="rounded-md p-1.5 text-ink-soft hover:bg-bg-hover hover:text-ink"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        <div className="px-1 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          Chats
        </div>
        {sessions.length === 0 && (
          <div className="px-2 py-6 text-center text-ui text-ink-faint">还没有会话</div>
        )}
        {arrange(sessions).map(({ meta, depth }) => (
          <SessionRow key={meta.id} meta={meta} depth={depth} active={meta.id === activeSessionId} onClick={() => selectSession(meta.id)} />
        ))}
      </nav>
    </aside>
  );
}

function SessionRow({ meta, depth, active, onClick }: { meta: SessionMeta; depth: number; active: boolean; onClick: () => void }): JSX.Element {
  const deleteSession = useChatStore((s) => s.deleteSession);
  return (
    <div
      onClick={onClick}
      style={depth > 0 ? { paddingLeft: `${8 + depth * 14}px` } : undefined}
      className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-ui ${
        active ? 'bg-bg-active text-ink' : 'text-ink-soft hover:bg-bg-hover'
      }`}
    >
      <StatusDot status={meta.status} />
      <span className="min-w-0 flex-1 truncate">{meta.title}</span>
      <span className="text-[10px] text-ink-faint">{timeAgo(meta.updatedAt)}</span>
      <button
        title="删除"
        onClick={(e) => {
          e.stopPropagation();
          void deleteSession(meta.id);
        }}
        className="hidden rounded p-0.5 text-ink-faint hover:text-err group-hover:block"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function StatusDot({ status }: { status: SessionMeta['status'] }): JSX.Element {
  if (status === 'running' || status === 'starting') {
    return <Loader2 size={12} className="shrink-0 animate-spin text-accent" />;
  }
  const color =
    status === 'awaiting' ? 'text-warn' : status === 'error' ? 'text-err' : status === 'idle' ? 'text-ok' : 'text-ink-faint';
  return <CircleDot size={11} className={`shrink-0 ${color}`} />;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
