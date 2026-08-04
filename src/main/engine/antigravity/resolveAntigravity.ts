/**
 * Locates the Antigravity CLI (`agy`) and produces a spawn spec.
 *
 * agy on Windows is a native exe: the installer registers it at
 * %LOCALAPPDATA%\agy\bin\agy.exe (实测，见 docs/antigravity cli v1.1.8/
 * installation-auth.md) and adds that dir to PATH. agy 升级不一定自动
 * 进 PATH，所以解析优先显式路径 → 安装默认路径 → PATH shim。
 *
 * 模型目录走 `agy models`（两列文本：`slug   Display Name`，见
 * headless-mode.md）；无 --json，逐行解析。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AntigravityCatalog, AntigravityConfigSnapshot, AntigravityModelEntry } from '@shared/types';
import { L } from '../../i18n';
import { log } from '../../log/logger';
import type { SpawnSpec } from '../kimi/resolveKimi';

export function resolveAgyCli(extraArgs: string[], explicitPath?: string): SpawnSpec {
  const candidates = [
    explicitPath,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : undefined,
    process.env.HOME ? join(process.env.HOME, '.local', 'bin', 'agy') : undefined,
  ].filter((p): p is string => !!p);

  for (const bin of candidates) {
    if (existsSync(bin)) return { command: bin, args: extraArgs, label: bin };
  }
  return { command: 'agy', args: extraArgs, label: 'agy (PATH)', shell: true };
}

export function findAgyBinary(explicitPath?: string): string | undefined {
  const spec = resolveAgyCli([], explicitPath);
  return spec.shell ? undefined : spec.command;
}

let cachedVersion: string | null | undefined; // undefined=未探测 null=失败
let failedAt = 0; // 失败只缓存短期（应用先启动、CLI 后安装的场景无需重启即可检出）
const PROBE_FAIL_TTL = 30_000;
function probeVersion(explicitPath?: string): string | undefined {
  if (typeof cachedVersion === 'string') return cachedVersion;
  if (cachedVersion === null && Date.now() - failedAt < PROBE_FAIL_TTL) return undefined;
  try {
    const spec = resolveAgyCli(['--version'], explicitPath);
    const res = spawnSync(spec.command, spec.args, {
      shell: spec.shell ?? false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8_000,
    });
    // 输出形如 `1.1.8`。
    const m = (res.stdout ?? '').trim().match(/(\d+\.\d+\.\d+)/);
    cachedVersion = m ? m[1] : null;
  } catch {
    cachedVersion = null;
  }
  if (cachedVersion === null) failedAt = Date.now();
  return cachedVersion ?? undefined;
}

/** goal 模式(/goal 斜杠命令)可用性的版本门:print 模式的斜杠命令/技能
 *  展开是 1.1.9 加的(changelog:「slash-command and skill expansion to
 *  print mode」),更早版本 `-p "/goal …"` 会把命令当纯文本发送。
 *  探测失败返回 true(不剥夺能力)——旧版最坏只是 /goal 当文本发、无强制
 *  续跑,无害降级;probe 本身有 8s 超时与 30s 失败 TTL,不会反复阻塞。 */
export function agySupportsGoalCommand(explicitPath?: string): boolean {
  const v = probeVersion(explicitPath);
  if (!v) return true;
  const [maj = 0, min = 0, patch = 0] = v.split('.').map((p) => Number(p) || 0);
  return maj > 1 || (maj === 1 && min > 1) || (maj === 1 && min === 1 && patch >= 9);
}

/** 静态只读快照（设置页展示用）：CLI 安装状态/版本 + keyring/账号池存在性。永不写入。 */
export function readAntigravitySnapshot(explicitPath?: string): AntigravityConfigSnapshot {
  const snap: AntigravityConfigSnapshot = { installed: false };
  try {
    const spec = resolveAgyCli([], explicitPath);
    const version = probeVersion(explicitPath);
    snap.installed = version !== undefined;
    snap.version = version;
    snap.cliPath = spec.shell ? undefined : spec.command;
    // cockpit 账号池目录存在性（账号切换的凭据来源，见 agyAccounts.ts）。
    const cockpit = join(homedir(), '.antigravity_cockpit', 'accounts');
    snap.configPath = cockpit;
    snap.configExists = existsSync(cockpit);
  } catch (err) {
    snap.error = err instanceof Error ? err.message : String(err);
  }
  return snap;
}

/** 拉取模型目录（`agy models`，两列文本）。失败/未认证返回空目录 + error。 */
export function fetchAntigravityCatalog(explicitPath?: string): Promise<AntigravityCatalog> {
  return new Promise((resolve) => {
    const spec = resolveAgyCli(['models'], explicitPath);
    const child = spawn(spec.command, spec.args, {
      shell: spec.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (err += d));
    const fail = (msg: string, err?: unknown): void => {
      log.warn('engine.antigravity', 'fetch model catalog failed', { detail: msg }, err);
      resolve({ models: [], error: msg });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      fail(L('agy models 超时', 'agy models timed out'));
    }, 30_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      fail(`${L('无法运行 agy CLI', 'Failed to run the agy CLI')}: ${e.message}`, e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const models = parseModelsText(out);
      if (models.length) resolve({ models });
      else fail(err.trim().slice(0, 300) || L('模型目录解析失败（可能未认证）', 'Failed to parse the model catalog (possibly unauthenticated)'));
    });
  });
}

/** 解析 `agy models` 两列文本：每行 `slug<空白>Display Name`。 */
function parseModelsText(text: string): AntigravityModelEntry[] {
  const out: AntigravityModelEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === '...') continue;
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m) {
      // 单列（只有 slug）也接受。
      if (/^[\w.-]+$/.test(line)) out.push({ slug: line });
      continue;
    }
    const slug = m[1];
    if (!slug || !/^[\w.-]+$/.test(slug)) continue; // 跳过表头/杂项行
    const displayName = m[2]?.trim();
    out.push({ slug, displayName: displayName || undefined });
  }
  return out;
}
