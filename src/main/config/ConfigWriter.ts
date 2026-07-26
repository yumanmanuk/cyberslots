/**
 * ConfigWriter — projects app settings into engine config files inside
 * app-managed home dirs (userData/kimi-home, userData/codex-home).
 * Because the homes are app-owned (not the user's ~/.kimi-code or
 * ~/.codex), we can regenerate whole files safely; the user's own CLI
 * setups are never touched.
 */

import { stringify as tomlStringify } from 'smol-toml';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppSettings } from '@shared/types';

export class ConfigWriter {
  constructor(
    private readonly kimiHome: string,
    private readonly codexHome: string,
  ) {}

  get home(): string {
    return this.kimiHome;
  }

  get codexHomeDir(): string {
    return this.codexHome;
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

  /**
   * (Re)generate the codex config.toml. codex only speaks the Responses
   * wire API, so its sole provider is the embedded ai-server proxy on
   * 127.0.0.1 — codex never sees a real key (routing hides in the model
   * name). Must be called after the proxy port is known, before spawn.
   */
  syncCodex(settings: AppSettings, proxyPort: number): string {
    const doc: Record<string, unknown> = {
      model_provider: 'cyberslots',
      model: settings.defaultModelId || 'MiniMax-M3',
      model_providers: {
        cyberslots: {
          name: 'CyberSlots 内置代理',
          base_url: `http://127.0.0.1:${proxyPort}/v1`,
          wire_api: 'responses',
        },
      },
      projects: {},
    };
    mkdirSync(this.codexHome, { recursive: true });
    const path = join(this.codexHome, 'config.toml');
    const header = '# Managed by CyberSlots — regenerated on every proxy (re)start.\n';
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
