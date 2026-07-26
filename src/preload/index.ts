/**
 * Preload bridge — exposes the typed CyberSlotsApi to the renderer via
 * contextBridge. Only IPC passthrough; zero logic.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { CyberSlotsApi } from '@shared/ipc';
import { IPC } from '@shared/ipc';
import type { EngineEventEnvelope } from '@shared/types';

const api: CyberSlotsApi = {
  sessionCreate: (req) => ipcRenderer.invoke(IPC.sessionCreate, req),
  sessionList: () => ipcRenderer.invoke(IPC.sessionList),
  sessionPrompt: (req) => ipcRenderer.invoke(IPC.sessionPrompt, req),
  sessionCancel: (sessionId) => ipcRenderer.invoke(IPC.sessionCancel, sessionId),
  sessionSetModel: (sessionId, modelId) => ipcRenderer.invoke(IPC.sessionSetModel, sessionId, modelId),
  sessionSetMode: (sessionId, mode) => ipcRenderer.invoke(IPC.sessionSetMode, sessionId, mode),
  sessionAnswerPermission: (req) => ipcRenderer.invoke(IPC.sessionAnswerPermission, req),
  sessionClose: (sessionId) => ipcRenderer.invoke(IPC.sessionClose, sessionId),
  sessionRename: (sessionId, title) => ipcRenderer.invoke(IPC.sessionRename, sessionId, title),
  sessionDelete: (sessionId) => ipcRenderer.invoke(IPC.sessionDelete, sessionId),
  sessionMessagesGet: (sessionId) => ipcRenderer.invoke(IPC.sessionMessagesGet, sessionId),
  sessionMessagesSave: (sessionId, messages) =>
    ipcRenderer.invoke(IPC.sessionMessagesSave, sessionId, messages),
  settingsGet: () => ipcRenderer.invoke(IPC.settingsGet),
  settingsSet: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  dialogPickFolder: () => ipcRenderer.invoke(IPC.dialogPickFolder),
  fsTree: (root, sub) => ipcRenderer.invoke(IPC.fsTree, root, sub),
  fsRead: (path) => ipcRenderer.invoke(IPC.fsRead, path),
  fsWrite: (path, text, root) => ipcRenderer.invoke(IPC.fsWrite, path, text, root),
  fsGitStatus: (root) => ipcRenderer.invoke(IPC.fsGitStatus, root),
  openIn: (target, path) => ipcRenderer.invoke(IPC.openIn, target, path),
  onEngineEvent: (listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, envelope: EngineEventEnvelope): void =>
      listener(envelope);
    ipcRenderer.on(IPC.engineEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC.engineEvent, wrapped);
  },
};

contextBridge.exposeInMainWorld('cyberslots', api);
