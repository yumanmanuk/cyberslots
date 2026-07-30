/**
 * RaceStatsCard — 赛后统计卡：总用时 / 总上下行 token + 逐阶段明细
 * （用时、↑上行、↓下行）。数据来自 RaceGroup.stats（主进程编排器
 * 按阶段累计并持久化）。
 *
 * 口径备注：kimi code 会话无真实 token 上报（仅字符数估算），一律
 * 不参与 token 统计（与「用量」页同口径）；用时照常计入。
 */

import type { RaceGroup, RaceStageStats } from '@shared/race';
import { RACE_STAGE_LABELS, RACE_WORK_STAGES } from '@shared/race';

/** 毫秒 → 人话时长（1h 02m / 4m 32s / 45s）。 */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** token 数紧凑展示（1.2k / 3.4M）。 */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export default function RaceStatsCard({ race }: { race: RaceGroup }): JSX.Element | null {
  const stats = race.stats;
  if (!stats) return null;
  const rows = RACE_WORK_STAGES.flatMap((stage) => {
    const s = stats[stage];
    return s ? [[stage, s] as const] : [];
  });
  if (rows.length === 0) return null;
  const total = rows.reduce<RaceStageStats>(
    (acc, [, s]) => ({
      durationMs: acc.durationMs + s.durationMs,
      inputTokens: acc.inputTokens + s.inputTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
    }),
    { durationMs: 0, inputTokens: 0, outputTokens: 0 },
  );

  return (
    <div className="shrink-0 rounded-2xl border border-line bg-bg-panel/70 p-4">
      <div className="mb-2 flex items-baseline gap-3 text-[13px] font-semibold text-ink">
        📊 赛后统计
        <span className="font-mono text-[11px] font-normal text-ink-soft">
          总用时 {fmtDuration(total.durationMs)} · 总 token {fmtTokens(total.inputTokens + total.outputTokens)}
          （↑{fmtTokens(total.inputTokens)} / ↓{fmtTokens(total.outputTokens)}）
        </span>
      </div>
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-left text-[10.5px] text-ink-faint">
            <th className="py-1 font-normal">环节</th>
            <th className="py-1 text-right font-normal">用时</th>
            <th className="py-1 text-right font-normal">Σ token</th>
            <th className="py-1 text-right font-normal">↑ 上行</th>
            <th className="py-1 text-right font-normal">↓ 下行</th>
          </tr>
        </thead>
        <tbody className="font-mono text-ink-soft">
          {rows.map(([stage, s]) => (
            <tr key={stage} className="border-t border-line/60">
              <td className="py-1 font-sans text-ink">{RACE_STAGE_LABELS[stage]}</td>
              <td className="py-1 text-right">{fmtDuration(s.durationMs)}</td>
              <td className="py-1 text-right">{fmtTokens(s.inputTokens + s.outputTokens)}</td>
              <td className="py-1 text-right">{fmtTokens(s.inputTokens)}</td>
              <td className="py-1 text-right">{fmtTokens(s.outputTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-[10.5px] text-ink-faint">
        注：kimi code 无真实 token 上报，不参与 token 统计（用时照常计入）；judging 用时含用户决策/批注等待。
      </div>
    </div>
  );
}
