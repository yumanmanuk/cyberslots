/**
 * probe-mcp-channel.mjs — P4 MCP 通道生效验证（kimi + omp，受管浏览器 MCP 落地前的门禁）。
 *
 * 验证 ACP `session/new` 的 mcpServers 字段是否真把工具落到引擎侧。本脚本双角色：
 *  - 默认 = 探针：逐引擎 spawn ACP 进程，session/new 挂一个临时 MCP stdio server
 *    （即本脚本 --serve），prompt 要求调用 cs_echo，观察事件流里的成功信号。
 *  - --serve = MCP server：换行分隔 JSON-RPC over stdio，同
 *    src/main/browser/mcpServerScript.ts 的手写风格：
 *      initialize      → capabilities.tools
 *      tools/list      → 单工具 cs_echo {text: string}
 *      tools/call      → {content:[{type:'text', text:'ECHO:'+args.text}]}
 *      其他 method     → -32601
 *
 * 成功信号：tool_call / tool_call_update 通知的 title/name 含 cs_echo，
 * 或 assistant 文本含 ECHO:ping。session/new 拒绝 mcpServers 或工具始终不出现 →
 * 打印「该引擎降级为『无浏览器工具』（不回落 prompt 注入）」。
 *
 * 用法：
 *   node scripts/probe-mcp-channel.mjs                 # 探针（kimi + omp）
 *   node scripts/probe-mcp-channel.mjs --engine kimi   # 只测单引擎
 *   node scripts/probe-mcp-channel.mjs --model kimi/k3 # omp 侧显式模型（隔离目录下必须）
 *   node scripts/probe-mcp-channel.mjs --serve         # MCP server 模式（被引擎拉起）
 *
 * 退出码：≥1 引擎 PASS → 0；两引擎均 FAIL → 2；基础设施错误 → 1。
 *
 * 注：只读探测/不写用户配置 —— omp 侧 PI_CODING_AGENT_DIR 指向临时目录
 *    （models.yml/config.yml 种子自 ~/.omp/agent 只读拷贝，探针结束删除）；
 *     kimi 侧用默认 home 解析（同 KimiAdapter 直连用户配置，不覆写）；
 *     request_permission 一律自动 allow-once（同 probe-omp.mjs 约定）。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const log = (...a) => console.log('[probe]', ...a);
const section = (t) => console.log(`\n========== ${t} ==========`);

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ================================================================ --serve：MCP stdio server
if (process.argv.includes('--serve')) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const dbg = (...a) => console.error('[cs-probe-mcp]', ...a);
  const CS_ECHO = {
    name: 'cs_echo',
    description: 'Echo text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  };
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined || id === null) return; // 通知一律忽略
    try {
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cs-probe', version: '0.1.0' } },
        });
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: [CS_ECHO] } });
      } else if (method === 'tools/call') {
        if (params?.name === 'cs_echo') {
          const text = String(params?.arguments?.text ?? '');
          dbg('cs_echo called, text =', text);
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ECHO:' + text }] } });
        } else {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'unknown tool: ' + params?.name }], isError: true } });
        }
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
      }
    } catch (err) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  });
  dbg('cs-probe MCP server ready');
  // 永不主动退出 —— 由引擎关闭 stdio 结束
  await new Promise(() => {});
}

// ================================================================ 探针模式
const OMP = process.env.OMP_BIN || join(process.env.LOCALAPPDATA || '', 'omp', 'omp.exe');
const KIMI_MAIN =
  process.env.KIMI_CLI_ENTRY ||
  join(process.env.APPDATA || '', 'npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
const ONLY_ENGINE = argVal('--engine');
const MODEL = argVal('--model'); // omp 侧 spawn --model（隔离目录下默认模型不可解析时必须显式带，probe-omp-findings §9）
const PROMPT_TIMEOUT_MS = 120_000;
const PROMPT_TEXT = '请调用 cs-probe 服务器的 cs_echo 工具，text 填 "ping"，并把结果原样告诉我。';

// omp 隔离 session-dir（种子自 ~/.omp/agent 只读拷贝放临时目录根 ——
// PI_CODING_AGENT_DIR 即 agent 目录本体；不写用户配置）
const ompAgentDir = mkdtempSync(join(tmpdir(), 'probe-mcp-omp-agent-'));
{
  const srcAgent = join(homedir(), '.omp', 'agent');
  for (const f of ['models.yml', 'config.yml']) {
    const src = join(srcAgent, f);
    if (existsSync(src)) copyFileSync(src, join(ompAgentDir, f));
  }
}

const engines = [
  {
    id: 'omp',
    available: existsSync(OMP),
    spec: () => ({ command: OMP, args: ['acp', '--approval-mode', 'always-ask', ...(MODEL ? ['--model', MODEL] : [])] }),
    env: () => ({ ...process.env, PI_CODING_AGENT_DIR: ompAgentDir }),
  },
  {
    id: 'kimi',
    available: existsSync(KIMI_MAIN),
    spec: () => ({ command: process.execPath, args: [KIMI_MAIN, 'acp'] }),
    env: () => {
      const env = { ...process.env };
      delete env.KIMI_CODE_HOME; // 用默认 home 解析（同 kimiSpawnEnv(undefined)）
      return env;
    },
  },
];

const results = new Map(); // engineId -> 'PASS' | 'FAIL' | 'INFRA'
for (const eng of engines) {
  if (ONLY_ENGINE && eng.id !== ONLY_ENGINE) continue;
  section(`引擎 = ${eng.id}`);
  if (!eng.available) {
    log(`${eng.id} 二进制不可用（${eng.id === 'omp' ? OMP : KIMI_MAIN}）→ INFRA`);
    results.set(eng.id, 'INFRA');
    continue;
  }
  const r = await runEngine(eng);
  results.set(eng.id, r);
}

// ---------------------------------------------------------------- 汇总
section('逐引擎汇总');
for (const [id, r] of results) log(`${r === 'PASS' ? 'PASS' : r === 'FAIL' ? 'FAIL' : 'INFRA'}  ${id}`);
// 清理 omp 隔离目录（含凭据拷贝；taskkill 后句柄释放有延迟 → 重试 3 次）
let removed = false;
for (let i = 0; i < 3 && !removed; i++) {
  try {
    rmSync(ompAgentDir, { recursive: true, force: true });
    removed = true;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (removed) log('omp 临时隔离目录已删除');
else log('omp 临时目录删除失败（可手动删）:', ompAgentDir);
const vals = [...results.values()];
if (vals.includes('PASS')) process.exit(0);
if (vals.includes('FAIL')) process.exit(2);
process.exit(1);

// ================================================================ per-engine runner
async function runEngine(eng) {
  const cwd = mkdtempSync(join(tmpdir(), `probe-mcp-${eng.id}-`));
  const spec = eng.spec();
  log('spawn =', spec.command, spec.args.join(' '));
  log('cwd =', cwd);

  const child = spawn(spec.command, spec.args, {
    cwd,
    env: eng.env(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let spawnFailed = false;
  child.once('error', () => {
    spawnFailed = true;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line.trim()) console.error('[acp:err]', line.slice(0, 300));
  });

  // --- ndjson JSON-RPC 客户端（LF 分帧，同 probe-omp.mjs）---
  const pending = new Map();
  let nextId = 1;
  let rxBuf = '';
  let sawEchoTool = false;
  let sawEchoText = false;
  let permCount = 0;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    rxBuf += chunk;
    let nl;
    while ((nl = rxBuf.indexOf('\n')) !== -1) {
      const line = rxBuf.slice(0, nl).replace(/\r$/, '');
      rxBuf = rxBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log('非 JSON 行:', line.slice(0, 200));
        continue;
      }
      handleMessage(msg);
    }
  });

  function handleMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(msg.error) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method && msg.id !== undefined) {
      onServerRequest(msg);
      return;
    }
    if (msg.method === 'session/update') {
      const u = msg.params?.update ?? {};
      const kind = u.sessionUpdate ?? '?';
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const blob = JSON.stringify(u);
        const title = u.title ?? u.name ?? '';
        log(`  工具事件（${kind}）: ${String(title).slice(0, 140)}`, blob.slice(0, 260));
        if (/cs_echo/.test(blob)) {
          sawEchoTool = true;
          log('  ★ 命中 cs_echo 工具事件');
        }
      } else if (kind === 'agent_message_chunk') {
        const text = u.content?.text ?? '';
        if (text.trim()) log('  agent:', text.slice(0, 200).replace(/\n/g, ' '));
        if (/ECHO:ping/.test(text)) {
          sawEchoText = true;
          log('  ★ 命中 assistant 文本 ECHO:ping');
        }
      } else {
        log(`  update: ${kind}`);
      }
    }
  }

  function onServerRequest(msg) {
    if (msg.method === 'session/request_permission') {
      permCount += 1;
      const opts = msg.params?.options ?? [];
      const title = msg.params?.toolCall?.title ?? msg.params?.title ?? '';
      log(`  ⇐ request_permission #${permCount}: ${String(title).slice(0, 160)} → 自动 allow-once`);
      const allow = opts.find((o) => /allow/.test(o.kind ?? '')) ?? opts[0];
      reply(msg.id, { outcome: { outcome: 'selected', optionId: allow?.optionId } });
      return;
    }
    if (msg.method === 'fs/read_text_file' || msg.method === 'fs/write_text_file') {
      reply(msg.id, msg.method === 'fs/read_text_file' ? { content: '' } : {});
      return;
    }
    replyError(msg.id, -32601, `probe: method ${msg.method} not handled`);
  }

  function send(method, params, timeoutMs = 60_000) {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method} 超时（${timeoutMs}ms）`));
        }
      }, timeoutMs);
    });
  }
  function reply(id, result) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
  function replyError(id, code, message) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }
  async function killTree() {
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill();
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  try {
    // --- 握手 ---
    const init = await send('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    }).catch((e) => ({ __err: e?.message ?? e }));
    if (spawnFailed || init?.__err || !init?.agentInfo) {
      log('initialize 失败 → INFRA:', JSON.stringify(init?.__err ?? init).slice(0, 300));
      return 'INFRA';
    }
    log('agent =', init.agentInfo?.name, init.agentInfo?.version);

    // --- session/new 挂 MCP ---
    const newSess = await send('session/new', {
      cwd,
      mcpServers: [{ name: 'cs-probe', command: process.execPath, args: [__filename, '--serve'], env: [] }],
    }).catch((e) => ({ __err: e?.message ?? e }));
    const sessionId = newSess?.sessionId;
    if (!sessionId) {
      log('session/new 拒绝 mcpServers / 建会话失败:', JSON.stringify(newSess?.__err ?? newSess).slice(0, 400));
      log('该引擎降级为「无浏览器工具」（不回落 prompt 注入）');
      return 'FAIL';
    }
    log('sessionId =', sessionId);

    // --- prompt ---
    const t0 = Date.now();
    const p = await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: PROMPT_TEXT }] }, PROMPT_TIMEOUT_MS).catch(
      async (e) => {
        await send('session/cancel', { sessionId }).catch(() => undefined);
        return { __err: e?.message ?? e };
      },
    );
    log(`prompt 返回（${Date.now() - t0}ms）:`, JSON.stringify(p?.__err ? { err: p.__err } : p ?? {}).slice(0, 300));

    const pass = sawEchoTool || sawEchoText;
    log(
      `证据: cs_echo 工具事件=${sawEchoTool} ECHO:ping 文本=${sawEchoText} request_permission=${permCount}`,
    );
    if (!pass) log('该引擎降级为「无浏览器工具」（不回落 prompt 注入）');
    return pass ? 'PASS' : 'FAIL';
  } finally {
    await killTree();
  }
}
