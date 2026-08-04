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

export type EngineId = 'kimi' | 'codex' | 'opencode' | 'omp' | 'antigravity' | 'claude';

/** 引擎展示名 — renderer 徽标与主进程系统公告共用（单一真源，勿在别处再定义）。 */
export const ENGINE_LABELS: Record<EngineId, string> = {
  codex: 'Codex',
  kimi: 'Kimi Code',
  opencode: 'opencode',
  omp: 'Oh My Pi',
  antigravity: 'Antigravity',
  claude: 'Claude Code',
};

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

/** 会话级能力快照 — 由主进程在 adapter 构建后按可选方法存在性计算
 *（单一真源 = EngineAdapter 接口），经 session.meta patch 推给 UI 做
 * 控件显隐。同一引擎不同通道能力可不同（kimi KAP 有 goal/steer，
 * ACP 没有），所以挂在会话而非引擎 id 上。 */
export interface SessionCapabilities {
  goal: boolean;
  steer: boolean;
  fork: boolean;
  compact: boolean;
  /** 引擎原生 swarm 模式开关（kimi KAP swarm_mode）；无则 UI 退回
   *  提示词引导（swarmBoost 前缀）。旧快照缺此字段 = 不支持。 */
  swarm?: boolean;
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
  /** 赛马角色会话标记：所属 RaceGroup id。侧栏隐藏，仅从宿主对话的
   *  赛马菜单进入赛马视图查看（赛马寄生于发起它的对话）。 */
  raceId?: string;
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
  /**
   * Sidechat 分支起始时从父会话继承的历史条数。上下文仍完整保留
   * （native engineSessionId 或 contextSeed），此计数仅供 SideChatPanel
   * 隐藏这段继承历史——分支面板只显示分支内新产生的问答，不重复渲染主对话。
   */
  forkSeedCount?: number;
  /**
   * 引擎切换分支（forkToEngine 产物）：数据上仍是新会话（干净的分支模型，
   * 父会话原生上下文完整保留可无损回切），但视觉上接管父会话 —— 侧栏沿
   * parentId 链折叠，同一条对话永远只显示链上最新叶子。
   */
  chained?: boolean;
  /**
   * Claude 原生分叉待就：新会话首个 prompt 时以 --resume <此 id> --fork-session
   * 从父会话分叉出独立副本（引擎侧真分支，无需重放历史）。
   * 分叉实例化（首个 result 回新 session_id）后由主进程清空。
   */
  forkPendingFromId?: string;
  /** 能力快照（启动过一次后才有）；缺省时 UI 按引擎 id 兼容兑底。 */
  capabilities?: SessionCapabilities;
  /** kimi 会话实际走的通道：kap（kimi web REST+WS，全能力）/
   *  acp（stdio，窄面兜底）。会话粒度一选定终身 — 两侧引擎代际
   *  不同（v1/v2），跨通道 resume 不保证成功。 */
  kimiChannel?: 'kap' | 'acp';
}

// ---------------------------------------------------------- message model

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled' | 'proposed';

export interface ToolCallContent {
  /** Best-effort textual output/diff preview extracted from the engine. */
  text?: string;
  /** Structured diff, when the tool edited a file. */
  diff?: { path: string; oldText?: string; newText?: string };
  /** Unified diff patch text (opencode edit/write metadata; omp hashline/ast_edit). */
  patch?: string;
  /** 编辑完成后的行数变更统计（+N / -N 徽章）。 */
  additions?: number;
  deletions?: number;
  /** 文件变更性质 — A（新增）/ M（修改）/ D（删除）徽章。 */
  changeKind?: 'add' | 'modify' | 'delete';
  /** grep/glob 等搜索类工具的命中数（"N results"）。 */
  matches?: number;
  /** shell 退出码（非 0 显示 Exit N）。 */
  exitCode?: number;
  /** omp 子代理（task）进度流：最新进度行 + 尾部输出（卡内滚动）。 */
  progress?: { line: string; tail?: string[] };
  /** 子代理免审批标记（仅 omp headless 子代理强制 yolo 时置位）——
   *  其他引擎的子代理走同一审批通道，不置此标，TaskCard 不显该标。 */
  autoApproved?: boolean;
  /** 工具输出图片（generate_image / inspect_image）：data URI 或文件路径。 */
  images?: string[];
}

