/**
 * Chat store — folds the main-process EngineEvent stream into renderable
 * UnifiedMessage lists per session, and fronts every session action.
 * This is the renderer's single source of truth.
 */

import { create } from 'zustand';

import type {
  AppSettings,
  CronTask,
  EngineEvent,
  EngineEventEnvelope,
  GoalControlAction,
  GoalInfo,
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
}

interface ChatState {
  sessions: SessionMeta[];
  ui: Record<string, SessionUiState>;
  activeSessionId: string | null;
  creating: boolean;
  settings: AppSettings | null;
  settingsOpen: boolean;
  swarmBoost: boolean;
  cronOpen: boolean;
  cronTasks: CronTask[];
  filter: SidebarFilter;
  /** Engine-native goal per session (codex thread/goal; pushed via goal.update). */
  goals: Record<string, GoalInfo | undefined>;
  /** Per-session reasoning-effort override (codex only). */
  efforts: Record<string, string>;
  /** Per-session outbox: messages waiting for the current turn to finish. */
  queues: Record<string, QueuedMessage[]>;
  init(): Promise<void>;
  saveSettings(patch: Partial<AppSettings>): Promise<void>;
  addWorkspace(name: string, folders: string[]): Promise<WorkspaceInfo>;
  updateWorkspace(ws: WorkspaceInfo): Promise<void>;
  removeWorkspace(id: string): Promise<void>;
  createSession(req: SessionCreateRequest): Promise<void>;
  selectSession(id: string): void;
  forkSession(id: string): Promise<void>;
  forkToEngine(id: string, engine: SessionMeta['engine']): Promise<void>;
  compactSession(): Promise<void>;
  sendPrompt(text: string, attachments?: string[]): Promise<void>;
  sendPromptTo(sessionId: string, text: string, attachments?: string[]): Promise<void>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  answerPermission(requestId: string, optionId?: string): Promise<void>;
  enqueue(text: string, attachments?: string[]): void;
  removeQueued(sessionId: string, id: string): void;
  moveQueued(sessionId: string, from: number, to: number): void;
  steerQueued(sessionId: string, id: string): Promise<void>;
  setGoal(objective: string): Promise<void>;
  controlGoal(action: GoalControlAction): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
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

/** Debounced per-session persistence of the folded message list. */
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePersist(get: () => ChatState, sessionId: string): void {
  const prev = persistTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  persistTimers.set(
    sessionId,
    setTimeout(() => {
      persistTimers.delete(sessionId);
      const messages = get().ui[sessionId]?.messages;
      if (messages) void window.cyberslots.sessionMessagesSave(sessionId, messages);
    }, 400),
  );
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  ui: {},
  activeSessionId: null,
  creating: false,
  settings: null,
  settingsOpen: false,
  swarmBoost: false,
  cronOpen: false,
  cronTasks: [],
  filter: DEFAULT_FILTER,
  goals: {},
  efforts: {},
  queues: {},

  async init() {
    const [sessions, settings] = await Promise.all([
      window.cyberslots.sessionList(),
      window.cyberslots.settingsGet(),
    ]);
    set({ sessions, settings });
    void window.cyberslots.themeSync(settings.theme);
    unsubscribe?.();
    unsubscribe = window.cyberslots.onEngineEvent((envelope) => {
      applyEnvelope(set, get, envelope);
    });
  },

  async saveSettings(patch) {
    const prevTheme = get().settings?.theme;
    const settings = await window.cyberslots.settingsSet(patch);
    set({ settings });
    if (settings.theme !== prevTheme) void window.cyberslots.themeSync(settings.theme);
  },

  async addWorkspace(name, folders) {
    const ws: WorkspaceInfo = { id: crypto.randomUUID(), name, folders, createdAt: Date.now() };
    await get().saveSettings({ workspaces: [...(get().settings?.workspaces ?? []), ws] });
    return ws;
  },

  async updateWorkspace(ws) {
    const workspaces = (get().settings?.workspaces ?? []).map((w) => (w.id === ws.id ? ws : w));
    await get().saveSettings({ workspaces });
  },

  async removeWorkspace(id) {
    const workspaces = (get().settings?.workspaces ?? []).filter((w) => w.id !== id);
    await get().saveSettings({ workspaces });
  },

  async createSession(req) {
    set({ creating: true });
    try {
      const meta = await window.cyberslots.sessionCreate(req);
      set((s) => ({
        sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)],
        ui: { ...s.ui, [meta.id]: s.ui[meta.id] ?? emptyUi() },
        activeSessionId: meta.id,
      }));
    } finally {
      set({ creating: false });
    }
  },

  selectSession(id) {
    set({ activeSessionId: id });
    void window.cyberslots.sessionMarkRead(id);
    set((s) => ({ sessions: s.sessions.map((m) => (m.id === id ? { ...m, unread: false } : m)) }));
    // Lazy-hydrate persisted history the first time a session is opened.
    if (!get().ui[id]) {
      void window.cyberslots.sessionMessagesGet(id).then((persisted) => {
        const messages = persisted.map((m) =>
          (m.kind === 'text' || m.kind === 'thinking') && m.streaming ? { ...m, streaming: false } : m,
        );
        set((s) => ({
          ui: { ...s.ui, [id]: { ...(s.ui[id] ?? emptyUi()), messages: s.ui[id]?.messages.length ? s.ui[id]!.messages : messages } },
        }));
      });
    }
  },

  /** Sidechat: branch off the given session and jump into the branch. */
  async forkSession(id) {
    set({ creating: true });
    try {
      const meta = await window.cyberslots.sessionFork(id);
      set((s) => ({ sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)] }));
      get().selectSession(meta.id);
    } finally {
      set({ creating: false });
    }
  },

  /** 换引擎继续聊：history-replay branch onto the other engine. */
  async forkToEngine(id, engine) {
    set({ creating: true });
    try {
      const meta = await window.cyberslots.sessionForkEngine(id, engine);
      set((s) => ({ sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)] }));
      get().selectSession(meta.id);
    } finally {
      set({ creating: false });
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

  async sendPromptTo(sessionId, text, attachments) {
    const { swarmBoost, efforts } = get();
    const finalText = swarmBoost
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
    const item: QueuedMessage = { id: crypto.randomUUID(), text, attachments };
    set((s) => ({ queues: { ...s.queues, [activeSessionId]: [...(s.queues[activeSessionId] ?? []), item] } }));
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
    if (!item) return;
    const ok = await window.cyberslots.sessionSteer(sessionId, item.text);
    if (ok) {
      get().removeQueued(sessionId, id);
    } else {
      const list = get().queues[sessionId] ?? [];
      const idx = list.findIndex((q) => q.id === id);
      if (idx > 0) get().moveQueued(sessionId, idx, 0);
    }
  },

  /** Engine-native goal (codex only — UI hides the control for kimi). */
  async setGoal(objective) {
    const { activeSessionId } = get();
    if (activeSessionId) await window.cyberslots.sessionGoalSet(activeSessionId, objective);
  },

  async controlGoal(action) {
    const { activeSessionId } = get();
    if (activeSessionId) await window.cyberslots.sessionGoalControl(activeSessionId, action);
  },

  async renameSession(id, title) {
    await window.cyberslots.sessionRename(id, title);
    set((s) => ({ sessions: s.sessions.map((m) => (m.id === id ? { ...m, title } : m)) }));
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
      mutateUi(set, sessionId, (ui) => ({
        ...ui,
        usage: { used: event.used, size: event.size, costUsd: event.costUsd },
      }));
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
      schedulePersist(get, sessionId);
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
      mutateUi(set, sessionId, (ui) => ({ ...ui, messages: foldMessage(ui.messages, event) }));
      schedulePersist(get, sessionId);
  }
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
      return [
        ...messages,
        { kind, id: crypto.randomUUID(), turnId: event.turnId, text: event.text, streaming: true, createdAt: now },
      ];
    }

    case 'tool.upsert': {
      const idx = messages.findIndex((m) => m.kind === 'tool_call' && m.toolCallId === event.toolCallId);
      if (idx >= 0) {
        const prev = messages[idx]!;
        if (prev.kind !== 'tool_call') return messages;
        const merged: UnifiedMessage = {
          ...prev,
          title: event.title ?? prev.title,
          toolKind: event.toolKind ?? prev.toolKind,
          status: event.status ?? prev.status,
          content: event.content ?? prev.content,
          locations: event.locations ?? prev.locations,
        };
        const next = [...messages];
        next[idx] = merged;
        return next;
      }
      return [
        ...messages,
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
      const idx = messages.findIndex((m) => m.kind === 'plan' && m.turnId === event.turnId);
      if (idx >= 0) {
        const next = [...messages];
        next[idx] = { ...(next[idx] as Extract<UnifiedMessage, { kind: 'plan' }>), entries: event.entries };
        return next;
      }
      return [
        ...messages,
        { kind: 'plan', id: crypto.randomUUID(), turnId: event.turnId, entries: event.entries, createdAt: now },
      ];
    }

    case 'permission.request':
      return [
        ...messages,
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
      const closed = messages.map((m) =>
        (m.kind === 'text' || m.kind === 'thinking') && m.turnId === event.turnId && m.streaming
          ? { ...m, streaming: false }
          : m,
      );
      if (event.stopReason === 'error') return closed;
      return [
        ...closed,
        {
          kind: 'turn_end',
          id: crypto.randomUUID(),
          turnId: event.turnId,
          stopReason: event.stopReason,
          usage: event.usage,
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
