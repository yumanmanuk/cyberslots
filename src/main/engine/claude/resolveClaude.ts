/**
 * Locates the Claude Code CLI (`claude`) and produces a spawn spec.
 *
 * Claude Code 在 Windows 上多为 npm 全局安装（APPDATA\npm\claude.cmd +
 * node_modules\@anthropic-ai\claude-code\cli.js）或 native 安装
 * (`claude install`) 落 %LOCALAPPDATA%\Programs 或用户自定义目录并入 PATH。
 * 解析优先：显式路径 → npm 全局 cli.js（用自带 Node 直跑，绕开 .cmd shim）
 * → PATH shim（claude，shell=true — .cmd 在 Node 20.12+ 需 shell）。
 *
 * 认证真源是 CLI 自身（`claude login` 的 OAuth token 存 keychain，或
 * ANTHROPIC_API_KEY 环境变量）；本程序永不读写凭据，只静态探测布尔态。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ClaudeConfigSnapshot } from '@shared/types';
import type { SpawnSpec } from '../kimi/resolveKimi';

/** 判定入口是否为 JS 脚本（需用 Node 直跑）。 */
function isJsEntry(p: string): boolean {
  return /\.(mjs|cjs|js)$/i.test(p);
}

export function resolveClaudeCli(extraArgs: string[], explicitEntry?: string): SpawnSpec {
  // npm 全局包入口（用自带 Electron/Node 作为 Node 跑，避开 .cmd shim 的
  // 控制台闪窗与 PATH 依赖）。
  const npmCli = process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    : undefined;

  // 用户自定义启动命令/路径（设置页）— 一旦非空就优先且始终采纳，
  // 不再回落自动探测（否则用户会困惑为何设了却没生效）。
  const custom = explicitEntry?.trim();
  if (custom) {
    // 1) 已存在的文件路径：JS 脚本走 Node，.cmd/.bat 走 shell，其余（.exe/native）直跑。
    if (existsSync(custom)) {
      if (isJsEntry(custom)) {
        return { command: process.execPath, args: [custom, ...extraArgs], label: `node ${custom}` };
      }
      const needsShell = /\.(cmd|bat)$/i.test(custom);
      return { command: custom, args: extraArgs, label: custom, shell: needsShell };
    }
    // 2) 非现有文件：当作 PATH 上的命令名（如 `cc`、`cc.cmd`），经 shell 解析。
    //    注：shell 别名（PowerShell Set-Alias / bash alias）不是可执行文件，
    //    spawn/cmd.exe 无法解析 — 需用真实可执行文件/shim 或完整路径。
    return { command: custom, args: extraArgs, label: `${custom} (custom)`, shell: true };
  }

  if (npmCli && existsSync(npmCli)) {
    return { command: process.execPath, args: [npmCli, ...extraArgs], label: `node ${npmCli}` };
  }

  // native 安装的常见落点（用户级）。
  const nativeCandidates = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe') : undefined,
    process.env.HOME ? join(process.env.HOME, '.local', 'bin', 'claude') : undefined,
    join(homedir(), '.local', 'bin', 'claude'),
  ].filter((p): p is string => !!p);
  for (const bin of nativeCandidates) {
    if (existsSync(bin)) return { command: bin, args: extraArgs, label: bin };
  }

  // 兑底：PATH shim（claude / claude.cmd）。shell=true 让 Windows 正确解析 .cmd。
  return { command: 'claude', args: extraArgs, label: 'claude (PATH)', shell: true };
}

/** Env for spawned claude processes.
 *  用自带 Node 跑 cli.js 时需 ELECTRON_RUN_AS_NODE=1；PATH shim/native 模式
 *  跑的是独立进程（系统 Node / 原生二进制），不设该变量以免污染其子进程环境。 */