/**
 * 文件选区引用 —— 「添加到对话」卡片背后真正的 payload。
 * 卡片上只显示 `{EXT} 文件名#L起-止`；发送时把快照文本+出处
 * 序列化成结构化块注入 prompt。
 */
export interface CodeSelection {
  id: string;
  /** 绝对路径 —— 模型可用工具继续读该文件拿上下文。 */
  path: string;
  fileName: string;
  /** 扩展名（小写无点）→ 卡片徽标 + 代码块语言标识。 */
  ext: string;
  /** 1-based，含首尾。 */
  startLine: number;
  endLine: number;
  /** 点击「添加到对话」那一刻的文本快照：AI/用户随后改动文件
   *  都不影响这条引用（否则卡片行号会与发送内容错位）。 */
  text: string;
}

/** One rendered item in the conversation stream. */
export type UnifiedMessage =
  | {
      kind: 'user';
      id: string;
      turnId: number;
      text: string;
      attachments?: string[];
      /** 随这条提问发送的代码选区引用（气泡里显示为卡片；
       *  发送时已序列化进 prompt，此处仅供 UI 回显）。 */
      selections?: CodeSelection[];
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
      toolKind: string; // read | edit | search | execute | fetch | think | other (ACP tool kinds)
      /** 引擎原始工具名（read/grep/glob/bash…），用于 Explored 明细行动词。 */
      toolName?: string;
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
      /** 富确认正文（plan_review 计划全文 / goal_start objective / 长命令），
       *  卡内滚动展示；缺省 = 纯标题卡。 */
      body?: string;
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
      /** 问题补充正文（KAP question 的 header/body）。 */
      body?: string;
      options: PermissionOptionView[];
      answeredOptionId?: string;
      /** 用户在提问卡输入框里的自定义回答原文（Other: …），仅增不改。 */
      answeredNote?: string;
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
      /** 回合结束时刻的引擎/模型快照 —— 回答信息 tooltip 用；旧消息文件
       *  无此字段，UI 回退显示会话当前值。 */
      engine?: EngineId;
      modelId?: string;
      /** 思考深度（回合发送时的生效档）快照 —— 回答信息 tooltip 用；旧消息
       *  无此字段，UI 回退重算会话当前生效档。 */
      effort?: string;
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
  /** 本回合内实际发生的 API 调用次数（工具循环逐次计数）。缺省 = 引擎
   *  无逐调用信号（omp / 老数据），统计侧按 1 回合兜底。 */
  apiCalls?: number;
  contextUsed?: number;
  contextMax?: number;
  /** 字符数估算值（kimi ACP 不推 usage 时的兜底），UI 带 ~ 标注。 */
  approx?: boolean;
}

// ---------------------------------------------------------- usage stats

/** 用量统计查询（渲染层 → 主进程；时间为毫秒时间戳）。 */
export interface UsageStatsQuery {
  startTs: number;
  endTs: number;
  /** 省略 = 全部引擎。 */
  engine?: EngineId;
}

/** 单个时间桶的用量聚合（跨度 ≤24h 按小时桶，否则按本地日历天）。 */
export interface UsageBucket {
  /** 桶起始时刻（ms）。 */
  ts: number;
  requests: number;
  /** 上行 token 总量（含缓存命中部分，语义同 UsageInfo.inputTokens）。 */
  inputTokens: number;
  outputTokens: number;
  /** 命中 provider 缓存的上行子集。 */
  cachedTokens: number;
}

export interface UsageStatsResult {
  bucketMs: number;
  buckets: UsageBucket[];
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
  };
}

// -------------------------------------------------------- provider quota

export type QuotaProviderId = 'kimi' | 'minimax' | 'deepseek';

/** Token Plan 单个时间窗（kimi / minimax coding plan）。 */
export interface QuotaTierInfo {
  name: 'five_hour' | 'weekly';
  /** 已用百分比 0–100。 */
  utilization: number;
  /** 窗口重置时刻（ms）；缺省 = 接口未给。 */
  resetsAt?: number;
}

/** 单个供应商的余量/余额查询结果。只返回本地引擎配置里探测到
 *  apiKey 的供应商；key 本身只在主进程使用，从不跨进 renderer。 */
