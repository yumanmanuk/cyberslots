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

/** The participants of a race（racerC 为可选第三选手）. */
export type RaceRole = 'racerA' | 'racerB' | 'racerC' | 'judge' | 'builder' | 'auditor';

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
};

/** Terminal stages carry no further engine work. */
export function isTerminalStage(stage: RaceStage): boolean {
  return stage === 'done';
}

/**
 * Read-only permission mode per engine, mirroring the sidechat convention:
 * codex/opencode/omp use `plan` (read-only sandbox); kimi has no read-only
 * mode —— 赛马无人值守跑长链路，泳道又没有审批操作区，kimi 若用
 * `default`（手动审批）弹权限请求会永久挂起（审批死锁），故强制
 * `auto` 自动批准，只读约束由 READONLY_GUARD 提示词护栏兑底。
 */
export function readOnlyMode(engine: EngineId): PermissionMode {
  return engine === 'kimi' ? 'auto' : 'plan';
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

/** Audit outcome for the current build. */
export interface RaceAuditResult {
  passed: boolean;
  issues: string[];
}

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
  | { type: 'race.audit'; passed: boolean; issues: string[]; repairRound: number }
  /** Recoverable orchestration error (a role failed, etc.). */
  | { type: 'race.error'; message: string; role?: RaceRole }
  /** Whole race finished (audit passed or repair budget exhausted). */
  | { type: 'race.done'; delivered: boolean };

export interface RaceEventEnvelope {
  raceId: string;
  event: RaceEvent;
  ts: number;
}
