/**
 * probe-agy-goal.mjs — 实测 agy CLI `/goal` 斜杠命令在 headless print 模式的
 * 语义，验证 AntigravityAdapter 的 goal 集成假设（docs/antigravity-integration.md
 * §goal）。需要可用网络与已认证账号；agy ≥1.1.9（print 模式斜杠展开）。
 *
 * 用法: node scripts/probe-agy-goal.mjs [--model <slug>]
 *
 * 观察点：
 *   1. `-p "/goal <objective>"` 是否被展开为目标标记（而非纯文本发送）——
 *      展开的标志：goal_stop_hook 强制续跑，单进程内出现多段 agent_response、
 *      result.num_turns > 1、响应尾部带完成令牌
 *   2. 续跑步在 stream-json 里的形态（step_type 分布、是否仍是已知四值）
 *   3. 对照组（不带 /goal 的同一任务）——确认「多 turn」确实是 goal 所致
 *
 * 判定依据打印在末尾，供人工核对 adapter 的 complete/blocked 映射是否成立。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const modelIdx = process.argv.indexOf('--model');
const MODEL = modelIdx >= 0 ? process.argv[modelIdx + 1] : 'claude-sonnet-4-6';
const CWD = mkdtempSync(join(tmpdir(), 'probe-agy-goal-'));
const TASK =
  '在当前目录创建 a.txt 内容 1、b.txt 内容 2、c.txt 内容 3。' +
  '三个文件都建好并逐一回读确认内容正确后才算完成，完成后报告文件清单。';

function runAgy(prompt, { timeout = '8m', conversation } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--print-timeout', timeout,
      '--model', MODEL,
      '--dangerously-skip-permissions',
    ];
    if (conversation) args.push('--conversation', conversation);
    const c = spawn('agy', args, { cwd: CWD, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stepTypes = new Map(); // step_type -> 次数
    const states = new Set();
    let buf = '';
    let cid;
    let result;
    let responseText = '';
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
        if (o.event === 'init') {
          cid = o.conversation_id ?? o.init?.conversation_id;
        } else if (o.event === 'step_update') {
          const s = o.step_update ?? {};
          const t = String(s.step_type ?? '(missing)');
          stepTypes.set(t, (stepTypes.get(t) ?? 0) + 1);
          if (s.state) states.add(String(s.state));
          if (s.text_delta) responseText += s.text_delta;
          if (t !== 'agent_response' && t !== 'tool') {
            console.log(`  [step] type=${t} state=${s.state ?? ''} keys=${Object.keys(s).join(',')}`);
          }
        } else if (o.event === 'result') {
          result = o.result ?? {};
        } else {
          console.log(`  [unknown-event] ${l.slice(0, 200)}`);
        }
      }
    });
    let errTail = '';
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    c.on('close', (code) => {
      resolve({ code, cid, result, stepTypes, states: [...states], responseText, errTail });
    });
  });
}

const report = (label, r) => {
  console.log(`\n----- ${label} -----`);
  console.log(`  exit=${r.code} cid=${r.cid ?? '(无)'}`);
  console.log(`  step_type 分布: ${JSON.stringify(Object.fromEntries(r.stepTypes))}  states: ${r.states.join('/')}`);
  if (r.result) {
    console.log(`  result.status=${r.result.status} num_turns=${r.result.num_turns} duration=${r.result.duration_seconds}s`);
    console.log(`  result.usage=${JSON.stringify(r.result.usage ?? {})}`);
    console.log(`  result 其余字段: ${Object.keys(r.result).filter((k) => !['status', 'num_turns', 'duration_seconds', 'usage', 'response', 'conversation_id', 'error'].includes(k)).join(',') || '(无)'}`);
    if (r.result.error) console.log(`  result.error=${String(r.result.error).slice(0, 300)}`);
  } else {
    console.log('  (无 result 事件) stderr 尾:', r.errTail.slice(-400) || '(空)');
  }
  const tail = r.responseText.trim().slice(-300);
  console.log(`  响应尾部: "${tail}"`);
};

async function run() {
  console.log(`cwd=${CWD} model=${MODEL}`);

  console.log('\n===== 1) 对照组:普通 prompt(无 /goal)=====');
  report('对照组', await runAgy(TASK));

  console.log('\n===== 2) 实验组:`/goal` + 同一任务 =====');
  const g = await runAgy(`/goal ${TASK}`, { timeout: '12m' });
  report('/goal 组', g);

  console.log('\n===== 3) 续接验证:同会话重发 /goal(模拟 controlGoal resume)=====');
  if (g.cid) {
    report('resume 组', await runAgy(`/goal ${TASK}`, { timeout: '12m', conversation: g.cid }));
  } else {
    console.log('  (实验组未拿到 conversation_id,跳过)');
  }

  console.log('\n========== 判定依据 ==========');
  console.log('· /goal 组 num_turns > 对照组(>1) → print 模式展开了 /goal 且 goal_stop_hook 在进程内强制续跑');
  console.log('· 若两组 num_turns 均为 1 → /goal 被当纯文本,adapter 的 goal 只是提示词,需降级为「无自驱」');
  console.log('· step_type 出现新值 → 需回流 AntigravityAdapter 的 compatAudit 白名单');
  console.log('· 工作目录产物:', readdirSync(CWD).join(', ') || '(空)');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
setTimeout(() => { console.log('\n[GLOBAL TIMEOUT]'); process.exit(0); }, 40 * 60 * 1000);
