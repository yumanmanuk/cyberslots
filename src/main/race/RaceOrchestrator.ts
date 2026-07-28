/**
 * RaceOrchestrator — drives a RaceGroup through its stage machine:
 *
 *   planning(A∥B) → rebuttal(A⇄B, plans frozen) → judging(fuse→annotate/revise)
 *     → building → auditing → (repair↺auditing, bounded) → done
 *
 * It owns race state and control flow only. All session side effects go
 * through the injected `RaceSessionHost` seam, so the orchestrator is
 * decoupled from SessionManager and unit-testable in isolation.
 *
 * Invariant: only the Builder role writes to disk; every other role runs
 * read-only (plan mode / kimi read-only guard), so concurrent role sessions
 * in the same cwd never collide.
 */

import { randomUUID } from 'node:crypto';

import type { EngineId, PermissionMode } from '@shared/types';
import type {
  RaceAdoptStrategy,
  RaceCreateRequest,
  RaceEvent,
  RaceGroup,
  RaceRole,
  RaceRoleConfig,
  RaceStage,
} from '@shared/race';
import { resolveRoleMode } from '@shared/race';
import {
  auditPrompt,
  builderPrompt,
  judgeFusePrompt,
  judgeRevisePrompt,
  parseAuditVerdict,
  planPrompt,
  rebuttalPrompt,
  repairPrompt,
  roleSessionTitle,
  withGuard,
} from './racePrompts';

/** Session spawn spec handed to the host. */
export interface RaceSpawnSpec {
  engine: EngineId;
  cwd: string;
  modelId: string;
  permissionMode: PermissionMode;
  title: string;
}

/**
 * The seam between the orchestrator and the session/engine layer.
 * Implemented by a thin adapter over SessionManager (see main wiring).
 */
export interface RaceSessionHost {
  /** Create a role session; resolves to its app-level session id. */
  spawn(spec: RaceSpawnSpec): Promise<string>;
  /** Dispatch a prompt to a session (awaits engine readiness internally). */
  prompt(sessionId: string, text: string, effort?: string): Promise<void>;
  /** Fold a session's assistant output into plain text (for hand-off). */
  transcript(sessionId: string): string;
  /** A textual digest of the builder's file changes (for the auditor). */
  changesDigest(sessionId: string): Promise<string>;
  /** Subscribe to one turn completion on a session; returns unsubscribe. */
  onTurnEnded(sessionId: string, cb: (stopReason: string) => void): () => void;
  /** Push a race-level event to the renderer. */
  emit(raceId: string, event: RaceEvent): void;
  /** Persist the current set of race groups. */
  persist(groups: RaceGroup[]): void;
}

/** Transient per-race artifacts (plans/rebuttals), not persisted. */
interface RaceArtifacts {
  planA: string;
  planB: string;
  rebuttalA: string;
  rebuttalB: string;
}

const DEFAULT_MAX_REPAIR = 3;

export class RaceOrchestrator {
  private readonly groups = new Map<string, RaceGroup>();
  private readonly artifacts = new Map<string, RaceArtifacts>();

  constructor(private readonly host: RaceSessionHost, persisted?: RaceGroup[]) {
    for (const g of persisted ?? []) this.groups.set(g.id, g);
  }

