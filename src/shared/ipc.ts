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
  openIn: 'sys:open-in',
  // main → renderer (send/on)
  engineEvent: 'engine:event',
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
  openIn(target: OpenTarget, path: string): Promise<void>;
  onEngineEvent(listener: (e: EngineEventEnvelope) => void): () => void;
  /** Absolute path of a dropped File (drag-and-drop attachments). */
  getPathForFile(file: File): string;
}
