import { useEffect } from 'react';

import { useChatStore } from './store/chatStore';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import NewSessionView from './components/NewSessionView';
import ErrorBoundary from './components/ErrorBoundary';

export default function App(): JSX.Element {
  const init = useChatStore((s) => s.init);
  const activeSessionId = useChatStore((s) => s.activeSessionId);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div data-theme="notion" className="flex h-full bg-bg text-ink">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary>
          {activeSessionId ? <ChatView key={activeSessionId} sessionId={activeSessionId} /> : <NewSessionView />}
        </ErrorBoundary>
      </main>
    </div>
  );
}
