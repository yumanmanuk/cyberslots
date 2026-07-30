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
  CompatAuditSnapshot,
  CronTask,
  EngineConfigsSnapshot,
  EngineEventEnvelope,
  EngineId,
  GoalControlAction,
  OpencodeCatalog,
  OmpCatalog,
  PermissionMode,
  ProviderQuotaInfo,
  SessionMeta,
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
  sessionSetMode: 'session:set-mode',
  sessionAnswerPermission: 'session:answer-permission',
  sessionClose: 'session:close',
  sessionRename: 'session:rename',
  sessionDelete: 'session:delete',
  sessionMessagesGet: 'session:messages-get',
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
  sessionMarkRead: 'session:mark-read',
  sessionSetArchived: 'session:set-archived',
  sessionAssignWorkspace: 'session:assign-workspace',
  workspaceAnnounce: 'workspace:announce',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
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
  fsImport: 'fs:import',
  fsIsDir: 'fs:is-dir',
  openIn: 'sys:open-in',
  attachmentSaveTemp: 'attachment:save-temp',
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
  raceRevise: 'race:revise',
  raceFinalize: 'race:finalize',
  raceResume: 'race:resume',
  raceUpdateRole: 'race:update-role',
  raceRetryRacer: 'race:retry-racer',
  raceEliminate: 'race:eliminate',
  raceRestartPlanning: 'race:restart-planning',
  raceCancel: 'race:cancel',
  // main → renderer (send/on)
  engineEvent: 'engine:event',
  terminalData: 'terminal:data',
  raceEvent: 'race:event',
  compatAudit: 'compat:audit',
} as const;

