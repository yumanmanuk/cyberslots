/**
 * SessionCard — 总控制台看板卡片。一张卡 = 一个会话的完整驾驶舱：
 * 状态徽章、「正在做什么」实时行、plan 进度环、上下文水位条、费用角标、
 * Goal 预算条、permission/ask_user 卡面直批、错误一键重试、steer 迷你
 * 输入、停止/标记已读。所有操作都不必切入会话（IPC 本就按 sessionId 寻址）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleDollarSign,
  CornerDownLeft,
  FileDiff,
  ListChecks,
  MessageSquarePlus,
  Pause,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';

import type { GoalInfo, SessionMeta, UnifiedMessage } from '@shared/types';
import { useChatStore } from '../../store/chatStore';
import { useT } from '../../i18n';
import { BrandSpinner } from '../brand';
import { EngineIcon } from '../EngineIcon';
import { fmtShort } from '../UsageQuota';

// ------------------------------------------------------------- helpers

/** 最后一条未应答的 permission/ask_user（卡面直批的数据源）。 */
export function findPendingRequest(
  messages: UnifiedMessage[] | undefined,
): Extract<UnifiedMessage, { kind: 'permission' | 'ask_user' }> | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if ((m.kind === 'permission' || m.kind === 'ask_user') && m.answeredOptionId === undefined) return m;
  }
  return null;
}

/** 默认批准项：第一个 allow 类选项（键盘流 a 键与卡面主按钮共用）。 */
export function defaultAllowOption(req: Extract<UnifiedMessage, { kind: 'permission' | 'ask_user' }>): string | undefined {
  return (req.options.find((o) => o.kind.startsWith('allow')) ?? req.options[0])?.optionId;
}

function timeAgo(ts: number, lang: 'zh' | 'en'): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return lang === 'zh' ? '刚刚' : 'now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** done 列成果摘要：最后一段正文的首两行。 */
function finalReply(messages: UnifiedMessage[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === 'text' && m.text.trim()) {
      return m.text.trim().split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 160);
    }
    if (m.kind === 'user') break; // 提问之后还没有产出
  }
  return null;
}

function lastError(messages: UnifiedMessage[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === 'error') return m.message.split('\n', 1)[0]!.slice(0, 140);
    if (m.kind === 'user') break;
  }
  return null;
}

/** 文件变更统计：聚合本会话 edit 类工具调用（去重路径 + 行数增减）。 */
function fileStats(messages: UnifiedMessage[] | undefined): { files: number; add: number; del: number } | null {
  if (!messages) return null;
  const paths = new Set<string>();
  let add = 0;
  let del = 0;
  for (const m of messages) {
    if (m.kind !== 'tool_call' || m.toolKind !== 'edit' || m.status !== 'completed') continue;
    for (const loc of m.locations ?? []) paths.add(loc);
    if (m.content?.diff?.path) paths.add(m.content.diff.path);
    add += m.content?.additions ?? 0;
    del += m.content?.deletions ?? 0;
  }
  if (paths.size === 0 && add === 0 && del === 0) return null;
  return { files: Math.max(paths.size, 1), add, del };
}

/** 最新 plan 的完成度（进度环数据源）。 */
function planProgress(messages: UnifiedMessage[] | undefined): { done: number; total: number } | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === 'plan' && m.entries.length > 0) {
      return { done: m.entries.filter((e) => e.status === 'completed').length, total: m.entries.length };
    }
  }
  return null;
}

const STATUS_STYLE: Record<string, { dot: string; text: string }> = {
  starting: { dot: 'bg-accent animate-pulse', text: 'text-accent' },
  running: { dot: 'bg-accent animate-pulse', text: 'text-accent' },
  awaiting: { dot: 'bg-warn animate-pulse', text: 'text-warn' },
  error: { dot: 'bg-err', text: 'text-err' },
  idle: { dot: 'bg-ok', text: 'text-ok' },
  closed: { dot: 'bg-ink-faint', text: 'text-ink-faint' },
};

// -------------------------------------------------------------- sub-bits

