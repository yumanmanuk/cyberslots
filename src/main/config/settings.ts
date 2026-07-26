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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppSettings, ProviderSettings } from '@shared/types';

interface StoredProvider extends Omit<ProviderSettings, 'apiKey'> {
  apiKeyEnc?: string; // base64(safeStorage)
  apiKeyPlain?: string; // fallback when encryption unavailable
}

interface StoredSettings extends Omit<AppSettings, 'providers'> {
  providers: StoredProvider[];
  /** Hash of .dev/secrets.json at seed time — reseed when it changes (dev only). */
  devSeedHash?: string;
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
  private devSeedHash: string | undefined;

  constructor(private readonly dir = app.getPath('userData')) {}

  private get file(): string {
    return join(this.dir, 'settings.json');
  }

  get(): AppSettings {
    if (this.cached) return this.cached;
    let settings = { ...DEFAULTS };
    let storedHash: string | undefined;
    if (existsSync(this.file)) {
      try {
        const stored = JSON.parse(readFileSync(this.file, 'utf8')) as StoredSettings;
        settings = { ...DEFAULTS, ...stored, providers: stored.providers.map(decryptProvider) };
        storedHash = stored.devSeedHash;
      } catch (err) {
        console.error('[settings] failed to read settings.json, using defaults:', err);
      }
    }
    // Dev reseed: whenever .dev/secrets.json changes, it wins — stale seeded
    // providers caused real confusion during testing (wrong endpoint/model).
    const seed = seedFromDevSecrets();
    if (seed && (settings.providers.length === 0 || storedHash !== seed.hash)) {
      settings.providers = seed.providers;
      settings.defaultModelId = seed.defaultModelId;
      this.devSeedHash = seed.hash;
      this.persist(settings);
      console.log('[settings] providers (re)seeded from .dev/secrets.json');
    } else {
      this.devSeedHash = storedHash;
    }
    this.cached = settings;
    return settings;
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const current = this.get();
    const next = { ...current, ...patch };
    // The renderer only ever sees masked keys ("sk-xxxx…abcd"). If a patch
    // carries a masked/empty key, keep the stored secret for that provider.
    if (patch.providers) {
      next.providers = patch.providers.map((p) => {
        const old = current.providers.find((o) => o.id === p.id);
        const masked = !p.apiKey || p.apiKey.includes('…');
        return masked && old ? { ...p, apiKey: old.apiKey } : p;
      });
    }
    this.persist(next);
    this.cached = next;
    return next;
  }

  private persist(settings: AppSettings): void {
    mkdirSync(this.dir, { recursive: true });
    const stored: StoredSettings = {
      ...settings,
      providers: settings.providers.map(encryptProvider),
      devSeedHash: this.devSeedHash,
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

function seedFromDevSecrets():
  | (Pick<AppSettings, 'providers' | 'defaultModelId'> & { hash: string })
  | undefined {
  try {
    // In dev, app.getAppPath() is the project root.
    const secretsPath = join(app.getAppPath(), '.dev', 'secrets.json');
    if (!existsSync(secretsPath)) return undefined;
    const rawText = readFileSync(secretsPath, 'utf8');
    const raw = JSON.parse(rawText) as Record<
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
    const hash = createHash('sha256').update(rawText).digest('hex').slice(0, 16);
    return { providers, defaultModelId, hash };
  } catch (err) {
    console.error('[settings] dev secrets seed failed:', err);
    return undefined;
  }
}
