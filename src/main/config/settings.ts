/**
 * App settings — persisted under userData/settings.json. 自「配置只读 +
 * 路由开关」改版后不再存储任何供应商/密钥：模型端点的唯一真源是
 * CLI 自己的配置文件（~/.kimi-code、~/.codex，只读），这里只保留
 * UI 偏好与每引擎的路由开关。
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppSettings } from '@shared/types';

const DEFAULTS: AppSettings = {
  themeMode: 'light',
  themePalette: 'notion',
  language: 'zh',
  defaultPermissionMode: 'default',
  sendKey: 'enter',
  notifications: { taskComplete: true, question: true, error: true },
  workspaces: [],
  routing: { kimi: false, codex: false },
};

/** Backfill fields added over time; silently drop the legacy provider
 *  store (pre-routing builds kept providers/keys in settings.json). */
function migrate(stored: Record<string, unknown>): AppSettings {
  const s = stored as Partial<AppSettings> & { providers?: unknown; defaultModelId?: unknown; theme?: 'notion' | 'light' | 'dark' };
  return {
    themeMode: s.themeMode ?? (s.theme === 'dark' ? 'dark' : DEFAULTS.themeMode),
    themePalette: s.themePalette ?? DEFAULTS.themePalette,
    language: s.language ?? DEFAULTS.language,
    defaultPermissionMode: s.defaultPermissionMode ?? DEFAULTS.defaultPermissionMode,
    sendKey: s.sendKey ?? DEFAULTS.sendKey,
    notifications: { ...DEFAULTS.notifications, ...(s.notifications ?? {}) },
    workspaces: s.workspaces ?? [],
    routing: { ...DEFAULTS.routing, ...(s.routing ?? {}) },
  };
}

export class SettingsStore {
  private cached: AppSettings | undefined;

  constructor(private readonly dir = app.getPath('userData')) {}

  private get file(): string {
    return join(this.dir, 'settings.json');
  }

  get(): AppSettings {
    if (this.cached) return this.cached;
    let settings = { ...DEFAULTS };
    if (existsSync(this.file)) {
      try {
        // BOM 容忍：外部工具（如 PowerShell）重写过的文件可能带 UTF-8 BOM。
        const raw = readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
        settings = migrate(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        console.error('[settings] failed to read settings.json, using defaults:', err);
      }
    }
    this.cached = settings;
    return settings;
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch };
    this.persist(next);
    this.cached = next;
    return next;
  }

  private persist(settings: AppSettings): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(settings, null, 2), 'utf8');
  }
}
