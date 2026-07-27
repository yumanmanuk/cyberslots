/**
 * Chat store — folds the main-process EngineEvent stream into renderable
 * UnifiedMessage lists per session, and fronts every session action.
 * This is the renderer's single source of truth.
 */

import { create } from 'zustand';

import type {
  AppSettings,
  CodexCatalogModel,
  CronTask,
  EngineEvent,
  EngineEventEnvelope,
  EngineId,
  GoalControlAction,
  GoalInfo,
  OpencodeCatalog,
  PermissionMode,
  SessionMeta,
  SlashCommandInfo,
  UnifiedMessage,
  WorkspaceInfo,
} from '@shared/types';
import type { SessionCreateRequest } from '@shared/ipc';

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
}

export interface SessionUiState {
  messages: UnifiedMessage[];
  usage?: { used: number; size: number; costUsd?: number };
  models: { current: string; available: string[] };
  modes: { current: PermissionMode; available: PermissionMode[] };
  commands: SlashCommandInfo[];
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
  cronTasks: CronTask[];
  filter: SidebarFilter;
  /** Engine-native goal per session (codex thread/goal; pushed via goal.update). */
  goals: Record<string, GoalInfo | undefined>;
  /** Per-session reasoning-effort override (codex only). */
  efforts: Record<string, string>;
  /** Per-session outbox: messages waiting for the current turn to finish. */
  queues: Record<string, QueuedMessage[]>;
  /** 侧边栏折叠态（localStorage 持久）。 */
  sidebarCollapsed: boolean;
  /** 主会话 → 右侧 sidechat 分支会话 id。 */
  sidechats: Record<string, string | undefined>;
  /** 会话 → 待右侧预览的 plan 文档消息 id（plan 模式回合结束时自动设置）。 */
  planPreview: Record<string, string | undefined>;
  /** codex model_catalog_json 目录（init 时读取；模型/思考深度选择器用）。 */
  codexCatalog: CodexCatalogModel[];
  /** ~/.codex/config.toml 的 model_reasoning_effort（codex 全局默认档）。 */
  codexDefaultEffort?: string;
  /** opencode 模型目录（懒加载 — 首个 opencode 会话的选择器触发，
   *  来自 /config/providers；拉取会按需启动 opencode server）。 */
  opencodeCatalog: OpencodeCatalog | null;
  loadOpencodeCatalog(force?: boolean): Promise<void>;
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
  openSidechat(parentId: string): Promise<void>;
  closeSidechat(parentId: string): void;
  toggleSidebar(): void;
  setPlanPreview(sessionId: string, messageId: string | undefined): void;
  forkToEngine(id: string, engine: SessionMeta['engine']): Promise<void>;
  compactSession(): Promise<void>;
  sendPrompt(text: string, attachments?: string[]): Promise<void>;
  sendPromptTo(sessionId: string, text: string, attachments?: string[], enginePrefix?: string): Promise<void>;
  cancel(): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  answerPermission(requestId: string, optionId?: string): Promise<void>;
  enqueue(text: string, attachments?: string[]): void;
  /** Enqueue into a specific session（PermissionSheet 补充说明用）。 */
  enqueueTo(sessionId: string, text: string, attachments?: string[]): void;
  removeQueued(sessionId: string, id: string): void;
  moveQueued(sessionId: string, from: number, to: number): void;
  steerQueued(sessionId: string, id: string): Promise<'steered' | 'moved' | 'head' | 'none'>;
  setGoal(objective: string): Promise<void>;
  controlGoal(action: GoalControlAction): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  /** 归档/还原：仅影响侧栏展示，数据与引擎会话全保留（区别于删除）。 */
  archiveSession(id: string, archived: boolean): Promise<void>;
  deleteSession(id: string): Promise<void>;
  loadCron(): Promise<void>;
  saveCron(task: CronTask): Promise<void>;
  deleteCron(id: string): Promise<void>;
  runCronNow(id: string): Promise<void>;
}

