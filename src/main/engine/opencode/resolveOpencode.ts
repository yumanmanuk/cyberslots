/**
 * Locates the opencode CLI (native bun-compiled exe, no Node wrapper
 * needed) and provides the static read-only config snapshot.
 *
 * Resolution order: explicit settings path → npm global install exe →
 * PATH shim (shell). 探针实测：npm 全局包 opencode-ai 的 bin 下是原生
 * opencode.exe，可直接 spawn，无 .cmd 包装问题。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { OpencodeConfigSnapshot } from '@shared/types';

export interface OpencodeSpawnSpec {
  command: string;
  args: string[];
  label: string;
  shell?: boolean;
}

/** 全局 npm 安装的原生 exe 候选路径（Windows）。 */
function globalExeCandidates(): string[] {
  const out: string[] = [];
  if (process.env.APPDATA) {
    out.push(join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
  }
  return out;
}

export function resolveOpencodeCli(extraArgs: string[], explicitEntry?: string): OpencodeSpawnSpec {
  const candidates = [explicitEntry, ...globalExeCandidates()].filter((p): p is string => !!p);
  for (const exe of candidates) {
    if (existsSync(exe)) {
      return { command: exe, args: extraArgs, label: exe };
    }
  }
  // PATH 兜底（shell 解析 opencode / opencode.cmd）。
  return { command: 'opencode', args: extraArgs, label: 'opencode (PATH)', shell: true };
}

/** CLI 是否可定位（不 spawn，纯文件存在性 + PATH 探测缓存）。 */
export function opencodeInstalled(): boolean {
  if (globalExeCandidates().some((p) => existsSync(p))) return true;
  return probeVersion() !== undefined;
}

// 版本探测走 spawnSync（bun 原生 exe，~百 ms 级），进程级缓存一次。
let cachedVersion: string | null | undefined; // undefined = 未探测；null = 探测失败
function probeVersion(): string | undefined {
  if (cachedVersion !== undefined) return cachedVersion ?? undefined;
  try {
    const spec = resolveOpencodeCli(['--version']);
    const res = spawnSync(spec.command, spec.args, {
      shell: spec.shell ?? false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5_000,
    });
    const v = (res.stdout ?? '').trim();
    cachedVersion = /^\d+\.\d+/.test(v) ? v : null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion ?? undefined;
}

/** 静态只读快照（不启动 server）：CLI 安装状态/版本/全局配置文件存在性。 */
export function readOpencodeSnapshot(): OpencodeConfigSnapshot {
  const snap: OpencodeConfigSnapshot = { installed: false };
  try {
    const spec = resolveOpencodeCli([]);
    const version = probeVersion();
    snap.installed = version !== undefined;
    snap.version = version;
    snap.cliPath = spec.shell ? undefined : spec.command;
    // 全局 opencode.json（~/.config/opencode）— 仅展示，永不写入。
    const cfgDir = join(homedir(), '.config', 'opencode');
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const p = join(cfgDir, name);
      if (existsSync(p)) {
        snap.configPath = p;
        snap.configExists = true;
        break;
      }
    }
    if (!snap.configPath) {
      snap.configPath = join(cfgDir, 'opencode.json');
      snap.configExists = false;
    }
  } catch (err) {
    snap.error = err instanceof Error ? err.message : String(err);
  }
  return snap;
}
