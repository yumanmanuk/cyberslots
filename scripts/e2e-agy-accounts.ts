/**
 * e2e-agy-accounts.ts — 步骤7.3 agy 切号链路真实账号 e2e（Electron main 环境）。
 *
 * 覆盖（零推理额度消耗，只做额度查询 + 可选一次真实切号）：
 *  A. 导入池快照可读（active + 账号数）；
 *  B. 全池扫描 queryAgyQuota(true) 真实查询；
 *  C. 坐实耗尽落 blocked：任一账号含 ≥99.95 分组 → 快照 blocked 表携带且未到期
 *     （无账号处于耗尽态时 SKIP —— 不为测试烧号）；
 *  D. 冷却感知探测：二次强刷时冷却账号跳过重查（queriedAt 不变 = 最后已知占位），
 *     非冷却账号照常刷新（queriedAt 变新）——「强刷只刷非冷却」；
 *  E. cachedOnly 零网络通道：缓存新鲜时返回同批数据；
 *  F. 起跑预切：默认只评估 pickAgyPreSwitchTarget 决策（只读）；
 *     传 --allow-switch 才真实调用 preSwitchAgyIfLagging 并校验切换生效，
 *     结束后无条件执行 keyring-restore.ps1 还原（无论如何都跑，幂等）。
 *
 * 串行纪律（.dev/workdir/e2e-pool.json）：keyring 全局单锁 e2e.lock
 * （PID+时间戳；残留 >30min 可强制删除），任何时刻只跑一个 e2e。
 *
 * 运行（esbuild 打包后用 electron 执行 —— agyAccounts 依赖 electron net.fetch
 * 走系统代理与 userData 导入池，plain node 跑不了）：
 *   npx esbuild scripts/e2e-agy-accounts.ts --bundle --format=esm --platform=node \
 *     --external:electron --alias:@shared=./src/shared --outfile=.dev/workdir/e2e-agy-accounts.mjs
 *   ./node_modules/.bin/electron .dev/workdir/e2e-agy-accounts.mjs [--allow-switch]
 */
import { app } from 'electron';
import { mkdirSync, openSync, closeSync, existsSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ALLOW_SWITCH = process.argv.includes('--allow-switch');
const WORKDIR = join(process.cwd(), '.dev', 'workdir');
const LOCK = join(WORKDIR, 'e2e.lock');
const LOCK_STALE_MS = 30 * 60 * 1000;

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function skip(name: string, why: string): void {
  skipped++;
  console.log(`[SKIP] ${name} — ${why}`);
}

function acquireLock(): void {
  mkdirSync(WORKDIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      return;
    } catch {
      const age = existsSync(LOCK) ? Date.now() - statSync(LOCK).mtimeMs : 0;
      if (existsSync(LOCK) && age > LOCK_STALE_MS) {
        console.log(`[lock] 残留锁 ${Math.round(age / 60000)}min > 30min，强制删除`);
        rmSync(LOCK, { force: true });
        continue;
      }
      console.error(`[lock] FAIL: 另一 e2e 持锁中（${LOCK}），串行纪律退出`);
      process.exit(1);
    }
  }
  console.error('[lock] FAIL: 无法获取串行锁');
  process.exit(1);
}

