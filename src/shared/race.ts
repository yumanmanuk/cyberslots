/**
 * Race domain model — the engine-agnostic language for the "大模型赛马"
 * (competitive planning) workflow, shared between main (orchestrator),
 * preload bridge, and renderer (race view/store).
 *
 * A `RaceGroup` is an orchestration layer that OWNS several ordinary engine
 * sessions, one per role. Each role can be configured with its own engine /
 * model / thinking-effort. Only the Builder role writes to disk; every other
 * role runs read-only, so concurrent role sessions never collide.
 *
 * This file is dependency-free (types + pure helpers only) so both processes
 * can import it without pulling in Electron/engine code.
 */

import type { EngineId, PermissionMode } from './types';

// ------------------------------------------------------------------ roles

/** The participants of a race（racerC 为可选第三选手）.
 *  preJudge 为编排器内部临时角色（AI 初审），复用 judge 配置但拥有独立会话，
 *  不计入 RACE_ROLES（配置 UI 不展示），仅用于 sessions/preJudgeRecommendation。 */
export type RaceRole = 'racerA' | 'racerB' | 'racerC' | 'judge' | 'builder' | 'auditor' | 'preJudge';

export const RACE_ROLES: readonly RaceRole[] = ['racerA', 'racerB', 'racerC', 'judge', 'builder', 'auditor'] as const;

/** 选手角色子集（A/B 必选，C 可选）。 */
export const RACER_ROLES = ['racerA', 'racerB', 'racerC'] as const;
export type RacerRole = (typeof RACER_ROLES)[number];

/** Per-role engine/model/effort selection — satisfies "自定义各角色". */
export interface RaceRoleConfig {
  engine: EngineId;
  modelId: string;
  /** Reasoning effort (codex/opencode); undefined = engine default. */
  effort?: string;
  /**
   * Permission mode override. Omitted → resolved by role:
   * builder gets a writable mode, everyone else read-only.
   */
  permissionMode?: PermissionMode;
}

export interface RaceRoleConfigs {
  racerA: RaceRoleConfig;
  racerB: RaceRoleConfig;
  /** 第三选手（可选）。 */
  racerC?: RaceRoleConfig;
  judge: RaceRoleConfig;
  builder: RaceRoleConfig;
  auditor: RaceRoleConfig;
  /** AI 初审角色配置（可选；未配置时 fallback 到 judge 配置兼容旧数据）。 */
  preJudge?: RaceRoleConfig;
}

// ----------------------------------------------------------------- stages

/**
 * Linear happy-path stages plus the `repairing` branch. Transitions are
 * driven by engine turn-completion events and explicit user actions
 * (annotate / revise / finalize); see RaceOrchestrator.
 */
export type RaceStage =
  | 'config' // configuring roles, not started
  | 'planning' // racerA ∥ racerB plan in parallel (read-only)
  | 'rebuttal' // cross-critique + symmetric defense, plans frozen
  | 'judging' // judge fuses both into ONE final plan; annotate/revise loop
  | 'building' // builder executes the finalized plan (writes)
  | 'auditing' // independent auditor reviews the diff
  | 'repairing' // audit failed → builder repairs (bounded loop)
  | 'done';

export const RACE_STAGE_ORDER: readonly RaceStage[] = [
  'config',
  'planning',
  'rebuttal',
  'judging',
  'building',
  'auditing',
  'done',
] as const;

/** Human labels (zh) for the circuit HUD / stage tag. */
export const RACE_STAGE_LABELS: Record<RaceStage, string> = {
  config: '配置',
  planning: '双规划',
  rebuttal: '交叉反驳',
  judging: '裁判融合',
  building: '执行',
  auditing: '独立审计',
  repairing: '修复回环',
  done: '完成',
};

export const RACE_ROLE_LABELS: Record<RaceRole, string> = {
  racerA: '选手 A',
  racerB: '选手 B',
  racerC: '选手 C',
  judge: '裁判',
  builder: '执行者',
  auditor: '审计',
  preJudge: '初审',
};

/** Terminal stages carry no further engine work. */
export function isTerminalStage(stage: RaceStage): boolean {
  return stage === 'done';
}

/**
 * 宿主对话已归档 → 赛马视为一并收纳：不进总控台泳道/待办列，
 * 也不计入角标。赛马寄生于宿主对话（侧栏无独立入口），归档宿主
 * 即用户对整条任务线「收起」的表达；还原宿主后赛马自动回来。
 * 无宿主的赛马（总控台直接发起）不受影响。
 */
