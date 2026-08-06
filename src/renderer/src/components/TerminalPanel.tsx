/**
 * TerminalPanel — 右侧 dock 内嵌终端（xterm.js + 主进程 node-pty 真 TTY）。
 *
 * 按终端 tab id 建 / 复用后端 PTY（cwd = 选定的工作区根目录）；支持多实例，
 * 非活动 tab 用 hidden 隐藏（xterm 实例保活，切回时滚动缓冲不丢）。
 * fit addon 随面板宽高自适应并把尺寸同步给 PTY。标题与关闭按钮由
 * RightDock 的统一 tab 栏接管，本组件只渲染终端本体。
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { MessageSquarePlus } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

import { useChatStore } from '../store/chatStore';
import { useT } from '../i18n';

/** 选区浮动按钮的定位快照（相对根容器）。 */
interface SelBtnState {
  top: number;
  left: number;
  lines: number;
}

/** 从 xterm 内部渲染尺寸读单元格 CSS 像素（canvas 兜底，避免内部字段漂移时崩）。 */
function readCellSize(term: Terminal): { w: number; h: number } | null {
  const el = term.element;
  if (!el) return null;
  const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  if (cell?.width && cell?.height) return { w: cell.width, h: cell.height };
  const canvas = el.querySelector<HTMLElement>('.xterm-screen canvas');
  if (canvas && term.cols > 0 && term.rows > 0) {
    const r = canvas.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { w: r.width / term.cols, h: r.height / term.rows };
  }
  return null;
}

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

export default function TerminalPanel({
  termId,
  cwd,
  width,
  hidden,
  sessionId,
}: {
  termId: string;
  cwd: string;
  width: number;
  hidden: boolean;
  sessionId: string;
}): JSX.Element {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // hidden 是切换 tab 的瞬时态，effect 里读最新值需走 ref。
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [selBtn, setSelBtn] = useState<SelBtnState | null>(null);
  const addSelection = useChatStore((s) => s.addSelection);

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
    // URL 可点击：hover 下划线高亮 + 点击经 window.open → 主进程
    // setWindowOpenHandler 拦截 → shell.openExternal 交系统浏览器。
    // 只放行 http/https，与主进程外链规则一致。
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener');
      }),
    );
    term.open(host);
    termRef.current = term;
    try {
      fit.fit();
    } catch {
      /* host 可能尚未布局（初始 hidden） */
    }

    /** 选区存在且终点可见时，把「添加到对话」按钮钉到选区末端右下角。 */
    const updateSelBtn = (): void => {
      const root = rootRef.current;
      if (!root || hiddenRef.current) {
        setSelBtn(null);
        return;
      }
      const text = term.getSelection();
      const range = term.getSelectionPosition();
      if (!text || !range) {
        setSelBtn(null);
        return;
      }
      const cell = readCellSize(term);
      if (!cell) {
        setSelBtn(null);
        return;
      }
      // getSelectionPosition 实际返回 0-based buffer 坐标（end.x 为排他列），
      // 类型注释里的 1-based 与实现不符 —— 这里按实现算。
      let endRow = range.end.y - term.buffer.active.viewportY;
      let endCol = range.end.x;
      // 整行选到下一行行首（end.x === 0）时，钉到上一行末尾更贴内容。
      if (endCol === 0 && endRow > 0) {
        endRow -= 1;
        endCol = term.cols;
      }
      if (endRow < 0 || endRow >= term.rows) {
        setSelBtn(null);
        return;
      }
      const el = term.element;
      if (!el) {
        setSelBtn(null);
        return;
      }
      const termRect = el.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').length || 1;
      setSelBtn({
        top: Math.max(0, Math.min(termRect.top - rootRect.top + (endRow + 1) * cell.h + 6, rootRect.height - 30)),
        left: Math.max(8, Math.min(termRect.left - rootRect.left + endCol * cell.w, rootRect.width - 150)),
        lines,
      });
    };

    // 选区变化/滚动/尺寸变化都会让按钮位置失效，统一重算（滚动后终点可能已出视口）。
    const offSel = term.onSelectionChange(updateSelBtn);
    const offScroll = term.onScroll(updateSelBtn);
    const offResize = term.onResize(updateSelBtn);

    // Ctrl+C（有选区时复制而非发 ^C）；Ctrl+Shift+C 恒为复制。复制后保留选区，
    // 用户仍可继续点「添加到对话」。
    const copySelection = (): void => {
      const text = term.getSelection();
      if (!text) return;
      void navigator.clipboard.writeText(text).catch(() => undefined);
    };
    term.attachCustomKeyEventHandler((e) => {
      const isC = e.key.toLowerCase() === 'c';
      if (!e.ctrlKey || e.altKey || e.metaKey || !isC) return true;
      if (e.shiftKey) {
        if (term.hasSelection()) copySelection();
        return false;
      }
      if (term.hasSelection()) {
        copySelection();
        return false;
      }
      return true; // 无选区时放行 ^C 给 shell
    });

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
      // fit 后单元格尺寸可能变化，重新钉按钮位置。
      updateSelBtn();
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
      offSel.dispose();
      offScroll.dispose();
      offResize.dispose();
      offData();
      inputDisp.dispose();
      termRef.current = null;
      term.dispose();
      // 后端 shell 保留（不 dispose）—— 关 tab 时由 store.removeTerminal 收尾。
    };
  }, [termId, cwd]);

  // hidden 时保持挂载（xterm 缓冲保活），显示时 ResizeObserver 触发重排。
  // 宽度由 RightDock 统一管理（dock 左缘把手拖拽）。
  const addToChat = (): void => {
    if (!selBtn) return;
    const text = termRef.current?.getSelection();
    if (!text) return;
    addSelection(sessionId, {
      id: crypto.randomUUID(),
      termId,
      cwd,
      fileName: cwd.split(/[\\/]/).filter(Boolean).pop() ?? termId,
      text,
    });
    // 与文件预览一致：投递后清掉选区，按钮收起。
    termRef.current?.clearSelection();
    setSelBtn(null);
  };

  return (
    <div ref={rootRef} className={`${hidden ? 'hidden' : 'flex'} relative min-h-0 shrink-0 flex-col bg-bg-input`} style={{ width }}>
      {/* xterm 挂载点：内边距留一点，背景由主题变量驱动 */}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1.5" />
      {selBtn && (
        <button
          style={{ top: selBtn.top, left: selBtn.left }}
          // mousedown 阻止默认：保住 xterm 选区，click 才能拿到完整快照。
          onMouseDown={(e) => e.preventDefault()}
          onClick={addToChat}
          className="absolute z-20 flex animate-[sel-pop_.14s_ease-out] items-center gap-1.5 rounded-full bg-accent py-1 pl-2.5 pr-1.5 text-[11px] font-medium text-white shadow-lg shadow-accent/25 transition hover:brightness-110 active:scale-95"
        >
          <MessageSquarePlus size={12} />
          {t('addToChat')}
          {/* 选区行数徽标 — 投递前就能确认范围 */}
          <span className="rounded-full bg-white/20 px-1.5 font-mono text-[10px] leading-4 tabular-nums">{t('selLineCount', { n: selBtn.lines })}</span>
        </button>
      )}
    </div>
  );
}
