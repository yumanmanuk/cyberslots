/**
 * RaceView — 赛马全屏视图：顶栏（返回/任务/阶段/中止）+ 赛程电路 HUD +
 * 按阶段切换主区（双泳道竞速 / 裁判台 / Builder+审计 / 完成）。
 * 收敛后角色会话仍是普通 session，可在侧栏继续使用（毕业机制）。
 */

import { ArrowLeft, CircleAlert, OctagonX } from 'lucide-react';
import { useEffect, useState } from 'react';

import { BrandHero } from '../brand';

import type { RaceGroup, RaceRole, RaceStage, RacerRole } from '@shared/race';
import { RACER_ROLES, RACE_ROLE_LABELS, RACE_STAGE_LABELS } from '@shared/race';
import { useChatStore } from '../../store/chatStore';
import { useRaceStore } from '../../store/raceStore';
import { ENGINE_LABELS } from '../EngineIcon';
import ArtifactsPreview from './ArtifactsPreview';
import JudgePanel from './JudgePanel';
import RaceCircuit from './RaceCircuit';
import RaceLane from './RaceLane';
import RaceStatsCard from './RaceStatsCard';
import RoleTuneDialog from './RoleTuneDialog';

function roleSubtitle(race: RaceGroup, role: RaceRole): string {
  const cfg = race.roles[role];
  if (!cfg) return '';
  return `${ENGINE_LABELS[cfg.engine]} · ${cfg.modelId || '默认模型'}${cfg.effort ? ` · ${cfg.effort}` : ''}`;
}

/** 阶段飘字图标（与赛程电路 HUD 节点图标同谱系）。 */
const STAGE_TOAST_ICONS: Record<RaceStage, string> = {
  config: '⚙',
  planning: '⚑',
  rebuttal: '⚔',
  judging: '⚖',
  building: '🔨',
  auditing: '🛡',
  repairing: '⟲',
  done: '🏁',
};

/** 阶段切换飘字：电路 HUD 下方居中浮层，滑入停留淡出后由
 *  raceStore 自动清掉；key=seq 保证连续切阶段时动画重新播放。
 *  居中靠外层 flex，动画 transform 只挂内层（不互相覆盖）。 */
function StageToast({ raceId }: { raceId: string }): JSX.Element | null {
  const flash = useRaceStore((s) => s.stageFlash);
  if (!flash || flash.raceId !== raceId) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center">
      <div
        key={flash.seq}
        className="race-stage-toast flex items-center gap-2 rounded-full border border-accent bg-bg-panel/95 px-4 py-1.5 text-[12.5px] font-semibold text-accent shadow-lg"
      >
        {flash.stage === 'done'
          ? '🏁 赛马完成'
          : `${STAGE_TOAST_ICONS[flash.stage]} 进入「${RACE_STAGE_LABELS[flash.stage]}」环节`}
      </div>
    </div>
  );
}

