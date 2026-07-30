/**
 * MessageItem — renders each UnifiedMessage kind in the conversation
 * stream, codex-desktop style: right-aligned gray user bubbles, clean
 * left-aligned AI markdown, compact tool rows, collapsible thinking,
 * and a per-answer stats footer (上行/缓存/下行/tts/用时).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  Atom,
  Braces,
  Code,
  FileCode2,
  FileText,
  Palette,
  Settings2,
  Image as ImageFileIcon,
  Copy,
  Download,
  Lightbulb,
  ListTodo,
  Maximize2,
  MessageCircleQuestion,
  Minimize2,
  RotateCcw,
  Target,
  TerminalSquare,
  X,
} from 'lucide-react';

import type { PlanEntry, UnifiedMessage } from '@shared/types';
import type { SessionChangeEntry } from '@shared/ipc';
import { useChatStore } from '../store/chatStore';
import SelectionChip from './SelectionChip';
import { useRaceStore } from '../store/raceStore';
import { downloadMarkdown, extractPlanTitle } from '../planDoc';
import { useT } from '../i18n';
import UndoConfirmDialog from './UndoConfirmDialog';
import { BrandSpinner } from './brand';

export default function MessageItem({ msg, sessionId }: { msg: UnifiedMessage; sessionId: string }): JSX.Element | null {
  switch (msg.kind) {
    case 'user':
      return <UserBubble msg={msg} sessionId={sessionId} />;

    case 'text':
      if (msg.planDoc) return <PlanDocCard msg={msg} sessionId={sessionId} />;
      return (
        <div className="md-body max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
      );

    case 'thinking':
      return <ThinkingBlock text={msg.text} streaming={msg.streaming} createdAt={msg.createdAt} durationMs={msg.durationMs} />;

    case 'tool_call':
      return <ToolCallItem msg={msg} />;

    case 'plan':
      // 内联 To-dos 卡片（同一条消息随 plan.update 就地刷新状态）；
      // Composer 上方的 PlanWidget 仍作为常驻进度条。
      return <TodoCard entries={msg.entries} />;

    case 'permission':
      return <DecisionRecord msg={msg} />;

    case 'ask_user':
      return <QuestionRecord msg={msg} />;

    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-err/30 bg-err/5 px-4 py-2.5 text-ui text-err">
          <CircleAlert size={15} className="mt-0.5 shrink-0" />
          {/* 长 JSON/URL 无空格串强制任意点断行，否则撑破卡片边框 */}
          <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{msg.message}</span>
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

/** 用户提问气泡 + hover 回退入口（Claude Code 的 Undo changes up to
 *  this point 同款）：确认弹窗列出将被一并撤销的文件变更；确认后
 *  还原文件、截断消息，并把提问回填输入框。另附 hover 复制提问按钮。 */
