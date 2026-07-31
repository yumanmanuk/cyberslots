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
import type { EngineId, SlashCommandInfo } from '@shared/types';
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
  const claudeHome = join(homedir(), '.claude');
  const skills: Root[] = [
    { dir: join(codexHome, 'skills'), engine: 'codex', scope: 'global' },
    { dir: join(kimiHome, 'skills'), engine: 'kimi', scope: 'global' },
    { dir: join(ocHome, 'skills'), engine: 'opencode', scope: 'global' },
    { dir: join(claudeHome, 'skills'), engine: 'claude', scope: 'global' },
    { dir: join(homedir(), '.agents', 'skills'), engine: 'generic', scope: 'global' },
  ];
  const commands: Root[] = [
    { dir: join(codexHome, 'prompts'), engine: 'codex', scope: 'global' },
    // opencode 两种拼写都扫（commands 现行 / command 历史）。
    { dir: join(ocHome, 'commands'), engine: 'opencode', scope: 'global' },
    { dir: join(ocHome, 'command'), engine: 'opencode', scope: 'global' },
    { dir: join(claudeHome, 'commands'), engine: 'claude', scope: 'global' },
  ];
  if (cwd) {
    skills.push(
      { dir: join(cwd, '.codex', 'skills'), engine: 'codex', scope: 'project' },
      { dir: join(cwd, '.kimi-code', 'skills'), engine: 'kimi', scope: 'project' },
      { dir: join(cwd, '.opencode', 'skills'), engine: 'opencode', scope: 'project' },
      { dir: join(cwd, '.claude', 'skills'), engine: 'claude', scope: 'project' },
      { dir: join(cwd, '.agents', 'skills'), engine: 'generic', scope: 'project' },
    );
    commands.push(
      { dir: join(cwd, '.codex', 'prompts'), engine: 'codex', scope: 'project' },
      { dir: join(cwd, '.opencode', 'commands'), engine: 'opencode', scope: 'project' },
      { dir: join(cwd, '.opencode', 'command'), engine: 'opencode', scope: 'project' },
      { dir: join(cwd, '.claude', 'commands'), engine: 'claude', scope: 'project' },
    );
  }
  return { skills, commands };
}

/** 引擎可见性：本引擎 + generic；kimi 兼容读 codex skills。 */
function visible(item: SlashItem, engine: EngineId): boolean {
  if (item.engine === 'generic' || item.engine === engine) return true;
  return engine === 'kimi' && item.kind === 'skill' && item.engine === 'codex';
}

