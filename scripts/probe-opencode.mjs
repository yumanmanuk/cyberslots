/**
 * probe-opencode.mjs — opencode serve 接入契约探针（实现 OpencodeAdapter 前的门禁）。
 *
 * 实测项（对应实施计划「前置探针」清单）：
 *  1. CLI 探测与版本
 *  2. 自选空闲端口启动 serve + OPENCODE_SERVER_PASSWORD（Basic auth）
 *  3. stdout 就绪行解析 + /global/health
 *  4. GET /config/providers vs GET /provider 返回差异（含 zen 免费模型）
 *  5. GET /doc（OpenAPI）→ session/permission/fork/summarize 端点地面真值
 *  6. 建 session（x-opencode-directory 头）→ SSE /event 订阅 → prompt → 事件枚举
 *  7. abort / fork / summarize / GET /session/{id}（resume 验证）
 *
 * 用法：node scripts/probe-opencode.mjs [--keep] [--no-prompt]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEEP = process.argv.includes('--keep');
const NO_PROMPT = process.argv.includes('--no-prompt');

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

// ---------------------------------------------------------------- 1. CLI
section('1. CLI 探测');
const versionOut = await new Promise((resolve) => {
  const c = spawn('opencode', ['--version'], { shell: true, windowsHide: true });
  let out = '';
  c.stdout.on('data', (d) => (out += d));
  c.on('close', () => resolve(out.trim()));
  c.on('error', () => resolve(''));
});
if (!versionOut) {
  console.error('[probe] FAIL: opencode CLI 不可用（PATH 中未找到）');
  process.exit(1);
}
log('opencode version =', versionOut);

// ---------------------------------------------------------------- 2. serve
section('2. 启动 serve（自选端口 + 密码）');
const port = await findFreePort();
const password = randomBytes(16).toString('hex');
const authHeader = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
const cwd = mkdtempSync(join(tmpdir(), 'probe-opencode-'));
log('port =', port, 'cwd =', cwd);

const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  shell: true,
  windowsHide: true,
  cwd,
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverExited = false;
child.on('exit', (code) => {
  serverExited = true;
  log(`serve 进程退出 code=${code}`);
});

const baseUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('等待就绪行超时(30s)。stdout:\n' + buf)), 30_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    const m = buf.match(/listening on\s+(https?:\/\/[^\s]+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => process.stderr.write('[serve:err] ' + d));
}).catch((err) => {
  console.error('[probe] FAIL:', err.message);
  process.exit(1);
});
log('就绪行 baseUrl =', baseUrl);

const api = async (path, init = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...authHeader, 'x-opencode-directory': cwd, ...(init.headers ?? {}) },
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

// 鉴权验证：无密码请求应 401
const noAuth = await fetch(`${baseUrl}/config/providers`, { headers: { Accept: 'application/json' } });
log('无鉴权请求 /config/providers →', noAuth.status, noAuth.status === 401 ? '(鉴权生效 ✅)' : '(⚠️ 未启用鉴权!)');

const health = await api('/global/health');
log('/global/health →', health.status, JSON.stringify(health.json).slice(0, 200));

// ---------------------------------------------------------------- 3. providers
section('3. /config/providers vs /provider');
const cfgProviders = await api('/config/providers');
const provList = await api('/provider');
const cp = cfgProviders.json;
const cpArr = cp?.providers ?? [];
log(`/config/providers → ${cfgProviders.status}; providers=${cpArr.length}`);
for (const p of cpArr) {
  const models = Object.keys(p.models ?? {});
  log(`  - ${p.id} (${p.name ?? ''}) models=${models.length}: ${models.slice(0, 6).join(', ')}${models.length > 6 ? ' …' : ''}`);
}
log('default =', JSON.stringify(cp?.default ?? {}));
const pl = provList.json;
log(
  `/provider → ${provList.status}; all=${Array.isArray(pl?.all) ? pl.all.length : '?'} connected=${JSON.stringify(pl?.connected ?? '?')}`,
);
// 采样一个模型条目的完整字段（capabilities/cost/limit/variants）
const sampleProvider = cpArr.find((p) => p.id === 'opencode') ?? cpArr[0];
const sampleModel = sampleProvider ? Object.values(sampleProvider.models ?? {})[0] : undefined;
if (sampleModel) {
  section('3b. 模型条目字段采样');
  console.log(JSON.stringify(sampleModel, null, 2).slice(0, 3000));
}

// 选一个免费模型（cost.input === 0 优先）
let pick;
for (const p of cpArr) {
  for (const [mid, m] of Object.entries(p.models ?? {})) {
    if ((m.cost?.input ?? 1) === 0) {
      pick = { providerID: p.id, modelID: mid, model: m };
      break;
    }
  }
  if (pick) break;
}
if (!pick && sampleProvider && sampleModel) {
  pick = { providerID: sampleProvider.id, modelID: sampleModel.id ?? Object.keys(sampleProvider.models)[0], model: sampleModel };
}
log('选用模型 =', pick ? `${pick.providerID}/${pick.modelID}` : '(无可用模型)');

// ---------------------------------------------------------------- 4. openapi
section('4. OpenAPI 端点地面真值 (/doc)');
const doc = await api('/doc');
const paths = doc.json?.paths ?? {};
const interesting = Object.keys(paths).filter((p) =>
  /session|permission|event|agent|provider|config/.test(p),
);
log(`/doc → ${doc.status}; 相关路径 ${interesting.length} 条：`);
for (const p of interesting.sort()) log('  ', Object.keys(paths[p]).join(',').toUpperCase().padEnd(8), p);
// prompt 请求体 schema
const msgOp = paths['/session/{id}/message']?.post ?? paths['/session/{sessionID}/message']?.post;
if (msgOp) {
  const schema = msgOp.requestBody?.content?.['application/json']?.schema;
  section('4b. prompt 请求体 schema');
  console.log(JSON.stringify(schema, null, 2).slice(0, 4000));
}
// permission 应答端点 schema
const permPath = interesting.find((p) => /permission/.test(p) && paths[p].post);
if (permPath) {
  section('4c. permission 应答端点');
  log(permPath);
  console.log(
    JSON.stringify(paths[permPath].post?.requestBody?.content?.['application/json']?.schema, null, 2)?.slice(0, 2000),
  );
}
// agents 列表
const agents = await api('/agent');
log(
  '/agent →',
  agents.status,
  Array.isArray(agents.json) ? agents.json.map((a) => a.name).join(', ') : JSON.stringify(agents.json).slice(0, 200),
);

// ---------------------------------------------------------------- 5. session + SSE
section('5. 建 session + SSE 订阅');
const created = await api('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
log('POST /session →', created.status, JSON.stringify(created.json).slice(0, 300));
const sessionID = created.json?.id;
if (!sessionID) {
  console.error('[probe] FAIL: 建会话失败');
  child.kill();
  process.exit(1);
}

// SSE 订阅（记录全部事件类型与 sessionID 位置）
const sseController = new AbortController();
const seenTypes = new Map(); // type -> count
const sseEvents = [];
const ssePromise = (async () => {
  const res = await fetch(`${baseUrl}/event`, {
    headers: { Accept: 'text/event-stream', ...authHeader, 'x-opencode-directory': cwd },
    signal: sseController.signal,
  });
  log('SSE /event →', res.status);
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
      try {
        const evt = JSON.parse(dataLine);
        seenTypes.set(evt.type, (seenTypes.get(evt.type) ?? 0) + 1);
        sseEvents.push(evt);
      } catch {
        /* ignore */
      }
    }
  }
})().catch((e) => {
  if (e.name !== 'AbortError') log('SSE error:', e.message);
});

