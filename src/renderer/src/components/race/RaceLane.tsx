/**
 * RaceLane — 一条赛道：渲染某个角色 session 的实时输出流。
 * 渲染层直接复用主区 MessageList（ChatView / SideChatPanel 同款）：
 * thinking 动效与折叠、shell/explore 分组进行中展开·结束自动折叠、
 * 活动指示器等交互与主对话完全一致，主区逻辑演进时泳道自动同步。
 */

import { RotateCcw, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { BrandHero, BrandSpinner } from '../brand';

import { useChatStore } from '../../store/chatStore';
import { useT } from '../../i18n';
import EliminateButton from './EliminateButton';
import MessageList from '../MessageList';

export default function RaceLane({
  title,
  subtitle,
  sessionId,
  tone = 'a',
  running,
  fill = false,
  badge,
  onStop,
  onRetry,
  onEliminate,
  finished,
}: {
  title: string;
  subtitle: string;
  /** 角色 session 尚未创建时为 undefined（显示等待占位）。 */
  sessionId?: string;
  /** 视觉基调：a=选手A(accent) / b=选手B(warn 暖色) / neutral。 */
  tone?: 'a' | 'b' | 'neutral';
  running: boolean;
  /** true = 撞满父容器高度（竞速双泳道：头固定、仅内容区滚动）；
   *  false = 限高内滚（Builder/裁判参考区等页面流式布局里）。 */
  fill?: boolean;
  /** 头像字符（缺省取标题末字：选手 A→A；中文角色名需显式指定）。 */
  badge?: string;
  /** 提供则在进行中时显示 ■ 单选手中止按钮（中止后可重试该阶段）。 */
  onStop?: () => void;
  /** 提供则在「已停止」态显示 ↻ 单选手重试按钮（只重跑本选手）。 */
  onRetry?: () => void;
  /** 提供则显示 ✂ 剔除按钮（二段确认；仅三人以上在场时由父层传入）。 */
  onEliminate?: () => void;
  /** 本阶段产物已落盘 = 真冲线（缺省：!running 视为已冲线，兼容参考区/执行道）。 */
  finished?: boolean;
}): JSX.Element {
  const t = useT();
  const messages = useChatStore((s) => (sessionId ? s.ui[sessionId]?.messages : undefined));
  // 重启后会话消息是懒加载的（仅 selectSession 时水合）；泳道不走
  // 选择链路，需自行触发一次，否则已冲线角色（如执行者）恢复后
  // 永远空白。hydrateSession 幂等，重复调用零成本。
  const hydrateSession = useChatStore((s) => s.hydrateSession);
  useEffect(() => {
    if (sessionId) hydrateSession(sessionId);
  }, [sessionId, hydrateSession]);
  // 赛马泳道不显示回合 token 统计行（竞速时只看产出；codex 内部多回合
  // 会让统计行夹在提问/输出之间造成误读）。消耗数据不丢：角色会话
  // 从主视图打开时照常显示，用量统计页也照常累计。
  const visible = useMemo(() => messages?.filter((m) => m.kind !== 'turn_end'), [messages]);
  // 会话真实运行态（角色会话已回灌会话表）：有会话但状态未知时
  // 先当作忙碌（防列表未刷到就闪“已停止”）；没有会话（如调参换
  // 引擎后待重建）则不存在运行中回合，老实显示已停止 + 重试入口。
  const status = useChatStore((s) => (sessionId ? s.sessions.find((m) => m.id === sessionId)?.status : undefined));
  const busy =
    running &&
    !!sessionId &&
    (status === undefined || status === 'running' || status === 'awaiting' || status === 'starting');
  const done = finished ?? !running;
  // 另一侧空窗：回合正常收笔（status→idle）与产物落盘（race.artifacts）
  // 是两条 IPC 链路，前者先到会闪一帧「已停止」再翻「已冲线」。正常
  // 收笔给一小段宽限期继续算忙碌；宽限内产物仍未落盘（真异常）才落停。
  // 用户 ■ 中止（stopReason=cancelled）不进宽限，立即显示已停止。
  const lastStopReason = useMemo(() => {
    if (!messages) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.kind === 'turn_end') return m.stopReason;
    }
    return undefined;
  }, [messages]);
  const settling = running && !done && !busy && status === 'idle' && lastStopReason !== 'cancelled';
  const [graceBusy, setGraceBusy] = useState(false);
  useEffect(() => {
    if (!settling) {
      setGraceBusy(false);
      return;
    }
    setGraceBusy(true);
    const t = window.setTimeout(() => setGraceBusy(false), 2000);
    return () => window.clearTimeout(t);
  }, [settling]);
  const showBusy = busy || graceBusy;
  const toneText = tone === 'a' ? 'text-accent' : tone === 'b' ? 'text-warn' : 'text-ink-soft';
  const toneBorder = tone === 'a' ? 'border-accent' : tone === 'b' ? 'border-warn' : 'border-line';

  // 流式期间贴底自动滚动；用户上翻离底后不打扰（与 SideChatPanel 同策略）。
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className={`flex min-w-0 flex-1 flex-col ${fill ? 'min-h-0' : ''}`}>
      <div className="flex shrink-0 items-center gap-2 px-1 py-2">
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-md border bg-bg-input text-[11px] font-bold ${toneText} ${toneBorder}`}
        >
          {badge ?? title.slice(-1)}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          <div className="truncate font-mono text-[10.5px] text-ink-faint">{subtitle}</div>
        </div>
        <div className="ml-auto flex items-center gap-1 text-[11px] text-ink-faint">
          {done ? (
            t('raceLaneFinished')
          ) : showBusy ? (
            <>
              <BrandSpinner size={11} /> {t('raceLaneRunning')}
              {onStop && sessionId && (
                <button
                  title={t('raceLaneStopTitle')}
                  onClick={onStop}
                  className="ml-1 rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-err"
                >
                  <Square size={10} fill="currentColor" />
                </button>
              )}
            </>
          ) : (
            <>
              <span className="font-medium text-warn">{t('raceLaneStopped')}</span>
              {onRetry && sessionId && (
                <button
                  title={t('raceLaneRetryTitle')}
                  onClick={onRetry}
                  className="ml-0.5 flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-soft transition hover:bg-bg-hover hover:text-ink"
                >
                  <RotateCcw size={10} /> {t('raceRetry')}
                </button>
              )}
            </>
          )}
          {onEliminate && <EliminateButton label={title} onConfirm={onEliminate} />}
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className={`overflow-y-auto overflow-x-hidden rounded-xl border border-line bg-bg-panel/70 ${fill ? 'min-h-0 flex-1' : 'max-h-[60vh] min-h-40'
          }`}
      >
        {!sessionId || !visible?.length ? (
          <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 text-[12px] text-ink-faint">
            {/* 泳道级等待按规范用 BrandHero；（无输出）是终态非 loading，保持纯文字 */}
            {showBusy ? (
              <>
                <BrandHero size={48} />
                {t('raceWaitingOutput')}
              </>
            ) : (
              t('raceNoOutput')
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-3 px-3 py-3 text-[13px]" style={{ overflowWrap: 'anywhere' }}>
            <MessageList sessionId={sessionId} messages={visible} />
          </div>
        )}
      </div>
    </div>
  );
}
