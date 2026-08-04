/**
 * TerminalService — 面板内嵌终端的后端，基于 @lydell/node-pty 的真 PTY
 * （Windows ConPTY）。预编译 N-API 二进制，Electron 33 免 rebuild 直接加载。
 *
 * 每个会话对应一个常驻 PTY（Windows: PowerShell；其它: bash/zsh），
 * cwd = 会话工作目录；真 TTY 支持颜色 / 光标定位 / TUI(vim/htop) / resize。
 * stdin 收 renderer 键入，输出流回 renderer。按会话 id 复用（切会话保留
 * 终端）；cwd 变化或进程退出则重建；app 退出或会话删除时 kill。
 */

import { existsSync } from 'node:fs';
import type { WebContents } from 'electron';
import * as pty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';

import { IPC } from '@shared/ipc';
import { log } from '../log/logger';

interface TermSession {
  proc: IPty;
  cwd: string;
}

/** 交互式 shell 可执行名（真 PTY 下无需附加 stdin 命令参数）。 */
function shellCommand(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash';
}

export class TerminalService {
  private readonly sessions = new Map<string, TermSession>();
  private target: WebContents | undefined;

  attach(target: WebContents): void {
    this.target = target;
  }

  /** 确保会话终端存在（幂等）；cwd 变化或进程已死则重建。 */
  create(id: string, cwd: string): void {
    const existing = this.sessions.get(id);
    if (existing && existing.cwd === cwd) return;
    if (existing) this.dispose(id);

    const command = shellCommand();
    const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [];
    let proc: IPty;
    try {
      proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd && existsSync(cwd) ? cwd : process.env.USERPROFILE || process.cwd(),
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      log.error('terminal', 'pty spawn failed', { id, cwd, command }, err);
      throw err;
    }

    proc.onData((d) => this.emit(id, d));
    proc.onExit(({ exitCode }) => {
      this.emit(id, `\r\n\x1b[90m[shell exited: ${exitCode}]\x1b[0m\r\n`);
      log.info('terminal', 'shell exited', { id, exitCode });
      if (this.sessions.get(id)?.proc === proc) this.sessions.delete(id);
    });

    this.sessions.set(id, { proc, cwd });
    log.info('terminal', 'shell created', { id, cwd, command });
  }

  /** renderer 键入 → PTY。 */
  input(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data);
  }

  /** xterm fit → PTY resize（真 TTY 才能让 TUI 正确重排）。 */
  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || cols < 1 || rows < 1) return;
    try {
      s.proc.resize(cols, rows);
    } catch {
      /* 进程可能已退出 — 忽略 */
    }
  }

  dispose(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try {
      s.proc.kill();
    } catch {
      /* already dead */
    }
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }

  private emit(id: string, data: string): void {
    if (this.target && !this.target.isDestroyed()) {
      this.target.send(IPC.terminalData, { id, data });
    }
  }
}
