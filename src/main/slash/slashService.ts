/**
 * slashService — 斜线命令候选扫描：引擎全局目录 + 会话项目目录。
 *
 * 扫描约定（全部只读、目录不存在即跳过）：
 * - Skills（目录内含 SKILL.md，frontmatter 取 name/description；kimi 根顶层
 *   平铺 *.md 也算技能 — kimi scanner.ts 特性）：
 *     全局  ~/.codex/skills（含 .system 内置缓存）、~/.kimi-code/skills、
 *           ~/.config/opencode/{skill,skills}、~/.opencode/{skill,skills}、
 *           ~/.claude/skills、~/.agents/skills
 *     项目  <各级项目目录>/.codex/skills、.kimi-code/skills、
 *           .opencode/{skill,skills}、.claude/skills、.agents/skills
 * - Commands（递归匹配 *.md；子目录名拼入触发名 — claude 冒号命名空间
 *   `ns:cmd`（2.1.220 实测），opencode 路径形式 `sub/cmd`（源码
 *   configEntryNameFromPath）；取 frontmatter description 或首个有效行）：
 *     全局  ~/.codex/prompts（遗留 — 现行 codex 已移除 prompts 命令并迁移为
 *           source-command 技能，此处客户端模板展开为其续命）、
 *           ~/.claude/commands、~/.config/opencode/{command,commands}、
 *           ~/.opencode/{command,commands}
 *     项目  <各级项目目录>/.codex/prompts、.claude/commands、
 *           .opencode/{command,commands}
 *
 * 项目目录基准（逐引擎考证，2026-08-03 复核）：
 * - claude 逐级加载（2.1.220 实测：git 根/中间层/cwd 三级的 .claude/commands
 *   全进 slash_commands；git 根之上的非 git 父目录不加载）；
 * - codex 逐级（load_project_layers 对 git 根→cwd 每个含 .codex 的祖先建
 *   Project 层；.agents/skills 走 dirs_between_project_root_and_cwd）；
 * - opencode 逐级（skill fsys.up start:directory stop:worktree）；
 * - kimi 仅 git 根单级（scanner.ts findProjectRoot 单根，PROJECT_BRAND_DIRS
 *   / PROJECT_GENERIC_DIRS 都锚定该根）→ 中间层对 kimi 是幽灵，特例收窄。
 * 统一实现 = git 根 → cwd 每一级（无 git 根仅 cwd），近 cwd 者优先去重；
 * kimi（含 kimi 会话的 generic 项）在扫描/可见性两层收窄到 git 根。
 *
 * 可见性（以引擎实测/源码为准，勿凭猜测放行 — 幽灵入口点击即报错）：
 * - 本引擎目录：恒可见；
 * - generic（.agents/skills）：codex/kimi/opencode/omp 均加载（各家源码），
 *   claude 2.1.220 实测全局/项目级都不加载 → claude 会话隐藏；
 * - omp（聚合引擎）：展示完全靠引擎推送 — omp 技能只认 /skill:name 形式，
 *   裸名扫描项点击不触发；本地扫描仍全量进行，供推送项来源回贴；
 * - kimi 不读 ~/.codex/skills（0.31.0 ACP 实测；源码中仅迁移技能文档提及）
 *   → 不再有跨引擎可见特例；
 * - opencode 不注册无 frontmatter name 的 SKILL.md（源码 isSkillFrontmatter）
 *   → 无名技能（目录名兜底项）对 opencode 隐藏。
 * 同名同类去重：项目级优先于全局（覆盖语义）；多级项目目录近 cwd 者优先。
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { SlashItem } from '@shared/ipc';
import type { EngineId, SlashCommandInfo } from '@shared/types';
import { codexHomeDir, kimiHomeDir } from '../config/engineConfigs';

/** 不再下钻的资源目录名（skill 包内的附属目录，不是子 skill）。 */
const SKIP_DESCEND = new Set(['references', 'scripts', 'assets', 'node_modules']);
/** 下钻深度上限 — 覆盖 <root>/<name>/SKILL.md 与 <root>/.system/<name>/SKILL.md，
 *  及命令的 commands/ns/cmd.md 一层命名空间。 */
const MAX_DEPTH = 2;
/** 项目级目录链级数上限（git 根 → cwd 通常 1-3 级，防御过深嵌套拖慢扫描）。 */
const MAX_PROJECT_LEVELS = 6;

interface Root {
  dir: string;
  engine: SlashItem['engine'];
  scope: SlashItem['scope'];
}