export function raceHostArchived(g: RaceGroup, archivedSessionIds: ReadonlySet<string>): boolean {
  return g.parentSessionId != null && archivedSessionIds.has(g.parentSessionId);
}

/**
 * 赛马正在进行（占用引擎回合或等用户决策/批注，未被打断）——
 * 宿主对话归档拦截用：被打断的赛马已停摆，允许归档宿主一并收纳。
 */
export function isRaceActive(g: RaceGroup): boolean {
  return g.stage !== 'done' && g.stage !== 'config' && !g.interrupted;
}

/**
 * Read-only permission mode per engine, mirroring the sidechat convention:
 * codex/opencode/omp/claude use `plan` (read-only sandbox); kimi 与 antigravity
 * 没有可用的只读沙箱 —— 赛马无人值守跑长链路，泳道又没有审批操作区：
 * kimi 用 `default`（手动审批）会永久挂起（审批死锁）；agy headless
 * 的 plan/default 不带 --dangerously-skip-permissions，工具调用被软拒，
 * 选手连文件都读不了，只会产出一句「让我获取访问权限」就交卷。
 * 两者都强制 `auto` 自动批准，只读约束由 READONLY_GUARD 提示词护栏兑底。
 * claude 的 plan 是引擎级真只读沙箱（且适配器在非 default 模式自动放行
 * can_use_tool，不会死锁），故与 codex 同走 plan。
 */
export function readOnlyMode(engine: EngineId): PermissionMode {
  return engine === 'kimi' || engine === 'antigravity' ? 'auto' : 'plan';
}

/** Resolve the effective permission mode for a role at spawn time. */
export function resolveRoleMode(role: RaceRole, cfg: RaceRoleConfig): PermissionMode {
  if (cfg.permissionMode) return cfg.permissionMode;
  // Only the builder writes; repairs reuse the builder session.
  if (role === 'builder') return 'auto';
  return readOnlyMode(cfg.engine);
}

// ------------------------------------------------------------- race group

/** 裁判阶段的采纳策略 —— 由用户先选，裁判据此产出最终方案：
 *  adoptX = 采纳单方；preferX = 以某选手为准、融合其余选手优点。 */
export type RaceAdoptStrategy = 'adoptA' | 'adoptB' | 'adoptC' | 'preferA' | 'preferB' | 'preferC';

export const RACE_ADOPT_LABELS: Record<RaceAdoptStrategy, string> = {
  adoptA: '采纳 A',
  adoptB: '采纳 B',
  adoptC: '采纳 C',
  preferA: '以 A 为准，结合其余',
  preferB: '以 B 为准，结合其余',
  preferC: '以 C 为准，结合其余',
};

/** 策略展示名（兼容旧数据 aOverB/bOverA 与未知值）。 */
export function adoptLabel(strategy: string): string {
  if (strategy === 'aOverB') return RACE_ADOPT_LABELS.preferA;
  if (strategy === 'bOverA') return RACE_ADOPT_LABELS.preferB;
  return (RACE_ADOPT_LABELS as Record<string, string>)[strategy] ?? strategy;
}

/** 用户的采纳决策：策略 + 可选评语（作为裁判出方案的指导意见）。 */
export interface RaceAdoptDecision {
  strategy: RaceAdoptStrategy;
  comment?: string;
}

// ---------------------------------------------------------- AI 初审 (pre-judge)

/**
 * AI 初审模式 —— 在裁判选策略前是否由 AI 先评审各方方案并给出推荐。
 *  - off：纯人工 4 选 1（默认，现状不变）
 *  - suggest：AI 出推荐策略 + 理由，用户可一键采纳或自己改（半自动）
 *  - designate：赛前指定信任选手 + 采纳策略，选手完赛后自动按预置策略走裁判出方案 → 执行（零延迟，人工预决策）
 *  - auto：AI 推荐 → 自动采纳 → 跳过批注定稿 → 直接进 builder（端到端无人值守，审计兜底）
 */
export type RacePreJudgeMode = 'off' | 'suggest' | 'designate' | 'auto';

/** AI 初审的推荐结果：建议策略 + 展示用 markdown 详情（含理由与各选手点评）。 */
export interface RacePreJudgeRecommendation {
  /** AI 推荐的采纳策略。 */
  strategy: RaceAdoptStrategy;
  /** 一句话结论（banner 展示用，≤60 字）。 */
  summary: string;
  /** 完整 markdown 详情（弹窗展开用：推荐策略 / 推荐理由 / 各选手点评）。 */
  detail: string;
}

