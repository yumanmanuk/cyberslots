/**
 * FileTree — lazy-loaded workspace tree with git status badges.
 * Absolute paths flow through; boundary checks live in the main process.
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react';

import type { FsNode } from '@shared/ipc';

interface Props {
  root: string;
  onOpenFile: (path: string) => void;
}

const GIT_COLORS: Record<string, string> = {
  M: 'text-warn',
  A: 'text-ok',
  D: 'text-err',
  '?': 'text-accent',
};

export default function FileTree({ root, onOpenFile }: Props): JSX.Element {
  const [children, setChildren] = useState<Record<string, FsNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [git, setGit] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // 拖放导入高亮（拖入区域时描边）。
  const [dragOver, setDragOver] = useState(false);

  const loadDir = useCallback(
    async (dir: string): Promise<void> => {
      try {
        const nodes = await window.cyberslots.fsTree(root, dir);
        setChildren((c) => ({ ...c, [dir]: nodes }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [root],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    await loadDir(root);
    setGit(await window.cyberslots.fsGitStatus(root));
    // Reload any expanded dirs so the tree stays fresh.
    for (const dir of expanded) void loadDir(dir);
  }, [root, expanded, loadDir]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const toggle = (dir: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
        if (!children[dir]) void loadDir(dir);
      }
      return next;
    });
  };

  // 拖外部文件/文件夹进树 = 导入拷贝到工作区根目录，完成后刷新。
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    const paths: string[] = [];
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = window.cyberslots.getPathForFile(file);
      if (p) paths.push(p);
    }
    if (paths.length) void window.cyberslots.fsImport(root, paths).then(() => void refresh());
  };

  const renderNodes = (dir: string, depth: number): JSX.Element[] =>
    (children[dir] ?? []).map((n) => (
      <div key={n.path}>
        <button
          onClick={() => (n.dir ? toggle(n.path) : onOpenFile(n.path))}
          onDoubleClick={() => !n.dir && onOpenFile(n.path)}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-[3px] text-left text-[12.5px] text-ink-soft hover:bg-bg-hover"
          style={{ paddingLeft: 6 + depth * 14 }}
          title={n.path}
        >
          {n.dir ? (
            <>
              {expanded.has(n.path) ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
              {expanded.has(n.path) ? <FolderOpen size={13} className="shrink-0 text-accent/80" /> : <Folder size={13} className="shrink-0 text-accent/80" />}
            </>
          ) : (
            <FileText size={13} className="ml-[12px] shrink-0 text-ink-faint" />
          )}
          <span className="min-w-0 flex-1 truncate">{n.name}</span>
          {!n.dir && git[n.path] && (
            <span className={`shrink-0 font-mono text-[10px] font-bold ${GIT_COLORS[git[n.path]!] ?? 'text-ink-faint'}`}>
              {git[n.path]}
            </span>
          )}
        </button>
        {n.dir && expanded.has(n.path) && renderNodes(n.path, depth + 1)}
      </div>
    ));

  return (
    <div
      className={`flex h-full flex-col ${dragOver ? 'outline outline-2 -outline-offset-2 outline-accent/60' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        // 显式声明拷贝意图 — Windows Electron 下不设可能不触发 drop。
        e.dataTransfer.dropEffect = 'copy';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        // 仅当离开整个容器时取消高亮（避免子元素间移动闪烁）。
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="truncate font-mono text-[11px] text-ink-faint" title={root}>
          {root.split(/[\\/]/).pop()}
        </span>
        <button onClick={() => void refresh()} title="刷新" className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-ink">
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {error && <div className="px-2 py-1 text-[11px] text-err">{error}</div>}
        {dragOver && <div className="px-2 py-1 text-[11px] text-accent">松开导入到 {root.split(/[\\/]/).pop()}</div>}
        {renderNodes(root, 0)}
      </div>
    </div>
  );
}
