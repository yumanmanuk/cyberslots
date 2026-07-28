/**
 * ChipInput — contenteditable 输入框，支持行内「文件引用胶囊」。
 *
 * 为什么不用 <textarea>：需求是「输入框里显示成彩色 chip，但 Ctrl+C /
 * 发送时序列化为纯文本 `文件名(路径)`」。textarea 是纯文本控件无法内嵌
 * 带样式的节点，故用 contenteditable + 自定义序列化/复制拦截。
 *
 * 设计约束（保持与 Composer 现有 text 字符串模型兼容）：
 * - value 始终是「序列化后的纯文本」（chip → `名(路径)`）；父组件的
 *   send/goal/queue 逻辑照旧读写这个字符串。
 * - chip 只由 insertFileChip（拖拽）以命令式插入，绝不从字符串反解析回
 *   chip —— 因此 value 外部变更（清空 / 回填队列消息）只作纯文本渲染。
 * - onCopy 拦截：按选区片段序列化为 `名(路径)` 写入剪贴板。
 * - onPaste 图片交父组件处理，其余强制纯文本粘贴（去格式）。
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface ChipInputHandle {
  focus(): void;
  /** 在当前光标处插入一个文件引用胶囊（显示名，序列化为 `名(路径)`）。 */
  insertFileChip(name: string, path: string): void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** 处理粘贴的图片项；返回 true 表示已消费（阻止默认粘贴）。 */
  onImagePaste?: (items: DataTransferItem[]) => boolean;
  placeholder?: string;
  className?: string;
}

/** DOM → 纯文本：chip → `名(路径)`，<br> → 换行，其余取文本。 */
function serialize(root: Node): string {
  let out = '';
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? '';
    } else if (child instanceof HTMLElement) {
      if (child.dataset.chip) {
        out += `${child.dataset.name}(${child.dataset.path})`;
      } else if (child.tagName === 'BR') {
        out += '\n';
      } else if (child.tagName === 'DIV') {
        // Chromium 偶尔用 <div> 包裹换行块。
        if (out && !out.endsWith('\n')) out += '\n';
        out += serialize(child);
      } else {
        out += serialize(child);
      }
    }
  }
  return out;
}

const ChipInput = forwardRef<ChipInputHandle, Props>(function ChipInput(
  { value, onChange, onKeyDown, onImagePaste, placeholder, className },
  ref,
) {
  const elRef = useRef<HTMLDivElement>(null);

  const syncEmpty = (): void => {
    const el = elRef.current;
    if (el) el.dataset.empty = el.textContent || el.querySelector('[data-chip]') ? 'false' : 'true';
  };

  // 外部 value 变更（清空 / 回填）→ 纯文本渲染；与当前序列化一致则不动，
  // 避免打字/插 chip 过程中被回写清掉光标。
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (serialize(el) !== value) {
      el.textContent = value;
      syncEmpty();
    }
  }, [value]);

  useImperativeHandle(ref, () => ({
    focus: () => elRef.current?.focus(),
    insertFileChip: (name, path) => {
      const el = elRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      let range: Range;
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        range = sel.getRangeAt(0);
      } else {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }
      range.deleteContents();
      const chip = document.createElement('span');
      chip.dataset.chip = '1';
      chip.dataset.name = name;
      chip.dataset.path = path;
      chip.contentEditable = 'false';
      chip.className = 'oc-file-chip';
      chip.textContent = name;
      chip.title = path;
      const space = document.createTextNode('\u00A0');
      range.insertNode(space);
      range.insertNode(chip);
      // 光标移到插入内容之后。
      range.setStartAfter(space);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
      onChange(serialize(el));
      syncEmpty();
    },
  }));

  const onInput = (): void => {
    const el = elRef.current;
    if (!el) return;
    onChange(serialize(el));
    syncEmpty();
  };

  const onCopyCut = (e: React.ClipboardEvent<HTMLDivElement>): void => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const frag = sel.getRangeAt(0).cloneContents();
    const holder = document.createElement('div');
    holder.appendChild(frag);
    e.clipboardData.setData('text/plain', serialize(holder));
    e.preventDefault();
    if (e.type === 'cut') {
      sel.getRangeAt(0).deleteContents();
      onInput();
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>): void => {
    // 图片交父组件（Composer 走临时文件 + 缩略图）。
    if (onImagePaste?.(Array.from(e.clipboardData.items))) {
      e.preventDefault();
      return;
    }
    // 其余强制纯文本粘贴（避免 contenteditable 吞入富文本格式）。
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    document.execCommand('insertText', false, text);
    onInput();
  };

  return (
    <div
      ref={elRef}
      role="textbox"
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      data-empty="true"
      data-placeholder={placeholder}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onCopy={onCopyCut}
      onCut={onCopyCut}
      className={`oc-chip-input whitespace-pre-wrap break-words outline-none ${className ?? ''}`}
    />
  );
});

export default ChipInput;
