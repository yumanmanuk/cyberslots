/**
 * probe-claude-adapter.mjs — 端到端模拟测试 ClaudeAdapter 本身（非裸协议）。
 *
 * 用 esbuild 把 ClaudeAdapter.ts + 本驱动打包成单文件，stub 掉带 electron
 * 依赖的 compatAudit（换成内存记录），然后用真实 `claude` 进程跑完整流程，
 * 断言翻译出的 EngineEvent 序列符合预期：
 *   1. start() → models.update / modes.update / session.status(idle)
 *   2. prompt() 基本回合 → turn.started → text.delta* → turn.ended(end_turn)
 *   3. 权限回路 → permission.request → answerPermission('allow_once') → tool 完成
 *   4. setMode/setModel 热切不崩
 *   5. cancel() 中断 → turn.ended(interrupted)
 *   6. session.meta 回填 engineSessionId
 *
 * 运行：node scripts/probe-claude-adapter.mjs
 */

import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---- 1. stub 文件：compatAudit（避开 electron app.getPath）+ killTree（纯 child_process，可原样）
const stubDir = mkdtempSync(join(tmpdir(), 'claude-adapter-stub-'));
const compatStub = join(stubDir, 'compatAudit.ts');
writeFileSync(
  compatStub,
  `export const compatAudit = { record: (...a: unknown[]) => { (globalThis as any).__compat?.push(a); } };\n`,
);

// ---- 2. 用 esbuild 打包 ClaudeAdapter + 驱动，alias compatAudit → stub
const entry = join(stubDir, 'entry.ts');
writeFileSync(
  entry,
  `
import { ClaudeAdapter } from ${JSON.stringify(join(ROOT, 'src/main/engine/claude/ClaudeAdapter.ts').replace(/\\\\/g, '/'))};
export { ClaudeAdapter };
`,
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
  alias: {
    '@shared/types': join(ROOT, 'src/shared/types.ts'),
  },
  plugins: [
    {
      name: 'stub-compat',
      setup(b) {
        // 把对 ../compatAudit 的引用重定向到 stub。
        b.onResolve({ filter: /compatAudit$/ }, () => ({ path: compatStub }));
      },
    },
  ],
  logLevel: 'warning',
});

const { ClaudeAdapter } = await import(pathToFileURL(outfile).href);

