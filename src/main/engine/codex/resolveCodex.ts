/**
 * Locates the codex CLI (npm global install) and produces a spawn spec.
 * Same strategy as resolveKimi: run the JS launcher with our own
 * Node/Electron binary to dodge Windows .ps1/.cmd shim issues.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { SpawnSpec } from '../kimi/resolveKimi';

export interface CodexSpawnSpec extends SpawnSpec {
  /** npm 托管包根（…/@openai/codex）— 直启 vendor exe 时回写 env，与 codex.js 启动器行为对齐。 */
  managedRoot?: string;
}

/** Windows: codex.js 启动器会以 stdio:'inherit' 且不带 windowsHide 再 spawn
 *  一层 vendor/codex.exe（控制台子系统）。Electron 是 GUI 进程、没有控制台可
 *  继承，Windows 会给这个孙进程分配一个可见且常驻的黑窗口（e2e 实测）——
 *  加在 node 那层的 windowsHide 管不到孙进程。改为直接 spawn vendor exe，
 *  windowsHide 才真正生效；非 Windows 无此问题，仍走启动器。 */
function resolveVendorExe(entry: string): { exe: string; managedRoot: string } | undefined {
  if (process.platform !== 'win32') return undefined;
  const arm64 = process.arch === 'arm64';
  const target = arm64 ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const platformPkg = arm64 ? 'codex-win32-arm64' : 'codex-win32-x64';
  const managedRoot = dirname(dirname(entry)); // bin/codex.js → 包根
  const candidates = [
    join(managedRoot, 'node_modules', '@openai', platformPkg, 'vendor', target, 'bin', 'codex.exe'), // 嵌套布局（本机实测）
    join(managedRoot, '..', platformPkg, 'vendor', target, 'bin', 'codex.exe'), // 被 npm 提升为同级
    join(managedRoot, 'vendor', target, 'bin', 'codex.exe'), // 启动器自身的兜底路径
  ];
  const exe = candidates.find((p) => existsSync(p));
  return exe ? { exe, managedRoot } : undefined;
}

export function resolveCodexCli(extraArgs: string[], explicitEntry?: string): CodexSpawnSpec {
  const candidates = [
    explicitEntry,
    process.env.APPDATA
      ? join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      : undefined,
  ].filter((p): p is string => !!p);

  for (const entry of candidates) {
    if (!existsSync(entry)) continue;
    const vendor = resolveVendorExe(entry);
    if (vendor) {
      return { command: vendor.exe, args: extraArgs, label: vendor.exe, managedRoot: vendor.managedRoot };
    }
    return { command: process.execPath, args: [entry, ...extraArgs], label: `node ${entry}` };
  }
  return { command: 'codex', args: extraArgs, label: 'codex (PATH)', shell: true };
}

/** Env for spawned codex processes: Electron-as-Node；不再覆盖
 *  CODEX_HOME — codex 始终用用户自己的 ~/.codex（登录/会话/配置），
 *  路由开关只通过 `-c` 命令行覆盖生效，零文件写入。
 *  直启 vendor exe（managedRoot 存在）时补回 codex.js 启动器原本会设的
 *  CODEX_MANAGED_* 变量，保持行为一致。 */
export function codexSpawnEnv(managedRoot?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (managedRoot) {
    delete env.CODEX_MANAGED_BY_NPM;
    delete env.CODEX_MANAGED_BY_BUN;
    delete env.CODEX_MANAGED_BY_PNPM;
    env.CODEX_MANAGED_PACKAGE_ROOT = managedRoot;
    env.CODEX_MANAGED_BY_NPM = '1';
  }
  return env;
}
