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
import {
  buildKimiRouteMirror,
  codexRouteOverrideArgs,
  readCodexConfig,
  readKimiConfig,
  resolveCodexRouteUpstreams,
  resolveKimiRouteUpstreams,
} from '../config/engineConfigs';
import type { SettingsStore } from '../config/settings';
import type { AiServerHost } from '../proxy/AiServerHost';

interface LiveSession {
  meta: SessionMeta;
  adapter: EngineAdapter | undefined;
  /** 后台启动中的 promise — prompt 等路径据此汇合，避免重复 spawn。 */
  starting?: Promise<void>;
}

export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private target: WebContents | undefined;

  constructor(
    private readonly settings: SettingsStore,
    private readonly proxy: AiServerHost,
  ) {
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
      modelId: req.modelId ?? '',
      permissionMode: req.permissionMode ?? settings.defaultPermissionMode,
      status: 'starting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
    };
    this.sessions.set(id, { meta, adapter: undefined });
    this.persistMetas();

    // 不等引擎起完 — 立刻返回 meta 让 UI 秒跳新会话，进程后台启动，
    // 状态由 session.status 事件推进（starting → idle / error）。
    const live = this.sessions.get(id)!;
    live.starting = this.startRuntime(live).catch(() => undefined);
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
    if (s.starting) await s.starting; // 后台启动进行中 — 汇合而非重复 spawn
    if (s.adapter) return;
    await this.startRuntime(s);
  }

  /** Spawn + 握手；create（后台）与 ensureRuntime（懒唤醒）共用。
   *  失败时广播 error 事件并抛出，adapter 清空以便下次重试。 */
  private async startRuntime(s: LiveSession): Promise<void> {
    const adapter = await this.buildAdapter(s.meta, s.meta.engineSessionId);
    s.adapter = adapter;
    s.meta.status = 'starting';
    this.touch(s.meta);
    this.forward(s.meta.id, { type: 'session.status', status: 'starting' });
    try {
      const { engineSessionId } = await adapter.start();
      s.meta.engineSessionId = engineSessionId;
      s.meta.status = 'idle';
      this.touch(s.meta);
      this.forward(s.meta.id, { type: 'session.status', status: 'idle' });
    } catch (err) {
      s.adapter = undefined;
      s.meta.status = 'error';
      this.touch(s.meta);
      this.forward(s.meta.id, { type: 'session.status', status: 'error' });
      this.forward(s.meta.id, {
        type: 'error',
        source: 'client',
        message: `会话启动失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      await adapter.dispose().catch(() => undefined);
      throw err;
    } finally {
      s.starting = undefined;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.require(sessionId).adapter?.cancel();
  }

  /** 预热：选中会话时提前唤醒引擎（已在跑则无操作），
   *  使模型/思考深度/命令等 models.update 事件即时就绪。
   *  启动失败不抛（仅预热，错误已通过 session.status 事件传给 UI）。 */
  async warmUp(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.adapter) return;
    await this.ensureRuntime(s).catch(() => undefined);
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
    if (s.starting) await s.starting; // 后台启动中 — 等握手完再下发
    await s.adapter?.setModel(modelId);
    s.meta.modelId = modelId;
    this.touch(s.meta);
  }

  async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const s = this.require(sessionId);
    if (s.starting) await s.starting;
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

  /** 归档/还原 — 只改展示态，不碰引擎进程与消息数据（区别于删除）。 */
  setArchived(sessionId: string, archived: boolean): void {
    const s = this.require(sessionId);
    s.meta.archived = archived;
    // 归档顺手清未读 — 隐藏的会话不该继续亮红点。
    if (archived) s.meta.unread = false;
    this.touch(s.meta);
    this.forward(sessionId, { type: 'session.meta', patch: { archived, unread: s.meta.unread } });
  }

  /** Project → Workspace 升级：把同 cwd 的散装 Project 会话挂到工作区下。 */
  assignWorkspace(cwd: string, workspaceId: string): void {
    for (const s of this.sessions.values()) {
      if (!s.meta.workspaceId && s.meta.chatMode === 'work' && s.meta.cwd === cwd) {
        s.meta.workspaceId = workspaceId;
        this.forward(s.meta.id, { type: 'session.meta', patch: { workspaceId } });
      }
    }
    this.persistMetas();
  }

  /** 工作区目录集变化后，给其所有会话注入一次性目录公告（下一条
   *  prompt 前置注入，引擎即时获知新增/移除的根目录）。 */
  announceWorkspaceFolders(workspaceId: string): void {
    const ws = this.settings.get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    const seed = `工作区「${ws.name}」的目录集已更新，当前包含以下根目录（第一个是工作目录，其余目录同属本项目范围，可用绝对路径访问；不在列表内的旧目录已移出本工作区）：\n${ws.folders.join('\n')}`;
    for (const s of this.sessions.values()) {
      if (s.meta.workspaceId === workspaceId) s.meta.contextSeed = seed;
    }
    this.persistMetas();
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
      return reconcilePersistedMessages(JSON.parse(readFileSync(f, 'utf8')) as UnifiedMessage[]);
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
    const settings = this.settings.get();
    // 空会话（无客户端历史）恢复失败时静默降级 — 没发过消息的线程
    // 引擎侧常未落盘（no rollout），报错纯噪音。
    const quietResumeFallback = resumeSessionId ? this.getMessages(meta.id).length === 0 : undefined;
    if (meta.engine === 'kimi') {
      // 路由开：镜像 home（base_url 指向本地 chat 前端）；关：不设
      // KIMI_CODE_HOME → kimi 直接用用户自己的 ~/.kimi-code 配置。
      let kimiHome: string | undefined;
      if (settings.routing.kimi) {
        const kimiCfg = readKimiConfig();
        if (!kimiCfg.exists) throw new Error(`未找到 Kimi Code 配置（${kimiCfg.configPath}），无法启用路由`);
        const port = await this.proxy.ensureKimiFront(resolveKimiRouteUpstreams(kimiCfg));
        kimiHome = buildKimiRouteMirror(app.getPath('userData'), kimiCfg, port);
      }
      return new KimiAdapter(
        {
          kimiHome,
          cwd: meta.cwd,
          modelId: meta.modelId,
          permissionMode: meta.permissionMode,
          resumeSessionId,
          quietResumeFallback,
        },
        (event) => this.onEngineEvent(meta.id, event),
      );
    }
    if (meta.engine === 'codex') {
      // 路由开：纯 `-c` 命令行覆盖指向本地 responses 前端（零文件写入）；
      // 关：不加覆盖，codex 完全按用户 ~/.codex 配置/登录直连。
      let overrideArgs: string[] = [];
      let availableModels: string[] = [];
      const codexCfg = readCodexConfig();
      if (settings.routing.codex) {
        const kimiCfg = readKimiConfig();
        const ups = resolveCodexRouteUpstreams(codexCfg, kimiCfg);
        if (!ups.chat && !ups.responses) throw new Error('Codex 路由无可用上游端点（见设置-模型页）');
        const port = await this.proxy.ensureCodexFront(ups);
        overrideArgs = codexRouteOverrideArgs(port);
        // 路由模式下模型名驱动路由：候选 = kimi 配置的模型别名。
        availableModels = kimiCfg.providers.flatMap((p) => p.models.map((m) => m.alias));
      } else {
        // 直连：候选 = model_catalog_json 目录（slug 即 model 参数），无目录
        // 时退回配置默认模型；配置默认模型不在目录里时也补进候选。
        const catalog = codexCfg.catalogModels ?? [];
        if (catalog.length) availableModels = catalog.map((m) => m.slug);
        else if (codexCfg.model) availableModels = [codexCfg.model];
        if (codexCfg.model && !availableModels.includes(codexCfg.model)) availableModels.unshift(codexCfg.model);
      }
      // 直连未显式选模型时加载 ~/.codex/config.toml 的默认 model —
      // UI 与实际生效模型一致，且下发值等于 codex 自身默认，不改变行为。
      const directModelId = meta.modelId || codexCfg.model || '';
      return new CodexAdapter(
        {
          cwd: meta.cwd,
          modelId: settings.routing.codex ? meta.modelId : directModelId,
          permissionMode: meta.permissionMode,
          resumeThreadId: resumeSessionId,
          quietResumeFallback,
          configOverrideArgs: overrideArgs,
          modelProvider: settings.routing.codex ? 'cyberslots' : undefined,
          availableModels,
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
      // 只在真正正常完成时提醒 — 出错/手动停止的回合不算「任务完成」，
      // 否则关了报错通知的用户还会收到伪装成完成的弹窗。
      if (event.stopReason === 'error' || event.stopReason === 'cancelled' || event.stopReason === 'interrupted') return;
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

/**
 * 收敛上次运行遗留的“进行中”状态：app 退出/崩溃时，引擎进程被杀，
 * 持久化历史里的 tool_call 转圈、待处理授权、进行中计划项永远不会再有
 * 后续事件，重启后必须按终态渲染，否则界面永远停在加载中。
 */
function reconcilePersistedMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    if (m.kind === 'tool_call' && (m.status === 'pending' || m.status === 'in_progress')) {
      changed = true;
      return { ...m, status: 'failed' as const };
    }
    if ((m.kind === 'permission' || m.kind === 'ask_user') && m.answeredOptionId === undefined) {
      changed = true;
      return { ...m, answeredOptionId: '__cancelled__' };
    }
    if (m.kind === 'plan' && m.entries.some((e) => e.status === 'in_progress')) {
      changed = true;
      return {
        ...m,
        entries: m.entries.map((e) => (e.status === 'in_progress' ? { ...e, status: 'pending' as const } : e)),
      };
    }
    if ((m.kind === 'text' || m.kind === 'thinking') && m.streaming) {
      changed = true;
      return { ...m, streaming: false };
    }
    return m;
  });
  return changed ? out : messages;
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
