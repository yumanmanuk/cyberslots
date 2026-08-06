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
  Flame,
  GripVertical,
  Hand,
  Image as ImageIcon,
  Maximize2,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Square,
  Target,
  Trash2,
  X,
  Zap,
} from 'lucide-react';

import type { SlashItem } from '@shared/ipc';
import type { ChatSelection, CodexCatalogModel, EngineId, OmpModelEntry, PermissionMode } from '@shared/types';
import { useChatStore, type DraftAttachment, type QueuedMessage } from '../store/chatStore';
import { useRaceStore } from '../store/raceStore';
import { useT, type MsgKey } from '../i18n';
import { EngineIcon, ENGINE_LABELS, PseudoWorkspaceBadge, useEngineOrder } from './EngineIcon';
import { BrandSpinner } from './brand';
import { RaceHorse } from './RaceHorse';
import OpencodeModelPicker from './OpencodeModelPicker';
import ChipInput, { type ChipInputHandle } from './ChipInput';
import SlashMenu from './SlashMenu';
import { isTerminalSelection, selectionLineCount, selectionRangeLabel } from '../selections';
import { resolveEffectiveEffort } from '../effort';
import { modelDisplayLabel } from './race/modelCatalogs';
import { TREE_NODE_MIME } from './workspace/FileTree';
import PlanWidget from './PlanWidget';

/** zustand selector 稳定引用（避免 `?? []` 每次新建导致多余重渲染）。 */
const NO_SELECTIONS: ChatSelection[] = [];

const PERM_LABEL_KEYS: Record<string, MsgKey> = {
  default: 'permManual',
  auto: 'permAuto',
  yolo: 'permYolo',
};

/** 权限下拉项副标题（codex 同款两行布局）— 一句话说清审批/沙箱差异。 */
const PERM_DESC_KEYS: Record<string, MsgKey> = {
  default: 'permManualDesc',
  auto: 'permAutoDesc',
  yolo: 'permYoloDesc',
};

/** 权限档位图标 — 举手拦截 → 沙箱内放行 → 火焰狂奔（与 ShieldCheck 拉开轮廓差异）。 */
const PERM_ICONS: Record<string, typeof Hand> = {
  default: Hand,
  auto: ShieldCheck,
  yolo: Flame,
};

/** 下拉列表里的图标着色（询问=蓝 安全=绿 危险=橙）——仅限列表，
 *  输入框触发按钮上的选中图标保持中性灰，避免控件条里过于抢眼。 */
const PERM_ICON_TINTS: Record<string, string> = {
  default: 'text-info',
  auto: 'text-ok',
  yolo: 'text-warn',
};

const EFFORT_LABEL_KEYS: Record<string, MsgKey> = {
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXhigh',
  max: 'effortMax',
  off: 'effortOff',
  auto: 'effortAuto',
};

/** omp 的 ACP 思考值域＝off/auto + 模型目录 thinking[] 精细档（动态扩展）。 */

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** omp 魔法关键词（独立小写词触发，代码块/路径内不算 — 这里只做宽松提示）。 */
const MAGIC_KEYWORD_RE = /(^|\s)(ultrathink|orchestrate|workflowz)(\s|$)/;

