/**
 * probe-claude.mjs — Claude Code CLI 双向 stream-json 协议实测探针。
 *
 * 验证目标（对接前的地面真值）：
 *  1. spawn `claude -p --input-format stream-json --output-format stream-json`
 *     常驻进程模式：init system 事件、assistant/stream_event、result 事件形态。
 *  2. 权限：`--permission-prompt-tool stdio` + control_request(can_use_tool)
 *     → control_response(allow/deny) 回路是否成立。
 *  3. control_request：interrupt / set_permission_mode / set_model 是否被接受。
 *  4. --resume <sessionId> 续接会话是否可用。
 *
 * 用法：node scripts/probe-claude.mjs [phase]   phase ∈ 1|2|3|4，缺省全跑。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PHASE = process.argv[2] ? Number(process.argv[2]) : 0;
const CWD = mkdtempSync(join(tmpdir(), 'probe-claude-'));
console.log('[probe] cwd =', CWD);

function spawnClaude(extraArgs = []) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--model', 'haiku',
    ...extraArgs,
  ];
  console.log('[spawn] claude', args.join(' '));
  const child = spawn('claude', args, { cwd: CWD, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
  return child;
}

/** 逐行解析 NDJSON，回调返回 true 时停止。 */
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
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        console.log('[raw非JSON]', line.slice(0, 300));
        continue;
      }
      handler(obj);
    }
  });
}

function send(child, obj) {
  const s = JSON.stringify(obj);
  console.log('>>>', s.slice(0, 220));
  child.stdin.write(s + '\n');
}

