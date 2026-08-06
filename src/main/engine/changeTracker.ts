/**
 * ChangeTracker — per-session file-edit ledger with revert ("保命回退")，
 * 底层用影子 git 快照（ShadowGit，对标 opencode）。
 *
 * 每会话在**首个回合开始（AI 尚未动手）**拍一张影子快照（tree hash）作基线
 * —— 含用户未提交手改，race-free。之后：
 *   - 变更清单 = 该会话 touched 的文件 ∩「自基线以来有差异」的文件；
 *   - 回退 = `git checkout <baselineHash> -- <file>`（还原到编辑前，或删新建）；
 *   - diff = 快照里的内容 vs 当前磁盘。
 * 只持久化 { baselineHash, touched{}, accepted{}, marks[], lastUndoSafety? }
 * （轻量，非全文）；跨重启仍可回退。
 * 多会话：各持自己的不可变基线 hash，回退互不打架（+ N会话徽标/二次确认）。
 *
 * 「回退到某个提问」（undoPreview/undoRevert）的回退集 = diffStat(mark.hash)
 * ∩（touched ∪ accepted），口径与变更面板 list() 一致 —— 只还原本会话动过
 * 的文件；用户手改、构建/依赖副作用、共享 cwd 的其他会话写入一律不动（未
 * 归属变更数经 preview.unattributed 透出给用户）。
 * undoRevert 动手改盘前会先拍一张反悔快照（undo-the-undo）存入台账
 * lastUndoSafety（单槽覆盖）并写日志 —— 回退会丢弃 ts ≥ mark.ts 的 marks，
 * 被还原文件的「回退前内容」自此失去可查询引用，这张快照是误确认后的恢复
 * 能力。手动恢复路径（影子仓库内容寻址，hash 即全部文件全文）：
 *   git --git-dir "<userData>/shadow-git/<sha1(root)>" --work-tree "<root>" \
 *       checkout <lastUndoSafety.hash> -- <相对路径>
 * （hash 同时见日志 scope=changes 的「undo safety snapshot」行。）
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { app } from 'electron';

import type { SessionChangeDiff, SessionChangeEntry, UndoPreview } from '@shared/ipc';
import { log } from '../log/logger';
import { ShadowGit } from './shadowGit';
import type { FileStatus } from './shadowGit';

interface SessionState {
  /** 基线快照 tree hash（首个回合开始时拍；null = 尚未拍到）。 */
  baselineHash: string | null;
  /** 本会话编辑过的绝对路径 → 最后编辑 ts（供变更清单过滤到「本对话」范围）。
   *  undo 过滤只认 ts ≥ mark.ts 的文件；ts=0 = 旧格式台账载入，视为恒有效。 */
  touched: Map<string, number>;
  /** 已接受文件快照（保留改动并展示为已接受，直到再次被编辑/回退）。 */
  accepted: Map<string, AcceptedChange>;
  /** 逐提问快照（发送前拍）——「回退到某个提问」的还原点。 */
  marks: PromptMark[];
  /** 反悔快照（undoRevert 动手前的全 tree hash，单槽覆盖）——误确认手动恢复用。 */
  lastUndoSafety?: { hash: string; ts: number };
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

