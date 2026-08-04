/**
 * ChangeTracker — per-session file-edit ledger with revert ("保命回退")，
 * 底层用影子 git 快照（ShadowGit，对标 opencode）。
 *
 * 每会话在**首个回合开始（AI 尚未动手）**拍一张影子快照（tree hash）作基线
 * —— 含用户未提交手改，race-free。之后：
 *   - 变更清单 = 该会话 touched 的文件 ∩「自基线以来有差异」的文件；
 *   - 回退 = `git checkout <baselineHash> -- <file>`（还原到编辑前，或删新建）；
 *   - diff = 快照里的内容 vs 当前磁盘。
 * 只持久化 { baselineHash, touched[], accepted[], marks[] }（轻量，非全文）；跨重启仍可回退。
 * 多会话：各持自己的不可变基线 hash，回退互不打架（+ N会话徽标/二次确认）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { app } from 'electron';

import type { SessionChangeDiff, SessionChangeEntry } from '@shared/ipc';
import { log } from '../log/logger';
import { ShadowGit } from './shadowGit';

interface SessionState {
  /** 基线快照 tree hash（首个回合开始时拍；null = 尚未拍到）。 */
  baselineHash: string | null;
  /** 本会话编辑过的绝对路径（供变更清单过滤到「本对话」范围）。 */
  touched: Set<string>;
  /** 已接受文件快照（保留改动并展示为已接受，直到再次被编辑/回退）。 */
  accepted: Map<string, AcceptedChange>;
  /** 逐提问快照（发送前拍）——「回退到某个提问」的还原点。 */
  marks: PromptMark[];
}

interface PromptMark {
  /** 用户消息 id（renderer 侧 UnifiedMessage.id）。 */
  messageId: string;
  /** 该提问发送前的影子快照 tree hash。 */
  hash: string;
  ts: number;
}

interface AcceptedChange {
  /** 已接受文件绝对路径。 */
  path: string;
  /** 接受时的文件名（路径变化不影响列表展示）。 */
  name: string;
  /** 接受时的原始变更类型。 */
  status: 'modified' | 'added' | 'deleted';
  adds: number;
  dels: number;
  ts: number;
}

