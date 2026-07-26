/**
 * SessionManager — owns every live engine session: creates adapters,
 * routes their events to the renderer, persists session metadata, and
 * guarantees no orphan child processes on shutdown.
 */

import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebContents } from 'electron';

import type { EngineEvent, EngineEventEnvelope, PermissionMode, SessionMeta, UnifiedMessage } from '@shared/types';
import type { SessionCreateRequest } from '@shared/ipc';
import { IPC } from '@shared/ipc';
import type { EngineAdapter } from './EngineAdapter';
import { KimiAdapter } from './kimi/KimiAdapter';
import { ConfigWriter } from '../config/ConfigWriter';
import type { SettingsStore } from '../config/settings';

interface LiveSession {
  meta: SessionMeta;
  adapter: EngineAdapter | undefined;
}

export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly configWriter: ConfigWriter;
  private target: WebContents | undefined;

  constructor(private readonly settings: SettingsStore) {
    this.configWriter = new ConfigWriter(join(app.getPath('userData'), 'kimi-home'));
    this.loadPersistedMetas();
  }

  /** Renderer webContents that receives engine events. */
  attach(target: WebContents): void {
    this.target = target;
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()]
      .map((s) => s.meta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(req: SessionCreateRequest): Promise<SessionMeta> {
    const id = randomUUID();
    const settings = this.settings.get();
    const cwd = req.cwd || this.makeScratchDir(id);
    const meta: SessionMeta = {
      id,
      engine: req.engine,
      title: req.title ?? '新会话',
      cwd,
      chatMode: req.cwd ? 'work' : 'chat',
      modelId: req.modelId ?? settings.defaultModelId,
      permissionMode: req.permissionMode ?? settings.defaultPermissionMode,
      status: 'starting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
    };
    this.sessions.set(id, { meta, adapter: undefined });
    this.persistMetas();

    // Regenerate engine config from current settings before spawn.
    this.configWriter.sync(settings);

    const adapter = this.buildAdapter(meta);
    this.sessions.get(id)!.adapter = adapter;
    try {
      const { engineSessionId } = await adapter.start();
      meta.engineSessionId = engineSessionId;
      meta.status = 'idle';
      this.touch(meta);
    } catch (err) {
      meta.status = 'error';
      this.touch(meta);
      this.forward(id, {
        type: 'error',
        source: 'client',
        message: `会话启动失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      await adapter.dispose().catch(() => undefined);
      throw err;
    }
    return meta;
  }

  async prompt(sessionId: string, text: string, attachments?: string[]): Promise<void> {
    const s = this.require(sessionId);
    await this.ensureRuntime(s);
    this.touch(s.meta);
    await s.adapter?.prompt(text, attachments);
    this.touch(s.meta);
  }

  /** Lazily revive the engine process for sessions closed by app restart. */
  private async ensureRuntime(s: LiveSession): Promise<void> {
    if (s.adapter) return;
    this.configWriter.sync(this.settings.get());
    const adapter = this.buildAdapter(s.meta, s.meta.engineSessionId);
    s.adapter = adapter;
    s.meta.status = 'starting';
    this.touch(s.meta);
    try {
      const { engineSessionId } = await adapter.start();
      s.meta.engineSessionId = engineSessionId;
      s.meta.status = 'idle';
      this.touch(s.meta);
    } catch (err) {
      s.adapter = undefined;
      s.meta.status = 'error';
      this.touch(s.meta);
      throw err;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.require(sessionId).adapter?.cancel();
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const s = this.require(sessionId);
    await s.adapter?.setModel(modelId);
    s.meta.modelId = modelId;
    this.touch(s.meta);
  }

  async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const s = this.require(sessionId);
    await s.adapter?.setMode(mode);
    s.meta.permissionMode = mode;
    this.touch(s.meta);
  }

  answerPermission(sessionId: string, requestId: string, optionId?: string): void {
    this.require(sessionId).adapter?.answerPermission(requestId, optionId);
  }

  rename(sessionId: string, title: string): void {
    const s = this.require(sessionId);
    s.meta.title = title;
    this.touch(s.meta);
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await s.adapter?.dispose().catch(() => undefined);
    s.adapter = undefined;
    s.meta.status = 'closed';
    this.touch(s.meta);
  }

  async delete(sessionId: string): Promise<void> {
    await this.close(sessionId);
    this.sessions.delete(sessionId);
    this.persistMetas();
    try {
      rmSync(this.messagesFile(sessionId), { force: true });
    } catch {
      /* best effort */
    }
  }

  // -------------------------------------------------- message persistence

  getMessages(sessionId: string): UnifiedMessage[] {
    try {
      const f = this.messagesFile(sessionId);
      if (!existsSync(f)) return [];
      return JSON.parse(readFileSync(f, 'utf8')) as UnifiedMessage[];
    } catch {
      return [];
    }
  }

  saveMessages(sessionId: string, messages: UnifiedMessage[]): void {
    try {
      mkdirSync(join(app.getPath('userData'), 'messages'), { recursive: true });
      writeFileSync(this.messagesFile(sessionId), JSON.stringify(messages), 'utf8');
    } catch (err) {
      console.error('[sessions] save messages failed:', err);
    }
  }

  private messagesFile(sessionId: string): string {
    return join(app.getPath('userData'), 'messages', `${sessionId}.json`);
  }

  /** Kill every child process — called on app quit (anti-orphan). */
  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.adapter?.dispose()));
  }

  // ---------------------------------------------------------------- private

  private buildAdapter(meta: SessionMeta, resumeSessionId?: string): EngineAdapter {
    if (meta.engine === 'kimi') {
      return new KimiAdapter(
        {
          kimiHome: this.configWriter.home,
          cwd: meta.cwd,
          modelId: meta.modelId,
          permissionMode: meta.permissionMode,
          resumeSessionId,
        },
        (event) => this.onEngineEvent(meta.id, event),
      );
    }
    throw new Error(`engine ${meta.engine} 尚未接入（阶段 6 提供 codex）`);
  }

  private onEngineEvent(sessionId: string, event: EngineEvent): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      if (event.type === 'session.status') {
        s.meta.status = event.status;
        s.meta.updatedAt = Date.now();
      } else if (event.type === 'models.update') {
        s.meta.modelId = event.current;
      } else if (event.type === 'modes.update' && event.current) {
        s.meta.permissionMode = event.current;
      }
    }
    this.forward(sessionId, event);
  }

  private forward(sessionId: string, event: EngineEvent): void {
    const envelope: EngineEventEnvelope = { sessionId, event, ts: Date.now() };
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(IPC.engineEvent, envelope);
    }
  }

  private require(sessionId: string): LiveSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    return s;
  }

  private touch(meta: SessionMeta): void {
    meta.updatedAt = Date.now();
    this.persistMetas();
  }

  private makeScratchDir(id: string): string {
    const dir = join(app.getPath('userData'), 'scratch', id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private get metaFile(): string {
    return join(app.getPath('userData'), 'sessions.json');
  }

  private persistMetas(): void {
    try {
      writeFileSync(this.metaFile, JSON.stringify(this.list(), null, 2), 'utf8');
    } catch (err) {
      console.error('[sessions] persist failed:', err);
    }
  }

  private loadPersistedMetas(): void {
    try {
      if (!existsSync(this.metaFile)) return;
      const metas = JSON.parse(readFileSync(this.metaFile, 'utf8')) as SessionMeta[];
      for (const meta of metas) {
        // Engine processes did not survive the restart — mark closed until resumed.
        this.sessions.set(meta.id, { meta: { ...meta, status: 'closed' }, adapter: undefined });
      }
    } catch (err) {
      console.error('[sessions] load failed:', err);
    }
  }
}
