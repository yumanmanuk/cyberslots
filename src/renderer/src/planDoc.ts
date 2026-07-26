/**
 * planDoc utils — shared by the plan preview card (MessageItem) and the
 * right-side PlanDocPanel. Kept outside components so Vite Fast Refresh
 * stays happy (components-only exports rule).
 */

export function extractPlanTitle(text: string): string | undefined {
  const m = text.match(/^#+\s+(.+)$/m);
  return m?.[1]?.trim();
}

export function downloadMarkdown(title: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'plan'}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
