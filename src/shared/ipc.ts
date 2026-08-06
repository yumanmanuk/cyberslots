/**
 * IPC contract — single source of truth for channel names and payload
 * shapes between renderer and main. Keep this file dependency-free
 * (types only) so both sides can import it.
 */

import type {
  AgyAccountsSnapshot,
  AgyActiveQuota,
  AgyImportCandidate,
  AgyQuotaInfo,
  AntigravityCatalog,
  AppSettings,
  BrowserPanelState,
  CompatAuditSnapshot,
  CronTask,
  EngineConfigsSnapshot,
  EngineEventEnvelope,
  EngineId,
  GoalControlAction,
  OpencodeCatalog,
  OmpCatalog,
  OmpQuota,
  PermissionMode,
  ProviderQuotaInfo,
  SessionMeta,
  SlashCommandInfo,
  UnifiedMessage,
  UsageStatsQuery,
  UsageStatsResult,
  WindowAppearance,
} from './types';
import type { RaceAdoptStrategy, RaceCreateRequest, RaceEventEnvelope, RaceGroup, RaceRole, RaceRoleConfig } from './race';

export const IPC = {
  // renderer → main (invoke/handle)
  sessionCreate: 'session:create',
  sessionList: 'session:list',
  sessionPrompt: 'session:prompt',
  sessionCancel: 'session:cancel',
  sessionWarmUp: 'session:warm-up',
  sessionSetModel: 'session:set-model',
  sessionSetEffort: 'session:set-effort',
  sessionSetMode: 'session:set-mode',
  sessionAnswerPermission: 'session:answer-permission',
  sessionClose: 'session:close',
  sessionRename: 'session:rename',
  sessionDelete: 'session:delete',
  sessionMessagesGet: 'session:messages-get',
  sessionSearch: 'session:search',
  sessionMessagesSave: 'session:messages-save',
  sessionFork: 'session:fork',
  sessionForkEngine: 'session:fork-engine',
  sessionCompact: 'session:compact',
  sessionChangesList: 'session:changes-list',
  sessionChangesDiff: 'session:changes-diff',
  sessionChangesRevert: 'session:changes-revert',
  sessionChangesAccept: 'session:changes-accept',
  sessionUndoPreview: 'session:undo-preview',
  sessionUndo: 'session:undo',
  sessionSteer: 'session:steer',
  sessionGoalSet: 'session:goal-set',
  sessionGoalControl: 'session:goal-control',
  sessionSetSwarm: 'session:set-swarm',
  sessionMarkRead: 'session:mark-read',
  sessionSetArchived: 'session:set-archived',
  sessionAssignWorkspace: 'session:assign-workspace',
  workspaceAnnounce: 'workspace:announce',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  dataDirGet: 'data-dir:get',
  dataDirSet: 'data-dir:set',
  titleGenerate: 'title:generate',
  usageStats: 'usage:stats',
  providerQuota: 'usage:provider-quota',
  engineConfigsGet: 'engine-configs:get',
  opencodeCatalogGet: 'opencode:catalog-get',
  ompCatalogGet: 'omp:catalog-get',
  antigravityCatalogGet: 'antigravity:catalog-get',
  agyAccountsList: 'agy:accounts-list',
  agyImportCandidates: 'agy:import-candidates',
  agyAccountsImport: 'agy:accounts-import',
  agyAccountsImportFile: 'agy:accounts-import-file',
  agyAccountRemove: 'agy:account-remove',
  agyAccountSwitch: 'agy:account-switch',
  agyQuota: 'agy:quota',
  agyActiveQuota: 'agy:active-quota',
  ompQuota: 'omp:quota',
  themeSync: 'window:theme-sync',
  badgeSet: 'window:badge-set',
  cronList: 'cron:list',
  cronSave: 'cron:save',
  cronDelete: 'cron:delete',
  cronRunNow: 'cron:run-now',
  enginesStatus: 'engines:status',
  compatAuditGet: 'compat:audit-get',
  dialogPickFolder: 'dialog:pick-folder',
  fsTree: 'fs:tree',
  fsRead: 'fs:read',
  fsWrite: 'fs:write',
  fsGitStatus: 'fs:git-status',
  gitBaseContent: 'fs:git-base-content',
  fsImport: 'fs:import',
  fsIsDir: 'fs:is-dir',
  fsResolve: 'fs:resolve',
  openIn: 'sys:open-in',
  openersDetect: 'sys:openers-detect',
  attachmentSaveTemp: 'attachment:save-temp',
  attachmentDataUrl: 'attachment:data-url',
  slashList: 'slash:list',
  // 面板内嵌终端
  terminalCreate: 'terminal:create',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalDispose: 'terminal:dispose',
  // 大模型赛马
  raceCreate: 'race:create',
  raceList: 'race:list',
  raceGet: 'race:get',
  raceAdopt: 'race:adopt',
  raceRevokeAdopt: 'race:revoke-adopt',
  raceRerunJudge: 'race:rerun-judge',
  raceRevise: 'race:revise',
  raceFinalize: 'race:finalize',
  raceResume: 'race:resume',
  raceOverrideAudit: 'race:override-audit',
  raceUpdateRole: 'race:update-role',
  raceRetryRacer: 'race:retry-racer',
  raceRetryRacerIfMissing: 'race:retry-racer-if-missing',
  raceEliminate: 'race:eliminate',
  raceRestartPlanning: 'race:restart-planning',
  raceCancel: 'race:cancel',
  raceAcceptPreJudge: 'race:accept-pre-judge',
  raceDismissPreJudge: 'race:dismiss-pre-judge',
  // 受管浏览器（browser use 工具服务层；settings.browserUse 开关控制）
  browserGetState: 'browser:get-state',
  browserEnsure: 'browser:ensure',
  browserStop: 'browser:stop',
  // main → renderer (send/on)
  engineEvent: 'engine:event',
  sessionActivate: 'session:activate',
  terminalData: 'terminal:data',
  raceEvent: 'race:event',
  compatAudit: 'compat:audit',
  browserEvent: 'browser:event',
  // 日志：renderer → main 批量落盘（send，无应答）；打开日志目录。
  logWrite: 'log:write',
  logsDir: 'log:dir',
  logsOpenDir: 'log:open-dir',
} as const;