function userMessage(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function summarize(obj) {
  const t = obj.type;
  if (t === 'system') {
    console.log('<<< system/' + obj.subtype, JSON.stringify({
      session_id: obj.session_id, model: obj.model, permissionMode: obj.permissionMode,
      tools: Array.isArray(obj.tools) ? obj.tools.length + ' tools' : undefined,
      slash_commands: Array.isArray(obj.slash_commands) ? obj.slash_commands.length + ' cmds' : undefined,
      agents: Array.isArray(obj.agents) ? obj.agents.length + ' agents' : undefined,
    }));
    if (obj.subtype === 'init') console.log('    [init全量]', JSON.stringify(obj).slice(0, 1500));
  } else if (t === 'stream_event') {
    const ev = obj.event ?? {};
    if (ev.type === 'content_block_delta') {
      const d = ev.delta ?? {};
      console.log('<<< stream_event delta', d.type, JSON.stringify(d.text ?? d.thinking ?? d.partial_json ?? '').slice(0, 80));
    } else {
      console.log('<<< stream_event', ev.type, JSON.stringify(ev).slice(0, 200));
    }
  } else if (t === 'assistant' || t === 'user') {
    const content = obj.message?.content;
    const kinds = Array.isArray(content) ? content.map((c) => c.type).join(',') : typeof content;
    console.log(`<<< ${t} [${kinds}]`, JSON.stringify(content).slice(0, 300));
  } else if (t === 'result') {
    console.log('<<< result', JSON.stringify({
      subtype: obj.subtype, is_error: obj.is_error, duration_ms: obj.duration_ms,
      num_turns: obj.num_turns, session_id: obj.session_id,
      total_cost_usd: obj.total_cost_usd, usage: obj.usage,
    }));
  } else if (t === 'control_request') {
    console.log('<<< control_request', JSON.stringify(obj).slice(0, 800));
  } else if (t === 'control_response') {
    console.log('<<< control_response', JSON.stringify(obj).slice(0, 500));
  } else {
    console.log('<<<', t, JSON.stringify(obj).slice(0, 400));
  }
}

// ---------------------------------------------------------------- phase 1
// 基本回合：常驻进程发两条消息，验证多回合复用 + result 事件。
async function phase1() {
  console.log('\n========== PHASE 1: 基本双向流 + 多回合 ==========');
  const child = spawnClaude();
  let sessionId = '';
  let results = 0;
  const done = new Promise((resolve) => {
    onLines(child, (obj) => {
      summarize(obj);
      if (obj.type === 'system' && obj.subtype === 'init') sessionId = obj.session_id;
      if (obj.type === 'result') {
        results += 1;
        if (results === 1) {
          send(child, userMessage('再用一句话说明你上一句说了什么（测试同进程第二回合上下文）。'));
        } else {
          resolve();
        }
      }
    });
  });
  send(child, userMessage('请只回复一个词：好的'));
  await Promise.race([done, timeout(120_000, 'phase1')]);
  child.stdin.end();
  await waitExit(child);
  console.log('[phase1] session_id =', sessionId);
  return sessionId;
}

// ---------------------------------------------------------------- phase 2
// 权限回路：default 模式下让它写文件 → 应收到 can_use_tool control_request，
// 先 deny 一次再 allow 一次，验证双向 control 协议。
async function phase2() {
  console.log('\n========== PHASE 2: can_use_tool 权限回路 ==========');
  const child = spawnClaude(['--permission-mode', 'default']);
  let denied = false;
  const done = new Promise((resolve) => {
    onLines(child, (obj) => {
      summarize(obj);
      if (obj.type === 'control_request' && obj.request?.subtype === 'can_use_tool') {
        const behavior = denied
          ? { behavior: 'allow', updatedInput: obj.request.input }
          : { behavior: 'deny', message: '探针拒绝：请再试一次同样的写入' };
        if (!denied) denied = true;
        send(child, {
          type: 'control_response',
          response: { subtype: 'success', request_id: obj.request_id, response: behavior },
        });
      }
      if (obj.type === 'result') resolve();
    });
  });
  send(child, userMessage('请把文本 hello 写入当前目录的 probe.txt 文件（用 Write 工具），若第一次被拒绝请重试一次。'));
  await Promise.race([done, timeout(180_000, 'phase2')]);
  child.stdin.end();
  await waitExit(child);
}

// ---------------------------------------------------------------- phase 3
// control_request：interrupt / set_permission_mode / set_model。
async function phase3() {
  console.log('\n========== PHASE 3: interrupt & set_permission_mode & set_model ==========');
  const child = spawnClaude();
  let interrupted = false;
  const done = new Promise((resolve) => {
    onLines(child, (obj) => {
      summarize(obj);
      // 一旦开始产出内容就打断
      if (!interrupted && obj.type === 'stream_event') {
        interrupted = true;
        send(child, { type: 'control_request', request_id: 'req-int-' + randomUUID().slice(0, 8), request: { subtype: 'interrupt' } });
      }
      if (obj.type === 'result') {
        // 打断后测 set_permission_mode / set_model
        send(child, { type: 'control_request', request_id: 'req-mode', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } });
        send(child, { type: 'control_request', request_id: 'req-model', request: { subtype: 'set_model', model: 'sonnet' } });
        setTimeout(resolve, 4000);
      }
    });
  });
  send(child, userMessage('请从 1 数到 200，每个数字单独一行。'));
  await Promise.race([done, timeout(120_000, 'phase3')]);
  child.stdin.end();
  await waitExit(child);
}

// ---------------------------------------------------------------- phase 4
// resume：用 phase1 的 session id 重启进程续接上下文。
async function phase4(sessionId) {
  console.log('\n========== PHASE 4: --resume 续接 ==========');
  if (!sessionId) {
    console.log('[phase4] 无 sessionId，跳过');
    return;
  }
  const child = spawnClaude(['--resume', sessionId]);
  const done = new Promise((resolve) => {
    onLines(child, (obj) => {
      summarize(obj);
      if (obj.type === 'result') resolve();
    });
  });
  send(child, userMessage('我们对话的第一条消息我让你回复什么词？只答那个词。'));
  await Promise.race([done, timeout(120_000, 'phase4')]);
  child.stdin.end();
  await waitExit(child);
}

function timeout(ms, tag) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' 超时 ' + ms + 'ms')), ms));
}

function waitExit(child) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill();
      resolve();
    }, 8000);
    child.on('exit', (code) => {
      clearTimeout(t);
      console.log('[exit] code =', code);
      resolve();
    });
  });
}

try {
  let sid = '';
  if (!PHASE || PHASE === 1) sid = await phase1();
  if (!PHASE || PHASE === 2) await phase2();
  if (!PHASE || PHASE === 3) await phase3();
  if (!PHASE || PHASE === 4) await phase4(sid || process.argv[3]);
  console.log('\n[probe] 完成');
  process.exit(0);
} catch (err) {
  console.error('\n[probe] 失败:', err.message);
  process.exit(1);
}
