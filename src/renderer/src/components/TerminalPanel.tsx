/**
 * TerminalPanel — 右侧面板内嵌终端（xterm.js + 主进程 node-pty 真 TTY）。
 *
 * 按会话 id 建 / 复用后端 PTY（cwd = 会话目录）；xterm 负责渲染与键入，
 * fit addon 随面板宽高自适应并把尺寸同步给 PTY。切走面板时销毁 xterm
 * 实例但保留后端 shell（下次打开重连，历史输出由 shell 自身滚动保留）。
 */

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { X } from 'lucide-react';
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

export default function TerminalPanel({ sessionId, cwd, onClose }: { sessionId: string; cwd: string; onClose: () => void }): JSX.Element {
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
    fit.fit();

    // 后端 PTY：确保存在（cwd = 会话目录）+ 订阅输出流（仅本会话 id）。
    void window.cyberslots.terminalCreate(sessionId, cwd);
    const offData = window.cyberslots.onTerminalData((payload) => {
      if (payload.id === sessionId) term.write(payload.data);
    });
    const inputDisp = term.onData((data) => void window.cyberslots.terminalInput(sessionId, data));

    // 尺寸同步：初次 + 面板 resize → fit → 通知 PTY resize。
    const syncSize = (): void => {
      try {
        fit.fit();
      } catch {
        /* host 尚未布局 */
      }
      void window.cyberslots.terminalResize(sessionId, term.cols, term.rows);
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
      // 后端 shell 保留（不 dispose）—— 切走再回来仍是同一会话终端。
    };
  }, [sessionId, cwd]);

  return (
    <aside className="flex w-[440px] shrink-0 animate-[sheet-in_.15s_ease-out] flex-col border-l border-line bg-bg-input">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-ui font-medium text-ink">终端</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={cwd}>{cwd}</span>
        <button
          title="关闭"
          onClick={onClose}
          className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
      {/* xterm 挂载点：内边距留一点，背景由主题变量驱动 */}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1.5" />
    </aside>
  );
}
