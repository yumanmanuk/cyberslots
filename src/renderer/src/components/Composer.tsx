/**
 * Composer — floating rounded input card. Control strip layout
 * (engine → mode → permissions → swarm/goal | model → effort → context
 * ring → expand → send), drag-and-drop attachments (images pinned above
 * the textarea, files as inline chips), Shift+Tab mode cycling, a goal
 * status line, and click-to-compact context ring.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Clock,
  CircleAlert,
  FileText,
  GripVertical,
  Image as ImageIcon,
  Maximize2,
  Pause,
  Pencil,
  Play,
  ShieldCheck,
  Sparkles,
  Square,
  Target,
  Trash2,
  X,
  Zap,
} from 'lucide-react';

import type { CodexCatalogModel, EngineId, PermissionMode } from '@shared/types';
import { useChatStore, type QueuedMessage } from '../store/chatStore';
import { useT, type MsgKey } from '../i18n';
import { EngineIcon, ENGINE_LABELS } from './EngineIcon';
import PlanWidget from './PlanWidget';

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
  const [goalMode, setGoalMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 控件条响应式收缩（codex 风）：右侧面板挤压到窄宽时，长文案控件
  // 降级成图标/截断，避免 CJK 文本竖排折行。
  const cardRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
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

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const send = (opts?: { force?: boolean }): void => {
    const value = text.trim();
    if (!value && attachments.length === 0) return;
    // Goal 模式：发送 = 把输入作为 objective 提交（codex thread/goal/set），
    // 与 codex `/goal <objective>` 的提交语义一致，不产出普通对话回合。
    if (goalMode) {
      if (!value) return;
      setText('');
      setGoalMode(false);
      void useChatStore.getState().setGoal(value);
      textareaRef.current?.focus();
      return;
    }
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

  /** 🎯 Goal (codex-only) — 目标是「模式」而非即时发送：点击只切换目标
   *  编辑模式（不提交），随后按发送/回车才把输入作为 objective 提交给
   *  codex thread/goal/set。与 Plan 互斥（codex 同款：plan 激活时隐藏
   *  goal）。kimi 无 goal API，按钮对 kimi 会话不渲染。 */
  const toggleGoalMode = (): void => {
    if (isPlan) void useChatStore.getState().setMode('default'); // 互斥：退出 Plan
    setGoalMode((v) => !v);
    textareaRef.current?.focus();
  };

  const cycleMode = (): void => {
    const setMode = useChatStore.getState().setMode;
    if (!isPlan) setGoalMode(false); // 进入 Plan → 退出目标模式（二者互斥）
    void setMode(isPlan ? 'default' : 'plan');
  };

  // Shift+Tab 全局切 Agent/Plan — 必须挂在 window 上：焦点不在输入框时
  // 浏览器默认的反向 Tab 导航会把焦点跳到其它按钮（黄色 focus 框）。
  useEffect(() => {
    const onGlobalKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      const current = useChatStore.getState().ui[sessionId]?.modes.current;
      const next = current === 'plan' ? 'default' : 'plan';
      if (next === 'plan') setGoalMode(false); // 进入 Plan → 退出目标模式
      void useChatStore.getState().setMode(next);
    };
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, [sessionId]);

  // 切换会话时重置目标编辑模式（Composer 不随会话 remount）。
  useEffect(() => setGoalMode(false), [sessionId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Shift+Tab 由上面的 window 监听统一处理（避免双重触发）。
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
      {/* 图片附件 — 输入框顶部 */}
      {images.length > 0 && (
        <div className="mx-auto mb-1.5 flex max-w-3xl flex-wrap gap-1.5">
          {images.map((a) => (
            <AttachmentChip key={a.path} att={a} onRemove={() => removeAttachment(a.path)} />
          ))}
        </div>
      )}

      <div ref={cardRef} className="mx-auto max-w-3xl">
        <TopRails
          sessionId={sessionId}
          onEditGoal={(goalText) => {
            // 编辑 = 回填目标到输入框并进入目标模式，改完点发送即 UpdateGoal
            setText(goalText);
            setGoalMode(true);
            textareaRef.current?.focus();
          }}
          onEditItem={(item) => {
            setText(item.text);
            useChatStore.getState().removeQueued(sessionId, item.id);
            textareaRef.current?.focus();
          }}
        />
        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          className="rounded-2xl border border-line bg-bg-input shadow-sm transition focus-within:border-ink-faint"
        >

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={Math.min(8, Math.max(1, text.split('\n').length))}
            placeholder={goalMode ? t('goalPlaceholder') : busy ? t('inputBusy') : sendKey === 'ctrl-enter' ? t('inputPlaceholderCtrl') : t('inputPlaceholder')}
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
            <EngineBadge sessionId={sessionId} />
            <ModeSwitch isPlan={isPlan} onCycle={cycleMode} compact={compact} />
            {!isPlan && <PermissionPicker sessionId={sessionId} compact={compact} />}
            <SwarmToggle />
            {meta?.engine === 'codex' && (
              <button
                title={t('goalToggle')}
                onClick={toggleGoalMode}
                className={`flex items-center gap-1 rounded-lg px-2 py-1 text-ui transition ${goalMode || goalActive ? 'bg-accent-soft font-medium text-accent' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
                  }`}
              >
                <Target size={13} fill={goalMode ? 'currentColor' : 'none'} />
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
                {/* 执行中与发送按钮同位同款，仅图标变为时钟（加入等待队列）；无输入时禁用不隐藏，位置不跳动 */}
                <button
                  onClick={() => send()}
                  disabled={!text.trim() && attachments.length === 0}
                  title={t('enqueue')}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition hover:opacity-90 disabled:opacity-30"
                >
                  <Clock size={15} />
                </button>
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
                title={goalMode ? t('goalSet') : t('send')}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition hover:opacity-90 disabled:opacity-30"
              >
                {goalMode ? <Target size={14} /> : <ArrowUp size={15} />}
              </button>
            )}
          </div>
        </div>
      </div>

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


// ------------------------------------------------------------ top rails

/** 输入框上方的叠层行条卡（codex 风格）：比输入框窄，顺序 等待发送 → 待办 → Goal
 *  三者都无内容时整体不渲染，避免空卡片残边。 */
function TopRails({
  sessionId,
  onEditGoal,
  onEditItem,
}: {
  sessionId: string;
  onEditGoal: (initial: string) => void;
  onEditItem: (item: QueuedMessage) => void;
}): JSX.Element | null {
  const hasQueue = useChatStore((s) => (s.queues[sessionId]?.length ?? 0) > 0);
  const hasGoal = useChatStore((s) => !!s.goals[sessionId]);
  const hasPlan = useChatStore((s) => {
    const msgs = s.ui[sessionId]?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.kind !== 'plan') continue;
      if (m.entries.length === 0) return false;
      const meta = s.sessions.find((x) => x.id === sessionId);
      const running = meta?.status === 'running' || meta?.status === 'awaiting';
      const done = m.entries.filter((e) => e.status === 'completed').length;
      return running || done < m.entries.length;
    }
    return false;
  });
  if (!hasQueue && !hasGoal && !hasPlan) return null;
  return (
    <div className="mx-4 -mb-px overflow-hidden rounded-t-xl border border-b-0 border-line bg-bg-panel/70">
      <QueuePanel sessionId={sessionId} onEditItem={onEditItem} />
      <PlanWidget sessionId={sessionId} />
      <GoalBar sessionId={sessionId} onEdit={onEditGoal} />
    </div>
  );
}

