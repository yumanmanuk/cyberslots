/**
 * slashService — 斜线命令候选扫描：引擎全局目录 + 会话项目目录。
 *
 * 扫描约定（全部只读、目录不存在即跳过）：
 * - Skills（目录内含 SKILL.md，frontmatter 取 name/description）：
 *     全局  ~/.codex/skills、~/.kimi-code/skills、~/.config/opencode/skills、~/.agents/skills
 *     项目  <cwd>/.codex/skills、<cwd>/.kimi-code/skills、<cwd>/.opencode/skills、<cwd>/.agents/skills
 * - Commands（*.md，取 frontmatter description 或首个有效行）：
 *     全局  ~/.codex/prompts、~/.config/opencode/commands(|command)
 *     项目  <cwd>/.codex/prompts、<cwd>/.opencode/commands(|command)
 *
 * 可见性：本会话引擎 + generic 通用目录；kimi 会话额外可见 codex
 * skills（kimi-code 内置兼容读取 ~/.codex/skills，dist 实测）。
 * 同名同类去重：项目级优先于全局（覆盖语义）。
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { SlashItem } from '@shared/ipc';
import type { EngineId } from '@shared/types';
import { codexHomeDir, kimiHomeDir } from '../config/engineConfigs';

/** 不再下钻的资源目录名（skill 包内的附属目录，不是子 skill）。 */
const SKIP_DESCEND = new Set(['references', 'scripts', 'assets', 'node_modules']);
/** 下钻深度上限 — 覆盖 <root>/<name>/SKILL.md 与 <root>/.system/<name>/SKILL.md。 */
const MAX_DEPTH = 2;

interface Root {
  dir: string;
  engine: SlashItem['engine'];
  scope: SlashItem['scope'];
}

function scanRoots(cwd: string): { skills: Root[]; commands: Root[] } {
  const codexHome = codexHomeDir();
  const kimiHome = kimiHomeDir();
  const ocHome = join(homedir(), '.config', 'opencode');
  const skills: Root[] = [
    { dir: join(codexHome, 'skills'), engine: 'codex', scope: 'global' },
    { dir: join(kimiHome, 'skills'), engine: 'kimi', scope: 'global' },
    { dir: join(ocHome, 'skills'), engine: 'opencode', scope: 'global' },
    { dir: join(homedir(), '.agents', 'skills'), engine: 'generic', scope: 'global' },
  ];
  const commands: Root[] = [
    { dir: join(codexHome, 'prompts'), engine: 'codex', scope: 'global' },
    // opencode 两种拼写都扫（commands 现行 / command 历史）。
    { dir: join(ocHome, 'commands'), engine: 'opencode', scope: 'global' },
    { dir: join(ocHome, 'command'), engine: 'opencode', scope: 'global' },
  ];
  if (cwd) {
    skills.push(
      { dir: join(cwd, '.codex', 'skills'), engine: 'codex', scope: 'project' },
      { dir: join(cwd, '.kimi-code', 'skills'), engine: 'kimi', scope: 'project' },
      { dir: join(cwd, '.opencode', 'skills'), engine: 'opencode', scope: 'project' },
      { dir: join(cwd, '.agents', 'skills'), engine: 'generic', scope: 'project' },
    );
    commands.push(
      { dir: join(cwd, '.codex', 'prompts'), engine: 'codex', scope: 'project' },
      { dir: join(cwd, '.opencode', 'commands'), engine: 'opencode', scope: 'project' },
      { dir: join(cwd, '.opencode', 'command'), engine: 'opencode', scope: 'project' },
    );
  }
  return { skills, commands };
}

/** 引擎可见性：本引擎 + generic；kimi 兼容读 codex skills。 */
function visible(item: SlashItem, engine: EngineId): boolean {
  if (item.engine === 'generic' || item.engine === engine) return true;
  return engine === 'kimi' && item.kind === 'skill' && item.engine === 'codex';
}

export async function listSlashItems(cwd: string, engine: EngineId): Promise<SlashItem[]> {
  const roots = scanRoots(cwd);
  const groups = await Promise.all([
    ...roots.skills.map((r) => scanSkills(r)),
    ...roots.commands.map((r) => scanCommands(r)),
  ]);
  // 项目级排前面 → 同名去重时项目级覆盖全局。
  const all = groups.flat().sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1));
  const seen = new Set<string>();
  const out: SlashItem[] = [];
  for (const item of all) {
    if (!visible(item, engine)) continue;
    const key = `${item.kind}:${item.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// --------------------------------------------------------------- scanners

/** 递归找含 SKILL.md 的目录（找到即停，不再下钻该 skill 包内部）。 */
async function scanSkills(root: Root): Promise<SlashItem[]> {
  const out: SlashItem[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限 / 竞态删除 — 静默跳过
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const path = join(dir, 'SKILL.md');
      const meta = await parseSkillMd(path);
      out.push({
        name: meta.name ?? basename(dir),
        description: meta.description,
        kind: 'skill',
        scope: root.scope,
        engine: root.engine,
        path,
      });
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DESCEND.has(e.name)) continue;
      // 隐藏目录只下钻 .system（codex 内置技能容器），其余（.git 等）跳过。
      if (e.name.startsWith('.') && e.name !== '.system') continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }
  if (existsSync(root.dir)) await walk(root.dir, 0);
  return out;
}

/** 平铺扫描 *.md 命令文件（文件名去扩展 = 触发名）。 */
async function scanCommands(root: Root): Promise<SlashItem[]> {
  const out: SlashItem[] = [];
  let entries;
  try {
    entries = await readdir(root.dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const path = join(root.dir, e.name);
    out.push({
      name: e.name.replace(/\.md$/i, ''),
      description: await parseCommandDesc(path),
      kind: 'command',
      scope: root.scope,
      engine: root.engine,
      path,
    });
  }
  return out;
}

// --------------------------------------------------------------- parsers

/** SKILL.md：frontmatter 的 name / description（缺省退回目录名）。 */
async function parseSkillMd(path: string): Promise<{ name?: string; description: string }> {
  const head = await readHead(path, 8192);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (!fm) return { description: '' };
  return {
    name: fmField(fm[1]!, 'name'),
    description: fmField(fm[1]!, 'description') ?? fmField(fm[1]!, 'short-description') ?? '',
  };
}

/** command md：frontmatter description 优先，否则首个有效正文行。 */
async function parseCommandDesc(path: string): Promise<string> {
  const head = await readHead(path, 4096);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (fm) {
    const d = fmField(fm[1]!, 'description');
    if (d) return d;
  }
  // 去掉 frontmatter 区块后找首个有效正文行（跳过空行/标题/HTML 注释）。
  const body = fm ? head.slice(fm[0].length) : head;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--')) continue;
    return oneLine(line);
  }
  return '';
}

async function readHead(path: string, cap: number): Promise<string> {
  try {
    // 容忍 UTF-8 BOM（Windows 编辑器常见，否则 frontmatter 锚定失败）。
    return (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').slice(0, cap);
  } catch {
    return '';
  }
}

/** 取 frontmatter 字段首行值（去引号、压成一行）。 */
function fmField(fm: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm);
  if (!m) return undefined;
  return oneLine(m[1]!.trim().replace(/^["']|["']$/g, ''));
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}
