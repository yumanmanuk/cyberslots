/**
 * BrowserHost —— 托管带 CDP 调试端口的独立 Chrome 子进程。
 * 生命周期照抄 OpencodeServerHost：懒启动单例（starting 去重）→ 自由端口
 * → spawn → 就绪探测（轮询 /json/version）→ stop() 树杀。
 *
 * 硬性要求（方案 Phase 1 验收项）：
 * - 强制独立 user-data-dir（userData/browser-profile），与用户日常 Chrome
 *   profile 完全隔离（也规避「已开 Chrome 占用调试端口」冲突）；
 * - 崩溃残留由 orphanSweep 兜底：user-data-dir 路径含 cyberslots 标识，
 *   已在 orphanSweep.ts 的匹配模式里登记（父进程死亡才被清杀，不伤及
 *   用户自己开的 Chrome）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { app } from 'electron';

import { killEngineTree } from '../engine/killTree';
import { log } from '../log/logger';
import { resolveChromePath } from './chromePaths';

const READY_TIMEOUT_MS = 30_000;
/** 受管页固定视口（兼作截图降分辨率手段，见 policy.BUDGET）。 */
const WINDOW_SIZE = '--window-size=1280,800';

export class BrowserHost {
  private child: ChildProcess | undefined;
  private starting: Promise<number> | undefined;
  private debugPort = 0;

  /** 调试端口（0 = 未运行）。 */
  get port(): number {
    return this.debugPort;
  }

  get running(): boolean {
    return !!this.child && this.debugPort > 0;
  }

  /** 懒启动 + 并发去重（ensure 语义同 OpencodeServerHost.ensure）。 */
  ensure(): Promise<number> {
    if (this.child && this.debugPort) return Promise.resolve(this.debugPort);
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<number> {
    const exe = resolveChromePath();
    const port = await findFreePort();
    const profileDir = join(app.getPath('userData'), 'browser-profile');
    const args = [
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      WINDOW_SIZE,
      'about:blank',
    ];
    const child = spawn(exe, args, {
      windowsHide: false, // 受管浏览器必须可见 —— 用户要能看到引擎在操作什么
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    log.info('browser.host', 'chrome spawned', { exe, port, pid: child.pid, profileDir });

    let stderrTail = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      stderrTail = (stderrTail + d).slice(-2000);
    });
    child.once('exit', (code) => {
      log.warn('browser.host', 'chrome exited', { code, port: this.debugPort });
      if (this.child === child) {
        this.child = undefined;
        this.debugPort = 0;
      }
    });
    child.once('error', (err) => {
      log.error('browser.host', 'chrome spawn failed', { exe }, err);
    });

    try {
      await waitForDevtools(port, READY_TIMEOUT_MS);
    } catch (err) {
      if (this.child === child) {
        this.child = undefined;
        this.debugPort = 0;
      }
      killEngineTree(child);
      log.error('browser.host', 'devtools port not ready', { port, stderrTail: stderrTail.slice(-500) }, err);
      throw err;
    }
    this.debugPort = port;
    log.info('browser.host', 'devtools ready', { port });
    return port;
  }

  /** 关停受管 Chrome（幂等）。 */
  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.debugPort = 0;
    if (child) {
      log.info('browser.host', 'stopping chrome', { pid: child.pid });
      killEngineTree(child);
    }
  }
}

/** 轮询 devtools HTTP 端点直到就绪（250ms 间隔，超时抛错）。 */
async function waitForDevtools(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* 未就绪，继续等 */
    }
    if (Date.now() > deadline) throw new Error(`Chrome devtools 端口 ${port} ${timeoutMs}ms 内未就绪`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 自由端口探测（同 OpencodeServerHost/AiServerHost 的既有实现）。 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}
