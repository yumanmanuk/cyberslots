/**
 * probe-agy-turn-gate.mjs — AntigravityAdapter 回合收尾/并发闸门模拟测试。
 *
 * 背景（2026-08-03 赛马假冲线 + 没自动切号）：
 * agy 中途 error_message 步只 emit error 不发 turn.ended；result ERROR
 * "Agent execution terminated due to error." 后要异步 probe 坐实额度才发
 * 唯一的 turn.ended（带 quotaExhausted）。probe 窗口期内任何并发 prompt
 * 都必须被闸门（promptActive）拒掉（superseded），否则 rogue 回合会
 * 覆盖 this.child、旧 probe 的 .then() 误发旧 turnId 事件。
 *
 * 用 esbuild 打包 AntigravityAdapter，stub 掉 electron 依赖（log/logger）、
 * compatAudit、agyAccounts（queryActiveAgyQuota 可控延迟/结论）和
 * resolveAntigravity（指向 fake agy CLI 脚本），断言：
 *   1. 额度场景：close 后 probe 在途时再 prompt → 拒 superseded；最终
 *      恰好一条 turn.ended(quotaExhausted=true) + 一条 quota 错误，泛化
 *      错误（"Agent execution terminated"）被抑制；idle 在 turn.ended 后。
 *   2. 非额度场景：probe 未坐实 → 补发无标记泛化错误，turn.ended 无 flag。
 *   3. 回合进行中（hang）再 prompt → 拒 superseded；cancel 后闸门放行。
 *   4. 无 result 崩退 → close 兜底 error + turn.ended(error)，闸门放行。
 *
 * 运行：node scripts/probe-agy-turn-gate.mjs
 */

import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------- fake agy CLI
const stubDir = mkdtempSync(join(tmpdir(), 'agy-gate-stub-'));
const fakeCli = join(stubDir, 'fake-agy.mjs');
writeFileSync(
  fakeCli,
  `
const mode = process.env.FAKE_AGY_MODE ?? 'ok';
const linger = Number(process.env.FAKE_AGY_LINGER_MS ?? 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const cid = 'fake-cid-1';

async function main() {
  emit({ event: 'init', init: { conversation_id: cid } });
  if (mode === 'hang') {
    setInterval(() => {}, 1000); // 永不退出，等被 kill
    return;
  }
  if (mode === 'crash') {
    process.stderr.write('fatal: auth backend unreachable\\n');
    await sleep(30);
    process.exit(2);
  }
  if (mode === 'quota_error') {
    // 复刻 2026-08-03 现场：中途空 error_message 步（152/154/156）
    for (const idx of [152, 154, 156]) {
      emit({ event: 'step_update', step_update: { step_index: idx, state: 'DONE', step_type: 'error_message', conversation_id: cid } });
      await sleep(60);
    }
    emit({ event: 'result', result: { status: 'ERROR', error: 'Agent execution terminated due to error.', conversation_id: cid, usage: { input_tokens: 1200, output_tokens: 340 }, duration_seconds: 1.5 } });
    await sleep(linger);
    process.exit(1);
  }
  emit({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '好的', conversation_id: cid } });
  emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: cid, usage: { input_tokens: 10, output_tokens: 2 }, duration_seconds: 0.2 } });
  await sleep(linger);
  process.exit(0);
}
main();
`,
);

// ---------------------------------------------------------------- stubs
const loggerStub = join(stubDir, 'logger.ts');
writeFileSync(loggerStub, `export const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };\n`);

const compatStub = join(stubDir, 'compatAudit.ts');
writeFileSync(compatStub, `export const compatAudit = { record: () => {} };\n`);

const quotaStub = join(stubDir, 'agyAccounts.ts');
writeFileSync(
  quotaStub,
  `
export async function queryActiveAgyQuota(_force = false) {
  const c = globalThis.__quotaControl ?? { delayMs: 0, result: { ok: false, groups: [] } };
  await new Promise((r) => setTimeout(r, c.delayMs));
  return c.result;
}
`,
);

const resolveStub = join(stubDir, 'resolveAntigravity.ts');
writeFileSync(
  resolveStub,
  `
export function resolveAgyCli(extraArgs) {
  return { command: process.execPath, args: [globalThis.__fakeAgyScript, ...extraArgs], label: 'fake-agy' };
}
`,
);

