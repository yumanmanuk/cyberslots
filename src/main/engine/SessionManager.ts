/**
 * SessionManager — owns every live engine session: creates adapters,
 * routes their events to the renderer, persists session metadata, and
 * guarantees no orphan child processes on shutdown.
 */

import { app } from 'electron';
import { BrowserWindow, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebContents } from 'electron';

import type { EngineEvent, EngineEventEnvelope, GoalControlAction, PermissionMode, SessionMeta, UnifiedMessage } from '@shared/types';
import type { SessionCreateRequest } from '@shared/ipc';
import { IPC } from '@shared/ipc';
import type { EngineAdapter } from './EngineAdapter';
import { KimiAdapter } from './kimi/KimiAdapter';
import { CodexAdapter } from './codex/CodexAdapter';
import { ConfigWriter } from '../config/ConfigWriter';
import type { SettingsStore } from '../config/settings';
import type { AiServerHost } from '../proxy/AiServerHost';

interface LiveSession {
  meta: SessionMeta;
  adapter: EngineAdapter | undefined;
}

export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly configWriter: ConfigWriter;
  private target: WebContents | undefined;

  constructor(
    private readonly settings: SettingsStore,
    private readonly proxy: AiServerHost,
  ) {
    this.configWriter = new ConfigWriter(
      join(app.getPath('userData'), 'kimi-home'),
      join(app.getPath('userData'), 'codex-home'),
    );
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
    const workspace = req.workspaceId ? settings.workspaces.find((w) => w.id === req.workspaceId) : undefined;
    // Workspace sessions run in the first root; the remaining roots are
    // announced to the engine via a one-shot context prefix (kimi ACP has
    // no stable multi-root field yet — 方案 P1 的提示注入路径).
    const cwd = workspace?.folders[0] ?? req.cwd ?? '';
    const meta: SessionMeta = {
      id,
      engine: req.engine,
      title: req.title ?? '新会话',
      cwd: cwd || this.makeScratchDir(id),
      chatMode: cwd ? 'work' : 'chat',
      workspaceId: workspace?.id,
      contextSeed:
        workspace && workspace.folders.length > 1
          ? `本会话绑定多根工作区「${workspace.name}」，包含以下根目录（当前工作目录是第一个，其余目录也属于本项目范围，可用绝对路径访问）：\n${workspace.folders.join('\n')}`
          : undefined,
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

    const adapter = await this.buildAdapter(meta);
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

  async prompt(sessionId: string, text: string, attachments?: string[], effort?: string): Promise<void> {
    const s = this.require(sessionId);
    await this.ensureRuntime(s);
    this.touch(s.meta);
    // Fallback-fork branches carry the parent history as a one-shot prefix.
    let engineText = text;
    if (s.meta.contextSeed) {
      engineText = `${s.meta.contextSeed}\n\n用户消息：${text}`;
      s.meta.contextSeed = undefined;
      this.persistMetas();
    }
    await s.adapter?.prompt(engineText, attachments, effort);
    this.touch(s.meta);
  }

  /** Lazily revive the engine process for sessions closed by app restart. */
  private async ensureRuntime(s: LiveSession): Promise<void> {
    if (s.adapter) return;
    this.configWriter.sync(this.settings.get());
    const adapter = await this.buildAdapter(s.meta, s.meta.engineSessionId);
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

  /**
   * Sidechat: fork an existing session into an independent branch.
   * Preferred path is the engine's native session/fork; kimi CLI 0.29.1
   * rejects it (-32601, scripts/probe-fork.mjs), so we fall back to a
   * fresh engine session seeded with the serialized parent history on
   * first prompt. Either way the client copies the folded message list
   * so the branch renders the full context immediately.
   */
  async fork(sessionId: string): Promise<SessionMeta> {
    const src = this.require(sessionId);
    await this.ensureRuntime(src);
    const native = src.adapter?.fork ? await src.adapter.fork() : null;
    const id = randomUUID();
    const history = this.getMessages(sessionId);
    const meta: SessionMeta = {
      ...src.meta,
      id,
      engineSessionId: native?.engineSessionId, // undefined → fresh session on revive
      title: `⑂ ${src.meta.title.replace(/^⑂ /, '')}`,
      parentId: src.meta.id,
      contextSeed: native ? undefined : serializeHistory(history),
      status: 'closed', // revived lazily on first prompt
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
    };
    this.sessions.set(id, { meta, adapter: undefined });
    this.persistMetas();
    this.saveMessages(id, history);
    return meta;
  }

  /**
   * “换引擎继续聊”：历史重放式分支到另一个引擎（引擎侧无法跨引擎
   * 迁移会话，所以始终走 contextSeed 前缀注入）。
   */
  forkToEngine(sessionId: string, engine: SessionMeta['engine']): SessionMeta {
    const src = this.require(sessionId);
    const id = randomUUID();
    const history = this.getMessages(sessionId);
    const meta: SessionMeta = {
      ...src.meta,
      id,
      engine,
      engineSessionId: undefined,
      title: `⇄ ${src.meta.title.replace(/^[⑂⇄] /, '')}`,
      parentId: src.meta.id,
      contextSeed: serializeHistory(history),
      status: 'closed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
    };
    this.sessions.set(id, { meta, adapter: undefined });
    this.persistMetas();
    this.saveMessages(id, history);
    return meta;
  }

  async compact(sessionId: string): Promise<void> {
    const s = this.require(sessionId);
    await this.ensureRuntime(s);
    if (!s.adapter?.compact) throw new Error(`引擎 ${s.meta.engine} 不支持上下文压缩`);
    await s.adapter.compact();
  }

  /** Steer the running turn; false = not supported / not steerable (re-queue). */
  async steer(sessionId: string, text: string): Promise<boolean> {
    const s = this.require(sessionId);
    if (!s.adapter?.steer) return false;
    const ok = await s.adapter.steer(text);
    if (ok) this.forward(sessionId, { type: 'user.echo', turnId: 0, text });
    return ok;
  }

  /** Engine-native goal (codex only). Throws for engines without a goal API. */
  async setGoal(sessionId: string, objective: string): Promise<void> {
    const s = this.require(sessionId);
    await this.ensureRuntime(s);
    if (!s.adapter?.setGoal) throw new Error(`引擎 ${s.meta.engine} 不支持原生 Goal`);
    await s.adapter.setGoal(objective);
  }

  async controlGoal(sessionId: string, action: GoalControlAction): Promise<void> {
    const s = this.require(sessionId);
    if (!s.adapter?.controlGoal) throw new Error(`引擎 ${s.meta.engine} 不支持原生 Goal`);
    await s.adapter.controlGoal(action);
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

  /** Push a user-message echo to the renderer for prompts sent from main (cron). */
  announceUser(sessionId: string, text: string): void {
    this.forward(sessionId, { type: 'user.echo', turnId: 0, text });
  }

  rename(sessionId: string, title: string): void {
    const s = this.require(sessionId);
    s.meta.title = title;
    this.touch(s.meta);
  }

  markRead(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.meta.unread) return;
    s.meta.unread = false;
    this.touch(s.meta);
    this.forward(sessionId, { type: 'session.meta', patch: { unread: false } });
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

  private async buildAdapter(meta: SessionMeta, resumeSessionId?: string): Promise<EngineAdapter> {
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
    if (meta.engine === 'codex') {
      // codex depends on the embedded proxy: start it, then point the
      // app-owned CODEX_HOME config at its current loopback port.
      const settings = this.settings.get();
      const port = await this.proxy.ensureStarted(settings);
      this.configWriter.syncCodex(settings, port);
      return new CodexAdapter(
        {
          codexHome: this.configWriter.codexHomeDir,
          cwd: meta.cwd,
          modelId: meta.modelId,
          permissionMode: meta.permissionMode,
          resumeThreadId: resumeSessionId,
          availableModels: settings.providers.flatMap((p) => p.models.map((m) => m.alias)),
        },
        (event) => this.onEngineEvent(meta.id, event),
      );
    }
    throw new Error(`未知引擎: ${meta.engine}`);
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
      } else if (event.type === 'turn.ended') {
        s.meta.unread = true;
        this.persistMetas();
      }
      this.maybeNotify(s.meta, event);
    }
    this.forward(sessionId, event);
  }

  /** System notifications per user preference; only when the window is unfocused. */
  private maybeNotify(meta: SessionMeta, event: EngineEvent): void {
    const prefs = this.settings.get().notifications;
    if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
    if (event.type === 'turn.ended' && prefs.taskComplete && !meta.title.startsWith('⏰')) {
      new Notification({ title: `任务完成：${meta.title}`, body: '回到窗口查看结果' }).show();
    } else if (event.type === 'goal.update' && event.goal?.status === 'complete' && prefs.taskComplete) {
      new Notification({
        title: `Goal 执行完成：${meta.title}`,
        body: event.goal.objective.slice(0, 100),
      }).show();
    } else if (event.type === 'permission.request' && prefs.question) {
      new Notification({ title: `需要你的确认：${meta.title}`, body: event.title }).show();
    } else if (event.type === 'error' && prefs.error) {
      new Notification({ title: `出错了：${meta.title}`, body: event.message.slice(0, 120) }).show();
    }
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

const SEED_MAX_CHARS = 12_000;

/** Compact user/assistant transcript used as fallback-fork context. */
function serializeHistory(messages: UnifiedMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.kind === 'user') lines.push(`用户: ${m.text}`);
    else if (m.kind === 'text') lines.push(`助手: ${m.text}`);
  }
  let transcript = lines.join('\n\n');
  if (transcript.length > SEED_MAX_CHARS) {
    transcript = `…（更早内容已截断）\n${transcript.slice(-SEED_MAX_CHARS)}`;
  }
  return [
    '以下是本分支会话从父会话继承的对话历史，供你了解上下文：',
    '<history>',
    transcript,
    '</history>',
    '请基于以上上下文回答用户接下来的消息。',
  ].join('\n');
}
