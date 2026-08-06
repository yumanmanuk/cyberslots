/**
 * probe-interrupt.mjs — 输出过程中断实测探针（codex / kimi ACP / omp ACP /
 * opencode / kimi KAP）。
 *
 * 每个引擎分两个阶段：
 *  - text：首段流式正文出现后立刻 cancel/abort/interrupt
 *  - tool：工具调用（长 sleep 命令）开始后立刻 cancel/abort/interrupt
 *
 * 指标：
 *  - cancel_rt_ms：cancel 协议调用自身往返耗时
 *  - stop_ms：从发起 cancel 到引擎回合真正收尾（turn.ended / prompt 响应 /
 *    session.idle / prompt.aborted）的延迟
 *  - stop_reason / status：引擎回报的收尾原因
 *
 * 用法：node scripts/probe-interrupt.mjs [--engines codex,kimi,omp,opencode,kimi-kap]
 *       [--rounds 3] [--tool]
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CWD = mkdtempSync(join(tmpdir(), 'probe-interrupt-'));

const argVal = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const ENGINES = (argVal('--engines') || 'codex,kimi,omp,opencode,kimi-kap')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ROUNDS = Number(argVal('--rounds') || 2);
const WITH_TOOL = process.argv.includes('--tool');
const WITH_GOAL = process.argv.includes('--goal');

const LONG_TEXT =
  '请用中文逐行输出数字 1 到 4000，每行一个数字，前面加“第”字，例如“第1行 1”。' +
  '不要停，不要总结，尽量输出尽可能多。';
const TOOL_TEXT =
  '请运行命令：python -c "import time; time.sleep(30)"，等命令执行完后再回复“完成”。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => console.log('[probe]', ...a);
const section = (t) => console.log(`\n========== ${t} ==========`);

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function codexBin() {
  const entry = join(
    process.env.APPDATA || '',
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  if (!existsSync(entry)) return { command: 'codex', args: [], shell: true };
  const managed = dirname(dirname(entry));
  const candidates = [
    join(managed, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    join(managed, '..', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    join(managed, 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
  ];
  const exe = candidates.find((p) => existsSync(p));
  return exe ? { command: exe, args: [], shell: false } : { command: entry, args: [], shell: false };
}

function kimiEntry() {
  const entry = join(
    process.env.APPDATA || '',
    'npm',
    'node_modules',
    '@moonshot-ai',
    'kimi-code',
    'dist',
    'main.mjs',
  );
  return existsSync(entry) ? entry : undefined;
}

function ompBin() {
  const p = join(process.env.LOCALAPPDATA || '', 'omp', 'omp.exe');
  return existsSync(p) ? p : 'omp';
}

function opencodeBin() {
  const p = join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  return existsSync(p) ? p : 'opencode';
}

// ---------------------------------------------------------------- JSON-RPC (codex)

class NdjsonRpc {
  constructor(child, onNotification, onServerRequest) {
    this.child = child;
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.feed(chunk));
  }

  feed(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    const id = msg.id;
    const method = msg.method;
    if (method && id !== undefined) {
      Promise.resolve()
        .then(() => this.onServerRequest(method, msg.params || {}))
        .then(
          (result) => this.child.stdin.write(JSON.stringify({ id, result: result ?? {} }) + '\n'),
          (err) =>
            this.child.stdin.write(
              JSON.stringify({ id, error: { code: -32603, message: String(err?.message || err) } }) + '\n',
            ),
        );
      return;
    }
    if (method) {
      this.onNotification(method, msg.params || {});
      return;
    }
    if (id !== undefined) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (msg.error) p.reject(new Error(`${msg.error.code || ''} ${msg.error.message || ''}`.trim()));
      else p.resolve(msg.result);
    }
  }

  request(method, params, timeoutMs = 90000) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ method, ...(params ? { params } : {}) }) + '\n');
  }
}

// ---------------------------------------------------------------- JSON-RPC (ACP)

class AcpRpc {
  constructor(child, onUpdate, onServerRequest) {
    this.child = child;
    this.onUpdate = onUpdate;
    this.onServerRequest = onServerRequest;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.feed(chunk));
  }

  feed(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.id !== undefined && msg.method) {
      Promise.resolve()
        .then(() => this.onServerRequest(msg.method, msg.params || {}))
        .then(
          (result) => this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n'),
          (err) =>
            this.child.stdin.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32603, message: String(err?.message || err) },
              }) + '\n',
            ),
        );
      return;
    }
    if (msg.method) {
      this.onUpdate(msg.method, msg.params || {});
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.code || ''} ${msg.error.message || ''}`.trim()));
      else p.resolve(msg.result);
    }
  }

  send(method, params, timeoutMs = 90000) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

async function waitUntil(check, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return Date.now() - start;
    await sleep(50);
  }
  throw new Error(`wait ${label || ''} timeout ${timeoutMs}ms`);
}

// ---------------------------------------------------------------- codex

async function runCodex(results) {
  section('codex (app-server RPC)');
  const spec = codexBin();
  const child = spawn(spec.command, ['app-server'], {
    cwd: CWD,
    shell: spec.shell,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderrTail = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    for (const l of String(d).split(/\r?\n/)) if (l.trim()) stderrTail.push(l);
    if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20);
  });

  let threadId = '';
  let turnId = '';
  let textSeen = false;
  let toolSeen = false;
  let completedResolve;
  let completedStatus = '';
  const completed = new Promise((resolve) => (completedResolve = resolve));
  // goal 场景状态
  let goalMode = false;
  let goalPromptCompletions = 0;
  let goalPromptDoneResolve;
  let goalBgStarted = false;
  let goalBgTurnId = '';
  let goalBgDoneResolve;

  const rpc = new NdjsonRpc(
    child,
    (method, params) => {
      if (method === 'turn/started') {
        turnId = String(params.turn?.id || '');
        if (goalMode && goalPromptCompletions >= 1 && !goalBgStarted) {
          goalBgStarted = true;
          goalBgTurnId = String(params.turn?.id || '');
        }
      } else if (method === 'item/agentMessage/delta') {
        if (String(params.delta || '').trim()) textSeen = true;
      } else if (method === 'item/started') {
        if (params.item?.type === 'commandExecution') toolSeen = true;
      } else if (method === 'turn/completed') {
        completedStatus = String(params.turn?.status || '');
        completedResolve();
        if (goalMode) {
          goalPromptCompletions++;
          if (goalPromptCompletions === 1) goalPromptDoneResolve?.();
          else goalBgDoneResolve?.();
        }
      }
    },
    (method) => {
      if (method.includes('requestApproval')) return Promise.resolve({ decision: 'accept' });
      return Promise.reject(new Error(`unsupported server request ${method}`));
    },
  );

  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'probe-interrupt', title: 'probe-interrupt', version: '0.0.1' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    const thread = await rpc.request('thread/start', {
      cwd: CWD,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    threadId = thread.thread.id;
    log('thread ready', threadId);

    const phases = [{ key: 'text', waitFor: () => textSeen, text: LONG_TEXT }];
    if (WITH_TOOL) phases.push({ key: 'tool', waitFor: () => toolSeen, text: TOOL_TEXT });

    for (const phase of phases) {
      for (let r = 0; r < ROUNDS; r++) {
        textSeen = false;
        toolSeen = false;
        turnId = '';
        completedStatus = '';
        const done = new Promise((resolve) => (completedResolve = resolve));
        const startP = rpc.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: phase.text }],
          approvalPolicy: 'on-request',
        });
        try {
          await waitUntil(() => turnId, 15000, 'turn id');
          await waitUntil(phase.waitFor, 60000, phase.key);
          const t0 = Date.now();
          const rtP = rpc
            .request('turn/interrupt', { threadId, turnId })
            .then(() => Date.now() - t0)
            .catch((e) => ({ err: String(e?.message || e) }));
          const doneP = done.then(() => Date.now() - t0);
          const [rt, stop] = await Promise.all([
            rtP,
            Promise.race([doneP, sleep(30000).then(() => '>30s')]),
          ]);
          results.push({
            engine: 'codex',
            phase: phase.key,
            round: r + 1,
            cancel_rt_ms: typeof rt === 'number' ? rt : rt,
            stop_ms: typeof stop === 'number' ? stop : stop,
            stop_reason: completedStatus,
          });
          log(`codex ${phase.key} #${r + 1} done`, JSON.stringify(results[results.length - 1]));
        } catch (e) {
          results.push({
            engine: 'codex',
            phase: phase.key,
            round: r + 1,
            error: String(e?.message || e),
          });
          log(`codex ${phase.key} #${r + 1} FAIL`, String(e?.message || e));
        } finally {
          try {
            await startP;
          } catch {
            /* turn already closed */
          }
          if (turnId) {
            try {
              await rpc.request('turn/interrupt', { threadId, turnId });
            } catch {
              /* best effort */
            }
          }
          await sleep(1200);
        }
      }
    }

    if (WITH_GOAL) {
      goalMode = true;
      goalPromptCompletions = 0;
      goalBgStarted = false;
      goalBgTurnId = '';
      const goalPromptDone = new Promise((resolve) => (goalPromptDoneResolve = resolve));
      const goalBgDone = new Promise((resolve) => (goalBgDoneResolve = resolve));
      let startP;
      try {
        await rpc.request('thread/goal/set', {
          threadId,
          objective: '请把 1 到 200 的数字逐个输出，不要停。',
          status: 'active',
        });
        log('codex goal set');
        turnId = '';
        startP = rpc.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: '开始' }],
          approvalPolicy: 'on-request',
        });
        await Promise.race([
          goalPromptDone,
          sleep(60000).then(() => {
            throw new Error('goal prompt turn timeout');
          }),
        ]);
        log('codex goal prompt turn done; waiting background turn');
        await waitUntil(() => goalBgStarted, 30000, 'goal bg turn');
        await sleep(1500);
        const t0 = Date.now();
        try {
          await rpc.request('thread/goal/set', { threadId, status: 'paused' });
        } catch (e) {
          log('codex goal pause err', String(e?.message || e));
        }
        const rtT = Date.now();
        let rt;
        try {
          await rpc.request('turn/interrupt', { threadId, turnId: goalBgTurnId });
          rt = Date.now() - rtT;
        } catch (e) {
          rt = `err:${String(e?.message || e)}`;
        }
        const stop = await Promise.race([
          goalBgDone.then(() => Date.now() - t0),
          sleep(25000).then(() => '>25s'),
        ]);
        results.push({
          engine: 'codex',
          phase: 'goal',
          round: 1,
          cancel_rt_ms: rt,
          stop_ms: stop,
          stop_reason: completedStatus,
        });
        log('codex goal done', JSON.stringify(results[results.length - 1]));
      } catch (e) {
        results.push({ engine: 'codex', phase: 'goal', round: 1, error: String(e?.message || e) });
        log('codex goal FAIL', String(e?.message || e));
      } finally {
        try {
          await rpc.request('thread/goal/clear', { threadId });
        } catch {
          /* best effort */
        }
        try {
          await startP;
        } catch {
          /* best effort */
        }
      }
    }
  } finally {
    killTree(child);
    if (stderrTail.length) log('codex stderr tail:', stderrTail.slice(-3));
  }
}

