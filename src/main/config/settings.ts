/**
 * App settings — persisted under userData/settings.json. API keys are
 * encrypted at rest via Electron safeStorage when the OS keychain is
 * available (DPAPI on Windows); a `plaintext` marker records fallback.
 *
 * Dev convenience: on first run, if `<repo>/.dev/secrets.json` exists
 * (gitignored), providers are seeded from it so the app talks to real
 * models immediately without retyping keys.
 */

import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppSettings, ProviderSettings } from '@shared/types';

interface StoredProvider extends Omit<ProviderSettings, 'apiKey'> {
  apiKeyEnc?: string; // base64(safeStorage)
  apiKeyPlain?: string; // fallback when encryption unavailable
}

interface StoredSettings extends Omit<AppSettings, 'providers'> {
  providers: StoredProvider[];
}

const DEFAULTS: AppSettings = {
  providers: [],
  defaultModelId: '',
  theme: 'notion',
  defaultPermissionMode: 'default',
  sendKey: 'enter',
};

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
        const stored = JSON.parse(readFileSync(this.file, 'utf8')) as StoredSettings;
        settings = { ...DEFAULTS, ...stored, providers: stored.providers.map(decryptProvider) };
      } catch (err) {
        console.error('[settings] failed to read settings.json, using defaults:', err);
      }
    }
    if (settings.providers.length === 0) {
      const seeded = seedFromDevSecrets();
      if (seeded) {
        settings.providers = seeded.providers;
        settings.defaultModelId = seeded.defaultModelId;
        this.persist(settings);
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
    const stored: StoredSettings = {
      ...settings,
      providers: settings.providers.map(encryptProvider),
    };
    writeFileSync(this.file, JSON.stringify(stored, null, 2), 'utf8');
  }
}

function encryptProvider(p: ProviderSettings): StoredProvider {
  const { apiKey, ...rest } = p;
  if (apiKey && safeStorage.isEncryptionAvailable()) {
    return { ...rest, apiKeyEnc: safeStorage.encryptString(apiKey).toString('base64') };
  }
  return { ...rest, apiKeyPlain: apiKey };
}

function decryptProvider(p: StoredProvider): ProviderSettings {
  const { apiKeyEnc, apiKeyPlain, ...rest } = p;
  let apiKey = apiKeyPlain ?? '';
  if (apiKeyEnc) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(apiKeyEnc, 'base64'));
    } catch (err) {
      console.error(`[settings] failed to decrypt key for provider ${p.id}:`, err);
    }
  }
  return { ...rest, apiKey };
}

function seedFromDevSecrets(): Pick<AppSettings, 'providers' | 'defaultModelId'> | undefined {
  try {
    // In dev, app.getAppPath() is the project root.
    const secretsPath = join(app.getAppPath(), '.dev', 'secrets.json');
    if (!existsSync(secretsPath)) return undefined;
    const raw = JSON.parse(readFileSync(secretsPath, 'utf8')) as Record<
      string,
      { baseUrl: string; apiKey: string; model: string; maxContextSize: number; userAgent?: string }
    >;
    const providers: ProviderSettings[] = Object.entries(raw).map(([id, v]) => ({
      id,
      baseUrl: v.baseUrl,
      apiKey: v.apiKey,
      models: [{ alias: v.model, model: v.model, maxContextSize: v.maxContextSize }],
      ...(v.userAgent ? { customHeaders: { 'User-Agent': v.userAgent } } : {}),
    }));
    // MiniMax is the verified-working provider for now (phase0 findings).
    const defaultModelId = raw['minimax']?.model ?? providers[0]?.models[0]?.alias ?? '';
    console.log('[settings] seeded providers from .dev/secrets.json');
    return { providers, defaultModelId };
  } catch (err) {
    console.error('[settings] dev secrets seed failed:', err);
    return undefined;
  }
}
