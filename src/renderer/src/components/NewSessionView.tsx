/**
 * NewSessionView — landing pane: pick engine (kimi / codex), then Chat
 * (no workspace) or Work (bound to a project folder).
 */

import { useState } from 'react';
import { FolderGit2, FolderOpen, MessageCircle, Layers, Loader2, Sparkles } from 'lucide-react';

import type { EngineId, WorkspaceInfo } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import WorkspaceDialog from './WorkspaceDialog';

const EMPTY_WORKSPACES: WorkspaceInfo[] = [];

const ENGINES: Array<{ id: EngineId; label: string; hint: string }> = [
  { id: 'kimi', label: 'Kimi Code', hint: '主引擎 · ACP · swarm/goal 原生' },
  { id: 'codex', label: 'Codex', hint: '副引擎 · app-server · 经内置代理路由' },
];

export default function NewSessionView(): JSX.Element {
  const t = useT();
  const createSession = useChatStore((s) => s.createSession);
  const creating = useChatStore((s) => s.creating);
  const workspaces = useChatStore((s) => s.settings?.workspaces) ?? EMPTY_WORKSPACES;
  const [engine, setEngine] = useState<EngineId>('kimi');
  const [error, setError] = useState<string | null>(null);
  const [wsDialogOpen, setWsDialogOpen] = useState(false);

  const start = async (cwd: string, workspaceId?: string): Promise<void> => {
    setError(null);
    try {
      await createSession({ engine, cwd, workspaceId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pickFolder = async (): Promise<void> => {
    const folder = await window.cyberslots.dialogPickFolder();
    if (folder) await start(folder);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-8">
      <div className="flex flex-col items-center gap-2">
        <Sparkles size={28} className="text-accent" />
        <h1 className="text-xl font-semibold">{t('newSessionTitle')}</h1>
        <p className="text-ui text-ink-soft">{t('newSessionHint')}</p>
      </div>

      <div className="flex items-center gap-1 rounded-xl border border-line bg-bg-panel p-1">
        {ENGINES.map((e) => (
          <button
            key={e.id}
            title={e.hint}
            onClick={() => setEngine(e.id)}
            className={`rounded-lg px-4 py-1.5 text-ui transition ${
              engine === e.id ? 'bg-bg font-medium text-ink shadow-sm' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {e.label}
          </button>
        ))}
      </div>

      <div className="flex gap-4">
        <button
          disabled={creating}
          onClick={() => void start('')}
          className="flex w-48 flex-col items-center gap-3 rounded-xl border border-line bg-bg-input px-5 py-7 shadow-sm transition hover:border-accent hover:shadow-md disabled:opacity-50"
        >
          <MessageCircle size={22} className="text-accent" />
          <div className="text-sm font-medium">Chat</div>
          <div className="text-center text-[12px] leading-5 text-ink-soft">{t('chatCardHint')}</div>
        </button>
        <button
          disabled={creating}
          onClick={() => void pickFolder()}
          className="flex w-48 flex-col items-center gap-3 rounded-xl border border-line bg-bg-input px-5 py-7 shadow-sm transition hover:border-accent hover:shadow-md disabled:opacity-50"
        >
          <FolderOpen size={22} className="text-accent" />
          <div className="text-sm font-medium">Project</div>
          <div className="text-center text-[12px] leading-5 text-ink-soft">{t('workCardHint')}</div>
        </button>
        <button
          disabled={creating}
          onClick={() => setWsDialogOpen(true)}
          className="flex w-48 flex-col items-center gap-3 rounded-xl border border-line bg-bg-input px-5 py-7 shadow-sm transition hover:border-accent hover:shadow-md disabled:opacity-50"
        >
          <Layers size={22} className="text-accent" />
          <div className="text-sm font-medium">Workspace</div>
          <div className="text-center text-[12px] leading-5 text-ink-soft">{t('workspaceCardHint')}</div>
        </button>
      </div>

      {workspaces.length > 0 && (
        <div className="flex w-[440px] flex-col gap-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Workspaces</div>
          {workspaces.map((w) => (
            <button
              key={w.id}
              disabled={creating}
              onClick={() => void start('', w.id)}
              className="flex items-center gap-2.5 rounded-xl border border-line bg-bg-input px-4 py-2.5 text-left shadow-sm transition hover:border-accent disabled:opacity-50"
            >
              <FolderGit2 size={15} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-ui font-medium">{w.name}</span>
              <span className="shrink-0 text-[11px] text-ink-faint">{w.folders.length} {t('folders')}</span>
            </button>
          ))}
        </div>
      )}

      {creating && (
        <div className="flex items-center gap-2 text-ui text-ink-soft">
          <Loader2 size={14} className="animate-spin" /> {t('startingEngine')} {engine} …
        </div>
      )}
      {error && <div className="max-w-lg rounded-lg bg-err/10 px-4 py-2 text-ui text-err">{error}</div>}

      {/* Workspace 卡：新建多目录工作区后直接在其中开会话 */}
      <WorkspaceDialog
        open={wsDialogOpen}
        onClose={() => setWsDialogOpen(false)}
        onCreated={(ws) => {
          setWsDialogOpen(false);
          void start('', ws.id);
        }}
      />
    </div>
  );
}
