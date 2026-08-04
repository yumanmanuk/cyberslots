/**
 * DotMenu — ⋯ 触发的小型下拉菜单（Sidebar 会话行 / ChatView 标题共用）。
 * 支持危险项二次确认：首次点击变确认态（图标换勾 + 换文案），再点才执行。
 * 可选 footer 分区：常规项之下加分隔线渲染自定义内容（如「用外部
 * 程序打开」的 OpenInList），回调收到 close 供选中后收起菜单。
 */

import { useEffect, useRef, useState } from 'react';
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
  align = 'right',
}: {
  items: DotMenuItem[];
  /** true = 平时隐藏、父级 .group hover 才显（侧栏行内用）；false = 常驻可见（标题栏用）。 */
  hoverReveal?: boolean;
  /** 菜单底部附加分区（分隔线之下）；参数为关闭菜单的回调。 */
  footer?: (close: () => void) => React.ReactNode;
  /** 水平对齐：right=菜单右缘对齐按钮（默认，行尾按钮用）；left=菜单左缘对齐按钮——
      按钮靠近主区左缘时用，否则菜单向左越出 <main> 被其 overflow-clip 裁掉。 */
  align?: 'left' | 'right';
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // 记录当前处于确认态的项（按 label 区分）；关菜单即重置。
  const [confirming, setConfirming] = useState<string | null>(null);
  // 触发按钮 ref：菜单用 fixed 定位，脱离侧栏 overflow-y 滚动容器的裁剪
  // （absolute 会在容器下缘被切掉底部菜单项）；fixed 包含块是视口
  // （同 RightDock 的 dropAt / OpenInRail 的技巧）。
  const btnRef = useRef<HTMLButtonElement>(null);
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
  // 下拉锚点：贴按钮下缘；下方剩余空间不足（< 160px）且上方更宽裕时向上弹出，
  // 避免菜单越出窗口下缘。max-h 仍留 70vh 兜底（超长列表内部滚动）。
  const dropStyle = (): React.CSSProperties => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return {};
    const below = window.innerHeight - r.bottom;
    const up = below < 160 && r.top > below;
    return {
      position: 'fixed',
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      ...(align === 'left' ? { left: r.left } : { right: Math.max(8, window.innerWidth - r.right) }),
    };
  };
  return (
    <div className="relative">
      <button
        ref={btnRef}
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
          <div style={dropStyle()} className="z-20 max-h-[70vh] w-44 overflow-y-auto rounded-xl border border-line bg-bg-input py-1 shadow-lg">
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
