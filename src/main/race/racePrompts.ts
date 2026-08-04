/**
 * Race prompt builders — pure functions that compose the instruction text
 * for each stage. Kept separate from the orchestrator (control flow) so the
 * wording is testable and tweakable in isolation. No engine/Electron deps.
 */

import type { RaceAdoptStrategy, RaceRole } from '@shared/race';
import { L } from '../i18n';

/**
 * Read-only guard for engines without a usable read-only sandbox
 * (kimi / antigravity — 两者在赛马里以 auto 自动批准跑，靠本护栏兑底).
 * Codex/opencode/omp racers run in `plan` mode instead and don't need this.
 */
export const READONLY_GUARD =
  '【只读约束】本轮只做分析与规划，严禁修改、创建或删除任何文件（包括把方案/报告写成 .md 等文档），也不要执行有副作用的命令。完整内容必须直接作为回复正文输出，不得以「见某文件」代替。';

/** Prepend the read-only guard for kimi/agy read-only roles. */
export function withGuard(text: string, needsGuard: boolean): string {
  return needsGuard ? `${READONLY_GUARD}\n\n${text}` : text;
}

/** ① Planning: each racer plans the task independently (blind, parallel). */
export function planPrompt(task: string): string {
  return [
    '你正在参加一场"方案赛马"：请针对下面的任务，独立产出一份**简洁、可执行的实施方案**。',
    '要求：分点列出关键步骤；标注风险与回滚考量；不要写代码，只给方案。',
    '交卷方式：完整方案直接作为回复正文输出；不要写入任何文件，也不要只给文件路径或「见报告」式的摘要。',
    '',
    '【任务】',
    task,
  ].join('\n');
}

/**
 * ② Rebuttal round (plans frozen), three sections with distinct object
 * ownership: 驳（攻·对手方案）/ 吸纳（取·对手之长，声明而非改稿）/
 * 辩护（守·自己方案的争议点，预防性）。
 */
export function rebuttalPrompt(ownPlan: string, opponents: Array<{ label: string; plan: string }>): string {
  const oppBlocks = opponents.map((o) => `【选手 ${o.label} 的方案】\n${o.plan}`).join('\n\n');
  return [
    `这是其余 ${opponents.length} 位对手针对同一任务给出的方案。请做三件事，**不要修改你自己的方案正文**：`,
    '',
    '## ⚔ 反驳（只谈对手方案的内容）',
    '逐个指出各对手方案的具体缺陷、风险或遗漏，按选手分节。',
    '',
    '## 🤝 吸纳（对手方案中确实比你更优的点）',
    '如有，明确承认，并说明「若最终按你的方案实施，你会如何吸纳该点」；',
    '只列真正重要、能实质提升方案的点，不要为了显得全面而堆砌，避免把方案越吸越复杂（过度设计）；',
    '没有就写“无”——不许为了显得客观而硬凑。',
    '',
    '## 🛡 辩护（只谈你自己方案中的设计点）',
    '预判对手可能对你方案的质疑，对容易被误读或看似激进的设计做出澄清与理由说明。',
    '',
    '语言精炼，分条陈述；完整内容直接作为回复正文输出，不要写入任何文件。',
    '',
    oppBlocks,
    '',
    `【你自己的方案（供参考，勿改）】\n${ownPlan}`,
  ].join('\n');
}

/**
 * ③ Judge plan synthesis —— the USER picks the adoption strategy first
 * (adopt X / prefer X, plus an optional comment); the judge then produces
 * ONE final plan under that directive. Supports 2–3 racers.
 */
function adoptDirective(strategy: string): string {
  const norm = strategy === 'aOverB' ? 'preferA' : strategy === 'bOverA' ? 'preferB' : strategy;
  const who = norm.endsWith('A') ? 'A' : norm.endsWith('B') ? 'B' : 'C';
  return norm.startsWith('adopt')
    ? `用户已决定【采纳选手 ${who} 的方案】：请以 ${who} 方案为最终方案，仅做必要的整理与完善（吸收其辩护中的澄清），不引入其他选手的方案结构。`
    : `用户已决定【以选手 ${who} 为准，结合其余】：请以 ${who} 方案为主体框架，融入其他选手方案中经得起反驳的优点。`;
}

export interface JudgeRacerInput {
  label: string;
  plan: string;
  rebuttal: string;
}

