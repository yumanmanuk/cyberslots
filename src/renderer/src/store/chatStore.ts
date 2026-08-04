/**
 * Chat store — folds the main-process EngineEvent stream into renderable
 * UnifiedMessage lists per session, and fronts every session action.
 * This is the renderer's single source of truth.
 */

import { create } from 'zustand';

import { useRaceStore } from './raceStore';

import type {
  AppSettings,
  AgyQuotaGroup,
  AgyQuotaInfo,
  CodeSelection,
  CodexCatalogModel,
  CompatAuditSnapshot,
  ContextFallbackRule,
  CronTask,
  KimiConfigModel,
  EngineConfigsSnapshot,
  EngineEvent,
  EngineEventEnvelope,
  EngineId,
  GoalControlAction,
  GoalInfo,
  OpencodeCatalog,
  OmpCatalog,
  PermissionMode,
  SessionMeta,
  SlashCommandInfo,
  UnifiedMessage,
  WorkspaceInfo,
} from '@shared/types';
import type { SessionCreateRequest, OpenerAvailability } from '@shared/ipc';
import { isRaceActive, type RaceRole } from '@shared/race';
import { serializeSelections, selectionRangeLabel } from '../selections';
import { resolveEffectiveEffort } from '../effort';
import { rlog } from '../log/logger';

export interface SidebarFilter {
  sort: 'updated' | 'created';
  status: 'all' | 'running' | 'done' | 'awaiting' | 'error';
  unreadOnly: boolean;
}

export const DEFAULT_FILTER: SidebarFilter = { sort: 'updated', status: 'all', unreadOnly: false };

/** A message waiting to be sent once the running turn finishes. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: string[];
  /** 随消息排队的代码选区引用（发送时与正文一起序列化）。 */
  selections?: CodeSelection[];
}

export interface SessionUiState {
  messages: UnifiedMessage[];
  usage?: { used: number; size: number; costUsd?: number };
  models: { current: string; available: string[] };
  modes: { current: PermissionMode; available: PermissionMode[] };
  commands: SlashCommandInfo[];
  /** 引擎原生 swarm 模式状态（kimi KAP；swarm.update 推送，含自发退出）。 */
  swarm?: boolean;
  /** Timestamp of the latest engine event — drives the heartbeat indicator. */
  lastActivityAt?: number;
  /** 持久化历史已加载。不能拿「ui 条目存在」当依据 — 任意 main 侧
   *  事件（如归档 meta patch）都会预先创建空 ui，曾导致打开归档会话
   *  时历史永远不加载（e2e 实测）。 */
  hydrated?: boolean;
}

interface ChatState {
  sessions: SessionMeta[];
  ui: Record<string, SessionUiState>;
  activeSessionId: string | null;
  creating: boolean;
  /** 正在创建的会话引擎 — 落地页据此显示「正在启动 X」。creating 是全局标记，
   *  创建也可能来自侧栏 EnginePick，不能读落地页本地的引擎选择（曾因此选 codex 显示 kimi）。 */
  creatingEngine: EngineId | null;
  settings: AppSettings | null;
  settingsOpen: boolean;
  swarmBoost: boolean;
  cronOpen: boolean;
  /** 「已归档会话」查看入口（模态）。 */
  archivedOpen: boolean;
  /** 用量统计视图（全屏覆盖层）。 */
  usageOpen: boolean;
  /** 总控制台（Mission Control）看板 — 无活动会话时的首页视图。 */
  dashboardOpen: boolean;
  /** 会话 → 「正在做什么」一行摘要（工具标题/正文首行/思考中），
   *  看板卡片实时显示用；纯内存态，不入持久化。 */
  lastActivity: Record<string, string>;
  cronTasks: CronTask[];
  filter: SidebarFilter;
  /** Engine-native goal per session (codex thread/goal; pushed via goal.update). */
  goals: Record<string, GoalInfo | undefined>;
  /** Per-session reasoning-effort override (codex only). */
  efforts: Record<string, string>;
  /** Per-session outbox: messages waiting for the current turn to finish. */
  queues: Record<string, QueuedMessage[]>;
  /** 输入框里待发送的代码选区卡片（按会话隔离；发送后清空）。 */
  selections: Record<string, CodeSelection[]>;
  /** prompt 在途标记（含引擎启动期的等待投递）— 启动中允许直接发送，
   *  主进程汇合等就绪后投递；此标记让后续消息走排队、底部指示器不空窗。 */
  sending: Record<string, boolean>;
  /** 回退后待回填输入框的提问（nonce 驱动 Composer 侧 effect）。 */
  composerDrafts: Record<string, { text: string; nonce: number } | undefined>;
  /** 输入框未发送草稿（按会话；切走时保存、切回恢复）。纯内存 — 重启不保留。 */
  drafts: Record<string, string>;
  /** 侧边栏折叠态（localStorage 持久）。 */
  sidebarCollapsed: boolean;
  /** 会话 → 右侧 dock 的打开状态与当前 tab（纯内存；切会话保留，重启不保留）。 */
  rightPanels: Record<string, RightPanelState | undefined>;
  /** 主会话 → 右侧 sidechat 分支会话 id 列表（支持多个分支 tab）。 */
  sidechats: Record<string, string[] | undefined>;
  /** 主会话 → 右侧内嵌终端 tab 列表（多实例，cwd 可选不同工作区根目录）。 */
  terminals: Record<string, TerminalTab[] | undefined>;
  /** 会话 → 待右侧预览的 plan 文档消息 id（plan 模式回合结束时自动设置）。 */
  planPreview: Record<string, string | undefined>;
  /** 会话 → 待右侧打开的文件预览（AI 正文文件 chip 点击；nonce 驱动重复点击）。
   *  ChatView 只负责开 files tab（不清除），WorkspacePanel 消费后清除。 */
  pendingFilePreview: Record<string, { path: string; nonce: number } | undefined>;
  /** 会话 → 待右侧变更面板打开的 diff（编辑工具卡点击；nonce 驱动重复点击）。
   *  ChatView 只负责开 changes tab（不清除），WorkspacePanel 消费后清除。 */
  pendingChangePreview: Record<string, { path: string; nonce: number } | undefined>;
  /** codex model_catalog_json 目录（init 时读取，↻/选择器打开时刷新；模型/思考深度选择器用）。 */
  codexCatalog: CodexCatalogModel[];
  /** ~/.codex/config.toml 的 model_reasoning_effort（codex 全局默认档）。 */
  codexDefaultEffort?: string;
  /** kimi config.toml 模型条目（含思考档位元数据；思考深度选择器用）。 */
  kimiModels: KimiConfigModel[];
  /** claude 自定义模型别名显示名（~/.claude settings env 推导；模型选择器用）。 */
  claudeModelLabels: Record<string, string> | null;
  /** 重读引擎配置快照并同步 codex 目录/默认档；返回快照供调用方复用（一次 IPC 两处受益）。 */
  refreshEngineConfigs(): Promise<EngineConfigsSnapshot>;
  /** 各引擎本机可用性（CLI 安装/配置存在）：null = 尚未探测（不置灰）。
   *  引擎选择入口据此把未安装项置灰展示（可见不可选）。 */
  engineAvailability: Record<EngineId, boolean> | null;
  /** 「外部打开」程序的本机可用性（VS Code / Cursor / Antigravity / Git Bash）：
   *  null = 尚未探测（菜单先全显）；探测后菜单隐藏未安装项。 */
  openerAvailability: OpenerAvailability | null;
  /** opencode 模型目录（懒加载 — 首个 opencode 会话的选择器触发，
   *  来自 /config/providers；拉取会按需启动 opencode server）。 */
  opencodeCatalog: OpencodeCatalog | null;
  loadOpencodeCatalog(force?: boolean): Promise<void>;
  /** omp 模型目录（懒加载 — `omp models --json`，无凭据时为空目录）。 */
  ompCatalog: OmpCatalog | null;
  loadOmpCatalog(force?: boolean): Promise<void>;
  /** 引擎兼容性审计快照（未知事件/被拒方法/解析失败）— 齿轮小黄点
   *  与设置页诊断卡的数据源；null = 尚未拉取。 */
  compatAudit: CompatAuditSnapshot | null;
  init(): Promise<void>;
  saveSettings(patch: Partial<AppSettings>): Promise<void>;
  addWorkspace(name: string, folders: string[]): Promise<WorkspaceInfo>;
  updateWorkspace(ws: WorkspaceInfo): Promise<void>;
  removeWorkspace(id: string): Promise<void>;
  /** Project → Workspace 升级：建工作区并把同 cwd 会话挂进去。 */
  convertProjectToWorkspace(cwd: string, name: string, folders: string[]): Promise<void>;
  createSession(req: SessionCreateRequest): Promise<void>;
  selectSession(id: string): void;
  hydrateSession(id: string): void;
  forkSession(id: string): Promise<void>;
  /** 新建一个 sidechat 分支（总是 fork 新会话），返回分支会话 id。 */
  openSidechat(parentId: string): Promise<string>;
  /** 关 sidechat tab = 彻底清理：删除分支会话（引擎/消息/侧栏一并移除）。 */
  closeSidechat(branchId: string): Promise<void>;
  /** 新开一个内嵌终端 tab（cwd = 选定的工作区根目录），返回 tab id。 */
  addTerminal(sessionId: string, cwd: string): string;
  removeTerminal(sessionId: string, termId: string): void;
  toggleSidebar(): void;
  /** 更新某会话右侧 dock 状态（只写补丁，保留未提及字段）。 */
  setRightPanel(sessionId: string, patch: Partial<RightPanelState>): void;
  setPlanPreview(sessionId: string, messageId: string | undefined): void;
  /** AI 正文文件 chip 点击 → 右侧 files tab 打开该文件预览（仅 work 会话；相对路径按 cwd 拼绝对）。 */
  requestFilePreview(sessionId: string, rawPath: string): void;
  /** 编辑工具卡点击 → 右侧 changes tab 打开该文件 diff（仅 work 会话；相对路径按 cwd 拼绝对）。 */
  requestChangePreview(sessionId: string, rawPath: string): void;
  forkToEngine(id: string, engine: SessionMeta['engine']): Promise<void>;
  compactSession(): Promise<void>;
  /** Antigravity 切号弹窗目标会话 id（null = 关闭）。低额/无额时自动置位。 */
  agySwitchFor: string | null;
  openAgySwitch(sessionId: string): void;
  closeAgySwitch(): void;
  /** 切换 Antigravity 账号（覆写 keyring）；continueSessionId 非空则切后自动发“继续”接回任务。 */
  switchAgyAccount(accountId: string, continueSessionId?: string): Promise<{ email: string }>;
  sendPrompt(text: string, attachments?: string[], selections?: CodeSelection[]): Promise<void>;
  sendPromptTo(
    sessionId: string,
    text: string,
    attachments?: string[],
    enginePrefix?: string,
    selections?: CodeSelection[],
  ): Promise<void>;
  addSelection(sessionId: string, sel: CodeSelection): void;
  removeSelection(sessionId: string, id: string): void;
  clearSelections(sessionId: string): void;
  cancel(): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  /** 回退到某提问：主进程还原文件+截断持久化 → 本地截断消息 → 提问回填输入框。 */
  undoToMessage(sessionId: string, messageId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  answerPermission(requestId: string, optionId?: string): Promise<void>;
  /** 看板卡面直批：对任意会话应答 permission/ask_user，不必先切入会话
   *  （sessionAnswerPermission IPC 本就按 sessionId 寻址）。 */
  answerPermissionTo(sessionId: string, requestId: string, optionId?: string): Promise<void>;
  /** 提问卡自定义回答留档（Other: …）— 只在对应 ask_user 消息上补字段，不增删消息。 */
  noteAskUserAnswer(sessionId: string, requestId: string, note: string): void;
  /** 回到总控制台看板（关闭赛马全屏/会话视图）。 */
  openDashboard(): void;
  /** 看板「标记已读」：不切入会话地清除未读点。 */
  markSessionRead(id: string): Promise<void>;
  /** 错误卡一键重试：重发该会话最后一条用户提问（未水合时直接读持久化历史）。 */
  retryLast(sessionId: string): Promise<boolean>;
  /** 卡面 steer：运行中注入指令（codex 原生），不可注入降级排队（kimi），
   *  空闲/出错会话直接作为新提问发送。 */
  steerLive(sessionId: string, text: string): Promise<'steered' | 'queued' | 'sent'>;
  enqueue(text: string, attachments?: string[], selections?: CodeSelection[]): void;
  /** Enqueue into a specific session（PermissionSheet 补充说明用）。 */
  enqueueTo(sessionId: string, text: string, attachments?: string[], selections?: CodeSelection[]): void;
  removeQueued(sessionId: string, id: string): void;
  moveQueued(sessionId: string, from: number, to: number): void;
  steerQueued(sessionId: string, id: string): Promise<'steered' | 'moved' | 'head' | 'none'>;
  setGoal(objective: string): Promise<void>;
  controlGoal(action: GoalControlAction): Promise<void>;
  /** 原生 swarm 开关（仅 capabilities.swarm 会话；其余引擎用 swarmBoost 前缀）。 */
  setSwarm(sessionId: string, active: boolean): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  /** 归档/还原：仅影响侧栏展示，数据与引擎会话全保留（区别于删除）。 */
  archiveSession(id: string, archived: boolean): Promise<void>;
  deleteSession(id: string): Promise<void>;
  loadCron(): Promise<void>;
  saveCron(task: CronTask): Promise<void>;
  deleteCron(id: string): Promise<void>;
  runCronNow(id: string): Promise<void>;
}

/** 右侧内嵌终端 tab（渲染进程侧台账；PTY 由主进程按 id 管理）。 */
export interface TerminalTab {
  id: string;
  cwd: string;
}

/** 右侧 dock 的会话级状态：开关 + 当前激活 tab（切会话恢复用，不落盘）。 */
export interface RightPanelState {
  open: boolean;
  activeTab: string;
}

const emptyUi = (meta?: Pick<SessionMeta, 'permissionMode'>): SessionUiState => ({
  messages: [],
  models: { current: '', available: [] },
  modes: { current: meta?.permissionMode ?? 'default', available: [] },
  commands: [],
});

/** Seed the UI permission mode from persisted session metadata so the composer
 *  does not show "manual" before the first modes.update event arrives. */
function seedMetaMode(ui: SessionUiState | undefined, meta: SessionMeta | undefined): SessionUiState {
  const base = ui ?? emptyUi(meta);
  if (!meta || base.modes.current !== 'default' || meta.permissionMode === 'default') return base;
  return { ...base, modes: { ...base.modes, current: meta.permissionMode } };
}

let unsubscribe: (() => void) | undefined;
let unsubscribeCompat: (() => void) | undefined;

/** loadOpencodeCatalog 的 in-flight 标记（模块级，不入 store）。 */
let opencodeCatalogLoading = false;

/** loadOmpCatalog 的 in-flight 标记（模块级，不入 store）。 */
let ompCatalogLoading = false;

/** refreshEngineConfigs 的 in-flight 去重（并发调用汇合到同一次 IPC）。 */
let engineConfigsRefresh: Promise<EngineConfigsSnapshot> | null = null;

/** Debounced per-session persistence of the folded message list. */
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const persistLastRun = new Map<string, number>();
/** Goal 完成公告暂存 — complete 事件到达时回合往往还在跑（模型先调
 *  update_goal 工具再写收尾总结），公告推迟到 turn.ended 再插，才不会
 *  插队在最终输出之前。 */
const pendingGoalDone = new Map<string, UnifiedMessage>();
/** 用户主动点过停止的会话 — 下一个 turn.ended 不再自动派发排队消息/
 *  自动压缩（引擎的 stopReason 不统一：opencode 中止后仍报 end_turn，
 *  只看 stopReason 挡不住「点了停止任务还在跑」）。 */
const stopRequested = new Set<string>();
/** 自动压缩冷却：触发后 usage 未见明显下降（omp 等不回推 usage 的通道）时
 *  跳过接下来 N 个回合，防连环触发；下降即解除。 */
const autoCompactGuard = new Map<string, { baselineUsed: number; skipTurns: number }>();
const PERSIST_DEBOUNCE = 400;
// 连续流式（每个 delta 都重置防抖）时最长 2s 强制落盘一次，
// 把「崩溃/热重启丢失的尾部输出」窗口从「整段回合」压到 ~2s。
const PERSIST_MAX_WAIT = 2000;

/** 选中即预热的防抖 — 快速连点浏览会话时，只预热最终停留的那一个，
 *  否则每个途经会话都会拉起一个引擎进程（曾致侧栏一排 starting 转圈）。 */
let warmUpTimer: ReturnType<typeof setTimeout> | undefined;
const WARM_UP_DELAY = 400;

function persistNow(get: () => ChatState, sessionId: string): void {
  const prev = persistTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  persistTimers.delete(sessionId);
  persistLastRun.set(sessionId, Date.now());
  const messages = get().ui[sessionId]?.messages;
  if (messages) void window.cyberslots.sessionMessagesSave(sessionId, messages);
}

function schedulePersist(get: () => ChatState, sessionId: string): void {
  // 未水合前不落盘 — 此时 ui 里只有几条实时消息，写回会覆盖完整
  // 历史文件（曾永久截断旧会话）。顺手触发水合，合并完成后再持久化。
  if (!get().ui[sessionId]?.hydrated) {
    get().hydrateSession(sessionId);
    return;
  }
  const last = persistLastRun.get(sessionId) ?? 0;
  if (Date.now() - last >= PERSIST_MAX_WAIT) {
    persistNow(get, sessionId);
    return;
  }
  const prev = persistTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  persistTimers.set(sessionId, setTimeout(() => persistNow(get, sessionId), PERSIST_DEBOUNCE));
}

/** 立即落盘（回合结束等关键节点，不等防抖）。 */
function flushPersist(get: () => ChatState, sessionId: string): void {
  if (!get().ui[sessionId]?.hydrated) return;
  persistNow(get, sessionId);
}

/** 退出前把所有挂起的落盘立即写完（尽力而为，减少尾部丢失）。 */
function flushAllPersist(get: () => ChatState): void {
  for (const id of [...persistTimers.keys()]) persistNow(get, id);
}

/** 右侧面板路径解析：相对路径按 cwd 的分隔符风格拼成绝对路径（绝对路径原样）。 */
function resolvePanelPath(cwd: string, rawPath: string): string {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(rawPath)) return rawPath;
  const sep = cwd.includes('\\') ? '\\' : '/';
  const rel = rawPath.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${rel}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  ui: {},
  activeSessionId: null,
  creating: false,
  creatingEngine: null,
  settings: null,
  settingsOpen: false,
  swarmBoost: false,
  cronOpen: false,
  archivedOpen: false,
  usageOpen: false,
  dashboardOpen: true,
  lastActivity: {},
  cronTasks: [],
  filter: DEFAULT_FILTER,
  goals: {},
  efforts: {},
  queues: {},
  selections: {},
  sending: {},
  composerDrafts: {},
  drafts: {},
  sidebarCollapsed: localStorage.getItem('cs.sidebarCollapsed') === '1',
  rightPanels: {},
  sidechats: {},
  terminals: {},
  planPreview: {},
  pendingFilePreview: {},
  pendingChangePreview: {},
  codexCatalog: [],
  codexDefaultEffort: undefined,
  kimiModels: [],
  claudeModelLabels: null,
  opencodeCatalog: null,
  ompCatalog: null,
  engineAvailability: null,
  openerAvailability: null,
  agySwitchFor: null,
  compatAudit: null,

