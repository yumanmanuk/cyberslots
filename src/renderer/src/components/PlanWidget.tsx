/**
 * PlanWidget — “待办”行条，内嵌输入框顶部（与 Goal / 等待发送行条一体）：
 * 默认收起仅显示进度，点击展开完整列表。
 */

import { useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import { BrandSpinner } from './brand';

type PlanMsg = Extract<UnifiedMessage, { kind: 'plan' }>;

export default function PlanWidget({ sessionId }: { sessionId: string }): JSX.Element | null {
  const t = useT();
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

  return (
    <div className="border-b border-line bg-bg-panel/70">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] transition hover:bg-bg-hover"
      >
        <ChevronRight size={12} className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="shrink-0 font-medium text-ink">{t('todoLabel')}</span>
        {/* 收起态不展示当前任务文本 — 只留进度，详情点开看。 */}
        <span className="flex-1" />
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
                  // 会话不在运行态（停止/暂停/重启恢复/error）时转轮定格淡化显示，避免一直滚动误导
                  running ? (
                    <BrandSpinner size={13} className="text-accent" />
                  ) : (
                    <BrandSpinner size={13} spinning={false} className="text-ink-faint" />
                  )
                ) : (
                  <span className="block h-3 w-3 rounded-full border border-ink-faint/50" />
                )}
              </span>
              <span className={e.status === 'completed' ? 'text-ink-faint' : e.status === 'in_progress' ? (running ? 'font-medium' : 'text-ink-soft') : ''}>
                {e.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