export async function listSlashItems(
  cwd: string,
  engine: EngineId,
  pushed?: SlashCommandInfo[],
): Promise<SlashItem[]> {
  const all = await scanAll(cwd);
  // 可见展示列表：本会话引擎 + generic；同名同类去重（项目级覆盖全局）。
  const seen = new Set<string>();
  const out: SlashItem[] = [];
  for (const item of all) {
    if (!visible(item, engine)) continue;
    const key = `${item.kind}:${item.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  // 引擎推送的命令：用全生态扫描索引回贴来源后并入（未命中保留 builtin）。
  if (pushed?.length) appendEnrichedPushed(out, all, pushed, engine);
  return out;
}

/** 扫描全部根（不受可见性过滤），项目级排前—供去重与来源回贴共用。 */
async function scanAll(cwd: string): Promise<SlashItem[]> {
  const roots = scanRoots(cwd);
  const groups = await Promise.all([
    ...roots.skills.map((r) => scanSkills(r)),
    ...roots.commands.map((r) => scanCommands(r)),
  ]);
  return groups.flat().sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1));
}

/**
 * 引擎运行时推送的命令 → 回贴本地来源（专治 omp 等聚合型引擎把用户
 * 安装的技能/命令混标成「引擎」的问题）：
 *  - `skill:X` 命中扫描出的技能 X → 标该技能来源（全局/项目）+ skill 类别；
 *  - 裸名 X 命中命令 X（优先）或技能 X → 标该文件来源；
 *  - 未命中 → kind='builtin'（无源文件，展示为「引擎」）。
 * 保留推送原名（含 `skill:` 前缀）—引擎按此原生解析；与已展示的可见
 * 扫描项同名则跳过（扫描项信息更全，去重优先）。
 */
function appendEnrichedPushed(
  out: SlashItem[],
  all: SlashItem[],
  pushed: SlashCommandInfo[],
  engine: EngineId,
): void {
  const shown = new Set(out.map((i) => i.name.toLowerCase()));
  // 全生态名字索引（技能 / 命令分表）—all 已项目先排序，first-seen 即项目优先。
  const skillIdx = new Map<string, SlashItem>();
  const cmdIdx = new Map<string, SlashItem>();
  for (const it of all) {
    const k = it.name.toLowerCase();
    const idx = it.kind === 'skill' ? skillIdx : cmdIdx;
    if (!idx.has(k)) idx.set(k, it);
  }
  for (const c of pushed) {
    const name = (c.name ?? '').trim();
    if (!name || shown.has(name.toLowerCase())) continue;
    shown.add(name.toLowerCase());
    const skillPrefix = /^skill:(.+)$/i.exec(name);
    const src = skillPrefix
      ? skillIdx.get(skillPrefix[1]!.toLowerCase())
      : (cmdIdx.get(name.toLowerCase()) ?? skillIdx.get(name.toLowerCase()));
    out.push(
      src
        ? {
            name, // 保留推送原名，引擎按此解析
            description: src.description || c.description || c.hint || '',
            kind: src.kind,
            scope: src.scope,
            engine: src.engine,
            path: src.path,
          }
        : {
            name,
            description: c.description ?? c.hint ?? '',
            kind: 'builtin',
            scope: 'global',
            engine,
            path: '',
          },
    );
  }
}

// ------------------------------------------------------- send-side routing

export type SlashRoute = { type: 'text'; text: string } | { type: 'command'; name: string; args: string };

/** 引擎自带斜杠文本解析的通道 — 透传即可：claude CLI 原生解析；
 *  kimi ACP（内置命令）与 KAP（skill.activated trigger=user-slash）均
 *  引擎侧解析；omp ACP 同。 */
const NATIVE_SLASH_ENGINES = new Set<EngineId>(['claude', 'kimi', 'omp']);

/**
 * 发送侧斜杠路由 — 引擎侧不解析斜杠文本时由客户端补齐执行语义：
 * - opencode command → 原生 POST /session/{id}/command（调用方走 adapter.command）；
 * - command（codex/antigravity）→ 读 md 模板客户端展开（$ARGUMENTS / $1..$9）；
 * - skill（codex/antigravity/opencode）→ 展开为「读技能文件并执行」指令；
 * - 未知名字 → null 原样透传（用户笔误或引擎私有命令）。
 */
export async function routeSlashPrompt(cwd: string, engine: EngineId, text: string): Promise<SlashRoute | null> {
  if (NATIVE_SLASH_ENGINES.has(engine)) return null;
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const args = (m[2] ?? '').trim();
  const items = await listSlashItems(cwd, engine);
  const item = items.find((it) => it.name.toLowerCase() === name);
  if (!item) return null;
  if (item.kind === 'command') {
    if (engine === 'opencode') return { type: 'command', name: item.name, args };
    return { type: 'text', text: substituteArgs(await readCommandBody(item.path), args) };
  }
  if (item.kind !== 'skill') return null;
  // skill：通用激活指令 — 与 TUI 侧的斜杠展开等效（模型自行读 SKILL.md）。
  return {
    type: 'text',
    text: [
      `请读取技能文件 ${item.path}，严格按其中的说明执行任务。`,
      args ? `任务输入：${args}` : '（无附加输入，按技能默认流程执行。）',
    ].join('\n'),
  };
}

/** 读命令模板全文并剥 frontmatter（listSlashItems 只读文件头取描述，此处要全文）。 */
async function readCommandBody(path: string): Promise<string> {
  const raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return (fm ? raw.slice(fm[0].length) : raw).trim();
}

/** 参数代入：$ARGUMENTS 整串、$1..$9 空白分词；模板无占位符且带参时追加到末尾。 */
function substituteArgs(body: string, args: string): string {
  const words = args ? args.split(/\s+/) : [];
  let used = false;
  let out = body.replace(/\$ARGUMENTS/g, () => {
    used = true;
    return args;
  });
  out = out.replace(/\$([1-9])/g, (_, d: string) => {
    used = true;
    return words[Number(d) - 1] ?? '';
  });
  if (!used && args) out += `\n\n${args}`;
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
    // SKILL.md 大小写不敏感：实测存在 skill.md 小写命名（如 ~/.claude/skills/…），
    // claude/omp 引擎自身都认，严格匹配会漏扫导致徽章/去重失效。
    const skillEntry = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'skill.md');
    if (skillEntry) {
      const path = join(dir, skillEntry.name);
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
