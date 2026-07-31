/**
 * DotMenu — ⋯ 触发的小型下拉菜单（Sidebar 会话行 / ChatView 标题共用）。
 * 支持危险项二次确认：首次点击变确认态（图标换勾 + 换文案），再点才执行。
 * 可选 footer 分区：常规项之下加分隔线渲染自定义内容（如「用外部
 * 程序打开」的 OpenInList），回调收到 close 供选中后收起菜单。
 */

import { useEffect, useState } from 'react';
import { Check, MoreHorizontal } from 'lucide-react';

export interface DotMenuItem {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  /** 需二次确认：首次点击变确认态（图标换勾 + 换文案），再点才执行。 */
  confirmLabel?: string;
  onClick: () => void;
}

export default function DotMenu({
  items,
  hoverReveal = true,
  footer,
}: {
  items: DotMenuItem[];
  /** true = 平时隐藏、父级 .group hover 才显（侧栏行内用）；false = 常驻可见（标题栏用）。 */
  hoverReveal?: boolean;
  /** 菜单底部附加分区（分隔线之下）；参数为关闭菜单的回调。 */
  footer?: (close: () => void) => React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // 记录当前处于确认态的项（按 label 区分）；关菜单即重置。
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const close = (): void => {
    setOpen(false);
    setConfirming(null);
  };
  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else setOpen(true);
        }}
        className={`rounded-md p-1 text-ink-faint transition hover:bg-bg-active hover:text-ink ${
          hoverReveal ? 'opacity-0 group-hover:opacity-100' : ''
        }`}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute right-0 top-7 z-20 max-h-[70vh] w-44 overflow-y-auto rounded-xl border border-line bg-bg-input py-1 shadow-lg">
            {items.map((item) => {
              const inConfirm = item.confirmLabel != null && confirming === item.label;
              return (
                <button
                  key={item.label}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (item.confirmLabel && !inConfirm) {
                      setConfirming(item.label);
                      return;
                    }
                    close();
                    item.onClick();
                  }}
                  onMouseLeave={() => {
                    if (inConfirm) setConfirming(null);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui transition ${item.disabled
                    ? 'cursor-not-allowed text-ink-faint/50'
                    : inConfirm
                      ? 'bg-warn/15 text-warn'
                      : `hover:bg-bg-hover ${item.danger ? 'text-err' : 'text-ink'}`
                    }`}
                >
                  {inConfirm ? <Check size={13} /> : item.icon} {inConfirm ? item.confirmLabel : item.label}
                </button>
              );
            })}
            {footer && <div className="mt-1 border-t border-line pt-1">{footer(close)}</div>}
          </div>
        </>
      )}
    </div>
  );
}
