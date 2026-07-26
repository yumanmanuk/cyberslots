/**
 * Sidebar — session navigator, three top-level groups (Workspaces /
 * Projects / Chats), a filter menu, and a bottom utility area
 * (scheduled-tasks entry + gear menu with language/theme quick
 * switches). Sessions nest under their workspace/project; fork
 * branches indent under their parent.
 */

import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CircleDot,
  Filter,
  Folder,
  FolderGit2,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  SquareTerminal,
  Trash2,
} from 'lucide-react';

import { DEFAULT_FILTER, useChatStore, type SidebarFilter } from '../store/chatStore';
import type { AppLanguage, AppSettings, SessionMeta, WorkspaceInfo } from '@shared/types';
import { useT, type MsgKey } from '../i18n';
import WorkspaceDialog from './WorkspaceDialog';

const EMPTY_WORKSPACES: WorkspaceInfo[] = [];

export default function Sidebar(): JSX.Element {
  const t = useT();
  const sessions = useChatStore((s) => s.sessions);
  // Stable fallback — inline `?? []` creates a fresh array per snapshot and
  // sends React's useSyncExternalStore into an infinite loop (白屏根因).
  const workspaces = useChatStore((s) => s.settings?.workspaces) ?? EMPTY_WORKSPACES;
  const filter = useChatStore((s) => s.filter);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const selectSession = useChatStore((s) => s.selectSession);
  const [wsDialog, setWsDialog] = useState<{ open: boolean; editing: WorkspaceInfo | null }>({ open: false, editing: null });

  const visible = useMemo(() => applyFilter(sessions, filter), [sessions, filter]);
  const groups = useMemo(() => groupSessions(visible, workspaces), [visible, workspaces]);

  // 分组头“+”快捷创建（默认主引擎 kimi）
  const createSession = useChatStore((s) => s.createSession);
  const quickNewChat = (): void => void createSession({ engine: 'kimi', cwd: '' });
  const quickNewProject = async (): Promise<void> => {
    const dir = await window.cyberslots.dialogPickFolder();
    if (dir) await createSession({ engine: 'kimi', cwd: dir });
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-bg-panel">
      {/* 新会话 + 小节工具条 */}
      <div className="px-3 pb-1 pt-3">
        <button
          onClick={() => useChatStore.setState({ activeSessionId: null })}
          className="flex w-full items-center gap-2 rounded-xl border border-line bg-bg-input px-3 py-2 text-ui text-ink-soft shadow-sm transition hover:border-ink-faint hover:text-ink"
        >
          <Plus size={14} /> {t('newSession')}
        </button>
      </div>
      <div className="flex items-center justify-between px-4 pb-1 pt-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Sessions</span>
        <FilterMenu />
      </div>

      {/* 分组滚动区 */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        <GroupHeader label={t('workspaces')} addTitle={t('newWorkspace')} onAdd={() => setWsDialog({ open: true, editing: null })} />
        {groups.workspaces.length === 0 && <EmptyHint />}
        {groups.workspaces.map(({ workspace, sessions: list }) => (
          <WorkspaceGroup
            key={workspace.id}
            workspace={workspace}
            sessions={list}
            activeSessionId={activeSessionId}
            onSelect={selectSession}
            onEdit={() => setWsDialog({ open: true, editing: workspace })}
          />
        ))}

        <GroupHeader label={t('projects')} addTitle={t('newProject')} onAdd={() => void quickNewProject()} />
        {groups.projects.length === 0 && <EmptyHint />}
        {groups.projects.map(({ cwd, name, sessions: list }) => (
          <ProjectGroup key={cwd} cwd={cwd} name={name} sessions={list} activeSessionId={activeSessionId} onSelect={selectSession} />
        ))}

        <GroupHeader label={t('chats')} addTitle={t('newChat')} onAdd={quickNewChat} />
        {groups.chats.length === 0 && <EmptyHint />}
        {arrange(groups.chats).map(({ meta, depth }) => (
          <SessionRow key={meta.id} meta={meta} depth={depth} active={meta.id === activeSessionId} onClick={() => selectSession(meta.id)} />
        ))}
      </nav>

      {/* 左下角功能入口区 */}
      <div className="border-t border-line px-2 pb-2 pt-2">
        <button
          onClick={() => useChatStore.setState({ cronOpen: true })}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-ui text-ink-soft transition hover:bg-bg-hover hover:text-ink"
        >
          <CalendarClock size={15} />
          {t('scheduled')}
        </button>
        <div className="mt-1 flex items-center justify-between px-2.5 pt-1">
          <span className="text-[11px] text-ink-faint">{t('appName')}</span>
          <GearMenu />
        </div>
      </div>

      <WorkspaceDialog open={wsDialog.open} editing={wsDialog.editing} onClose={() => setWsDialog({ open: false, editing: null })} />
    </aside>
  );
}

// ------------------------------------------------------------- grouping

interface Groups {
  workspaces: Array<{ workspace: WorkspaceInfo; sessions: SessionMeta[] }>;
  projects: Array<{ cwd: string; name: string; sessions: SessionMeta[] }>;
  chats: SessionMeta[];
}

function groupSessions(sessions: SessionMeta[], workspaces: WorkspaceInfo[]): Groups {
  const wsIds = new Set(workspaces.map((w) => w.id));
  const chats: SessionMeta[] = [];
  const byWs = new Map<string, SessionMeta[]>();
  const byCwd = new Map<string, SessionMeta[]>();

  for (const s of sessions) {
    if (s.workspaceId && wsIds.has(s.workspaceId)) {
      byWs.set(s.workspaceId, [...(byWs.get(s.workspaceId) ?? []), s]);
    } else if (s.chatMode === 'work') {
      byCwd.set(s.cwd, [...(byCwd.get(s.cwd) ?? []), s]);
    } else {
      chats.push(s);
    }
  }

  return {
    workspaces: workspaces.map((workspace) => ({ workspace, sessions: byWs.get(workspace.id) ?? [] })),
    projects: [...byCwd.entries()]
      .map(([cwd, list]) => ({ cwd, name: cwd.split(/[\\/]/).pop() ?? cwd, sessions: list }))
      .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0)),
    chats,
  };
}

