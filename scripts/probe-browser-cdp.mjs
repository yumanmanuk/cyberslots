/**
 * probe-browser-cdp.mjs — P1 驱动连通性探针（BrowserHost/BrowserService 落地前的门禁）。
 *
 * 验证 playwright-core 能按 src/main/browser/BrowserHost.ts 的形态驱动一个
 * 外部系统 Chrome（playwright-core 不下载浏览器）：
 *  1. 系统 Chrome 解析（CS_CHROME_PATH 覆盖 → 各平台常见安装路径）
 *  2. spawn 外部 Chrome：独立临时 user-data-dir + 自由调试端口 +
 *     --remote-allow-origins=* --no-first-run --no-default-browser-check about:blank
 *  3. /json/version 就绪轮询（30s 截止 / 250ms 间隔）
 *  4. chromium.connectOverCDP + 默认上下文取页/建页 + setViewportSize(1280x800)
 *  5. 七工具原语演练（对齐 policy.BROWSER_TOOLS）：
 *     navigate_page / click / fill / scroll_page(mouse.wheel) /
 *     take_screenshot(jpeg q50，报字节数，断言 0<size<600KB) /
 *     evaluate_script(document.title) / list_pages(>=1)
 *  6. profile 隔离断言：临时 user-data-dir 被填充（非空）；默认 profile 不碰（仅记录路径）
 *  7. CDP 断连语义：browser.close() 不杀外部 Chrome（实测记录）；随后一律树杀清理
 *
 * 用法：node scripts/probe-browser-cdp.mjs
 *
 * 注：只读探测/不写用户配置 —— 临时 profile 建在 %TEMP%（mkdtemp），
 *     用户日常 Chrome 数据目录全程不碰；任一项 FAIL 退出码 1。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const log = (...a) => console.log('[probe]', ...a);
const section = (t) => console.log(`\n========== ${t} ==========`);

const results = []; // {name, ok, detail}
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- 1. Chrome 解析
section('1. 系统 Chrome 解析');
function resolveChromePath() {
  const env = process.env.CS_CHROME_PATH;
  const list = env ? [env] : [];
  if (process.platform === 'win32') {
    for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (root) list.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    for (const root of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (root) list.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  for (const p of list) if (existsSync(p)) return p;
  return undefined;
}
const CHROME = resolveChromePath();
if (!CHROME) {
  console.error('[probe] FAIL: 未找到系统 Chrome/Edge。设 CS_CHROME_PATH 指向浏览器可执行文件。');
  process.exit(1);
}
log('chrome =', CHROME);

// ---------------------------------------------------------------- 2. spawn 外部 Chrome
section('2. spawn 外部 Chrome（独立临时 profile + 自由端口）');
const profileDir = mkdtempSync(join(tmpdir(), 'probe-cdp-profile-'));
log('临时 user-data-dir =', profileDir);

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}
const port = await findFreePort();
log('remote-debugging-port =', port);

const child = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }, // windowsHide 默认 false（受管浏览器必须可见，同 BrowserHost）
);
let stderrTail = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => {
  stderrTail = (stderrTail + d).slice(-2000);
});
let chromeExited = false;
child.once('exit', (code) => {
  chromeExited = true;
  log('chrome 进程退出 code =', code);
});
check('spawn chrome', !!child.pid, `pid=${child.pid}`);

async function killTree() {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill();
    }
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 500));
}

// ---------------------------------------------------------------- 3. 就绪轮询
section('3. /json/version 就绪轮询（30s/250ms）');
async function devtoolsAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}
{
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() <= deadline) {
    if (await devtoolsAlive()) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('devtools 端口就绪', ready, ready ? `port=${port}` : `30s 未就绪；stderr 尾: ${stderrTail.slice(-300)}`);
  if (!ready) {
    await killTree();
    printSummary();
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 4. connectOverCDP
section('4. playwright connectOverCDP + 页面/视口');
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  check('connectOverCDP', browser.isConnected(), 'connected');
} catch (e) {
  check('connectOverCDP', false, String(e?.message ?? e).slice(0, 300));
  await killTree();
  printSummary();
  process.exit(1);
}
const context = browser.contexts()[0];
const page = context.pages().find((p) => !p.isClosed()) ?? (await context.newPage());
await page.setViewportSize({ width: 1280, height: 800 });
log('默认上下文页数 =', context.pages().length, '；视口已设 1280x800');

// ---------------------------------------------------------------- 5. 七工具原语
section('5. 七工具原语演练');
const HTML =
  '<title>probe-page</title><h1>probe</h1>' +
  '<input id=pwd type=password>' +
  '<button id=b onclick="window.__clicked=(window.__clicked||0)+1">ok</button>' +
  '<div style="height:2000px">tall</div><footer>end</footer>';

// 5.1 navigate_page
try {
  await page.goto(`data:text/html,${encodeURIComponent(HTML)}`);
  const h1 = await page.evaluate(() => document.querySelector('h1')?.textContent);
  check('navigate_page', h1 === 'probe', `h1=${h1}`);
} catch (e) {
  check('navigate_page', false, String(e?.message ?? e).slice(0, 200));
}

// 5.2 click
try {
  await page.click('#b');
  const n = await page.evaluate(() => window.__clicked ?? 0);
  check('click', n === 1, `onclick 计数=${n}`);
} catch (e) {
  check('click', false, String(e?.message ?? e).slice(0, 200));
}

// 5.3 fill（password 字段，对齐敏感字段场景）
try {
  await page.fill('#pwd', 'probe-secret');
  const v = await page.evaluate(() => document.getElementById('pwd')?.value);
  check('fill', v === 'probe-secret', `pwd.value 长度=${String(v).length}`);
} catch (e) {
  check('fill', false, String(e?.message ?? e).slice(0, 200));
}

// 5.4 scroll_page（mouse.wheel）
try {
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(200);
  const y = await page.evaluate(() => window.scrollY);
  check('scroll_page', y > 0, `scrollY=${y}`);
} catch (e) {
  check('scroll_page', false, String(e?.message ?? e).slice(0, 200));
}

// 5.5 take_screenshot（jpeg q50；预算 <600KB，对齐 policy.BUDGET）
try {
  const buf = await page.screenshot({ type: 'jpeg', quality: 50 });
  const kb = (buf.length / 1024).toFixed(1);
  check('take_screenshot', buf.length > 0 && buf.length < 600 * 1024, `jpeg=${buf.length}B (${kb}KB)`);
} catch (e) {
  check('take_screenshot', false, String(e?.message ?? e).slice(0, 200));
}

// 5.6 evaluate_script
try {
  const title = await page.evaluate(() => document.title);
  check('evaluate_script', title === 'probe-page', `document.title=${title}`);
} catch (e) {
  check('evaluate_script', false, String(e?.message ?? e).slice(0, 200));
}

// 5.7 list_pages
try {
  const pages = context.pages().filter((p) => !p.isClosed());
  log('  页面清单:', pages.map((p) => p.url().slice(0, 60)).join(' | '));
  check('list_pages', pages.length >= 1, `pages=${pages.length}`);
} catch (e) {
  check('list_pages', false, String(e?.message ?? e).slice(0, 200));
}

// ---------------------------------------------------------------- 6. profile 隔离
section('6. profile 隔离断言');
{
  let populated = false;
  try {
    populated = readdirSync(profileDir).length > 0;
  } catch {
    /* ignore */
  }
  check(
    '临时 user-data-dir 被填充',
    populated,
    `${profileDir} 顶层条目=${populated ? readdirSync(profileDir).length : 0}`,
  );
  log('默认 Chrome profile：全程未触碰（本探针只使用上述临时目录，不读取/不写入用户数据目录）');
}

// ---------------------------------------------------------------- 7. CDP 断连语义 + 清理
section('7. browser.close() 断连语义（不杀外部 Chrome）');
await browser.close().catch(() => undefined);
await new Promise((r) => setTimeout(r, 500));
{
  const alive = (await devtoolsAlive()) && !chromeExited;
  log(`browser.close() 后外部 Chrome 存活 = ${alive}（CDP 连接语义：close 只断开客户端）`);
  check('CDP close 不杀外部 Chrome', alive, alive ? 'chrome 仍在运行（符合预期）' : 'chrome 已退出（与预期不符）');
}
log('树杀 spawn 的 chrome 进程树…');
await killTree();
{
  const alive = await devtoolsAlive();
  log('taskkill 后 devtools 端口存活 =', alive);
}

// ---------------------------------------------------------------- 汇总
printSummary();
process.exit(results.every((r) => r.ok) ? 0 : 1);

function printSummary() {
  section('PASS/FAIL 汇总');
  for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const fails = results.filter((r) => !r.ok).length;
  log(`合计 ${results.length} 项，FAIL ${fails} 项 → ${fails ? 'P1 未过' : 'P1 全过'}`);
}