/** plan 进度环：14px SVG 圆环 + n/m 文本。 */
function PlanRing({ done, total }: { done: number; total: number }): JSX.Element {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const ratio = total > 0 ? done / total : 0;
  return (
    <span className="flex items-center gap-1 text-[11px] tabular-nums text-ink-soft" title={`Plan ${done}/${total}`}>
      <svg width={14} height={14} viewBox="0 0 14 14" className="-rotate-90">
        <circle cx="7" cy="7" r={r} fill="none" stroke="var(--line)" strokeWidth="2" />
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke={ratio >= 1 ? 'var(--ok)' : 'var(--accent)'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${c * ratio} ${c}`}
          className="transition-[stroke-dasharray] duration-500"
        />
      </svg>
      {done}/{total}
    </span>
  );
}

/** 上下文水位条：4px 细条，占用越高越警示。 */
function ContextBar({ used, size }: { used: number; size: number }): JSX.Element | null {
  if (!size) return null;
  const pct = Math.min(100, Math.round((used / size) * 100));
  const color = pct >= 90 ? 'bg-err' : pct >= 70 ? 'bg-warn' : 'bg-ok';
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5" title={`Context ${pct}%`}>
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
        <span className={`block h-full rounded-full ${color} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      </span>
      <span className="shrink-0 text-[10.5px] tabular-nums text-ink-faint">{pct}%</span>
    </span>
  );
}

// ------------------------------------------------------------------ card

export interface SessionCardProps {
  meta: SessionMeta;
  column: 'running' | 'inbox' | 'done';
  selected: boolean;
  /** done 列尾部卡片不水合（懒加载帽），其余列全水合。 */
  hydrate: boolean;
}

export default function SessionCard({ meta, column, selected, hydrate }: SessionCardProps): JSX.Element {
  const t = useT();
  const lang = useChatStore((s) => s.settings?.language ?? 'zh');
  const ui = useChatStore((s) => s.ui[meta.id]);
  const goal = useChatStore((s) => s.goals[meta.id]) as GoalInfo | undefined;
  const activity = useChatStore((s) => s.lastActivity[meta.id]);
  const queueLen = useChatStore((s) => s.queues[meta.id]?.length ?? 0);
  const [steerOpen, setSteerOpen] = useState(false);
  const [steerText, setSteerText] = useState('');
  const [steerTip, setSteerTip] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout>>();

  // 懒水合：卡面直批/成果摘要都要读历史消息（只读拉取，不碰落盘）。
  useEffect(() => {
    if (hydrate && !ui?.hydrated) useChatStore.getState().hydrateSession(meta.id);
  }, [hydrate, ui?.hydrated, meta.id]);

  // 键盘流选中 → 滚入视野。
  useEffect(() => {
    if (selected) cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  useEffect(() => () => clearTimeout(tipTimer.current), []);

  const messages = ui?.messages;
  const pending = useMemo(() => findPendingRequest(messages), [messages]);
  const plan = useMemo(() => planProgress(messages), [messages]);
  const err = meta.status === 'error' ? lastError(messages) : null;
  const summary = column === 'done' ? finalReply(messages) : null;
  const stats = column === 'done' ? fileStats(messages) : null;
  const style = STATUS_STYLE[meta.status] ?? STATUS_STYLE.idle!;
  const live = meta.status === 'running' || meta.status === 'starting' || meta.status === 'awaiting';

  const showTip = (text: string): void => {
    setSteerTip(text);
    clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => setSteerTip(null), 2600);
  };

  const submitSteer = async (): Promise<void> => {
    const text = steerText.trim();
    if (!text) return;
    setSteerText('');
    const result = await useChatStore.getState().steerLive(meta.id, text);
    showTip(result === 'steered' ? t('mcSteered') : result === 'queued' ? t('mcQueuedTip') : t('mcSentTip'));
  };

  const statusLabel =
    meta.status === 'running' || meta.status === 'starting'
      ? t('running')
      : meta.status === 'awaiting'
        ? t('awaiting')
        : meta.status === 'error'
          ? t('failed')
          : t('statusDone');

  return (
    <div
      ref={cardRef}
      data-mc-card={meta.id}
      onClick={() => useChatStore.getState().selectSession(meta.id)}
      className={`group cursor-pointer rounded-xl border bg-bg-panel p-3 transition-all duration-200 hover:bg-bg-hover hover:shadow-md ${selected ? 'border-accent shadow-md ring-1 ring-accent/40' : 'border-line'
        }`}
    >
      {/* 头行：引擎 + 标题 + 状态 + 时间 */}
      <div className="flex items-center gap-2">
        <EngineIcon engine={meta.engine} size={13} className="shrink-0 text-ink-soft" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{meta.title}</span>
        {meta.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t('unreadOnly')} />}
        <span className={`flex shrink-0 items-center gap-1 text-[11px] ${style.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
          {statusLabel}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">{timeAgo(meta.updatedAt, lang)}</span>
      </div>

      {/* 「正在做什么」实时行（运行中 shimmer；出错/完成列不显示避免噪音） */}
      {live && activity && (
        <div className={`mt-1.5 truncate text-[12px] text-ink-soft ${meta.status !== 'awaiting' ? 'shimmer-text' : ''}`}>
          {activity}
        </div>
      )}

      {/* 指标行：plan 环 · 上下文水位 · 排队数 · 费用 */}
      {(plan || ui?.usage || queueLen > 0) && (
        <div className="mt-2 flex items-center gap-3">
          {plan && <PlanRing done={plan.done} total={plan.total} />}
          {ui?.usage && ui.usage.size > 0 ? <ContextBar used={ui.usage.used} size={ui.usage.size} /> : <span className="flex-1" />}
          {queueLen > 0 && (
            <span className="shrink-0 rounded bg-bg-hover px-1 text-[10.5px] tabular-nums text-ink-faint" title={t('mcQueueBadge')}>
              +{queueLen}
            </span>
          )}
          {ui?.usage?.costUsd != null && ui.usage.costUsd > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-[10.5px] tabular-nums text-ink-faint">
              <CircleDollarSign size={10} />
              {ui.usage.costUsd.toFixed(2)}
            </span>
          )}
        </div>
      )}

      {/* Goal 预算条：目标 + 暂停/续跑 + token 预算水位 */}
      {goal && (
        <div className="mt-2 rounded-lg bg-bg-hover/60 px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-soft">🎯 {goal.objective}</span>
            <button
              title={goal.status === 'paused' ? t('mcGoalResume') : t('mcGoalPause')}
              onClick={(e) => {
                e.stopPropagation();
                void window.cyberslots.sessionGoalControl(meta.id, goal.status === 'paused' ? 'resume' : 'pause');
              }}
              className="shrink-0 rounded p-0.5 text-ink-faint transition hover:bg-bg-active hover:text-ink"
            >
              {goal.status === 'paused' ? <Play size={12} /> : <Pause size={12} />}
            </button>
          </div>
          {goal.tokenBudget != null && goal.tokenBudget > 0 && (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
                <span
                  className="block h-full rounded-full bg-accent transition-[width] duration-500"
                  style={{ width: `${Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)}%` }}
                />
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
                {fmtShort(goal.tokensUsed, lang)}/{fmtShort(goal.tokenBudget, lang)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 待办直批：permission / ask_user 选项按钮直接放卡面 */}
      {pending && (
        <div className="mt-2 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-2" onClick={(e) => e.stopPropagation()}>
          <div className="text-[12px] leading-snug text-ink" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {pending.kind === 'permission' ? pending.title : pending.question}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {pending.options.slice(0, 4).map((o) => {
              const allow = o.kind.startsWith('allow');
              return (
                <button
                  key={o.optionId}
                  onClick={() => void useChatStore.getState().answerPermissionTo(meta.id, pending.requestId, o.optionId)}
                  className={`rounded-md px-2 py-0.5 text-[11.5px] transition ${allow
                      ? 'bg-accent text-white hover:opacity-85'
                      : 'border border-line bg-bg text-ink-soft hover:bg-bg-hover'
                    }`}
                >
                  {o.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 错误卡：错误首行 + 一键重试 */}
      {err && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-err/30 bg-err/10 px-2.5 py-2" onClick={(e) => e.stopPropagation()}>
          <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-err" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {err}
          </span>
          <button
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void useChatStore
                .getState()
                .retryLast(meta.id)
                .finally(() => setRetrying(false));
            }}
            className="flex shrink-0 items-center gap-1 rounded-md border border-err/40 px-2 py-0.5 text-[11.5px] text-err transition hover:bg-err/15 disabled:opacity-50"
          >
            {retrying ? <BrandSpinner size={11} /> : <RotateCcw size={11} />}
            {t('mcRetry')}
          </button>
        </div>
      )}

      {/* 成果摘要（done 列）：最终回复首行 + 文件变更统计 */}
      {column === 'done' && (summary || stats) && (
        <div className="mt-2">
          {summary && (
            <div className="text-[12px] leading-snug text-ink-soft" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {summary}
            </div>
          )}
          {stats && (
            <div className="mt-1 flex items-center gap-2 text-[11px] tabular-nums">
              <span className="flex items-center gap-1 text-ink-faint">
                <FileDiff size={11} />
                {stats.files}
              </span>
              {stats.add > 0 && <span className="text-ok">+{stats.add}</span>}
              {stats.del > 0 && <span className="text-err">-{stats.del}</span>}
            </div>
          )}
        </div>
      )}

      {/* steer 迷你输入（展开态） */}
      {steerOpen && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5 rounded-lg border border-line bg-bg-input px-2 py-1 focus-within:border-accent/60">
            <input
              autoFocus
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submitSteer();
                if (e.key === 'Escape') setSteerOpen(false);
              }}
              placeholder={t('mcSteerPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-faint"
            />
            <CornerDownLeft size={12} className="shrink-0 text-ink-faint" />
          </div>
        </div>
      )}
      {steerTip && <div className="mt-1 text-[11px] text-ok">{steerTip}</div>}

      {/* 操作行：hover 浮现，不干扰浏览 */}
      <div
        className="mt-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          title={t('mcSteerTitle')}
          onClick={() => setSteerOpen((v) => !v)}
          className={`rounded-md p-1 transition hover:bg-bg-hover ${steerOpen ? 'text-accent' : 'text-ink-faint hover:text-ink'}`}
        >
          <MessageSquarePlus size={13} />
        </button>
        {live && (
          <button
            title={t('mcStop')}
            onClick={() => void useChatStore.getState().cancelSession(meta.id)}
            className="rounded-md p-1 text-ink-faint transition hover:bg-err/15 hover:text-err"
          >
            <Square size={12} />
          </button>
        )}
        {meta.unread && (
          <button
            title={t('mcMarkRead')}
            onClick={() => void useChatStore.getState().markSessionRead(meta.id)}
            className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            <ListChecks size={13} />
          </button>
        )}
        <span className="flex-1" />
        <span className="text-[10.5px] text-ink-faint">{t('mcOpenHint')}</span>
      </div>
    </div>
  );
}