// ---------------------------------------------------------------- ACP (kimi / omp)

async function runAcp(engine, results) {
  section(`${engine} (ACP stdio)`);
  const kimi = kimiEntry();
  let cmd, args;
  if (engine === 'kimi') {
    if (!kimi) throw new Error('kimi main.mjs not found');
    cmd = process.execPath;
    args = [kimi, 'acp'];
  } else {
    cmd = ompBin();
    args = ['acp', '--approval-mode', 'always-ask'];
  }
  const child = spawn(cmd, args, {
    cwd: CWD,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderrTail = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    for (const l of String(d).split(/\r?\n/)) if (l.trim()) stderrTail.push(l);
    if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20);
  });

  let sessionId = '';
  let textSeen = false;
  let toolSeen = false;
  let rpc;

  try {
    rpc = new AcpRpc(
      child,
      (method, params) => {
        if (method !== 'session/update') return;
        const kind = params.update?.sessionUpdate;
        const content = params.update?.content || {};
        if (kind === 'agent_message_chunk' && (params.update?.text || content?.text)) textSeen = true;
        if (kind === 'tool_call') toolSeen = true;
      },
      (method, params) => {
        if (method === 'session/request_permission') {
          const opts = params.options || [];
          const allow = opts.find((o) => /allow/.test(String(o.kind || ''))) || opts[0];
          return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow?.optionId } });
        }
        return Promise.reject(new Error(`unsupported server request ${method}`));
      },
    );

    await rpc.send('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const sess = await rpc.send('session/new', { cwd: CWD, mcpServers: [] });
    sessionId = sess.sessionId;
    log('session ready', sessionId);

    const phases = [{ key: 'text', waitFor: () => textSeen, text: LONG_TEXT }];
    if (WITH_TOOL) phases.push({ key: 'tool', waitFor: () => toolSeen, text: TOOL_TEXT });

    for (const phase of phases) {
      for (let r = 0; r < ROUNDS; r++) {
        textSeen = false;
        toolSeen = false;
        try {
          const promptP = rpc
            .send(
              'session/prompt',
              { sessionId, prompt: [{ type: 'text', text: phase.text }] },
              60000,
            )
            .catch((e) => ({ __err: String(e?.message || e) }));
          await waitUntil(phase.waitFor, 60000, phase.key);
          const t0 = Date.now();
          rpc.notify('session/cancel', { sessionId });
          const stop = await Promise.race([
            promptP.then((res) => ({ stop_ms: Date.now() - t0, reason: res.stopReason })),
            sleep(30000).then(() => ({ stop_ms: '>30s', reason: 'timeout' })),
          ]);
          results.push({
            engine,
            phase: phase.key,
            round: r + 1,
            cancel_rt_ms: 'notify(0)',
            stop_ms: stop.stop_ms,
            stop_reason: stop.reason,
          });
          log(`${engine} ${phase.key} #${r + 1} done`, JSON.stringify(results[results.length - 1]));
        } catch (e) {
          results.push({ engine, phase: phase.key, round: r + 1, error: String(e?.message || e) });
          log(`${engine} ${phase.key} #${r + 1} FAIL`, String(e?.message || e));
        } finally {
          rpc.notify('session/cancel', { sessionId });
          await sleep(1500);
        }
      }
    }
  } finally {
    killTree(child);
    if (stderrTail.length) log(`${engine} stderr tail:`, stderrTail.slice(-3));
  }
}

