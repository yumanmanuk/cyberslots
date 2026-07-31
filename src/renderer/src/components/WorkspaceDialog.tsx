/**
 * WorkspaceDialog — create/edit a named multi-folder workspace,
 * codex-desktop「创建项目」style (item 10): name field with folder
 * icon, "Source folders" list with a Primary badge on the first
 * folder, × per row, and an "添加文件夹" row at the bottom.
 * The first folder becomes the engine cwd; extra folders reach engines
 * via a context prefix (all engines) plus native multi-root channels
 * (claude/omp --add-dir, codex writable_roots, opencode permission rules).
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderPlus, X } from 'lucide-react';

import type { WorkspaceInfo } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { BrandSpinner } from './brand';
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
  /* 创建/保存走 IPC 异步 — 进行中态给品牌 spinner，顺便防连点重复创建 */
  const [busy, setBusy] = useState(false);

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
    if (folders.length === 0 || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await updateWorkspace({ ...editing, name: finalName, folders });
      } else {
        const ws = await addWorkspace(finalName, folders);
        onCreated?.(ws);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // Portal 到 body — 侧栏外层带 transform（折叠动画），会把 fixed 定位困在侧栏内
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-[520px] flex-col overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <span className="text-base font-semibold">{editing ? t('manageWorkspace') : t('newWorkspace')}</span>
          <button onClick={onClose} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* 名称：codex 风格 — 文件夹图标 + 扁平输入条 */}
          <div className="flex items-center gap-2.5 rounded-xl border border-line bg-bg-input px-3.5 py-2.5 transition focus-within:border-accent">
            <Folder size={16} className="shrink-0 text-ink-soft" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('workspaceName')}
              className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-ink-faint"
            />
          </div>

          <div>
            <div className="mb-1.5 text-[12px] text-ink-soft">{t('sourceFolders')}</div>
            <div className="overflow-hidden rounded-xl border border-line">
              {folders.length === 0 && (
                <div className="px-4 py-6 text-center text-ui text-ink-faint">{t('noFoldersYet')}</div>
              )}
              {folders.map((f, i) => (
                <div key={f} className="group flex items-center gap-2.5 border-b border-line bg-bg-input px-3.5 py-2.5">
                  <Folder size={14} className="shrink-0 text-ink-soft" />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-ui" title={f}>
                      {f.split(/[\\/]/).pop()}
                    </span>
                  </div>
                  {i === 0 && (
                    <span className="shrink-0 rounded-md border border-line bg-bg-panel px-2 py-0.5 text-[10.5px] font-medium text-ink-soft">
                      {t('primaryFolder')}
                    </span>
                  )}
                  <button
                    onClick={() => setFolders((prev) => prev.filter((x) => x !== f))}
                    className="shrink-0 rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => void pickFolder()}
                className="flex w-full items-center gap-2.5 bg-bg-panel/70 px-3.5 py-2.5 text-ui text-ink-soft transition hover:bg-bg-hover hover:text-ink"
              >
                <FolderPlus size={14} /> {t('addFolder')}
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-5 pb-4 pt-1">
          <span className="text-[11px] text-ink-faint">{folders.length === 0 ? t('needFolders') : ''}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg px-4 py-1.5 text-ui text-ink-soft transition hover:bg-bg-hover">
              {t('cancel')}
            </button>
            <button
              onClick={() => void submit()}
              disabled={folders.length === 0 || busy}
              className="flex items-center gap-1.5 rounded-lg bg-ink px-4 py-1.5 text-ui font-medium text-bg transition hover:opacity-85 disabled:opacity-40"
            >
              {busy && <BrandSpinner size={12} />}
              {editing ? t('save') : t('createProject')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
