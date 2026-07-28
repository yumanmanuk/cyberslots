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

/** The five participants of a race. */
export type RaceRole = 'racerA' | 'racerB' | 'judge' | 'builder' | 'auditor';

export const RACE_ROLES: readonly RaceRole[] = ['racerA', 'racerB', 'judge', 'builder', 'auditor'] as const;

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

export type RaceRoleConfigs = Record<RaceRole, RaceRoleConfig>;

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
  building: 'Builder 执行',
  auditing: '独立审计',
  repairing: '修复回环',
  done: '完成',
};

export const RACE_ROLE_LABELS: Record<RaceRole, string> = {
  racerA: '选手 A',
  racerB: '选手 B',
  judge: '裁判',
  builder: 'Builder',
  auditor: '审计',
};

/** Terminal stages carry no further engine work. */
export function isTerminalStage(stage: RaceStage): boolean {
  return stage === 'done';
}

/**
 * Read-only permission mode per engine, mirroring the sidechat convention:
 * codex/opencode use `plan` (read-only sandbox); kimi has no read-only mode
 * so it stays `default` and is constrained via a prompt guard instead.
 */
export function readOnlyMode(engine: EngineId): PermissionMode {
  return engine === 'kimi' ? 'default' : 'plan';
}

/** Resolve the effective permission mode for a role at spawn time. */
export function resolveRoleMode(role: RaceRole, cfg: RaceRoleConfig): PermissionMode {
  if (cfg.permissionMode) return cfg.permissionMode;
  // Only the builder writes; repairs reuse the builder session.
  if (role === 'builder') return 'auto';
  return readOnlyMode(cfg.engine);
}

// ------------------------------------------------------------- race group

/** 裁判阶段的采纳策略 —— 由用户先选（4 选 1），裁判据此产出最终方案。 */
export type RaceAdoptStrategy = 'adoptA' | 'adoptB' | 'aOverB' | 'bOverA';

export const RACE_ADOPT_LABELS: Record<RaceAdoptStrategy, string> = {
  adoptA: '采纳 A',
  adoptB: '采纳 B',
  aOverB: '以 A 为准，结合 B',
  bOverA: '以 B 为准，结合 A',
};

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
  /** Set when the race was started mid-conversation (forked context source). */
  parentSessionId?: string;
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
