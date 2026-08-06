/**
 * CyberSlots (赛博老虎机) — Electron main entry.
 * Window management, single-instance lock, engine lifecycle & cleanup.
 */

import { app, BrowserWindow, shell } from 'electron';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveUserDataDir } from './config/dataDir';

import { SettingsStore } from './config/settings';
import { L, setMainLang } from './i18n';
import { SessionManager } from './engine/SessionManager';
import { compatAudit } from './engine/compatAudit';
import { CronService } from './cron/CronService';
import { RaceManager } from './race/RaceManager';
import { AiServerHost } from './proxy/AiServerHost';
import { OpencodeServerHost } from './engine/opencode/OpencodeServerHost';
import { OpencodeEventHub } from './engine/opencode/OpencodeEventHub';
import { KapServerHost } from './engine/kimi/KapServerHost';
import { TerminalService } from './terminal/TerminalService';
import { BrowserService } from './browser/BrowserService';
import { registerIpc } from './ipc';
import { initLogger, log } from './log/logger';
import { sweepOrphanEngines } from './orphanSweep';
import { TITLEBAR_HEIGHT, applyWindowTheme, chromeFor, resolveMode } from './windowTheme';
import type { AppSettings, WindowAppearance } from '@shared/types';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

// dev 热重启时新旧实例短暂共用同一 userData，会争抢 GPUCache/Cache 目录
// 导致“拒绝访问 0x5”刷屏（非致命，Chromium 退回内存缓存）。dev 不需
// 磁盘缓存，直接关掉消除噪音；必须在 app ready 前设置。
if (isDev) {
  app.commandLine.appendSwitch('disable-gpu-disk-cache');
  app.commandLine.appendSwitch('disable-http-cache');
}

// 数据目录解析（自定义指针 → 默认）：dev 与打包版统一默认 %APPDATA%\CyberSlots。
// 目标目录不存在会自动创建。必须在 app ready 之前设置（否则 userData
// 已被锁定到默认 userData）。
resolveUserDataDir();

let mainWindow: BrowserWindow | undefined;
let sessions: SessionManager | undefined;
let cron: CronService | undefined;
let proxy: AiServerHost | undefined;
let opencodeHost: OpencodeServerHost | undefined;
let kapHost: KapServerHost | undefined;
let terminal: TerminalService | undefined;
let race: RaceManager | undefined;
let browser: BrowserService | undefined;

function createWindow(appSettings: AppSettings): void {
  const appearance: WindowAppearance = { mode: resolveMode(appSettings.themeMode) };
  const chrome = chromeFor(appearance);
  // 品牌图标（任务栏/Alt+Tab）：免安装包不跑 rcedit，靠运行时 icon 选项生效；
  // 打包后随 extraResources 落在 resources/icon.png，dev 直接读仓库 resources 目录。
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: L('赛博老虎机', 'CyberSlots'),
    icon: iconPath,
    backgroundColor: chrome.bg,
    show: false,
    autoHideMenuBar: true,
    // Frameless-with-overlay: the renderer owns the header strip so the
    // window chrome follows the active theme (主题切换时顶部融为一体).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.bg, symbolColor: chrome.symbol, height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // 首帧主题：把建窗时已解析的明暗传下去，preload 在页面脚本执行前
      // 同步挂 <html data-mode>，避免首帧按 :root 浅色兜底绘制后二次切换。
      additionalArguments: [`--cs-theme=${appearance.mode}`],
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  applyWindowTheme(mainWindow, appearance);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  log.info('app.window', 'main window created', { mode: appearance.mode, isDev });

  // External links open in the default browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  sessions?.attach(mainWindow.webContents);
  terminal?.attach(mainWindow.webContents);
  race?.attach(mainWindow.webContents);
  browser?.attach(mainWindow.webContents);
  compatAudit.attach(mainWindow.webContents);

  if (isDev) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

/**
 * 删除 userData 下 Chromium 残留的 SingletonLock / SingletonSocket /
 * SingletonCookie 文件。Windows 上重启电脑后（尤其 Fast Startup 场景），
 * 这些文件可能残留导致 Error Code 32。在 sweep 确认无孤儿进程后安全删除。
 */
function cleanupStaleLockFiles(): void {
  const userDataPath = app.getPath('userData');
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = join(userDataPath, name);
    try {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
        log.info('app.startup', 'removed stale lock file', { name });
      }
    } catch (e) {
      log.warn('app.startup', 'failed to remove lock file', { name }, e);
    }
  }
}

// 启动时清一遍孤儿引擎进程（~0.5s）：dev 热重启强杀旧主进程、生产环境
// 重启电脑（Fast Startup）都可能残留握着句柄的孤儿引擎，先清掉。
const preSweepCount = sweepOrphanEngines();
if (preSweepCount > 0) {
  log.info('app.startup', 'pre-sweep killed orphan engines', { count: preSweepCount });
}