// ---------------------------------------------------------------- opencode

async function runOpencode(results) {
  section('opencode (serve + SSE)');
  const bin = opencodeBin();
  const port = await findFreePort();
  const password = randomBytes(16).toString('hex');
  const authHeader = {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
  };
  const child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: CWD,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  });
  let stderrTail = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    for (const l of String(d).split(/\r?\n/)) if (l.trim()) stderrTail.push(l);
    if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20);
  });

  let baseUrl;
  try {
    baseUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('opencode ready timeout')), 30000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/listening on\s+(https?:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode serve exited code=${code}`));
      });
    });
    log('serve ready', baseUrl);

    const api = async (path, init = {}) => {
      const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...authHeader,
          'x-opencode-directory': CWD,
          ...(init.headers || {}),
        },
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, json };
    };

    const roles = new Map();
    let textSeen = false;
    let toolSeen = false;
    const sseTypes = new Map();
    let idleResolve;
    const idle = new Promise((resolve) => (idleResolve = resolve));
    const sseController = new AbortController();

    const sseP = (async () => {
      const res = await fetch(`${baseUrl}/event`, {
        headers: { Accept: 'text/event-stream', ...authHeader, 'x-opencode-directory': CWD },
        signal: sseController.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!dataLine) continue;
          let evt;
          try {
            evt = JSON.parse(dataLine);
          } catch {
            continue;
          }
          const props = evt.properties || {};
          sseTypes.set(evt.type, (sseTypes.get(evt.type) || 0) + 1);
          if (evt.type === 'message.updated') {
            const info = props.info || {};
            if (info.id) roles.set(String(info.id), String(info.role || ''));
          } else if (evt.type === 'message.part.updated' || evt.type === 'message.part.delta') {
            const part = props.part || {};
            const role = roles.get(String(part.messageID || ''));
            if (role === 'assistant') {
              if (part.type === 'text' && part.text) textSeen = true;
              if (part.type === 'tool') toolSeen = true;
            }
          } else if (evt.type === 'session.idle') {
            idleResolve();
          } else if (evt.type === 'permission.updated' || evt.type === 'permission.asked') {
            const id = String(props.id || '');
            if (id) void api(`/session/${sessionID}/permissions/${id}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ response: 'always' }),
            }).catch(() => undefined);
          }
        }
      }
    })().catch(() => undefined);

    const created = await api('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const sessionID = created.json?.id;
    if (!sessionID) throw new Error(`opencode session create failed ${created.status}`);
    log('session ready', sessionID);
    await sleep(800);

    const phases = [{ key: 'text', waitFor: () => textSeen, text: LONG_TEXT }];
    if (WITH_TOOL) phases.push({ key: 'tool', waitFor: () => toolSeen, text: TOOL_TEXT });

    for (const phase of phases) {
      for (let r = 0; r < ROUNDS; r++) {
        textSeen = false;
        toolSeen = false;
        const done = new Promise((resolve) => (idleResolve = resolve));
        try {
          const httpP = api(`/session/${sessionID}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parts: [{ type: 'text', text: phase.text }], agent: 'build' }),
          });
          await waitUntil(phase.waitFor, 60000, phase.key);
          const t0 = Date.now();
          const abortT = Date.now();
          const abortRes = await api(`/session/${sessionID}/abort`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          const rt = Date.now() - abortT;
          const stop = await Promise.race([done.then(() => Date.now() - t0), sleep(30000).then(() => '>30s')]);
          results.push({
            engine: 'opencode',
            phase: phase.key,
            round: r + 1,
            cancel_rt_ms: rt,
            stop_ms: stop,
            stop_reason: `abort http ${abortRes.status}`,
          });
          log(`opencode ${phase.key} #${r + 1} done`, JSON.stringify(results[results.length - 1]));
          try {
            await httpP;
          } catch {
            /* HTTP 错误通道，回合结束以 SSE 为准 */
          }
        } catch (e) {
          results.push({ engine: 'opencode', phase: phase.key, round: r + 1, error: String(e?.message || e) });
          log(`opencode ${phase.key} #${r + 1} FAIL`, String(e?.message || e));
          log('opencode sse types:', JSON.stringify([...sseTypes.entries()]));
        } finally {
          if (sessionID) {
            void api(`/session/${sessionID}/abort`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            }).catch(() => undefined);
          }
          await sleep(1500);
        }
      }
    }
    sseController.abort();
    await sseP;
  } finally {
    killTree(child);
    if (stderrTail.length) log('opencode stderr tail:', stderrTail.slice(-3));
  }
}

