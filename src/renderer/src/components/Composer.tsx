/**
 * Composer — floating rounded input card. Control strip layout
 * (engine → mode → permissions → swarm/goal | model → effort → context
 * ring → expand → send), drag-and-drop attachments (images pinned above
 * the textarea, files as inline chips), Shift+Tab mode cycling, a goal
 * status line, and click-to-compact context ring.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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
  Square,
  Swords,
  Target,
  Trash2,
  X,
  Zap,
} from 'lucide-react';

import type { SlashItem } from '@shared/ipc';
import type { CodeSelection, CodexCatalogModel, EngineId, PermissionMode } from '@shared/types';
import { useChatStore, type QueuedMessage } from '../store/chatStore';
import { useRaceStore } from '../store/raceStore';
import { useT, type MsgKey } from '../i18n';
import { EngineIcon, ENGINE_LABELS } from './EngineIcon';
import { BrandSpinner } from './brand';
import OpencodeModelPicker from './OpencodeModelPicker';
import ChipInput, { type ChipInputHandle } from './ChipInput';
import SlashMenu from './SlashMenu';
import SelectionChip from './SelectionChip';
import { TREE_NODE_MIME } from './workspace/FileTree';
import PlanWidget from './PlanWidget';

/** zustand selector 稳定引用（避免 `?? []` 每次新建导致多余重渲染）。 */
const NO_SELECTIONS: CodeSelection[] = [];

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
  off: 'effortOff',
  auto: 'effortAuto',
};

/** omp 的 ACP 思考值域＝off/auto + 模型目录 thinking[] 精细档（动态扩展）。 */
const OMP_BASE_EFFORTS = ['off', 'auto'];

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** omp 魔法关键词（独立小写词触发，代码块/路径内不算 — 这里只做宽松提示）。 */
const MAGIC_KEYWORD_RE = /(^|\s)(ultrathink|orchestrate|workflowz)(\s|$)/;

interface Attachment {
  path: string;
  name: string;
  isImage: boolean;
  /** 图片预览 object URL（拖拽/粘贴时由 File 生成；发送/移除时 revoke）。 */
  preview?: string;
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
  // 点击缩略图放大预览的灯箱（图片 object URL；null = 关闭）。
  const [lightbox, setLightbox] = useState<string | null>(null);
  const chipRef = useRef<ChipInputHandle>(null);
  // 控件条响应式收缩（codex 风）：右侧面板挤压到窄宽时，按优先级依次退避
  // —— level 越大越窄。引擎图标 / 放大输入框 / 发送按钮永不退避。
  //   level>=1 权限变图标 → >=2 隐思考深度 → >=3 隐模型名 → >=4 隐权限图标
  //   → >=5 隐 Agent/Plan。
  const cardRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(0);
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const ui = useChatStore((s) => s.ui[sessionId]);
  const goalActive = useChatStore((s) => !!s.goals[sessionId]);
  const sendKey = useChatStore((s) => s.settings?.sendKey ?? 'enter');
  const sendPrompt = useChatStore((s) => s.sendPrompt);
  const selections = useChatStore((s) => s.selections[sessionId] ?? NO_SELECTIONS);
  const removeSelection = useChatStore((s) => s.removeSelection);
  const cancel = useChatStore((s) => s.cancel);
  const sending = useChatStore((s) => !!s.sending[sessionId]);

