/**
 * Routing probe — headless validation of the "CLI 配置只读 + 协议路由开关"
 * architecture, all four spawn modes:
 *   1. kimi direct   : no KIMI_CODE_HOME → ~/.kimi-code config
 *   2. kimi routed   : openai-server chat front + mirror home
 *   3. codex direct  : user ~/.codex (ChatGPT login), no overrides
 *   4. codex routed  : codex-server responses front + `-c` overrides
 *
 * Usage: node scripts/probe-routing.mjs [1|2|3|4 ...]  (default: all)
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK_DIR = join(ROOT, '.dev', 'workdir');
mkdirSync(WORK_DIR, { recursive: true });

const KIMI_CFG = join(homedir(), '.kimi-code', 'config.toml');
const PROMPT = '只回答数字：1+1=?';
const results = [];
const log = (...a) => console.log('[probe]', ...a);

function withTimeout(promise, ms, tag) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function kimiSpawnSpec() {
  const mainMjs = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
  if (existsSync(mainMjs)) return { command: process.execPath, args: [mainMjs, 'acp'] };
  return { command: 'kimi', args: ['acp'], shell: true };
}

function codexSpawnSpec(extraArgs) {
  const codexJs = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (existsSync(codexJs)) return { command: process.execPath, args: [codexJs, ...extraArgs] };
  return { command: 'codex', args: extraArgs, shell: true };
}

// ------------------------------------------------------------------ kimi

async function runKimi(label, env) {
  const spec = kimiSpawnSpec();
  const child = spawn(spec.command, spec.args, {
    cwd: WORK_DIR,
    shell: spec.shell ?? false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const errTail = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => errTail.push(d.trim()));
  try {
    const texts = { current: '' };
    const client = new ClientSideConnection(
      () => ({
        async sessionUpdate(n) {
          const u = n.update ?? {};
          if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') texts.current += u.content.text;
        },
        async requestPermission(p) {
          const pick = (p.options ?? [])[0];
          return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
        },
        async readTextFile() { throw new Error('disabled'); },
        async writeTextFile() { throw new Error('disabled'); },
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    );
    await withTimeout(client.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }), 30_000, `${label} initialize`);
    const sess = await withTimeout(client.newSession({ cwd: WORK_DIR, mcpServers: [] }), 30_000, `${label} session/new`);
    log(label, 'session', sess.sessionId);
    const res = await withTimeout(client.prompt({ sessionId: sess.sessionId, prompt: [{ type: 'text', text: PROMPT }] }), 120_000, `${label} prompt`);
    const reply = texts.current.trim().slice(0, 120);
    log(label, `stopReason=${res.stopReason} reply="${reply}"`);
    results.push({ label, ok: !!reply, detail: reply || `stopReason=${res.stopReason}; stderr=${errTail.slice(-3).join(' | ')}` });
  } catch (err) {
    results.push({ label, ok: false, detail: `${err.message}; stderr=${errTail.slice(-5).join(' | ')}` });
  } finally {
    child.kill();
  }
}

// ----------------------------------------------------------------- codex

/** Minimal app-server ndjson client (no jsonrpc field, id-based replies). */
function codexClient(child) {
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const waiters = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // server request (approvals) — approve everything in the probe
      child.stdin.write(JSON.stringify({ id: msg.id, result: { decision: 'accept' } }) + '\n');
      return;
    }
    if (msg.method) {
      notifications.push(msg);
      for (const w of [...waiters]) {
        if (w.match(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ method, params: params ?? {} }) + '\n');
    },
    waitFor(match, ms, tag) {
      const hit = notifications.find(match);
      if (hit) return Promise.resolve(hit);
      return withTimeout(new Promise((resolve) => waiters.push({ match, resolve })), ms, tag);
    },
    notifications,
  };
}