/**
 * 项目级扫描目录链：git 根 → cwd 每一级，**按离 cwd 由近到远返回**（scanAll
 * first-seen 去重时近者优先）。无 git 根时仅 cwd（claude 2.1.220 实测：非
 * git 父目录的 .claude 不被加载；kimi findProjectRoot 无 .git 退回 cwd）。
 */
function projectDirs(cwd: string): string[] {
  const chain: string[] = [];
  let cur = cwd;
  for (let i = 0; i < 64; i++) {
    chain.unshift(cur);
    if (existsSync(join(cur, '.git'))) break; // .git 可为文件（worktree/submodule）
    const parent = dirname(cur);
    if (parent === cur) return [cwd];
    cur = parent;
  }
  return chain.reverse().slice(0, MAX_PROJECT_LEVELS);
}

function scanRoots(cwd: string): { skills: Root[]; commands: Root[] } {
  const codexHome = codexHomeDir();
  const kimiHome = kimiHomeDir();
  const ocHome = join(homedir(), '.config', 'opencode');
  // opencode home 级配置目录（源码 config/paths.ts 的 ~/.opencode 上溯项）。
  const ocHomeAlt = join(homedir(), '.opencode');
  const claudeHome = join(homedir(), '.claude');
  const skills: Root[] = [
    { dir: join(codexHome, 'skills'), engine: 'codex', scope: 'global' },
    { dir: join(kimiHome, 'skills'), engine: 'kimi', scope: 'global' },
    // opencode 单复数都扫（源码 OPENCODE_SKILL_PATTERN = "{skill,skills}"）。
    { dir: join(ocHome, 'skills'), engine: 'opencode', scope: 'global' },
    { dir: join(ocHome, 'skill'), engine: 'opencode', scope: 'global' },
    { dir: join(ocHomeAlt, 'skills'), engine: 'opencode', scope: 'global' },
    { dir: join(ocHomeAlt, 'skill'), engine: 'opencode', scope: 'global' },
    { dir: join(claudeHome, 'skills'), engine: 'claude', scope: 'global' },
    { dir: join(homedir(), '.agents', 'skills'), engine: 'generic', scope: 'global' },
  ];
  const commands: Root[] = [
    { dir: join(codexHome, 'prompts'), engine: 'codex', scope: 'global' },
    // opencode 两种拼写都扫（commands 现行 / command 历史）。
    { dir: join(ocHome, 'commands'), engine: 'opencode', scope: 'global' },
    { dir: join(ocHome, 'command'), engine: 'opencode', scope: 'global' },
    { dir: join(ocHomeAlt, 'commands'), engine: 'opencode', scope: 'global' },
    { dir: join(ocHomeAlt, 'command'), engine: 'opencode', scope: 'global' },
    { dir: join(claudeHome, 'commands'), engine: 'claude', scope: 'global' },
  ];
  if (cwd) {
    // 项目级：git 根 → cwd 每一级（近 cwd 者排前，first-seen 去重近者优先）。
    const dirs = projectDirs(cwd);
    const gitRoot = dirs[dirs.length - 1]!; // 链尾 = git 根（无 git 根时 = cwd）
    for (const dir of dirs) {
      skills.push(
        { dir: join(dir, '.codex', 'skills'), engine: 'codex', scope: 'project' },
        // kimi 项目技能只认 git 根单级（scanner.ts findProjectRoot 单根，
        // PROJECT_BRAND_DIRS 锚定该根）——中间层的 .kimi-code/skills 引擎
        // 不加载，扫了就是幽灵入口。
        ...(dir === gitRoot
          ? [{ dir: join(dir, '.kimi-code', 'skills'), engine: 'kimi', scope: 'project' } as Root]
          : []),
        { dir: join(dir, '.opencode', 'skills'), engine: 'opencode', scope: 'project' },
        { dir: join(dir, '.opencode', 'skill'), engine: 'opencode', scope: 'project' },
        { dir: join(dir, '.claude', 'skills'), engine: 'claude', scope: 'project' },
        { dir: join(dir, '.agents', 'skills'), engine: 'generic', scope: 'project' },
      );
      commands.push(
        { dir: join(dir, '.codex', 'prompts'), engine: 'codex', scope: 'project' },
        { dir: join(dir, '.opencode', 'commands'), engine: 'opencode', scope: 'project' },
        { dir: join(dir, '.opencode', 'command'), engine: 'opencode', scope: 'project' },
        { dir: join(dir, '.claude', 'commands'), engine: 'claude', scope: 'project' },
      );
    }
  }
  return { skills, commands };
}

