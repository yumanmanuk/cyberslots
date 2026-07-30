/**
 * Sidebar — session navigator, three top-level groups (Workspaces /
 * Projects / Chats), a filter menu, and a bottom utility area
 * (scheduled-tasks entry + gear menu with language/theme quick
 * switches). Sessions nest under their workspace/project; fork
 * branches indent under their parent.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Filter,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Languages,
  LayoutDashboard,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  SquareTerminal,
  Trash2,
} from 'lucide-react';

import { DEFAULT_FILTER, useChatStore, type SidebarFilter } from '../store/chatStore';
import { useRaceStore } from '../store/raceStore';
import type { AppLanguage, AppSettings, EngineId, SessionMeta, WorkspaceInfo } from '@shared/types';
import { isRaceActive, raceHostArchived } from '@shared/race';
import { useT, type MsgKey } from '../i18n';
import WorkspaceDialog from './WorkspaceDialog';
import { EngineIcon, ENGINE_LABELS, useEngineOrder } from './EngineIcon';
import { UsageQuickButton } from './UsageQuota';
import { BrandMark, BrandSpinner } from './brand';

const EMPTY_WORKSPACES: WorkspaceInfo[] = [];

/** 归档拦截：会话正在跑，或名下有进行中的赛马（被打断的不算）。
 *  非响应式取快照 — 批量归档与点击时兜底用；行内按钮的反应式
 *  禁用态在 SessionRow 里另行订阅。 */
function archiveBlocked(meta: SessionMeta): boolean {
  if (meta.status === 'running' || meta.status === 'starting') return true;
  return Object.values(useRaceStore.getState().races).some((g) => g.parentSessionId === meta.id && isRaceActive(g));
}

/** Escape 关闭弹层（侧栏内的裸 popover 用）。 */
function useEscClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

