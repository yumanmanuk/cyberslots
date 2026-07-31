/**
 * probe-claude-effort.mjs — 实测 stream-json 常驻进程模式下「回合间热切
 * 思考深度」的可行机制。验证三条候选路径：
 *   A. 发送斜杠命令 `/effort high` 作为 user 消息（init.slash_commands 含 effort）
 *   B. control_request { subtype: 'set_model', model, ... } 是否带 effort 语义
 *   C. control_request 未知 effort subtype 的错误回执（探边界）
 *
 * 关注点：CLI 是否接受、是否回显新档、后续回合思考行为是否变化。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CWD = mkdtempSync(join(tmpdir(), 'probe-effort-'));

function spawnClaude() {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose',
    '--permission-prompt-tool', 'stdio', '--model', 'haiku',
  ];
  const child = spawn('claude', args, { cwd: CWD, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
  return child;
}

function onLines(child, handler) {
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { handler(JSON.parse(line)); } catch { /* ignore banner */ }
    }
  });
}

function send(child, obj) {
  const s = JSON.stringify(obj);
  console.log('>>>', s.slice(0, 200));
  child.stdin.write(s + '\n');
}
const userMsg = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 汇总每回合的思考 token 量（thinking_delta 字符数）+ system 回显
function makeCounter() {
  return { thinkingChars: 0, textChars: 0, systemModes: [], errors: [], controlResp: [] };
}

async function run() {
  const child = spawnClaude();
  let cur = makeCounter();
  const results = [];
  let resolveTurn;

  onLines(child, (obj) => {
    const t = obj.type;
    if (t === 'system') {
      // init 会回显 permissionMode / model / 可能的 effort/reasoning 字段
      if (obj.subtype === 'init') {
        const echo = { model: obj.model, permissionMode: obj.permissionMode };
        // 扫描 init 里任何含 effort/thinking/reasoning 的字段
        for (const [k, v] of Object.entries(obj)) {
          if (/effort|thinking|reasoning/i.test(k)) echo[k] = v;
        }
        cur.systemModes.push(echo);
        console.log('<<< system/init echo', JSON.stringify(echo));
      }
    } else if (t === 'stream_event') {
      const ev = obj.event ?? {};
      if (ev.type === 'content_block_delta') {
        const d = ev.delta ?? {};
        if (d.type === 'thinking_delta') cur.thinkingChars += String(d.thinking ?? '').length;
        if (d.type === 'text_delta') cur.textChars += String(d.text ?? '').length;
      }
    } else if (t === 'control_response') {
      cur.controlResp.push(obj.response);
      console.log('<<< control_response', JSON.stringify(obj.response).slice(0, 300));
    } else if (t === 'result') {
      // result 里可能带 effort/thinking 元数据
      const meta = {};
      for (const [k, v] of Object.entries(obj)) {
        if (/effort|thinking|reasoning/i.test(k)) meta[k] = v;
      }
      console.log('<<< result', JSON.stringify({ subtype: obj.subtype, is_error: obj.is_error, ...meta }));
      results.push({ ...cur, resultMeta: meta });
      cur = makeCounter();
      if (resolveTurn) { const r = resolveTurn; resolveTurn = undefined; r(); }
    }
  });

  const turn = (fn) => new Promise((resolve) => { resolveTurn = resolve; fn(); });

  // ---- 基线回合：默认 effort，问一个需要推理的问题
  console.log('\n===== 回合1：基线（默认思考档） =====');
  await turn(() => send(child, userMsg('用一句话回答：为什么天是蓝的？简短点。')));

  // ---- 路径 A：发斜杠命令 /effort high
  console.log('\n===== 路径A：发送 `/effort high` 斜杠命令 =====');
  await turn(() => send(child, userMsg('/effort high')));

  // ---- 回合2：high 档下同类问题，看思考量是否变化
  console.log('\n===== 回合2：/effort high 之后 =====');
  await turn(() => send(child, userMsg('用一句话回答：为什么晚霞是红的？简短点。')));

  // ---- 路径 B：control_request set_model 带不同写法（探是否有 effort 语义）
  console.log('\n===== 路径B：control_request set_model =====');
  send(child, { type: 'control_request', request_id: 'm1', request: { subtype: 'set_model', model: 'sonnet' } });
  await wait(1500);

  // ---- 路径 C：探未知 effort control subtype 的错误回执
  console.log('\n===== 路径C：control_request 试探 effort subtype =====');
  send(child, { type: 'control_request', request_id: 'e1', request: { subtype: 'set_effort', effort: 'high' } });
  await wait(1500);
  send(child, { type: 'control_request', request_id: 'e2', request: { subtype: 'set_thinking_effort', effort: 'max' } });
  await wait(1500);

  // ---- 路径 A 再验：/effort low 后思考量应下降
  console.log('\n===== 路径A2：/effort low 再验 =====');
  await turn(() => send(child, userMsg('/effort low')));
  console.log('\n===== 回合3：/effort low 之后 =====');
  await turn(() => send(child, userMsg('用一句话回答：为什么草是绿的？简短点。')));

  child.stdin.end();
  await wait(500);
  try { child.kill(); } catch { /* ignore */ }

  console.log('\n========== 汇总 ==========');
  results.forEach((r, i) => {
    console.log(`回合${i + 1}: thinking=${r.thinkingChars} 字符, text=${r.textChars} 字符, resultMeta=${JSON.stringify(r.resultMeta)}`);
  });
  console.log('\ninit 回显序列：', JSON.stringify(results.map((r) => r.systemModes).flat()));
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
