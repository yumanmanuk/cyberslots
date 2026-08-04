/**
 * RightDock — 右侧统一辅助面板（参考 codex 的 tab 化设计）：
 * 文件/变更/Agents（work 会话固定 tab）与多个终端、多个 sidechat、
 * plan 预览并列为同级 tab；"+" 菜单可选工作区任一文件夹新开终端
 * （多根 workspace 每个 root 一项，默认 primary），或新开 sidechat。
 * sidechat 的只读说明不常驻，悬浮其 tab 时以 tooltip 展示。
 *
 * tab 数量不设上限：tab 栏用 w-0 min-w-full 避免撑宽 dock（dock 宽度
 * 始终由内容面板决定），装不下时栏内横向滚动 + 「全部标签页」下拉兜底；
 * dock 左缘拖拽把手调整当前激活面板的宽度（按面板类型分别记忆）。
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileDiff, FolderTree, MessagesSquare, NotebookText, Plus, SquareTerminal, X } from 'lucide-react';

import type { SessionMeta } from '@shared/types';
import { useChatStore, type TerminalTab } from '../store/chatStore';
import { useT } from '../i18n';
import WorkspacePanel, { useChangedFiles, type ChangedFilesResult, type PanelTab } from './workspace/WorkspacePanel';
import SideChatPanel from './SideChatPanel';
import TerminalPanel from './TerminalPanel';
import PlanDocPanel from './PlanDocPanel';
import { BrandHero, BrandSpinner } from './brand';

/** tab id 约定：固定 tab 用字面量；动态 tab 用 `term:<id>` / `side:<会话id>`。 */
export const TERM_PREFIX = 'term:';
export const SIDE_PREFIX = 'side:';
/** sidechat fork 进行中的占位 tab id（乐观先开面板，fork 完成后替换）。 */
export const SIDE_PENDING = `${SIDE_PREFIX}pending`;

/** 面板宽度按 tab 类型分别记忆（localStorage）；左缘把手拖拽调整。 */
type PanelKind = 'ws' | 'term' | 'side' | 'plan';
const WIDTH_SPEC: Record<PanelKind, { key: string; def: number; min: number; max: number }> = {
  ws: { key: 'cs.wsTreeWidth', def: 300, min: 220, max: 520 },
  term: { key: 'cs.termWidth', def: 440, min: 300, max: 800 },
  side: { key: 'cs.sidechatWidth', def: 380, min: 300, max: 720 },
  plan: { key: 'cs.planWidth', def: 420, min: 320, max: 720 },
};
const readWidth = (kind: PanelKind): number => {
  const s = WIDTH_SPEC[kind];
  const saved = Number(localStorage.getItem(s.key));
  return Number.isFinite(saved) && saved >= s.min && saved <= s.max ? saved : s.def;
};

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

/** tab 元数据 — 滚动条里的 tab 与「全部标签页」下拉共用一份。 */
interface TabDesc {
  id: string;
  icon: React.ReactNode;
  label: string;
  title?: string;
  closable?: boolean;
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** tab 条两端渐隐宽度（px）— 与 index.css 的 .strip-fade-* 保持一致。 */
const STRIP_FADE = 16;

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
  // "+"菜单的终端目录候选 / 文件树多根：workspace 全部根目录，普通项目仅 cwd。
  // cwd 强制置首（primary）— 防 workspace 编辑后 folders 顺序与会话 cwd 脱钩。
  const workspace = useChatStore((s) => s.settings?.workspaces.find((w) => w.id === meta.workspaceId));
  const termFolders = isWork
    ? [meta.cwd, ...(workspace?.folders ?? []).filter((f) => f !== meta.cwd)]
    : [];
  const [menuOpen, setMenuOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  // 下拉锚点：按钮 ref + fixed 定位 —— absolute 会被 DockReveal 的
  // overflow 裁剪链切掉（窄窗口下 dock 盒子比菜单窄，菜单只剩右半截，
  // 实测踩坑）；fixed 的包含块是视口，不受祖先 overflow 影响。
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const listBtnRef = useRef<HTMLButtonElement>(null);
  const dropAt = (btn: HTMLElement | null): React.CSSProperties => {
    const r = btn?.getBoundingClientRect();
    return r ? { position: 'fixed', top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) } : {};
  };

  // 变更数据提升到此处：tab 徽标与内容面板共用一份（避免双拉取）。
  const [changesNonce, setChangesNonce] = useState(0);
  const { entries: changes, loading: changesLoading } = useChangedFiles(sessionId, changesNonce);
  // tab 徽标只统计待接受文件；已接受文件保留在面板内展示，不再增加待办角标。
  const pendingChanges = changes.filter((c) => c.status !== 'accepted').length;

  const isPanelTab = activeTab === 'files' || activeTab === 'changes';

