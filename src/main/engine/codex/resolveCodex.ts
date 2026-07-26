/**
 * Locates the codex CLI (npm global install) and produces a spawn spec.
 * Same strategy as resolveKimi: run the JS launcher with our own
 * Node/Electron binary to dodge Windows .ps1/.cmd shim issues.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SpawnSpec } from '../kimi/resolveKimi';

export function resolveCodexCli(extraArgs: string[], explicitEntry?: string): SpawnSpec {
  const candidates = [
    explicitEntry,
    process.env.APPDATA
      ? join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      : undefined,
  ].filter((p): p is string => !!p);

  for (const entry of candidates) {
    if (existsSync(entry)) {
      return { command: process.execPath, args: [entry, ...extraArgs], label: `node ${entry}` };
    }
  }
  return { command: 'codex', args: extraArgs, label: 'codex (PATH)', shell: true };
}

/** Env for spawned codex processes: Electron-as-Node + app-owned CODEX_HOME. */
export function codexSpawnEnv(codexHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    CODEX_HOME: codexHome,
  };
}
