/**
 * OpencodeServerHost — 懒启动的单例 `opencode serve` 宿主。
 *
 * 全部 opencode 会话共享一个 server 进程（opencode 官方设计即单实例、
 * 按请求 x-opencode-directory 头路由多目录）。生命周期模式沿用
 * AiServerHost：starting promise 去重、exit 自清理、退出树杀；不做
 * 周期健康守护 —— 进程挂了走「error 态 + 下次操作懒重启」。
 *
 * 安全：serve 未设 OPENCODE_SERVER_PASSWORD 时 127.0.0.1 上无鉴权，
 * 本机任意进程可驱动它 —— 这里每次启动生成随机密码注入 env，所有
 * 请求带 Basic auth 头（用户名固定 opencode，见 opencode ServerAuth）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { app } from 'electron';

import type { OpencodeCatalog, OpencodeModelEntry } from '@shared/types';
import { killEngineTree } from '../killTree';
import { resolveOpencodeCli } from './resolveOpencode';

const READY_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

export class OpencodeServerHost {
  private child: ChildProcess | undefined;
  private baseUrl = '';
  private password = '';
  /** server 代次 — 每次进程更替 +1；catalog 缓存与 SSE 订阅据此失效。 */
  private generation = 0;
  private starting: Promise<string> | undefined;
  private catalogCache: { gen: number; catalog: OpencodeCatalog } | undefined;
  private readonly exitListeners = new Set<() => void>();
  private readonly stderrTail: string[] = [];

  get running(): boolean {
    return !!this.child && !!this.baseUrl;
  }

  get gen(): number {
    return this.generation;
  }

  get url(): string {
    return this.baseUrl;
  }

  /** 请求头：Basic auth + directory 路由。 */
  headers(directory?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
    };
    if (directory) h['x-opencode-directory'] = directory;
    return h;
  }

  /** server 进程意外退出时的通知（adapter 借此推 error 态）。 */
  onExit(fn: () => void): () => void {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  /** 确保 server 在跑，返回 baseUrl（幂等；并发调用汇合到同一次启动）。 */
  ensure(): Promise<string> {
    if (this.child && this.baseUrl) return Promise.resolve(this.baseUrl);
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<string> {
    const port = await findFreePort();
    this.password = randomBytes(16).toString('hex');
    // 显式传自选空闲端口 —— 不用 `--port 0`（其语义是「优先抢 4096」，
    // 会与用户自跑的 opencode 抢默认端口）。
    const spec = resolveOpencodeCli(['serve', '--hostname', '127.0.0.1', '--port', String(port)]);
    const child = spawn(spec.command, spec.args, {
      cwd: app.getPath('userData'),
      shell: spec.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: this.password },
    });
    this.child = child;
    this.stderrTail.length = 0;

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      for (const line of d.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    });
    child.once('exit', (code) => {
      console.error(`[opencode-host] serve exited (code=${code})`);
      if (this.child === child) {
        this.child = undefined;
        this.baseUrl = '';
        this.generation++;
        for (const fn of [...this.exitListeners]) fn();
      }
    });

    // 就绪 = stdout 打印 "opencode server listening on http://…"（openchamber 同款解析）。
    const url = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error(`opencode serve 启动超时\n${this.stderrTail.slice(-6).join('\n')}`)),
        READY_TIMEOUT_MS,
      );
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (d: string) => {
        buf += d;
        const m = buf.match(/listening on\s+(https?:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode serve 提前退出 (code=${code})\n${this.stderrTail.slice(-6).join('\n')}`));
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`无法启动 opencode CLI: ${err.message}（未安装？运行 npm i -g opencode-ai）`));
      });
    }).catch((err) => {
      if (this.child === child) {
        this.child = undefined;
        this.baseUrl = '';
      }
      killEngineTree(child);
      throw err;
    });

    // /global/health 双确认（就绪行之后通常立即通过）。
    await this.waitHealthy(url);
    this.baseUrl = url;
    console.log(`[opencode-host] serve ready at ${url}`);
    return url;
  }

  private async waitHealthy(url: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const res = await fetch(`${url}/global/health`, { headers: this.headers() });
        if (res.ok) return;
      } catch {
        /* retry */
      }
      if (Date.now() > deadline) throw new Error('opencode serve 健康检查超时');
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * 模型目录：GET /config/providers（= 已连接 + 启用的可用集，含 zen
   * 免费模型；绝不是 /provider 的 models.dev 全目录），按 server 代次缓存。
   */
  async getCatalog(force = false): Promise<OpencodeCatalog> {
    await this.ensure();
    if (!force && this.catalogCache && this.catalogCache.gen === this.generation) {
      return this.catalogCache.catalog;
    }
    try {
      const res = await fetch(`${this.baseUrl}/config/providers`, { headers: this.headers() });
      if (!res.ok) throw new Error(`GET /config/providers → ${res.status}`);
      const body = (await res.json()) as Json;
      const catalog = normalizeCatalog(body);
      this.catalogCache = { gen: this.generation, catalog };
      return catalog;
    } catch (err) {
      return { models: [], defaults: {}, error: err instanceof Error ? err.message : String(err) };
    }
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.baseUrl = '';
    this.generation++;
    if (child) killEngineTree(child);
  }
}

// ------------------------------------------------------------- normalize

/** /config/providers → OpencodeModelEntry[]（探针 1.17.18 实测结构）。 */
function normalizeCatalog(body: Json): OpencodeCatalog {
  const providers = Array.isArray(body.providers) ? (body.providers as Json[]) : [];
  const defaults = (body.default ?? {}) as Record<string, string>;
  const models: OpencodeModelEntry[] = [];
  for (const p of providers) {
    const providerID = String(p.id ?? '');
    const providerName = String(p.name ?? providerID);
    const modelMap = (p.models ?? {}) as Record<string, Json>;
    for (const [modelID, m] of Object.entries(modelMap)) {
      const caps = (m.capabilities ?? {}) as Json;
      const limit = (m.limit ?? {}) as Json;
      const cost = (m.cost ?? {}) as Json;
      const variants = (m.variants ?? {}) as Json;
      const efforts = Object.keys(variants);
      const input = (caps.input ?? {}) as Record<string, unknown>;
      const output = (caps.output ?? {}) as Record<string, unknown>;
      models.push({
        slug: `${providerID}/${modelID}`,
        providerID,
        providerName,
        modelID,
        displayName: m.name ? String(m.name) : undefined,
        contextWindow: numOr(limit.context),
        inputModalities: modalities(input),
        outputModalities: modalities(output),
        efforts: efforts.length ? efforts : undefined,
        toolCall: boolOr(caps.toolcall),
        reasoning: boolOr(caps.reasoning),
        attachment: boolOr(caps.attachment),
        costInput: numOr(cost.input),
        costOutput: numOr(cost.output),
      });
    }
  }
  return { models, defaults };
}

function modalities(flags: Record<string, unknown>): string[] | undefined {
  const on = Object.entries(flags)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  return on.length ? on : undefined;
}

function numOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function boolOr(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
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
