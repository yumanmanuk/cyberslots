/**
 * Slash probe — slashService 扫描/可见性/发送侧路由的无引擎回归验证。
 * 用 esbuild 打包 src/main/slash/slashService.ts（engineConfigs 打桩为
 * 环境变量），在 .dev/fx-slash 下构造全引擎 fixture 目录后断言：
 *   - 项目级 git 根上溯（cwd 深埋子目录仍命中 git 根的 .claude/.agents）；
 *   - claude 不显示 generic(.agents) 技能（2.1.220 实测不加载）；
 *   - kimi 不显示 codex 技能（0.31.0 ACP 实测不读 ~/.codex/skills）、
 *     平铺 *.md 技能、不下钻 . 开头目录；
 *   - opencode 单数 skill/command 目录、~/.opencode 根、无名技能隐藏、
 *     子目录命令 sub/cmd 名；
 *   - omp 扫描项全隐藏、推送项回贴来源（skill:X → 技能来源）；
 *   - routeSlashPrompt：claude/kimi 原生透传；opencode command/skill 都
 *     走 command 端点；codex skill 原生 {type:'skill'}、prompts 模板展开。
 *
 * Usage: node scripts/probe-slash.mjs
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const esbuild = require('esbuild');

const FX = path.join(ROOT, '.dev', 'fx-slash');
const HOME_DIR = path.join(FX, 'home');
const PROJ = path.join(FX, 'proj');
const CWD = path.join(PROJ, 'sub', 'deeper');

// ---------- fixtures ----------
function w(rel, content) {
  const p = path.join(FX, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}
fs.rmSync(FX, { recursive: true, force: true });
const skill = (name, desc) => '---\nname: ' + name + '\ndescription: ' + desc + '\n---\nbody\n';
w('home/.codex/skills/cskill/SKILL.md', skill('cskill', 'codex skill'));
w('home/.codex/skills/.system/sysskill/SKILL.md', skill('sysskill', 'codex system skill'));
w('home/.codex/prompts/myprompt.md', '---\ndescription: my prompt\n---\ndo $ARGUMENTS\n');
w('home/.kimi-code/skills/kskill/SKILL.md', skill('kskill', 'kimi skill'));
w('home/.kimi-code/skills/flat.md', skill('flatskill', 'kimi flat md skill'));
w('home/.kimi-code/skills/noname.md', 'plain body no frontmatter\n');
w('home/.kimi-code/skills/.hidden/hskill/SKILL.md', skill('hskill', 'hidden dir skill'));
w('home/.config/opencode/skill/single/SKILL.md', skill('single', 'oc singular'));
w('home/.config/opencode/skills/plural/SKILL.md', skill('plural', 'oc plural'));
w('home/.config/opencode/skills/noname/SKILL.md', '---\ndescription: no name here\n---\nx\n');
w('home/.opencode/skill/homesingle/SKILL.md', skill('homesingle', 'oc home alt'));
w('home/.config/opencode/commands/oc.md', '---\ndescription: oc cmd\n---\noc body\n');
w('home/.config/opencode/commands/sub/oc2.md', '---\ndescription: oc nested cmd\n---\noc2 body\n');
w('home/.claude/skills/clskill/SKILL.md', skill('clskill', 'claude skill'));
w('home/.claude/commands/ns/cmd.md', '---\ndescription: claude ns cmd\n---\nns body\n');
w('home/.agents/skills/gskill/SKILL.md', skill('gskill', 'generic skill'));
fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true });
w('proj/.claude/skills/projcl/SKILL.md', skill('projcl', 'project claude skill'));
w('proj/.agents/skills/projgen/SKILL.md', skill('projgen', 'project generic skill'));
w('proj/.opencode/command/projcmd.md', '---\ndescription: project oc cmd\n---\npb\n');
// kimi 只认 git 根单级：rootkimi 可见；proj/sub 是中间层（cwd=proj/sub/deeper），
// midkimi / midgen 对 kimi 是幽灵（但 codex/opencode 逐级加载 → 可见）。
w('proj/.kimi-code/skills/rootkimi/SKILL.md', skill('rootkimi', 'git-root kimi skill'));
w('proj/sub/.kimi-code/skills/midkimi/SKILL.md', skill('midkimi', 'mid-level kimi skill'));
w('proj/sub/.agents/skills/midgen/SKILL.md', skill('midgen', 'mid-level generic skill'));
fs.mkdirSync(CWD, { recursive: true });

// ---------- env（须在 import 被打包模块前设置）----------
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = HOME_DIR;
process.env.CODEX_HOME = path.join(HOME_DIR, '.codex');
process.env.KIMI_CODE_HOME = path.join(HOME_DIR, '.kimi-code');

// ---------- bundle slashService（engineConfigs 打桩，脱离 electron 依赖链）----------
const stub = path.join(FX, 'stub-engineConfigs.js');
fs.writeFileSync(stub, 'export const codexHomeDir=()=>process.env.CODEX_HOME;export const kimiHomeDir=()=>process.env.KIMI_CODE_HOME;', 'utf8');
const out = path.join(FX, 'slashService.bundle.mjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main/slash/slashService.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
  plugins: [{ name: 'stub', setup(b) {
    b.onResolve({ filter: /config\/engineConfigs$/ }, () => ({ path: stub }));
  } }],
});
const svc = await import('file:///' + out.replace(/\\/g, '/'));

// ---------- assertions ----------
let pass = 0, fail = 0;
const fails = [];
function ok(cond, label) { if (cond) pass++; else { fail++; fails.push(label); } }
const names = (items, kind) => items.filter(i => !kind || i.kind === kind).map(i => i.name).sort();

const claude = await svc.listSlashItems(CWD, 'claude');
ok(names(claude, 'skill').join(',') === 'clskill,projcl', 'claude skills = clskill,projcl (got: ' + names(claude,'skill') + ')');
ok(names(claude, 'command').join(',') === 'ns:cmd', 'claude commands = ns:cmd (got: ' + names(claude,'command') + ')');

const codex = await svc.listSlashItems(CWD, 'codex');
ok(names(codex, 'skill').join(',') === 'cskill,gskill,midgen,projgen,sysskill', 'codex skills incl .system+generic chain (got: ' + names(codex,'skill') + ')');
ok(names(codex, 'command').join(',') === 'myprompt', 'codex commands = myprompt (got: ' + names(codex,'command') + ')');

const kimi = await svc.listSlashItems(CWD, 'kimi');
ok(names(kimi, 'skill').join(',') === 'flatskill,gskill,kskill,noname,projgen,rootkimi', 'kimi skills incl flat md + git-root generic, excl codex/hidden (got: ' + names(kimi,'skill') + ')');
ok(!names(kimi).includes('hskill'), 'kimi must NOT descend .hidden');
ok(!names(kimi).includes('cskill'), 'kimi must NOT see codex skills');
ok(!names(kimi).includes('midkimi'), 'kimi must NOT see mid-level .kimi-code skills (git-root only)');
ok(!names(kimi).includes('midgen'), 'kimi must NOT see mid-level generic skills (git-root only)');

const oc = await svc.listSlashItems(CWD, 'opencode');
ok(names(oc, 'skill').join(',') === 'gskill,homesingle,midgen,plural,projgen,single', 'opencode skills incl singular+home-alt+chain, excl unnamed (got: ' + names(oc,'skill') + ')');
ok(names(oc, 'command').join(',') === 'oc,projcmd,sub/oc2', 'opencode commands incl nested sub/oc2 + project singular (got: ' + names(oc,'command') + ')');

// omp：扫描项全隐藏，推送项回贴来源
const omp = await svc.listSlashItems(CWD, 'omp', [
  { name: 'skill:cskill', description: '' },
  { name: 'help', description: 'show help' },
  { name: 'flatskill', description: '' },
]);
ok(omp.length === 3, 'omp shows only pushed (got ' + omp.length + ')');
const ocSkill = omp.find(i => i.name === 'skill:cskill');
ok(ocSkill && ocSkill.kind === 'skill' && ocSkill.engine === 'codex' && ocSkill.scope === 'global' && ocSkill.description === 'codex skill', 'omp skill:cskill enriched from codex scan (got ' + JSON.stringify(ocSkill) + ')');
const oHelp = omp.find(i => i.name === 'help');
ok(oHelp && oHelp.kind === 'builtin' && oHelp.description === 'show help', 'omp unknown pushed = builtin');
const oFlat = omp.find(i => i.name === 'flatskill');
ok(oFlat && oFlat.kind === 'skill' && oFlat.engine === 'kimi', 'omp bare flatskill matched to kimi skill');

// kimi 推送 skill:kskill 与已展示扫描项同源去重
const kimi2 = await svc.listSlashItems(CWD, 'kimi', [{ name: 'skill:kskill', description: '' }, { name: 'skill:other', description: 'o' }]);
ok(names(kimi2, 'skill').filter(n => n === 'kskill').length === 1, 'kimi kskill single entry (got ' + names(kimi2,'skill') + ')');
ok(!names(kimi2).includes('skill:kskill'), 'kimi pushed skill:kskill deduped');
ok(names(kimi2).includes('skill:other'), 'kimi pushed skill:other kept as builtin entry');

// ---------- routeSlashPrompt ----------
const r1 = await svc.routeSlashPrompt(CWD, 'claude', '/ns:cmd x');
ok(r1 === null, 'claude native → null');
const r2 = await svc.routeSlashPrompt(CWD, 'opencode', '/oc arg1');
ok(r2 && r2.type === 'command' && r2.name === 'oc' && r2.args === 'arg1' && r2.path && r2.path.endsWith('oc.md'), 'opencode /oc → command route with path (got ' + JSON.stringify(r2) + ')');
const r3 = await svc.routeSlashPrompt(CWD, 'opencode', '/sub/oc2');
ok(r3 && r3.type === 'command' && r3.name === 'sub/oc2', 'opencode nested command name with slash (got ' + JSON.stringify(r3) + ')');
const r4 = await svc.routeSlashPrompt(CWD, 'opencode', '/single hi');
ok(r4 && r4.type === 'command' && r4.name === 'single' && r4.skill === true && r4.path && r4.path.endsWith('SKILL.md'), 'opencode skill → command route with path+skill flag (got ' + JSON.stringify(r4) + ')');
const r5 = await svc.routeSlashPrompt(CWD, 'codex', '/cskill do it');
ok(r5 && r5.type === 'skill' && r5.name === 'cskill' && r5.path.endsWith('SKILL.md') && r5.args === 'do it', 'codex skill → native skill route (got ' + JSON.stringify(r5) + ')');
const r6 = await svc.routeSlashPrompt(CWD, 'codex', '/myprompt a b');
ok(r6 && r6.type === 'text' && r6.text === 'do a b', 'codex prompt template expand (got ' + JSON.stringify(r6) + ')');
const r7 = await svc.routeSlashPrompt(CWD, 'codex', '/nosuch');
ok(r7 === null, 'unknown → null passthrough');
const r8 = await svc.routeSlashPrompt(CWD, 'kimi', '/kskill');
ok(r8 === null, 'kimi native → null');

console.log('[probe-slash] PASS', pass, 'FAIL', fail);
if (fails.length) { console.log('FAILURES:'); for (const f of fails) console.log(' -', f); process.exit(1); }