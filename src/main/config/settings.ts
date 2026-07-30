/**
 * App settings — persisted under userData/settings.json. 自「配置只读 +
 * 路由开关」改版后不再存储任何供应商/密钥：模型端点的唯一真源是
 * CLI 自己的配置文件（~/.kimi-code、~/.codex，只读），这里只保留
 * UI 偏好与每引擎的路由开关。
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppSettings, ContextFallbackRule, EngineId } from '@shared/types';

const ENGINE_IDS: EngineId[] = ['codex', 'opencode', 'kimi', 'omp', 'antigravity'];

/** 引擎顺序消毒：剔非法 id + 去重 + 把缺失引擎补到末尾（新版本
 *  加引擎后老配置自动补全，不会掉项）。 */
function sanitizeEngineOrder(raw: unknown): EngineId[] {
  const stored = Array.isArray(raw)
    ? raw.filter((x): x is EngineId => ENGINE_IDS.includes(x as EngineId))
    : [];
  return [...new Set([...stored, ...ENGINE_IDS])];
}

const DEFAULTS: AppSettings = {
  themeMode: 'light',
  themePalette: 'notion',
  language: 'zh',
  defaultPermissionMode: 'default',
  sendKey: 'enter',
  autoCompactRatio: 90,
  contextFallbackRules: [{ match: 'k3 256k', to: 'k3' }],
  notifications: { taskComplete: true, question: true, error: true },
  titleGen: { mode: 'program', baseUrl: '', apiKey: '', model: '' },
  workspaces: [],
  routing: { kimi: false, codex: false },
  opencodeHiddenModels: [],
  antigravityDefaultModel: '',
  antigravityHiddenModels: [],
  antigravityAutoSwitch: false,
  antigravityQuotaThreshold: 15,
  engineOrder: [...ENGINE_IDS],
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
    titleGen: { ...DEFAULTS.titleGen, ...(s.titleGen ?? {}) },
    workspaces: s.workspaces ?? [],
    routing: { ...DEFAULTS.routing, ...(s.routing ?? {}) },
    opencodeHiddenModels: Array.isArray(s.opencodeHiddenModels)
      ? s.opencodeHiddenModels.filter((x): x is string => typeof x === 'string')
      : [],
    antigravityDefaultModel:
      typeof s.antigravityDefaultModel === 'string' ? s.antigravityDefaultModel : DEFAULTS.antigravityDefaultModel,
    antigravityHiddenModels: Array.isArray(s.antigravityHiddenModels)
      ? s.antigravityHiddenModels.filter((x): x is string => typeof x === 'string')
      : [],
    antigravityAutoSwitch: typeof s.antigravityAutoSwitch === 'boolean' ? s.antigravityAutoSwitch : DEFAULTS.antigravityAutoSwitch,
    antigravityQuotaThreshold:
      typeof s.antigravityQuotaThreshold === 'number'
        ? Math.max(0, Math.min(100, Math.round(s.antigravityQuotaThreshold)))
        : DEFAULTS.antigravityQuotaThreshold,
    engineOrder: sanitizeEngineOrder(s.engineOrder),
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
