/**
 * QuestionPin — 滚动时把「当前提问」钉在消息区顶部（截图同款交互）：
 * 当某条提问气泡完全滚出视口上缘后，顶部浮出一颗右对齐的提问胶囊
 * （与用户气泡同色系，单行摘要），点击平滑回跳到该提问；下一条提问
 * 滚近顶缘时按 sticky 分组头手感把胶囊顶出去，越过顶缘后接棒换字，
 * 两者永不重叠。纯只读浮层——不改消息流布局与数据，
 * offsetTop 测量方式与 TurnRail 一致（scroller 为 relative 定位父）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';

export default function QuestionPin({
  sessionId,
  scrollRef,
}: {
  sessionId: string;
  scrollRef: React.RefObject<HTMLDivElement>;
}): JSX.Element | null {
  const t = useT();
  const messages = useChatStore((s) => s.ui[sessionId]?.messages);
  const [pinned, setPinned] = useState<{ id: string; text: string } | null>(null);
  // 下一条提问逼近顶缘时把胶囊往上推出去的位移（≤0，sticky 分组头手感）。
  const [push, setPush] = useState(0);
  // 滚动条占宽 — 浮层盖在含滚动条的全宽上，而消息列在客户区内居中；
  // 右缘扣掉它才能和气泡同轴。
  const [sbw, setSbw] = useState(0);
  const pinRef = useRef<HTMLButtonElement>(null);

  const userMsgs = useMemo(
    () => (messages ?? []).filter((m) => m.kind === 'user'),
    [messages],
  );

  // 当前钉住的提问 = 底缘已越过视口上缘的最后一条 user 消息；
  // 同时盯住下一条提问：它的顶缘进入胶囊区域时计算上推位移，避免重叠。
  const update = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const line = scroller.scrollTop + 8;
    let cur: { id: string; text: string } | null = null;
    let nextTop: number | undefined; // 下一条提问顶缘相对视口的 y
    for (const m of userMsgs) {
      const node = scroller.querySelector(`[data-msg-id="${m.id}"]`);
      if (!(node instanceof HTMLElement)) continue;
      if (node.offsetTop + node.offsetHeight < line) {
        cur = { id: m.id, text: m.text.replace(/\s+/g, ' ').trim() };
      } else {
        nextTop = node.offsetTop - scroller.scrollTop;
        break;
      }
    }
    setPinned((prev) => (prev?.id === cur?.id && prev?.text === cur?.text ? prev : cur));
    // 胶囊占据顶部 8px(mt-2) + 自身高度；下一条提问顶缘侵入该区域（含 6px
    // 间隙）时按侵入量上推，直到它越过顶缘接棒。
    const pinH = pinRef.current?.offsetHeight ?? 32;
    setPush(cur && nextTop != null ? Math.min(0, nextTop - (8 + pinH + 6)) : 0);
    setSbw(scroller.offsetWidth - scroller.clientWidth);
  }, [userMsgs, scrollRef]);

  const updateRef = useRef(update);
  updateRef.current = update;

  // 滚动（rAF 节流）+ 内容高度变化（流式/折叠）都重算钉住状态。
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let raf = 0;
    const run = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => updateRef.current());
    };
    run();
    scroller.addEventListener('scroll', run, { passive: true });
    const content = scroller.firstElementChild;
    const ro = new ResizeObserver(run);
    if (content) ro.observe(content);
    return () => {
      scroller.removeEventListener('scroll', run);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [scrollRef]);

  // 消息增删（新提问/回退截断）立即重算，不等下一次滚动。
  useEffect(() => {
    updateRef.current();
  }, [userMsgs]);

  if (!pinned) return null;

  const jump = (): void => {
    const scroller = scrollRef.current;
    const node = scroller?.querySelector(`[data-msg-id="${pinned.id}"]`);
    if (scroller && node instanceof HTMLElement) {
      scroller.scrollTo({ top: Math.max(0, node.offsetTop - 14), behavior: 'smooth' });
    }
  };

  return (
    // 与消息列同轴：px-6 必须和内容列一样加在 max-w-3xl 列内部（宽屏下外层
    // padding 约束不到内层 768px 列，胶囊会越出气泡右缘 24px）；右缘再扣掉
    // 滚动条宽，与客户区的居中基准对齐。胶囊右对齐呼应用户气泡位置。
    // overflow-hidden 裁掉上推时露出顶缘的部分（推出 = 滑出视口）。
    <div style={{ right: sbw }} className="pointer-events-none absolute left-0 top-0 z-10 flex justify-center overflow-hidden">
      <div className="flex w-full max-w-3xl justify-end px-6" style={{ transform: `translateY(${push}px)` }}>
        <button
          key={pinned.id}
          ref={pinRef}
          onClick={jump}
          title={t('pinnedQuestionJump')}
          // 被上推时关掉入场动画（question-pin）——接棒时 key 变化会重播
          // 「从上滑入」，与正在进行的推出位移叠加会闪跳。
          className={`${push === 0 ? 'question-pin ' : ''}pointer-events-auto mt-2 max-w-[80%] truncate rounded-full border border-line bg-bg-active px-4 py-1.5 text-left text-[12.5px] text-ink-soft shadow-md transition-colors hover:text-ink`}
        >
          {pinned.text}
        </button>
      </div>
    </div>
  );
}
