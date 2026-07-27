/**
 * TurnRail — codex 桌面版同款「回合导航刻度条」，贴在对话区左缘：
 * 每一轮问答对应一枚小刻度（按消息在全文中的纵向位置映射，minimap 式）；
 * 悬停刻度变长高亮并浮出该轮缩略卡（提问 + 回答标题/摘要），
 * 点击平滑滚动定位到该轮。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { UnifiedMessage } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';

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
  const [fracs, setFracs] = useState<Record<string, number>>({});
  const [hoverId, setHoverId] = useState<string>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();

  const turns = useMemo(() => collectTurns(messages ?? []), [messages]);
  const turnKey = turns.map((x) => x.id).join('|');

  // 刻度位置 = 消息 offsetTop / 全文高度，线性映射到视口高度。
  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || scroller.scrollHeight === 0) return;
    const next: Record<string, number> = {};
    for (const turn of turns) {
      const node = scroller.querySelector(`[data-msg-id="${turn.id}"]`);
      if (node instanceof HTMLElement) {
        next[turn.id] = Math.min(0.97, Math.max(0.01, node.offsetTop / scroller.scrollHeight));
      }
    }
    setFracs((prev) => {
      const keys = Object.keys(next);
      const same =
        keys.length === Object.keys(prev).length && keys.every((k) => Math.abs((prev[k] ?? -1) - (next[k] ?? -2)) < 0.002);
      return same ? prev : next;
    });
  }, [turns, scrollRef]);

  // 回合增删时重测（turnKey 驱动）；流式输出/折叠展开等高度变化由 ResizeObserver 兜底。
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

  // 卸载时清掉浮卡延时器
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  if (turns.length === 0) return null;

  const enter = (id: string) => (): void => {
    clearTimeout(leaveTimer.current);
    setHoverId(id);
  };
  const leave = (): void => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHoverId(undefined), 220);
  };
  const jump = (id: string) => (): void => {
    const scroller = scrollRef.current;
    const node = scroller?.querySelector(`[data-msg-id="${id}"]`);
    if (scroller && node instanceof HTMLElement) {
      scroller.scrollTo({ top: Math.max(0, node.offsetTop - 14), behavior: 'smooth' });
    }
    setHoverId(undefined);
  };

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 z-20 w-4">
      {turns.map((turn) => {
        const frac = fracs[turn.id];
        if (frac == null) return null;
        const hovered = hoverId === turn.id;
        // 浮卡垂直对齐：靠顶部的向下展开，靠底部的向上展开，中间居中
        const cardPos = frac < 0.15 ? 'top-0' : frac > 0.8 ? 'bottom-0' : 'top-1/2 -translate-y-1/2';
        return (
          <div key={turn.id} className="absolute left-0" style={{ top: `${frac * 100}%` }}>
            <button
              title={t('turnRailJump')}
              onMouseEnter={enter(turn.id)}
              onMouseLeave={leave}
              onClick={jump(turn.id)}
              className="group pointer-events-auto flex h-4 w-4 items-center justify-center"
            >
              <span
                className={`block rounded-full transition-all duration-150 ${
                  hovered ? 'h-6 w-1 bg-accent' : 'h-1 w-3 bg-ink-soft/80 group-hover:bg-ink-soft'
                }`}
              />
            </button>
            {hovered && (
              <div
                onMouseEnter={enter(turn.id)}
                onMouseLeave={leave}
                onClick={jump(turn.id)}
                className={`pointer-events-auto absolute left-[18px] z-30 w-64 cursor-pointer rounded-xl border border-line bg-bg-panel p-3 shadow-lg ${cardPos}`}
              >
                <div className="line-clamp-2 text-[12px] leading-[18px] text-ink-faint">{turn.question}</div>
                {turn.heading && (
                  <div className="mt-1 line-clamp-1 text-[13px] font-semibold leading-5 text-ink">{turn.heading}</div>
                )}
                {turn.snippet ? (
                  <div className="mt-0.5 line-clamp-3 text-[12px] leading-[18px] text-ink-soft">{turn.snippet}</div>
                ) : (
                  !turn.heading && <div className="mt-1 text-[12px] text-ink-faint">{t('turnRailPending')}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
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
