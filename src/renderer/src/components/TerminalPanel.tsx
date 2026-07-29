/**
 * TerminalPanel — 右侧 dock 内嵌终端（xterm.js + 主进程 node-pty 真 TTY）。
 *
 * 按终端 tab id 建 / 复用后端 PTY（cwd = 选定的工作区根目录）；支持多实例，
 * 非活动 tab 用 hidden 隐藏（xterm 实例保活，切回时滚动缓冲不丢）。
 * fit addon 随面板宽高自适应并把尺寸同步给 PTY。标题与关闭按钮由
 * RightDock 的统一 tab 栏接管，本组件只渲染终端本体。
 */

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** 与应用配色对齐的终端主题（读 CSS 变量，明暗自动跟随）。 */
function readTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--bg-input', '#1e1e1e'),
    foreground: v('--ink', '#d4d4d4'),
    cursor: v('--accent', '#e6b450'),
    selectionBackground: v('--bg-active', '#264f78'),
  };
}

export default function TerminalPanel({ termId, cwd, hidden }: { termId: string; cwd: string; hidden: boolean }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: 'Iosevka, "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: readTheme(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host 可能尚未布局（初始 hidden） */
    }

    // 后端 PTY：确保存在（cwd = 该 tab 选定目录）+ 订阅输出流（仅本 tab id）。
    void window.cyberslots.terminalCreate(termId, cwd);
    const offData = window.cyberslots.onTerminalData((payload) => {
      if (payload.id === termId) term.write(payload.data);
    });
    const inputDisp = term.onData((data) => void window.cyberslots.terminalInput(termId, data));

    // 尺寸同步：初次 + 面板 resize / hidden→显示 → fit → 通知 PTY resize。
    const syncSize = (): void => {
      try {
        fit.fit();
      } catch {
        /* host 尚未布局 */
      }
      if (term.cols >= 1 && term.rows >= 1) void window.cyberslots.terminalResize(termId, term.cols, term.rows);
    };
    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(host);
    term.focus();

    return () => {
      ro.disconnect();
      offData();
      inputDisp.dispose();
      term.dispose();
      // 后端 shell 保留（不 dispose）—— 关 tab 时由 store.removeTerminal 收尾。
    };
  }, [termId, cwd]);

  // hidden 时保持挂载（xterm 缓冲保活），显示时 ResizeObserver 触发重排。
  return (
    <div className={`${hidden ? 'hidden' : 'flex'} w-[440px] shrink-0 flex-col bg-bg-input`}>
      {/* xterm 挂载点：内边距留一点，背景由主题变量驱动 */}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1.5" />
    </div>
  );
}
