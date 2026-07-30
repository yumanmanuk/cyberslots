/**
 * MessageList — 消息流渲染层（ChatView / SideChatPanel 共用）：
 * 1. 连续的同类工具调用聚合成可折叠组（qoder 风格）：
 *    - explore 组（read/search/fetch）：进行中 "Exploring" 展开明细流，
 *      结束自动折叠成 "Explored N files · M searches"；
 *    - shell 组（execute）：进行中 "Running" 展开命令卡流，结束自动
 *      折叠成 "Ran N commands"（带失败计数）。
 *    两类组都允许思考段并入组内渲染（Thought 行不切断分组）。
 * 2. 流尾挂活动指示器：仅在静默空窗期（末尾没有任何可见进行态）
 *    显示旋转 ✻ + "Working…"。思考/探索/编辑/命令/审批各块自带
 *    进行态标签，指示器不再重复同一个词（避免两行 Thinking 挨着）。
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Telescope, TerminalSquare } from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import MessageItem, { Collapsible, ShellCard, ThinkingBlock, ToolLine, toolLabel } from './MessageItem';
import { BrandSpinner } from './brand';

type ToolMsg = Extract<UnifiedMessage, { kind: 'tool_call' }>;
type ThinkMsg = Extract<UnifiedMessage, { kind: 'thinking' }>;
type GroupEntry = ToolMsg | ThinkMsg;
type GroupKind = 'explore' | 'shell';

const EXPLORE_KINDS = new Set(['read', 'search', 'fetch']);

/** 该工具调用归属哪类可折叠组（null = 不入组，单独渲染）。 */
function groupKindOf(m: ToolMsg): GroupKind | null {
  if (EXPLORE_KINDS.has(m.toolKind)) return 'explore';
  if (m.toolKind === 'execute') return 'shell';
  return null;
}

type StreamItem =
  | { type: 'msg'; msg: UnifiedMessage }
  | { type: 'tools'; id: string; gkind: GroupKind; entries: GroupEntry[] };

function buildStream(messages: UnifiedMessage[]): StreamItem[] {
  const items: StreamItem[] = [];
  for (const m of messages) {
    // 空计划不渲染（避免空 wrapper 擑大 flex gap）。
    if (m.kind === 'plan' && m.entries.length === 0) continue;
    // 已作答的授权/提问不留痕——授权结果不展示（只在进行中给一行知情提示），
    // 空 wrapper 也会撑出多余 flex gap，故在建流阶段整体跳过。
    if (m.kind === 'permission' && m.answeredOptionId !== undefined) continue;
    // todowrite/todoread 工具行不渲染 — 内容已由内联 To-dos 卡片呈现。
    if (m.kind === 'tool_call' && (m.toolName ?? '').toLowerCase().includes('todo')) continue;
    if (m.kind === 'tool_call') {
      const gk = groupKindOf(m);
      if (gk) {
        const last = items[items.length - 1];
        if (last && last.type === 'tools' && last.gkind === gk) {
          last.entries.push(m);
          continue;
        }
        // 紧邻的前一段思考回拉并入新组（qoder：组可以 Thought 行开头）。
        if (last && last.type === 'msg' && last.msg.kind === 'thinking') {
          items[items.length - 1] = { type: 'tools', id: `tools-${m.id}`, gkind: gk, entries: [last.msg, m] };
          continue;
        }
        items.push({ type: 'tools', id: `tools-${m.id}`, gkind: gk, entries: [m] });
        continue;
      }
    }
    // 工具间隙的思考不切断分组 — 作为组内 Thought 行继续收集。
    if (m.kind === 'thinking') {
      const last = items[items.length - 1];
      if (last && last.type === 'tools') {
        last.entries.push(m);
        continue;
      }
    }
    items.push({ type: 'msg', msg: m });
  }
  return items;
}

export default function MessageList({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: UnifiedMessage[];
}): JSX.Element {
  const status = useChatStore((s) => s.sessions.find((m) => m.id === sessionId)?.status);
  // 启动期已发送（prompt 在途等引擎就绪）也算进行态 — 否则用户发完
  // 首条消息到回合真正开始的 1~5s 窗口内界面像死机。
  const sending = useChatStore((s) => !!s.sending[sessionId]);
  const items = buildStream(messages);
  return (
    <>
      {items.map((it) =>
        it.type === 'msg' ? (
          <div key={it.msg.id} data-msg-id={it.msg.id}>
            <MessageItem msg={it.msg} sessionId={sessionId} />
          </div>
        ) : (
          <div key={it.id} data-msg-id={it.entries[0]!.id}>
            <ToolGroup gkind={it.gkind} entries={it.entries} />
          </div>
        ),
      )}
      {(status === 'running' || status === 'awaiting' || sending) && !hasVisibleActivity(messages) && <ActivityIndicator />}
    </>
  );
}

