/**
 * KapServerHost — 懒启动的单例 `kimi web`（kap-server）宿主。
 *
 * 全部 kimi KAP 会话共享一个 server 进程（kap-server 本身即一 server
 * 多 session 设计）。生命周期模式沿用 OpencodeServerHost：starting
 * promise 去重、exit 自清理、退出树杀。
 *
 * 发现优先于 spawn：用户自己跑着的 `kimi web` 实例（实例注册表
 * <home>/server/instances/*.json + <home>/server.token）直接复用，
 * 不重复起进程；外来实例退出时按「error 态 + 下次操作懒重连」处理。
 *
 * 鉴权：REST 走 Authorization: Bearer；WS 走 Sec-WebSocket-Protocol
 * 子协议 `kimi-code.bearer.<token>`（token 来自 <home>/server.token）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { KapDetection } from '@shared/types';
import { L } from '../../i18n';
import { killEngineTree } from '../killTree';
import { log } from '../../log/logger';
import { kimiSpawnEnv, resolveKimiCli } from './resolveKimi';

const READY_TIMEOUT_MS = 30_000;

/** 已就绪 server 的连接信息 — adapter 据此建 REST/WS 客户端。 */
export interface KapServerInfo {
  /** http://127.0.0.1:PORT（无尾斜杠）。 */
  origin: string;
  token: string;
  /** server 代次 — 进程更替 +1，adapter 据此判断连接失效。 */
  gen: number;
}

function kimiHomeOf(explicit?: string): string {
  return explicit ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
}

/** pid 存活探测（signal 0）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 实例注册表扫描：<home>/server/instances/<serverId>.json（snake_case:
 *  server_id/pid/host/port/started_at/heartbeat_at），token 不在注册表里
 *  （只在 <home>/server.token）。返回第一个 pid 存活的实例。 */
function scanLiveInstance(home: string): { host: string; port: number; pid: number } | undefined {
  const dir = join(home, 'server', 'instances');
  if (!existsSync(dir)) return undefined;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const doc = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
        const pid = Number(doc.pid ?? 0);
        const port = Number(doc.port ?? 0);
        if (pid > 0 && port > 0 && pidAlive(pid)) {
          return { host: String(doc.host ?? '127.0.0.1'), port, pid };
        }
      } catch {
        /* 单个坏文件不阻断扫描 */
      }
    }
  } catch {
    /* 目录不可读 = 视为无实例 */
  }
  return undefined;
}

function readServerToken(home: string): string | undefined {
  try {
    const token = readFileSync(join(home, 'server.token'), 'utf8').trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * KAP 静态探测（同步、不 spawn）— engineConfigs 快照 / 启动检测共用。
 * installed = npm 全局 kimi 入口存在；running = 注册表有存活实例。
 */
export function detectKap(explicitHome?: string): KapDetection {
  const home = kimiHomeOf(explicitHome);
  const entry = process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs')
    : undefined;
  const installed = !!entry && existsSync(entry);
  let version: string | undefined;
  if (installed && entry) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(entry, '..', '..', 'package.json'), 'utf8'),
      ) as { version?: string };
      version = pkg.version;
    } catch {
      /* 版本读不到不阻断 */
    }
  }
  return { installed, version, running: !!scanLiveInstance(home) };
}

export class KapServerHost {
  private child: ChildProcess | undefined;
  private info: KapServerInfo | undefined;
  /** 本次 info 对应的 home（路由镜像切换后需换 server）。 */
  private homeKey = '';
  /** 复用的外来实例（用户自己跑的 kimi web）— 不归我们杀。 */
  private external = false;
  private generation = 0;
  private starting: Promise<KapServerInfo> | undefined;
  private readonly stderrTail: string[] = [];

  /** 启动检测缓存（app ready 后跑一次；设置页/日志展示）。 */
  private detection: KapDetection | undefined;

  get running(): boolean {
    return !!this.info;
  }

  /** app 启动时的能力检测：静态探测 + 若有活实例做一次 healthz 确认。
   *  只发现不拉起 — spawn 留到第一个 kimi KAP 会话按需进行。 */
  async detectAtStartup(): Promise<KapDetection> {
    const det = detectKap();
    if (det.running) {
      // 注册表说活着 ≠ 真能服务（心跳文件可能滞后）— healthz 双确认。
      const adopted = await this.tryAdopt(kimiHomeOf()).catch(() => undefined);
      det.running = !!adopted;
    }
    this.detection = det;
    log.info('host.kap', 'startup detect', { installed: det.installed, version: det.version, running: det.running });
    return det;
  }

  lastDetection(): KapDetection | undefined {
    return this.detection;
  }

