/**
 * JudgePanel — 裁判台，两道人工关口：
 *   ④a 采纳决策：4 选 1（采纳A/采纳B/以A为准结合B/以B为准结合A）+ 可选评语；
 *   ④b 裁判按策略出最终方案（等待期显示进行中）；
 *   ④c 批注 → 裁判修订（v+1）→ 定稿交给 Builder。
 */

import { Check, PenLine, Square } from 'lucide-react';
import { useEffect, useState } from 'react';

import { BrandHero } from '../brand';

import type { RaceAdoptStrategy, RaceGroup, RacerRole } from '@shared/race';
import { RACER_ROLES, RACE_ADOPT_LABELS, adoptLabel } from '@shared/race';
import { useRaceStore } from '../../store/raceStore';

const LETTER: Record<RacerRole, 'A' | 'B' | 'C'> = { racerA: 'A', racerB: 'B', racerC: 'C' };

export default function JudgePanel({ race }: { race: RaceGroup }): JSX.Element {
  const revokeAdopt = useRaceStore((s) => s.revokeAdopt);
  // 裁判回合可手动中止（中止后走错误横幅的「↻ 重试当前阶段」重跑）。
  const stopJudge = race.sessions.judge
    ? (): void => void window.cyberslots.sessionCancel(race.sessions.judge!)
    : undefined;
  if (!race.adopt) return <AdoptStep race={race} />;
  if (!race.finalPlan)
    return (
      <Working
        label={`裁判正在按「${adoptLabel(race.adopt.strategy)}」出方案…`}
        onStop={stopJudge}
        onRevoke={() => void revokeAdopt()}
      />
    );
  return <ReviewStep race={race} stopJudge={stopJudge} />;
}

/** ④a 采纳决策：先由你定方向；对各方方案不满意可回退重跑双规划。
 *  策略集按在场选手动态生成（剔除者退场：剔 B 后剩 A+C → 只列 A/C 策略）。 */
function AdoptStep({ race }: { race: RaceGroup }): JSX.Element {
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
  return (
    <div className="mx-auto w-full max-w-2xl rounded-2xl border border-line bg-bg-panel/70 p-5">
      <div className="mb-1 text-[14px] font-semibold">⚖ 采纳决策 · 由你定方向</div>
      <div className="mb-4 text-[12px] text-ink-faint">
        读完各选手的方案与反驳/辩护后，选择采纳策略；裁判将严格按你的决策产出最终方案。
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
            {RACE_ADOPT_LABELS[st]}
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="评语（可选）：给裁判的指导意见，如「保留 A 的回滚设计，B 的第 2 步太激进不要」…"
        className="mb-3 min-h-16 w-full resize-y rounded-xl border border-line bg-bg-input px-3 py-2 text-[12.5px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent"
      />
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={openTune}
            title="调整各选手的引擎/模型/思考档（配合重跑生效）"
            className="rounded-xl border border-line bg-bg-input px-3 py-2 text-[12px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
          >
            ⚙ 调整选手
          </button>
          <button
            onClick={() => void restartPlanning()}
            title="清空各方方案与反驳，重新双规划（会重新消耗回合）"
            className="rounded-xl border border-line bg-bg-input px-3 py-2 text-[12px] text-ink-soft transition hover:border-warn hover:text-warn"
          >
            ↩ 对方案不满意，重跑规划
          </button>
        </div>
        <button
          disabled={!strategy}
          onClick={() => strategy && void adopt(strategy, comment.trim() || undefined)}
          className="rounded-xl bg-accent px-5 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-30"
        >
          提交决策，让裁判出方案 →
        </button>
      </div>
    </div>
  );
}

/** ④c 方案评审：批注修订循环 + 定稿。 */
function ReviewStep({ race, stopJudge }: { race: RaceGroup; stopJudge?: () => void }): JSX.Element {
  const revise = useRaceStore((s) => s.revise);
  const finalize = useRaceStore((s) => s.finalize);
  const [note, setNote] = useState('');
  // 提交批注后进入「修订中」，新版本号到达时解除；修订回合被中止/
  // 报错（错误横幅出现）也要解除，否则永远卡在转圈态。
  const [revising, setRevising] = useState(false);
  const [seenVersion, setSeenVersion] = useState(race.finalPlanVersion);
  const error = useRaceStore((s) => (s.activeRaceId ? s.errors[s.activeRaceId] : undefined));
  useEffect(() => {
    if (race.finalPlanVersion !== seenVersion) {
      setSeenVersion(race.finalPlanVersion);
      setRevising(false);
    }
  }, [race.finalPlanVersion, seenVersion]);
  useEffect(() => {
    if (error) setRevising(false);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="rounded-2xl border border-line border-l-2 border-l-accent bg-bg-panel/70 p-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[14px] font-semibold">📋 最终方案</span>
          <span className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-ink-faint">
            v{race.finalPlanVersion}
          </span>
          {race.adopt && (
            <span className="text-[11px] text-ink-faint">策略：{adoptLabel(race.adopt.strategy)}</span>
          )}
        </div>
        <div className="max-h-[46vh] overflow-y-auto whitespace-pre-wrap text-[13px] leading-6 text-ink-soft">
          {race.finalPlan}
        </div>
      </div>

      {race.annotations.length > 0 && (
        <div className="mt-3 rounded-r-lg border-l-2 border-warn bg-bg-input px-3 py-2 text-[12px] text-ink-soft">
          ✂ 最近批注：{race.annotations[race.annotations.length - 1]}
        </div>
      )}

      {revising ? (
        <Working label="裁判正在按批注修订方案…" onStop={stopJudge} />
      ) : (
        <div className="mt-4">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="在此批注 / 提出修改意见（如：第 3 步缺少并发锁，请补充）…"
            className="min-h-16 w-full resize-y rounded-xl border border-line bg-bg-input px-3 py-2 text-[12.5px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              disabled={!note.trim()}
              onClick={() => {
                setRevising(true);
                void revise(note.trim());
                setNote('');
              }}
              className="flex items-center gap-1.5 rounded-xl border border-line bg-bg-input px-4 py-2 text-[12.5px] text-ink-soft transition hover:bg-bg-hover hover:text-ink disabled:opacity-30"
            >
              <PenLine size={13} /> 按批注让裁判修订
            </button>
            <button
              onClick={() => void finalize()}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90"
            >
              <Check size={14} /> 定稿，交付执行
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Working({ label, onStop, onRevoke }: { label: string; onStop?: () => void; onRevoke?: () => void }): JSX.Element {
  return (
    <div className="mx-auto mt-6 flex w-full max-w-2xl flex-col items-center justify-center gap-3 rounded-2xl border border-line bg-bg-panel/70 py-8 text-[13px] text-ink-soft">
      {/* 大横幅用完整拉霸仪式 — 15px 三星在此场景太小，看起来像三个灰点 */}
      <BrandHero size={48} />
      <div className="flex items-center gap-3">
        {label}
        {onRevoke && (
          <button
            title="反悔了？叫停裁判并回到「选择采纳策略」重选（策略与评语重新填）"
            onClick={onRevoke}
            className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            ↩ 重新选择策略
          </button>
        )}
        {onStop && (
          <button
            title="中止裁判当前回合（随后可在错误横幅点「↻ 重试当前阶段」重跑）"
            onClick={onStop}
            className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-faint transition hover:border-err hover:text-err"
          >
            <Square size={10} fill="currentColor" /> 中止
          </button>
        )}
      </div>
    </div>
  );
}