// 单例锁只在生产环境启用（防用户开两份、并聚焦已有窗口）。
// dev 下 electron-vite 已管控唯一实例，热重启时新旧主进程会短暂重叠 ——
// Windows Chromium 的单例靠内核 mutex+隐藏窗口，删 SingletonLock 文件对
// 活持有者无效，requestSingleInstanceLock 必然报 process_singleton_win
// Error code 32。因此 dev 直接跳过这把锁（旧进程会随后自然退出）。
if (isDev) {
  startApp();
} else {
  cleanupStaleLockFiles();
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // 拿锁失败：可能是真实第二实例，也可能是残留锁/孤儿进程。
    // 清孤儿 + 删 lock 文件 + 重试一次。
    const swept = sweepOrphanEngines();
    cleanupStaleLockFiles();
    if (app.requestSingleInstanceLock()) {
      startApp();
    } else if (!process.argv.includes('--cs-swept')) {
      log.warn('app.startup', 'single-instance lock unavailable, relaunching once', { swept });
      app.relaunch({ args: [...process.argv.slice(1), '--cs-swept'] });
      app.quit();
    } else {
      // 已重试过仍拿不到 → 确有另一个真实实例在跑，聚焦它并退出本实例。
      log.info('app.startup', 'another instance is running, exiting');
      app.quit();
    }
  } else {
    startApp();
  }
}

function startApp(): void {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    initLogger();
    // 主进程最后一道网：未捕获异常/未处理 rejection 全量落日志（不退出，
    // Electron 默认行为继续；崩溃类异常交给系统 crash reporter）。
    process.on('uncaughtException', (err) => log.error('app.error', 'uncaught exception', undefined, err));
    process.on('unhandledRejection', (reason) => log.error('app.error', 'unhandled rejection', undefined, reason));
    // Windows toast 通知按 AUMID 归属应用；须与 electron-builder appId 一致，
    // 打包安装后通知才会显示「CyberSlots」名称与图标（否则是 electron.app.Electron）。
    if (process.platform === 'win32') app.setAppUserModelId('com.yumanmanuk.cyberslots');
    const settings = new SettingsStore();
    setMainLang(settings.get().language);
    proxy = new AiServerHost();
    opencodeHost = new OpencodeServerHost();
    const opencodeHub = new OpencodeEventHub(opencodeHost);
    kapHost = new KapServerHost();
    // 启动期引擎能力检测（只发现不拉起）：KAP 通道可用性入缓存 +
    // 日志；server spawn 留到首个 kimi KAP 会话按需进行。
    void kapHost.detectAtStartup().catch(() => undefined);
    terminal = new TerminalService();
    sessions = new SessionManager(settings, proxy, opencodeHost, opencodeHub, kapHost);
    cron = new CronService(sessions, settings);
    race = new RaceManager(sessions, settings);
    browser = new BrowserService(settings);
    // browser use 工具服务接线：引擎 MCP 注册面 + 审批应答路由（requestId
    // 前缀 `browser:` 拦截出引擎通道）+ 审批卡外发知悉的会话信息解析。
    sessions.setBrowserTools(browser);
    sessions.setPermissionInterceptor((requestId, optionId) => {
      if (!requestId.startsWith('browser:')) return false;
      browser?.answerPermission(requestId, optionId);
      return true;
    });
    browser.bindSessionResolver((sessionId) => {
      const meta = sessions?.list().find((s) => s.id === sessionId);
      return meta ? { engine: meta.engine } : undefined;
    });
    // 预热 MCP loopback 出口（flag 开时）：不拉 Chrome，只保证引擎 tools/call
    // 时 endpoint.json 已就位（Chrome 由首个工具调用懒启动）。
    void browser.warmEndpoint().catch((err) => log.warn('browser', 'warm endpoint failed', undefined, err));
    registerIpc(sessions, settings, cron, opencodeHost, terminal, race, browser);
    cron.start();
    createWindow(settings.get());
    log.info('app.startup', 'app ready', { isDev, singleInstance: !isDev });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(settings.get());
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // Anti-orphan: every engine child dies with the app.
  // 生产：首次 before-quit 先阻断，等 disposeAll 发完树杀再真退出，
  // 避免孤儿进程握锁。dev 不阻断 —— electron-vite 热重启需旧进程
  // 尽快退出（新旧重叠越短越好），dispose 尽力而为、不阻塑退出。
  let cleanedUp = false;
  app.on('before-quit', (event) => {
    log.info('app.shutdown', 'before-quit: disposing services', { cleanedUp, isDev });
    cron?.stop();
    proxy?.stop();
    opencodeHost?.stop();
    kapHost?.stop();
    terminal?.disposeAll();
    // 受管 Chrome 同步树杀（prod 路径还会在下方 await 链里再停一次，幂等）。
    void browser?.stop();
    if (cleanedUp || !sessions) return;
    cleanedUp = true;
    if (isDev) {
      void sessions.disposeAll();
      return;
    }
    event.preventDefault();
    void Promise.allSettled([sessions.disposeAll(), browser?.stop()]).finally(() => app.quit());
  });
}
