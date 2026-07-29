/**
 * SessionManager — owns every live engine session: creates adapters,
 * routes their events to the renderer, persists session metadata, and
 * guarantees no orphan child processes on shutdown.
 */

import { app } from 'electron';
import { BrowserWindow, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebContents } from 'electron';

import type { EngineEvent, EngineEventEnvelope, GoalControlAction, PermissionMode, SessionMeta, UnifiedMessage, UsageBucket, UsageStatsQuery, UsageStatsResult } from '@shared/types';
import type { SessionChangeDiff, SessionChangeEntry } from '@shared/ipc';
import type { SessionCreateRequest } from '@shared/ipc';
import { IPC } from '@shared/ipc';
import type { EngineAdapter } from './EngineAdapter';
import { KimiAdapter } from './kimi/KimiAdapter';
import { CodexAdapter } from './codex/CodexAdapter';
import { ChangeTracker } from './changeTracker';
import { OpencodeAdapter } from './opencode/OpencodeAdapter';
import { OmpAdapter } from './omp/OmpAdapter';
import type { OpencodeServerHost } from './opencode/OpencodeServerHost';
import type { OpencodeEventHub } from './opencode/OpencodeEventHub';
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

/** 从消息文件抽取的单回合用量行（turn_end 折叠）。 */
interface UsageRow {
  ts: number;
  input: number;
  output: number;
  cached: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private target: WebContents | undefined;
  /** 逐会话文件编辑台账 + 回退能力（变更面板接受/拒绝）。 */
  private readonly changes = new ChangeTracker();
  /** 内部事件订阅（赛马编排器观察 turn.ended 等，与 renderer 转发并行）。 */
  private readonly localListeners = new Map<string, Set<(event: EngineEvent) => void>>();
  /** 主进程侧「当前回合助手正文」缓冲（供赛马角色产物交接；renderer
   *  持久化有防抖延迟，主进程不能依赖磁盘文件的即时性）。 */
  private readonly turnText = new Map<string, string>();
  private readonly turnOpen = new Set<string>();
    /** 懒重置标记：新回合开始时不立刻清空上回合产物，等本回合真正
     *  产出新内容（正文/工具活动）才清 —— 防无产出的自发回合（auto-
     *  compact 等）把赛马刚拿到的 transcript 产物摧毁成空串。 */
  private readonly turnFresh = new Set<string>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly proxy: AiServerHost,
    private readonly opencodeHost: OpencodeServerHost,
    private readonly opencodeHub: OpencodeEventHub,
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
      raceId: req.raceId,
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

  async prompt(sessionId: string, text: string, attachments?: string[], effort?: string, userMessageId?: string): Promise<void> {
    const s = this.require(sessionId);
    // 逐提问快照（AI 未动手，race-free）——「回退到此提问」的还原点；
    // 与引擎启动并行，不拖慢首条消息的投递。
    const marking = userMessageId && s.meta.cwd
      ? this.changes.markPrompt(sessionId, s.meta.cwd, userMessageId).catch(() => undefined)
      : undefined;
    await this.ensureRuntime(s);
    await marking;
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
    // 登记 in-flight — 并发调用（如快速连点的 warmUp 与 prompt）汇合到
    // 同一次启动，否则会并行 spawn 两个引擎，adapter 互覆 → 孤儿进程
    // + 两路状态事件打架（会话卡在 starting 转圈）。
    s.starting = this.startRuntime(s);
    await s.starting;
  }

