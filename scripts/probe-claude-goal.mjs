/**
 * probe-claude-goal.mjs — 实测 Claude Code `/goal` 斜杠命令的语义，判断能否
 * 映射到本程序的 goal 抽象（codex 式引擎原生自主目标：跨回合自驱 +
 * 预算/用量追踪 + active/paused/complete 生命周期 + goal.update 推送）。
 *
 * 观察点：
 *   1. `/goal <objective>` 是否被接受，返回什么（是否有结构化 goal 对象）
 *   2. 设 goal 后，后续普通回合结束时引擎是否「自主继续」推进目标（codex 式）
 *      —— 即 result 后是否自发新 turn，还是老实停在 idle 等用户
 *   3. 是否有任何带 tokensUsed/budget/status 的 goal 进度信号
 *   4. `/goal` 无参 / `/goal clear` 等控制形态
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CWD = mkdtempSync(join(tmpdir(), 'probe-goal2-'));

function spawnClaude() {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--model', 'haiku', '--permission-mode', 'bypassPermissions'];
  const c = spawn('claude', args, { cwd: CWD, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  c.stderr.setEncoding('utf8');
  c.stderr.on('data', () => {});
  return c;
}

const c = spawnClaude();
let buf = '';
let resolveTurn;
let turnText = '';
let toolNames = [];
let selfTurns = 0; // 未经我方 prompt 就自发的 result 计数
let awaitingUser = true; // 当前是否在等我方输入

c.stdout.setEncoding('utf8');
c.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    handle(o);
  }
});

function handle(o) {
  if (o.type === 'system' && o.subtype === 'init') {
    // 扫描 init 里任何 goal 相关字段
    const gk = Object.keys(o).filter((k) => /goal/i.test(k));
    if (gk.length) console.log('  init goal 字段:', JSON.stringify(gk.map((k) => [k, o[k]])));
  } else if (o.type === 'stream_event' && o.event?.type === 'content_block_delta') {
    const dd = o.event.delta ?? {};
    if (dd.type === 'text_delta') turnText += dd.text;
  } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const b of o.message.content) {
      if (b.type === 'tool_use') toolNames.push(b.name);
    }
  } else if (o.type === 'result') {
    // 扫描 result 里任何 goal 字段
    const gk = Object.keys(o).filter((k) => /goal/i.test(k));
    console.log(`  [result] subtype=${o.subtype} 正文="${turnText.trim().slice(0, 100)}" 工具=[${toolNames.join(',')}]${gk.length ? ' goal字段=' + JSON.stringify(gk) : ''}`);
    turnText = '';
    toolNames = [];
    if (resolveTurn) { const r = resolveTurn; resolveTurn = undefined; r(); }
    else { selfTurns++; console.log(`  ⚠ 检测到自发 result（非我方 prompt 触发），累计 ${selfTurns}`); }
  }
}

const send = (obj) => c.stdin.write(JSON.stringify(obj) + '\n');
const userMsg = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const turn = (fn) => new Promise((res) => { resolveTurn = res; fn(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('\n===== 1) /goal <objective> 设定目标 =====');
  await turn(() => send(userMsg('/goal 在当前目录创建 a.txt 内容 1、b.txt 内容 2、c.txt 内容 3，三个文件都建好才算完成')));

  console.log('\n===== 2) 设 goal 后发一条无关小问题，观察是否自主推进目标 =====');
  await turn(() => send(userMsg('顺便告诉我 1+1 等于几')));

  console.log('\n===== 3) 静置 8s，观察引擎是否自发继续推进目标（codex 式自驱） =====');
  await wait(8000);

  console.log('\n===== 4) /goal 无参（查看当前目标状态？） =====');
  await turn(() => send(userMsg('/goal')));

  console.log('\n========== 判定依据 ==========');
  console.log(`自发回合数（非我方 prompt 触发的 result）= ${selfTurns}`);
  console.log('若 >0 且伴随目标相关工具活动 → 有 codex 式自主推进；若 =0 → /goal 只是上下文提示，非自驱引擎目标');

  c.stdin.end();
  try { c.kill(); } catch { /* ignore */ }
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
setTimeout(() => { console.log('\n[GLOBAL TIMEOUT]'); process.exit(0); }, 150000);