function applyFilter(sessions: SessionMeta[], f: SidebarFilter): SessionMeta[] {
  let out = sessions;
  if (f.status !== 'all') {
    out = out.filter((s) => {
      switch (f.status) {
        case 'running':
          return s.status === 'running' || s.status === 'starting';
        case 'awaiting':
          return s.status === 'awaiting';
        case 'error':
          return s.status === 'error';
        case 'done':
          return s.status === 'idle' || s.status === 'closed';
        default:
          return true;
      }
    });
  }
  if (f.unreadOnly) out = out.filter((s) => s.unread);
  return [...out].sort((a, b) => (f.sort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt));
}

/** Order sessions so fork branches nest right under their parent. */
function arrange(sessions: SessionMeta[]): Array<{ meta: SessionMeta; depth: number }> {
  const byParent = new Map<string, SessionMeta[]>();
  const ids = new Set(sessions.map((s) => s.id));
  const roots: SessionMeta[] = [];
  for (const s of sessions) {
    if (s.parentId && ids.has(s.parentId)) {
      byParent.set(s.parentId, [...(byParent.get(s.parentId) ?? []), s]);
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

// ---------------------------------------------------------------- pieces

function GroupHeader({ label, addTitle, onAdd }: { label: string; addTitle?: string; onAdd?: () => void }): JSX.Element {
  return (
    <div className="group/head flex items-center justify-between px-2 pb-0.5 pt-3">
      <span className="text-[11px] font-semibold text-ink-faint">{label}</span>
      {onAdd && (
        <button
          title={addTitle}
          onClick={onAdd}
          className="rounded-md p-0.5 text-ink-faint opacity-0 transition hover:bg-bg-hover hover:text-ink group-hover/head:opacity-100"
        >
          <Plus size={13} />
        </button>
      )}
    </div>
  );
}

function EmptyHint(): JSX.Element {
  const t = useT();
  return <div className="px-2 py-1 text-[11px] text-ink-faint/70">{t('noSessions')}</div>;
}

function WorkspaceGroup({
  workspace,
  sessions,
  activeSessionId,
  onSelect,
  onEdit,
}: {
  workspace: WorkspaceInfo;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onEdit: () => void;
}): JSX.Element {
  const t = useT();
  const removeWorkspace = useChatStore((s) => s.removeWorkspace);
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <div className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-bg-hover">
        <button onClick={() => setExpanded(!expanded)} className="flex min-w-0 flex-1 items-center gap-2 text-ui text-ink">
          {/* 文件夹开合即展开态（取代旋转箭头）；workspace 叠加 git 徽标区分 */}
          {expanded ? (
            <FolderOpen size={15} className="shrink-0 text-ink-soft" />
          ) : (
            <FolderGit2 size={15} className="shrink-0 text-ink-soft" />
          )}
          <span className="min-w-0 truncate font-medium">{workspace.name}</span>
          <span className="shrink-0 text-[10px] text-ink-faint">×{workspace.folders.length}</span>
        </button>
        <DotMenu
          items={[
            { icon: <Pencil size={13} />, label: t('renameWorkspace'), onClick: onEdit },
            {
              icon: <SquareTerminal size={13} />,
              label: t('openTerminal'),
              onClick: () => void window.cyberslots.openIn('terminal', workspace.folders[0] ?? ''),
            },
            {
              icon: <Folder size={13} />,
              label: t('openInEditor'),
              onClick: () => void window.cyberslots.openIn('vscode', workspace.folders[0] ?? ''),
            },
            { icon: <Trash2 size={13} />, label: t('removeWorkspace'), danger: true, onClick: () => void removeWorkspace(workspace.id) },
          ]}
        />
      </div>
      {expanded &&
        arrange(sessions).map(({ meta, depth }) => (
          <SessionRow key={meta.id} meta={meta} depth={depth + 1} active={meta.id === activeSessionId} onClick={() => onSelect(meta.id)} />
        ))}
    </div>
  );
}

function ProjectGroup({
  cwd,
  name,
  sessions,
  activeSessionId,
  onSelect,
}: {
  cwd: string;
  name: string;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  return (
    <div>
      <div className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-bg-hover">
        <button onClick={() => setExpanded(!expanded)} title={cwd} className="flex min-w-0 flex-1 items-center gap-2 text-ui text-ink">
          {expanded ? (
            <FolderOpen size={15} className="shrink-0 text-ink-soft" />
          ) : (
            <Folder size={15} className="shrink-0 text-ink-soft" />
          )}
          <span className="min-w-0 truncate font-medium">{name}</span>
        </button>
        <DotMenu
          items={[
            { icon: <SquareTerminal size={13} />, label: t('openTerminal'), onClick: () => void window.cyberslots.openIn('terminal', cwd) },
            { icon: <Folder size={13} />, label: t('openInEditor'), onClick: () => void window.cyberslots.openIn('vscode', cwd) },
          ]}
        />
      </div>
      {expanded &&
        arrange(sessions).map(({ meta, depth }) => (
          <SessionRow key={meta.id} meta={meta} depth={depth + 1} active={meta.id === activeSessionId} onClick={() => onSelect(meta.id)} />
        ))}
    </div>
  );
}

function SessionRow({ meta, depth, active, onClick }: { meta: SessionMeta; depth: number; active: boolean; onClick: () => void }): JSX.Element {
  const t = useT();
  const deleteSession = useChatStore((s) => s.deleteSession);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const onDelete = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (!confirming) {
      // 二段确认：第一次点击进入确认态，3 秒内再点才真正删除。
      setConfirming(true);
      timer.current = setTimeout(() => setConfirming(false), 3000);
      return;
    }
    clearTimeout(timer.current);
    void deleteSession(meta.id);
  };

  return (
    <div
      onClick={onClick}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      className={`group flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-ui ${
        active ? 'bg-bg-active text-ink' : 'text-ink-soft hover:bg-bg-hover'
      }`}
    >
      <StatusIcon status={meta.status} />
      <span className="min-w-0 flex-1 truncate">{meta.title}</span>
      {meta.unread && <span title="未读" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
      <span className="text-[10px] tabular-nums text-ink-faint group-hover:hidden">{timeAgo(meta.updatedAt)}</span>
      <button
        title={confirming ? t('confirmDelete') : t('remove')}
        onClick={onDelete}
        onMouseLeave={() => {
          clearTimeout(timer.current);
          setConfirming(false);
        }}
        className={`hidden rounded-md p-0.5 transition group-hover:block ${
          confirming ? 'block bg-err/15 text-err' : 'text-ink-faint hover:text-err'
        }`}
      >
        {confirming ? <Check size={13} /> : <Trash2 size={13} />}
      </button>
    </div>
  );
}

/** Prominent state icons: spinner=running, pulse=awaiting, triangle=error. */
function StatusIcon({ status }: { status: SessionMeta['status'] }): JSX.Element | null {
  switch (status) {
    case 'running':
    case 'starting':
      return <Loader2 size={13} className="shrink-0 animate-spin text-accent" />;
    case 'awaiting':
      return <CircleDot size={12} className="shrink-0 animate-pulse text-warn" />;
    case 'error':
      return <AlertTriangle size={12} className="shrink-0 text-err" />;
    default:
      return <CircleDot size={11} className="shrink-0 text-ink-faint/50" />;
  }
}

// ------------------------------------------------------------ filter menu

function FilterMenu(): JSX.Element {
  const t = useT();
  const filter = useChatStore((s) => s.filter);
  const [open, setOpen] = useState(false);
  const dirty = JSON.stringify(filter) !== JSON.stringify(DEFAULT_FILTER);
  const patch = (p: Partial<SidebarFilter>): void => useChatStore.setState({ filter: { ...filter, ...p } });

  const statusItems: Array<{ id: SidebarFilter['status']; label: string }> = [
    { id: 'all', label: t('all') },
    { id: 'running', label: t('statusRunning') },
    { id: 'awaiting', label: t('statusAwaiting') },
    { id: 'error', label: t('statusError') },
    { id: 'done', label: t('statusDone') },
  ];

  return (
    <div className="relative">
      <button
        title={t('filter')}
        onClick={() => setOpen(!open)}
        className={`rounded-md p-1 transition hover:bg-bg-hover ${dirty ? 'text-accent' : 'text-ink-faint hover:text-ink'}`}
      >
        <Filter size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-7 z-20 w-52 rounded-xl border border-line bg-bg-input py-1.5 shadow-lg">
            <MenuSection label={t('sortBy')} />
            <MenuCheck label={t('sortUpdated')} checked={filter.sort === 'updated'} onClick={() => patch({ sort: 'updated' })} />
            <MenuCheck label={t('sortCreated')} checked={filter.sort === 'created'} onClick={() => patch({ sort: 'created' })} />
            <MenuSection label={t('filterStatus')} />
            {statusItems.map((s) => (
              <MenuCheck key={s.id} label={s.label} checked={filter.status === s.id} onClick={() => patch({ status: s.id })} />
            ))}
            <MenuSection label={t('filterUnread')} />
            <MenuCheck label={t('unreadOnly')} checked={filter.unreadOnly} onClick={() => patch({ unreadOnly: !filter.unreadOnly })} />
            <div className="mx-3 my-1 border-t border-line" />
            <button
              onClick={() => {
                useChatStore.setState({ filter: DEFAULT_FILTER });
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-ui text-ink-soft transition hover:bg-bg-hover"
            >
              {t('reset')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function MenuSection({ label }: { label: string }): JSX.Element {
  return <div className="px-3 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">{label}</div>;
}

function MenuCheck({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }): JSX.Element {
  return (
    <button onClick={onClick} className="flex w-full items-center justify-between px-3 py-1.5 text-left text-ui transition hover:bg-bg-hover">
      <span className={checked ? 'font-medium text-ink' : 'text-ink-soft'}>{label}</span>
      {checked && <Check size={13} className="text-accent" />}
    </button>
  );
}

// -------------------------------------------------------------- gear menu

const THEME_ITEMS: Array<{ id: AppSettings['theme']; key: MsgKey }> = [
  { id: 'notion', key: 'themeNotion' },
  { id: 'light', key: 'themeLight' },
  { id: 'dark', key: 'themeDark' },
];

const LANG_ITEMS: Array<{ id: AppLanguage; key: MsgKey }> = [
  { id: 'zh', key: 'langZh' },
  { id: 'en', key: 'langEn' },
];

function GearMenu(): JSX.Element {
  const t = useT();
  const settings = useChatStore((s) => s.settings);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        title={t('settings')}
        onClick={() => setOpen(!open)}
        className="rounded-md p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
      >
        <Settings size={15} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-8 right-0 z-20 w-48 rounded-xl border border-line bg-bg-input py-1.5 shadow-lg">
            <button
              onClick={() => {
                setOpen(false);
                useChatStore.setState({ settingsOpen: true });
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-ink transition hover:bg-bg-hover"
            >
              <Settings size={13} /> {t('settings')}
            </button>
            <div className="mx-3 my-1 border-t border-line" />
            <MenuSection label={t('language')} />
            {LANG_ITEMS.map((l) => (
              <MenuCheck
                key={l.id}
                label={t(l.key)}
                checked={settings?.language === l.id}
                onClick={() => void saveSettings({ language: l.id })}
              />
            ))}
            <MenuSection label={t('theme')} />
            {THEME_ITEMS.map((th) => (
              <MenuCheck
                key={th.id}
                label={t(th.key)}
                checked={settings?.theme === th.id}
                onClick={() => void saveSettings({ theme: th.id })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ tiny menu

interface DotMenuItem {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}

function DotMenu({ items }: { items: DotMenuItem[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-bg-active hover:text-ink group-hover:opacity-100"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-20 w-44 rounded-xl border border-line bg-bg-input py-1 shadow-lg">
            {items.map((item) => (
              <button
                key={item.label}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onClick();
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui transition hover:bg-bg-hover ${
                  item.danger ? 'text-err' : 'text-ink'
                }`}
              >
                {item.icon} {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
