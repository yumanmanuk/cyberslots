/**
 * Race prompt builders — pure functions that compose the instruction text
 * for each stage. Kept separate from the orchestrator (control flow) so the
 * wording is testable and tweakable in isolation. No engine/Electron deps.
 */

import type { RaceAdoptStrategy, RaceRole } from '@shared/race';

/**
 * Read-only guard for engines without a read-only sandbox mode (kimi).
 * Codex/opencode racers run in `plan` mode instead and don't need this.
 */
export const READONLY_GUARD =
  '【只读约束】本轮只做分析与规划，严禁修改、创建或删除任何文件，也不要执行有副作用的命令。仅输出文字。';

/** Prepend the read-only guard for kimi read-only roles. */
export function withGuard(text: string, needsGuard: boolean): string {
  return needsGuard ? `${READONLY_GUARD}\n\n${text}` : text;
}

/** ① Planning: each racer plans the task independently (blind, parallel). */
export function planPrompt(task: string): string {
  return [
    '你正在参加一场"方案赛马"：请针对下面的任务，独立产出一份**简洁、可执行的实施方案**。',
    '要求：分点列出关键步骤；标注风险与回滚考量；不要写代码，只给方案。',
    '',
    '【任务】',
    task,
  ].join('\n');
}

/**
 * ② Rebuttal + defense (plans frozen): the racer sees the opponent's plan,
 * critiques it, and defends its own — one symmetric round, no plan changes.
 */
export function rebuttalPrompt(ownPlan: string, opponentPlan: string): string {
  return [
    '这是对手针对同一任务给出的方案。请做两件事，**不要修改你自己的方案**：',
    '1. ⚔ 反驳：指出对手方案的具体缺陷、风险或遗漏；',
    '2. 🛡 辩护：针对对手可能对你方案的质疑，做出澄清或说明。',
    '语言精炼，分条陈述。',
    '',
    '【对手方案】',
    opponentPlan,
    '',
    '【你自己的方案（供参考，勿改）】',
    ownPlan,
  ].join('\n');
}

/**
 * ③ Judge plan synthesis —— the USER picks the adoption strategy first
 * (adopt A / adopt B / A-over-B / B-over-A, plus an optional comment); the
 * judge then produces ONE final plan under that directive, with the fusion
 * basis explained. NOT a free "pick your own winner" judgement.
 */
const ADOPT_DIRECTIVES: Record<RaceAdoptStrategy, string> = {
  adoptA:
    '用户已决定【采纳选手 A 的方案】：请以 A 方案为最终方案，仅做必要的整理与完善（吸收其辩护中的澄清），不引入 B 的方案结构。',
  adoptB:
    '用户已决定【采纳选手 B 的方案】：请以 B 方案为最终方案，仅做必要的整理与完善（吸收其辩护中的澄清），不引入 A 的方案结构。',
  aOverB:
    '用户已决定【以 A 为准，结合 B】：请以 A 方案为主体框架，融入 B 方案中经得起反驳的优点。',
  bOverA:
    '用户已决定【以 B 为准，结合 A】：请以 B 方案为主体框架，融入 A 方案中经得起反驳的优点。',
};

export function judgeFusePrompt(
  task: string,
  planA: string,
  planB: string,
  rebuttalA: string,
  rebuttalB: string,
  strategy: RaceAdoptStrategy,
  comment?: string,
): string {
  return [
    '你是这场方案赛马的裁判。用户已阅过双方方案与反驳/辩护并做出采纳决策，你的职责是**严格按用户的决策产出一份最终方案**。',
    ADOPT_DIRECTIVES[strategy],
    ...(comment ? ['', `【用户评语（出方案时必须遵从的指导意见）】\n${comment}`] : []),
    '',
    '请输出：',
    '一、最终方案（分点、可执行，作为后续实施依据）；',
    '二、采纳说明（对照用户决策，说明保留/融入/舍弃了什么及原因）。',
    '',
    `【任务】\n${task}`,
    '',
    `【选手 A 方案】\n${planA}`,
    `【选手 A 的反驳/辩护】\n${rebuttalA}`,
    '',
    `【选手 B 方案】\n${planB}`,
    `【选手 B 的反驳/辩护】\n${rebuttalB}`,
  ].join('\n');
}

/** ③b Judge revision: revise the current final plan per user annotation. */
export function judgeRevisePrompt(currentPlan: string, annotation: string): string {
  return [
    '用户对你上一版最终方案提出了批注。请据此**修订最终方案**，保留仍然有效的部分，只改动批注涉及处，并简要说明改了什么。',
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
    judge: '⚖裁判',
    builder: '🔨执行',
    auditor: '🛡审计',
  };
  return `${tag[role]} · ${head}`;
}
