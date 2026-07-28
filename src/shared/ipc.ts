/**
 * IPC contract — single source of truth for channel names and payload
 * shapes between renderer and main. Keep this file dependency-free
 * (types only) so both sides can import it.
 */

import type {
  AppSettings,
  CronTask,
  EngineConfigsSnapshot,
  EngineEventEnvelope,
  EngineId,
  GoalControlAction,
  OpencodeCatalog,
  PermissionMode,
  SessionMeta,
  UnifiedMessage,
  WindowAppearance,
} from './types';
import type { RaceAdoptStrategy, RaceCreateRequest, RaceEventEnvelope, RaceGroup } from './race';

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
  sessionSteer: 'session:steer',
  sessionGoalSet: 'session:goal-set',
  sessionGoalControl: 'session:goal-control',
  sessionMarkRead: 'session:mark-read',
  sessionSetArchived: 'session:set-archived',
  sessionAssignWorkspace: 'session:assign-workspace',
  workspaceAnnounce: 'workspace:announce',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  engineConfigsGet: 'engine-configs:get',
  opencodeCatalogGet: 'opencode:catalog-get',
  themeSync: 'window:theme-sync',
  cronList: 'cron:list',
  cronSave: 'cron:save',
  cronDelete: 'cron:delete',
  cronRunNow: 'cron:run-now',
  enginesStatus: 'engines:status',
  dialogPickFolder: 'dialog:pick-folder',
  fsTree: 'fs:tree',
  fsRead: 'fs:read',
  fsWrite: 'fs:write',
  fsGitStatus: 'fs:git-status',
  fsImport: 'fs:import',
  openIn: 'sys:open-in',
  attachmentSaveTemp: 'attachment:save-temp',
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
  raceRevise: 'race:revise',
  raceFinalize: 'race:finalize',
  raceCancel: 'race:cancel',
  // main → renderer (send/on)
  engineEvent: 'engine:event',
  terminalData: 'terminal:data',
  raceEvent: 'race:event',
} as const;

export interface SessionCreateRequest {
  engine: EngineId;
  cwd: string; // '' → chat mode (scratch dir)
  modelId?: string;
  permissionMode?: PermissionMode;
  title?: string;
  /** Bind the session to a named multi-folder workspace. */
  workspaceId?: string;
}

export interface SessionPromptRequest {
  sessionId: string;
  text: string;
  /** Absolute paths attached via drag/@ mention. */
  attachments?: string[];
  /** Reasoning effort override (codex turn/start). */
  effort?: string;
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
  /** CLI 配置只读快照（~/.kimi-code、~/.codex）+ 路由可用性。 */
  engineConfigsGet(): Promise<EngineConfigsSnapshot>;
  /** opencode 模型目录（主进程代理 /config/providers，按需启动 server）。 */
  opencodeCatalogGet(force?: boolean): Promise<OpencodeCatalog>;
  /** Push the resolved appearance to main so the native title bar matches. */
  themeSync(appearance: WindowAppearance): Promise<void>;
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
  openIn(target: OpenTarget, path: string): Promise<void>;
  /** 粘贴/拖拽的二进制写临时文件，返回绝对路径（图片附件）。 */
  attachmentSaveTemp(bytes: Uint8Array, ext: string): Promise<string>;
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
  // --- 大模型赛马 ---
  /** 发起一场赛马（config → 立即开跑 planning）。 */
  raceCreate(req: RaceCreateRequest): Promise<RaceGroup>;
  raceList(): Promise<RaceGroup[]>;
  raceGet(raceId: string): Promise<RaceGroup | null>;
  /** 裁判阶段第一步：用户选定采纳策略（4选1 + 可选评语）→ 裁判出最终方案。 */
  raceAdopt(raceId: string, strategy: RaceAdoptStrategy, comment?: string): Promise<void>;
  /** 裁判融合方案的批注修订循环。 */
  raceRevise(raceId: string, annotation: string): Promise<void>;
  /** 定稿裁判方案 → 交给 Builder 执行。 */
  raceFinalize(raceId: string): Promise<void>;
  raceCancel(raceId: string): Promise<void>;
  /** 订阅赛马阶段/角色/融合方案/审计等编排事件（main → renderer）。 */
  onRaceEvent(listener: (e: RaceEventEnvelope) => void): () => void;
  /** Absolute path of a dropped File (drag-and-drop attachments). */
  getPathForFile(file: File): string;
}
