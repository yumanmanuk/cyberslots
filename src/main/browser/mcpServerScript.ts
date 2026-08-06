/**
 * 受管浏览器 MCP server —— 单文件、零依赖 Node 脚本源码（运行时由
 * BrowserService 物化到 userData/browser-mcp/server.mjs，经 ELECTRON_RUN_AS_NODE
 * 拉起），以 stdio MCP 形式注册进各引擎：
 * - kimi/omp：ACP newSession 的 mcpServers 字段；
 * - claude：--mcp-config 指向的合并配置文件；
 * - codex：-c mcp_servers.* 配置覆盖。
 *
 * 脚本本身不含任何业务逻辑：tools/list 的工具清单由 env
 * CYBERSLOTS_MCP_MANIFEST 注入，tools/call 一律转发到主进程 BrowserService
 * 的 loopback HTTP 出口（端口现读 CYBERSLOTS_MCP_PORTFILE 指向的
 * endpoint.json + Bearer CYBERSLOTS_MCP_TOKEN），审批/审计/预算全部在
 * 主进程侧完成 —— 这就是「客户端出口统一钩子」：不依赖引擎主动发起审批。
 *
 * 脚本以字符串内嵌而非走 resources/extraResources：避免 asar 打包路径问题，
 * 回滚 = 关 flag / 删 src/main/browser 目录，无打包配置残留。
 */

export const MCP_SERVER_NAME = 'cyberslots-browser';

export const MCP_SERVER_SCRIPT = `// CyberSlots managed-browser MCP server (generated, do not edit).
// stdio JSON-RPC (newline-delimited) → forward tools/call to main process HTTP.
import fs from 'node:fs';
import readline from 'node:readline';

const MANIFEST = JSON.parse(process.env.CYBERSLOTS_MCP_MANIFEST || '[]');
const PORTFILE = process.env.CYBERSLOTS_MCP_PORTFILE || '';
const TOKEN = process.env.CYBERSLOTS_MCP_TOKEN || '';
const SESSION_ID = process.env.CYBERSLOTS_SESSION_ID || '';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

async function callTool(name, args) {
  // 端口现读：主进程 HTTP 出口在首次工具调用时才拉起，spec 创建时不烘端口。
  let url;
  try {
    const endpoint = JSON.parse(fs.readFileSync(PORTFILE, 'utf8'));
    url = 'http://127.0.0.1:' + endpoint.port + '/call';
  } catch {
    return { content: [{ type: 'text', text: 'CyberSlots 受管浏览器未就绪（endpoint.json 缺失），请稍后重试' }], isError: true };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ sessionId: SESSION_ID, name, args: args || {} }),
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { content: [{ type: 'text', text }] }; }
  if (!res.ok) {
    return { content: [{ type: 'text', text: payload.error || ('HTTP ' + res.status) }], isError: true };
  }
  return payload;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  // 通知（无 id）一律忽略。
  if (id === undefined || id === null) return;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: '${MCP_SERVER_NAME}', version: '0.1.0' },
      } });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: MANIFEST } });
    } else if (method === 'tools/call') {
      const result = await callTool(params && params.name, params && params.arguments);
      send({ jsonrpc: '2.0', id, result });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String((err && err.message) || err) } });
  }
});
`;