/** diffStat 的单条变更（相对 posix 路径 → 增删/类型）。 */
type DiffEntry = { adds: number; dels: number; status: FileStatus };

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

  /** 标记本会话编辑过某文件（fileChange 事件驱动）；重复编辑刷新最后编辑 ts。 */
  noteEdit(sessionId: string, rawPath: string, root: string): void {
    this.ensureLoaded(sessionId);
    const abs = isAbsolute(rawPath) ? rawPath : join(root, rawPath);
    const s = this.state(sessionId);
    const isNew = !s.touched.has(abs);
    s.touched.set(abs, Date.now());
    if (isNew) this.persist(sessionId);
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
        // 无事件改动的归因精度 = 回合时间窗：以发现时刻记入（undo 的 ts 过滤口径）。
        s.touched.set(abs, Date.now());
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
    for (const abs of s.touched.keys()) {
      const rel = normRel(root, abs);
      const st = stat.get(rel);
      if (!st) continue; // 无差异（已回退 / 与基线一致）
      out.push({ path: abs, name: basename(abs), adds: st.adds, dels: st.dels, status: st.status, sessions: this.sessionCount(root, abs) });
    }
    for (const acc of s.accepted.values()) {
      if (s.touched.has(acc.path)) continue; // 再次被编辑后以待接受状态优先
      out.push({ path: acc.path, name: acc.name, adds: acc.adds, dels: acc.dels, status: 'accepted', sessions: this.sessionCount(root, acc.path) });
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
    const targets = path ? [path] : [...s.touched.keys()];
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

  /** 丢弃某个提问的快照标记（steer 注入失败时清理孤儿标记，避免台账堆积）。 */
  async dropMark(sessionId: string, messageId: string): Promise<void> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    const before = s.marks.length;
    s.marks = s.marks.filter((m) => m.messageId !== messageId);
    if (s.marks.length !== before) this.persist(sessionId);
  }

  /** 回退到该提问将撤销的文件清单（仅本会话改动 ∩ 快照后差异）+ 未归属变更
   *  计数；null = 无快照（旧消息/cron）。 */
  async undoPreview(sessionId: string, root: string, messageId: string): Promise<UndoPreview | null> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    const mark = s.marks.find((m) => m.messageId === messageId);
    if (!mark) return null;
    const { targets, unattributed } = await this.undoSet(s, root, mark);
    const files: SessionChangeEntry[] = [];
    for (const [rel, st] of targets) {
      const abs = join(root, rel);
      files.push({ path: abs, name: basename(abs), adds: st.adds, dels: st.dels, status: st.status, sessions: this.sessionCount(root, abs) });
    }
    return { files, unattributed };
  }

  /** 执行回退：还原回退集内的文件（不在快照 = 删除），并丢弃该时点及之后的
   *  marks。回退集在执行时**重新计算** —— TOCTOU 硬约束：禁止缓存/复用
   *  undoPreview 的结果，预览→点击确认之间磁盘与台账可能已再变。 */
  async undoRevert(sessionId: string, root: string, messageId: string): Promise<void> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    const mark = s.marks.find((m) => m.messageId === messageId);
    if (!mark) return;
    const { targets, unattributed } = await this.undoSet(s, root, mark); // 重算，勿复用预览（见上）
    // 反悔快照（undo-the-undo）：动手改盘前先拍全树快照，hash 留台账 + 日志。
    // 回退会丢弃 ts ≥ mark.ts 的 marks，被还原文件的「回退前内容」自此失去
    // 可查询引用 —— 误确认后的手动恢复路径见模块头注释。
    const safety = await this.shadow.snapshot(root);
    if (safety) {
      s.lastUndoSafety = { hash: safety, ts: Date.now() };
      log.info('changes', 'undo safety snapshot', { sessionId, hash: safety.slice(0, 12) });
    }
    for (const rel of targets.keys()) {
      await this.shadow.revertFile(root, mark.hash, join(root, rel));
    }
    // accepted 精确清理：只删被实际还原文件的记录（mark 之前已 accepted 的
    // 改动本就在快照里，不受影响），不再全清。
    for (const abs of [...s.accepted.keys()]) {
      if (targets.has(normRel(root, abs))) s.accepted.delete(abs);
    }
    // 该提问及其后的消息已被移除 — 对应还原点一并作废。
    s.marks = s.marks.filter((m) => m.ts < mark.ts);
    log.info('changes', 'undo revert applied', { sessionId, reverted: targets.size, skipped: unattributed });
    this.persist(sessionId);
  }

  /** 接受（保留改动、标记已接受，不动磁盘）；path 省略 = 全部。 */
  async accept(sessionId: string, root: string, path?: string): Promise<void> {
    this.ensureLoaded(sessionId);
    const s = this.state(sessionId);
    if (!s.baselineHash) return;
    const stat = await this.shadow.diffStat(root, s.baselineHash);
    const targets = path ? [path] : [...s.touched.keys()];
    for (const abs of targets) {
      if (!s.touched.has(abs)) continue;
      const rel = normRel(root, abs);
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
      s = { baselineHash: null, touched: new Map(), accepted: new Map(), marks: [] };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /**
   * 回退集 = diffStat(root, mark.hash) ∩（touched ∪ accepted）—— undoPreview
   * 与 undoRevert 共用同一计算，口径与变更面板 list() 一致。
   * 路径统一规范化为相对 posix 再比较（touched 混有引擎上报的正斜杠绝对路径
   * 与 join(root, rel) 拼出的反斜杠路径，不规范化会在 Windows 上静默 miss）。
   * touched 追加 ts ≥ mark.ts（只认「该提问之后本会话动过」的文件，剔除 mark
   * 之前的历史编辑残留；ts=0 旧格式视为恒有效）；accepted 不参与 ts 比较
   * （无编辑时刻语义，且被接受的文件本就是本会话确认的变更），视为恒有效。
   */
  private async undoSet(s: SessionState, root: string, mark: PromptMark): Promise<{ targets: Map<string, DiffEntry>; unattributed: number }> {
    const eligible = new Set<string>();
    for (const [abs, ts] of s.touched) if (ts === 0 || ts >= mark.ts) eligible.add(normRel(root, abs));
    for (const abs of s.accepted.keys()) eligible.add(normRel(root, abs));
    const stat = await this.shadow.diffStat(root, mark.hash);
    const targets = new Map<string, DiffEntry>();
    for (const [rel, st] of stat) if (eligible.has(rel)) targets.set(rel, st);
    return { targets, unattributed: stat.size - targets.size };
  }

  /** 当前内存中有多少个会话编辑过该文件（>1 = 多会话共编）。路径按相对 posix
   *  归一后比较（touched 路径形态不一，见 normRel；不规范化跨会话计数会静默 miss）。 */
  private sessionCount(root: string, abs: string): number {
    const rel = normRel(root, abs);
    let n = 0;
    for (const s of this.sessions.values()) {
      for (const p of s.touched.keys()) {
        if (normRel(root, p) === rel) {
          n++;
          break;
        }
      }
    }
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
        lastUndoSafety?: unknown;
      };
      // touched 双格式：旧 = string 数组（无编辑时刻 → ts=0 恒有效，undo 过滤
      // 退化为纯路径交集）；新 = { path: ts }。只读旧、不丢旧、不阻断。
      const touchedValid = Array.isArray(raw.touched) || (!!raw.touched && typeof raw.touched === 'object');
      if (raw && typeof raw === 'object' && touchedValid) {
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
        const touched = new Map<string, number>();
        if (Array.isArray(raw.touched)) {
          for (const x of raw.touched) if (typeof x === 'string') touched.set(x, 0);
        } else {
          for (const [p, ts] of Object.entries(raw.touched as Record<string, unknown>)) {
            if (typeof ts === 'number') touched.set(p, ts);
          }
        }
        const rawSafety = raw.lastUndoSafety as Partial<{ hash: unknown; ts: unknown }> | null;
        const lastUndoSafety =
          rawSafety && typeof rawSafety === 'object' && typeof rawSafety.hash === 'string' && typeof rawSafety.ts === 'number'
            ? { hash: rawSafety.hash, ts: rawSafety.ts }
            : undefined;
        this.sessions.set(sessionId, {
          baselineHash: typeof raw.baselineHash === 'string' ? raw.baselineHash : null,
          touched,
          accepted,
          marks,
          lastUndoSafety,
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
      writeFileSync(
        this.file(sessionId),
        JSON.stringify({
          baselineHash: s.baselineHash,
          touched: Object.fromEntries(s.touched),
          accepted: Object.fromEntries(s.accepted),
          marks: s.marks,
          lastUndoSafety: s.lastUndoSafety,
        }),
        'utf8',
      );
    } catch (err) {
      log.error('changes', 'change ledger persist failed', { sessionId }, err);
    }
  }
}

/** 绝对路径 → 相对 root 的 posix 形式。touched 里混有引擎上报的正斜杠绝对
 *  路径与 join(root, rel) 拼出的反斜杠路径，统一规范化后再比较（relative
 *  本身先归一两边分隔符）——不规范化在 Windows 上会静默 miss。 */
function normRel(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/');
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