/**
 * 引擎可见性 —— 以引擎实测/源码为准（幽灵入口 = 点击即 Unknown command）：
 * - 本引擎目录恒可见；
 * - generic（.agents/skills）：claude 2.1.220 实测不加载 → claude 隐藏；
 *   kimi 项目级 generic 只加载 git 根单级（scanner.ts PROJECT_GENERIC_DIRS
 *   锚定 findProjectRoot）→ kimi 会话隐藏中间层 generic；
 * - omp 聚合引擎：扫描项全隐藏（技能只认引擎推送的 /skill:name 形式；
 *   命令 omp 也自行聚合推送）——扫描仅用于推送项的来源回贴；
 * - opencode 不注册无 frontmatter name 的技能 → 无名项隐藏。
 */
function visible(item: SlashItem, engine: EngineId, gitRoot?: string): boolean {
  if (engine === 'omp') return false;
  if (item.unnamed && item.kind === 'skill' && engine === 'opencode') return false;
  if (item.engine === 'generic') {
    if (engine === 'claude') return false;
    if (engine === 'kimi' && item.scope === 'project' && gitRoot) {
      return item.path.startsWith(join(gitRoot, '.agents', 'skills'));
    }
    return true;
  }
  return item.engine === engine;
}

export async function listSlashItems(
  cwd: string,
  engine: EngineId,
  pushed?: SlashCommandInfo[],
): Promise<SlashItem[]> {
  const all = await scanAll(cwd);
  // kimi 的项目级 generic 收窄需要 git 根基准（visible 第三参）。
  const dirs = cwd ? projectDirs(cwd) : [];
  const gitRoot = dirs[dirs.length - 1];
  // 可见展示列表：本会话引擎 + generic；同名同类去重（项目级覆盖全局）。
  const seen = new Set<string>();
  const out: SlashItem[] = [];
  for (const item of all) {
    if (!visible(item, engine, gitRoot)) continue;
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
 * 保留推送原名（含 `skill:` 前缀）—引擎按此原生解析。
 * 去重：与已展示扫描项同名、或 `skill:X` 与已展示技能 X 同源（kimi ACP
 * 推送 skill:X 与本地扫描 X 会双入口）则跳过 — 扫描项信息更全。
 */
function appendEnrichedPushed(
  out: SlashItem[],
  all: SlashItem[],
  pushed: SlashCommandInfo[],
  engine: EngineId,
): void {
  const shown = new Set(out.map((i) => i.name.toLowerCase()));
  // 已展示技能 X 同时覆盖推送别名 skill:X（同源去重，防双入口）。
  for (const i of out) {
    if (i.kind === 'skill') shown.add(`skill:${i.name.toLowerCase()}`);
  }
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

export type SlashRoute =
  | { type: 'text'; text: string }
  // path/skill 供 opencode 服务端清单缺项时客户端展开兜底（adapter.command）。
  | { type: 'command'; name: string; args: string; path?: string; skill?: boolean }
  | { type: 'skill'; name: string; path: string; args: string };

/** 引擎自带斜杠文本解析的通道 — 透传即可：claude CLI 原生解析（2.1.220
 *  实测 stream-json 下命令模板展开 / 技能激活均生效）；kimi ACP（内置命令
 *  + skill:name 引擎侧解析）与 KAP（适配器拦截走 :activate）；omp ACP 同。 */
const NATIVE_SLASH_ENGINES = new Set<EngineId>(['claude', 'kimi', 'omp']);

/**
 * 发送侧斜杠路由 — 引擎侧不解析斜杠文本时由客户端补齐执行语义：
 * - opencode command → 原生 POST /session/{id}/command（调用方走 adapter.command）；
 * - opencode skill → 同样走 command 端点（opencode 把技能聚合为服务端命令，
 *   模板 = 技能全文 + base dir 提示，且有权限门 — 优于客户端文本展开）；
 * - codex skill → {type:'skill'} 原生注入（app-server v2，core 直读 SKILL.md
 *   全文注入，与 TUI $mention 等效 — 免「读文件」指令的一跳工具调用）；
 * - command（codex/antigravity，遗留 prompts 目录）→ 读 md 模板客户端展开
 *   （$ARGUMENTS / $1..$9）；
 * - skill（antigravity）→ 展开为「读技能文件并执行」指令；
 * - 未知名字 → null 原样透传（用户笔误或引擎私有命令）。
 */
export async function routeSlashPrompt(cwd: string, engine: EngineId, text: string): Promise<SlashRoute | null> {
  if (NATIVE_SLASH_ENGINES.has(engine)) return null;
  // 名字字符类含 '/'（opencode 子路径命令 sub/cmd）与 ':'（claude 命名空间）。
  const m = /^\/([A-Za-z0-9][\w:./-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const args = (m[2] ?? '').trim();
  const items = await listSlashItems(cwd, engine);
  const item = items.find((it) => it.name.toLowerCase() === name);
  if (!item) return null;
  if (item.kind === 'command') {
    if (engine === 'opencode') return { type: 'command', name: item.name, args, path: item.path };
    return { type: 'text', text: substituteArgs(await readCommandBody(item.path), args) };
  }
  if (item.kind !== 'skill') return null;
  if (engine === 'opencode') return { type: 'command', name: item.name, args, path: item.path, skill: true };
  if (engine === 'codex') return { type: 'skill', name: item.name, path: item.path, args };
  // antigravity：通用激活指令 — 与 TUI 侧的斜杠展开等效（模型自行读 SKILL.md）。
  return {
    type: 'text',
    text: [
      `请读取技能文件 ${item.path}，严格按其中的说明执行任务。`,
      args ? `任务输入：${args}` : '（无附加输入，按技能默认流程执行。）',
    ].join('\n'),
  };
}

/** 读命令模板全文并剥 frontmatter（listSlashItems 只读文件头取描述，此处要全文）。
 *  导出给 OpencodeAdapter 的服务端缺项兜底展开共用。 */
export async function readCommandBody(path: string): Promise<string> {
  const raw = (await readFile(path, 'utf8')).replace(/^﻿/, '');
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return (fm ? raw.slice(fm[0].length) : raw).trim();
}

/** 参数代入：$ARGUMENTS 整串、$1..$9 空白分词；模板无占位符且带参时追加到末尾。
 *  导出给 OpencodeAdapter 的服务端缺项兜底展开共用。 */
export function substituteArgs(body: string, args: string): string {
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
  async function walk(dir: string, depth: number, top: boolean): Promise<void> {
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
        // 无 frontmatter name（目录名兜底）— opencode 不注册此类技能（隐藏用）。
        ...(meta.name ? {} : { unnamed: true }),
      });
      return;
    }
    // kimi 根顶层平铺 .md 技能（<root>/foo.md — kimi scanner.ts 特性；深层
    //  .md 是技能负载如 references/foo.md，不是技能）。
    if (top && root.engine === 'kimi') {
      for (const e of entries) {
        if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
        const path = join(dir, e.name);
        const meta = await parseSkillMd(path);
        out.push({
          name: meta.name ?? e.name.replace(/\.md$/i, ''),
          description: meta.description,
          kind: 'skill',
          scope: root.scope,
          engine: root.engine,
          path,
          ...(meta.name ? {} : { unnamed: true }),
        });
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DESCEND.has(e.name)) continue;
      // 隐藏目录只下钻 codex 根的 .system（codex 内置技能缓存）；kimi 等引擎
      // 自身跳过 . 开头目录（kimi scanner），下钻会误显引擎不认的技能。
      if (e.name.startsWith('.') && !(e.name === '.system' && root.engine === 'codex')) continue;
      await walk(join(dir, e.name), depth + 1, false);
    }
  }
  if (existsSync(root.dir)) await walk(root.dir, 0, true);
  return out;
}

/** 递归扫描 **​/*.md 命令文件（子目录名拼入触发名：claude 冒号命名空间
 *  `ns:cmd`（2.1.220 实测），其余引擎路径形式 `sub/cmd`（opencode 源码
 *  configEntryNameFromPath 剥前缀后保留子路径）。 */
async function scanCommands(root: Root): Promise<SlashItem[]> {
  const out: SlashItem[] = [];
  async function walk(dir: string, rel: string[], depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || depth >= MAX_DEPTH) continue;
        await walk(join(dir, e.name), [...rel, e.name], depth + 1);
        continue;
      }
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
      const path = join(dir, e.name);
      const parts = [...rel, e.name.replace(/\.md$/i, '')];
      out.push({
        name: root.engine === 'claude' ? parts.join(':') : parts.join('/'),
        description: await parseCommandDesc(path),
        kind: 'command',
        scope: root.scope,
        engine: root.engine,
        path,
      });
    }
  }
  if (existsSync(root.dir)) await walk(root.dir, [], 0);
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
    return (await readFile(path, 'utf8')).replace(/^﻿/, '').slice(0, cap);
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