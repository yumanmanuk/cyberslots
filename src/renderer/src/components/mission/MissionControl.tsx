/**
 * MissionControl — 总控制台看板（无活动会话时的首页）。
 * 三列看板（进行中 / 等你处理 / 最近完成）+ workspace 过滤 chips + 搜索
 * + 赛马泳道 + cron 任务条 + 键盘流（j/k/Enter/a，/ 聚焦搜索）。
 * 所有卡面操作都不必切入会话；纯增量渲染，不触碰消息持久化路径。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlarmClock,
  CircleCheck,
  Inbox,
  LayoutDashboard,
  OctagonX,
  Play,
  Power,
  Search,
  Zap,
} from 'lucide-react';

import type { CronTask, SessionMeta, WorkspaceInfo } from '@shared/types';
import type { RaceGroup, RaceStage } from '@shared/race';
import { RACE_STAGE_ORDER, raceHostArchived } from '@shared/race';
import { useChatStore } from '../../store/chatStore';
import { useRaceStore } from '../../store/raceStore';
import { raceStageKey, useT } from '../../i18n';
import SessionCard, { defaultAllowOption, findPendingRequest } from './SessionCard';
import { BrandHero, BrandSpinner } from '../brand';
import { RaceHorse } from '../RaceHorse';
import { fmtEta, nextRunAt } from './cronNext';

type ChipId = 'all' | 'projects' | 'chats' | string;

/** 键盘流游标项：会话卡或赛马决策卡。 */
interface FlatItem {
  key: string;
  kind: 'session' | 'race';
  id: string;
}

/** done 列懒水合帽 — 只有前 N 张卡拉取历史做成果摘要。 */
const DONE_HYDRATE_CAP = 12;

// 稳定空数组兑底 — 内联 `?? []` 每次快照产生新数组，
// 会把 useSyncExternalStore 打进无限循环（同 Sidebar 白屏根因）。
const EMPTY_WORKSPACES: WorkspaceInfo[] = [];

