/**
 * TurnRail — codex 桌面版同款「回合导航刻度条」：
 * 对话区左缘纵向居中一簇横线，每轮问答对应一根（超过 3 轮才出现）；
 * 无悬浮时所有刻度保持低调的小灰线，仅当前轮（随滚动联动）微微提亮；
 * 悬浮某根时它变长变亮，邻近横线按与焦点的距离以不同比例跟随变化
 * （高斯衰减的鱼眼波形），过渡动画平滑；
 * 悬停浮出该轮缩略卡（提问 + 回答标题/摘要），点击平滑滚动定位。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';

/** 超过 3 轮问答才显示刻度条 */
const MIN_TURNS = 4;
/** 刻度最多渲染这么多根，轮数超出时均匀抽稀（首末轮必保留） */
const MAX_TICKS = 24;
/** 每根刻度的垂直步进 px（按钮热区高，浮卡定位同步使用） */
const TICK_STEP = 14;

interface Turn {
  id: string; // 用户消息 id，同时是滚动锚点（data-msg-id）
  question: string;
  heading?: string; // 回答中的第一个 markdown 标题
  snippet?: string; // 回答纯文本摘要
}

export default function TurnRail({
  sessionId,
  scrollRef,
}: {
  sessionId: string;
  scrollRef: React.RefObject<HTMLDivElement>;
}): JSX.Element | null {
  const t = useT();
  const messages = useChatStore((s) => s.ui[sessionId]?.messages);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [activeTick, setActiveTick] = useState(0);
  const [hoverTick, setHoverTick] = useState<number>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();

  const turns = useMemo(() => collectTurns(messages ?? []), [messages]);
  const turnKey = turns.map((x) => x.id).join('|');

  // 轮数过多时均匀抽稀成 MAX_TICKS 根刻度，保证刻度簇紧凑居中
  const ticks = useMemo(() => {
    if (turns.length <= MAX_TICKS) return turns.map((turn, i) => ({ turn, turnIndex: i }));
    const step = (turns.length - 1) / (MAX_TICKS - 1);
    return Array.from({ length: MAX_TICKS }, (_, i) => Math.round(i * step))
      .map((ti) => ({ turn: turns[ti], turnIndex: ti }))
      .filter((x): x is { turn: Turn; turnIndex: number } => x.turn != null);
  }, [turns]);

  // 记录每轮锚点在全文中的 offsetTop（滚动联动 + 点击跳转会用到）
  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const next: Record<string, number> = {};
    for (const turn of turns) {
      const node = scroller.querySelector(`[data-msg-id="${turn.id}"]`);
      if (node instanceof HTMLElement) next[turn.id] = node.offsetTop;
    }
    setOffsets((prev) => {
      const keys = Object.keys(next);
      const same = keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
  }, [turns, scrollRef]);

  // 回合增删时重测（turnKey 驱动）；流式输出/折叠展开等高度变化由 ResizeObserver 兜底
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useEffect(() => {
    const run = (): void => measureRef.current();
    const raf = requestAnimationFrame(run);
    const content = scrollRef.current?.firstElementChild;
    if (!content) return () => cancelAnimationFrame(raf);
    const ro = new ResizeObserver(run);
    ro.observe(content);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [turnKey, scrollRef]);

  // 滚动联动：视口 35% 高度线之下最后一轮为「当前轮」，映射到最近的刻度
  const updateActive = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || ticks.length === 0) return;
    const line = scroller.scrollTop + scroller.clientHeight * 0.35;
    let turnIdx = 0;
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (!turn) break;
      const off = offsets[turn.id];
      if (off == null) continue;
      if (off <= line) turnIdx = i;
      else break;
    }
    let best = 0;
    for (let i = 1; i < ticks.length; i++) {
      const cur = ticks[i];
      const prev = ticks[best];
      if (cur && prev && Math.abs(cur.turnIndex - turnIdx) < Math.abs(prev.turnIndex - turnIdx)) best = i;
    }
    setActiveTick(best);
  }, [turns, ticks, offsets, scrollRef]);

  const updateActiveRef = useRef(updateActive);
  updateActiveRef.current = updateActive;

  useEffect(() => {
    updateActiveRef.current();
    const scroller = scrollRef.current;
    if (!scroller) return;
    let raf = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => updateActiveRef.current());
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [scrollRef, turnKey]);

  // 锚点位置变化（流式推高内容、折叠展开等）后重算当前轮
  useEffect(() => {
    updateActiveRef.current();
  }, [offsets]);

  // 卸载时清掉浮卡延时器
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  if (turns.length < MIN_TURNS || ticks.length === 0) return null;

  // 无悬浮 = 无焦点：全部刻度保持默认的短小低调状态
  const focus = hoverTick ?? -1;
  /** 与焦点距离 d 的跟随比例：高斯衰减，近高远低，形成优雅的波形 */
  const follow = (d: number): number => Math.exp(-(d * d) / 3.0);

  const enter = (i: number) => (): void => {
    clearTimeout(leaveTimer.current);
    setHoverTick(i);
  };
  const leave = (): void => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHoverTick(undefined), 220);
  };
  const jump = (id: string) => (): void => {
    const scroller = scrollRef.current;
    const node = scroller?.querySelector(`[data-msg-id="${id}"]`);
    if (scroller && node instanceof HTMLElement) {
      scroller.scrollTo({ top: Math.max(0, node.offsetTop - 14), behavior: 'smooth' });
    }
    setHoverTick(undefined);
  };

  const hoveredTurn = hoverTick != null ? ticks[hoverTick]?.turn : undefined;

  return (
    <div className="pointer-events-none absolute left-0 top-1/2 z-20 -translate-y-1/2 pl-1.5">
      <div className="relative flex flex-col" onMouseLeave={leave}>
        {ticks.map(({ turn }, i) => {
          const ratio = focus < 0 ? 0 : follow(Math.abs(i - focus));
          // 颜色取主题变量 --ink（明暗色板自适应），透明度做插值：
          // 默认 28% 的低调小灰线；当前轮（滚动联动）稍亮稍长但不变波形；
          // 悬浮时焦点 90% + 28px，邻近按高斯比例跟随，整体柔和不扎眼。
          const current = i === activeTick;
          const baseW = current ? 14 : 12;
          const baseO = current ? 0.5 : 0.28;
          return (
            <button
              key={turn.id}
              title={t('turnRailJump')}
              onMouseEnter={enter(i)}
              onClick={jump(turn.id)}
              className="pointer-events-auto flex w-9 items-center"
              style={{ height: TICK_STEP }}
            >
              <span
                className="block rounded-full"
                style={{
                  width: baseW + (28 - baseW) * ratio,
                  height: 2 + ratio,
                  backgroundColor: 'var(--ink)',
                  opacity: baseO + (0.9 - baseO) * ratio,
                  transition:
                    'width 260ms cubic-bezier(0.22, 1, 0.36, 1), height 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease',
                }}
              />
            </button>
          );
        })}
        {hoveredTurn && hoverTick != null && (
          <div
            onMouseEnter={enter(hoverTick)}
            onClick={jump(hoveredTurn.id)}
            className="pointer-events-auto absolute left-9 z-30 w-64 -translate-y-1/2 cursor-pointer rounded-xl border border-line bg-bg-panel p-3 shadow-lg"
            style={{ top: hoverTick * TICK_STEP + TICK_STEP / 2 }}
          >
            <div className="line-clamp-2 text-[12px] leading-[18px] text-ink-faint">{hoveredTurn.question}</div>
            {hoveredTurn.heading && (
              <div className="mt-1 line-clamp-1 text-[13px] font-semibold leading-5 text-ink">{hoveredTurn.heading}</div>
            )}
            {hoveredTurn.snippet ? (
              <div className="mt-0.5 line-clamp-3 text-[12px] leading-[18px] text-ink-soft">{hoveredTurn.snippet}</div>
            ) : (
              !hoveredTurn.heading && <div className="mt-1 text-[12px] text-ink-faint">{t('turnRailPending')}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- helpers

/** 每轮问答 = 一条 user 消息 + 同 turnId 的首条 text 回答。
 *  乐观写入的 user 消息（turnId=-1）与引擎 user.echo 会重复，按文本去重。 */
function collectTurns(messages: UnifiedMessage[]): Turn[] {
  const firstText = new Map<number, string>();
  for (const m of messages) {
    if (m.kind === 'text' && !firstText.has(m.turnId)) firstText.set(m.turnId, m.text);
  }
  const users = messages.filter((m): m is Extract<UnifiedMessage, { kind: 'user' }> => m.kind === 'user');
  return users
    .filter((m) => !(m.turnId === -1 && users.some((x) => x.turnId >= 0 && x.text === m.text)))
    .map((m) => {
      const answer = m.turnId >= 0 ? firstText.get(m.turnId) : undefined;
      const heading = answer ? firstHeading(answer) : undefined;
      let snippet = answer ? plainText(answer) : '';
      if (heading && snippet.startsWith(heading)) snippet = snippet.slice(heading.length).trim();
      return {
        id: m.id,
        question: m.text.replace(/\s+/g, ' ').trim(),
        heading,
        snippet: snippet.slice(0, 180) || undefined,
      };
    });
}

/** markdown → 纯文本（缩略卡摘要用，够用即可不求完备） */
function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstHeading(md: string): string | undefined {
  const m = /^\s{0,3}#{1,3}\s+(.+)$/m.exec(md);
  return m?.[1] ? m[1].replace(/[*_`]/g, '').trim() : undefined;
}
