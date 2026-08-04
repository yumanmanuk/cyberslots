/**
 * Locates the omp (oh-my-pi) CLI and produces a spawn spec.
 *
 * omp on Windows is a native single exe (installer puts it at
 * %LOCALAPPDATA%\omp\omp.exe and adds it to PATH) — no bun/node
 * runtime needed, so unlike kimi we never route through our own
 * Node binary (probe-omp-findings §1).
 *
 * Resolution order: explicit settings path → installer default → PATH.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { OmpCatalog, OmpConfigSnapshot, OmpModelEntry } from '@shared/types';
import { L } from '../../i18n';
import { log } from '../../log/logger';
import type { SpawnSpec } from '../kimi/resolveKimi';

export function resolveOmpCli(extraArgs: string[], explicitPath?: string): SpawnSpec {
  const candidates = [
    explicitPath,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'omp', 'omp.exe') : undefined,
    process.env.HOME ? join(process.env.HOME, '.local', 'bin', 'omp') : undefined,
  ].filter((p): p is string => !!p);

  for (const bin of candidates) {
    if (existsSync(bin)) {
      return { command: bin, args: extraArgs, label: bin };
    }
  }
  // Last resort — PATH shim via shell.
  return { command: 'omp', args: extraArgs, label: 'omp (PATH)', shell: true };
}

/** omp CLI 安装位置探测（设置页快照用；找不到返回 undefined）。 */
export function findOmpBinary(explicitPath?: string): string | undefined {
  const spec = resolveOmpCli([], explicitPath);
  return spec.shell ? undefined : spec.command;
}

// 版本探测走 spawnSync（原生 exe，~百 ms 级），成功结果进程级缓存一次。
let cachedVersion: string | null | undefined; // undefined = 未探测；null = 探测失败
let failedAt = 0; // 失败只缓存短期（应用先启动、CLI 后安装的场景无需重启即可检出）
const PROBE_FAIL_TTL = 30_000;
function probeVersion(explicitPath?: string): string | undefined {
  if (typeof cachedVersion === 'string') return cachedVersion;
  if (cachedVersion === null && Date.now() - failedAt < PROBE_FAIL_TTL) return undefined;
  try {
    const spec = resolveOmpCli(['--version'], explicitPath);
    const res = spawnSync(spec.command, spec.args, {
      shell: spec.shell ?? false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8_000,
    });
    // 输出形如 `omp/17.1.8`（probe-omp-findings §1）。
    const m = (res.stdout ?? '').trim().match(/omp\/(\S+)/);
    cachedVersion = m ? m[1] : null;
  } catch {
    cachedVersion = null;
  }
  if (cachedVersion === null) failedAt = Date.now();
  return cachedVersion ?? undefined;
}

/** 静态只读快照（不进会话）：CLI 安装状态/版本/~/.omp 存在性。永不写入。 */
export function readOmpSnapshot(explicitPath?: string): OmpConfigSnapshot {
  const snap: OmpConfigSnapshot = { installed: false };
  try {
    const spec = resolveOmpCli([], explicitPath);
    const version = probeVersion(explicitPath);
    snap.installed = version !== undefined;
    snap.version = version;
    snap.cliPath = spec.shell ? undefined : spec.command;
    const agentDir = join(homedir(), '.omp', 'agent');
    snap.configPath = agentDir;
    snap.configExists = existsSync(agentDir);
  } catch (err) {
    snap.error = err instanceof Error ? err.message : String(err);
  }
  return snap;
}

/** 拉取模型目录（`omp models --json`）并归一化。无凭据时目录为空
 *  （probe-omp-findings §4）— 调用方用「引擎默认」兑底。兼容多种
 *  输出形态（数组 / {models} / {providers:{models}}），字段宽松解析。 */
export function fetchOmpCatalog(explicitPath?: string): Promise<OmpCatalog> {
  return new Promise((resolve) => {
    const spec = resolveOmpCli(['models', '--json', '--no-extensions'], explicitPath);
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
      log.warn('engine.omp', 'fetch model catalog failed', { detail: msg }, err);
      resolve({ models: [], error: msg });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      fail(L('omp models --json 超时', 'omp models --json timed out'));
    }, 30_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      fail(`${L('无法运行 omp CLI', 'Failed to run the omp CLI')}: ${e.message}`, e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve({ models: normalizeCatalog(JSON.parse(out)) });
      } catch {
        fail(err.trim().slice(0, 300) || L('模型目录解析失败（可能未登录/无凭据）', 'Failed to parse the model catalog (possibly not logged in / no credentials)'));
      }
    });
  });
}

type Json = Record<string, unknown>;

function normalizeCatalog(parsed: unknown): OmpModelEntry[] {
  const out: OmpModelEntry[] = [];
  const push = (m: Json, providerHint?: string): void => {
    // 实测字段（17.1.8）：provider/id/selector/name/contextWindow/reasoning/
    // thinking[]/cost{input,output}；selector 即 spawn --model 参数值。
    const selector = str(m.selector);
    const rawId = selector ?? str(m.id) ?? str(m.slug) ?? str(m.model) ?? '';
    if (!rawId) return;
    const provider =
      str(m.provider) ?? str(m.providerID) ?? providerHint ?? (rawId.includes('/') ? rawId.split('/')[0] ?? '' : '');
    const bareId = str(m.id) ?? (rawId.includes('/') ? rawId.slice(rawId.indexOf('/') + 1) : rawId);
    const slug = selector ?? (rawId.includes('/') ? rawId : provider ? `${provider}/${rawId}` : rawId);
    const cost = m.cost as Json | undefined;
    const thinking = Array.isArray(m.thinking) ? (m.thinking as unknown[]).map(String).filter(Boolean) : undefined;
    out.push({
      slug,
      provider,
      providerName: str(m.providerName) ?? str(m.providerLabel),
      modelID: bareId,
      displayName: str(m.name) ?? str(m.displayName),
      contextWindow: num(m.contextWindow) ?? num(m.context_window),
      reasoning: bool(m.reasoning),
      efforts: thinking?.length ? thinking : undefined,
      subscription: bool(m.subscription) ?? bool(m.plan),
      costInput: num(cost?.input) ?? num(m.costInput),
      costOutput: num(cost?.output) ?? num(m.costOutput),
    });
  };
  if (Array.isArray(parsed)) {
    for (const m of parsed as Json[]) push(m);
  } else if (parsed && typeof parsed === 'object') {
    const doc = parsed as Json;
    if (Array.isArray(doc.models)) {
      for (const m of doc.models as Json[]) push(m);
    } else if (doc.providers && typeof doc.providers === 'object') {
      for (const [pid, p] of Object.entries(doc.providers as Record<string, Json>)) {
        const models = (p.models ?? {}) as Record<string, Json> | Json[];
        if (Array.isArray(models)) {
          for (const m of models) push(m, pid);
        } else {
          for (const [mid, m] of Object.entries(models)) push({ id: mid, ...m }, pid);
        }
      }
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
