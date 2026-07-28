/**
 * ChangeTracker — per-session file-edit ledger with revert ("保命回退").
 *
 * 引擎（codex/kimi/opencode）直接落盘，客户端只在事件里得知「某文件被编辑」。
 * 为支持回退，参考 claude-code 的 fileHistory（快照「编辑前」内容再还原）：
 * 因本进程是外部观察者、不掌控引擎写盘，无法可靠地「写前一刻」抓快照，
 * 故采用两路 race-free 基线——
 *   1) 回合开始（AI 尚未动手）快照所有「已跟踪且未提交」文件的当前内容
 *      （snapshotDirtyFiles）：保留用户未提交改动；
 *   2) 首次编辑某文件时取其 git HEAD 内容（clean 文件 HEAD == 编辑前）；
 *      git 内新建 → null（回退即删）；非 git → 尽力读盘。
 * 于是回退把文件还原到「AI 首次编辑前」的状态，只撤 AI 改动、留用户手改。
 * 回退 = 把基线写回磁盘（或删除）；接受 = 停止跟踪（不动磁盘）。
 *
 * 基线台账按会话持久化到 userData/changes/<id>.json（同 claude-code 的
 * 快照 resume 支持）——app 崩溃/重启后仍可回退，这是「保命」的关键。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, basename } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';

import type { SessionChangeDiff, SessionChangeEntry } from '@shared/ipc';

const execFileAsync = promisify(execFile);

/** null = 该文件在本会话编辑前不存在（回退即删除）。 */
interface Baseline {
  content: string | null;
}

export class ChangeTracker {
  /** sessionId → (绝对路径 → 基线)。 */
  private readonly baselines = new Map<string, Map<string, Baseline>>();
  /** 已从磁盘台账加载过的会话（懒加载一次）。 */
  private readonly loaded = new Set<string>();
  /** 回合开始时已存在的未跟踪文件（不归 AI；扫尾时用于区分 AI 新建）。 */
  private readonly preUntracked = new Map<string, Set<string>>();
  /** root → 是否 git 工作区（缓存，避免每次 spawn）。 */
  private readonly gitRepoCache = new Map<string, boolean>();
  private readonly dir = join(app.getPath('userData'), 'changes');

  /** 首次编辑某路径时捕获「编辑前」基线（幂等）。已跟踪文件取 git HEAD
   *  （race-free；clean 文件的 HEAD == 编辑前）；git 新建 → null（回退即删）；
   *  非 git → 尽力读盘。用户未提交改动由 snapshotDirtyFiles 在回合开始时
   *  提前锁定，故此处即便晚于写盘也不会误用被 AI 改过的内容。 */
  async noteEdit(sessionId: string, rawPath: string, root: string): Promise<void> {
    this.ensureLoaded(sessionId);
    const abs = isAbsolute(rawPath) ? rawPath : join(root, rawPath);
    let m = this.baselines.get(sessionId);
    if (m?.has(abs)) return;
    if (!m) {
      m = new Map();
      this.baselines.set(sessionId, m);
    }
    m.set(abs, { content: null }); // 占位防并发重复捕获
    const r = await this.gitHead(abs, root).catch(() => ({ kind: 'nongit' as const }));
    const slot = this.baselines.get(sessionId)?.get(abs);
    if (slot) {
      if (r.kind === 'head') slot.content = r.content;
      else if (r.kind === 'new') slot.content = null;
      else slot.content = existsSync(abs) ? safeRead(abs) : null; // 非 git：尽力（racy）
    }
    this.persist(sessionId);
  }

