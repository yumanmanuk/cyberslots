/**
 * ChatView — conversation stream + composer for the active session.
 * Right side hosts the RightDock: a codex-style tabbed panel where
 * 文件/变更/Agents、多个终端、多个 sidechat 分支与 plan 预览并列成
 * tab。The icon rail is persistent; its top button folds/expands the
 * dock (item 3/4/8).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  FileDiff,
  FolderTree,
  MessagesSquare,
  PanelRightClose,
  PanelRightOpen,
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
import TurnRail from './TurnRail';
import { BrandHero, BrandSpinner } from './brand';

export default function ChatView({ sessionId }: { sessionId: string }): JSX.Element {
  const t = useT();
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const creating = useChatStore((s) => s.creating);
  const sidechatIds = useChatStore((s) => s.sidechats[sessionId]) ?? [];
  const terms = useChatStore((s) => s.terminals[sessionId]) ?? [];
  const planPreviewId = useChatStore((s) => s.planPreview[sessionId]);
  const openSidechat = useChatStore((s) => s.openSidechat);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('files');
  const [sidechatOpening, setSidechatOpening] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const messages = ui?.messages ?? [];
  const isWork = meta?.chatMode === 'work';

  // Auto-follow the stream unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 折叠收起/展开是 200ms 高度动画（Collapsible），只在 messages 变化时
  // 贴底会在动画期间失去锚点导致跳变 — 用 ResizeObserver 追着内容高度
  // 逐帧贴底，收起/增高都平滑跟随。
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const planMsg = planPreviewId
    ? messages.find((m) => m.id === planPreviewId && m.kind === 'text')
    : undefined;
  const planText = planMsg && planMsg.kind === 'text' ? planMsg.text : undefined;

  // 当前会话可用的 tab 集合（顺序 = dock tab 栏顺序）。
  const allTabs = [
    ...(isWork ? ['files', 'changes', 'agents'] : []),
    ...terms.map((tm) => `${TERM_PREFIX}${tm.id}`),
    ...sidechatIds.map((id) => `${SIDE_PREFIX}${id}`),
    ...(sidechatOpening ? [SIDE_PENDING] : []), // fork 进行中的占位 tab
    ...(planText !== undefined ? ['plan'] : []),
  ];
  const tabsKey = allTabs.join('|');

  // Plan 模式产出计划后自动弹出 plan tab（item 8）。
  useEffect(() => {
    if (planPreviewId) {
      setActiveTab('plan');
      setPanelOpen(true);
    }
  }, [planPreviewId]);

  // 切会话 / 关 tab 后校验 activeTab 合法性：失效则回退首个 tab 或收起。
  useEffect(() => {
    if (!panelOpen || allTabs.includes(activeTab)) return;
    if (allTabs.length) setActiveTab(allTabs[0]!);
    else setPanelOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, activeTab, tabsKey]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const openTab = (tab: string): void => {
    setActiveTab(tab);
    setPanelOpen(true);
  };

  /** rail 图标点击：已激活再点则收起（保留旧交互习惯）。 */
  const toggleTab = (tab: string): void => {
    if (panelOpen && activeTab === tab) setPanelOpen(false);
    else openTab(tab);
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
      setActiveTab((cur) => (cur === SIDE_PENDING ? `${SIDE_PREFIX}${id}` : cur));
    } finally {
      setSidechatOpening(false);
    }
  };

  /** rail 终端钮：已在终端 tab → 收起；有终端 → 激活最近一个；
   *  没有 → 在默认目录（workspace 的 primary 根）新开。 */
  const onRailTerminal = (): void => {
    if (panelOpen && activeTab.startsWith(TERM_PREFIX)) {
      setPanelOpen(false);
      return;
    }
    if (terms.length) openTab(`${TERM_PREFIX}${terms[terms.length - 1]!.id}`);
    else if (meta) addTerminalTab(meta.cwd);
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
      if (remaining.length) setActiveTab(remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]!);
      else setPanelOpen(false);
    }
  };

  // 顶部按钮：折叠/展开右侧 dock（图标 rail 本身常驻不折叠）。
  const toggleRightPanel = async (): Promise<void> => {
    if (panelOpen) {
      // 折叠时若停在 plan tab，清掉预览标记，否则上面的 effect 会立刻重新弹出。
      if (activeTab === 'plan') useChatStore.getState().setPlanPreview(sessionId, undefined);
      setPanelOpen(false);
      return;
    }
    if (allTabs.length) {
      if (!allTabs.includes(activeTab)) setActiveTab(allTabs[0]!);
      setPanelOpen(true);
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
            onClick={() => toggleTab('files')}
          >
            <FolderTree size={16} />
          </RailButton>
          <RailButton
            title={t('railChanges')}
            active={panelOpen && activeTab === 'changes'}
            onClick={() => toggleTab('changes')}
          >
            <FileDiff size={16} />
          </RailButton>
          <RailButton
            title={t('railAgents')}
            active={panelOpen && activeTab === 'agents'}
            onClick={() => toggleTab('agents')}
          >
            <Bot size={16} />
          </RailButton>
          <div className="my-1 h-px w-5 bg-line" />
          <RailButton
            title={t('railTerminal')}
            active={panelOpen && activeTab.startsWith(TERM_PREFIX)}
            onClick={onRailTerminal}
          >
            <SquareTerminal size={16} />
          </RailButton>
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
    </>
  );

  return (
    <div className="relative flex h-full min-w-0">
      {/* 中间列保底宽度 — 防右侧 dock 把会话流/Composer 挤成条（溢出时由 dock 一侧收缩） */}
      <div className="flex h-full min-w-[340px] flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 px-5">
          <span className="min-w-0 truncate text-sm font-medium">{meta?.title ?? '会话'}</span>
          {isWork && meta && (
            <span className="truncate rounded-md bg-bg-panel px-2 py-[3px] font-mono text-[11px] leading-none text-ink-soft">{meta.cwd}</span>
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
                    <span className="text-[14px]">引擎后台启动中，可直接发送消息</span>
                  ) : (
                    <span className="text-[14px]">发送第一条消息开始对话</span>
                  )}
                </div>
              )}
              <MessageList sessionId={sessionId} messages={messages} />
            </div>
          </div>
          <TurnRail sessionId={sessionId} scrollRef={scrollRef} />
          {/* 当前提问滚出上缘后钉在顶部的提问胶囊（点击回跳） */}
          <QuestionPin sessionId={sessionId} scrollRef={scrollRef} />
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
            onSelectTab={setActiveTab}
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
  const race = useRaceStore((s) => s.races[raceId]);
  const openRace = useRaceStore((s) => s.openRace);
  const selectSession = useChatStore((s) => s.selectSession);
  if (!race) return null;
  return (
    <div className="mx-5 mb-1 flex shrink-0 items-center gap-2 rounded-lg border border-line bg-bg-panel/70 px-3 py-1.5 text-[12px] text-ink-soft">
      <span className="min-w-0 flex-1 truncate" title={race.prompt}>
        🏇 赛马「{race.prompt}」的角色会话
      </span>
      <button
        onClick={() => openRace(raceId)}
        className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
      >
        ↩ 返回赛马
      </button>
      {race.parentSessionId && (
        <button
          onClick={() => selectSession(race.parentSessionId!)}
          className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
        >
          返回发起对话
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
    <div className="flex items-center gap-1.5" title={`距上次引擎事件 ${idleSec}s`}>
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
      className="grid min-h-0 min-w-0"
      // minmax(0, …fr)：裸 1fr 的隐式最小宽度是内容宽（minmax(auto,1fr)），
      // 窄窗口下轨道拒绝收缩会把 dock 整体顶出屏外；锁死最小 0 才能
      // 落地「裁剪而非溢出」的设计（dock 贴右缘露出可用部分）
      style={{ gridTemplateColumns: expanded ? 'minmax(0, 1fr)' : 'minmax(0, 0fr)', transition: 'grid-template-columns 220ms ease-out' }}
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