export function claudeSpawnEnv(spec: SpawnSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (spec.command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

let cachedVersion: string | null | undefined; // undefined=未探测 null=失败
let failedAt = 0; // 失败只缓存短期（应用先启动、CLI 后安装的场景无需重启即可检出）
let probedEntry: string | undefined; // 上次探测的入口 — 自定义命令变化时自动重探
const PROBE_FAIL_TTL = 30_000;

function probeVersion(explicitEntry?: string): string | undefined {
  const entryKey = explicitEntry?.trim() || '';
  // 自定义启动命令改变 → 旧缓存作废，重新探测（否则设置改了也不生效）。
  if (entryKey !== probedEntry) {
    cachedVersion = undefined;
    failedAt = 0;
    probedEntry = entryKey;
  }
  if (typeof cachedVersion === 'string') return cachedVersion;
  if (cachedVersion === null && Date.now() - failedAt < PROBE_FAIL_TTL) return undefined;
  try {
    const spec = resolveClaudeCli(['--version'], explicitEntry);
    const res = spawnSync(spec.command, spec.args, {
      shell: spec.shell ?? false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      env: claudeSpawnEnv(spec),
    });
    // 输出形如 `2.1.220 (Claude Code)`。
    const m = (res.stdout ?? '').trim().match(/(\d+\.\d+\.\d+)/);
    cachedVersion = m ? m[1] : null;
  } catch {
    cachedVersion = null;
  }
  if (cachedVersion === null) failedAt = Date.now();
  return cachedVersion ?? undefined;
}

/** 探测登录/认证方式：优先看 ANTHROPIC_API_KEY 环境变量（apikey），
 *  否则调 `claude auth status`（返回 JSON {loggedIn, authMethod}）。
 *  auth 子命令是较新版本才有，解析失败一律回落 none（不阻塞）。 */
function probeAuth(explicitEntry?: string): { loggedIn: boolean; authMethod: 'oauth' | 'apikey' | 'none' } {
  if (process.env.ANTHROPIC_API_KEY) return { loggedIn: true, authMethod: 'apikey' };
  try {
    const spec = resolveClaudeCli(['auth', 'status'], explicitEntry);
    const res = spawnSync(spec.command, spec.args, {
      shell: spec.shell ?? false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      env: claudeSpawnEnv(spec),
    });
    const out = (res.stdout ?? '').trim();
    // 尽力从输出里抠出 JSON 段（老版本可能夹带其它行）。
    const jsonStart = out.indexOf('{');
    if (jsonStart >= 0) {
      const parsed = JSON.parse(out.slice(jsonStart)) as { loggedIn?: boolean; authMethod?: string };
      if (parsed.loggedIn) {
        const oauth = String(parsed.authMethod ?? '').toLowerCase().includes('oauth');
        return { loggedIn: true, authMethod: oauth ? 'oauth' : 'apikey' };
      }
    }
    // 无 JSON 但退出码 0 且输出含 logged in 字样 → 视为已登录（oauth）。
    if (res.status === 0 && /logged\s*in|authenticated/i.test(out)) return { loggedIn: true, authMethod: 'oauth' };
  } catch {
    /* auth 探测失败 — 回落 none */
  }
  return { loggedIn: false, authMethod: 'none' };
}

/** 读 ~/.claude/settings.json 的 env 段，推导「别名 → 自定义模型显示名」。
 *  第三方网关用户常用 ANTHROPIC_DEFAULT_SONNET/OPUS/HAIKU_MODEL 把别名重定向到
 *  自定义模型（可配套 …_MODEL_NAME 友好名），ANTHROPIC_MODEL 则决定 default 档。
 *  这里只读展示名不参与 spawn — 模型路由仍由 CLI 自身按 env 生效。 */
function readModelLabels(): Record<string, string> | undefined {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8');
    // PowerShell 写的 settings.json 常带 UTF-8 BOM — JSON.parse 会直接报错，先剥掉。
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as { env?: Record<string, string | undefined> };
    // settings.json env 覆盖进程环境变量（与 CLI 自身生效顺序一致）。
    const env: Record<string, string | undefined> = { ...process.env, ...parsed.env };
    const labels: Record<string, string> = {};
    const aliasKeys: Array<[string, string]> = [['sonnet', 'SONNET'], ['opus', 'OPUS'], ['haiku', 'HAIKU']];
    for (const [alias, key] of aliasKeys) {
      const model = env[`ANTHROPIC_DEFAULT_${key}_MODEL`];
      // 映射回别名自身（如 haiku→haiku）= 未自定义，不覆盖。
      if (model && model !== alias) labels[alias] = env[`ANTHROPIC_DEFAULT_${key}_MODEL_NAME`] || model;
    }
    const def = env.ANTHROPIC_MODEL;
    if (def) {
      // default 档若与某别名指向同一模型，复用其友好名。
      const hit = aliasKeys.find(([alias, key]) => def === alias || def === env[`ANTHROPIC_DEFAULT_${key}_MODEL`]);
      labels.default = (hit && labels[hit[0]]) || def;
    }
    return Object.keys(labels).length ? labels : undefined;
  } catch {
    return undefined; // 无 settings.json / 解析失败 → 回落内置别名展示
  }
}

/** 静态只读快照（设置页展示用）：CLI 安装状态/版本 + 登录布尔态。永不写入。 */
export function readClaudeSnapshot(explicitEntry?: string): ClaudeConfigSnapshot {
  const snap: ClaudeConfigSnapshot = { installed: false };
  try {
    const spec = resolveClaudeCli([], explicitEntry);
    const version = probeVersion(explicitEntry);
    snap.installed = version !== undefined;
    snap.version = version;
    // cliPath 展示：Node 跑 cli.js → 脚本路径；非 shell 直跑 → 命令；
    // shell 模式（.cmd/自定义命令名）→ 显示原始命令供诊断。
    snap.cliPath =
      spec.command === process.execPath ? spec.args[0] : spec.shell ? explicitEntry?.trim() || spec.command : spec.command;
    snap.modelLabels = readModelLabels();
    if (snap.installed) {
      const auth = probeAuth(explicitEntry);
      snap.loggedIn = auth.loggedIn;
      snap.authMethod = auth.authMethod;
    }
  } catch (err) {
    snap.error = err instanceof Error ? err.message : String(err);
  }
  return snap;
}

/** 测试/重探用：清版本缓存。 */
export function resetClaudeProbeCache(): void {
  cachedVersion = undefined;
}
