/**
 * CyberSlots (赛博老虎机) — Electron main entry.
 * Window management, single-instance lock, engine lifecycle & cleanup.
 */

import { app, BrowserWindow, shell } from 'electron';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SettingsStore } from './config/settings';
import { SessionManager } from './engine/SessionManager';
import { compatAudit } from './engine/compatAudit';
import { CronService } from './cron/CronService';
import { RaceManager } from './race/RaceManager';
import { AiServerHost } from './proxy/AiServerHost';
import { OpencodeServerHost } from './engine/opencode/OpencodeServerHost';
import { OpencodeEventHub } from './engine/opencode/OpencodeEventHub';
import { TerminalService } from './terminal/TerminalService';
import { registerIpc } from './ipc';
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

// 绿色版约定：打包后全部数据落在 exe 同级 ./data，解压即用、删目录即卸载。
// 必须在 app ready 之前设置（否则 userData 已被锁定到 %APPDATA%）。
if (app.isPackaged) {
  const portableData = join(dirname(process.execPath), 'data');
  try {
    mkdirSync(portableData, { recursive: true });
    app.setPath('userData', portableData);
  } catch (err) {
    console.error('[main] portable data dir unavailable, falling back to default userData:', err);
  }
}

let mainWindow: BrowserWindow | undefined;
let sessions: SessionManager | undefined;
let cron: CronService | undefined;
let proxy: AiServerHost | undefined;
let opencodeHost: OpencodeServerHost | undefined;
let terminal: TerminalService | undefined;
let race: RaceManager | undefined;

function createWindow(appSettings: AppSettings): void {
  const appearance: WindowAppearance = { palette: appSettings.themePalette, mode: resolveMode(appSettings.themeMode) };
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
    title: '赛博老虎机',
    icon: iconPath,
    backgroundColor: chrome.bg,
    show: false,
    autoHideMenuBar: true,
    // Frameless-with-overlay: the renderer owns the header strip so the
    // window chrome follows the active theme (主题切换时顶部融为一体).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.bg, symbolColor: chrome.symbol, height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  applyWindowTheme(mainWindow, appearance);
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // External links open in the default browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  sessions?.attach(mainWindow.webContents);
  terminal?.attach(mainWindow.webContents);
  race?.attach(mainWindow.webContents);
  compatAudit.attach(mainWindow.webContents);

  if (isDev) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
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
        console.log(`[startup] Removed stale lock file: ${name}`);
      }
    } catch (e) {
      console.log(`[startup] Failed to remove ${name}: ${e}`);
    }
  }
}

// 启动时清一遍孤儿引擎进程（~0.5s）：dev 热重启强杀旧主进程、生产环境
// 重启电脑（Fast Startup）都可能残留握着句柄的孤儿引擎，先清掉。
const preSweepCount = sweepOrphanEngines();
if (preSweepCount > 0) {
  console.log(`[startup] Pre-sweep killed ${preSweepCount} orphan engine(s)`);
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
      console.log(`[startup] Lock unavailable (swept ${swept}), relaunching once...`);
      app.relaunch({ args: [...process.argv.slice(1), '--cs-swept'] });
      app.quit();
    } else {
      // 已重试过仍拿不到 → 确有另一个真实实例在跑，聚焦它并退出本实例。
      console.log('[startup] Another instance is running, exiting.');
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
    const settings = new SettingsStore();
    proxy = new AiServerHost();
    opencodeHost = new OpencodeServerHost();
    const opencodeHub = new OpencodeEventHub(opencodeHost);
    terminal = new TerminalService();
    sessions = new SessionManager(settings, proxy, opencodeHost, opencodeHub);
    cron = new CronService(sessions, settings);
    race = new RaceManager(sessions);
    registerIpc(sessions, settings, cron, opencodeHost, terminal, race);
    cron.start();
    createWindow(settings.get());

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
    cron?.stop();
    proxy?.stop();
    opencodeHost?.stop();
    terminal?.disposeAll();
    if (cleanedUp || !sessions) return;
    cleanedUp = true;
    if (isDev) {
      void sessions.disposeAll();
      return;
    }
    event.preventDefault();
    void sessions.disposeAll().finally(() => app.quit());
  });
}
