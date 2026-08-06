/**
 * probe-changetracker.mjs — 变更台账/回退机制探针（不依赖 electron app）。
 *
 * PHASE 1（机制概念验证，复刻 git 命令，不加载真实代码）：
 *   回退后 AI 改动被撤销、用户未提交手改被保留、AI 新建文件被删除。
 *
 * PHASE 2（真实 ChangeTracker + ShadowGit，esbuild 打包 + stub electron/logger）：
 *   「回退到某个提问」回退集 = diff ∩（touched ∪ accepted）的回归断言：
 *   A. mark 后 (a) 本会话改 A、(b) 外部改 B（无事件）、(c) 第二会话同 cwd 改 C
 *      → undoPreview 只含 A（unattributed=2）；undoRevert 后 B、C 磁盘原样。
 *   B. 同会话两个提问：mark 前历史编辑（ts < mark.ts）之后被外部再改 → 不入
 *      回退集；回退第一个提问只还原其后的本会话编辑；marks 截断作废。
 *   C. 新建文件回退即删、删除文件回退即还原、修改文件还原内容（A/D/M 状态）。
 *   D. accepted 文件入回退集（免 ts 比较、恒有效）；accepted 精确清理：只删
 *      被实际还原文件的记录，mark 前已 accepted 的保留。
 *   E. 旧格式台账（touched = string 数组）加载回归：ts=0 恒有效，行为退化为
 *      纯路径交集；未归属变更仍被剔除。
 *
 * 运行：node scripts/probe-changetracker.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ============================================================ PHASE 1: 机制概念验证（复刻 git 命令）
const root = mkdtempSync(join(tmpdir(), 'ct-'));
const git = (...a) => execFileSync('git', a, { cwd: root, windowsHide: true }).toString();

git('init', '-q');
git('config', 'user.email', 't@t');
git('config', 'user.name', 't');
writeFileSync(join(root, 'a.txt'), 'line1\nline2\nline3\n');
git('add', '.');
git('commit', '-q', '-m', 'init');

// 用户的未提交手改（work in progress）
writeFileSync(join(root, 'a.txt'), 'line1\nUSER-EDIT\nline2\nline3\n');

// —— snapshotDirtyFiles（turn.started）：锁定已跟踪且未提交文件的当前内容
const baselines = new Map();
for (const entry of git('status', '--porcelain', '-z').split('\0')) {
  if (entry.length < 4) continue;
  const code = entry.slice(0, 2);
  const rel = entry.slice(3);
  if (!rel || code.includes('?')) continue;
  if (!code.includes('M') && !code.includes('A')) continue;
  const abs = join(root, rel);
  baselines.set(abs, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
}
const dirtyCaptured = baselines.get(join(root, 'a.txt')) === 'line1\nUSER-EDIT\nline2\nline3\n';

// —— AI 动手：改已有文件 + 新建文件
writeFileSync(join(root, 'a.txt'), 'line1\nUSER-EDIT\nAI-ADDED\nline2\nCHANGED3\n');
writeFileSync(join(root, 'b.txt'), 'new by ai\n');

// noteEdit(b.txt)：git HEAD 无 → new → 基线 null（回退即删）；a.txt 已锁定 → 跳过
for (const p of ['a.txt', 'b.txt']) {
  const abs = join(root, p);
  if (baselines.has(abs)) continue;
  let baseline;
  try {
    baseline = git('show', `HEAD:${p}`); // 已跟踪 clean 文件的编辑前内容
  } catch {
    baseline = null; // 不在 HEAD = 新建
  }
  baselines.set(abs, baseline);
}

// —— 回退全部：写回基线 / 删除新建
for (const [abs, base] of baselines) {
  if (base === null) {
    if (existsSync(abs)) rmSync(abs, { force: true });
  } else writeFileSync(abs, base, 'utf8');
}

const aAfter = readFileSync(join(root, 'a.txt'), 'utf8');
const bGone = !existsSync(join(root, 'b.txt'));
const aOk = aAfter === 'line1\nUSER-EDIT\nline2\nline3\n';
rmSync(root, { recursive: true, force: true });

console.log('PHASE 1（机制概念验证）');
console.log('1. 回合开始锁定用户未提交内容为基线:', dirtyCaptured ? 'OK' : 'FAIL');
console.log('2. 回退后 a.txt =', JSON.stringify(aAfter));
console.log('   → 撤销 AI 的 AI-ADDED/CHANGED3、保留用户的 USER-EDIT:', aOk ? 'OK' : 'FAIL');
console.log('3. AI 新建的 b.txt 被删除:', bGone ? 'OK' : 'FAIL');
const pass1 = dirtyCaptured && aOk && bGone;
console.log(pass1 ? 'PHASE 1 PASS ✅\n' : 'PHASE 1 FAIL ❌\n');

// ============================================================ PHASE 2: 真实 ChangeTracker 回退集语义
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- stubs：electron app.getPath → 临时 userData；logger 落 globalThis.__csLogs ----------
const stubDir = mkdtempSync(join(tmpdir(), 'ct-stub-'));
const userData = mkdtempSync(join(tmpdir(), 'ct-userdata-'));
globalThis.__probeUserData = userData;
globalThis.__csLogs = [];

const electronStub = join(stubDir, 'electron.ts');
writeFileSync(electronStub, `export const app = { getPath: () => globalThis.__probeUserData };\n`);
const loggerStub = join(stubDir, 'logger.ts');
writeFileSync(
  loggerStub,
  `const push = (level) => (scope, msg, data) => globalThis.__csLogs.push({ level, scope, msg, data });
export const log = { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
`,
);
const entry = join(stubDir, 'entry.ts');
writeFileSync(
  entry,
  `export { ChangeTracker } from ${JSON.stringify(join(ROOT, 'src/main/engine/changeTracker.ts').replace(/\\/g, '/'))};\n`,
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
        b.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub }));
        b.onResolve({ filter: /log[\\/]logger$/ }, () => ({ path: loggerStub }));
      },
    },
  ],
  logLevel: 'warning',
});
const { ChangeTracker } = await import(pathToFileURL(outfile).href);
const tracker = new ChangeTracker();
const ledgerOf = (sid) => JSON.parse(readFileSync(join(userData, 'changes', `${sid}.json`), 'utf8'));
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');

// ---------- 场景 A：本会话 / 外部 / 第二会话三类改动，只回退本会话 ----------
console.log('场景 A：mark 后本会话改 A、外部改 B（无事件）、第二会话同 cwd 改 C');
{
  const dir = mkdtempSync(join(tmpdir(), 'ct-a-'));
  writeFileSync(join(dir, 'a.txt'), 'orig-a\n');
  await tracker.onTurnStart('S1', dir);
  await tracker.markPrompt('S1', dir, 'm1');
  // (a) 本会话改 A（反斜杠 join 路径 — scanTurnEnd 同款形态）
  writeFileSync(join(dir, 'a.txt'), 'by S1\n');
  tracker.noteEdit('S1', join(dir, 'a.txt'), dir);
  // (b) 模拟外部改 B（无任何事件、不触发 scanTurnEnd）
  writeFileSync(join(dir, 'b.txt'), 'external\n');
  // (c) 第二会话同 cwd 改 C（引擎上报同款正斜杠绝对路径 — 混合形态覆盖）
  await tracker.onTurnStart('S2', dir);
  writeFileSync(join(dir, 'c.txt'), 'by S2\n');
  tracker.noteEdit('S2', join(dir, 'c.txt').replace(/\\/g, '/'), dir);

  const prev = await tracker.undoPreview('S1', dir, 'm1');
  assert(prev && prev.files.length === 1 && prev.files[0].name === 'a.txt', 'undoPreview 只含本会话的 a.txt');
  assert(prev.unattributed === 2, `unattributed = 2（b 外部 + c 他会话；实际=${prev.unattributed}）`);

  await tracker.undoRevert('S1', dir, 'm1');
  assert(read(dir, 'a.txt') === 'orig-a\n', 'undoRevert 后 a.txt 还原到 mark 前内容');
  assert(read(dir, 'b.txt') === 'external\n', 'b.txt 外部改动原样保留（不再被误删/误改）');
  assert(read(dir, 'c.txt') === 'by S2\n', 'c.txt 他会话改动原样保留（共享 cwd 物理覆盖被拦截）');
  const l1 = ledgerOf('S1');
  assert(typeof l1.lastUndoSafety?.hash === 'string' && typeof l1.lastUndoSafety?.ts === 'number', '台账写入反悔快照 lastUndoSafety{hash,ts}');
  assert(typeof l1.touched === 'object' && !Array.isArray(l1.touched), 'touched 持久化为 {path: ts} 形态');
  const logs = globalThis.__csLogs;
  assert(
    logs.some((e) => e.scope === 'changes' && e.msg === 'undo revert applied' && e.data?.reverted === 1 && e.data?.skipped === 2),
    '日志记「还原 1 / 跳过 2」（scope=changes，仅计数）',
  );
  assert(logs.some((e) => e.scope === 'changes' && e.msg === 'undo safety snapshot'), '日志记反悔快照 hash');
  const s2List = await tracker.list('S2', dir);
  assert(s2List.length === 1 && s2List[0].name === 'c.txt', 'S2 台账不受 S1 回退影响');
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 场景 B：同会话两个提问 + ts 过滤剔除 mark 前历史残留 ----------
console.log('场景 B：mark 前历史编辑被外部再改 → ts 过滤剔除；回退第一个提问');
{
  const dir = mkdtempSync(join(tmpdir(), 'ct-b-'));
  writeFileSync(join(dir, 'x.txt'), 'x-orig\n');
  await tracker.onTurnStart('S3', dir);
  // mark 之前的历史编辑（touched ts < mark.ts）
  writeFileSync(join(dir, 'x.txt'), 'x-by-S3-before-mark\n');
  tracker.noteEdit('S3', join(dir, 'x.txt'), dir);
  await sleep(25); // 保证 x 的 touched ts 严格早于 q1 的 mark.ts
  await tracker.markPrompt('S3', dir, 'q1');
  // q1 之后：本会话改 a2
  writeFileSync(join(dir, 'a2.txt'), 'a2 after q1\n');
  tracker.noteEdit('S3', join(dir, 'a2.txt'), dir);
  // q1 之后：外部再改 x（无事件 — x 在 touched 但 ts < q1.ts，应被剔除）
  writeFileSync(join(dir, 'x.txt'), 'x-external-after-q1\n');
  // 第二个提问 + 其后本会话编辑 b2
  await tracker.markPrompt('S3', dir, 'q2');
  writeFileSync(join(dir, 'b2.txt'), 'b2 after q2\n');
  tracker.noteEdit('S3', join(dir, 'b2.txt'), dir);

  const prev = await tracker.undoPreview('S3', dir, 'q1');
  const names = prev.files.map((f) => f.name).sort();
  assert(names.join(',') === 'a2.txt,b2.txt', `两个提问：preview 含其后的本会话编辑 a2/b2（实际=${names}）`);
  assert(!prev.files.some((f) => f.name === 'x.txt'), 'ts 过滤：mark 前历史编辑残留 x.txt 不入回退集');
  assert(prev.unattributed === 1, `unattributed=1（x 的外部改动；实际=${prev.unattributed}）`);

  await tracker.undoRevert('S3', dir, 'q1');
  assert(!existsSync(join(dir, 'a2.txt')) && !existsSync(join(dir, 'b2.txt')), '回退第一个提问：其后的本会话新建全部还原');
  assert(read(dir, 'x.txt') === 'x-external-after-q1\n', 'x.txt 外部改动保留（ts 过滤生效）');
  assert(ledgerOf('S3').marks.length === 0, 'marks 截断：q1/q2 还原点一并作废');
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 场景 C：新建 / 删除 / 修改三类文件的还原 ----------
console.log('场景 C：新建回退即删、删除回退即还原、修改还原内容');
{
  const dir = mkdtempSync(join(tmpdir(), 'ct-c-'));
  writeFileSync(join(dir, 'keep.txt'), 'keep-orig\n');
  writeFileSync(join(dir, 'del.txt'), 'del-orig\n');
  await tracker.onTurnStart('S4', dir);
  await tracker.markPrompt('S4', dir, 'c1');
  writeFileSync(join(dir, 'new.txt'), 'new after mark\n');
  tracker.noteEdit('S4', join(dir, 'new.txt'), dir);
  rmSync(join(dir, 'del.txt'));
  tracker.noteEdit('S4', join(dir, 'del.txt'), dir);
  writeFileSync(join(dir, 'keep.txt'), 'keep-changed\n');
  tracker.noteEdit('S4', join(dir, 'keep.txt'), dir);

  const prev = await tracker.undoPreview('S4', dir, 'c1');
  const byName = Object.fromEntries(prev.files.map((f) => [f.name, f.status]));
  assert(byName['new.txt'] === 'added' && byName['del.txt'] === 'deleted' && byName['keep.txt'] === 'modified', 'A/D/M 状态正确');
  await tracker.undoRevert('S4', dir, 'c1');
  assert(!existsSync(join(dir, 'new.txt')), 'mark 后新建文件被删除');
  assert(read(dir, 'del.txt') === 'del-orig\n', 'mark 后删除的文件被还原');
  assert(read(dir, 'keep.txt') === 'keep-orig\n', 'mark 后修改的文件还原内容');
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 场景 D：accepted 入回退集（免 ts）+ accepted 精确清理 ----------
console.log('场景 D：accepted 文件恒有效入回退集；只清理被实际还原的 accepted 记录');
{
  const dir = mkdtempSync(join(tmpdir(), 'ct-d-'));
  writeFileSync(join(dir, 'old.txt'), 'old-orig\n');
  writeFileSync(join(dir, 'acc.txt'), 'acc-orig\n');
  await tracker.onTurnStart('S5', dir);
  // mark 前编辑 old.txt 并接受（accepted 记录；其内容将进 mark 快照）
  writeFileSync(join(dir, 'old.txt'), 'old-accepted\n');
  tracker.noteEdit('S5', join(dir, 'old.txt'), dir);
  await tracker.accept('S5', dir, join(dir, 'old.txt'));
  await tracker.markPrompt('S5', dir, 'd1');
  // mark 后编辑 acc.txt 并接受
  writeFileSync(join(dir, 'acc.txt'), 'acc-changed\n');
  tracker.noteEdit('S5', join(dir, 'acc.txt'), dir);
  await tracker.accept('S5', dir, join(dir, 'acc.txt'));

  const prev = await tracker.undoPreview('S5', dir, 'd1');
  assert(prev.files.length === 1 && prev.files[0].name === 'acc.txt', 'accepted 文件入回退集（恒有效，免 ts 比较）');
  assert(prev.unattributed === 0, `mark 前 accepted 的 old.txt 不在 diff 中（实际 unattributed=${prev.unattributed}）`);
  await tracker.undoRevert('S5', dir, 'd1');
  assert(read(dir, 'acc.txt') === 'acc-orig\n', 'mark 后 accepted 的文件被还原');
  assert(read(dir, 'old.txt') === 'old-accepted\n', 'mark 前 accepted 的文件不动（本就在快照里）');
  const accKeys = Object.keys(ledgerOf('S5').accepted ?? {});
  assert(!accKeys.some((k) => k.endsWith('acc.txt')), 'accepted 精确清理：被还原的 acc.txt 记录已删');
  assert(accKeys.some((k) => k.endsWith('old.txt')), 'accepted 精确清理：未受影响的 old.txt 记录保留');
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 场景 E：旧格式台账（touched = string 数组）加载回归 ----------
console.log('场景 E：旧格式台账 ts=0 恒有效，行为退化为纯路径交集');
{
  const dir = mkdtempSync(join(tmpdir(), 'ct-e-'));
  writeFileSync(join(dir, 'legacy.txt'), 'legacy-orig\n');
  await tracker.onTurnStart('S6', dir);
  await tracker.markPrompt('S6', dir, 'e1');
  writeFileSync(join(dir, 'legacy.txt'), 'legacy-changed\n');
  tracker.noteEdit('S6', join(dir, 'legacy.txt'), dir);
  writeFileSync(join(dir, 'ext.txt'), 'ext\n'); // 外部改动（不在台账）
  // 把磁盘台账改写成旧格式（touched = string 数组）
  const f6 = join(userData, 'changes', 'S6.json');
  const cur = JSON.parse(readFileSync(f6, 'utf8'));
  writeFileSync(f6, JSON.stringify({ ...cur, touched: Object.keys(cur.touched) }), 'utf8');
  // 全新实例（loaded 为空 → ensureLoaded 重新读盘）
  const tracker2 = new ChangeTracker();
  const prev = await tracker2.undoPreview('S6', dir, 'e1');
  assert(prev && prev.files.length === 1 && prev.files[0].name === 'legacy.txt', '旧格式加载：ts=0 恒有效，台账文件入回退集');
  assert(prev.unattributed === 1, `旧格式下未归属变更仍被剔除（ext.txt；实际=${prev.unattributed}）`);
  rmSync(dir, { recursive: true, force: true });
}

rmSync(stubDir, { recursive: true, force: true });
rmSync(userData, { recursive: true, force: true });

console.log(`\nPHASE 2: ${passed} passed, ${failed} failed`);
const pass = pass1 && failed === 0;
console.log(pass ? 'PASS ✅ 回退集 = 本会话变更 ∩ 快照差异；外部/他会话/历史残留均不被误回退' : 'FAIL ❌');
process.exit(pass ? 0 : 1);
