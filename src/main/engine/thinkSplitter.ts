/**
 * Streaming splitter for models that inline their reasoning as
 * `<think>…</think>` inside normal content (observed with MiniMax-M3
 * over chat completions — see docs/phase0-findings.md).
 *
 * Feed it text deltas; it re-emits them classified as `text` or
 * `thinking`, handling tags split across chunk boundaries.
 */

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export type SplitPart = { kind: 'text' | 'thinking'; text: string };

export class ThinkSplitter {
  private inThink = false;
  /** Carry-over that might be a partial tag prefix. */
  private pending = '';

  push(delta: string): SplitPart[] {
    let buf = this.pending + delta;
    this.pending = '';
    const out: SplitPart[] = [];

    while (buf.length > 0) {
      const tag = this.inThink ? CLOSE_TAG : OPEN_TAG;
      const idx = buf.indexOf(tag);
      if (idx !== -1) {
        const before = buf.slice(0, idx);
        if (before) out.push({ kind: this.inThink ? 'thinking' : 'text', text: before });
        this.inThink = !this.inThink;
        buf = buf.slice(idx + tag.length);
        continue;
      }
      // No full tag — hold back a suffix that could be a partial tag start.
      const hold = partialTagSuffix(buf, tag);
      const emit = hold > 0 ? buf.slice(0, -hold) : buf;
      if (emit) out.push({ kind: this.inThink ? 'thinking' : 'text', text: emit });
      this.pending = hold > 0 ? buf.slice(-hold) : '';
      buf = '';
    }
    return out;
  }

  /** Flush any held-back partial tag as literal text at stream end. */
  flush(): SplitPart[] {
    if (!this.pending) return [];
    const part: SplitPart = { kind: this.inThink ? 'thinking' : 'text', text: this.pending };
    this.pending = '';
    return [part];
  }

  reset(): void {
    this.inThink = false;
    this.pending = '';
  }
}

/** Longest suffix of `buf` that is a proper prefix of `tag` (0 if none). */
function partialTagSuffix(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (buf.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}