// ---------------------------------------------------------------- bundle
const entry = join(stubDir, 'entry.ts');
writeFileSync(
  entry,
  `export { AntigravityAdapter } from ${JSON.stringify(join(ROOT, 'src/main/engine/antigravity/AntigravityAdapter.ts').replace(/\\/g, '/'))};\n`,
);
const outfile = join(stubDir, 'bundle.mjs');
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile,
  external: ['node:*'],
  plugins: [
    {
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /log[\\/]logger$/ }, () => ({ path: loggerStub }));
        b.onResolve({ filter: /compatAudit$/ }, () => ({ path: compatStub }));
        b.onResolve({ filter: /agyAccounts$/ }, () => ({ path: quotaStub }));
        b.onResolve({ filter: /resolveAntigravity$/ }, () => ({ path: resolveStub }));
      },
    },
  ],
  logLevel: 'warning',
});

globalThis.__fakeAgyScript = fakeCli;
const { AntigravityAdapter } = await import(pathToFileURL(outfile).href);

// ---------------------------------------------------------------- harness
const cwd = mkdtempSync(join(tmpdir(), 'agy-gate-cwd-'));
const events = [];
const sink = (e) => {
  events.push(e);
  const brief =
    e.type === 'error'
      ? `${e.source}${e.quotaExhausted ? ' [quota]' : ''}: ${e.message.split('\n')[0].slice(0, 70)}`
      : e.type === 'turn.ended'
        ? `stop=${e.stopReason}${e.quotaExhausted ? ' [quota]' : ''}`
        : e.type === 'session.status'
          ? e.status
          : e.type === 'text.delta'
            ? `"${e.text}"`
            : '';
  console.log(`  ⟶ ${e.type} ${brief}`);
};

let passed = 0;
let failed = 0;
let unhandled = 0;
process.on('unhandledRejection', (err) => {
  unhandled++;
  console.log('  [UNHANDLED]', err?.message ?? err);
});
function assert(cond, label) {
  if (cond) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failed++;
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await wait(25);
  }
}
const ofType = (type) => events.filter((e) => e.type === type);
const idxLast = (pred) => {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) return i;
  return -1;
};
async function expectSuperseded(p, label) {
  try {
    await p;
    assert(false, `${label} — 未被拒绝`);
  } catch (err) {
    assert(/superseded/.test(err?.message ?? ''), `${label} — 拒绝含 superseded (实际=${err?.message})`);
  }
}

console.log('\n[cwd]', cwd);

// ============================================================ PHASE 1: 额度耗尽（bug 现场）
console.log('\n===== PHASE 1: result ERROR + 慢 probe 坐实额度 → probe 窗口闸门 + 唯一 quota turn.ended =====');
process.env.FAKE_AGY_MODE = 'quota_error';
process.env.FAKE_AGY_LINGER_MS = '50';
globalThis.__quotaControl = {
  delayMs: 800,
  result: { ok: true, email: 'lucille3717@gmail.com', groups: [{ group: '5小时', utilization: 100, resetsInSeconds: 17400 }] },
};
{
  const adapter = new AntigravityAdapter({ cwd, modelId: 'claude-opus-4-6-thinking' }, sink);
  await adapter.start();
  await adapter.prompt('重构这个模块'); // resolve 于子进程 close —— 此时 probe（800ms）仍在途
  // ★ 核心回归断言：probe 窗口期并发 prompt 必须被闸门拒掉
  await expectSuperseded(adapter.prompt('继续'), 'probe 窗口期 rogue「继续」被拒');
  assert(ofType('turn.started').length === 1, 'rogue 被拒后 turn.started 仍只有 1 次');
  await waitFor(() => ofType('turn.ended').length >= 1, 'turn.ended 到达');
  await wait(50); // 让可能的重复事件有机会暴露
  const te = ofType('turn.ended');
  assert(te.length === 1, `turn.ended 恰好 1 条 (实际=${te.length})`);
  assert(te[0]?.quotaExhausted === true, 'turn.ended 带 quotaExhausted=true');
  const quotaErrs = ofType('error').filter((e) => e.quotaExhausted === true);
  assert(quotaErrs.length === 1 && quotaErrs[0].message.includes('lucille3717@gmail.com'), '恰好 1 条 quota 错误且带账号名');
  assert(ofType('error').filter((e) => e.message.includes('Agent execution terminated')).length === 0, '泛化错误被抑制（quota 场景只发 quota 错误）');
  assert(ofType('error').filter((e) => e.message.includes('模型报告错误')).length === 3, '中途 3 个 error_message 步照常上报');
  const iTE = events.indexOf(te[0]);
  const iIdle = idxLast((e) => e.type === 'session.status' && e.status === 'idle');
  assert(iIdle > iTE, 'idle 在 turn.ended 之后（收尾放行点在 .then()）');
  // 闸门已放行：第二个完整回合能跑通
  await adapter.prompt('第二回合');
  await waitFor(() => ofType('turn.ended').length >= 2, '第二回合 turn.ended');
  assert(ofType('turn.started').length === 2 && ofType('turn.ended').length === 2, '闸门放行后第二回合完整跑完');
  await adapter.dispose();
}

