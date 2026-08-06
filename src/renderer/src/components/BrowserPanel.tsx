/**
 * BrowserPanel — 右侧 dock「浏览器」tab：受管浏览器（browser use）的全局状态面板。
 * 数据源 = chatStore.browser（主进程 browserEvent 全量推送 + 开关开启时补拉）：
 * 服务状态 / 当前页 / 最近截图 / 动作历史（摘要-only，不含输入文本与 DOM）。
 * 启停走 browserEnsure / browserStop IPC；状态为全局单例，跨会话共享同一面板内容。
 */

import { Globe } from 'lucide-react';

import type { BrowserActionRecord, BrowserPanelState } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { useT, type MsgKey, type TParams } from '../i18n';
import { BrandHero, BrandSpinner } from './brand';

/** 状态文案 i18n 键与状态点配色（off 灰 / starting 黄脉冲 / running 绿 / error 红）。 */
const STATUS_KEY: Record<BrowserPanelState['status'], MsgKey> = {
  off: 'browserStatusOff',
  starting: 'browserStatusStarting',
  running: 'browserStatusRunning',
  error: 'browserStatusError',
};
const STATUS_DOT: Record<BrowserPanelState['status'], string> = {
  off: 'bg-ink-faint',
  starting: 'bg-warn animate-pulse',
  running: 'bg-ok',
  error: 'bg-err',
};

/** 相对时间（刚刚 / N秒前 / N分钟前 / N小时前）— 动作列表随推送重渲染，不做秒级 tick。 */
function timeAgo(ts: number, t: (key: MsgKey, params?: TParams) => string): string {
  const diff = Date.now() - ts;
  if (diff < 10_000) return t('justNow');
  if (diff < 60_000) return t('timeSecsAgo', { n: Math.floor(diff / 1000) });
  if (diff < 3_600_000) return t('timeMinsAgo', { n: Math.floor(diff / 60_000) });
  return t('timeHoursAgo', { n: Math.floor(diff / 3_600_000) });
}

/** 耗时人性化：不足 1s 显示毫秒，否则保留一位小数的秒。 */
function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function BrowserPanel({ width }: { width: number }): JSX.Element {
  const t = useT();
  const state = useChatStore((s) => s.browser);
  const starting = state.status === 'starting';
  return (
    <aside className="flex min-h-0 shrink-0 flex-col bg-bg-panel/60" style={{ width }}>
      {/* 头部：状态点 + 状态文案 + 启停按钮（starting 时按钮锁死并转品牌 spinner） */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Globe size={14} className="shrink-0 text-accent" />
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[state.status]}`} />
        <span className="text-ui font-medium">{t(STATUS_KEY[state.status])}</span>
        <div className="flex-1" />
        {starting ? (
          <span className="flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-faint">
            <BrandSpinner size={14} className="text-accent" />
            {t('browserStatusStarting')}
          </span>
        ) : state.status === 'running' ? (
          <button
            onClick={() => void window.cyberslots.browserStop()}
            className="rounded-md px-2 py-0.5 text-[11px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
          >
            {t('stop')}
          </button>
        ) : (
          // off / error 都允许重新拉起（ensure 幂等）
          <button
            onClick={() => void window.cyberslots.browserEnsure()}
            className="rounded-md px-2 py-0.5 text-[11px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
          >
            {t('browserStart')}
          </button>
        )}
      </div>
      {/* 错误一行提示（红色小字，不抢主视觉） */}
      {state.status === 'error' && state.error && (
        <div className="shrink-0 border-b border-line px-3 py-1.5 text-[11px] leading-4 text-err">{state.error}</div>
      )}

      {/* 截图区：有截图展示最近一帧；启动中无截图走面板级等待（规范用 BrandHero） */}
      {state.screenshot ? (
        <div className="shrink-0 px-3 pt-2.5">
          <img src={state.screenshot} alt="" className="max-h-[220px] w-full rounded-lg border border-line object-contain" />
        </div>
      ) : starting ? (
        <div className="flex shrink-0 flex-col items-center justify-center gap-2.5 py-8 text-ink-faint">
          <BrandHero size={48} />
          <span className="text-ui">{t('browserStartingWait')}</span>
        </div>
      ) : state.status === 'off' ? (
        <div className="shrink-0 px-3 py-8 text-center text-ui text-ink-faint">{t('browserOffHint')}</div>
      ) : null}

      {/* 当前页（运行中才显示；标题 + URL 一行截断，mono 与工作区路径同款） */}
      {state.status === 'running' && (state.pageUrl || state.pageTitle) && (
        <div className="shrink-0 truncate px-3 pt-2 font-mono text-[11px] text-ink-soft" title={state.pageUrl}>
          {state.pageTitle ? `${state.pageTitle} — ` : ''}
          {state.pageUrl ?? ''}
        </div>
      )}

      {/* 动作历史：新→旧，占满剩余高度滚动（行样式对齐工作区 Files 面板小字） */}
      <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-line">
        {state.actions.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-ink-faint">{t('browserNoActions')}</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {[...state.actions].reverse().map((a) => (
              <ActionRow key={a.id} action={a} t={t} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

/** 单条动作记录：成败状态点 + 工具名（mono）+ 摘要 + 相对时间；耗时/错误次要一行。 */
function ActionRow({ action: a, t }: { action: BrowserActionRecord; t: (key: MsgKey, params?: TParams) => string }): JSX.Element {
  return (
    <div className="px-3 py-1.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.ok ? 'bg-ok' : 'bg-err'}`} />
        <span className="shrink-0 font-mono text-[11px] text-ink">{a.tool}</span>
        <span className="min-w-0 flex-1 truncate text-ink-soft" title={a.summary}>
          {a.summary}
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-ink-faint">{timeAgo(a.at, t)}</span>
      </div>
      {(a.durationMs !== undefined || (!a.ok && a.error)) && (
        <div className="ml-3.5 mt-0.5 flex items-center gap-2 text-[10.5px] text-ink-faint">
          {a.durationMs !== undefined && <span className="tabular-nums">{fmtDuration(a.durationMs)}</span>}
          {!a.ok && a.error && (
            <span className="min-w-0 truncate text-err" title={a.error}>
              {a.error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
