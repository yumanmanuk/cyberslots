/**
 * Composer — floating rounded input card. Control strip layout
 * (mode → engine → permissions → swarm/goal | model → effort → context
 * ring → expand → send), drag-and-drop attachments (images pinned above
 * the textarea, files as inline chips), Shift+Tab mode cycling, a goal
 * status line, and click-to-compact context ring.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  FileText,
  GripVertical,
  Image as ImageIcon,
  ListPlus,
  Maximize2,
  Pause,
  Pencil,
  Play,
  Square,
  Target,
  Trash2,
  X,
  Zap,
} from 'lucide-react';

import type { EngineId, PermissionMode } from '@shared/types';
import { useChatStore, type QueuedMessage } from '../store/chatStore';
import { useT, type MsgKey } from '../i18n';

const PERM_LABEL_KEYS: Record<string, MsgKey> = {
  default: 'permManual',
  auto: 'permAuto',
  yolo: 'permYolo',
};

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const EFFORT_LABEL_KEYS: Record<string, MsgKey> = {
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXhigh',
};

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

interface Attachment {
  path: string;
  name: string;
  isImage: boolean;
}

/** Escape 关闭裸弹层（非 Dropdown 封装的 popover 用）。 */
function useEscClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

export default function Composer({ sessionId }: { sessionId: string }): JSX.Element {
  const t = useT();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [ctxFullOpen, setCtxFullOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const goalActive = useChatStore((s) => !!s.goals[sessionId]);
  const sendKey = useChatStore((s) => s.settings?.sendKey ?? 'enter');
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  const cancel = useChatStore((s) => s.cancel);

  const busy = meta?.status === 'running' || meta?.status === 'awaiting';
  const isPlan = ui?.modes.current === 'plan';
  const usage = ui?.usage;
  const ctxFull = !!usage && usage.size > 0 && usage.used / usage.size >= 1;

  const send = (opts?: { force?: boolean }): void => {
    const value = text.trim();
    if (!value && attachments.length === 0) return;
    // 上下文 100%：先弹确认弹窗要求压缩，避免静默丢失早期内容。
    if (ctxFull && !opts?.force && !busy) {
      setCtxFullOpen(true);
      return;
    }
    const paths = attachments.length ? attachments.map((a) => a.path) : undefined;
    setText('');
    setAttachments([]);
    if (busy) {
      // 忙碌时入队，回合结束后自动依次发送
      useChatStore.getState().enqueue(value, paths);
    } else {
      void sendPrompt(value, paths);
    }
    textareaRef.current?.focus();
  };

  /** 🎯 Goal (codex-only): the composer text IS the objective — sent to the
   *  engine's native thread/goal/set. kimi's ACP surface has no goal API,
   *  so the button never renders for kimi sessions. */
  const sendGoal = (): void => {
    const goal = text.trim();
    if (!goal) return;
    setText('');
    void useChatStore.getState().setGoal(goal);
    textareaRef.current?.focus();
  };

  const cycleMode = (): void => {
    const setMode = useChatStore.getState().setMode;
    void setMode(isPlan ? 'default' : 'plan');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Tab' && e.shiftKey) {
      // Shift+Tab 循环 Agent / Plan
      e.preventDefault();
      cycleMode();
      return;
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // 发送键可配：Enter 发送（Shift+Enter 换行） / Ctrl+Enter 发送（Enter 换行）
    if (sendKey === 'ctrl-enter') {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        send();
      }
      return;
    }
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      send();
    }
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const next: Attachment[] = [];
    for (const file of Array.from(e.dataTransfer.files)) {
      const path = window.cyberslots.getPathForFile(file);
      if (!path || attachments.some((a) => a.path === path)) continue;
      next.push({ path, name: file.name, isImage: IMAGE_RE.test(path) });
    }
    if (next.length) setAttachments((prev) => [...prev, ...next]);
  };

  const removeAttachment = (path: string): void => setAttachments((prev) => prev.filter((a) => a.path !== path));

  const images = attachments.filter((a) => a.isImage);
  const files = attachments.filter((a) => !a.isImage);

  return (
    <div className="shrink-0 px-6 pb-5 pt-1">
      <GoalBar
        sessionId={sessionId}
        onEdit={(goalText) => {
          // 编辑 = 把目标回填输入框，改完再点 🎯 触发 UpdateGoal
          setText(goalText);
          textareaRef.current?.focus();
        }}
      />

      <QueuePanel
        sessionId={sessionId}
        onEditItem={(item) => {
          setText(item.text);
          useChatStore.getState().removeQueued(sessionId, item.id);
          textareaRef.current?.focus();
        }}
      />

      {/* 图片附件 — 输入框顶部 */}
      {images.length > 0 && (
        <div className="mx-auto mb-1.5 flex max-w-3xl flex-wrap gap-1.5">
          {images.map((a) => (
            <AttachmentChip key={a.path} att={a} onRemove={() => removeAttachment(a.path)} />
          ))}
        </div>
      )}

      <div
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        className="mx-auto max-w-3xl rounded-2xl border border-line bg-bg-input shadow-sm transition focus-within:border-ink-faint"
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          placeholder={busy ? t('inputBusy') : sendKey === 'ctrl-enter' ? t('inputPlaceholderCtrl') : t('inputPlaceholder')}
          className="w-full resize-none bg-transparent px-4 pb-1 pt-3 text-body outline-none placeholder:text-ink-faint"
        />

        {/* 文件附件 — 输入框内高亮小块 */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pb-1.5">
            {files.map((a) => (
              <AttachmentChip key={a.path} att={a} onRemove={() => removeAttachment(a.path)} />
            ))}
          </div>
        )}

        <div className="flex items-center gap-1.5 px-3 pb-2.5">
          <ModeSwitch isPlan={isPlan} onCycle={cycleMode} />
          <EngineBadge sessionId={sessionId} />
          {!isPlan && <PermissionPicker sessionId={sessionId} />}
          <SwarmToggle />
          {meta?.engine === 'codex' && (
            <button
              title={text.trim() ? (goalActive ? `${t('goal')} · 更新目标` : `${t('goal')} · 以输入框内容创建目标`) : `${t('goal')} · 先在输入框写目标，再点此触发`}
              onClick={sendGoal}
              disabled={!text.trim()}
              className={`flex items-center gap-1 rounded-lg px-2 py-1 text-ui transition disabled:opacity-40 ${
                goalActive ? 'bg-accent-soft font-medium text-accent' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
              }`}
            >
              <Target size={13} />
            </button>
          )}

          <div className="flex-1" />

          <ModelPicker sessionId={sessionId} />
          {meta?.engine === 'codex' && <EffortPicker sessionId={sessionId} />}
          <ContextRing sessionId={sessionId} />
          <button
            title={t('expandInput')}
            onClick={() => setExpanded(true)}
            className="rounded-lg p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
          >
            <Maximize2 size={13} />
          </button>
          {busy ? (
            <div className="flex items-center gap-1.5">
              {(text.trim() || attachments.length > 0) && (
                <button
                  onClick={() => send()}
                  title={t('enqueue')}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-accent/40 bg-accent-soft text-accent transition hover:opacity-85"
                >
                  <ListPlus size={15} />
                </button>
              )}
              <button
                onClick={() => void cancel()}
                title={t('stop')}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-bg transition hover:opacity-80"
              >
                <Square size={13} fill="currentColor" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => send()}
              disabled={!text.trim() && attachments.length === 0}
              title={t('send')}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition hover:opacity-90 disabled:opacity-30"
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
      {isPlan && <div className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-ink-faint">{t('planHint')}</div>}

      {expanded && (
        <ExpandDialog
          value={text}
          onChange={setText}
          onSend={() => {
            setExpanded(false);
            send();
          }}
          onClose={() => setExpanded(false)}
        />
      )}

      {ctxFullOpen && (
        <CtxFullDialog
          onCompact={() => {
            setCtxFullOpen(false);
            void useChatStore.getState().compactSession();
          }}
          onSendAnyway={() => {
            setCtxFullOpen(false);
            send({ force: true });
          }}
          onClose={() => setCtxFullOpen(false)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ send queue

const EMPTY_QUEUE: QueuedMessage[] = [];

/** Pending-send outbox above the input (qoder-style "等待发送 N"):
 *  drag to reorder, edit back into the composer, delete, or steer. */
function QueuePanel({
  sessionId,
  onEditItem,
}: {
  sessionId: string;
  onEditItem: (item: QueuedMessage) => void;
}): JSX.Element | null {
  const t = useT();
  const queue = useChatStore((s) => s.queues[sessionId]) ?? EMPTY_QUEUE;
  const removeQueued = useChatStore((s) => s.removeQueued);
  const moveQueued = useChatStore((s) => s.moveQueued);
  const steerQueued = useChatStore((s) => s.steerQueued);
  const [collapsed, setCollapsed] = useState(false);
  const dragFrom = useRef<number | null>(null);

  if (queue.length === 0) return null;

  return (
    <div className="mx-auto mb-1.5 max-w-3xl overflow-hidden rounded-xl border border-line bg-bg-panel/60">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-medium text-ink-soft transition hover:bg-bg-hover"
      >
        <ChevronRight size={12} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        {t('queueWaiting')} {queue.length}
      </button>
      {!collapsed && (
        <div>
          {queue.map((item, i) => (
            <div
              key={item.id}
              draggable
              onDragStart={() => (dragFrom.current = i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom.current !== null && dragFrom.current !== i) moveQueued(sessionId, dragFrom.current, i);
                dragFrom.current = null;
              }}
              className="group flex items-center gap-1.5 border-t border-line px-2 py-1.5"
            >
              <GripVertical size={13} className="shrink-0 cursor-grab text-ink-faint/60 group-hover:text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={item.text}>
                {item.text}
              </span>
              <button
                title={t('queueSteer')}
                onClick={() => void steerQueued(sessionId, item.id)}
                className="rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-bg-hover hover:text-accent group-hover:opacity-100"
              >
                <ArrowUp size={12} className="rotate-45" />
              </button>
              <button
                title={t('queueEdit')}
                onClick={() => onEditItem(item)}
                className="rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-bg-hover hover:text-ink group-hover:opacity-100"
              >
                <Pencil size={12} />
              </button>
              <button
                title={t('remove')}
                onClick={() => removeQueued(sessionId, item.id)}
                className="rounded-md p-1 text-ink-faint opacity-0 transition hover:bg-bg-hover hover:text-err group-hover:opacity-100"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ attachments

function AttachmentChip({ att, onRemove }: { att: Attachment; onRemove: () => void }): JSX.Element {
  return (
    <span
      title={att.path}
      className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent-soft px-2 py-1 text-[11.5px] font-medium text-accent"
    >
      {att.isImage ? <ImageIcon size={12} /> : <FileText size={12} />}
      <span className="max-w-44 truncate">{att.name}</span>
      <button onClick={onRemove} className="rounded-md transition hover:opacity-70">
        <X size={11} />
      </button>
    </span>
  );
}

// ------------------------------------------------------------ mode/engine

function ModeSwitch({ isPlan, onCycle }: { isPlan: boolean; onCycle: () => void }): JSX.Element {
  const t = useT();
  const setMode = useChatStore((s) => s.setMode);
  void onCycle;
  return (
    <div title="Shift+Tab 切换" className="flex items-center gap-0.5 rounded-lg border border-line bg-bg-panel p-0.5">
      <button
        onClick={() => void setMode('default')}
        className={`rounded-md px-2 py-0.5 text-[11px] transition ${!isPlan ? 'bg-bg font-medium text-ink shadow-sm' : 'text-ink-faint hover:text-ink'}`}
      >
        {t('modeAgent')}
      </button>
      <button
        onClick={() => void setMode('plan')}
        className={`rounded-md px-2 py-0.5 text-[11px] transition ${isPlan ? 'bg-bg font-medium text-ink shadow-sm' : 'text-ink-faint hover:text-ink'}`}
      >
        {t('modePlan')}
      </button>
    </div>
  );
}

function EngineBadge({ sessionId }: { sessionId: string }): JSX.Element | null {
  const t = useT();
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const forkToEngine = useChatStore((s) => s.forkToEngine);
  const [open, setOpen] = useState(false);
  if (!meta) return null;
  const other: EngineId = meta.engine === 'kimi' ? 'codex' : 'kimi';

  return (
    <div className="relative">
      <button
        title={t('engine')}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui font-medium text-ink-soft transition hover:bg-bg-hover"
      >
        {meta.engine === 'kimi' ? 'Kimi Code' : 'Codex'}
        <ChevronDown size={11} />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)}>
          <div className="px-3 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">{t('continueWith')}</div>
          <DropdownItem
            active={false}
            onClick={() => {
              setOpen(false);
              void forkToEngine(sessionId, other);
            }}
          >
            ⇄ {other === 'kimi' ? 'Kimi Code' : 'Codex'}
          </DropdownItem>
        </Dropdown>
      )}
    </div>
  );
}

function PermissionPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const t = useT();
  const ui = useChatStore((s) => s.ui[sessionId]);
  const setMode = useChatStore((s) => s.setMode);
  const [open, setOpen] = useState(false);
  const current = ui?.modes.current ?? 'default';
  const options: PermissionMode[] = ['default', 'auto', 'yolo'];
  const label = (m: string): string => (PERM_LABEL_KEYS[m] ? t(PERM_LABEL_KEYS[m]!) : m);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
      >
        {label(current)}
        <ChevronDown size={11} />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)}>
          {options.map((m) => (
            <DropdownItem
              key={m}
              active={m === current}
              onClick={() => {
                setOpen(false);
                void setMode(m);
              }}
            >
              {label(m)}
            </DropdownItem>
          ))}
        </Dropdown>
      )}
    </div>
  );
}

function SwarmToggle(): JSX.Element {
  const t = useT();
  const swarmBoost = useChatStore((s) => s.swarmBoost);
  return (
    <button
      title={swarmBoost ? t('swarmOn') : t('swarmOff')}
      onClick={() => useChatStore.setState({ swarmBoost: !swarmBoost })}
      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-ui transition ${
        swarmBoost ? 'bg-accent-soft font-medium text-accent' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
      }`}
    >
      <Zap size={13} fill={swarmBoost ? 'currentColor' : 'none'} />
    </button>
  );
}

// -------------------------------------------------------- model & effort

function ModelPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const ui = useChatStore((s) => s.ui[sessionId]);
  const setModel = useChatStore((s) => s.setModel);
  const [open, setOpen] = useState(false);
  const models = ui?.models;
  if (!models?.current) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
      >
        <span className="font-medium">{models.current}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)} align="right">
          {models.available.map((m) => (
            <DropdownItem
              key={m}
              active={m === models.current}
              onClick={() => {
                setOpen(false);
                void setModel(m);
              }}
            >
              {m}
            </DropdownItem>
          ))}
        </Dropdown>
      )}
    </div>
  );
}

/** 思考深度 — codex 桌面版同款滑条交互：弹层里一条 4 档滑轨，
 *  拖动/点击档位即选，标题行实时显示当前档位名。 */
function EffortPicker({ sessionId }: { sessionId: string }): JSX.Element {
  const t = useT();
  const effort = useChatStore((s) => s.efforts[sessionId] ?? 'medium');
  const [open, setOpen] = useState(false);
  useEscClose(open, () => setOpen(false));
  const idx = Math.max(0, EFFORTS.indexOf(effort));
  const label = (e: string): string => (EFFORT_LABEL_KEYS[e] ? t(EFFORT_LABEL_KEYS[e]!) : e);

  const select = (i: number): void => {
    const value = EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, i))]!;
    useChatStore.setState((s) => ({ efforts: { ...s.efforts, [sessionId]: value } }));
  };

  return (
    <div className="relative">
      <button
        title={t('effort')}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
      >
        {label(effort)}
        <ChevronDown size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-9 right-0 z-20 w-56 rounded-2xl border border-line bg-bg-input p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-ui font-medium">{label(effort)}</span>
              <ChevronRight size={12} className="text-ink-faint" />
            </div>
            <EffortSlider index={idx} count={EFFORTS.length} onSelect={select} />
            <div className="mt-2 flex justify-between text-[10px] text-ink-faint">
              <span>{label('low')}</span>
              <span>{label('xhigh')}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 4-stop slider: filled accent track up to the thumb, dots on the rest. */
function EffortSlider({ index, count, onSelect }: { index: number; count: number; onSelect: (i: number) => void }): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const pick = (clientX: number): void => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    onSelect(Math.round(ratio * (count - 1)));
  };

  return (
    <div
      ref={trackRef}
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        pick(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && pick(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      className="relative h-5 cursor-pointer touch-none select-none"
    >
      <div className="absolute left-0 right-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-bg-active" />
      <div
        className="absolute left-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-accent transition-all duration-150"
        style={{ width: `calc(${(index / (count - 1)) * 100}% + ${index === 0 ? 10 : 0}px)`, minWidth: 18 }}
      />
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={`absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition ${
            i <= index ? 'bg-white/70' : 'bg-ink-faint/40'
          }`}
          style={{ left: `${(i / (count - 1)) * 92 + 4}%` }}
        />
      ))}
      <span
        className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line bg-white shadow-md transition-all duration-150"
        style={{ left: `${(index / (count - 1)) * 100}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------- context ring

function ContextRing({ sessionId }: { sessionId: string }): JSX.Element | null {
  const t = useT();
  const usage = useChatStore((s) => s.ui[sessionId]?.usage);
  const compactSession = useChatStore((s) => s.compactSession);
  const [open, setOpen] = useState(false);
  useEscClose(open, () => setOpen(false));
  if (!usage || usage.size <= 0) return null;

  const pct = Math.min(1, usage.used / usage.size);
  const R = 6.5;
  const CIRC = 2 * Math.PI * R;
  const color = pct > 0.85 ? 'var(--err)' : pct > 0.65 ? 'var(--warn)' : 'var(--ink-faint)';
  const barColor = pct > 0.85 ? 'bg-err' : pct > 0.65 ? 'bg-warn' : 'bg-accent';

  return (
    <div className="relative">
      <button
        title={`${t('context')} ${Math.round(pct * 100)}% · ${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens`}
        onClick={() => setOpen(!open)}
        className="flex h-7 w-7 items-center justify-center rounded-lg transition hover:bg-bg-hover"
      >
        <svg width="17" height="17" viewBox="0 0 17 17">
          <circle cx="8.5" cy="8.5" r={R} fill="none" stroke="var(--line)" strokeWidth="2.5" />
          <circle
            cx="8.5"
            cy="8.5"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${pct * CIRC} ${CIRC}`}
            transform="rotate(-90 8.5 8.5)"
          />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-9 right-0 z-20 w-72 rounded-2xl border border-line bg-bg-input p-4 shadow-lg">
            {/* 标题行：占用百分比大字 + 状态色点 */}
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-ui font-semibold">{t('ctxTitle')}</span>
              <span className={`text-lg font-semibold tabular-nums ${pct > 0.85 ? 'text-err' : pct > 0.65 ? 'text-warn' : 'text-ink'}`}>
                {Math.round(pct * 100)}%
              </span>
            </div>
            {/* 分段进度条 */}
            <div className="mb-3 h-2 overflow-hidden rounded-full bg-bg-active">
              <div className={`h-full rounded-full ${barColor} transition-all duration-300`} style={{ width: `${pct * 100}%` }} />
            </div>
            {/* 明细三行 */}
            <div className="mb-3 space-y-1.5 text-[11.5px]">
              <div className="flex justify-between">
                <span className="text-ink-faint">{t('ctxUsed')}</span>
                <span className="font-mono tabular-nums text-ink">{fmtTokens(usage.used)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-faint">{t('ctxFree')}</span>
                <span className="font-mono tabular-nums text-ink">{fmtTokens(Math.max(0, usage.size - usage.used))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-faint">{t('ctxWindow')}</span>
                <span className="font-mono tabular-nums text-ink">{fmtTokens(usage.size)}</span>
              </div>
            </div>
            <div className="mb-3 rounded-lg bg-bg-panel px-3 py-2 text-[11px] leading-5 text-ink-soft">{t('compactConfirm')}</div>
            <button
              onClick={() => {
                setOpen(false);
                void compactSession();
              }}
              className="w-full rounded-lg bg-accent py-1.5 text-ui font-medium text-white transition hover:opacity-90"
            >
              {t('compactStart')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 上下文已满 — 发送前强制确认：先压缩 / 执意发送 / 取消。 */
function CtxFullDialog({
  onCompact,
  onSendAnyway,
  onClose,
}: {
  onCompact: () => void;
  onSendAnyway: () => void;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  useEscClose(true, onClose);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-[420px] rounded-2xl border border-line bg-bg p-5 shadow-2xl">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <CircleAlert size={16} className="text-err" />
          {t('ctxFullTitle')}
        </div>
        <p className="mb-4 text-ui leading-6 text-ink-soft">{t('ctxFullBody')}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-3.5 py-1.5 text-ui text-ink-soft transition hover:bg-bg-hover">
            {t('cancel')}
          </button>
          <button onClick={onSendAnyway} className="rounded-lg border border-line px-3.5 py-1.5 text-ui text-ink-soft transition hover:border-warn/60 hover:text-warn">
            {t('ctxSendAnyway')}
          </button>
          <button onClick={onCompact} className="rounded-lg bg-accent px-4 py-1.5 text-ui font-medium text-white transition hover:opacity-90">
            {t('ctxCompactNow')}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

// ------------------------------------------------------------------ goal

/** Goal status line — renders the engine's real goal state (codex
 *  thread/goal/updated pushes objective/status/usage; nothing client-faked). */
function GoalBar({ sessionId, onEdit }: { sessionId: string; onEdit: (initial: string) => void }): JSX.Element | null {
  const t = useT();
  const goal = useChatStore((s) => s.goals[sessionId]);
  const controlGoal = useChatStore((s) => s.controlGoal);
  const [, tick] = useState(0);

  // Local ticker so the elapsed display moves between engine pushes.
  useEffect(() => {
    if (!goal || goal.status !== 'active') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [goal]);

  if (!goal) return null;

  const paused = goal.status !== 'active';
  const statusLabel =
    goal.status === 'active'
      ? t('goalRunning')
      : goal.status === 'paused'
        ? `${t('goal')} · ${t('goalPause')}`
        : `${t('goal')} · ${goal.status}`;

  return (
    <div className="mx-auto mb-1.5 flex max-w-3xl items-center gap-2 px-1 text-[11px] text-ink-faint">
      <Target size={11} className={goal.status === 'active' ? 'text-accent' : ''} />
      <span className="font-medium text-ink-soft">{statusLabel}</span>
      <span className="min-w-0 flex-1 truncate" title={goal.objective}>
        {goal.objective}
      </span>
      <span className="shrink-0 font-mono tabular-nums" title={`已用 ${goal.tokensUsed.toLocaleString()} tokens${goal.tokenBudget ? ` / 预算 ${goal.tokenBudget.toLocaleString()}` : ''}`}>
        {formatElapsed(goal.timeUsedSeconds * 1000)}
      </span>
      {paused ? (
        <IconBtn title={t('goalResume')} onClick={() => void controlGoal('resume')}>
          <Play size={11} />
        </IconBtn>
      ) : (
        <IconBtn title={t('goalPause')} onClick={() => void controlGoal('pause')}>
          <Pause size={11} />
        </IconBtn>
      )}
      <IconBtn title={t('goalEdit')} onClick={() => onEdit(goal.objective)}>
        <Pencil size={11} />
      </IconBtn>
      <IconBtn title={t('goalDelete')} onClick={() => void controlGoal('clear')}>
        <CircleSlash size={11} />
      </IconBtn>
    </div>
  );
}

// ----------------------------------------------------------- expand modal

function ExpandDialog({
  value,
  onChange,
  onSend,
  onClose,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="flex h-[70vh] w-[760px] flex-col rounded-2xl border border-line bg-bg p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">{t('longInputTitle')}</span>
          <button onClick={onClose} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-0 flex-1 resize-none rounded-xl border border-line bg-bg-input px-4 py-3 text-body leading-6 outline-none transition focus:border-accent"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-line px-4 py-1.5 text-ui text-ink-soft transition hover:bg-bg-hover">
            {t('close')}
          </button>
          <button
            onClick={onSend}
            disabled={!value.trim()}
            className="rounded-lg bg-accent px-5 py-1.5 text-ui font-medium text-white transition hover:opacity-90 disabled:opacity-40"
          >
            {t('send')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- primitives

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button title={title} onClick={onClick} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
      {children}
    </button>
  );
}

function Dropdown({
  children,
  onClose,
  align = 'left',
}: {
  children: React.ReactNode;
  onClose: () => void;
  align?: 'left' | 'right';
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className={`absolute bottom-9 z-20 min-w-40 rounded-xl border border-line bg-bg-input py-1 shadow-lg ${align === 'left' ? 'left-0' : 'right-0'}`}>
        {children}
      </div>
    </>
  );
}

function DropdownItem({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left text-ui transition hover:bg-bg-hover ${active ? 'font-semibold text-accent' : 'text-ink'}`}
    >
      {children}
    </button>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