  /** Spawn + 握手；create（后台）与 ensureRuntime（懒唤醒）共用。
   *  失败时广播 error 事件并抛出，adapter 清空以便下次重试。 */
  private async startRuntime(s: LiveSession): Promise<void> {
    const adapter = await this.buildAdapter(s.meta, s.meta.engineSessionId);
    s.adapter = adapter;
    // 预热/唤醒的状态过渡只持久化，不刷 updatedAt — 否则选中即预热
    // 会把会话顶到侧栏顶部，快速连点时列表顺序乱跳。
    s.meta.status = 'starting';
    this.persistMetas();
    this.forward(s.meta.id, { type: 'session.status', status: 'starting' });
    try {
      const { engineSessionId } = await adapter.start();
      s.meta.engineSessionId = engineSessionId;
      s.meta.status = 'idle';
      this.persistMetas();
      this.forward(s.meta.id, { type: 'session.status', status: 'idle' });
    } catch (err) {
      s.adapter = undefined;
      s.meta.status = 'error';
      this.persistMetas();
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

  /** 本会话 AI 编辑过的文件清单（含 +/- 与变更类型）。 */
  changesList(sessionId: string): Promise<SessionChangeEntry[]> {
    const s = this.sessions.get(sessionId);
    return s ? this.changes.list(sessionId, s.meta.cwd) : Promise.resolve([]);
  }

  /** 单文件编辑前/后内容（diff 视图）。 */
  changesDiff(sessionId: string, path: string): Promise<SessionChangeDiff> {
    const s = this.sessions.get(sessionId);
    return s ? this.changes.diff(sessionId, s.meta.cwd, path) : Promise.resolve({ path, before: null, after: null });
  }

  /** 回退到编辑前基线（新建则删）；path 省略 = 全部。 */
  changesRevert(sessionId: string, path?: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    return s ? this.changes.revert(sessionId, s.meta.cwd, path) : Promise.resolve();
  }

  /** 接受（保留改动、停止跟踪）；path 省略 = 全部。 */
  changesAccept(sessionId: string, path?: string): void {
    this.changes.accept(sessionId, path);
  }

  /** 回退到某提问将撤销的文件清单；null = 该提问无快照（旧消息/cron 注入）。 */
  undoPreview(sessionId: string, messageId: string): Promise<SessionChangeEntry[] | null> {
    const s = this.sessions.get(sessionId);
    return s ? this.changes.undoPreview(sessionId, s.meta.cwd, messageId) : Promise.resolve(null);
  }

  /**
   * 回退到某个提问：还原文件 → 截断消息（先全量备份）→ 重置引擎
   * 上下文（下次 prompt 以截断后历史作 contextSeed 新建引擎会话）。
   * 返回被移除的提问内容供输入框回填。
   */
  async undoToMessage(sessionId: string, messageId: string): Promise<{ text: string; attachments?: string[] }> {
    const s = this.require(sessionId);
    if (s.meta.status === 'running' || s.meta.status === 'awaiting') {
      throw new Error('会话进行中，无法回退');
    }
    const messages = this.getMessages(sessionId);
    const idx = messages.findIndex((m) => m.kind === 'user' && m.id === messageId);
    if (idx < 0) throw new Error('未找到该提问');
    const target = messages[idx] as Extract<UnifiedMessage, { kind: 'user' }>;

    // 1. 磁盘文件还原到该提问发送前的快照（无快照 = 仅移除消息）。
    await this.changes.undoRevert(sessionId, s.meta.cwd, messageId);

    // 2. 截断消息；先全量备份（数据安全底线：保留最近一次回退前的历史）。
    try {
      writeFileSync(this.messagesFile(sessionId).replace(/\.json$/, '.undo-bak.json'), JSON.stringify(messages), 'utf8');
    } catch {
      /* best effort */
    }
    const truncated = messages.slice(0, idx);
    this.saveMessages(sessionId, truncated);

    // 3. 重置引擎绑定 — 引擎侧历史无法截断（codex/kimi 无 rollback API），
    //    统一换新会话 + contextSeed 重播，三引擎行为一致。
    await this.close(sessionId);
    s.meta.engineSessionId = undefined;
    s.meta.contextSeed = truncated.length > 0 ? serializeHistory(truncated) : undefined;
    this.persistMetas();

    return { text: target.text, attachments: target.attachments };
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
    this.changes.clear(sessionId);
    this.localListeners.delete(sessionId);
    this.turnText.delete(sessionId);
    this.turnOpen.delete(sessionId);
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
      const raw = JSON.parse(readFileSync(f, 'utf8')) as UnifiedMessage[];
      const reconciled = reconcilePersistedMessages(raw);
      // 收敛后回写，避免磁盘文件长期留存 in_progress 脏状态。
      if (reconciled !== raw) this.saveMessages(sessionId, reconciled);
      return reconciled;
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

  // -------------------------------------------------------- usage stats

  /** turn_end 抽取行缓存 — mtime 命中直接复用，避免每次查询重析全部消息文件。 */
  private readonly usageRowCache = new Map<string, { mtimeMs: number; rows: UsageRow[] }>();

  /** 聚合各会话消息文件里的 turn_end 用量（不含费用）：
   *  跨度 ≤24h 按小时桶（起点对齐），否则按本地日历天分桶，空桶补零。
   *  kimi 会话一律不参与统计（无可靠的真实 token 上报，只有字符数估算）。 */
  usageStats(query: UsageStatsQuery): UsageStatsResult {
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const endTs = query.endTs;
    const startTs = Math.min(query.startTs, endTs);
    const hourly = endTs - startTs <= DAY;

    const bucketStarts: number[] = [];
    if (hourly) {
      const count = Math.max(1, Math.ceil((endTs - startTs) / HOUR));
      for (let i = 0; i < count; i++) bucketStarts.push(startTs + i * HOUR);
    } else {
      const first = new Date(startTs);
      first.setHours(0, 0, 0, 0);
      for (const d = new Date(first); d.getTime() <= endTs; d.setDate(d.getDate() + 1)) {
        bucketStarts.push(d.getTime());
      }
    }
    const buckets: UsageBucket[] = bucketStarts.map((ts) => ({
      ts,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    }));
    // 天桶索引表：按本地午夜时刻反查（不用除法 — 避开 DST 时差）。
    const dayIndex = new Map<number, number>();
    if (!hourly) bucketStarts.forEach((ts, i) => dayIndex.set(ts, i));

    const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 };
    for (const s of this.sessions.values()) {
      if (s.meta.engine === 'kimi') continue;
      if (query.engine && s.meta.engine !== query.engine) continue;
      for (const r of this.usageRows(s.meta.id)) {
        if (r.ts < startTs || r.ts > endTs) continue;
        let idx: number;
        if (hourly) {
          idx = Math.min(buckets.length - 1, Math.floor((r.ts - startTs) / HOUR));
        } else {
          const d = new Date(r.ts);
          d.setHours(0, 0, 0, 0);
          const found = dayIndex.get(d.getTime());
          if (found === undefined) continue;
          idx = found;
        }
        const b = buckets[idx];
        if (!b) continue;
        b.requests += 1;
        b.inputTokens += r.input;
        b.outputTokens += r.output;
        b.cachedTokens += r.cached;
        totals.requests += 1;
        totals.inputTokens += r.input;
        totals.outputTokens += r.output;
        totals.cachedTokens += r.cached;
      }
    }
    totals.totalTokens = totals.inputTokens + totals.outputTokens;
    return { bucketMs: hourly ? HOUR : DAY, buckets, totals };
  }

  private usageRows(sessionId: string): UsageRow[] {
    const f = this.messagesFile(sessionId);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(f).mtimeMs;
    } catch {
      return [];
    }
    const hit = this.usageRowCache.get(sessionId);
    if (hit && hit.mtimeMs === mtimeMs) return hit.rows;
    let rows: UsageRow[] = [];
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as UnifiedMessage[];
      rows = raw.flatMap((m) =>
        m.kind === 'turn_end'
          ? [
              {
                ts: m.createdAt,
                input: m.usage?.inputTokens ?? 0,
                output: m.usage?.outputTokens ?? 0,
                cached: m.usage?.cachedInputTokens ?? 0,
              },
            ]
          : [],
      );
    } catch {
      rows = [];
    }
    this.usageRowCache.set(sessionId, { mtimeMs, rows });
    return rows;
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
    if (meta.engine === 'opencode') {
      // 共享单例 serve（按 x-opencode-directory 头路由多目录）；
      // 模型/凭据完全委托 opencode 自身配置，无协议路由。
      return new OpencodeAdapter(
        {
          cwd: meta.cwd,
          modelId: meta.modelId,
          permissionMode: meta.permissionMode,
          resumeSessionId,
          quietResumeFallback,
        },
        this.opencodeHost,
        this.opencodeHub,
        (event) => this.onEngineEvent(meta.id, event),
      );
    }
    if (meta.engine === 'omp') {
      // 每会话一个 `omp acp` 子进程（ACP，同 kimi 基建）。approval 与
      // 精细思考档走 spawn flag（probe-omp-findings §3）；模型/凭据完全
      // 委托 omp 自身（~/.omp），无协议路由。
      return new OmpAdapter(
        {
          cwd: meta.cwd,
          modelId: meta.modelId,
          permissionMode: meta.permissionMode,
          resumeSessionId,
          quietResumeFallback,
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
        // 仅真正开跑才刷 updatedAt — 预热/唤醒的状态过渡不该改变
        // 侧栏排序（与 renderer 侧同规则）。
        if (event.status === 'running') s.meta.updatedAt = Date.now();
        // 持久化运行态：崩溃/重启后 loadPersistedMetas 才能据此识别
        // 「上次仍在执行/待回答」并标记未读（否则中断的任务无痕）。
        this.persistMetas();
      } else if (event.type === 'models.update') {
        s.meta.modelId = event.current;
      } else if (event.type === 'modes.update' && event.current) {
        s.meta.permissionMode = event.current;
      } else if (event.type === 'turn.ended') {
        s.meta.unread = true;
        s.meta.updatedAt = Date.now(); // 真实活动 — 回合完成刷新排序时间
        this.persistMetas();
        // shell 命令产生的文件改动没有 fileChange 事件 → 回合结束快照 diff 扫尾登记。
        void this.changes.scanTurnEnd(s.meta.id, s.meta.cwd);
      } else if (event.type === 'turn.started') {
        // AI 尚未动手：首个回合拍基线影子快照（含用户未提交手改）。
        void this.changes.onTurnStart(s.meta.id, s.meta.cwd);
      } else if (event.type === 'tool.upsert') {
        // 文件编辑事件 → 标记本会话编辑过该文件（供变更面板过滤）。
        const kind = event.toolKind ?? '';
        const editish =
          ['edit', 'write', 'delete', 'move'].includes(kind) ||
          /^(writing|editing|creating|deleting|moving|\u4fee\u6539|\u521b\u5efa|\u5220\u9664|\u5199\u5165)/i.test(event.title ?? '');
        if (editish) {
          const paths = new Set<string>(event.locations ?? []);
          if (event.content?.diff?.path) paths.add(event.content.diff.path);
          for (const p of paths) {
            // omp 等引擎的内部 URL scheme（agent:// / pr:// / conflict:// …）
            // 不是磁盘文件，不进变更台账。
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) continue;
            this.changes.noteEdit(s.meta.id, p, s.meta.cwd);
          }
        }
      }
      this.maybeNotify(s.meta, event);
    }
    this.trackTurnText(sessionId, event);
    this.emitLocal(sessionId, event);
    this.forward(sessionId, event);
  }