export default function MissionControl(): JSX.Element {
  const t = useT();
  const sessions = useChatStore((s) => s.sessions);
  const sending = useChatStore((s) => s.sending);
  const lastActivity = useChatStore((s) => s.lastActivity);
  const workspaces = useChatStore((s) => s.settings?.workspaces) ?? EMPTY_WORKSPACES;
  const races = useRaceStore((s) => s.races);
  const [chip, setChip] = useState<ChipId>('all');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ------------------------------------------------------------ grouping

  const visible = useMemo(() => sessions.filter((s) => !s.archived && !s.raceId), [sessions]);

  // 宿主对话已归档的赛马一并收纳（不进泳道/待办），还原宿主后自动回来。
  const archivedIds = useMemo(() => new Set(sessions.filter((s) => s.archived).map((s) => s.id)), [sessions]);

  const chipFiltered = useMemo(() => {
    if (chip === 'all') return visible;
    if (chip === 'projects') return visible.filter((s) => s.chatMode === 'work' && !s.workspaceId);
    if (chip === 'chats') return visible.filter((s) => s.chatMode === 'chat');
    return visible.filter((s) => s.workspaceId === chip);
  }, [visible, chip]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chipFiltered;
    return chipFiltered.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        (lastActivity[s.id] ?? '').toLowerCase().includes(q),
    );
  }, [chipFiltered, query, lastActivity]);

  const columns = useMemo(() => {
    const running: SessionMeta[] = [];
    const inbox: SessionMeta[] = [];
    const done: SessionMeta[] = [];
    for (const s of filtered) {
      if (s.status === 'awaiting' || s.status === 'error') inbox.push(s);
      else if (s.status === 'running' || s.status === 'starting' || sending[s.id]) running.push(s);
      else done.push(s);
    }
    const byUpdated = (a: SessionMeta, b: SessionMeta): number => b.updatedAt - a.updatedAt;
    running.sort(byUpdated);
    inbox.sort(byUpdated);
    done.sort(byUpdated);
    return { running, inbox, done: done.slice(0, 30) };
  }, [filtered, sending]);

  /** 等你决策的赛马（judging 且未选采纳策略）→ 进待办列头部。 */
  const decisionRaces = useMemo(
    () =>
      Object.values(races)
        .filter((g) => g.stage === 'judging' && !g.adopt && !raceHostArchived(g, archivedIds))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [races, archivedIds],
  );
  /** 进行中的赛马（非终态）→ 泳道条。 */
  const liveRaces = useMemo(
    () =>
      Object.values(races)
        .filter((g) => g.stage !== 'done' && g.stage !== 'config' && !raceHostArchived(g, archivedIds))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [races, archivedIds],
  );

  // ---------------------------------------------------------- 键盘流

  const flat = useMemo<FlatItem[]>(() => {
    const list: FlatItem[] = [];
    for (const s of columns.running) list.push({ key: `s:${s.id}`, kind: 'session', id: s.id });
    for (const g of decisionRaces) list.push({ key: `r:${g.id}`, kind: 'race', id: g.id });
    for (const s of columns.inbox) list.push({ key: `s:${s.id}`, kind: 'session', id: s.id });
    for (const s of columns.done) list.push({ key: `s:${s.id}`, kind: 'session', id: s.id });
    return list;
  }, [columns, decisionRaces]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (flat.length === 0) return;
      const idx = flat.findIndex((f) => f.key === selectedKey);
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedKey(flat[Math.min(idx + 1, flat.length - 1)]!.key);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedKey(flat[Math.max(idx - 1, 0)]!.key);
      } else if (e.key === 'Enter' && idx >= 0) {
        const item = flat[idx]!;
        if (item.kind === 'race') useRaceStore.getState().openRace(item.id);
        else useChatStore.getState().selectSession(item.id);
      } else if (e.key === 'a' && idx >= 0) {
        const item = flat[idx]!;
        if (item.kind === 'race') {
          useRaceStore.getState().openRace(item.id);
          return;
        }
        const req = findPendingRequest(useChatStore.getState().ui[item.id]?.messages);
        if (req) void useChatStore.getState().answerPermissionTo(item.id, req.requestId, defaultAllowOption(req));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, selectedKey]);

  // 列表变化后游标失效 → 清除（避免幽灵高亮）。
  useEffect(() => {
    if (selectedKey && !flat.some((f) => f.key === selectedKey)) setSelectedKey(null);
  }, [flat, selectedKey]);

  if (visible.length === 0 && liveRaces.length === 0) return <EmptyHero />;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 头部：标题 + 键盘提示 + 搜索 */}
      <div className="flex shrink-0 items-center gap-3 px-6 pb-3 pt-5">
        <LayoutDashboard size={18} className="text-accent" />
        <h1 className="text-[16px] font-semibold text-ink">{t('mcTitle')}</h1>
        <span className="hidden text-[11px] text-ink-faint xl:block">{t('mcKeysHint')}</span>
        <span className="flex-1" />
        <div className="flex w-64 items-center gap-1.5 rounded-lg border border-line bg-bg-input px-2.5 py-1.5 transition focus-within:border-accent/60">
          <Search size={13} className="shrink-0 text-ink-faint" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder={t('mcSearch')}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>

      {/* workspace 过滤 chips */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-6 pb-3">
        <Chip label={t('all')} count={visible.length} active={chip === 'all'} onClick={() => setChip('all')} />
        {workspaces.map((ws) => {
          const n = visible.filter((s) => s.workspaceId === ws.id).length;
          if (n === 0 && chip !== ws.id) return null;
          return <Chip key={ws.id} label={ws.name} count={n} active={chip === ws.id} onClick={() => setChip(ws.id)} />;
        })}
        <Chip
          label={t('projects')}
          count={visible.filter((s) => s.chatMode === 'work' && !s.workspaceId).length}
          active={chip === 'projects'}
          onClick={() => setChip('projects')}
        />
        <Chip
          label={t('chats')}
          count={visible.filter((s) => s.chatMode === 'chat').length}
          active={chip === 'chats'}
          onClick={() => setChip('chats')}
        />
      </div>

      {/* 全局条带：赛马泳道 + cron */}
      <div className="flex shrink-0 flex-col gap-2 px-6 pb-3">
        {liveRaces.length > 0 && <RaceStrip races={liveRaces} />}
        <CronStrip />
      </div>

      {/* 三列看板 */}
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-4 px-6 pb-5">
        <BoardColumn
          icon={<Zap size={13} className="text-accent" />}
          title={t('mcColRunning')}
          count={columns.running.length}
          headerExtra={
            columns.running.length > 1 ? (
              <button
                title={t('mcStopAll')}
                onClick={() => {
                  for (const s of columns.running) void useChatStore.getState().cancelSession(s.id);
                }}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint transition hover:bg-err/15 hover:text-err"
              >
                <OctagonX size={11} />
                {t('mcStopAll')}
              </button>
            ) : undefined
          }
          empty={t('mcEmptyRunning')}
        >
          {columns.running.map((s) => (
            <SessionCard key={s.id} meta={s} column="running" selected={selectedKey === `s:${s.id}`} hydrate />
          ))}
        </BoardColumn>

        <BoardColumn
          icon={<Inbox size={13} className="text-warn" />}
          title={t('mcColInbox')}
          count={columns.inbox.length + decisionRaces.length}
          highlight={columns.inbox.length + decisionRaces.length > 0}
          empty={t('mcEmptyInbox')}
        >
          {decisionRaces.map((g) => (
            <RaceDecisionCard key={g.id} race={g} selected={selectedKey === `r:${g.id}`} />
          ))}
          {columns.inbox.map((s) => (
            <SessionCard key={s.id} meta={s} column="inbox" selected={selectedKey === `s:${s.id}`} hydrate />
          ))}
        </BoardColumn>

        <BoardColumn
          icon={<CircleCheck size={13} className="text-ok" />}
          title={t('mcColDone')}
          count={columns.done.length}
          empty={t('mcEmptyDone')}
        >
          {columns.done.map((s, i) => (
            <SessionCard
              key={s.id}
              meta={s}
              column="done"
              selected={selectedKey === `s:${s.id}`}
              hydrate={i < DONE_HYDRATE_CAP}
            />
          ))}
        </BoardColumn>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- chips

function Chip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition ${active
          ? 'border-accent/50 bg-accent/10 font-medium text-accent'
          : 'border-line bg-bg-panel text-ink-soft hover:bg-bg-hover hover:text-ink'
        }`}
    >
      {label}
      <span className={`tabular-nums ${active ? 'text-accent' : 'text-ink-faint'}`}>{count}</span>
    </button>
  );
}

// ---------------------------------------------------------------- column

function BoardColumn({
  icon,
  title,
  count,
  headerExtra,
  highlight,
  empty,
  children,
}: {
  icon: JSX.Element;
  title: string;
  count: number;
  headerExtra?: JSX.Element;
  highlight?: boolean;
  empty: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-col rounded-2xl bg-bg-canvas/60 p-2">
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
        {icon}
        <span className="text-[12px] font-semibold text-ink-soft">{title}</span>
        <span
          className={`rounded-full px-1.5 text-[11px] tabular-nums ${highlight ? 'bg-warn/15 font-semibold text-warn' : 'bg-bg-hover text-ink-faint'
            }`}
        >
          {count}
        </span>
        <span className="flex-1" />
        {headerExtra}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-0.5 pb-1 pt-0.5">
        {count === 0 ? <div className="px-2 py-6 text-center text-[12px] text-ink-faint">{empty}</div> : children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ race strip

/** 阶段进度定位：repairing 视觉上等同 auditing 段（回环不另占一格）。 */
function stageIndex(stage: RaceStage): number {
  const idx = RACE_STAGE_ORDER.indexOf(stage === 'repairing' ? 'auditing' : stage);
  return idx < 0 ? 0 : idx;
}

function RaceStrip({ races }: { races: RaceGroup[] }): JSX.Element {
  const t = useT();
  return (
    <div className="rounded-xl border border-line bg-bg-panel px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-soft">
        <RaceHorse size={18} className="shrink-0" />
        {t('mcRaceLane')}
      </div>
      <div className="flex flex-col gap-1.5">
        {races.map((g) => {
          const idx = stageIndex(g.stage);
          const waiting = g.stage === 'judging' && !g.adopt;
          return (
            <button
              key={g.id}
              onClick={() => useRaceStore.getState().openRace(g.id)}
              className="group flex items-center gap-3 rounded-lg px-1.5 py-1 text-left transition hover:bg-bg-hover"
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{g.prompt}</span>
              {/* 阶段分段进度条 */}
              <span className="flex shrink-0 items-center gap-0.5">
                {RACE_STAGE_ORDER.slice(1, -1).map((st, i) => (
                  <span
                    key={st}
                    title={t(raceStageKey(st))}
                    className={`h-1 w-5 rounded-full transition-colors ${i + 1 < idx ? 'bg-accent' : i + 1 === idx ? 'bg-accent animate-pulse' : 'bg-line'
                      }`}
                  />
                ))}
              </span>
              <span className="w-16 shrink-0 text-[11px] text-ink-soft">
                {t(raceStageKey(g.stage))}
              </span>
              {waiting ? (
                <span className="shrink-0 animate-pulse rounded-md bg-warn/15 px-1.5 py-0.5 text-[11px] font-medium text-warn">
                  {t('mcRaceDecision')}
                </span>
              ) : g.interrupted ? (
                <span className="shrink-0 rounded-md bg-err/10 px-1.5 py-0.5 text-[11px] text-err">{t('mcRaceInterrupted')}</span>
              ) : (
                <span className="shrink-0 text-[11px] text-ink-faint opacity-0 transition group-hover:opacity-100">
                  {t('mcRaceOpen')} →
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 待办列里的赛马决策卡：裁判等你选采纳策略。 */
function RaceDecisionCard({ race, selected }: { race: RaceGroup; selected: boolean }): JSX.Element {
  const t = useT();
  return (
    <div
      data-mc-card={`race:${race.id}`}
      onClick={() => useRaceStore.getState().openRace(race.id)}
      className={`cursor-pointer rounded-xl border bg-bg-panel p-3 transition-all duration-200 hover:bg-bg-hover hover:shadow-md ${selected ? 'border-accent shadow-md ring-1 ring-accent/40' : 'border-warn/40'
        }`}
    >
      <div className="flex items-center gap-2">
        <RaceHorse size={18} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{race.prompt}</span>
      </div>
      <div className="mt-1.5 text-[12px] text-ink-soft">{t('mcRaceDecisionDesc')}</div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          useRaceStore.getState().openRace(race.id);
        }}
        className="mt-2 rounded-md bg-warn/15 px-2.5 py-1 text-[11.5px] font-medium text-warn transition hover:bg-warn/25"
      >
        {t('mcRaceOpen')} →
      </button>
    </div>
  );
}

// ------------------------------------------------------------ cron strip

function CronStrip(): JSX.Element | null {
  const t = useT();
  const tasks = useChatStore((s) => s.cronTasks);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void useChatStore.getState().loadCron();
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (tasks.length === 0) return null;

  return (
    <div className="rounded-xl border border-line bg-bg-panel px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-soft">
        <AlarmClock size={12} className="text-info" />
        {t('scheduled')}
      </div>
      <div className="flex flex-col gap-1">
        {tasks.map((task) => (
          <CronRow key={task.id} task={task} now={now} />
        ))}
      </div>
    </div>
  );
}

function CronRow({ task, now }: { task: CronTask; now: number }): JSX.Element {
  const t = useT();
  const next = useMemo(() => (task.enabled ? nextRunAt(task.cron, now) : null), [task.enabled, task.cron, now]);
  const [running, setRunning] = useState(false);

  return (
    <div className="group flex items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-bg-hover">
      <span className={`min-w-0 flex-1 truncate text-[12px] ${task.enabled ? 'text-ink' : 'text-ink-faint'}`}>
        {task.name}
      </span>
      <code className="shrink-0 rounded bg-bg-hover px-1.5 text-[10.5px] text-ink-faint">{task.cron}</code>
      {task.enabled && next != null && (
        <span className="shrink-0 text-[11px] tabular-nums text-ink-soft" title={new Date(next).toLocaleString()}>
          {t('mcCronNext')} {fmtEta(next, now)}
        </span>
      )}
      {task.lastResult && (
        <span className={`shrink-0 text-[11px] ${task.lastResult === 'ok' ? 'text-ok' : 'text-err'}`}>
          {task.lastResult === 'ok' ? '✓' : '✗'}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        {task.lastSessionId && (
          <button
            title={t('mcCronLastSession')}
            onClick={() => useChatStore.getState().selectSession(task.lastSessionId!)}
            className="rounded-md p-1 text-ink-faint transition hover:bg-bg-active hover:text-ink"
          >
            <Search size={11} />
          </button>
        )}
        <button
          title={t('mcCronRunNow')}
          disabled={running}
          onClick={() => {
            setRunning(true);
            void useChatStore
              .getState()
              .runCronNow(task.id)
              .finally(() => setTimeout(() => setRunning(false), 1500));
          }}
          className="rounded-md p-1 text-ink-faint transition hover:bg-bg-active hover:text-accent disabled:opacity-50"
        >
          {/* 进行中态用品牌 spinner 替换图标，不用 animate-pulse 表达 loading */}
          {running ? <BrandSpinner size={11} /> : <Play size={11} />}
        </button>
        <button
          title={task.enabled ? t('mcCronPause') : t('mcCronResume')}
          onClick={() => void useChatStore.getState().saveCron({ ...task, enabled: !task.enabled })}
          className={`rounded-md p-1 transition hover:bg-bg-active ${task.enabled ? 'text-ok hover:text-warn' : 'text-ink-faint hover:text-ok'}`}
        >
          <Power size={11} />
        </button>
      </span>
    </div>
  );
}

// ------------------------------------------------------------ empty hero

/** 全空看板：优雅的落地空态，引导去新建会话或发起赛马。 */
function EmptyHero(): JSX.Element {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 panel-in">
      {/* 品牌拉霸仪式循环 —— 空看板也有期待感 */}
      <BrandHero size={72} />
      <div className="text-[16px] font-semibold text-ink">{t('mcTitle')}</div>
      <div className="max-w-sm text-center text-[13px] leading-relaxed text-ink-soft">{t('mcEmptyAll')}</div>
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={() => useChatStore.setState({ dashboardOpen: false, activeSessionId: null })}
          className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-85"
        >
          {t('newSession')}
        </button>
        <button
          onClick={() => useRaceStore.getState().openSetup()}
          className="flex items-center gap-1.5 rounded-xl border border-line px-4 py-2 text-[13px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
        >
          <RaceHorse size={18} className="shrink-0" />
          {t('mcStartRace')}
        </button>
      </div>
    </div>
  );
}
