/**
 * windowTheme — keeps the native window chrome (title-bar overlay,
 * window background) in sync with the renderer theme so the header
 * blends into the app instead of staying OS-default.
 */

import { nativeTheme } from 'electron';
import type { BrowserWindow } from 'electron';

import type { ResolvedMode, ThemeMode, WindowAppearance } from '@shared/types';

interface ChromeColors {
  bg: string;
  symbol: string;
}

// 顶栏/侧栏 = 画布色（--bg-canvas），原生右上角窗口控制按钮区同色 →
// 整条顶栏无缝；主内容浮层（--bg）带左上大圆角浮在画布上。
// 皮肤已收敛为单一 notion 主题，只按明暗一维映射。
export const THEME_CHROME: Record<ResolvedMode, ChromeColors> = {
  light: { bg: '#F0ECDF', symbol: '#37352F' },
  dark: { bg: '#0F0E0E', symbol: '#CECDC3' },
};

export const TITLEBAR_HEIGHT = 40;

/** 'system' 按操作系统当前明暗解析（建窗时主进程侧的一次性解析）。 */
export function resolveMode(mode: ThemeMode): ResolvedMode {
  if (mode === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return mode;
}

export function chromeFor(appearance: WindowAppearance): ChromeColors {
  return THEME_CHROME[appearance.mode] ?? THEME_CHROME.light;
}

export function applyWindowTheme(win: BrowserWindow, appearance: WindowAppearance): void {
  const colors = chromeFor(appearance);
  win.setBackgroundColor(colors.bg);
  try {
    win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.symbol, height: TITLEBAR_HEIGHT });
  } catch {
    /* overlay not enabled on this window (e.g. legacy frame) */
  }
}
