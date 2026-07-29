/**
 * RightDock — 右侧统一辅助面板（参考 codex 的 tab 化设计）：
 * 文件/变更/Agents（work 会话固定 tab）与多个终端、多个 sidechat、
 * plan 预览并列为同级 tab；"+" 菜单可选工作区任一文件夹新开终端
 * （多根 workspace 每个 root 一项，默认 primary），或新开 sidechat。
 * sidechat 的只读说明不常驻，悬浮其 tab 时以 tooltip 展示。
 */

import { useState } from 'react';
import { Bot, FileDiff, FolderTree, MessagesSquare, NotebookText, Plus, SquareTerminal, X } from 'lucide-react';

import type { SessionMeta } from '@shared/types';
import { useChatStore, type TerminalTab } from '../store/chatStore';
import { useT } from '../i18n';
import WorkspacePanel, { useAgentActivity, useChangedFiles, type PanelTab } from './workspace/WorkspacePanel';
import SideChatPanel, { readSidechatWidth } from './SideChatPanel';
import TerminalPanel from './TerminalPanel';
import PlanDocPanel from './PlanDocPanel';
import { BrandHero, BrandSpinner } from './brand';

/** tab id 约定：固定 tab 用字面量；动态 tab 用 `term:<id>` / `side:<会话id>`。 */
export const TERM_PREFIX = 'term:';
export const SIDE_PREFIX = 'side:';
/** sidechat fork 进行中的占位 tab id（乐观先开面板，fork 完成后替换）。 */
export const SIDE_PENDING = `${SIDE_PREFIX}pending`;

