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

import type { EngineEvent, EngineEventEnvelope, GoalControlAction, PermissionMode, PermissionOptionView, SessionMeta, UnifiedMessage, UsageBucket, UsageStatsQuery, UsageStatsResult } from '@shared/types';
import { ENGINE_LABELS } from '@shared/types';
import type { SessionChangeDiff, SessionChangeEntry } from '@shared/ipc';
import type { SessionCreateRequest } from '@shared/ipc';
import { IPC } from '@shared/ipc';
import type { EngineAdapter } from './EngineAdapter';
import { KimiAdapter } from './kimi/KimiAdapter';
import { KimiKapAdapter } from './kimi/KimiKapAdapter';
import type { KapServerHost } from './kimi/KapServerHost';
import { CodexAdapter } from './codex/CodexAdapter';
import { ChangeTracker } from './changeTracker';
import { compatAudit } from './compatAudit';
import { OpencodeAdapter } from './opencode/OpencodeAdapter';
import { OmpAdapter } from './omp/OmpAdapter';
import { AntigravityAdapter } from './antigravity/AntigravityAdapter';
import { ClaudeAdapter } from './claude/ClaudeAdapter';
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
import { L } from '../i18n';
import type { AiServerHost } from '../proxy/AiServerHost';
import { routeSlashPrompt } from '../slash/slashService';

interface LiveSession {
  meta: SessionMeta;
  adapter: EngineAdapter | undefined;
  /** 后台启动中的 promise — prompt 等路径据此汇合，避免重复 spawn。 */
  starting?: Promise<void>;
}