// ------------------------------------------------------------ send queue

const EMPTY_QUEUE: QueuedMessage[] = [];

/** Pending-send outbox above the input (qoder-style "等待发送 N" 行条)：
 *  默认收起，展开后可拖拽排序、编辑回填、删除、steer。 */
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
  const [open, setOpen] = useState(false);
  const dragFrom = useRef<number | null>(null);
  // Transient per-panel notice after a steer attempt falls back (kimi has no native steer).
  const [steerNotice, setSteerNotice] = useState<{ id: string; kind: 'moved' | 'head' } | null>(null);
  useEffect(() => {
    if (!steerNotice) return;
    const timer = setTimeout(() => setSteerNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [steerNotice]);

  if (queue.length === 0) return null;

  return (
    <div className="border-b border-line bg-bg-panel/70">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] transition hover:bg-bg-hover"
      >
        <ChevronRight size={12} className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 truncate text-left font-medium text-ink">
          {t('queueWaiting')} {queue.length}
        </span>
        {!open && queue[0] && (
          <span className="min-w-0 max-w-[50%] shrink-0 truncate text-ink-faint">{queue[0].text}</span>
        )}
      </button>
      {open && (
        <div className="pb-1">
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
              className="queue-row-in group flex items-center gap-1.5 px-2 py-1"
            >
              <GripVertical size={13} className="shrink-0 cursor-grab text-ink-faint/60 group-hover:text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={item.text}>
                {item.text}
              </span>
              <span className="flex shrink-0 animate-pulse items-center gap-1 text-[11px] text-ink-faint">
                <Sparkles size={11} />
                {t('queueItemWaiting')}
              </span>
              <button
                title={t('queueSteer')}
                onClick={() =>
                  void steerQueued(sessionId, item.id).then((r) => {
                    if (r === 'moved' || r === 'head') setSteerNotice({ id: item.id, kind: r });
                  })
                }
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
          {steerNotice && (
            <div className="px-3 pb-1 text-[11px] text-warn">
              {t(steerNotice.kind === 'moved' ? 'queueSteerMoved' : 'queueSteerHead')}
            </div>
          )}
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

function ModeSwitch({ isPlan, onCycle, compact }: { isPlan: boolean; onCycle: () => void; compact?: boolean }): JSX.Element {
  const t = useT();
  const setMode = useChatStore((s) => s.setMode);
  // 窄宽只显当前激活模式（codex 小窗同款），点击在两模式间循环。
  if (compact) {
    return (
      <div title="Shift+Tab 切换" className="flex shrink-0 items-center rounded-lg border border-line bg-bg-panel p-0.5">
        <button
          onClick={onCycle}
          className="whitespace-nowrap rounded-md bg-bg px-2 py-0.5 text-[11px] font-medium text-ink shadow-sm"
        >
          {isPlan ? t('modePlan') : t('modeAgent')}
        </button>
      </div>
    );
  }
  return (
    <div title="Shift+Tab 切换" className="flex items-center gap-0.5 rounded-lg border border-line bg-bg-panel p-0.5">
      <button
        onClick={() => void setMode('default')}
        className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] transition ${!isPlan ? 'bg-bg font-medium text-ink shadow-sm' : 'text-ink-faint hover:text-ink'}`}
      >
        {t('modeAgent')}
      </button>
      <button
        onClick={() => void setMode('plan')}
        className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] transition ${isPlan ? 'bg-bg font-medium text-ink shadow-sm' : 'text-ink-faint hover:text-ink'}`}
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
        title={`${t('engine')} · ${ENGINE_LABELS[meta.engine]}`}
        onClick={() => setOpen(!open)}
        className="flex items-center rounded-lg px-2 py-1 text-ink-soft transition hover:bg-bg-hover"
      >
        <EngineIcon engine={meta.engine} size={14} />
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
            <span className="flex items-center gap-2">
              <EngineIcon engine={other} size={13} />
              {ENGINE_LABELS[other]}
            </span>
          </DropdownItem>
        </Dropdown>
      )}
    </div>
  );
}

