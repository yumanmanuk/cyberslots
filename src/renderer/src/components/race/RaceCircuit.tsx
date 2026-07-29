/**
 * RaceCircuit — 赛程电路 HUD：五个阶段节点 + 连线，随 RaceStage 点亮，
 * 修复回环时在审计节点下方显示回环轮次。中性配色，进行中节点脉冲。
 */

import { Check } from 'lucide-react';

import type { RaceStage } from '@shared/race';

const NODES: { label: string; icon: string }[] = [
  { label: '双规划', icon: '⚑' },
  { label: '交叉反驳', icon: '⚔' },
  { label: '裁判', icon: '⚖' },
  { label: '执行', icon: '🔨' },
  { label: '审计', icon: '🛡' },
];

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
}: {
  stage: RaceStage;
  repairRound: number;
}): JSX.Element {
  const active = activeIndex(stage);
  return (
    <div className="mx-auto flex w-full max-w-3xl items-start px-6 py-4">
      {NODES.map((n, i) => {
        const done = active > i;
        const isActive = active === i;
        return (
          <div key={n.label} className="flex flex-1 items-start last:flex-none">
            <div className="flex w-16 shrink-0 flex-col items-center gap-1.5">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-full border text-[15px] transition ${done
                  ? 'border-accent bg-accent-soft text-accent'
                  : isActive
                    ? 'animate-pulse border-accent bg-accent-soft text-accent'
                    : 'border-line bg-bg-input text-ink-faint'
                  }`}
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
