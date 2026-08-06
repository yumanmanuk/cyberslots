/**
 * MCP server 脚本（mcpServerScript.MCP_SERVER_SCRIPT）集成测试：
 * 真实物化脚本 + 拉起 node 子进程，验证 stdio JSON-RPC 握手、tools/list
 * 清单透传、tools/call 经 portfile 转发到 loopback HTTP 出口并回传结果。
 * （不依赖 electron；HTTP 出口用本地 stub 模拟 BrowserService。）
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MCP_SERVER_NAME, MCP_SERVER_SCRIPT } from './mcpServerScript';

interface JsonRpcMsg {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

describe('MCP server 脚本（stdio → HTTP 转发）', () => {
  let dir: string;
  let stub: Server;
  let stubPort = 0;
  let lastCall: { name?: string; sessionId?: string; args?: unknown; authed?: boolean } = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cs-mcp-test-'));
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { name?: string; sessionId?: string; args?: unknown };
        lastCall = { ...parsed, authed: req.headers.authorization === 'Bearer test-token' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: `stub-ok:${parsed.name ?? '?'}` }] }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const addr = stub.address();
    stubPort = typeof addr === 'object' && addr ? addr.port : 0;
    writeFileSync(join(dir, 'endpoint.json'), JSON.stringify({ port: stubPort }), 'utf8');
    writeFileSync(join(dir, 'server.mjs'), MCP_SERVER_SCRIPT, 'utf8');
  });

  afterAll(async () => {
    await new Promise((r) => stub.close(() => r(undefined)));
    rmSync(dir, { recursive: true, force: true });
  });

  function runScript(): { send: (msg: unknown) => void; next: () => Promise<JsonRpcMsg>; kill: () => void } {
    const child = spawn(process.execPath, [join(dir, 'server.mjs')], {
      env: {
        ...process.env,
        CYBERSLOTS_MCP_MANIFEST: JSON.stringify([
          { name: 'take_screenshot', description: 'shot', inputSchema: { type: 'object', properties: {} } },
        ]),
        CYBERSLOTS_MCP_PORTFILE: join(dir, 'endpoint.json'),
        CYBERSLOTS_MCP_TOKEN: 'test-token',
        CYBERSLOTS_SESSION_ID: 'sess-1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    const queue: JsonRpcMsg[] = [];
    const waiters: Array<(m: JsonRpcMsg) => void> = [];
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      buf += d;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as JsonRpcMsg;
        const w = waiters.shift();
        if (w) w(msg);
        else queue.push(msg);
      }
    });
    return {
      send: (msg) => child.stdin!.write(JSON.stringify(msg) + '\n'),
      next: () =>
        new Promise<JsonRpcMsg>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('MCP 应答超时')), 8000);
          const cached = queue.shift();
          if (cached) {
            clearTimeout(t);
            resolve(cached);
            return;
          }
          waiters.push((m) => {
            clearTimeout(t);
            resolve(m);
          });
        }),
      kill: () => child.kill(),
    };
  }

  it('initialize → tools/list → tools/call 全链路', async () => {
    const proc = runScript();
    try {
      proc.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      const init = await proc.next();
      const initResult = init.result as { serverInfo: { name: string }; capabilities: { tools: object } };
      expect(initResult.serverInfo.name).toBe(MCP_SERVER_NAME);
      expect(initResult.capabilities.tools).toBeDefined();

      proc.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const list = await proc.next();
      const tools = (list.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name)).toEqual(['take_screenshot']);

      proc.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'take_screenshot', arguments: {} } });
      const call = await proc.next();
      const content = (call.result as { content: Array<{ type: string; text?: string }> }).content;
      expect(content[0]?.text).toBe('stub-ok:take_screenshot');
      // 转发必须携带 sessionId 与 Bearer token（审批路由 + 鉴权的前提）。
      expect(lastCall.sessionId).toBe('sess-1');
      expect(lastCall.authed).toBe(true);

      // 未知方法 → -32601。
      proc.send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
      const unknown = await proc.next();
      expect(unknown.error?.message).toContain('Method not found');
    } finally {
      proc.kill();
    }
  }, 15_000);
});
