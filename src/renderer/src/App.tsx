import { useEffect, useRef, useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';

import { useChatStore } from './store/chatStore';
import { useT } from './i18n';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import NewSessionView from './components/NewSessionView';
import ErrorBoundary from './components/ErrorBoundary';
import SettingsView from './components/SettingsView';
import ScheduledView from './components/ScheduledView';

export default function App(): JSX.Element {
  const t = useT();
  const init = useChatStore((s) => s.init);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const theme = useChatStore((s) => s.settings?.theme ?? 'notion');
  const sidebarCollapsed = useChatStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    void init();
  }, [init]);

  // 折叠态：悬停展开图标 → 浮出侧栏；移开延迟收起；点击图标 → 常驻展开。
  const peekEnter = (): void => {
    clearTimeout(peekTimer.current);
    setPeek(true);
  };
  const peekLeave = (): void => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 250);
  };

  return (
    <div data-theme={theme} className="flex h-full flex-col bg-bg-canvas text-ink">
      {/* 40px 拖拽标题条 — 与侧栏同色融合（codex 桌面版风），无分隔线 */}
      <header className="drag flex h-10 shrink-0 items-center px-4">
        <span className="text-[12px] font-semibold tracking-wide text-ink-soft">{t('appName')}</span>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {!sidebarCollapsed && <Sidebar />}

        {sidebarCollapsed && (
          <>
            {/* 折叠态：左缘悬浮把手（悬停浮出侧栏，点击常驻展开） */}
            <div className="absolute left-0 top-3 z-40" onMouseEnter={peekEnter} onMouseLeave={peekLeave}>
              <button
                title={t('expandSidebar')}
                onClick={() => {
                  setPeek(false);
                  toggleSidebar();
                }}
                className="flex h-8 w-6 items-center justify-center rounded-r-lg bg-bg-canvas text-ink-faint shadow-sm transition hover:text-ink"
              >
                <PanelLeftOpen size={14} />
              </button>
            </div>
            {/* 悬浮浮出的侧栏（overlay，不挤压内容区） */}
            <div
              onMouseEnter={peekEnter}
              onMouseLeave={peekLeave}
              className={`absolute bottom-0 left-0 top-0 z-30 shadow-2xl transition-transform duration-200 ease-out ${
                peek ? 'translate-x-0' : '-translate-x-full'
              }`}
            >
              <Sidebar overlay />
            </div>
          </>
        )}

        {/* 主内容「浮层」— 左上大圆角，靠色块与画布分层，不用分隔线 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[20px] bg-bg shadow-sm">
          <ErrorBoundary>
            {activeSessionId ? <ChatView key={activeSessionId} sessionId={activeSessionId} /> : <NewSessionView />}
          </ErrorBoundary>
        </main>
        <SettingsView />
      </div>

      <ScheduledView />
    </div>
  );
}
