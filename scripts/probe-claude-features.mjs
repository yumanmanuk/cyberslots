/**
 * probe-claude-features.mjs — 实测 1/2/4/5 项功能涉及的协议行为：
 *   [5a] --session-id <uuid>：用我方指定 UUID 建会话（可控会话号）
 *   [5b] --fork-session（配 --resume）：原生分叉出新 session_id
 *   [2 ] --permission-mode plan → ExitPlanMode 工具的 can_use_tool 形态
 *   [4 ] --mcp-config <json>：init 的 mcp_servers 回显结构
 *   [1 ] --forward-subagent-text + Task：子代理文本是否带 parent_tool_use_id 转发
 *   [6 ] /security-review 是否为纯本地斜杠命令（走自建 API 即可）
 *
 * 每项独立 spawn，尽量轻量（haiku）。用法：node scripts/probe-claude-features.mjs [phase]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PHASE = process.argv[2] ? Number(process.argv[2]) : 0;
const CWD = mkdtempSync(join(tmpdir(), 'probe-feat-'));
console.log('[cwd]', CWD);

function spawnClaude(extraArgs) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose',
    '--permission-prompt-tool', 'stdio', '--model', 'haiku',
    ...extraArgs,
  ];
  console.log('[spawn] claude', extraArgs.join(' '));
  const child = spawn('claude', args, { cwd: CWD, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d.slice(0, 200)));
  return child;
}

function onLines(child, handler) {
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { handler(JSON.parse(line)); } catch { /* banner */ } }
    }
  });
}
function send(child, obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
const userMsg = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// [5a] 指定 session-id
async function phase5a() {
  console.log('\n===== [5a] --session-id 指定会话号 =====');
  const myId = randomUUID();
  console.log('我方指定 session-id =', myId);
  const child = spawnClaude(['--session-id', myId]);
  let sawId = '';
  const done = new Promise((res) => {
    onLines(child, (o) => {
      if (o.type === 'system' && o.subtype === 'init') { sawId = o.session_id; console.log('init.session_id =', o.session_id); }
      if (o.type === 'result') { console.log('result.session_id =', o.session_id); res(); }
    });
  });
  send(child, userMsg('回复 ok'));
  await Promise.race([done, wait(60000)]);
  child.stdin.end(); child.kill();
  console.log(sawId === myId ? '✅ session-id 被采纳（我方可控会话号）' : `❌ 未采纳（cli 用了 ${sawId}）`);
  return myId;
}

// [5b] fork-session
async function phase5b(resumeId) {
  console.log('\n===== [5b] --fork-session 原生分叉 =====');
  if (!resumeId) { console.log('跳过（无 resumeId）'); return; }
  const child = spawnClaude(['--resume', resumeId, '--fork-session']);
  let forkId = '';
  const done = new Promise((res) => {
    onLines(child, (o) => {
      if (o.type === 'system' && o.subtype === 'init') forkId = o.session_id;
      if (o.type === 'result') { console.log('fork 后 session_id =', o.session_id); res(); }
    });
  });
  send(child, userMsg('回复 forked'));
  await Promise.race([done, wait(60000)]);
  child.stdin.end(); child.kill();
  console.log(forkId && forkId !== resumeId ? `✅ fork 出新 session_id（${forkId.slice(0, 8)} ≠ 原 ${resumeId.slice(0, 8)}）` : `⚠ fork session_id=${forkId}`);
}

// [2] plan 模式 → ExitPlanMode
async function phase2() {
  console.log('\n===== [2] plan 模式 ExitPlanMode 形态 =====');
  const child = spawnClaude(['--permission-mode', 'plan']);
  let sawExitPlan = false;
  let sawCanUse = null;
  const done = new Promise((res) => {
    onLines(child, (o) => {
      if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
        for (const b of o.message.content) {
          if (b.type === 'tool_use' && /exitplanmode/i.test(b.name)) {
            sawExitPlan = true;
            console.log('ExitPlanMode input 键:', Object.keys(b.input ?? {}));
            console.log('  plan 文本前 120:', String(b.input?.plan ?? '').slice(0, 120));
          }
        }
      }
      if (o.type === 'control_request' && o.request?.subtype === 'can_use_tool') {
        sawCanUse = o.request.tool_name;
        console.log('can_use_tool for:', o.request.tool_name);
        // plan 模式下自动放行
        send(child, { type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { behavior: 'allow', updatedInput: o.request.input } } });
      }
      if (o.type === 'result') res();
    });
  });
  send(child, userMsg('制定一个给项目加单元测试的计划（不要写代码，只规划）。'));
  await Promise.race([done, wait(120000)]);
  child.stdin.end(); child.kill();
  console.log(sawExitPlan ? '✅ 收到 ExitPlanMode 工具（含 plan 文本）' : '⚠ 本轮未触发 ExitPlanMode');
  console.log('  plan 模式 can_use_tool 命中工具:', sawCanUse ?? '(无)');
}

