/**
 * PlanDocPanel — right-side markdown preview for plan-mode output
 * (item 8): full rendered plan with copy / download / implement.
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Download, NotebookText, Play, X } from 'lucide-react';

import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';
import { downloadMarkdown, extractPlanTitle } from '../planDoc';

export default function PlanDocPanel({
  sessionId,
  text,
  onClose,
}: {
  sessionId: string;
  text: string;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const setMode = useChatStore((s) => s.setMode);
  const [copied, setCopied] = useState(false);
  const title = extractPlanTitle(text) ?? t('planDocTitle');

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const implement = (): void => {
    onClose();
    void setMode('default');
    setTimeout(() => void useChatStore.getState().sendPromptTo(sessionId, t('planImplementPrompt')), 300);
  };

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-line bg-bg-panel/50">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-2.5">
        <NotebookText size={14} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium" title={title}>
          {title}
        </span>
        <button
          title={t('planCopy')}
          onClick={copy}
          className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
        >
          {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
        </button>
        <button
          title={t('planDownload')}
          onClick={() => downloadMarkdown(title, text)}
          className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
        >
          <Download size={13} />
        </button>
        <button onClick={onClose} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="md-body px-4 py-3 text-[13px]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      </div>

      <div className="shrink-0 p-2.5">
        <button
          onClick={implement}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-ui font-medium text-white transition hover:opacity-90"
        >
          <Play size={13} /> {t('planImplement')}
        </button>
      </div>
    </aside>
  );
}