  /** 懒加载 opencode 模型目录（in-flight 去重；失败结果也缓存，避免风暴重试）。 */
  async loadOpencodeCatalog(force) {
    if (!force && (get().opencodeCatalog || opencodeCatalogLoading)) return;
    opencodeCatalogLoading = true;
    try {
      const catalog = await window.cyberslots.opencodeCatalogGet(force);
      set({ opencodeCatalog: catalog });
    } catch (err) {
      set({ opencodeCatalog: { models: [], defaults: {}, error: err instanceof Error ? err.message : String(err) } });
    } finally {
      opencodeCatalogLoading = false;
    }
  },

  /** 懒加载 omp 模型目录（in-flight 去重；失败结果也缓存，避免风暴重试）。 */
  async loadOmpCatalog(force) {
    if (!force && (get().ompCatalog || ompCatalogLoading)) return;
    ompCatalogLoading = true;
    try {
      const catalog = await window.cyberslots.ompCatalogGet(force);
      set({ ompCatalog: catalog });
    } catch (err) {
      set({ ompCatalog: { models: [], error: err instanceof Error ? err.message : String(err) } });
    } finally {
      ompCatalogLoading = false;
    }
  },

  /** 配置文件是磁盘上的活物（主进程每次现读）— 这里是渲染层唯一的重读入口。 */
  async refreshEngineConfigs() {
    engineConfigsRefresh ??= window.cyberslots
      .engineConfigsGet()
      .then((snap) => {
        set({
          codexCatalog: snap.codex.catalogModels ?? [],
          codexDefaultEffort: snap.codex.reasoningEffort,
          kimiModels: (snap.kimi.providers ?? []).flatMap((p) => p.models),
          claudeModelLabels: snap.claude.modelLabels ?? null,
          // 可用性：opencode/omp/antigravity/claude 有真实 CLI 探测；kimi/codex 用配置存在性
          // 近似（装过并登录/初始化过才会有 config.toml）。
          engineAvailability: {
            kimi: snap.kimi.exists,
            codex: snap.codex.exists,
            opencode: snap.opencode.installed,
            omp: snap.omp.installed,
            antigravity: snap.antigravity.installed,
            claude: snap.claude.installed,
          },
        });
        return snap;
      })
      .finally(() => {
        engineConfigsRefresh = null;
      });
    return engineConfigsRefresh;
  },

  async init() {
    let sessions: Awaited<ReturnType<typeof window.cyberslots.sessionList>>;
    let settings: Awaited<ReturnType<typeof window.cyberslots.settingsGet>>;
    try {
      [sessions, settings] = await Promise.all([
        window.cyberslots.sessionList(),
        window.cyberslots.settingsGet(),
      ]);
    } catch (err) {
      rlog.error('app', 'store init failed (sessionList/settingsGet)', undefined, err);
      throw err;
    }
    set({ sessions, settings });
    rlog.info('app', 'store initialized', { sessions: sessions.length, language: settings.language });
    // codex 配置快照 — catalog 目录 + 默认思考深度（选择器的元信息源）。
    void get().refreshEngineConfigs();
    // 「外部打开」程序可用性 — 启动后探测一次，菜单据此隐藏未安装项。
    void window.cyberslots.openersDetect().then((a) => set({ openerAvailability: a })).catch(() => undefined);
    unsubscribe?.();
    unsubscribe = window.cyberslots.onEngineEvent((envelope) => {
      applyEnvelope(set, get, envelope);
    });
    // 兼容性审计：启动时拉一次存量（主进程内存态），后续增量走推送。
    void window.cyberslots.compatAuditGet().then((snap) => set({ compatAudit: snap })).catch(() => undefined);
    unsubscribeCompat?.();
    unsubscribeCompat = window.cyberslots.onCompatAudit((snap) => set({ compatAudit: snap }));
    // 退出/刷新前把挂起的消息落盘写完，尽量不丢正在执行任务的尾部。
    window.addEventListener('beforeunload', () => flushAllPersist(get));
  },

  async saveSettings(patch) {
    const settings = await window.cyberslots.settingsSet(patch);
    set({ settings });
  },

  async addWorkspace(name, folders) {
    const ws: WorkspaceInfo = { id: crypto.randomUUID(), name, folders, createdAt: Date.now() };
    await get().saveSettings({ workspaces: [...(get().settings?.workspaces ?? []), ws] });
    return ws;
  },

  async updateWorkspace(ws) {
    const workspaces = (get().settings?.workspaces ?? []).map((w) => (w.id === ws.id ? ws : w));
    await get().saveSettings({ workspaces });
    // 目录集可能变了 — 让引擎在下一条消息前获知最新根目录列表。
    await window.cyberslots.workspaceAnnounce(ws.id);
  },

  async convertProjectToWorkspace(cwd, name, folders) {
    const ws = await get().addWorkspace(name, folders);
    await window.cyberslots.sessionAssignWorkspace(cwd, ws.id);
    await window.cyberslots.workspaceAnnounce(ws.id);
    set((s) => ({
      sessions: s.sessions.map((m) =>
        !m.workspaceId && m.chatMode === 'work' && m.cwd === cwd ? { ...m, workspaceId: ws.id } : m,
      ),
    }));
  },

