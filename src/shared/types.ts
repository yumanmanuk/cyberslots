/**
 * Shared domain model — the engine-agnostic language spoken between
 * main process (engine adapters), preload bridge, and renderer UI.
 *
 * Everything the UI renders is a `UnifiedEvent` stream materialized
 * into `UnifiedMessage`s per session. Engine adapters (kimi/ACP,
 * codex/app-server) translate their native protocols into this model
 * and nothing engine-specific leaks past this file.
 */

// ---------------------------------------------------------------- engines

export type EngineId = 'kimi' | 'codex';

/** Session permission mode — union of both engines' surfaces (kimi: default/plan/auto/yolo). */
export type PermissionMode = 'default' | 'plan' | 'auto' | 'yolo';

export type SessionStatus =
  | 'starting' // engine process/session being created
  | 'idle' // ready, no active turn
  | 'running' // turn in flight
  | 'awaiting' // blocked on permission / ask-user answer
  | 'error'
  | 'closed';

export interface ModelInfo {
  /** Alias used to select the model (config.toml alias / catalog id). */
  id: string;
  name: string;
  provider: string;
  engine: EngineId;
  maxContextSize?: number;
  /** Thinking/reasoning levels this model supports (empty = none). */
  thinkingLevels?: string[];
}

export interface SessionMeta {
  /** App-level id (stable across engine restarts). */
  id: string;
  engine: EngineId;
  /** Engine-native id: ACP sessionId / codex threadId. */
  engineSessionId?: string;
  title: string;
  /** Working directory ('' = pure-chat mode, no workspace bound). */
  cwd: string;
  chatMode: 'chat' | 'work';
  modelId: string;
  permissionMode: PermissionMode;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  /** Set when this session was forked off another one (sidechat). */
  parentId?: string;
  /** Sidebar grouping: id of the WorkspaceInfo this session belongs to. */
  workspaceId?: string;
  /** Marks sessions that finished a turn while not being viewed. */
  unread?: boolean;
  /**
   * Fallback-fork context: serialized parent history injected before the
   * first prompt when the engine has no native session/fork. Cleared after use.
   */
  contextSeed?: string;
}

// ---------------------------------------------------------- message model

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallContent {
  /** Best-effort textual output/diff preview extracted from the engine. */
  text?: string;
  /** Structured diff, when the tool edited a file. */
  diff?: { path: string; oldText?: string; newText?: string };
}

/** One rendered item in the conversation stream. */
export type UnifiedMessage =
  | { kind: 'user'; id: string; turnId: number; text: string; attachments?: string[]; createdAt: number; steer?: boolean }
  | { kind: 'text'; id: string; turnId: number; text: string; streaming: boolean; createdAt: number; planDoc?: boolean }
  | { kind: 'thinking'; id: string; turnId: number; text: string; streaming: boolean; createdAt: number; durationMs?: number }
  | {
      kind: 'tool_call';
      id: string;
      turnId: number;
      toolCallId: string;
      title: string;
      toolKind: string; // read | edit | execute | fetch | think | other (ACP tool kinds)
      status: ToolCallStatus;
      content?: ToolCallContent;
      locations?: string[];
      createdAt: number;
    }
  | { kind: 'plan'; id: string; turnId: number; entries: PlanEntry[]; createdAt: number }
  | {
      kind: 'permission';
      id: string;
      turnId: number;
      requestId: string;
      title: string;
      toolCallId?: string;
      options: PermissionOptionView[];
      /** Filled once answered — UI locks the card. */
      answeredOptionId?: string;
      createdAt: number;
    }
  | {
      kind: 'ask_user';
      id: string;
      turnId: number;
      requestId: string;
      question: string;
      options: PermissionOptionView[];
      answeredOptionId?: string;
      createdAt: number;
    }
  | { kind: 'error'; id: string; turnId: number; message: string; createdAt: number }
  | { kind: 'system'; id: string; turnId: number; text: string; createdAt: number }
  | { kind: 'turn_end'; id: string; turnId: number; stopReason: string; usage?: UsageInfo; durationMs?: number; createdAt: number };

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: string;
}

export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: string; // allow_once | allow_always | reject_once | reject_always
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Tokens served from provider prompt cache (subset of inputTokens). */
  cachedInputTokens?: number;
  contextUsed?: number;
  contextMax?: number;
}

/** Engine-native goal snapshot (codex thread/goal; kimi ACP has no goal surface). */
export interface GoalInfo {
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  tokensUsed: number;
  timeUsedSeconds: number;
  tokenBudget?: number;
}

export type GoalControlAction = 'pause' | 'resume' | 'clear';

// ------------------------------------------------------------ event model
// Adapters emit these; the renderer store folds them into UnifiedMessages.

