/**
 * ChatView — conversation stream + composer for the active session.
 * Right side hosts the RightDock: a codex-style tabbed panel where
 * 文件/变更/Agents、多个终端、多个 sidechat 分支与 plan 预览并列成
 * tab。The icon rail is persistent; its top button folds/expands the
 * dock (item 3/4/8).
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  FileDiff,
  FolderTree,
  Globe,
  MessagesSquare,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  SquareTerminal,
} from 'lucide-react';

import { useChatStore } from '../store/chatStore';
import { useRaceStore } from '../store/raceStore';
import { useT } from '../i18n';
import MessageList from './MessageList';
import Composer from './Composer';
import PermissionSheet from './PermissionSheet';
import QuestionPin from './QuestionPin';
import RightDock, { SIDE_PENDING, SIDE_PREFIX, TERM_PREFIX } from './RightDock';
import { RaceHorse } from './RaceHorse';
import OpenInRail from './OpenInRail';
import TurnRail from './TurnRail';
import DotMenu from './DotMenu';
import { BrandHero, BrandSpinner } from './brand';

export default function ChatView({ sessionId }: { sessionId: string }): JSX.Element {
  const t = useT();
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const creating = useChatStore((s) => s.creating);
  const sidechatIds = useChatStore((s) => s.sidechats[sessionId]) ?? [];
  const terms = useChatStore((s) => s.terminals[sessionId]) ?? [];
  const planPreviewId = useChatStore((s) => s.planPreview[sessionId]);
  const pendingFilePreview = useChatStore((s) => s.pendingFilePreview[sessionId]);
  const pendingChangePreview = useChatStore((s) => s.pendingChangePreview[sessionId]);
  const openSidechat = useChatStore((s) => s.openSidechat);
  const rightPanel = useChatStore((s) => s.rightPanels[sessionId]);
  const setRightPanel = useChatStore((s) => s.setRightPanel);
  // Open in 的文件夹候选：cwd 置首（primary）+ workspace 其他根去重（同 RightDock termFolders）。
  const workspace = useChatStore((s) => s.settings?.workspaces.find((w) => w.id === meta?.workspaceId));
  // browser use 开关：关时浏览器 tab / rail 钮不显示；持久化的 activeTab='browser'
  // 残留由下方 activeTab 合法性 effect 兜底回退到首个可用 tab。
  const browserUse = useChatStore((s) => s.settings?.browserUse ?? false);
  const panelOpen = rightPanel?.open ?? false;
  const activeTab = rightPanel?.activeTab ?? 'files';
  const [sidechatOpening, setSidechatOpening] = useState(false);
  // 标题内联重命名（⋯ 菜单触发）：Enter/blur 提交，Esc 取消，空标题不提交。
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // 与 stickToBottom 同源的 state 镜像 — 仅用于「回到底部」按钮显隐（ref 不触发重渲染）。
  const [atBottom, setAtBottom] = useState(true);

  const messages = ui?.messages ?? [];
  const isWork = meta?.chatMode === 'work';
  const openFolders =
    isWork && meta
      ? [meta.cwd, ...(workspace?.folders ?? []).filter((f) => f !== meta.cwd)].filter(Boolean)
      : [];

  // 切会话时复位贴底状态 — 组件实例跨会话复用，避免上个会话的离底状态泄漏到新会话。
  // switchGuard 短暂屏蔽 onScroll 对 stickToBottom 的置 false：切会话后消息列表
  // 重渲染期间 scrollHeight 分帧变化，程序化设 scrollTop 触发的 onScroll 可能在
  // 中间帧误判 near=false，之后 ResizeObserver 不再贴底 → 最终停在中间位置。
  const switchGuard = useRef(false);
  useEffect(() => {
    stickToBottom.current = true;
    setAtBottom(true);
    switchGuard.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    const timer = setTimeout(() => {
      switchGuard.current = false;
      // 窗口结束时再贴一次底，兜住渲染延迟。
      if (scrollRef.current && stickToBottom.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [sessionId]);

  // Auto-follow the stream unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 折叠收起/展开是 200ms 高度动画（Collapsible），只在 messages 变化时
  // 贴底会在动画期间失去锚点导致跳变 — 用 ResizeObserver 追着内容高度
  // 逐帧贴底，收起/增高都平滑跟随。同时监听滚动容器自身：Composer 高度
  // 变化（TopRails 显隐、textarea 自适应）会缩放滚动视口，仅监听内容不够
  // —— 视口缩小后 scrollTop 不自动跟进，末尾内容（如 Working… 指示器）
  // 被裁剪到底缘以下。
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 搜索高亮定位：searchHighlight 变化时滚动到目标消息并闪烁高亮。
  const searchHighlight = useChatStore((s) => s.searchHighlight);
  useEffect(() => {
    if (!searchHighlight || searchHighlight.sessionId !== sessionId || !searchHighlight.messageId) return;
    const { messageId } = searchHighlight;
    // 延迟等水合完成后再滚动（切会话时消息可能尚未渲染）。
    const timer = setTimeout(() => {
      const el = scrollRef.current?.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // 闪烁高亮
      el.classList.add('search-flash');
      setTimeout(() => el.classList.remove('search-flash'), 2000);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchHighlight, sessionId]);

  const planMsg = planPreviewId
    ? messages.find((m) => m.id === planPreviewId && m.kind === 'text')
    : undefined;
  const planText = planMsg && planMsg.kind === 'text' ? planMsg.text : undefined;

  // 当前会话可用的 tab 集合（顺序 = dock tab 栏顺序）。
  const allTabs = [
    ...(isWork ? ['files', 'changes'] : []),
    ...terms.map((tm) => `${TERM_PREFIX}${tm.id}`),
    ...sidechatIds.map((id) => `${SIDE_PREFIX}${id}`),
    ...(sidechatOpening ? [SIDE_PENDING] : []), // fork 进行中的占位 tab
    ...(planText !== undefined ? ['plan'] : []),
    ...(browserUse ? ['browser'] : []),
  ];
  const tabsKey = allTabs.join('|');

  // Plan 模式产出计划后自动弹出 plan tab（item 8）。
  useEffect(() => {
    if (planPreviewId) {
      setRightPanel(sessionId, { activeTab: 'plan', open: true });
    }
  }, [planPreviewId, sessionId, setRightPanel]);

  // AI 正文文件 chip 点击 → 开 files tab（信号不在这清除 — 由 WorkspacePanel
  // 挂载后消费并清除，保证点击时 dock 未开也能正确落地）。
  useEffect(() => {
    if (pendingFilePreview) {
      setRightPanel(sessionId, { activeTab: 'files', open: true });
    }
  }, [pendingFilePreview, sessionId, setRightPanel]);

  // 编辑工具卡点击 → 开 changes tab（信号同上，由 WorkspacePanel 消费清除）。
  useEffect(() => {
    if (pendingChangePreview) {
      setRightPanel(sessionId, { activeTab: 'changes', open: true });
    }
  }, [pendingChangePreview, sessionId, setRightPanel]);

  // 切会话时退出重命名编辑态（组件实例跨会话复用）。
  useEffect(() => setRenaming(false), [sessionId]);

  // 切会话 / 关 tab 后校验 activeTab 合法性：失效则回退首个 tab 或收起。
  useEffect(() => {
    if (!panelOpen || allTabs.includes(activeTab)) return;
    if (allTabs.length) setRightPanel(sessionId, { activeTab: allTabs[0]! });
    else setRightPanel(sessionId, { open: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, activeTab, tabsKey, sessionId, setRightPanel]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // switchGuard 期间只允许 near → true（贴底成功），不允许误判 false
    // （切会话重渲染期间 scrollHeight 分帧膨胀，中间帧 near 可能 false）。
    if (!near && switchGuard.current) return;
    stickToBottom.current = near;
    setAtBottom(near);
  };

  const scrollToBottom = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    // 先恢复贴底跟随（平滑滚动途中新消息到达时由 ResizeObserver 接管直接贴底）。
    stickToBottom.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const openTab = (tab: string): void => {
    setRightPanel(sessionId, { activeTab: tab, open: true });
  };

  /** 提交重命名：仅非空且有变化才落库（renameSession 已同步侧栏）。 */
  const commitRename = (): void => {
    setRenaming(false);
    const next = titleDraft.trim();
    if (!next || !meta || next === meta.title) return;
    void useChatStore.getState().renameSession(sessionId, next);
  };

  /** 新开终端 tab；cwd 由调用方选定（rail 默认 primary，"+"菜单可选其他根）。 */
  const addTerminalTab = (cwd: string): void =>
    openTab(`${TERM_PREFIX}${useChatStore.getState().addTerminal(sessionId, cwd)}`);

  /** 新开 sidechat 分支 tab：乐观先开占位 tab（fork/引擎唤醒在后台跑），
   *  fork 完成后原地换成真实分支面板，避免点击后干等 loading。 */
  const addSidechatTab = async (): Promise<void> => {
    setSidechatOpening(true);
    openTab(SIDE_PENDING);
    try {
      const id = await openSidechat(sessionId);
      // 用户中途没切走才跳到新分支；占位 tab 随 opening 结束自动消失。
      if (useChatStore.getState().rightPanels[sessionId]?.activeTab === SIDE_PENDING) {
        setRightPanel(sessionId, { activeTab: `${SIDE_PREFIX}${id}` });
      }
    } finally {
      setSidechatOpening(false);
    }
  };

  // Ctrl+S 新建当前对话的 sidechat（主 Composer 输入框聚焦时也可用）。
  // 跳过终端（Ctrl+S 是 XOFF 流量控制）与 INPUT/TEXTAREA（文件编辑器里
  // Ctrl+S 是保存、sidechat 输入框里无操作），让原处理优先。
  const addSidechatTabRef = useRef(addSidechatTab);
  addSidechatTabRef.current = addSidechatTab;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 's') return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('.xterm')) return;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      void addSidechatTabRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** rail 终端钮：只负责「打开/激活终端」；面板开合由顶部专用按钮负责。
   *  有终端 → 激活最近一个；没有 → 多目录 workspace 先弹菜单选目录
   *  （返回 'menu' 交给钮内下拉），单目录直接在 cwd 新开。 */
  const onRailTerminal = (): 'menu' | undefined => {
    if (terms.length) openTab(`${TERM_PREFIX}${terms[terms.length - 1]!.id}`);
    else if (openFolders.length > 1) return 'menu';
    else if (meta) addTerminalTab(meta.cwd);
    return;
  };

  /** rail sidechat 钮：每次点击都新建一个分支 tab（关 tab 即清理分支）。 */
  const onRailSidechat = async (): Promise<void> => {
    await addSidechatTab();
  };

  /** 关 tab：动态 tab 同步清理台账，激活态落到邻居；没剩下则收起。 */
  const closeTab = (tab: string): void => {
    const idx = allTabs.indexOf(tab);
    const remaining = allTabs.filter((x) => x !== tab);
    if (tab === 'plan') useChatStore.getState().setPlanPreview(sessionId, undefined);
    else if (tab.startsWith(TERM_PREFIX)) useChatStore.getState().removeTerminal(sessionId, tab.slice(TERM_PREFIX.length));
    else if (tab.startsWith(SIDE_PREFIX)) void useChatStore.getState().closeSidechat(tab.slice(SIDE_PREFIX.length));
    if (activeTab === tab) {
      const neighbor = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)];
      if (neighbor) setRightPanel(sessionId, { activeTab: neighbor });
      else setRightPanel(sessionId, { open: false });
    }
  };

  // 顶部按钮：折叠/展开右侧 dock（图标 rail 本身常驻不折叠）。
  const toggleRightPanel = async (): Promise<void> => {
    if (panelOpen) {
      // 折叠时若停在 plan tab，清掉预览标记，否则上面的 effect 会立刻重新弹出。
      if (activeTab === 'plan') useChatStore.getState().setPlanPreview(sessionId, undefined);
      setRightPanel(sessionId, { open: false });
      return;
    }
    if (allTabs.length) {
      const nextTab = allTabs.includes(activeTab) ? activeTab : allTabs[0]!;
      setRightPanel(sessionId, { activeTab: nextTab, open: true });
      return;
    }
    // chat 会话且没有任何 tab → 直接开一个 sidechat 分支。
    if (meta) await addSidechatTab();
  };

  const railButtons = (
    <>
      <RailButton
        title={panelOpen ? t('collapseRail') : t('expandRail')}
        active={panelOpen}
        onClick={() => void toggleRightPanel()}
      >
        {panelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
      </RailButton>
      {isWork && (
        <>
          <RailButton
            title={t('railFiles')}
            active={panelOpen && activeTab === 'files'}
            onClick={() => openTab('files')}
          >
            <FolderTree size={16} />
          </RailButton>
          <RailButton
            title={t('railChanges')}
            active={panelOpen && activeTab === 'changes'}
            onClick={() => openTab('changes')}
          >
            <FileDiff size={16} />
          </RailButton>
          <div className="my-1 h-px w-5 bg-line" />
          <TermRailButton
            title={t('railTerminal')}
            active={panelOpen && activeTab.startsWith(TERM_PREFIX)}
            folders={openFolders}
            onClick={onRailTerminal}
            onPickFolder={addTerminalTab}
          />
          {/* 用外部程序打开当前工作目录（workspace 多根时菜单内选文件夹） */}
          <OpenInRail folders={openFolders} />
        </>
      )}
      {meta && (
        <RailButton
          title={t('railBranch')}
          active={panelOpen && activeTab.startsWith(SIDE_PREFIX)}
          disabled={creating || sidechatOpening || meta.status === 'starting'}
          onClick={() => void onRailSidechat()}
          onHover={() => void window.cyberslots.sessionWarmUp(sessionId)} // 悬停预热父引擎，fork 免等唤醒
        >
          {sidechatOpening ? <BrandSpinner size={16} className="text-accent" /> : <MessagesSquare size={16} />}
        </RailButton>
      )}
      {browserUse && (
        <RailButton
          title={t('railBrowser')}
          active={panelOpen && activeTab === 'browser'}
          onClick={() => openTab('browser')}
        >
          <Globe size={16} />
        </RailButton>
      )}
    </>
  );

  return (
    <div className="relative flex h-full min-w-0">
      {/* 中间列保底宽度 — 防右侧 dock 把会话流/Composer 挤成条（溢出时由 dock 一侧收缩） */}
      <div className="flex h-full min-w-[340px] flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 px-5">
          {renaming ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                else if (e.key === 'Escape') setRenaming(false);
              }}
              onBlur={commitRename}
              className="w-64 rounded-md border border-line bg-bg-input px-2 py-0.5 text-sm font-medium outline-none transition focus:border-accent"
            />
          ) : (
            <span className="min-w-0 truncate text-sm font-medium">{meta?.title ?? t('sessionFallback')}</span>
          )}
          {meta && (
            <DotMenu
              hoverReveal={false}
              align="left"
              items={[
                {
                  icon: <Pencil size={13} />,
                  label: t('renameChat'),
                  onClick: () => {
                    setTitleDraft(meta.title ?? '');
                    setRenaming(true);
                  },
                },
              ]}
            />
          )}
          {isWork && meta && (
            <span className="truncate rounded-md bg-bg-panel px-2 py-[3px] font-mono text-[11px] leading-[1.2] text-ink-soft">{meta.cwd}</span>
          )}
          <div className="flex-1" />
          <Heartbeat sessionId={sessionId} busy={meta?.status === 'running' || meta?.status === 'awaiting'} awaiting={meta?.status === 'awaiting'} />
        </header>

        {/* 赛马角色会话不在侧栏，落进来后靠面包屑标明归属与回路 */}
        {meta?.raceId && <RaceCrumb raceId={meta.raceId} />}

        {/* 消息滚动区 — relative 供刻度条测量锚点；左缘叠加 codex 同款回合导航刻度 */}
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="relative h-full overflow-y-auto">
            <div ref={contentRef} className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 px-6 py-6">
              {messages.length === 0 && (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink-faint">
                  {/* 大场面拉霸仪式：启动中=等开奖；空会话=拉一把开聊 */}
                  <BrandHero size={64} />
                  {meta?.status === 'starting' ? (
                    /* 启动不阻塞输入 — 消息会在引擎就绪后自动投递 */
                    <span className="text-[14px]">{t('chatStartingBanner')}</span>
                  ) : (
                    <span className="text-[14px]">{t('chatFirstMessage')}</span>
                  )}
                </div>
              )}
              <MessageList sessionId={sessionId} messages={messages} />
            </div>
          </div>
          <TurnRail sessionId={sessionId} scrollRef={scrollRef} />
          {/* 当前提问滚出上缘后钉在顶部的提问胶囊（点击回跳） */}
          <QuestionPin sessionId={sessionId} scrollRef={scrollRef} />
          {/* 离底时悬浮在滚动区底缘中央的「回到底部」（Composer 上方，与 QuestionPin 同款胶囊样式） */}
          {!atBottom && (
            <button
              onClick={scrollToBottom}
              title={t('scrollToBottom')}
              className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-bg-active p-2 text-ink-soft shadow-md transition-colors hover:text-ink"
            >
              <ArrowDown size={14} />
            </button>
          )}
        </div>

        <PermissionSheet sessionId={sessionId} />
        <Composer sessionId={sessionId} />
      </div>

      {/* 右侧 dock：统一 tab 化的辅助面板（文件/变更/Agents/终端/sidechat/plan）。
          DockReveal 做宽度过渡，中间消息区随之平滑让位而非瞬移。 */}
      <DockReveal open={panelOpen && !!meta && allTabs.length > 0}>
        {meta && allTabs.length > 0 && (
          <RightDock
            sessionId={sessionId}
            meta={meta}
            activeTab={activeTab}
            terms={terms}
            sidechatIds={sidechatIds}
            pendingSidechat={sidechatOpening}
            planText={planText}
            creating={creating || sidechatOpening}
            onSelectTab={(tab) => setRightPanel(sessionId, { activeTab: tab })}
            onCloseTab={closeTab}
            onAddTerminal={addTerminalTab}
            onAddSidechat={() => void addSidechatTab()}
          />
        )}
      </DockReveal>

      {/* 右侧快捷图标 rail — 常驻不折叠；顶部按钮切换旁边的工作区面板 */}
      <div className="flex w-11 shrink-0 flex-col items-center gap-1 py-2.5">
        {railButtons}
      </div>
    </div>
  );
}