  async removeWorkspace(id) {
    const workspaces = (get().settings?.workspaces ?? []).filter((w) => w.id !== id);
    await get().saveSettings({ workspaces });
  },

  async createSession(req) {
    // 任何会话导航都退出赛马全屏视图（赛马继续后台跑，Composer 🏇 可回），
    // 否则 RaceView 压在 ChatView 上，侧栏点击看起来全部失灵。
    useRaceStore.getState().closeRace();
    set({ creating: true, creatingEngine: req.engine });
    let meta: Awaited<ReturnType<typeof window.cyberslots.sessionCreate>>;
    try {
      meta = await window.cyberslots.sessionCreate(req).catch((err) => {
        rlog.error('chat', 'sessionCreate ipc failed', { engine: req.engine, cwd: req.cwd }, err);
        throw err;
      });
      set((s) => ({
        sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)],
        // 新会话没有历史可水合 — 直接标记 hydrated，避免首条消息被水合门禁拖延落盘。
        ui: { ...s.ui, [meta.id]: { ...seedMetaMode(s.ui[meta.id], meta), hydrated: true } },
        activeSessionId: meta.id,
      }));
    } finally {
      set({ creating: false, creatingEngine: null });
    }
  },

  selectSession(id) {
    // 同上：会话导航优先于赛马全屏视图。
    useRaceStore.getState().closeRace();
    set({ activeSessionId: id });
    void window.cyberslots.sessionMarkRead(id);
    set((s) => ({ sessions: s.sessions.map((m) => (m.id === id ? { ...m, unread: false } : m)) }));
    get().hydrateSession(id);
    // 预热引擎：恢复态会话不再等首条消息才懒启动，选中即唤醒，
    // 模型/思考深度选择器、命令等立即就绪，首次发送也无启动延迟。
    // 防抖：停留满 WARM_UP_DELAY 且仍是当前会话才真正预热。
    clearTimeout(warmUpTimer);
    warmUpTimer = setTimeout(() => {
      if (get().activeSessionId === id) void window.cyberslots.sessionWarmUp(id);
    }, WARM_UP_DELAY);
  },

  /** Lazy-hydrate persisted history the first time a session is rendered. */
  hydrateSession(id) {
    if (get().ui[id]?.hydrated) return;
    const meta = get().sessions.find((m) => m.id === id);
    void window.cyberslots.sessionMessagesGet(id).then((persisted) => {
      const messages = persisted.map((m) =>
        (m.kind === 'text' || m.kind === 'thinking') && m.streaming ? { ...m, streaming: false } : m,
      );
      set((s) => {
        // 合并而非二选一 — 曾经「流非空就丢弃持久化历史」，与早于水合
        // 到达的引擎事件（恢复降级报错等）竞态，导致历史被截断并回写覆盖。
        const live = s.ui[id]?.messages ?? [];
        const liveIds = new Set(live.map((m) => m.id));
        return {
          ui: {
            ...s.ui,
            [id]: {
              ...seedMetaMode(s.ui[id], meta),
              messages: [...messages.filter((m) => !liveIds.has(m.id)), ...live],
              hydrated: true,
            },
          },
        };
      });
      // 水合前被门禁的落盘在此补上（合并后的完整列表）。
      schedulePersist(get, id);
    });
  },

  /** Sidechat: branch off the given session and jump into the branch. */
  async forkSession(id) {
    set({ creating: true, creatingEngine: get().sessions.find((s) => s.id === id)?.engine ?? null });
    try {
      const meta = await window.cyberslots.sessionFork(id);
      set((s) => ({
        sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)],
        ui: { ...s.ui, [meta.id]: seedMetaMode(s.ui[meta.id], meta) },
      }));
      get().selectSession(meta.id);
    } finally {
      set({ creating: false, creatingEngine: null });
    }
  },

  /** Sidechat（右侧分支对话）：fork 出只读分支，在主对话右侧面板打开，
   *  不切换主会话。只读约束：codex 用 plan 模式（read-only sandbox 硬隔离）；
   *  kimi 的 plan 模式会触发写计划文件的工作流（e2e 实测），改用
   *  default 模式 + 每条消息前置只读指令（见 SIDECHAT_GUARD）。 */
  async openSidechat(parentId) {
    set({ creating: true, creatingEngine: get().sessions.find((s) => s.id === parentId)?.engine ?? null });
    try {
      const parent = get().sessions.find((s) => s.id === parentId);
      const meta = await window.cyberslots.sessionFork(parentId);
      const mode: PermissionMode = parent?.engine === 'codex' ? 'plan' : 'default';
      if (mode === 'plan') {
        await window.cyberslots.sessionSetMode(meta.id, 'plan');
      }
      const patched = { ...meta, permissionMode: mode };
      set((s) => ({
        sessions: [patched, ...s.sessions.filter((x) => x.id !== meta.id)],
        ui: { ...s.ui, [meta.id]: seedMetaMode(s.ui[meta.id], patched) },
        sidechats: { ...s.sidechats, [parentId]: [...(s.sidechats[parentId] ?? []), meta.id] },
      }));
      get().hydrateSession(meta.id);
      if (mode === 'plan') {
        mutateUi(set, meta.id, (ui) => ({ ...ui, modes: { ...ui.modes, current: 'plan' } }));
      }
      void window.cyberslots.sessionWarmUp(meta.id); // 预热分支引擎
      return meta.id;
    } finally {
      set({ creating: false, creatingEngine: null });
    }
  },

  async closeSidechat(branchId) {
    // 关 tab 即清理：分支是阅后即焚的只读问答，直接删会话；
    // sidechats 映射由 deleteSession 内统一摘除。
    await get().deleteSession(branchId);
  },

  addTerminal(sessionId, cwd) {
    const id = crypto.randomUUID();
    set((s) => ({
      terminals: { ...s.terminals, [sessionId]: [...(s.terminals[sessionId] ?? []), { id, cwd }] },
    }));
    return id;
  },

  removeTerminal(sessionId, termId) {
    void window.cyberslots.terminalDispose(termId); // 同步杀掉后端 PTY
    set((s) => ({
      terminals: { ...s.terminals, [sessionId]: (s.terminals[sessionId] ?? []).filter((t) => t.id !== termId) },
    }));
  },

  toggleSidebar() {
    const next = !get().sidebarCollapsed;
    localStorage.setItem('cs.sidebarCollapsed', next ? '1' : '0');
    set({ sidebarCollapsed: next });
  },

  setRightPanel(sessionId, patch) {
    set((s) => ({
      rightPanels: {
        ...s.rightPanels,
        [sessionId]: { open: false, activeTab: 'files', ...s.rightPanels[sessionId], ...patch },
      },
    }));
  },

  setPlanPreview(sessionId, messageId) {
    set((s) => ({ planPreview: { ...s.planPreview, [sessionId]: messageId } }));
  },

  requestFilePreview(sessionId, rawPath) {
    const meta = get().sessions.find((m) => m.id === sessionId);
    // 非 work 会话没有文件面板 — chip 仅作展示，点击无动作。
    if (!meta || meta.chatMode !== 'work') return;
    // AI 常写裸文件名（`SettingsView.tsx`）或省略目录前缀，直接拼 cwd 会 ENOENT —
    // 先让主进程在工作区内模糊定位真实文件，定位不到就不打开（避免面板报 ENOENT）。
    void window.cyberslots
      .fsResolve(meta.cwd, rawPath)
      .then((path) => {
        if (!path) {
          rlog.info('chat', 'file preview skipped: path not found in workspace', { sessionId, rawPath });
          return;
        }
        set((s) => ({ pendingFilePreview: { ...s.pendingFilePreview, [sessionId]: { path, nonce: Date.now() } } }));
      })
      .catch((err) => rlog.error('chat', 'fsResolve ipc failed', { sessionId }, err));
  },

  requestChangePreview(sessionId, rawPath) {
    const meta = get().sessions.find((m) => m.id === sessionId);
    // 非 work 会话没有变更面板 — 点击回退为卡内展开（EditCard 自行判断）。
    if (!meta || meta.chatMode !== 'work') return;
    const path = resolvePanelPath(meta.cwd, rawPath);
    set((s) => ({ pendingChangePreview: { ...s.pendingChangePreview, [sessionId]: { path, nonce: Date.now() } } }));
  },

  /** 换引擎继续聊：history-replay branch onto the other engine。
   *  空白会话主进程原地换引擎（返回同 id，不产生分支）— 此时重置该会话
   *  的 per-session ui：旧引擎推过的模型/模式/命令残留会在新引擎首次推送前
   *  误显示；消息本为空（主进程以 messages.length===0 判定），无历史可丢。 */
  async forkToEngine(id, engine) {
    set({ creating: true, creatingEngine: engine });
    try {
      const meta = await window.cyberslots.sessionForkEngine(id, engine);
      const inPlace = meta.id === id;
      set((s) => ({
        sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)],
        ui: inPlace
          ? { ...s.ui, [id]: emptyUi(meta) }
          : { ...s.ui, [meta.id]: seedMetaMode(s.ui[meta.id], meta) },
      }));
      get().selectSession(meta.id);
    } finally {
      set({ creating: false, creatingEngine: null });
    }
  },

  async compactSession() {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    // 不支持压缩的引擎（antigravity 无 adapter.compact）会 reject —— 显性
    // 提示，不再无声失败；剥掉 ipcRenderer.invoke 的包装前缀取主进程原消息。
    try {
      await window.cyberslots.sessionCompact(activeSessionId);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const m = /Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw);
      announceSystem(activeSessionId, `⚠️ ${(m?.[1] || raw).trim()}`);
    }
  },

  async sendPrompt(text, attachments, selections) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    await get().sendPromptTo(activeSessionId, text, attachments, undefined, selections);
  },

  async sendPromptTo(sessionId, text, attachments, enginePrefix, selections) {
    const { swarmBoost, efforts } = get();
    // 用户主动发新消息 = 解除「停止」态 — 消账，免得回合已结束后
    // 才点的停止残留标记，误伤下个正常回合的队列派发。
    stopRequested.delete(sessionId);
    const typedText = text;
    // 选区引用序列化后注在正文最前（上下文在前、提问在后；
    // 引擎前缀/机器人指令仍保持最前）。
    text = serializeSelections(selections) + text;
    // enginePrefix（如 sidechat 只读指令）优先于 swarm 前缀，且不入气泡。
    // 原生 swarm 会话（kimi KAP）不叠加提示词前缀 — swarm_mode 由引擎
    // 强制，再拼引导语只会污染提问。
    const nativeSwarm = !!get().sessions.find((m) => m.id === sessionId)?.capabilities?.swarm;
    const finalText = enginePrefix
      ? `${enginePrefix}\n\n${text}`
      : swarmBoost && !nativeSwarm
        ? `请优先使用 AgentSwarm 并行子代理拆解与执行以下任务（可并行的子任务尽量委派给子代理）：\n${text}`
        : text;
    const userMsg: UnifiedMessage = {
      kind: 'user',
      id: crypto.randomUUID(),
      turnId: -1,
      text: typedText,
      attachments,
      selections: selections?.length ? selections : undefined,
      createdAt: Date.now(),
    };
    mutateUi(set, sessionId, (ui) => ({ ...ui, messages: [...ui.messages, userMsg] }));
    schedulePersist(get, sessionId);
    // 在途标记：引擎启动中也允许发送（主进程 prompt 会等启动完再投递），
    // 期间后续消息据此走排队，避免并发 prompt 打架。
    set((s) => ({ sending: { ...s.sending, [sessionId]: true } }));
    // First user message becomes the session title.
    const session = get().sessions.find((s) => s.id === sessionId);
    const firstMessage = !!(session && isDefaultTitle(session.title));
    if (firstMessage) {
      const title = typedText.slice(0, 24) || (selections?.length ? `${selections[0]!.fileName} ${selectionRangeLabel(selections[0]!)}` : '') || session.title;
      autoTitleSession(get, set, sessionId, typedText, title);
    }
    // 思考深度下发值 = EffortPicker 的显示值（共享解析 src/renderer/src/effort.ts）：
    // 用户未显选档时，界面展示的默认档同样是用户意图 —— 引擎会话档是引擎侧
    // 持久状态（KAP 服务端/claude /effort/omp ACP），重启后 override 清空，
    // 不显式下发会静默沿用残留档，界面与实际运行脱节。undefined = 无档位面
    // （antigravity / 目录未就绪 / 模型无档声明）→ 不下发，跟随引擎当前档。
    const effortMeta = get().sessions.find((m) => m.id === sessionId);
    const effortModels = get().ui[sessionId]?.models;
    const effectiveEffort = resolveEffectiveEffort({
      engine: effortMeta?.engine,
      override: efforts[sessionId],
      activeModel: effortModels?.current || effortModels?.available[0] || effortMeta?.modelId || '',
      kimiModels: get().kimiModels,
      codexCatalog: get().codexCatalog,
      codexDefaultEffort: get().codexDefaultEffort,
      opencodeCatalog: get().opencodeCatalog,
      ompCatalog: get().ompCatalog,
    })?.value;
    // 步骤3：新会话首条消息前，若当前 antigravity 账号已 blocked 则先切后发。
    if (firstMessage && session?.engine === 'antigravity') {
      await maybePreCheckAgyAccount(get, sessionId);
    }
    try {
      await window.cyberslots.sessionPrompt({
        sessionId,
        text: finalText,
        attachments,
        effort: effectiveEffort,
        userMessageId: userMsg.id,
      }).catch((err) => {
        // superseded（agy 并发总闸拒绝）由调用方按场景静默吞（catchAutoResume），
        // 此处不重复记 error。
        if (!String(err?.message ?? err).includes('superseded')) {
          rlog.error('chat', 'sessionPrompt ipc failed', { sessionId, chars: finalText.length }, err);
        }
        throw err;
      });
    } finally {
      set((s) => ({ sending: { ...s.sending, [sessionId]: false } }));
    }
  },

  openAgySwitch(sessionId) {
    set({ agySwitchFor: sessionId });
  },
  closeAgySwitch() {
    set({ agySwitchFor: null });
  },
  async switchAgyAccount(accountId, continueSessionId) {
    const res = await window.cyberslots.agyAccountSwitch(accountId);
    set({ agySwitchFor: null });
    // 切号后接回任务：赛马角色会话走 raceResume（重跑当前阶段，而非
    // 把「继续」发给编排器不监听的隐藏角色会话）；普通会话发「继续」
    // —— agy 从本地库重放整段历史给新账号，跨账号续接不丢上下文
    // （实测坐实，见 docs/antigravity-integration.md §3.8）。
    if (continueSessionId) {
      const meta = get().sessions.find((m) => m.id === continueSessionId);
      if (meta?.raceId) void window.cyberslots.raceResume(meta.raceId);
      else void get().sendPromptTo(continueSessionId, '继续').catch(catchAutoResume(continueSessionId, 'manual-switch'));
    }
    return res;
  },

  addSelection(sessionId, sel) {
    set((s) => {
      const list = s.selections[sessionId] ?? [];
      // 同文件同行号范围不重复添加（避免卡片刷屏）。
      if (list.some((x) => x.path === sel.path && x.startLine === sel.startLine && x.endLine === sel.endLine)) return {};
      return { selections: { ...s.selections, [sessionId]: [...list, sel] } };
    });
  },

  removeSelection(sessionId, id) {
    set((s) => ({
      selections: { ...s.selections, [sessionId]: (s.selections[sessionId] ?? []).filter((x) => x.id !== id) },
    }));
  },

  clearSelections(sessionId) {
    set((s) => ({ selections: { ...s.selections, [sessionId]: [] } }));
  },

  async cancel() {
    const { activeSessionId } = get();
    if (activeSessionId) await get().cancelSession(activeSessionId);
  },

  async cancelSession(sessionId) {
    // 先记账再发请求：中断落地时（turn.ended）据此按「用户停止」收尾。
    stopRequested.add(sessionId);
    try {
      await window.cyberslots.sessionCancel(sessionId);
    } catch (err) {
      // 中止被引擎拒绝/请求失败必须显性化 — 静默吞掉的话「点停止没反应」无从排查。
      const emsg = err instanceof Error ? err.message : String(err);
      announceSystem(
        sessionId,
        (get().settings?.language ?? 'zh') === 'zh' ? `⚠ 中止失败：${emsg}` : `⚠ Cancel failed: ${emsg}`,
      );
    }
  },

  async undoToMessage(sessionId, messageId) {
    const removed = await window.cyberslots.sessionUndo(sessionId, messageId);
    mutateUi(set, sessionId, (ui) => {
      const idx = ui.messages.findIndex((m) => m.kind === 'user' && m.id === messageId);
      return idx < 0 ? ui : { ...ui, messages: ui.messages.slice(0, idx) };
    });
    // 立即落盘：取消防抖窗口内可能把旧列表回写磁盘的定时器。
    persistNow(get, sessionId);
    set((s) => ({
      composerDrafts: { ...s.composerDrafts, [sessionId]: { text: removed.text, nonce: Date.now() } },
    }));
  },

  async setModel(modelId) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    try {
      await window.cyberslots.sessionSetModel(activeSessionId, modelId);
    } catch (err) {
      // 引擎拒绝/请求失败必须显性化 — 静默吞掉的话「切模型没反应」无从排查。
      announceSystem(activeSessionId, `⚠ 切换模型失败（${modelId}）：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async setMode(mode) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    try {
      await window.cyberslots.sessionSetMode(activeSessionId, mode);
    } catch (err) {
      // 与 setModel 同规：失败显性化，且不乐观更新（否则 UI 停在未生效的档位）。
      announceSystem(activeSessionId, `⚠ 切换权限模式失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Optimistic: kimi doesn't always push current_mode_update after
    // setSessionMode, which left the mode switch looking dead in the UI.
    mutateUi(set, activeSessionId, (ui) => ({ ...ui, modes: { ...ui.modes, current: mode } }));
  },

  async answerPermission(requestId, optionId) {
    const { activeSessionId } = get();
    if (activeSessionId) {
      await window.cyberslots.sessionAnswerPermission({
        sessionId: activeSessionId,
        requestId,
        optionId,
      });
    }
  },

  async answerPermissionTo(sessionId, requestId, optionId) {
    await window.cyberslots.sessionAnswerPermission({ sessionId, requestId, optionId });
    // 乐观标记已应答 — permission.resolved 未必即时回推，卡面按钮需立即定格。
    mutateUi(set, sessionId, (ui) => ({
      ...ui,
      messages: ui.messages.map((m) =>
        (m.kind === 'permission' || m.kind === 'ask_user') && m.requestId === requestId && m.answeredOptionId === undefined
          ? { ...m, answeredOptionId: optionId ?? '__cancelled__' }
          : m,
      ),
    }));
  },

  noteAskUserAnswer(sessionId, requestId, note) {
    mutateUi(set, sessionId, (ui) => ({
      ...ui,
      messages: ui.messages.map((m) => (m.kind === 'ask_user' && m.requestId === requestId ? { ...m, answeredNote: note } : m)),
    }));
    schedulePersist(get, sessionId);
  },

  openDashboard() {
    useRaceStore.getState().closeRace();
    set({ activeSessionId: null, dashboardOpen: true, settingsOpen: false, usageOpen: false, archivedOpen: false });
  },

  async markSessionRead(id) {
    await window.cyberslots.sessionMarkRead(id);
    set((s) => ({ sessions: s.sessions.map((m) => (m.id === id ? { ...m, unread: false } : m)) }));
  },

  async retryLast(sessionId) {
    // 未水合时直接读持久化历史（只读，不触碰落盘路径）。
    const ui = get().ui[sessionId];
    const msgs = ui?.hydrated ? ui.messages : await window.cyberslots.sessionMessagesGet(sessionId);
    const lastUser = [...msgs].reverse().find((m) => m.kind === 'user');
    if (!lastUser || lastUser.kind !== 'user') return false;
    await get().sendPromptTo(sessionId, lastUser.text, lastUser.attachments, undefined, lastUser.selections);
    return true;
  },

  async steerLive(sessionId, text) {
    const status = get().sessions.find((m) => m.id === sessionId)?.status;
    // 空闲/出错会话没有可注入的回合 — 直接作为新提问发送。
    if (status !== 'running' && status !== 'awaiting' && !get().sending[sessionId]) {
      void get().sendPromptTo(sessionId, text);
      return 'sent';
    }
    const ok = await window.cyberslots.sessionSteer(sessionId, text);
    if (ok) return 'steered';
    get().enqueueTo(sessionId, text);
    return 'queued';
  },

  enqueue(text, attachments, selections) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    get().enqueueTo(activeSessionId, text, attachments, selections);
  },

  enqueueTo(sessionId, text, attachments, selections) {
    const item: QueuedMessage = { id: crypto.randomUUID(), text, attachments, selections: selections?.length ? selections : undefined };
    set((s) => ({ queues: { ...s.queues, [sessionId]: [...(s.queues[sessionId] ?? []), item] } }));
  },

  removeQueued(sessionId, id) {
    set((s) => ({ queues: { ...s.queues, [sessionId]: (s.queues[sessionId] ?? []).filter((q) => q.id !== id) } }));
  },

  moveQueued(sessionId, from, to) {
    set((s) => {
      const list = [...(s.queues[sessionId] ?? [])];
      if (from < 0 || from >= list.length || to < 0 || to >= list.length) return {};
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item!);
      return { queues: { ...s.queues, [sessionId]: list } };
    });
  },

  /** Steer: codex injects into the running turn; when not steerable the
   *  item jumps to the queue head instead (kimi 降级路径). */
  async steerQueued(sessionId, id) {
    const item = (get().queues[sessionId] ?? []).find((q) => q.id === id);
    if (!item) return 'none';
    const ok = await window.cyberslots.sessionSteer(sessionId, serializeSelections(item.selections) + item.text);
    if (ok) {
      get().removeQueued(sessionId, id);
      return 'steered';
    }
    // kimi has no native steer: fall back to queue head; when already there,
    // report 'head' so the UI can explain instead of looking dead.
    const list = get().queues[sessionId] ?? [];
    const idx = list.findIndex((q) => q.id === id);
    if (idx > 0) {
      get().moveQueued(sessionId, idx, 0);
      return 'moved';
    }
    return 'head';
  },

  /** Engine-native goal (codex only — UI hides the control for kimi). */
  async setGoal(objective) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    // 提问入气泡并标注「Sent as goal」（engine 的 thread/goal 不产出用户消息）。
    const userMsg: UnifiedMessage = {
      kind: 'user',
      id: crypto.randomUUID(),
      turnId: -1,
      text: objective,
      createdAt: Date.now(),
      sentAsGoal: true,
    };
    mutateUi(set, activeSessionId, (ui) => ({ ...ui, messages: [...ui.messages, userMsg] }));
    schedulePersist(get, activeSessionId);
    // 乐观置入状态条 — thread/goal/set 往返（含懒启动引擎）期间 GoalBar
    // 不能空窗；引擎真实快照到达后覆盖，失败则回滚。
    const prevGoal = get().goals[activeSessionId];
    set((s) => ({
      goals: {
        ...s.goals,
        [activeSessionId]: {
          objective,
          status: 'active' as const,
          // replace 语义（引擎侧 clear+set）— 计数从零开始，别继承旧 goal。
          tokensUsed: 0,
          timeUsedSeconds: 0,
          tokenBudget: undefined,
        },
      },
    }));
    // 首条消息即会话标题（与普通提问同规则）。
    const session = get().sessions.find((s) => s.id === activeSessionId);
    if (session && isDefaultTitle(session.title)) {
      autoTitleSession(get, set, activeSessionId, objective, objective.slice(0, 24) || session.title);
    }
    try {
      await window.cyberslots.sessionGoalSet(activeSessionId, objective);
    } catch (err) {
      // 失败回滚乐观状态、撤回「Sent as goal」气泡（没发出去不能留标注），
      // 并把错误显性化到消息流。
      set((s) => ({ goals: { ...s.goals, [activeSessionId]: prevGoal } }));
      mutateUi(set, activeSessionId, (ui) => ({
        ...ui,
        messages: [
          ...ui.messages.filter((m) => m.id !== userMsg.id),
          {
            kind: 'error',
            id: crypto.randomUUID(),
            turnId: -1,
            message:
              (get().settings?.language ?? 'zh') === 'zh'
                ? `Goal 设置失败：${err instanceof Error ? err.message : String(err)}`
                : `Goal setup failed: ${err instanceof Error ? err.message : String(err)}`,
            createdAt: Date.now(),
          },
        ],
      }));
    }
  },

  async controlGoal(action) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    try {
      await window.cyberslots.sessionGoalControl(activeSessionId, action);
    } catch (err) {
      // 失败显性化到消息流 — 静默吞掉「点了没反应」无从排查。
      const emsg = err instanceof Error ? err.message : String(err);
      announceSystem(
        activeSessionId,
        (get().settings?.language ?? 'zh') === 'zh' ? `⚠ Goal 操作失败：${emsg}` : `⚠ Goal control failed: ${emsg}`,
      );
    }
  },

  async setSwarm(sessionId, active) {
    // 乐观翻转；失败回滚（引擎真实状态随后经 swarm.update 回声纠正）。
    mutateUi(set, sessionId, (ui) => ({ ...ui, swarm: active }));
    try {
      await window.cyberslots.sessionSetSwarm(sessionId, active);
    } catch {
      mutateUi(set, sessionId, (ui) => ({ ...ui, swarm: !active }));
    }
  },

  async renameSession(id, title) {
    await window.cyberslots.sessionRename(id, title);
    set((s) => ({ sessions: s.sessions.map((m) => (m.id === id ? { ...m, title } : m)) }));
  },

  async archiveSession(id, archived) {
    // 拦截兜底：进行中的会话 / 名下有进行中赛马的宿主不可归档
    // （UI 入口已禁用/跳过，这里防未来新入口绕过；还原不拦）。
    if (archived) {
      const meta = get().sessions.find((m) => m.id === id);
      const busy =
        meta?.status === 'running' ||
        meta?.status === 'starting' ||
        Object.values(useRaceStore.getState().races).some((g) => g.parentSessionId === id && isRaceActive(g));
      if (busy) return;
    }
    await window.cyberslots.sessionSetArchived(id, archived);
    set((s) => ({
      sessions: s.sessions.map((m) => (m.id === id ? { ...m, archived, unread: archived ? false : m.unread } : m)),
      // 归档当前正打开的会话 → 退回新会话页（它已从侧栏消失）。
      activeSessionId: archived && s.activeSessionId === id ? null : s.activeSessionId,
    }));
  },

  async deleteSession(id) {
    rlog.info('chat', 'session delete requested', { sessionId: id });
    // 先摘防抖落盘计时器 —— 主进程删消息文件与下方清 ui 之间的窗口里
    // 它触发会把刚删除的文件复活（ghost file）。
    const pt = persistTimers.get(id);
    if (pt) clearTimeout(pt);
    persistTimers.delete(id);
    await window.cyberslots.sessionDelete(id).catch((err) => {
      rlog.error('chat', 'sessionDelete ipc failed', { sessionId: id }, err);
      throw err;
    });
    // 同步清理：该会话挂的终端 PTY，以及它在任意 sidechat 映射里的引用。
    for (const t of get().terminals[id] ?? []) void window.cyberslots.terminalDispose(t.id);
    set((s) => ({
      sessions: s.sessions.filter((m) => m.id !== id),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
      terminals: { ...s.terminals, [id]: undefined },
      rightPanels: { ...s.rightPanels, [id]: undefined },
      goals: { ...s.goals, [id]: undefined },
      efforts: Object.fromEntries(Object.entries(s.efforts).filter(([k]) => k !== id)),
      ui: Object.fromEntries(Object.entries(s.ui).filter(([k]) => k !== id)),
      sidechats: Object.fromEntries(
        Object.entries(s.sidechats).map(([k, v]) => [k, k === id ? undefined : v?.filter((x) => x !== id)]),
      ),
    }));
    // 其余按会话 id 键控的散表一并摘（会话已不存在，残留即泄漏）。
    persistLastRun.delete(id);
    pendingGoalDone.delete(id);
    stopRequested.delete(id);
    autoCompactGuard.delete(id);
  },

  async loadCron() {
    set({ cronTasks: await window.cyberslots.cronList() });
  },

  async saveCron(task) {
    set({ cronTasks: await window.cyberslots.cronSave(task) });
  },

  async deleteCron(id) {
    set({ cronTasks: await window.cyberslots.cronDelete(id) });
  },

  async runCronNow(id) {
    await window.cyberslots.cronRunNow(id);
    // Refresh sessions shortly after — the run creates a new visible session.
    setTimeout(() => {
      void window.cyberslots.sessionList().then((sessions) => set({ sessions }));
    }, 1200);
  },
}));