/** Audit outcome for the current build. */
export interface RaceAuditResult {
  passed: boolean;
  issues: string[];
  /** Full markdown body from the auditor (for rich preview). */
  body?: string;
}

// -------------------------------------------------------------- run stats

/** 有实际工作量的阶段（config/done 不计时不计量）。 */
export type RaceWorkStage = Exclude<RaceStage, 'config' | 'done'>;

/** 统计卡的阶段展示顺序（repairing 排在 auditing 之后）。 */
export const RACE_WORK_STAGES: readonly RaceWorkStage[] = [
  'planning',
  'rebuttal',
  'judging',
  'building',
  'auditing',
  'repairing',
] as const;

/**
 * 单阶段累计统计：用时为墙钟累计（重试/回炉/修复回环都累加，judging
 * 含用户决策与批注等待）；token 为该阶段各角色回合 usage 之和。
 * 注意：kimi code 会话无真实 token 上报（仅字符数估算），一律不参与
 * token 统计（与主进程用量统计口径一致），用时照常计入。
 */
export interface RaceStageStats {
  durationMs: number;
  /** 上行 token（含缓存命中部分，语义同 UsageInfo.inputTokens）。 */
  inputTokens: number;
  /** 下行 token。 */
  outputTokens: number;
}

export type RaceStats = Partial<Record<RaceWorkStage, RaceStageStats>>;

/**
 * 双方冻结产物：plan 文档与「攻击对方/自我辩驳」正文（裁判阶段干净
 * 预览用，不含思考/工具过程噪音）。规划、反驳回合结束时由编排器
 * 捕获并随 RaceGroup 持久化。
 */
export interface RaceArtifacts {
  planA?: string;
  planB?: string;
  planC?: string;
  rebuttalA?: string;
  rebuttalB?: string;
  rebuttalC?: string;
}

/**
 * A race group: the orchestration record. Role sessions are ordinary engine
 * sessions created lazily as stages progress; their app-level ids live in
 * `sessions`. Persisted alongside SessionMeta so a race can resume after
 * restart from its `stage`.
 */
export interface RaceGroup {
  id: string;
  /** The shared task prompt both racers plan against. */
  prompt: string;
  /** Working directory: builder writes here; other roles read-only. */
  cwd: string;
  roles: RaceRoleConfigs;
  stage: RaceStage;
  /** App-level session id per role (filled as the role's session is created). */
  sessions: Partial<Record<RaceRole, string>>;
  /** 用户的采纳决策；undefined = judging 阶段仍在等用户选策略。 */
  adopt?: RaceAdoptDecision;
  /** 双方冻结产物（plan 文档 + 反驳辩驳），裁判阶段预览用。 */
  artifacts?: RaceArtifacts;
  /** Judge's fused final plan (latest version); undefined until judging. */
  finalPlan?: string;
  /** Bumps each time the judge revises after a user annotation (starts at 1). */
  finalPlanVersion: number;
  /** User annotations fed back to the judge, in submission order. */
  annotations: string[];
  /** Latest audit outcome (set during auditing). */
  audit?: RaceAuditResult;
  /** 是否已作为成果交付（审计通过，或审计未通过但用户人工放行）。 */
  delivered?: boolean;
  /** 审计未通过但用户人工放行交付（overrideAudit）。UI/结果卡片据此显示
   *  「人工放行」而非普通「已交付」，避免把流程放行误读为审计通过/已实施。 */
  auditOverridden?: boolean;
  /** 各阶段累计用时/上下行 token（kimi 会话不计 token，见 RaceStageStats）。 */
  stats?: RaceStats;
  /** Repair loop counter and its bound (prevents infinite audit↔repair). */
  repairRound: number;
  maxRepairRounds: number;
  /** 引擎回合被应用重启打断；由用户点「继续赛马」重跑当前阶段。
   *  judging 的纯等待态（等选策略/等批注定稿）不算打断，原样恢复。 */
  interrupted?: boolean;
  /** Set when the race was started mid-conversation (forked context source). */
  parentSessionId?: string;
  /** 被剔除的选手（标记式，不删数据）：退出后续回合与裁判输入；
   *  会话/产物保留可查。仅三人及以上在场且裁判选策略前可剔，剩余 ≥2。 */
  eliminated?: RacerRole[];
  /** 发起对话的压缩摘录（可选）：注入双选手规划回合作为背景资料。 */
  contextSeed?: string;
  /** AI 初审模式（发令时选定，整场不变）；省略 = off（纯人工）。 */
  preJudgeMode?: RacePreJudgeMode;
  /** AI 初审推荐结果；undefined = 尚未产出或已被忽略/降级。
   *  auto 模式下产出后会立即自动采纳（写入 adopt），此字段仍保留供回看。 */
  preJudgeRecommendation?: RacePreJudgeRecommendation;
  /** designate 模式下用户预置的采纳策略；选手完赛后自动采纳，跳过 AI 初审和人工选择。 */
  designateStrategy?: RaceAdoptStrategy;
  /** designate 模式下的评语（指导裁判出方案）。 */
  designateComment?: string;
  createdAt: number;
  updatedAt: number;
}

