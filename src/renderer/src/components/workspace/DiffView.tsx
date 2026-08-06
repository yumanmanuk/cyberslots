/**
 * DiffView — before/after 行级对照（借鉴 claude-code StructuredDiff：
 * LCS 回溯出增/删/上下文行，红/绿着色的统一 diff）。数据来自主进程
 * ChangeTracker 的编辑前基线 vs 当前磁盘内容。超大文件降级为纯统计。
 */

import { useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';

import type { SessionChangeDiff } from '@shared/ipc';
import { BrandHero } from '../brand';
import { useT } from '../../i18n';
import { buildRows, type Row } from './diffRows';

export default function DiffView({
  sessionId,
  path,
  nonce,
  canRevert = true,
  onClose,
  onRevert,
}: {
  sessionId: string;
  path: string;
  nonce: number;
  /** 已接受文件只读查看 diff，隐藏回退按钮。 */
  canRevert?: boolean;
  onClose: () => void;
  onRevert: () => void;
}): JSX.Element {
  const t = useT();
  const [data, setData] = useState<SessionChangeDiff | null>(null);
  useEffect(() => {
    let alive = true;
    void window.cyberslots.sessionChangesDiff(sessionId, path).then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, [sessionId, path, nonce]);

  const name = path.split(/[\\/]/).pop() ?? path;
  const rows = data ? buildRows(data.before, data.after) : null;
  const adds = rows?.reduce((n, r) => n + (r.t === 'add' ? 1 : 0), 0) ?? 0;
  const dels = rows?.reduce((n, r) => n + (r.t === 'del' ? 1 : 0), 0) ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-ui font-medium" title={path}>
          {name}
        </span>
        <span className="font-mono text-[11px] text-ok">+{adds}</span>
        <span className="font-mono text-[11px] text-err">-{dels}</span>
        {canRevert && (
          <button
            title={t('wsRevertFileTitle')}
            onClick={onRevert}
            className="rounded-md p-1 text-ink-faint transition hover:bg-bg-active hover:text-err"
          >
            <RotateCcw size={13} />
          </button>
        )}
        <button title={t('close')} onClick={onClose} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-active hover:text-ink">
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11.5px] leading-5">
        {rows === null ? (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-8 text-ink-faint">
            {/* 面板内容区级等待按规范用 BrandHero */}
            <BrandHero size={48} />
            {t('loading')}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-ink-faint">{t('diffNoChange')}</div>
        ) : (
          rows.map((r, i) => (
            <div
              key={i}
              className={`flex whitespace-pre-wrap px-2 ${r.t === 'add' ? 'bg-ok/10' : r.t === 'del' ? 'bg-err/10' : ''
                }`}
            >
              <span className="w-9 shrink-0 select-none pr-2 text-right text-ink-faint/70">{r.oldN ?? ''}</span>
              <span className="w-9 shrink-0 select-none pr-2 text-right text-ink-faint/70">{r.newN ?? ''}</span>
              <span className={`w-3 shrink-0 select-none ${r.t === 'add' ? 'text-ok' : r.t === 'del' ? 'text-err' : 'text-transparent'}`}>
                {r.t === 'add' ? '+' : r.t === 'del' ? '-' : ' '}
              </span>
              <span className="min-w-0 flex-1 break-all">{r.text || ' '}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

