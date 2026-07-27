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

export type EngineId = 'kimi' | 'codex' | 'opencode';

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
  /** 归档：不在侧栏展示，从「已归档」入口查看/还原；与删除（discard）不同，数据全保留。 */
  archived?: boolean;
  /**
   * Fallback-fork context: serialized parent history injected before the
   * first prompt when the engine has no native session/fork. Cleared after use.
   */
  contextSeed?: string;
}

// ---------------------------------------------------------- message model

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';

export interface ToolCallContent {
  /** Best-effort textual output/diff preview extracted from the engine. */
  text?: string;
  /** Structured diff, when the tool edited a file. */
  diff?: { path: string; oldText?: string; newText?: string };
}

/** One rendered item in the conversation stream. */
export type UnifiedMessage =
  | {
      kind: 'user';
      id: string;
      turnId: number;
      text: string;
      attachments?: string[];
      createdAt: number;
      steer?: boolean;
      /** 该条提问是作为 Goal 发送的（气泡下方标注 Sent as goal）。 */
      sentAsGoal?: boolean;
    }
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
  | {
      kind: 'turn_end';
      id: string;
      turnId: number;
      stopReason: string;
      usage?: UsageInfo;
      durationMs?: number;
      /** 纯 API/模型耗时（墙钟 − 工具执行 − 审批等待），t/s 的分母；缺省退回 durationMs。 */
      apiDurationMs?: number;
      createdAt: number;
    };

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
  /** 字符数估算值（kimi ACP 不推 usage 时的兜底），UI 带 ~ 标注。 */
  approx?: boolean;
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
  | {
      type: 'turn.ended';
      turnId: number;
      stopReason: string;
      usage?: UsageInfo;
      durationMs?: number;
      apiDurationMs?: number;
    }
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
  /** model_catalog_json 里声明的模型目录（存在且可解析时）。 */
  catalogModels?: CodexCatalogModel[];
  error?: string;
}

/** codex model_catalog_json 的单个模型条目（只留 UI 需要的字段；
 *  slug 即 codex `model` 参数值）。 */
export interface CodexCatalogModel {
  slug: string;
  displayName?: string;
  contextWindow?: number;
  /** 输入模态：text / image … */
  inputModalities?: string[];
  /** 支持的思考深度档位（按 catalog 声明顺序）。 */
  efforts?: string[];
  defaultEffort?: string;
}

/** opencode `GET /config/providers` 归一化后的单个模型条目。
 *  slug = `providerID/modelID`（选择器/会话 modelId 的统一格式）；
 *  efforts 来自 reasoning variants 键名（如 none/high）。 */
export interface OpencodeModelEntry {
  slug: string;
  providerID: string;
  /** provider 展示名（选择器分组标题）。 */
  providerName: string;
  modelID: string;
  displayName?: string;
  contextWindow?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  efforts?: string[];
  defaultEffort?: string;
  /** 能力标记（选择器详情面板）。 */
  toolCall?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  /** 单价 $/1M tokens（0/0 = 免费模型）。 */
  costInput?: number;
  costOutput?: number;
}

/** opencode catalog 拉取结果（opencodeCatalogGet IPC 返回体）。 */
export interface OpencodeCatalog {
  models: OpencodeModelEntry[];
  /** providerID → 默认 modelID（server 侧声明）。 */
  defaults: Record<string, string>;
  error?: string;
}

/** opencode CLI 只读快照（静态探测，不启动 server）。 */
export interface OpencodeConfigSnapshot {
  installed: boolean;
  version?: string;
  cliPath?: string;
  /** 全局 opencode.json（~/.config/opencode）存在性 — 仅展示，永不写入。 */
  configPath?: string;
  configExists?: boolean;
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
  opencode: OpencodeConfigSnapshot;
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

export type ThemeMode = 'light' | 'dark' | 'system';
/** system 解析后的实际明暗值。 */
export type ResolvedMode = 'light' | 'dark';
export type ThemePalette = 'notion' | 'solarized' | 'everforest';

/** 渲染进程推给主进程的已解析外观（原生标题栏/窗口底色联动）。 */
export interface WindowAppearance {
  palette: ThemePalette;
  mode: ResolvedMode;
}

export interface AppSettings {
  /** 明暗模式：浅色 / 深色 / 跟随系统。 */
  themeMode: ThemeMode;
  /** 配色主题（阅读向色板，每套含明、暗两个变体）。 */
  themePalette: ThemePalette;
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