// ------------------------------------------------------------ event folding

type SetFn = (fn: (s: ChatState) => Partial<ChatState>) => void;
type GetFn = () => ChatState;

/** 向指定会话插一条系统公告并持久化（赛马发起/收尾等跨模块回流用，
 *  与 Goal 完成公告同模式）。 */
export function announceSystem(sessionId: string, text: string): void {
  const set: SetFn = (fn) => useChatStore.setState(fn);
  mutateUi(set, sessionId, (ui) => ({
    ...ui,
    messages: [
      ...ui.messages,
      { kind: 'system', id: crypto.randomUUID(), turnId: -1, text, createdAt: Date.now() },
    ],
  }));
  schedulePersist(useChatStore.getState, sessionId);
}

// ---------------------------------------------- antigravity 额度自动切号

/** 自动切号全局互斥：keyring 是全局唯一一条，多路触发（多个失败回合/
 *  主动+兜底并发）只允许一个切换在途，其余静默跳过。 */
let agyAutoSwitchInflight = false;

// ---- 步骤1：连续切号熔断 ----

/** 自动切号成功时间戳（滚动窗口）；超过窗口的条目惰性裁剪。
 *  超过 AGY_AUTOSWITCH_RATE_LIMIT 次/窗口 → 停自动切号，回退手动弹窗。
 *  防止系统性故障时把整池挨个烧一遍（每次切号都伴随 enterprise 现刷 +
 *  CredWrite，是最像滥用的行为模式）。 */
