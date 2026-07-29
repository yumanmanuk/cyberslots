/**
 * probe-omp.mjs — oh-my-pi (omp) ACP 接入契约探针（实现 OmpAdapter 前的门禁）。
 *
 * omp 通过 `omp acp` 暴露 ACP JSON-RPC（ndjson on stdio），协议面与 kimi 同源，
 * 但 omp 是 batteries-included fork（32 工具、subagent、LSP、hashline 编辑…），
 * 需实测其 ACP 面到底暴露哪些能力，作为 OmpAdapter 的地面真值。
 *
 * 实测项（对应实施计划 Phase 0 清单）：
 *  1. CLI 版本 + models --json 目录形态（provider/思考档/订阅标记）
 *  2. spawn `omp acp` → initialize 能力声明
 *  3. session/new → configOptions（model / mode 档位枚举）
 *  4. prompt 流：text / thinking chunk、tool_call 事件、plan、usage
 *  5. session/set_mode（plan 语义）、set_config_option（model/thinking）
 *  6. request_permission 选项形状
 *  7. resume / fork 是否暴露（Method not found 即降级）
 *  8. available_commands_update 内容（斜杠命令白名单素材）
 *  9. tool_call 字段：kind/locations/content(diff|patch)、task 进度、ast_edit 两阶段
 *
 * 用法：node scripts/probe-omp.mjs [--no-prompt] [--model <slug>]
 *
 * 注：不写用户 ~/.omp 配置；用临时 cwd + 临时 session-dir，只读探测。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OMP = process.env.OMP_BIN || join(process.env.LOCALAPPDATA || '', 'omp', 'omp.exe');
const NO_PROMPT = process.argv.includes('--no-prompt');
const MODEL = argVal('--model');

const log = (...a) => console.log('[probe]', ...a);
const section = (t) => console.log(`\n========== ${t} ==========`);

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---------------------------------------------------------------- 1. CLI + models
section('1. CLI 版本 + models --json');
const version = await runCapture(OMP, ['--version']);
if (!version) {
  console.error(`[probe] FAIL: omp CLI 不可用（${OMP}）。设 OMP_BIN 指向 omp.exe。`);
  process.exit(1);
}
log('omp version =', version.trim());

const modelsRaw = await runCapture(OMP, ['models', '--json'], 60_000);
let models = [];
try {
  const parsed = JSON.parse(modelsRaw);
  models = Array.isArray(parsed) ? parsed : (parsed.models ?? parsed.data ?? []);
} catch {
  log('models --json 解析失败，原始前 500 字：', modelsRaw.slice(0, 500));
}
log('models 条目数 =', Array.isArray(models) ? models.length : '(非数组)');
if (Array.isArray(models) && models.length) {
  section('1b. 模型条目字段采样（前 3 条）');
  for (const m of models.slice(0, 3)) console.log(JSON.stringify(m, null, 2).slice(0, 1200));
  // provider 归组 + 思考档统计
  const providers = new Set();
  const withEfforts = [];
  for (const m of models) {
    const pid = m.provider ?? m.providerID ?? (typeof m.id === 'string' ? m.id.split('/')[0] : '?');
    providers.add(pid);
    const eff = m.efforts ?? m.thinkingLevels ?? m.reasoning ?? m.thinking;
    if (eff) withEfforts.push(`${m.id ?? m.slug}: ${JSON.stringify(eff)}`);
  }
  log('providers =', [...providers].join(', '));
  if (withEfforts.length) {
    section('1c. 带思考档的模型样本（前 5）');
    for (const e of withEfforts.slice(0, 5)) console.log('  ', e);
  }
}

// ---------------------------------------------------------------- ACP over stdio
section('2. spawn `omp acp` + JSON-RPC 握手');
const cwd = mkdtempSync(join(tmpdir(), 'probe-omp-'));
const sessionDir = mkdtempSync(join(tmpdir(), 'probe-omp-sess-'));
log('cwd =', cwd);

const child = spawn(OMP, ['acp', ...(MODEL ? ['--model', MODEL] : []), '--approval-mode', 'always-ask'], {
  cwd,
  env: { ...process.env, PI_CODING_AGENT_DIR: sessionDir },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let exited = false;
child.on('exit', (code, signal) => {
  exited = true;
  log(`omp acp 退出 code=${code} signal=${signal ?? 'none'}`);
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => {
  for (const line of String(d).split(/\r?\n/)) if (line.trim()) console.error('[acp:err]', line);
});

// --- ndjson JSON-RPC 客户端（LF 分帧）---
const pending = new Map(); // id -> {resolve,reject}
const notifications = []; // 收到的 session/update 通知
const seenUpdateKinds = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
let rxBuf = '';
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
  // 响应
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(msg.error) : p.resolve(msg.result);
    }
    return;
  }
  // 服务端 → 客户端请求（如 session/request_permission、fs/read_text_file）
  if (msg.method && msg.id !== undefined) {
    onServerRequest(msg);
    return;
  }
  // 通知（session/update 等）
  if (msg.method) {
    if (msg.method === 'session/update') {
      const kind = msg.params?.update?.sessionUpdate ?? '?';
      seenUpdateKinds.set(kind, (seenUpdateKinds.get(kind) ?? 0) + 1);
      notifications.push(msg.params);
    } else {
      log('通知:', msg.method, JSON.stringify(msg.params ?? {}).slice(0, 200));
    }
  }
}

function onServerRequest(msg) {
  log(`⇐ 服务端请求 ${msg.method}:`, JSON.stringify(msg.params ?? {}).slice(0, 400));
  if (msg.method === 'session/request_permission') {
    section('6. request_permission 选项形状（首次命中）');
    console.log(JSON.stringify(msg.params, null, 2).slice(0, 1500));
    // 自动允许一次（选第一个 allow 类选项）
    const opts = msg.params?.options ?? [];
    const allow = opts.find((o) => /allow/.test(o.kind ?? '')) ?? opts[0];
    reply(msg.id, { outcome: { outcome: 'selected', optionId: allow?.optionId } });
    return;
  }
  if (msg.method === 'fs/read_text_file' || msg.method === 'fs/write_text_file') {
    reply(msg.id, msg.method === 'fs/read_text_file' ? { content: '' } : {});
    return;
  }
  // 未知请求：回 method not found
  replyError(msg.id, -32601, `probe: method ${msg.method} not handled`);
}

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 60_000);
  });
}
function reply(id, result) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

// --- 握手 ---
const init = await send('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
}).catch((e) => ({ __err: e }));
section('2b. initialize 结果');
console.log(JSON.stringify(init, null, 2).slice(0, 2500));

// --- session/new ---
section('3. session/new + configOptions');
const newSess = await send('session/new', { cwd, mcpServers: [] }).catch((e) => ({ __err: e }));
console.log(JSON.stringify(newSess, null, 2).slice(0, 2500));
const sessionId = newSess?.sessionId;
if (!sessionId) {
  log('FAIL: 无 sessionId，无法继续');
  await cleanup();
  process.exit(1);
}

// --- set_mode / set_config_option 探测 ---
section('5. session/set_mode + set_config_option');
for (const modeId of ['plan', 'default', 'yolo', 'auto', 'write', 'always-ask']) {
  const r = await send('session/set_mode', { sessionId, modeId }).catch((e) => ({ __err: e?.message ?? e }));
  log(`set_mode(${modeId}) →`, JSON.stringify(r).slice(0, 160));
}
for (const [optionId, value] of [
  ['model', MODEL ?? ''],
  ['thinking', 'high'],
  ['thinkingLevel', 'high'],
]) {
  if (optionId === 'model' && !value) continue;
  const r = await send('session/set_config_option', { sessionId, optionId, value }).catch((e) => ({ __err: e?.message ?? e }));
  log(`set_config_option(${optionId}=${value}) →`, JSON.stringify(r).slice(0, 160));
}

// --- resume / fork 探测（能力存在性）---
section('7. resume / fork 能力探测');
const resumeR = await send('session/load', { sessionId, cwd, mcpServers: [] }).catch((e) => ({ __err: e?.message ?? e }));
log('session/load →', JSON.stringify(resumeR).slice(0, 200));
const forkR = await send('session/fork', { sessionId, cwd, mcpServers: [] }).catch((e) => ({ __err: e?.message ?? e }));
log('session/fork →', JSON.stringify(forkR).slice(0, 200));
const unstableForkR = await send('unstable_forkSession', { sessionId, cwd, mcpServers: [] }).catch((e) => ({ __err: e?.message ?? e }));
log('unstable_forkSession →', JSON.stringify(unstableForkR).slice(0, 200));

// --- prompt ---
if (!NO_PROMPT) {
  section('4. prompt（观察事件流）');
  const t0 = Date.now();
  const promptR = await send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '用 read 或 ls 工具列出当前目录，然后写一个 hello.txt 内容为 hi，最后回答完成。' }],
  }).catch((e) => ({ __err: e?.message ?? e }));
  log(`session/prompt 返回（${Date.now() - t0}ms）:`, JSON.stringify(promptR).slice(0, 300));
} else {
  section('4. prompt（跳过）');
}

// --- 事件汇总 ---
section('8. session/update 类型汇总');
for (const [k, n] of [...seenUpdateKinds.entries()].sort()) log(`  ${k} × ${n}`);
section('8b. 各类型首个通知样本（截断）');
const dumped = new Set();
for (const p of notifications) {
  const kind = p?.update?.sessionUpdate ?? '?';
  if (dumped.has(kind)) continue;
  dumped.add(kind);
  console.log(`--- ${kind}\n${JSON.stringify(p).slice(0, 1500)}`);
}

await cleanup();
log('done. exited =', exited);
process.exit(0);

// ---------------------------------------------------------------- helpers
async function cleanup() {
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

function runCapture(cmd, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', () => {});
    const timer = setTimeout(() => {
      try {
        c.kill();
      } catch {
        /* ignore */
      }
      resolve(out);
    }, timeoutMs);
    c.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    c.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}
