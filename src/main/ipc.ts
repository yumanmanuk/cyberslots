/**
 * IPC registration — thin, typed glue between channels and SessionManager
 * / SettingsStore. No business logic lives here.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';

import type { AnswerPermissionRequest, OpenTarget, SessionCreateRequest, SessionPromptRequest } from '@shared/ipc';
import { IPC } from '@shared/ipc';
import type { AppSettings, CronTask, EngineId, GoalControlAction, PermissionMode, UnifiedMessage, WindowAppearance } from '@shared/types';
import type { SessionManager } from './engine/SessionManager';
import type { SettingsStore } from './config/settings';
import type { CronService } from './cron/CronService';
import type { OpencodeServerHost } from './engine/opencode/OpencodeServerHost';
import { readEngineConfigs } from './config/engineConfigs';
import { applyWindowTheme } from './windowTheme';
import { gitStatus, listTree, openIn, readFilePreview, writeFileChecked } from './fs/fsService';

export function registerIpc(
  sessions: SessionManager,
  settings: SettingsStore,
  cron: CronService,
  opencodeHost: OpencodeServerHost,
): void {
  ipcMain.handle(IPC.sessionCreate, (_e, req: SessionCreateRequest) => sessions.create(req));
  ipcMain.handle(IPC.sessionList, () => sessions.list());
  ipcMain.handle(IPC.sessionPrompt, (_e, req: SessionPromptRequest) =>
    sessions.prompt(req.sessionId, req.text, req.attachments, req.effort),
  );
  ipcMain.handle(IPC.sessionCancel, (_e, sessionId: string) => sessions.cancel(sessionId));
  ipcMain.handle(IPC.sessionWarmUp, (_e, sessionId: string) => sessions.warmUp(sessionId));
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
  ipcMain.handle(IPC.sessionFork, (_e, sessionId: string) => sessions.fork(sessionId));
  ipcMain.handle(IPC.sessionForkEngine, (_e, sessionId: string, engine: EngineId) =>
    sessions.forkToEngine(sessionId, engine),
  );
  ipcMain.handle(IPC.sessionCompact, (_e, sessionId: string) => sessions.compact(sessionId));
  ipcMain.handle(IPC.sessionSteer, (_e, sessionId: string, text: string) => sessions.steer(sessionId, text));
  ipcMain.handle(IPC.sessionGoalSet, (_e, sessionId: string, objective: string) =>
    sessions.setGoal(sessionId, objective),
  );
  ipcMain.handle(IPC.sessionGoalControl, (_e, sessionId: string, action: GoalControlAction) =>
    sessions.controlGoal(sessionId, action),
  );
  ipcMain.handle(IPC.sessionMarkRead, (_e, sessionId: string) => sessions.markRead(sessionId));
  ipcMain.handle(IPC.sessionSetArchived, (_e, sessionId: string, archived: boolean) =>
    sessions.setArchived(sessionId, archived),
  );
  ipcMain.handle(IPC.sessionAssignWorkspace, (_e, cwd: string, workspaceId: string) =>
    sessions.assignWorkspace(cwd, workspaceId),
  );
  ipcMain.handle(IPC.workspaceAnnounce, (_e, workspaceId: string) =>
    sessions.announceWorkspaceFolders(workspaceId),
  );

  ipcMain.handle(IPC.settingsGet, () => settings.get());
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => settings.set(patch));
  // CLI 配置只读快照 — key 从不跨进 renderer（只有 hasKey 标记）。
  ipcMain.handle(IPC.engineConfigsGet, () => readEngineConfigs());
  // opencode 模型目录 — 主进程代理 /config/providers（renderer 不直连
  // serve 端口，server 密码不出主进程）；按需启动 server。
  ipcMain.handle(IPC.opencodeCatalogGet, (_e, force?: boolean) => opencodeHost.getCatalog(force));

  ipcMain.handle(IPC.themeSync, (e, appearance: WindowAppearance) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) applyWindowTheme(win, appearance);
  });

  ipcMain.handle(IPC.cronList, () => cron.list());
  ipcMain.handle(IPC.cronSave, (_e, task: CronTask) => cron.save(task));
  ipcMain.handle(IPC.cronDelete, (_e, id: string) => cron.delete(id));
  ipcMain.handle(IPC.cronRunNow, (_e, id: string) => cron.runNow(id));

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