const AGY_AUTOSWITCH_RATE_WINDOW_MS = 10 * 60 * 1000; // 10 分钟
const AGY_AUTOSWITCH_RATE_LIMIT = 3; // 窗口内最多 3 次自动切号
const agyAutoSwitchHistory: number[] = [];

/** 判断自动切号是否已被熔断（窗口内成功次数超限）。 */
function agyAutoSwitchRateLimited(): boolean {
  const now = Date.now();
  while (agyAutoSwitchHistory.length > 0 && agyAutoSwitchHistory[0]! < now - AGY_AUTOSWITCH_RATE_WINDOW_MS) {
    agyAutoSwitchHistory.shift();
  }
  return agyAutoSwitchHistory.length >= AGY_AUTOSWITCH_RATE_LIMIT;
}

/** 记录一次成功的自动切号（用于熔断计数）。 */
function recordAgyAutoSwitch(): void {
  agyAutoSwitchHistory.push(Date.now());
  const now = Date.now();
  while (agyAutoSwitchHistory.length > 0 && agyAutoSwitchHistory[0]! < now - AGY_AUTOSWITCH_RATE_WINDOW_MS) {
    agyAutoSwitchHistory.shift();
  }
}

/** 正常回合收尾时清零熔断计数（证明当前账号在正常工作）。 */
function clearAgyAutoSwitchHistory(): void {
  agyAutoSwitchHistory.length = 0;
}

// ---- 耗尽账号冷却（状态在主进程，快照同步） ----

/** 快照 blocked 表 → 未到期冷却邮箱集（渲染层按时间戳惰性过滤）。
 *  冷却表唯一真源在 main 的 agyAccounts（坐实探测/池扫描落 blocked、
 *  恢复即清、到期惰性失效）；渲染层不自行重查维护 —— 坐实耗尽事件自带
 *  quotaEmail/quotaResetsInSeconds，省一次真实 Google 调用。 */
function blockedEmailsOf(snap: { blocked?: Record<string, number> }): Set<string> {
  const now = Date.now();
  const out = new Set<string>();
  for (const [email, until] of Object.entries(snap.blocked ?? {})) if (until > now) out.add(email);
  return out;
}

// ---- 步骤4：普通会话非额度错误自动重试 ----

/** 每会话仅自动重试一次（防无限循环）；正常回合收尾时清除。 */
const agyAutoRetriedSessions = new Map<string, boolean>();

/** 「继续」类自动补发的统一 catch：adapter 并发总闸的 superseded 拒绝静默
 *  （原回合收尾后由切号/补跑等正当路径接回），其余失败记 warn。防 void
 *  发射留 unhandled rejection。 */
function catchAutoResume(sessionId: string, where: string): (e: unknown) => void {
  return (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('superseded')) return;
    rlog.warn('chat', `agy auto-resume rejected (${where})`, { sessionId, err: msg });
  };
}

/** 按 raceId + sessionId 反查选手角色（racerA/racerB/racerC）。
 *  赛马切号成功后据此精确补跑缺产物的那名选手，而非按阶段整跑。 */
function raceRoleOfSession(raceId: string, sessionId: string): RaceRole | undefined {
  const g = useRaceStore.getState().races[raceId];
  if (!g?.sessions) return undefined;
  const entry = (Object.entries(g.sessions) as Array<[RaceRole, string | undefined]>).find(([, sid]) => sid === sessionId);
  return entry?.[0];
}

/** 时间窗标签 → 对应阈值：5小时/7天各自独立配置（主进程已把分组名归一
 *  为时间窗标签）；未知窗标签（后端新增分组等）取两者中较低的阈值 ——
 *  宽松兜底，避免误触发切号/误杀候选账号。 */
function agyWindowThreshold(group: string, t5h: number, t7d: number): number {
  return group === '5小时' ? t5h : group === '7天' ? t7d : Math.min(t5h, t7d);
}

/** 从额度快照挑一个可切换的目标账号。三道硬门槛：查得到(ok) + 非当前账号
 *  + 每个时间窗剩余都 ≥ 各自阈值（5小时/7天独立门槛，任一窗低就快堵）。
 *  合格池按「短板窗」min(各窗剩余 - 各窗阈值) 最厚优先 —— 两窗尺度不同，
 *  可用寿命由更贴近自身阈值的窗决定，相对余量最厚 = 切过去最耐用、
 *  最不易立刻再触发。无合格返回 undefined。 */
export function pickAgySwitchTarget(
  quotas: AgyQuotaInfo[],
  currentEmail: string | undefined,
  t5h: number,
  t7d: number,
  blockedEmails?: Set<string>,
): AgyQuotaInfo | undefined {
  const margin = (g: AgyQuotaGroup): number => 100 - g.utilization - agyWindowThreshold(g.group, t5h, t7d);
  const minMargin = (q: AgyQuotaInfo): number => Math.min(...q.groups.map(margin));
  const eligible = quotas.filter(
    (q) =>
      q.ok &&
      q.email !== currentEmail &&
      !blockedEmails?.has(q.email) &&
      q.groups.length > 0 &&
      q.groups.every((g) => margin(g) >= 0),
  );
  if (eligible.length === 0) return undefined;
  return [...eligible].sort((a, b) => minMargin(b) - minMargin(a))[0];
}

/** 自动切号编排：挑号 → 覆写 keyring → 按会话类型接回。
 *  - reason='exhausted'（兜底，回合已因额度失败）：切后接回任务 —— 赛马
 *    走 raceResume 重跑当前阶段，普通会话发「继续」；无合格目标则回退
 *    手动切号弹窗让用户定夺（等重置 or 挑个凑合的）。
 *  - reason='threshold'（主动，回合正常收尾）：只静默换 keyring（任务没失败，
 *    下一回合自然用新号），无合格目标则静默放弃、不打扰。 */