  // 面板宽度状态：拖动中直接改 state（无过渡），松手持久化。
  const [widths, setWidths] = useState<Record<PanelKind, number>>(() => ({
    ws: readWidth('ws'),
    term: readWidth('term'),
    side: readWidth('side'),
    plan: readWidth('plan'),
  }));
  const activeKind: PanelKind = activeTab.startsWith(TERM_PREFIX)
    ? 'term'
    : activeTab.startsWith(SIDE_PREFIX)
      ? 'side'
      : activeTab === 'plan'
        ? 'plan'
        : 'ws';
  const drag = useRef<{ kind: PanelKind; startX: number; startW: number } | null>(null);

  // tab 描述集中生成（顺序 = 展示顺序）。
  const tabs: TabDesc[] = [];
  if (isWork) {
    tabs.push(
      { id: 'files', icon: <FolderTree size={13} />, label: t('tabFiles') },
      { id: 'changes', icon: <FileDiff size={13} />, label: pendingChanges > 0 ? `${t('tabChanges')} ${pendingChanges}` : t('tabChanges') },
    );
  }
  for (const tm of terms) {
    tabs.push({ id: `${TERM_PREFIX}${tm.id}`, icon: <SquareTerminal size={13} />, label: basename(tm.cwd), title: tm.cwd, closable: true });
  }
  sidechatIds.forEach((sid, i) => {
    tabs.push({
      id: `${SIDE_PREFIX}${sid}`,
      icon: <MessagesSquare size={13} />,
      label: sidechatIds.length > 1 ? `${t('sidechatTab')} ${i + 1}` : t('sidechatTab'),
      title: t('sidechatHint'),
      closable: true,
    });
  });
  if (pendingSidechat) {
    tabs.push({ id: SIDE_PENDING, icon: <BrandSpinner size={13} className="text-accent" />, label: t('sidechatTab'), title: t('sidechatHint') });
  }
  if (planText !== undefined) {
    tabs.push({ id: 'plan', icon: <NotebookText size={13} />, label: t('planDocTitle'), closable: true });
  }

  // tab 溢出检测：装不下时露出「全部标签页」下拉兜底；同时维护两端
  // 渐隐态（哪侧还有被截断的 tab 就在哪侧淡出，消硬切残影）。
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [fade, setFade] = useState({ l: false, r: false });
  const tabsKey = tabs.map((tb) => tb.id).join('|');
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const check = (): void => {
      const over = el.scrollWidth > el.clientWidth + 1;
      setOverflowing(over);
      const l = over && el.scrollLeft > 1;
      const r = over && el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
      setFade((prev) => (prev.l === l && prev.r === r ? prev : { l, r }));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener('scroll', check, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsKey]);