await new Promise((r) => setTimeout(r, 1500)); // 等 server.connected

// ---------------------------------------------------------------- 6. prompt
if (!NO_PROMPT && pick) {
  section('6. prompt（免费模型，观察事件流）');
  const body = {
    parts: [{ type: 'text', text: '只回答两个字：你好' }],
    model: { providerID: pick.providerID, modelID: pick.modelID },
  };
  const t0 = Date.now();
  const promptRes = await api(`/session/${sessionID}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  log(`POST message → ${promptRes.status}（HTTP 返回耗时 ${Date.now() - t0}ms）`);
  console.log('HTTP 响应体（截断）:', JSON.stringify(promptRes.json).slice(0, 1500));
  await new Promise((r) => setTimeout(r, 3000)); // 收尾部事件
} else {
  section('6. prompt（跳过）');
}

// ---------------------------------------------------------------- 7. 其他端点
section('7. abort / fork / summarize / resume');
const abortRes = await api(`/session/${sessionID}/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
log('POST abort →', abortRes.status, JSON.stringify(abortRes.json).slice(0, 120));
const forkRes = await api(`/session/${sessionID}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
log('POST fork →', forkRes.status, JSON.stringify(forkRes.json).slice(0, 200));
const sumRes = await api(`/session/${sessionID}/summarize`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(pick ? { providerID: pick.providerID, modelID: pick.modelID } : {}),
});
log('POST summarize →', sumRes.status, JSON.stringify(sumRes.json).slice(0, 120));
const getRes = await api(`/session/${sessionID}`);
log('GET /session/{id} →', getRes.status, JSON.stringify(getRes.json).slice(0, 200));
const msgsRes = await api(`/session/${sessionID}/message`);
log(
  'GET messages →',
  msgsRes.status,
  Array.isArray(msgsRes.json) ? `${msgsRes.json.length} 条` : JSON.stringify(msgsRes.json).slice(0, 120),
);

// ---------------------------------------------------------------- 8. 事件汇总
section('8. SSE 事件类型汇总');
for (const [t, n] of [...seenTypes.entries()].sort()) log(`  ${t} × ${n}`);
section('8b. 各类型首个事件样本（截断）');
const dumped = new Set();
for (const evt of sseEvents) {
  if (dumped.has(evt.type)) continue;
  dumped.add(evt.type);
  console.log(`--- ${evt.type}\n${JSON.stringify(evt).slice(0, 1200)}`);
}

// ---------------------------------------------------------------- cleanup
sseController.abort();
if (!KEEP) {
  // Windows 下 shell:true spawn 的是 cmd 包装，须整树杀
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill();
  }
}
log('done. serverExited =', serverExited);
process.exit(0);
