/**
 * IPC registration — thin, typed glue between channels and SessionManager
 * / SettingsStore. No business logic lives here.
 */

import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';

import type { AnswerPermissionRequest, OpenTarget, SessionCreateRequest, SessionPromptRequest, SessionSearchRequest, SlashListRequest } from '@shared/ipc';
import { IPC } from '@shared/ipc';
import type { AgyAccountsSnapshot, AntigravityCatalog, AppSettings, CronTask, EngineConfigsSnapshot, EngineId, GoalControlAction, OmpCatalog, PermissionMode, UnifiedMessage, UsageStatsQuery, WindowAppearance } from '@shared/types';
import type { RaceAdoptStrategy, RaceCreateRequest, RaceRole, RaceRoleConfig } from '@shared/race';
import type { SessionManager } from './engine/SessionManager';
import type { BrowserService } from './browser/BrowserService';
import type { SettingsStore } from './config/settings';
import type { CronService } from './cron/CronService';
import type { OpencodeServerHost } from './engine/opencode/OpencodeServerHost';
import type { TerminalService } from './terminal/TerminalService';
import type { RaceManager } from './race/RaceManager';
import { readEngineConfigs } from './config/engineConfigs';
import { setDataDir } from './config/dataDir';
import { fetchOmpCatalog } from './engine/omp/resolveOmp';
import { fetchAntigravityCatalog } from './engine/antigravity/resolveAntigravity';
import { listAgyAccounts, listAgyImportCandidates, importAgyAccounts, importAgyAccountsFromFile, removeAgyAccount, switchAgyAccount, queryAgyQuota, queryActiveAgyQuota } from './engine/antigravity/agyAccounts';
import { applyWindowTheme } from './windowTheme';
import { detectOpeners, gitBaseContent, gitStatus, importPaths, isDirectory, listTree, openIn, readFilePreview, resolveWorkspaceFile, saveTempAttachment, writeFileChecked } from './fs/fsService';
import { compatAudit } from './engine/compatAudit';
import { inlineImageDataUrl } from './engine/attachments';
import { listSlashItems } from './slash/slashService';
import { getProviderQuotas } from './usage/providerQuota';
import { queryOmpQuota } from './usage/ompQuota';
import { generateTitle } from './titleGen';
import { setMainLang } from './i18n';
import { log, logDir, writeRendererLogs } from './log/logger';

/**
 * IPC 统一包装：handler 抛错一律记 error 日志（含通道名与参数摘要）后原样
 * 回抛渲染层 —— 任何 UI 操作失败在日志里都能定位到具体通道。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IpcHandler = (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown;
function handle(channel: string, fn: IpcHandler): void {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return await fn(e, ...args);
    } catch (err) {
      log.error('ipc', 'handler failed', { channel, args }, err);
      throw err;
    }
  });
}

/** engineConfigsGet 的短 TTL 结果缓存 — 配置读取 + CLI 版本探测全同步，
 *  频繁展开选择器时不能让主进程事件循环反复被 spawnSync 占住。 */
let engineConfigsCache: { at: number; claudeCliPath: string; snap: EngineConfigsSnapshot } | null = null;
const ENGINE_CONFIGS_CACHE_TTL = 10_000;

function readEngineConfigsCached(force: boolean, claudeCliPath: string): EngineConfigsSnapshot {
  const now = Date.now();
  if (
    !force &&
    engineConfigsCache &&
    engineConfigsCache.claudeCliPath === claudeCliPath &&
    now - engineConfigsCache.at < ENGINE_CONFIGS_CACHE_TTL
  ) {
    return engineConfigsCache.snap;
  }
  const snap = readEngineConfigs({ claudeCliPath });
  engineConfigsCache = { at: now, claudeCliPath, snap };
  return snap;
}