/** 赛马角色会话面包屑：角色会话被侧栏隐藏（赛马寄生设计），从赛马视图
 *  「↗ 打开执行会话」等入口跳进来后，靠这条横幅看清自己在哪、
 *  一键回赛马视图或回发起该赛马的宿主对话。 */
function RaceCrumb({ raceId }: { raceId: string }): JSX.Element | null {
  const t = useT();
  const race = useRaceStore((s) => s.races[raceId]);
  const openRace = useRaceStore((s) => s.openRace);
  const selectSession = useChatStore((s) => s.selectSession);
  if (!race) return null;
  return (
    <div className="mx-5 mb-1 flex shrink-0 items-center gap-2 rounded-lg border border-line bg-bg-panel/70 px-3 py-1.5 text-[12px] text-ink-soft">
      <RaceHorse size={16} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={race.prompt}>
        {t('chatRaceRoleBanner', { prompt: race.prompt })}
      </span>
      <button
        onClick={() => openRace(raceId)}
        className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
      >
        {t('chatBackToRace')}
      </button>
      {race.parentSessionId && (
        <button
          onClick={() => selectSession(race.parentSessionId!)}
          className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
        >
          {t('chatBackToHost')}
        </button>
      )}
    </div>
  );
}

/**
 * Heartbeat — liveness indicator for the running turn. Network drops
 * rarely raise an error, they just go silent; this surfaces "seconds
 * since the last engine event" and escalates color when it stalls.
 */
