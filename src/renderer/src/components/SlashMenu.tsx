/**
 * SlashMenu — 斜线命令补全弹层（Codex 桌面版同款交互）。
 *
 * 触发：输入框内容仅为 `/token`（以 / 开头、无空格无换行）时由 Composer
 * 唤起；随输入实时过滤候选。↑↓ 选择、Enter/Tab 插入触发词、Esc 关闭。
 * 候选项 = 引擎全局 + 项目级的 skills / commands（主进程目录扫描），
 * 另加引擎运行时推送的命令（ui.commands，builtin 组）；按
 * 命令组 → 技能组 → 引擎命令组 分区展示。行内两维正交标注：
 * 左图标 = 类别（命令/技能/引擎命令，引擎推送的 `skill:` 前缀项识别
 * 为技能）；行尾徽章 = 来源（全局/项目/引擎，带颜色与 tooltip。注：
 * 引擎推送清单无来源字段，无法区分原生内置与用户安装后被引擎加载，
 * 故统一标「引擎」而非「内置」）。
 */

import { Package, SquareSlash, Zap } from 'lucide-react';
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
          // 类别（左图标）：引擎推送项里 `skill:` 前缀是引擎侧加载的用户技能。
          const isSkill = item.kind === 'skill' || (item.kind === 'builtin' && item.name.startsWith('skill:'));
          // 来源（行尾徽章）：全局/项目 = 本地扫描到源文件；引擎 = 运行时推送。
          const badge =
            item.kind === 'builtin'
              ? { label: t('slashEngine'), tip: t('slashEngineTip'), cls: 'border-info/40 text-info' }
              : item.scope === 'global'
                ? { label: t('slashGlobal'), tip: t('slashGlobalTip'), cls: 'border-line text-ink-faint' }
                : { label: t('slashProject'), tip: t('slashProjectTip'), cls: 'border-accent/40 text-accent' };
          return (
            <div key={`${item.kind}:${item.name}`}>
              {showHeader && (
                <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-ink-faint">
                  {item.kind === 'command' ? t('slashCommands') : item.kind === 'skill' ? t('slashSkills') : t('slashEngineCommands')}
                </div>
              )}
              <button
                data-idx={i}
                title={item.path || undefined}
                onMouseEnter={() => onActiveChange(i)}
                onClick={() => onPick(item)}
                className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition ${
                  i === active ? 'bg-bg-hover' : ''
                }`}
              >
                <span className="shrink-0 text-ink-faint">
                  {isSkill ? <Package size={14} /> : item.kind === 'builtin' ? <Zap size={14} /> : <SquareSlash size={14} />}
                </span>
                <span className="shrink-0 text-ui font-medium text-ink">/{item.name}</span>
                <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-ink-faint">
                  {item.description}
                </span>
                <span title={badge.tip} className={`shrink-0 rounded-md border px-1.5 py-px text-[10px] ${badge.cls}`}>
                  {badge.label}
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
