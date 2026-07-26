/**
 * AiServerHost — runs the embedded protocol-routing servers as Electron
 * utilityProcesses on dynamic loopback ports:
 *  - codex front (codex-server.js): Responses API 前端，Responses↔Chat
 *    转换 + responses 直通（codex 路由开时使用）。
 *  - kimi front (openai-server.js): Chat Completions 前端，http2 透传
 *    （kimi 路由开时使用）。
 *
 * Key design points:
 *  - Upstream endpoints/keys来自 CLI 配置文件的内存解析结果，经 env 注入
 *    子进程 — 本程序不落盘任何密钥（kimi 镜像 config 除外，见 engineConfigs）。
 *  - The bundled sources are copied into userData/ai-server before spawn
 *    so the proxy's own logs/ and data/ dirs land in a writable location.
 */

import { app, utilityProcess, type UtilityProcess } from 'electron';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import type { RouteUpstreams } from '../config/engineConfigs';

const PROXY_FILES = [
  'codex-server.js',
  'openai-server.js',
  'client-access.js',
  'kimi-quota-guard.js',
  'kimi-effort.js',
  'config.js',
  'package.json',
];
const READY_TIMEOUT_MS = 10_000;

type FrontKind = 'codex' | 'kimi';

interface Front {
  child: UtilityProcess | undefined;
  port: number;
  starting: Promise<number> | undefined;
  /** Upstream fingerprint — restart the front when endpoints change. */
  sig: string;
}

export class AiServerHost {
  private readonly fronts: Record<FrontKind, Front> = {
    codex: { child: undefined, port: 0, starting: undefined, sig: '' },
    kimi: { child: undefined, port: 0, starting: undefined, sig: '' },
  };

  /** codex 路由前端（Responses 协议入口）。 */
  ensureCodexFront(upstreams: RouteUpstreams): Promise<number> {
    return this.ensure('codex', upstreams);
  }

  /** kimi 路由前端（Chat Completions 协议入口）。 */
  ensureKimiFront(upstreams: RouteUpstreams): Promise<number> {
    return this.ensure('kimi', upstreams);
  }

  stop(): void {
    for (const kind of ['codex', 'kimi'] as FrontKind[]) {
      this.fronts[kind].child?.kill();
      this.fronts[kind] = { child: undefined, port: 0, starting: undefined, sig: '' };
    }
  }

  private ensure(kind: FrontKind, upstreams: RouteUpstreams): Promise<number> {
    const front = this.fronts[kind];
    const sig = JSON.stringify(upstreams);
    if (front.child && front.port && front.sig === sig) return Promise.resolve(front.port);
    if (front.starting) return front.starting;
    // Endpoint set changed → restart with fresh env.
    front.child?.kill();
    front.child = undefined;
    front.port = 0;
    front.starting = this.start(kind, upstreams, sig).finally(() => {
      front.starting = undefined;
    });
    return front.starting;
  }

  private async start(kind: FrontKind, upstreams: RouteUpstreams, sig: string): Promise<number> {
    const runDir = this.materialize();
    const port = await findFreePort();
    const entry = kind === 'codex' ? 'codex-server.js' : 'openai-server.js';
    const portEnv = kind === 'codex' ? 'CODEX_PORT_OVERRIDE' : 'OPENAI_PORT_OVERRIDE';

    const child = utilityProcess.fork(join(runDir, entry), [], {
      serviceName: `cyberslots-ai-server-${kind}`,
      stdio: 'pipe',
      env: {
        ...process.env,
        [portEnv]: String(port),
        KIMI_OPENAI_BASE_URL: upstreams.chat?.baseUrl ?? '',
        KIMI_API_KEY: upstreams.chat?.apiKey ?? '',
        MINIMAX_OPENAI_BASE_URL: upstreams.responses?.baseUrl ?? '',
        MINIMAX_API_KEY: upstreams.responses?.apiKey ?? '',
      },
    });
    child.stdout?.on('data', (d: Buffer) => console.log(`[ai-server:${kind}]`, d.toString().trim()));
    child.stderr?.on('data', (d: Buffer) => console.error(`[ai-server:${kind}:err]`, d.toString().trim()));
    child.once('exit', (code) => {
      console.error(`[ai-server:${kind}] exited (code=${code})`);
      const front = this.fronts[kind];
      if (front.child === child) {
        front.child = undefined;
        front.port = 0;
      }
    });

    const front = this.fronts[kind];
    front.child = child;
    front.sig = sig;

    await waitForHealth(port);
    front.port = port;
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
    if (Date.now() > deadline) throw new Error(`内置 ai-server(${port}) 启动超时`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
