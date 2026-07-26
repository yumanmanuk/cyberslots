/**
 * CronService — scheduled prompts ("定时任务", codex desktop Scheduled
 * tasks equivalent). Zero-dependency 5-field cron matcher, one tick per
 * minute; each firing runs a fresh headless session (visible in the
 * sidebar afterwards) and raises a system notification on completion.
 */

import { app, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CronTask } from '@shared/types';
import type { SessionManager } from '../engine/SessionManager';
import type { SettingsStore } from '../config/settings';
import { cronMatches, validateCron } from './cronMatch';

const TICK_MS = 20_000;

export class CronService {
  private tasks: CronTask[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** Minute key of the last evaluated tick — guarantees one firing per minute. */
  private lastMinuteKey = '';
  private readonly running = new Set<string>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly settings: SettingsStore,
  ) {
    this.load();
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): CronTask[] {
    return [...this.tasks].sort((a, b) => b.createdAt - a.createdAt);
  }

  save(task: CronTask): CronTask[] {
    if (!task.name.trim()) throw new Error('任务名不能为空');
    if (!task.prompt.trim()) throw new Error('prompt 不能为空');
    validateCron(task.cron);
    const normalized: CronTask = { ...task, id: task.id || randomUUID() };
    const idx = this.tasks.findIndex((t) => t.id === normalized.id);
    if (idx >= 0) this.tasks[idx] = normalized;
    else this.tasks.push({ ...normalized, createdAt: Date.now() });
    this.persist();
    return this.list();
  }

  delete(id: string): CronTask[] {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.persist();
    return this.list();
  }

  /** Manual "run now" from the UI — fires in the background. */
  runNow(id: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`unknown cron task: ${id}`);
    void this.run(task);
  }

  // ---------------------------------------------------------------- private

  private tick(): void {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    if (key === this.lastMinuteKey) return;
    this.lastMinuteKey = key;
    for (const task of this.tasks) {
      if (!task.enabled || this.running.has(task.id)) continue;
      try {
        if (cronMatches(task.cron, now)) void this.run(task);
      } catch {
        /* invalid expression — surfaced at save time, skip here */
      }
    }
  }

  private async run(task: CronTask): Promise<void> {
    if (this.running.has(task.id)) return;
    this.running.add(task.id);
    try {
      const meta = await this.sessions.create({
        engine: task.engine,
        cwd: task.cwd,
        title: `⏰ ${task.name}`,
      });
      task.lastSessionId = meta.id;
      // Echo the prompt so the session transcript shows what was asked.
      this.sessions.announceUser(meta.id, task.prompt);
      await this.sessions.prompt(meta.id, task.prompt);
      task.lastResult = 'ok';
      if (this.settings.get().notifications.taskComplete) {
        this.notify(`定时任务完成：${task.name}`, '结果已写入会话，可在侧栏查看。');
      }
    } catch (err) {
      task.lastResult = 'error';
      if (this.settings.get().notifications.error) {
        this.notify(`定时任务失败：${task.name}`, err instanceof Error ? err.message : String(err));
      }
    } finally {
      task.lastRunAt = Date.now();
      this.running.delete(task.id);
      this.persist();
    }
  }

  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    new Notification({ title, body }).show();
  }

  private get file(): string {
    return join(app.getPath('userData'), 'cron-tasks.json');
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.tasks, null, 2), 'utf8');
    } catch (err) {
      console.error('[cron] persist failed:', err);
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      this.tasks = JSON.parse(readFileSync(this.file, 'utf8')) as CronTask[];
    } catch (err) {
      console.error('[cron] load failed:', err);
    }
  }
}
