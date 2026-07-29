/**
 * NewSessionView — landing pane: pick engine (kimi / codex / opencode / omp),
 * then Chat (no workspace) or Work (bound to a project folder).
 */

import { useEffect, useState } from 'react';
import { FolderGit2, FolderOpen, MessageCircle, Layers } from 'lucide-react';

import type { EngineId, WorkspaceInfo } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import WorkspaceDialog from './WorkspaceDialog';
import { EngineIcon, ENGINE_LABELS } from './EngineIcon';
import { BrandHero, BrandSpinner } from './brand';

const EMPTY_WORKSPACES: WorkspaceInfo[] = [];

const ENGINES: Array<{ id: EngineId; hint: string }> = [
  { id: 'codex', hint: '主引擎 · app-server · 直连 ~/.codex 配置/登录（可开协议路由）' },
  { id: 'opencode', hint: '第二引擎 · HTTP · 直连 opencode 已连接的 provider（zen 免费模型免登录可用）' },
  { id: 'kimi', hint: '第三引擎 · ACP · 直连 ~/.kimi-code 配置（可开协议路由）' },
  { id: 'omp', hint: '第四引擎 · ACP · 直连 ~/.omp 配置（原生 fork/plan 沙箱，子代理/LSP 全工具面）' },
];

export default function NewSessionView(): JSX.Element {
  const t = useT();
  const createSession = useChatStore((s) => s.createSession);
  const creating = useChatStore((s) => s.creating);
  const creatingEngine = useChatStore((s) => s.creatingEngine);
  const workspaces = useChatStore((s) => s.settings?.workspaces) ?? EMPTY_WORKSPACES;
  const availability = useChatStore((s) => s.engineAvailability);
  const [engine, setEngine] = useState<EngineId>('codex');
  const [error, setError] = useState<string | null>(null);
  const [wsDialogOpen, setWsDialogOpen] = useState(false);

  // 探测结果到达后，若当前选中引擎未安装 → 自动切到首个可用引擎，
  // 避免默认选中一个置灰项导致建会话必败。
  useEffect(() => {
    if (!availability || availability[engine]) return;
    const first = ENGINES.find((e) => availability[e.id]);
    if (first) setEngine(first.id);
  }, [availability, engine]);

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
        {/* 品牌主视觉：拉霸仪式循环 —— 拉一把，开新局 */}
        <BrandHero size={72} />
        <h1 className="text-xl font-semibold">{t('newSessionTitle')}</h1>
        <p className="text-ui text-ink-soft">{t('newSessionHint')}</p>
      </div>

      <div className="flex items-center gap-1 rounded-xl border border-line bg-bg-panel p-1">
        {ENGINES.map((e) => {
          // 未安装置灰展示（可见不可选）；尚未探测（null）时不置灰。
          const unavailable = availability ? !availability[e.id] : false;
          return (
            <button
              key={e.id}
              title={unavailable ? `${e.hint}（未检测到本机安装，详见设置-模型页）` : e.hint}
              disabled={unavailable}
              onClick={() => setEngine(e.id)}
              className={`flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-ui transition ${unavailable
                ? 'cursor-not-allowed text-ink-faint opacity-40'
                : engine === e.id
                  ? 'bg-bg font-medium text-ink shadow-sm'
                  : 'text-ink-soft hover:text-ink'
                }`}
            >
              <EngineIcon engine={e.id} size={14} />
              {ENGINE_LABELS[e.id]}
            </button>
          );
        })}
      </div>

      <div className="flex gap-4">
        <button
          disabled={creating}
          onClick={() => void start('')}
          className="flex w-48 flex-col items-center gap-3 rounded-xl border border-line bg-bg-input px-5 py-7 shadow-sm transition hover:bg-bg-hover hover:shadow-md disabled:opacity-50"
        >
          <MessageCircle size={22} className="text-accent" />
          <div className="text-sm font-medium">Chat</div>
          <div className="text-center text-[12px] leading-5 text-ink-soft">{t('chatCardHint')}</div>
        </button>
        <button
          disabled={creating}
          onClick={() => void pickFolder()}
          className="flex w-48 flex-col items-center gap-3 rounded-xl border border-line bg-bg-input px-5 py-7 shadow-sm transition hover:bg-bg-hover hover:shadow-md disabled:opacity-50"
        >
          <FolderOpen size={22} className="text-accent" />
          <div className="text-sm font-medium">Project</div>
          <div className="text-center text-[12px] leading-5 text-ink-soft">{t('workCardHint')}</div>
        </button>
        <button
          disabled={creating}
          onClick={() => setWsDialogOpen(true)}
          className="flex w-48 flex-col items-center gap-3 rounded-xl border border-line bg-bg-input px-5 py-7 shadow-sm transition hover:bg-bg-hover hover:shadow-md disabled:opacity-50"
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
              className="flex items-center gap-2.5 rounded-xl border border-line bg-bg-input px-4 py-2.5 text-left shadow-sm transition hover:bg-bg-hover disabled:opacity-50"
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
          <BrandSpinner size={14} /> {t('startingEngine')}{' '}
          {ENGINE_LABELS[creatingEngine ?? engine]} …
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
