/**
 * SlashMenu — 斜线命令补全弹层（Codex 桌面版同款交互）。
 *
 * 触发：输入框内容仅为 `/token`（以 / 开头、无空格无换行）时由 Composer
 * 唤起；随输入实时过滤候选。↑↓ 选择、Enter/Tab 插入触发词、Esc 关闭。
 * 候选项 = 引擎全局 + 项目级的 skills / commands（主进程目录扫描），
 * 按 命令组 → 技能组 分区展示，行尾徽章标 全局/项目 来源。
 */

import { Package, SquareSlash } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { SlashItem } from '@shared/ipc';
import { useT } from '../i18n';

interface Props {
  /** 已过滤 + 排序的展示列表（命令组在前，技能组在后）。 */
  items: SlashItem[];
  /** 当前激活行下标（父组件已按列表长度钳制）。 */
  active: number;
  onActiveChange: (i: number) => void;
  onPick: (item: SlashItem) => void;
}

export default function SlashMenu({ items, active, onActiveChange, onPick }: Props): JSX.Element {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);

  // 键盘导航越出可视区时滚动跟随激活行。
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // 分组标题在 kind 边界处插入（父组件保证同 kind 连续）。
  let lastKind: SlashItem['kind'] | null = null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-2xl border border-line bg-bg-input shadow-lg">
      <div ref={listRef} className="no-scrollbar max-h-72 overflow-y-auto py-1">
        {items.length === 0 && <div className="px-3 py-2 text-ui text-ink-faint">{t('slashNoMatch')}</div>}
        {items.map((item, i) => {
          const showHeader = item.kind !== lastKind;
          lastKind = item.kind;
          return (
            <div key={`${item.kind}:${item.name}`}>
              {showHeader && (
                <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-ink-faint">
                  {item.kind === 'command' ? t('slashCommands') : t('slashSkills')}
                </div>
              )}
              <button
                data-idx={i}
                title={item.path}
                onMouseEnter={() => onActiveChange(i)}
                onClick={() => onPick(item)}
                className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition ${
                  i === active ? 'bg-bg-hover' : ''
                }`}
              >
                <span className="shrink-0 text-ink-faint">
                  {item.kind === 'skill' ? <Package size={14} /> : <SquareSlash size={14} />}
                </span>
                <span className="shrink-0 text-ui font-medium text-ink">/{item.name}</span>
                <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-ink-faint">
                  {item.description}
                </span>
                <span className="shrink-0 rounded-md border border-line px-1.5 py-px text-[10px] text-ink-faint">
                  {item.scope === 'global' ? t('slashGlobal') : t('slashProject')}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      <div className="border-t border-line px-3 py-1 text-[10.5px] text-ink-faint">{t('slashHint')}</div>
    </div>
  );
}
