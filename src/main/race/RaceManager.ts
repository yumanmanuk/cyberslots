/**
 * RaceManager — composition root for the race feature. It owns the
 * RaceOrchestrator and implements `RaceSessionHost` by delegating to
 * SessionManager (role sessions) and the renderer bridge (race events),
 * plus persisting race groups to disk.
 *
 * This is the ONLY place that couples the (pure) orchestrator to the
 * concrete session layer and Electron IPC, keeping both sides testable.
 */

import { app } from 'electron';
import type { WebContents } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { IPC } from '@shared/ipc';
import type { EngineEvent } from '@shared/types';
import type { RaceAdoptStrategy, RaceCreateRequest, RaceEvent, RaceEventEnvelope, RaceGroup } from '@shared/race';
import type { SessionManager } from '../engine/SessionManager';
import { RaceOrchestrator, type RaceSessionHost, type RaceSpawnSpec } from './RaceOrchestrator';

export class RaceManager implements RaceSessionHost {
  private target: WebContents | undefined;
  private readonly orchestrator: RaceOrchestrator;

  constructor(private readonly sessions: SessionManager) {
    this.orchestrator = new RaceOrchestrator(this, this.loadPersisted());
  }

  /** Renderer webContents that receives race events. */
  attach(target: WebContents): void {
    this.target = target;
  }

  // ---------------------------------------------------- public API (IPC)

  create(req: RaceCreateRequest): RaceGroup {
    return this.orchestrator.create(req);
  }

  list(): RaceGroup[] {
    return this.orchestrator.list();
  }

  get(raceId: string): RaceGroup | null {
    return this.orchestrator.get(raceId) ?? null;
  }

  /** 用户选定采纳策略（+可选评语）→ 裁判产出最终方案。 */
  adopt(raceId: string, strategy: RaceAdoptStrategy, comment?: string): void {
    this.orchestrator.adoptStrategy(raceId, strategy, comment);
  }

  revise(raceId: string, annotation: string): void {
    this.orchestrator.reviseJudge(raceId, annotation);
  }

  finalize(raceId: string): void {
    this.orchestrator.finalize(raceId);
  }

  cancel(raceId: string): void {
    this.orchestrator.cancel(raceId);
  }

  // ------------------------------------------------ RaceSessionHost impl

  async spawn(spec: RaceSpawnSpec): Promise<string> {
    const meta = await this.sessions.create({
      engine: spec.engine,
      cwd: spec.cwd,
      modelId: spec.modelId,
      permissionMode: spec.permissionMode,
      title: spec.title,
    });
    return meta.id;
  }

  prompt(sessionId: string, text: string, effort?: string): Promise<void> {
    return this.sessions.prompt(sessionId, text, undefined, effort);
  }

  transcript(sessionId: string): string {
    return this.sessions.transcript(sessionId);
  }

  changesDigest(sessionId: string): Promise<string> {
    return this.sessions.changesDigest(sessionId);
  }

  onTurnEnded(sessionId: string, cb: (stopReason: string) => void): () => void {
    return this.sessions.subscribe(sessionId, (event: EngineEvent) => {
      if (event.type === 'turn.ended') cb(event.stopReason);
    });
  }

  emit(raceId: string, event: RaceEvent): void {
    const envelope: RaceEventEnvelope = { raceId, event, ts: Date.now() };
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(IPC.raceEvent, envelope);
    }
  }

  persist(groups: RaceGroup[]): void {
    try {
      writeFileSync(this.storeFile, JSON.stringify(groups, null, 2), 'utf8');
    } catch (err) {
      console.error('[race] persist failed:', err);
    }
  }

  // ---------------------------------------------------------------- private

  private get storeFile(): string {
    return join(app.getPath('userData'), 'races.json');
  }

  private loadPersisted(): RaceGroup[] {
    try {
      if (!existsSync(this.storeFile)) return [];
      const groups = JSON.parse(readFileSync(this.storeFile, 'utf8')) as RaceGroup[];
      // Engine role sessions did not survive a restart; mark any in-flight
      // race as done so the UI doesn't wait forever on dead sessions.
      return groups.map((g) => (g.stage === 'done' ? g : { ...g, stage: 'done' as const }));
    } catch (err) {
      console.error('[race] load failed:', err);
      return [];
    }
  }
}
