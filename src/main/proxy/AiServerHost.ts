/**
 * AiServerHost — runs the embedded Responses↔Chat conversion proxy
 * (resources/ai-server, the user's own ai-server trimmed to its core)
 * as an Electron utilityProcess on a dynamic loopback port.
 *
 * Key design points (方案 §内置 ai-server):
 *  - API keys are injected via env only — never written to disk.
 *  - The bundled sources are copied into userData/ai-server before spawn
 *    so the proxy's own logs/ and data/ dirs land in a writable location
 *    (packaged resources may be read-only).
 *  - codex talks to 127.0.0.1:<port>; routing hides in the model name
 *    ("kimi*" → Kimi chat conversion, default → MiniMax responses).
 */

import { app, utilityProcess, type UtilityProcess } from 'electron';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import type { AppSettings } from '@shared/types';

const PROXY_FILES = ['codex-server.js', 'client-access.js', 'kimi-quota-guard.js', 'kimi-effort.js', 'config.js', 'package.json'];
const READY_TIMEOUT_MS = 10_000;

export class AiServerHost {
  private child: UtilityProcess | undefined;
  private port = 0;
  private starting: Promise<number> | undefined;

  /** Ensure the proxy is running; resolves with its loopback port. */
  async ensureStarted(settings: AppSettings): Promise<number> {
    if (this.child && this.port) return this.port;
    this.starting ??= this.start(settings).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  get currentPort(): number {
    return this.port;
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
    this.port = 0;
  }

  private async start(settings: AppSettings): Promise<number> {
    const runDir = this.materialize();
    const port = await findFreePort();

    const kimi = settings.providers.find((p) => p.id === 'kimi');
    const minimax = settings.providers.find((p) => p.id === 'minimax');

    const child = utilityProcess.fork(join(runDir, 'codex-server.js'), [], {
      serviceName: 'cyberslots-ai-server',
      stdio: 'pipe',
      env: {
        ...process.env,
        CODEX_PORT_OVERRIDE: String(port),
        KIMI_OPENAI_BASE_URL: kimi?.baseUrl ?? '',
        KIMI_API_KEY: kimi?.apiKey ?? '',
        MINIMAX_OPENAI_BASE_URL: minimax?.baseUrl ?? '',
        MINIMAX_API_KEY: minimax?.apiKey ?? '',
      },
    });
    child.stdout?.on('data', (d: Buffer) => console.log('[ai-server]', d.toString().trim()));
    child.stderr?.on('data', (d: Buffer) => console.error('[ai-server:err]', d.toString().trim()));
    child.once('exit', (code) => {
      console.error(`[ai-server] exited (code=${code})`);
      if (this.child === child) {
        this.child = undefined;
        this.port = 0;
      }
    });
    this.child = child;

    await waitForHealth(port);
    this.port = port;
    return port;
  }

  /** Copy bundled proxy sources into a writable run dir (idempotent). */
  private materialize(): string {
    const src = sourceDir();
    const dst = join(app.getPath('userData'), 'ai-server');
    mkdirSync(dst, { recursive: true });
    for (const f of PROXY_FILES) {
      copyFileSync(join(src, f), join(dst, f));
    }
    return dst;
  }
}

/** Bundled sources: workspace resources/ in dev, process.resourcesPath when packaged. */
function sourceDir(): string {
  const dev = join(app.getAppPath(), 'resources', 'ai-server');
  if (existsSync(dev)) return dev;
  return join(process.resourcesPath, 'ai-server');
}

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

/** Poll until the proxy accepts TCP connections (it has no /health route). */
async function waitForHealth(port: number): Promise<void> {
  const { connect } = await import('node:net');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = connect({ port, host: '127.0.0.1' }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`内置 ai-server 启动超时（port ${port}）`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