export interface SessionCreateRequest {
  engine: EngineId;
  cwd: string; // '' → chat mode (scratch dir)
  modelId?: string;
  /** 新会话默认思考深度（本程序每引擎默认，随 meta 一起落盘）。 */
  effort?: string;
  permissionMode?: PermissionMode;
  title?: string;
  /** Bind the session to a named multi-folder workspace. */
  workspaceId?: string;
  /** 赛马角色会话：所属 RaceGroup id（侧栏隐藏标记）。 */
  raceId?: string;
}

export interface SessionPromptRequest {
  sessionId: string;
  text: string;
  /** Absolute paths attached via drag/@ mention. */
  attachments?: string[];
  /** Reasoning effort override (codex turn/start). */
  effort?: string;
  /** 对应的用户消息 id — 发送前拍逐提问快照（回退还原点）。 */
  userMessageId?: string;
}

/** 渲染进程经 IPC 转发给主进程落盘的单条日志（与主进程 JSONL 行同构）。 */
/** 数据目录设置结果（IPC 返回）。 */
export interface DataDirResult {
  /** 本次启动实际生效的数据目录（重启前不会变）。 */
  current: string;
  /** 已写入指针、待下次启动生效的目录（'' = 恢复默认）。 */
  pending: string;
  /** pending 与 current 相同（目标即当前目录）。 */
  applied: boolean;
}

export interface RendererLogPayload {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
  err?: { name?: string; message: string; stack?: string };
}

export interface AnswerPermissionRequest {
  sessionId: string;
  requestId: string;
  /** undefined → cancelled/dismissed */
  optionId?: string;
}

export interface FsNode {
  name: string;
  path: string;
  dir: boolean;
  /** git status short code for files: M/A/D/?/'' */
  git?: string;
}