export default function Sidebar({ overlay }: { overlay?: boolean }): JSX.Element {
  const t = useT();
  const sessions = useChatStore((s) => s.sessions);
  // Stable fallback — inline `?? []` creates a fresh array per snapshot and
  // sends React's useSyncExternalStore into an infinite loop (白屏根因).
  const workspaces = useChatStore((s) => s.settings?.workspaces) ?? EMPTY_WORKSPACES;
  const filter = useChatStore((s) => s.filter);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const selectSession = useChatStore((s) => s.selectSession);
  const [wsDialog, setWsDialog] = useState<{ open: boolean; editing: WorkspaceInfo | null }>({ open: false, editing: null });

  // 赛马角色会话（raceId 标记）不入侧栏 —— 赛马寄生于宿主对话，
  // 只能从宿主对话的 🏇 入口进赛马视图查看。
  const visible = useMemo(() => applyFilter(sessions.filter((m) => !m.raceId), filter), [sessions, filter]);
  const groups = useMemo(() => groupSessions(visible, workspaces, sessions), [visible, workspaces, sessions]);
  const archivedCount = useMemo(() => sessions.filter((s) => s.archived).length, [sessions]);
  // 总控制台入口角标：等你处理的会话数（awaiting/error）+ 等决策的赛马。
  const races = useRaceStore((s) => s.races);
  const inboxCount = useMemo(() => {
    // 宿主已归档的赛马不计入角标（与总控台泳道/待办口径一致）。
    const archivedIds = new Set(sessions.filter((s) => s.archived).map((s) => s.id));
    return (
      sessions.filter((m) => !m.archived && !m.raceId && (m.status === 'awaiting' || m.status === 'error')).length +
      Object.values(races).filter((g) => g.stage === 'judging' && !g.adopt && !raceHostArchived(g, archivedIds)).length
    );
  }, [sessions, races]);

  // 分组头“+”快捷创建 — 先选引擎再建会话，避免进会话后切引擎产生分支
  const createSession = useChatStore((s) => s.createSession);
  const quickNewChat = (engine: EngineId): void => void createSession({ engine, cwd: '' });
  const quickNewProject = async (engine: EngineId): Promise<void> => {
    const dir = await window.cyberslots.dialogPickFolder();
    if (dir) await createSession({ engine, cwd: dir });
  };

  return (
    <aside
      className={`flex w-64 shrink-0 flex-col ${overlay ? 'h-full rounded-r-2xl bg-bg-canvas' : 'bg-transparent'
        }`}
    >
      {/* 新会话 + 总控制台 + 小节工具条 */}
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-3">
        <button
          onClick={() => {
            // 新建对话落地页也是导航 —— 退出赛马全屏视图（赛马后台继续）。
            useRaceStore.getState().closeRace();
            useChatStore.setState({ activeSessionId: null, dashboardOpen: false });
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-bg-input px-3 py-2 text-ui text-ink-soft shadow-sm transition hover:bg-bg-hover hover:text-ink"
        >
          <Plus size={14} /> {t('newSession')}
        </button>
        {/* 总控制台入口 — 待办数角标常驻可见 */}
        <button
          title={t('mcTitle')}
          onClick={() => useChatStore.getState().openDashboard()}
          className="relative flex shrink-0 items-center justify-center rounded-xl border border-line bg-bg-input p-2 text-ink-soft shadow-sm transition hover:bg-bg-hover hover:text-ink"
        >
          <LayoutDashboard size={15} />
          {inboxCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[9.5px] font-semibold leading-none text-white">
              {inboxCount > 9 ? '9+' : inboxCount}
            </span>
          )}
        </button>
      </div>
      <div className="flex items-center justify-between px-4 pb-1 pt-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Sessions</span>
        <FilterMenu />
      </div>

      {/* 分组滚动区 */}
      <nav className="scroll-quiet flex-1 overflow-y-auto px-2 pb-2">
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

        <GroupHeader label={t('projects')} addTitle={t('newProject')} onAddEngine={(engine) => void quickNewProject(engine)} />
        {groups.projects.length === 0 && <EmptyHint />}
        {groups.projects.map(({ cwd, name, sessions: list }) => (
          <ProjectGroup key={cwd} cwd={cwd} name={name} sessions={list} activeSessionId={activeSessionId} onSelect={selectSession} />
        ))}

        <GroupHeader label={t('chats')} addTitle={t('newChat')} onAddEngine={quickNewChat} />
        {groups.chats.length === 0 && <EmptyHint />}
        {arrange(groups.chats).map(({ meta, depth }) => (
          <SessionRow key={meta.id} meta={meta} depth={depth} active={meta.id === activeSessionId} onClick={() => selectSession(meta.id)} />
        ))}
      </nav>

      {/* 左下角功能入口区 — 靠留白分隔，不用分隔线 */}
      <div className="px-2 pb-2 pt-2">
        <button
          onClick={() => useChatStore.setState({ cronOpen: true })}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-ui text-ink-soft transition hover:bg-bg-hover hover:text-ink"
        >
          <CalendarClock size={15} />
          {t('scheduled')}
        </button>
        {archivedCount > 0 && (
          <button
            onClick={() => useChatStore.setState({ archivedOpen: true })}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-ui text-ink-soft transition hover:bg-bg-hover hover:text-ink"
          >
            <Archive size={15} />
            <span className="min-w-0 flex-1 truncate text-left">{t('archivedEntry')}</span>
            <span className="shrink-0 rounded-md bg-bg-active px-1.5 text-[10.5px] tabular-nums text-ink-faint">{archivedCount}</span>
          </button>
        )}
        <div className="mt-1 flex items-center justify-between px-2.5 pt-1">
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <BrandMark size={13} />
            {t('appName')}
          </span>
          <div className="flex items-center gap-0.5">
            {/* 用量入口在设置齿轮左侧 — 悬浮弹今日用量小窗，点击开大窗 */}
            <UsageQuickButton />
            <GearMenu />
          </div>
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

function groupSessions(sessions: SessionMeta[], workspaces: WorkspaceInfo[], allSessions: SessionMeta[]): Groups {
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

  // Project 组常驻：会话全部归档（或被筛选器滤空）后项目不消失，空置显示。
  // cwd 集合与排序时间戳都从全量列表推导，谓词与上面的分组规则一致。
  const latestByCwd = new Map<string, number>();
  for (const s of allSessions) {
    if (s.raceId || s.chatMode !== 'work' || (s.workspaceId && wsIds.has(s.workspaceId))) continue;
    if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, []);
    latestByCwd.set(s.cwd, Math.max(latestByCwd.get(s.cwd) ?? 0, s.updatedAt));
  }

  return {
    workspaces: workspaces.map((workspace) => ({ workspace, sessions: byWs.get(workspace.id) ?? [] })),
    projects: [...byCwd.entries()]
      .map(([cwd, list]) => ({ cwd, name: cwd.split(/[\\/]/).pop() ?? cwd, sessions: list }))
      .sort((a, b) => (latestByCwd.get(b.cwd) ?? 0) - (latestByCwd.get(a.cwd) ?? 0)),
    chats,
  };
}

function applyFilter(sessions: SessionMeta[], f: SidebarFilter): SessionMeta[] {
  // 归档的会话不进侧栏 — 只在「已归档」入口里查看。
  let out = sessions.filter((s) => !s.archived);
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

function GroupHeader({
  label,
  addTitle,
  onAdd,
  onAddEngine,
}: {
  label: string;
  addTitle?: string;
  onAdd?: () => void;
  onAddEngine?: (engine: EngineId) => void;
}): JSX.Element {
  return (
    <div className="group/head flex min-h-[34px] items-center justify-between px-2 pb-1 pt-3">
      <span className="text-[11px] font-semibold text-ink-faint">{label}</span>
      {onAddEngine ? (
        <EnginePick
          title={addTitle}
          onPick={onAddEngine}
          btnClass="rounded-md p-1.5 text-ink-faint opacity-0 transition hover:bg-bg-hover hover:text-ink group-hover/head:opacity-100"
          iconSize={13}
        />
      ) : (
        onAdd && (
          <button
            title={addTitle}
            onClick={onAdd}
            className="rounded-md p-1.5 text-ink-faint opacity-0 transition hover:bg-bg-hover hover:text-ink group-hover/head:opacity-100"
          >
            <Plus size={13} />
          </button>
        )
      )}
    </div>
  );
}

/** 快捷创建的引擎选择 — 建会话时定引擎，避免进会话后切引擎走 forkToEngine 产生分支。
 *  列表顺序跟随设置 engineOrder。 */
function EnginePick({
  title,
  onPick,
  btnClass,
  iconSize,
}: {
  title?: string;
  onPick: (engine: EngineId) => void;
  btnClass: string;
  iconSize: number;
}): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const availability = useChatStore((s) => s.engineAvailability);
  const engineOrder = useEngineOrder();
  useEscClose(open, () => setOpen(false));
  return (
    <div className="relative">
      <button
        ref={btnRef}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) {
            // 靠近视口底部时向上弹出，避免菜单被窗口下缘遮挡（chats 分组靠底时）。
            const rect = btnRef.current?.getBoundingClientRect();
            setDropUp(!!rect && window.innerHeight - rect.bottom < 170);
          }
          setOpen(!open);
        }}
        className={btnClass}
      >
        <Plus size={iconSize} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`absolute right-0 z-20 w-36 rounded-xl border border-line bg-bg-input py-1 shadow-lg ${dropUp ? 'bottom-6' : 'top-6'}`}
          >
            <MenuSection label={t('pickEngine')} />
            {engineOrder.map((id) => {
              // 未安装置灰展示（可见不可选）；尚未探测（null）时不置灰。
              const unavailable = availability ? !availability[id] : false;
              return (
                <button
                  key={id}
                  disabled={unavailable}
                  title={unavailable ? '未检测到本机安装，详见设置-模型页' : undefined}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setOpen(false);
                    onPick(id);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui transition ${unavailable ? 'cursor-not-allowed text-ink-faint opacity-40' : 'text-ink hover:bg-bg-hover'
                    }`}
                >
                  <EngineIcon engine={id} size={13} />
                  {ENGINE_LABELS[id]}
                </button>
              );
            })}
          </div>
        </>
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
  const createSession = useChatStore((s) => s.createSession);
  const archiveSession = useChatStore((s) => s.archiveSession);
  // 组内还有对话时禁止移除（查全量列表，不受侧栏筛选器影响；已归档的不算）。
  const hasSessions = useChatStore((s) => s.sessions.some((x) => x.workspaceId === workspace.id && !x.archived));
  const [expanded, setExpanded] = useState(true);

  /** 归档本工作区全部未归档会话（取全量列表，不受侧栏筛选影响；
   *  进行中的跳过）。 */
  const archiveAll = async (): Promise<void> => {
    const list = useChatStore
      .getState()
      .sessions.filter((x) => x.workspaceId === workspace.id && !x.archived && !archiveBlocked(x));
    for (const s of list) await archiveSession(s.id, true);
  };

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
            { icon: <Pencil size={13} />, label: t('manageWorkspace'), onClick: onEdit },
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
            {
              icon: <FolderOpen size={13} />,
              label: t('openInExplorer'),
              onClick: () => void window.cyberslots.openIn('explorer', workspace.folders[0] ?? ''),
            },
            {
              icon: <Archive size={13} />,
              label: t('archiveAllChats'),
              confirmLabel: t('confirmArchive'),
              disabled: !hasSessions,
              onClick: () => void archiveAll(),
            },
            {
              icon: <Trash2 size={13} />,
              label: t('removeWorkspace'),
              danger: true,
              disabled: hasSessions,
              title: hasSessions ? t('removeWorkspaceBlocked') : undefined,
              onClick: () => void removeWorkspace(workspace.id),
            },
          ]}
        />
        <EnginePick
          title={t('newSession')}
          onPick={(engine) => void createSession({ engine, cwd: '', workspaceId: workspace.id })}
          btnClass="rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-bg-active hover:text-ink group-hover:opacity-100"
          iconSize={14}
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
  const convertProjectToWorkspace = useChatStore((s) => s.convertProjectToWorkspace);
  const createSession = useChatStore((s) => s.createSession);
  const archiveSession = useChatStore((s) => s.archiveSession);
  const [expanded, setExpanded] = useState(true);

  /** 归档本项目全部未归档会话 — 谓词与 groupSessions 的分组规则一致，
   *  取全量列表避免遭侧栏筛选器遮蔽；进行中的跳过。 */
  const archiveAll = async (): Promise<void> => {
    const { sessions, settings } = useChatStore.getState();
    const wsIds = new Set((settings?.workspaces ?? []).map((w) => w.id));
    const list = sessions.filter(
      (x) =>
        !x.archived &&
        x.cwd === cwd &&
        x.chatMode === 'work' &&
        (!x.workspaceId || !wsIds.has(x.workspaceId)) &&
        !archiveBlocked(x),
    );
    for (const s of list) await archiveSession(s.id, true);
  };

  /** Project → Workspace：选一个新目录，和现有 cwd 合并成多目录工作区，
   *  本组会话整体迁入新工作区（引擎下一条消息前获知新目录）。 */
  const convert = async (): Promise<void> => {
    const dir = await window.cyberslots.dialogPickFolder();
    if (!dir) return;
    const folders = dir === cwd ? [cwd] : [cwd, dir];
    await convertProjectToWorkspace(cwd, name, folders);
  };

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
            { icon: <FolderPlus size={13} />, label: t('convertToWorkspace'), onClick: () => void convert() },
            { icon: <SquareTerminal size={13} />, label: t('openTerminal'), onClick: () => void window.cyberslots.openIn('terminal', cwd) },
            { icon: <Folder size={13} />, label: t('openInEditor'), onClick: () => void window.cyberslots.openIn('vscode', cwd) },
            { icon: <FolderOpen size={13} />, label: t('openInExplorer'), onClick: () => void window.cyberslots.openIn('explorer', cwd) },
            { icon: <Archive size={13} />, label: t('archiveAllChats'), confirmLabel: t('confirmArchive'), onClick: () => void archiveAll() },
          ]}
        />
        <EnginePick
          title={t('newSession')}
          onPick={(engine) => void createSession({ engine, cwd })}
          btnClass="rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-bg-active hover:text-ink group-hover:opacity-100"
          iconSize={14}
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
  const archiveSession = useChatStore((s) => s.archiveSession);
  // 反应式拦截态：会话在跑 / 名下有进行中赛马（选择器返回布尔，不产生新引用）。
  const raceBusy = useRaceStore((s) => Object.values(s.races).some((g) => g.parentSessionId === meta.id && isRaceActive(g)));
  const blocked = meta.status === 'running' || meta.status === 'starting' || raceBusy;
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // 侧栏不提供删除 — 只能归档；彻底删除去「已归档」页操作。
  const onArchive = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (blocked) return;
    if (!confirming) {
      // 二段确认：第一次点击进入确认态（3 秒内再点才真正归档）。
      setConfirming(true);
      timer.current = setTimeout(() => setConfirming(false), 3000);
      return;
    }
    clearTimeout(timer.current);
    void archiveSession(meta.id, true);
  };

  return (
    <div
      onClick={onClick}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      className={`group flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-ui text-ink ${active ? 'bg-bg-active' : 'hover:bg-bg-hover'
        }`}
    >
      <span className="min-w-0 flex-1 truncate">{meta.title}</span>
      {/* 右侧状态位（codex 风）：运行中灰色菜单 / 待回答黄色问号 /
          报错红色叹号 / 未读（已完成未查看）金色实心点；否则显相对时间。 */}
      <span className="flex shrink-0 items-center group-hover:hidden">
        <RowIndicator meta={meta} />
      </span>
      <button
        title={blocked ? t('archiveBlockedBusy') : confirming ? t('confirmArchive') : t('archive')}
        onClick={onArchive}
        disabled={blocked}
        onMouseLeave={() => {
          clearTimeout(timer.current);
          setConfirming(false);
        }}
        className={`hidden rounded-md p-0.5 transition group-hover:block ${blocked
            ? 'cursor-not-allowed text-ink-faint opacity-40'
            : confirming
              ? 'block bg-warn/15 text-warn'
              : 'text-ink-faint hover:text-ink'
          }`}
      >
        {confirming ? <Check size={13} /> : <Archive size={13} />}
      </button>
    </div>
  );
}

/** 行尾状态指示（取代左侧小图标）：spinner=运行 / 黄问号=等回答 /
 *  红叹号=报错 / 金点=未读；空闲已读显示相对时间。 */
function RowIndicator({ meta }: { meta: SessionMeta }): JSX.Element {
  switch (meta.status) {
    case 'running':
    case 'starting':
      return <BrandSpinner size={13} className="shrink-0 text-ink-soft" />;
    case 'awaiting':
      // 黄色醒目 — 需要用户行动（授权/回答），不能淹没在灰色里。
      return <CircleHelp size={14} className="shrink-0 animate-pulse text-warn" />;
    case 'error':
      return <CircleAlert size={13} className="shrink-0 text-err" />;
    default:
      if (meta.unread) return <span title="任务已完成，未查看" className="h-2 w-2 shrink-0 rounded-full bg-accent" />;
      return <span className="text-[10px] tabular-nums text-ink-faint">{timeAgo(meta.updatedAt)}</span>;
  }
}

// ------------------------------------------------------------ filter menu

function FilterMenu(): JSX.Element {
  const t = useT();
  const filter = useChatStore((s) => s.filter);
  const [open, setOpen] = useState(false);
  useEscClose(open, () => setOpen(false));
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

const MODE_ITEMS: Array<{ id: AppSettings['themeMode']; key: MsgKey }> = [
  { id: 'light', key: 'modeLight' },
  { id: 'dark', key: 'modeDark' },
  { id: 'system', key: 'modeSystem' },
];

const PALETTE_ITEMS: Array<{ id: AppSettings['themePalette']; key: MsgKey }> = [
  { id: 'notion', key: 'paletteNotion' },
  { id: 'solarized', key: 'paletteSolarized' },
  { id: 'everforest', key: 'paletteEverforest' },
];

const LANG_ITEMS: Array<{ id: AppLanguage; key: MsgKey }> = [
  { id: 'zh', key: 'langZh' },
  { id: 'en', key: 'langEn' },
];

function GearMenu(): JSX.Element {
  const t = useT();
  const settings = useChatStore((s) => s.settings);
  const saveSettings = useChatStore((s) => s.saveSettings);
  // 兼容性审计有条目 → 齿轮上小黄点（不打断的诊断入口，详情在设置→模型）。
  const hasCompatIssues = useChatStore((s) =>
    Object.values(s.compatAudit?.engines ?? {}).some((list) => (list?.length ?? 0) > 0),
  );
  const [open, setOpen] = useState(false);
  useEscClose(open, () => setOpen(false));

  return (
    <div className="relative">
      <button
        title={hasCompatIssues ? `${t('settings')}（引擎兼容性诊断有新条目）` : t('settings')}
        onClick={() => setOpen(!open)}
        className="relative rounded-md p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
      >
        <Settings size={15} />
        {hasCompatIssues && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-8 right-0 z-20 w-44 rounded-xl border border-line bg-bg-input py-1.5 shadow-lg">
            <SubMenu icon={<Languages size={13} />} label={t('language')}>
              {LANG_ITEMS.map((l) => (
                <MenuCheck
                  key={l.id}
                  label={t(l.key)}
                  checked={settings?.language === l.id}
                  onClick={() => void saveSettings({ language: l.id })}
                />
              ))}
            </SubMenu>
            <SubMenu icon={<Moon size={13} />} label={t('theme')} align="bottom">
              <MenuSection label={t('themeMode')} />
              {MODE_ITEMS.map((m) => (
                <MenuCheck
                  key={m.id}
                  label={t(m.key)}
                  checked={settings?.themeMode === m.id}
                  onClick={() => void saveSettings({ themeMode: m.id })}
                />
              ))}
              <MenuSection label={t('themePalette')} />
              {PALETTE_ITEMS.map((p) => (
                <MenuCheck
                  key={p.id}
                  label={t(p.key)}
                  checked={settings?.themePalette === p.id}
                  onClick={() => void saveSettings({ themePalette: p.id })}
                />
              ))}
            </SubMenu>
            <div className="mx-3 my-1 border-t border-line" />
            <button
              onClick={() => {
                setOpen(false);
                useChatStore.setState({ settingsOpen: true });
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-ink transition hover:bg-bg-hover"
            >
              <Settings size={13} /> {t('settings')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 悬停展开、向右飞出的下级子菜单；带短暂关闭延迟，斜向移动不闪关。 */
function SubMenu({ icon, label, align = 'top', children }: {
  icon: React.ReactNode;
  label: string;
  align?: 'top' | 'bottom';
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = (): void => {
    window.clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = (): void => {
    timer.current = window.setTimeout(() => setOpen(false), 150);
  };

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-ink transition hover:bg-bg-hover ${open ? 'bg-bg-hover' : ''}`}
      >
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight size={13} className="text-ink-faint" />
      </button>
      {open && (
        <div className={`absolute left-full pl-1 ${align === 'top' ? '-top-1.5' : '-bottom-1.5'}`}>
          <div className="w-36 rounded-xl border border-line bg-bg-input py-1.5 shadow-lg">{children}</div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ tiny menu

interface DotMenuItem {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  /** 需二次确认：首次点击变确认态（图标换勾 + 换文案），再点才执行。 */
  confirmLabel?: string;
  onClick: () => void;
}

function DotMenu({ items }: { items: DotMenuItem[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  // 记录当前处于确认态的项（按 label 区分）；关菜单即重置。
  const [confirming, setConfirming] = useState<string | null>(null);
  useEscClose(open, () => setOpen(false));
  const close = (): void => {
    setOpen(false);
    setConfirming(null);
  };
  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else setOpen(true);
        }}
        className="rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-bg-active hover:text-ink group-hover:opacity-100"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute right-0 top-7 z-20 w-44 rounded-xl border border-line bg-bg-input py-1 shadow-lg">
            {items.map((item) => {
              const inConfirm = item.confirmLabel != null && confirming === item.label;
              return (
                <button
                  key={item.label}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (item.confirmLabel && !inConfirm) {
                      setConfirming(item.label);
                      return;
                    }
                    close();
                    item.onClick();
                  }}
                  onMouseLeave={() => {
                    if (inConfirm) setConfirming(null);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui transition ${item.disabled
                    ? 'cursor-not-allowed text-ink-faint/50'
                    : inConfirm
                      ? 'bg-warn/15 text-warn'
                      : `hover:bg-bg-hover ${item.danger ? 'text-err' : 'text-ink'}`
                    }`}
                >
                  {inConfirm ? <Check size={13} /> : item.icon} {inConfirm ? item.confirmLabel : item.label}
                </button>
              );
            })}
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