export function judgeFusePrompt(
  task: string,
  racers: JudgeRacerInput[],
  strategy: RaceAdoptStrategy,
  comment?: string,
  eliminated?: string[],
): string {
  const sections = racers
    .map((r) => `【选手 ${r.label} 方案】\n${r.plan}\n【选手 ${r.label} 的反驳/吸纳/辩护】\n${r.rebuttal}`)
    .join('\n\n');
  return [
    '你是这场方案赛马的裁判。用户已阅过各方方案与反驳/吸纳/辩护并做出采纳决策，你的职责是**严格按用户的决策产出一份最终方案**。',
    adoptDirective(strategy),
    '各选手「吸纳」节中互相认可的共识点视为高置信度设计，在符合用户决策的前提下优先纳入。',
    '**你不是又一位选手**：除融合所必需的粘合设计外，禁止引入任何选手方案与吸纳声明之外的新设计；所有裁判自己补充的设计必须在溯源表中显式标注。',
    ...(eliminated?.length
      ? [`（选手 ${eliminated.join('、')} 已被用户剔除：其方案不在输入中，其余选手反驳中针对其的内容请忽略，不作为融合输入）`]
      : []),
    ...(comment ? ['', `【用户评语（出方案时必须遵从的指导意见）】\n${comment}`] : []),
    '',
    '请输出三个部分（标题固定）：',
    '一、最终方案：分点、可执行，作为后续实施依据；正文保持干净，不要混入来源标注；',
    '二、设计溯源（表格）：| 设计点 | 来源 | 说明 |',
    '   · 粒度为主要设计点（章节/步骤级），每个主要设计点都必须入表，不许遗漏；',
    `   · 来源只能是：选手 X ／ 共识（多位选手一致或互相吸纳）／ 裁判补充；`,
    '   · 「裁判补充」仅限融合所必需的粘合设计，必须在说明列解释为什么缺它不行；',
    '三、取舍说明：对照用户决策，说明舍弃了哪些点及原因。',
    '',
    `【任务】\n${task}`,
    '',
    sections,
  ].join('\n');
}

/** ③b Judge revision: revise the current final plan per user annotation.
 *  修订后溯源表必须同步维护；因批注产生的改动来源标「用户批注」。 */
export function judgeRevisePrompt(currentPlan: string, annotation: string): string {
  return [
    '用户对你上一版最终方案提出了批注。请据此**修订最终方案**，保留仍然有效的部分，只改动批注涉及处，并简要说明改了什么。',
    '输出仍保持三段式（一、最终方案 / 二、设计溯源 / 三、取舍说明）：溯源表同步更新，',
    '因本次批注新增或改动的设计点，来源标为「用户批注」；未变动的设计点保留原来源。',
    '',
    `【用户批注】\n${annotation}`,
    '',
    `【当前最终方案】\n${currentPlan}`,
  ].join('\n');
}

/** ④ Builder: implement the finalized plan (this role writes to disk). */
export function builderPrompt(finalPlan: string): string {
  return [
    '请严格按照下面这份**最终方案**在当前工作区实施改动。逐项完成，保持改动聚焦、可回滚。',
    '',
    '【最终方案】',
    finalPlan,
  ].join('\n');
}

/**
 * ⑤ Audit: independent review of the builder's diff. The auditor must end
 * its reply with a machine-readable verdict line so the orchestrator can
 * branch pass/fail deterministically.
 */
export function auditPrompt(finalPlan: string, diffDigest: string): string {
  return [
    '你是独立审计员。请对照【最终方案】审查下面的【改动摘要】，判断实现是否正确、完整、无越权写入与明显风险。',
    '',
    '在回复的**最后一行**，必须输出且只输出以下两种裁决之一（供程序解析）：',
    '`VERDICT: PASS` 或 `VERDICT: FAIL`',
    '若为 FAIL，请在裁决行之前用条目列出必须修复的问题。',
    '',
    `【最终方案】\n${finalPlan}`,
    '',
    `【改动摘要】\n${diffDigest}`,
  ].join('\n');
}

/** ⑥ Repair: feed audit issues back to the builder for another pass. */
export function repairPrompt(issues: string[]): string {
  return [
    '审计未通过。请针对下列问题**修复你上一步的实现**，仅改动相关处：',
    ...issues.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n');
}

/** 中断后的断点续接（agy 会话保留 conversation_id，模型带着原上下文接着
 *  跑）。提醒交卷口径，防模型在断点处跑偏成闲聊。仅用于竞速选手（规划/
 *  反驳阶段）— 这些阶段的产物本就要求直接作为正文输出。 */
export function continuePrompt(): string {
  return L(
    '刚才中断了，请从中断点继续并交卷（完整内容直接作为回复正文输出，不要写入任何文件）。',
    'Interrupted earlier. Please resume from where you stopped, then finish and hand in (output the full content as your reply body — do not write to any file).',
  );
}

/**
 * Parse the auditor's reply into a verdict. Looks for the machine-readable
 * `VERDICT: PASS/FAIL` line; falls back to keyword heuristics.
 */
export function parseAuditVerdict(transcript: string): { passed: boolean; issues: string[] } {
  const text = transcript.trim();
  const m = /VERDICT:\s*(PASS|FAIL)/i.exec(text);
  const passed = m ? m[1]!.toUpperCase() === 'PASS' : /审计通过|通过审计|no issues/i.test(text);
  const issues: string[] = [];
  if (!passed) {
    for (const line of text.split('\n')) {
      const item = line.replace(/^\s*(?:[-*·]|\d+[.)、])\s*/, '').trim();
      if (item && !/VERDICT:/i.test(line) && item.length > 4) issues.push(item);
    }
  }
  return { passed, issues: issues.slice(0, 10) };
}

/** Title shown in the sidebar/session list for a race role session. */
export function roleSessionTitle(role: RaceRole, racePrompt: string): string {
  const head = racePrompt.slice(0, 16);
  const tag: Record<RaceRole, string> = {
    racerA: '🏇A',
    racerB: '🏇B',
    racerC: '🏇C',
    judge: L('⚖裁判', '⚖Judge'),
    builder: L('🔨执行', '🔨Build'),
    auditor: L('🛡审计', '🛡Audit'),
  };
  return `${tag[role]} · ${head}`;
}