  return (
    <div className="relative flex shrink-0 flex-col border-l border-line bg-bg-panel/60">
      {/* 左缘拖拽把手 — 悬停/拖动时高亮成细线，调整当前激活面板宽度 */}
      <div
        onPointerDown={(e) => {
          drag.current = { kind: activeKind, startX: e.clientX, startW: widths[activeKind] };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const spec = WIDTH_SPEC[d.kind];
          const w = Math.min(spec.max, Math.max(spec.min, d.startW + (d.startX - e.clientX)));
          setWidths((prev) => (prev[d.kind] === w ? prev : { ...prev, [d.kind]: w }));
        }}
        onPointerUp={() => {
          const d = drag.current;
          if (!d) return;
          drag.current = null;
          localStorage.setItem(WIDTH_SPEC[d.kind].key, String(widths[d.kind]));
        }}
        className="absolute inset-y-0 left-0 z-30 w-1 cursor-col-resize touch-none transition-colors duration-150 hover:bg-accent/40 active:bg-accent/60"
      />

      {/* 统一 tab 栏 — w-0 min-w-full：不参与撑宽 dock，超宽时栏内横向滚动；
          「全部标签页」与 "+" 固定右侧不随滚动走 */}
      <div className="flex w-0 min-w-full shrink-0 items-center border-b border-line">
        <div
          ref={stripRef}
          className={`no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1.5 ${
            fade.l ? (fade.r ? 'strip-fade-lr' : 'strip-fade-l') : fade.r ? 'strip-fade-r' : ''
          }`}
        >
          {tabs.map((tb) => (
            <DockTab
              key={tb.id}
              active={activeTab === tb.id}
              icon={tb.icon}
              label={tb.label}
              title={tb.title}
              onClick={() => onSelectTab(tb.id)}
              onClose={tb.closable ? () => onCloseTab(tb.id) : undefined}
            />
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 py-1.5 pr-2">
          {/* 溢出兜底：列出全部 tab（含滚出视野的），一眼定位并跳转 */}
          {overflowing && (
            <div className="relative">
              <button
                ref={listBtnRef}
                title={t('dockAllTabs')}
                onClick={() => setListOpen(!listOpen)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition hover:bg-bg-hover hover:text-ink"
              >
                <ChevronDown size={14} />
              </button>
              {listOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setListOpen(false)} />
                  <div style={dropAt(listBtnRef.current)} className="z-20 max-h-80 min-w-44 overflow-y-auto rounded-lg border border-line bg-bg-input py-1 shadow-lg">
                    {tabs.map((tb) => (
                      <div
                        key={tb.id}
                        className={`group flex items-center gap-1 pr-1.5 transition hover:bg-bg-hover ${activeTab === tb.id ? 'text-accent' : 'text-ink'}`}
                      >
                        <button
                          title={tb.title}
                          onClick={() => {
                            setListOpen(false);
                            onSelectTab(tb.id);
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 text-left text-[12px]"
                        >
                          <span className="shrink-0">{tb.icon}</span>
                          <span className={`min-w-0 truncate ${activeTab === tb.id ? 'font-medium' : ''}`}>{tb.label}</span>
                        </button>
                        {tb.closable && (
                          <button
                            title={t('closeTab')}
                            onClick={() => onCloseTab(tb.id)}
                            className="shrink-0 rounded p-0.5 text-transparent transition hover:bg-bg-active hover:text-ink group-hover:text-ink-faint"
                          >
                            <X size={11} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* "+"：按文件夹新开终端 / 新开 sidechat（codex 的 New tab 菜单） */}
          <div className="relative">
            <button
              ref={menuBtnRef}
              title={t('dockAddTab')}
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition hover:bg-bg-hover hover:text-ink"
            >
              <Plus size={14} />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div style={dropAt(menuBtnRef.current)} className="z-20 min-w-52 rounded-lg border border-line bg-bg-input py-1 shadow-lg">
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
      </div>

      {/* 内容区：workspace 三 tab 共用一个面板；终端全部挂载（hidden 保活缓冲） */}
      <div className="flex min-h-0 flex-1">
        {isPanelTab && isWork && (
          <WorkspacePanel
            sessionId={sessionId}
            roots={termFolders.length ? termFolders : [meta.cwd]}
            tab={activeTab as PanelTab}
            treeWidth={widths.ws}
            changes={changes}
            changesLoading={changesLoading}
            changesNonce={changesNonce}
            onRefreshChanges={() => setChangesNonce((n) => n + 1)}
          />
        )}
        {terms.map((tm) => (
          <TerminalPanel key={tm.id} termId={tm.id} cwd={tm.cwd} width={widths.term} hidden={activeTab !== `${TERM_PREFIX}${tm.id}`} />
        ))}
        {activeTab.startsWith(SIDE_PREFIX) && sidechatIds.includes(activeTab.slice(SIDE_PREFIX.length)) && (
          <SideChatPanel sessionId={activeTab.slice(SIDE_PREFIX.length)} width={widths.side} />
        )}
        {activeTab === SIDE_PENDING && pendingSidechat && (
          // 宽度对齐真实 sidechat 面板，fork 完成替换时不跳动；面板级等待按规范用 BrandHero
          <div className="flex shrink-0 flex-col items-center justify-center gap-2.5 text-ink-faint" style={{ width: widths.side }}>
            <BrandHero size={48} />
            <span className="text-[12.5px]">{t('sidechatPending')}</span>
          </div>
        )}
        {activeTab === 'plan' && planText !== undefined && (
          <PlanDocPanel sessionId={sessionId} text={planText} width={widths.plan} onClose={() => onCloseTab('plan')} />
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
  const ref = useRef<HTMLButtonElement>(null);
  // 激活时滚入视野 — tab 多时切换/新建不至于"失踪"在滚动区外。
  // 手动只滚 tab 条自身：不用 scrollIntoView —— 它会连带滚动所有可滚祖先，
  // 窄窗口下曾把 App 的 overflow 主容器横向滚出「面板可见但点击全部
  // 落空」的错位死态（hit-test 与渲染不同步，实测踩坑）。
  useEffect(() => {
    const el = ref.current;
    const strip = el?.parentElement; // tabs 是 stripRef 容器的直接子元素
    if (!active || !el || !strip) return;
    const align = (): void => {
      // 按内容盒对齐并避开两端渐隐区（STRIP_FADE），不让激活 tab 被淡出
      const cs = getComputedStyle(strip);
      const sr = strip.getBoundingClientRect();
      const tr = el.getBoundingClientRect();
      const left = sr.left + parseFloat(cs.paddingLeft) + STRIP_FADE;
      const right = sr.right - parseFloat(cs.paddingRight) - STRIP_FADE;
      if (tr.left < left) strip.scrollLeft += tr.left - left;
      else if (tr.right > right) strip.scrollLeft += tr.right - right;
    };
    align();
    // 「全部标签页」钮随溢出态迟一帧才出现，会挤窄 tab 条把刚对齐的
    // 激活 tab 右缘截掉一角 —— 激活期间监听条宽变化持续复位对齐。
    const ro = new ResizeObserver(align);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [active]);
  return (
    <button
      ref={ref}
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
