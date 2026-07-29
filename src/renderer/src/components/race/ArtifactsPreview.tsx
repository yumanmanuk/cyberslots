/**
 * ArtifactsPreview — 裁判阶段的干净产物预览：各选手的 plan 文档（markdown
 * 渲染）+ 各自的「⚔ 反驳 / 🤝 吸纳 / 🛡 辩护」，替代全过程原文流（思考/
 * 工具噪音太多）。数据来自 RaceGroup.artifacts（规划/反驳回合结束时
 * 由编排器冻结并推送）。
 */

import { ChevronRight, Download } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { RaceGroup, RacerRole } from '@shared/race';
import { RACE_ROLE_LABELS } from '@shared/race';
import { downloadMarkdown } from '../../planDoc';
import { useRaceStore } from '../../store/raceStore';
import EliminateButton from './EliminateButton';

export default function ArtifactsPreview({ race, fill = false }: { race: RaceGroup; fill?: boolean }): JSX.Element {
  const eliminateRacer = useRaceStore((s) => s.eliminateRacer);
  const art = race.artifacts ?? {};
  // 参赛选手（2–3 位，剔除者退场）动态排列；C 用中性色。
  const racers = [
    { role: 'racerA' as const, letter: 'A', tone: 'a' as const, plan: art.planA, rebuttal: art.rebuttalA },
    { role: 'racerB' as const, letter: 'B', tone: 'b' as const, plan: art.planB, rebuttal: art.rebuttalB },
    { role: 'racerC' as const, letter: 'C', tone: 'c' as const, plan: art.planC, rebuttal: art.rebuttalC },
  ].filter((r) => !!race.roles[r.role] && !race.eliminated?.includes(r.role));
  // 读完方案觉得某位实在不行 → 选策略前就地剔除（剩余 ≥2）。
  const canEliminate = !race.adopt && racers.length > 2;
  return (
    <div
      className={`mx-auto flex w-full gap-4 ${racers.length > 2 ? 'max-w-7xl' : 'max-w-5xl'} ${fill ? 'h-full min-h-0' : 'mb-4'
        }`}
    >
      {racers.map((r, i) => (
        <div key={r.role} className={`flex min-w-0 flex-1 ${fill ? 'min-h-0' : ''}`}>
          {i > 0 && <div className="mr-4 w-px shrink-0 bg-line" />}
          <RacerArtifact
            letter={r.letter}
            tone={r.tone}
            plan={r.plan}
            rebuttal={r.rebuttal}
            engineLabel={`${race.roles[r.role]!.engine} · ${race.roles[r.role]!.modelId || '默认模型'}`}
            onEliminate={
              canEliminate ? () => void eliminateRacer(r.role as RacerRole) : undefined
            }
            eliminateLabel={RACE_ROLE_LABELS[r.role]}
            fill={fill}
          />
        </div>
      ))}
    </div>
  );
}

function RacerArtifact({
  letter,
  tone,
  plan,
  rebuttal,
  engineLabel,
  onEliminate,
  eliminateLabel,
  fill = false,
}: {
  letter: string;
  tone: 'a' | 'b' | 'c';
  plan?: string;
  rebuttal?: string;
  engineLabel: string;
  onEliminate?: () => void;
  eliminateLabel?: string;
  /** 锁滞布局：方案文档区占满弹性高度内滚（替代固定 max-h）。 */
  fill?: boolean;
}): JSX.Element {
  const [planOpen, setPlanOpen] = useState(true);
  const [rebutOpen, setRebutOpen] = useState(false);
  const toneText = tone === 'a' ? 'text-accent' : tone === 'b' ? 'text-warn' : 'text-ink-soft';
  const toneBorder = tone === 'a' ? 'border-accent' : tone === 'b' ? 'border-warn' : 'border-line';

  return (
    <div className={`flex min-w-0 flex-1 flex-col gap-2 ${fill ? 'min-h-0' : ''}`}>
      {/* 头部：选手标识 + 引擎/模型 */}
      <div className="flex items-center gap-2 px-1">
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-md border bg-bg-input text-[11px] font-bold ${toneText} ${toneBorder}`}
        >
          {letter}
        </span>
        <span className="text-[13px] font-semibold text-ink">选手 {letter}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint">{engineLabel}</span>
        {onEliminate && <EliminateButton label={eliminateLabel ?? `选手 ${letter}`} onConfirm={onEliminate} />}
      </div>

      {/* 📋 Plan 文档（markdown 预览，可下载）：fill 下占满弹性高度 */}
      <div className={`rounded-xl border border-line bg-bg-panel/70 ${fill && planOpen ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
        <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
          <button
            onClick={() => setPlanOpen(!planOpen)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-medium text-ink transition hover:text-accent"
          >
            <ChevronRight size={12} className={`shrink-0 transition-transform ${planOpen ? 'rotate-90' : ''}`} />
            📋 方案文档
          </button>
          {plan && (
            <button
              title="下载 md"
              onClick={() => downloadMarkdown(`选手${letter}方案`, plan)}
              className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
            >
              <Download size={12} />
            </button>
          )}
        </div>
        {planOpen && (
          <div className={`overflow-y-auto px-3.5 py-2.5 ${fill ? 'min-h-0 flex-1' : 'max-h-[44vh]'}`}>
            {plan ? (
              <div className="md-body text-[12.5px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
              </div>
            ) : (
              <div className="py-4 text-center text-[12px] text-ink-faint">（尚未产出）</div>
            )}
          </div>
        )}
      </div>

      {/* ⚔ 反驳 / 🤝 吸纳 / 🛡 辩护（同一回合产物，默认收起） */}
      <div className="rounded-xl border border-line bg-bg-panel/70">
        <button
          onClick={() => setRebutOpen(!rebutOpen)}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-ink transition hover:text-accent"
        >
          <ChevronRight size={12} className={`shrink-0 transition-transform ${rebutOpen ? 'rotate-90' : ''}`} />
          ⚔ 反驳 · 🤝 吸纳 · 🛡 辩护
        </button>
        {rebutOpen && (
          <div className="max-h-[36vh] overflow-y-auto border-t border-line px-3.5 py-2.5">
            {rebuttal ? (
              <div className="md-body text-[12.5px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{rebuttal}</ReactMarkdown>
              </div>
            ) : (
              <div className="py-4 text-center text-[12px] text-ink-faint">（尚未产出）</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
