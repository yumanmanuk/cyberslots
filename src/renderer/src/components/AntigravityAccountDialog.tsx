/**
 * AntigravityAccountDialog — Antigravity 账号切换弹窗（半自动）。
 *
 * 触发：① 手动（额度看板/引擎控件点开）；② 自动 —— antigravity 会话回合
 * 以错误收尾（多为额度耗尽/认证失效）时 chatStore 置 agySwitchFor 自动弹出。
 * 列出【导入池】账号（设置 → 模型 → Antigravity 账号 里显式导入，未导入
 * 的账号本程序不可用）+ 各账号「分组周额度」剩余量，点选某账号即覆写
 * keyring 切号，并自动向该会话发「继续」接回任务（跨账号本地重放上下文，
 * 见集成文档 §3.8）。
 *
 * loading 指示遵循品牌规范：面板级等待用 BrandHero，行内用 BrandSpinner。
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import type { AgyAccount, AgyQuotaInfo } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { agyWindowLabel, useT } from '../i18n';
import { BrandHero, BrandSpinner } from './brand';
import { EngineIcon } from './EngineIcon';

function fmtReset(sec: number | undefined, t: ReturnType<typeof useT>): string {
  if (sec == null || sec <= 0) return '';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return t('agyResetInDays', { d, h });
  if (h > 0) return t('agyResetInHours', { h, m });
  return t('agyResetInMins', { m });
}

/** 剩余量配色：>30% 绿 / 10–30% 橙 / <10% 红。 */
function remainColor(remain: number): string {
  if (remain > 30) return 'text-ok';
  if (remain > 10) return 'text-warn';
  return 'text-err';
}
function barColor(remain: number): string {
  if (remain > 30) return 'bg-ok';
  if (remain > 10) return 'bg-warn';
  return 'bg-err';
}

export default function AntigravityAccountDialog(): JSX.Element | null {
  const t = useT();
  const sessionId = useChatStore((s) => s.agySwitchFor);
  const close = useChatStore((s) => s.closeAgySwitch);
  const doSwitch = useChatStore((s) => s.switchAgyAccount);

  const [accounts, setAccounts] = useState<AgyAccount[]>([]);
  const [active, setActive] = useState<string | undefined>();
  const [blocked, setBlocked] = useState<Record<string, number>>({});
  const [quota, setQuota] = useState<Record<string, AgyQuotaInfo>>({});
  const [quotaFailed, setQuotaFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = sessionId !== null;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setQuotaFailed(false);
    void window.cyberslots
      .agyAccountsList()
      .then((snap) => {
        if (!alive) return;
        if (snap.error) setError(snap.error);
        setAccounts(snap.accounts);
        setActive(snap.active);
        // 冷却表随快照下发（main 唯一真源）：冷却账号显示「冷却中」占位；
        // 手动切号是逃生口，不据此禁选。
        setBlocked(snap.blocked ?? {});
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    // 额度并行拉取（较慢，扫导入池内全部账号）；到了再填。
    // IPC 异常也要落地为失败态 — 否则行内永远停在「额度加载中」。
    void window.cyberslots
      .agyQuota()
      .then((list) => {
        if (!alive) return;
        const map: Record<string, AgyQuotaInfo> = {};
        for (const q of list) map[q.accountId] = q;
        setQuota(map);
      })
      .catch(() => {
        if (alive) setQuotaFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [open, sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  if (!open) return null;

  const pick = (id: string): void => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    // continueSessionId = 当前会话 → 切后自动发「继续」。
    doSwitch(id, sessionId ?? undefined)
      .then(() => close())
      .catch((e) => {
        setBusyId(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={close}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[76vh] w-[520px] flex-col rounded-2xl border border-line bg-bg p-5 shadow-2xl"
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <EngineIcon engine="antigravity" size={15} />
            {t('agySwitchTitle')}
          </span>
          <button onClick={close} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="mb-3 text-[12px] leading-5 text-ink-soft">
          {t('agySwitchDesc')}
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-ui text-ink-soft">
            <BrandHero size={56} />
            <span>{t('agyReadingPool')}</span>
          </div>
        ) : accounts.length === 0 ? (
          <div className="py-8 text-center text-ui text-ink-soft">
            {error ?? t('agyNoAccounts')}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {/* 当前活动账号置顶，其余保持导入顺序 */}
            {[...accounts].sort((a, b) => Number(!!active && b.email === active) - Number(!!active && a.email === active)).map((a) => {
              const q = quota[a.id];
              const isActive = active && a.email === active;
              const busy = busyId === a.id;
              const coolingMs = blocked[a.email];
              const cooling = coolingMs !== undefined && coolingMs > Date.now();
              return (
                <button
                  key={a.id}
                  onClick={() => pick(a.id)}
                  disabled={!!busyId}
                  className={`flex w-full flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-50 ${
                    isActive ? 'border-accent/50 bg-accent/5' : 'border-line hover:bg-bg-hover'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.email}</span>
                    {isActive && <span className="shrink-0 rounded bg-accent/15 px-1.5 text-[10px] text-accent">{t('agyCurrent')}</span>}
                    {cooling && (
                      <span className="shrink-0 rounded bg-warn/15 px-1.5 text-[10px] text-warn">
                        {t('agyCooling')} · {fmtReset(Math.max(1, Math.ceil((coolingMs - Date.now()) / 1000)), t)}
                      </span>
                    )}
                    {busy && <BrandSpinner size={13} />}
                  </div>
                  {q && q.ok && q.groups.length > 0 ? (
                    <div className="space-y-1">
                      {q.groups.map((g) => {
                        const remain = Math.max(0, Math.round(100 - g.utilization));
                        return (
                          <div key={g.group} className="flex items-center gap-2 text-[11px]">
                            {/* w-40：容得下「Claude and GPT · 5小时」全名，避免被截成「· …」被误当成 loading */}
                            <span className="w-40 shrink-0 truncate text-ink-faint" title={g.group}>{agyWindowLabel(t, g.group)}</span>
                            <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-bg-input">
                              <span className={`absolute inset-y-0 left-0 rounded-full ${barColor(remain)}`} style={{ width: `${remain}%` }} />
                            </span>
                            <span className={`w-10 shrink-0 text-right font-mono ${remainColor(remain)}`}>{remain}%</span>
                            {g.resetsInSeconds != null && (
                              <span className="w-24 shrink-0 truncate text-right text-ink-faint">{fmtReset(g.resetsInSeconds, t)}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : q && !q.ok ? (
                    <span className="text-[11px] text-ink-faint">{t('agyQuotaFailedDetail', { err: q.error?.slice(0, 60) ?? '' })}</span>
                  ) : q ? (
                    // ok 但 0 组：响应成功却解析不出分组（字段漂移，主进程已留档）——明示而非假装还在加载。
                    <span className="text-[11px] text-ink-faint">{t('agyNoQuotaData')}</span>
                  ) : quotaFailed ? (
                    <span className="text-[11px] text-ink-faint">{t('agyQuotaFailed')}</span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                      <BrandSpinner size={11} /> {t('agyQuotaLoading')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {error && accounts.length > 0 && <div className="mt-2 text-[12px] text-err">{t('agySwitchFailed', { err: error })}</div>}
      </div>
    </div>
  );
}
