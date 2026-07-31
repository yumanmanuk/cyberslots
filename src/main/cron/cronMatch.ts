/**
 * cronMatch — dependency-free 5-field cron expression matcher shared by
 * CronService (runtime) and tests. Fields: min hour dom month dow;
 * supports * , - / (dom AND dow, simplified vs. POSIX OR).
 */

import { L } from '../i18n';

/** Throws with a readable message when the expression is malformed. */
export function validateCron(expr: string): void {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(L('cron 表达式必须是 5 段：分 时 日 月 周', 'A cron expression must have 5 fields: min hour day month weekday'));
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  parts.forEach((field, i) => {
    for (const part of field.split(',')) {
      if (!/^(\*|\d+(-\d+)?)(\/\d+)?$/.test(part)) {
        throw new Error(L(`第 ${i + 1} 段 "${part}" 不合法（支持 * , - /）`, `Field ${i + 1} "${part}" is invalid (supports * , - /)`));
      }
      const [range] = part.split('/');
      if (range !== '*') {
        const nums = range!.split('-').map(Number);
        const [lo, hi] = ranges[i]!;
        for (const n of nums) {
          if (n < lo || n > hi) throw new Error(L(`第 ${i + 1} 段数值 ${n} 超出范围 ${lo}-${hi}`, `Field ${i + 1} value ${n} is out of range ${lo}-${hi}`));
        }
      }
    }
  });
}

/** Whether the expression fires at the given wall-clock minute. */
export function cronMatches(expr: string, d: Date): boolean {
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
      // Bare value with step ("5/10") extends to the max; without step it's exact.
      hi = stepStr ? Number.MAX_SAFE_INTEGER : lo;
    }
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}
