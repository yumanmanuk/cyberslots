/**
 * Race prompt builders — pure functions that compose the instruction text
 * for each stage. Kept separate from the orchestrator (control flow) so the
 * wording is testable and tweakable in isolation. No engine/Electron deps.
 */

import type { RaceAdoptStrategy, RacePreJudgeRecommendation, RaceRole } from '@shared/race';
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
    '输出纪律：最终方案正文必须是一份完整、可执行的方案，包含目标、分点实施步骤与验收标准；',
    '禁止只写「已完成」「已通过 xd://propose 审批」「待办清零」之类的状态声明，禁止以「见某文件」或外部审批代替方案正文；',
    '即使你把方案写入了文件或发起了审批，仍必须把完整方案正文原样贴回「一、最终方案」。',
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
    '修订后的最终方案正文仍需完整、可审计（含目标、分点步骤与验收标准），禁止只写状态声明或指向外部文件。',
    '',
    `【用户批注】\n${annotation}`,
    '',
    `【当前最终方案】\n${currentPlan}`,
  ].join('\n');
}

/** 裁判产出的方案不可审计时，自动重出一次的纠正提示词。 */
export function judgePlanFixPrompt(plan: string, problems: string[]): string {
  return [
    '你上一版产出的最终方案不可审计，原因如下：',
    ...problems.map((p, i) => `${i + 1}. ${p}`),
    '',
    '请重新产出完整的最终方案正文（仍按三段式：一、最终方案 / 二、设计溯源 / 三、取舍说明），必须包含：',
    '- 目标与任务范围；',
    '- 分点、可执行的实施步骤（标注涉及文件/模块）；',
    '- 验收标准或验证方法；',
    '- 风险与回滚考量。',
    '禁止只写状态声明（如「已完成」「已通过审批」「待办清零」），禁止以文件路径或外部审批代替正文。',
    '',
    `【你上一版的最终方案（仅供你回顾，不得把占位内容照抄回来）】\n${plan}`,
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

/** ⑥ Repair: feed audit issues back to the builder for another pass. Builder
 *  必须先表态：同意就修；不同意要说明理由。REJECT_ALL 时禁止改文件，
 *  由编排器停止回合并交给用户人工介入，避免审计-修复无限拉扯。 */
export function repairPrompt(issues: string[]): string {
  return [
    '审计未通过。请先对下列问题逐条表态：同意就修复，不同意就说明技术理由。',
    '',
    '回合结束前，**最后一行必须输出且只输出以下裁决之一**（供程序解析）：',
    '`REPAIR_DECISION: ACCEPT_ALL` —— 同意全部问题并已完成对应修复；',
    '`REPAIR_DECISION: ACCEPT_PARTIAL` —— 至少同意一条并已修复对应处，其余不同意的在正文说明理由；',
    '`REPAIR_DECISION: REJECT_ALL` —— 不同意全部问题，**不要改动文件**，只输出拒绝理由并结束回合。',
    '',
    ...issues.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n');
}

/** 解析执行者对审计意见的总体态度。旧执行者没输出裁决行时按“接受并继续
 *  修复”处理，保证既有流程不回退；只有明确“全部不同意”才停下等人工。 */
export function parseRepairDecision(transcript: string): { rejectedAll: boolean } {
  const text = transcript.trim();
  const m = /REPAIR_DECISION:\s*(ACCEPT_ALL|ACCEPT_PARTIAL|REJECT_ALL)/i.exec(text);
  const decision = m?.[1]?.toUpperCase();
  if (decision === 'REJECT_ALL') return { rejectedAll: true };
  if (decision === 'ACCEPT_ALL' || decision === 'ACCEPT_PARTIAL') return { rejectedAll: false };
  return {
    rejectedAll: /全部不同意|拒绝执行|不同意全部|拒绝全部|reject\s*all|disagree\s*with\s*all/i.test(text),
  };
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

/** 执行/修复角色的断点续接：产物是文件改动，口径与 continuePrompt 相反 ——
 *  不能要求「不要写入任何文件」，而是提醒把未完成的文件改动做完再汇报。 */
export function continueBuildPrompt(): string {
  return L(
    '刚才的回合中断了，请从中断点继续完成任务（未做完的文件改动继续做完，全部完成后简要汇报改动内容）。',
    'The previous turn was interrupted. Resume from where you stopped and finish the task (complete any remaining file changes, then briefly report what changed).',
  );
}

/** 「必须修复的问题」小节标题（中英兼容，含任务卡/待办式标题）。 */
const MUST_FIX_HEADER =
  /^\s*(?:#{1,6}\s*)?(?:必须修复的问题|需要修复的问题|待修复问题|必改项|必须修复|需修复|Must[- ]fix(?:ed)?\s+(?:issues?|problems?|items?)|Issues? to fix|Required fixes?|Blocking issues?)\s*[:：]?\s*$/i;

/** Markdown 章节标题行。 */
const MD_HEADING = /^\s*#{1,6}\s/;

/** 审计正文 → 可执行问题条目：
 *  - afterHeaderOnly=true：只取「必须修复的问题」小节内的条目；
 *  - afterHeaderOnly=false（兜底）：取全文的列表行（跳过表格行/标题行）。
 *  去重后返回，单条最短 5 字符。 */
function extractAuditIssues(text: string, afterHeaderOnly: boolean): string[] {
  const issues: string[] = [];
  let capturing = !afterHeaderOnly;
  let seenHeader = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/VERDICT:\s*(PASS|FAIL)/i.test(line)) break;
    if (afterHeaderOnly) {
      if (!seenHeader) {
        if (MUST_FIX_HEADER.test(line)) {
          seenHeader = true;
          capturing = true;
        }
        continue;
      }
      // 进入下一章节（非必须修复的标题）即结束采集。
      if (MD_HEADING.test(line)) break;
    } else {
      if (MD_HEADING.test(line)) continue;
      // 兜底模式只收明确的列表条目，避免把正文段落当问题。
      if (!/^\s*(?:[-*•·]|\d+[.)、])\s/.test(line)) continue;
    }
    if (!capturing) continue;
    if (!line || line.startsWith('|')) continue; // 表格行不是问题条目
    const item = line
      .replace(/^\s*(?:[-*•·]|\d+[.)、])\s*/, '')
      .replace(/^[-*•·]\s*/, '')
      .trim();
    if (!item || item.length <= 4) continue;
    if (!issues.includes(item)) issues.push(item);
  }
  return issues;
}

/**
 * Parse the auditor's reply into a verdict. Looks for the machine-readable
 * `VERDICT: PASS/FAIL` line; falls back to keyword heuristics.
 * 问题条目只从「必须修复的问题」小节提取（缺失时兜底取全文列表行），
 * 不再把 markdown 表格/标题当成审计问题，避免挤掉真正可执行的条目。
 */
export function parseAuditVerdict(transcript: string): { passed: boolean; issues: string[]; body: string } {
  const text = transcript.trim();
  const m = /VERDICT:\s*(PASS|FAIL)/i.exec(text);
  const passed = m ? m[1]!.toUpperCase() === 'PASS' : /审计通过|通过审计|no issues/i.test(text);
  // Strip the machine-readable VERDICT line from the display body.
  const body = text.replace(/^.*VERDICT:\s*(PASS|FAIL).*$/im, '').trim();
  let issues = passed ? [] : extractAuditIssues(text, true);
  // 有「必须修复的问题」标题但小节为空/未命中 → 兜底提取全文列表行。
  if (!passed && issues.length === 0) issues = extractAuditIssues(text, false);
  return { passed, issues: issues.slice(0, 20), body };
}

/** 最终方案最小完整性门槛：防裁判把「状态声明/占位符」当成方案交付。
 *  返回不可审计原因列表；空数组 = 可审计。 */
export function finalPlanProblems(plan: string | undefined): string[] {
  const text = (plan ?? '').trim();
  const problems: string[] = [];
  if (!text) {
    problems.push('最终方案为空');
    return problems;
  }
  if (text.length < 200) {
    problems.push(`最终方案过短（${text.length} 字），疑似状态声明或占位符，不包含可实施内容`);
  }
  const statusOnly = /^\s*(?:已完成|已交付|已通过|计划已通过|完成|done|delivered|completed|approved)[^#\n]{0,160}\s*$/i.test(text);
  const hasStructure = /(?:^|\n)\s*(?:#{1,6}\s|[-*•]\s|\d+[.)、]\s)|步骤|实施|验收|目标|方案|Step|Approach|Implement|Verification|Acceptance|Goal|Plan/i.test(text);
  if (statusOnly && !hasStructure) {
    problems.push('最终方案只是一句完成状态声明（如「已完成/已交付/待办清零」），不含目标、步骤与验收标准');
  } else if (!hasStructure) {
    problems.push('最终方案缺少可执行结构：需要目标、分点实施步骤与验收标准（或 Markdown 章节/列表）');
  }
  return problems;
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
    preJudge: L('🔍初审', '🔍PreJudge'),
  };
  return `${tag[role]} · ${head}`;
}

// ---------------------------------------------------------- AI 初审 (pre-judge)

/**
 * ★ AI 初审提示词 —— 在用户选策略前，由 AI 评审各方方案并给出推荐策略。
 *  仅出"建议"不出"方案"——方案仍由裁判按用户决策产出（judgeFusePrompt）。
 *  输入与 judgeFusePrompt 同源（任务 + 各选手方案 + 反驳/吸纳/辩护），
 *  但输出为结构化 markdown（推荐策略 / 一句话结论 / 推荐理由 / 各选手点评），
 *  供弹窗展开查看。纯函数，无副作用，可独立单测。
 */
export function preJudgePrompt(
  task: string,
  racers: JudgeRacerInput[],
  eliminated?: string[],
): string {
  const sections = racers
    .map((r) => `【选手 ${r.label} 方案】\n${r.plan}\n【选手 ${r.label} 的反驳/吸纳/辩护】\n${r.rebuttal}`)
    .join('\n\n');
  return [
    '你是这场方案赛马的"初审评审员"。请阅读各方方案与反驳/吸纳/辩护，给出你推荐的采纳策略及理由。',
    '',
    '可选策略：',
    '- adoptA / adoptB / adoptC：采纳某一方方案（仅做必要整理，不引入其他选手结构）',
    '- preferA / preferB / preferC：以某方为主体框架，融合其余选手优点',
    '',
    '请在回复中严格按以下结构输出 markdown（标题固定，供程序解析）：',
    '',
    '## 推荐策略',
    '（仅一行：adoptX 或 preferX，X 为 A/B/C）',
    '',
    '## 一句话结论',
    '（≤60 字，概括推荐理由的核心）',
    '',
    '## 推荐理由',
    '（分点列出 2-4 条关键理由，说明为什么推荐该策略）',
    '',
    '## 各选手点评',
    '（按选手分节，每节 2-3 句点评其方案的优劣）',
    '',
    ...(eliminated?.length
      ? [`（选手 ${eliminated.join('、')} 已被剔除：其方案不在输入中，不作为评审对象）`]
      : []),
    '',
    `【任务】\n${task}`,
    '',
    sections,
  ].join('\n');
}

/**
 * 解析 AI 初审的 markdown 输出为结构化推荐结果。纯函数，可独立单测。
 *  - strategy：从全文查找 adoptX / preferX（不限于"## 推荐策略"节，容错）
 *  - summary：从"## 一句话结论"节提取首行
 *  - detail：原始 markdown 全文（弹窗展示用）
 *  解析失败（找不到合法策略）返回 null，由调用方降级为纯人工。
 */
export function parsePreJudgeRecommendation(transcript: string): RacePreJudgeRecommendation | null {
  const text = transcript.trim();
  // 查找首个 adoptX / preferX（容错：不限制在标题节内）
  const m = /\b(adopt|prefer)([ABC])\b/i.exec(text);
  if (!m) return null;
  const strategy = `${m[1]!.toLowerCase()}${m[2]!.toUpperCase()}` as RaceAdoptStrategy;

  // 提取"## 一句话结论"节的首行
  const summaryMatch = /##\s*一句话结论\s*\n+([^\n]+)/i.exec(text);
  const summary = summaryMatch?.[1]?.trim() ?? '';

  return {
    strategy,
    summary: summary || strategy,
    detail: text,
  };
}
