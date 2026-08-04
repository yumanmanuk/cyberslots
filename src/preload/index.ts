/**
 * Preload bridge — exposes the typed CyberSlotsApi to the renderer via
 * contextBridge. Only IPC passthrough; zero logic.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { CyberSlotsApi } from '@shared/ipc';
import { IPC } from '@shared/ipc';
import type { CompatAuditSnapshot, EngineEventEnvelope } from '@shared/types';
import type { RaceEventEnvelope } from '@shared/race';

const api: CyberSlotsApi = {
  sessionCreate: (req) => ipcRenderer.invoke(IPC.sessionCreate, req),
  sessionList: () => ipcRenderer.invoke(IPC.sessionList),
  sessionPrompt: (req) => ipcRenderer.invoke(IPC.sessionPrompt, req),
  sessionCancel: (sessionId) => ipcRenderer.invoke(IPC.sessionCancel, sessionId),
  sessionWarmUp: (sessionId) => ipcRenderer.invoke(IPC.sessionWarmUp, sessionId),
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
  sessionChangesList: (sessionId) => ipcRenderer.invoke(IPC.sessionChangesList, sessionId),
  sessionChangesDiff: (sessionId, path) => ipcRenderer.invoke(IPC.sessionChangesDiff, sessionId, path),
  sessionChangesRevert: (sessionId, path) => ipcRenderer.invoke(IPC.sessionChangesRevert, sessionId, path),
  sessionChangesAccept: (sessionId, path) => ipcRenderer.invoke(IPC.sessionChangesAccept, sessionId, path),
  sessionUndoPreview: (sessionId, messageId) => ipcRenderer.invoke(IPC.sessionUndoPreview, sessionId, messageId),
  sessionUndo: (sessionId, messageId) => ipcRenderer.invoke(IPC.sessionUndo, sessionId, messageId),
  sessionSteer: (sessionId, text) => ipcRenderer.invoke(IPC.sessionSteer, sessionId, text),
  sessionGoalSet: (sessionId, objective) => ipcRenderer.invoke(IPC.sessionGoalSet, sessionId, objective),
  sessionGoalControl: (sessionId, action) => ipcRenderer.invoke(IPC.sessionGoalControl, sessionId, action),
  sessionSetSwarm: (sessionId, active) => ipcRenderer.invoke(IPC.sessionSetSwarm, sessionId, active),
  sessionMarkRead: (sessionId) => ipcRenderer.invoke(IPC.sessionMarkRead, sessionId),
  sessionSetArchived: (sessionId, archived) => ipcRenderer.invoke(IPC.sessionSetArchived, sessionId, archived),
  sessionAssignWorkspace: (cwd, workspaceId) => ipcRenderer.invoke(IPC.sessionAssignWorkspace, cwd, workspaceId),
  workspaceAnnounce: (workspaceId) => ipcRenderer.invoke(IPC.workspaceAnnounce, workspaceId),
  settingsGet: () => ipcRenderer.invoke(IPC.settingsGet),
  settingsSet: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  titleGenerate: (text) => ipcRenderer.invoke(IPC.titleGenerate, text),
  usageStats: (query) => ipcRenderer.invoke(IPC.usageStats, query),
  providerQuota: (force) => ipcRenderer.invoke(IPC.providerQuota, force),
  engineConfigsGet: () => ipcRenderer.invoke(IPC.engineConfigsGet),
  opencodeCatalogGet: (force) => ipcRenderer.invoke(IPC.opencodeCatalogGet, force),
  ompCatalogGet: (force) => ipcRenderer.invoke(IPC.ompCatalogGet, force),
    antigravityCatalogGet: (force) => ipcRenderer.invoke(IPC.antigravityCatalogGet, force),
    agyAccountsList: () => ipcRenderer.invoke(IPC.agyAccountsList),
    agyImportCandidates: () => ipcRenderer.invoke(IPC.agyImportCandidates),
    agyAccountsImport: (ids) => ipcRenderer.invoke(IPC.agyAccountsImport, ids),
    agyAccountsImportFile: () => ipcRenderer.invoke(IPC.agyAccountsImportFile),
    agyAccountRemove: (id) => ipcRenderer.invoke(IPC.agyAccountRemove, id),
    agyAccountSwitch: (accountId) => ipcRenderer.invoke(IPC.agyAccountSwitch, accountId),
    agyQuota: (force, cachedOnly) => ipcRenderer.invoke(IPC.agyQuota, force, cachedOnly),
    agyActiveQuota: (force) => ipcRenderer.invoke(IPC.agyActiveQuota, force),
  themeSync: (appearance) => ipcRenderer.invoke(IPC.themeSync, appearance),
  badgeSet: (dataUrl, description) => ipcRenderer.invoke(IPC.badgeSet, dataUrl, description),
  cronList: () => ipcRenderer.invoke(IPC.cronList),
  cronSave: (task) => ipcRenderer.invoke(IPC.cronSave, task),
  cronDelete: (id) => ipcRenderer.invoke(IPC.cronDelete, id),
  cronRunNow: (id) => ipcRenderer.invoke(IPC.cronRunNow, id),
  dialogPickFolder: () => ipcRenderer.invoke(IPC.dialogPickFolder),
  fsTree: (root, sub) => ipcRenderer.invoke(IPC.fsTree, root, sub),
  fsRead: (path) => ipcRenderer.invoke(IPC.fsRead, path),
  fsWrite: (path, text, root) => ipcRenderer.invoke(IPC.fsWrite, path, text, root),
  fsGitStatus: (root) => ipcRenderer.invoke(IPC.fsGitStatus, root),
  fsImport: (root, srcPaths) => ipcRenderer.invoke(IPC.fsImport, root, srcPaths),
  fsIsDir: (path) => ipcRenderer.invoke(IPC.fsIsDir, path),
  fsResolve: (root, rawPath) => ipcRenderer.invoke(IPC.fsResolve, root, rawPath),
  openIn: (target, path) => ipcRenderer.invoke(IPC.openIn, target, path),
  openersDetect: (force) => ipcRenderer.invoke(IPC.openersDetect, force),
  attachmentSaveTemp: (bytes, ext) => ipcRenderer.invoke(IPC.attachmentSaveTemp, bytes, ext),
  slashList: (req) => ipcRenderer.invoke(IPC.slashList, req),
  terminalCreate: (id, cwd) => ipcRenderer.invoke(IPC.terminalCreate, id, cwd),
  terminalInput: (id, data) => ipcRenderer.invoke(IPC.terminalInput, id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke(IPC.terminalResize, id, cols, rows),
  terminalDispose: (id) => ipcRenderer.invoke(IPC.terminalDispose, id),
  onTerminalData: (listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: { id: string; data: string }): void => listener(payload);
    ipcRenderer.on(IPC.terminalData, wrapped);
    return () => ipcRenderer.removeListener(IPC.terminalData, wrapped);
  },
  onEngineEvent: (listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, envelope: EngineEventEnvelope): void =>
      listener(envelope);
    ipcRenderer.on(IPC.engineEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC.engineEvent, wrapped);
  },
  compatAuditGet: () => ipcRenderer.invoke(IPC.compatAuditGet),
  onCompatAudit: (listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, snap: CompatAuditSnapshot): void => listener(snap);
    ipcRenderer.on(IPC.compatAudit, wrapped);
    return () => ipcRenderer.removeListener(IPC.compatAudit, wrapped);
  },
  raceCreate: (req) => ipcRenderer.invoke(IPC.raceCreate, req),
  raceList: () => ipcRenderer.invoke(IPC.raceList),
  raceGet: (raceId) => ipcRenderer.invoke(IPC.raceGet, raceId),
  raceAdopt: (raceId, strategy, comment) => ipcRenderer.invoke(IPC.raceAdopt, raceId, strategy, comment),
  raceRevokeAdopt: (raceId) => ipcRenderer.invoke(IPC.raceRevokeAdopt, raceId),
  raceRerunJudge: (raceId) => ipcRenderer.invoke(IPC.raceRerunJudge, raceId),
  raceRevise: (raceId, annotation) => ipcRenderer.invoke(IPC.raceRevise, raceId, annotation),
  raceFinalize: (raceId) => ipcRenderer.invoke(IPC.raceFinalize, raceId),
  raceResume: (raceId) => ipcRenderer.invoke(IPC.raceResume, raceId),
  raceUpdateRole: (raceId, role, cfg) => ipcRenderer.invoke(IPC.raceUpdateRole, raceId, role, cfg),
  raceRetryRacer: (raceId, role) => ipcRenderer.invoke(IPC.raceRetryRacer, raceId, role),
  raceRetryRacerIfMissing: (raceId, role) => ipcRenderer.invoke(IPC.raceRetryRacerIfMissing, raceId, role),
  raceEliminate: (raceId, role) => ipcRenderer.invoke(IPC.raceEliminate, raceId, role),
  raceRestartPlanning: (raceId) => ipcRenderer.invoke(IPC.raceRestartPlanning, raceId),
  raceCancel: (raceId) => ipcRenderer.invoke(IPC.raceCancel, raceId),
  onRaceEvent: (listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, envelope: RaceEventEnvelope): void => listener(envelope);
    ipcRenderer.on(IPC.raceEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC.raceEvent, wrapped);
  },
  // 日志：批量转发主进程落盘（send 不等待应答；失败静默，不能反过来影响业务）。
  logWrite: (entries) => {
    try {
      ipcRenderer.send(IPC.logWrite, entries);
    } catch {
      /* 日志通道故障静默 */
    }
  },
  logsDir: () => ipcRenderer.invoke(IPC.logsDir),
  logsOpenDir: () => ipcRenderer.invoke(IPC.logsOpenDir),
  /** Absolute path of a dropped File (drag-and-drop attachments). */
  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('cyberslots', api);