async function autoSwitchAgy(get: GetFn, sessionId: string, reason: 'exhausted' | 'threshold'): Promise<void> {
  if (agyAutoSwitchInflight) return;
  // 步骤1：熔断——窗口内自动切号次数超限 → 不再自动切，回退手动。
  if (agyAutoSwitchRateLimited()) {
    if (reason === 'exhausted') {
      const lang = (useChatStore.getState().settings?.language ?? 'zh') as 'zh' | 'en';
      announceSystem(
        sessionId,
        lang === 'zh'
          ? '⚠ 自动切号频率过高，已暂停自动切号，请手动切换账号后重试。'
          : '⚠ Auto-switching rate too high — paused. Please switch accounts manually and retry.',
      );
      useChatStore.setState({ agySwitchFor: sessionId });
    }
    return;
  }
  const meta = get().sessions.find((m) => m.id === sessionId);
  if (!meta || meta.engine !== 'antigravity') return;
  const t5h = get().settings?.antigravityQuotaThreshold5h ?? 15;
  const t7d = get().settings?.antigravityQuotaThreshold7d ?? 5;
  agyAutoSwitchInflight = true;
  try {
    const [snap, quotas] = await Promise.all([window.cyberslots.agyAccountsList(), window.cyberslots.agyQuota(true)]);
    // 冷却状态取自快照 blocked 表（main 侧池扫描强刷时已只刷非冷却账号，
    // 坐实耗尽/恢复清除同样在 main 落表）——渲染层零额外探测。
    const blockedEmails = blockedEmailsOf(snap);
    const target = pickAgySwitchTarget(quotas, snap.active, t5h, t7d, blockedEmails);
    if (!target) {
      // 无合格目标分两路：候选全在冷却期（全池冷却）→ 公告 + 回退手动弹窗
      // （手动切号不受 blocked 约束，是逃生口），exhausted/threshold 两路一致；
      // 否则 exhausted 弹手动窗、主动 threshold 静默放弃（旧行为）。
      const candidates = quotas.filter((q) => q.email !== snap.active && (q.ok || blockedEmails.has(q.email)));
      const allCooling = blockedEmails.size > 0 && candidates.length > 0 && candidates.every((q) => blockedEmails.has(q.email));
      if (allCooling) {
        announceSystem(
          sessionId,
          (useChatStore.getState().settings?.language ?? 'zh') === 'zh'
            ? '⚠ 导入池账号全部处于额度冷却期，已停止自动切号 —— 请等重置或手动选择账号。'
            : '⚠ All imported accounts are in quota cooldown — auto-switch paused. Wait for resets or pick an account manually.',
        );
        useChatStore.setState({ agySwitchFor: sessionId });
      } else if (reason === 'exhausted') {
        useChatStore.setState({ agySwitchFor: sessionId });
      }
      return;
    }
    const from = snap.active ?? '?';
    await window.cyberslots.agyAccountSwitch(target.accountId);
    // 步骤1：记录成功的自动切号（用于熔断计数）。
    recordAgyAutoSwitch();
    if (reason === 'exhausted') {
      if (meta.raceId) {
        useChatStore.setState({ agySwitchFor: null });
        // 精确补跑该选手：切号耗时期间比赛阶段链可能已死，raceResume 按
        // 阶段重跑会空转/打扰在跑选手；retryRacerIfMissing 只重建并重跑
        // 缺产物的那名（切号完成后该选手必缺产物，除非对手已补齐）。
        const role = raceRoleOfSession(meta.raceId, sessionId);
        if (role) void window.cyberslots.raceRetryRacerIfMissing(meta.raceId, role);
        else void window.cyberslots.raceResume(meta.raceId); // 反查不到角色兜底
      } else {
        announceSystem(
          sessionId,
          (useChatStore.getState().settings?.language ?? 'zh') === 'zh'
            ? `🔀 额度耗尽，已自动切换账号：${from} → ${target.email}，正在继续任务…`
            : `🔀 Quota exhausted — switched account automatically: ${from} → ${target.email}, resuming the task…`,
        );
        void get().sendPromptTo(sessionId, '继续').catch(catchAutoResume(sessionId, 'auto-switch'));
      }
    } else if (!meta.raceId) {
      // 主动预切：赛马靠编排器下一回合自然用新号，不插播公告；普通会话公告一条。
      announceSystem(
        sessionId,
        (useChatStore.getState().settings?.language ?? 'zh') === 'zh'
          ? `🔀 额度将尽（剩余低于阈值 5小时${t5h}%/7天${t7d}%），已自动切换账号：${from} → ${target.email}`
          : `🔀 Quota running low (below thresholds 5h ${t5h}% / 7d ${t7d}%) — switched account automatically: ${from} → ${target.email}`,
      );
    }
  } catch {
    if (reason === 'exhausted') useChatStore.setState({ agySwitchFor: sessionId });
  } finally {
    agyAutoSwitchInflight = false;
  }
}

/** 主动阈值切号：回合正常收尾后查当前活动账号余量，任一窗低于其
 *  对应阈值（5小时/7天独立配置）就预切。
 *  赛马场景下若同场还有角色在跑则跳过（避免并行回合中途换全局 keyring；
 *  主动切是「未耗尽的预切」，晚一回合无害，交给下次收尾或兜底）。 */
async function maybeProactiveSwitchAgy(get: GetFn, sessionId: string): Promise<void> {
  const meta = get().sessions.find((m) => m.id === sessionId);
  if (!meta || meta.engine !== 'antigravity') return;
  if (meta.raceId) {
    const siblingRunning = get().sessions.some(
      (m) => m.raceId === meta.raceId && m.id !== sessionId && (m.status === 'running' || m.status === 'starting'),
    );
    if (siblingRunning) return;
  }
  const t5h = get().settings?.antigravityQuotaThreshold5h ?? 15;
  const t7d = get().settings?.antigravityQuotaThreshold7d ?? 5;
  try {
    const q = await window.cyberslots.agyActiveQuota();
    if (!q.ok || q.groups.length === 0) return;
    if (q.groups.some((g) => 100 - g.utilization < agyWindowThreshold(g.group, t5h, t7d))) {
      await autoSwitchAgy(get, sessionId, 'threshold');
    }
  } catch {
    /* 主动检测失败不打扰 */
  }
}

/** 步骤3：首条消息前预检查——当前账号 blocked 时先切后发（快照 blocked
 *  表判断，零额外网络请求；blocked 才走全池扫描切号）。低额度未 blocked
 *  的场景由现有 maybeProactiveSwitchAgy 在回合后处理，不在此处阻塞。 */
async function maybePreCheckAgyAccount(get: GetFn, sessionId: string): Promise<void> {
  try {
    const snap = await window.cyberslots.agyAccountsList();
    if (!snap.active || !blockedEmailsOf(snap).has(snap.active)) return;
    // 当前账号 blocked → 复用 threshold 路径切到合格账号。
    await autoSwitchAgy(get, sessionId, 'threshold');
  } catch {
    // 预检查失败不打扰 — 用当前账号起跑
  }
}


function mutateUi(set: SetFn, sessionId: string, fn: (ui: SessionUiState) => SessionUiState): void {
  set((s) => ({ ui: { ...s.ui, [sessionId]: fn(s.ui[sessionId] ?? emptyUi()) } }));
}

/** 默认标题哨兵：主进程按当前语言建会话（新会话 / New chat），两种都视为未命名。 */
function isDefaultTitle(title: string | undefined): boolean {
  return title === '新会话' || title === 'New chat';
}

/** 首条消息自动命名：先立即落截取式标题（侧栏不空窗）；设置为 AI
 *  生成时再异步调主进程生成语义标题覆盖。期间用户手动改名则放弃
 *  覆盖；AI 未配置/失败静默保留截取式标题，不阻塞发送链路。 */
function autoTitleSession(get: () => ChatState, set: SetFn, sessionId: string, sourceText: string, fallback: string): void {
  const rename = (title: string): void => {
    void window.cyberslots.sessionRename(sessionId, title);
    set((s) => ({ sessions: s.sessions.map((m) => (m.id === sessionId ? { ...m, title } : m)) }));
  };
  rename(fallback);
  if (get().settings?.titleGen?.mode !== 'ai' || !sourceText.trim()) return;
  void window.cyberslots.titleGenerate(sourceText).then((ai) => {
    if (!ai) return;
    const cur = get().sessions.find((s) => s.id === sessionId);
    if (cur && cur.title === fallback) rename(ai);
  });
}

/** "X 秒" under a minute, otherwise "X 分 Y 秒" (en: "Xs" / "Xm Ys"). */
function formatGoalDuration(seconds: number, lang: 'zh' | 'en'): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (lang === 'zh') return m > 0 ? (rest > 0 ? `${m} 分 ${rest} 秒` : `${m} 分钟`) : `${s} 秒`;
  return m > 0 ? (rest > 0 ? `${m}m ${rest}s` : `${m}m`) : `${s}s`;
}