// [4] mcp-config init 回显
async function phase4() {
  console.log('\n===== [4] --mcp-config init.mcp_servers 回显 =====');
  // 造一个明显不可连的 mcp server 配置，只看 init 是否回显其状态结构。
  const cfgPath = join(CWD, 'mcp.json');
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: { probe_demo: { command: 'node', args: ['-e', 'process.exit(0)'] } } }));
  const child = spawnClaude(['--mcp-config', cfgPath, '--strict-mcp-config']);
  const done = new Promise((res) => {
    onLines(child, (o) => {
      if (o.type === 'system' && o.subtype === 'init') {
        console.log('init.mcp_servers =', JSON.stringify(o.mcp_servers));
        console.log('init.tools 含 mcp 前缀:', (o.tools ?? []).filter((t) => /^mcp__/.test(t)));
      }
      if (o.type === 'result') res();
    });
  });
  send(child, userMsg('回复 ok'));
  await Promise.race([done, wait(60000)]);
  child.stdin.end(); child.kill();
}

// [1] forward-subagent-text + Task 子代理
async function phase1() {
  console.log('\n===== [1] --forward-subagent-text 子代理转发（较慢） =====');
  const child = spawnClaude(['--forward-subagent-text', '--permission-mode', 'bypassPermissions']);
  let sawTask = false;
  let sawParentTagged = 0;
  const done = new Promise((res) => {
    onLines(child, (o) => {
      if ((o.type === 'assistant' || o.type === 'user')) {
        if (o.parent_tool_use_id) {
          sawParentTagged++;
          if (sawParentTagged <= 3) console.log(`  带 parent_tool_use_id 的 ${o.type}:`, o.parent_tool_use_id.slice(0, 12));
        }
        if (Array.isArray(o.message?.content)) {
          for (const b of o.message.content) {
            if (b.type === 'tool_use' && /^task$/i.test(b.name)) { sawTask = true; console.log('  触发 Task 子代理:', JSON.stringify(b.input).slice(0, 120)); }
          }
        }
      }
      if (o.type === 'stream_event' && o.parent_tool_use_id) sawParentTagged++;
      if (o.type === 'result') { console.log('  result:', o.subtype); res(); }
    });
  });
  send(child, userMsg('用 Task 工具启动一个 general-purpose 子代理，让它用一句话总结当前目录是空的。'));
  await Promise.race([done, wait(180000)]);
  child.stdin.end(); child.kill();
  console.log(sawTask ? '✅ 触发了 Task 子代理' : '⚠ 本轮未触发 Task');
  console.log(sawParentTagged > 0 ? `✅ 收到 ${sawParentTagged} 条带 parent_tool_use_id 的转发事件（子代理过程实时可见）` : '⚠ 未见 parent_tool_use_id 转发');
}

// [6] security-review 是否本地斜杠命令
async function phase6() {
  console.log('\n===== [6] /security-review 本地斜杠命令验证 =====');
  const child = spawnClaude([]);
  const done = new Promise((res) => {
    onLines(child, (o) => {
      if (o.type === 'system' && o.subtype === 'init') {
        const cmds = o.slash_commands ?? [];
        console.log('init.slash_commands 含 security-review:', cmds.includes('security-review'));
        console.log('init.slash_commands 含 ultrareview:', cmds.includes('ultrareview'), '(云端，自建 API 无关)');
      }
      if (o.type === 'result') res();
    });
  });
  send(child, userMsg('回复 ok'));
  await Promise.race([done, wait(60000)]);
  child.stdin.end(); child.kill();
}

let sid;
if (!PHASE || PHASE === 5) { sid = await phase5a(); await phase5b(sid); }
if (!PHASE || PHASE === 2) await phase2();
if (!PHASE || PHASE === 4) await phase4();
if (!PHASE || PHASE === 6) await phase6();
if (PHASE === 1) await phase1(); // 慢，仅显式指定时跑
console.log('\n[done]');
process.exit(0);
