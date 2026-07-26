/**
 * MessageItem — renders each UnifiedMessage kind in the conversation
 * stream, codex-desktop style: right-aligned gray user bubbles, clean
 * left-aligned AI markdown, compact tool rows, collapsible thinking.
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  Loader2,
  Pencil,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';

export default function MessageItem({ msg }: { msg: UnifiedMessage }): JSX.Element | null {
  switch (msg.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-bg-active px-4 py-2.5 text-body">
            {msg.text}
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="mt-1 text-[12px] text-ink-soft">📎 {msg.attachments.join(', ')}</div>
            )}
          </div>
        </div>
      );

    case 'text':
      return (
        <div className={`md-body max-w-none ${msg.streaming ? 'caret' : ''}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
      );

    case 'thinking':
      return <ThinkingBlock text={msg.text} streaming={msg.streaming} />;

    case 'tool_call':
      return <ToolCallRow msg={msg} />;

    case 'plan':
      // Rendered by the sticky PlanWidget above the composer, not inline.
      return null;

    case 'permission':
    case 'ask_user':
      return <DecisionRecord msg={msg} />;

    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-err/30 bg-err/5 px-4 py-2.5 text-ui text-err">
          <CircleAlert size={15} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap">{msg.message}</span>
        </div>
      );

    case 'turn_end':
      return (
        <div className="flex items-center gap-2 text-[11px] text-ink-faint">
          <span className="h-px flex-1 bg-line" />
          {msg.stopReason === 'cancelled' ? '已停止' : ''}
          <span className="h-px flex-1 bg-line" />
        </div>
      );

    default:
      return null;
  }
}

// ------------------------------------------------------------- sub-blocks

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-bg-panel/60">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-ui text-ink-soft hover:text-ink"
      >
        {streaming ? <Loader2 size={13} className="animate-spin text-accent" /> : <Brain size={13} />}
        <span className="font-medium">{streaming ? '思考中…' : '思考过程'}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="whitespace-pre-wrap border-t border-line px-3 py-2 text-[12.5px] leading-6 text-ink-soft">
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * Compact historical record of a permission / ask-user exchange.
 * Pending requests are actionable in the bottom PermissionSheet; here we
 * only show a subtle one-liner so the stream keeps its narrative.
 */
function DecisionRecord({ msg }: { msg: Extract<UnifiedMessage, { kind: 'permission' | 'ask_user' }> }): JSX.Element {
  const title = msg.kind === 'ask_user' ? msg.question : msg.title;
  const answered = msg.answeredOptionId !== undefined;
  const chosen = msg.options.find((o) => o.optionId === msg.answeredOptionId);
  const rejected = chosen ? chosen.kind.startsWith('reject') : msg.answeredOptionId === '__cancelled__';
  return (
    <div className="flex items-center gap-2 text-ui text-ink-faint">
      {answered ? (
        rejected ? <X size={13} className="shrink-0 text-err" /> : <Check size={13} className="shrink-0 text-ok" />
      ) : (
        <Loader2 size={13} className="shrink-0 animate-spin text-warn" />
      )}
      <span className="min-w-0 truncate">
        {msg.kind === 'ask_user' ? '提问' : '授权'}：{title}
      </span>
      {answered ? (
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${rejected ? 'bg-err/10 text-err' : 'bg-ok/10 text-ok'}`}>
          {chosen?.name ?? '已取消'}
        </span>
      ) : (
        <span className="shrink-0 rounded bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">等待处理（见下方弹层）</span>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<string, typeof FileText> = {
  read: FileText,
  edit: Pencil,
  search: Search,
  execute: TerminalSquare,
  think: Brain,
};

function ToolCallRow({ msg }: { msg: Extract<UnifiedMessage, { kind: 'tool_call' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[msg.toolKind] ?? TerminalSquare;
  const hasDetail = !!(msg.content?.text || msg.content?.diff);
  return (
    <div className="rounded-lg border border-line">
      <button
        onClick={() => hasDetail && setOpen(!open)}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-ui text-ink-soft ${hasDetail ? 'hover:bg-bg-hover' : 'cursor-default'}`}
      >
        <Icon size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left font-mono text-[12px]">{msg.title}</span>
        {msg.status === 'in_progress' || msg.status === 'pending' ? (
          <Loader2 size={12} className="animate-spin text-accent" />
        ) : msg.status === 'failed' ? (
          <X size={12} className="text-err" />
        ) : (
          <Check size={12} className="text-ok" />
        )}
        {hasDetail && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      {open && hasDetail && (
        <div className="max-h-72 overflow-auto border-t border-line bg-bg-panel px-3 py-2">
          {msg.content?.diff && (
            <DiffView oldText={msg.content.diff.oldText} newText={msg.content.diff.newText} path={msg.content.diff.path} />
          )}
          {msg.content?.text && (
            <pre className="whitespace-pre-wrap font-mono text-[12px] leading-5 text-ink-soft">{msg.content.text}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function DiffView({ path, oldText, newText }: { path: string; oldText?: string; newText?: string }): JSX.Element {
  return (
    <div className="mb-2">
      <div className="mb-1 font-mono text-[11px] text-ink-faint">{path}</div>
      {oldText && (
        <pre className="whitespace-pre-wrap rounded bg-err/10 px-2 py-1 font-mono text-[12px] leading-5 text-err">
          {prefixLines(oldText, '- ')}
        </pre>
      )}
      {newText && (
        <pre className="mt-1 whitespace-pre-wrap rounded bg-ok/10 px-2 py-1 font-mono text-[12px] leading-5 text-ok">
          {prefixLines(newText, '+ ')}
        </pre>
      )}
    </div>
  );
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}