export function registerIpc(
  sessions: SessionManager,
  settings: SettingsStore,
  cron: CronService,
  opencodeHost: OpencodeServerHost,
  terminal: TerminalService,
  race: RaceManager,
  browser: BrowserService,
): void {
  // 渲染进程日志批量落盘（send/on，无应答）；日志目录查询与打开。
  ipcMain.on(IPC.logWrite, (_e, entries: Parameters<typeof writeRendererLogs>[0]) => writeRendererLogs(entries));
  handle(IPC.logsDir, () => logDir());
  handle(IPC.logsOpenDir, async () => {
    const err = await shell.openPath(logDir());
    if (err) log.warn('log', 'open log dir failed', { err });
  });

  handle(IPC.sessionCreate, (_e, req: SessionCreateRequest) => sessions.create(req));
  handle(IPC.sessionList, () => sessions.list());
  handle(IPC.sessionPrompt, (_e, req: SessionPromptRequest) =>
    sessions.prompt(req.sessionId, req.text, req.attachments, req.effort, req.userMessageId),
  );
  handle(IPC.sessionCancel, (_e, sessionId: string) => sessions.cancel(sessionId));
  handle(IPC.sessionWarmUp, (_e, sessionId: string) => sessions.warmUp(sessionId));
  handle(IPC.sessionSetModel, (_e, sessionId: string, modelId: string) =>
    sessions.setModel(sessionId, modelId),
  );
  handle(IPC.sessionSetEffort, (_e, sessionId: string, effort: string | null) =>
    sessions.setEffort(sessionId, effort),
  );
  handle(IPC.sessionSetMode, (_e, sessionId: string, mode: PermissionMode) =>
    sessions.setMode(sessionId, mode),
  );
  handle(IPC.sessionAnswerPermission, (_e, req: AnswerPermissionRequest) =>
    sessions.answerPermission(req.sessionId, req.requestId, req.optionId),
  );
  handle(IPC.sessionClose, (_e, sessionId: string) => sessions.close(sessionId));
  handle(IPC.sessionRename, (_e, sessionId: string, title: string) =>
    sessions.rename(sessionId, title),
  );
  handle(IPC.sessionDelete, (_e, sessionId: string) => sessions.delete(sessionId));
  handle(IPC.sessionMessagesGet, (_e, sessionId: string) => sessions.getMessages(sessionId));
  handle(IPC.sessionSearch, (_e, req: SessionSearchRequest) => sessions.search(req));
  handle(IPC.sessionMessagesSave, (_e, sessionId: string, messages: UnifiedMessage[]) =>
    sessions.saveMessages(sessionId, messages),
  );
  handle(IPC.sessionFork, (_e, sessionId: string) => sessions.fork(sessionId));
  handle(IPC.sessionForkEngine, (_e, sessionId: string, engine: EngineId) =>
    sessions.forkToEngine(sessionId, engine),
  );
  handle(IPC.sessionCompact, (_e, sessionId: string) => sessions.compact(sessionId));
  handle(IPC.sessionChangesList, (_e, sessionId: string) => sessions.changesList(sessionId));
  handle(IPC.sessionChangesDiff, (_e, sessionId: string, path: string) =>
    sessions.changesDiff(sessionId, path),
  );
  handle(IPC.sessionChangesRevert, (_e, sessionId: string, path?: string) =>
    sessions.changesRevert(sessionId, path),
  );
  handle(IPC.sessionChangesAccept, (_e, sessionId: string, path?: string) =>
    sessions.changesAccept(sessionId, path),
  );
  handle(IPC.sessionUndoPreview, (_e, sessionId: string, messageId: string) =>
    sessions.undoPreview(sessionId, messageId),
  );
  handle(IPC.sessionUndo, (_e, sessionId: string, messageId: string) =>
    sessions.undoToMessage(sessionId, messageId),
  );
  handle(IPC.sessionSteer, (_e, sessionId: string, text: string, attachments?: string[], messageId?: string) =>
    sessions.steer(sessionId, text, attachments, messageId),
  );
  handle(IPC.sessionGoalSet, (_e, sessionId: string, objective: string) =>
    sessions.setGoal(sessionId, objective),
  );
  handle(IPC.sessionGoalControl, (_e, sessionId: string, action: GoalControlAction) =>
    sessions.controlGoal(sessionId, action),
  );
  handle(IPC.sessionSetSwarm, (_e, sessionId: string, active: boolean) =>
    sessions.setSwarm(sessionId, active),
  );
  handle(IPC.sessionMarkRead, (_e, sessionId: string) => sessions.markRead(sessionId));
  handle(IPC.sessionSetArchived, (_e, sessionId: string, archived: boolean) =>
    sessions.setArchived(sessionId, archived),
  );
  handle(IPC.sessionAssignWorkspace, (_e, cwd: string, workspaceId: string) =>
    sessions.assignWorkspace(cwd, workspaceId),
  );
  handle(IPC.workspaceAnnounce, (_e, workspaceId: string) =>
    sessions.announceWorkspaceFolders(workspaceId),
  );

  handle(IPC.settingsGet, () => settings.get());
  handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => {
    const next = settings.set(patch);
    setMainLang(next.language); // 主进程文案（错误/通知/权限选项）随界面语言即时切换
    return next;
  });
  // 数据目录：get 返回本次启动生效目录；set 写指针文件（'' = 恢复默认），
  // 目录不存在由主进程在下次启动时自动创建。
  handle(IPC.dataDirGet, () => app.getPath('userData'));
  handle(IPC.dataDirSet, (_e, path: string) => setDataDir(path));
  // AI 生成会话标题 — key 只在主进程使用；失败返回 null 由渲染层回退。
  handle(IPC.titleGenerate, (_e, text: string) => generateTitle(settings.get().titleGen, text));
  // 用量统计 — 扫描各会话消息文件的 turn_end 统计行按时间桶聚合。
  handle(IPC.usageStats, (_e, query: UsageStatsQuery) => sessions.usageStats(query));
  // 供应商套餐余量/余额 — key 只在主进程使用，结果不含任何密钥。
  handle(IPC.providerQuota, (_e, force?: boolean) => getProviderQuotas(!!force));
  // CLI 配置只读快照 — key 从不跨进 renderer（只有 hasKey 标记）。
  // 短 TTL 结果缓存：选择器每次展开都会调这里，读多份 CLI 配置 + 版本
  // 探测对主进程事件循环是同步阻塞（spawnSync 实测单次 1~2s）。展开等
  // 非显式场景复用缓存；设置页显式「刷新」传 force 跳过缓存。
  handle(IPC.engineConfigsGet, (_e, force?: boolean) => readEngineConfigsCached(!!force, settings.get().claudeCliPath ?? ''));
  // 引擎兼容性审计快照（设置页诊断卡首次打开时拉取；增量走推送）。
  handle(IPC.compatAuditGet, () => compatAudit.snapshot());
  // opencode 模型目录 — 主进程代理 /config/providers（renderer 不直连
  // serve 端口，server 密码不出主进程）；按需启动 server。
  handle(IPC.opencodeCatalogGet, (_e, force?: boolean) => opencodeHost.getCatalog(force));
  // omp 模型目录 — 主进程代理 `omp models --json`，进程级缓存（force = 重拉）。
  let ompCatalogCache: OmpCatalog | undefined;
  handle(IPC.ompCatalogGet, async (_e, force?: boolean) => {
    if (!force && ompCatalogCache && !ompCatalogCache.error) return ompCatalogCache;
    ompCatalogCache = await fetchOmpCatalog();
    return ompCatalogCache;
  });
  // antigravity 模型目录 — 主进程代理 `agy models`，进程级缓存。
  let agyCatalogCache: AntigravityCatalog | undefined;
  handle(IPC.antigravityCatalogGet, async (_e, force?: boolean) => {
    if (!force && agyCatalogCache && !agyCatalogCache.error) return agyCatalogCache;
    agyCatalogCache = await fetchAntigravityCatalog();
    return agyCatalogCache;
  });
  // Antigravity 导入池 / 导入 / 切号 / 额度 — 凭据与切号逻辑全在主进程，renderer 只拿脱敏结果。
  handle(IPC.agyAccountsList, (): AgyAccountsSnapshot => listAgyAccounts());
  handle(IPC.agyImportCandidates, () => listAgyImportCandidates());
  handle(IPC.agyAccountsImport, (_e, ids: string[]) => importAgyAccounts(Array.isArray(ids) ? ids : []));
  // 从导出文件导入：文件选择 + 解析全在主进程，renderer 不接触凭据内容。
  handle(IPC.agyAccountsImportFile, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = {
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths[0]) return null;
    return importAgyAccountsFromFile(result.filePaths[0]);
  });
  handle(IPC.agyAccountRemove, (_e, id: string) => removeAgyAccount(id));
  handle(IPC.agyAccountSwitch, (_e, accountId: string) => switchAgyAccount(accountId));
  handle(IPC.agyQuota, (_e, force?: boolean, cachedOnly?: boolean) => queryAgyQuota(!!force, { cachedOnly: !!cachedOnly }));
  // 当前活动账号额度 — 只 1 次往返（用量小窗/大窗常显），与扫全账号的 agyQuota 解耦。
  handle(IPC.agyActiveQuota, (_e, force?: boolean) => queryActiveAgyQuota(!!force));
  // omp Claude 系列余量 — 调 `omp usage --json --provider google-antigravity`，无需活跃会话。
  handle(IPC.ompQuota, (_e, force?: boolean) => queryOmpQuota(!!force));

  handle(IPC.themeSync, (e, appearance: WindowAppearance) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) applyWindowTheme(win, appearance);
  });

  // 任务栏角标（Windows overlay icon）— renderer 用 canvas 画好角标图推过来，
  // null = 清除。非 Windows 平台 setOverlayIcon 是 no-op，无需分支。
  handle(IPC.badgeSet, (e, dataUrl: string | null, description: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    win.setOverlayIcon(dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, description);
  });

  handle(IPC.cronList, () => cron.list());
  handle(IPC.cronSave, (_e, task: CronTask) => cron.save(task));
  handle(IPC.cronDelete, (_e, id: string) => cron.delete(id));
  handle(IPC.cronRunNow, (_e, id: string) => cron.runNow(id));

  handle(IPC.dialogPickFolder, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(IPC.fsTree, (_e, root: string, sub?: string) => listTree(root, sub));
  handle(IPC.fsRead, (_e, path: string) => readFilePreview(path));
  handle(IPC.fsWrite, (_e, path: string, text: string, root: string) =>
    writeFileChecked(path, text, root),
  );
  handle(IPC.fsGitStatus, (_e, root: string) => gitStatus(root));
  handle(IPC.gitBaseContent, (_e, root: string, path: string) => gitBaseContent(root, path));
  handle(IPC.fsImport, (_e, root: string, srcPaths: string[]) => importPaths(root, srcPaths));
  handle(IPC.fsIsDir, (_e, path: string) => isDirectory(path));
  handle(IPC.fsResolve, (_e, root: string, rawPath: string) => resolveWorkspaceFile(root, rawPath));
  handle(IPC.openIn, (_e, target: OpenTarget, path: string) => openIn(target, path));
  handle(IPC.openersDetect, (_e, force?: boolean) => detectOpeners(force));
  handle(IPC.attachmentSaveTemp, (_e, bytes: Uint8Array, ext: string) => saveTempAttachment(bytes, ext));
  handle(IPC.attachmentDataUrl, (_e, path: string) => inlineImageDataUrl(path) ?? null);

  // 斜线命令候选（skills/commands 目录扫描，纯只读）。
  handle(IPC.slashList, (_e, req: SlashListRequest) => listSlashItems(req.cwd, req.engine, req.pushedCommands));

  // 受管浏览器（browser use 工具服务）：状态查询 / 懒启动 / 停止；
  // 工具调用本体不走 IPC —— 引擎经 MCP → loopback HTTP 出口进 BrowserService。
  handle(IPC.browserGetState, () => browser.getState());
  handle(IPC.browserEnsure, () => browser.ensure());
  handle(IPC.browserStop, () => browser.stop());

  // 面板内嵌终端：每会话一个管道式 shell（cwd = 会话目录）。
  handle(IPC.terminalCreate, (_e, id: string, cwd: string) => terminal.create(id, cwd));
  handle(IPC.terminalInput, (_e, id: string, data: string) => terminal.input(id, data));
  handle(IPC.terminalResize, (_e, id: string, cols: number, rows: number) => terminal.resize(id, cols, rows));
  handle(IPC.terminalDispose, (_e, id: string) => terminal.dispose(id));

  // 大模型赛马：编排层公开的动作（事件走 IPC.raceEvent 主动推送）。
  handle(IPC.raceCreate, (_e, req: RaceCreateRequest) => race.create(req));
  handle(IPC.raceList, () => race.list());
  handle(IPC.raceGet, (_e, raceId: string) => race.get(raceId));
  handle(IPC.raceAdopt, (_e, raceId: string, strategy: RaceAdoptStrategy, comment?: string) =>
    race.adopt(raceId, strategy, comment),
  );
  handle(IPC.raceRevise, (_e, raceId: string, annotation: string) => race.revise(raceId, annotation));
  handle(IPC.raceFinalize, (_e, raceId: string) => race.finalize(raceId));
  handle(IPC.raceResume, (_e, raceId: string) => race.resume(raceId));
  handle(IPC.raceOverrideAudit, (_e, raceId: string) => race.overrideAudit(raceId));
  handle(IPC.raceUpdateRole, (_e, raceId: string, role: RaceRole, cfg: RaceRoleConfig) =>
    race.updateRole(raceId, role, cfg),
  );
  handle(IPC.raceRetryRacer, (_e, raceId: string, role: RaceRole) => race.retryRacer(raceId, role));
  handle(IPC.raceRetryRacerIfMissing, (_e, raceId: string, role: RaceRole) => race.retryRacerIfMissing(raceId, role));
  handle(IPC.raceRevokeAdopt, (_e, raceId: string) => race.revokeAdopt(raceId));
  handle(IPC.raceRerunJudge, (_e, raceId: string) => race.rerunJudge(raceId));
  handle(IPC.raceEliminate, (_e, raceId: string, role: RaceRole) => race.eliminateRacer(raceId, role));
  handle(IPC.raceRestartPlanning, (_e, raceId: string) => race.restartPlanning(raceId));
  handle(IPC.raceCancel, (_e, raceId: string) => race.cancel(raceId));
  handle(IPC.raceAcceptPreJudge, (_e, raceId: string) => race.acceptPreJudge(raceId));
  handle(IPC.raceDismissPreJudge, (_e, raceId: string) => race.dismissPreJudge(raceId));
}
