/**
 * ArchivedView —— 「已归档会话」viewer modal。归档会话从侧栏隐藏但数据
 * 全保留（消息 + 引擎会话），在这里可打开查看、还原到侧栏、或彻底删除
 * （两步确认，与侧栏同一套交互 idiom）。列表按 workspace / project / chats
 * 分组（谓词与侧栏 groupSessions 同源），支持一键清空全部、或按组清空。
 */

import { useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Check, Folder, Layers, MessageCircle, Trash2, X } from 'lucide-react';

import type { SessionMeta, WorkspaceInfo } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import { ENGINE_LABELS } from './EngineIcon';

const EMPTY_WORKSPACES: WorkspaceInfo[] = [];

export default function ArchivedView(): JSX.Element | null {
  const t = useT();
  const open = useChatStore((s) => s.archivedOpen);
  const sessions = useChatStore((s) => s.sessions);
  // Stable fallback —— 与侧栏同理：内联 `?? []` 每次快照都是新数组，
  // 会把 useSyncExternalStore 送进无限重渲染。
  const workspaces = useChatStore((s) => s.settings?.workspaces) ?? EMPTY_WORKSPACES;
  const archived = useMemo(
    () => sessions.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const groups = useMemo(() => groupArchived(archived, workspaces), [archived, workspaces]);

  if (!open) return null;
  const close = (): void => useChatStore.setState({ archivedOpen: false });

  /** 一键清空全部已归档 —— 取全量快照重过滤，逐条走 store 删除（与逐行删同路径）。 */
  const clearAll = async (): Promise<void> => {
    const list = useChatStore.getState().sessions.filter((s) => s.archived);
    for (const s of list) await useChatStore.getState().deleteSession(s.id);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={close}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[600px] flex-col overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Archive size={15} /> {t('archivedTitle')}
            {archived.length > 0 && <span className="text-[11px] font-normal text-ink-faint">{archived.length}</span>}
          </span>
          <span className="flex items-center gap-1">
            {archived.length > 0 && (
              <ConfirmTrashButton
                label={t('archivedClearAll')}
                title={t('archivedClearAll')}
                confirmTitle={t('confirmDelete')}
                onConfirm={() => void clearAll()}
              />
            )}
            <button onClick={close} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
              <X size={16} />
            </button>
          </span>
        </div>
        <div className="px-5 pb-2 text-[11.5px] leading-5 text-ink-faint">{t('archivedHint')}</div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {archived.length === 0 ? (
            <div className="py-12 text-center text-ui text-ink-faint">{t('archivedEmpty')}</div>
          ) : (
            <>
              {groups.workspaces.map(({ workspace, sessions: list }) => (
                <GroupBlock
                  key={workspace.id}
                  icon={<Layers size={12} />}
                  label={workspace.name}
                  hint={t('workspaces')}
                  sessions={list}
                  collect={() =>
                    useChatStore.getState().sessions.filter((s) => s.archived && s.workspaceId === workspace.id)
                  }
                  onOpen={close}
                />
              ))}
              {groups.projects.map(({ cwd, name, sessions: list }) => (
                <GroupBlock
                  key={cwd}
                  icon={<Folder size={12} />}
                  label={name}
                  hint={cwd}
                  sessions={list}
                  collect={() => {
                    // 谓词与 groupArchived 的项目分组规则一致：无 workspaceId
                    // 或其 workspaceId 不在现有工作区集内（孤儿）才算本项目成员。
                    const wsIds = new Set((useChatStore.getState().settings?.workspaces ?? []).map((w) => w.id));
                    return useChatStore
                      .getState()
                      .sessions.filter(
                        (s) =>
                          s.archived && s.chatMode === 'work' && s.cwd === cwd && (!s.workspaceId || !wsIds.has(s.workspaceId)),
                      );
                  }}
                  onOpen={close}
                />
              ))}
              {groups.chats.length > 0 && (
                <GroupBlock
                  icon={<MessageCircle size={12} />}
                  label={t('chats')}
                  sessions={groups.chats}
                  collect={() => {
                    const wsIds = new Set((useChatStore.getState().settings?.workspaces ?? []).map((w) => w.id));
                    return useChatStore
                      .getState()
                      .sessions.filter((s) => s.archived && s.chatMode !== 'work' && !(s.workspaceId && wsIds.has(s.workspaceId)));
                  }}
                  onOpen={close}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- grouping

interface ArchivedGroups {
  workspaces: Array<{ workspace: WorkspaceInfo; sessions: SessionMeta[] }>;
  projects: Array<{ cwd: string; name: string; sessions: SessionMeta[] }>;
  chats: SessionMeta[];
}

/** 分组谓词与侧栏 groupSessions 同源：有效 workspaceId → workspace 组（按
 *  设置里的工作区顺序）；其余 chatMode=work → 按 cwd 归 project 组（按组内
 *  最新活跃排序，入参已按 updatedAt 降序，组内首条即最新）；剩下的纯聊天进
 *  chats 组。空组不渲染。 */
function groupArchived(archived: SessionMeta[], workspaces: WorkspaceInfo[]): ArchivedGroups {
  const wsIds = new Set(workspaces.map((w) => w.id));
  const chats: SessionMeta[] = [];
  const byWs = new Map<string, SessionMeta[]>();
  const byCwd = new Map<string, SessionMeta[]>();

  for (const s of archived) {
    if (s.workspaceId && wsIds.has(s.workspaceId)) {
      byWs.set(s.workspaceId, [...(byWs.get(s.workspaceId) ?? []), s]);
    } else if (s.chatMode === 'work') {
      byCwd.set(s.cwd, [...(byCwd.get(s.cwd) ?? []), s]);
    } else {
      chats.push(s);
    }
  }

  return {
    workspaces: workspaces
      .map((workspace) => ({ workspace, sessions: byWs.get(workspace.id) ?? [] }))
      .filter((g) => g.sessions.length > 0),
    projects: [...byCwd.entries()]
      .map(([cwd, list]) => ({ cwd, name: cwd.split(/[\/]/).pop() ?? cwd, sessions: list }))
      .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0)),
    chats,
  };
}

// ------------------------------------------------------------- blocks

/** 单个分组块：组头（图标 + 名称 + 计数 + hover 显示的「清空本组」）+ 会话行。 */
function GroupBlock({
  icon,
  label,
  hint,
  sessions: list,
  collect,
  onOpen,
}: {
  icon: React.ReactNode;
  label: string;
  /** 悬浮提示（project 组传完整 cwd）。 */
  hint?: string;
  sessions: SessionMeta[];
  /** 清空时取全量快照重算本组成员（与侧栏批量操作同 idiom，防列表中途变化）。 */
  collect: () => SessionMeta[];
  onOpen: () => void;
}): JSX.Element {
  const t = useT();

  const clearGroup = async (): Promise<void> => {
    for (const s of collect()) await useChatStore.getState().deleteSession(s.id);
  };

  return (
    <div className="pb-1">
      <div className="group flex items-center gap-1.5 px-2.5 pb-1 pt-3">
        <span title={hint} className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold text-ink-faint">
          {icon}
          <span className="min-w-0 truncate">{label}</span>
          <span className="shrink-0 font-normal tabular-nums text-ink-faint/70">{list.length}</span>
        </span>
        <ConfirmTrashButton
          title={t('archivedClearGroup')}
          confirmTitle={t('confirmDelete')}
          hoverReveal
          onConfirm={() => void clearGroup()}
        />
      </div>
      {list.map((meta) => (
        <ArchivedRow key={meta.id} meta={meta} onOpen={onOpen} />
      ))}
    </div>
  );
}

function ArchivedRow({ meta, onOpen }: { meta: SessionMeta; onOpen: () => void }): JSX.Element {
  const t = useT();
  const selectSession = useChatStore((s) => s.selectSession);
  const archiveSession = useChatStore((s) => s.archiveSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const openSession = (): void => {
    // 查看不强制还原 —— 仍是归档态，只是临时打开阅读。
    selectSession(meta.id);
    onOpen();
  };

  return (
    <div
      onClick={openSession}
      title={t('archivedOpenSession')}
      className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition hover:bg-bg-hover"
    >
      {/* 引擎标签定宽居中 —— 不同长度引擎名（Codex ~ Antigravity）行间对齐 */}
      <span className="w-[74px] shrink-0 truncate rounded-md bg-bg-panel px-1.5 py-0.5 text-center text-[10px] text-ink-faint">
        {ENGINE_LABELS[meta.engine]}
      </span>
      <span className="min-w-0 flex-1 truncate text-ui text-ink">{meta.title}</span>
      <span className="shrink-0 text-[10.5px] tabular-nums text-ink-faint">{timeAgo(meta.updatedAt)}</span>
      <button
        title={t('unarchive')}
        onClick={(e) => {
          e.stopPropagation();
          void archiveSession(meta.id, false);
        }}
        className="rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-bg-active hover:text-accent group-hover:opacity-100"
      >
        <ArchiveRestore size={14} />
      </button>
      <ConfirmTrashButton
        title={t('remove')}
        confirmTitle={t('confirmDelete')}
        hoverReveal
        onConfirm={() => void deleteSession(meta.id)}
      />
    </div>
  );
}

/** 两步确认的危险按钮：首次点击进入确认态（图标换勾 + err 染色），3 秒内
 *  二次点击才执行；鼠标移出或超时复位。行删除 / 组清空 / 全部清空共用。 */
function ConfirmTrashButton({
  title,
  confirmTitle,
  label,
  hoverReveal = false,
  onConfirm,
}: {
  title: string;
  confirmTitle: string;
  /** 常驻文字标签（标题栏「清空全部」用）；缺省为纯图标钮。 */
  label?: string;
  /** true = 平时隐藏，父级 .group hover 才显（会话行 / 组头内用）。 */
  hoverReveal?: boolean;
  onConfirm: () => void;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const onClick = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      timer.current = setTimeout(() => setConfirming(false), 3000);
      return;
    }
    clearTimeout(timer.current);
    onConfirm();
  };

  return (
    <button
      title={confirming ? confirmTitle : title}
      onClick={onClick}
      onMouseLeave={() => {
        clearTimeout(timer.current);
        setConfirming(false);
      }}
      className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 transition ${
        confirming
          ? 'bg-err/15 text-err opacity-100'
          : `text-ink-faint hover:bg-bg-active hover:text-err ${hoverReveal ? 'opacity-0 group-hover:opacity-100' : ''}`
      }`}
    >
      {confirming ? <Check size={14} /> : <Trash2 size={14} />}
      {label && <span className="text-[11px]">{confirming ? confirmTitle : label}</span>}
    </button>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  // 非响应式读语言：本视图随 settings 变更重渲染，相对时间随之刷新。
  const lang = useChatStore.getState().settings?.language ?? 'zh';
  if (diff < 60_000) return lang === 'zh' ? '刚刚' : 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