function Heartbeat({ sessionId, busy, awaiting }: { sessionId: string; busy: boolean; awaiting?: boolean }): JSX.Element | null {
  const t = useT();
  const lastActivityAt = useChatStore((s) => s.ui[sessionId]?.lastActivityAt);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  if (!busy || !lastActivityAt) return null;
  const idleSec = Math.floor((Date.now() - lastActivityAt) / 1000);

  // 等待授权不是停滞 — 引擎在等用户点按钮，不走静默升级逻辑。
  if (awaiting) {
    return (
      <div className="flex items-center gap-1.5" title={t('hbAwaitingPerm')}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
        <span className="text-[11px] text-warn">{t('hbAwaitingPerm')}</span>
      </div>
    );
  }

  let dot = 'bg-ok animate-pulse';
  let label = t('hbWorking');
  let tone = 'text-ink-faint';
  if (idleSec >= 45) {
    dot = 'bg-err';
    label = `${t('hbStalled')} ${idleSec}s`;
    tone = 'text-err';
  } else if (idleSec >= 12) {
    dot = 'bg-warn';
    label = `${t('hbWaiting')} ${idleSec}s`;
    tone = 'text-warn';
  }

  return (
    <div className="flex items-center gap-1.5" title={t('chatIdleSince', { s: idleSec })}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className={`text-[11px] tabular-nums ${tone}`}>{label}</span>
    </div>
  );
}