const emptyUi = (): SessionUiState => ({
  messages: [],
  models: { current: '', available: [] },
  modes: { current: 'default', available: [] },
  commands: [],
});

let unsubscribe: (() => void) | undefined;

/** loadOpencodeCatalog 的 in-flight 标记（模块级，不入 store）。 */
let opencodeCatalogLoading = false;

/** Debounced per-session persistence of the folded message list. */
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const persistLastRun = new Map<string, number>();
const PERSIST_DEBOUNCE = 400;
// 连续流式（每个 delta 都重置防抖）时最长 2s 强制落盘一次，
// 把「崩溃/热重启丢失的尾部输出」窗口从「整段回合」压到 ~2s。
const PERSIST_MAX_WAIT = 2000;

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
  cronTasks: [],
  filter: DEFAULT_FILTER,
  goals: {},
  efforts: {},
  queues: {},
  sidebarCollapsed: localStorage.getItem('cs.sidebarCollapsed') === '1',
  sidechats: {},
  planPreview: {},
  codexCatalog: [],
  codexDefaultEffort: undefined,
  opencodeCatalog: null,

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

  async init() {
    const [sessions, settings] = await Promise.all([
      window.cyberslots.sessionList(),
      window.cyberslots.settingsGet(),
    ]);
    set({ sessions, settings });
    // codex 配置快照 — catalog 目录 + 默认思考深度（选择器的元信息源）。
    void window.cyberslots.engineConfigsGet().then((snap) => {
      set({
        codexCatalog: snap.codex.catalogModels ?? [],
        codexDefaultEffort: snap.codex.reasoningEffort,
      });
    });
    unsubscribe?.();
    unsubscribe = window.cyberslots.onEngineEvent((envelope) => {
      applyEnvelope(set, get, envelope);
    });
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
    set({ creating: true, creatingEngine: req.engine });
    try {
      const meta = await window.cyberslots.sessionCreate(req);
      set((s) => ({
        sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)],
        // 新会话没有历史可水合 — 直接标记 hydrated，避免首条消息被水合门禁拖延落盘。
        ui: { ...s.ui, [meta.id]: s.ui[meta.id] ?? { ...emptyUi(), hydrated: true } },
        activeSessionId: meta.id,
      }));
    } finally {
      set({ creating: false, creatingEngine: null });
    }
  },

  selectSession(id) {
    set({ activeSessionId: id });
    void window.cyberslots.sessionMarkRead(id);
    set((s) => ({ sessions: s.sessions.map((m) => (m.id === id ? { ...m, unread: false } : m)) }));
    get().hydrateSession(id);
    // 预热引擎：恢复态会话不再等首条消息才懒启动，选中即唤醒，
    // 模型/思考深度选择器、命令等立即就绪，首次发送也无启动延迟。
    void window.cyberslots.sessionWarmUp(id);
  },

  /** Lazy-hydrate persisted history the first time a session is rendered. */
  hydrateSession(id) {
    if (get().ui[id]?.hydrated) return;
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
              ...(s.ui[id] ?? emptyUi()),
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
      set((s) => ({ sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)] }));
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
    const existing = get().sidechats[parentId];
    if (existing && get().sessions.some((s) => s.id === existing)) return; // 已开
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
        sidechats: { ...s.sidechats, [parentId]: meta.id },
      }));
      get().hydrateSession(meta.id);
      if (mode === 'plan') {
        mutateUi(set, meta.id, (ui) => ({ ...ui, modes: { ...ui.modes, current: 'plan' } }));
      }
      void window.cyberslots.sessionWarmUp(meta.id); // 预热分支引擎
    } finally {
      set({ creating: false, creatingEngine: null });
    }
  },

  closeSidechat(parentId) {
    set((s) => ({ sidechats: { ...s.sidechats, [parentId]: undefined } }));
  },

  toggleSidebar() {
    const next = !get().sidebarCollapsed;
    localStorage.setItem('cs.sidebarCollapsed', next ? '1' : '0');
    set({ sidebarCollapsed: next });
  },

  setPlanPreview(sessionId, messageId) {
    set((s) => ({ planPreview: { ...s.planPreview, [sessionId]: messageId } }));
  },

  /** 换引擎继续聊：history-replay branch onto the other engine. */
  async forkToEngine(id, engine) {
    set({ creating: true, creatingEngine: engine });
    try {
      const meta = await window.cyberslots.sessionForkEngine(id, engine);
      set((s) => ({ sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)] }));
      get().selectSession(meta.id);
    } finally {
      set({ creating: false, creatingEngine: null });
    }
  },

  async compactSession() {
    const { activeSessionId } = get();
    if (activeSessionId) await window.cyberslots.sessionCompact(activeSessionId);
  },

  async sendPrompt(text, attachments) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    await get().sendPromptTo(activeSessionId, text, attachments);
  },

  async sendPromptTo(sessionId, text, attachments, enginePrefix) {
    const { swarmBoost, efforts } = get();
    // enginePrefix（如 sidechat 只读指令）优先于 swarm 前缀，且不入气泡。
    const finalText = enginePrefix
      ? `${enginePrefix}\n\n${text}`
      : swarmBoost
        ? `请优先使用 AgentSwarm 并行子代理拆解与执行以下任务（可并行的子任务尽量委派给子代理）：\n${text}`
        : text;
    const userMsg: UnifiedMessage = {
      kind: 'user',
      id: crypto.randomUUID(),
      turnId: -1,
      text,
      attachments,
      createdAt: Date.now(),
    };
    mutateUi(set, sessionId, (ui) => ({ ...ui, messages: [...ui.messages, userMsg] }));
    schedulePersist(get, sessionId);
    // First user message becomes the session title.
    const session = get().sessions.find((s) => s.id === sessionId);
    if (session && session.title === '新会话') {
      const title = text.slice(0, 24) || '新会话';
      void window.cyberslots.sessionRename(sessionId, title);
      set((s) => ({
        sessions: s.sessions.map((m) => (m.id === sessionId ? { ...m, title } : m)),
      }));
    }
    await window.cyberslots.sessionPrompt({
      sessionId,
      text: finalText,
      attachments,
      effort: efforts[sessionId],
    });
  },

  async cancel() {
    const { activeSessionId } = get();
    if (activeSessionId) await window.cyberslots.sessionCancel(activeSessionId);
  },

  async cancelSession(sessionId) {
    await window.cyberslots.sessionCancel(sessionId);
  },

  async setModel(modelId) {
    const { activeSessionId } = get();
    if (activeSessionId) await window.cyberslots.sessionSetModel(activeSessionId, modelId);
  },

  async setMode(mode) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    await window.cyberslots.sessionSetMode(activeSessionId, mode);
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

  enqueue(text, attachments) {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    get().enqueueTo(activeSessionId, text, attachments);
  },

  enqueueTo(sessionId, text, attachments) {
    const item: QueuedMessage = { id: crypto.randomUUID(), text, attachments };
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
    const ok = await window.cyberslots.sessionSteer(sessionId, item.text);
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
    // 首条消息即会话标题（与普通提问同规则）。
    const session = get().sessions.find((s) => s.id === activeSessionId);
    if (session && session.title === '新会话') {
      const title = objective.slice(0, 24) || '新会话';
      void window.cyberslots.sessionRename(activeSessionId, title);
      set((s) => ({
        sessions: s.sessions.map((m) => (m.id === activeSessionId ? { ...m, title } : m)),
      }));
    }
    await window.cyberslots.sessionGoalSet(activeSessionId, objective);
  },

  async controlGoal(action) {
    const { activeSessionId } = get();
    if (activeSessionId) await window.cyberslots.sessionGoalControl(activeSessionId, action);
  },

  async renameSession(id, title) {
    await window.cyberslots.sessionRename(id, title);
    set((s) => ({ sessions: s.sessions.map((m) => (m.id === id ? { ...m, title } : m)) }));
  },

  async archiveSession(id, archived) {
    await window.cyberslots.sessionSetArchived(id, archived);
    set((s) => ({
      sessions: s.sessions.map((m) => (m.id === id ? { ...m, archived, unread: archived ? false : m.unread } : m)),
      // 归档当前正打开的会话 → 退回新会话页（它已从侧栏消失）。
      activeSessionId: archived && s.activeSessionId === id ? null : s.activeSessionId,
    }));
  },

  async deleteSession(id) {
    await window.cyberslots.sessionDelete(id);
    set((s) => ({
      sessions: s.sessions.filter((m) => m.id !== id),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
    }));
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

function mutateUi(set: SetFn, sessionId: string, fn: (ui: SessionUiState) => SessionUiState): void {
  set((s) => ({ ui: { ...s.ui, [sessionId]: fn(s.ui[sessionId] ?? emptyUi()) } }));
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
    case 'session.status':
      set((s) => ({
        sessions: s.sessions.map((m) =>
          m.id === sessionId ? { ...m, status: event.status, updatedAt: Date.now() } : m,
        ),
      }));
      return;
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
      return;
    case 'commands.update':
      mutateUi(set, sessionId, (ui) => ({ ...ui, commands: event.commands }));
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
        // 完成态：清状态条，并向消息流插一条完成公告（目标 + 真实用时）。
        set((s) => ({ goals: { ...s.goals, [sessionId]: undefined } }));
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
        mutateUi(set, sessionId, (ui) => ({ ...ui, messages: [...ui.messages, doneMsg] }));
        schedulePersist(get, sessionId);
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
        sessions: s.sessions.map((m) => (m.id === sessionId ? { ...m, unread: !active } : m)),
      }));
      mutateUi(set, sessionId, (ui) => ({ ...ui, messages: foldMessage(ui.messages, event) }));
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
      // 自动派发等待队列的下一条（稍作延迟，让引擎回到 idle）。
      const queue = get().queues[sessionId] ?? [];
      if (queue.length > 0 && event.stopReason !== 'error') {
        const [next, ...rest] = queue;
        set((s) => ({ queues: { ...s.queues, [sessionId]: rest } }));
        setTimeout(() => void get().sendPromptTo(sessionId, next!.text, next!.attachments), 500);
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
  }
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
function foldMessage(messages: UnifiedMessage[], event: EngineEvent): UnifiedMessage[] {
  const now = Date.now();
  switch (event.type) {
    case 'turn.started':
      return messages;

    case 'user.echo':
      return [
        ...messages,
        { kind: 'user', id: crypto.randomUUID(), turnId: event.turnId, text: event.text, createdAt: now },
      ];

    case 'text.delta':
    case 'thinking.delta': {
      const kind = event.type === 'text.delta' ? 'text' : 'thinking';
      const last = messages[messages.length - 1];
      if (last && last.kind === kind && last.turnId === event.turnId && last.streaming) {
        const updated = { ...last, text: last.text + event.text };
        return [...messages.slice(0, -1), updated];
      }
      // 开启新的文本/思考段前，先给上一段流式内容收尾（黄色 caret 止闪）。
      return [
        ...endStreaming(messages),
        { kind, id: crypto.randomUUID(), turnId: event.turnId, text: event.text, streaming: true, createdAt: now },
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
              options: event.options,
              createdAt: now,
            }
          : {
              kind: 'permission',
              id: crypto.randomUUID(),
              turnId: event.turnId,
              requestId: event.requestId,
              title: event.title,
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
        // 回合结束时仍未应答的授权/提问已无意义 — 标记取消，
        // 避免停止后弹层残留（e2e 实测）。
        if ((m.kind === 'permission' || m.kind === 'ask_user') && m.answeredOptionId === undefined) {
          return { ...m, answeredOptionId: '__cancelled__' };
        }
        return m;
      });
      if (event.stopReason === 'error') return closed;
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
