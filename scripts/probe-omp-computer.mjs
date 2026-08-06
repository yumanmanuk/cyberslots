/**
 * probe-omp-computer.mjs — P3 omp 原生 browser/computer 面勘察（解除黑名单前的 go/no-go 门禁）。
 *
 * 背景：docs/probe-omp-findings.md §6 把 omp 的 /computer、/browser 斜杠命令列入
 * GUI 语境黑名单。本探针收集证据：omp 原生 browser/computer 动作在各审批档下是否
 * 产生「客户端可见、可按动作拦截」的事件流。
 *
 * 实测矩阵（对应 OmpAdapter.approvalArgs 的 ask/write/yolo 三桶）：
 *  1. --approval-mode always-ask（ask 桶）
 *  2. --approval-mode write（write 桶）
 *  3. --auto-approve（yolo 桶）
 * 每档：全新 `omp acp` 进程 + mkdtemp cwd → initialize → session/new →
 * prompt `/browser`（若报错或无工具事件，回退自然语言 prompt
 * 「请使用 browser 工具打开 https://example.com 并截图」），收集 ≤45s/回合的通知。
 * request_permission 一律自动 allow-once（同 probe-omp.mjs 约定），并计入可见性证据。
 *
 * 报告：每档事件类型计数（tool_call / tool_call_update / request_permission）、
 * browser/computer 工具可见性、可否按动作拦截；末尾打印建议判定
 * （三档均可见可拦截 → GO；任一档静默自动执行/事件不可见 → NO-GO）。
 *
 * 用法：node scripts/probe-omp-computer.mjs [--model <slug>]
 *
 * 注：只读探测/不写用户配置 —— PI_CODING_AGENT_DIR 指向临时目录
 *    （models.yml/config.yml 种子自 ~/.omp/agent 的只读拷贝，probe-omp-findings §9：
 *     空目录会隔离出「无默认模型」），探针结束删除该临时目录；omp 起不来时退出码 1，
 *     其余情况退出码 0（纯证据收集）。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const OMP = process.env.OMP_BIN || join(process.env.LOCALAPPDATA || '', 'omp', 'omp.exe');
const MODEL = argVal('--model');
const PROMPT_TIMEOUT_MS = 45_000;

const log = (...a) => console.log('[probe]', ...a);
const section = (t) => console.log(`\n========== ${t} ==========`);

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---------------------------------------------------------------- 0. 前置：omp CLI
section('0. 前置检查 + 隔离 session-dir 种子');
const version = await runCapture(OMP, ['--version']);
if (!version) {
  console.error(`[probe] FAIL: omp CLI 不可用（${OMP}）。设 OMP_BIN 指向 omp.exe。`);
  process.exit(1);
}
log('omp version =', version.trim());

// PI_CODING_AGENT_DIR 隔离：种子自 ~/.omp/agent 的只读拷贝（不写用户配置）。
// 注意：PI_CODING_AGENT_DIR 即 agent 目录本体 —— models.yml/config.yml 放其根
// （实测 2026-08-05：放 <dir>/agent/ 子目录会解析不到 → models --json 0 条）。
const agentDir = mkdtempSync(join(tmpdir(), 'probe-omp-computer-agent-'));
const srcAgent = join(homedir(), '.omp', 'agent');
for (const f of ['models.yml', 'config.yml']) {
  const src = join(srcAgent, f);
  if (existsSync(src)) {
    copyFileSync(src, join(agentDir, f));
    log(`种子拷贝 ${f}（只读源 → 临时隔离目录）`);
  } else {
    log(`无 ${src} —— 该文件缺失，prompt 可能无可用模型`);
  }
}

const MODES = [
  { bucket: 'ask', args: ['--approval-mode', 'always-ask'] },
  { bucket: 'write', args: ['--approval-mode', 'write'] },
  { bucket: 'yolo', args: ['--auto-approve'] },
];

const modeResults = []; // {bucket, infraFail, promptFailed, counts, browserToolSeen, permSamples, note}

// ---------------------------------------------------------------- 矩阵
for (const mode of MODES) {
  section(`审批档 = ${mode.bucket}（${mode.args.join(' ')}）`);
  const r = await runMode(mode);
  modeResults.push(r);
}

// ---------------------------------------------------------------- 判定
section('判定证据汇总');
for (const r of modeResults) {
  log(
    `[${r.bucket}] infraFail=${r.infraFail} promptFailed=${r.promptFailed} ` +
      `tool_call=${r.counts.tool_call} tool_call_update=${r.counts.tool_call_update} ` +
      `request_permission=${r.counts.request_permission} browserToolSeen=${r.browserToolSeen}` +
      (r.note ? ` note=${r.note}` : ''),
  );
}
const usable = modeResults.filter((r) => !r.infraFail && !r.promptFailed);
let verdict;
if (usable.length === 0) {
  verdict = 'INCONCLUSIVE（所有档位 prompt 均未跑通，无事件流证据）→ 建议维持黑名单（NO-GO 待复测）';
} else {
  // 可见 = browser 工具事件出现在事件流；可拦截 = request_permission 出现。
  const silent = usable.filter((r) => !r.browserToolSeen && !r.counts.request_permission);
  const uninterceptable = usable.filter((r) => r.bucket !== 'ask' && r.browserToolSeen && !r.counts.request_permission);
  if (silent.length) {
    verdict = `NO-GO（维持黑名单）：${silent.map((r) => r.bucket).join('/')} 档 browser 动作静默执行/事件不可见`;
  } else if (uninterceptable.length) {
    verdict =
      `NO-GO（维持黑名单）：${uninterceptable.map((r) => r.bucket).join('/')} 档 browser 动作可见但无 request_permission，` +
      'write/yolo 桶下自动执行无法按动作拦截';
  } else {
    verdict = 'GO（可作 omp 单引擎过渡增益）：三档均可见可拦截';
  }
}
log('建议判定:', verdict);

// 清理隔离目录（含凭据拷贝，不留盘；taskkill 后句柄释放有延迟 → 重试 3 次）
let removed = false;
for (let i = 0; i < 3 && !removed; i++) {
  try {
    rmSync(agentDir, { recursive: true, force: true });
    removed = true;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (removed) log('临时隔离目录已删除:', agentDir);
else log('临时目录删除失败（可手动删）:', agentDir);
process.exit(0);

// ================================================================ per-mode runner
async function runMode(mode) {
  const counts = { tool_call: 0, tool_call_update: 0, request_permission: 0 };
  const r = {
    bucket: mode.bucket,
    infraFail: false,
    promptFailed: false,
    counts,
    browserToolSeen: false,
    permSamples: [],
    note: '',
  };
  const cwd = mkdtempSync(join(tmpdir(), 'probe-omp-computer-'));
  log('cwd =', cwd);

  const child = spawn(OMP, ['acp', ...(MODEL ? ['--model', MODEL] : []), ...mode.args], {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line.trim()) console.error('[acp:err]', line.slice(0, 300));
  });

  // --- ndjson JSON-RPC 客户端（LF 分帧，同 probe-omp.mjs）---
  const pending = new Map();
  let nextId = 1;
  let rxBuf = '';
  const BROWSER_RE = /browser|computer|screenshot|navigate|puppeteer|playwright|page/i;

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
      if (kind in counts) counts[kind] += 1;
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const title = u.title ?? u.name ?? '';
        const k2 = u.kind ?? '';
        if (BROWSER_RE.test(`${title} ${k2} ${JSON.stringify(u.rawInput ?? {})}`)) {
          r.browserToolSeen = true;
          log(`  ★ browser 面工具事件（${kind}）:`, JSON.stringify(u).slice(0, 400));
        } else {
          log(`  工具事件（${kind}）: ${String(title).slice(0, 120)} kind=${k2}`);
        }
      } else if (kind === 'agent_message_chunk') {
        const text = u.content?.text ?? '';
        if (text.trim()) log('  agent:', text.slice(0, 200).replace(/\n/g, ' '));
      } else {
        log(`  update: ${kind}`, JSON.stringify(u).slice(0, 200));
      }
    }
  }

  function onServerRequest(msg) {
    if (msg.method === 'session/request_permission') {
      counts.request_permission += 1;
      const title = msg.params?.toolCall?.title ?? msg.params?.title ?? '';
      const opts = msg.params?.options ?? [];
      r.permSamples.push(title.slice(0, 120));
      log(`  ⇐ request_permission #${counts.request_permission}: ${String(title).slice(0, 160)} opts=${opts.map((o) => o.kind).join(',')}`);
      if (BROWSER_RE.test(title)) r.browserToolSeen = true;
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
    if (init?.__err || !init?.agentInfo) {
      r.infraFail = true;
      r.note = `initialize 失败: ${JSON.stringify(init?.__err ?? init).slice(0, 200)}`;
      log('initialize 失败:', r.note);
      return r;
    }
    log('agent =', init.agentInfo?.name, init.agentInfo?.version);

    const newSess = await send('session/new', { cwd, mcpServers: [] }).catch((e) => ({ __err: e?.message ?? e }));
    const sessionId = newSess?.sessionId;
    if (!sessionId) {
      r.infraFail = true;
      r.note = `session/new 失败: ${JSON.stringify(newSess?.__err ?? newSess).slice(0, 200)}`;
      log('session/new 失败:', r.note);
      return r;
    }
    log('sessionId =', sessionId);

    // --- prompt 1: /browser ---
    log('prompt #1: /browser');
    const t0 = Date.now();
    const p1 = await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/browser' }] }, PROMPT_TIMEOUT_MS).catch(
      (e) => ({ __err: e?.message ?? e }),
    );
    log(`prompt #1 返回（${Date.now() - t0}ms）:`, JSON.stringify(p1?.__err ? { err: p1.__err } : p1 ?? {}).slice(0, 300));

    const toolEventsAfterP1 = counts.tool_call + counts.tool_call_update;
    const needFallback = p1?.__err || toolEventsAfterP1 === 0;
    if (p1?.__err) r.note = `prompt#1 错误: ${String(p1.__err).slice(0, 120)}`;

    // --- prompt 2（回退）：自然语言 ---
    if (needFallback) {
      log('prompt #2（回退）: 请使用 browser 工具打开 https://example.com 并截图');
      const t1 = Date.now();
      const p2 = await send(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: '请使用 browser 工具打开 https://example.com 并截图' }] },
        PROMPT_TIMEOUT_MS,
      ).catch((e) => ({ __err: e?.message ?? e }));
      log(`prompt #2 返回（${Date.now() - t1}ms）:`, JSON.stringify(p2?.__err ? { err: p2.__err } : p2 ?? {}).slice(0, 300));
      if (p2?.__err) r.note += `${r.note ? '；' : ''}prompt#2 错误: ${String(p2.__err).slice(0, 120)}`;
    }

    // promptFailed = 两轮下来既无工具事件也无权限请求，且 agent 明确报错或无任何内容
    const anySignal = counts.tool_call + counts.tool_call_update + counts.request_permission > 0;
    if (!anySignal && (p1?.__err || r.note.includes('prompt#2 错误'))) r.promptFailed = true;
    if (!anySignal && !r.promptFailed) r.note += `${r.note ? '；' : ''}回合有响应但无工具事件（可能无 browser 工具或无凭据）`;
  } finally {
    await killTree();
  }
  return r;
}

// ---------------------------------------------------------------- helpers
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