export interface FileContent {
  path: string;
  text: string;
  /** true when file exceeds the preview cap and was truncated. */
  truncated: boolean;
  /** lowercased extension without dot, for highlight/preview routing. */
  ext: string;
}

/** 单文件 git 基准（编辑器行级变更标记用）：
 *  base = HEAD 版本内容（未跟踪/新增/二进制/非 git 时为 null），
 *  status = 文件级短码（M/A/D/U/R，非 git 仓库为空串）。 */
export interface GitBaseContent {
  base: string | null;
  status: string;
}

export type OpenTarget = 'vscode' | 'cursor' | 'antigravity' | 'explorer' | 'gitbash' | 'wt' | 'terminal';

/** 需本机安装才可用的「外部打开」目标（explorer/wt/terminal 系统自带，不检测）。 */
export type OpenerId = 'vscode' | 'cursor' | 'antigravity' | 'gitbash';

/** 各外部打开程序的本机可用性（可执行文件存在或命令在 PATH）。 */
export type OpenerAvailability = Record<OpenerId, boolean>;

/** 斜线命令候选项（skill / command），来源：引擎全局目录或会话项目目录。 */
export interface SlashItem {
  /** 触发名（不含斜线），如 imagegen / codereview。 */
  name: string;
  /** 一句话描述（SKILL.md frontmatter description，或 md 首个有效行）。 */
  description: string;
  /** builtin = 引擎运行时推送、且未能回贴到本地源文件的命令（无源文件，
   *  展示为「引擎」）。已回贴到本地 skill/command 文件的推送项会标 skill/command。 */
  kind: 'skill' | 'command' | 'builtin';
  /** global = 引擎用户目录；project = 会话工作目录。 */
  scope: 'global' | 'project';
  /** 所属引擎生态；generic = 通用目录（.agents/skills，各引擎均可读）。 */
  engine: EngineId | 'generic';
  /** 来源文件绝对路径（tooltip / 排查用）。 */
  path: string;
  /** SKILL.md 无 frontmatter name、以目录/文件名兜底命名 —— opencode 引擎
   *  不注册此类技能（isSkillFrontmatter 要求 name），该会话隐藏此项。 */
  unnamed?: boolean;
}

export interface SlashListRequest {
  /** 会话工作目录（'' = 纯聊天模式，仅扫全局目录）。 */
  cwd: string;
  engine: EngineId;
  /** 引擎运行时推送的命令（commands.update）—主进程用全生态扫描索引
   *  给它们回贴来源（全局/项目 + skill/command 类别），未命中保留 builtin。 */
  pushedCommands?: SlashCommandInfo[];
}

/** 本会话被 AI 编辑的单个文件（含行级增删与变更类型），供「变更」面板接受/回退。 */
export interface SessionChangeEntry {
  path: string;
  name: string;
  adds: number;
  dels: number;
  /** accepted = 已接受（保留改动）/不再参与回退 */
  status: 'modified' | 'added' | 'deleted' | 'accepted';
  /** 当前有多少个会话在跟踪该文件（>1 = 多会话共编，回退会影响彼此）。 */
  sessions: number;
}

/** 单个变更文件的编辑前/后内容（null = 不存在），供 before/after diff 视图。 */
export interface SessionChangeDiff {
  path: string;
  before: string | null;
  after: string | null;
}

/** 「回退到某提问」预览：files = 将撤销的本会话变更（diff ∩ 本会话台账）；
 *  unattributed = 快照后存在但不归属于本对话的变更数（仅提示，不会被回退）。 */
export interface UndoPreview {
  files: SessionChangeEntry[];
  unattributed: number;
}

/** 停止请求的返回：软失败不抛错，通过字段回传，避免 UI 只看到「请求成功」却无提示。 */
export interface CancelSessionResult {
  /** 有活跃 goal 且暂停失败/超时——中断后引擎可能自动续跑，UI 应明确提示。 */
  goalPauseFailed?: boolean;
}

/** 全局搜索请求（跨会话搜索标题 + 消息内容）。 */
export interface SessionSearchRequest {
  query: string;
  /** 最多返回几条结果（默认 50）。 */
  limit?: number;
}

