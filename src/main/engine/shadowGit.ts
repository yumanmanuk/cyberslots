/**
 * ShadowGit — 影子 git 快照（借鉴 opencode 的 Snapshot）。
 *
 * 为每个 workspace root 建一个**独立的 GIT_DIR**（userData/shadow-git/<hash>），
 * 用 `--work-tree=<root>` 叠在真实工作树上，与用户自己的 `.git` 完全隔离
 * （不污染、也不依赖用户仓库是不是 git）。
 *   - snapshot()  = `git add -A` + `git write-tree` → 内容寻址的 tree hash；
 *   - show()      = `git cat-file -p <hash>:<file>` 取快照里该文件内容；
 *   - diffStat()  = `git diff --cached --numstat/--name-status <hash>` 拿全部变更；
 *   - revertFile()= `git checkout <hash> -- <file>`（不在快照 = 删除）。
 * tree hash 不可变、内容寻址：多会话各自持有自己的快照 hash，回退互不干扰。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';

import { log } from '../log/logger';

const execFileAsync = promisify(execFile);

type GitResult = { code: number; stdout: string; stderr: string };

export type FileStatus = 'modified' | 'added' | 'deleted';

/** 影子仓库忽略：用户真实 .git 与常见重目录，避免首次 add 卷入海量文件。 */
const SHADOW_EXCLUDE = ['.git/', 'node_modules/', '.venv/', 'venv/', 'dist/', 'out/', 'build/', 'target/', '.next/'];

export class ShadowGit {
  private readonly base = join(app.getPath('userData'), 'shadow-git');
  /** root → gitdir（已初始化）| null（不可用）。 */
  private readonly ready = new Map<string, Promise<string | null>>();
  /** root → 串行锁，避免并发 git 操作抢 index 锁。 */
  private readonly locks = new Map<string, Promise<unknown>>();

  private gitdirFor(root: string): string {
    return join(this.base, createHash('sha1').update(root).digest('hex'));
  }

  private lock<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(root) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(root, next.then(() => undefined, () => undefined));
    return next;
  }

  private async git(gitdir: string, root: string, args: string[]): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', ['--git-dir', gitdir, '--work-tree', root, ...args], {
        cwd: root,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: unknown; stdout?: string; stderr?: string };
      return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(e) };
    }
  }

  private ensure(root: string): Promise<string | null> {
    let p = this.ready.get(root);
    if (p) return p;
    p = (async () => {
      const gitdir = this.gitdirFor(root);
      try {
        if (!existsSync(join(gitdir, 'HEAD'))) {
          mkdirSync(gitdir, { recursive: true });
          const init = await this.git(gitdir, root, ['init', '-q']);
          if (init.code !== 0) {
            log.warn('changes', 'shadow git init failed — change tracking disabled for this root', {
              root,
              stderr: init.stderr.slice(0, 300),
            });
            return null;
          }
          const configs: Array<[string, string]> = [
            ['core.autocrlf', 'false'],
            ['core.longpaths', 'true'],
            ['core.symlinks', 'true'],
            ['core.fsmonitor', 'false'],
            ['feature.manyFiles', 'true'],
            ['index.version', '4'],
            ['core.untrackedCache', 'true'],
            ['gc.auto', '0'],
          ];
          for (const [k, v] of configs) {
            await this.git(gitdir, root, ['config', k, v]);
          }
          try {
            mkdirSync(join(gitdir, 'info'), { recursive: true });
            writeFileSync(join(gitdir, 'info', 'exclude'), SHADOW_EXCLUDE.join('\n') + '\n', 'utf8');
          } catch {
            /* ignore */
          }
        }
        return gitdir;
      } catch (err) {
        log.warn('changes', 'shadow git ensure failed — change tracking disabled for this root', { root }, err);
        return null;
      }
    })();
    this.ready.set(root, p);
    return p;
  }

  /** 快照当前工作树 → tree hash（尊重工作树 .gitignore + 影子 exclude）。 */
  async snapshot(root: string): Promise<string | null> {
    return this.lock(root, async () => {
      const gitdir = await this.ensure(root);
      if (!gitdir) return null;
      if ((await this.git(gitdir, root, ['add', '-A'])).code !== 0) return null;
      const wt = await this.git(gitdir, root, ['write-tree']);
      return wt.code === 0 ? wt.stdout.trim() || null : null;
    });
  }

  /** 快照里某文件的内容（null = 快照中不存在，即当时为新建/缺失）。 */
  async show(root: string, hash: string, abs: string): Promise<string | null> {
    const rel = relative(root, abs).split('\\').join('/');
    return this.lock(root, async () => {
      const gitdir = await this.ensure(root);
      if (!gitdir) return null;
      const r = await this.git(gitdir, root, ['cat-file', '-p', `${hash}:${rel}`]);
      return r.code === 0 ? r.stdout : null;
    });
  }

  /** 自快照以来的全部变更（相对路径 → 增删/类型）。 */
  async diffStat(root: string, hash: string): Promise<Map<string, { adds: number; dels: number; status: FileStatus }>> {
    return this.lock(root, async () => {
      const out = new Map<string, { adds: number; dels: number; status: FileStatus }>();
      const gitdir = await this.ensure(root);
      if (!gitdir) return out;
      await this.git(gitdir, root, ['add', '-A']); // 刷新 index=工作树，纳入新建/删除
      const nam = await this.git(gitdir, root, ['diff', '--cached', '--name-status', '--no-renames', hash, '--', '.']);
      const status = new Map<string, FileStatus>();
      if (nam.code === 0) {
        for (const line of nam.stdout.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const tab = t.indexOf('\t');
          if (tab < 0) continue;
          const code = t.slice(0, tab);
          const file = t.slice(tab + 1).trim();
          if (!file) continue;
          status.set(file, code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified');
        }
      }
      const num = await this.git(gitdir, root, ['diff', '--cached', '--numstat', '--no-renames', hash, '--', '.']);
      if (num.code === 0) {
        for (const line of num.stdout.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const parts = t.split('\t');
          if (parts.length < 3) continue;
          const [a, d] = parts;
          const file = parts.slice(2).join('\t');
          out.set(file, {
            adds: a === '-' ? 0 : parseInt(a!, 10) || 0,
            dels: d === '-' ? 0 : parseInt(d!, 10) || 0,
            status: status.get(file) ?? 'modified',
          });
        }
      }
      // 二进制文件 numstat 记 -，仍要显示（用 name-status 补齐）。
      for (const [file, st] of status) if (!out.has(file)) out.set(file, { adds: 0, dels: 0, status: st });
      return out;
    });
  }

  /** 回退单文件到快照（不在快照 = 删除该文件）。 */
  async revertFile(root: string, hash: string, abs: string): Promise<void> {
    const rel = relative(root, abs).split('\\').join('/');
    await this.lock(root, async () => {
      const gitdir = await this.ensure(root);
      if (!gitdir) return;
      const co = await this.git(gitdir, root, ['checkout', hash, '--', rel]);
      if (co.code === 0) return;
      // checkout 失败：文件在快照里存在则保守不动，否则=新建 → 删除。
      const ls = await this.git(gitdir, root, ['ls-tree', hash, '--', rel]);
      if (ls.code === 0 && ls.stdout.trim()) return;
      try {
        if (existsSync(abs)) rmSync(abs, { force: true });
      } catch {
        /* ignore */
      }
    });
  }

  /** 会话/工作区清理时删除影子仓库（可选，节省空间）。 */
  async destroy(root: string): Promise<void> {
    const gitdir = this.gitdirFor(root);
    this.ready.delete(root);
    try {
      rmSync(gitdir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
