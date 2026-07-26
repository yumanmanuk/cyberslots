/**
 * PlanWidget — “待办” docked row above the composer (Qoder-style):
 * a rounded bar slightly narrower than the input card, collapsed by
 * default showing the current step + progress; expands to the list.
 * Same row style as the send-queue and goal bars (visual family).
 */

import { useState } from 'react';
import { Check, ChevronRight, Loader2 } from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../store/chatStore';

type PlanMsg = Extract<UnifiedMessage, { kind: 'plan' }>;

export default function PlanWidget({ sessionId }: { sessionId: string }): JSX.Element | null {
  const plan = useChatStore((s) => {
    const msgs = s.ui[sessionId]?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.kind === 'plan') return m as PlanMsg;
    }
    return undefined;
  });
  const running = useChatStore((s) => {
    const meta = s.sessions.find((m) => m.id === sessionId);
    return meta?.status === 'running' || meta?.status === 'awaiting';
  });
  const [open, setOpen] = useState(false);

  if (!plan || plan.entries.length === 0) return null;
  const done = plan.entries.filter((e) => e.status === 'completed').length;
  // Hide once everything is finished and the turn is over.
  if (!running && done === plan.entries.length) return null;

  const current = plan.entries.find((e) => e.status === 'in_progress') ?? plan.entries.find((e) => e.status === 'pending');

  return (
    <div className="shrink-0 px-6 pb-1">
      <div className="mx-auto max-w-[720px] overflow-hidden rounded-xl bg-bg-panel/70">
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] transition hover:bg-bg-hover"
        >
          <ChevronRight size={12} className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="shrink-0 font-medium text-ink">待办</span>
          <span className="min-w-0 flex-1 truncate text-left text-ink-soft">{current?.content ?? ''}</span>
          <span className="shrink-0 tabular-nums text-ink-faint">
            {done}/{plan.entries.length}
          </span>
        </button>
        {open && (
          <ul className="max-h-44 space-y-1 overflow-y-auto px-3 pb-2 pt-0.5">
            {plan.entries.map((e, i) => (
              <li key={i} className="flex items-start gap-2 text-ui">
                <span className="mt-0.5 shrink-0">
                  {e.status === 'completed' ? (
                    <Check size={13} className="text-ok" />
                  ) : e.status === 'in_progress' ? (
                    <Loader2 size={13} className="animate-spin text-accent" />
                  ) : (
                    <span className="block h-3 w-3 rounded-full border border-ink-faint/50" />
                  )}
                </span>
                <span className={e.status === 'completed' ? 'text-ink-faint line-through' : e.status === 'in_progress' ? 'font-medium' : ''}>
                  {e.content}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