/** 单条搜索命中（标题匹配 or 消息内容匹配）。 */
export interface SearchHit {
  sessionId: string;
  /** 命中的消息 id（标题匹配时为空）。 */
  messageId?: string;
  /** 命中类型：title = 标题匹配, content = 消息内容匹配。 */
  kind: 'title' | 'content';
  /** 匹配上下文摘要（标题匹配时 = 标题全文；内容匹配时 = 关键词前后 ~60 字）。 */
  snippet: string;
}

/** Renderer-facing API exposed by the preload bridge. */
export interface CyberSlotsApi {
  sessionCreate(req: SessionCreateRequest): Promise<SessionMeta>;
  sessionList(): Promise<SessionMeta[]>;
  sessionPrompt(req: SessionPromptRequest): Promise<void>;
  sessionCancel(sessionId: string): Promise<CancelSessionResult>;
  /** 预热：选中会话时立即唤醒引擎进程（恢复态不再懒启动）。 */
  sessionWarmUp(sessionId: string): Promise<void>;
  sessionSetModel(sessionId: string, modelId: string): Promise<void>;
  /** 持久化会话级思考深度；null = 清除（回落到引擎默认解析链）。 */
  sessionSetEffort(sessionId: string, effort: string | null): Promise<void>;
  sessionSetMode(sessionId: string, mode: PermissionMode): Promise<PermissionMode>;
  sessionAnswerPermission(req: AnswerPermissionRequest): Promise<void>;
  sessionClose(sessionId: string): Promise<void>;
  sessionRename(sessionId: string, title: string): Promise<void>;
  sessionDelete(sessionId: string): Promise<void>;
  sessionMessagesGet(sessionId: string): Promise<UnifiedMessage[]>;
  sessionMessagesSave(sessionId: string, messages: UnifiedMessage[]): Promise<void>;
  /** 全局搜索：跨会话搜索标题和消息内容。 */
  sessionSearch(req: SessionSearchRequest): Promise<SearchHit[]>;
  sessionFork(sessionId: string): Promise<SessionMeta>;
  sessionForkEngine(sessionId: string, engine: EngineId): Promise<SessionMeta>;
  sessionCompact(sessionId: string): Promise<void>;
  /** 本会话 AI 编辑过的文件清单（含 +/- 行数与变更类型）。 */
  sessionChangesList(sessionId: string): Promise<SessionChangeEntry[]>;
  /** 单文件编辑前/后内容（diff 视图）。 */
  sessionChangesDiff(sessionId: string, path: string): Promise<SessionChangeDiff>;
  /** 回退：写回编辑前基线（新建文件则删除）；path 省略 = 全部回退。 */
  sessionChangesRevert(sessionId: string, path?: string): Promise<void>;
  /** 接受：保留改动并停止跟踪（不动磁盘）；path 省略 = 全部接受。 */
  sessionChangesAccept(sessionId: string, path?: string): Promise<void>;
  /** 回退到某提问将撤销的本会话文件清单 + 未归属变更计数；null = 该提问无快照（仅能移除消息）。 */
  sessionUndoPreview(sessionId: string, messageId: string): Promise<UndoPreview | null>;
  /** 执行回退：还原文件 + 截断消息 + 重置引擎上下文；返回被移除的提问供回填。 */
  sessionUndo(sessionId: string, messageId: string): Promise<{ text: string; attachments?: string[] }>;
  /** Steer the in-flight turn; resolves false when not steerable. */
  sessionSteer(sessionId: string, text: string, attachments?: string[], messageId?: string): Promise<boolean>;
  /** Engine-native goal (codex thread/goal). */
  sessionGoalSet(sessionId: string, objective: string): Promise<void>;
  sessionGoalControl(sessionId: string, action: GoalControlAction): Promise<void>;
  /** 原生 swarm 模式开关（kimi KAP agent_config.swarm_mode）。 */
  sessionSetSwarm(sessionId: string, active: boolean): Promise<void>;
  sessionMarkRead(sessionId: string): Promise<void>;
  /** 归档/还原：归档仅从侧栏隐藏，数据与引擎会话全保留（区别于删除）。 */
  sessionSetArchived(sessionId: string, archived: boolean): Promise<void>;
  /** 把某个 Project（按 cwd 分组）的会话挂到工作区下（Project → Workspace 升级）。 */
  sessionAssignWorkspace(cwd: string, workspaceId: string): Promise<void>;
  /** 工作区目录集变化后，向其会话注入一次性目录公告前缀。 */
  workspaceAnnounce(workspaceId: string): Promise<void>;
  settingsGet(): Promise<AppSettings>;
  settingsSet(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** 当前生效的数据目录（app.getPath('userData')）。 */
  dataDirGet(): Promise<string>;
  /** 设置数据目录指针（'' = 恢复默认）；目录不存在时下次启动自动创建。 */
  dataDirSet(path: string): Promise<DataDirResult>;
  /** AI 生成会话标题（主进程调用设置里的 OpenAI 兼容接口）；
   *  未配置/失败返回 null，渲染层回退截取式标题。 */
  titleGenerate(text: string): Promise<string | null>;
  /** 用量统计：主进程扫描各会话 turn_end 统计行按时间桶聚合。 */
  usageStats(query: UsageStatsQuery): Promise<UsageStatsResult>;
  /** 供应商余量/余额（kimi/minimax token plan、deepseek 余额）；只返回
   *  本地配置里探到 key 的供应商，主进程代查带缓存（force = 跳过缓存）。 */
  providerQuota(force?: boolean): Promise<ProviderQuotaInfo[]>;
  /** CLI 配置只读快照（~/.kimi-code、~/.codex）+ 路由可用性。
   *  force = 跳过主进程短 TTL 缓存；选择器展开等非显式场景不传。 */
  engineConfigsGet(force?: boolean): Promise<EngineConfigsSnapshot>;
  /** opencode 模型目录（主进程代理 /config/providers，按需启动 server）。 */
  opencodeCatalogGet(force?: boolean): Promise<OpencodeCatalog>;
  /** omp 模型目录（主进程代理 `omp models --json`，带缓存）。 */
  ompCatalogGet(force?: boolean): Promise<OmpCatalog>;
  /** antigravity 模型目录（主进程代理 `agy models`，带缓存）。 */
  antigravityCatalogGet(force?: boolean): Promise<AntigravityCatalog>;
  /** Antigravity 导入池快照（仅已导入账号 + 当前活动邮箱）。只读。 */
  agyAccountsList(): Promise<AgyAccountsSnapshot>;
  /** 扫描 cockpit 账号库生成导入候选（只读，仅供导入弹层展示）。 */
  agyImportCandidates(): Promise<{ candidates: AgyImportCandidate[]; error?: string }>;
  /** 把选中的 cockpit 账号凭据拷入导入池（按 id 覆盖更新）；返回新快照。 */
  agyAccountsImport(ids: string[]): Promise<AgyAccountsSnapshot>;
  /** 从导出文件（[{email, refresh_token}] 数组或 {accounts:[…]}）导入 —
   *  主进程弹文件选择框并解析；取消选择返回 null。 */
  agyAccountsImportFile(): Promise<AgyAccountsSnapshot | null>;
  /** 从导入池移除账号（只删本程序副本，不碰 cockpit / keyring）。 */
  agyAccountRemove(id: string): Promise<AgyAccountsSnapshot>;
  /** 切换 Antigravity 账号（限导入池内；覆写 keyring + 更新 active）；返回新活动邮箱。
   *  agy 下一次调用即以新账号执行（实时读 keyring）。 */
  agyAccountSwitch(accountId: string): Promise<{ email: string }>;
  /** Antigravity 分组周额度（扫导入池内全部账号，带缓存；force 跳缓存）。
   *  cachedOnly = 只读 60s TTL 缓存、零网络（起跑预检用）：缓存 miss/不新鲜
   *  返回空数组。 */
  agyQuota(force?: boolean, cachedOnly?: boolean): Promise<AgyQuotaInfo[]>;
  /** 当前活动 Antigravity 账号的额度（只 1 次往返，用量小窗/大窗常显；force 跳缓存）。 */
  agyActiveQuota(force?: boolean): Promise<AgyActiveQuota>;
  /** omp 当前 session 账号的 Claude 系列余量（_omp/usage ext method；force 跳缓存）。 */
  ompQuota(force?: boolean): Promise<OmpQuota>;
  /** Push the resolved appearance to main so the native title bar matches. */
  themeSync(appearance: WindowAppearance): Promise<void>;
  /** 任务栏角标（Windows overlay icon）：dataUrl = renderer 画好的角标图；
   *  null = 清除。「等你处理」数量变化时由 App 侧推送。 */
  badgeSet(dataUrl: string | null, description: string): Promise<void>;
  cronList(): Promise<CronTask[]>;
  cronSave(task: CronTask): Promise<CronTask[]>;
  cronDelete(id: string): Promise<CronTask[]>;
  cronRunNow(id: string): Promise<void>;
  dialogPickFolder(): Promise<string | null>;
  fsTree(root: string, sub?: string): Promise<FsNode[]>;
  fsRead(path: string): Promise<FileContent>;
  fsWrite(path: string, text: string, root: string): Promise<void>;
  fsGitStatus(root: string): Promise<Record<string, string>>;
  /** 取文件相对 HEAD 的基准内容 + 变更状态（编辑器行级标记用）。 */
  gitBaseContent(root: string, path: string): Promise<GitBaseContent>;
  /** 将拖入的外部文件/文件夹拷贝进工作区根目录；返回成功个数。 */
  fsImport(root: string, srcPaths: string[]): Promise<number>;
  /** 路径是否目录（拖放到输入框时区分文件夹/文件引用）。 */
  fsIsDir(path: string): Promise<boolean>;
  /** AI 提及的路径 → 工作区内真实存在的文件绝对路径（cwd 直拼失败时全树模糊定位）；找不到返回 null。 */
  fsResolve(root: string, rawPath: string): Promise<string | null>;
  openIn(target: OpenTarget, path: string): Promise<void>;
  /** 探测「外部打开」目标程序的本机可用性（VS Code / Cursor / Antigravity / Git Bash）；进程级缓存。 */
  openersDetect(force?: boolean): Promise<OpenerAvailability>;
  /** 粘贴/拖拽的二进制写临时文件，返回绝对路径（图片附件）。 */
  attachmentSaveTemp(bytes: Uint8Array, ext: string): Promise<string>;
  /** 读图片附件为 data URL（缩略图展示）；非图片/读取失败返回 null。 */
  attachmentDataUrl(path: string): Promise<string | null>;
  /** 斜线命令候选：扫描引擎全局 + 项目级 skills/commands（输入 / 唤起补全菜单）。 */
  slashList(req: SlashListRequest): Promise<SlashItem[]>;
  /** 面板内嵌终端：确保会话 shell 存在（cwd = 会话目录）。 */
  terminalCreate(id: string, cwd: string): Promise<void>;
  /** renderer 键入 → shell stdin。 */
  terminalInput(id: string, data: string): Promise<void>;
  /** 终端尺寸变化（xterm fit → PTY resize）。 */
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  /** 关闭会话 shell（会话删除时）。 */
  terminalDispose(id: string): Promise<void>;
  /** 订阅 shell 输出流（main → renderer）。 */
  onTerminalData(listener: (payload: { id: string; data: string }) => void): () => void;
  // --- 受管浏览器（browser use；settings.browserUse 开启后可用） ---
  /** 查询受管浏览器面板状态（status/页面/截图/动作历史）。 */
  browserGetState(): Promise<BrowserPanelState>;
  /** 懒启动受管 Chrome（独立 user-data-dir；幂等），返回最新状态。 */
  browserEnsure(): Promise<BrowserPanelState>;
  /** 停止受管 Chrome 并释放调试端口。 */
  browserStop(): Promise<void>;
  /** 订阅受管浏览器状态全量推送（main → renderer）。 */
  onBrowserEvent(listener: (state: BrowserPanelState) => void): () => void;
  /** 引擎事件订阅：主进程 16ms 合批后一次可能送来单条或数组。 */
  onEngineEvent(listener: (e: EngineEventEnvelope | EngineEventEnvelope[]) => void): () => void;
  /** 系统通知点击 → 主进程要求定位到某会话（sessionId）。 */
  onSessionActivate(listener: (sessionId: string) => void): () => void;
  /** 引擎兼容性审计快照（未知事件/被拒方法/解析失败的聚合计数）。 */
  compatAuditGet(): Promise<CompatAuditSnapshot>;
  /** 订阅审计快照变更（新指纹出现/计数增长时节流推送）。 */
  onCompatAudit(listener: (snap: CompatAuditSnapshot) => void): () => void;
  // --- 大模型赛马 ---
  /** 发起一场赛马（config → 立即开跑 planning）。 */
  raceCreate(req: RaceCreateRequest): Promise<RaceGroup>;
  raceList(): Promise<RaceGroup[]>;
  raceGet(raceId: string): Promise<RaceGroup | null>;
  /** 裁判阶段第一步：用户选定采纳策略（4选1 + 可选评语）→ 裁判出最终方案。 */
  raceAdopt(raceId: string, strategy: RaceAdoptStrategy, comment?: string): Promise<void>;
  /** ④a 反悔：撤回采纳决策（仅裁判尚未出方案时），回到选策略关口。 */
  raceRevokeAdopt(raceId: string): Promise<void>;
  /** 让裁判按既定策略重新出方案（换裁判引擎后手动重跑，v+1 覆盖）。 */
  raceRerunJudge(raceId: string): Promise<void>;
  /** 裁判融合方案的批注修订循环。 */
  raceRevise(raceId: string, annotation: string): Promise<void>;
  /** 定稿裁判方案 → 交给 Builder 执行。 */
  raceFinalize(raceId: string): Promise<void>;
  /** 重启后继续被打断的赛马（重跑当前阶段）。 */
  raceResume(raceId: string): Promise<void>;
  /** 审计未通过时由用户人工放行：接受当前实现并交付，停止审计-修复循环。 */
  raceOverrideAudit(raceId: string): Promise<void>;
  /** 重试前调整选手配置（仅 racerA/racerB；引擎/模型变更后重跑时重建会话）。 */
  raceUpdateRole(raceId: string, role: RaceRole, cfg: RaceRoleConfig): Promise<void>;
  /** 单选手重试：只补跑该选手当前阶段回合（另一侧不受影响）。 */
  raceRetryRacer(raceId: string, role: RaceRole): Promise<void>;
  /** 额度耗尽切号后的精确补跑：仅当该选手当前阶段产物缺失时才重跑。 */
  raceRetryRacerIfMissing(raceId: string, role: RaceRole): Promise<void>;
  /** ✂ 剔除选手（三人以上在场且裁判选策略前；剩余 ≥2；不可逆）。 */
  raceEliminate(raceId: string, role: RaceRole): Promise<void>;
  /** 裁判选策略前回退：清空产物重跑双规划。 */
  raceRestartPlanning(raceId: string): Promise<void>;
  raceCancel(raceId: string): Promise<void>;
  /** 采纳 AI 初审的推荐策略（等同于用推荐策略调 raceAdopt）。 */
  raceAcceptPreJudge(raceId: string): Promise<void>;
  /** 忽略 AI 初审推荐，回到纯人工 4 选 1。 */
  raceDismissPreJudge(raceId: string): Promise<void>;
  /** 订阅赛马阶段/角色/融合方案/审计等编排事件（main → renderer）。 */
  onRaceEvent(listener: (e: RaceEventEnvelope) => void): () => void;
  /** 渲染进程日志批量上报（fire-and-forget；主进程落 renderer-*.jsonl）。 */
  logWrite(entries: RendererLogPayload[]): void;
  /** 日志目录绝对路径（设置页展示）。 */
  logsDir(): Promise<string>;
  /** 在系统文件管理器中打开日志目录。 */
  logsOpenDir(): Promise<void>;
  /** Absolute path of a dropped File (drag-and-drop attachments). */
  getPathForFile(file: File): string;
}
