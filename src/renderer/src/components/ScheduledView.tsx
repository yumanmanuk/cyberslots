/**
 * ScheduledView — cron task manager modal (codex desktop "Scheduled
 * tasks" equivalent): list with enable toggle / run-now / delete, plus
 * an inline create-edit form. Cron parsing happens in the main process;
 * save errors surface inline.
 */

import { useEffect, useState } from 'react';
import { CalendarClock, Pencil, Play, Plus, Trash2, X } from 'lucide-react';

import type { CronTask } from '@shared/types';
import { useChatStore } from '../store/chatStore';

const EMPTY: CronTask = {
  id: '',
  name: '',
  cron: '0 9 * * 1-5',
  prompt: '',
  engine: 'codex',
  cwd: '',
  enabled: true,
  createdAt: 0,
};

export default function ScheduledView(): JSX.Element | null {
  const open = useChatStore((s) => s.cronOpen);
  const tasks = useChatStore((s) => s.cronTasks);
  const loadCron = useChatStore((s) => s.loadCron);
  const saveCron = useChatStore((s) => s.saveCron);
  const deleteCron = useChatStore((s) => s.deleteCron);
  const runCronNow = useChatStore((s) => s.runCronNow);
  const [editing, setEditing] = useState<CronTask | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setEditing(null);
      setError('');
      void loadCron();
    }
  }, [open, loadCron]);

  if (!open) return null;

  const close = (): void => useChatStore.setState({ cronOpen: false });
  const submit = async (): Promise<void> => {
    if (!editing) return;
    try {
      await saveCron(editing);
      setEditing(null);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={close}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[680px] flex-col overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <CalendarClock size={15} /> 定时任务
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                setEditing({ ...EMPTY });
                setError('');
              }}
              className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-ui text-ink-soft hover:bg-bg-hover"
            >
              <Plus size={13} /> 新建
            </button>
            <button onClick={close} className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-ink">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {editing ? (
            <TaskForm task={editing} onChange={setEditing} onSubmit={() => void submit()} onCancel={() => setEditing(null)} error={error} />
          ) : tasks.length === 0 ? (
            <div className="py-14 text-center text-ui leading-7 text-ink-faint">
              还没有定时任务
              <br />
              新建一个：按 cron 计划自动向引擎发送 prompt，结果落到新会话并系统通知
            </div>
          ) : (
            <div className="space-y-2">
              {tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onToggle={() => void saveCron({ ...t, enabled: !t.enabled })}
                  onEdit={() => {
                    setEditing(t);
                    setError('');
                  }}
                  onRun={() => void runCronNow(t.id)}
                  onDelete={() => void deleteCron(t.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onToggle,
  onEdit,
  onRun,
  onDelete,
}: {
  task: CronTask;
  onToggle: () => void;
  onEdit: () => void;
  onRun: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className={`rounded-xl border border-line px-4 py-3 ${task.enabled ? 'bg-bg' : 'bg-bg-panel/50 opacity-70'}`}>
      <div className="flex items-center gap-2">
        <button
          title={task.enabled ? '点击停用' : '点击启用'}
          onClick={onToggle}
          className={`h-4 w-7 rounded-full transition ${task.enabled ? 'bg-accent' : 'bg-bg-active'}`}
        >
          <span className={`block h-3 w-3 rounded-full bg-white transition ${task.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{task.name}</span>
        <code className="rounded-md bg-bg-active px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">{task.cron}</code>
        <button title="立即运行" onClick={onRun} className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-accent">
          <Play size={13} />
        </button>
        <button title="编辑" onClick={onEdit} className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-ink">
          <Pencil size={13} />
        </button>
        <button title="删除" onClick={onDelete} className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-err">
          <Trash2 size={13} />
        </button>
      </div>
      <div className="mt-1.5 line-clamp-2 pl-9 text-[11.5px] text-ink-faint">{task.prompt}</div>
      {task.lastRunAt && (
        <div className="mt-1 pl-9 text-[10.5px] text-ink-faint">
          上次运行 {new Date(task.lastRunAt).toLocaleString()} ·{' '}
          <span className={task.lastResult === 'ok' ? 'text-ok' : 'text-err'}>{task.lastResult === 'ok' ? '成功' : '失败'}</span>
        </div>
      )}
    </div>
  );
}

function TaskForm({
  task,
  onChange,
  onSubmit,
  onCancel,
  error,
}: {
  task: CronTask;
  onChange: (t: CronTask) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error: string;
}): JSX.Element {
  const pickFolder = async (): Promise<void> => {
    const dir = await window.cyberslots.dialogPickFolder();
    if (dir) onChange({ ...task, cwd: dir });
  };
  return (
    <div className="space-y-3">
      <Field label="任务名">
        <input
          value={task.name}
          onChange={(e) => onChange({ ...task, name: e.target.value })}
          placeholder="例如：每日晨报"
          className="w-full rounded-lg border border-line bg-bg-input px-2.5 py-1.5 text-ui outline-none focus:border-accent"
        />
      </Field>
      <Field label="Cron 计划（分 时 日 月 周）">
        <input
          value={task.cron}
          onChange={(e) => onChange({ ...task, cron: e.target.value })}
          spellCheck={false}
          className="w-56 rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
        />
        <span className="ml-2 text-[11px] text-ink-faint">如 0 9 * * 1-5 = 工作日每天 9:00</span>
      </Field>
      <Field label="Prompt">
        <textarea
          value={task.prompt}
          onChange={(e) => onChange({ ...task, prompt: e.target.value })}
          rows={4}
          placeholder="触发时发送给引擎的任务指令"
          className="w-full resize-y rounded-lg border border-line bg-bg-input px-2.5 py-1.5 text-ui outline-none focus:border-accent"
        />
      </Field>
      <Field label="工作目录（留空 = 纯对话）">
        <div className="flex items-center gap-2">
          <input
            value={task.cwd}
            onChange={(e) => onChange({ ...task, cwd: e.target.value })}
            placeholder="D:\path\to\project"
            spellCheck={false}
            className="flex-1 rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
          />
          <button onClick={() => void pickFolder()} className="rounded-lg border border-line px-3 py-1.5 text-ui text-ink-soft hover:bg-bg-hover">
            选择…
          </button>
        </div>
      </Field>
      {error && <div className="rounded-lg bg-err/10 px-3 py-2 text-ui text-err">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="rounded-lg border border-line px-4 py-1.5 text-ui text-ink-soft hover:bg-bg-hover">
          取消
        </button>
        <button onClick={onSubmit} className="rounded-lg bg-accent px-4 py-1.5 text-ui font-medium text-white hover:opacity-90">
          保存任务
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-ink-faint">{label}</div>
      {children}
    </div>
  );
}