function applyEnvelope(set: SetFn, get: GetFn, { sessionId, event }: EngineEventEnvelope): void {
  // Any engine event counts as liveness — feeds the stall detector.
  mutateUi(set, sessionId, (ui) => ({ ...ui, lastActivityAt: Date.now() }));
  switch (event.type) {
    case 'session.status': {
      // 仅真正开跑才刷新 updatedAt — 预热/唤醒的 starting→idle 过渡
      // 不该把会话顶到侧栏顶部（曾致快速连点会话时列表顺序乱跳）。
      set((s) => ({
        sessions: s.sessions.map((m) =>
          m.id === sessionId
            ? { ...m, status: event.status, updatedAt: event.status === 'running' ? Date.now() : m.updatedAt }
            : m,
        ),
      }));
      // 引擎回到非运行态 → 收敛仍标「进行中」的待办为 pending：模型常在
      // 收尾时忘记再推一次 plan 更新，不收敛的话第一项会永远停在 loading
      // （与重启恢复的 reconcilePersistedMessages 同语义；没人在跑 = 不存在
      // 进行中）。挂在这里而非 turn.ended，是为了连 background 自发回合收尾
      // 也一并覆盖。
      if (event.status === 'idle' || event.status === 'error' || event.status === 'closed') {
        let planChanged = false;
        mutateUi(set, sessionId, (ui) => {
          const messages = ui.messages.map((m) => {
            if (m.kind !== 'plan' || !m.entries.some((e) => e.status === 'in_progress')) return m;
            planChanged = true;
            return { ...m, entries: m.entries.map((e) => (e.status === 'in_progress' ? { ...e, status: 'pending' as const } : e)) };
          });
          return planChanged ? { ...ui, messages } : ui;
        });
        if (planChanged) schedulePersist(get, sessionId);
      }
      return;
    }
    case 'session.meta':
      set((s) => ({
        sessions: s.sessions.map((m) => (m.id === sessionId ? { ...m, ...event.patch } : m)),
      }));
      return;
    case 'models.update':
      mutateUi(set, sessionId, (ui) => ({
        ...ui,
        models: { current: event.current, available: event.available.length ? event.available : ui.models.available },
      }));
      set((s) => ({
        sessions: s.sessions.map((m) => (m.id === sessionId ? { ...m, modelId: event.current } : m)),
      }));
      return;
    case 'modes.update':
      mutateUi(set, sessionId, (ui) => ({
        ...ui,
        modes: { current: event.current, available: event.available.length ? event.available : ui.modes.available },
      }));
      set((s) => ({
        sessions: s.sessions.map((m) => (m.id === sessionId ? { ...m, permissionMode: event.current } : m)),
      }));
      return;
    case 'commands.update':
      mutateUi(set, sessionId, (ui) => ({ ...ui, commands: event.commands }));
      return;
    case 'swarm.update':
      mutateUi(set, sessionId, (ui) => ({ ...ui, swarm: event.active }));
      return;
    case 'usage.update':
      mutateUi(set, sessionId, (ui) => {
        let messages = ui.messages;
        // kimi 的 usage_update 可能晚于 turn.ended 到达 — 回填到刚结束
        // 回合的统计行，避免统计行只剩用时一段（e2e 实测）。
        const last = messages[messages.length - 1];
        if (last && last.kind === 'turn_end' && last.usage?.contextUsed == null && last.usage?.inputTokens == null) {
          messages = [
            ...messages.slice(0, -1),
            { ...last, usage: { ...last.usage, contextUsed: event.used, contextMax: event.size || undefined } },
          ];
        }
        return {
          ...ui,
          messages,
          usage: { used: event.used, size: event.size, costUsd: event.costUsd },
        };
      });
      return;
    case 'goal.update': {
      const g = event.goal;
      if (g && g.status === 'complete') {
        // 完成公告仅发给「本地已知进行中」的 goal —— resume 快照会重放引擎
        // DB 里的 complete 残留行（codex 完成不删行），那种只清状态条，
        // 不重复公告（否则每次打开旧会话都弹一次「Goal 执行完成」）。
        const hadGoal = !!get().goals[sessionId];
        // 完成态：清状态条，并向消息流插一条完成公告（目标 + 真实用时）。
        set((s) => ({ goals: { ...s.goals, [sessionId]: undefined } }));
        if (!hadGoal) return;
        const lang = get().settings?.language ?? 'zh';
        const doneMsg: UnifiedMessage = {
          kind: 'system',
          id: crypto.randomUUID(),
          turnId: -1,
          text:
            lang === 'zh'
              ? `🎯 Goal「${g.objective}」执行完成 · 用时 ${formatGoalDuration(g.timeUsedSeconds, 'zh')}`
              : `🎯 Goal “${g.objective}” completed · took ${formatGoalDuration(g.timeUsedSeconds, 'en')}`,
          createdAt: Date.now(),
        };
        // 回合进行中（模型标完成后还会继续流收尾总结）→ 暂存，
        // turn.ended 时再插，公告排在最终输出之后；空闲则立即插。
        const status = get().sessions.find((m) => m.id === sessionId)?.status;
        if (status === 'running' || status === 'awaiting') {
          pendingGoalDone.set(sessionId, doneMsg);
        } else {
          mutateUi(set, sessionId, (ui) => ({ ...ui, messages: [...ui.messages, doneMsg] }));
          schedulePersist(get, sessionId);
        }
      } else {
        set((s) => ({ goals: { ...s.goals, [sessionId]: g ?? undefined } }));
      }
      return;
    }
    case 'turn.ended': {
      // Unread bookkeeping: main marks every finished session unread; the
      // renderer immediately clears it for the session being viewed.
      const active = get().activeSessionId === sessionId;
      if (active) void window.cyberslots.sessionMarkRead(sessionId);
      set((s) => ({
        sessions: s.sessions.map((m) =>
          m.id === sessionId ? { ...m, unread: !active, updatedAt: Date.now() } : m,
        ),
      }));
      const turnMeta = get().sessions.find((m) => m.id === sessionId);
      const turnModels = get().ui[sessionId]?.models;
      // 思考深度盖章 = 下发值（sendPromptTo 同一解析），tooltip 显示与实跑一致。
      const turnEffort = resolveEffectiveEffort({
        engine: turnMeta?.engine,
        override: get().efforts[sessionId],
        activeModel: turnModels?.current || turnModels?.available[0] || turnMeta?.modelId || '',
        kimiModels: get().kimiModels,
        codexCatalog: get().codexCatalog,
        codexDefaultEffort: get().codexDefaultEffort,
        opencodeCatalog: get().opencodeCatalog,
        ompCatalog: get().ompCatalog,
      })?.value;
      mutateUi(set, sessionId, (ui) => ({
        ...ui,
        messages: foldMessage(ui.messages, event, {
          engine: turnMeta?.engine,
          modelId: turnMeta?.modelId,
          effort: turnEffort,
        }),
      }));
      // 暂存的 Goal 完成公告在回合收尾后补插 — 排在最终输出之后。
      const goalDone = pendingGoalDone.get(sessionId);
      if (goalDone) {
        pendingGoalDone.delete(sessionId);
        mutateUi(set, sessionId, (ui) => ({ ...ui, messages: [...ui.messages, goalDone] }));
      }
      // Plan 模式产出的长文本 = 计划文档 → 自动弹右侧 md 预览。
      if (get().ui[sessionId]?.modes.current === 'plan' && event.stopReason !== 'error') {
        const msgs = get().ui[sessionId]?.messages ?? [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]!;
          if (m.kind === 'text' && m.turnId === event.turnId && m.planDoc) {
            get().setPlanPreview(sessionId, m.id);
            break;
          }
        }
      }
      // 回合结束立即落盘（完成的产出必须持久化，不受防抖/崩溃影响）。
      flushPersist(get, sessionId);
      // 步骤1+4：正常收尾 → 清零自动切号熔断计数 + 清除一次性重试标记。
      if (event.stopReason !== 'error') {
        clearAgyAutoSwitchHistory();
        agyAutoRetriedSessions.delete(sessionId);
      }
      // Antigravity 主动阈值切号：回合【正常收尾】且开启自动切时，检测当前账号
      // 余量，任一时间窗低于阈值则预切到有 buffer 的账号（赛马有同场角色在跑
      // 则跳过）。耗尽【报错】的兜底切号不在这里 —— 由 reportQuotaExhaustion 的
      // quotaExhausted 事件驱动（见 error 分支）；非额度类错误一律不弹切号窗。
      if (
        event.stopReason !== 'error' &&
        get().settings?.antigravityAutoSwitch &&
        get().sessions.find((m) => m.id === sessionId)?.engine === 'antigravity'
      ) {
        void maybeProactiveSwitchAgy(get, sessionId);
      }
      // 用户点过停止 → 本次收尾不自动派发排队/不触自动压缩（否则刚中断就
      // 又自起新回合，看起来就是「停不下来」）。无论哪种 stopReason 都
      // 要消账，避免标记残留误伤后续正常回合。
      const userStopped =
        stopRequested.delete(sessionId) || event.stopReason === 'cancelled' || event.stopReason === 'interrupted';
      // 引擎自发回合结束：仍活跃的 goal 续跑不派发队列、不触自动压缩（引擎
      // 紧接着自起下一轮）；backgroundKind 有值（compact / goal-idle）= 引擎
      // 不会再自起 —— 期间排队的消息照常补发，否则滞留到下个回合（且用户再发
      // 新消息会直接插队，顺序倒置）；但仍不触自动压缩：compact 后 usage 多是
      // 压缩前旧值，重触=死循环。
      if (event.stopReason === 'background') {
        if (!event.backgroundKind || userStopped) return;
        const bgQueue = get().queues[sessionId] ?? [];
        if (bgQueue.length > 0) {
          const [next, ...rest] = bgQueue;
          set((s) => ({ queues: { ...s.queues, [sessionId]: rest } }));
          setTimeout(() => void get().sendPromptTo(sessionId, next!.text, next!.attachments, undefined, next!.selections), 500);
        }
        return;
      }
      // 自动派发等待队列的下一条（稍作延迟，让引擎回到 idle）。
      const queue = get().queues[sessionId] ?? [];
      if (userStopped) return; // 排队消息保留在队列里，由用户自行删除或下次回合后再续发
      if (queue.length > 0 && event.stopReason !== 'error') {
        const [next, ...rest] = queue;
        set((s) => ({ queues: { ...s.queues, [sessionId]: rest } }));
        setTimeout(() => void get().sendPromptTo(sessionId, next!.text, next!.attachments, undefined, next!.selections), 500);
      } else if (event.stopReason !== 'error') {
        // 自动压缩：无排队且占用达阈值 → 在回合边界（现在）触发一次；
        // 仅回合结束处判定，绝不打断进行中的回合（0=关闭）。
        const ratio = get().settings?.autoCompactRatio ?? 0;
        const u = get().ui[sessionId]?.usage;
        if (ratio > 0 && u && u.size > 0 && u.used / u.size >= ratio / 100) {
          // 赛马角色会话不触应用层压缩/降切：compact 回合的提示文本会污染
          // 角色 transcript（编排器拿它交棒），交给引擎内部压缩兜底。
          const isRaceRole = !!get().sessions.find((m) => m.id === sessionId)?.raceId;
          // 冷却：上次触发后 usage 未见下降（omp 等不回推 usage 的通道）时
          // 跳过接下来 3 个回合，防连环触发；下降即解除。
          const guard = autoCompactGuard.get(sessionId);
          let guarded = false;
          if (guard) {
            if (u.used < guard.baselineUsed * 0.9) autoCompactGuard.delete(sessionId);
            else if (guard.skipTurns-- > 0) guarded = true;
            else autoCompactGuard.delete(sessionId);
          }
          // 满窗降切：当前模型命中规则表（如 k3 256k → k3，同能力仅窗口
          // 不同）且列表里有目标模型 → 不压缩，直接热切继续跑，长任务
          // 不被压缩打断；无命中才走自动压缩。
          const models = get().ui[sessionId]?.models;
          const fallback =
            isRaceRole || guarded
              ? undefined
              : findContextFallback(models?.current, models?.available, get().settings?.contextFallbackRules);
          if (fallback) {
            const from = models!.current;
            void window.cyberslots.sessionSetModel(sessionId, fallback);
            // 乐观更新当前模型 — 引擎侧 models.update 未必回推，不更新会在
            // 下个回合末重复触发切换/公告。
            mutateUi(set, sessionId, (ui) => ({ ...ui, models: { ...ui.models, current: fallback } }));
            set((s) => ({
              sessions: s.sessions.map((m) => (m.id === sessionId ? { ...m, modelId: fallback } : m)),
            }));
            const lang = get().settings?.language ?? 'zh';
            const pct = Math.round((u.used / u.size) * 100);
            announceSystem(
              sessionId,
              lang === 'zh'
                ? `🔀 上下文已用 ${pct}%，已自动切换模型：${from} → ${fallback}（能力一致，任务继续）`
                : `🔀 Context ${pct}% used — switched model automatically: ${from} → ${fallback} (same capability, task continues)`,
            );
          } else if (!isRaceRole && !guarded) {
            autoCompactGuard.set(sessionId, { baselineUsed: u.used, skipTurns: 3 });
            // catch：不支持的引擎（antigravity 无 adapter.compact）会 reject。
            void window.cyberslots.sessionCompact(sessionId).catch(() => undefined);
          }
        }
      }
      return;
    }
    case 'error': {
      // 先照常把错误落进消息流 + 持久化 + 活动摘要（与 default 同语义）。
      mutateUi(set, sessionId, (ui) => ({ ...ui, messages: foldMessage(ui.messages, event) }));
      schedulePersist(get, sessionId);
      noteActivity(set, get, sessionId, event);
      // 确认额度耗尽（adapter probe 坐实，事件自带 quotaEmail/resetSec；
      // 冷却标记已在 main 落表，渲染层零重查）→ 开启自动切则自动切号接回，
      // 否则兜底弹手动切号窗。仅此一条路径会弹切号窗 —— 非额度类错误不触发。
      const isAntigravityErr = get().sessions.find((m) => m.id === sessionId)?.engine === 'antigravity';
      if (event.quotaExhausted && isAntigravityErr) {
        if (get().settings?.antigravityAutoSwitch) void autoSwitchAgy(get, sessionId, 'exhausted');
        else set(() => ({ agySwitchFor: sessionId }));
      } else if (isAntigravityErr && !event.quotaExhausted) {
        // 步骤4：非额度类错误（探测已确认未耗尽）→ 退避后重试同账号一次。
        // 与 RaceOrchestrator 的 1.5s 退避重试对齐；每会话仅自动重试一次，
        // 防止无限循环；重试发「继续」接回任务（与切号后接回同模式）。
        //
        // 赛马角色会话一律跳过：agy 中途的 error_message 步会 emit `error`
        // 但不发 turn.ended（回合仍在跑），此处误判为回合失败提前发「继续」
        // 会酿成 —— 编排器仍挂着的 onTurnEnded 回调误收新回合的 turn.ended，
        // 把「继续」那段 transcript 当成交卷产物落盘 → 假冲线；且 rogue 回合
        // 同样撞额度耗尽，与原回合 probe 完成后的 quota 错误并发触发切号，
        // 被 agyAutoSwitchInflight 互斥/熔断挡掉 → 看起来没自动切号。
        // 赛马回合重试由 RaceOrchestrator.runTurnWithRetry 在真正 turn.ended
        // 失败时负责（含 1.5s 退避），chatStore 不插手。
        const isRaceRole = !!get().sessions.find((m) => m.id === sessionId)?.raceId;
        if (!isRaceRole && !agyAutoRetriedSessions.has(sessionId)) {
          agyAutoRetriedSessions.set(sessionId, true);
          setTimeout(() => {
            // 期间用户可能已手动操作或切走会话；只在会话仍存在时重发。
            // adapter 的 promptActive 总闸可能在原回合 probe 窗口期拒掉
            // 这次「继续」（superseded）；静默吞掉 —— 原回合 probe 收尾后
            // 会由 quota 错误路径走自动切号 + 「继续」正当接回，不丢任务。
            if (get().sessions.some((m) => m.id === sessionId)) {
              void get().sendPromptTo(sessionId, '继续').catch(catchAutoResume(sessionId, 'non-quota-retry'));
            }
          }, 1500);
        }
      }
      return;
    }
    default:
      mutateUi(set, sessionId, (ui) => {
        let messages = foldMessage(ui.messages, event);
        // Plan 模式下的正文流标记为计划文档 — 主流只渲染缩略卡片。
        // 仅对“像文档”的文本生效：模型偶尔把工具调用 JSON 当正文吐
        // （e2e 实测），那类内容不该包成计划卡。
        if (event.type === 'text.delta' && ui.modes.current === 'plan') {
          const last = messages[messages.length - 1];
          if (last && last.kind === 'text' && !last.planDoc && looksLikePlanDoc(last.text)) {
            messages = [...messages.slice(0, -1), { ...last, planDoc: true }];
          }
        }
        return { ...ui, messages };
      });
      schedulePersist(get, sessionId);
      // 「正在做什么」一行摘要 — 看板卡片实时显示（需在折叠之后取值）。
      noteActivity(set, get, sessionId, event);
  }
}