export default function RaceView({ raceId }: { raceId: string }): JSX.Element {
  const race = useRaceStore((s) => s.races[raceId]);
  const error = useRaceStore((s) => s.errors[raceId]);
  const closeRace = useRaceStore((s) => s.closeRace);
  const cancelRace = useRaceStore((s) => s.cancelRace);
  const resumeRace = useRaceStore((s) => s.resumeRace);
  const openTune = useRaceStore((s) => s.openTune);

  if (!race) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-ink-faint">
        <BrandHero size={56} />
        加载赛马数据…
      </div>
    );
  }

  const stage = race.stage;
  // 回看态：用户从电路点入某个已到达的阶段。viewStage 仅影响本
  // 视图展示（只读），不碰 race.stage——执行由主进程编排器跑，
  // 与“看哪个阶段”彻底解耦，回看绝不打断执行。
  const [viewStage, setViewStage] = useState<RaceStage | null>(null);
  const reviewing = viewStage !== null && viewStage !== stage;
  const shown = viewStage ?? stage;
  // 实际阶段推进到“恰好等于正在回看的阶段”时自动归位，不抽掉用户。
  useEffect(() => {
    if (viewStage === stage) setViewStage(null);
  }, [stage, viewStage]);

  const racing = stage === 'planning' || stage === 'rebuttal';
  const buildish = stage === 'building' || stage === 'auditing' || stage === 'repairing' || stage === 'done';

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <StageToast raceId={raceId} />
      {/* 顶栏 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-2.5">
        <button
          onClick={closeRace}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ink-faint transition hover:bg-bg-hover hover:text-ink"
        >
          <ArrowLeft size={13} /> 返回对话
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink" title={race.prompt}>
          🏇 {race.prompt}
        </span>
        <span className="rounded-full border border-line bg-accent-soft px-3 py-1 text-[11px] text-accent">
          {RACE_STAGE_LABELS[stage]}
        </span>
        {stage !== 'done' && (
          <button
            onClick={() => void cancelRace()}
            title="中止赛马（角色会话与产物保留）"
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ink-faint transition hover:bg-bg-hover hover:text-err"
          >
            <OctagonX size={13} /> 中止
          </button>
        )}
      </div>

      <RaceCircuit stage={stage} repairRound={race.repairRound} viewing={shown} onPick={setViewStage} />

      {reviewing && (
        <div className="mx-6 mb-2 flex items-center gap-3 rounded-lg border border-line bg-bg-input px-3 py-2 text-[12px]">
          <span className="flex-1 text-ink-soft">
            👁 正在回看「{RACE_STAGE_LABELS[shown]}」环节（只读）· 赛马仍在后台按实际进度继续，不受影响。
          </span>
          <button
            onClick={() => setViewStage(null)}
            className="shrink-0 rounded-lg border border-line px-3 py-1 text-[12px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
          >
            → 回到当前进度（{RACE_STAGE_LABELS[stage]}）
          </button>
        </div>
      )}

      {race.interrupted && stage !== 'done' && (
        <div className="mx-6 mb-2 flex items-center gap-3 rounded-lg border border-warn bg-bg-input px-3 py-2 text-[12px]">
          <span className="flex-1 text-warn">
            ⚠ 此赛马被应用重启打断（当前阶段：{RACE_STAGE_LABELS[stage]}），继续将重跑该阶段。
          </span>
          <button
            onClick={() => void resumeRace()}
            className="shrink-0 rounded-lg bg-accent px-3 py-1 text-[12px] font-semibold text-white transition hover:opacity-90"
          >
            ▶ 继续赛马
          </button>
        </div>
      )}

      {error && (
        <div className="mx-6 mb-2 flex items-center gap-3 rounded-lg border border-err bg-bg-input px-3 py-2 text-[12px]">
          <CircleAlert size={13} className="shrink-0 text-err" />
          <span className="min-w-0 flex-1 text-err">{error}</span>
          {stage !== 'done' && (
            <>
              {/* 裁判出方案前被中止/报错 → 可反悔回选策略关口（而非按原策略重跑） */}
              {stage === 'judging' && race.adopt && !race.finalPlan && (
                <button
                  onClick={() => void useRaceStore.getState().revokeAdopt()}
                  title="撤回采纳决策，回到「选择采纳策略」重选"
                  className="shrink-0 rounded-lg border border-line px-3 py-1 text-[12px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
                >
                  ↩ 重新选择策略
                </button>
              )}
              <button
                onClick={openTune}
                title="调整选手 A/B 的引擎/模型/思考档，保存后重试生效"
                className="shrink-0 rounded-lg border border-line px-3 py-1 text-[12px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
              >
                ⚙ 调整选手
              </button>
              <button
                onClick={() => void resumeRace()}
                className="shrink-0 rounded-lg bg-accent px-3 py-1 text-[12px] font-semibold text-white transition hover:opacity-90"
              >
                ↻ 重试当前阶段
              </button>
            </>
          )}
        </div>
      )}

      {/* 全阶段整页锁滞（无总体滚动条），滚动区按信息主体划分：
          竞速 = 泳道内滚；裁判 = 产物预览弹性内滚 + 裁判台固定下部；
          执行 = 执行泳道内滚 + 审计/操作区固定。 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-6">
        {reviewing ? (
          <ReviewStageView race={race} stage={shown} />
        ) : (
          <>
            {racing && <DualLanes race={race} running fill />}

            {stage === 'judging' && (
              <>
                {/* 冻结产物干净预览 —— 占上部弹性空间，每栏各自内滚 */}
                <div className="min-h-0 flex-1 overflow-hidden">
                  <ArtifactsPreview race={race} fill />
                </div>
                {/* 裁判台固定下部，始终可见；不给容器级滚动条 —— 评审态
                    头/尾固定、方案内容区内滚（JudgePanel 内部分区滚动） */}
                <div className="flex max-h-[56vh] min-h-0 shrink-0 flex-col overflow-hidden pt-3">
                  <JudgePanel race={race} />
                </div>
              </>
            )}

            {buildish && <BuilderSection race={race} />}
          </>
        )}
      </div>

      <RoleTuneDialog />
    </div>
  );
}

/** 竞速泳道：参赛选手（2–3 位）并排，中间细分道线。冲线 = 本阶段
 *  产物已落盘；已停止的选手就地 ↻ 单独重试（不等其它选手）；
 *  三人以上在场时可 ✂ 剔除。被剔选手不占泳道（不展示残留卡），
 *  会话与产物仍持久化保留。 */