function UserBubble({ msg, sessionId }: { msg: Extract<UnifiedMessage, { kind: 'user' }>; sessionId: string }): JSX.Element {
  const t = useT();
  const status = useChatStore((s) => s.sessions.find((m) => m.id === sessionId)?.status);
  const sending = useChatStore((s) => !!s.sending[sessionId]);
  const [undoOpen, setUndoOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // undefined = 预览加载中；null = 无快照；[] = 无文件变更。
  const [preview, setPreview] = useState<SessionChangeEntry[] | null | undefined>(undefined);
  // 赛马角色会话：提问由编排器发出，回退会截断角色历史/还原文件，
  // 直接打断赛马状态机 —— 不提供「回退到此处」（泳道与主视图打开都隐藏）。
  const isRaceRole = useRaceStore((s) =>
    Object.values(s.races).some((g) => Object.values(g.sessions).includes(sessionId)),
  );
  const busy = status === 'running' || status === 'awaiting' || sending;
  // steer（回合中插入）与 Goal 提交没有独立快照/回合边界，不提供回退。
  const canUndo = !busy && !msg.steer && !msg.sentAsGoal && !isRaceRole;

  const openUndo = (): void => {
    setPreview(undefined);
    setUndoOpen(true);
    void window.cyberslots.sessionUndoPreview(sessionId, msg.id).then(setPreview).catch(() => setPreview(null));
  };

  const copyQuestion = (): void => {
    if (!msg.text) return;
    void navigator.clipboard.writeText(msg.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="group/user flex items-start justify-end gap-2">
      {/* 复制提问 + 回退入口悬浮在气泡左侧（截图同款位置），纵向堆叠：复制在上、回退在下。 */}
      <div className="mt-1.5 flex shrink-0 flex-col items-start gap-0.5">
        <button
          onClick={copyQuestion}
          title={copied ? t('copied') : t('copyQuestion')}
          className="flex items-center rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-bg-hover hover:text-ink group-hover/user:opacity-100"
        >
          {copied ? <Check size={11} className="text-ok" /> : <Copy size={11} />}
        </button>
        {canUndo && (
          <button
            onClick={openUndo}
            title={t('undoToHere')}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint opacity-0 transition hover:bg-bg-hover hover:text-ink group-hover/user:opacity-100"
          >
            <RotateCcw size={10} />
            {t('undoToHere')}
          </button>
        )}
      </div>
      <div className="max-w-[80%]">
        <div className="whitespace-pre-wrap rounded-2xl bg-bg-active px-4 py-2.5 text-body">
          {msg.selections && msg.selections.length > 0 && (
            <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
              {msg.selections.map((s) => (
                <SelectionChip key={s.id} sel={s} />
              ))}
            </div>
          )}
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
      {undoOpen && (
        <UndoConfirmDialog
          preview={preview}
          onConfirm={() => useChatStore.getState().undoToMessage(sessionId, msg.id)}
          onClose={() => setUndoOpen(false)}
        />
      )}
    </div>
  );
}

/** 回合结束统计行（取代分隔线）：↑上行（缓存比例） · ↓下行 · tts · 用时。
 *  复制按钮是纯图标，在统计行行首常驻显示。
 *  kimi 引擎不展示任何 token 数（无可靠的真实 usage 上报），只留用时。 */
function TurnStats({ msg, sessionId }: { msg: Extract<UnifiedMessage, { kind: 'turn_end' }>; sessionId: string }): JSX.Element | null {
  const t = useT();
  const engine = useChatStore((s) => s.sessions.find((m) => m.id === sessionId)?.engine);
  const [copied, setCopied] = useState(false);
  const u = msg.usage;
  const parts: string[] = [];
  const showTokens = engine !== 'kimi';

  if (showTokens && u?.inputTokens != null && u.inputTokens > 0) {
    const cachePct =
      u.cachedInputTokens != null && u.inputTokens > 0
        ? ` (${((u.cachedInputTokens / u.inputTokens) * 100).toFixed(1)}%)`
        : '';
    parts.push(`↑ ${fmtK(u.inputTokens)}${cachePct}`);
  } else if (showTokens && u?.contextUsed != null && u.contextUsed > 0) {
    parts.push(`↑ ${fmtK(u.contextUsed)}`);
  }
  // 估算值（approx，kimi ACP 不推真实 usage）不展示 token 数——只留用时。
  if (showTokens && !u?.approx) {
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
  // 赛马角色会话：实施走赛马自己的「定稿→Builder」链路，隐藏旁路
  // 「按此计划实施」按钮；赛马视图无右侧预览面板，点卡改开弹窗预览。
  const isRaceRole = useRaceStore((s) =>
    Object.values(s.races).some((g) => Object.values(g.sessions).includes(sessionId)),
  );
  const [modalOpen, setModalOpen] = useState(false);
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

  const implementRow = !msg.streaming && !isRaceRole && (
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
  // 赛马角色会话无右侧预览面板，不走收条态 —— 始终限高展开，预览用弹窗。
  if (previewing && !msg.streaming && !isRaceRole) {
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
        onClick={() => !msg.streaming && (isRaceRole ? setModalOpen(true) : setPlanPreview(sessionId, msg.id))}
        className={`overflow-hidden rounded-2xl border border-line bg-bg-panel/60 shadow-sm transition ${msg.streaming ? '' : 'cursor-pointer hover:shadow-md'
          }`}
      >
        {/* 头部：💡 Plan + 右上角操作图标 */}
        <div className="flex items-center gap-2 px-4 pt-3">
          {msg.streaming ? (
            <BrandSpinner size={14} className="shrink-0 text-accent" />
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
                onClick={() => (isRaceRole ? setModalOpen(true) : setPlanPreview(sessionId, msg.id))}
                className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
              >
                <Maximize2 size={13} />
              </button>
            </div>
          )}
        </div>
        {/* md 内容预览 — 限高截断 + 底部渐隐 */}
        <div className="relative max-h-64 overflow-hidden px-4 pb-3 pt-1">
          <div className="md-body max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-bg-panel to-transparent" />
        </div>
      </div>
      {implementRow}

      {/* 赛马角色会话的弹窗预览（无右侧面板可用）：完整 md + 下载 */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setModalOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex h-[82vh] w-[780px] flex-col rounded-2xl border border-line bg-bg p-5 shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                <Lightbulb size={15} className="shrink-0 text-ink-faint" />
                <span className="truncate">{title}</span>
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  title={t('planDownload')}
                  onClick={() => downloadMarkdown(title, msg.text)}
                  className="rounded-md p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
                >
                  <Download size={14} />
                </button>
                <button
                  onClick={() => setModalOpen(false)}
                  className="rounded-md p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="md-body max-w-none pr-1 text-[13px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
              </div>
            </div>
          </div>
        </div>
      )}
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

/** 可折叠容器 — 高度用 grid-rows 0fr↔1fr 过渡（无需测量内容高度），
 *  避免完成态自动收起时整块内容一帧内消失导致页面跳变；配合滚动区
 *  的 ResizeObserver 贴底，收起表现为平滑合拢。关闭动画跑完后再卸载
 *  children，长会话不积压隐藏 DOM。 */
export function Collapsible({ open, children }: { open: boolean; children: ReactNode }): JSX.Element | null {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const id = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(id);
  }, [open]);
  if (!open && !mounted) return null;
  return (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: open && mounted ? '1fr' : '0fr' }}
    >
      <div className="min-h-0 overflow-hidden">{mounted ? children : null}</div>
    </div>
  );
}

/** 思考块 — 无边框。流式中：图标 + "Thinking" 流光，正文默认展开限高
 *  8 行自动滚底；结束后自动折叠成 "Thought for Ns"，点击展开全文。
 *  也作为 Explore 组内的 Thought 明细行复用（MessageList）。 */
export function ThinkingBlock({
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
  // 用户点击覆盖默认态；流式结束时复位 null → 自动折叠。
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (!streaming) setUserOpen(null);
  }, [streaming]);
  const open = userOpen ?? streaming;

  // 流式中新增内容自动滚到底部（overflow-hidden 仍可编程滚动）。
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (streaming && open && el) el.scrollTop = el.scrollHeight;
  }, [text, streaming, open]);

  // 流式中每秒走表；结束后用 store 定格的 durationMs（历史消息可能没有）。
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [streaming]);
  const elapsed = streaming ? nowTick - createdAt : durationMs;

  return (
    <div>
      <button onClick={() => setUserOpen(!open)} className="group flex items-center gap-1.5 text-ui">
        <Brain size={13} className={`shrink-0 ${streaming ? 'text-accent' : 'text-ink-faint group-hover:text-ink-soft'}`} />
        {streaming ? (
          <span className="shimmer-text font-medium">Thinking</span>
        ) : (
          <span className="text-ink-faint transition group-hover:text-ink-soft">
            Thought{elapsed != null && elapsed > 0 ? ` for ${fmtDuration(elapsed)}` : ''}
          </span>
        )}
        {!streaming &&
          (open ? (
            <ChevronDown size={12} className="shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-ink-faint opacity-0 transition group-hover:opacity-100" />
          ))}
      </button>
      <Collapsible open={open && !!text}>
        <div
          ref={bodyRef}
          className={`ml-[5px] mt-1.5 whitespace-pre-wrap border-l-2 border-line pl-3.5 text-[12.5px] leading-6 text-ink-faint [overflow-wrap:anywhere] ${streaming
            ? 'max-h-[192px] overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_22px)]'
            : 'max-h-72 overflow-y-auto'
            }`}
        >
          {text}
        </div>
      </Collapsible>
    </div>
  );
}

