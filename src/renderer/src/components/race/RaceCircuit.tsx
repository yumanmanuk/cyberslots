/**
 * RaceCircuit — 赛程电路 HUD：五个阶段节点 + 连线，随 RaceStage 点亮，
 * 修复回环时在审计节点下方显示回环轮次。中性配色，进行中节点脉冲。
 */

import { Check } from 'lucide-react';

import type { RaceStage } from '@shared/race';
import { RACE_STAGE_ORDER } from '@shared/race';

const NODES: { label: string; icon: string; stage: RaceStage }[] = [
  { label: '双规划', icon: '⚑', stage: 'planning' },
  { label: '交叉反驳', icon: '⚔', stage: 'rebuttal' },
  { label: '裁判', icon: '⚖', stage: 'judging' },
  { label: '执行', icon: '🔨', stage: 'building' },
  { label: '审计', icon: '🛡', stage: 'auditing' },
];

/** 进度秩：repairing 视作已到审计段（修复意味着审计发生过）。
 *  用于判定某节点是否已“到达”——已到达才可点击回看。 */
function stageRank(stage: RaceStage): number {
  return RACE_STAGE_ORDER.indexOf(stage === 'repairing' ? 'auditing' : stage);
}

/** 当前阶段 → 激活节点下标；done → 全部完成（返回节点数）。 */
function activeIndex(stage: RaceStage): number {
  switch (stage) {
    case 'planning':
      return 0;
    case 'rebuttal':
      return 1;
    case 'judging':
      return 2;
    case 'building':
      return 3;
    case 'auditing':
      return 4;
    case 'repairing':
      return 3; // 修复 = Builder 节点重新激活 + 回环标记
    case 'done':
      return NODES.length;
    default:
      return -1;
  }
}

export default function RaceCircuit({
  stage,
  repairRound,
  viewing,
  onPick,
}: {
  stage: RaceStage;
  repairRound: number;
  /** 当前正在查看的阶段（回看时高亮对应节点）；缺省=跟随实际 stage。 */
  viewing?: RaceStage;
  /** 提供则节点可点击回看（仅已到达的节点）。 */
  onPick?: (stage: RaceStage) => void;
}): JSX.Element {
  const active = activeIndex(stage);
  const progress = stageRank(stage);
  // repairing 无专属节点，归到执行节点（与 active 同口径）。
  const viewIdx = NODES.findIndex((n) => n.stage === (viewing === 'repairing' ? 'building' : viewing));
  return (
    <div className="mx-auto flex w-full max-w-3xl items-start px-6 py-4">
      {NODES.map((n, i) => {
        const done = active > i;
        const isActive = active === i;
        const reached = progress >= stageRank(n.stage);
        const clickable = !!onPick && reached;
        // 回看态：正在看的节点与实际进行节点不同时，给它一道环高亮。
        const isViewing = !!onPick && viewIdx === i && viewIdx !== active;
        return (
          <div key={n.label} className="flex flex-1 items-start last:flex-none">
            <div
              className={`group flex w-16 shrink-0 flex-col items-center gap-1.5 ${clickable ? 'cursor-pointer' : ''}`}
              onClick={clickable ? () => onPick!(n.stage) : undefined}
              title={clickable ? `查看「${n.label}」环节（只读，不打断执行）` : undefined}
            >
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full border text-[15px] transition ${done
                  ? 'border-accent bg-accent-soft text-accent'
                  : isActive
                    ? 'animate-pulse border-accent bg-accent-soft text-accent'
                    : 'border-line bg-bg-input text-ink-faint'
                  }${isViewing ? ' ring-2 ring-accent' : ''}${clickable && !isActive ? ' group-hover:border-ink-soft group-hover:text-ink-soft' : ''}`}
              >
                {done ? <Check size={15} /> : n.icon}
              </div>
              <span className={`text-[11px] ${isActive ? 'font-semibold text-accent' : done ? 'text-ink-soft' : 'text-ink-faint'}`}>
                {n.label}
              </span>
              {/* 修复回环：审计节点下方标注轮次 */}
              {i === 4 && stage === 'repairing' && (
                <span className="text-[10px] text-err">⟲ 修复第 {repairRound} 轮</span>
              )}
            </div>
            {i < NODES.length - 1 && (
              <div className={`mt-[17px] h-px flex-1 ${active > i ? 'bg-accent' : 'bg-line'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
