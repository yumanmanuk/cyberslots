/**
 * 系统通知统一出口：展示桌面通知，并支持「点击 → 回到窗口并定位会话」。
 * 引擎行为正文不入本程序日志；这里只记点击摘要（sessionId）。
 */

import { BrowserWindow, Notification } from 'electron';

import { IPC } from '@shared/ipc';
import { log } from './log/logger';

interface NotifyOptions {
  title: string;
  body: string;
  /** 点击通知时要定位到的会话；缺省则仅恢复/聚焦窗口。 */
  sessionId?: string;
}

/** 当前主窗口（取第一个未销毁的 BrowserWindow 兜底）。 */
function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
}

function focusMainWindow(): void {
  const win = mainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

export function notifyWithSession(opts: NotifyOptions): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: opts.title, body: opts.body });
  if (opts.sessionId) {
    const sessionId = opts.sessionId;
    n.on('click', () => {
      focusMainWindow();
      const wc = mainWindow()?.webContents;
      if (wc && !wc.isDestroyed()) {
        wc.send(IPC.sessionActivate, sessionId);
        log.info('notification', 'clicked, activate session', { sessionId });
      }
    });
  }
  n.on('failed', (_event, err) => {
    log.warn('notification', 'show failed', undefined, err);
  });
  n.show();
}
