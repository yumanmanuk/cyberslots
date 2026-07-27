/**
 * ArchivedView — “已归档会话” viewer modal. Archived sessions are hidden
 * from the sidebar but fully retained (messages + engine session);
 * from here they can be opened, restored to the sidebar, or deleted
 * for good (two-step confirm, same idiom as the sidebar).
 */

import { useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Check, Trash2, X } from 'lucide-react';

import type { SessionMeta } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import { ENGINE_LABELS } from './EngineIcon';

export default function ArchivedView(): JSX.Element | null {
  const t = useT();
  const open = useChatStore((s) => s.archivedOpen);
  const sessions = useChatStore((s) => s.sessions);
  const archived = useMemo(
    () => sessions.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  if (!open) return null;
  const close = (): void => useChatStore.setState({ archivedOpen: false });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={close}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Archive size={15} /> {t('archivedTitle')}
            {archived.length > 0 && <span className="text-[11px] font-normal text-ink-faint">{archived.length}</span>}
          </span>
          <button onClick={close} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 pb-2 text-[11.5px] leading-5 text-ink-faint">{t('archivedHint')}</div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {archived.length === 0 ? (
            <div className="py-12 text-center text-ui text-ink-faint">{t('archivedEmpty')}</div>
          ) : (
            archived.map((meta) => <ArchivedRow key={meta.id} meta={meta} onOpen={close} />)
          )}
        </div>
      </div>
    </div>
  );
}

function ArchivedRow({ meta, onOpen }: { meta: SessionMeta; onOpen: () => void }): JSX.Element {
  const t = useT();
  const selectSession = useChatStore((s) => s.selectSession);
  const archiveSession = useChatStore((s) => s.archiveSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const openSession = (): void => {
    // 查看不强制还原 — 仍是归档态，只是临时打开阅读。
    selectSession(meta.id);
    onOpen();
  };

  const onDelete = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      timer.current = setTimeout(() => setConfirming(false), 3000);
      return;
    }
    clearTimeout(timer.current);
    void deleteSession(meta.id);
  };

  return (
    <div
      onClick={openSession}
      title={t('archivedOpenSession')}
      className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition hover:bg-bg-hover"
    >
      <span className="shrink-0 rounded-md bg-bg-panel px-1.5 py-0.5 text-[10px] text-ink-faint">
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
      <button
        title={confirming ? t('confirmDelete') : t('remove')}
        onClick={onDelete}
        onMouseLeave={() => {
          clearTimeout(timer.current);
          setConfirming(false);
        }}
        className={`rounded-md p-1 transition group-hover:opacity-100 ${confirming ? 'bg-err/15 text-err opacity-100' : 'text-ink-faint opacity-0 hover:bg-bg-active hover:text-err'
          }`}
      >
        {confirming ? <Check size={14} /> : <Trash2 size={14} />}
      </button>
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