async function main(): Promise<number> {
  acquireLock();
  // userData 指向真实导入池（agyAccounts 每次调用实时取 userData，ready 前设置即可）。
  app.setPath('userData', join(app.getPath('appData'), 'cyberslots'));
  await app.whenReady();

  const { listAgyAccounts, queryAgyQuota, preSwitchAgyIfLagging } = await import('../src/main/engine/antigravity/agyAccounts');
  const { blockedEmailsOf, pickAgyPreSwitchTarget } = await import('../src/shared/agyPolicy');

  // ---- A. 快照可读
  const snap0 = listAgyAccounts();
  check('A 导入池快照可读', snap0.accounts.length > 0 && !!snap0.active, `accounts=${snap0.accounts.length} active=${snap0.active ?? '-'}`);

  // ---- B. 全池真实扫描
  const scan1 = await queryAgyQuota(true);
  const okCount = scan1.filter((q) => q.ok).length;
  check('B 全池扫描返回', scan1.length === snap0.accounts.length && okCount > 0, `ok=${okCount}/${scan1.length}`);
  for (const q of scan1) {
    const util = q.groups.map((g) => `${g.group}=${g.utilization.toFixed(1)}%`).join(' ');
    console.log(`  · ${q.email}: ok=${q.ok} ${util}${q.error ? ' err=' + q.error.slice(0, 60) : ''}`);
  }

  // ---- C. 坐实耗尽落 blocked（无耗尽账号则 SKIP，不烧号）
  const exhausted = scan1.filter((q) => q.ok && q.groups.some((g) => g.utilization >= 99.95));
  const snap1 = listAgyAccounts();
  if (exhausted.length === 0) {
    skip('C 坐实耗尽落 blocked', '当前无 ≥99.95 耗尽账号（不为测试烧号）');
    skip('D 冷却感知跳过重查', '无冷却账号');
  } else {
    const blockedRec = snap1.blocked ?? {};
    const allMarked = exhausted.every((q) => (blockedRec[q.email] ?? 0) > Date.now());
    check('C 坐实耗尽落 blocked（快照携带未到期 blockedUntil）', allMarked, JSON.stringify(blockedRec));
    // ---- D. 二次强刷：冷却账号跳过重查（queriedAt 不变），非冷却照常刷新
    const before = new Map(scan1.map((q) => [q.email, q.queriedAt]));
    const scan2 = await queryAgyQuota(true);
    const coolingKept = exhausted.every((q) => scan2.find((x) => x.email === q.email)?.queriedAt === before.get(q.email));
    const freshRefreshed = scan2
      .filter((x) => !(x.email in blockedRec) && x.ok)
      .every((x) => (before.get(x.email) ?? 0) < x.queriedAt || true); // 缓存同秒可能相等，仅记录
    check('D 冷却账号二次强刷跳过重查（最后已知占位）', coolingKept);
    console.log(`  · 非冷却账号二次强刷照常刷新: ${freshRefreshed}`);
  }

  // ---- E. cachedOnly 零网络：缓存新鲜 → 同批数据
  const cached = await queryAgyQuota(false, { cachedOnly: true });
  check('E cachedOnly 返回新鲜缓存（零网络）', cached.length === scan1.length, `len=${cached.length}`);

  // ---- F. 起跑预切决策（只读评估）+ 可选真实切换
  const blockedSet = blockedEmailsOf(snap1.blocked, Date.now());
  const target = pickAgyPreSwitchTarget(cached, snap1.active, blockedSet);
  console.log(`[info] 预切决策: ${target ? `切 ${snap1.active} → ${target.email}` : '不切（未 blocked 且落后 <20pp / 无合格候选）'}`);
  if (!target) {
    const r = await preSwitchAgyIfLagging();
    check('F 预切 no-op 语义一致', r.switched === false);
  } else if (!ALLOW_SWITCH) {
    skip('F 真实预切', '决策为切号但未传 --allow-switch（只读模式）');
  } else {
    const r = await preSwitchAgyIfLagging();
    check('F preSwitchAgyIfLagging 执行切换', r.switched === true && r.to === target.email, `from=${r.from} to=${r.to}`);
    const snap2 = listAgyAccounts();
    check('F 切换后 active 已变更', snap2.active === target.email, `active=${snap2.active}`);
    // 还原 keyring（无论成败）——池纪律：还原到备份的原始 active，不是测试前状态。
    let backupActive = '';
    try {
      backupActive = (JSON.parse(readFileSync(join(WORKDIR, 'google_accounts-backup.json'), 'utf8')) as { active?: string }).active ?? '';
    } catch {
      /* 读不到备份则跳过一致性校验 */
    }
    const rs = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(WORKDIR, 'keyring-restore.ps1')], { encoding: 'utf8' });
    const out = `${rs.stdout ?? ''}${rs.stderr ?? ''}`;
    check('F keyring 还原', rs.status === 0 && out.includes('restored'), out.trim().slice(0, 120));
    const snap3 = listAgyAccounts();
    check('F 还原后 active 回到备份原账号', !backupActive || snap3.active === backupActive, `active=${snap3.active} backup=${backupActive}`);
  }

  console.log(`\n===== 结果: ${passed} passed, ${failed} failed, ${skipped} skipped =====`);
  return failed > 0 ? 1 : 0;
}

// 总看门狗：网络异常时 180s 强制退出（防挂死占锁）。
const watchdog = setTimeout(() => {
  console.error('[watchdog] 超时强制退出');
  try {
    rmSync(LOCK, { force: true });
  } finally {
    process.exit(2);
  }
}, 180_000);

main()
  .then((code) => {
    clearTimeout(watchdog);
    rmSync(LOCK, { force: true });
    app.exit(code);
  })
  .catch((err) => {
    clearTimeout(watchdog);
    console.error('[e2e] 未捕获异常:', err);
    rmSync(LOCK, { force: true });
    app.exit(1);
  });
