/**
 * MessageItem — renders each UnifiedMessage kind in the conversation
 * stream, codex-desktop style: right-aligned gray user bubbles, clean
 * left-aligned AI markdown, compact tool rows, collapsible thinking,
 * and a per-answer stats footer (上行/缓存/下行/tts/用时).
 */

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  FileText,
  Lightbulb,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Search,
  Target,
  TerminalSquare,
  X,
} from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { downloadMarkdown, extractPlanTitle } from '../planDoc';
import { useT } from '../i18n';

export default function MessageItem({ msg, sessionId }: { msg: UnifiedMessage; sessionId: string }): JSX.Element | null {
  const t = useT();
  switch (msg.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%]">
            <div className="whitespace-pre-wrap rounded-2xl bg-bg-active px-4 py-2.5 text-body">
              {msg.text}
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="mt-1 text-[12px] text-ink-soft">📎 {msg.attachments.join(', ')}</div>
              )}
            </div>
            {msg.sentAsGoal && (
              <div className="mt-1 flex items-center justify-end gap-1 pr-1 text-[11px] text-ink-faint">
                <Target size={10} />
                {t('sentAsGoal')}
              </div>
            )}
          </div>
        </div>
      );

    case 'text':
      if (msg.planDoc) return <PlanDocCard msg={msg} sessionId={sessionId} />;
      return (
        <div className={`md-body max-w-none ${msg.streaming ? 'caret' : ''}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
      );

    case 'thinking':
      return <ThinkingBlock text={msg.text} streaming={msg.streaming} createdAt={msg.createdAt} durationMs={msg.durationMs} />;

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
      return <TurnStats msg={msg} sessionId={sessionId} />;

    case 'system':
      // 安静的左对齐小字提示行（goal 完成公告等），不加高亮框不居中。
      return <div className="whitespace-pre-wrap text-[11.5px] leading-5 text-ink-faint">{msg.text}</div>;

    default:
      return null;
  }
}

// ------------------------------------------------------------- sub-blocks

/** 回合结束统计行（取代分隔线）：↑上行（缓存比例） · ↓下行 · tts · 用时。
 *  复制按钮是纯图标，在统计行行首常驻显示。 */
function TurnStats({ msg, sessionId }: { msg: Extract<UnifiedMessage, { kind: 'turn_end' }>; sessionId: string }): JSX.Element | null {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const u = msg.usage;
  const parts: string[] = [];

  if (u?.inputTokens != null && u.inputTokens > 0) {
    const cachePct =
      u.cachedInputTokens != null && u.inputTokens > 0
        ? ` (${((u.cachedInputTokens / u.inputTokens) * 100).toFixed(1)}%)`
        : '';
    parts.push(`↑ ${fmtK(u.inputTokens)}${cachePct}`);
  } else if (u?.contextUsed != null && u.contextUsed > 0) {
    parts.push(`↑ ${fmtK(u.contextUsed)}`);
  }
  // 估算值（approx，kimi ACP 不推真实 usage）不展示 token 数——只留用时。
  if (!u?.approx) {
    if (u?.outputTokens != null && u.outputTokens > 0) parts.push(`↓ ${fmtK(u.outputTokens)}`);
    // t/s 按纯 API/模型时间算（不含工具执行与审批等待），拿不到才退回回合墙钟。
    const rateMs = msg.apiDurationMs ?? msg.durationMs;
    if (u?.outputTokens && rateMs && rateMs > 500) {
      parts.push(`${(u.outputTokens / (rateMs / 1000)).toFixed(1)} t/s`);
    }
  }
  if (msg.durationMs) parts.push(fmtDuration(msg.durationMs));
  if (msg.stopReason === 'cancelled') parts.unshift('已停止');
  if (parts.length === 0) return null;

  const copyAnswer = (): void => {
    const msgs = useChatStore.getState().ui[sessionId]?.messages ?? [];
    const text = msgs
      .filter((m) => m.kind === 'text' && m.turnId === msg.turnId)
      .map((m) => (m as Extract<UnifiedMessage, { kind: 'text' }>).text)
      .join('\n\n');
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="group/stats -my-1 flex items-center gap-1.5 font-mono text-[11px] leading-none tabular-nums text-ink-faint">
      {/* 复制本回合回答 — 行首常驻图标，与统计文字同一中线 */}
      <button
        onClick={copyAnswer}
        title={copied ? t('copied') : t('copyAnswer')}
        className="flex items-center rounded p-0.5 transition hover:bg-bg-hover hover:text-ink"
      >
        {copied ? <Check size={10} className="text-ok" /> : <Copy size={10} />}
      </button>
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-ink-faint/40">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

/** Plan 模式产出的计划文档 — codex 桌面版同款交互：卡片内直接渲染 md
 *  预览（限高+底部渐隐），点击卡片在右侧打开完整预览；预览中卡片收起
 *  成单行小条，点收缩图标关闭预览恢复卡片。 */
function PlanDocCard({ msg, sessionId }: { msg: Extract<UnifiedMessage, { kind: 'text' }>; sessionId: string }): JSX.Element {
  const t = useT();
  const setPlanPreview = useChatStore((s) => s.setPlanPreview);
  const previewing = useChatStore((s) => s.planPreview[sessionId] === msg.id);
  const setMode = useChatStore((s) => s.setMode);
  const [copied, setCopied] = useState(false);

  const title = extractPlanTitle(msg.text) ?? t('planCardTitle');

  const copy = (): void => {
    void navigator.clipboard.writeText(msg.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const implement = (): void => {
    void setMode('default');
    setTimeout(() => void useChatStore.getState().sendPromptTo(sessionId, t('planImplementPrompt')), 300);
  };

  const implementRow = !msg.streaming && (
    <div className="mt-2 flex justify-end">
      <button
        onClick={implement}
        className="rounded-lg bg-bg-active px-3.5 py-1.5 text-ui font-medium text-ink transition hover:bg-bg-hover"
      >
        {t('planImplement')}
      </button>
    </div>
  );

  // 预览中 → 收起成单行小条（图二），右侧收缩图标关闭预览。
  if (previewing && !msg.streaming) {
    return (
      <div>
        <div className="flex items-center gap-2.5 rounded-xl border border-line bg-bg-panel/60 px-3.5 py-2 shadow-sm">
          <Lightbulb size={14} className="shrink-0 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate text-ui text-ink-soft">Plan</span>
          <button
            title={t('planCollapse')}
            onClick={() => setPlanPreview(sessionId, undefined)}
            className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            <Minimize2 size={13} />
          </button>
        </div>
        {implementRow}
      </div>
    );
  }

  return (
    <div>
      <div
        onClick={() => !msg.streaming && setPlanPreview(sessionId, msg.id)}
        className={`overflow-hidden rounded-2xl border border-line bg-bg-panel/60 shadow-sm transition ${msg.streaming ? '' : 'cursor-pointer hover:shadow-md'
          }`}
      >
        {/* 头部：💡 Plan + 右上角操作图标 */}
        <div className="flex items-center gap-2 px-4 pt-3">
          {msg.streaming ? (
            <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
          ) : (
            <Lightbulb size={14} className="shrink-0 text-ink-faint" />
          )}
          <span className="min-w-0 flex-1 truncate text-ui text-ink-faint">
            {msg.streaming ? t('planCardStreaming') : 'Plan'}
          </span>
          {!msg.streaming && (
            <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              <button
                title={t('planDownload')}
                onClick={() => downloadMarkdown(title, msg.text)}
                className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
              >
                <Download size={13} />
              </button>
              <button
                title={copied ? t('copied') : t('planCopy')}
                onClick={copy}
                className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
              >
                {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
              </button>
              <button
                title={t('planOpen')}
                onClick={() => setPlanPreview(sessionId, msg.id)}
                className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
              >
                <Maximize2 size={13} />
              </button>
            </div>
          )}
        </div>
        {/* md 内容预览 — 限高截断 + 底部渐隐 */}
        <div className="relative max-h-64 overflow-hidden px-4 pb-3 pt-1">
          <div className={`md-body max-w-none ${msg.streaming ? 'caret' : ''}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-bg-panel to-transparent" />
        </div>
      </div>
      {implementRow}
    </div>
  );
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function ThinkingBlock({
  text,
  streaming,
  createdAt,
  durationMs,
}: {
  text: string;
  streaming: boolean;
  createdAt: number;
  durationMs?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // 流式中每秒走表；结束后用 store 定格的 durationMs（历史消息可能没有）。
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [streaming]);
  const elapsed = streaming ? nowTick - createdAt : durationMs;
  return (
    <div className="rounded-lg border border-line bg-bg-panel/60">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-ui text-ink-soft hover:text-ink"
      >
        {streaming ? <Loader2 size={13} className="animate-spin text-accent" /> : <Brain size={13} />}
        <span className="font-medium">{streaming ? '思考中…' : '思考过程'}</span>
        {elapsed != null && elapsed >= 1000 && (
          <span className="font-mono text-[11px] tabular-nums text-ink-faint">{fmtDuration(elapsed)}</span>
        )}
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
        <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] ${rejected ? 'bg-err/10 text-err' : 'bg-ok/10 text-ok'}`}>
          {chosen?.name ?? '已取消'}
        </span>
      ) : (
        <span className="shrink-0 rounded-md bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn">等待处理（见下方弹层）</span>
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
        {msg.status === 'in_progress' || msg.status === 'pending' ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
        ) : msg.status === 'failed' ? (
          <X size={12} className="shrink-0 text-err" />
        ) : msg.status === 'canceled' ? (
          <X size={12} className="shrink-0 text-ink-faint" />
        ) : (
          <Check size={12} className="shrink-0 text-ok" />
        )}
        <Icon size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left font-mono text-[12px]">{msg.title}</span>
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
        <pre className="whitespace-pre-wrap rounded-md bg-err/10 px-2 py-1 font-mono text-[12px] leading-5 text-err">
          {prefixLines(oldText, '- ')}
        </pre>
      )}
      {newText && (
        <pre className="mt-1 whitespace-pre-wrap rounded-md bg-ok/10 px-2 py-1 font-mono text-[12px] leading-5 text-ok">
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
