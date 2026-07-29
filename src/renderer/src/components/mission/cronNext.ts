/**
 * cronNext — renderer 侧「下次运行时刻」计算。5 字段匹配逻辑与主进程
 * src/main/cron/cronMatch.ts 保持一致（renderer 不允许 import main 侧
 * 代码，故镜像一份纯函数）；在其上加逐分钟扫描求下一次命中。
 */

function matchField(field: string, value: number, min: number): boolean {
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    if (step <= 0 || Number.isNaN(step)) continue;
    let lo: number;
    let hi: number;
    if (range === '*' || range === '') {
      lo = min;
      hi = Number.MAX_SAFE_INTEGER;
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-').map(Number);
      lo = a!;
      hi = b!;
    } else {
      lo = Number(range);
      hi = stepStr ? Number.MAX_SAFE_INTEGER : lo;
    }
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}

function cronMatches(expr: string, d: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [mi, h, dom, mon, dow] = parts as [string, string, string, string, string];
  return (
    matchField(mi, d.getMinutes(), 0) &&
    matchField(h, d.getHours(), 0) &&
    matchField(dom, d.getDate(), 1) &&
    matchField(mon, d.getMonth() + 1, 1) &&
    matchField(dow, d.getDay(), 0)
  );
}

/** 从 now 之后的下一个整分钟开始扫描，最多 45 天（覆盖月度表达式）；
 *  无命中返回 null（畸形表达式或极稀疏规则）。 */
export function nextRunAt(expr: string, now = Date.now()): number | null {
  const d = new Date(now);
  d.setSeconds(0, 0);
  for (let i = 0; i < 45 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (cronMatches(expr, d)) return d.getTime();
  }
  return null;
}

/** 倒计时短格式："32s 内"级别无意义，最小粒度分钟：3m / 2h5m / 1d3h。 */
export function fmtEta(ts: number, now = Date.now()): string {
  const diff = Math.max(0, ts - now);
  const m = Math.ceil(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 > 0 ? `${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d${h % 24 > 0 ? `${h % 24}h` : ''}`;
}
