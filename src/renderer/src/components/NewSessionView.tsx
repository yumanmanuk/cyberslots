/**
 * NewSessionView — landing pane: pick engine (kimi / codex / opencode / omp),
 * then Chat (no workspace) or Work (bound to a project folder).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FolderGit2, FolderOpen, MessageCircle, Layers } from 'lucide-react';

import type { EngineId, WorkspaceInfo } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { engineHintKey, enginePseudoWsKey, useT } from '../i18n';
import WorkspaceDialog from './WorkspaceDialog';
import { EngineIcon, ENGINE_LABELS, PseudoWorkspaceBadge, useEngineOrder } from './EngineIcon';
import { BrandHero, BrandSpinner } from './brand';

const EMPTY_WORKSPACES: WorkspaceInfo[] = [];

export default function NewSessionView(): JSX.Element {
  const t = useT();
  const createSession = useChatStore((s) => s.createSession);
  const creating = useChatStore((s) => s.creating);
  const creatingEngine = useChatStore((s) => s.creatingEngine);
  const workspaces = useChatStore((s) => s.settings?.workspaces) ?? EMPTY_WORKSPACES;
  const availability = useChatStore((s) => s.engineAvailability);
  // 列表顺序跟随设置 engineOrder；默认选中排序首位引擎。
  const engineOrder = useEngineOrder();
  const [engine, setEngine] = useState<EngineId>(engineOrder[0] ?? 'codex');
  const [error, setError] = useState<string | null>(null);
  const [wsDialogOpen, setWsDialogOpen] = useState(false);
  // 滑动高亮胶囊：测量选中按钮在容器内的位置，用 transform/宽度过渡实现平移而非瞬移。
  const tabRefs = useRef<Partial<Record<EngineId, HTMLButtonElement | null>>>({});
  const [pill, setPill] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const el = tabRefs.current[engine];
    if (!el) return;
    setPill({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
  }, [engine, availability, engineOrder]);

  // 探测结果到达后，若当前选中引擎未安装 → 自动切到首个可用引擎，
  // 避免默认选中一个置灰项导致建会话必败。
  useEffect(() => {
    if (!availability || availability[engine]) return;
    const first = engineOrder.find((id) => availability[id]);
    if (first) setEngine(first);
  }, [availability, engine, engineOrder]);

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

      <div className="relative flex items-center gap-1 rounded-xl border border-line bg-bg-panel p-1">
        {/* 滑动高亮胶囊：跟随选中项平移，替代逐按钮背景的瞬移切换 */}
        {pill && (
          <div
            className="pointer-events-none absolute rounded-lg bg-bg shadow-sm transition-all duration-300 ease-out"
            style={{ left: pill.left, top: pill.top, width: pill.width, height: pill.height }}
          />
        )}
        {engineOrder.map((id) => {
          // 未安装置灰展示（可见不可选）；尚未探测（null）时不置灰。
          const unavailable = availability ? !availability[id] : false;
          return (
            <button
              key={id}
              ref={(el) => { tabRefs.current[id] = el; }}
              title={unavailable ? `${t(engineHintKey(id))}${t('engineNotDetectedSuffix')}` : t(engineHintKey(id))}
              disabled={unavailable}
              onClick={() => setEngine(id)}
              className={`relative flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-ui transition ${unavailable
                ? 'cursor-not-allowed text-ink-faint opacity-40'
                : engine === id
                  ? 'font-medium text-ink'
                  : 'text-ink-soft hover:text-ink'
                }`}
            >
              <EngineIcon engine={id} size={14} />
              {/* 隐形加粗占位：预留 font-medium 宽度，选中变粗时不再挤动相邻按钮 */}
              <span className="grid">
                <span aria-hidden className="invisible whitespace-nowrap font-medium [grid-area:1/1]">{ENGINE_LABELS[id]}</span>
                <span className="whitespace-nowrap [grid-area:1/1]">{ENGINE_LABELS[id]}</span>
              </span>
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
              title={w.folders.length > 1 && enginePseudoWsKey(engine) ? t(enginePseudoWsKey(engine)!) : undefined}
              onClick={() => void start('', w.id)}
              className="flex items-center gap-2.5 rounded-xl border border-line bg-bg-input px-4 py-2.5 text-left shadow-sm transition hover:bg-bg-hover disabled:opacity-50"
            >
              <FolderGit2 size={15} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-ui font-medium">{w.name}</span>
              {/* 当前选中引擎无原生多根且工作区是多目录 → 事前提醒伪 workspace */}
              {w.folders.length > 1 && <PseudoWorkspaceBadge engine={engine} />}
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
