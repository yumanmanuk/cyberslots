/**
 * Minimal newline-delimited JSON-RPC client for `codex app-server`.
 *
 * The wire format is JSONL without the `"jsonrpc":"2.0"` field
 * (codex-rs/app-server-protocol/src/rpc.rs). Supports:
 *  - client → server requests with response correlation,
 *  - server → client notifications (listener),
 *  - server → client requests (async handler; approvals flow).
 */

import type { Readable, Writable } from 'node:stream';

import { compatAudit } from '../compatAudit';

type Json = Record<string, unknown>;

export type NotificationHandler = (method: string, params: Json) => void;
export type ServerRequestHandler = (method: string, params: Json) => Promise<unknown>;

/** 带错误码的 RPC 错误 — 上层可精确判 -32601（Method not found）降级。 */
export class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'RpcError';
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** 请求方法名 — 错误应答时审计日志能指向具体方法。 */
  method: string;
}

export class NdjsonRpc {
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly onNotification: NotificationHandler,
    private readonly onServerRequest: ServerRequestHandler,
  ) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.feed(chunk));
  }

  request<T = Json>(method: string, params?: Json): Promise<T> {
    if (this.closed) return Promise.reject(new Error('rpc closed'));
    const id = this.nextId++;
    const frame = params === undefined ? { id, method } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.write(frame);
    });
  }

  notify(method: string, params?: Json): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  close(reason = 'closed'): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      p.reject(new Error(`rpc ${reason}`));
      this.pending.delete(id);
    }
  }

  // ---------------------------------------------------------------- private

  private write(frame: Json): void {
    try {
      this.stdin.write(JSON.stringify(frame) + '\n');
    } catch {
      /* child gone — pending requests fail via close() */
    }
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        // non-JSON noise on stdout（banner/日志行属正常）；以 { 开头却解不动
        // = 畸形 JSON 帧（格式漂移信号）才留账。
        if (line.startsWith('{')) compatAudit.record('codex', 'parse-error', 'stdout-malformed-json', line);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Json): void {
    const id = msg.id as number | string | undefined;
    const method = msg.method as string | undefined;

    if (method && id !== undefined) {
      // Server → client request (approval flow).
      void this.onServerRequest(method, (msg.params as Json) ?? {})
        .then((result) => this.write({ id, result: result ?? {} } as Json))
        .catch((err: Error) =>
          this.write({ id, error: { code: -32603, message: err.message } } as Json),
        );
      return;
    }
    if (method) {
      this.onNotification(method, (msg.params as Json) ?? {});
      return;
    }
    if (id !== undefined) {
      const p = this.pending.get(Number(id));
      if (!p) return;
      this.pending.delete(Number(id));
      if (msg.error) {
        const e = msg.error as { code?: number; message?: string };
        // Method not found 集中入账：引擎升级砍方法时各 catch 降级点无需各自重复记录。
        if (e.code === -32601) compatAudit.record('codex', 'rejected-method', p.method, e.message);
        p.reject(new RpcError(e.message ?? `rpc error ${e.code}`, e.code));
      } else {
        p.resolve(msg.result);
      }
    }
  }
}
