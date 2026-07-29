/**
 * 代码选区引用的序列化与显示工具。
 *
 * 「添加到对话」卡片只是句柄（handle）：界面上是 `{EXT} 文件名#L起-止`，
 * 背后真正发给模型的是 **点击那一刻的选区快照 + 出处**（绝对路径/
 * 行号范围/语言）。用快照而不是发送时重读磁盘：AI 随时可能改动
 * 文件，重读会让卡片行号与实际内容错位；带绝对路径则让模型
 * 能用工具继续读该文件获取更多上下文。
 *
 * 截断策略与 Claude Code 同款（attachments.ts · selected_lines_in_ide）：
 * 快照本体不截断（卡片行号永远与快照一致），序列化时超出
 * MAX_SELECTION_CHARS 的部分截到最后一个完整行并标注剩余内容的读取方式。
 */

import type { CodeSelection } from '@shared/types';

/** 单个选区注入内容的字符上限（Claude Code maxSelectionLength 同款）。 */
export const MAX_SELECTION_CHARS = 2000;

/** 卡片上的行号标签：单行 `#L460`，跨行 `#L460-467`。 */
export function selectionRangeLabel(sel: Pick<CodeSelection, 'startLine' | 'endLine'>): string {
  return sel.endLine > sel.startLine ? `#L${sel.startLine}-${sel.endLine}` : `#L${sel.startLine}`;
}

/** 把选区引用序列化为 prompt 前置块（上下文在前、提问在后）。 */
export function serializeSelections(sels?: CodeSelection[]): string {
  if (!sels?.length) return '';
  const blocks = sels.map((s) => {
    const lang = s.ext || 'text';
    const totalLines = s.endLine - s.startLine + 1;
    let code = s.text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    let note = '';
    if (code.length > MAX_SELECTION_CHARS) {
      // 截到最后一个不超上限的完整行，避免半行残句。
      const cut = code.slice(0, MAX_SELECTION_CHARS);
      const lastNl = cut.lastIndexOf('\n');
      code = cut.slice(0, lastNl > 0 ? lastNl : MAX_SELECTION_CHARS);
      const shown = code.split('\n').length;
      note = `\n… (已截断：仅显示前 ${shown} / ${totalLines} 行；剩余内容请用 read 工具按路径+行号读取)`;
    }
    return `<selection path="${s.path}" lines="${s.startLine}-${s.endLine}">\n\`\`\`${lang}\n${code}\n\`\`\`${note}\n</selection>`;
  });
  return `用户引用了以下代码选区（来自文件预览，内容为添加时的快照；如需选区外的更多上下文，可用 read 工具按 path 与行号读取该文件）：\n\n${blocks.join('\n\n')}\n\n`;
}