// -------------------------------------------------------------- tool group

/** 工具活动组（explore / shell）—— 方案 A「定高活动窗」：
 *  进行中固定高度（状态行 + 1px 扫描线 + 3 行历史视窗，新行从底部推入、
 *  旧行上移到顶部被渐隐遮罩吞掉），高度恒定不随步数增长；回合结束坍缩成
 *  单行摘要，点击展开完整历史（含各行的输出/diff 查看入口）。这样「进行
 *  →折叠」的高度突变只发生一次且在回合边界，消除页面上下跳动。 */
function ToolGroup({ gkind, entries }: { gkind: GroupKind; entries: GroupEntry[] }): JSX.Element {
  const tools = entries.filter((e): e is ToolMsg => e.kind === 'tool_call');
  const active = entries.some((e) =>
    e.kind === 'tool_call' ? e.status === 'in_progress' || e.status === 'pending' : e.streaming,
  );

  // 进行中 → 定高活动窗（不可折叠、高度恒定）。
  if (active) return <ActivityWindow gkind={gkind} entries={entries} />;

  // 已完成 → 单行摘要，点击展开完整历史。
  const failed = tools.filter((m) => m.status === 'failed').length;
  let summary: string;
  if (gkind === 'shell') {
    summary = `Ran ${tools.length} ${tools.length === 1 ? 'command' : 'commands'}`;
  } else {
    const files = tools.filter((m) => m.toolKind === 'read').length;
    const searches = tools.length - files;
    const parts: string[] = [];
    if (files > 0) parts.push(`${files} ${files === 1 ? 'file' : 'files'}`);
    if (searches > 0) parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`);
    summary = `Explored ${parts.join(' · ')}`;
  }
  return <ToolSummary Icon={gkind === 'shell' ? TerminalSquare : Telescope} summary={summary} failed={failed} entries={entries} gkind={gkind} />;
}

/** 进行中的定高活动窗：状态行（品牌 spinner + 动词流光 + 步数·用时）
 *  + 扫描线 + 60px（3 行）视窗；视窗内容底部对齐，新行推入、旧行溢出
 *  顶部被渐隐遮罩吞掉。只渲染尾部若干行（完整历史在折叠态可查）。 */
function ActivityWindow({ gkind, entries }: { gkind: GroupKind; entries: GroupEntry[] }): JSX.Element {
  const start = entries[0]?.createdAt ?? Date.now();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // 定高遮罩视窗内无法行内展开（会被裁切），故被点开的思考正文
  // 渲染到视窗下方（抽屉）——用户主动展开，允许的高度变化。
  const [openThink, setOpenThink] = useState<string | null>(null);
  const steps = entries.filter((e) => e.kind === 'tool_call').length;
  const tail = entries.slice(-8);
  const revealed = openThink
    ? (entries.find((e) => e.id === openThink && e.kind === 'thinking') as ThinkMsg | undefined)
    : undefined;
  return (
    <div className="text-ui">
      <div className="flex items-center gap-2" style={{ height: 22 }}>
        <BrandSpinner size={14} className="shrink-0 text-accent" />
        <span className="shimmer-text text-[12.5px] font-medium">{gkind === 'shell' ? 'Running' : 'Exploring'}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
          {steps > 0 ? `${steps} ${steps === 1 ? 'step' : 'steps'} · ` : ''}
          {fmtElapsed(now - start)}
        </span>
      </div>
      <div className="tool-scan my-[3px]" />
      <div
        className="overflow-hidden"
        style={{
          height: 60,
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 22px)',
          maskImage: 'linear-gradient(to bottom, transparent 0, #000 22px)',
        }}
      >
        <div className="flex min-h-full flex-col justify-end">
          {tail.map((e) => (
            <CompactRow
              key={e.id}
              entry={e}
              expanded={openThink === e.id}
              onToggle={() => setOpenThink((prev) => (prev === e.id ? null : e.id))}
            />
          ))}
        </div>
      </div>
      {/* 展开的思考正文（阐述推理——真内容，区别于工具行）。 */}
      {revealed && <ThinkingReveal text={revealed.text} streaming={revealed.streaming} />}
    </div>
  );
}

/** 活动窗内的单行紧凑态（20px）：3px 状态刻度 + 动词 + 对象 + 辅助数。
 *  工具行纯知情不可展；思考行是真推理内容，带箭头可点击展开（正文在
 *  视窗下方阐述）。 */
function CompactRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: GroupEntry;
  expanded?: boolean;
  onToggle?: () => void;
}): JSX.Element {
  if (entry.kind === 'thinking') {
    const running = entry.streaming;
    const hasText = !!entry.text;
    return (
      <button
        onClick={() => hasText && onToggle?.()}
        className={`group flex w-full items-center gap-2 text-left ${hasText ? '' : 'cursor-default'}`}
        style={{ height: 20 }}
      >
        <span className={`h-[11px] w-[3px] shrink-0 rounded-full ${running ? 'bg-accent tool-tick-run' : 'bg-ink-faint/50'}`} />
        <span className={`shrink-0 text-[12px] ${running ? 'shimmer-text font-medium' : 'text-ink-soft'}`}>Thinking</span>
        {hasText &&
          (expanded ? (
            <ChevronDown size={12} className="shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-ink-faint opacity-0 transition group-hover:opacity-100" />
          ))}
      </button>
    );
  }
  const running = entry.status === 'in_progress' || entry.status === 'pending';
  const failed = entry.status === 'failed';
  const isShell = entry.toolKind === 'execute';
  const label = toolLabel(entry);
  const verb = isShell ? (running ? 'Running' : 'Ran') : label.verb;
  const object = isShell ? entry.title : label.object;
  const matches = entry.content?.matches;
  return (
    <div className="flex items-center gap-2" style={{ height: 20 }}>
      <span className={`h-[11px] w-[3px] shrink-0 rounded-full ${running ? 'bg-accent tool-tick-run' : failed ? 'bg-err' : 'bg-ink-faint/50'}`} />
      <span className={`shrink-0 text-[12px] ${running ? 'shimmer-text font-medium' : failed ? 'text-err' : 'text-ink-soft'}`}>{verb}</span>
      {object && object !== verb && (
        <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-faint">{object}</span>
      )}
      {matches != null && !running && (
        <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-ink-faint/80">{matches}</span>
      )}
      {failed && <span className="ml-auto shrink-0 text-[10.5px] text-err">failed</span>}
    </div>
  );
}

/** 活动窗内思考行展开后的推理正文（视窗下方，不受遮罩限高）：
 *  流式中自动贴底，与 ThinkingBlock 正文同样式。 */
function ThinkingReveal({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (streaming && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, streaming]);
  return (
    <div
      ref={ref}
      className="ml-[5px] mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap border-l-2 border-line pl-3.5 text-[12.5px] leading-6 text-ink-faint [overflow-wrap:anywhere]"
    >
      {text}
    </div>
  );
}

/** 完成态摘要行：图标 + 概览（Explored/Ran …），点击展开完整历史。
 *  展开区沿用原明细：explore → ToolLine、shell → ShellCard（含输出查看）、
 *  思考 → ThinkingBlock。 */
function ToolSummary({
  Icon,
  summary,
  failed,
  entries,
  gkind,
}: {
  Icon: typeof Telescope;
  summary: string;
  failed: number;
  entries: GroupEntry[];
  gkind: GroupKind;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-ui">
      <button onClick={() => setOpen(!open)} className="group flex items-center gap-1.5">
        <Icon size={13} className="shrink-0 text-ink-faint transition group-hover:text-ink-soft" />
        <span className="text-ink-faint transition group-hover:text-ink-soft">{summary}</span>
        {failed > 0 && <span className="shrink-0 text-[11.5px] text-err">{failed} failed</span>}
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-ink-faint opacity-0 transition group-hover:opacity-100" />
        )}
      </button>
      <Collapsible open={open}>
        <div className="ml-[5px] mt-1.5 flex flex-col gap-1.5 border-l-2 border-line pl-3.5">
          {entries.map((e) =>
            e.kind === 'thinking' ? (
              <ThinkingBlock
                key={e.id}
                text={e.text}
                streaming={e.streaming}
                createdAt={e.createdAt}
                durationMs={e.durationMs}
              />
            ) : gkind === 'shell' ? (
              <ShellCard key={e.id} msg={e} />
            ) : (
              <ToolLine key={e.id} msg={e} />
            ),
          )}
        </div>
      </Collapsible>
    </div>
  );
}

/** 活动窗计时：秒级用时（<60s 显 Ns，否则 Nm Ns）。 */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// ------------------------------------------------------ activity indicator

/** 流末尾是否已有可见的进行态元素（自带 Thinking/Exploring/Generating/
 *  Running/Waiting 标签）— 有则指示器静默，避免同词重复。 */
function hasVisibleActivity(messages: UnifiedMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === 'user') return false;
    if ((m.kind === 'thinking' || m.kind === 'text') && m.streaming) return true;
    if (m.kind === 'tool_call' && (m.status === 'in_progress' || m.status === 'pending')) return true;
    if ((m.kind === 'permission' || m.kind === 'ask_user') && m.answeredOptionId === undefined) return true;
  }
  return false;
}

function ActivityIndicator(): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-ui">
      {/* 全局进行态指示 — 规范要求品牌 spinner，不用 lucide 图标旋转 */}
      <BrandSpinner size={14} />
      <span className="shimmer-text font-medium">Working…</span>
    </div>
  );
}
