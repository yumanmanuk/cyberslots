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

import type { ChatSelection, CodeSelection, TerminalSelection } from '@shared/types';

/** 单个选区注入内容的字符上限（Claude Code maxSelectionLength 同款）。 */
export const MAX_SELECTION_CHARS = 2000;

/** 终端选区判别：没有文件路径/行号，用 termId 字段区分。 */
export function isTerminalSelection(sel: ChatSelection): sel is TerminalSelection {
  return 'termId' in sel;
}

/** 卡片上的行号标签：单行 `#L460`，跨行 `#L460-467`。 */
export function selectionRangeLabel(sel: Pick<CodeSelection, 'startLine' | 'endLine'>): string {
  return sel.endLine > sel.startLine ? `#L${sel.startLine}-${sel.endLine}` : `#L${sel.startLine}`;
}

/** 选区覆盖的行数（终端选区按快照换行数计）。 */
export function selectionLineCount(sel: ChatSelection): number {
  if (isTerminalSelection(sel)) {
    const lines = sel.text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
    return lines.length || 1;
  }
  return sel.endLine - sel.startLine + 1;
}

/** 超长快照截到最后一个不超上限的完整行（文件/终端选区共用）。 */
function truncateSelection(text: string, totalLines: number, readHint: string): { code: string; note: string } {
  if (text.length <= MAX_SELECTION_CHARS) return { code: text, note: '' };
  const cut = text.slice(0, MAX_SELECTION_CHARS);
  const lastNl = cut.lastIndexOf('\n');
  const code = cut.slice(0, lastNl > 0 ? lastNl : MAX_SELECTION_CHARS);
  const shown = code.split('\n').length;
  return { code, note: `\n… (已截断：仅显示前 ${shown} / ${totalLines} 行；${readHint})` };
}

/** 把选区引用序列化为 prompt 前置块（上下文在前、提问在后）。 */
export function serializeSelections(sels?: ChatSelection[]): string {
  if (!sels?.length) return '';
  const blocks = sels.map((s) => {
    if (isTerminalSelection(s)) return serializeTerminalSelection(s);
    const lang = s.ext || 'text';
    const totalLines = s.endLine - s.startLine + 1;
    const { code, note } = truncateSelection(
      s.text.replace(/\r\n/g, '\n').replace(/\s+$/, ''),
      totalLines,
      '剩余内容请用 read 工具按路径+行号读取',
    );
    return `<selection path="${s.path}" lines="${s.startLine}-${s.endLine}">\n\`\`\`${lang}\n${code}\n\`\`\`${note}\n</selection>`;
  });
  const hasTerminal = sels.some(isTerminalSelection);
  const intro = hasTerminal
    ? '用户引用了以下内容（来自文件预览或内嵌终端，为添加时的快照；如需选区外的更多上下文，可用 read 工具读取文件，或直接在终端重新执行命令获取完整输出）：\n\n'
    : '用户引用了以下代码选区（来自文件预览，内容为添加时的快照；如需选区外的更多上下文，可用 read 工具按 path 与行号读取该文件）：\n\n';
  return `${intro}${blocks.join('\n\n')}\n\n`;
}

/** 终端选区序列化：cwd 给出处，快照按纯文本 code block 注入。 */
function serializeTerminalSelection(sel: TerminalSelection): string {
  const totalLines = selectionLineCount(sel);
  const { code, note } = truncateSelection(
    sel.text.replace(/\r\n/g, '\n').replace(/\s+$/, ''),
    totalLines,
    '如需完整输出，请在终端重新执行命令',
  );
  return `<terminal cwd="${sel.cwd}">\n\`\`\`text\n${code}\n\`\`\`${note}\n</terminal>`;
}