/** 从消息文件抽取的单回合用量行（turn_end 折叠）。 */
interface UsageRow {
  ts: number;
  /** 回合内真实 API 调用次数；无逐调用信号（omp/老数据）按 1 回合兜底。 */
  calls: number;
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
    private readonly kapHost: KapServerHost,
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
    // Workspace sessions run in the first root. Extra roots reach engines
    // through two channels: a one-shot context prefix (认知，所有引擎) +
    // per-engine native 硬放行 (claude --add-dir / codex writable_roots /
    // omp --add-dir / opencode 会话级权限预放行；kimi acp 无任何原生
    // 通道 — 已验证 CLI/ACP 均不收多根参数，仅剩提示注入).
    const cwd = workspace?.folders[0] ?? req.cwd ?? '';
    const meta: SessionMeta = {
      id,
      engine: req.engine,
      title: req.title ?? L('新会话', 'New chat'),
      cwd: cwd || this.makeScratchDir(id),
      chatMode: cwd ? 'work' : 'chat',
      workspaceId: workspace?.id,
      raceId: req.raceId,
      contextSeed:
        workspace && workspace.folders.length > 1
          ? `本会话绑定多根工作区「${workspace.name}」，包含以下根目录（当前工作目录是第一个，其余目录也属于本项目范围，可用绝对路径访问）：\n${workspace.folders.join('\n')}`
          : undefined,
      modelId: req.modelId ?? '',
      // antigravity headless 无法交互式审批 → 默认自动放行（否则工作区外读写/shell 均被软拒）。
      permissionMode: req.permissionMode ?? (req.engine === 'antigravity' ? 'auto' : settings.defaultPermissionMode),
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
    } else if (text.startsWith('/')) {
      // 发送侧斜杠路由：引擎不解析斜杠文本时客户端补齐执行语义
      //（opencode 命令走原生端点；codex/antigravity 展开模板/技能）。
      const route = await routeSlashPrompt(s.meta.cwd, s.meta.engine, text).catch(() => null);
      if (route?.type === 'command' && s.adapter?.command) {
        await s.adapter.command(route.name, route.args);
        this.touch(s.meta);
        return;
      }
      if (route?.type === 'text') engineText = route.text;
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
    // 能力快照：单一真源 = adapter 可选方法存在性（同一引擎不同通道
    // 能力不同，如 kimi KAP/ACP）— UI 据此显隐 goal/steer 等控件。
    s.meta.capabilities = {
      goal: !!adapter.setGoal,
      steer: !!adapter.steer,
      fork: !!adapter.fork,
      compact: !!adapter.compact,
      swarm: !!adapter.setSwarm,
    };
    // 预热/唤醒的状态过渡只持久化，不刷 updatedAt — 否则选中即预热
    // 会把会话顶到侧栏顶部，快速连点时列表顺序乱跳。
    s.meta.status = 'starting';
    this.persistMetas();
    this.forward(s.meta.id, { type: 'session.status', status: 'starting' });
    this.forward(s.meta.id, {
      type: 'session.meta',
      patch: { capabilities: s.meta.capabilities, kimiChannel: s.meta.kimiChannel },
    });
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
        message: `${L('会话启动失败', 'Session failed to start')}: ${err instanceof Error ? err.message : String(err)}`,
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
   * first prompt. Either way the full parent context is preserved (native
   * engineSessionId or contextSeed) and the folded history is copied into
   * the branch's message store so it survives restarts — but the branch
   * records forkSeedCount so SideChatPanel can hide that inherited history
   * and only render questions asked inside the branch (§4.8).
   */
  async fork(sessionId: string): Promise<SessionMeta> {
    const src = this.require(sessionId);
    await this.ensureRuntime(src);
    // claude 原生分叉：父会话有 engineSessionId 时，新会话首个 prompt 以
    // --resume <父> --fork-session 分叉（引擎侧真分支，免重放历史）。
    const claudeFork = src.meta.engine === 'claude' && src.meta.engineSessionId ? src.meta.engineSessionId : undefined;
    const native = !claudeFork && src.adapter?.fork ? await src.adapter.fork() : null;
    const id = randomUUID();
    const history = this.getMessages(sessionId);
    const meta: SessionMeta = {
      ...src.meta,
      id,
      engineSessionId: native?.engineSessionId, // undefined → fresh session on revive
      forkPendingFromId: claudeFork, // claude: 首个 prompt 时 --fork-session 的父 id
      title: `⑂ ${src.meta.title.replace(/^⑂ /, '')}`,
      parentId: src.meta.id,
      chained: undefined, // sidechat 分支平级展示，不折叠父会话（区别于 forkToEngine）
      // 原生分叉（native 或 claudeFork）无需重放种子；否则注入历史。
      contextSeed: native || claudeFork ? undefined : serializeHistory(history),
      forkSeedCount: history.length, // 面板隐藏这段继承历史，仅显示分支内新问答
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
   * 迁移会话，所以始终走 contextSeed 前缀注入）。数据上是新会话（干净的
   * 分支模型，父会话原生上下文完整保留可无损回切），视觉上接管父会话：
   * 沿用原标题、chained 标记让侧栏折叠链上祖先、消息流末尾追加切换分割线。
   */
  async forkToEngine(sessionId: string, engine: SessionMeta['engine']): Promise<SessionMeta> {
    const src = this.require(sessionId);
    const history = this.getMessages(sessionId);
    const engineChanged = engine !== src.meta.engine;
    // 空白会话（一条消息都没有）：原地换引擎 — 无历史可保、无上下文可迁，
    // fork 只会留下一个毫无意义的空祖先（侧栏 ⎇ 噪音）；等价于新会话页
    // 重选引擎：不产生分支链、不写切换分割线；contextSeed（多根工作区提示）
    // 保留继续待注入。await close 防竞态：fire-and-forget 的 dispose 回调会
    // 把随后懒唤醒的新 adapter 置空造成孤儿进程。
    if (history.length === 0) {
      await this.close(sessionId);
      src.meta.engine = engine;
      src.meta.engineSessionId = undefined;
      if (engineChanged) src.meta.modelId = '';
      src.meta.permissionMode = engine === 'antigravity' ? 'auto' : src.meta.permissionMode;
      this.touch(src.meta);
      return src.meta;
    }
    const id = randomUUID();
    const meta: SessionMeta = {
      ...src.meta,
      id,
      engine,
      engineSessionId: undefined,
      title: src.meta.title.replace(/^[⑂⇄] /, ''), // 视觉连续：沿用原标题，不加分支前缀
      parentId: src.meta.id,
      chained: true, // 侧栏把父会话折叠进本分支（同一条对话只显示最新叶子）
      contextSeed: serializeHistory(history),
      // 切到不同引擎时重置模型（否则沿用上一个引擎的模型名）；空串 = 目标引擎用其默认。
      modelId: engineChanged ? '' : src.meta.modelId,
      // antigravity headless 默认自动放行（同 create；无法交互式审批）。
      permissionMode: engine === 'antigravity' ? 'auto' : src.meta.permissionMode,
      status: 'closed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
    };
    this.sessions.set(id, { meta, adapter: undefined });
    this.persistMetas();
    // 聊天区呈现为原地换引擎：历史原样带入 + 一条切换分割线。
    const divider: UnifiedMessage = {
      kind: 'system',
      id: randomUUID(),
      turnId: -1,
      text: L(
        `⇄ 已切换引擎 ${ENGINE_LABELS[src.meta.engine]} → ${ENGINE_LABELS[engine]}，上下文已接续`,
        `⇄ Engine switched ${ENGINE_LABELS[src.meta.engine]} → ${ENGINE_LABELS[engine]}, context carried over`,
      ),
      createdAt: Date.now(),
    };
    this.saveMessages(id, [...history, divider]);
    return meta;
  }

  async compact(sessionId: string): Promise<void> {
    const s = this.require(sessionId);
    await this.ensureRuntime(s);
    if (!s.adapter?.compact) throw new Error(L(`引擎 ${s.meta.engine} 不支持上下文压缩`, `Engine ${s.meta.engine} does not support context compaction`));
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
      throw new Error(L('会话进行中，无法回退', 'Session is busy — cannot undo'));
    }
    const messages = this.getMessages(sessionId);
    const idx = messages.findIndex((m) => m.kind === 'user' && m.id === messageId);
    if (idx < 0) throw new Error(L('未找到该提问', 'Question message not found'));
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

  /** Engine-native goal (codex thread/goal 或 kimi KAP goal_objective)。
   *  Throws for adapters without a goal API（UI 已按能力快照隐藏入口）。 */
  async setGoal(sessionId: string, objective: string): Promise<void> {
    const s = this.require(sessionId);
    await this.ensureRuntime(s);
    if (!s.adapter?.setGoal) throw new Error(L(`引擎 ${s.meta.engine} 不支持原生 Goal`, `Engine ${s.meta.engine} does not support native Goal`));
    await s.adapter.setGoal(objective);
  }

  async controlGoal(sessionId: string, action: GoalControlAction): Promise<void> {
    const s = this.require(sessionId);
    if (!s.adapter?.controlGoal) throw new Error(L(`引擎 ${s.meta.engine} 不支持原生 Goal`, `Engine ${s.meta.engine} does not support native Goal`));
    await s.adapter.controlGoal(action);
  }

  /** 原生 swarm 模式开关（kimi KAP）。无原生面的引擎抛错 — UI 已按
   *  capabilities.swarm 分流到提示词引导，正常不会走到这。 */
  async setSwarm(sessionId: string, active: boolean): Promise<void> {
    const s = this.require(sessionId);
    await this.ensureRuntime(s);
    if (!s.adapter?.setSwarm) throw new Error(L(`引擎 ${s.meta.engine} 不支持原生 Swarm`, `Engine ${s.meta.engine} does not support native Swarm`));
    await s.adapter.setSwarm(active);
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

  /** 聚合各会话消息文件里的 turn_end 用量（不含费用）：requests 口径为
   *  真实 API 调用次数（usage.apiCalls 累加，缺失时按 1 回合兜底）。
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
        b.requests += r.calls;
        b.inputTokens += r.input;
        b.outputTokens += r.output;
        b.cachedTokens += r.cached;
        totals.requests += r.calls;
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
                calls: Math.max(1, m.usage?.apiCalls ?? 1),
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
    // 多根工作区的其余根目录（提示注入只解决「认知」，有访问控制的
    // 引擎还需原生硬放行）。读当前 settings 而非建会时快照 — 目录
    // 增删后的懒唤醒/重启自动生效。
    const wsFolders = meta.workspaceId
      ? settings.workspaces.find((w) => w.id === meta.workspaceId)?.folders ?? []
      : [];
    const extraRoots = wsFolders.filter((f) => f !== meta.cwd);
    if (meta.engine === 'kimi') {
      // 路由开：镜像 home（base_url 指向本地 chat 前端）；关：不设
      // KIMI_CODE_HOME → kimi 直接用用户自己的 ~/.kimi-code 配置。
      // 多根工作区：kimi 无原生多根通道 — 仅靠 contextSeed 提示注入，
      // 好在 kimi 的文件工具允许绝对路径访问工作区外目录。
      let kimiHome: string | undefined;
      if (settings.routing.kimi) {
        const kimiCfg = readKimiConfig();
        if (!kimiCfg.exists) throw new Error(L(`未找到 Kimi Code 配置（${kimiCfg.configPath}），无法启用路由`, `Kimi Code config not found (${kimiCfg.configPath}) — cannot enable routing`));
        const port = await this.proxy.ensureKimiFront(resolveKimiRouteUpstreams(kimiCfg));
        kimiHome = buildKimiRouteMirror(app.getPath('userData'), kimiCfg, port);
      }
      const kimiOpts = {
        kimiHome,
        cwd: meta.cwd,
        modelId: meta.modelId,
        permissionMode: meta.permissionMode,
        resumeSessionId,
        quietResumeFallback,
      };
      const sink = (event: EngineEvent): void => this.onEngineEvent(meta.id, event);
      // 通道选路：KAP（kimi web REST+WS，goal/steer/fork/真实 usage 全原生）
      // 优先，失败降级 ACP。会话粒度粘性：已有引擎历史的 ACP 会话不迁
      // KAP（两侧引擎代际不同，跨通道 resume 必丢上下文）；降级只发生
      // 在会话启动时，不做回合中热切。
      const stickyAcp =
        meta.kimiChannel === 'acp' && !!resumeSessionId && this.getMessages(meta.id).length > 0;
      if (settings.kimiPreferKap && !stickyAcp) {
        try {
          await this.kapHost.ensure(kimiHome);
          meta.kimiChannel = 'kap';
          return new KimiKapAdapter({ ...kimiOpts, host: this.kapHost }, sink);
        } catch (err) {
          // KAP 起不来（未安装/版本不支持 web 子命令/端口被占且探测失败）
          // → 降级 ACP 兼容兜底；证据入兼容审计，对用户仅提示一次。
          const msg = err instanceof Error ? err.message : String(err);
          compatAudit.record('kimi', 'rejected-method', 'kap-server unavailable', msg);
          console.warn(`[kap-host] KAP 不可用，降级 ACP: ${msg}`);
        }
      }
      meta.kimiChannel = 'acp';
      return new KimiAdapter(kimiOpts, sink);
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
        if (!ups.chat && !ups.responses) throw new Error(L('Codex 路由无可用上游端点（见设置-模型页）', 'Codex routing has no usable upstream endpoint (see Settings → Engines)'));
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
          // 其余根目录并入 workspace-write 沙盒可写根（codex 是唯一有
          // OS 沙盒会硬拦写的引擎）。
          extraWritableRoots: extraRoots,
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
          // opencode 引擎侧无多根概念 — 其余根目录经会话级
          // external_directory 规则预放行，免逐次弹权限卡。
          extraDirs: extraRoots,
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
          // 其余根目录走 omp 原生 multi-root（spawn 级 --add-dir）。
          extraDirs: extraRoots,
        },
        (event) => this.onEngineEvent(meta.id, event),
      );
    }
    if (meta.engine === 'antigravity') {
      // headless `agy -p --output-format stream-json`，每回合一个进程。
      // 账号切换由 agyAccounts 覆写 keyring 完成，本适配器无需感知——
      // 下一个 prompt 进程自然以新账号启动（实时读 keyring）。
      return new AntigravityAdapter(
        {
          cwd: meta.cwd,
          // 未显式选模型时回落设置里的 agy 默认模型（仍为空则适配器用内置默认）。
          // 读当前 settings 而非建会时快照 — 改默认后懒唤醒/重启自然生效。
          modelId: meta.modelId || settings.antigravityDefaultModel || '',
          permissionMode: meta.permissionMode,
          resumeSessionId,
          // 工作态会话：把项目根传给适配器，首个 prompt 注入工作目录上下文
          // （headless agent 不把进程 cwd 当「工作区」自述，不告知就说“未设置工作区”）。
          workDir: meta.chatMode === 'work' ? meta.cwd : undefined,
        },
        (event) => this.onEngineEvent(meta.id, event),
      );
    }
    if (meta.engine === 'claude') {
      // 常驻 `claude -p --input-format stream-json --output-format stream-json`
      // 子进程（双向 stream-json）。模型/凭据完全委托 claude 自身
      // （OAuth token / ANTHROPIC_API_KEY），无协议路由。多根工作区的其余
      // 根目录经 --add-dir 放行（首个根是进程 cwd）。
      return new ClaudeAdapter(
        {
          cwd: meta.cwd,
          modelId: meta.modelId,
          permissionMode: meta.permissionMode,
          resumeSessionId,
          quietResumeFallback,
          extraDirs: extraRoots,
          // 赛马角色会话（meta.raceId）无人值守：自动放行权限/计划审批，防死锁。
          unattended: !!meta.raceId,
          // claude 原生分叉：首个 prompt 以 --fork-session 从此父 id 分支。
          forkFromSessionId: meta.forkPendingFromId,
          // 额外 MCP 服务器配置（可选；~/.claude MCP 仍自动加载）。
          mcpConfigPath: settings.claudeMcpConfig || undefined,
          // 自定义启动命令/路径（空 = 自动探测）— 支持完整路径或 PATH 命令名（如 cc）。
          cliEntry: settings.claudeCliPath || undefined,
        },
        (event) => this.onEngineEvent(meta.id, event),
      );
    }
    throw new Error(L(`未知引擎: ${meta.engine}`, `Unknown engine: ${meta.engine}`));
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
      } else if (event.type === 'session.meta') {
        // 适配器回填的元数据（如 antigravity 首个 prompt 后的 conversation_id、
        // opencode 服务端会话重建后的新 id）必须合并进 meta 并落盘 —— 否则
        // 重启后 resumeSessionId 为空，续接断链（上下文丢失）。
        Object.assign(s.meta, event.patch);
        // claude 原生分叉已实例化（拿到新 engineSessionId）→ 清分叉待就标记，
        // 否则重启/唤醒会对已分支的会话再次 --fork-session（重复分叉）。
        if (s.meta.forkPendingFromId && event.patch.engineSessionId) {
          s.meta.forkPendingFromId = undefined;
        }
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
      new Notification({ title: L(`任务完成：${meta.title}`, `Task done: ${meta.title}`), body: L('回到窗口查看结果', 'Return to the window to view the result') }).show();
    } else if (event.type === 'goal.update' && event.goal?.status === 'complete' && prefs.taskComplete) {
      new Notification({
        title: L(`Goal 执行完成：${meta.title}`, `Goal completed: ${meta.title}`),
        body: event.goal.objective.slice(0, 100),
      }).show();
    } else if (event.type === 'permission.request' && prefs.question) {
      new Notification({ title: L(`需要你的确认：${meta.title}`, `Needs your confirmation: ${meta.title}`), body: event.title }).show();
    } else if (event.type === 'error' && prefs.error) {
      new Notification({ title: L(`出错了：${meta.title}`, `Error: ${meta.title}`), body: event.message.slice(0, 120) }).show();
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

// ------------------------------------------------------------ history seed
//
// 跨引擎切换 / fork 降级 / 回退重播的上下文种子。目标：在纯文本通道里
// 最大化保真 —— 覆盖全部消息类型（工具轨迹/计划/权限决策/错误），分层
// 压缩（最近回合全保真含工具输出预览、更早回合瘦身、再超预算才整轮省略
// 并留提问摘要），取代旧版“只留 user/text + 尾部 12k 硬截断”的重度有损序列化。
// thinking/turn_end 不入种子：内部推理跨模型重放易被模仿且性价比极低，
// 统计行无信息量 —— 与 oh-my-pi 跨 provider 丢弃 thinking 的取舍一致。

const SEED_MAX_CHARS = 40_000; // 总预算（≈ 1–2 万 token，六引擎窗口均 ≥128k）
const SEED_RECENT_TURNS = 6; // 最近 N 轮全保真（含工具输出/补丁预览）
const SEED_FULL_TEXT_CAP = 6_000; // 全保真轮次单条正文上限
const SEED_TOOL_OUT_CAP = 700; // 工具输出/补丁预览上限（仅全保真轮次）
const SEED_OLD_TEXT_CAP = 500; // 压缩轮次正文截断

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…（截断 ${s.length - max} 字）` : s;
}

function optionName(options: PermissionOptionView[], id?: string): string {
  if (!id) return '未回答';
  if (id === '__cancelled__') return '未回答（已取消）';
  return options.find((o) => o.optionId === id)?.name ?? id;
}

/** 单条消息 → transcript 片段；null = 不入种子。lastPlanId：只保留最终计划快照。 */
function seedLine(m: UnifiedMessage, full: boolean, lastPlanId: string | undefined): string | null {
  switch (m.kind) {
    case 'user': {
      const extras: string[] = [];
      if (m.attachments?.length) extras.push(`附件: ${m.attachments.join(', ')}`);
      if (m.selections?.length)
        extras.push(`引用: ${m.selections.map((s) => `${s.path}#L${s.startLine}-${s.endLine}`).join(', ')}`);
      return `【用户】${clip(m.text, full ? SEED_FULL_TEXT_CAP : SEED_OLD_TEXT_CAP)}${extras.length ? `\n（${extras.join('；')}）` : ''}`;
    }
    case 'text':
      return `【助手】${clip(m.text, full ? SEED_FULL_TEXT_CAP : SEED_OLD_TEXT_CAP)}`;
    case 'tool_call': {
      if (m.toolKind === 'think') return null; // 思考类工具对续接无信息量
      const marks: string[] = [];
      if (m.locations?.length) marks.push(`@ ${m.locations.join(', ')}`);
      if (m.content?.changeKind) marks.push({ add: '新增文件', modify: '修改文件', delete: '删除文件' }[m.content.changeKind]);
      if (m.content?.additions !== undefined || m.content?.deletions !== undefined)
        marks.push(`+${m.content?.additions ?? 0}/-${m.content?.deletions ?? 0}`);
      if (m.content?.matches !== undefined) marks.push(`${m.content.matches} 处命中`);
      if (m.content?.exitCode !== undefined && m.content.exitCode !== 0) marks.push(`exit ${m.content.exitCode}`);
      if (m.status === 'failed') marks.push('失败');
      else if (m.status === 'canceled') marks.push('被中断');
      let line = `· [${m.toolName ?? m.toolKind}] ${m.title}${marks.length ? `（${marks.join('，')}）` : ''}`;
      if (full) {
        // 补丁优于输出预览（编辑类工具的 patch 信息密度更高）。
        const out = m.content?.patch ?? m.content?.text;
        if (out?.trim()) line += `\n  ↳ ${clip(out.trim(), SEED_TOOL_OUT_CAP).replace(/\n/g, '\n    ')}`;
      }
      return line;
    }
    case 'plan': {
      if (m.id !== lastPlanId) return null; // 中间态计划被后续快照取代
      const box = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const;
      return `【计划】\n${m.entries.map((e) => `  ${box[e.status]} ${e.content}`).join('\n')}`;
    }
    case 'permission':
      return `【权限】${m.title} → ${optionName(m.options, m.answeredOptionId)}`;
    case 'ask_user':
      return `【AI 提问】${clip(m.question, SEED_OLD_TEXT_CAP)} → 用户回答: ${m.answeredNote ?? optionName(m.options, m.answeredOptionId)}`;
    case 'error':
      return `【错误】${clip(m.message, 300)}`;
    case 'system':
      return `【系统】${clip(m.text, 300)}`;
    default:
      return null; // thinking / turn_end
  }
}

/** Maximal-fidelity transcript used as engine-switch / fallback-fork / undo context. */
function serializeHistory(messages: UnifiedMessage[]): string {
  // 按用户提问切轮：一轮 = 一条 user 消息到下一条 user 之前（首轮前的引导消息自成一组）。
  const turns: UnifiedMessage[][] = [];
  let cur: UnifiedMessage[] = [];
  for (const m of messages) {
    if (m.kind === 'user' && cur.length) {
      turns.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) turns.push(cur);

  const lastPlanId = [...messages].reverse().find((m) => m.kind === 'plan')?.id;

  // 会话概览：全程改动过的文件清单 —— 即使早期轮次被省略，这条关键线索也不丢。
  const edited = new Set<string>();
  for (const m of messages) {
    if (m.kind !== 'tool_call') continue;
    const editish = m.content?.changeKind !== undefined || m.content?.additions !== undefined || m.toolKind === 'edit';
    if (editish) for (const loc of m.locations ?? []) edited.add(loc);
  }

  const renderTurn = (turn: UnifiedMessage[], full: boolean): string =>
    turn
      .map((m) => seedLine(m, full, lastPlanId))
      .filter((l): l is string => l !== null)
      .join('\n');

  const recentStart = Math.max(0, turns.length - SEED_RECENT_TURNS);
  let dropped = 0;
  const assemble = (): string => {
    const parts: string[] = [];
    if (dropped > 0) {
      // 被省略轮次不默默蒸发 —— 留提问摘要行，新引擎至少知道聊过什么。
      const qs = turns
        .slice(0, dropped)
        .map((t) => t.find((m) => m.kind === 'user'))
        .filter((m): m is Extract<UnifiedMessage, { kind: 'user' }> => !!m)
        .map((m) => clip(m.text.replace(/\s+/g, ' '), 60));
      parts.push(`…（最早 ${dropped} 轮已省略，其间用户问过：${qs.join(' / ') || '（无提问记录）'}）`);
    }
    for (let i = dropped; i < turns.length; i++) {
      const body = renderTurn(turns[i]!, i >= recentStart);
      if (body) parts.push(body);
    }
    return parts.join('\n\n');
  };

  let transcript = assemble();
  // 超预算：从最早轮次起整轮省略（最近 SEED_RECENT_TURNS 轮保底不丢）。
  while (transcript.length > SEED_MAX_CHARS && dropped < recentStart) {
    dropped++;
    transcript = assemble();
  }
  if (transcript.length > SEED_MAX_CHARS) {
    // 保底轮次仍超预算（单轮超长工具输出等极端情形）— 尾部硬截断兑底。
    transcript = `…（更早内容已截断）\n${transcript.slice(-SEED_MAX_CHARS)}`;
  }

  const overview = edited.size
    ? `本会话此前已改动的文件（磁盘上即当前状态）：\n${[...edited].slice(0, 40).join('\n')}\n\n`
    : '';

  return [
    '以下是本会话此前的对话与执行历史（可能由另一个 AI 引擎执行），请接续上下文继续工作：',
    '<history>',
    overview + transcript,
    '</history>',
    '历史中的工具调用与文件改动都已真实执行完毕，请勿重复执行；磁盘文件以当前实际内容为准。',
    '请基于以上上下文回答用户接下来的消息。',
  ].join('\n');
}