  list(): RaceGroup[] {
    return [...this.groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(raceId: string): RaceGroup | undefined {
    return this.groups.get(raceId);
  }

  /** Start a new race: create the record and kick off planning. */
  create(req: RaceCreateRequest): RaceGroup {
    const now = Date.now();
    const g: RaceGroup = {
      id: randomUUID(),
      prompt: req.prompt,
      cwd: req.cwd,
      roles: req.roles,
      stage: 'planning',
      sessions: {},
      finalPlanVersion: 1,
      annotations: [],
      repairRound: 0,
      maxRepairRounds: req.maxRepairRounds ?? DEFAULT_MAX_REPAIR,
      parentSessionId: req.parentSessionId,
      createdAt: now,
      updatedAt: now,
    };
    this.groups.set(g.id, g);
    this.artifacts.set(g.id, { planA: '', planB: '', rebuttalA: '', rebuttalB: '' });
    this.touch(g);
    this.setStage(g, 'planning');
    void this.safe(g.id, () => this.runPlanning(g));
    return g;
  }

  /** 用户选定采纳策略（4 选 1 + 可选评语）→ 裁判据此产出最终方案 v1。 */
  adoptStrategy(raceId: string, strategy: RaceAdoptStrategy, comment?: string): void {
    const g = this.groups.get(raceId);
    if (!g || g.stage !== 'judging' || g.adopt) return;
    const judgeId = g.sessions.judge;
    if (!judgeId) return;
    g.adopt = { strategy, comment };
    this.touch(g);
    void this.safe(raceId, async () => {
      const cfg = g.roles.judge;
      const art = this.artifact(g.id);
      const plan = await this.runTurn(
        judgeId,
        withGuard(
          judgeFusePrompt(g.prompt, art.planA, art.planB, art.rebuttalA, art.rebuttalB, strategy, comment),
          this.needsGuard('judge', cfg),
        ),
        cfg.effort,
      );
      g.finalPlan = plan;
      g.finalPlanVersion = 1;
      this.touch(g);
      this.host.emit(g.id, { type: 'race.finalPlan', version: 1, text: plan });
    });
  }

  /** Judge revision loop: apply a user annotation and re-fuse. */
  reviseJudge(raceId: string, annotation: string): void {
    const g = this.groups.get(raceId);
    if (!g || g.stage !== 'judging') return;
    const judgeId = g.sessions.judge;
    if (!judgeId) return;
    g.annotations.push(annotation);
    this.touch(g);
    void this.safe(raceId, async () => {
      const cfg = g.roles.judge;
      const plan = await this.runTurn(
        judgeId,
        withGuard(judgeRevisePrompt(g.finalPlan ?? '', annotation), this.needsGuard('judge', cfg)),
        cfg.effort,
      );
      g.finalPlan = plan;
      g.finalPlanVersion += 1;
      this.touch(g);
      this.host.emit(g.id, { type: 'race.finalPlan', version: g.finalPlanVersion, text: plan });
    });
  }

  /** User approved the final plan → hand off to the Builder. */
  finalize(raceId: string): void {
    const g = this.groups.get(raceId);
    if (!g || g.stage !== 'judging' || !g.finalPlan) return;
    void this.safe(raceId, () => this.runBuilding(g));
  }

  /** Abort a race (best-effort): mark done; role sessions are left intact. */
  cancel(raceId: string): void {
    const g = this.groups.get(raceId);
    if (!g) return;
    this.finish(g, false);
  }

  // ------------------------------------------------------------- stages

  private async runPlanning(g: RaceGroup): Promise<void> {
    const [a, b] = await Promise.all([this.spawnRole(g, 'racerA'), this.spawnRole(g, 'racerB')]);
    const cfgA = g.roles.racerA;
    const cfgB = g.roles.racerB;
    const [planA, planB] = await Promise.all([
      this.runTurn(a, withGuard(planPrompt(g.prompt), this.needsGuard('racerA', cfgA)), cfgA.effort),
      this.runTurn(b, withGuard(planPrompt(g.prompt), this.needsGuard('racerB', cfgB)), cfgB.effort),
    ]);
    const art = this.artifact(g.id);
    art.planA = planA;
    art.planB = planB;
    await this.runRebuttal(g);
  }

  private async runRebuttal(g: RaceGroup): Promise<void> {
    this.setStage(g, 'rebuttal');
    const a = g.sessions.racerA!;
    const b = g.sessions.racerB!;
    const cfgA = g.roles.racerA;
    const cfgB = g.roles.racerB;
    const art = this.artifact(g.id);
    const [ra, rb] = await Promise.all([
      this.runTurn(a, withGuard(rebuttalPrompt(art.planA, art.planB), this.needsGuard('racerA', cfgA)), cfgA.effort),
      this.runTurn(b, withGuard(rebuttalPrompt(art.planB, art.planA), this.needsGuard('racerB', cfgB)), cfgB.effort),
    ]);
    art.rebuttalA = ra;
    art.rebuttalB = rb;
    await this.runJudging(g);
  }

  private async runJudging(g: RaceGroup): Promise<void> {
    this.setStage(g, 'judging');
    // 只预热裁判会话，不出方案 —— 等用户先选定采纳策略（adoptStrategy），
    // 再按策略 + 评语产出最终方案；之后进入批注/修订循环直到定稿。
    await this.spawnRole(g, 'judge');
  }

  private async runBuilding(g: RaceGroup): Promise<void> {
    this.setStage(g, 'building');
    const builderId = await this.spawnRole(g, 'builder');
    const cfg = g.roles.builder;
    // Builder writes — no read-only guard.
    await this.runTurn(builderId, builderPrompt(g.finalPlan ?? ''), cfg.effort);
    await this.runAuditing(g);
  }

  private async runAuditing(g: RaceGroup): Promise<void> {
    this.setStage(g, 'auditing');
    const builderId = g.sessions.builder!;
    const digest = await this.host.changesDigest(builderId);
    const auditorId = g.sessions.auditor ?? (await this.spawnRole(g, 'auditor'));
    const cfg = g.roles.auditor;
    const out = await this.runTurn(
      auditorId,
      withGuard(auditPrompt(g.finalPlan ?? '', digest), this.needsGuard('auditor', cfg)),
      cfg.effort,
    );
    const verdict = parseAuditVerdict(out);
    g.audit = verdict;
    this.touch(g);
    this.host.emit(g.id, {
      type: 'race.audit',
      passed: verdict.passed,
      issues: verdict.issues,
      repairRound: g.repairRound,
    });
    if (verdict.passed) return this.finish(g, true);
    if (g.repairRound >= g.maxRepairRounds) return this.finish(g, false);
    await this.runRepair(g, verdict.issues);
  }

  private async runRepair(g: RaceGroup, issues: string[]): Promise<void> {
    g.repairRound += 1;
    this.setStage(g, 'repairing');
    const builderId = g.sessions.builder!;
    const cfg = g.roles.builder;
    await this.runTurn(builderId, repairPrompt(issues), cfg.effort);
    await this.runAuditing(g);
  }

  private finish(g: RaceGroup, delivered: boolean): void {
    this.setStage(g, 'done');
    this.host.emit(g.id, { type: 'race.done', delivered });
  }

  // ------------------------------------------------------------- helpers

  /** Spawn a role's session, record it, and announce to the renderer. */
  private async spawnRole(g: RaceGroup, role: RaceRole): Promise<string> {
    const cfg = g.roles[role];
    const id = await this.host.spawn({
      engine: cfg.engine,
      cwd: g.cwd,
      modelId: cfg.modelId,
      permissionMode: resolveRoleMode(role, cfg),
      title: roleSessionTitle(role, g.prompt),
    });
    g.sessions[role] = id;
    this.touch(g);
    this.host.emit(g.id, { type: 'race.role', role, sessionId: id });
    return id;
  }

  /** Prompt a session and resolve with its transcript once the turn ends. */
  private runTurn(sessionId: string, text: string, effort?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const off = this.host.onTurnEnded(sessionId, () => {
        off();
        resolve(this.host.transcript(sessionId));
      });
      this.host.prompt(sessionId, text, effort).catch((err) => {
        off();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** kimi read-only roles need the prompt guard (no read-only sandbox mode). */
  private needsGuard(role: RaceRole, cfg: RaceRoleConfig): boolean {
    return role !== 'builder' && cfg.engine === 'kimi';
  }

  private setStage(g: RaceGroup, stage: RaceStage): void {
    g.stage = stage;
    this.touch(g);
    this.host.emit(g.id, { type: 'race.stage', stage });
  }

  private artifact(raceId: string): RaceArtifacts {
    let a = this.artifacts.get(raceId);
    if (!a) {
      a = { planA: '', planB: '', rebuttalA: '', rebuttalB: '' };
      this.artifacts.set(raceId, a);
    }
    return a;
  }

  private touch(g: RaceGroup): void {
    g.updatedAt = Date.now();
    this.host.persist(this.list());
  }

  /** Wrap an async stage chain; surface failures as a race error event. */
  private async safe(raceId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.host.emit(raceId, {
        type: 'race.error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