function DualLanes({ race, running, fill = false }: { race: RaceGroup; running: boolean; fill?: boolean }): JSX.Element {
  const retryRacer = useRaceStore((s) => s.retryRacer);
  const eliminateRacer = useRaceStore((s) => s.eliminateRacer);
  const art = race.artifacts ?? {};
  const planStage = race.stage === 'planning';
  const racers = RACER_ROLES.filter((r) => !!race.roles[r] && !race.eliminated?.includes(r));
  const canEliminate = running && racers.length > 2;
  const finishedOf = (r: RacerRole): boolean => {
    if (!running) return true;
    if (r === 'racerA') return planStage ? !!art.planA : !!art.rebuttalA;
    if (r === 'racerB') return planStage ? !!art.planB : !!art.rebuttalB;
    return planStage ? !!art.planC : !!art.rebuttalC;
  };
  const toneOf = (r: RacerRole): 'a' | 'b' | 'neutral' => (r === 'racerA' ? 'a' : r === 'racerB' ? 'b' : 'neutral');
  return (
    <div className={`mx-auto flex w-full ${racers.length > 2 ? 'max-w-7xl' : 'max-w-5xl'} gap-4 ${fill ? 'min-h-0 flex-1' : ''}`}>
      {racers.map((r, i) => {
        const id = race.sessions[r];
        return (
          <div key={r} className={`flex min-w-0 flex-1 ${fill ? 'min-h-0' : ''}`}>
            {i > 0 && <div className="mr-4 w-px shrink-0 bg-line" />}
            <RaceLane
              title={RACE_ROLE_LABELS[r]}
              subtitle={roleSubtitle(race, r)}
              sessionId={id}
              tone={toneOf(r)}
              running={running}
              fill={fill}
              finished={finishedOf(r)}
              onStop={id ? () => void window.cyberslots.sessionCancel(id) : undefined}
              onRetry={() => void retryRacer(r)}
              onEliminate={canEliminate ? () => void eliminateRacer(r) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

/** 回看某个已完成阶段的内容（均只读，不提供任何可变操作）：
 *  双规划/交叉反驳 → 产物干净预览（各选手方案 + 反驳）；
 *  裁判 → 最终方案只读；执行/修复/审计 → 执行泳道 + 审计结果。 */
function ReviewStageView({ race, stage }: { race: RaceGroup; stage: RaceStage }): JSX.Element {
  if (stage === 'planning' || stage === 'rebuttal') {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <ArtifactsPreview race={race} fill />
      </div>
    );
  }
  if (stage === 'judging') {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <JudgePanel race={race} readOnly />
      </div>
    );
  }
  // building / repairing / auditing
  return <BuilderSection race={race} review />;
}

/** 打开 Builder 会话（先刷新会话列表 —— 角色会话由主进程创建，
 *  renderer 列表未必已收录）；selectSession 会自动退出赛马视图。 */
async function openBuilderSession(sessionId: string): Promise<void> {
  const sessions = await window.cyberslots.sessionList();
  useChatStore.setState({ sessions });
  useChatStore.getState().selectSession(sessionId);
}

/** Builder 执行 + 独立审计 + 完成横幅。锁滞布局：执行泳道占满弹性
 *  高度内滚；审计卡/操作行固定下部，问题清单超长时自身内滚。
 *  review=回看只读：泳道不当作运行中（无中止按钮），不重复展示完成横幅/统计。 */
function BuilderSection({ race, review = false }: { race: RaceGroup; review?: boolean }): JSX.Element {
  const building = !review && (race.stage === 'building' || race.stage === 'repairing');
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3">
      <RaceLane
        title="执行者"
        badge="🔨"
        subtitle={roleSubtitle(race, 'builder')}
        sessionId={race.sessions.builder}
        tone="neutral"
        running={building}
        fill
        onStop={
          race.sessions.builder ? () => void window.cyberslots.sessionCancel(race.sessions.builder!) : undefined
        }
      />

      {race.sessions.builder && (
        <button
          onClick={() => void openBuilderSession(race.sessions.builder!)}
          className="shrink-0 self-start text-[12px] text-accent transition hover:underline"
        >
          ↗ 打开执行会话 —— 右侧「变更」面板可逐文件查看 diff / 拒绝回退
        </button>
      )}

      {(race.audit || race.stage === 'auditing') && (
        <div className="max-h-[36vh] shrink-0 overflow-y-auto rounded-2xl border border-line bg-bg-panel/70 p-4">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink">
            🛡 独立审计
            <span className="font-mono text-[10.5px] font-normal text-ink-faint">{roleSubtitle(race, 'auditor')}</span>
          </div>
          {race.stage === 'auditing' ? (
            <div className="flex flex-col items-center gap-2 py-3 text-[12px] text-ink-soft">
              {/* 面板横幅按规范用 BrandHero — 13px 三星在此场景退化成“横着动的三个点”，无品牌辨识度 */}
              <BrandHero size={48} />
              审计中（对照最终方案复查执行改动）…
            </div>
          ) : race.audit?.passed ? (
            <div className="text-[13px] font-semibold text-accent">✓ 审计通过 · 方案可交付</div>
          ) : race.audit ? (
            <>
              <div className="text-[13px] font-semibold text-err">✗ 未通过 · {race.audit.issues.length} 处问题</div>
              <ul className="mt-2 space-y-1 text-[12px] text-ink-soft">
                {race.audit.issues.map((it, i) => (
                  <li key={i}>· {it}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      )}

      {race.stage === 'done' && !review && (
        <>
          <div className="shrink-0 rounded-2xl border border-line bg-bg-panel/70 p-4 text-[13px] text-ink">
            {race.audit?.passed ? '🏁 赛马完成，审计通过，成果已交付。' : '🏁 赛马已结束。'}
            <span className="ml-1 text-[12px] text-ink-faint">角色会话已保留，可在侧栏继续对话或查看变更。</span>
          </div>
          <RaceStatsCard race={race} />
        </>
      )}
    </div>
  );
}
