/**
 * WorkspacePanel — right-hand collapsible panel (codex "Code changes"
 * style): 变更 tab aggregates per-file diffs from the tool stream with
 * +/- counts; 文件 tab is the lazy project tree; clicking either opens
 * an inline file preview.
 */

import { useMemo, useState } from 'react';
import { FileDiff, FolderTree } from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../../store/chatStore';
import FileTree from './FileTree';
import FilePreview from './FilePreview';

interface Props {
  sessionId: string;
  root: string;
}

interface ChangeEntry {
  path: string;
  name: string;
  adds: number;
  dels: number;
  count: number;
}

export default function WorkspacePanel({ sessionId, root }: Props): JSX.Element {
  const [tab, setTab] = useState<'changes' | 'files'>('files');
  const [openFile, setOpenFile] = useState<string | null>(null);
  const changes = useChangedFiles(sessionId);

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-bg-panel/40">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <TabButton active={tab === 'files'} onClick={() => setTab('files')} icon={<FolderTree size={13} />} label="文件" />
        <TabButton
          active={tab === 'changes'}
          onClick={() => setTab('changes')}
          icon={<FileDiff size={13} />}
          label={changes.length > 0 ? `变更 ${changes.length}` : '变更'}
        />
      </div>

      <div className="min-h-0 flex-1">
        {openFile ? (
          <FilePreview path={openFile} root={root} onClose={() => setOpenFile(null)} />
        ) : tab === 'files' ? (
          <FileTree root={root} onOpenFile={setOpenFile} />
        ) : (
          <ChangesList changes={changes} onOpen={setOpenFile} />
        )}
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-ui ${
        active ? 'bg-bg-active font-medium text-ink' : 'text-ink-soft hover:bg-bg-hover'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/** Aggregate tool-call activity into a per-file change summary.
 *  Prefers structured diffs; falls back to edit/write tool locations
 *  (some engines report file writes without a diff payload). */
function useChangedFiles(sessionId: string): ChangeEntry[] {
  const messages = useChatStore((s) => s.ui[sessionId]?.messages);
  return useMemo(() => {
    const byPath = new Map<string, ChangeEntry>();
    const bump = (path: string, adds: number, dels: number): void => {
      const prev = byPath.get(path);
      byPath.set(path, {
        path,
        name: path.split(/[\\/]/).pop() ?? path,
        adds: (prev?.adds ?? 0) + adds,
        dels: (prev?.dels ?? 0) + dels,
        count: (prev?.count ?? 0) + 1,
      });
    };
    for (const m of messages ?? []) {
      if (m.kind !== 'tool_call') continue;
      const tc = m as Extract<UnifiedMessage, { kind: 'tool_call' }>;
      const diff = tc.content?.diff;
      if (diff?.path) {
        bump(
          diff.path,
          diff.newText ? diff.newText.split('\n').length : 0,
          diff.oldText ? diff.oldText.split('\n').length : 0,
        );
      } else if ((tc.toolKind === 'edit' || tc.toolKind === 'delete' || tc.toolKind === 'move') && tc.status === 'completed') {
        for (const loc of tc.locations ?? []) bump(loc, 0, 0);
      }
    }
    return [...byPath.values()];
  }, [messages]);
}

function ChangesList({ changes, onOpen }: { changes: ChangeEntry[]; onOpen: (path: string) => void }): JSX.Element {
  if (changes.length === 0) {
    return <div className="px-3 py-8 text-center text-ui text-ink-faint">本会话还没有文件变更</div>;
  }
  const totalAdds = changes.reduce((n, c) => n + c.adds, 0);
  const totalDels = changes.reduce((n, c) => n + c.dels, 0);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-ui">
        <span className="font-medium">{changes.length} 个文件变更</span>
        <span className="font-mono text-[11px] text-ok">+{totalAdds}</span>
        <span className="font-mono text-[11px] text-err">-{totalDels}</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {changes.map((c) => (
          <button
            key={c.path}
            onClick={() => onOpen(c.path)}
            title={c.path}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-bg-hover"
          >
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            {c.count > 1 && <span className="rounded bg-bg-active px-1 text-[10px] text-ink-faint">×{c.count}</span>}
            {c.adds + c.dels > 0 ? (
              <>
                <span className="font-mono text-[11px] text-ok">+{c.adds}</span>
                <span className="font-mono text-[11px] text-err">-{c.dels}</span>
              </>
            ) : (
              <span className="rounded bg-warn/10 px-1 text-[10px] text-warn">已写入</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
