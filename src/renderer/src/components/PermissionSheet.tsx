/**
 * PermissionSheet — bottom sheet for pending authorization / ask-user
 * requests (slides up above the composer, codex style). The chat stream
 * keeps only a compact historical record; actions live here.
 */

import { KeyRound, MessageCircleQuestion } from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../store/chatStore';

type Decision = Extract<UnifiedMessage, { kind: 'permission' | 'ask_user' }>;

export default function PermissionSheet({ sessionId }: { sessionId: string }): JSX.Element | null {
  const pending = useChatStore((s) =>
    (s.ui[sessionId]?.messages ?? []).filter(
      (m): m is Decision => (m.kind === 'permission' || m.kind === 'ask_user') && m.answeredOptionId === undefined,
    ),
  );
  const answerPermission = useChatStore((s) => s.answerPermission);
  const current = pending[0];
  if (!current) return null;

  const isQuestion = current.kind === 'ask_user';

  return (
    <div className="shrink-0 px-6 pb-2">
      <div className="mx-auto max-w-3xl animate-[sheet-in_.18s_ease-out] rounded-2xl border border-line bg-bg-input shadow-lg">
        <div className="flex items-center gap-2.5 px-4 pb-1 pt-3">
          <span className={`flex h-7 w-7 items-center justify-center rounded-full ${isQuestion ? 'bg-accent-soft text-accent' : 'bg-warn/15 text-warn'}`}>
            {isQuestion ? <MessageCircleQuestion size={15} /> : <KeyRound size={15} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              {isQuestion ? '模型提问' : '请求授权'}
              {pending.length > 1 && <span className="ml-1.5 rounded bg-bg-active px-1.5 text-[10px]">{pending.length} 项等待</span>}
            </div>
            <div className="truncate text-sm font-medium">{isQuestion ? current.question : current.title}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 px-4 pb-3.5 pt-2">
          {current.options.map((o) => {
            const rejecting = o.kind.startsWith('reject');
            return (
              <button
                key={o.optionId}
                onClick={() => void answerPermission(current.requestId, o.optionId)}
                className={`rounded-lg border px-3.5 py-1.5 text-ui font-medium transition ${
                  rejecting
                    ? 'border-line text-ink-soft hover:border-err/60 hover:text-err'
                    : 'border-accent/50 bg-accent text-white hover:opacity-90'
                }`}
              >
                {o.name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