  /** System notifications per user preference; only when the window is unfocused. */
  private maybeNotify(meta: SessionMeta, event: EngineEvent): void {
    const prefs = this.settings.get().notifications;
    if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
    if (event.type === 'turn.ended' && prefs.taskComplete && !meta.title.startsWith('⏰')) {
      // 只在真正正常完成时提醒 — 出错/手动停止的回合不算「任务完成」，
      // 否则关了报错通知的用户还会收到伪装成完成的弹窗。引擎自发回合
      // （goal continuation / compact）也不算：goal 有自己的完成通知。
      if (
        event.stopReason === 'error' ||
        event.stopReason === 'cancelled' ||
        event.stopReason === 'interrupted' ||
        event.stopReason === 'background'
      )
        return;
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

  /** 内部订阅某会话的引擎事件（返回取消函数）；赛马编排器据此观察
   *  turn.ended 推进阶段，与 renderer 事件转发互不影响。 */
  subscribe(sessionId: string, cb: (event: EngineEvent) => void): () => void {
    let set = this.localListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.localListeners.set(sessionId, set);
    }
    set.add(cb);
    return () => {
      const cur = this.localListeners.get(sessionId);
      if (!cur) return;
      cur.delete(cb);
      if (cur.size === 0) this.localListeners.delete(sessionId);
    };
  }

  private emitLocal(sessionId: string, event: EngineEvent): void {
    const set = this.localListeners.get(sessionId);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(event);
      } catch {
        /* 单个监听器异常隔离，不影响其它订阅与 renderer 转发 */
      }
    }
  }

  private trackTurnText(sessionId: string, event: EngineEvent): void {
    if (event.type === 'turn.started') {
      // 懒重置：先只打标记，等本回合真产出内容时才清空上回合正文，
      // 防无产出的自发回合把刚拿到的产物摧毁成空串。
      this.turnFresh.add(sessionId);
      this.turnOpen.add(sessionId);
    } else if (event.type === 'text.delta') {
      if (this.turnFresh.delete(sessionId)) this.turnText.set(sessionId, '');
      if (!this.turnOpen.has(sessionId)) {
        this.turnText.set(sessionId, '');
        this.turnOpen.add(sessionId);
      }
      this.turnText.set(sessionId, (this.turnText.get(sessionId) ?? '') + event.text);
    } else if (event.type === 'tool.upsert') {
      // 新工具活动开始 → 之前的正文只是过程叙述（“我先看一下…”），
      // 非最终产物；清空使 transcript 收敛为「最后一段连续正文」
      // （plan/答案主体），赛马产物交接不再被探索独白稀释。
      // 仅在回合进行中且新工具启动时重置（completed 等尾部状态更新不重置）。
      if (
        this.turnOpen.has(sessionId) &&
        (event.status === 'pending' || event.status === 'in_progress')
      ) {
        this.turnFresh.delete(sessionId); // 真干活了 → 懒重置作废
        this.turnText.set(sessionId, '');
      }
    } else if (event.type === 'turn.ended') {
      this.turnOpen.delete(sessionId);
      this.turnFresh.delete(sessionId);
    }
  }

  /** 最新一个回合的助手正文（赛马角色间产物交接用）。 */
  transcript(sessionId: string): string {
    return (this.turnText.get(sessionId) ?? '').trim();
  }

  /** Builder 改动的文本摘要（供审计角色对照 diff）。 */
  async changesDigest(sessionId: string): Promise<string> {
    const list = await this.changesList(sessionId);
    if (!list.length) return '（无文件改动）';
    return list
      .map((c) => `${c.status === 'added' ? 'A' : c.status === 'deleted' ? 'D' : 'M'} ${c.path} (+${c.adds}/-${c.dels})`)
      .join('\n');
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
        // 上次仍在执行/待回答的会话 = 被重启打断：置未读，让侧栏有醒目
        // 提示，用户不会把半截任务误当已完成。
        const wasActive =
          meta.status === 'running' || meta.status === 'awaiting' || meta.status === 'starting';
        this.sessions.set(meta.id, {
          meta: { ...meta, status: 'closed', unread: meta.unread || wasActive },
          adapter: undefined,
        });
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
    if (m.kind === 'tool_call' && (m.status === 'pending' || m.status === 'in_progress' || m.status === 'proposed')) {
      changed = true;
      // 被重启打断 ≠ 工具真的报错：用 canceled 与 failed 区分（灰色而非红色）。
      // proposed（omp 两阶段编辑预览待确认）重启后同样永无后续 → 收敛。
      return { ...m, status: 'canceled' as const };
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
