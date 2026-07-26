/**
 * CyberSlots (赛博老虎机) — Electron main entry.
 * Window management, single-instance lock, engine lifecycle & cleanup.
 */

import { app, BrowserWindow, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SettingsStore } from './config/settings';
import { SessionManager } from './engine/SessionManager';
import { CronService } from './cron/CronService';
import { AiServerHost } from './proxy/AiServerHost';
import { registerIpc } from './ipc';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: '赛博老虎机',
    backgroundColor: '#FFFCF0',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // External links open in the default browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  sessions?.attach(mainWindow.webContents);

  if (isDev) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    const settings = new SettingsStore();
    proxy = new AiServerHost();
    sessions = new SessionManager(settings, proxy);
    cron = new CronService(sessions);
    registerIpc(sessions, settings, cron);
    cron.start();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // Anti-orphan: every engine child dies with the app.
  app.on('before-quit', () => {
    cron?.stop();
    proxy?.stop();
    void sessions?.disposeAll();
  });
}
