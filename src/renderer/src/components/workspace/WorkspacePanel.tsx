/**
 * WorkspacePanel — right-hand collapsible panel (codex "Code changes"
 * style): 变更 tab aggregates per-file diffs from the tool stream with
 * +/- counts; 文件 tab is the lazy project tree. Clicking a file opens
 * a separate preview panel to the LEFT of the tree (item 9) so the
 * tree stays visible while reading code. Tab 栏已上移到 RightDock 的
 * 统一标签栏（与终端/sidechat 并列），本组件只渲染内容区。
 */

import { useEffect, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';

import type { UnifiedMessage } from '@shared/types';
import type { SessionChangeEntry } from '@shared/ipc';
import { useChatStore } from '../../store/chatStore';
import { useT } from '../../i18n';
import FileTree, { ownerRoot } from './FileTree';
import FilePreview from './FilePreview';
import DiffView from './DiffView';

interface Props {
  sessionId: string;
  /** workspace 全部根目录（首个为 primary）；普通项目为单元素。 */
  roots: string[];
  /** Controlled tab — owned by RightDock's unified tab bar. */
  tab: PanelTab;
  /** 文件树列宽 — 由 RightDock 统一管理（dock 左缘把手拖拽）。 */
  treeWidth: number;
  changes: SessionChangeEntry[];
  changesNonce: number;
  /** 接受/回退后触发变更清单重取（nonce+1，由 RightDock 持有）。 */
  onRefreshChanges: () => void;
}

export type PanelTab = 'files' | 'changes';

// 变更清单改由主进程台账（ChangeTracker）驱动，条目类型 = SessionChangeEntry。

export default function WorkspacePanel({ sessionId, roots, tab, treeWidth, changes, changesNonce, onRefreshChanges }: Props): JSX.Element {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openDiff, setOpenDiff] = useState<string | null>(null);

  // AI 正文文件 chip 点击信号：打开该文件预览并消费清除（ChatView 只负责
  // 开 files tab 不清除 — 保证点击时 dock 未挂载也能在挂载后落地）。
  const pendingPreview = useChatStore((s) => s.pendingFilePreview[sessionId]);
  useEffect(() => {
    if (!pendingPreview) return;
    setOpenDiff(null);
    setOpenFile(pendingPreview.path);
    useChatStore.setState((s) => ({ pendingFilePreview: { ...s.pendingFilePreview, [sessionId]: undefined } }));
  }, [pendingPreview, sessionId]);

  // 文件被回退/接受后从清单消失 → 关掉其 diff 视图。
  useEffect(() => {
    if (openDiff && !changes.some((c) => c.path === openDiff)) setOpenDiff(null);
  }, [changes, openDiff]);

  // 预览刷新信号：工具调用数（AI 流式编辑）+ 会话状态（回合边界，捕获
  // shell 改动）+ 回退 nonce（磁盘被写回）任一变化 → FilePreview 重读盘。
  const previewReloadKey = useChatStore((s) => {
    const msgs = s.ui[sessionId]?.messages ?? [];
    let n = 0;
    for (const m of msgs) if (m.kind === 'tool_call') n++;
    const st = s.sessions.find((x) => x.id === sessionId)?.status ?? '';
    return `${n}|${st}`;
  });

  return (
    <>
      {/* 左侧详情面板：变更行 → diff 对照；文件树 → 只读预览（树保持可见） */}
      {(openDiff || openFile) && (
        <aside className="flex w-[440px] shrink-0 animate-[sheet-in_.15s_ease-out] flex-col border-r border-line bg-bg-panel/30">
          {openDiff ? (
            <DiffView
              sessionId={sessionId}
              path={openDiff}
              nonce={changesNonce}
              onClose={() => setOpenDiff(null)}
              onRevert={() =>
                void window.cyberslots.sessionChangesRevert(sessionId, openDiff).then(() => {
                  onRefreshChanges();
                  setOpenDiff(null);
                })
              }
            />
          ) : (
            <FilePreview path={openFile!} root={ownerRoot(openFile!, roots)} sessionId={sessionId} reloadKey={`${previewReloadKey}|${changesNonce}`} onClose={() => setOpenFile(null)} />
          )}
        </aside>
      )}

      <aside className="flex shrink-0 flex-col bg-bg-panel/60" style={{ width: treeWidth }}>
        <div className="min-h-0 flex-1">
          {tab === 'files' ? (
            <FileTree roots={roots} onOpenFile={(p) => { setOpenDiff(null); setOpenFile(p); }} />
          ) : (
            <ChangesList
              changes={changes}
              sessionId={sessionId}
              onOpen={(p) => {
                setOpenFile(null);
                setOpenDiff(p);
              }}
              onRefresh={onRefreshChanges}
            />
          )}
        </div>
      </aside>
    </>
  );
}

/** 变更清单来自主进程台账（ChangeTracker）：真实基线 diff + 可回退。
 *  编辑类工具调用数变化时自动刷新；接受/回退后由 onRefresh 触发重取。
 *  由 RightDock 调用（tab 栏徽标 + 本面板共用一份数据）。 */
