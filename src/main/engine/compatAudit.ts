/**
 * compatAudit — 引擎兼容性审计（优雅降级的"记账"半边）。
 *
 * 各 adapter 在「未知事件 / 被拒方法 / 解析失败」的降级点调用 record()：
 * 用户侧保持静默不打断，维护者侧全量留痕 —— 内存按指纹（engine+kind+detail）
 * 聚合计数供 UI 小黄点/诊断卡展示，原始报文样本落 userData/logs/
 * compat-audit.jsonl（每指纹只落前几条，防高频未知事件刷爆磁盘）。
 * 引擎升级后行为漂移（砍方法/加事件/改格式）由此第一时间可见。
 */

import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { IPC } from '@shared/ipc';
import type { CompatAuditEntry, CompatAuditKind, CompatAuditSnapshot, EngineId } from '@shared/types';

/** 同一指纹落盘的原始报文样本上限（此后仅内存计数）。 */
const SAMPLE_LOG_LIMIT = 3;
/** 样本报文截断长度（防超长 stdout 噪音撑爆日志行）。 */
const SAMPLE_MAX_CHARS = 2000;
/** 推送节流：高频未知事件按批合并，不逐条打渲染层。 */
const PUSH_THROTTLE_MS = 1500;

class CompatAudit {
  private readonly entries = new Map<EngineId, Map<string, CompatAuditEntry>>();
  private target?: Electron.WebContents;
  private pushTimer?: NodeJS.Timeout;
  private logDirReady = false;

  /** 窗口创建/重建时接线推送目标。 */
  attach(target: Electron.WebContents): void {
    this.target = target;
  }

  /** 降级点统一入口 — 永不抛错（审计自身故障不能反过来弄崩会话链路）。 */
  record(engine: EngineId, kind: CompatAuditKind, detail: string, raw?: unknown): void {
    try {
      const now = Date.now();
      let byKey = this.entries.get(engine);
      if (!byKey) this.entries.set(engine, (byKey = new Map()));
      const key = `${kind}:${detail}`;
      let entry = byKey.get(key);
      if (!entry) {
        byKey.set(key, (entry = { kind, detail, count: 0, firstTs: now, lastTs: now }));
        console.warn(`[compat-audit] ${engine} ${kind}: ${detail}`);
      }
      entry.count += 1;
      entry.lastTs = now;
      if (entry.count <= SAMPLE_LOG_LIMIT) this.appendLog(engine, kind, detail, now, raw);
      this.schedulePush();
    } catch {
      /* 审计尽力而为 */
    }
  }

  snapshot(): CompatAuditSnapshot {
    const engines: CompatAuditSnapshot['engines'] = {};
    for (const [engine, byKey] of this.entries) {
      engines[engine] = [...byKey.values()].sort((a, b) => b.lastTs - a.lastTs);
    }
    return { engines, logFile: this.logFile };
  }

  get logFile(): string {
    return join(app.getPath('userData'), 'logs', 'compat-audit.jsonl');
  }

  private appendLog(engine: EngineId, kind: CompatAuditKind, detail: string, ts: number, raw?: unknown): void {
    try {
      if (!this.logDirReady) {
        mkdirSync(join(app.getPath('userData'), 'logs'), { recursive: true });
        this.logDirReady = true;
      }
      let sample: string | undefined;
      if (raw !== undefined) {
        sample = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (sample && sample.length > SAMPLE_MAX_CHARS) sample = sample.slice(0, SAMPLE_MAX_CHARS) + '…';
      }
      appendFileSync(this.logFile, JSON.stringify({ ts, engine, kind, detail, sample }) + '\n', 'utf8');
    } catch (err) {
      console.error('[compat-audit] append log failed:', err);
    }
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      if (this.target && !this.target.isDestroyed()) {
        this.target.send(IPC.compatAudit, this.snapshot());
      }
    }, PUSH_THROTTLE_MS);
  }
}

/** 进程级单例 — adapter/rpc/EventHub 直接 import 使用，无需穿参。 */
export const compatAudit = new CompatAudit();