  // 在途发送（含启动期等待投递）也算忙 — 后续消息走排队，避免并发 prompt。
  const busy = meta?.status === 'running' || meta?.status === 'awaiting' || sending;
  // 引擎启动中：不再拦发送 — 主进程 prompt 会等启动完成后自动投递
  //（AionUi 同款体验：输入永不禁用，首条消息后台补投）。
  const starting = meta?.status === 'starting';
  const isPlan = ui?.modes.current === 'plan';
  const usage = ui?.usage;
  const ctxFull = !!usage && usage.size > 0 && usage.used / usage.size >= 1;

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    // 断点从窄到宽依次判定，取第一个命中的 level（阈值 = 控件条内容宽度经验值）。
    const compute = (w: number): number =>
      w < 400 ? 5 : w < 470 ? 4 : w < 560 ? 3 : w < 650 ? 2 : w < 730 ? 1 : 0;
    const ro = new ResizeObserver(() => setLevel(compute(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 回退后把被移除的提问回填输入框（nonce 驱动，消费即清）。
  const undoDraft = useChatStore((s) => s.composerDrafts[sessionId]);
  useEffect(() => {
    if (!undoDraft) return;
    setText(undoDraft.text);
    chipRef.current?.focus();
    useChatStore.setState((s) => ({ composerDrafts: { ...s.composerDrafts, [sessionId]: undefined } }));
  }, [undoDraft, sessionId]);

  const send = (opts?: { force?: boolean }): void => {
    const value = text.trim();
    if (!value && attachments.length === 0 && selections.length === 0) return;
    // Goal 模式：发送 = 把输入作为 objective 提交（codex thread/goal/set），
    // 与 codex `/goal <objective>` 的提交语义一致，不产出普通对话回合。
    if (goalMode) {
      if (!value) return;
      setText('');
      setGoalMode(false);
      void useChatStore.getState().setGoal(value);
      chipRef.current?.focus();
      return;
    }
    // 上下文 100%：先弹确认弹窗要求压缩，避免静默丢失早期内容。
    if (ctxFull && !opts?.force && !busy) {
      setCtxFullOpen(true);
      return;
    }
    const paths = attachments.length ? attachments.map((a) => a.path) : undefined;
    const sels = selections.length ? selections : undefined;
    setText('');
    for (const a of attachments) if (a.preview) URL.revokeObjectURL(a.preview);
    setAttachments([]);
    if (sels) useChatStore.getState().clearSelections(sessionId);
    if (busy) {
      // 忙碌时入队，回合结束后自动依次发送
      useChatStore.getState().enqueue(value, paths, sels);
    } else {
      void sendPrompt(value, paths, sels);
    }
    chipRef.current?.focus();
  };

  /** 🎯 Goal (codex-only) — 目标是「模式」而非即时发送：点击只切换目标
   *  编辑模式（不提交），随后按发送/回车才把输入作为 objective 提交给
   *  codex thread/goal/set。与 Plan 互斥（codex 同款：plan 激活时隐藏
   *  goal）。kimi 无 goal API，按钮对 kimi 会话不渲染。 */
  const toggleGoalMode = (): void => {
    if (isPlan) void useChatStore.getState().setMode('default'); // 互斥：退出 Plan
    setGoalMode((v) => !v);
    chipRef.current?.focus();
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

  // ---------------------------------------------------------- 斜线命令菜单
  // 触发：输入仅为 `/token`（/ 开头、无空格无换行）— 与各引擎「/name 须在
  // 消息起始处生效」的语义一致；goal 模式（输入是 objective）不触发。
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const [slashActive, setSlashActive] = useState(0);
  // Esc 关闭 = 记住关闭时的文本，文本不变不再弹出（继续输入即恢复）。
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const slashQuery = !goalMode && /^\/[^\s]*$/.test(text) ? text.slice(1) : null;
  const slashOpen = slashQuery !== null && slashDismissed !== text;

  // 每次唤起都重新扫描（目录扫描很轻；用户可能刚装了新 skill/command）。
  useEffect(() => {
    if (!slashOpen) return;
    let live = true;
    void window.cyberslots
      .slashList({ cwd: meta?.cwd ?? '', engine: meta?.engine ?? 'codex' })
      .then((items) => live && setSlashItems(items))
      .catch(() => live && setSlashItems([]));
    return () => {
      live = false;
    };
    // 只依赖真正影响扫描范围/时机的字段（meta 引用每轮渲染都变）。
  }, [slashOpen, meta?.cwd, meta?.engine]);

  // 实时过滤：名称精确 > 前缀 > 子串 > 描述命中；组内相关度+字母序，
  // 展示顺序 命令组 → 技能组。
  const slashMatches = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    const rank = (it: SlashItem): number => {
      if (!q) return 0;
      const name = it.name.toLowerCase();
      if (name === q) return 0;
      if (name.startsWith(q)) return 1;
      if (name.includes(q)) return 2;
      return it.description.toLowerCase().includes(q) ? 3 : -1;
    };
    const hit = slashItems.filter((it) => rank(it) >= 0);
    hit.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return [...hit.filter((i) => i.kind === 'command'), ...hit.filter((i) => i.kind === 'skill')];
  }, [slashItems, slashQuery]);

  // 查询串变化时回到第一项。
  useEffect(() => setSlashActive(0), [slashQuery]);

  const slashActiveClamped = slashMatches.length ? Math.min(slashActive, slashMatches.length - 1) : 0;

  /** 选中候选：把输入整体替换为触发词 `/name `（尾部空格使触发条件失效，菜单自然关闭）。 */
  const acceptSlash = (item: SlashItem): void => {
    chipRef.current?.setPlainText(`/${item.name} `);
    setSlashDismissed(null);
  };

  // 新选区卡片到达 → 聚焦输入框（Copilot 同款：点完「添加到对话」直接提问）。
  const prevSelCount = useRef(0);
  useEffect(() => {
    if (selections.length > prevSelCount.current) chipRef.current?.focus();
    prevSelCount.current = selections.length;
  }, [selections.length]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Shift+Tab 由上面的 window 监听统一处理（避免双重触发）。
    // 斜线菜单打开时优先接管导航/确认/关闭键（IME 组合中不拦截，让输入法先用键）。
    if (slashOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = slashMatches.length;
        if (n > 0) setSlashActive((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && slashMatches.length > 0) {
        e.preventDefault();
        acceptSlash(slashMatches[slashActiveClamped]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissed(text);
        return;
      }
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
    // 右侧文件树内部拖拽 — 没有 File 对象，读自定义 MIME（自带目录标记）。
    const rawNode = e.dataTransfer.getData(TREE_NODE_MIME);
    if (rawNode) {
      try {
        const node = JSON.parse(rawNode) as { name: string; path: string; dir: boolean };
        if (!node.dir && IMAGE_RE.test(node.path)) {
          // 工作区图片 → 图片附件（无 File 对象，缩略图用图标占位）。
          setAttachments((prev) =>
            prev.some((a) => a.path === node.path) ? prev : [...prev, { path: node.path, name: node.name, isImage: true }],
          );
        } else {
          chipRef.current?.insertFileChip(node.name, node.path, node.dir);
        }
      } catch {
        // 损坏的拖拽数据 — 忽略。
      }
      return;
    }
    const imgs: Attachment[] = [];
    const refs: Array<{ name: string; path: string }> = [];
    for (const file of Array.from(e.dataTransfer.files)) {
      const path = window.cyberslots.getPathForFile(file);
      if (!path) continue;
      if (IMAGE_RE.test(path)) {
        // 图片：缩略图附件（可预览）。
        if (attachments.some((a) => a.path === path)) continue;
        imgs.push({ path, name: file.name, isImage: true, preview: URL.createObjectURL(file) });
      } else {
        // 非图片：在光标处插入文件引用 chip。
        refs.push({ name: file.name, path });
      }
    }
    if (imgs.length) setAttachments((prev) => [...prev, ...imgs]);
    if (refs.length) {
      // 非图片：逐个在光标处插入引用 chip（显示胶囊，复制/发送时
      // 序列化为 `名(路径)` 纯文本）。外部拖入的 File 不携带目录信息，
      // 需问主进程 stat 后再插（文件夹 chip 图标/样式不同）。
      void (async () => {
        for (const r of refs) {
          const dir = await window.cyberslots.fsIsDir(r.path);
          chipRef.current?.insertFileChip(r.name, r.path, dir);
        }
      })();
    }
  };

  // 粘贴图片（Ctrl+V）：剪贴板里是原始图像数据（无文件路径），写临时
  // 文件拿到路径再当附件加入；预览直接用 File 生成 object URL。
  // 返回 true = 含图片已处理（ChipInput 据此阻止默认粘贴）。
  const handleImagePaste = (items: DataTransferItem[]): boolean => {
    const imageItems = items.filter((it) => it.type.startsWith('image/'));
    if (imageItems.length === 0) return false;
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const preview = URL.createObjectURL(file);
      void file.arrayBuffer().then(async (buf) => {
        const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const path = await window.cyberslots.attachmentSaveTemp(new Uint8Array(buf), ext);
        setAttachments((prev) =>
          prev.some((a) => a.path === path)
            ? prev
            : [...prev, { path, name: `粘贴图片.${ext}`, isImage: true, preview }],
        );
      });
    }
    return true;
  };

  const removeAttachment = (path: string): void =>
    setAttachments((prev) => {
      const hit = prev.find((a) => a.path === path);
      if (hit?.preview) URL.revokeObjectURL(hit.preview);
      return prev.filter((a) => a.path !== path);
    });

  const images = attachments.filter((a) => a.isImage);
  const files = attachments.filter((a) => !a.isImage);

  return (
    <div className="shrink-0 px-6 pb-5 pt-1">
      <div ref={cardRef} className="mx-auto max-w-3xl">
        <TopRails
          sessionId={sessionId}
          onEditGoal={(goalText) => {
            // 编辑 = 回填目标到输入框并进入目标模式，改完点发送即 UpdateGoal
            setText(goalText);
            setGoalMode(true);
            chipRef.current?.focus();
          }}
          onEditItem={(item) => {
            setText(item.text);
            // 队列项携带的选区引用一并回填为输入框卡片（addSelection 自带去重）。
            if (item.selections?.length) {
              for (const sel of item.selections) useChatStore.getState().addSelection(sessionId, sel);
            }
            useChatStore.getState().removeQueued(sessionId, item.id);
            chipRef.current?.focus();
          }}
        />
        <div
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          className="relative rounded-2xl border border-line bg-bg-input shadow-sm"
        >
          {/* 斜线命令菜单 — 悬浮于输入卡片正上方（输入 / 唤起） */}
          {slashOpen && (
            <SlashMenu
              items={slashMatches}
              active={slashActiveClamped}
              onActiveChange={setSlashActive}
              onPick={acceptSlash}
            />
          )}
          {/* 图片附件 — 输入框内顶部缩略图（点击放大，悬停右上角 × 移除） */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pb-1 pt-3">
              {images.map((a) => (
                <ImageThumb
                  key={a.path}
                  att={a}
                  onOpen={() => a.preview && setLightbox(a.preview)}
                  onRemove={() => removeAttachment(a.path)}
                />
              ))}
            </div>
          )}

          {/* 代码选区引用卡片 —— 文件预览里「添加到对话」投递过来的 */}
          {selections.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 px-3 pb-1.5 ${images.length === 0 ? 'pt-3' : ''}`}>
              {selections.map((sel) => (
                <SelectionChip key={sel.id} sel={sel} onRemove={() => removeSelection(sessionId, sel.id)} />
              ))}
            </div>
          )}

          <ChipInput
            ref={chipRef}
            value={text}
            onChange={setText}
            onKeyDown={onKeyDown}
            onImagePaste={handleImagePaste}
            placeholder={goalMode ? t('goalPlaceholder') : starting && !busy ? t('inputStarting') : busy ? t('inputBusy') : sendKey === 'ctrl-enter' ? t('inputPlaceholderCtrl') : t('inputPlaceholder')}
            className="no-scrollbar max-h-32 min-h-[3.25rem] overflow-y-auto px-4 pb-1 pt-3 text-body"
          />

          {/* omp 魔法关键词提示 — 正文里的 ultrathink/orchestrate/workflowz
              会静默触发特殊行为（深度思考/并行编排），此处提醒不拦截。 */}
          {meta?.engine === 'omp' && MAGIC_KEYWORD_RE.test(text) && (
            <div className="mx-3 mb-1 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-600 dark:text-amber-400">
              检测到 omp 魔法关键词（ultrathink / orchestrate / workflowz）— 发送后会触发深度思考或并行子代理编排。
            </div>
          )}

          {/* 非图片文件附件 — 中性色小块 */}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-1.5">
              {files.map((a) => (
                <AttachmentChip key={a.path} att={a} onRemove={() => removeAttachment(a.path)} />
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5 px-3 pb-2.5">
            <EngineBadge sessionId={sessionId} />
            {level < 5 && <ModeSwitch isPlan={isPlan} onCycle={cycleMode} compact={level >= 1} />}
            {!isPlan && level < 4 && <PermissionPicker sessionId={sessionId} compact={level >= 1} />}
            <SwarmToggle />
            <RaceToggle sessionId={sessionId} />
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

            {level < 3 &&
              (meta?.engine === 'opencode' ? (
                <OpencodeModelPicker sessionId={sessionId} />
              ) : (
                <ModelPicker sessionId={sessionId} />
              ))}
            {level < 2 && (meta?.engine === 'codex' || meta?.engine === 'opencode' || meta?.engine === 'omp') && <EffortPicker sessionId={sessionId} />}
            <ContextRing sessionId={sessionId} />
            <button
              title={t('expandInput')}
              onClick={() => setExpanded(true)}
              className="rounded-lg p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
            >
              <Maximize2 size={13} />
            </button>
            {busy ? (
              text.trim() || attachments.length > 0 || selections.length > 0 ? (
                // 有输入 → 与发送按钮合并为「加入等待队列」（时钟），本轮结束后自动发送
                <button
                  onClick={() => send()}
                  title={t('enqueue')}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition hover:opacity-90"
                >
                  <Clock size={15} />
                </button>
              ) : (
                // 输入为空 → 同位显示中止按钮
                <button
                  onClick={() => void cancel()}
                  title={t('stop')}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-bg transition hover:opacity-80"
                >
                  <Square size={13} fill="currentColor" />
                </button>
              )
            ) : (
              <button
                onClick={() => send()}
                disabled={!text.trim() && attachments.length === 0 && selections.length === 0}
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

      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

// --------------------------------------------------------- attachment thumb

/** 输入框内图片缩略图：点击放大预览，悬停右上角 × 移除。 */
function ImageThumb({ att, onOpen, onRemove }: { att: Attachment; onOpen: () => void; onRemove: () => void }): JSX.Element {
  return (
    <div className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-line bg-bg-panel">
      <button onClick={onOpen} title={att.name} className="h-full w-full">
        {att.preview ? (
          <img src={att.preview} alt={att.name} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-ink-faint">
            <ImageIcon size={18} />
          </span>
        )}
      </button>
      <button
        title="移除"
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition hover:bg-black/80 group-hover:opacity-100"
      >
        <X size={10} />
      </button>
    </div>
  );
}

/** 图片放大预览灯箱：遮罩点击 / Esc / 右上角 × 关闭。 */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }): JSX.Element {
  useEscClose(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8" onClick={onClose}>
      <button
        title="关闭"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
      >
        <X size={18} />
      </button>
      <img
        src={src}
        alt="预览"
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />
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

  // 队列新增消息时，头部条闪一下 accent（面板常折叠，给点可见反馈）。
  const [bump, setBump] = useState(0);
  const prevLen = useRef(queue.length);
  useEffect(() => {
    if (queue.length > prevLen.current) setBump((n) => n + 1);
    prevLen.current = queue.length;
  }, [queue.length]);

  if (queue.length === 0) return null;

  return (
    <div className="border-b border-line bg-bg-panel/70">
      <button
        key={bump}
        onClick={() => setOpen(!open)}
        className="queue-bump flex w-full items-center gap-2 px-3 py-1.5 text-[12px] transition hover:bg-bg-hover"
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
              {item.selections && item.selections.length > 0 && (
                <span
                  title={item.selections.map((s) => s.fileName).join(', ')}
                  className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent"
                >
                  +{item.selections.length} {t('selRefs')}
                </span>
              )}
              {/* 排队等待 = 进行中语义 → 品牌星芒轮闪 */}
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-faint">
                <BrandSpinner size={11} />
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
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-bg-panel px-2 py-1 text-[11.5px] text-ink-soft"
    >
      <FileText size={12} className="text-ink-faint" />
      <span className="max-w-44 truncate">{att.name}</span>
      <button onClick={onRemove} className="rounded-md text-ink-faint transition hover:text-ink">
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
  const availability = useChatStore((s) => s.engineAvailability);
  const [open, setOpen] = useState(false);
  if (!meta) return null;
  // 四引擎：列出除当前引擎外的全部选项（二元切换已成历史）。
  const others = (['codex', 'opencode', 'kimi', 'omp'] as EngineId[]).filter((e) => e !== meta.engine);

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
          {others.map((other) => {
            // 未安装置灰展示（可见不可选）；尚未探测（null）时不置灰。
            const unavailable = availability ? !availability[other] : false;
            return (
              <DropdownItem
                key={other}
                active={false}
                onClick={() => {
                  if (unavailable) return;
                  setOpen(false);
                  void forkToEngine(sessionId, other);
                }}
              >
                <span
                  className={`flex items-center gap-2 ${unavailable ? 'cursor-not-allowed text-ink-faint opacity-40' : ''}`}
                  title={unavailable ? '未检测到本机安装，详见设置-模型页' : undefined}
                >
                  <EngineIcon engine={other} size={13} />
                  {ENGINE_LABELS[other]}
                </span>
              </DropdownItem>
            );
          })}
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

/** 🏇 赛马入口 —— 赛马寄生于宿主对话，严格按当前会话过滤：
 *  · 本对话有未完成赛马 → 高亮（进行中=accent，待继续=警示色），点击直入赛马视图；
 *  · 只有已完成的 → 下拉（回看 + 发起新赛马）；
 *  · 什么都没有 → 直接打开发起配置。其它对话的赛马一律不可见。 */
function RaceToggle({ sessionId }: { sessionId: string }): JSX.Element {
  const openSetup = useRaceStore((s) => s.openSetup);
  const openRace = useRaceStore((s) => s.openRace);
  const races = useRaceStore((s) => s.races);
  const [open, setOpen] = useState(false);
  // 归属判定：宿主对话本身，或身处该赛马的某个角色会话内。
  const mine = Object.values(races)
    .filter((r) => r.parentSessionId === sessionId || Object.values(r.sessions).includes(sessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const unfinished = mine.filter((r) => r.stage !== 'done');
  const doneOnes = mine.filter((r) => r.stage === 'done');
  const running = unfinished.some((r) => !r.interrupted);
  const tint = running
    ? 'bg-accent-soft font-medium text-accent'
    : unfinished.length
      ? 'font-medium text-warn hover:bg-bg-hover'
      : 'text-ink-faint hover:bg-bg-hover hover:text-ink';
  return (
    <div className="relative">
      <button
        title={
          unfinished.length
            ? `本对话的赛马：${unfinished[0]!.interrupted ? '待继续' : '进行中'}（点击进入）`
            : doneOnes.length
              ? '本对话的赛马（回看/发起）'
              : '发起赛马（竞争式规划）'
        }
        onClick={() =>
          unfinished.length ? openRace(unfinished[0]!.id) : doneOnes.length ? setOpen(!open) : openSetup()
        }
        className={`flex items-center gap-1 rounded-lg px-2 py-1 text-ui transition ${tint}`}
      >
        <Swords size={13} />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)}>
          <div className="px-3 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">本对话的赛马</div>
          {doneOnes.map((r) => (
            <DropdownItem
              key={r.id}
              active={false}
              onClick={() => {
                setOpen(false);
                openRace(r.id);
              }}
            >
              <span className="flex min-w-0 max-w-60 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">🏇 {r.prompt}</span>
                <span className="shrink-0 text-[10px] text-ink-faint">已完成</span>
              </span>
            </DropdownItem>
          ))}
          <DropdownItem
            active={false}
            onClick={() => {
              setOpen(false);
              openSetup();
            }}
          >
            ＋ 发起新赛马
          </DropdownItem>
        </Dropdown>
      )}
    </div>
  );
}

// -------------------------------------------------------- model & effort

function ModelPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const uiModels = useChatStore((s) => s.ui[sessionId]?.models);
  const setModel = useChatStore((s) => s.setModel);
  const catalog = useChatStore((s) => s.codexCatalog);
  const refreshEngineConfigs = useChatStore((s) => s.refreshEngineConfigs);

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
        onClick={() => {
          // 展开时后台重读配置目录 — 改 catalog 后无需重启应用即可看到新模型。
          if (!open) void refreshEngineConfigs();
          setOpen(!open);
        }}
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
  entry: Pick<CodexCatalogModel, 'efforts' | 'defaultEffort'> | undefined,
): string {
  const efforts = entry?.efforts ?? EFFORTS;
  for (const c of [override, cfgDefault, entry?.defaultEffort, 'medium']) {
    if (c && efforts.includes(c)) return c;
  }
  return efforts[efforts.length - 1]!;
}

/** 思考深度 — codex 桌面版同款滑条交互：弹层里一条 4 档滑轨，
 *  拖动/点击档位即选，标题行实时显示当前档位名。sidechat 复用（align="left"）。
 *  opencode：档位 = 模型 reasoning variants 键名（none/high 等），无 variants
 *  的模型自动隐藏；未显式选择时不下发 variant（跟随 server 默认）。 */
export function EffortPicker({ sessionId, align = 'right' }: { sessionId: string; align?: 'left' | 'right' }): JSX.Element | null {
  const t = useT();
  const override = useChatStore((s) => s.efforts[sessionId]);
  const cfgDefault = useChatStore((s) => s.codexDefaultEffort);
  const refreshEngineConfigs = useChatStore((s) => s.refreshEngineConfigs);
  const models = useChatStore((s) => s.ui[sessionId]?.models);
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const catalog = useChatStore((s) => s.codexCatalog);
  const ocCatalog = useChatStore((s) => s.opencodeCatalog);
  const ompCatalog = useChatStore((s) => s.ompCatalog);
  const [open, setOpen] = useState(false);
  useEscClose(open, () => setOpen(false));
  const isOpencode = meta?.engine === 'opencode';
  const isOmp = meta?.engine === 'omp';
  // 档位列表优先取 catalog 里当前模型声明的档位；
  // 引擎未运行时回退到持久化的 meta.modelId。
  const activeModel = models?.current || models?.available[0] || meta?.modelId;
  // omp：值域 = off/auto + 目录 thinking[] 精细档；非 reasoning 模型隐控件。
  if (isOmp) {
    const ompEntry = ompCatalog?.models.find((c) => c.slug === activeModel);
    if (ompEntry && ompEntry.reasoning === false) return null;
    const ompEfforts = ompEntry?.efforts?.length ? [...OMP_BASE_EFFORTS, ...ompEntry.efforts] : OMP_BASE_EFFORTS;
    const ompEffort = override && ompEfforts.includes(override) ? override : ompEfforts[0]!;
    const ompIdx = Math.max(0, ompEfforts.indexOf(ompEffort));
    const ompLabel = (e: string): string => (EFFORT_LABEL_KEYS[e] ? t(EFFORT_LABEL_KEYS[e]!) : e);
    const ompSelect = (i: number): void => {
      const value = ompEfforts[Math.max(0, Math.min(ompEfforts.length - 1, i))]!;
      useChatStore.setState((s) => ({ efforts: { ...s.efforts, [sessionId]: value } }));
    };
    return (
      <div className="relative">
        <button
          title={t('effort')}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
        >
          <span>{ompLabel(ompEffort)}</span>
          <ChevronDown size={11} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className={`absolute bottom-9 z-20 w-64 rounded-2xl border border-line bg-bg-input p-4 shadow-lg ${align === 'left' ? 'left-0' : 'right-0'}`}>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-ui font-medium">{ompLabel(ompEffort)}</span>
                <ChevronRight size={12} className="text-ink-faint" />
              </div>
              <EffortSlider index={ompIdx} count={ompEfforts.length} onSelect={ompSelect} />
              <div className="mt-2 flex justify-between text-[10px] text-ink-faint">
                {ompEfforts.map((e) => (
                  <span key={e}>{ompLabel(e)}</span>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }
  // 档位列表优先取 catalog 里当前模型声明的档位；
  // 引擎未运行时回退到持久化的 meta.modelId。
  const entry: Pick<CodexCatalogModel, 'efforts' | 'defaultEffort'> | undefined = isOpencode
    ? ocCatalog?.models.find((c) => c.slug === activeModel)
    : catalog.find((c) => c.slug === activeModel);
  // opencode 无 reasoning variants 的模型不渲染思考深度控件。
  if (isOpencode && !entry?.efforts?.length) return null;
  const efforts = entry?.efforts ?? EFFORTS;
  const effort = isOpencode
    ? override && efforts.includes(override)
      ? override
      : (entry?.defaultEffort ?? efforts[0]!)
    : resolveEffort(override, cfgDefault, entry);
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
        onClick={() => {
          // 同 ModelPicker：展开时后台刷新（档位元数据同源于 catalog）。
          if (!open) void refreshEngineConfigs();
          setOpen(!open);
        }}
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
  const busy = useChatStore((s) => {
    const st = s.sessions.find((m) => m.id === sessionId)?.status;
    return st === 'running' || st === 'awaiting';
  });
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
            {busy ? (
              // 任务进行中不能压缩（会与正跑的回合争引擎回合）— 给提示。
              <div className="rounded-lg bg-bg-panel px-3 py-2 text-[11px] leading-5 text-warn">
                {t('compactBusy')}
              </div>
            ) : (
              <>
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
              </>
            )}
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
  // 引擎只在结算点（回合边界/goal 工具调用）推 timeUsedSeconds，两次
  // 推送间本地外推秒针，否则计时长时间冻结再跳变；shownRef 单调保护，
  // 快照到达时不回跳。
  const baseRef = useRef({ src: -1, at: 0 });
  const shownRef = useRef(0);
  const keyRef = useRef('');

  // Local ticker so the elapsed display moves between engine pushes.
  useEffect(() => {
    if (!goal || goal.status !== 'active') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [goal]);

  // codex 同款：plan 模式激活时隐藏 goal 状态（二者互斥）。
  if (!goal || isPlan) return null;

  // 换了目标 = 新 goal → 单调保护归零；快照值变化 → 重置外推基线。
  if (keyRef.current !== goal.objective) {
    keyRef.current = goal.objective;
    shownRef.current = 0;
    baseRef.current = { src: goal.timeUsedSeconds, at: Date.now() };
  } else if (baseRef.current.src !== goal.timeUsedSeconds) {
    baseRef.current = { src: goal.timeUsedSeconds, at: Date.now() };
  }
  const extrapolated =
    goal.status === 'active'
      ? baseRef.current.src + Math.floor((Date.now() - baseRef.current.at) / 1000)
      : goal.timeUsedSeconds;
  const displaySeconds = Math.max(shownRef.current, extrapolated);
  shownRef.current = displaySeconds;

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
          {formatElapsed(displaySeconds * 1000)}
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
