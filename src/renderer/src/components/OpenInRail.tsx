/**
 * OpenInRail / OpenInList — 「用外部程序打开」入口，复用主进程已就绪的
 * openIn(target, path)（VS Code / 文件管理器 / Git Bash / Antigravity）。
 * 菜单主体 OpenInList：
 *   - 单文件夹（普通项目）：直接平铺 4 个工具，点一下打开该目录。
 *   - 多文件夹 workspace：按文件夹分组，每组一个小标题（primary 徽标 +
 *     完整路径 tooltip）下列全部工具 —— 一次点击直达指定文件夹。
 *
 * OpenInRail：ChatView 右侧图标 rail 的按钮，菜单向左弹出，用 fixed 定位
 * 规避祖先 overflow 裁剪（同 RightDock 的 dropAt 技巧）。
 * 侧栏 workspace/project 行不再有独立入口，OpenInList 作为 DotMenu 的
 * footer 分区并入「⋯」菜单（见 Sidebar）。
 */

import { useEffect, useRef, useState } from 'react';
import { Code2, ExternalLink, FolderGit2, FolderOpen, Orbit } from 'lucide-react';

import type { OpenerId, OpenTarget } from '@shared/ipc';
import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';

/** 打开目标（含图标）— 与 FilePreview 的 OpenInMenu 选型对齐，另加 Antigravity。
 *  explorer 的显示名走 i18n（fileManager），渲染处按 labelKey 查译文。 */
const OPEN_TARGETS = [
  { id: 'vscode' as const, labelKey: null, label: 'VS Code', icon: Code2 },
  { id: 'explorer' as const, labelKey: 'fileManager' as const, label: '', icon: FolderOpen },
  { id: 'gitbash' as const, labelKey: null, label: 'Git Bash', icon: FolderGit2 },
  { id: 'antigravity' as const, labelKey: null, label: 'Antigravity', icon: Orbit },
] satisfies Array<{ id: OpenTarget; labelKey: 'fileManager' | null; label: string; icon: typeof Code2 }>;

/** explorer/wt/terminal 系统自带、无需检测；其余（OpenerId）按本机可用性过滤。 */
function needsDetect(id: OpenTarget): id is OpenerId {
  return id === 'vscode' || id === 'cursor' || id === 'antigravity' || id === 'gitbash';
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Esc 关闭下拉。 */
function useEscClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

/**
 * 菜单主体：工具 × 文件夹。单文件夹平铺工具；多文件夹按文件夹分组，
 * 每组标题为文件夹名（primary 徽标 + 完整路径 tooltip）。
 * OpenInRail 与 Sidebar 的 DotMenu footer 共用。
 */
export function OpenInList({ folders, onPick }: { folders: string[]; onPick?: () => void }): JSX.Element {
  const t = useT();
  const avail = useChatStore((s) => s.openerAvailability);
  // 未探测（null）先全显；探测后隐藏未安装的（explorer 系统自带，永远保留）。
  const targets = OPEN_TARGETS.filter((tg) => !needsDetect(tg.id) || !avail || avail[tg.id]);
  const openAt = (target: OpenTarget, folder: string): void => {
    onPick?.();
    void window.cyberslots.openIn(target, folder);
  };
  if (folders.length <= 1) {
    const folder = folders[0] ?? '';
    return (
      <>
        {targets.map((tg) => (
          <MenuItem key={tg.id} icon={tg.icon} label={tg.labelKey ? t(tg.labelKey) : tg.label} onClick={() => openAt(tg.id, folder)} />
        ))}
      </>
    );
  }
  return (
    <>
      {folders.map((folder, i) => (
        <div key={folder} className={i > 0 ? 'mt-1 border-t border-line pt-1' : undefined}>
          <div
            title={folder}
            className="flex items-center gap-1.5 px-3 pb-1 pt-1 text-[10.5px] tracking-wide text-ink-faint"
          >
            <span className="min-w-0 truncate">{basename(folder)}</span>
            {i === 0 && (
              <span className="shrink-0 rounded border border-line px-1 text-[9px] text-ink-faint">
                {t('primaryFolder')}
              </span>
            )}
          </div>
          {targets.map((tg) => (
            <MenuItem key={tg.id} icon={tg.icon} label={tg.labelKey ? t(tg.labelKey) : tg.label} onClick={() => openAt(tg.id, folder)} />
          ))}
        </div>
      ))}
    </>
  );
}

/** ChatView 图标 rail 的「用外部程序打开」按钮；菜单向左弹出。 */
export default function OpenInRail({ folders, active }: { folders: string[]; active?: boolean }): JSX.Element | null {
  const t = useT();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEscClose(open, () => setOpen(false));

  if (folders.length === 0) return null;

  // 下拉锚点：rail 在最右列且外层 overflow-clip，absolute 会被裁切；
  // fixed 的包含块是视口，向左展开（right 贴 rail 左缘）。
  const dropStyle = (): React.CSSProperties => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return {};
    return { position: 'fixed', top: r.top, right: Math.max(8, window.innerWidth - r.left + 6) };
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        title={t('railOpenIn')}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
          active || open ? 'bg-accent-soft text-accent' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
        }`}
      >
        <ExternalLink size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            style={dropStyle()}
            className="z-20 max-h-[70vh] min-w-48 overflow-y-auto rounded-lg border border-line bg-bg-input py-1 shadow-lg"
          >
            <OpenInList folders={folders} onPick={() => setOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Code2;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink transition hover:bg-bg-hover"
    >
      <Icon size={15} className="shrink-0 text-ink-soft" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
