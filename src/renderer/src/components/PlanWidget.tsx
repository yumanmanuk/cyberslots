/**
 * PlanWidget — sticky "待办" checklist above the composer (referencing the
 * Qoder todo panel, restyled to the codex/Notion identity). Shows the
 * latest plan of the conversation with progress; collapsible.
 */

import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, ListChecks, Loader2 } from 'lucide-react';

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
  const [open, setOpen] = useState(true);

  if (!plan || plan.entries.length === 0) return null;
  const done = plan.entries.filter((e) => e.status === 'completed').length;
  // Hide once everything is finished and the turn is over.
  if (!running && done === plan.entries.length) return null;

  return (
    <div className="shrink-0 px-6 pb-2">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-line bg-bg-panel/80 backdrop-blur">
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 px-3.5 py-2 text-ui text-ink-soft hover:text-ink"
        >
          <ListChecks size={14} className="text-accent" />
          <span className="font-medium">待办</span>
          <span className="tabular-nums text-ink-faint">
            {done}/{plan.entries.length}
          </span>
          <span className="mx-1 h-1 flex-1 overflow-hidden rounded-full bg-bg-active">
            <span className="block h-full rounded-full bg-ok transition-all" style={{ width: `${(done / plan.entries.length) * 100}%` }} />
          </span>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        {open && (
          <ul className="max-h-44 space-y-1 overflow-y-auto border-t border-line px-3.5 py-2">
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
