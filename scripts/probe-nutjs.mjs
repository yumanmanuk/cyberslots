/**
 * probe-nutjs.mjs — P2 动作库可用性探针（桌面控制面落地前的门禁）。
 *
 * 验证 @nut-tree-fork/nut-js 在本机 node 下的可用性：
 *  1. 免 rebuild 加载（该库走 @nut-tree-fork/libnut-win32 预编译 .node）+ 版本号
 *  2. 只读查询：screen.width()/height()、mouse.getPosition()
 *  3. --move：鼠标 +10/+10 px 往返移动（不做任何键盘输入）；无此 flag 时纯只读
 *  4. Electron 兼容性记录：本脚本跑在纯 node（process.versions.electron 缺失），
 *     Electron 33 的 ABI 匹配属打包期问题，此处只记录 node 侧可加载性
 *  5. electron-builder 打包备注（REMARK 行）：
 *     该库现为 devDependency（不会进包）；Phase 3 需移到 dependencies，
 *     并对原生 .node 文件配 asarUnpack。
 *
 * 用法：node scripts/probe-nutjs.mjs [--move]
 *
 * 注：只读探测/不写用户配置；--move 仅移动鼠标 ±10px 后归位。
 */
import { createRequire } from 'node:module';

const MOVE = process.argv.includes('--move');
const log = (...a) => console.log('[probe]', ...a);
const section = (t) => console.log(`\n========== ${t} ==========`);
const remark = (...a) => console.log('[probe] REMARK:', ...a);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- 1. 免 rebuild 加载
section('1. 模块加载（prebuilds，无 node-gyp）');
let nut;
try {
  nut = await import('@nut-tree-fork/nut-js');
} catch (e) {
  check('模块加载', false, String(e?.message ?? e).slice(0, 300));
  printSummary();
  process.exit(1);
}
const { screen, mouse, keyboard, Point } = nut;
const require = createRequire(import.meta.url);
const pkg = require('@nut-tree-fork/nut-js/package.json');
check('模块加载', typeof screen === 'object' && typeof mouse === 'object', `version=${pkg.version}`);
log('keyboard/Point 导出类型 =', typeof keyboard, '/', typeof Point);

// ---------------------------------------------------------------- 2. 只读查询
section('2. 只读查询（screen / mouse.getPosition）');
try {
  const [w, h] = [await screen.width(), await screen.height()];
  check('screen.width()/height()', w > 0 && h > 0, `${w}x${h}`);
} catch (e) {
  check('screen.width()/height()', false, String(e?.message ?? e).slice(0, 200));
}
let before;
try {
  before = await mouse.getPosition();
  check('mouse.getPosition()', Number.isFinite(before.x) && Number.isFinite(before.y), `(${before.x}, ${before.y})`);
} catch (e) {
  check('mouse.getPosition()', false, String(e?.message ?? e).slice(0, 200));
}

// ---------------------------------------------------------------- 3. --move 位移往返
section(`3. 鼠标位移（${MOVE ? '--move 已给，执行 +10/+10 往返' : '未给 --move，跳过（只读模式）'}）`);
if (MOVE && before) {
  try {
    await mouse.setPosition(new Point(before.x + 10, before.y + 10));
    const moved = await mouse.getPosition();
    await mouse.setPosition(new Point(before.x, before.y));
    const back = await mouse.getPosition();
    const ok = Math.abs(moved.x - (before.x + 10)) <= 1 && Math.abs(moved.y - (before.y + 10)) <= 1 &&
      Math.abs(back.x - before.x) <= 1 && Math.abs(back.y - before.y) <= 1;
    check('鼠标 +10/+10 往返', ok, `(${before.x},${before.y}) → (${moved.x},${moved.y}) → (${back.x},${back.y})`);
  } catch (e) {
    check('鼠标 +10/+10 往返', false, String(e?.message ?? e).slice(0, 200));
  }
} else if (MOVE) {
  check('鼠标 +10/+10 往返', false, 'getPosition 失败，无基准点');
} else {
  log('跳过（只读探测默认不动鼠标）');
}

// ---------------------------------------------------------------- 4. Electron 兼容性记录
section('4. 运行环境记录');
log('node =', process.version, '；ABI modules =', process.versions.modules, '；platform =', process.platform, process.arch);
if (process.versions.electron) {
  log('process.versions.electron =', process.versions.electron);
} else {
  log('process.versions.electron = （缺失 —— 当前跑在纯 node）');
  remark('Electron 33 兼容性属打包期问题：nut-js 预编译 .node 按 node ABI 出包，Electron 需确认其 ABI 与预编译件匹配，必要时在打包钩子内 electron-rebuild。本条仅记录 node 侧可加载性（已验证）。');
}

// ---------------------------------------------------------------- 5. 打包备注
section('5. electron-builder 打包备注（Phase 3 待办）');
remark('@nut-tree-fork/nut-js 现为 devDependency —— electron-builder 不会把 devDependencies 打进 app 包。');
remark('Phase 3 必须：① 移到 dependencies；② 原生 .node（@nut-tree-fork/libnut-win32/build/Release/libnut.node 等）配 asarUnpack，否则 asar 内无法 dlopen。');
remark('libnut 按平台分包（libnut-win32/darwin/linux），跨平台分发时 electron-builder 需按 target 保留对应包。');

printSummary();
process.exit(results.every((r) => r.ok) ? 0 : 1);

function printSummary() {
  section('PASS/FAIL 汇总');
  for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const fails = results.filter((r) => !r.ok).length;
  log(`合计 ${results.length} 项，FAIL ${fails} 项 → ${fails ? 'P2 未过' : 'P2 全过'}`);
}
