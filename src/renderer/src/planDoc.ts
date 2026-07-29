/**
 * planDoc utils — shared by the plan preview card (MessageItem) and the
 * right-side PlanDocPanel. Kept outside components so Vite Fast Refresh
 * stays happy (components-only exports rule).
 */

export function extractPlanTitle(text: string): string | undefined {
  const m = text.match(/^#+\s+(.+)$/m);
  if (m?.[1]) return m[1].trim();
  // 无 md 标题时取首个有意义的文本行兜底（剥掉列表/引用/加粗等记号），
  // 避免下载文件名回落成千篇一律的「计划文档」。
  const line = text
    .split('\n')
    .map((l) => l.replace(/^[\s>*\-+•]+|^\d+[.、)]\s*/g, '').replace(/[*_`#]/g, '').trim())
    .find((l) => l.length >= 4);
  return line ? line.slice(0, 30) : undefined;
}

export function downloadMarkdown(title: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // 文件名 = 标题 + 时间戳，重复下载/同名计划不会互相覆盖。
  const pad = (n: number): string => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60).trim() || 'plan';
  a.download = `${safe}_${stamp}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