function PermissionPicker({ sessionId, compact }: { sessionId: string; compact?: boolean }): JSX.Element | null {
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
        title={label(current)}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
      >
        {/* 窄宽降级成图标（codex 小窗同款），完整文案进 title */}
        {compact ? <ShieldCheck size={13} /> : label(current)}
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
      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-ui transition ${swarmBoost ? 'bg-accent-soft font-medium text-accent' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
        }`}
    >
      <Zap size={13} fill={swarmBoost ? 'currentColor' : 'none'} />
    </button>
  );
}

// -------------------------------------------------------- model & effort

function ModelPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const uiModels = useChatStore((s) => s.ui[sessionId]?.models);
  const setModel = useChatStore((s) => s.setModel);
  const catalog = useChatStore((s) => s.codexCatalog);

  // 引擎未运行（会话恢复/懒启动）时不会有 models.update 事件，
  // 此时用持久化的 meta.modelId + catalog 兑底，避免选择器消失。
  const catalogSlugs = catalog.map((c) => c.slug);
  const current = uiModels?.current || meta?.modelId || '';
  const available =
    uiModels?.available.length
      ? uiModels.available
      : meta?.engine === 'codex'
        ? catalogSlugs.length
          ? catalogSlugs
          : current
            ? [current]
            : []
        : current
          ? [current]
          : [];

  const [open, setOpen] = useState(false);
  if (!current && !available.length) return null;

  const entryOf = (id: string): ReturnType<typeof catalog.find> => catalog.find((c) => c.slug === id);
  const activeId = current || available[0]!;

  const pick = (id: string): void => {
    void setModel(id);
    // 换模型后若已显式选过的思考深度不在新模型支持列表里，重置为其
    // 默认档；未显式选过则继续跟随 codex 默认解析（不写入覆盖值）。
    const efforts = entryOf(id)?.efforts;
    if (efforts?.length) {
      const cur = useChatStore.getState().efforts[sessionId];
      if (cur && !efforts.includes(cur)) {
        const next = entryOf(id)?.defaultEffort ?? efforts[efforts.length - 1]!;
        useChatStore.setState((s) => ({ efforts: { ...s.efforts, [sessionId]: next } }));
      }
    }
  };

  return (
    <div className="relative min-w-0">
      <button
        onClick={() => setOpen(!open)}
        title={entryOf(activeId)?.displayName ?? activeId}
        className="flex w-full min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
      >
        {/* min-w-0 + truncate：宽度不够时模型名截断省略，不撑出输入框 */}
        <span className="min-w-0 truncate font-medium">
          {entryOf(activeId)?.displayName ?? activeId}
        </span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)} align="right">
          {available.map((m) => {
            const entry = entryOf(m);
            return (
              <DropdownItem
                key={m}
                active={m === activeId}
                onClick={() => {
                  setOpen(false);
                  pick(m);
                }}
              >
                <span className="flex min-w-44 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{entry?.displayName ?? m}</span>
                  {entry && (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-ink-faint">
                      {entry.contextWindow ? fmtCtxWindow(entry.contextWindow) : ''}
                      {entry.inputModalities?.includes('image') && <ImageIcon size={10} />}
                    </span>
                  )}
                </span>
              </DropdownItem>
            );
          })}
        </Dropdown>
      )}
    </div>
  );
}

/** 上下文窗口紧凑格式：1000000 → 1M，256000 → 256K。 */
function fmtCtxWindow(n: number): string {
  if (n >= 1_000_000) return `${n % 1_000_000 === 0 ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** 生效思考深度解析（与 codex 自身优先级一致）：会话覆盖 → 配置
 *  model_reasoning_effort → catalog 模型默认档 → medium；候选必须在
 *  当前模型支持列表内，否则退回列表末档。 */
function resolveEffort(
  override: string | undefined,
  cfgDefault: string | undefined,
  entry: CodexCatalogModel | undefined,
): string {
  const efforts = entry?.efforts ?? EFFORTS;
  for (const c of [override, cfgDefault, entry?.defaultEffort, 'medium']) {
    if (c && efforts.includes(c)) return c;
  }
  return efforts[efforts.length - 1]!;
}

/** 思考深度 — codex 桌面版同款滑条交互：弹层里一条 4 档滑轨，
 *  拖动/点击档位即选，标题行实时显示当前档位名。sidechat 复用（align="left"）。 */
export function EffortPicker({ sessionId, align = 'right' }: { sessionId: string; align?: 'left' | 'right' }): JSX.Element {
  const t = useT();
  const override = useChatStore((s) => s.efforts[sessionId]);
  const cfgDefault = useChatStore((s) => s.codexDefaultEffort);
  const models = useChatStore((s) => s.ui[sessionId]?.models);
  const metaModelId = useChatStore((s) => s.sessions.find((m) => m.id === sessionId)?.modelId);
  const catalog = useChatStore((s) => s.codexCatalog);
  const [open, setOpen] = useState(false);
  useEscClose(open, () => setOpen(false));
  // 档位列表优先取 catalog 里当前模型声明的 supported_reasoning_levels；
  // 引擎未运行时回退到持久化的 meta.modelId。
  const activeModel = models?.current || models?.available[0] || metaModelId;
  const entry = catalog.find((c) => c.slug === activeModel);
  const efforts = entry?.efforts ?? EFFORTS;
  const effort = resolveEffort(override, cfgDefault, entry);
  const idx = Math.max(0, efforts.indexOf(effort));
  const label = (e: string): string => (EFFORT_LABEL_KEYS[e] ? t(EFFORT_LABEL_KEYS[e]!) : e);

  const select = (i: number): void => {
    const value = efforts[Math.max(0, Math.min(efforts.length - 1, i))]!;
    useChatStore.setState((s) => ({ efforts: { ...s.efforts, [sessionId]: value } }));
  };

  return (
    <div className="relative">
      <button
        title={t('effort')}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
      >
        <span className={effort === 'xhigh' ? 'effort-max-label' : ''}>{label(effort)}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className={`absolute bottom-9 z-20 w-64 rounded-2xl border border-line bg-bg-input p-4 shadow-lg ${align === 'left' ? 'left-0' : 'right-0'}`}>
            <div className="mb-3 flex items-center justify-between">
              <span className={`text-ui font-medium ${effort === 'xhigh' ? 'effort-max-label' : ''}`}>{label(effort)}</span>
              <ChevronRight size={12} className="text-ink-faint" />
            </div>
            <EffortSlider index={idx} count={efforts.length} onSelect={select} />
            <div className="mt-2 flex justify-between text-[10px] text-ink-faint">
              <span>{label(efforts[0]!)}</span>
              <span>{label(efforts[efforts.length - 1]!)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 4-stop slider: filled accent track up to the thumb, dots on the rest.
 *  拉满档（xhigh）时轨道流光 + 滑块脉冲光环（index.css effort-max-*）。 */
function EffortSlider({ index, count, onSelect }: { index: number; count: number; onSelect: (i: number) => void }): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const maxed = index === count - 1;

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
      className="relative h-6 cursor-pointer touch-none select-none"
    >
      <div className="absolute left-0 right-0 top-1/2 h-3.5 -translate-y-1/2 rounded-full bg-bg-active" />
      <div
        className={`absolute left-0 top-1/2 h-3.5 -translate-y-1/2 rounded-full transition-all duration-150 ${maxed ? 'effort-max-fill' : 'bg-accent'}`}
        style={{ width: `calc(${(index / (count - 1)) * 100}% + ${index === 0 ? 12 : 0}px)`, minWidth: 22 }}
      />
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className={`absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition ${i <= index ? 'bg-white/70' : 'bg-ink-faint/40'
            }`}
          style={{ left: `${(i / (count - 1)) * 92 + 4}%` }}
        />
      ))}
      <span
        className={`absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line bg-white shadow-md transition-all duration-150 ${maxed ? 'effort-max-thumb' : ''}`}
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

/** Goal 状态行条 — 内嵌输入框顶部的一体行条（引擎真实 goal 状态，
 *  codex thread/goal/updated 推 objective/status/usage，无客户端伪造）。 */
function GoalBar({ sessionId, onEdit }: { sessionId: string; onEdit: (initial: string) => void }): JSX.Element | null {
  const t = useT();
  const goal = useChatStore((s) => s.goals[sessionId]);
  const isPlan = useChatStore((s) => s.ui[sessionId]?.modes.current === 'plan');
  const controlGoal = useChatStore((s) => s.controlGoal);
  const [, tick] = useState(0);

  // Local ticker so the elapsed display moves between engine pushes.
  useEffect(() => {
    if (!goal || goal.status !== 'active') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [goal]);

  // codex 同款：plan 模式激活时隐藏 goal 状态（二者互斥）。
  if (!goal || isPlan) return null;

  const paused = goal.status !== 'active';
  const statusLabel =
    goal.status === 'active'
      ? t('goalRunning')
      : goal.status === 'paused'
        ? `${t('goal')} · ${t('goalPause')}`
        : `${t('goal')} · ${goal.status}`;

  return (
    <div className="border-b border-line bg-bg-panel/70">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
        <Target size={12} className={`shrink-0 ${goal.status === 'active' ? 'text-accent' : 'text-ink-faint'}`} />
        <span className="shrink-0 font-medium text-ink">{statusLabel}</span>
        <span className="min-w-0 flex-1 truncate text-ink-soft" title={goal.objective}>
          {goal.objective}
        </span>
        <span
          className="shrink-0 font-mono text-[11px] tabular-nums text-ink-faint"
          title={`已用 ${goal.tokensUsed.toLocaleString()} tokens${goal.tokenBudget ? ` / 预算 ${goal.tokenBudget.toLocaleString()}` : ''}`}
        >
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
          <Trash2 size={11} />
        </IconBtn>
      </div>
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
