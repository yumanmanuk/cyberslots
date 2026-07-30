/**
 * Filesystem service — powers the workspace panel (tree, preview, edit)
 * and external openers. All write paths are boundary-checked to the
 * session root; reads are capped to keep the UI responsive.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { app, shell } from 'electron';

import type { FileContent, FsNode, OpenTarget } from '@shared/ipc';

const execFileAsync = promisify(execFile);
const PREVIEW_CAP = 512 * 1024; // 512 KB
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store', '.hg', '.svn']);

/** 把剪贴板/拖拽的二进制（如粘贴的图片）写入一个临时文件，返回绝对
 *  路径（作为附件传给引擎）。落在 userData/pasted 下，app 退出不主动清。 */
export function saveTempAttachment(bytes: Uint8Array, ext: string): string {
  const dir = join(app.getPath('userData'), 'pasted');
  mkdirSync(dir, { recursive: true });
  const safeExt = /^[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : 'png';
  const file = join(dir, `${randomUUID()}.${safeExt}`);
  writeFileSync(file, bytes);
  return file;
}

/** 路径是否目录 — 拖放到输入框时区分文件夹/文件引用（不存在视为文件）。 */
export async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory()).catch(() => false);
}

/** List one directory level, dirs first then files, alpha-sorted. */
export async function listTree(root: string, sub = ''): Promise<FsNode[]> {
  const dir = sub ? resolve(root, sub) : resolve(root);
  assertInside(root, dir);
  const entries = await readdir(dir, { withFileTypes: true });
  const nodes: FsNode[] = [];
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    nodes.push({ name: e.name, path: join(dir, e.name), dir: e.isDirectory() });
  }
  nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return nodes;
}

export async function readFilePreview(path: string): Promise<FileContent> {
  const info = await stat(path);
  const ext = extname(path).slice(1).toLowerCase();
  if (info.size > PREVIEW_CAP) {
    const buf = Buffer.alloc(PREVIEW_CAP);
    const { open } = await import('node:fs/promises');
    const fh = await open(path, 'r');
    try {
      await fh.read(buf, 0, PREVIEW_CAP, 0);
    } finally {
      await fh.close();
    }
    return { path, text: buf.toString('utf8'), truncated: true, ext };
  }
  return { path, text: await readFile(path, 'utf8'), truncated: false, ext };
}

export async function writeFileChecked(path: string, text: string, root: string): Promise<void> {
  assertInside(root, resolve(path));
  await writeFile(path, text, 'utf8');
}

/** Porcelain git status keyed by absolute path → short code (M/A/D/U/R…)。
 *  `??`（未跟踪）归一化为 U —— 对用户即「新增文件」，跟 VS Code 徽标一致，
 *  避免树里出现语义不明的 `?`。 */
export async function gitStatus(root: string): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z'], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const out: Record<string, string> = {};
    for (const entry of stdout.split('\0')) {
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2).trim();
      const rel = entry.slice(3);
      const short = code[0] === ' ' ? code[1]! : code[0]!;
      out[resolve(root, rel)] = short === '?' ? 'U' : short;
    }
    return out;
  } catch {
    return {}; // not a git repo / git missing — silent
  }
}

/** Open a path in an external tool. Falls back to OS default where possible. */
export async function openIn(target: OpenTarget, path: string): Promise<void> {
  const quoted = path;
  switch (target) {
    case 'explorer': {
      // 目录直接打开其内容（workspace/project 菜单的“在文件管理器中打开”）；
      // 文件则在父目录中定位选中。
      const isDir = await stat(path).then((s) => s.isDirectory()).catch(() => false);
      if (isDir) await shell.openPath(path);
      else shell.showItemInFolder(path);
      return;
    }
    case 'vscode':
      await spawnDetached(['code', quoted]);
      return;
    case 'cursor':
      await spawnDetached(['cursor', quoted]);
      return;
    case 'antigravity':
      await spawnDetached(['antigravity', quoted]);
      return;
    case 'wt':
      await spawnDetached(['wt', '-d', quoted]);
      return;
    case 'terminal': {
      // 快捷“打开终端”：Windows Terminal 优先，缺失时退回 PowerShell 窗口。
      // 注意：spawnDetached 带 shell:true，命令缺失不会抛错（cmd 静默退出），
      // 不能靠 try/catch 兑底 — 必须先探测 wt 是否存在（e2e 实测点击无反应）。
      if (await hasCommand('wt')) await spawnDetached(['wt', '-d', `"${path}"`]);
      else await spawnDetached(['start', 'powershell', '-NoExit'], path);
      return;
    }
    case 'gitbash': {
      // Git Bash: open a login shell rooted at the path.
      const bash = process.env.PROGRAMFILES
        ? join(process.env.PROGRAMFILES, 'Git', 'git-bash.exe')
        : 'git-bash.exe';
      await spawnDetached([bash], quoted);
      return;
    }
    default:
      await shell.openPath(path);
  }
}

// ------------------------------------------------------------------ helpers

/** 将拖入的外部文件/文件夹拷贝到工作区根目录（文件树拖放导入）。
 *  目标与源同路径则跳过（避免拷贝自身）；逐个尽力，单个失败不阻断其余。
 *  @returns 成功导入的个数。 */
export async function importPaths(root: string, srcPaths: string[]): Promise<number> {
  const rootAbs = resolve(root);
  let ok = 0;
  for (const src of srcPaths) {
    try {
      const srcAbs = resolve(src);
      const dest = join(rootAbs, basename(srcAbs));
      if (resolve(dest) === srcAbs) continue; // 源已在目录里，无需拷贝
      await cp(srcAbs, dest, { recursive: true, force: true, errorOnExist: false });
      ok++;
    } catch (err) {
      console.error('[fs] import failed:', src, err);
    }
  }
  return ok;
}

async function spawnDetached(argv: string[], cwd?: string): Promise<void> {
  const [cmd, ...args] = argv;
  const { spawn } = await import('node:child_process');
  const child = spawn(cmd!, args, { cwd, detached: true, stdio: 'ignore', shell: true, windowsHide: false });
  child.unref();
}

/** 命令是否在 PATH 上（where/which）— shell:true 的 spawn 对缺失命令不报错，只能事前探。 */
async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [cmd], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Throw if `target` escapes `root` (path-traversal / symlink guard). */
function assertInside(root: string, target: string): void {
  const rel = relative(resolve(root), target);
  if (rel === '') return;
  if (rel.startsWith('..') || (rel.includes('..' + sep))) {
    throw new Error(`路径越界，拒绝访问工作区之外：${target}`);
  }
}