interface Props {
  sessionId: string;
  meta: SessionMeta;
  activeTab: string;
  terms: TerminalTab[];
  sidechatIds: string[];
  /** sidechat fork 进行中 — 展示占位 tab + loading 面板。 */
  pendingSidechat?: boolean;
  /** plan 预览文本；有值时展示 plan tab。 */
  planText?: string;
  /** 分支 fork 进行中 — 禁用"+"里的新建 sidechat。 */
  creating: boolean;
  onSelectTab: (tab: string) => void;
  onCloseTab: (tab: string) => void;
  onAddTerminal: (cwd: string) => void;
  onAddSidechat: () => void;
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export default function RightDock({
  sessionId,
  meta,
  activeTab,
  terms,
  sidechatIds,
  pendingSidechat,
  planText,
  creating,
  onSelectTab,
  onCloseTab,
  onAddTerminal,
  onAddSidechat,
}: Props): JSX.Element {
  const t = useT();
  const isWork = meta.chatMode === 'work';
  // "+"菜单的终端目录候选：workspace 全部根目录（首个为 primary），普通项目仅 cwd。
  const workspace = useChatStore((s) => s.settings?.workspaces.find((w) => w.id === meta.workspaceId));
  const termFolders = isWork ? (workspace?.folders.length ? workspace.folders : [meta.cwd]) : [];
  const [menuOpen, setMenuOpen] = useState(false);

  // 变更/Agents 数据提升到此处：tab 徽标与内容面板共用一份（避免双拉取）。
  const [changesNonce, setChangesNonce] = useState(0);
  const changes = useChangedFiles(sessionId, changesNonce);
  const agents = useAgentActivity(sessionId);

  const isPanelTab = activeTab === 'files' || activeTab === 'changes' || activeTab === 'agents';

  return (
    <div className="flex shrink-0 flex-col border-l border-line bg-bg-panel/60">
      {/* 统一 tab 栏 — 文件/变更/Agents 与终端、sidechat、plan 并列（codex 风格） */}
      <div className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
        {isWork && (
          <>
            <DockTab
              active={activeTab === 'files'}
              icon={<FolderTree size={13} />}
              label={t('tabFiles')}
              onClick={() => onSelectTab('files')}
            />
            <DockTab
              active={activeTab === 'changes'}
              icon={<FileDiff size={13} />}
              label={changes.length > 0 ? `${t('tabChanges')} ${changes.length}` : t('tabChanges')}
              onClick={() => onSelectTab('changes')}
            />
            <DockTab
              active={activeTab === 'agents'}
              icon={<Bot size={13} />}
              label={agents.length > 0 ? `${t('tabAgents')} ${agents.length}` : t('tabAgents')}
              onClick={() => onSelectTab('agents')}
            />
          </>
        )}
        {terms.map((tm) => (
          <DockTab
            key={tm.id}
            active={activeTab === `${TERM_PREFIX}${tm.id}`}
            icon={<SquareTerminal size={13} />}
            label={basename(tm.cwd)}
            title={tm.cwd}
            onClick={() => onSelectTab(`${TERM_PREFIX}${tm.id}`)}
            onClose={() => onCloseTab(`${TERM_PREFIX}${tm.id}`)}
          />
        ))}
        {sidechatIds.map((sid, i) => (
          <DockTab
            key={sid}
            active={activeTab === `${SIDE_PREFIX}${sid}`}
            icon={<MessagesSquare size={13} />}
            label={sidechatIds.length > 1 ? `${t('sidechatTab')} ${i + 1}` : t('sidechatTab')}
            title={t('sidechatHint')}
            onClick={() => onSelectTab(`${SIDE_PREFIX}${sid}`)}
            onClose={() => onCloseTab(`${SIDE_PREFIX}${sid}`)}
          />
        ))}
        {pendingSidechat && (
          <DockTab
            active={activeTab === SIDE_PENDING}
            icon={<BrandSpinner size={13} className="text-accent" />}
            label={t('sidechatTab')}
            title={t('sidechatHint')}
            onClick={() => onSelectTab(SIDE_PENDING)}
          />
        )}
        {planText !== undefined && (
          <DockTab
            active={activeTab === 'plan'}
            icon={<NotebookText size={13} />}
            label={t('planDocTitle')}
            onClick={() => onSelectTab('plan')}
            onClose={() => onCloseTab('plan')}
          />
        )}

        {/* "+"：按文件夹新开终端 / 新开 sidechat（codex 的 New tab 菜单） */}
        <div className="relative shrink-0">
          <button
            title={t('dockAddTab')}
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            <Plus size={14} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-7 z-20 min-w-52 rounded-lg border border-line bg-bg-input py-1 shadow-lg">
                {termFolders.map((f, i) => (
                  <button
                    key={f}
                    title={f}
                    onClick={() => {
                      setMenuOpen(false);
                      onAddTerminal(f);
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink transition hover:bg-bg-hover"
                  >
                    <SquareTerminal size={13} className="shrink-0 text-ink-soft" />
                    <span className="min-w-0 flex-1 truncate">
                      {t('dockNewTerminal')} · {basename(f)}
                    </span>
                    {i === 0 && termFolders.length > 1 && (
                      <span className="shrink-0 rounded border border-line px-1 text-[9.5px] text-ink-faint">{t('primaryFolder')}</span>
                    )}
                  </button>
                ))}
                {termFolders.length > 0 && <div className="mx-2 my-1 h-px bg-line" />}
                <button
                  disabled={creating}
                  title={t('sidechatHint')}
                  onClick={() => {
                    setMenuOpen(false);
                    onAddSidechat();
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink transition hover:bg-bg-hover disabled:opacity-40"
                >
                  <MessagesSquare size={13} className="shrink-0 text-ink-soft" />
                  {t('dockNewSidechat')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 内容区：workspace 三 tab 共用一个面板；终端全部挂载（hidden 保活缓冲） */}
      <div className="flex min-h-0 flex-1">
        {isPanelTab && isWork && (
          <WorkspacePanel
            sessionId={sessionId}
            root={meta.cwd}
            tab={activeTab as PanelTab}
            changes={changes}
            changesNonce={changesNonce}
            agents={agents}
            onRefreshChanges={() => setChangesNonce((n) => n + 1)}
          />
        )}
        {terms.map((tm) => (
          <TerminalPanel key={tm.id} termId={tm.id} cwd={tm.cwd} hidden={activeTab !== `${TERM_PREFIX}${tm.id}`} />
        ))}
        {activeTab.startsWith(SIDE_PREFIX) && sidechatIds.includes(activeTab.slice(SIDE_PREFIX.length)) && (
          <SideChatPanel sessionId={activeTab.slice(SIDE_PREFIX.length)} />
        )}
        {activeTab === SIDE_PENDING && pendingSidechat && (
          // 宽度对齐真实 sidechat 面板，fork 完成替换时不跳动；面板级等待按规范用 BrandHero
          <div className="flex shrink-0 flex-col items-center justify-center gap-2.5 text-ink-faint" style={{ width: readSidechatWidth() }}>
            <BrandHero size={48} />
            <span className="text-[12.5px]">{t('sidechatPending')}</span>
          </div>
        )}
        {activeTab === 'plan' && planText !== undefined && (
          <PlanDocPanel sessionId={sessionId} text={planText} onClose={() => onCloseTab('plan')} />
        )}
      </div>
    </div>
  );
}

function DockTab({
  active,
  icon,
  label,
  title,
  onClick,
  onClose,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
  onClose?: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <button
      onClick={onClick}
      title={title}
      className={`group flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-ui ${active ? 'bg-bg-active font-medium text-ink' : 'text-ink-soft hover:bg-bg-hover'
        }`}
    >
      {icon}
      <span className="max-w-28 truncate">{label}</span>
      {onClose && (
        <span
          role="button"
          title={t('closeTab')}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={`-mr-1 rounded p-0.5 transition hover:bg-bg-hover hover:text-ink ${active ? 'text-ink-faint' : 'text-transparent group-hover:text-ink-faint'
            }`}
        >
          <X size={11} />
        </span>
      )}
    </button>
  );
}