// ---------------------------------------------------------------- kimi KAP

async function runKimiKap(results) {
  section('kimi (KAP web + WS)');
  const kimi = kimiEntry();
  if (!kimi) throw new Error('kimi main.mjs not found');
  const home = join(homedir(), '.kimi-code');
  const child = spawn(process.execPath, [kimi, 'web', '--no-open', '--log-level', 'error'], {
    cwd: home,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderrTail = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    for (const l of String(d).split(/\r?\n/)) if (l.trim()) stderrTail.push(l);
    if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20);
  });

  let ws;
  try {
    const readyUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('kimi web ready timeout')), 45000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        const plain = buf.replace(/\u001b\[[0-9;]*m/g, '');
        const m = plain.match(/Kimi server(?: ready)?:?\s+(https?:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`kimi web exited code=${code}`));
      });
    });
    const [base, frag] = readyUrl.split('#');
    const origin = base.replace(/\/+$/, '');
    const token =
      /token=([^&\s]+)/.exec(frag || '')?.[1] ||
      (existsSync(join(home, 'server.token')) ? readFileSync(join(home, 'server.token'), 'utf8').trim() : '');
    if (!token) throw new Error('kimi kap token missing');
    log('kap ready', origin);

    const api = async (path, init = {}) => {
      const res = await fetch(`${origin}/api/v1${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.headers || {}),
        },
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return json?.data ?? json;
    };

    ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/v1/ws`, [`kimi-code.bearer.${token}`]);
    let textSeen = false;
    let toolSeen = false;
    const wsTypes = new Map();
    let promptEndResolve;
    let promptEndReason = '';
    let sessionId = '';
    const promptEnd = new Promise((resolve) => (promptEndResolve = resolve));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('kap ws open timeout')), 10000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const type = String(msg.type || '');
      wsTypes.set(type, (wsTypes.get(type) || 0) + 1);
      if (msg.seq === undefined) {
        if (type === 'ping') ws.send(JSON.stringify({ type: 'pong', payload: msg.payload || {} }));
        return;
      }
      if (msg.session_id !== undefined && msg.session_id !== sessionId) return;
      const p = msg.payload || {};
      if (['error', 'turn.ended', 'prompt.completed', 'agent.status.updated', 'turn.step.interrupted'].includes(type)) {
        log('kap ws', type, JSON.stringify(p).slice(0, 300));
      }
      if (type === 'assistant.delta') {
        const text = String(p.text ?? p.delta ?? '');
        if (text.trim()) textSeen = true;
      } else if (type === 'tool.call.started') {
        toolSeen = true;
      } else if (type === 'prompt.aborted' || type === 'prompt.completed') {
        promptEndReason = String(p.reason || type);
        promptEndResolve();
      } else if (type === 'event.session.work_changed') {
        if (String(p.pending_interaction || '') === 'approval') {
          void (async () => {
            const list = await api(`/sessions/${sessionId}/approvals?status=pending`).catch(() => ({}));
            for (const item of Array.isArray(list.items) ? list.items : []) {
              const id = String(item.approval_id || '');
              if (id) void api(`/sessions/${sessionId}/approvals/${id}`, {
                method: 'POST',
                body: JSON.stringify({ decision: 'approved' }),
              }).catch(() => undefined);
            }
          })();
        }
      } else if (type === 'agent.status.updated') {
        if (p.phase?.kind === 'awaiting_approval' && p.phase?.approval?.approval_id) {
          void api(`/sessions/${sessionId}/approvals/${p.phase.approval.approval_id}`, {
            method: 'POST',
            body: JSON.stringify({ decision: 'approved' }),
          }).catch(() => undefined);
        }
      }
    });

    ws.send(JSON.stringify({ type: 'client_hello', id: randomUUID(), payload: { client_id: randomUUID() } }));
    ws.send(JSON.stringify({ type: 'subscribe', id: randomUUID(), payload: { session_ids: [] } }));
    await sleep(500);

    const sess = await api('/sessions', {
      method: 'POST',
      body: JSON.stringify({ metadata: { cwd: CWD }, agent_config: { model: 'kimi/k3-256k' } }),
    });
    sessionId = String(sess.id || '');
    if (!sessionId) throw new Error('kap session create failed');
    await api(`/sessions/${sessionId}/profile`, {
      method: 'POST',
      body: JSON.stringify({ agent_config: { model: 'kimi/k3-256k' } }),
    }).catch((e) => log('kap setModel failed', String(e?.message || e)));
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        id: randomUUID(),
        payload: { session_ids: [sessionId], cursors: {} },
      }),
    );
    log('session ready', sessionId);
    await sleep(800);

    const phases = [{ key: 'text', waitFor: () => textSeen, text: LONG_TEXT }];
    if (WITH_TOOL) phases.push({ key: 'tool', waitFor: () => toolSeen, text: TOOL_TEXT });

    for (const phase of phases) {
      for (let r = 0; r < ROUNDS; r++) {
        textSeen = false;
        toolSeen = false;
        promptEndReason = '';
        const done = new Promise((resolve) => (promptEndResolve = resolve));
        try {
          const submitted = await api(`/sessions/${sessionId}/prompts`, {
            method: 'POST',
            body: JSON.stringify({ content: [{ type: 'text', text: phase.text }] }),
          });
          const promptId = String(submitted.prompt_id || submitted.id || '');
          if (!promptId) throw new Error(`kap prompt submit failed ${JSON.stringify(submitted).slice(0, 200)}`);
          log('kap prompt submitted', JSON.stringify(submitted).slice(0, 160));
          await waitUntil(phase.waitFor, 60000, phase.key);
          const t0 = Date.now();
          const abortT = Date.now();
          await api(`/sessions/${sessionId}/prompts/${promptId}:abort`, {
            method: 'POST',
            body: '{}',
          }).catch(() => undefined);
          const rt = Date.now() - abortT;
          const stop = await Promise.race([done.then(() => Date.now() - t0), sleep(30000).then(() => '>30s')]);
          results.push({
            engine: 'kimi-kap',
            phase: phase.key,
            round: r + 1,
            cancel_rt_ms: rt,
            stop_ms: stop,
            stop_reason: promptEndReason,
          });
          log(`kimi-kap ${phase.key} #${r + 1} done`, JSON.stringify(results[results.length - 1]));
        } catch (e) {
          results.push({ engine: 'kimi-kap', phase: phase.key, round: r + 1, error: String(e?.message || e) });
          log(`kimi-kap ${phase.key} #${r + 1} FAIL`, String(e?.message || e));
          log('kimi-kap ws types:', JSON.stringify([...wsTypes.entries()]));
        } finally {
          if (sessionId) {
            void api(`/sessions/${sessionId}:abort`, {
              method: 'POST',
              body: '{}',
            }).catch(() => undefined);
          }
          await sleep(1500);
        }
      }
    }
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    killTree(child);
    if (stderrTail.length) log('kimi kap stderr tail:', stderrTail.slice(-3));
  }
}

// ---------------------------------------------------------------- main

const results = [];
try {
  for (const engine of ENGINES) {
    try {
      if (engine === 'codex') await runCodex(results);
      else if (engine === 'kimi') await runAcp('kimi', results);
      else if (engine === 'omp') await runAcp('omp', results);
      else if (engine === 'opencode') await runOpencode(results);
      else if (engine === 'kimi-kap') await runKimiKap(results);
      else log('unknown engine', engine);
    } catch (e) {
      log(`FAIL ${engine}:`, e?.message || e);
    }
  }
} finally {
  section('结果汇总');
  console.table(
    results.map((r) => ({
      engine: r.engine,
      phase: r.phase,
      round: r.round,
      cancel_rt_ms: r.cancel_rt_ms ?? '',
      stop_ms: r.stop_ms ?? '',
      stop_reason: r.stop_reason ?? '',
      error: r.error ?? '',
    })),
  );
}
process.exit(0);
