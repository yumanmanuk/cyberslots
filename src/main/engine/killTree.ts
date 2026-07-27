/**
 * killEngineTree — terminate an engine CLI child and its whole process
 * tree. Windows 上必须树杀：CLI 的孙进程继承了 Chromium 的 SingletonLock
 * 文件句柄，留下孤儿会让下次启动报 process_singleton_win.cc "Lock file
 * can not be created! Error code: 32"（dev 热重启偶发退出的根因）。
 */

import { spawn, type ChildProcess } from 'node:child_process';

const KILL_GRACE_MS = 3_000;

export function killEngineTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    // taskkill 是独立进程，即使本进程随后退出也会完成整棵树的清理。
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      .on('error', () => child.kill());
    return;
  }
  child.kill();
  const killer = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  killer.unref();
}