/** marks 滚动上限 — 超出丢最旧（快照对象本身在影子仓库里，无需清理）。 */
const MAX_MARKS = 100;

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
    for (const [rel, st] of stat) {
      const abs = join(root, rel);
      const acc = s.accepted.get(abs);
      // 已接受且统计未变化 = 仍是同一份已接受改动，不要重新变成待接受。
      if (acc && acc.status === st.status && acc.adds === st.adds && acc.dels === st.dels) continue;
      if (!s.touched.has(abs)) {
        s.touched.add(abs);
        added = true;
      }
    }
    if (added) this.persist(sessionId);
  }

  /** 本会话 AI 编辑过、且与基线有差异的文件清单（已接受文件也保留展示）。 */
  async list(sessionId: string, root: string): Promise<SessionChangeEntry[]> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    if (!s.baselineHash || (s.touched.size === 0 && s.accepted.size === 0)) return [];
    const stat = await this.shadow.diffStat(root, s.baselineHash);
    const out: SessionChangeEntry[] = [];
    for (const abs of s.touched) {
      const rel = relative(root, abs).split('\\').join('/');
      const st = stat.get(rel);
      if (!st) continue; // 无差异（已回退 / 与基线一致）
      out.push({ path: abs, name: basename(abs), adds: st.adds, dels: st.dels, status: st.status, sessions: this.sessionCount(abs) });
    }
    for (const acc of s.accepted.values()) {
      if (s.touched.has(acc.path)) continue; // 再次被编辑后以待接受状态优先
      out.push({ path: acc.path, name: acc.name, adds: acc.adds, dels: acc.dels, status: 'accepted', sessions: this.sessionCount(acc.path) });
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
      s.accepted.delete(abs);
    }
    this.persist(sessionId);
  }

  /** 提问发送前拍快照 — 记录「回退到此提问」的还原点（AI 未动手，race-free）。 */
  async markPrompt(sessionId: string, root: string, messageId: string): Promise<void> {
    this.ensureLoaded(sessionId);
    const hash = await this.shadow.snapshot(root);
    if (!hash) return;
    const s = this.state(sessionId);
    s.marks.push({ messageId, hash, ts: Date.now() });
    if (s.marks.length > MAX_MARKS) s.marks.splice(0, s.marks.length - MAX_MARKS);
    this.persist(sessionId);
  }

  /** 回退到该提问将撤销的文件清单（快照 vs 当前磁盘）；null = 无快照（旧消息/cron）。 */
  async undoPreview(sessionId: string, root: string, messageId: string): Promise<SessionChangeEntry[] | null> {
    this.ensureLoaded(sessionId);
    const mark = this.state(sessionId).marks.find((m) => m.messageId === messageId);
    if (!mark) return null;
    const stat = await this.shadow.diffStat(root, mark.hash);
    const out: SessionChangeEntry[] = [];
    for (const [rel, st] of stat) {
      const abs = join(root, rel);
      out.push({ path: abs, name: basename(abs), adds: st.adds, dels: st.dels, status: st.status, sessions: this.sessionCount(abs) });
    }
    return out;
  }

  /** 执行回退：把与快照有差异的文件全部还原（不在快照 = 删除），并丢弃该时点及之后的 marks。 */
  async undoRevert(sessionId: string, root: string, messageId: string): Promise<void> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    const mark = s.marks.find((m) => m.messageId === messageId);
    if (!mark) return;
    const stat = await this.shadow.diffStat(root, mark.hash);
    for (const rel of stat.keys()) {
      await this.shadow.revertFile(root, mark.hash, join(root, rel));
    }
    // 该提问及其后的消息已被移除 — 对应还原点一并作废。
    // 回退到历史提问后，已接受标记不再对应当前文件状态，全部清空。
    s.accepted.clear();
    s.marks = s.marks.filter((m) => m.ts < mark.ts);
    this.persist(sessionId);
  }

  /** 接受（保留改动、标记已接受，不动磁盘）；path 省略 = 全部。 */
  async accept(sessionId: string, root: string, path?: string): Promise<void> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    if (!s.baselineHash) return;
    const stat = await this.shadow.diffStat(root, s.baselineHash);
    const targets = path ? [path] : [...s.touched];
    for (const abs of targets) {
      if (!s.touched.has(abs)) continue;
      const rel = relative(root, abs).split('\\').join('/');
      const st = stat.get(rel);
      s.touched.delete(abs);
      if (!st) continue; // 已回退/与基线一致，不生成已接受记录
      s.accepted.set(abs, { path: abs, name: basename(abs), status: st.status, adds: st.adds, dels: st.dels, ts: Date.now() });
    }
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
      s = { baselineHash: null, touched: new Set(), accepted: new Map(), marks: [] };
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
      const raw = JSON.parse(readFileSync(f, 'utf8')) as {
        baselineHash?: unknown;
        touched?: unknown;
        accepted?: unknown;
        marks?: unknown;
      };
      if (raw && typeof raw === 'object' && Array.isArray(raw.touched)) {
        const marks = Array.isArray(raw.marks)
          ? raw.marks.filter(
              (m): m is PromptMark =>
                !!m && typeof m === 'object' && typeof (m as PromptMark).messageId === 'string' && typeof (m as PromptMark).hash === 'string' && typeof (m as PromptMark).ts === 'number',
            )
          : [];
        const accepted = new Map<string, AcceptedChange>();
        if (raw.accepted && typeof raw.accepted === 'object' && !Array.isArray(raw.accepted)) {
          for (const [path, value] of Object.entries(raw.accepted as Record<string, unknown>)) {
            const a = value as Partial<AcceptedChange> | null;
            if (
              a &&
              typeof a === 'object' &&
              typeof a.path === 'string' &&
              typeof a.name === 'string' &&
              (a.status === 'modified' || a.status === 'added' || a.status === 'deleted') &&
              typeof a.adds === 'number' &&
              typeof a.dels === 'number'
            ) {
              accepted.set(path, a as AcceptedChange);
            }
          }
        }
        this.sessions.set(sessionId, {
          baselineHash: typeof raw.baselineHash === 'string' ? raw.baselineHash : null,
          touched: new Set(raw.touched.filter((x): x is string => typeof x === 'string')),
          accepted,
          marks,
        });
      }
    } catch (err) {
      // 台账损坏 = 视作无记录，不阻断；但留痕（变更面板莫名变空时可溯源）。
      log.warn('changes', 'change ledger corrupted, treating as empty', { sessionId }, err);
    }
  }

  private persist(sessionId: string): void {
    try {
      const s = this.sessions.get(sessionId);
      if (!s || (!s.baselineHash && s.touched.size === 0 && s.accepted.size === 0 && s.marks.length === 0)) {
        rmSync(this.file(sessionId), { force: true });
        return;
      }
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file(sessionId), JSON.stringify({ baselineHash: s.baselineHash, touched: [...s.touched], accepted: Object.fromEntries(s.accepted), marks: s.marks }), 'utf8');
    } catch (err) {
      log.error('changes', 'change ledger persist failed', { sessionId }, err);
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