export type EngineEvent =
  | { type: 'session.status'; status: SessionStatus; detail?: string }
  | { type: 'session.meta'; patch: Partial<SessionMeta> }
  | { type: 'turn.started'; turnId: number }
  /** Echo of a user prompt injected outside the renderer (cron runs). */
  | { type: 'user.echo'; turnId: number; text: string }
  | { type: 'text.delta'; turnId: number; text: string }
  | { type: 'thinking.delta'; turnId: number; text: string }
  | {
      type: 'tool.upsert';
      turnId: number;
      toolCallId: string;
      title?: string;
      toolKind?: string;
      status?: ToolCallStatus;
      content?: ToolCallContent;
      locations?: string[];
    }
  | { type: 'plan.update'; turnId: number; entries: PlanEntry[] }
  | {
      type: 'permission.request';
      turnId: number;
      requestId: string;
      isQuestion: boolean;
      title: string;
      toolCallId?: string;
      options: PermissionOptionView[];
    }
  | { type: 'permission.resolved'; requestId: string; optionId?: string }
  | { type: 'commands.update'; commands: SlashCommandInfo[] }
  | { type: 'models.update'; current: string; available: string[] }
  | { type: 'modes.update'; current: PermissionMode; available: PermissionMode[] }
  | { type: 'usage.update'; used: number; size: number; costUsd?: number }
  /** Engine-side goal state changed (null = cleared/none). */
  | { type: 'goal.update'; goal: GoalInfo | null }
  | { type: 'turn.ended'; turnId: number; stopReason: string; usage?: UsageInfo; durationMs?: number }
  | { type: 'error'; turnId?: number; message: string; source: 'client' | 'engine' | 'provider' };

export interface SlashCommandInfo {
  name: string;
  description?: string;
  hint?: string;
}

/** Envelope pushed main → renderer. */
export interface EngineEventEnvelope {
  sessionId: string;
  event: EngineEvent;
  ts: number;
}

// ------------------------------------------------------------- settings

/** 每引擎的协议路由开关：true = 调用 CLI 时前置本程序的协议转换
 *  server；false = CLI 直连其自己配置文件里的端点（本程序零干预）。 */
export interface EngineRoutingSettings {
  kimi: boolean;
  codex: boolean;
}

// ---------------------------------------------- CLI 配置只读快照（展示用）
// 本程序只读取 CLI 自己的配置文件（~/.kimi-code、~/.codex），永不写入；
// key 绝不以明文跨进 renderer，只给 hasKey 标记。

export interface KimiConfigModel {
  alias: string;
  model: string;
  maxContextSize?: number;
}

export interface KimiConfigProvider {
  id: string;
  /** kosong provider type：kimi / openai / openai_responses / anthropic … */
  type: string;
  baseUrl: string;
  hasKey: boolean;
  models: KimiConfigModel[];
}

export interface KimiConfigSnapshot {
  home: string;
  configPath: string;
  exists: boolean;
  defaultModel?: string;
  providers: KimiConfigProvider[];
  error?: string;
}

export interface CodexConfigProvider {
  id: string;
  name?: string;
  baseUrl: string;
  /** codex wire_api：responses（chat 已从 codex 移除，旧配置可能仍有） */
  wireApi: string;
  envKey?: string;
  /** env_key 在当前环境能解析到值。 */
  hasKey: boolean;
}

export interface CodexConfigSnapshot {
  home: string;
  configPath: string;
  exists: boolean;
  model?: string;
  reasoningEffort?: string;
  /** 配置里的 model_provider（未设 = 内置 openai）。 */
  activeProvider?: string;
  authMode: 'chatgpt' | 'apikey' | 'none';
  providers: CodexConfigProvider[];
  error?: string;
}

export interface RouteSupport {
  ok: boolean;
  /** 不可路由时的人话原因（已 i18n 化的中文，renderer 直接展示）。 */
  reason?: string;
}

export interface EngineConfigsSnapshot {
  kimi: KimiConfigSnapshot;
  codex: CodexConfigSnapshot;
  routeSupport: { kimi: RouteSupport; codex: RouteSupport };
}

/** A named multi-folder workspace (sidebar top-level group). */
export interface WorkspaceInfo {
  id: string;
  name: string;
  /** Absolute folder paths; the first one is the engine cwd. */
  folders: string[];
  createdAt: number;
}

export interface NotificationSettings {
  /** Notify when a turn finishes while the window is unfocused. */
  taskComplete: boolean;
  /** Notify on permission / ask-user requests. */
  question: boolean;
  /** Notify on engine/provider errors. */
  error: boolean;
}

export type AppLanguage = 'zh' | 'en';

export interface AppSettings {
  theme: 'notion' | 'light' | 'dark';
  language: AppLanguage;
  defaultPermissionMode: PermissionMode;
  sendKey: 'enter' | 'ctrl-enter';
  notifications: NotificationSettings;
  workspaces: WorkspaceInfo[];
  /** 协议路由开关（仅影响本程序内 spawn 的 CLI，不碰用户配置文件）。 */
  routing: EngineRoutingSettings;
}

// ------------------------------------------------------------ cron tasks

export interface CronTask {
  id: string;
  name: string;
  /** Standard 5-field cron: `min hour day-of-month month day-of-week`. */
  cron: string;
  prompt: string;
  engine: EngineId;
  /** Working directory ('' = headless chat session in a scratch dir). */
  cwd: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastResult?: 'ok' | 'error';
  /** Session created by the most recent run — lets the user inspect output. */
  lastSessionId?: string;
}
