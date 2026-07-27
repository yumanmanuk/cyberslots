/**
 * windowTheme — keeps the native window chrome (title-bar overlay,
 * window background) in sync with the renderer theme so the header
 * blends into the app instead of staying OS-default.
 */

import { nativeTheme } from 'electron';
import type { BrowserWindow } from 'electron';

import type { ResolvedMode, ThemeMode, ThemePalette, WindowAppearance } from '@shared/types';

interface ChromeColors {
  bg: string;
  symbol: string;
}

// 顶栏/侧栏 = 画布色（--bg-canvas），原生右上角窗口控制按钮区同色 →
// 整条顶栏无缝；主内容浮层（--bg）带左上大圆角浮在画布上。
export const THEME_CHROME: Record<`${ThemePalette}-${ResolvedMode}`, ChromeColors> = {
  'notion-light': { bg: '#EFECE4', symbol: '#37352F' },
  'notion-dark': { bg: '#0F0E0E', symbol: '#CECDC3' },
  'solarized-light': { bg: '#EEE8D5', symbol: '#586E75' },
  'solarized-dark': { bg: '#00212B', symbol: '#93A1A1' },
  'everforest-light': { bg: '#E5DFC5', symbol: '#5C6A72' },
  'everforest-dark': { bg: '#232A2E', symbol: '#D3C6AA' },
};

export const TITLEBAR_HEIGHT = 40;

/** 'system' 按操作系统当前明暗解析（建窗时主进程侧的一次性解析）。 */
export function resolveMode(mode: ThemeMode): ResolvedMode {
  if (mode === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return mode;
}

export function chromeFor(appearance: WindowAppearance): ChromeColors {
  return THEME_CHROME[`${appearance.palette}-${appearance.mode}`] ?? THEME_CHROME['notion-light'];
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
