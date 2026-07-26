/**
 * IPC contract — single source of truth for channel names and payload
 * shapes between renderer and main. Keep this file dependency-free
 * (types only) so both sides can import it.
 */

import type {
  AppSettings,
  EngineEventEnvelope,
  EngineId,
  PermissionMode,
  SessionMeta,
} from './types';

export const IPC = {
  // renderer → main (invoke/handle)
  sessionCreate: 'session:create',
  sessionList: 'session:list',
  sessionPrompt: 'session:prompt',
  sessionCancel: 'session:cancel',
  sessionSetModel: 'session:set-model',
  sessionSetMode: 'session:set-mode',
  sessionAnswerPermission: 'session:answer-permission',
  sessionClose: 'session:close',
  sessionRename: 'session:rename',
  sessionDelete: 'session:delete',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  enginesStatus: 'engines:status',
  dialogPickFolder: 'dialog:pick-folder',
  // main → renderer (send/on)
  engineEvent: 'engine:event',
} as const;

export interface SessionCreateRequest {
  engine: EngineId;
  cwd: string; // '' → chat mode (scratch dir)
  modelId?: string;
  permissionMode?: PermissionMode;
  title?: string;
}

export interface SessionPromptRequest {
  sessionId: string;
  text: string;
  /** Absolute paths attached via drag/@ mention. */
  attachments?: string[];
}

export interface AnswerPermissionRequest {
  sessionId: string;
  requestId: string;
  /** undefined → cancelled/dismissed */
  optionId?: string;
}

/** Renderer-facing API exposed by the preload bridge. */
export interface CyberSlotsApi {
  sessionCreate(req: SessionCreateRequest): Promise<SessionMeta>;
  sessionList(): Promise<SessionMeta[]>;
  sessionPrompt(req: SessionPromptRequest): Promise<void>;
  sessionCancel(sessionId: string): Promise<void>;
  sessionSetModel(sessionId: string, modelId: string): Promise<void>;
  sessionSetMode(sessionId: string, mode: PermissionMode): Promise<void>;
  sessionAnswerPermission(req: AnswerPermissionRequest): Promise<void>;
  sessionClose(sessionId: string): Promise<void>;
  sessionRename(sessionId: string, title: string): Promise<void>;
  sessionDelete(sessionId: string): Promise<void>;
  settingsGet(): Promise<AppSettings>;
  settingsSet(patch: Partial<AppSettings>): Promise<AppSettings>;
  dialogPickFolder(): Promise<string | null>;
  onEngineEvent(listener: (e: EngineEventEnvelope) => void): () => void;
}
