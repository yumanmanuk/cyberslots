/**
 * OpencodeEventHub — 共享 SSE 事件枢纽。
 *
 * 每个 directory 一条上游 /event 连接（opencode 的 /event 是 directory
 * 级全流），按事件 properties.sessionID 分发到各 adapter 的 listener；
 * 无 sessionID 的事件（server.connected / heartbeat / plugin.added …）
 * 对 adapter 无意义，直接丢弃。
 *
 * 重连：250ms 退避 + 20s stall 超时（openchamber upstream-reader 的
 * 精简版，无 Last-Event-ID replay）。仅在 host 仍在跑时重连 —— host
 * 进程退出由 host.onExit 通知 adapter，hub 不负责懒重启 server。
 */

import { compatAudit } from '../compatAudit';
import type { OpencodeServerHost } from './OpencodeServerHost';

export interface OpencodeSseEvent {
  type: string;
  properties: Record<string, unknown>;
}

type Listener = (evt: OpencodeSseEvent) => void;

const STALL_TIMEOUT_MS = 20_000;
const RECONNECT_DELAY_MS = 250;

interface DirChannel {
  /** sessionID → listeners（同一会话可能有多个订阅方）。 */
  listeners: Map<string, Set<Listener>>;
  abort: AbortController | undefined;
  running: boolean;
}

export class OpencodeEventHub {
  private readonly channels = new Map<string, DirChannel>();

  constructor(private readonly host: OpencodeServerHost) {
    // server 进程更替 → 掐断全部旧连接（adapter 重订阅时按新代次重连）。
    host.onExit(() => {
      for (const ch of this.channels.values()) ch.abort?.abort();
    });
  }

  /** 订阅某 directory 下指定 engine sessionID 的事件流；返回退订函数。 */
  subscribe(directory: string, sessionID: string, fn: Listener): () => void {
    let ch = this.channels.get(directory);
    if (!ch) {
      ch = { listeners: new Map(), abort: undefined, running: false };
      this.channels.set(directory, ch);
    }
    let set = ch.listeners.get(sessionID);
    if (!set) {
      set = new Set();
      ch.listeners.set(sessionID, set);
    }
    set.add(fn);
    if (!ch.running) void this.runChannel(directory, ch);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) ch!.listeners.delete(sessionID);
      if (ch!.listeners.size === 0) {
        ch!.abort?.abort(); // 引用计数归零 → 关连接
        this.channels.delete(directory);
      }
    };
  }

  /** 单 directory 的连接循环：断线重连直到无订阅者或 server 不在跑。 */
  private async runChannel(directory: string, ch: DirChannel): Promise<void> {
    ch.running = true;
    try {
      while (ch.listeners.size > 0) {
        if (!this.host.running) return; // server 挂了 — 等 adapter 走懒重启路径重订阅
        const abort = new AbortController();
        ch.abort = abort;
        try {
          await this.readStream(directory, ch, abort);
        } catch {
          /* 断线 → 退避重连 */
        }
        if (ch.listeners.size === 0) return;
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      }
    } finally {
      ch.running = false;
      if (ch.listeners.size === 0) this.channels.delete(directory);
    }
  }

  private async readStream(directory: string, ch: DirChannel, abort: AbortController): Promise<void> {
    const res = await fetch(`${this.host.url}/event`, {
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...this.host.headers(directory),
      },
      signal: abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE /event → ${res.status}`);

    // stall 看门狗：超过 20s 无任何数据（心跳每 10s 一发）判定连接僵死。
    let stallTimer: NodeJS.Timeout | undefined;
    const resetStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => abort.abort(), STALL_TIMEOUT_MS);
    };
    resetStall();

    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        resetStall();
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          this.dispatch(ch, block);
        }
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  }

  private dispatch(ch: DirChannel, block: string): void {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!data) return;
    let evt: OpencodeSseEvent;
    try {
      evt = JSON.parse(data) as OpencodeSseEvent;
    } catch {
      // SSE data 帧解不动 = server 版本换了输出格式，留账后丢弃。
      compatAudit.record('opencode', 'parse-error', 'sse-malformed-json', data);
      return;
    }
    if (!evt || typeof evt.type !== 'string') return;
    const props = (evt.properties ?? {}) as Record<string, unknown>;
    const sessionID = typeof props.sessionID === 'string' ? props.sessionID : undefined;
    if (!sessionID) return; // 全局事件对 adapter 无意义
    const set = ch.listeners.get(sessionID);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(evt);
      } catch (err) {
        console.error('[opencode-hub] listener error:', err);
      }
    }
  }
}
