/**
 * Preload bridge — exposes the typed CyberSlotsApi to the renderer via
 * contextBridge. Only IPC passthrough; zero logic.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

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
  sessionFork: (sessionId) => ipcRenderer.invoke(IPC.sessionFork, sessionId),
  sessionForkEngine: (sessionId, engine) => ipcRenderer.invoke(IPC.sessionForkEngine, sessionId, engine),
  sessionCompact: (sessionId) => ipcRenderer.invoke(IPC.sessionCompact, sessionId),
  sessionSteer: (sessionId, text) => ipcRenderer.invoke(IPC.sessionSteer, sessionId, text),
  sessionMarkRead: (sessionId) => ipcRenderer.invoke(IPC.sessionMarkRead, sessionId),
  settingsGet: () => ipcRenderer.invoke(IPC.settingsGet),
  settingsSet: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  themeSync: (theme) => ipcRenderer.invoke(IPC.themeSync, theme),
  cronList: () => ipcRenderer.invoke(IPC.cronList),
  cronSave: (task) => ipcRenderer.invoke(IPC.cronSave, task),
  cronDelete: (id) => ipcRenderer.invoke(IPC.cronDelete, id),
  cronRunNow: (id) => ipcRenderer.invoke(IPC.cronRunNow, id),
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
  /** Absolute path of a dropped File (drag-and-drop attachments). */
  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('cyberslots', api);
