/**
 * Filesystem service — powers the workspace panel (tree, preview, edit)
 * and external openers. All write paths are boundary-checked to the
 * session root; reads are capped to keep the UI responsive.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { cp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep, extname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { app, BrowserWindow, dialog, shell } from 'electron';

import type { FileContent, FsNode, GitBaseContent, OpenerAvailability, OpenerId, OpenTarget } from '@shared/ipc';
import { L } from '../i18n';
import { log } from '../log/logger';

const execFileAsync = promisify(execFile);
const PREVIEW_CAP = 512 * 1024; // 512 KB
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store', '.hg', '.svn']);

/** 粘贴附件目录的数量上限 —— codex localImage 按路径引用、resume/compact
 *  时会重读文件，不能按龄期乱删；只保留最新 N 个（防无限膨胀），
 *  超出才从最旧开始清。500 × 典型截图 ≈ 百 MB 级，上限可控。 */
const PASTED_KEEP_MAX = 500;

/** 机会式清扫：只在写入新附件时顺带修剪（best-effort，失败不影响保存）。 */
function sweepPastedDir(dir: string): void {
  try {
    const entries = readdirSync(dir)
      .map((name) => {
        try {
          return { name, mtime: statSync(join(dir, name)).mtimeMs };
        } catch {
          return { name, mtime: 0 };
        }
      })
      .sort((a, b) => a.mtime - b.mtime);
    const excess = entries.length - PASTED_KEEP_MAX;
    for (let i = 0; i < excess; i++) {
      try {
        unlinkSync(join(dir, entries[i]!.name));
      } catch {
        /* 单文件删除失败跳过 */
      }
    }
  } catch {
    /* 目录不可读 = 不清 */
  }
}

/** 把剪贴板/拖拽的二进制（如粘贴的图片）写入一个临时文件，返回绝对
 *  路径（作为附件传给引擎）。落在 userData/pasted 下，数量封顶清扫。 */
export function saveTempAttachment(bytes: Uint8Array, ext: string): string {
  const dir = join(app.getPath('userData'), 'pasted');
  mkdirSync(dir, { recursive: true });
  const safeExt = /^[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : 'png';
  const file = join(dir, `${randomUUID()}.${safeExt}`);
  writeFileSync(file, bytes);
  sweepPastedDir(dir);
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

/** AI 正文提及的路径 → 工作区内真实文件。相对路径先按 root 直接拼；
 *  不存在时全树模糊定位：路径后缀匹配优先（`components/SettingsView.tsx`
 *  命中 `src/renderer/src/components/SettingsView.tsx`），退化为同名文件。
 *  绝对路径只认「存在」，不做模糊（指向工作区外的由调用方另行处理）。 */
export async function resolveWorkspaceFile(root: string, rawPath: string): Promise<string | null> {
  const isFile = async (p: string): Promise<boolean> => stat(p).then((s) => s.isFile()).catch(() => false);
  if (isAbsolute(rawPath)) return (await isFile(rawPath)) ? rawPath : null;

  const rootAbs = resolve(root);
  const direct = resolve(rootAbs, rawPath);
  if (await isFile(direct)) return direct;

  const want = rawPath.replace(/^[.\\/]+/, '').replace(/[\\/]+/g, '/').toLowerCase();
  const base = want.split('/').pop()!;
  let suffixHit: string | null = null;
  let baseHit: string | null = null;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if ((suffixHit && baseHit) || depth > 10) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 权限/符号链接坏链 — 跳过该子树
    }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const rel = relative(rootAbs, full).replace(/[\\/]+/g, '/').toLowerCase();
      if (!suffixHit && (rel === want || rel.endsWith(`/${want}`))) suffixHit = full;
      else if (!baseHit && e.name.toLowerCase() === base) baseHit = full;
    }
  };
  await walk(rootAbs, 0);
  return suffixHit ?? baseHit;
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

