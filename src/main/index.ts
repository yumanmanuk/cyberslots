/**
 * CyberSlots (赛博老虎机) — Electron main entry.
 * Window management, single-instance lock, engine lifecycle & cleanup.
 */

import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

import { SettingsStore } from './config/settings';
import { SessionManager } from './engine/SessionManager';
import { registerIpc } from './ipc';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | undefined;
let sessions: SessionManager | undefined;

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
      preload: join(__dirname, '../preload/index.js'),
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
    sessions = new SessionManager(settings);
    registerIpc(sessions, settings);
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
    void sessions?.disposeAll();
  });
}
