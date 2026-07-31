import { useEffect, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { useChatStore } from './store/chatStore';
import { useRaceStore } from './store/raceStore';
import type { ResolvedMode, ThemeMode } from '@shared/types';
import { raceHostArchived } from '@shared/race';
import { useT } from './i18n';
import Sidebar from './components/Sidebar';
import { BrandMark } from './components/brand';
import ChatView from './components/ChatView';
import NewSessionView from './components/NewSessionView';
import ErrorBoundary from './components/ErrorBoundary';
import SettingsView from './components/SettingsView';
import UsageView from './components/UsageView';
import ScheduledView from './components/ScheduledView';
import ArchivedView from './components/ArchivedView';
import AntigravityAccountDialog from './components/AntigravityAccountDialog';
import RaceView from './components/race/RaceView';
import RaceSetup from './components/race/RaceSetup';
import MissionControl from './components/mission/MissionControl';

/** system 模式按 OS 明暗实时解析（监听 prefers-color-scheme 变化）。 */
function useResolvedMode(mode: ThemeMode): ResolvedMode {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

/** 任务栏角标：待处理数（awaiting/error 会话 + 等决策赛马）画成红圈白字 overlay。 */
function useTaskbarBadge(): void {
  const sessions = useChatStore((s) => s.sessions);
  const races = useRaceStore((s) => s.races);
  useEffect(() => {
    // 宿主已归档的赛马不计入角标（与总控台/侧栏口径一致）。
    const archivedIds = new Set(sessions.filter((m) => m.archived).map((m) => m.id));
    const count =
      sessions.filter((m) => !m.archived && !m.raceId && (m.status === 'awaiting' || m.status === 'error')).length +
      Object.values(races).filter((g) => g.stage === 'judging' && !g.adopt && !raceHostArchived(g, archivedIds)).length;
    if (count === 0) {
      void window.cyberslots.badgeSet(null, '');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#e5484d';
    ctx.beginPath();
    ctx.arc(16, 16, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(count > 99 ? '99' : String(count), 16, 17);
    void window.cyberslots.badgeSet(canvas.toDataURL('image/png'), `${count} pending`);
  }, [sessions, races]);
}

export default function App(): JSX.Element {
  const t = useT();
  const init = useChatStore((s) => s.init);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const dashboardOpen = useChatStore((s) => s.dashboardOpen);
  const activeRaceId = useRaceStore((s) => s.activeRaceId);
  const themeMode = useChatStore((s) => s.settings?.themeMode);
  const mode = useResolvedMode(themeMode ?? 'light');
  const sidebarCollapsed = useChatStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>();

  useTaskbarBadge();

  useEffect(() => {
    void init();
  }, [init]);

  // 赛马切片独立初始化（订阅 race:event + 拉取持久化赛马列表）。
  useEffect(() => {
    void useRaceStore.getState().init();
  }, []);

  // 主题属性挂 <html>（而非根 div）：portal 到 body 的弹层（WorkspaceDialog 等）
  // 也能继承主题 CSS 变量；未加载完成前走 CSS :root 回退（浅色），不闪烁。
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  // 已解析外观推送主进程 → 原生标题栏/窗口底色同步（含 OS 明暗切换）；
  // 设置未加载完成前不推，避免默认值盖掉建窗时从配置文件读到的正确配色。
  useEffect(() => {
    if (!themeMode) return;
    void window.cyberslots.themeSync({ mode });
  }, [themeMode, mode]);

  // 折叠态：悬停左缘热区 → 浮出侧栏；移开延迟收起；常驻展开走标题栏固定按钮。
  const peekEnter = (): void => {
    clearTimeout(peekTimer.current);
    setPeek(true);
  };
  const peekLeave = (): void => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 250);
  };

  return (
    <div className="flex h-full flex-col bg-bg-canvas text-ink">
      {/* 40px 拖拽标题条 — 与侧栏同色融合（codex 桌面版风），无分隔线 */}
      <header className="drag flex h-10 shrink-0 items-center gap-2 px-3">
        {/* 品牌占标题栏最左（Windows 应用图标惯例位，品牌优先）；
            折叠按钮紧随其后 — 品牌宽度恒定，按钮在两种状态下位置依然不变，图标交叉旋转淡入淡出 */}
        <span className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-ink-soft">
          {/* ≥20px 才会画出窗内三星芒/出币槽细节 —— 品牌识别位用完整形态 */}
          <BrandMark size={26} className="text-accent" />
          {t('appName')}
        </span>
        <button
          title={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
          onClick={toggleSidebar}
          className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-bg-hover hover:text-ink"
        >
          <PanelLeftClose
            size={15}
            className={`absolute transition-all duration-200 ${sidebarCollapsed ? 'rotate-90 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100'
              }`}
          />
          <PanelLeftOpen
            size={15}
            className={`absolute transition-all duration-200 ${sidebarCollapsed ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-50 opacity-0'
              }`}
          />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* 侧栏滑入滑出：margin-left 0 ↔ -256px，主内容区平滑跟随。
            不用 overflow/transform 容器 — 它们会裁剪越界弹层（齿轮菜单子菜单）、
            劫持 fixed 定位（菜单点击关闭背景、工作区对话框）。 */}
        <div
          className={`flex h-full shrink-0 transition-[margin-left] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${sidebarCollapsed ? '-ml-64' : 'ml-0'
            }`}
        >
          <Sidebar />
        </div>

        {sidebarCollapsed && (
          <>
            {/* 折叠态：左缘隐形热区（悬停浮出侧栏预览；常驻展开用标题栏按钮） */}
            <div className="absolute bottom-0 left-0 top-0 z-20 w-2" onMouseEnter={peekEnter} onMouseLeave={peekLeave} />
            {/* 悬浮浮出的侧栏（overlay，不挤压内容区） */}
            <div
              onMouseEnter={peekEnter}
              onMouseLeave={peekLeave}
              className={`absolute bottom-0 left-0 top-0 z-30 shadow-2xl transition-[margin-left,opacity] duration-300 ease-out ${peek ? 'ml-0 opacity-100' : '-ml-64 opacity-0'
                }`}
            >
              <Sidebar overlay />
            </div>
          </>
        )}

        {/* 主内容「浮层」— 左上大圆角，靠色块与画布分层，不用分隔线。
            overflow-clip（非 hidden）：纯裁剪、禁止程序化滚动 —— 窄窗口下
            scrollIntoView/焦点追踪曾把本容器横向滚出错位死态（右侧 dock
            看得见但点击全部落空，实测踩坑） */}
        <main className="flex min-w-0 flex-1 flex-col overflow-clip rounded-tl-[20px] bg-bg shadow-sm">
          <ErrorBoundary>
            {activeRaceId ? (
              <RaceView raceId={activeRaceId} />
            ) : activeSessionId ? (
              <ChatView key={activeSessionId} sessionId={activeSessionId} />
            ) : dashboardOpen ? (
              <MissionControl />
            ) : (
              <NewSessionView />
            )}
          </ErrorBoundary>
        </main>
        <SettingsView />
        <UsageView />
      </div>

      <ScheduledView />
      <ArchivedView />
      <RaceSetup />
      <AntigravityAccountDialog />
    </div>
  );
}
