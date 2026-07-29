/**
 * DiffView — before/after 行级对照（借鉴 claude-code StructuredDiff：
 * LCS 回溯出增/删/上下文行，红/绿着色的统一 diff）。数据来自主进程
 * ChangeTracker 的编辑前基线 vs 当前磁盘内容。超大文件降级为纯统计。
 */

import { useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';

import type { SessionChangeDiff } from '@shared/ipc';
import { BrandHero } from '../brand';

type Row = { t: 'ctx' | 'add' | 'del'; text: string; oldN?: number; newN?: number };

const MAX_LINES = 3000;

export default function DiffView({
  sessionId,
  path,
  nonce,
  onClose,
  onRevert,
}: {
  sessionId: string;
  path: string;
  nonce: number;
  onClose: () => void;
  onRevert: () => void;
}): JSX.Element {
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
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-ui font-medium" title={path}>
          {name}
        </span>
        <span className="font-mono text-[11px] text-ok">+{adds}</span>
        <span className="font-mono text-[11px] text-err">-{dels}</span>
        <button
          title="回退此文件到编辑前"
          onClick={onRevert}
          className="rounded-md p-1 text-ink-faint transition hover:bg-bg-active hover:text-err"
        >
          <RotateCcw size={13} />
        </button>
        <button title="关闭" onClick={onClose} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-active hover:text-ink">
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11.5px] leading-5">
        {rows === null ? (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-8 text-ink-faint">
            {/* 面板内容区级等待按规范用 BrandHero */}
            <BrandHero size={48} />
            加载中…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-ink-faint">无差异</div>
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

function splitLines(s: string | null): string[] {
  if (s == null) return [];
  return s.length ? s.split('\n') : [];
}

/** LCS 回溯出统一 diff 行序列；超大文件降级为「全删+全增」避免卡顿。 */
function buildRows(before: string | null, after: string | null): Row[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const rows: Row[] = [];
    a.forEach((t, i) => rows.push({ t: 'del', text: t, oldN: i + 1 }));
    b.forEach((t, i) => rows.push({ t: 'add', text: t, newN: i + 1 }));
    return rows;
  }
  const n = a.length;
  const m = b.length;
  // LCS 长度表
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  // 回溯生成行
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ t: 'ctx', text: a[i]!, oldN: i + 1, newN: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ t: 'del', text: a[i]!, oldN: i + 1 });
      i++;
    } else {
      rows.push({ t: 'add', text: b[j]!, newN: j + 1 });
      j++;
    }
  }
  while (i < n) rows.push({ t: 'del', text: a[i]!, oldN: ++i });
  while (j < m) rows.push({ t: 'add', text: b[j]!, newN: ++j });
  return rows;
}