/**
 * DockReveal — 右侧 dock 的开合宽度过渡容器。grid 列宽 0fr↔1fr 连续插值，
 * 让 dock 从右缘滑入/滑出的同时，中间消息区同步平滑让位（而非瞬移回流）。
 * 收起时等过渡结束再卸载子树。
 */
function DockReveal({ open, children }: { open: boolean; children: React.ReactNode }): JSX.Element | null {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (!open) {
      setExpanded(false);
      return;
    }
    setMounted(true);
    // 先以 0fr 挂载，隔帧再展开，保证过渡动画触发。
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(true)));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      // min-w-0（非 shrink-0）：窗口不够宽时由 dock 被裁剪收缩，中间列保住保底宽度
      className="grid h-full min-h-0 min-w-0"
      // minmax(0, …fr)：裸 1fr 的隐式最小宽度是内容宽（minmax(auto,1fr)），
      // 窄窗口下轨道拒绝收缩会把 dock 整体顶出屏外；锁死最小 0 才能
      // 落地「裁剪而非溢出」的设计（dock 贴右缘露出可用部分）。
      // 行高同样必须 minmax(0,1fr)：auto 行高按内容撑高，面板内部
      // 的 overflow-y-auto 永远等不到触发，超高内容会被外层直接裁剪。
      style={{
        gridTemplateColumns: expanded ? 'minmax(0, 1fr)' : 'minmax(0, 0fr)',
        gridTemplateRows: 'minmax(0, 1fr)',
        transition: 'grid-template-columns 220ms ease-out',
      }}
      onTransitionEnd={(e) => {
        if (e.propertyName === 'grid-template-columns' && !open) setMounted(false);
      }}
    >
      {/* 右对齐 + 裁剪：收窄时 dock 保持贴右缘，呈现从右滑入/滑出。
          overflow-clip：禁止程序化滚动（xterm 聚焦/scrollIntoView 会把
          overflow-hidden 容器滚出错位，同 App 主容器的踩坑） */}
      <div className="flex min-w-0 justify-end overflow-clip">{children}</div>
    </div>
  );
}

