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

import { useEffect, useState } from 'react';
import { Asterisk, ChevronDown, ChevronRight, Telescope, TerminalSquare } from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import MessageItem, { Collapsible, ShellCard, ThinkingBlock, ToolLine } from './MessageItem';

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

/** 可折叠工具组（explore / shell）：进行中强制展开明细，结束后复位为
 *  默认折叠（可点开）。明细行：explore 工具 → ToolLine，shell → ShellCard，
 *  思考 → ThinkingBlock（流式中仍有 8 行滚窗）。 */
function ToolGroup({ gkind, entries }: { gkind: GroupKind; entries: GroupEntry[] }): JSX.Element {
  const tools = entries.filter((e): e is ToolMsg => e.kind === 'tool_call');
  const active = entries.some((e) =>
    e.kind === 'tool_call' ? e.status === 'in_progress' || e.status === 'pending' : e.streaming,
  );
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) setUserOpen(null);
  }, [active]);
  const open = userOpen ?? active;

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
  const Icon = gkind === 'shell' ? TerminalSquare : Telescope;

  return (
    <div className="text-ui">
      <button onClick={() => setUserOpen(!open)} className="group flex items-center gap-1.5">
        <Icon size={13} className={`shrink-0 ${active ? 'text-accent' : 'text-ink-faint group-hover:text-ink-soft'}`} />
        {active ? (
          <span className="shimmer-text font-medium">{gkind === 'shell' ? 'Running' : 'Exploring'}</span>
        ) : (
          <span className="text-ink-faint transition group-hover:text-ink-soft">{summary}</span>
        )}
        {!active && failed > 0 && (
          <span className="shrink-0 text-[11.5px] text-err">{failed} failed</span>
        )}
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
      <Asterisk size={14} className="animate-[spin_2.4s_linear_infinite] text-accent" />
      <span className="shimmer-text font-medium">Working…</span>
    </div>
  );
}
