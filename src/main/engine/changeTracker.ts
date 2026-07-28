/**
 * ChangeTracker — per-session file-edit ledger with revert ("保命回退")，
 * 底层用影子 git 快照（ShadowGit，对标 opencode）。
 *
 * 每会话在**首个回合开始（AI 尚未动手）**拍一张影子快照（tree hash）作基线
 * —— 含用户未提交手改，race-free。之后：
 *   - 变更清单 = 该会话 touched 的文件 ∩「自基线以来有差异」的文件；
 *   - 回退 = `git checkout <baselineHash> -- <file>`（还原到编辑前，或删新建）；
 *   - diff = 快照里的内容 vs 当前磁盘。
 * 只持久化 { baselineHash, touched[] }（轻量，非全文）；跨重启仍可回退。
 * 多会话：各持自己的不可变基线 hash，回退互不打架（+ N会话徽标/二次确认）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { app } from 'electron';

import type { SessionChangeDiff, SessionChangeEntry } from '@shared/ipc';
import { ShadowGit } from './shadowGit';

interface SessionState {
  /** 基线快照 tree hash（首个回合开始时拍；null = 尚未拍到）。 */
  baselineHash: string | null;
  /** 本会话编辑过的绝对路径（供变更清单过滤到「本对话」范围）。 */
  touched: Set<string>;
}

export class ChangeTracker {
  private readonly shadow = new ShadowGit();
  private readonly sessions = new Map<string, SessionState>();
  private readonly loaded = new Set<string>();
  private readonly dir = join(app.getPath('userData'), 'changes');

  /** 回合开始（AI 未动手）：首个回合为该会话拍基线快照。 */
  async onTurnStart(sessionId: string, root: string): Promise<void> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    if (s.baselineHash) return; // 已有基线（本会话已拍过）
    const hash = await this.shadow.snapshot(root);
    if (hash) {
      s.baselineHash = hash;
      this.persist(sessionId);
    }
  }

  /** 标记本会话编辑过某文件（fileChange 事件驱动）。 */
  noteEdit(sessionId: string, rawPath: string, root: string): void {
    this.ensureLoaded(sessionId);
    const abs = isAbsolute(rawPath) ? rawPath : join(root, rawPath);
    const s = this.state(sessionId);
    if (!s.touched.has(abs)) {
      s.touched.add(abs);
      this.persist(sessionId);
    }
  }

  /** 回合结束扫尾：shell/命令改动无 fileChange 事件 → 用快照 diff 补全 touched。 */
  async scanTurnEnd(sessionId: string, root: string): Promise<void> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    if (!s.baselineHash) return;
    const stat = await this.shadow.diffStat(root, s.baselineHash);
    let added = false;
    for (const rel of stat.keys()) {
      const abs = join(root, rel);
      if (!s.touched.has(abs)) {
        s.touched.add(abs);
        added = true;
      }
    }
    if (added) this.persist(sessionId);
  }

  /** 本会话 AI 编辑过、且与基线有差异的文件清单。 */
  async list(sessionId: string, root: string): Promise<SessionChangeEntry[]> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    if (!s.baselineHash || s.touched.size === 0) return [];
    const stat = await this.shadow.diffStat(root, s.baselineHash);
    const out: SessionChangeEntry[] = [];
    for (const abs of s.touched) {
      const rel = relative(root, abs).split('\\').join('/');
      const st = stat.get(rel);
      if (!st) continue; // 无差异（已回退 / 与基线一致）
      out.push({ path: abs, name: basename(abs), adds: st.adds, dels: st.dels, status: st.status, sessions: this.sessionCount(abs) });
    }
    return out;
  }

  /** 单文件的 before(快照)/after(磁盘)，供 diff 视图。 */
  async diff(sessionId: string, root: string, abs: string): Promise<SessionChangeDiff> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    const before = s.baselineHash ? await this.shadow.show(root, s.baselineHash, abs) : null;
    const after = existsSync(abs) ? safeRead(abs) : null;
    return { path: abs, before, after };
  }

  /** 回退到基线（写回快照内容 / 删新建）；path 省略 = 全部。 */
  async revert(sessionId: string, root: string, path?: string): Promise<void> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    if (!s.baselineHash) return;
    const targets = path ? [path] : [...s.touched];
    for (const abs of targets) {
      await this.shadow.revertFile(root, s.baselineHash, abs);
      s.touched.delete(abs);
    }
    this.persist(sessionId);
  }

  /** 接受（保留改动、停止跟踪，不动磁盘）；path 省略 = 全部。 */
  accept(sessionId: string, path?: string): void {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    if (path) s.touched.delete(path);
    else s.touched.clear();
    this.persist(sessionId);
  }

  /** 会话删除时清理（内存 + 磁盘台账）。 */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.loaded.delete(sessionId);
    try {
      rmSync(this.file(sessionId), { force: true });
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- internals

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { baselineHash: null, touched: new Set() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** 当前内存中有多少个会话编辑过该文件（>1 = 多会话共编）。 */
  private sessionCount(abs: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.touched.has(abs)) n++;
    return n;
  }

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  private ensureLoaded(sessionId: string): void {
    if (this.loaded.has(sessionId)) return;
    this.loaded.add(sessionId);
    try {
      const f = this.file(sessionId);
      if (!existsSync(f)) return;
      const raw = JSON.parse(readFileSync(f, 'utf8')) as { baselineHash?: unknown; touched?: unknown };
      if (raw && typeof raw === 'object' && Array.isArray(raw.touched)) {
        this.sessions.set(sessionId, {
          baselineHash: typeof raw.baselineHash === 'string' ? raw.baselineHash : null,
          touched: new Set(raw.touched.filter((x): x is string => typeof x === 'string')),
        });
      }
    } catch {
      /* 台账损坏 = 视作无记录，不阻断 */
    }
  }

  private persist(sessionId: string): void {
    try {
      const s = this.sessions.get(sessionId);
      if (!s || (!s.baselineHash && s.touched.size === 0)) {
        rmSync(this.file(sessionId), { force: true });
        return;
      }
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file(sessionId), JSON.stringify({ baselineHash: s.baselineHash, touched: [...s.touched] }), 'utf8');
    } catch {
      /* best effort */
    }
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