// ============================================================ PHASE 2: 泛化错误但 probe 未坐实 → 非额度
console.log('\n===== PHASE 2: result ERROR + probe 未坐实 → 补发无标记泛化错误 =====');
process.env.FAKE_AGY_MODE = 'quota_error';
globalThis.__quotaControl = {
  delayMs: 600,
  result: { ok: true, email: 'fresh@x.y', groups: [{ group: '5小时', utilization: 40, resetsInSeconds: 1000 }] },
};
{
  events.length = 0;
  const adapter = new AntigravityAdapter({ cwd }, sink);
  await adapter.start();
  await adapter.prompt('再试一次');
  await expectSuperseded(adapter.prompt('继续'), 'probe 窗口期（非额度）并发 prompt 同样被拒');
  await waitFor(() => ofType('turn.ended').length >= 1, 'turn.ended 到达');
  await wait(50);
  const generic = ofType('error').filter((e) => e.message.includes('Agent execution terminated'));
  assert(generic.length === 1 && !generic[0].quotaExhausted, 'probe 未坐实 → 补发 1 条无标记泛化错误');
  const te = ofType('turn.ended');
  assert(te.length === 1 && !te[0].quotaExhausted, 'turn.ended 无 quota flag');
  assert(events.indexOf(generic[0]) < events.indexOf(te[0]), '泛化错误在 turn.ended 之前');
  await adapter.dispose();
}

// ============================================================ PHASE 3: 回合进行中重入 + cancel 放行
console.log('\n===== PHASE 3: 回合 hang 住 → 重入被拒；cancel 后闸门放行 =====');
process.env.FAKE_AGY_MODE = 'hang';
globalThis.__quotaControl = { delayMs: 0, result: { ok: false, groups: [] } };
{
  events.length = 0;
  const adapter = new AntigravityAdapter({ cwd }, sink);
  await adapter.start();
  const p1 = adapter.prompt('长跑任务');
  await waitFor(() => ofType('turn.started').length === 1, 'turn.started');
  await expectSuperseded(adapter.prompt('插队'), '回合进行中并发 prompt 被拒');
  await adapter.cancel();
  await p1; // close 后 resolve
  await wait(50);
  const te = ofType('turn.ended');
  assert(te.length === 1 && te[0].stopReason === 'error', `cancel 后兜底 turn.ended(error) (实际=${te[0]?.stopReason})`);
  // 闸门放行：新回合可起
  const p2 = adapter.prompt('新回合');
  await waitFor(() => ofType('turn.started').length === 2, '第二回合 turn.started');
  await adapter.cancel();
  await p2;
  await adapter.dispose();
  assert(true, 'cancel 后闸门放行、可起新回合');
}

// ============================================================ PHASE 4: 无 result 崩退 → close 兜底
console.log('\n===== PHASE 4: 无 result 崩退 → close 兜底 error + turn.ended，闸门放行 =====');
process.env.FAKE_AGY_MODE = 'crash';
{
  events.length = 0;
  const adapter = new AntigravityAdapter({ cwd }, sink);
  await adapter.start();
  await adapter.prompt('会崩的回合');
  await wait(50);
  const errs = ofType('error');
  assert(errs.some((e) => e.message.includes('agy 退出')), 'close 兜底补发「agy 退出」错误');
  const te = ofType('turn.ended');
  assert(te.length === 1 && te[0].stopReason === 'error', '兜底 turn.ended(error) 恰好 1 条');
  await adapter.prompt('再来'); // 闸门已放行，不抛 superseded（会再崩一次）
  await waitFor(() => ofType('turn.ended').length >= 2, '第二回合 turn.ended');
  assert(ofType('turn.ended').length === 2, '崩退后闸门放行、第二回合跑完');
  await adapter.dispose();
}

await wait(100);
assert(unhandled === 0, `无 unhandledRejection (实际=${unhandled})`);

rmSync(stubDir, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
console.log(`\n===== 结果: ${passed} passed, ${failed} failed =====`);
process.exit(failed > 0 ? 1 : 0);
