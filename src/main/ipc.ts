/**
 * IPC registration — thin, typed glue between channels and SessionManager
 * / SettingsStore. No business logic lives here.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';

import type { AnswerPermissionRequest, OpenTarget, SessionCreateRequest, SessionPromptRequest } from '@shared/ipc';
import { IPC } from '@shared/ipc';
import type { AppSettings, PermissionMode, UnifiedMessage } from '@shared/types';
import type { SessionManager } from './engine/SessionManager';
import type { SettingsStore } from './config/settings';
import { gitStatus, listTree, openIn, readFilePreview, writeFileChecked } from './fs/fsService';

export function registerIpc(sessions: SessionManager, settings: SettingsStore): void {
  ipcMain.handle(IPC.sessionCreate, (_e, req: SessionCreateRequest) => sessions.create(req));
  ipcMain.handle(IPC.sessionList, () => sessions.list());
  ipcMain.handle(IPC.sessionPrompt, (_e, req: SessionPromptRequest) =>
    sessions.prompt(req.sessionId, req.text, req.attachments),
  );
  ipcMain.handle(IPC.sessionCancel, (_e, sessionId: string) => sessions.cancel(sessionId));
  ipcMain.handle(IPC.sessionSetModel, (_e, sessionId: string, modelId: string) =>
    sessions.setModel(sessionId, modelId),
  );
  ipcMain.handle(IPC.sessionSetMode, (_e, sessionId: string, mode: PermissionMode) =>
    sessions.setMode(sessionId, mode),
  );
  ipcMain.handle(IPC.sessionAnswerPermission, (_e, req: AnswerPermissionRequest) =>
    sessions.answerPermission(req.sessionId, req.requestId, req.optionId),
  );
  ipcMain.handle(IPC.sessionClose, (_e, sessionId: string) => sessions.close(sessionId));
  ipcMain.handle(IPC.sessionRename, (_e, sessionId: string, title: string) =>
    sessions.rename(sessionId, title),
  );
  ipcMain.handle(IPC.sessionDelete, (_e, sessionId: string) => sessions.delete(sessionId));
  ipcMain.handle(IPC.sessionMessagesGet, (_e, sessionId: string) => sessions.getMessages(sessionId));
  ipcMain.handle(IPC.sessionMessagesSave, (_e, sessionId: string, messages: UnifiedMessage[]) =>
    sessions.saveMessages(sessionId, messages),
  );

  ipcMain.handle(IPC.settingsGet, () => redactForRenderer(settings.get()));
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) =>
    redactForRenderer(settings.set(patch)),
  );

  ipcMain.handle(IPC.dialogPickFolder, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.fsTree, (_e, root: string, sub?: string) => listTree(root, sub));
  ipcMain.handle(IPC.fsRead, (_e, path: string) => readFilePreview(path));
  ipcMain.handle(IPC.fsWrite, (_e, path: string, text: string, root: string) =>
    writeFileChecked(path, text, root),
  );
  ipcMain.handle(IPC.fsGitStatus, (_e, root: string) => gitStatus(root));
  ipcMain.handle(IPC.openIn, (_e, target: OpenTarget, path: string) => openIn(target, path));
}

/** API keys never cross into the renderer — masked for display only. */
function redactForRenderer(s: AppSettings): AppSettings {
  return {
    ...s,
    providers: s.providers.map((p) => ({
      ...p,
      apiKey: p.apiKey ? `${p.apiKey.slice(0, 8)}…${p.apiKey.slice(-4)}` : '',
    })),
  };
}