/** 从事件流提炼「正在做什么」摘要：工具标题 > 正文首行 > 思考中 > 错误首行。
 *  同值跳过 set，避免流式 delta 引发无意义渲染。 */
function noteActivity(set: SetFn, get: GetFn, sessionId: string, event: EngineEvent): void {
  let label: string | undefined;
  if (event.type === 'tool.upsert') {
    label = event.title;
  } else if (event.type === 'thinking.delta') {
    label = get().settings?.language === 'en' ? 'Thinking…' : '思考中…';
  } else if (event.type === 'text.delta' && event.text) {
    const msgs = get().ui[sessionId]?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.kind === 'text') {
        label = m.text.trimStart().split('\n', 1)[0]!.slice(0, 80);
        break;
      }
    }
  } else if (event.type === 'error') {
    label = event.message.split('\n', 1)[0]!.slice(0, 80);
  }
  if (!label || get().lastActivity[sessionId] === label) return;
  set((s) => ({ lastActivity: { ...s.lastActivity, [sessionId]: label } }));
}

/** 模型 id 归一化：小写并剔除所有分隔符 — 兼容 "Kimi k3 256k" /
 *  "kimi-k3-256K" / "kimi_k3_256k" 等任意写法。 */
function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 规则词元化："Kimi k3 256k" → ['k3','256k']（按非字母数字分词）。 */
function ruleTokens(spec: string): string[] {
  return spec.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** 模型是否命中词元集：归一化后包含全部词元即命中。 */
function matchesTokens(id: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const n = normalizeModelId(id);
  return tokens.every((tok) => n.includes(tok));
}

/** 满窗降切目标：按规则表顺序找第一条「命中当前模型且可用列表里有
 *  目标候选」的规则（候选 = 命中 to 且不命中 match，避免自切自）。
 *  同规则多候选时优先取「当前 id 去掉 match 独有词元后」归一化相等的
 *  那个，否则取第一个；全部未命中返回 null（走原有自动压缩）。 */
function findContextFallback(
  current: string | undefined,
  available: string[] | undefined,
  rules: ContextFallbackRule[] | undefined,
): string | null {
  if (!current || !rules?.length) return null;
  for (const rule of rules) {
    const matchToks = ruleTokens(rule.match);
    const toToks = ruleTokens(rule.to);
    if (toToks.length === 0 || !matchesTokens(current, matchToks)) continue;
    const candidates = (available ?? []).filter((m) => matchesTokens(m, toToks) && !matchesTokens(m, matchToks));
    if (candidates.length === 0) continue;
    let stripped = normalizeModelId(current);
    for (const tok of matchToks) if (!toToks.includes(tok)) stripped = stripped.split(tok).join('');
    return candidates.find((m) => normalizeModelId(m) === stripped) ?? candidates[0]!;
  }
  return null;
}

/** 计划文档启发式判定：markdown 标题/列表等结构特征，且不是裸 JSON。 */
function looksLikePlanDoc(text: string): boolean {
  const t = text.trimStart();
  if (!t) return false;
  if (t.startsWith('{') || t.startsWith('[')) return false; // 裸 JSON/工具调用回显
  return /^#{1,4}\s/m.test(t) || /^([-*]|\d+\.)\s/m.test(t) || t.length > 300;
}

/** 给任意遗留的流式文本/思考段收尾（清 streaming 标志 → caret 止闪）。
 *  新内容块（工具/计划/权限/另一段）开始时调用，无需等整个回合结束。 */
function endStreaming(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (!messages.some((m) => (m.kind === 'text' || m.kind === 'thinking') && m.streaming)) return messages;
  const now = Date.now();
  return messages.map((m) => {
    if ((m.kind === 'text' || m.kind === 'thinking') && m.streaming) {
      // 思考段收尾时定格耗时（首个 delta → 收尾），供折叠头展示。
      if (m.kind === 'thinking') return { ...m, streaming: false, durationMs: m.durationMs ?? now - m.createdAt };
      return { ...m, streaming: false };
    }
    return m;
  });
}

/** Pure fold of one message-affecting event into the message list. */
// stamp：回合结束时刻的引擎/模型快照 —— 盖进 turn_end 统计行，
// 回答信息 tooltip 据此显示该回答真实的产生者（中途换引擎/模型不串）。
function foldMessage(
  messages: UnifiedMessage[],
  event: EngineEvent,
  stamp?: { engine?: EngineId; modelId?: string; effort?: string },
): UnifiedMessage[] {
  const now = Date.now();
  switch (event.type) {
    case 'turn.started': {
      // 回合号回填：乐观写入的 user 气泡（turnId=-1）此刻才拿到真实回合号，
      // TurnRail 等按 turnId 配对提问与回答的消费者依赖它。仅在该气泡仍是
      // 最后一条消息时回填——之后已有事件落地说明它不属于本回合（如引擎
      // 自发的 goal/compact 回合），不要误贴。
      const last = messages[messages.length - 1];
      if (last && last.kind === 'user' && last.turnId === -1) {
        return [...messages.slice(0, -1), { ...last, turnId: event.turnId }];
      }
      return messages;
    }

    case 'user.echo':
      return [
        ...messages,
        { kind: 'user', id: crypto.randomUUID(), turnId: event.turnId, text: event.text, createdAt: now },
      ];

    case 'text.delta':
    case 'thinking.delta': {
      const kind = event.type === 'text.delta' ? 'text' : 'thinking';
      // 引擎报的真实思考时长（opencode reasoning part.time）— 优先于
      // 渲染端墙钟（SSE 突发送达时墙钟严重偏小）。
      const engineDuration = event.type === 'thinking.delta' ? event.durationMs : undefined;
      const last = messages[messages.length - 1];
      if (last && last.kind === kind && last.turnId === event.turnId && last.streaming) {
        const updated =
          last.kind === 'thinking'
            ? { ...last, text: last.text + event.text, durationMs: engineDuration ?? last.durationMs }
            : { ...last, text: last.text + event.text };
        return [...messages.slice(0, -1), updated];
      }
      // 纯时长回填（空 delta）但已没有在流的思考段 → 回填到本回合
      // 最近一段已收尾的思考（time.end 常晚于工具开始到达）。
      if (!event.text) {
        if (kind !== 'thinking' || engineDuration === undefined) return messages;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]!;
          if (m.kind === 'thinking' && m.turnId === event.turnId) {
            const next = [...messages];
            next[i] = { ...m, durationMs: engineDuration };
            return next;
          }
        }
        return messages;
      }
      // 开启新的文本/思考段前，先给上一段流式内容收尾。
      return [
        ...endStreaming(messages),
        kind === 'thinking'
          ? {
              kind,
              id: crypto.randomUUID(),
              turnId: event.turnId,
              text: event.text,
              streaming: true,
              createdAt: now,
              durationMs: engineDuration,
            }
          : { kind, id: crypto.randomUUID(), turnId: event.turnId, text: event.text, streaming: true, createdAt: now },
      ];
    }

    case 'tool.upsert': {
      // 工具调用开始 = 之前的文本流已结束，收尾遗留的流式 caret。
      const base = endStreaming(messages);
      const idx = base.findIndex((m) => m.kind === 'tool_call' && m.toolCallId === event.toolCallId);
      if (idx >= 0) {
        const prev = base[idx]!;
        if (prev.kind !== 'tool_call') return base;
        const merged: UnifiedMessage = {
          ...prev,
          title: event.title ?? prev.title,
          toolKind: event.toolKind ?? prev.toolKind,
          toolName: event.toolName ?? prev.toolName,
          status: event.status ?? prev.status,
          content: event.content ?? prev.content,
          locations: event.locations ?? prev.locations,
        };
        const next = [...base];
        next[idx] = merged;
        return next;
      }
      return [
        ...base,
        {
          kind: 'tool_call',
          id: crypto.randomUUID(),
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          title: event.title ?? event.toolCallId,
          toolKind: event.toolKind ?? 'other',
          toolName: event.toolName,
          status: event.status ?? 'pending',
          content: event.content,
          locations: event.locations,
          createdAt: now,
        },
      ];
    }

    case 'plan.update': {
      const base = endStreaming(messages);
      const idx = base.findIndex((m) => m.kind === 'plan' && m.turnId === event.turnId);
      if (idx >= 0) {
        const next = [...base];
        next[idx] = { ...(next[idx] as Extract<UnifiedMessage, { kind: 'plan' }>), entries: event.entries };
        return next;
      }
      return [
        ...base,
        { kind: 'plan', id: crypto.randomUUID(), turnId: event.turnId, entries: event.entries, createdAt: now },
      ];
    }

    case 'permission.request':
      return [
        ...endStreaming(messages),
        event.isQuestion
          ? {
              kind: 'ask_user',
              id: crypto.randomUUID(),
              turnId: event.turnId,
              requestId: event.requestId,
              question: event.title,
              body: event.body,
              options: event.options,
              createdAt: now,
            }
          : {
              kind: 'permission',
              id: crypto.randomUUID(),
              turnId: event.turnId,
              requestId: event.requestId,
              title: event.title,
              body: event.body,
              toolCallId: event.toolCallId,
              options: event.options,
              createdAt: now,
            },
      ];

    case 'permission.resolved':
      return messages.map((m) =>
        (m.kind === 'permission' || m.kind === 'ask_user') && m.requestId === event.requestId
          ? { ...m, answeredOptionId: event.optionId ?? '__cancelled__' }
          : m,
      );

    case 'turn.ended': {
      const closed = messages.map((m) => {
        if ((m.kind === 'text' || m.kind === 'thinking') && m.turnId === event.turnId && m.streaming) {
          if (m.kind === 'thinking') return { ...m, streaming: false, durationMs: m.durationMs ?? now - m.createdAt };
          return { ...m, streaming: false };
        }
        // 回合结束时仍未完成的工具调用标记取消 — 避免 Exploring 组/
        // 编辑卡片永远停在进行态（停止/报错后的残留）。
        if (m.kind === 'tool_call' && m.turnId === event.turnId && (m.status === 'in_progress' || m.status === 'pending')) {
          return { ...m, status: 'canceled' as const };
        }
        // 回合结束时仍未应答的授权/提问已无意义 — 标记取消，
        // 避免停止后弹层残留（e2e 实测）。
        if ((m.kind === 'permission' || m.kind === 'ask_user') && m.answeredOptionId === undefined) {
          return { ...m, answeredOptionId: '__cancelled__' };
        }
        return m;
      });
      // background/error 不产统计行 —— 但引擎自发回合里属用户可见回答的
      // （showStats，如 goal 续跑）例外：照常生成 turn_end，否则无复制回答/token 行。
      if ((event.stopReason === 'error' || event.stopReason === 'background') && !event.showStats) return closed;
      return [
        ...closed,
        {
          kind: 'turn_end',
          id: crypto.randomUUID(),
          turnId: event.turnId,
          stopReason: event.stopReason,
          usage: event.usage,
          durationMs: event.durationMs,
          apiDurationMs: event.apiDurationMs,
          engine: stamp?.engine,
          modelId: stamp?.modelId,
          createdAt: now,
        },
      ];
    }

    case 'error':
      return [
        ...messages,
        { kind: 'error', id: crypto.randomUUID(), turnId: event.turnId ?? -1, message: event.message, createdAt: now },
      ];

    default:
      return messages;
  }
}
