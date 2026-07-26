/**
 * WorkspaceDialog — create/edit a named multi-folder workspace.
 * The first folder becomes the engine cwd; extra folders are announced
 * to the engine via a context prefix on the first prompt.
 */

import { useEffect, useState } from 'react';
import { Folder, FolderPlus, Trash2, X } from 'lucide-react';

import type { WorkspaceInfo } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';

interface Props {
  open: boolean;
  /** When set, the dialog edits the given workspace instead of creating. */
  editing?: WorkspaceInfo | null;
  onClose: () => void;
  /** Fired after a new workspace is created (not on edit). */
  onCreated?: (ws: WorkspaceInfo) => void;
}

export default function WorkspaceDialog({ open, editing, onClose, onCreated }: Props): JSX.Element | null {
  const t = useT();
  const addWorkspace = useChatStore((s) => s.addWorkspace);
  const updateWorkspace = useChatStore((s) => s.updateWorkspace);
  const [name, setName] = useState('');
  const [folders, setFolders] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setFolders(editing?.folders ?? []);
    }
  }, [open, editing]);

  if (!open) return null;

  const pickFolder = async (): Promise<void> => {
    const dir = await window.cyberslots.dialogPickFolder();
    if (dir && !folders.includes(dir)) {
      setFolders((prev) => [...prev, dir]);
      if (!name.trim()) setName(dir.split(/[\\/]/).pop() ?? '');
    }
  };

  const submit = async (): Promise<void> => {
    const finalName = name.trim() || folders[0]?.split(/[\\/]/).pop() || 'workspace';
    if (folders.length === 0) return;
    if (editing) {
      await updateWorkspace({ ...editing, name: finalName, folders });
    } else {
      const ws = await addWorkspace(finalName, folders);
      onCreated?.(ws);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-[520px] flex-col overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-sm font-semibold">{editing ? t('renameWorkspace') : t('newWorkspace')}</span>
          <button onClick={onClose} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-ink-faint">{t('workspaceName')}</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my workspace"
              className="w-full rounded-lg border border-line bg-bg-input px-2.5 py-1.5 text-ui outline-none transition focus:border-accent"
            />
          </div>

          <div className="overflow-hidden rounded-xl border border-line">
            {folders.length === 0 ? (
              <div className="px-4 py-8 text-center text-ui text-ink-faint">{t('noFoldersYet')}</div>
            ) : (
              folders.map((f) => (
                <div key={f} className="group flex items-center gap-2.5 border-b border-line px-3.5 py-2.5 last:border-b-0">
                  <Folder size={14} className="shrink-0 text-ink-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ui font-medium">{f.split(/[\\/]/).pop()}</div>
                    <div className="truncate font-mono text-[11px] text-ink-faint">{f}</div>
                  </div>
                  <button
                    onClick={() => setFolders((prev) => prev.filter((x) => x !== f))}
                    className="rounded-md p-1 text-ink-faint opacity-0 transition hover:text-err group-hover:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
            <button
              onClick={() => void pickFolder()}
              className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2.5 text-ui text-ink-soft transition hover:bg-bg-hover"
            >
              <FolderPlus size={14} /> {t('addFolder')}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <span className="text-[11px] text-ink-faint">{folders.length === 0 ? t('needFolders') : ''}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-line px-4 py-1.5 text-ui text-ink-soft transition hover:bg-bg-hover">
              {t('cancel')}
            </button>
            <button
              onClick={() => void submit()}
              disabled={folders.length === 0}
              className="rounded-lg bg-accent px-4 py-1.5 text-ui font-medium text-white transition hover:opacity-90 disabled:opacity-40"
            >
              {editing ? t('save') : t('create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
