/**
 * probe-claude-customcli.mjs — 实测自定义启动命令经 ClaudeAdapter 解析后能否
 * 真正跑起会话。覆盖三种形态：
 *   A. PATH 上的裸命令名（cc）
 *   B. 绝对路径 .cmd（<tmp>/cc-shim-test/cc.cmd）
 *   C. 留空（自动探测，回归验证不破坏原路径）
 *
 * 用 esbuild 打包真实 ClaudeAdapter（stub compatAudit），跑到 start()+一个回合。
 */

import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const stubDir = mkdtempSync(join(tmpdir(), 'cc-cli-stub-'));
writeFileSync(join(stubDir, 'compatAudit.ts'), `export const compatAudit = { record: () => {} };\n`);
const entry = join(stubDir, 'entry.ts');
writeFileSync(
  entry,
  `export { ClaudeAdapter } from ${JSON.stringify(join(ROOT, 'src/main/engine/claude/ClaudeAdapter.ts').replace(/\\\\/g, '/'))};\n` +
    `export { resolveClaudeCli } from ${JSON.stringify(join(ROOT, 'src/main/engine/claude/resolveClaude.ts').replace(/\\\\/g, '/'))};\n`,
);
const outfile = join(stubDir, 'bundle.mjs');
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'node20', outfile,
  external: ['node:*'],
  alias: { '@shared/types': join(ROOT, 'src/shared/types.ts') },
  plugins: [{ name: 'stub', setup(b) { b.onResolve({ filter: /compatAudit$/ }, () => ({ path: join(stubDir, 'compatAudit.ts') })); } }],
  logLevel: 'warning',
});
const { ClaudeAdapter, resolveClaudeCli } = await import(pathToFileURL(outfile).href);

const ccCmd = join(tmpdir(), 'cc-shim-test', 'cc.cmd');
let pass = 0, fail = 0;
const ok = (c, l) => { console.log(`  ${c ? '[PASS]' : '[FAIL]'} ${l}`); c ? pass++ : fail++; };

// ---- 先纯逻辑验证 resolveClaudeCli 对三种入口的 spawn spec
console.log('\n===== resolveClaudeCli 解析形态 =====');
const specBare = resolveClaudeCli(['--version'], 'cc');
console.log('  cc →', JSON.stringify({ command: specBare.command, shell: specBare.shell, label: specBare.label }));
ok(specBare.command === 'cc' && specBare.shell === true, '裸命令名 cc → shell PATH 解析');

if (existsSync(ccCmd)) {
  const specCmd = resolveClaudeCli(['--version'], ccCmd);
  console.log('  cc.cmd →', JSON.stringify({ command: specCmd.command, shell: specCmd.shell }));
  ok(specCmd.command === ccCmd && specCmd.shell === true, '绝对路径 .cmd → 直跑 + shell');
} else {
  console.log('  (跳过 .cmd 绝对路径：shim 不存在)');
}

const specAuto = resolveClaudeCli(['--version'], '');
console.log('  "" →', JSON.stringify({ command: specAuto.command === process.execPath ? 'ELECTRON/node' : specAuto.command, shell: specAuto.shell }));
ok(!!specAuto.command, '留空 → 回落自动探测（不破坏原路径）');

const specSpace = resolveClaudeCli(['--version'], '  cc  ');
ok(specSpace.command === 'cc', '前后空格被 trim');

// ---- 真实 spawn 验证：自定义命令 A（裸 cc，需 PATH 含 shim 目录）
async function runTurn(label, opts) {
  const cwd = mkdtempSync(join(tmpdir(), 'cc-run-'));
  const events = [];
  const ad = new ClaudeAdapter({ cwd, modelId: 'haiku', permissionMode: 'default', ...opts }, (e) => events.push(e));
  let started = false;
  try {
    await ad.start();
    started = true;
    await ad.prompt('回复一个词：ok');
  } catch (e) {
    console.log(`  [${label}] 异常:`, e.message);
  }
  const te = [...events].reverse().find((e) => e.type === 'turn.ended');
  const err = events.find((e) => e.type === 'error');
  await ad.dispose();
  try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  return { started, ended: te?.stopReason, err: err?.message };
}

console.log('\n===== 真实 spawn：自定义 cliEntry =====');
if (existsSync(ccCmd)) {
  const r = await runTurn('cc.cmd 绝对路径', { cliEntry: ccCmd });
  console.log('  cc.cmd:', JSON.stringify(r));
  ok(r.started && r.ended === 'end_turn' && !r.err, 'cc.cmd 绝对路径能跑完整回合');
} else {
  console.log('  (跳过 .cmd 真实 spawn：shim 不存在，先跑前面的 PowerShell 建 shim)');
}

// 裸 cc：需 PATH 含 shim 目录。把 shim 目录注入本进程 PATH 后测。
const ccDir = join(tmpdir(), 'cc-shim-test');
if (existsSync(join(ccDir, 'cc.cmd'))) {
  process.env.PATH = `${ccDir};${process.env.PATH}`;
  const r = await runTurn('裸 cc (PATH)', { cliEntry: 'cc' });
  console.log('  cc:', JSON.stringify(r));
  ok(r.started && r.ended === 'end_turn' && !r.err, '裸命令名 cc 经 PATH 能跑完整回合');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
try { rmSync(stubDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail > 0 ? 1 : 0);
