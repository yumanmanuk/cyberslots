/**
 * JudgePanel — 裁判台，两道人工关口：
 *   ④a 采纳决策：4 选 1（采纳A/采纳B/以A为准结合B/以B为准结合A）+ 可选评语；
 *   ④b 裁判按策略出最终方案（等待期直播裁判会话输出流，不黑盒）；
 *   ④c 批注 → 裁判修订（v+1）→ 定稿交给 Builder。
 */

import { Check, Maximize2, PenLine, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { BrandHero, BrandSpinner } from '../brand';

import type { RaceAdoptStrategy, RaceGroup, RacerRole } from '@shared/race';
import { RACER_ROLES } from '@shared/race';
import { adoptStrategyLabel, useT } from '../../i18n';
import { useRaceStore } from '../../store/raceStore';
import { ENGINE_LABELS } from '../EngineIcon';
import ArtifactZoom from './ArtifactZoom';
import RaceLane from './RaceLane';

const LETTER: Record<RacerRole, 'A' | 'B' | 'C'> = { racerA: 'A', racerB: 'B', racerC: 'C' };

export default function JudgePanel({ race, readOnly = false }: { race: RaceGroup; readOnly?: boolean }): JSX.Element {
  const t = useT();
  const revokeAdopt = useRaceStore((s) => s.revokeAdopt);
  // 裁判回合可手动中止（中止后走错误横幅的「↻ 重试当前阶段」重跑）。
  const stopJudge = race.sessions.judge
    ? (): void => void window.cyberslots.sessionCancel(race.sessions.judge!)
    : undefined;
  // 回看态（从电路回点裁判节点）：裁判环节已完成，最终方案只读展示，
  // 不提供采纳/批注/定稿等任何可变操作。
  if (readOnly) {
    if (race.finalPlan) return <ReviewStep race={race} readOnly />;
    return (
      <div className="mx-auto w-full max-w-2xl rounded-2xl border border-line bg-bg-panel/70 p-5 text-center text-[12px] text-ink-faint">
        {t('raceJudgeNoFinal')}
      </div>
    );
  }
  if (!race.adopt) return <AdoptStep race={race} />;
  if (!race.finalPlan)
    return (
      <Working
        race={race}
        label={t('raceJudgeWorking', { strategy: adoptStrategyLabel(t, race.adopt.strategy) })}
        onStop={stopJudge}
        onRevoke={() => void revokeAdopt()}
      />
    );
  return <ReviewStep race={race} stopJudge={stopJudge} />;
}

/** ④a 采纳决策：先由你定方向；对各方方案不满意可回退重跑双规划。
 *  策略集按在场选手动态生成（剔除者退场：剔 B 后剩 A+C → 只列 A/C 策略）。 */
function AdoptStep({ race }: { race: RaceGroup }): JSX.Element {
  const t = useT();
  const adopt = useRaceStore((s) => s.adopt);
  const openTune = useRaceStore((s) => s.openTune);
  const restartPlanning = useRaceStore((s) => s.restartPlanning);
  const [strategy, setStrategy] = useState<RaceAdoptStrategy | null>(null);
  const [comment, setComment] = useState('');
  const letters = RACER_ROLES.filter((r) => !!race.roles[r] && !race.eliminated?.includes(r)).map((r) => LETTER[r]);
  const strategies: RaceAdoptStrategy[] = [
    ...letters.map((l) => `adopt${l}` as RaceAdoptStrategy),
    ...letters.map((l) => `prefer${l}` as RaceAdoptStrategy),
  ];
  const judge = race.roles.judge;
  return (
    <div className="mx-auto min-h-0 w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-bg-panel/70 p-5">
      <div className="mb-1 flex items-baseline gap-2 text-[14px] font-semibold">
        {t('raceAdoptTitle')}
        {judge && (
          <span className="font-mono text-[10.5px] font-normal text-ink-faint">
            {t('raceJudgePrefix')}{ENGINE_LABELS[judge.engine]} · {judge.modelId || t('raceDefaultModel')}
            {judge.effort ? ` · ${judge.effort}` : ''}
          </span>
        )}
      </div>
      <div className="mb-4 text-[12px] text-ink-faint">
        {t('raceAdoptDesc')}
      </div>
      <div className={`mb-3 grid gap-2 ${letters.length > 2 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {strategies.map((st) => (
          <button
            key={st}
            onClick={() => setStrategy(st)}
            className={`rounded-xl border px-3 py-2.5 text-[12.5px] transition ${strategy === st
              ? 'border-accent bg-accent-soft font-semibold text-accent'
              : 'border-line bg-bg-input text-ink-soft hover:bg-bg-hover hover:text-ink'
              }`}
          >
            {adoptStrategyLabel(t, st)}
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={t('raceAdoptCommentPlaceholder')}
        className="mb-3 min-h-16 w-full resize-y rounded-xl border border-line bg-bg-input px-3 py-2 text-[12.5px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent"
      />
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={openTune}
            title={t('raceTuneAllTitle')}
            className="rounded-xl border border-line bg-bg-input px-3 py-2 text-[12px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
          >
            {t('raceTuneRacers')}
          </button>
          <button
            onClick={() => void restartPlanning()}
            title={t('raceRestartPlanningTitle')}
            className="rounded-xl border border-line bg-bg-input px-3 py-2 text-[12px] text-ink-soft transition hover:border-warn hover:text-warn"
          >
            {t('raceRestartPlanning')}
          </button>
        </div>
        <button
          disabled={!strategy}
          onClick={() => strategy && void adopt(strategy, comment.trim() || undefined)}
          className="rounded-xl bg-accent px-5 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-30"
        >
          {t('raceSubmitDecision')}
        </button>
      </div>
    </div>
  );
}

/** ④c 方案评审：批注修订循环 + 定稿。 */
function ReviewStep({ race, stopJudge, readOnly = false }: { race: RaceGroup; stopJudge?: () => void; readOnly?: boolean }): JSX.Element {
  const t = useT();
  const revise = useRaceStore((s) => s.revise);
  const finalize = useRaceStore((s) => s.finalize);
  const openTune = useRaceStore((s) => s.openTune);
  const rerunJudge = useRaceStore((s) => s.rerunJudge);
  const [note, setNote] = useState('');
  // 提交批注（revise）/重新出方案（rework）后进入等待态，新版本号到达
  // 时解除；回合被中止/报错（错误横幅出现）也要解除，否则永远卡在转圈态。
  const [pending, setPending] = useState<'revise' | 'rework' | null>(null);
  const [seenVersion, setSeenVersion] = useState(race.finalPlanVersion);
  const [zoomed, setZoomed] = useState(false);
  const error = useRaceStore((s) => (s.activeRaceId ? s.errors[s.activeRaceId] : undefined));
  useEffect(() => {
    if (race.finalPlanVersion !== seenVersion) {
      setSeenVersion(race.finalPlanVersion);
      setPending(null);
    }
  }, [race.finalPlanVersion, seenVersion]);
  useEffect(() => {
    if (error) setPending(null);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      {/* 最终方案卡：header 固定，方案内容区内滚（占满剩余高度）。
          重新出方案（rework）期间隐藏——新方案将 v+1 整体覆盖，旧内容
          此时已过期，留着只会误导（批注修订 revise 是增量改，保留作基准）。 */}
      {pending !== 'rework' && (
      <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-line bg-bg-panel/70 p-5">
        <div className="mb-2 flex shrink-0 items-center gap-2">
          <span className="text-[14px] font-semibold">{t('raceFinalPlan')}</span>
          <span className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-ink-faint">
            v{race.finalPlanVersion}
          </span>
          {race.adopt && (
            <span className="text-[11px] text-ink-faint">{t('raceStrategyLabel', { strategy: adoptStrategyLabel(t, race.adopt.strategy) })}</span>
          )}
          <button
            title={t('raceZoom')}
            onClick={() => setZoomed(true)}
            className="ml-auto rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            <Maximize2 size={13} />
          </button>
        </div>
        {/* 与选手方案预览同款 markdown 渲染（md-body），不展示原文 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="md-body text-[13px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{race.finalPlan ?? ''}</ReactMarkdown>
          </div>
        </div>
      </div>
      )}

      {zoomed && race.finalPlan && (
        <ArtifactZoom
          title={t('raceJudgePlanTitle', { v: race.finalPlanVersion })}
          text={race.finalPlan}
          onClose={() => setZoomed(false)}
        />
      )}

      {race.annotations.length > 0 && (
        <div className="mt-3 shrink-0 rounded-r-lg border-l-2 border-warn bg-bg-input px-3 py-2 text-[12px] text-ink-soft">
          {t('raceRecentAnnotation', { note: race.annotations[race.annotations.length - 1] ?? '' })}
        </div>
      )}

      {pending ? (
        <Working
          race={race}
          label={
            pending === 'revise'
              ? t('raceJudgeRevising')
              : t('raceJudgeRework', { strategy: race.adopt ? adoptStrategyLabel(t, race.adopt.strategy) : t('raceExistingStrategy') })
          }
          onStop={stopJudge}
        />
      ) : readOnly ? null : (
        <div className="mt-4 shrink-0">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('raceReviseCommentPlaceholder')}
            className="min-h-16 w-full resize-y rounded-xl border border-line bg-bg-input px-3 py-2 text-[12.5px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={openTune}
              title={t('raceTuneJudgeTitle')}
              className="rounded-xl border border-line bg-bg-input px-3 py-2 text-[12px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
            >
              {t('raceTuneRoles')}
            </button>
            <button
              onClick={() => {
                setPending('rework');
                void rerunJudge();
              }}
              title={t('raceRerunJudgeTitle')}
              className="rounded-xl border border-line bg-bg-input px-3 py-2 text-[12px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
            >
              {t('raceRerunJudge')}
            </button>
            <div className="flex-1" />
            <button
              disabled={!note.trim()}
              onClick={() => {
                setPending('revise');
                void revise(note.trim());
                setNote('');
              }}
              className="flex items-center gap-1.5 rounded-xl border border-line bg-bg-input px-4 py-2 text-[12.5px] text-ink-soft transition hover:bg-bg-hover hover:text-ink disabled:opacity-30"
            >
              <PenLine size={13} /> {t('raceReviseBtn')}
            </button>
            <button
              onClick={() => void finalize()}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90"
            >
              <Check size={14} /> {t('raceFinalize')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 裁判工作中：精简操作行 + 裁判会话实时输出泳道（复用 RaceLane，
 *  思考/工具/正文流与选手泳道同款）——裁判不再黑盒。 */
function Working({
  race,
  label,
  onStop,
  onRevoke,
}: {
  race: RaceGroup;
  label: string;
  onStop?: () => void;
  onRevoke?: () => void;
}): JSX.Element {
  const t = useT();
  const sessionId = race.sessions.judge;
  const cfg = race.roles.judge;
  const subtitle = cfg
    ? `${ENGINE_LABELS[cfg.engine]} · ${cfg.modelId || t('raceDefaultModel')}${cfg.effort ? ` · ${cfg.effort}` : ''}`
    : '';
  return (
    <div className="mx-auto mt-4 flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-1">
      <div className="flex shrink-0 items-center justify-center gap-3 rounded-2xl border border-line bg-bg-panel/70 px-4 py-2.5 text-[13px] text-ink-soft">
        <BrandSpinner size={13} />
        {label}
        {onRevoke && (
          <button
            title={t('raceRevokeWorkingTitle')}
            onClick={onRevoke}
            className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            {t('raceReselectStrategy')}
          </button>
        )}
        {onStop && (
          <button
            title={t('raceStopJudgeTitle')}
            onClick={onStop}
            className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-faint transition hover:border-err hover:text-err"
          >
            <Square size={10} fill="currentColor" /> {t('raceCancel')}
          </button>
        )}
      </div>
      {/* 裁判过程直播：占满剩余高度内滚（fill），不撑出容器级滚动条；
          会话未建好前给大场面等待（按规范用 BrandHero） */}
      {sessionId ? (
        <RaceLane
          title={t('raceRoleJudge')}
          badge="⚖"
          subtitle={subtitle}
          sessionId={sessionId}
          tone="neutral"
          running
          fill
          finished={false}
        />
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-bg-panel/70 py-8 text-[12px] text-ink-faint">
          <BrandHero size={48} />
          {t('raceJudgeCreating')}
        </div>
      )}
    </div>
  );
}
