/**
 * WorkspacePanel — right-hand collapsible panel (codex "Code changes"
 * style): 变更 tab aggregates per-file diffs from the tool stream with
 * +/- counts; 文件 tab is the lazy project tree. Clicking a file opens
 * a separate preview panel to the LEFT of the tree (item 9) so the
 * tree stays visible while reading code.
 */

import { useMemo, useState } from 'react';
import { Bot, FileDiff, FolderTree, Loader2 } from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../../store/chatStore';
import FileTree from './FileTree';
import FilePreview from './FilePreview';

interface Props {
  sessionId: string;
  root: string;
  /** Controlled tab — owned by ChatView's right icon rail. */
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
}

export type PanelTab = 'files' | 'changes' | 'agents';

interface ChangeEntry {
  path: string;
  name: string;
  adds: number;
  dels: number;
  count: number;
}

export default function WorkspacePanel({ sessionId, root, tab, onTabChange }: Props): JSX.Element {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const changes = useChangedFiles(sessionId);
  const agents = useAgentActivity(sessionId);

  return (
    <>
      {/* 文件预览 — 独立小面板，开在文件树左侧，树保持可见（item 9） */}
      {openFile && (
        <aside className="flex w-[400px] shrink-0 animate-[sheet-in_.15s_ease-out] flex-col border-l border-line bg-bg">
          <FilePreview path={openFile} root={root} onClose={() => setOpenFile(null)} />
        </aside>
      )}

      <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-bg-panel/40">
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
          <TabButton active={tab === 'files'} onClick={() => onTabChange('files')} icon={<FolderTree size={13} />} label="文件" />
          <TabButton
            active={tab === 'changes'}
            onClick={() => onTabChange('changes')}
            icon={<FileDiff size={13} />}
            label={changes.length > 0 ? `变更 ${changes.length}` : '变更'}
          />
          <TabButton
            active={tab === 'agents'}
            onClick={() => onTabChange('agents')}
            icon={<Bot size={13} />}
            label={agents.length > 0 ? `Agents ${agents.length}` : 'Agents'}
          />
        </div>

        <div className="min-h-0 flex-1">
          {tab === 'files' ? (
            <FileTree root={root} onOpenFile={setOpenFile} />
          ) : tab === 'changes' ? (
            <ChangesList changes={changes} onOpen={setOpenFile} />
          ) : (
            <AgentsList agents={agents} />
          )}
        </div>
      </aside>
    </>
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
      } else if (isWriteLike(tc) && tc.status === 'completed') {
        const paths = tc.locations?.length ? tc.locations : pathsFromTitle(tc.title);
        for (const loc of paths) bump(loc, 0, 0);
      }
    }
    return [...byPath.values()];
  }, [messages]);
}

/** Write-ish tool calls, by ACP kind or by title verb (kimi uses
 *  "Writing <path>" / "Editing <path>" with kind variance across tools). */
function isWriteLike(tc: Extract<UnifiedMessage, { kind: 'tool_call' }>): boolean {
  if (['edit', 'write', 'delete', 'move'].includes(tc.toolKind)) return true;
  return /^(writing|editing|creating|deleting|moving)\b/i.test(tc.title);
}

/** Extract file paths from titles like "Writing D:/proj/file.txt". */
function pathsFromTitle(title: string): string[] {
  const m = title.match(/(?:[A-Za-z]:[\\/]|\.{0,2}\/)[^\s'"]+/g);
  return m ?? [];
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

// ------------------------------------------------------------- agents tab

interface AgentEntry {
  id: string;
  title: string;
  status: string;
  detail?: string;
  startedAt: number;
}

/** Surface subagent / swarm activity from the tool-call stream.
 *  Match only the leading verb/tool-name — matching anywhere hits
 *  workspace paths like "D:/ai-agent/…" (found in Work-mode e2e). */
function useAgentActivity(sessionId: string): AgentEntry[] {
  const messages = useChatStore((s) => s.ui[sessionId]?.messages);
  return useMemo(() => {
    const out: AgentEntry[] = [];
    for (const m of messages ?? []) {
      if (m.kind !== 'tool_call') continue;
      const tc = m as Extract<UnifiedMessage, { kind: 'tool_call' }>;
      const agentish =
        /^(agent|swarm|subagent|delegat|spawn)/i.test(tc.title.trim()) ||
        /agent|swarm/i.test(tc.toolKind);
      if (!agentish) continue;
      out.push({
        id: tc.toolCallId,
        title: tc.title,
        status: tc.status,
        detail: tc.content?.text?.slice(0, 200),
        startedAt: tc.createdAt,
      });
    }
    return out;
  }, [messages]);
}

function AgentsList({ agents }: { agents: AgentEntry[] }): JSX.Element {
  if (agents.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-ui leading-6 text-ink-faint">
        本会话还没有子代理活动
        <br />
        开启 Composer 里的 ⚡Swarm 后发送任务可触发并行委派
      </div>
    );
  }
  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-2">
      {agents.map((a) => (
        <div key={a.id} className="rounded-lg border border-line bg-bg px-3 py-2">
          <div className="flex items-center gap-2">
            {a.status === 'in_progress' || a.status === 'pending' ? (
              <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
            ) : (
              <Bot size={12} className={`shrink-0 ${a.status === 'failed' ? 'text-err' : 'text-ok'}`} />
            )}
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{a.title}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] ${
                a.status === 'failed'
                  ? 'bg-err/10 text-err'
                  : a.status === 'completed'
                    ? 'bg-ok/10 text-ok'
                    : 'bg-accent-soft text-accent'
              }`}
            >
              {a.status}
            </span>
          </div>
          {a.detail && <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] text-ink-faint">{a.detail}</div>}
        </div>
      ))}
    </div>
  );
}