/** 单文件 git 基准：HEAD 版本内容 + 文件级变更状态，供编辑器逐行标记。
 *  非 git 仓库 / HEAD 无该文件（新增、未跟踪）/ 二进制 → base 为 null，
 *  渲染端按「相对 HEAD 全新增」或「无标记」处理；失败一律静默降级。 */
export async function gitBaseContent(root: string, path: string): Promise<GitBaseContent> {
  try {
    const repo = await execFileAsync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const repoRoot = repo.stdout.trim();
    if (!repoRoot) return { base: null, status: '' };
    const rel = relative(repoRoot, resolve(path)).split('\\').join('/');
    let status = '';
    try {
      const st = await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain', '--', rel], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const line = st.stdout.split('\n')[0] ?? '';
      const code = line.slice(0, 2).trim();
      status = code ? (code[0] === ' ' ? code[1]! : code[0]!) : '';
      if (status === '?') status = 'U';
    } catch {
      /* 单文件状态查询失败 — 保持无状态 */
    }
    let base: string | null = null;
    try {
      const show = await execFileAsync('git', ['-C', repoRoot, 'show', `HEAD:${rel}`], {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      // 二进制内容含 NUL，逐行 diff 无意义 → 视为无基准。
      if (!show.stdout.includes('\0')) base = show.stdout;
    } catch {
      /* HEAD 无此文件 = 新增/未跟踪 */
    }
    return { base, status };
  } catch {
    // git 缺失 / 非仓库 — 静默降级为无标记
    return { base: null, status: '' };
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
    case 'cursor':
    case 'antigravity':
      await openEditor(target, path);
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
      // Git Bash：用绝对路径 + shell:false 启动——含空格的安装路径（
      // C:\Program Files\Git）经 cmd 会被拆成 "C:\Program"，历史上
      // “点了没反应”就是这个坑；--cd 定位到目标目录。
      for (const exe of gitBashCandidates()) {
        if (await launchExe(exe, [`--cd=${path}`], path)) return;
      }
      await reportMissing('gitbash');
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
      log.error('fs', 'import failed', { src }, err);
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

// -------- external openers（编辑器 / Git Bash 的健壮解析与启动）--------

/** 各 opener 的展示名（缺失提示用）。 */
const OPENER_NAMES: Partial<Record<OpenTarget, string>> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  gitbash: 'Git Bash',
};

/** Windows 上各编辑器可执行文件的常见安装路径（首个存在者即用）。
 *  注意 Antigravity 安装目录名为 "Antigravity IDE"（带空格）。 */
function editorCandidates(target: OpenTarget): string[] {
  if (process.platform !== 'win32') return [];
  const { LOCALAPPDATA: LA, PROGRAMFILES: PF } = process.env;
  const PF86 = process.env['PROGRAMFILES(X86)'];
  const j = (base: string | undefined, ...rest: string[]): string => (base ? join(base, ...rest) : '');
  const list =
    target === 'vscode'
      ? [j(LA, 'Programs', 'Microsoft VS Code', 'Code.exe'), j(PF, 'Microsoft VS Code', 'Code.exe'), j(PF86, 'Microsoft VS Code', 'Code.exe')]
      : target === 'cursor'
        ? [j(LA, 'Programs', 'cursor', 'Cursor.exe'), j(LA, 'Programs', 'Cursor', 'Cursor.exe')]
        : target === 'antigravity'
          ? [
              j(LA, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
              j(LA, 'Programs', 'Antigravity', 'Antigravity.exe'),
              j(PF, 'Antigravity IDE', 'Antigravity IDE.exe'),
            ]
          : [];
  return list.filter(Boolean);
}

/** PATH 上可尝试的命令名（绝对路径找不到时的跨平台/自定义安装兑底）。 */
const EDITOR_PATH_CMDS: Partial<Record<OpenTarget, string[]>> = {
  vscode: ['code'],
  cursor: ['cursor'],
  antigravity: ['antigravity', 'antigravity-ide'],
};

/** Git Bash 常见安装路径。 */
function gitBashCandidates(): string[] {
  const { PROGRAMFILES: PF, LOCALAPPDATA: LA } = process.env;
  const PF86 = process.env['PROGRAMFILES(X86)'];
  return [PF && join(PF, 'Git', 'git-bash.exe'), PF86 && join(PF86, 'Git', 'git-bash.exe'), LA && join(LA, 'Programs', 'Git', 'git-bash.exe')].filter(
    (p): p is string => Boolean(p),
  );
}

/** 用绝对路径启动 GUI 程序（shell:false — args 走数组，含空格路径不被 cmd 拆断）。 */
async function launchExe(exe: string, args: string[], cwd?: string): Promise<boolean> {
  if (!existsSync(exe)) return false;
  const { spawn } = await import('node:child_process');
  spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return true;
}

/** 用 PATH 上的命令启动（.cmd 需 shell:true；path 手动加引号防空格被拆）。 */
async function launchOnPath(cmd: string, path: string): Promise<boolean> {
  if (!(await hasCommand(cmd))) return false;
  await spawnDetached([cmd, `"${path}"`]);
  return true;
}

/** 打开编辑器：优先绝对路径（最稳），回退 PATH 命令；都没有则提示缺失。 */
async function openEditor(target: OpenTarget, path: string): Promise<void> {
  for (const exe of editorCandidates(target)) {
    if (await launchExe(exe, [path])) return;
  }
  for (const cmd of EDITOR_PATH_CMDS[target] ?? []) {
    if (await launchOnPath(cmd, path)) return;
  }
  await reportMissing(target);
}

/** 未检测到目标程序时弹原生提示（避免历史上“点了没反应”的静默失败）。 */
async function reportMissing(target: OpenTarget): Promise<void> {
  const name = OPENER_NAMES[target] ?? target;
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const opts = {
    type: 'warning' as const,
    message: L(`未检测到 ${name}`, `${name} not detected`),
    detail: L(`没有找到 ${name} 的可执行文件，请确认已安装后重试。`, `Could not find an executable for ${name}. Make sure it is installed, then retry.`),
    buttons: [L('知道了', 'OK')],
  };
  if (win) await dialog.showMessageBox(win, opts);
  else await dialog.showMessageBox(opts);
}

/** 单个 opener 是否本机可用：任一绝对路径候选存在，或任一 PATH 命令存在。
 *  与 openIn 实际启动用的同一份 candidates——“检测说有 = 打开一定能开”。 */
async function isOpenerAvailable(id: OpenerId): Promise<boolean> {
  const exePaths = id === 'gitbash' ? gitBashCandidates() : editorCandidates(id);
  if (exePaths.some((p) => existsSync(p))) return true;
  const cmds = id === 'gitbash' ? [] : EDITOR_PATH_CMDS[id] ?? [];
  for (const cmd of cmds) {
    if (await hasCommand(cmd)) return true;
  }
  return false;
}

/** 探测全部「外部打开」目标的本机可用性（进程级缓存，force 重探）。
 *  启动后由渲染层拉一次；菜单据此隐藏未安装项（而非点了才弹缺失提示）。 */
let openerCache: OpenerAvailability | undefined;
export async function detectOpeners(force = false): Promise<OpenerAvailability> {
  if (openerCache && !force) return openerCache;
  const ids: OpenerId[] = ['vscode', 'cursor', 'antigravity', 'gitbash'];
  const results = await Promise.all(ids.map((id) => isOpenerAvailable(id)));
  openerCache = Object.fromEntries(ids.map((id, i) => [id, results[i]!])) as OpenerAvailability;
  return openerCache;
}

/** Throw if `target` escapes `root` (path-traversal / symlink guard). */
function assertInside(root: string, target: string): void {
  const rel = relative(resolve(root), target);
  if (rel === '') return;
  if (rel.startsWith('..') || (rel.includes('..' + sep))) {
    throw new Error(L(`路径越界，拒绝访问工作区之外：${target}`, `Path escapes the workspace, access denied: ${target}`));
  }
}
