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
      const provider: Record<string, unknown> = {
        type: 'openai',
        base_url: p.baseUrl,
        api_key: p.apiKey,
      };
      // Coding-plan endpoints (e.g. api.kimi.com/coding) enforce a
      // User-Agent allowlist; merge any provider-level custom headers so
      // the spawned engine passes them through (kosong `custom_headers`).
      const headers = { ...effectiveHeaders(p) };
      if (Object.keys(headers).length > 0) provider.custom_headers = headers;
      providers[p.id] = provider;
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

/** Known coding-plan hosts that gate access behind a UA allowlist. */
const CODING_PLAN_UA = 'claude-cli/2.1.161 (external, cli)';
const CODING_PLAN_HOST_RE = /api\.kimi\.com\/coding/i;

/** Merge explicit custom headers with an auto-injected UA for gated hosts. */
function effectiveHeaders(p: { baseUrl: string; customHeaders?: Record<string, string> }): Record<string, string> {
  const headers: Record<string, string> = { ...(p.customHeaders ?? {}) };
  if (CODING_PLAN_HOST_RE.test(p.baseUrl) && !headers['User-Agent']) {
    headers['User-Agent'] = CODING_PLAN_UA;
  }
  return headers;
}