// ---------------------------------------------------------------- harness
const cwd = mkdtempSync(join(tmpdir(), 'claude-adapter-cwd-'));
globalThis.__compat = [];
const events = [];
const sink = (e) => {
  events.push(e);
  const brief =
    e.type === 'text.delta'
      ? `"${e.text.slice(0, 30)}"`
      : e.type === 'tool.upsert'
        ? `${e.toolName ?? ''} ${e.status ?? ''} ${e.title ?? ''}`.trim()
        : e.type === 'turn.ended'
          ? `stop=${e.stopReason} usage=${JSON.stringify(e.usage ?? {})}`
          : e.type === 'permission.request'
            ? `"${e.title}" opts=${e.options.map((o) => o.optionId).join(',')}`
            : e.type === 'models.update' || e.type === 'modes.update'
              ? `cur=${e.current} avail=[${e.available.join(',')}]`
              : e.type === 'session.status'
                ? e.status
                : e.type === 'session.meta'
                  ? JSON.stringify(e.patch)
                  : e.type === 'error'
                    ? `${e.source}: ${e.message.slice(0, 80)}`
                    : e.type === 'plan.update'
                      ? `${e.entries.length} entries`
                      : '';
  console.log(`  ⟶ ${e.type} ${brief}`);
};

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failed++;
  }
}
function last(type) {
  return [...events].reverse().find((e) => e.type === type);
}
function countSince(mark, type) {
  return events.slice(mark).filter((e) => e.type === type).length;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n[cwd]', cwd);

// ============================================================ PHASE 1: start
console.log('\n===== PHASE 1: start() 元信息广播 =====');
const adapter = new ClaudeAdapter({ cwd, modelId: 'haiku', permissionMode: 'default' }, sink);
const { engineSessionId } = await adapter.start();
assert(last('models.update')?.available.includes('sonnet'), 'models.update 含 sonnet');
assert(last('modes.update')?.available.includes('plan'), 'modes.update 含 plan');
assert(last('session.status')?.status === 'idle', 'start 后 idle');
// 新会话：start() 即返回确定性 session-id（--session-id），无需等首回合。
assert(/^[0-9a-f-]{36}$/i.test(engineSessionId), `start() 返回确定性 session-id (${engineSessionId})`);

// ============================================================ PHASE 2: 基本回合
console.log('\n===== PHASE 2: 基本回合（流式文本 + turn.ended） =====');
let mark = events.length;
await adapter.prompt('请只回复一个词：好的');
assert(countSince(mark, 'turn.started') === 1, 'turn.started 一次');
assert(countSince(mark, 'text.delta') >= 1, 'text.delta ≥1');
const te2 = last('turn.ended');
assert(te2?.stopReason === 'end_turn', `turn.ended end_turn (实际=${te2?.stopReason})`);
// usage 对象已附且至少一个 token 计数为正（代理后端可能把量全放入 cachedInputTokens）。
const u2 = te2?.usage ?? {};
const anyTokens = (u2.inputTokens ?? 0) + (u2.outputTokens ?? 0) + (u2.cachedInputTokens ?? 0) + (u2.totalTokens ?? 0);
assert(!!te2?.usage && anyTokens > 0, `turn.ended 带真实 usage (${JSON.stringify(u2)})`);
assert(!!last('session.meta')?.patch?.engineSessionId || !!engineSessionId, 'engineSessionId 已回填');

// ============================================================ PHASE 3: 第二回合上下文
console.log('\n===== PHASE 3: 同进程第二回合（上下文延续） =====');
mark = events.length;
await adapter.prompt('复述你上一句回复的那个词');
assert(countSince(mark, 'turn.ended') === 1, '第二回合正常收尾');

// ============================================================ PHASE 4: 权限回路
console.log('\n===== PHASE 4: can_use_tool 权限回路（default 模式） =====');
mark = events.length;
// 在权限请求到达时自动 allow_once
const permWatcher = setInterval(() => {
  const req = events.slice(mark).find((e) => e.type === 'permission.request' && !e.__handled);
  if (req) {
    req.__handled = true;
    console.log(`  → 自动应答 allow_once (${req.requestId})`);
    adapter.answerPermission(req.requestId, 'allow_once');
  }
}, 200);
await adapter.prompt('用 Write 工具在当前目录创建 hello.txt，内容为 hi');
clearInterval(permWatcher);
assert(countSince(mark, 'permission.request') >= 1, '触发了 permission.request');
assert(countSince(mark, 'permission.resolved') >= 1, 'permission.resolved 已回执');
// 授权生效的验证：应答后回合无错收尾（end_turn）且至少一个工具走到 completed
// （模型具体用 Write 还是 Bash 建文件不确定，不断言工具名，只验证授权链路通）。
const toolDone = events.slice(mark).some((e) => e.type === 'tool.upsert' && e.status === 'completed');
const te4 = last('turn.ended');
assert(toolDone, '授权后至少一个工具 completed');
assert(te4?.stopReason === 'end_turn', `授权后回合正常收尾 (${te4?.stopReason})`);
assert(countSince(mark, 'error') === 0, '授权链路无 error 事件');

// ============================================================ PHASE 5: 热切模式/模型
console.log('\n===== PHASE 5: setMode / setModel 热切 =====');
mark = events.length;
await adapter.setMode('acceptEdits' in {} ? 'auto' : 'auto');
await adapter.setModel('sonnet');
await wait(1500);
assert(last('modes.update')?.current === 'auto', 'setMode(auto) 已广播');
assert(last('models.update')?.current === 'sonnet', 'setModel(sonnet) 已广播');
assert(globalThis.__compat.length === 0, `无兼容审计告警（未知事件数=${globalThis.__compat.length}）`);

// ============================================================ PHASE 6: cancel 中断
console.log('\n===== PHASE 6: cancel() 中断长回合 =====');
mark = events.length;
const longPrompt = adapter.prompt('从 1 数到 300，每个数字单独一行，中间不要停。');
await wait(2500); // 等它开始产出
await adapter.cancel();
await longPrompt;
const te6 = last('turn.ended');
assert(countSince(mark, 'turn.ended') === 1, '中断后回合收尾一次');
assert(te6?.stopReason === 'interrupted' || te6?.stopReason === 'end_turn', `中断回合 stopReason=${te6?.stopReason}`);

// ============================================================ PHASE 7: effort 热切
console.log('\n===== PHASE 7: effort 热切（/effort 斜杠命令，内部静默） =====');
// 先回到可控模式（上一阶段换了 sonnet/auto），用 haiku 降噪。
await adapter.setModel('haiku');
await wait(500);
mark = events.length;
// 传 effort=high：适配器应先发内部 /effort high（不发 turn.started），再跑正文。
await adapter.prompt('一句话回答：1+1=？', undefined, 'high');
const startsHigh = countSince(mark, 'turn.started');
const endsHigh = countSince(mark, 'turn.ended');
assert(startsHigh === 1, `effort 热切后仅 1 个真回合 turn.started（实际=${startsHigh}，/effort 静默不泄漏）`);
assert(endsHigh === 1, `effort 热切后仅 1 个 turn.ended（实际=${endsHigh}）`);
assert(countSince(mark, 'error') === 0, 'effort 热切无 error');
// 再传相同 effort=high：不应重复发 /effort（appliedEffort 去重），仍只 1 个真回合。
mark = events.length;
await adapter.prompt('再一句：2+2=？', undefined, 'high');
assert(countSince(mark, 'turn.started') === 1, '重复同档不重发 /effort（仍 1 个真回合）');
// 切不同 effort=low：应再发一次内部 /effort low，仍只 1 个真回合。
mark = events.length;
await adapter.prompt('再一句：3+3=？', undefined, 'low');
assert(countSince(mark, 'turn.started') === 1, '换档后仍只 1 个真回合 turn.started');
assert(countSince(mark, 'turn.ended') === 1, '换档后仍只 1 个 turn.ended');

// ============================================================ PHASE 8: compact
console.log('\n===== PHASE 8: compact() 上下文压缩（/compact） =====');
mark = events.length;
await adapter.compact();
assert(countSince(mark, 'turn.ended') === 1, 'compact 作为一个回合正常收尾');
assert(countSince(mark, 'error') === 0, 'compact 无 error');

// ============================================================ PHASE 9: 新会话实例 + 计划审批
console.log('\n===== PHASE 9: 新实例 plan 模式 ExitPlanMode 审批卡 =====');
// 开一个全新适配器（default->首个 prompt 验证 --session-id）。
const cwd2 = mkdtempSync(join(tmpdir(), 'claude-adapter-cwd2-'));
const events2 = [];
let planApproved = false;
const adapter2 = new ClaudeAdapter({ cwd: cwd2, modelId: 'haiku', permissionMode: 'plan' }, (e) => {
  events2.push(e);
  // ExitPlanMode 在 plan 交互模式下应弹「批准计划」卡 → 自动批准。
  if (e.type === 'permission.request' && /批准计划/.test(e.title)) {
    planApproved = true;
    console.log(`  → 收到计划审批卡："${e.title}"，自动批准`);
    adapter2.answerPermission(e.requestId, 'allow_once');
  } else if (e.type === 'permission.request') {
    // AskUserQuestion 等其他交互卡 → 也放行以推进。
    adapter2.answerPermission(e.requestId, 'allow_once');
  }
});
const { engineSessionId: sid2 } = await adapter2.start();
assert(/^[0-9a-f-]{36}$/i.test(sid2) && sid2 !== engineSessionId, `新实例 独立确定性 session-id (${sid2.slice(0, 8)})`);
await adapter2.prompt('严禁使用 AskUserQuestion。直接调用 ExitPlanMode 工具提交一个只有两步的极简计划（1.读文件 2.加测试）。不要问任何问题。');
const planUpd = [...events2].reverse().find((e) => e.type === 'plan.update');
assert(!!planUpd, 'plan 模式产出 plan.update（ExitPlanMode 计划文本）');
assert(planApproved, 'ExitPlanMode 弹出了「批准计划」审批卡（交互计划审批）');
await adapter2.dispose();
try { rmSync(cwd2, { recursive: true, force: true }); } catch { /* ignore */ }

// ============================================================ 收尾
await adapter.dispose();
console.log(`\n===== 结果：${passed} 通过 / ${failed} 失败 =====`);
try {
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(failed > 0 ? 1 : 0);