async function runCodex(label, extraArgs, { model } = {}) {
  const spec = codexSpawnSpec([...extraArgs, 'app-server']);
  const child = spawn(spec.command, spec.args, {
    cwd: WORK_DIR,
    shell: spec.shell ?? false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const errTail = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => errTail.push(d.trim()));
  try {
    const rpc = codexClient(child);
    await withTimeout(rpc.request('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '0' } }), 30_000, `${label} initialize`);
    rpc.notify('initialized');
    const threadParams = { cwd: WORK_DIR, approvalPolicy: 'never', sandbox: 'read-only' };
    if (model) threadParams.model = model;
    if (extraArgs.length > 0) threadParams.modelProvider = 'cyberslots';
    const started = await withTimeout(rpc.request('thread/start', threadParams), 30_000, `${label} thread/start`);
    log(label, 'thread', started.thread?.id);
    const turnParams = { threadId: started.thread.id, input: [{ type: 'text', text: PROMPT }], approvalPolicy: 'never' };
    if (model) turnParams.model = model;
    await withTimeout(rpc.request('turn/start', turnParams), 30_000, `${label} turn/start`);
    const done = await rpc.waitFor((m) => m.method === 'turn/completed', 180_000, `${label} turn/completed`);
    const status = done.params?.turn?.status;
    const deltas = rpc.notifications
      .filter((m) => m.method === 'item/agentMessage/delta')
      .map((m) => m.params?.delta ?? '')
      .join('');
    log(label, `status=${status} reply="${deltas.trim().slice(0, 120)}"`);
    results.push({ label, ok: status === 'completed' && !!deltas.trim(), detail: deltas.trim().slice(0, 120) || `status=${status}; err=${JSON.stringify(done.params?.turn?.error ?? null)}` });
  } catch (err) {
    results.push({ label, ok: false, detail: `${err.message}; stderr=${errTail.slice(-5).join(' | ')}` });
  } finally {
    child.kill();
  }
}

// --------------------------------------------------------- local fronts

function upstreamsFromKimiConfig() {
  const doc = tomlParse(readFileSync(KIMI_CFG, 'utf8'));
  const providers = doc.providers ?? {};
  const ups = {};
  for (const p of Object.values(providers)) {
    if (!ups.chat && (p.type === 'kimi' || p.type === 'openai') && p.base_url) ups.chat = { baseUrl: p.base_url, apiKey: p.api_key ?? '' };
    if (!ups.responses && p.type === 'openai_responses' && p.base_url) ups.responses = { baseUrl: p.base_url, apiKey: p.api_key ?? '' };
  }
  return ups;
}

function startFront(entry, portEnvName, port, ups) {
  const child = spawn(process.execPath, [join(ROOT, 'resources', 'ai-server', entry)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      [portEnvName]: String(port),
      KIMI_OPENAI_BASE_URL: ups.chat?.baseUrl ?? '',
      KIMI_API_KEY: ups.chat?.apiKey ?? '',
      MINIMAX_OPENAI_BASE_URL: ups.responses?.baseUrl ?? '',
      MINIMAX_API_KEY: ups.responses?.apiKey ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${entry}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${entry}:err] ${d}`));
  return child;
}

async function waitPort(port, ms) {
  const { connect } = await import('node:net');
  const deadline = Date.now() + ms;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const s = connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
      s.setTimeout(800, () => { s.destroy(); resolve(false); });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`front on ${port} not ready`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ------------------------------------------------------------------ main

const picks = process.argv.slice(2).map(Number);
const want = (n) => picks.length === 0 || picks.includes(n);

if (want(1)) {
  log('=== 1. kimi direct (~/.kimi-code) ===');
  await runKimi('kimi-direct', {});
}

if (want(2)) {
  log('=== 2. kimi routed (openai-server front + mirror home) ===');
  const ups = upstreamsFromKimiConfig();
  const port = 3891;
  const front = startFront('openai-server.js', 'OPENAI_PORT_OVERRIDE', port, ups);
  try {
    await waitPort(port, 10_000);
    // mirror home: chat provider base_url → local front
    const mirror = join(ROOT, '.dev', 'kimi-route-home');
    mkdirSync(mirror, { recursive: true });
    const doc = tomlParse(readFileSync(KIMI_CFG, 'utf8'));
    for (const p of Object.values(doc.providers ?? {})) {
      if ((p.type === 'kimi' || p.type === 'openai') && p.base_url) p.base_url = `http://127.0.0.1:${port}/v1`;
    }
    writeFileSync(join(mirror, 'config.toml'), tomlStringify(doc) + '\n', 'utf8');
    await runKimi('kimi-routed', { KIMI_CODE_HOME: mirror });
  } catch (err) {
    results.push({ label: 'kimi-routed', ok: false, detail: err.message });
  } finally {
    front.kill();
  }
}

if (want(3)) {
  log('=== 3. codex direct (~/.codex, ChatGPT login) ===');
  await runCodex('codex-direct', []);
}

if (want(4)) {
  log('=== 4. codex routed (codex-server front + -c overrides) ===');
  const ups = upstreamsFromKimiConfig();
  const port = 3892;
  const front = startFront('codex-server.js', 'CODEX_PORT_OVERRIDE', port, ups);
  try {
    await waitPort(port, 10_000);
    const overrides = [
      '-c', 'model_provider=cyberslots',
      '-c', 'model_providers.cyberslots.name=CyberSlots-Router',
      '-c', `model_providers.cyberslots.base_url=http://127.0.0.1:${port}/v1`,
      '-c', 'model_providers.cyberslots.wire_api=responses',
      '-c', 'model_providers.cyberslots.requires_openai_auth=false',
    ];
    await runCodex('codex-routed', overrides, { model: 'MiniMax-M3' });
  } catch (err) {
    results.push({ label: 'codex-routed', ok: false, detail: err.message });
  } finally {
    front.kill();
  }
}

console.log('\n================= RESULTS =================');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}  ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
