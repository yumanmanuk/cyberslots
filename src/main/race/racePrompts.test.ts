/**
 * racePrompts 纯函数单测：审计问题解析（必须修复小节提取，防表格/标题
 * 挤掉真实条目）与最终方案完整性门槛（防「状态声明/占位符」交付）。
 */
import { describe, expect, it } from 'vitest';

import { finalPlanProblems, judgePlanFixPrompt, parseAuditVerdict } from './racePrompts';

describe('parseAuditVerdict', () => {
  it('只提取「必须修复的问题」小节内的条目，忽略表格与标题', () => {
    const transcript = [
      '## 审计报告',
      '### 审查项',
      '| 维度 | 结果 | 说明 |',
      '|------|------|------|',
      '| 方案可审计性 | ❌ | 仅为状态声明 |',
      '| 完整性 | ❌ 无法判定 | 无方案内容 |',
      '### 必须修复的问题',
      '1. **最终方案不是方案。** 提供的内容不包含任何可审计的规格。',
      '2. **零改动与「已完成」矛盾。** 需提供改动摘要或说明为何无需改动。',
      '3. **缺少原始计划文件。** 需提供 local://<slug>-plan.md 的全文。',
      'VERDICT: FAIL',
    ].join('\n');
    const verdict = parseAuditVerdict(transcript);
    expect(verdict.passed).toBe(false);
    expect(verdict.issues).toHaveLength(3);
    expect(verdict.issues[0]).toContain('最终方案不是方案');
    expect(verdict.issues[1]).toContain('零改动');
    expect(verdict.issues[2]).toContain('原始计划文件');
    expect(verdict.issues.some((i) => i.startsWith('|') || i.startsWith('#') || i.includes('审查项'))).toBe(false);
  });

  it('支持英文小节标题与列表', () => {
    const transcript = [
      '## Audit report',
      '### Must-fix issues',
      '- The final plan is not a plan: no goals, steps, or acceptance criteria.',
      '- Zero changes contradict the completion claim.',
      'VERDICT: FAIL',
    ].join('\n');
    const verdict = parseAuditVerdict(transcript);
    expect(verdict.passed).toBe(false);
    expect(verdict.issues).toHaveLength(2);
    expect(verdict.issues[0]).toContain('not a plan');
    expect(verdict.issues[1]).toContain('Zero changes');
  });

  it('无小节标题时兜底提取全文列表行，仍跳过表格行', () => {
    const transcript = [
      '整体评估如下：',
      '| 维度 | 结果 |',
      '|------|------|',
      '| 完整性 | ❌ |',
      '- issue one',
      '- issue two',
      'VERDICT: FAIL',
    ].join('\n');
    const verdict = parseAuditVerdict(transcript);
    expect(verdict.issues).toEqual(['issue one', 'issue two']);
  });

  it('重复条目去重；PASS 时无问题列表', () => {
    const failed = parseAuditVerdict('### 必须修复的问题\n- 同一问题需要补充完整方案内容\n- 同一问题需要补充完整方案内容\nVERDICT: FAIL');
    expect(failed.issues).toEqual(['同一问题需要补充完整方案内容']);
    const passed = parseAuditVerdict('一切符合要求。\nVERDICT: PASS');
    expect(passed.passed).toBe(true);
    expect(passed.issues).toEqual([]);
  });
});

describe('finalPlanProblems', () => {
  it('拦截空方案与状态声明占位符', () => {
    expect(finalPlanProblems('')).not.toEqual([]);
    expect(finalPlanProblems(undefined)).not.toEqual([]);
    expect(finalPlanProblems('已完成。计划已通过 `xd://propose` 提交并获批，所有待办项清零。')).not.toEqual([]);
    expect(finalPlanProblems('Done. The plan was approved via xd://propose and all todos are cleared.')).not.toEqual([]);
  });

  it('拦截过短且无结构的文本', () => {
    expect(finalPlanProblems('随便一句话，没有任何实施内容。')).not.toEqual([]);
  });

  it('放行含目标/步骤/验收标准的结构化方案', () => {
    const zh = [
      '## 目标',
      '解决多会话卡顿问题，事件流按帧合批。',
      '## 实施步骤',
      '1. 主进程 forward() 增加 16ms 合批队列；',
      '2. 渲染端 foldMessage 改为尾部追加；',
      '3. 异步原子写盘（tmp + rename）；',
      '4. noteActivity 200ms 节流；',
      '5. MessageItem 加 React.memo。',
      '## 验收标准',
      '3 个并发会话长文本流式输出时 Long Tasks < 3/秒，消息文件不损坏；',
      '8 个会话并发时侧栏 lastActivity 更新频率不超过 5 次/秒。',
      '## 风险与回滚',
      '节流可回退；原子写用 tmp+rename；并发池限制可通过设置调整。',
    ].join('\n');
    expect(finalPlanProblems(zh)).toEqual([]);

    const en = [
      '## Goal',
      'Fix multi-session stalls by batching the event stream per frame.',
      '## Approach',
      '- Add a 16ms batching queue in SessionManager.forward().',
      '- Make foldMessage append in O(1).',
      '- Write files asynchronously with atomic rename.',
      '## Verification',
      'With 3 concurrent sessions, long tasks stay below 3/s.',
    ].join('\n');
    expect(finalPlanProblems(en)).toEqual([]);
  });

  it('judgePlanFixPrompt 会回传不可审计原因与输出要求', () => {
    const prompt = judgePlanFixPrompt('已完成。', ['最终方案过短（4 字）']);
    expect(prompt).toContain('最终方案过短（4 字）');
    expect(prompt).toContain('禁止只写状态声明');
  });
});