function RailButton({
  title,
  active,
  disabled,
  onClick,
  onHover,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** 悬停回调（如提前预热引擎）。 */
  onHover?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      onPointerEnter={onHover}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition disabled:opacity-40 ${active ? 'bg-accent-soft text-accent' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
        }`}
    >
      {children}
    </button>
  );
}

const termBasename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * TermRailButton — rail 终端钮：onClick 返回 'menu' 时（多目录 workspace
 * 要新开终端）弹出向左菜单选工作目录，交互与下方 OpenInRail 一致
 * （fixed 定位规避 overflow 裁剪，Esc/点空处关闭）；条目样式同 RightDock
 * 「+」菜单（新终端 · 目录名 + primary 徽标）。
 */
function TermRailButton({
  title,
  active,
  folders,
  onClick,
  onPickFolder,
}: {
  title: string;
  active: boolean;
  folders: string[];
  onClick: () => 'menu' | undefined;
  onPickFolder: (cwd: string) => void;
}): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 下拉锚点：同 OpenInRail — rail 在最右列且外层 overflow-clip，fixed 向左展开。
  const dropStyle = (): React.CSSProperties => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return {};
    return { position: 'fixed', top: r.top, right: Math.max(8, window.innerWidth - r.left + 6) };
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        title={title}
        onClick={() => {
          if (open) setOpen(false);
          else if (onClick() === 'menu') setOpen(true);
        }}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
          active || open ? 'bg-accent-soft text-accent' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
        }`}
      >
        <SquareTerminal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            style={dropStyle()}
            className="z-20 max-h-[70vh] min-w-52 overflow-y-auto rounded-lg border border-line bg-bg-input py-1 shadow-lg"
          >
            {folders.map((f, i) => (
              <button
                key={f}
                title={f}
                onClick={() => {
                  setOpen(false);
                  onPickFolder(f);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink transition hover:bg-bg-hover"
              >
                <SquareTerminal size={13} className="shrink-0 text-ink-soft" />
                <span className="min-w-0 flex-1 truncate">
                  {t('dockNewTerminal')} · {termBasename(f)}
                </span>
                {i === 0 && (
                  <span className="shrink-0 rounded border border-line px-1 text-[9.5px] text-ink-faint">{t('primaryFolder')}</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
