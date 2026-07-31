/**
 * sweepOrphanEngines — dev 热重启/崩溃后的自愈：electron-vite 重启是
 * 强杀旧主进程，before-quit 树杀来不及执行，残留的引擎子进程
 * （kimi acp / codex app-server / ai-server 前端）握着继承来的
 * Chromium SingletonLock 句柄，新实例会报
 * process_singleton_win "Lock file can not be created! Error code: 32"。
 *
 * 只清「父进程已死」的机器模式进程（acp / app-server 只有 GUI 客户端
 * 会用），绝不误伤用户终端里的交互式 CLI 或另一个真实实例的子进程。
 */

import { spawnSync } from 'node:child_process';

const PS_SCRIPT = `
$patterns = @('*kimi-code*main.mjs* acp*', '*codex*app-server*', '*ai-server*-server.js*', '*opencode*serve --hostname 127.0.0.1*', '*claude-code*cli.js*--input-format stream-json*');
$alive = @{}; Get-Process | ForEach-Object { $alive[$_.Id] = $true };
$killed = @();
Get-CimInstance Win32_Process | ForEach-Object {
  $cmd = $_.CommandLine;
  if (-not $cmd) { return }
  $hit = $false;
  foreach ($p in $patterns) { if ($cmd -like $p) { $hit = $true; break } }
  if ($hit -and -not $alive.ContainsKey([int]$_.ParentProcessId)) {
    $killed += "$($_.ProcessId):$($cmd.Substring(0, [Math]::Min(80, $cmd.Length)))";
    taskkill /pid $_.ProcessId /T /F | Out-Null;
  }
};
Write-Output ($killed.Count);
foreach ($k in $killed) { Write-Output $k }`;

/** @returns 清掉的孤儿进程数（非 Windows 或失败时为 0）。
 *  同时通过 console.log 输出被杀进程的具体信息（PID + 命令行摘要）。 */
export function sweepOrphanEngines(): number {
  if (process.platform !== 'win32') return 0;
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const lines = (res.stdout ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const n = Number(lines[0] ?? '0');
  if (!Number.isFinite(n)) return 0;
  // 后续行是被杀进程的 PID:CommandLine 摘要
  for (let i = 1; i < lines.length; i++) {
    console.log(`[orphan-sweep] Killed: ${lines[i]}`);
  }
  return n;
}
