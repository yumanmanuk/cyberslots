/**
 * SelectionChip —— 「添加到对话」选区引用的统一卡片外观。
 * Composer（可移除）与历史气泡（只读）共用。
 *
 * 卡片只是句柄：类型徽标 + 文件名 + 行号范围；真正的 payload
 * （代码快照 + 绝对路径）藏在 sel 里。点击卡片展开快照预览浮层
 * （opencode/VS Code 悬停预览同款：卡片背后的内容对用户可检查）。
 */

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';

import type { CodeSelection } from '@shared/types';
import { MAX_SELECTION_CHARS, selectionRangeLabel } from '../selections';

interface Props {
  sel: CodeSelection;
  /** 传了就显示 ×（Composer 待发送状态）；不传 = 只读（历史气泡）。 */
  onRemove?: () => void;
}

export default function SelectionChip({ sel, onRemove }: Props): JSX.Element {
  const lineCount = sel.endLine - sel.startLine + 1;
  const [preview, setPreview] = useState(false);
  /** 发送时将被截断（快照超过注入上限）→ 卡片上给个小标记。 */
  const willTruncate = sel.text.length > MAX_SELECTION_CHARS;
  return (
    <span className="relative">
      <span
        role="button"
        tabIndex={0}
        title={`${sel.path}\n${lineCount} 行${willTruncate ? '\n超出注入上限，发送时截断' : ''}`}
        onClick={() => setPreview((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setPreview((v) => !v);
        }}
        className="inline-flex max-w-64 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-bg-panel px-2 py-1 text-[11.5px] transition hover:bg-bg-hover"
      >
        {sel.ext && <span className="shrink-0 font-mono text-[10px] font-semibold uppercase text-accent">{sel.ext}</span>}
        <span className="min-w-0 truncate font-medium text-ink">{sel.fileName}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">{selectionRangeLabel(sel)}</span>
        {willTruncate && <span className="shrink-0 text-[10px] text-warn">截</span>}
        {onRemove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="shrink-0 rounded-md text-ink-faint transition hover:text-ink"
          >
            <X size={11} />
          </button>
        )}
      </span>
      {preview && <SelectionPreview sel={sel} onClose={() => setPreview(false)} />}
    </span>
  );
}

/** 快照预览浮层：带行号的只读代码（不高亮，速度优先）；
 *  点外侧/Escape 关闭。 */
function SelectionPreview({ sel, onClose }: { sel: CodeSelection; onClose: () => void }): JSX.Element {
  const lines = useMemo(() => {
    // 统一换行并去掉尾部空行（与旧 replace 链等价）。
    const arr = sel.text.split(/\r?\n/);
    while (arr.length > 1 && arr[arr.length - 1] === '') arr.pop();
    return arr;
  }, [sel.text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const gutterWidth = String(sel.endLine).length;
  return (
    <>
      <div className="fixed inset-0 z-30 cursor-default" onClick={onClose} />
      <div className="absolute left-0 top-full z-40 mt-1.5 w-[440px] max-w-[82vw] overflow-hidden rounded-xl border border-line bg-bg-input shadow-xl">
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-soft" title={sel.path}>
            {sel.path}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">{selectionRangeLabel(sel)}</span>
        </div>
        <div className="flex max-h-60 overflow-auto py-1.5 font-mono text-[11px] leading-[1.45]">
          <div className="select-none px-2 text-right text-ink-faint/60" style={{ minWidth: `${gutterWidth + 2}ch` }}>
            {lines.map((_, i) => (
              <div key={i}>{sel.startLine + i}</div>
            ))}
          </div>
          <pre className="flex-1 whitespace-pre px-2 text-ink">{lines.join('\n')}</pre>
        </div>
      </div>
    </>
  );
}