/**
 * 授权交换的进行态提示。用户明确：授权结果不需展示 —— 已作答
 * 不留痕（已在 buildStream 过滤，这里再兵底一道）。仅在等待中给一行
 * 知情提示（品牌 spinner + 流光），真正的作答入口在底部 PermissionSheet。
 */
function DecisionRecord({ msg }: { msg: Extract<UnifiedMessage, { kind: 'permission' }> }): JSX.Element | null {
  if (msg.answeredOptionId !== undefined) return null;
  return (
    <div className="flex items-center gap-2 text-ui" style={{ minHeight: 20 }}>
      <BrandSpinner size={12} className="shrink-0 text-warn" />
      <span className="shimmer-text shrink-0 text-[12px] font-medium">Waiting for approval</span>
      <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-faint">{msg.title}</span>
    </div>
  );
}

/**
 * ask_user 的流内记录卡（对照 ChatGPT "Questions Answers"）：保留加粗
 * 问题上下文，下方一行回答 — 选项作答显✓+选项名，自定义回答以
 * Other: 原文留档，跳过/取消显灰色小字；作答入口仍在底部 Sheet。
 */
function QuestionRecord({ msg }: { msg: Extract<UnifiedMessage, { kind: 'ask_user' }> }): JSX.Element {
  const answered = msg.answeredOptionId !== undefined;
  const chosen = msg.options.find((o) => o.optionId === msg.answeredOptionId);
  const skipped = !msg.answeredNote && (chosen ? chosen.kind.startsWith('reject') : msg.answeredOptionId === '__cancelled__');
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-bg-panel/60 px-3 py-2 text-ui">
        <MessageCircleQuestion size={13} className="shrink-0 text-ink-faint" />
        <span className="font-medium text-ink-soft">模型提问</span>
        <span className="ml-auto shrink-0">
          {!answered ? (
            <BrandSpinner size={13} className="text-warn" />
          ) : skipped ? (
            <X size={13} className="text-ink-faint" />
          ) : (
            <Check size={13} className="text-ok" />
          )}
        </span>
      </div>
      <div className="space-y-1.5 px-3 py-2.5">
        <div className="text-ui font-semibold leading-snug">{msg.question}</div>
        {!answered ? (
          <div className="shimmer-text text-ui">等待作答…</div>
        ) : msg.answeredNote ? (
          <div className="text-ui leading-snug text-ink-soft [overflow-wrap:anywhere]">
            <span className="text-ink-faint">Other: </span>
            {msg.answeredNote}
          </div>
        ) : skipped ? (
          <div className="text-ui text-ink-faint">已跳过</div>
        ) : (
          <div className="flex items-start gap-1.5 text-ui leading-snug text-ink-soft">
            <Check size={13} className="mt-[2.5px] shrink-0 text-ok" />
            <span className="min-w-0">{chosen?.name}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ tool calls

/** 内联 To-dos 卡片（qoder 风格）：头部 To-dos + 完成进度，条目行状态
 *  图标随 plan.update 就地刷新（待办圆圈 / 进行中旋转 / 完成划掉）。 */
function TodoCard({ entries }: { entries: PlanEntry[] }): JSX.Element | null {
  if (entries.length === 0) return null;
  const done = entries.filter((e) => e.status === 'completed').length;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-bg-panel/60 px-3 py-2 text-ui">
        <ListTodo size={13} className="shrink-0 text-ink-faint" />
        <span className="font-medium text-ink-soft">To-dos</span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-ink-faint">
          {done}/{entries.length} done
        </span>
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        {entries.map((e, i) => (
          <div key={i} className="flex items-start gap-2 text-ui">
            {e.status === 'completed' ? (
              <CircleCheck size={13} className="mt-[3px] shrink-0 text-ink-faint" />
            ) : e.status === 'in_progress' ? (
              <BrandSpinner size={13} className="mt-[3px] shrink-0 text-accent" />
            ) : (
              <Circle size={11} className="mt-1 shrink-0 text-ink-faint" />
            )}
            <span className="text-ink-soft">{e.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 工具调用分派：编辑 → 矩形卡片；shell → 命令条；task 子代理 → 进度卡；
 *  其余（explore/todo/mcp）→ 无框明细行。explore 类在 MessageList 层已聚合成组。 */
export function ToolCallItem({ msg }: { msg: Extract<UnifiedMessage, { kind: 'tool_call' }> }): JSX.Element {
  if (isTaskTool(msg)) return <TaskCard msg={msg} />;
  if (msg.toolKind === 'edit') return <EditCard msg={msg} />;
  if (msg.toolKind === 'execute') return <ShellCard msg={msg} />;
  return <ToolLine msg={msg} />;
}

/** omp 子代理（task）工具判定：原始工具名为 task，或卡内携带进度流。 */
function isTaskTool(msg: Extract<UnifiedMessage, { kind: 'tool_call' }>): boolean {
  return (msg.toolName ?? '').toLowerCase() === 'task' || !!msg.content?.progress;
}

/** 原始工具名 → 英文过去式动词（qoder/claude code 风格明细行）。 */
const TOOL_VERBS: Array<[RegExp, string]> = [
  [/grep/, 'Grepped'],
  [/glob/, 'Globbed'],
  [/read/, 'Read'],
  [/list|^ls$/, 'Listed'],
  [/web_search/, 'Searched web'],
  [/search/, 'Searched'],
  [/fetch/, 'Fetched'],
  [/todo|plan/, 'Planned'],
  [/task|agent/, 'Delegated'],
  // omp 扩展工具面（lsp/debug/browser/eval/hub/ast）。
  [/^lsp$/, 'Inspected'],
  [/debug/, 'Debugged'],
  [/browser/, 'Browsed'],
  [/eval|python|notebook/, 'Evaluated'],
  [/^hub$/, 'Coordinated'],
  [/ast_grep/, 'Matched'],
  [/inspect_image|vision/, 'Inspected'],
  [/generate_image/, 'Generated'],
];

export function toolLabel(msg: Extract<UnifiedMessage, { kind: 'tool_call' }>): { verb: string; object?: string } {
  const name = (msg.toolName ?? '').toLowerCase();
  const object = msg.toolKind === 'read' ? (msg.locations?.[0] ?? msg.title).split(/[\\/]/).pop() : msg.title;
  for (const [re, verb] of TOOL_VERBS) if (name && re.test(name)) return { verb, object };
  switch (msg.toolKind) {
    case 'read':
      return { verb: 'Read', object };
    case 'search':
      return { verb: 'Searched', object };
    case 'fetch':
      return { verb: 'Fetched', object };
    default:
      // 未知工具（mcp/压缩提示等）：标题即动词位，不重复对象。
      return { verb: msg.title };
  }
}

/** 无框工具明细行（20px 紧凑态）：左侧 3px 状态刻度 + 动词 + 对象 +
 *  命中数；进行中用 BrandSpinner + 动词流光（单独渲染时无组级 spinner，
 *  这里自带），点击展开输出。既是摘要展开区的明细，也是 mcp/其它工具的兑底行。 */
export function ToolLine({ msg }: { msg: Extract<UnifiedMessage, { kind: 'tool_call' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const active = msg.status === 'in_progress' || msg.status === 'pending';
  const failed = msg.status === 'failed';
  const { verb, object } = toolLabel(msg);
  const detail = msg.content?.text;
  const matches = msg.content?.matches;
  return (
    <div className="text-ui">
      <button
        onClick={() => detail && setOpen(!open)}
        className={`group flex w-full items-center gap-2 text-left ${detail ? '' : 'cursor-default'}`}
        style={{ minHeight: 20 }}
      >
        {active ? (
          <BrandSpinner size={12} className="shrink-0 text-accent" />
        ) : (
          <span className={`h-[11px] w-[3px] shrink-0 rounded-full ${failed ? 'bg-err' : 'bg-ink-faint/50'}`} />
        )}
        <span className={`shrink-0 text-[12px] ${active ? 'shimmer-text font-medium' : failed ? 'text-err' : 'text-ink-soft'}`}>
          {verb}
        </span>
        {object && object !== verb && (
          <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-faint">{object}</span>
        )}
        {matches != null && !active && (
          <span className="shrink-0 text-[10.5px] tabular-nums text-ink-faint/80">{matches}</span>
        )}
        {failed && <span className="shrink-0 text-[10.5px] text-err">failed</span>}
        {msg.status === 'canceled' && <span className="shrink-0 text-[10.5px] text-ink-faint">canceled</span>}
        {detail &&
          (open ? (
            <ChevronDown size={12} className="shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-ink-faint opacity-0 transition group-hover:opacity-100" />
          ))}
      </button>
      <Collapsible open={open && !!detail}>
        <pre className="ml-[3px] mt-1 max-h-56 overflow-auto whitespace-pre-wrap border-l-2 border-line pl-3 font-mono text-[11.5px] leading-5 text-ink-faint">
          {detail}
        </pre>
      </Collapsible>
      <ToolImages images={msg.content?.images} />
    </div>
  );
}

/** 子代理（task）进度卡 — omp 子代理在卡内滚动进度流（不展开为独立
 *  消息）：运行中显最新进度行，展开看尾部输出；完成后显示 yield 摘要。
 *  卡头常驻「子代理不受审批约束」提示 — omp 对 headless 子代理强制
 *  yolo（probe-omp-findings §7），用户开着审批也拦不住它们。 */
function TaskCard({ msg }: { msg: Extract<UnifiedMessage, { kind: 'tool_call' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const active = msg.status === 'in_progress' || msg.status === 'pending';
  const c = msg.content;
  const tail = c?.progress?.tail;
  const summary = c?.text;
  const hasDetail = !!(tail?.length || summary);
  return (
    <div className={`overflow-hidden rounded-lg border transition ${active ? 'border-accent/35' : 'border-line'}`}>
      <button
        onClick={() => hasDetail && setOpen(!open)}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left ${active ? 'card-sweep' : ''} ${hasDetail ? 'hover:bg-bg-hover' : 'cursor-default'
          }`}
      >
        <Bot size={13} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate text-ui text-ink">{msg.title || '子代理任务'}</span>
        <span className="shrink-0 rounded-md bg-warn/10 px-1.5 py-0.5 text-[10.5px] text-warn" title="omp 对无界面的子代理强制自动批准，主会话的权限审批不约束它们（plan 只读模式除外）">
          子代理免审批
        </span>
        {active ? (
          <span className="shimmer-text shrink-0 text-[11.5px] font-medium">Delegating…</span>
        ) : msg.status === 'failed' ? (
          <span className="shrink-0 text-[11.5px] font-medium text-err">Failed</span>
        ) : msg.status === 'canceled' ? (
          <span className="shrink-0 text-[11.5px] text-ink-faint">Canceled</span>
        ) : (
          <span className="shrink-0 text-[11.5px] text-ink-faint">Done</span>
        )}
        {hasDetail &&
          (open ? (
            <ChevronDown size={12} className="shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-ink-faint" />
          ))}
      </button>
      {/* 运行中：卡内最新进度行（150ms 合并的进度流，就地刷新不叠消息）。 */}
      {active && c?.progress?.line && (
        <div className="truncate border-t border-line bg-bg-panel/40 px-3 py-1.5 font-mono text-[11.5px] text-ink-faint">
          {c.progress.line}
        </div>
      )}
      <Collapsible open={open && hasDetail}>
        <div className="max-h-72 overflow-auto border-t border-line bg-bg-panel/60 px-3 py-2">
          {tail?.length ? (
            <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-5 text-ink-faint">{tail.join('\n')}</pre>
          ) : null}
          {summary && (
            <pre className="whitespace-pre-wrap font-mono text-[12px] leading-5 text-ink-soft">{summary}</pre>
          )}
        </div>
      </Collapsible>
      <ToolImages images={c?.images} />
    </div>
  );
}

/** 工具输出图片（generate_image / inspect_image）：卡内缩略图，
 *  点击全屏灯箱预览（复用图片附件的交互范式）。 */
function ToolImages({ images }: { images?: string[] }): JSX.Element | null {
  const [zoom, setZoom] = useState<string | null>(null);
  if (!images?.length) return null;
  return (
    <div className="flex flex-wrap gap-2 border-t border-line px-3 py-2">
      {images.map((src, i) => (
        <img
          key={i}
          src={src}
          onClick={() => setZoom(src)}
          className="h-20 w-20 cursor-zoom-in rounded-md border border-line object-cover"
        />
      ))}
      {zoom && (
        <div className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/70" onClick={() => setZoom(null)}>
          <img src={zoom} className="max-h-[88vh] max-w-[90vw] rounded-lg object-contain shadow-2xl" />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------- file type icons

/** 扩展名 → 文件类型图标（lucide + 品牌色），编辑卡片文件名前缀。 */
const FILE_ICONS: Array<{ re: RegExp; Icon: typeof FileCode2; color?: string }> = [
  { re: /\.(tsx|jsx)$/, Icon: Atom, color: '#61dafb' },
  { re: /\.(ts|mts|cts)$/, Icon: FileCode2, color: '#3178c6' },
  { re: /\.(js|mjs|cjs)$/, Icon: FileCode2, color: '#e8d44d' },
  { re: /\.(json|jsonc)$/, Icon: Braces, color: '#cbcb41' },
  { re: /\.(md|markdown)$/, Icon: FileText },
  { re: /\.(css|scss|less|styl)$/, Icon: Palette, color: '#9575cd' },
  { re: /\.vue$/, Icon: Code, color: '#42b883' },
  { re: /\.svelte$/, Icon: Code, color: '#ff3e00' },
  { re: /\.(html?|xml)$/, Icon: Code, color: '#e44d26' },
  { re: /\.py$/, Icon: FileCode2, color: '#4b8bbe' },
  { re: /\.rs$/, Icon: FileCode2, color: '#dea584' },
  { re: /\.go$/, Icon: FileCode2, color: '#00add8' },
  { re: /\.(java|kts?)$/, Icon: FileCode2, color: '#f89820' },
  { re: /\.(c|h|cc|cpp|hpp)$/, Icon: FileCode2, color: '#649ad2' },
  { re: /\.(sh|bash|ps1|bat|cmd)$/, Icon: TerminalSquare },
  { re: /\.(ya?ml|toml|ini|env|conf|cfg)$/, Icon: Settings2 },
  { re: /\.(svg|png|jpe?g|gif|webp|ico)$/, Icon: ImageFileIcon, color: '#6bc46d' },
];

export function FileTypeIcon({ name, size = 13 }: { name: string; size?: number }): JSX.Element {
  const hit = FILE_ICONS.find((f) => f.re.test(name.toLowerCase()));
  const Icon = hit?.Icon ?? FileCode2;
  return (
    <Icon
      size={size}
      className={hit?.color ? 'shrink-0' : 'shrink-0 text-ink-faint'}
      style={hit?.color ? { color: hit.color } : undefined}
    />
  );
}

/** 文件编辑卡片 — 矩形框：编辑中卡面扫光 + 右侧 "Generating…"；
 *  完成后右侧 +N -N 行数变更 + A/M/D 徽章；失败显 Failed。点击展开 diff。
 *  proposed（omp ast_edit 两阶段预览）：琥珀色 "Preview" 标签，落盘前可先看 diff。 */
function EditCard({ msg }: { msg: Extract<UnifiedMessage, { kind: 'tool_call' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const active = msg.status === 'in_progress' || msg.status === 'pending';
  const proposed = msg.status === 'proposed';
  const c = msg.content;
  const fullPath = msg.locations?.[0] ?? msg.title;
  const file = fullPath.split(/[\\/]/).pop() ?? fullPath;
  const hasDetail = !active && !!(c?.patch || c?.diff || c?.text);
  const [letter, letterTone] =
    c?.changeKind === 'add' ? ['A', 'text-ok'] : c?.changeKind === 'delete' ? ['D', 'text-err'] : ['M', 'text-warn'];
  return (
    <div
      className={`overflow-hidden rounded-lg border transition ${active ? 'border-accent/35' : proposed ? 'border-warn/40' : 'border-line'
        }`}
    >
      <button
        onClick={() => hasDetail && setOpen(!open)}
        title={fullPath}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left ${active ? 'card-sweep' : ''} ${hasDetail ? 'hover:bg-bg-hover' : 'cursor-default'
          }`}
      >
        <FileTypeIcon name={file} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{file}</span>
        {active ? (
          <span className="shimmer-text shrink-0 text-[11.5px] font-medium">Generating…</span>
        ) : proposed ? (
          <span className="shrink-0 rounded-md bg-warn/10 px-1.5 py-0.5 text-[11px] font-medium text-warn">预览待确认</span>
        ) : msg.status === 'failed' ? (
          <span className="shrink-0 text-[11.5px] font-medium text-err">Failed</span>
        ) : msg.status === 'canceled' ? (
          <span className="shrink-0 text-[11.5px] text-ink-faint">Canceled</span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] tabular-nums">
            {c?.additions != null && c.additions > 0 && <span className="text-ok">+{c.additions}</span>}
            {c?.deletions != null && c.deletions > 0 && <span className="text-err">-{c.deletions}</span>}
            <span className={`font-semibold ${letterTone}`}>{letter}</span>
          </span>
        )}
        {hasDetail &&
          (open ? (
            <ChevronDown size={12} className="shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-ink-faint" />
          ))}
      </button>
      <Collapsible open={open && hasDetail}>
        <div className="max-h-72 overflow-auto border-t border-line bg-bg-panel/60 px-3 py-2">
          {c?.patch ? (
            <PatchView patch={c.patch} />
          ) : c?.diff ? (
            <DiffView oldText={c.diff.oldText} newText={c.diff.newText} path={c.diff.path} />
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-[12px] leading-5 text-ink-soft">{c?.text}</pre>
          )}
        </div>
      </Collapsible>
    </div>
  );
}

/** shell 命令条 — 单行框：命令文本 + 右侧 Running…/Ran/Exit N/Failed，
 *  点击展开输出（运行中实时追底）。也作为 Shell 组内明细行复用。 */
export function ShellCard({ msg }: { msg: Extract<UnifiedMessage, { kind: 'tool_call' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const active = msg.status === 'in_progress' || msg.status === 'pending';
  const out = msg.content?.text;
  const exit = msg.content?.exitCode;
  const outRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = outRef.current;
    if (open && active && el) el.scrollTop = el.scrollHeight;
  }, [out, open, active]);

  const label = active ? (
    <span className="shimmer-text shrink-0 text-[11.5px] font-medium">Running…</span>
  ) : msg.status === 'failed' ? (
    <span className="shrink-0 text-[11.5px] font-medium text-err">Failed</span>
  ) : msg.status === 'canceled' ? (
    <span className="shrink-0 text-[11.5px] text-ink-faint">Canceled</span>
  ) : exit != null && exit !== 0 ? (
    <span className="shrink-0 font-mono text-[11.5px] text-err">Exit {exit}</span>
  ) : (
    <span className="shrink-0 text-[11.5px] text-ink-faint">Ran</span>
  );

  return (
    <div className={`overflow-hidden rounded-lg border transition ${active ? 'border-accent/35' : 'border-line'}`}>
      <button
        onClick={() => out && setOpen(!open)}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${active ? 'card-sweep' : ''} ${out ? 'hover:bg-bg-hover' : 'cursor-default'
          }`}
      >
        <TerminalSquare size={13} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-soft">{msg.title}</span>
        {label}
        {out &&
          (open ? (
            <ChevronDown size={12} className="shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-ink-faint" />
          ))}
      </button>
      <Collapsible open={open && !!out}>
        <pre
          ref={outRef}
          className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-line bg-bg-panel/60 px-3 py-2 font-mono text-[11.5px] leading-5 text-ink-soft"
        >
          {out}
        </pre>
      </Collapsible>
    </div>
  );
}

/** unified diff 逐行着色渲染（+绿 / -红 / @@ 浅色）。 */
function PatchView({ patch }: { patch: string }): JSX.Element {
  const lines = patch.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('Index:') && !l.startsWith('='));
  return (
    <div className="font-mono text-[12px] leading-5">
      {lines.map((l, i) => {
        const cls = l.startsWith('+')
          ? 'bg-ok/10 text-ok'
          : l.startsWith('-')
            ? 'bg-err/10 text-err'
            : l.startsWith('@@')
              ? 'text-ink-faint'
              : 'text-ink-soft';
        return (
          <div key={i} className={`whitespace-pre-wrap px-1 ${cls}`}>
            {l || ' '}
          </div>
        );
      })}
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