  /** 确保 server 可用（幂等；并发汇合）。home 变化（路由镜像开关）时换代重启。 */
  ensure(explicitHome?: string): Promise<KapServerInfo> {
    const home = kimiHomeOf(explicitHome);
    if (this.info && this.homeKey === home) {
      // 外来实例可能随时被用户 Ctrl+C — 轻量确认后返回。
      return this.confirmAlive().then((ok) => {
        if (ok && this.info) return this.info;
        this.reset();
        return this.ensure(explicitHome);
      });
    }
    if (this.info && this.homeKey !== home) this.stop();
    if (this.starting) return this.starting;
    this.starting = this.start(home).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async confirmAlive(): Promise<boolean> {
    if (!this.info) return false;
    // 自有子进程：进程活着即可（exit 回调已负责清理）。
    if (!this.external) return !!this.child;
    try {
      const res = await fetch(`${this.info.origin}/api/v1/healthz`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async start(home: string): Promise<KapServerInfo> {
    // 1) 先发现：复用已在跑的实例（含用户自己起的）。
    const adopted = await this.tryAdopt(home);
    if (adopted) return adopted;

    // 2) spawn `kimi web`：--no-open 免弹浏览器；--log-level error 让就绪
    //    输出退化为单行 "Kimi server: <url>#token=..."（比多行 banner 好解析）。
    //    端口不显式指定 — kap-server 自己从默认端口起找空闲位并写实例注册表。
    const spec = resolveKimiCli(['web', '--no-open', '--log-level', 'error']);
    const child = spawn(spec.command, spec.args, {
      cwd: home,
      shell: spec.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: kimiSpawnEnv(explicitOrUndefined(home)),
    });
    this.child = child;
    this.external = false;
    this.stderrTail.length = 0;
    log.info('host.kap', 'kimi web spawned', { command: spec.command, home, pid: child.pid });

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      for (const line of d.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    });
    child.once('exit', (code) => {
      log.warn('host.kap', 'kimi web exited', { code, external: this.external, stderrTail: this.stderrTail.slice(-6).join(' | ') });
      if (this.child === child) this.reset();
    });

    // 就绪 = stdout 出现 "Kimi server: http://…"（run.ts formatReadyLine）。
    const readyUrl = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error(`${L('kimi web 启动超时', 'kimi web startup timed out')}\n${this.stderrTail.slice(-6).join('\n')}`)),
        READY_TIMEOUT_MS,
      );
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (d: string) => {
        buf += d;
        // 剥 ANSI 色码再匹配 — banner 分支（默认 log-level）的 URL 带 chalk
        // 着色，不剥会把转义序列吸进 origin。
        const plain = buf.replace(/\u001b\[[0-9;]*m/g, '');
        const m = plain.match(/Kimi server(?: ready)?:?\s+(https?:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`${L('kimi web 提前退出', 'kimi web exited early')} (code=${code})\n${this.stderrTail.slice(-6).join('\n')}`));
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(L(`无法启动 kimi CLI: ${err.message}（未安装？运行 npm i -g @moonshot-ai/kimi-code）`, `Failed to launch the kimi CLI: ${err.message} (not installed? run npm i -g @moonshot-ai/kimi-code)`)));
      });
    }).catch((err) => {
      if (this.child === child) this.child = undefined;
      killEngineTree(child);
      throw err;
    });

    // URL 形如 http://127.0.0.1:58627/#token=xxx — token 在 fragment；
    // 缺 fragment 时兜底读 <home>/server.token（首启已落盘）。
    const [base, frag] = readyUrl.split('#');
    const origin = base!.replace(/\/+$/, '');
    const token = /token=([^&\s]+)/.exec(frag ?? '')?.[1] ?? readServerToken(home);
    if (!token) {
      killEngineTree(child);
      this.child = undefined;
      throw new Error(L('kimi web 已启动但拿不到 bearer token（server.token 缺失）', 'kimi web started but no bearer token (server.token missing)'));
    }

    await this.waitHealthy(origin);
    this.generation++;
    this.info = { origin, token, gen: this.generation };
    this.homeKey = home;
    log.info('host.kap', 'kimi web ready', { origin, external: this.external });
    return this.info;
  }

  /** 发现并验证一个已在跑的实例；成功则采纳（external，不归我们杀）。 */
  private async tryAdopt(home: string): Promise<KapServerInfo | undefined> {
    const inst = scanLiveInstance(home);
    if (!inst) return undefined;
    const token = readServerToken(home);
    if (!token) return undefined;
    const host = inst.host === '0.0.0.0' ? '127.0.0.1' : inst.host;
    const origin = `http://${host}:${inst.port}`;
    try {
      const res = await fetch(`${origin}/api/v1/healthz`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return undefined;
    } catch {
      return undefined;
    }
    this.generation++;
    this.info = { origin, token, gen: this.generation };
    this.homeKey = home;
    this.external = true;
    this.child = undefined;
    log.info('host.kap', 'adopted external kimi web', { origin });
    return this.info;
  }

  private async waitHealthy(origin: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const res = await fetch(`${origin}/api/v1/healthz`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return;
      } catch {
        /* retry */
      }
      if (Date.now() > deadline) throw new Error(L('kimi web 健康检查超时', 'kimi web health check timed out'));
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  private reset(): void {
    this.child = undefined;
    this.info = undefined;
    this.homeKey = '';
    this.external = false;
    this.generation++;
  }

  stop(): void {
    const child = this.child;
    const external = this.external;
    this.reset();
    // 外来实例是用户的 — 只断开引用，绝不杀。
    if (child && !external) killEngineTree(child);
  }
}

/** kimiSpawnEnv 语义：仅显式 home（路由镜像）才设 KIMI_CODE_HOME；
 *  home 等于默认 ~/.kimi-code 时传 undefined 让 kimi 用自己的解析。 */
function explicitOrUndefined(home: string): string | undefined {
  const def = join(homedir(), '.kimi-code');
  return home === def && !process.env.KIMI_CODE_HOME ? undefined : home;
}
