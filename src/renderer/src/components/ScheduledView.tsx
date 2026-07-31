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
import { useT } from '../i18n';
import { BrandHero, BrandSpinner } from './brand';

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
  const t = useT();
  const open = useChatStore((s) => s.cronOpen);
  const tasks = useChatStore((s) => s.cronTasks);
  const loadCron = useChatStore((s) => s.loadCron);
  const saveCron = useChatStore((s) => s.saveCron);
  const deleteCron = useChatStore((s) => s.deleteCron);
  const runCronNow = useChatStore((s) => s.runCronNow);
  const [editing, setEditing] = useState<CronTask | null>(null);
  const [error, setError] = useState('');
  /* 列表未到达前 cronTasks 是初始 []，与真正的空态不可分 — 用本地标志区分三态 */
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setEditing(null);
      setError('');
      setLoaded(false);
      void loadCron().finally(() => setLoaded(true));
    }
  }, [open, loadCron]);

  if (!open) return null;

  const close = (): void => useChatStore.setState({ cronOpen: false });
  const submit = async (): Promise<void> => {
    if (!editing) return;
    setSaving(true);
    try {
      await saveCron(editing);
      setEditing(null);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
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
            <CalendarClock size={15} /> {t('scheduled')}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                setEditing({ ...EMPTY });
                setError('');
              }}
              className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-ui text-ink-soft hover:bg-bg-hover"
            >
              <Plus size={13} /> {t('cronNew')}
            </button>
            <button onClick={close} className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-ink">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {editing ? (
            <TaskForm task={editing} onChange={setEditing} onSubmit={() => void submit()} onCancel={() => setEditing(null)} error={error} saving={saving} />
          ) : !loaded ? (
            <div className="flex flex-col items-center gap-2 py-14 text-ui text-ink-faint">
              {/* 面板内容区级等待按规范用 BrandHero */}
              <BrandHero size={48} />
              {t('cronLoading')}
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-14 text-center text-ui leading-7 text-ink-faint">
              <BrandHero size={56} />
              <div>
                {t('cronEmpty')}
                <br />
                {t('cronEmptyHint')}
              </div>
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
                  onRun={() => runCronNow(t.id)}
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
  onRun: () => Promise<void>;
  onDelete: () => void;
}): JSX.Element {
  /* 立即运行会真正拉起引擎会话 — 进行中态用品牌 spinner 替换图标（同 MissionControl） */
  const [running, setRunning] = useState(false);
  const t = useT();
  return (
    <div className={`rounded-xl border border-line px-4 py-3 ${task.enabled ? 'bg-bg' : 'bg-bg-panel/50 opacity-70'}`}>
      <div className="flex items-center gap-2">
        <button
          title={task.enabled ? t('cronToggleOff') : t('cronToggleOn')}
          onClick={onToggle}
          className={`h-4 w-7 rounded-full transition ${task.enabled ? 'bg-accent' : 'bg-bg-active'}`}
        >
          <span className={`block h-3 w-3 rounded-full bg-white transition ${task.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{task.name}</span>
        <code className="rounded-md bg-bg-active px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">{task.cron}</code>
        <button
          title={t('mcCronRunNow')}
          disabled={running}
          onClick={() => {
            setRunning(true);
            void onRun().finally(() => setTimeout(() => setRunning(false), 1500));
          }}
          className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-accent disabled:opacity-50"
        >
          {running ? <BrandSpinner size={13} /> : <Play size={13} />}
        </button>
        <button title={t('cronEdit')} onClick={onEdit} className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-ink">
          <Pencil size={13} />
        </button>
        <button title={t('cronDelete')} onClick={onDelete} className="rounded-md p-1 text-ink-faint hover:bg-bg-hover hover:text-err">
          <Trash2 size={13} />
        </button>
      </div>
      <div className="mt-1.5 line-clamp-2 pl-9 text-[11.5px] text-ink-faint">{task.prompt}</div>
      {task.lastRunAt && (
        <div className="mt-1 pl-9 text-[10.5px] text-ink-faint">
          {t('cronLastRun', { time: new Date(task.lastRunAt).toLocaleString() })} ·{' '}
          <span className={task.lastResult === 'ok' ? 'text-ok' : 'text-err'}>{task.lastResult === 'ok' ? t('cronOk') : t('cronFail')}</span>
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
  saving,
}: {
  task: CronTask;
  onChange: (t: CronTask) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error: string;
  saving: boolean;
}): JSX.Element {
  const t = useT();
  const pickFolder = async (): Promise<void> => {
    const dir = await window.cyberslots.dialogPickFolder();
    if (dir) onChange({ ...task, cwd: dir });
  };
  return (
    <div className="space-y-3">
      <Field label={t('cronFieldName')}>
        <input
          value={task.name}
          onChange={(e) => onChange({ ...task, name: e.target.value })}
          placeholder={t('cronNamePlaceholder')}
          className="w-full rounded-lg border border-line bg-bg-input px-2.5 py-1.5 text-ui outline-none focus:border-accent"
        />
      </Field>
      <Field label={t('cronFieldCron')}>
        <input
          value={task.cron}
          onChange={(e) => onChange({ ...task, cron: e.target.value })}
          spellCheck={false}
          className="w-56 rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
        />
        <span className="ml-2 text-[11px] text-ink-faint">{t('cronExample')}</span>
      </Field>
      <Field label="Prompt">
        <textarea
          value={task.prompt}
          onChange={(e) => onChange({ ...task, prompt: e.target.value })}
          rows={4}
          placeholder={t('cronPromptPlaceholder')}
          className="w-full resize-y rounded-lg border border-line bg-bg-input px-2.5 py-1.5 text-ui outline-none focus:border-accent"
        />
      </Field>
      <Field label={t('cronFieldCwd')}>
        <div className="flex items-center gap-2">
          <input
            value={task.cwd}
            onChange={(e) => onChange({ ...task, cwd: e.target.value })}
            placeholder="D:\path\to\project"
            spellCheck={false}
            className="flex-1 rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
          />
          <button onClick={() => void pickFolder()} className="rounded-lg border border-line px-3 py-1.5 text-ui text-ink-soft hover:bg-bg-hover">
            {t('cronPickFolder')}
          </button>
        </div>
      </Field>
      {error && <div className="rounded-lg bg-err/10 px-3 py-2 text-ui text-err">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="rounded-lg border border-line px-4 py-1.5 text-ui text-ink-soft hover:bg-bg-hover">
          {t('cancel')}
        </button>
        <button
          onClick={onSubmit}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-ui font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {saving && <BrandSpinner size={12} />}
          {t('cronSave')}
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
