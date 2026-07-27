/**
 * PermissionSheet — bottom sheet for pending authorization / ask-user
 * requests (slides up above the composer, codex style). The chat stream
 * keeps only a compact historical record; actions live here.
 *
 * ask_user 卡片仿 ChatGPT "Asking questions" 风格：卡片外一行灰色小字
 * 标签；卡内为问题标题 + 分页器 + 关闭按钮，选项是带序号圆圈的纵向
 * 列表（整行点击作答），底部是补充说明输入行与 Skip 按钮。reject 类
 * 选项（kimi 桥接自带的 Skip）不进列表，映射为右下角 Skip 按钮。
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  KeyRound,
  MessageCircleQuestion,
  Paperclip,
  SendHorizonal,
  X,
} from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../store/chatStore';

type Decision = Extract<UnifiedMessage, { kind: 'permission' | 'ask_user' }>;

export default function PermissionSheet({ sessionId }: { sessionId: string }): JSX.Element | null {
  // Select the stable messages reference; derive with useMemo. Returning a
  // fresh array from the selector would loop useSyncExternalStore forever.
  const messages = useChatStore((s) => s.ui[sessionId]?.messages);
  // 必须用自己的 sessionId 应答 — store.answerPermission 只看
  // activeSessionId，在 sidechat 面板里会把答复发给主会话，导致分支
  // 授权永远无响应（e2e 实测死锁根因）。
  const answer = (requestId: string, optionId?: string): void => {
    void window.cyberslots.sessionAnswerPermission({ sessionId, requestId, optionId });
  };
  const pending = useMemo(
    () =>
      (messages ?? []).filter(
        (m): m is Decision => (m.kind === 'permission' || m.kind === 'ask_user') && m.answeredOptionId === undefined,
      ),
    [messages],
  );
  const [index, setIndex] = useState(0);
  if (pending.length === 0) return null;

  const clamped = Math.min(index, pending.length - 1);
  const current = pending[clamped]!;

  // 多条待处理时的分页器（嵌在两类卡片的标题行右侧）。
  const pager =
    pending.length > 1 ? (
      <div className="flex shrink-0 items-center gap-0.5 text-ink-faint">
        <button
          onClick={() => setIndex((i) => (i - 1 + pending.length) % pending.length)}
          className="rounded p-0.5 transition hover:bg-bg-hover hover:text-ink"
          title="上一条"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="min-w-[36px] text-center text-[11px] tabular-nums">
          {clamped + 1} / {pending.length}
        </span>
        <button
          onClick={() => setIndex((i) => (i + 1) % pending.length)}
          className="rounded p-0.5 transition hover:bg-bg-hover hover:text-ink"
          title="下一条"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    ) : null;

  return (
    <div className="shrink-0 px-6 pb-2">
      <div className="mx-auto max-w-3xl">
        {current.kind === 'ask_user' ? (
          <QuestionCard
            key={current.requestId}
            msg={current}
            pager={pager}
            onAnswer={(optionId) => answer(current.requestId, optionId)}
            onDismiss={() => answer(current.requestId)}
            onNote={(text) => {
              // 取消当前提问（模型收到 dismiss），补充说明排入队列，
              // 回合结束后由 store 自动派发（chatStore turn.ended 分支）。
              answer(current.requestId);
              useChatStore.getState().enqueueTo(sessionId, text);
            }}
          />
        ) : (
          <ApprovalCard msg={current} pager={pager} onAnswer={(optionId) => answer(current.requestId, optionId)} />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- ask_user

/** ChatGPT "Asking questions" 风格的提问卡片。 */
function QuestionCard({
  msg,
  pager,
  onAnswer,
  onDismiss,
  onNote,
}: {
  msg: Extract<UnifiedMessage, { kind: 'ask_user' }>;
  pager: ReactNode;
  onAnswer: (optionId: string) => void;
  onDismiss: () => void;
  onNote: (text: string) => void;
}): JSX.Element {
  const [note, setNote] = useState('');
  const choices = msg.options.filter((o) => !o.kind.startsWith('reject'));
  const skipOption = msg.options.find((o) => o.kind.startsWith('reject'));
  const skip = (): void => (skipOption ? onAnswer(skipOption.optionId) : onDismiss());
  const submitNote = (): void => {
    const text = note.trim();
    if (!text) return;
    setNote('');
    onNote(text);
  };

  return (
    <div>
      {/* 卡片外灰色小字标签（对照截图的 "Asking questions"） */}
      <div className="mb-1.5 flex items-center gap-1.5 px-1.5 text-[11.5px] text-ink-faint">
        <MessageCircleQuestion size={12.5} />
        模型提问
      </div>
      <div className="animate-[sheet-in_.18s_ease-out] rounded-2xl border border-line bg-bg-panel shadow-lg">
        {/* 头部：问题标题 + 分页器 + 关闭（取消提问） */}
        <div className="flex items-start gap-2 px-4 pb-2 pt-3.5">
          <div className="min-w-0 flex-1 text-[14px] font-semibold leading-snug">{msg.question}</div>
          {pager}
          <button
            onClick={onDismiss}
            title="关闭（取消该提问）"
            className="shrink-0 rounded p-0.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>

        {/* 选项列表：序号圆圈 + 名称，整行点击作答，hover 浮出箭头 */}
        <div className="space-y-1 px-2.5">
          {choices.map((o, i) => (
            <button
              key={o.optionId}
              onClick={() => onAnswer(o.optionId)}
              className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-bg-hover"
            >
              <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-line text-[11px] text-ink-faint transition group-hover:border-ink-faint group-hover:text-ink-soft">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-ui font-medium">{o.name}</span>
              <ChevronRight size={14} className="shrink-0 text-ink-faint opacity-0 transition group-hover:opacity-100" />
            </button>
          ))}
        </div>

        {/* 底部：回形针 + 补充说明输入（回车提交） + Skip */}
        <div className="mt-1.5 flex items-center gap-2.5 border-t border-line/60 px-4 py-2.5">
          <Paperclip size={14} className="shrink-0 text-ink-faint" />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNote();
            }}
            placeholder="有别的想法？告诉模型怎么做…"
            className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-ink-faint"
          />
          {note.trim() ? (
            <button
              onClick={submitNote}
              className="flex shrink-0 items-center gap-1 rounded-full bg-accent px-3 py-1 text-[12px] font-medium text-white transition hover:opacity-90"
            >
              <SendHorizonal size={12} />
              发送
            </button>
          ) : (
            <button
              onClick={skip}
              className="shrink-0 rounded-full border border-line px-3.5 py-1 text-[12px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
            >
              Skip
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- permission

/** 授权卡片保持原样式，仅在标题行右侧加分页器（替代原“N 项等待”徽章）。 */
function ApprovalCard({
  msg,
  pager,
  onAnswer,
}: {
  msg: Extract<UnifiedMessage, { kind: 'permission' }>;
  pager: ReactNode;
  onAnswer: (optionId: string) => void;
}): JSX.Element {
  return (
    <div className="animate-[sheet-in_.18s_ease-out] rounded-2xl border border-line bg-bg-input shadow-lg">
      <div className="flex items-center gap-2.5 px-4 pb-1 pt-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-warn/15 text-warn">
          <KeyRound size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">请求授权</div>
          <div className="truncate text-sm font-medium">{msg.title}</div>
        </div>
        {pager}
      </div>
      <div className="flex flex-wrap gap-2 px-4 pb-3.5 pt-2">
        {msg.options.map((o) => {
          const rejecting = o.kind.startsWith('reject');
          return (
            <button
              key={o.optionId}
              onClick={() => onAnswer(o.optionId)}
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
  );
}