export interface ProviderQuotaInfo {
  provider: QuotaProviderId;
  ok: boolean;
  error?: string;
  /** kimi/minimax token plan 时间窗。 */
  tiers?: QuotaTierInfo[];
  /** deepseek 账户余额（按币种）。 */
  balances?: Array<{ currency: string; amount: number }>;
  queriedAt: number;
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
  | { type: 'thinking.delta'; turnId: number; text: string; durationMs?: number }
  | {
      type: 'tool.upsert';
      turnId: number;
      toolCallId: string;
      title?: string;
      toolKind?: string;
      toolName?: string;
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
      /** 富确认正文（计划全文/objective/长命令），可选。 */
      body?: string;
      toolCallId?: string;
      options: PermissionOptionView[];
    }
  | { type: 'permission.resolved'; requestId: string; optionId?: string }
  | { type: 'commands.update'; commands: SlashCommandInfo[] }
  | { type: 'models.update'; current: string; available: string[] }
  | { type: 'modes.update'; current: PermissionMode; available: PermissionMode[] }
  | { type: 'usage.update'; used: number; size: number; costUsd?: number }
  /** 引擎原生 swarm 模式状态（kimi KAP；开关回声与引擎自发退出同源）。 */
  | { type: 'swarm.update'; active: boolean }
  /** Engine-side goal state changed (null = cleared/none). */
  | { type: 'goal.update'; goal: GoalInfo | null }
  | {
      type: 'turn.ended';
      turnId: number;
      stopReason: string;
      usage?: UsageInfo;
      durationMs?: number;
      apiDurationMs?: number;
      /** 引擎自发回合（stopReason='background'）中、仍属用户可见回答的那些
       *  （如 goal 续跑）标为 true：渲染层依旧不派发队列/不触压缩（保护不变），
       *  但依然生成 turn_end 统计行（复制回答 + token）。compaction 等不置。 */
      showStats?: boolean;
      /** background 回合细分。渲染层据此在回合结束时补发排队消息：
       *  'compact' = 压缩回合；'goal-idle' = goal 已不活跃（完成/清除/暂停）
       *  的续跑回合 —— 这两种引擎都不会再自起下一轮，不补发队列会滞留；
       *  'task' = 引擎一次性自发工作（异步任务结果注入），同样没有下一轮；
       *  未置 = 引擎会自起下一轮（goal 活跃续跑），保持不派发。 */
      backgroundKind?: 'compact' | 'goal-idle' | 'task';
      /** 本回合的失败已坐实为额度耗尽（引擎在发 turn.ended 前完成核实，
       *  不再靠事后异步补报）——赛马编排器据此不盲目自动重试（重试必
       *  再撞同一账号），把复活交给切号后的补跑；普通会话的
       *  quotaExhausted error 分支不受影响。 */
      quotaExhausted?: boolean;
    }
  | { type: 'error'; turnId?: number; message: string; source: 'client' | 'engine' | 'provider'; quotaExhausted?: boolean };

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

// ------------------------------------------------------------ compat audit

/** 引擎兼容性审计事件分类：降级对用户静默，对维护者全记账。
 *  unknown-event = 引擎发来不认识的事件/通知（可能是新增能力）；
 *  rejected-method = 我方调用被引擎拒绝（Method not found 等，可能被砍）；
 *  parse-error = 协议流里解析失败的报文（格式漂移信号）。 */
export type CompatAuditKind = 'unknown-event' | 'rejected-method' | 'parse-error';

/** 同一指纹（kind + detail）的聚合条目 — 原始报文样本落磘 JSONL，
 *  内存只留计数，防高频未知事件刷爆。 */
export interface CompatAuditEntry {
  kind: CompatAuditKind;
  /** 指纹明细：事件名 / 方法名 / 解析场景。 */
  detail: string;
  count: number;
  firstTs: number;
  lastTs: number;
}

/** compat:audit-get 返回体，也是 compat:audit 推送体。 */
export interface CompatAuditSnapshot {
  engines: Partial<Record<EngineId, CompatAuditEntry[]>>;
  /** JSONL 审计日志绝对路径（UI「打开日志位置」用）。 */
  logFile: string;
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
  /** 思考深度面板值域（config.toml support_efforts 合成，对齐 kimi CLI
   *  buildThinkingOption：always_thinking 模型无 off 行；无档位声明或仅
   *  单值 = 无可选 → 缺省，控件隐藏）。 */
  efforts?: string[];
  /** 默认档（default_effort，overrides 优先）。 */
  defaultEffort?: string;
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
  /** CLI 版本（npm 包 package.json 快路径，兜底 `kimi --version` 探测）。 */
  version?: string;
  defaultModel?: string;
  providers: KimiConfigProvider[];
  error?: string;
  /** KAP 通道（kimi web server）可用性探测：启动/设置页展示用。 */
  kap?: KapDetection;
}

/** KAP 通道静态探测结果（不 spawn，纯文件/注册表扫描）。 */
export interface KapDetection {
  /** kimi CLI 入口可定位（npm 全局安装）。 */
  installed: boolean;
  /** CLI 版本（package.json）。 */
  version?: string;
  /** 实例注册表里有活的 kimi web server（pid 存活）。 */
  running: boolean;
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
  /** CLI 版本（npm 包 package.json 快路径，兜底 `codex --version` 探测）。 */
  version?: string;
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

/** omp (oh-my-pi) `omp models --json` 归一化后的单个模型条目。
 *  slug = `provider/modelID`（spawn --model 参数值）；ACP 面思考档只有
 *  off/auto（probe-omp-findings §3），精细档经 spawn --thinking 承载。 */
export interface OmpModelEntry {
  slug: string;
  provider: string;
  /** provider 展示名（选择器分组标题）。 */
  providerName?: string;
  modelID: string;
  displayName?: string;
  contextWindow?: number;
  /** 思考能力标记（reasoning 模型 → effort 选项给 off/auto）。 */
  reasoning?: boolean;
  /** 思考档位（目录 thinking[] 实报，如 minimal/low/medium/high 或 high/max）；
   *  带模型 spawn 后 ACP configOptions 会动态扩展出这些档。 */
  efforts?: string[];
  /** 订阅/套餐类 provider（coding plan）标记，选择器角标。 */
  subscription?: boolean;
  /** 单价 $/1M tokens（0/0 = 免费模型）。 */
  costInput?: number;
  costOutput?: number;
}

/** omp 模型目录拉取结果（ompCatalogGet IPC 返回体）。
 *  无凭据时 models 为空（引擎默认兑底）— probe-omp-findings §4。 */
export interface OmpCatalog {
  models: OmpModelEntry[];
  error?: string;
}

/** omp CLI 只读快照（静态探测，不进会话）。永不写入 ~/.omp。 */
export interface OmpConfigSnapshot {
  installed: boolean;
  version?: string;
  cliPath?: string;
  /** ~/.omp/agent 存在性（已初始化/登录过的痕迹）— 仅展示。 */
  configPath?: string;
  configExists?: boolean;
  error?: string;
}

export interface RouteSupport {
  ok: boolean;
  /** 不可路由时的人话原因（已 i18n 化的中文，renderer 直接展示）。 */
  reason?: string;
}

/** Antigravity CLI (`agy`) 只读快照（静态探测，不进会话）。永不写入。 */
export interface AntigravityConfigSnapshot {
  installed: boolean;
  version?: string;
  cliPath?: string;
  /** cockpit 账号池目录（~/.antigravity_cockpit/accounts）存在性 — 仅展示。 */
  configPath?: string;
  configExists?: boolean;
  error?: string;
}

/** `agy models` 两列文本解析后的单个模型条目（slug 即 --model 参数值）。 */
export interface AntigravityModelEntry {
  slug: string;
  displayName?: string;
  /** 思考档位（claude 系支持 low/medium/high；gemini flash slug 已含档位）。 */
  efforts?: string[];
}

export interface AntigravityCatalog {
  models: AntigravityModelEntry[];
  error?: string;
}

/** Claude Code CLI (`claude`) 只读快照（静态探测，不进会话）。永不写入 ~/.claude。
 *  认证真源是 CLI 自身（OAuth token / ANTHROPIC_API_KEY），本程序不管理凭据。 */
export interface ClaudeConfigSnapshot {
  installed: boolean;
  version?: string;
  cliPath?: string;
  /** 已登录（OAuth）或检测到 ANTHROPIC_API_KEY — 仅展示布尔态，绝不外泄凭据。 */
  loggedIn?: boolean;
  /** 认证方式：oauth（claude login）/ apikey（ANTHROPIC_API_KEY 环境变量）/ none。 */
  authMethod?: 'oauth' | 'apikey' | 'none';
  /** 第三方网关自定义模型映射（settings.json env 的 ANTHROPIC_MODEL /
   *  ANTHROPIC_DEFAULT_*_MODEL(_NAME) 推导）：别名 → 自定义模型显示名。 */
  modelLabels?: Record<string, string>;
  error?: string;
}

/** 单个 Antigravity 账号（本程序导入池；凭据副本存 userData/agy-accounts.json）。 */
export interface AgyAccount {
  id: string;
  email: string;
  name?: string;
  lastUsed?: number;
  /** 导入时间戳。 */
  importedAt?: number;
}

/** 导入池快照 + 当前活动账号。accounts 仅含用户显式导入的账号 —
 *  未导入的 cockpit 账号本程序不列出、不切号、不查额度。 */
export interface AgyAccountsSnapshot {
  accounts: AgyAccount[];
  /** 当前 keyring/google_accounts 侧的活动邮箱。 */
  active?: string;
  /** cockpit 侧记录的当前账号 id（活动邮箱匹配不上时的回退）。 */
  cockpitCurrentId?: string;
  error?: string;
}

/** 导入弹层里的 cockpit 候选账号（只读扫描，仅导入时用）。 */
export interface AgyImportCandidate {
  id: string;
  email: string;
  name?: string;
  /** 已在导入池中。 */
  imported: boolean;
  /** cockpit 账号文件里是否有 refresh_token（无则不可导入）。 */
  hasToken: boolean;
}

/** 单个「分组周额度」（Gemini 组 / Claude+GPT 组）。 */
export interface AgyQuotaGroup {
  group: string;
  /** 已用百分比 0–100。 */
  utilization: number;
  /** 距周额度重置的剩余秒数。 */
  resetsInSeconds?: number;
  /** 组内模型名（展示用）。 */
  models?: string[];
}

/** 单个账号的额度查询结果（走 cockpit 链路，与推理解耦）。 */
export interface AgyQuotaInfo {
  email: string;
  accountId: string;
  ok: boolean;
  error?: string;
  groups: AgyQuotaGroup[];
  queriedAt: number;
}

/** 「当前活动账号」的额度（用量小窗/大窗常显）。只查 keyring 侧活动账号，
 *  1 次网络往返，区别于 AgyQuotaInfo[]（扫全账号、切号弹窗用）。 */
export interface AgyActiveQuota {
  /** 当前活动邮箱（google_accounts.json active）；无则 undefined。 */
  email?: string;
  ok: boolean;
  error?: string;
  groups: AgyQuotaGroup[];
  queriedAt: number;
}

export interface EngineConfigsSnapshot {
  kimi: KimiConfigSnapshot;
  codex: CodexConfigSnapshot;
  opencode: OpencodeConfigSnapshot;
  omp: OmpConfigSnapshot;
  antigravity: AntigravityConfigSnapshot;
  claude: ClaudeConfigSnapshot;
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

/** 赛马单角色默认（设置页配置，发起面板预填）：modelId/effort 空串 =
 *  跟随引擎默认模型 / 最大思考档。 */
export interface RaceRoleDefaultSetting {
  engine: EngineId;
  modelId: string;
  effort?: string;
}

/** 赛马默认配置：roles 键为角色 id（racerA/racerB/racerC/judge/builder/auditor）。 */
export interface RaceSettings {
  /** 默认启用第三选手（发起面板可临时开关；A/B 必选）。 */
  enableRacerC: boolean;
  roles: Record<string, RaceRoleDefaultSetting>;
}

export type AppLanguage = 'zh' | 'en';

export type ThemeMode = 'light' | 'dark' | 'system';
/** system 解析后的实际明暗值。 */
export type ResolvedMode = 'light' | 'dark';

/** 渲染进程推给主进程的已解析外观（原生标题栏/窗口底色联动）。皮肤已收敛为单一 notion 主题，只剩明暗一维。 */
export interface WindowAppearance {
  mode: ResolvedMode;
}

/** 满窗降切规则：「同能力不同上下文窗口」模型对（如 k3 256k → k3）。
 *  两侧均为词元串：按非字母数字分词、忽略大小写与分隔符后做包含匹配，
 *  兼容 "Kimi k3 256k" / "kimi-k3-256K" 等任意写法。 */
export interface ContextFallbackRule {
  /** 命中当前模型的词元串，如 "k3 256k"。 */
  match: string;
  /** 降切目标的词元串，如 "k3"（在可用模型列表里找命中者）。 */
  to: string;
}

/** 会话标题生成方式：program = 截取首条消息前 24 字；ai = 调用
 *  OpenAI 兼容接口生成短标题（失败自动回退截取式）。 */
export interface TitleGenSettings {
  mode: 'program' | 'ai';
  /** OpenAI 兼容 API base，如 https://api.openai.com/v1。 */
  baseUrl: string;
  /** 密钥随 settings 同步仅供设置页编辑；实际请求只在主进程发起。 */
  apiKey: string;
  /** 模型名，如 gpt-4o-mini。 */
  model: string;
}

export interface AppSettings {
  /** 明暗模式：浅色 / 深色 / 跟随系统。 */
  themeMode: ThemeMode;
  language: AppLanguage;
  defaultPermissionMode: PermissionMode;
  sendKey: 'enter' | 'ctrl-enter';
  /** 上下文占用达该百分比时，在回合边界自动压缩；0 = 关闭。默认 90。 */
  autoCompactRatio: number;
  /** 满窗降切规则表：达自动压缩阈值且当前模型命中 match 时，
   *  不压缩而是热切到命中 to 的可用模型继续任务。默认内置 k3 256k → k3。 */
  contextFallbackRules: ContextFallbackRule[];
  notifications: NotificationSettings;
  /** 会话标题生成设置。 */
  titleGen: TitleGenSettings;
  workspaces: WorkspaceInfo[];
  /** 赛马默认配置（各角色引擎/模型/思考档 + 第三选手开关）。 */
  race: RaceSettings;
  /** 协议路由开关（仅影响本程序内 spawn 的 CLI，不碰用户配置文件）。 */
  routing: EngineRoutingSettings;
  /** opencode 隐藏模型黑名单（slug = providerID/modelID）。默认全显示，
   *  只影响本程序内的选择器/赛马配置展示 — 不写 opencode 配置文件。 */
  opencodeHiddenModels: string[];
  /** omp 隐藏模型黑名单（slug = provider/modelID）。默认全显示，
   *  只影响本程序内的选择器/赛马配置展示 — 不写 ~/.omp。 */
  ompHiddenModels: string[];
  /** antigravity 新会话的默认模型 slug（空 = 用适配器内置默认 claude-sonnet-4-6）。
   *  仅作用于「未显式选模型」的新会话；已有会话与显式选择不受影响。 */
  antigravityDefaultModel?: string;
  /** antigravity 隐藏模型黑名单（slug）。默认全显示，只影响本程序内的
   *  模型选择器/赛马配置展示 — 不限制 agy 实际可用模型。 */
  antigravityHiddenModels: string[];
  /** 额度不足时自动切换 antigravity 账号（默认关）。开启后：回合结束
   *  后主动检测当前账号余量，低于阈值就换到有 buffer 的账号（普通会话
   *  静默换、赛马换后 raceResume）；真耗尽报错时作兜底。 */
  antigravityAutoSwitch: boolean;
  /** 自动切号 5 小时窗额度阈值（剩余百分比 0–100）。该窗剩余低于此值
   *  即视为不足；5 小时窗桶小消耗快、最多 5 小时自愈，阈值宜设较高提前预切。 */
  antigravityQuotaThreshold5h: number;
  /** 自动切号 7 天窗额度阈值（剩余百分比 0–100）。7 天窗桶大恢复慢，
   *  同样的剩余百分比可用时长远长于 5 小时窗，阈值宜设较低 —— 否则全池
   *  账号 7 天窗同时低于阈值时合格集合恒空，自动切彻底失效。
   *  挑目标账号时要求每个窗剩余都 ≥ 各自阈值（buffer 门槛防拖抽）。 */
  antigravityQuotaThreshold7d: number;
  /** 引擎选择列表的展示顺序（新建会话、侧栏快捷创建、切换引擎、
   *  赛马角色下拉统一生效）。缺失/非法项由读取端剔除并补全到末尾。 */
  engineOrder: EngineId[];
  /** Claude 额外 MCP 服务器配置文件路径（→ claude --mcp-config）。空 = 不传；
   *  无论如何 claude 自身的 ~/.claude MCP 仍自动加载，此项仅叠加额外服务器。 */
  claudeMcpConfig?: string;
  /** kimi 新会话优先走 KAP 通道（kimi web REST+WS，goal/steer/fork/真实
   *  usage 全原生）；失败自动降级 ACP。关闭 = 强制走稳定的 ACP 窄面。 */
  kimiPreferKap: boolean;
  /** Claude 自定义启动命令/路径（空 = 自动探测 npm/native/PATH）。
   *  可填完整路径（cli.js/.cmd/.exe）或 PATH 上的命令名（如 cc）；
   *  不支持 shell 别名（Set-Alias/alias 非可执行文件，spawn 无法解析）。 */
  claudeCliPath?: string;
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