export function useChangedFiles(sessionId: string, nonce: number): SessionChangeEntry[] {
  const editTick = useChatStore((s) => {
    let n = 0;
    for (const m of s.ui[sessionId]?.messages ?? []) {
      if (m.kind === 'tool_call' && isEditish(m.toolKind, m.title)) n++;
    }
    return n;
  });
  const [entries, setEntries] = useState<SessionChangeEntry[]>([]);
  // 回合结束（status 变化）也要重取：shell 命令改动由主进程在 turn.ended
  // 后异步 git 扫尾登记（~百毫秒），故延迟再取一次兜底。
  const status = useChatStore((s) => s.sessions.find((x) => x.id === sessionId)?.status);
  useEffect(() => {
    let alive = true;
    const fetchNow = (): void =>
      void window.cyberslots.sessionChangesList(sessionId).then((e) => {
        if (alive) setEntries(e);
      });
    fetchNow();
    const timer = setTimeout(fetchNow, 900);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [sessionId, editTick, status, nonce]);
  return entries;
}

/** 编辑类工具（按 ACP kind 或标题动词）。主进程工具卡标题已双语，
 *  正则同时覆盖中英文动词（Edit/Write/Create/Delete/Move 含进行时）。 */
function isEditish(toolKind: string, title: string): boolean {
  if (['edit', 'write', 'delete', 'move'].includes(toolKind)) return true;
  return /^(writ(e|ing)|edit(ing)?|creat(e|ing)|delet(e|ing)|mov(e|ing)|修改|创建|删除|写入)/i.test(title);
}

const STATUS_BADGE: Record<SessionChangeEntry['status'], { label: string; cls: string }> = {
  modified: { label: 'M', cls: 'text-warn' },
  added: { label: 'A', cls: 'text-ok' },
  deleted: { label: 'D', cls: 'text-err' },
};

function ChangesList({
  changes,
  sessionId,
  onOpen,
  onRefresh,
}: {
  changes: SessionChangeEntry[];
  sessionId: string;
  onOpen: (path: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  const t = useT();
  // 全部回退是不可逆写盘，用两次点击确认（3s 自动撤销）。
  const [confirmAll, setConfirmAll] = useState(false);
  useEffect(() => {
    if (!confirmAll) return;
    const timer = setTimeout(() => setConfirmAll(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmAll]);
  // 多会话共编文件的单文件回退需二次确认（会影响其它会话的改动）。
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmPath) return;
    const timer = setTimeout(() => setConfirmPath(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmPath]);

  if (changes.length === 0) {
    return <div className="px-3 py-8 text-center text-ui text-ink-faint">{t('wsNoChanges')}</div>;
  }
  const totalAdds = changes.reduce((n, c) => n + c.adds, 0);
  const totalDels = changes.reduce((n, c) => n + c.dels, 0);
  const revert = (path?: string): void => void window.cyberslots.sessionChangesRevert(sessionId, path).then(onRefresh);
  const accept = (path?: string): void => void window.cyberslots.sessionChangesAccept(sessionId, path).then(onRefresh);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-ui">
        <span className="font-medium">{t('wsChangesCount', { n: changes.length })}</span>
        <span className="font-mono text-[11px] text-ok">+{totalAdds}</span>
        <span className="font-mono text-[11px] text-err">-{totalDels}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => accept()}
            title={t('wsAcceptAllTitle')}
            className="rounded-md px-2 py-0.5 text-[11px] text-ink-soft transition hover:bg-bg-hover"
          >
            {t('wsAcceptAll')}
          </button>
          <button
            onClick={() => (confirmAll ? revert() : setConfirmAll(true))}
            title={t('wsRevertAllTitle')}
            className={`rounded-md px-2 py-0.5 text-[11px] transition ${confirmAll ? 'bg-err/10 font-medium text-err' : 'text-ink-soft hover:bg-bg-hover'
              }`}
          >
            {confirmAll ? t('wsConfirmRevertAll') : t('wsRevertAll')}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {changes.map((c) => (
          <div key={c.path} className="group flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-bg-hover">
            <button onClick={() => onOpen(c.path)} title={c.path} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className={`w-3 shrink-0 text-center font-mono text-[10px] ${STATUS_BADGE[c.status].cls}`}>{STATUS_BADGE[c.status].label}</span>
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.sessions > 1 && (
                <span
                  title={t('wsMultiSessionTitle', { n: c.sessions })}
                  className="shrink-0 rounded bg-warn/15 px-1 text-[10px] text-warn"
                >
                  {t('wsSessionsBadge', { n: c.sessions })}
                </span>
              )}
              <span className="font-mono text-[11px] text-ok">+{c.adds}</span>
              <span className="font-mono text-[11px] text-err">-{c.dels}</span>
            </button>
            <button
              title={t('wsAcceptFile')}
              onClick={() => accept(c.path)}
              className="shrink-0 rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-bg-active hover:text-ok group-hover:opacity-100"
            >
              <Check size={13} />
            </button>
            <button
              title={c.sessions > 1 ? t('wsRevertFileMultiTitle') : t('wsRevertFileTitle')}
              onClick={() => {
                if (c.sessions > 1 && confirmPath !== c.path) {
                  setConfirmPath(c.path);
                  return;
                }
                setConfirmPath(null);
                revert(c.path);
              }}
              className={`shrink-0 rounded-md p-1 transition hover:bg-bg-active hover:text-err ${confirmPath === c.path ? 'text-err opacity-100' : 'text-ink-faint opacity-0 group-hover:opacity-100'
                }`}
            >
              <RotateCcw size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
