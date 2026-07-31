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

/** 与应用配色对齐的终端主题（读 CSS 变量，明暗自动跟随）。
 *  ANSI 16 色必须按明暗各配一套 —— xterm 默认调色板是深底设计，
 *  浅色奶油底上亮黄/亮白（PSReadLine 命令名、数字等）会糊成看不清；
 *  浅色版整体压深并向主题暖调靠（yellow → 深金 --accent 系）。 */
function readTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.mode === 'dark';
  const ansi = dark
    ? {
        black: '#3a3733',
        red: '#d14d41',
        green: '#66a06b',
        yellow: '#cea54b',
        blue: '#6f9fd2',
        magenta: '#b97fb5',
        cyan: '#5aa8a0',
        white: '#cecdc3',
        brightBlack: '#84817a',
        brightRed: '#e0685c',
        brightGreen: '#7fb984',
        brightYellow: '#e3c078',
        brightBlue: '#8cb4e0',
        brightMagenta: '#cf9ccb',
        brightCyan: '#79c2ba',
        brightWhite: '#f1efe4',
      }
    : {
        black: '#37352f',
        red: '#b3392f',
        green: '#34794f',
        yellow: '#8a681c',
        blue: '#3a6ea5',
        magenta: '#8f4e94',
        cyan: '#247e76',
        white: '#6f6c64', // 浅底上 white/brightWhite 映射为深墨 — 可读性优先
        brightBlack: '#79766c',
        brightRed: '#c5493f',
        brightGreen: '#3a8f5f',
        brightYellow: '#96721f',
        brightBlue: '#2f5f94',
        brightMagenta: '#7d4287',
        brightCyan: '#1e6b64',
        brightWhite: '#37352f',
      };
  return {
    background: v('--bg-input', '#1e1e1e'),
    foreground: v('--ink', '#d4d4d4'),
    cursor: v('--accent', '#cea54b'),
    selectionBackground: v('--bg-active', '#264f78'),
    ...ansi,
  };
}

export default function TerminalPanel({ termId, cwd, width, hidden }: { termId: string; cwd: string; width: number; hidden: boolean }): JSX.Element {
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

    // 运行时切明暗模式 → 重读主题（含 ANSI 调色板），否则旧终端留着
    // 另一套明暗的颜色会直接不可读。
    const mo = new MutationObserver(() => {
      term.options.theme = readTheme();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });

    return () => {
      ro.disconnect();
      mo.disconnect();
      offData();
      inputDisp.dispose();
      term.dispose();
      // 后端 shell 保留（不 dispose）—— 关 tab 时由 store.removeTerminal 收尾。
    };
  }, [termId, cwd]);

  // hidden 时保持挂载（xterm 缓冲保活），显示时 ResizeObserver 触发重排。
  // 宽度由 RightDock 统一管理（dock 左缘把手拖拽）。
  return (
    <div className={`${hidden ? 'hidden' : 'flex'} shrink-0 flex-col bg-bg-input`} style={{ width }}>
      {/* xterm 挂载点：内边距留一点，背景由主题变量驱动 */}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1.5" />
    </div>
  );
}
