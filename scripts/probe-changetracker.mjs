/**
 * probe-changetracker.mjs — 验证「接受/拒绝(回退)」核心机制（不依赖 electron）：
 * 复刻 ChangeTracker 的 git 命令与基线/回退流程，在临时 git 仓库上断言——
 * 回退后：AI 改动被撤销、用户未提交手改被保留、AI 新建文件被删除。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

console.log('1. 回合开始锁定用户未提交内容为基线:', dirtyCaptured ? 'OK' : 'FAIL');
console.log('2. 回退后 a.txt =', JSON.stringify(aAfter));
console.log('   → 撤销 AI 的 AI-ADDED/CHANGED3、保留用户的 USER-EDIT:', aOk ? 'OK' : 'FAIL');
console.log('3. AI 新建的 b.txt 被删除:', bGone ? 'OK' : 'FAIL');
const pass = dirtyCaptured && aOk && bGone;
console.log(pass ? '\nPASS ✅ 只回退本次 AI 改动、保留用户未提交手改' : '\nFAIL ❌');
process.exit(pass ? 0 : 1);