export interface SessionCreateRequest {
  engine: EngineId;
  cwd: string; // '' → chat mode (scratch dir)
  modelId?: string;
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

export type OpenTarget = 'vscode' | 'cursor' | 'antigravity' | 'explorer' | 'gitbash' | 'wt' | 'terminal';

/** 斜线命令候选项（skill / command），来源：引擎全局目录或会话项目目录。 */
export interface SlashItem {
  /** 触发名（不含斜线），如 imagegen / codereview。 */
  name: string;
  /** 一句话描述（SKILL.md frontmatter description，或 md 首个有效行）。 */
  description: string;
  kind: 'skill' | 'command';
  /** global = 引擎用户目录；project = 会话工作目录。 */
  scope: 'global' | 'project';
  /** 所属引擎生态；generic = 通用目录（.agents/skills，各引擎均可读）。 */
  engine: EngineId | 'generic';
  /** 来源文件绝对路径（tooltip / 排查用）。 */
  path: string;
}

export interface SlashListRequest {
  /** 会话工作目录（'' = 纯聊天模式，仅扫全局目录）。 */
  cwd: string;
  engine: EngineId;
}

/** 本会话被 AI 编辑的单个文件（含行级增删与变更类型），供「变更」面板接受/回退。 */
export interface SessionChangeEntry {
  path: string;
  name: string;
  adds: number;
  dels: number;
  status: 'modified' | 'added' | 'deleted';
  /** 当前有多少个会话在跟踪该文件（>1 = 多会话共编，回退会影响彼此）。 */
  sessions: number;
}

/** 单个变更文件的编辑前/后内容（null = 不存在），供 before/after diff 视图。 */
export interface SessionChangeDiff {
  path: string;
  before: string | null;
  after: string | null;
}

/** Renderer-facing API exposed by the preload bridge. */
export interface CyberSlotsApi {
  sessionCreate(req: SessionCreateRequest): Promise<SessionMeta>;
  sessionList(): Promise<SessionMeta[]>;
  sessionPrompt(req: SessionPromptRequest): Promise<void>;
  sessionCancel(sessionId: string): Promise<void>;
  /** 预热：选中会话时立即唤醒引擎进程（恢复态不再懒启动）。 */
  sessionWarmUp(sessionId: string): Promise<void>;
  sessionSetModel(sessionId: string, modelId: string): Promise<void>;
  sessionSetMode(sessionId: string, mode: PermissionMode): Promise<void>;
  sessionAnswerPermission(req: AnswerPermissionRequest): Promise<void>;
  sessionClose(sessionId: string): Promise<void>;
  sessionRename(sessionId: string, title: string): Promise<void>;
  sessionDelete(sessionId: string): Promise<void>;
  sessionMessagesGet(sessionId: string): Promise<UnifiedMessage[]>;
  sessionMessagesSave(sessionId: string, messages: UnifiedMessage[]): Promise<void>;
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
  /** 回退到某提问将撤销的文件清单；null = 该提问无快照（仅能移除消息）。 */
  sessionUndoPreview(sessionId: string, messageId: string): Promise<SessionChangeEntry[] | null>;
  /** 执行回退：还原文件 + 截断消息 + 重置引擎上下文；返回被移除的提问供回填。 */
  sessionUndo(sessionId: string, messageId: string): Promise<{ text: string; attachments?: string[] }>;
  /** Steer the in-flight turn; resolves false when not steerable. */
  sessionSteer(sessionId: string, text: string): Promise<boolean>;
  /** Engine-native goal (codex thread/goal). */
  sessionGoalSet(sessionId: string, objective: string): Promise<void>;
  sessionGoalControl(sessionId: string, action: GoalControlAction): Promise<void>;
  sessionMarkRead(sessionId: string): Promise<void>;
  /** 归档/还原：归档仅从侧栏隐藏，数据与引擎会话全保留（区别于删除）。 */
  sessionSetArchived(sessionId: string, archived: boolean): Promise<void>;
  /** 把某个 Project（按 cwd 分组）的会话挂到工作区下（Project → Workspace 升级）。 */
  sessionAssignWorkspace(cwd: string, workspaceId: string): Promise<void>;
  /** 工作区目录集变化后，向其会话注入一次性目录公告前缀。 */
  workspaceAnnounce(workspaceId: string): Promise<void>;
  settingsGet(): Promise<AppSettings>;
  settingsSet(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** AI 生成会话标题（主进程调用设置里的 OpenAI 兼容接口）；
   *  未配置/失败返回 null，渲染层回退截取式标题。 */
  titleGenerate(text: string): Promise<string | null>;
  /** 用量统计：主进程扫描各会话 turn_end 统计行按时间桶聚合。 */
  usageStats(query: UsageStatsQuery): Promise<UsageStatsResult>;
  /** 供应商余量/余额（kimi/minimax token plan、deepseek 余额）；只返回
   *  本地配置里探到 key 的供应商，主进程代查带缓存（force = 跳过缓存）。 */
  providerQuota(force?: boolean): Promise<ProviderQuotaInfo[]>;
  /** CLI 配置只读快照（~/.kimi-code、~/.codex）+ 路由可用性。 */
  engineConfigsGet(): Promise<EngineConfigsSnapshot>;
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
  /** Antigravity 分组周额度（扫导入池内全部账号，带缓存；force 跳缓存）。 */
  agyQuota(force?: boolean): Promise<AgyQuotaInfo[]>;
  /** 当前活动 Antigravity 账号的额度（只 1 次往返，用量小窗/大窗常显；force 跳缓存）。 */
  agyActiveQuota(force?: boolean): Promise<AgyActiveQuota>;
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
  /** 将拖入的外部文件/文件夹拷贝进工作区根目录；返回成功个数。 */
  fsImport(root: string, srcPaths: string[]): Promise<number>;
  /** 路径是否目录（拖放到输入框时区分文件夹/文件引用）。 */
  fsIsDir(path: string): Promise<boolean>;
  openIn(target: OpenTarget, path: string): Promise<void>;
  /** 粘贴/拖拽的二进制写临时文件，返回绝对路径（图片附件）。 */
  attachmentSaveTemp(bytes: Uint8Array, ext: string): Promise<string>;
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
  onEngineEvent(listener: (e: EngineEventEnvelope) => void): () => void;
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
  /** 裁判融合方案的批注修订循环。 */
  raceRevise(raceId: string, annotation: string): Promise<void>;
  /** 定稿裁判方案 → 交给 Builder 执行。 */
  raceFinalize(raceId: string): Promise<void>;
  /** 重启后继续被打断的赛马（重跑当前阶段）。 */
  raceResume(raceId: string): Promise<void>;
  /** 重试前调整选手配置（仅 racerA/racerB；引擎/模型变更后重跑时重建会话）。 */
  raceUpdateRole(raceId: string, role: RaceRole, cfg: RaceRoleConfig): Promise<void>;
  /** 单选手重试：只补跑该选手当前阶段回合（另一侧不受影响）。 */
  raceRetryRacer(raceId: string, role: RaceRole): Promise<void>;
  /** ✂ 剔除选手（三人以上在场且裁判选策略前；剩余 ≥2；不可逆）。 */
  raceEliminate(raceId: string, role: RaceRole): Promise<void>;
  /** 裁判选策略前回退：清空产物重跑双规划。 */
  raceRestartPlanning(raceId: string): Promise<void>;
  raceCancel(raceId: string): Promise<void>;
  /** 订阅赛马阶段/角色/融合方案/审计等编排事件（main → renderer）。 */
  onRaceEvent(listener: (e: RaceEventEnvelope) => void): () => void;
  /** Absolute path of a dropped File (drag-and-drop attachments). */
  getPathForFile(file: File): string;
}