/** Sidebar/summary view of a race (no heavy fields). */
export interface RaceGroupMeta {
  id: string;
  prompt: string;
  stage: RaceStage;
  finalPlanVersion: number;
  createdAt: number;
  updatedAt: number;
}

export function toRaceGroupMeta(g: RaceGroup): RaceGroupMeta {
  return {
    id: g.id,
    prompt: g.prompt,
    stage: g.stage,
    finalPlanVersion: g.finalPlanVersion,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

// --------------------------------------------------------------- requests

/** Create a new race from scratch (config stage). */
export interface RaceCreateRequest {
  prompt: string;
  cwd: string;
  roles: RaceRoleConfigs;
  /** When set, the race inherits this session's context as the racers' seed. */
  parentSessionId?: string;
  /** 发起对话的压缩摘录（可选，随 parentSessionId 一起传）。 */
  contextSeed?: string;
  /** Default 3; audit↔repair loop bound. */
  maxRepairRounds?: number;
  /** AI 初审模式；省略 = off（纯人工 4 选 1）。 */
  preJudgeMode?: RacePreJudgeMode;
  /** designate 模式下预置的采纳策略（如 'adoptA'/'preferB'）+ 可选评语。
   *  仅 preJudgeMode === 'designate' 时有效。 */
  designateStrategy?: RaceAdoptStrategy;
  /** designate 模式下的评语（指导裁判出方案）。 */
  designateComment?: string;
}

// ----------------------------------------------------------------- events
// main → renderer race-level orchestration signals. Per-role token streams
// are NOT here — the renderer subscribes to each role session's normal
// engine events (chatStore) and renders them in the lanes.

export type RaceEvent =
  /** Stage machine advanced. */
  | { type: 'race.stage'; stage: RaceStage }
  /** A role's engine session was created/assigned (lane can now subscribe). */
  | { type: 'race.role'; role: RaceRole; sessionId: string }
  | { type: 'race.eliminated'; role: RacerRole }
  /** 规划/反驳回合结束，冻结产物更新（裁判阶段预览用）。 */
  | { type: 'race.artifacts'; artifacts: RaceArtifacts }
  /** Judge produced/updated the fused final plan. */
  | { type: 'race.finalPlan'; version: number; text: string }
  /** Auditor returned a verdict. */
  | { type: 'race.audit'; passed: boolean; issues: string[]; body?: string; repairRound: number }
  /** 阶段用时/token 统计更新（阶段收尾或角色回合记账时推送）。 */
  | { type: 'race.stats'; stats: RaceStats }
  /** Recoverable orchestration error (a role failed, etc.). */
  | { type: 'race.error'; message: string; role?: RaceRole }
  /** Whole race finished (audit passed, repair budget exhausted, or user
   *  override). `overridden` = 审计未通过但用户人工放行交付。 */
  | { type: 'race.done'; delivered: boolean; overridden?: boolean }
  // ---- AI 初审（pre-judge）事件 ----
  /** AI 初审开始评审（UI 进入"AI 评审中"等待态）。 */
  | { type: 'race.preJudgeReviewing' }
  /** AI 初审推荐结果已产出（UI 显示 banner + 一键采纳）。 */
  | { type: 'race.preJudgeRecommendation'; recommendation: RacePreJudgeRecommendation }
  /** 全自动模式：AI 已自动采纳建议，即将进入方案生成（UI 显示只读过场）。 */
  | { type: 'race.preJudgeAutoAdopted'; strategy: RaceAdoptStrategy }
  /** AI 初审不可用（失败/超时/解析失败），降级为纯人工 4 选 1。 */
  | { type: 'race.preJudgeUnavailable'; reason: string }
  /** 全自动模式：裁判出方案后自动定稿，跳过批注环节直接进 builder。 */
  | { type: 'race.autoFinalized'; version: number };

export interface RaceEventEnvelope {
  raceId: string;
  event: RaceEvent;
  ts: number;
}
