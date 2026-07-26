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
  PermissionMode,
  SessionMeta,
  SlashCommandInfo,
  UnifiedMessage,
} from '@shared/types';
import type { SessionCreateRequest } from '@shared/ipc';

export interface SessionUiState {
  messages: UnifiedMessage[];
  usage?: { used: number; size: number; costUsd?: number };
  models: { current: string; available: string[] };
  modes: { current: PermissionMode; available: PermissionMode[] };
  commands: SlashCommandInfo[];
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
  init(): Promise<void>;
  saveSettings(patch: Partial<AppSettings>): Promise<void>;
  createSession(req: SessionCreateRequest): Promise<void>;
  selectSession(id: string): void;
  forkSession(id: string): Promise<void>;
  sendPrompt(text: string, attachments?: string[]): Promise<void>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  answerPermission(requestId: string, optionId?: string): Promise<void>;
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

  async init() {
    const [sessions, settings] = await Promise.all([
      window.cyberslots.sessionList(),
      window.cyberslots.settingsGet(),
    ]);
    set({ sessions, settings });
    unsubscribe?.();
    unsubscribe = window.cyberslots.onEngineEvent((envelope) => {
      applyEnvelope(set, get, envelope);
    });
  },

  async saveSettings(patch) {
    const settings = await window.cyberslots.settingsSet(patch);
    set({ settings });
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

  async sendPrompt(text, attachments) {
    const { activeSessionId, swarmBoost } = get();
    if (!activeSessionId) return;
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
    mutateUi(set, activeSessionId, (ui) => ({ ...ui, messages: [...ui.messages, userMsg] }));
    schedulePersist(get, activeSessionId);
    // First user message becomes the session title.
    const session = get().sessions.find((s) => s.id === activeSessionId);
    if (session && session.title === '新会话') {
      const title = text.slice(0, 24) || '新会话';
      void window.cyberslots.sessionRename(activeSessionId, title);
      set((s) => ({
        sessions: s.sessions.map((m) => (m.id === activeSessionId ? { ...m, title } : m)),
      }));
    }
    await window.cyberslots.sessionPrompt({ sessionId: activeSessionId, text: finalText, attachments });
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
    if (activeSessionId) await window.cyberslots.sessionSetMode(activeSessionId, mode);
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

function applyEnvelope(set: SetFn, get: GetFn, { sessionId, event }: EngineEventEnvelope): void {
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
