/**
 * windowTheme — keeps the native window chrome (title-bar overlay,
 * window background) in sync with the renderer theme so the header
 * blends into the app instead of staying OS-default.
 */

import type { BrowserWindow } from 'electron';

import type { AppSettings } from '@shared/types';

interface ChromeColors {
  bg: string;
  symbol: string;
}

// 顶栏/侧栏 = 画布色（--bg-canvas），原生右上角窗口控制按钮区同色 →
// 整条顶栏无缝；主内容浮层（--bg）带左上大圆角浮在画布上。
export const THEME_CHROME: Record<AppSettings['theme'], ChromeColors> = {
  notion: { bg: '#EFECE4', symbol: '#37352F' },
  light: { bg: '#F2F2F4', symbol: '#1F1F21' },
  dark: { bg: '#0F0E0E', symbol: '#CECDC3' },
};

export const TITLEBAR_HEIGHT = 40;

export function applyWindowTheme(win: BrowserWindow, theme: AppSettings['theme']): void {
  const colors = THEME_CHROME[theme] ?? THEME_CHROME.notion;
  win.setBackgroundColor(colors.bg);
  try {
    win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.symbol, height: TITLEBAR_HEIGHT });
  } catch {
    /* overlay not enabled on this window (e.g. legacy frame) */
  }
}
