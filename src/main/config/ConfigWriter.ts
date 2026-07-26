/**
 * ConfigWriter — projects app settings into the kimi CLI's config.toml
 * inside an app-managed KIMI_CODE_HOME (userData/kimi-home). Because the
 * home dir is app-owned (not the user's ~/.kimi-code), we can regenerate
 * the whole file safely; the user's own kimi setup is never touched.
 */

import { stringify as tomlStringify } from 'smol-toml';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppSettings } from '@shared/types';

export class ConfigWriter {
  constructor(private readonly kimiHome: string) {}

  get home(): string {
    return this.kimiHome;
  }

  /** (Re)generate config.toml from settings; returns the config path. */
  sync(settings: AppSettings): string {
    const providers: Record<string, unknown> = {};
    const models: Record<string, unknown> = {};

    for (const p of settings.providers) {
      providers[p.id] = {
        type: 'openai',
        base_url: p.baseUrl,
        api_key: p.apiKey,
      };
      for (const m of p.models) {
        models[m.alias] = {
          provider: p.id,
          model: m.model,
          max_context_size: m.maxContextSize,
        };
      }
    }

    const doc: Record<string, unknown> = { providers, models };
    if (settings.defaultModelId) doc.default_model = settings.defaultModelId;

    mkdirSync(this.kimiHome, { recursive: true });
    const path = join(this.kimiHome, 'config.toml');
    const header = '# Managed by CyberSlots — regenerated on every settings change.\n';
    writeFileSync(path, header + tomlStringify(doc) + '\n', 'utf8');
    return path;
  }
}