  /** 回合开始时（AI 尚未动手）快照所有「已跟踪且未提交」文件内容，
   *  作其编辑前基线——保留用户未提交改动，回退只撤 AI 的部分（claude-code
   *  同款）。race-free：turn.started 到首个编辑事件间隔足够（模型生成）。 */
  async snapshotDirtyFiles(sessionId: string, root: string): Promise<void> {
    this.ensureLoaded(sessionId);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('git', ['status', '--porcelain', '-z', '-uall'], {
        cwd: root,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }));
    } catch {
      return; // 非 git
    }
    let m = this.baselines.get(sessionId);
    let changed = false;
    const untracked = new Set<string>();
    for (const entry of stdout.split('\0')) {
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const rel = entry.slice(3);
      if (!rel) continue;
      const abs = join(root, rel);
      if (code.includes('?')) {
        untracked.add(abs); // 回合前就存在的未跟踪文件 — 不归 AI
        continue;
      }
      if (!code.includes('M') && !code.includes('A')) continue; // 只快照被修改/暂存
      if (m?.has(abs)) continue;
      if (!m) {
        m = new Map();
        this.baselines.set(sessionId, m);
      }
      m.set(abs, { content: existsSync(abs) ? safeRead(abs) : null });
      changed = true;
    }
    this.preUntracked.set(sessionId, untracked);
    if (changed) this.persist(sessionId);
  }

  /** 回合结束扫尾：shell 命令产生的文件改动没有 fileChange 事件（e2e
   *  实测：MiniMax 用 python -c 写文件，note.txt 漏登记）——用 git 再扫一次：
   *  新出现的 ?? 文件 = AI 创建（基线 null）；未登记却变脏的已跟踪文件
   *  （回合开始时 clean）= shell 改的（基线 = git HEAD 即编辑前）。 */
  async scanTurnEnd(sessionId: string, root: string): Promise<void> {
    this.ensureLoaded(sessionId);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('git', ['status', '--porcelain', '-z', '-uall'], {
        cwd: root,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }));
    } catch {
      return; // 非 git
    }
    const pre = this.preUntracked.get(sessionId) ?? new Set<string>();
    let m = this.baselines.get(sessionId);
    let changed = false;
    for (const entry of stdout.split('\0')) {
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const rel = entry.slice(3);
      if (!rel) continue;
      const abs = join(root, rel);
      if (m?.has(abs)) continue;
      if (!m) {
        m = new Map();
        this.baselines.set(sessionId, m);
      }
      if (code.includes('?')) {
        if (pre.has(abs)) continue; // 会话前就有的未跟踪文件，不动
        m.set(abs, { content: null }); // 本回合新出现 = AI 创建 → 回退即删
        changed = true;
        continue;
      }
      const r = await this.gitHead(abs, root).catch(() => ({ kind: 'nongit' as const }));
      if (r.kind === 'head') {
        m.set(abs, { content: r.content });
        changed = true;
      } else if (r.kind === 'new') {
        m.set(abs, { content: null });
        changed = true;
      }
    }
    if (changed) this.persist(sessionId);
  }

  /** 列出本会话尚未接受、且与基线有差异的文件。 */
  list(sessionId: string): SessionChangeEntry[] {
    this.ensureLoaded(sessionId);
    const m = this.baselines.get(sessionId);
    if (!m) return [];
    const out: SessionChangeEntry[] = [];
    for (const [abs, base] of m) {
      const cur = existsSync(abs) ? safeRead(abs) : null;
      if (base.content === cur) continue; // 无差异（含已回退 / 内容相同）
      const { adds, dels, status } = diffStat(base.content, cur);
      out.push({ path: abs, name: basename(abs), adds, dels, status });
    }
    return out;
  }

  /** 单个文件的 before/after，供 diff 视图。 */
  diff(sessionId: string, path: string): SessionChangeDiff {
    this.ensureLoaded(sessionId);
    const base = this.baselines.get(sessionId)?.get(path);
    return {
      path,
      before: base ? base.content : null,
      after: existsSync(path) ? safeRead(path) : null,
    };
  }

  /** 回退单个文件到基线（写回或删除）；path 省略 = 全部回退。 */
  revert(sessionId: string, path?: string): void {
    this.ensureLoaded(sessionId);
    const m = this.baselines.get(sessionId);
    if (!m) return;
    const targets = path ? [path] : [...m.keys()];
    for (const abs of targets) {
      const base = m.get(abs);
      if (!base) continue;
      try {
        if (base.content === null) {
          if (existsSync(abs)) rmSync(abs, { force: true });
        } else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, base.content, 'utf8');
        }
      } catch {
        /* best effort：单文件失败不影响其余 */
      }
      m.delete(abs);
    }
    this.persist(sessionId);
    if (m.size === 0) this.baselines.delete(sessionId);
  }

  /** 接受（保留改动、停止跟踪，不动磁盘）；path 省略 = 全部接受。 */
  accept(sessionId: string, path?: string): void {
    this.ensureLoaded(sessionId);
    const m = this.baselines.get(sessionId);
    if (!m) return;
    if (path) m.delete(path);
    else m.clear();
    this.persist(sessionId);
    if (m.size === 0) this.baselines.delete(sessionId);
  }

  /** 会话删除时清理（内存 + 磁盘台账）。 */
  clear(sessionId: string): void {
    this.baselines.delete(sessionId);
    this.loaded.delete(sessionId);
    try {
      rmSync(this.file(sessionId), { force: true });
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- persistence

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  /** 懒加载磁盘台账一次（跨重启恢复回退能力）。 */
  private ensureLoaded(sessionId: string): void {
    if (this.loaded.has(sessionId)) return;
    this.loaded.add(sessionId);
    try {
      const f = this.file(sessionId);
      if (!existsSync(f)) return;
      const raw = JSON.parse(readFileSync(f, 'utf8')) as Record<string, Baseline>;
      const m = this.baselines.get(sessionId) ?? new Map<string, Baseline>();
      for (const [abs, base] of Object.entries(raw)) if (!m.has(abs)) m.set(abs, base);
      if (m.size) this.baselines.set(sessionId, m);
    } catch {
      /* 台账损坏 = 视作无基线，不阻断 */
    }
  }

  private persist(sessionId: string): void {
    try {
      const m = this.baselines.get(sessionId);
      if (!m || m.size === 0) {
        rmSync(this.file(sessionId), { force: true });
        return;
      }
      mkdirSync(this.dir, { recursive: true });
      const obj: Record<string, Baseline> = {};
      for (const [abs, base] of m) obj[abs] = base;
      writeFileSync(this.file(sessionId), JSON.stringify(obj), 'utf8');
    } catch {
      /* best effort */
    }
  }

  // ------------------------------------------------------------- internals

  /** git HEAD 内容 / 'new'（git 内新建）/ 'nongit'（非 git 仓库）。 */
  private async gitHead(
    abs: string,
    root: string,
  ): Promise<{ kind: 'head'; content: string } | { kind: 'new' } | { kind: 'nongit' }> {
    if (!(await this.isGitRepo(root))) return { kind: 'nongit' };
    const rel = relative(root, abs).split('\\').join('/');
    try {
      const { stdout } = await execFileAsync('git', ['show', `HEAD:${rel}`], {
        cwd: root,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { kind: 'head', content: stdout };
    } catch {
      return { kind: 'new' }; // 不在 HEAD = 新建
    }
  }

  private async isGitRepo(root: string): Promise<boolean> {
    const cached = this.gitRepoCache.get(root);
    if (cached !== undefined) return cached;
    let ok = false;
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, windowsHide: true });
      ok = true;
    } catch {
      ok = false;
    }
    this.gitRepoCache.set(root, ok);
    return ok;
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function splitLines(s: string): string[] {
  return s.length ? s.split('\n') : [];
}

/** 行级增删统计 + 变更类型。大文件退化为多集近似，避免 O(n·m) 卡顿。 */
function diffStat(
  base: string | null,
  cur: string | null,
): { adds: number; dels: number; status: SessionChangeEntry['status'] } {
  if (base === null && cur !== null) return { adds: splitLines(cur).length, dels: 0, status: 'added' };
  if (base !== null && cur === null) return { adds: 0, dels: splitLines(base).length, status: 'deleted' };
  const a = splitLines(base ?? '');
  const b = splitLines(cur ?? '');
  const { adds, dels } = a.length > 4000 || b.length > 4000 ? approxDiff(a, b) : lcsDiff(a, b);
  return { adds, dels, status: 'modified' };
}

/** LCS 行差异（滚动数组，O(n·m) 时间、O(m) 空间）。 */
function lcsDiff(a: string[], b: string[]): { adds: number; dels: number } {
  const n = a.length;
  const m = b.length;
  if (n === 0) return { adds: m, dels: 0 };
  if (m === 0) return { adds: 0, dels: n };
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  const lcs = prev[m]!;
  return { adds: m - lcs, dels: n - lcs };
}

/** 多集近似：按行内容计数差，忽略顺序（仅用于超大文件的粗略计数）。 */
function approxDiff(a: string[], b: string[]): { adds: number; dels: number } {
  const count = new Map<string, number>();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  let adds = 0;
  for (const l of b) {
    const c = count.get(l) ?? 0;
    if (c > 0) count.set(l, c - 1);
    else adds++;
  }
  let dels = 0;
  for (const c of count.values()) dels += c;
  return { adds, dels };
}
