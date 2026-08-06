/** 行级 diff 工具 — DiffView（变更对照）与 FilePreview（编辑器行标记）共用。
 *  统一 LCS 回溯出 ctx/add/del 行序列，避免两处各自实现导致口径漂移。 */

export type Row = { t: 'ctx' | 'add' | 'del'; text: string; oldN?: number; newN?: number };

/** 超过该行数降级：LCS 是 O(n·m)，大文件逐行回溯会卡 UI。 */
export const DIFF_MAX_LINES = 3000;

export function splitLines(s: string | null): string[] {
  if (s == null) return [];
  if (!s.length) return [];
  // 同时兼容 CRLF / CR / LF 三种行尾，并剥除分隔后残留的 '\r'。
  // git show HEAD:... 在 Windows + git autocrlf 默认下会带 CRLF，
  // 而 CodeMirror 的草稿走 LF。不归一化时 a[i] === b[j] 全 false，
  // LCS 会把整文件判成 add+del → 表现为「打开 M 文件全是修改色」
  // 且行号偏移一格。
  return s.split(/\r\n|\n/).map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** LCS 回溯出统一 diff 行序列；超大文件降级为「全删+全增」避免卡顿。 */
export function buildRows(before: string | null, after: string | null): Row[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
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

/** 编辑器行标记：add = 纯新增行（绿），mod = 修改块内的新行（琥珀，
 *  VS Code 把相邻 del+add 合并为修改）；dels = 纯删除块关联的新行号
 *  （该行上方有被删除行，红条；文件尾删除则落在最后一行）。 */
export type LineDiffKind = 'add' | 'mod';

export interface LineDiff {
  /** 1-based 当前文件行号 → 变更类型。 */
  rows: Map<number, LineDiffKind>;
  /** 纯删除块关联行号集合。 */
  dels: Set<number>;
}

export const EMPTY_LINE_DIFF: LineDiff = { rows: new Map(), dels: new Set() };

/** base = HEAD 版本内容（null = 新增/未跟踪/非 git，按全新增处理）。 */
export function computeLineDiff(base: string | null, current: string): LineDiff {
  const a = splitLines(base);
  const b = splitLines(current);
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return EMPTY_LINE_DIFF;
  const rows = buildRows(base, current);
  const out: Map<number, LineDiffKind> = new Map();
  const dels = new Set<number>();
  const total = Math.max(1, b.length);
  let newLine = 0;
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.t === 'ctx') {
      newLine++;
      i++;
      continue;
    }
    let hasDel = false;
    const addLines: number[] = [];
    let j = i;
    while (j < rows.length && rows[j]!.t !== 'ctx') {
      if (rows[j]!.t === 'del') hasDel = true;
      else addLines.push(newLine + addLines.length + 1);
      j++;
    }
    if (addLines.length > 0) {
      // del+add 相邻 = 修改块（琥珀），纯新增 = 绿色。
      const kind: LineDiffKind = hasDel ? 'mod' : 'add';
      for (const ln of addLines) out.set(ln, kind);
    } else if (hasDel) {
      // 纯删除块：红条挂到块后第一个新行；文件尾则最后一行。
      dels.add(Math.min(newLine + 1, total));
    }
    newLine += addLines.length;
    i = j;
  }
  return { rows: out, dels };
}
