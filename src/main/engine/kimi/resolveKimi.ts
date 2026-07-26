/**
 * Locates the kimi CLI and produces a spawn spec that works on Windows
 * without shell shims (PowerShell execution policy blocks .ps1; .cmd
 * needs shell=true since Node 20.12). Strategy proven in phase 0:
 * run the CLI's ESM entry directly with our own Node/Electron binary.
 *
 * Resolution order: explicit settings path → npm global install → PATH shim.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Human-readable description for logs/diagnostics. */
  label: string;
  shell?: boolean;
}

export function resolveKimiCli(extraArgs: string[], explicitEntry?: string): SpawnSpec {
  // ELECTRON_RUN_AS_NODE lets the Electron binary act as plain Node for
  // child entrypoints; process.execPath works both in dev (node) and
  // packaged (electron.exe) contexts.
  const candidates = [
    explicitEntry,
    process.env.APPDATA
      ? join(process.env.APPDATA, 'npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs')
      : undefined,
  ].filter((p): p is string => !!p);

  for (const entry of candidates) {
    if (existsSync(entry)) {
      return { command: process.execPath, args: [entry, ...extraArgs], label: `node ${entry}` };
    }
  }
  // Last resort — PATH shim via shell (works when npm bin dir is on PATH).
  return { command: 'kimi', args: extraArgs, label: 'kimi (PATH)', shell: true };
}

/** Env for spawned kimi processes: run Electron binary as Node.
 *  kimiHome 仅在路由开启时传入（镜像 home）；不传则不设
 *  KIMI_CODE_HOME → kimi 用自己的 ~/.kimi-code（用户配置直连）。 */
export function kimiSpawnEnv(kimiHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (kimiHome) env.KIMI_CODE_HOME = kimiHome;
  else delete env.KIMI_CODE_HOME;
  return env;
}
