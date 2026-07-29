/**
 * App settings — persisted under userData/settings.json. 自「配置只读 +
 * 路由开关」改版后不再存储任何供应商/密钥：模型端点的唯一真源是
 * CLI 自己的配置文件（~/.kimi-code、~/.codex，只读），这里只保留
 * UI 偏好与每引擎的路由开关。
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppSettings, ContextFallbackRule } from '@shared/types';

const DEFAULTS: AppSettings = {
  themeMode: 'light',
  themePalette: 'notion',
  language: 'zh',
  defaultPermissionMode: 'default',
  sendKey: 'enter',
  autoCompactRatio: 90,
  contextFallbackRules: [{ match: 'k3 256k', to: 'k3' }],
  notifications: { taskComplete: true, question: true, error: true },
  workspaces: [],
  routing: { kimi: false, codex: false },
  opencodeHiddenModels: [],
  race: {
    enableRacerC: false,
    roles: {
      racerA: { engine: 'codex', modelId: '', effort: '' },
      racerB: { engine: 'kimi', modelId: '', effort: '' },
      racerC: { engine: 'opencode', modelId: '', effort: '' },
      judge: { engine: 'codex', modelId: '', effort: '' },
      builder: { engine: 'codex', modelId: '', effort: '' },
      auditor: { engine: 'codex', modelId: '', effort: '' },
    },
  },
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
    autoCompactRatio:
      typeof s.autoCompactRatio === 'number' ? Math.max(0, Math.min(100, s.autoCompactRatio)) : DEFAULTS.autoCompactRatio,
    // 存过则以用户的为准（含故意清空），仅剔除缺字段/空白的脏行；
    // 老版本没存过才回填内置 k3 规则。
    contextFallbackRules: Array.isArray(s.contextFallbackRules)
      ? s.contextFallbackRules
          .filter((r): r is ContextFallbackRule => !!r && typeof r.match === 'string' && typeof r.to === 'string')
          .map((r) => ({ match: r.match.trim(), to: r.to.trim() }))
          .filter((r) => r.match && r.to)
      : DEFAULTS.contextFallbackRules,
    notifications: { ...DEFAULTS.notifications, ...(s.notifications ?? {}) },
    workspaces: s.workspaces ?? [],
    routing: { ...DEFAULTS.routing, ...(s.routing ?? {}) },
    opencodeHiddenModels: Array.isArray(s.opencodeHiddenModels)
      ? s.opencodeHiddenModels.filter((x): x is string => typeof x === 'string')
      : [],
    race: {
      enableRacerC: s.race?.enableRacerC ?? DEFAULTS.race.enableRacerC,
      roles: { ...DEFAULTS.race.roles, ...(s.race?.roles ?? {}) },
    },
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