type Attachment = DraftAttachment;

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
  // 初值取会话草稿 — 切会话时 ChatView 按 key 整树重建，本地 state 会丢；
  // 未发送文本 + 图片附件靠 store 按会话保留（卸载时写回，见下方 effect）。
  const [text, setText] = useState(() => useChatStore.getState().drafts[sessionId] ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(
    () => useChatStore.getState().draftAttachments?.[sessionId] ?? [],
  );
  const [expanded, setExpanded] = useState(false);
  const [ctxFullOpen, setCtxFullOpen] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  // 不支持 Goal 的引擎（opencode）点 goal 图标 → 瞬态提示条（自动消失）。
  const [goalNotice, setGoalNotice] = useState(false);
  useEffect(() => {
    if (!goalNotice) return;
    const timer = setTimeout(() => setGoalNotice(false), 2600);
    return () => clearTimeout(timer);
  }, [goalNotice]);
  // 点击缩略图放大预览的灯箱（图片 object URL；null = 关闭）。
  const [lightbox, setLightbox] = useState<string | null>(null);
  const chipRef = useRef<ChipInputHandle>(null);
  // 「+ 选择文件」的隐藏系统文件选择器。
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 控件条响应式收缩（codex 风）：右侧面板挤压到窄宽时，按优先级依次退避
  // —— level 越大越窄。引擎图标 / + 菜单（含放大输入框） / 发送按钮永不退避。
  //   level>=1 模式开关变紧凑 → >=2 隐思考深度 → >=3 隐模型名 → >=4 隐权限图标
  //   → >=5 隐 Agent/Plan（权限选择器恒为图标态，不参与宽→窄降级）。
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
  const cancelling = useChatStore((s) => !!s.cancelling[sessionId]);

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
    if (undoDraft.attachments?.length) {
      restorePaths(undoDraft.attachments);
    }
    chipRef.current?.focus();
    useChatStore.setState((s) => ({ composerDrafts: { ...s.composerDrafts, [sessionId]: undefined } }));
  }, [undoDraft, sessionId]);

  // 会话挂载后：把草稿里的非图片附件重新插成行内胶囊（图片走缩略图区，
  // 不需要 DOM chip）。silent 插入避免 emit 在正文渲染前回写清掉文本。
  const restoredFileChips = useRef(false);
  useEffect(() => {
    if (restoredFileChips.current) return;
    restoredFileChips.current = true;
    const files = useChatStore.getState().draftAttachments?.[sessionId] ?? [];
    for (const f of files) {
      if (!f.isImage) chipRef.current?.insertFileChip(f.name, f.path, undefined, true);
    }
  }, [sessionId]);

  // 卸载时把未发送内容存为会话草稿（纯内存，重启不保留）。
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => {
    return () => {
      // 会话已删除时不再回写，避免卸载清理把刚清掉的草稿/附件复活。
      if (!useChatStore.getState().sessions.some((m) => m.id === sessionId)) return;
      useChatStore.setState((s) => ({
        drafts: { ...s.drafts, [sessionId]: textRef.current },
        draftAttachments: { ...s.draftAttachments, [sessionId]: attachmentsRef.current },
      }));
    };
  }, [sessionId]);

  /** 切换引擎前把当前输入内容刷入 store — fork 出的新会话按新 id 初始化
   *  输入框，不先落库的话复制到的是上次卸载时的旧草稿。 */
  const flushDraft = (): void => {
    useChatStore.setState((s) => ({
      drafts: { ...s.drafts, [sessionId]: textRef.current },
      draftAttachments: { ...s.draftAttachments, [sessionId]: attachmentsRef.current },
    }));
  };

  const send = (opts?: { force?: boolean }): void => {
    const value = text.trim();
    if (!value && attachments.length === 0 && selections.length === 0) return;
    // Goal 模式：发送 = 把输入作为 objective 提交（codex thread/goal/set），
    // 与 codex `/goal <objective>` 的提交语义一致，不产出普通对话回合。
    if (goalMode) {
      if (!value) return;
      setText('');
      setGoalMode(false);
      chipRef.current?.setPlainText('');
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
    // 清空行内胶囊（文件 + 选区），避免发送后胶囊残留在输入框里。
    chipRef.current?.setPlainText('');
    if (busy) {
      // 忙碌时入队，回合结束后自动依次发送
      useChatStore.getState().enqueue(value, paths, sels);
    } else {
      void sendPrompt(value, paths, sels);
    }
    chipRef.current?.focus();
  };

  /** 🎯 Goal — 目标是「模式」而非即时发送：点击只切换目标编辑模式
   *（不提交），随后按发送/回车才把输入作为 objective 提交给引擎
   *（codex thread/goal/set 与 kimi KAP goal_objective）。与 Plan 互斥。
   *  能否用看会话能力快照（主进程侧 adapter 可选方法推送；kimi 只有
   *  KAP 通道有 goal，ACP 降级会话没有）；未启动过时按 codex 兑底。
   *  不支持的引擎按钮照常展示，点击弹「不支持」提示（产品要求：
   *  显式告知而非隐藏）。 */
  const goalCapable = meta?.capabilities?.goal ?? meta?.engine === 'codex';
  const toggleGoalMode = (): void => {
    if (!goalCapable) {
      setGoalNotice(true);
      return;
    }
    if (isPlan) void useChatStore.getState().setMode('default'); // 互斥：退出 Plan
    setGoalMode((v) => !v);
    chipRef.current?.focus();
  };

  const cycleMode = (): void => {
    const setMode = useChatStore.getState().setMode;
    if (!isPlan) setGoalMode(false); // 进入 Plan → 退出目标模式（二者互斥）
    void setMode(isPlan ? 'default' : 'plan');
  };

  // Ctrl+Tab / Shift+Tab 全局切 Agent/Plan — 必须挂在 window 上：焦点不在
  // 输入框时浏览器默认的 Tab 导航会把焦点跳到其它按钮（黄色 focus 框）。
  useEffect(() => {
    const togglePlanMode = (): void => {
      const current = useChatStore.getState().ui[sessionId]?.modes.current;
      const next = current === 'plan' ? 'default' : 'plan';
      if (next === 'plan') setGoalMode(false); // 进入 Plan → 退出目标模式
      void useChatStore.getState().setMode(next);
    };
    const onGlobalKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const ctrlTab = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      const shiftTab = e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
      if (!ctrlTab && !shiftTab) return;
      e.preventDefault();
      togglePlanMode();
    };
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, [sessionId]);

  // Ctrl+M / Ctrl+Shift+M 循环模型、Ctrl+E / Ctrl+Shift+E 循环思考深度 —
  // 全局 window 级（焦点不在输入框也生效）；无可用列表 / 无思考档位面时
  // 静默无动作，不打扰。
  useEffect(() => {
    const cycleModel = (dir: 1 | -1): void => {
      const s = useChatStore.getState();
      const meta = s.sessions.find((m) => m.id === sessionId);
      if (!meta) return;
      const uiModels = s.ui[sessionId]?.models;
      const current = uiModels?.current || meta.modelId || '';
      // 与 ModelPicker 的 available 兜底解析保持一致（codex catalog / omp slugs / current）。
      const catalogSlugs = s.codexCatalog.map((c) => c.slug);
      const ompSlugs = meta.engine === 'omp' ? (s.ompCatalog?.models ?? []).map((m) => m.slug) : [];
      const rawAvailable = uiModels?.available.length
        ? uiModels.available
        : meta.engine === 'codex'
          ? catalogSlugs.length
            ? catalogSlugs
            : current
              ? [current]
              : []
          : meta.engine === 'omp'
            ? current
              ? [current]
              : [] // ACP 模型值域未到前不展示目录全量（目录 ≠ 会话可用集）
            : ompSlugs.length
              ? current && !ompSlugs.includes(current)
                ? [current, ...ompSlugs]
                : ompSlugs
              : current
                ? [current]
                : [];
      // antigravity/omp 隐藏黑名单过滤（始终保留当前模型，同 ModelPicker）。
      const hidden =
        meta.engine === 'antigravity'
          ? (s.settings?.antigravityHiddenModels ?? [])
          : meta.engine === 'omp'
            ? (s.settings?.ompHiddenModels ?? [])
            : [];
      const available = hidden.length
        ? rawAvailable.filter((m) => m === current || !hidden.includes(m))
        : rawAvailable;
      if (available.length < 2) return;
      const idx = available.indexOf(current);
      const next =
        idx >= 0 ? available[(idx + dir + available.length) % available.length]! : available[dir === 1 ? 0 : available.length - 1]!;
      if (next !== current) void s.setModel(next);
    };

    const cycleEffort = (dir: 1 | -1): void => {
      const s = useChatStore.getState();
      const meta = s.sessions.find((m) => m.id === sessionId);
      if (!meta) return;
      const ui = s.ui[sessionId];
      const activeModel = ui?.models?.current || ui?.models?.available[0] || meta.modelId || '';
      const resolved = resolveEffectiveEffort({
        engine: meta.engine,
        override: s.efforts[sessionId],
        activeModel,
        kimiModels: s.kimiModels,
        codexCatalog: s.codexCatalog,
        codexDefaultEffort: s.codexDefaultEffort,
        opencodeCatalog: s.opencodeCatalog,
        ompCatalog: s.ompCatalog,
        ompThinking: ui?.thinking,
      });
      if (!resolved || resolved.options.length < 2) return;
      const next = resolved.options[(resolved.index + dir + resolved.options.length) % resolved.options.length]!;
      useChatStore.getState().setSessionEffort(sessionId, next);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const dir: 1 | -1 = e.shiftKey ? -1 : 1;
      const key = e.key.toLowerCase();
      if (key === 'm') {
        e.preventDefault();
        cycleModel(dir);
      } else if (key === 'e') {
        e.preventDefault();
        cycleEffort(dir);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionId]);

  // 切换会话时重置目标编辑模式（Composer 不随会话 remount）。
  useEffect(() => setGoalMode(false), [sessionId]);

  // ---------------------------------------------------------- 斜线命令菜单
  // 触发：输入仅为 `/token`（/ 开头、无空格无换行）— 与各引擎「/name 须在
  // 消息起始处生效」的语义一致；goal 模式（输入是 objective）不触发。
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const [slashActive, setSlashActive] = useState(0);
  // 引擎运行时推送的命令（claude init.slash_commands / kimi·omp ACP
  // available_commands / kimi KAP skills / opencode 服务端命令）—— 传给主进程，
  // 由主进程用全生态扫描索引回贴来源（全局/项目 + skill/command 类别）。
  const engineCmds = useChatStore((s) => s.ui[sessionId]?.commands);
  // Esc 关闭 = 记住关闭时的文本，文本不变不再弹出（继续输入即恢复）。
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const slashQuery = !goalMode && /^\/[^\s]*$/.test(text) ? text.slice(1) : null;
  const slashOpen = slashQuery !== null && slashDismissed !== text;

  // 每次唤起都重新扫描（目录扫描很轻；用户可能刚装了新 skill/command），
  // 并带上引擎推送命令交主进程合并、回贴来源后回传完整候选池。
  useEffect(() => {
    if (!slashOpen) return;
    let live = true;
    void window.cyberslots
      .slashList({ cwd: meta?.cwd ?? '', engine: meta?.engine ?? 'codex', pushedCommands: engineCmds ?? [] })
      .then((items) => live && setSlashItems(items))
      .catch(() => live && setSlashItems([]));
    return () => {
      live = false;
    };
    // 只依赖真正影响扫描范围/时机的字段（meta 引用每轮渲染都变）。
  }, [slashOpen, meta?.cwd, meta?.engine, engineCmds]);

  // 实时过滤：名称精确 > 前缀 > 子串 > 描述命中；组内相关度+字母序，
  // 展示顺序 命令组 → 技能组 → 引擎命令组。slashItems 已是主进程合并
  //（目录扫描项 + 回贴来源的推送命令）后的完整候选池，此处只做过滤/排序/分组。
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
    return [
      ...hit.filter((i) => i.kind === 'command'),
      ...hit.filter((i) => i.kind === 'skill'),
      ...hit.filter((i) => i.kind === 'builtin'),
    ];
  }, [slashItems, slashQuery]);

  // 查询串变化时回到第一项。
  useEffect(() => setSlashActive(0), [slashQuery]);

  const slashActiveClamped = slashMatches.length ? Math.min(slashActive, slashMatches.length - 1) : 0;

  /** 选中候选：把输入整体替换为触发词 `/name `（尾部空格使触发条件失效，菜单自然关闭）。 */
  const acceptSlash = (item: SlashItem): void => {
    chipRef.current?.setPlainText(`/${item.name} `);
    setSlashDismissed(null);
  };

  // 新选区到达 → 行内胶囊插到输入框光标处（而非顶部卡片行），光标落在
  // 胶囊之后可直接提问。切会话只刷新名单不插入；队列编辑回填的选区
  // 文本里已有标记，用 skip 标志跳过插胶囊（只回填 store 快照）。
  const knownSelIds = useRef<Set<string>>(new Set());
  const selSessionRef = useRef(sessionId);
  const skipSelInsert = useRef(false);
  useEffect(() => {
    const isSwitch = selSessionRef.current !== sessionId;
    selSessionRef.current = sessionId;
    const prev = knownSelIds.current;
    knownSelIds.current = new Set(selections.map((s) => s.id));
    if (isSwitch) return;
    const added = selections.filter((s) => !prev.has(s.id));
    if (!added.length) return;
    if (skipSelInsert.current) {
      skipSelInsert.current = false;
      return;
    }
    for (const s of added) {
      chipRef.current?.insertSelectionChip({
        id: s.id,
        fileName: s.fileName,
        rangeLabel: isTerminalSelection(s) ? ` ${t('selLineCount', { n: selectionLineCount(s) })}` : selectionRangeLabel(s),
        path: isTerminalSelection(s) ? s.cwd : s.path,
      });
    }
  }, [selections, sessionId]);

  /** 输入框里的选区胶囊被删（退格/剪切/清空）→ 同步移除 store 快照，
   *  避免发送时夹带看不见的选区块。 */
  const syncSelChips = (ids: string[]): void => {
    const cur = useChatStore.getState().selections[sessionId] ?? [];
    for (const s of cur) if (!ids.includes(s.id)) removeSelection(sessionId, s.id);
  };

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
    // 发送键可配：Enter 发送（Shift+Enter 换行）/ Ctrl+Enter 发送（Enter 换行）
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

  /** 回填路径列表（回退/队列编辑）：图片进缩略图附件，非图片插行内胶囊。
   *  silent —— 状态由调用方同步，不触发 emit（避免正文被回写清掉）。 */
  const restorePaths = (paths: string[]): void => {
    if (!paths.length) return;
    setAttachments((prev) => {
      const known = new Set(prev.map((a) => a.path));
      const fresh = paths
        .filter((p) => !known.has(p))
        .map((p) => ({
          path: p,
          name: p.split(/[\\/]/).pop() ?? p,
          isImage: IMAGE_RE.test(p),
        }));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
    for (const p of paths) {
      if (!IMAGE_RE.test(p)) chipRef.current?.insertFileChip(p.split(/[\\/]/).pop() ?? p, p, undefined, true);
    }
  };

  /** 非图片文件/文件夹 → 行内胶囊插到光标处（attachments 由 onFileChipsChange
   *  从 DOM 同步），彻底绕开「胶囊可见但发送时丢」的旧病。 */
  const insertFileChips = (items: Array<{ name: string; path: string; dir?: boolean }>): void => {
    for (const it of items) chipRef.current?.insertFileChip(it.name, it.path, it.dir);
  };

  const addFiles = (fileList: File[]): void => {
    const imgs: Attachment[] = [];
    const refs: Array<{ name: string; path: string }> = [];
    for (const file of fileList) {
      const path = window.cyberslots.getPathForFile(file);
      if (!path) continue;
      if (IMAGE_RE.test(path)) {
        // 图片：缩略图附件（可预览）。
        if (attachments.some((a) => a.path === path)) continue;
        imgs.push({ path, name: file.name, isImage: true, preview: URL.createObjectURL(file) });
      } else {
        // 非图片：行内胶囊插到光标处（与文本同一行）。
        refs.push({ name: file.name, path });
      }
    }
    if (imgs.length) setAttachments((prev) => [...prev, ...imgs]);
    if (refs.length) insertFileChips(refs);
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    // 右侧文件树内部拖拽 → 没有 File 对象，读自定义 MIME（自带目录标记）。
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
          // 工作区文件/文件夹 → 行内胶囊插到光标处（与文本同一行）。
          insertFileChips([{ name: node.name, path: node.path, dir: node.dir }]);
        }
      } catch {
        // 损坏的拖拽数据 → 忽略。
      }
      return;
    }
    addFiles(Array.from(e.dataTransfer.files));
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
            : [...prev, { path, name: `${t('pastedImage')}.${ext}`, isImage: true, preview }],
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

  /** DOM 文件胶囊存活清单 → attachments（图片仍以 state 为准；删除胶囊 =
   *  删除附件，发送不夹带看不见的引用）。 */
  const syncFileChips = (refs: Array<{ name: string; path: string; dir: boolean }>): void => {
    setAttachments((prev) => {
      const imgs = prev.filter((a) => a.isImage);
      const files = refs.map((r) => ({ path: r.path, name: r.name, isImage: false }));
      const next = [...imgs, ...files];
      if (next.length === prev.length && next.every((a, i) => a.path === prev[i]!.path)) return prev;
      return next;
    });
  };

  const images = attachments.filter((a) => a.isImage);

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
            if (item.attachments?.length) restorePaths(item.attachments);
            // 队列项携带的选区引用一并回填 store（文本里已含胶囊标记，
            // 跳过行内插入避免重复；addSelection 自带去重）。
            if (item.selections?.length) {
              skipSelInsert.current = true;
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
          {/* 斜线命令菜单 — 悬浮于输入卡片正上方（输入 / 唤起）*/}
          {slashOpen && (
            <SlashMenu
              items={slashMatches}
              active={slashActiveClamped}
              onActiveChange={setSlashActive}
              onPick={acceptSlash}
            />
          )}
          {/* 图片附件 — 输入框内顶部缩略图（点击放大，悬停右上角 × 移除）*/}
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

          {/* 代码选区引用改为行内胶囊（见 insertSelectionChip），不再占卡片行 */}

          <ChipInput
            ref={chipRef}
            value={text}
            onChange={setText}
            onKeyDown={onKeyDown}
            onImagePaste={handleImagePaste}
            onSelChipsChange={syncSelChips}
            onFileChipsChange={syncFileChips}
            placeholder={goalMode ? t('goalPlaceholder') : starting && !busy ? t('inputStarting') : busy ? t('inputBusy') : sendKey === 'ctrl-enter' ? t('inputPlaceholderCtrl') : t('inputPlaceholder')}
            className="no-scrollbar max-h-32 min-h-[3.25rem] overflow-y-auto px-4 pb-1 pt-3 text-body"
          />

          {/* omp 魔法关键词提示 — 正文里的 ultrathink/orchestrate/workflowz
              会静默触发特殊行为（深度思考/并行编排），此处提醒不拦截。 */}
          {meta?.engine === 'omp' && MAGIC_KEYWORD_RE.test(text) && (
            <div className="mx-3 mb-1 rounded-md bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-600 dark:text-amber-400">
              {t('ompMagicHint')}
            </div>
          )}

          {/* 不支持 Goal 的引擎点击 goal 图标 → 瞬态提示（2.6s 自动消失）*/}
          {goalNotice && (
            <div className="mx-3 mb-1 rounded-md bg-warn/10 px-2.5 py-1 text-[11px] text-warn">
              {meta?.engine} {t('goalUnsupported')}
            </div>
          )}

          <div className="flex items-center gap-1.5 px-3 pb-2.5">
            <EngineBadge sessionId={sessionId} onSwitchEngine={flushDraft} />
            {/* + 菜单（codex 同款）：选择文件 / 放大输入框。承接了原右侧
                独立放大按钮的功能，与引擎图标同为永不退避项（引擎仍最左）。 */}
            <AddMenu onExpand={() => setExpanded(true)} onPickFiles={() => fileInputRef.current?.click()} />
            {/* 隐藏的系统文件选择器 — 选中后走与拖拽同一条 addFiles 链路 */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const list = Array.from(e.target.files ?? []);
                if (list.length) addFiles(list);
                e.target.value = '';
              }}
            />
            {level < 5 && <ModeSwitch isPlan={isPlan} onCycle={cycleMode} compact={level >= 1} />}
            {!isPlan && level < 4 && <PermissionPicker sessionId={sessionId} />}
            <SwarmToggle sessionId={sessionId} />
            <RaceToggle sessionId={sessionId} />
            {/* 始终展示：不支持的引擎置灰（不用 disabled —— 仍可点击，点击弹「不支持」提示，显式告知而非隐藏）*/}
            <button
              title={goalCapable ? t('goalToggle') : `${meta?.engine} ${t('goalUnsupported')}`}
              onClick={toggleGoalMode}
              className={`flex items-center gap-1 rounded-lg px-2 py-1 text-ui transition ${!goalCapable
                ? 'cursor-not-allowed text-ink-faint/50'
                : goalMode || goalActive
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
                }`}
            >
              {/* Target 是三层同心圆，fill 会糊成纯色圆点 — 保持描边，激活态靠底色/文字色区分（与发送按钮的 Target 同款）*/}
              <Target size={13} />
            </button>

            <div className="flex-1" />

            {level < 3 &&
              (meta?.engine === 'opencode' ? (
                <OpencodeModelPicker sessionId={sessionId} />
              ) : (
                <ModelPicker sessionId={sessionId} />
              ))}
            {level < 2 && (meta?.engine === 'codex' || meta?.engine === 'opencode' || meta?.engine === 'omp' || meta?.engine === 'kimi' || meta?.engine === 'claude') && <EffortPicker sessionId={sessionId} />}
            <ContextRing sessionId={sessionId} />
            {busy ? (
              text.trim() || attachments.length > 0 || selections.length > 0 ? (
                // 有输入 → 与发送按钮合并为「加入等待队列」（时钟），本轮结束后自动发送
                <button
                  onClick={() => send()}
                  title={t('enqueue')}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:opacity-90"
                >
                  <Clock size={15} />
                </button>
              ) : (
                // 输入为空 → 同位显示中止按钮
                <button
                  onClick={() => void cancel()}
                  disabled={cancelling}
                  title={cancelling ? t('stopping') : t('stop')}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-bg transition hover:opacity-80 disabled:opacity-80"
                >
                  {cancelling ? <BrandSpinner size={14} /> : <Square size={13} fill="currentColor" />}
                </button>
              )
            ) : (
              <button
                onClick={() => send()}
                disabled={!text.trim() && attachments.length === 0 && selections.length === 0}
                title={goalMode ? t('goalSet') : t('send')}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:opacity-90 disabled:opacity-30"
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
  const t = useT();
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
        title={t('removeAttachment')}
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
  const t = useT();
  useEscClose(true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8" onClick={onClose}>
      <button
        title={t('close')}
        onClick={onClose}
        className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
      >
        <X size={18} />
      </button>
      <img
        src={src}
        alt={t('fpPreview')}
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

/** Pending-send outbox above the input (qoder-style "等待发送 N" 行条)。
 *  首次收到消息后默认展开，展开后可拖拽排序、编辑回填、删除、steer。 */
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
  const [open, setOpen] = useState(() => queue.length > 0);
  const dragFrom = useRef<number | null>(null);
  // Transient per-panel notice after a steer attempt falls back / re-routes.
  const [steerNotice, setSteerNotice] = useState<{ id: string; kind: 'moved' | 'head' | 'sent' } | null>(null);
  /** 正在尝试引导的队列项（IPC 往返期间的行内进行中态）。 */
  const [steeringId, setSteeringId] = useState<string | null>(null);
  useEffect(() => {
    if (!steerNotice) return;
    const timer = setTimeout(() => setSteerNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [steerNotice]);

  // 队列新增消息时，头部条闪一下 accent；第一条消息到达时默认展开。
  const [bump, setBump] = useState(0);
  const prevLen = useRef(queue.length);
  useEffect(() => {
    const grew = queue.length > prevLen.current;
    if (grew) setBump((n) => n + 1);
    if (prevLen.current === 0 && queue.length > 0) setOpen(true);
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
              className="queue-row-in group flex items-baseline gap-1.5 px-2 py-1"
            >
              <GripVertical size={13} className="shrink-0 cursor-grab self-center text-ink-faint/60 group-hover:text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-[12px] leading-[20px] text-ink" title={item.text}>
                {item.text}
              </span>
              {item.selections && item.selections.length > 0 && (
                <span
                  title={item.selections.map((s) => s.fileName).join(', ')}
                  className="shrink-0 self-center rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent"
                >
                  +{item.selections.length} {t('selRefs')}
                </span>
              )}
              {item.attachments && item.attachments.length > 0 && (
                <span
                  title={item.attachments.join('\n')}
                  className="flex shrink-0 items-center gap-1 self-center rounded bg-bg-panel px-1.5 py-0.5 text-[10px] text-ink-soft"
                >
                  <Paperclip size={10} className="text-ink-faint" />
                  {item.attachments.length} {t('attachments')}
                </span>
              )}
              {(item.steering || steeringId === item.id) && (
                <span className="flex shrink-0 items-center gap-1 self-center text-[11px] text-accent">
                  <BrandSpinner size={11} />
                  {t('queueItemSteering')}
                </span>
              )}
              <button
                title={t('queueSteer')}
                disabled={steeringId !== null || item.steering}
                onClick={() => {
                  setSteeringId(item.id);
                  void steerQueued(sessionId, item.id)
                    .then((r) => {
                      if (r === 'moved' || r === 'head' || r === 'sent') setSteerNotice({ id: item.id, kind: r });
                    })
                    .finally(() => setSteeringId(null))
                    .catch(() => undefined);
                }}
                className="flex items-center justify-center self-center rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-accent disabled:opacity-40"
              >
                <ArrowUp size={12} className="rotate-45" />
              </button>
              <button
                title={t('queueEdit')}
                onClick={() => onEditItem(item)}
                className="flex items-center justify-center self-center rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
              >
                <Pencil size={12} />
              </button>
              <button
                title={t('remove')}
                onClick={() => removeQueued(sessionId, item.id)}
                className="flex items-center justify-center self-center rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-err"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {steerNotice && (
            <div className="px-3 pb-1 text-[11px] text-warn">
              {t(
                steerNotice.kind === 'moved'
                  ? 'queueSteerMoved'
                  : steerNotice.kind === 'sent'
                    ? 'queueSteerSent'
                    : 'queueSteerHead',
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ mode/engine

function ModeSwitch({ isPlan, onCycle, compact }: { isPlan: boolean; onCycle: () => void; compact?: boolean }): JSX.Element {
  const t = useT();
  const setMode = useChatStore((s) => s.setMode);
  // 窄宽只显当前激活模式（codex 小窗同款），点击在两模式间循环。
  if (compact) {
    return (
      <div title={t('shiftTabToggle')} className="flex shrink-0 items-center rounded-lg border border-line bg-bg-panel p-0.5">
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
    <div title={t('shiftTabToggle')} className="flex items-center gap-0.5 rounded-lg border border-line bg-bg-panel p-0.5">
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

function EngineBadge({
  sessionId,
  onSwitchEngine,
}: {
  sessionId: string;
  onSwitchEngine: () => void;
}): JSX.Element | null {
  const t = useT();
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const forkToEngine = useChatStore((s) => s.forkToEngine);
  const openAgySwitch = useChatStore((s) => s.openAgySwitch);
  const availability = useChatStore((s) => s.engineAvailability);
  const workspaces = useChatStore((s) => s.settings?.workspaces);
  const engineOrder = useEngineOrder();
  const [open, setOpen] = useState(false);
  if (!meta) return null;
  // 五引擎：按设置 engineOrder 列出除当前引擎外的全部选项。
  const others = engineOrder.filter((e) => e !== meta.engine);
  // 多目录工作区会话切到无原生多根的引擎时挂「非原生工作区」徽标提醒。
  const ws = meta.workspaceId ? workspaces?.find((w) => w.id === meta.workspaceId) : undefined;
  const multiRoot = (ws?.folders.length ?? 0) > 1;

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
          {meta.engine === 'antigravity' && (
            <>
              <DropdownItem
                active={false}
                onClick={() => {
                  setOpen(false);
                  openAgySwitch(sessionId);
                }}
              >
                <span className="flex items-center gap-2">
                  <EngineIcon engine="antigravity" size={13} />
                  {t('agySwitchEntry')}
                </span>
              </DropdownItem>
              <div className="my-1 border-t border-line" />
            </>
          )}
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
                  onSwitchEngine();
                  void forkToEngine(sessionId, other);
                }}
              >
                <span
                  className={`flex items-center gap-2 ${unavailable ? 'cursor-not-allowed text-ink-faint opacity-40' : ''}`}
                  title={unavailable ? t('engineNotDetectedTitle') : undefined}
                >
                  <EngineIcon engine={other} size={13} />
                  {ENGINE_LABELS[other]}
                  {multiRoot && <PseudoWorkspaceBadge engine={other} />}
                </span>
              </DropdownItem>
            );
          })}
        </Dropdown>
      )}
    </div>
  );
}

function PermissionPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const t = useT();
  const ui = useChatStore((s) => s.ui[sessionId]);
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const setMode = useChatStore((s) => s.setMode);
  const [open, setOpen] = useState(false);
  const current = ui?.modes.current ?? 'default';
  const options: PermissionMode[] = ['default', 'auto', 'yolo'];
  // antigravity headless 无交互式审批 → 「手动审批(default)」不可用（选了只会软拒工具）。
  const isAgy = meta?.engine === 'antigravity';
  const label = (m: string): string => (PERM_LABEL_KEYS[m] ? t(PERM_LABEL_KEYS[m]!) : m);
  const CurrentIcon = PERM_ICONS[current] ?? ShieldCheck;

  return (
    <div className="relative">
      <button
        title={label(current)}
        onClick={() => setOpen(!open)}
        className="flex items-center whitespace-nowrap rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
      >
        {/* 选中态只显示档位图标，完整文案进 title */}
        <CurrentIcon size={13} />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)}>
          {options.map((m) => {
            const disabled = isAgy && m === 'default';
            const Icon = PERM_ICONS[m] ?? ShieldCheck;
            return (
              <DropdownItem
                key={m}
                active={m === current}
                onClick={() => {
                  if (disabled) return;
                  setOpen(false);
                  void setMode(m);
                }}
              >
                <span
                  className={`flex items-start gap-2 ${disabled ? 'cursor-not-allowed text-ink-faint opacity-40' : ''}`}
                  title={disabled ? t('headlessNoApproval') : undefined}
                >
                  {/* 图标对齐标题首行：text-ui 行高 20px，3px 图标居中需下移 (20-13)/2；置灰项不着色 */}
                  <Icon size={13} className={`mt-[3.5px] shrink-0 ${disabled ? '' : PERM_ICON_TINTS[m] ?? ''}`} />
                  <span className="block">
                    {label(m)}
                    {/* 副标题小字 — 选中态不继承 accent，保持弱化层级 */}
                    <span className="mt-0.5 block whitespace-nowrap text-[11px] font-normal leading-4 text-ink-faint">
                      {PERM_DESC_KEYS[m] ? t(PERM_DESC_KEYS[m]!) : ''}
                    </span>
                  </span>
                </span>
              </DropdownItem>
            );
          })}
        </Dropdown>
      )}
    </div>
  );
}

/** ⚡ Swarm — 两套实现按会话能力分流：
 *  · 原生（kimi KAP，capabilities.swarm）：会话级 swarm_mode 开关（引擎
 *    IAgentSwarmService，强制并行模式），状态由 swarm.update 回声驱动。
 *    含引擎自发退出；
 *  · 其余引擎：全局 swarmBoost 提示词前缀（软引导，发送时拼入）。 */
function SwarmToggle({ sessionId }: { sessionId: string }): JSX.Element {
  const t = useT();
  const swarmBoost = useChatStore((s) => s.swarmBoost);
  const nativeCapable = useChatStore(
    (s) => !!s.sessions.find((m) => m.id === sessionId)?.capabilities?.swarm,
  );
  const nativeOn = useChatStore((s) => !!s.ui[sessionId]?.swarm);
  const on = nativeCapable ? nativeOn : swarmBoost;
  const toggle = (): void => {
    if (nativeCapable) void useChatStore.getState().setSwarm(sessionId, !nativeOn);
    else useChatStore.setState({ swarmBoost: !swarmBoost });
  };
  return (
    <button
      title={`${on ? t('swarmOn') : t('swarmOff')}${nativeCapable ? t('swarmNativeTag') : ''}`}
      onClick={toggle}
      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-ui transition ${on ? 'bg-accent-soft font-medium text-accent' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'
        }`}
    >
      <Zap size={13} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

/** 🏇 赛马入口 —— 赛马寄生于宿主对话，严格按当前会话过滤：
 *  · 本对话有未完成赛马 → 高亮（进行中=accent，待继续=警示色），点击直入赛马视图；
 *  · 只有已完成的 → 下拉（回顾 + 发起新赛马）；
 *  · 什么都没有 → 直接打开发起配置。其它对话的赛马一律不可见。 */
function RaceToggle({ sessionId }: { sessionId: string }): JSX.Element {
  const t = useT();
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
  // 图标与 text 着色（currentColor）：进行中=accent 色字、待继续=warn 色字。
  const tint = running
    ? 'bg-accent-soft font-medium text-accent'
    : unfinished.length
      ? 'bg-warn/15 font-medium text-warn hover:bg-bg-hover'
      : 'text-ink-faint hover:bg-bg-hover hover:text-ink';
  // 对齐 SwarmToggle 的灰/彩语义：本对话没配置过赛马时图标压淡（hover 恢复提示可点）。
  const plain = mine.length === 0;
  return (
    <div className="relative">
      <button
        title={
          unfinished.length
            ? (unfinished[0]!.interrupted ? t('composerRaceResume') : t('composerRaceRunning'))
            : doneOnes.length
              ? t('composerRaceReview')
              : t('composerRaceStart')
        }
        onClick={() =>
          unfinished.length ? openRace(unfinished[0]!.id) : doneOnes.length ? setOpen(!open) : openSetup()
        }
        className={`group flex items-center gap-1 rounded-lg px-2 py-1 text-ui transition ${tint}`}
      >
        <RaceHorse size={15} className={plain ? 'opacity-70 transition group-hover:opacity-100' : ''} />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)}>
          <div className="px-3 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">{t('composerRaceMenu')}</div>
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
                <RaceHorse size={12} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{r.prompt}</span>
                <span className="shrink-0 text-[10px] text-ink-faint">{t('statusDone')}</span>
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
            {t('composerNewRace')}
          </DropdownItem>
        </Dropdown>
      )}
    </div>
  );
}

// -------------------------------------------------------- model & effort

function ModelPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const t = useT();
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const uiModels = useChatStore((s) => s.ui[sessionId]?.models);
  const setModel = useChatStore((s) => s.setModel);
  const catalog = useChatStore((s) => s.codexCatalog);
  const kimiModels = useChatStore((s) => s.kimiModels);
  const claudeLabels = useChatStore((s) => s.claudeModelLabels);
  const lang = useChatStore((s) => s.settings?.language ?? 'zh');
  const maybeRefreshEngineConfigs = useChatStore((s) => s.maybeRefreshEngineConfigs);
  const agyHiddenList = useChatStore((s) => s.settings?.antigravityHiddenModels);
  const ompHiddenList = useChatStore((s) => s.settings?.ompHiddenModels);
  const ompCatalog = useChatStore((s) => s.ompCatalog);
  const loadOmpCatalog = useChatStore((s) => s.loadOmpCatalog);
  const isOmp = meta?.engine === 'omp';
  // omp：引擎启动前 models.update 未到，模型列表用目录兜底（懒加载）；
  // 目录未就绪期间下拉里展示 BrandSpinner 加载行占位。
  useEffect(() => {
    if (isOmp) void loadOmpCatalog();
  }, [isOmp, loadOmpCatalog]);
  const ompLoading = isOmp && !ompCatalog;

  // 引擎未运行（会话恢复/懒启动）时不会有 models.update 事件。
  // 此时用持久化的 meta.modelId + catalog 兑底，避免选择器消失。
  const catalogSlugs = catalog.map((c) => c.slug);
  const current = uiModels?.current || meta?.modelId || '';
  const ompSlugs = isOmp ? (ompCatalog?.models ?? []).map((m) => m.slug) : [];
  const rawAvailable =
    uiModels?.available.length
      ? uiModels.available
      : meta?.engine === 'codex'
        ? catalogSlugs.length
          ? catalogSlugs
          : current
            ? [current]
            : []
        : meta?.engine === 'omp'
          ? current
            ? [current]
            : [] // ACP 模型值域未到前不展示目录全量（目录 ≠ 会话可用集）
          : ompSlugs.length
            ? current && !ompSlugs.includes(current)
              ? [current, ...ompSlugs]
              : ompSlugs
            : current
              ? [current]
              : [];
  // antigravity/omp：按设置页隐藏黑名单过滤选择器（始终保留当前模型，避免选中项消失）。
  const available =
    meta?.engine === 'antigravity' && agyHiddenList?.length
      ? rawAvailable.filter((m) => m === current || !agyHiddenList.includes(m))
      : meta?.engine === 'omp' && ompHiddenList?.length
        ? rawAvailable.filter((m) => m === current || !ompHiddenList.includes(m))
        : rawAvailable;

  const [open, setOpen] = useState(false);
  if (!current && !available.length) {
    // omp 目录仍在拉取且无任何可展示项 → BrandSpinner 占位，就绪后自动换回选择器。
    if (ompLoading) {
      return (
        <span title={t('ocModelLoading')} className="flex items-center px-2 py-1 text-ink-faint">
          <BrandSpinner size={12} />
        </span>
      );
    }
    return null;
  }

  const entryOf = (id: string): ReturnType<typeof catalog.find> => catalog.find((c) => c.slug === id);
  const ompEntryOf = (id: string): OmpModelEntry | undefined => (isOmp ? ompCatalog?.models.find((c) => c.slug === id) : undefined);
  // claude：自定义模型映射（第三方网关 env）优先，回落内置别名友好名；
  // antigravity：codexCatalog 条目 → 用 slug→友好名映射展示（否则显示原始 slug）。
  // 展示名解析链与回答信息 tooltip 共用（modelDisplayLabel）；claude 'default'
  // 无自定义映射时的文案即 claudeDefaultFollow（claudeModelLabel 内置同款）。
  const labelFor = (id: string): string =>
    modelDisplayLabel(meta?.engine, id, { codexCatalog: catalog, ompCatalog, claudeLabels, lang });
  const activeId = current || available[0]!;

  const pick = (id: string): void => {
    void setModel(id);
    // 换模型后若已显式选过的思考深度不在新模型支持列表里，重置为其
    // 默认档；未显式选过则继续跟随 codex 默认解析（不写入覆盖值）。
    const cur = useChatStore.getState().efforts[sessionId];
    if (!cur) return;
    let efforts: string[] | undefined;
    let defaultEffort: string | undefined;
    if (isOmp) {
      efforts = ompEntryOf(id)?.efforts; // omp 目录无默认档字段 → 重置取末档
    } else if (meta?.engine === 'kimi') {
      const kEntry = kimiModels.find((m) => m.alias === id);
      efforts = kEntry?.efforts;
      defaultEffort = kEntry?.defaultEffort;
    } else {
      const entry = entryOf(id);
      efforts = entry?.efforts;
      defaultEffort = entry?.defaultEffort;
    }
    if (efforts?.length && !efforts.includes(cur)) {
      const next = defaultEffort ?? efforts[efforts.length - 1]!;
      useChatStore.getState().setSessionEffort(sessionId, next);
    }
  };

  return (
    <div className="relative min-w-0">
      <button
        onClick={() => {
          // 展开时后台重读配置目录（TTL 节流）→ 换 catalog 后无需重启应用即可看到新模型。
          if (!open) void maybeRefreshEngineConfigs();
          setOpen(!open);
        }}
        title={`${labelFor(activeId)} · ${t('modelCycleHint')}`}
        className="flex w-full min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
      >
        {/* min-w-0 + truncate：宽度不够时模型名截断省略，不撑出输入框 */}
        <span className="min-w-0 truncate font-medium">
          {labelFor(activeId)}
        </span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)} align="right">
          {available.map((m) => {
            const entry = entryOf(m);
            const oEntry = ompEntryOf(m);
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
                  <span className="min-w-0 flex-1 truncate">{labelFor(m)}</span>
                  {entry && (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-ink-faint">
                      {entry.contextWindow ? fmtCtxWindow(entry.contextWindow) : ''}
                      {entry.inputModalities?.includes('image') && <ImageIcon size={10} />}
                    </span>
                  )}
                  {!entry && oEntry?.contextWindow ? (
                    <span className="shrink-0 text-[10px] text-ink-faint">{fmtCtxWindow(oEntry.contextWindow)}</span>
                  ) : null}
                </span>
              </DropdownItem>
            );
          })}
          {/* omp 目录拉取中 → 列表尾部加载行（当前模型仍可选，全量选项稍后补齐）*/}
          {ompLoading && (
            <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-ink-faint">
              <BrandSpinner size={12} />
              <span>{t('ocModelLoading')}</span>
            </div>
          )}
        </Dropdown>
      )}
    </div>
  );
}

/** 上下文窗口紧凑格式：1000000 → 1M、256000 → 256K。 */
function fmtCtxWindow(n: number): string {
  if (n >= 1_000_000) return `${n % 1_000_000 === 0 ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** 思考深度 — codex 桌面版同款滑条交互：弹层里一列 4 档滑轨，
 *  拖动/点击档位即选，标题行实时显示当前档位名。sidechat 复用（align="left"）。
 *  opencode：档位 = 模型 reasoning variants 键名（none/high 等），无 variants
 *  的模型自动隐藏；未显式选择时不下发 variant（跟随 server 默认）。 */
export function EffortPicker({ sessionId, align = 'right' }: { sessionId: string; align?: 'left' | 'right' }): JSX.Element | null {
  const t = useT();
  const override = useChatStore((s) => s.efforts[sessionId]);
  const cfgDefault = useChatStore((s) => s.codexDefaultEffort);
  const maybeRefreshEngineConfigs = useChatStore((s) => s.maybeRefreshEngineConfigs);
  const models = useChatStore((s) => s.ui[sessionId]?.models);
  const meta = useChatStore((s) => s.sessions.find((m) => m.id === sessionId));
  const catalog = useChatStore((s) => s.codexCatalog);
  const ocCatalog = useChatStore((s) => s.opencodeCatalog);
  const ompCatalog = useChatStore((s) => s.ompCatalog);
  const ompThinking = useChatStore((s) => s.ui[sessionId]?.thinking);
  const loadOmpCatalog = useChatStore((s) => s.loadOmpCatalog);
  const kimiModels = useChatStore((s) => s.kimiModels);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEscClose(open, () => setOpen(false));
  // 弹层用 fixed 定位（与 RightDock 的 dropAt 同策略）——absolute 会被
  // DockReveal 的 overflow 裁剪链切掉，sidechat 面板里弹层右侧被吃。
  const popupStyle = (): React.CSSProperties => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return {};
    const s: React.CSSProperties = { position: 'fixed', bottom: window.innerHeight - r.top + 4, width: 256 };
    if (align === 'left') s.left = r.left; else s.right = Math.max(8, window.innerWidth - r.right);
    return s;
  };
  const isOpencode = meta?.engine === 'opencode';
  const isOmp = meta?.engine === 'omp';
  // omp 精细档来自模型目录 thinking[]，目录是懒加载的 → 此前只有设置页
  // 赛马面板会触发拉取，普通会话里 ompCatalog 恒为 null，档位退化成
  // off/auto 两档。挂载即拉（in-flight 去重 + 主进程缓存，代价低）。
  useEffect(() => {
    if (isOmp) void loadOmpCatalog();
  }, [isOmp, loadOmpCatalog]);
  const isKimi = meta?.engine === 'kimi';
  const isClaude = meta?.engine === 'claude';
  // claude：思考档 = /effort 斜杠命令的档位（low/medium/high/xhigh/max），
  // 运行时回合间热切（scripts/probe-claude-effort.mjs 实测）。未显选时展示
  // 默认 max 但不写 override（sendPromptTo 以该默认档显式下发）。
  // 注：isClaude 分支在下方实体解析后（需 activeModel/open 已就绪）统一处理。
  // 档位列表优先取 catalog 里当前模型声明的档位。
  // 引擎未运行时回退到持久化的 meta.modelId。
  const activeModel = models?.current || models?.available[0] || meta?.modelId;
  // 生效档解析走共享单一真源（src/renderer/src/effort.ts）——此处的显示值
  // 与 sendPromptTo 的下发值严格一致（所见即所得）；undefined = 无档位面
  // （控件隐藏/占位，不下发）。
  const resolved = resolveEffectiveEffort({
    engine: meta?.engine,
    override,
    activeModel: activeModel ?? '',
    kimiModels,
    codexCatalog: catalog,
    codexDefaultEffort: cfgDefault,
    opencodeCatalog: ocCatalog,
    ompCatalog,
    ompThinking,
  });
  // kimi：值域来自 config.toml 声明（off + support_efforts，always_thinking
  // 模型（off）；无档位声明的模型隐控件。下发路径 = prompt 带
  // setSessionConfigOption(thinking)（kimi CLI 0.30 新增）。
  if (isKimi) {
    if (!resolved) return null;
    const { value: kEffort, options: kEfforts, index: kIdx } = resolved;
    const kLabel = (e: string): string => (EFFORT_LABEL_KEYS[e] ? t(EFFORT_LABEL_KEYS[e]!) : e);
    const kSelect = (i: number): void => {
      const value = kEfforts[Math.max(0, Math.min(kEfforts.length - 1, i))]!;
      useChatStore.getState().setSessionEffort(sessionId, value);
    };
    return (
      <div className="relative">
        <button
          ref={btnRef}
          title={`${t('effort')} · ${t('effortCycleHint')}`}
          onClick={() => {
            if (!open) void maybeRefreshEngineConfigs();
            setOpen(!open);
          }}
          className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
        >
          <span className={kEffort === 'max' ? 'effort-max-label' : ''}>{kLabel(kEffort)}</span>
          <ChevronDown size={11} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div style={popupStyle()} className="z-20 rounded-2xl border border-line bg-bg-input p-4 shadow-lg">
              <div className="mb-3 flex items-center">
                <span className={`text-ui font-medium ${kEffort === 'max' ? 'effort-max-label' : ''}`}>{kLabel(kEffort)}</span>
              </div>
              <EffortSlider index={kIdx} count={kEfforts.length} onSelect={kSelect} />
              <div className="mt-2 flex justify-between text-[10px] text-ink-faint">
                {kEfforts.map((e) => (
                  <span key={e}>{kLabel(e)}</span>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }
  // omp：值域 = off/auto + 目录 thinking[] 精细档；非 reasoning 模型隐控件。
  if (isOmp) {
    // 目录未就绪（懒拉取中）且 ACP 未推送 thinking 值域 → BrandSpinner 占位，
    // 避免先展示 off/auto 假两档误导选择；ACP 已推送时跳过等待。
    if (!ompCatalog && !ompThinking?.available.length) {
      return (
        <span title={`${t('effort')} · ${t('effortCycleHint')}`} className="flex items-center px-2 py-1 text-ink-faint">
          <BrandSpinner size={12} />
        </span>
      );
    }
    if (!resolved) return null;
    const { value: ompEffort, options: ompEfforts, index: ompIdx } = resolved;
    const ompLabel = (e: string): string => (EFFORT_LABEL_KEYS[e] ? t(EFFORT_LABEL_KEYS[e]!) : e);
    const ompSelect = (i: number): void => {
      const value = ompEfforts[Math.max(0, Math.min(ompEfforts.length - 1, i))]!;
      useChatStore.getState().setSessionEffort(sessionId, value);
    };
    return (
      <div className="relative">
        <button
          ref={btnRef}
          title={`${t('effort')} · ${t('effortCycleHint')}`}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
        >
          <span>{ompLabel(ompEffort)}</span>
          <ChevronDown size={11} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div style={popupStyle()} className="z-20 rounded-2xl border border-line bg-bg-input p-4 shadow-lg">
              <div className="mb-3 flex items-center">
                <span className="text-ui font-medium">{ompLabel(ompEffort)}</span>
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
  // claude：思考档 = /effort 斜杠命令的档位（回合间热切）；未显选时展示默认
  // max（sendPromptTo 以该档显式下发）。
  if (isClaude) {
    if (!resolved) return null;
    const { value: cEffort, options: CLAUDE_EFFORTS, index: cIdx } = resolved;
    const cLabel = (e: string): string => (EFFORT_LABEL_KEYS[e] ? t(EFFORT_LABEL_KEYS[e]!) : e);
    const cSelect = (i: number): void => {
      const value = CLAUDE_EFFORTS[Math.max(0, Math.min(CLAUDE_EFFORTS.length - 1, i))]!;
      useChatStore.getState().setSessionEffort(sessionId, value);
    };
    return (
      <div className="relative">
        <button
          ref={btnRef}
          title={`${t('effort')} · ${t('effortCycleHint')}`}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
        >
          <span className={cEffort === 'max' ? 'effort-max-label' : ''}>{cLabel(cEffort)}</span>
          <ChevronDown size={11} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div style={popupStyle()} className="z-20 rounded-2xl border border-line bg-bg-input p-4 shadow-lg">
              <div className="mb-3 flex items-center">
                <span className={`text-ui font-medium ${cEffort === 'max' ? 'effort-max-label' : ''}`}>{cLabel(cEffort)}</span>
              </div>
              <EffortSlider index={cIdx} count={CLAUDE_EFFORTS.length} onSelect={cSelect} />
              <div className="mt-2 flex justify-between text-[10px] text-ink-faint">
                {CLAUDE_EFFORTS.map((e) => (
                  <span key={e}>{cLabel(e)}</span>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }
  // codex / opencode 统一壳：opencode 无 reasoning variants 的模型不渲染
  // 思考深度控件（resolved 为 undefined）。
  if (!resolved) return null;
  const { value: effort, options: efforts, index: idx, explicit } = resolved;
  const label = (e: string): string => (EFFORT_LABEL_KEYS[e] ? t(EFFORT_LABEL_KEYS[e]!) : e);
  // opencode 目录无默认档字段且未显选时，展示「跟随默认」而非具体档 —
  // 发送侧 explicit=false 不下发，避免把预览档强加给服务端。
  const showFollowDefault = !explicit;

  const select = (i: number): void => {
    const value = efforts[Math.max(0, Math.min(efforts.length - 1, i))]!;
    useChatStore.getState().setSessionEffort(sessionId, value);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        title={`${t('effort')} · ${t('effortCycleHint')}`}
        onClick={() => {
          // 同 ModelPicker：展开时后台刷新（TTL 节流；档位元数据同源于 catalog）。
          if (!open) void maybeRefreshEngineConfigs();
          setOpen(!open);
        }}
        className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover"
      >
        <span className={effort === 'xhigh' ? 'effort-max-label' : ''}>
          {showFollowDefault ? t('effortFollowDefault') : label(effort)}
        </span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div style={popupStyle()} className="z-20 rounded-2xl border border-line bg-bg-input p-4 shadow-lg">
            <div className="mb-3 flex items-center">
                <span className={`text-ui font-medium ${effort === 'xhigh' ? 'effort-max-label' : ''}`}>
                  {showFollowDefault ? t('effortFollowDefault') : label(effort)}
                </span>
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
              // 任务进行中不能压缩（会与正跑的回合争引擎回合）→ 给提示。
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

/** Goal 状态行 —— 内嵌输入框顶部的一体行条（引擎真实 goal 状态，
 *  codex thread/goal/updated 推 objective/status/usage，无客户端伪造）。 */
function GoalBar({ sessionId, onEdit }: { sessionId: string; onEdit: (initial: string) => void }): JSX.Element | null {
  const t = useT();
  const goal = useChatStore((s) => s.goals[sessionId]);
  const isPlan = useChatStore((s) => s.ui[sessionId]?.modes.current === 'plan');
  const controlGoal = useChatStore((s) => s.controlGoal);
  const [, tick] = useState(0);
  // 引擎只在结算点（回合边界/goal 工具调用）推 timeUsedSeconds，两次
  // 推送间本地外推秒针，否则计时长时间冻结再跳变；shownRef 单调保护。
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

  // 换了目标 = 新 goal，单调保护归零；快照值变小 → 重置外推基线。
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
  const statusKey =
    goal.status === 'blocked'
      ? ('goalStatusBlocked' as const)
      : goal.status === 'usageLimited'
        ? ('goalStatusUsageLimited' as const)
        : goal.status === 'budgetLimited'
          ? ('goalStatusBudgetLimited' as const)
          : null;
  const statusLabel =
    goal.status === 'active'
      ? t('goalRunning')
      : goal.status === 'paused'
        ? `${t('goal')} · ${t('goalPause')}`
        : statusKey
          ? `${t('goal')} · ${t(statusKey)}`
          : `${t('goal')} · ${goal.status}`;

  return (
    <div className="border-b border-line bg-bg-panel/70">
      <div className="flex items-baseline gap-2 px-3 py-1.5 text-[12px]">
        <Target size={12} className={`shrink-0 self-center ${goal.status === 'active' ? 'text-accent' : 'text-ink-faint'}`} />
        <span className="shrink-0 font-medium leading-[19px] text-ink">{statusLabel}</span>
        <span className="min-w-0 flex-1 truncate leading-[19px] text-ink-soft" title={goal.objective}>
          {goal.objective}
        </span>
        <span
          className="shrink-0 font-mono text-[11px] leading-[19px] tabular-nums text-ink-faint"
          title={`${t('goalTokensTitle', { n: goal.tokensUsed.toLocaleString() })}${goal.tokenBudget ? t('goalTokensBudget', { n: goal.tokenBudget.toLocaleString() }) : ''}`}
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

// ----------------------------------------------------------- add (+) menu

/** 控件条的 + 菜单（codex 同款）：选择文件 / 放大输入框。
 *  位置固定在引擎图标之后，不参与响应式退避。 */
function AddMenu({ onExpand, onPickFiles }: { onExpand: () => void; onPickFiles: () => void }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const item =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui text-ink transition hover:bg-bg-hover';
  return (
    <div className="relative">
      <button
        title={t('addMenu')}
        onClick={() => setOpen(!open)}
        className={`shrink-0 rounded-lg p-1.5 transition ${open ? 'bg-bg-hover text-ink' : 'text-ink-faint hover:bg-bg-hover hover:text-ink'}`}
      >
        <Plus size={14} />
      </button>
      {open && (
        <Dropdown onClose={() => setOpen(false)}>
          <button
            onClick={() => {
              setOpen(false);
              onPickFiles();
            }}
            className={item}
          >
            <Paperclip size={13} className="text-ink-faint" />
            {t('addFiles')}
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onExpand();
            }}
            className={item}
          >
            <Maximize2 size={13} className="text-ink-faint" />
            {t('expandInput')}
          </button>
        </Dropdown>
      )}
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
    <button title={title} onClick={onClick} className="flex items-center justify-center self-center rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
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
