import { useEffect } from 'react';

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

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div data-theme={theme} className="flex h-full flex-col bg-bg text-ink">
      {/* 40px 拖拽标题条 — 与原生 titleBarOverlay 等高，随主题换色 */}
      <header className="drag flex h-10 shrink-0 items-center border-b border-line bg-bg-panel px-4">
        <span className="text-[12px] font-semibold tracking-wide text-ink-soft">{t('appName')}</span>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
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
