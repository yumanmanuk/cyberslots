/**
 * SettingsView — full-page settings with a category rail (通用 / 模型 /
 * 赛马 / 通知 / 关于). 全页实时保存：无草稿/保存钮，每个控件改动
 * 直接按字段 patch 写回 settings。模型页是 CLI 配置的只读快照
 * （~/.kimi-code、~/.codex）加每引擎一个协议路由开关 — 本程序
 * 不提供任何配置文件修改功能。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bell, Box, ChevronRight, Eye, EyeOff, FileLock2, GripVertical, Info, Plus, RefreshCw, Search, Settings2, Upload, X } from 'lucide-react';

import type { AgyAccountsSnapshot, AgyImportCandidate, AgyQuotaInfo, AppSettings, ClaudeConfigSnapshot, CodexConfigSnapshot, CompatAuditKind, CompatAuditSnapshot, ContextFallbackRule, EngineConfigsSnapshot, EngineId, KimiConfigSnapshot, NotificationSettings, OmpCatalog, OmpConfigSnapshot, OpencodeCatalog, OpencodeConfigSnapshot, RaceRoleDefaultSetting, RouteSupport, TitleGenSettings } from '@shared/types';
import { isRaceActive, RACE_ROLES } from '@shared/race';
import { announceSystem, useChatStore } from '../store/chatStore';
import { useRaceStore } from '../store/raceStore';
import { agyWindowLabel, engineHintKey, raceRoleKey, translate, useT, type MsgKey } from '../i18n';
import { ENGINE_LABELS, EngineIcon, useEngineOrder } from './EngineIcon';
import { RaceHorse } from './RaceHorse';
import { BrandHero, BrandMark, BrandSpinner } from './brand';
import { effortLabel, useRoleCatalogs } from './race/modelCatalogs';
import { ANTIGRAVITY_LABELS } from './race/modelCatalogs';

type MainCategory = 'general' | 'race' | 'notifications' | 'about';
/** 导航分类：固定页 + 引擎总览页（'engines'）+ 每引擎一个子页
 *  （「引擎」分组下按 engineOrder 列出）。 */
type Category = MainCategory | 'engines' | EngineId;

const CATEGORIES: Array<{ id: MainCategory; key: MsgKey; icon: React.ReactNode }> = [
  { id: 'general', key: 'settingsGeneral', icon: <Settings2 size={15} /> },
  { id: 'race', key: 'settingsRace', icon: <RaceHorse size={16} /> },
  { id: 'notifications', key: 'settingsNotifications', icon: <Bell size={15} /> },
  { id: 'about', key: 'settingsAbout', icon: <Info size={15} /> },
];

/** 透明 1px 拖影 — 隐藏系统默认的半透明行快照（拖拽重排的视觉反馈
 *  改走 FLIP 实体位移，见引擎顺序列表）。 */
const DRAG_BLANK_IMG = new Image();
DRAG_BLANK_IMG.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export default function SettingsView(): JSX.Element | null {
  const t = useT();
  const open = useChatStore((s) => s.settingsOpen);
  const settings = useChatStore((s) => s.settings);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const refreshEngineConfigs = useChatStore((s) => s.refreshEngineConfigs);
  // 导航置灰/小黄点数据源：引擎可用性（null = 尚未探测 → 不置灰）与兼容性审计。
  const availability = useChatStore((s) => s.engineAvailability);
  const compatByEngine = useChatStore((s) => s.compatAudit?.engines);
  const engineOrder = useEngineOrder();
  const [category, setCategory] = useState<Category>('general');
  // 导航选中项滑动高亮 — 与新建会话选引擎同款：测量选中按钮位置，
  // 用绝对定位的胶囊平移过渡代替逐按钮背景瞬移。
  const navRefs = useRef<Partial<Record<Category, HTMLButtonElement | null>>>({});
  const [navPill, setNavPill] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // 跟踪打开/关闭沿 — 只在「刚打开」那一拍复位到通用页（用户页内导航不改分类）。
  const prevOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      // 打开设置即探测一次可用性 — 导航置灰不依赖用户先点进某个引擎页。
      void refreshEngineConfigs();
    }
  }, [open, refreshEngineConfigs]);

  useLayoutEffect(() => {
    // 打开设置回到通用页（仅刚打开那一拍）→ 先复位再测量：重开时高亮
    // 胶囊直接落在「通用」上，不会先亮上次的分类再滑回。
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;
    if (justOpened && category !== 'general') {
      setCategory('general');
      return;
    }
    const el = navRefs.current[category];
    if (!el) return;
    setNavPill((prev) => {
      const next = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
      return prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height
        ? prev
        : next;
    });
  }, [open, category, engineOrder]);

  if (!open || !settings) return null;

  const close = (): void => useChatStore.setState({ settingsOpen: false });
  // 全页实时保存：单一数据源（store settings）+ 按字段 patch 写回，
  // 无草稿快照（旧快照整体回写会冲掉其他面板的即时改动）。
  const commit = (patch: Partial<AppSettings>): void => void saveSettings(patch);

  const isEngine = (c: Category): c is EngineId => (engineOrder as string[]).includes(c);
  const navBtnCls = (active: boolean): string =>
    `relative mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-ui transition ${active ? 'font-medium text-ink' : 'text-ink-soft hover:bg-bg-hover'
    }`;

  return (
    <div className="absolute inset-0 z-30 flex bg-bg-canvas">
      {/* 分类导航 — 与画布同色融合 */}
      <aside className="relative flex w-56 shrink-0 flex-col px-3 pb-4 pt-3">
        {/* 选中项滑动高亮胶囊 — 同新建会话选引擎：跟随导航项平移 */}
        {navPill && (
          <div
            className="pointer-events-none absolute rounded-lg bg-bg-active shadow-sm transition-all duration-300 ease-out"
            style={{ left: navPill.left, top: navPill.top, width: navPill.width, height: navPill.height }}
          />
        )}
        <button onClick={close} className="mb-3 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-ui text-ink-soft transition hover:bg-bg-hover hover:text-ink">
          <ArrowLeft size={15} /> {t('back')}
        </button>
        {CATEGORIES.slice(0, 1).map((c) => (
          <button key={c.id} ref={(el) => { navRefs.current[c.id] = el; }} onClick={() => setCategory(c.id)} className={navBtnCls(category === c.id)}>
            {c.icon} {t(c.key)}
          </button>
        ))}
        {/* 引擎分组 — 组标题本身可点 = 引擎总览页（支持哪些引擎/安装态/顺序）；
            下挂每引擎一个子页，顺序跟随设置 engineOrder。未安装只置灰
            不禁点 — 页内自带安装指引，全禁用会把指引也锁死。 */}
        <button
          onClick={() => setCategory('engines')}
          ref={(el) => { navRefs.current['engines'] = el; }}
          className={`relative mb-0.5 mt-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-ui transition ${category === 'engines' ? 'font-medium text-ink' : 'text-ink-soft hover:bg-bg-hover'
            }`}
        >
          <Box size={15} /> {t('settingsEngines')}
        </button>
        {engineOrder.map((id) => {
          const installed = availability?.[id] ?? true;
          const hasIssue = (compatByEngine?.[id]?.length ?? 0) > 0;
          return (
            <button
              key={id}
              ref={(el) => { navRefs.current[id] = el; }}
              onClick={() => setCategory(id)}
              title={installed ? undefined : t('engineNotInstalledHint')}
              className={`${navBtnCls(category === id)} pl-5 ${installed ? '' : 'opacity-55'}`}
            >
              <EngineIcon engine={id} size={14} />
              <span className="min-w-0 flex-1 truncate text-left">{ENGINE_LABELS[id]}</span>
              {/* 兼容性审计有条目 → 子项小黄点（承接侧栏齿轮黄点的定位链路） */}
              {hasIssue && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />}
              {!installed && (
                <span className="shrink-0 rounded bg-warn/10 px-1 text-[10px] text-warn">{t('engineNotInstalled')}</span>
              )}
            </button>
          );
        })}
        <div className="mt-3" />
        {CATEGORIES.slice(1).map((c) => (
          <button key={c.id} ref={(el) => { navRefs.current[c.id] = el; }} onClick={() => setCategory(c.id)} className={navBtnCls(category === c.id)}>
            {c.icon} {t(c.key)}
          </button>
        ))}
      </aside>

      {/* 内容区 — 与主界面同款左上大圆角浮层 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[20px] bg-bg shadow-sm">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-8 py-8">
            <h1 className="mb-6 text-xl font-semibold">
              {category === 'engines'
                ? t('settingsEngines')
                : isEngine(category)
                  ? ENGINE_LABELS[category]
                  : t(CATEGORIES.find((c) => c.id === category)!.key)}
            </h1>
            {category === 'general' && <GeneralPane settings={settings} commit={commit} />}
            {category === 'engines' && <EnginesOverviewPane settings={settings} commit={commit} onOpenEngine={setCategory} />}
            {isEngine(category) && <EnginePane engine={category} />}
            {category === 'race' && <RacePane settings={settings} commit={commit} />}
            {category === 'notifications' && <NotificationsPane settings={settings} commit={commit} />}
            {category === 'about' && <AboutPane />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- general

interface PaneProps {
  settings: AppSettings;
  commit: (patch: Partial<AppSettings>) => void;
}

function GeneralPane({ settings, commit }: PaneProps): JSX.Element {
  const t = useT();
  const rules = settings.contextFallbackRules ?? [];
  const setRules = (contextFallbackRules: ContextFallbackRule[]): void => commit({ contextFallbackRules });
  const titleGen = settings.titleGen ?? { mode: 'program', baseUrl: '', apiKey: '', model: '' };
  const patchTitleGen = (p: Partial<TitleGenSettings>): void => commit({ titleGen: { ...titleGen, ...p } });
  return (
    <div className="space-y-7">
      <Section title={t('language')}>
        <Segmented
          value={settings.language}
          options={[
            { id: 'zh', label: t('langZh') },
            { id: 'en', label: t('langEn') },
          ]}
          onChange={(language) => commit({ language: language as AppSettings['language'] })}
        />
      </Section>
      <Section title={t('themeMode')}>
        <Segmented
          value={settings.themeMode}
          options={[
            { id: 'light', label: t('modeLight') },
            { id: 'dark', label: t('modeDark') },
            { id: 'system', label: t('modeSystem') },
          ]}
          onChange={(themeMode) => commit({ themeMode: themeMode as AppSettings['themeMode'] })}
        />
      </Section>
      <Section title={t('sendKey')}>
        <Segmented
          value={settings.sendKey}
          options={[
            { id: 'enter', label: t('sendEnter') },
            { id: 'ctrl-enter', label: t('sendCtrlEnter') },
          ]}
          onChange={(sendKey) => commit({ sendKey: sendKey as AppSettings['sendKey'] })}
        />
      </Section>
      <Section title={t('defaultPermMode')}>
        {/* 档位与 Composer 权限选择器一致（plan 由 Agent/Plan 开关承载，不在此列）。 */}
        <Segmented
          value={settings.defaultPermissionMode}
          options={[
            { id: 'default', label: t('permManual') },
            { id: 'auto', label: t('permAuto') },
            { id: 'yolo', label: t('permYolo') },
          ]}
          onChange={(defaultPermissionMode) => commit({ defaultPermissionMode: defaultPermissionMode as AppSettings['defaultPermissionMode'] })}
        />
        <p className="mt-2 text-[11px] leading-5 text-ink-faint">{t('defaultPermModeHint')}</p>
      </Section>
      <Section title={t('titleGen')}>
        <Segmented
          value={titleGen.mode}
          options={[
            { id: 'program', label: t('titleGenProgram') },
            { id: 'ai', label: t('titleGenAi') },
          ]}
          onChange={(mode) => patchTitleGen({ mode: mode as TitleGenSettings['mode'] })}
        />
        {titleGen.mode === 'ai' && (
          <div className="mt-3 space-y-2">
            <input
              value={titleGen.baseUrl}
              placeholder={t('titleGenBaseUrl')}
              onChange={(e) => patchTitleGen({ baseUrl: e.target.value })}
              className="w-full max-w-md rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-ui outline-none placeholder:text-ink-faint"
            />
            <input
              type="password"
              value={titleGen.apiKey}
              placeholder={t('titleGenApiKey')}
              onChange={(e) => patchTitleGen({ apiKey: e.target.value })}
              className="w-full max-w-md rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-ui outline-none placeholder:text-ink-faint"
            />
            <input
              value={titleGen.model}
              placeholder={t('titleGenModel')}
              onChange={(e) => patchTitleGen({ model: e.target.value })}
              className="w-full max-w-md rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-ui outline-none placeholder:text-ink-faint"
            />
          </div>
        )}
        <p className="mt-2 text-[11px] leading-5 text-ink-faint">{t('titleGenHint')}</p>
      </Section>
      <Section title={t('autoCompact')}>
        <Segmented
          value={String(settings.autoCompactRatio)}
          options={[
            { id: '0', label: t('autoCompactOff') },
            { id: '70', label: '70%' },
            { id: '80', label: '80%' },
            { id: '90', label: '90%' },
            { id: '95', label: '95%' },
          ]}
          onChange={(v) => commit({ autoCompactRatio: Number(v) })}
        />
        <p className="mt-2 text-[11px] leading-5 text-ink-faint">{t('autoCompactHint')}</p>
      </Section>
      <Section title={t('contextFallback')}>
        <div className="space-y-2">
          {rules.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={r.match}
                placeholder={t('contextFallbackMatch')}
                onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)))}
                className="w-48 rounded-lg border border-line bg-bg-input px-2.5 py-1.5 text-ui outline-none placeholder:text-ink-faint"
              />
              <span className="text-ink-faint">→</span>
              <input
                value={r.to}
                placeholder={t('contextFallbackTo')}
                onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}
                className="w-48 rounded-lg border border-line bg-bg-input px-2.5 py-1.5 text-ui outline-none placeholder:text-ink-faint"
              />
              <button
                title={t('remove')}
                onClick={() => setRules(rules.filter((_, j) => j !== i))}
                className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            onClick={() => setRules([...rules, { match: '', to: '' }])}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui text-ink-soft transition hover:bg-bg-hover hover:text-ink"
          >
            <Plus size={13} /> {t('contextFallbackAdd')}
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-ink-faint">{t('contextFallbackHint')}</p>
      </Section>
    </div>
  );
}

// ----------------------------------------------------------------- engines
// 引擎总览：支持的引擎清单（安装态/版本/简介，点击进入子页）+
// 引擎总体配置（展示顺序）+ 跨引擎兼容性诊断。

function EnginesOverviewPane({ commit, onOpenEngine }: PaneProps & { onOpenEngine: (id: EngineId) => void }): JSX.Element {
  const t = useT();
  const refreshEngineConfigs = useChatStore((s) => s.refreshEngineConfigs);
  const availability = useChatStore((s) => s.engineAvailability);
  const [snap, setSnap] = useState<EngineConfigsSnapshot | null>(null);
  useEffect(() => {
    void refreshEngineConfigs().then(setSnap);
  }, [refreshEngineConfigs]);

  // 引擎列表顺序：拖拽排序 — 拖动中实时预览重排（FLIP 位移动画），
  // 松手提交完整序列；取消（Esc/拖出）则弹回原序。
  const engineOrder = useEngineOrder();
  const [dragId, setDragId] = useState<EngineId | null>(null);
  const [draft, setDraft] = useState<EngineId[] | null>(null);
  const dropCommitted = useRef(false);
  const rowRefs = useRef(new Map<EngineId, HTMLDivElement>());
  const flipTops = useRef(new Map<EngineId, number>());
  const order = draft ?? engineOrder;

  /** 重排前先快照各行纵坐标 — 渲染后在 useLayoutEffect 里做 FLIP 反演位移。 */
  const snapshotRows = (): void => {
    flipTops.current.clear();
    for (const [id, el] of rowRefs.current) flipTops.current.set(id, el.getBoundingClientRect().top);
  };
  useLayoutEffect(() => {
    // FLIP：新位置先反向平移回旧位置，下一帧释放到 0 — 行以缓动曲线“让位”
    // 而非瞬移。无快照时不动（仅拖拽/弹回引发的重排才有动画）。
    for (const [id, el] of rowRefs.current) {
      const prevTop = flipTops.current.get(id);
      if (prevTop === undefined) continue;
      const dy = prevTop - el.getBoundingClientRect().top;
      if (!dy) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 240ms cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.transform = '';
      });
    }
    flipTops.current.clear();
  });

  /** 拖到某行上方 → 把被拖引擎插到该行位置（预览序，未提交）。 */
  const previewMove = (overId: EngineId): void => {
    if (!dragId || dragId === overId) return;
    const cur = draft ?? engineOrder;
    const from = cur.indexOf(dragId);
    const to = cur.indexOf(overId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...cur];
    next.splice(from, 1);
    next.splice(to, 0, dragId);
    snapshotRows();
    setDraft(next);
  };
  const commitDrag = (): void => {
    if (draft && draft.join('|') !== engineOrder.join('|')) commit({ engineOrder: draft });
    dropCommitted.current = true;
  };
  const endDrag = (): void => {
    setDragId(null);
    if (!dropCommitted.current && draft) {
      // 未落在有效目标上（Esc/拖出窗口）→ 弹回原序（同样走 FLIP）。
      snapshotRows();
      setDraft(null);
    }
    dropCommitted.current = false;
  };
  // 提交后 settings 回到与预览序一致 → 静默释放 draft（无视觉跳变）。
  useEffect(() => {
    if (draft && !dragId && draft.join('|') === engineOrder.join('|')) setDraft(null);
  }, [draft, dragId, engineOrder]);

  /** 快照 → 安装态/版本（kimi/codex 无 CLI 探测，安装态用配置存在性近似，
   *  版本号来自 npm 包/`--version` 探测；快照未到时回退 store 可用性，
   *  undefined = 探测中）。 */
  const statusOf = (id: EngineId): { installed?: boolean; version?: string } => {
    if (!snap) return { installed: availability?.[id] };
    switch (id) {
      case 'codex':
        return { installed: snap.codex.exists, version: snap.codex.version };
      case 'kimi':
        return { installed: snap.kimi.exists, version: snap.kimi.version };
      case 'opencode':
        return { installed: snap.opencode.installed, version: snap.opencode.version };
      case 'omp':
        return { installed: snap.omp.installed, version: snap.omp.version };
      case 'antigravity':
        return { installed: snap.antigravity.installed, version: snap.antigravity.version };
      case 'claude':
        return { installed: snap.claude.installed, version: snap.claude.version };
    }
  };

  return (
    <div className="space-y-7">
      <Section title={t('supportedEngines')}>
        <div className="w-full space-y-1.5">
          {engineOrder.map((id) => {
            const { installed, version } = statusOf(id);
            const off = installed === false;
            return (
              <button
                key={id}
                onClick={() => onOpenEngine(id)}
                title={off ? t('engineNotInstalledHint') : undefined}
                className={`flex w-full items-center gap-3 rounded-xl border border-line bg-bg-panel/50 px-4 py-3 text-left transition hover:bg-bg-hover ${off ? 'opacity-55' : ''}`}
              >
                <EngineIcon engine={id} size={18} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold">{ENGINE_LABELS[id]}</span>
                  <span className="block truncate text-[11px] leading-5 text-ink-faint">{t(engineHintKey(id))}</span>
                </span>
                {installed === undefined ? (
                  <BrandSpinner size={12} />
                ) : (
                  <span className={`shrink-0 rounded-md px-1.5 text-[10px] ${installed ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
                    {installed ? `${t('setInstalled')}${version ? ` ${version}` : ''}` : t('engineNotInstalled')}
                  </span>
                )}
                <ChevronRight size={14} className="shrink-0 text-ink-faint" />
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-ink-faint">{t('enginesOverviewHint')}</p>
      </Section>
      <Section title={t('engineOrder')}>
        <div className="w-full max-w-md space-y-1" onDragOver={(e) => e.preventDefault()}>
          {order.map((id, i) => {
            const dragging = dragId === id;
            return (
              <div
                key={id}
                ref={(el) => {
                  if (el) rowRefs.current.set(id, el);
                  else rowRefs.current.delete(id);
                }}
                draggable
                onDragStart={(e) => {
                  setDragId(id);
                  dropCommitted.current = false;
                  e.dataTransfer.effectAllowed = 'move';
                  // 隐藏系统拖影 — 行本体留在列表里随预览重排移动，
                  // 观感是“实体在列表内滑动”而非半透明副本飘移。
                  e.dataTransfer.setDragImage(DRAG_BLANK_IMG, 0, 0);
                }}
                onDragEnter={() => previewMove(id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  commitDrag();
                }}
                onDragEnd={endDrag}
                title={t('engineOrderDrag')}
                className={`relative flex select-none items-center gap-2.5 rounded-lg border px-3 py-1.5 ${dragging
                  ? 'z-10 cursor-grabbing border-accent/60 bg-bg-hover shadow-lg'
                  : 'cursor-grab border-line bg-bg-input'
                  }`}
              >
                <GripVertical size={13} className={`shrink-0 ${dragging ? 'text-accent' : 'text-ink-faint/60'}`} />
                <span className="w-3 text-center text-[11px] tabular-nums text-ink-faint">{i + 1}</span>
                <EngineIcon engine={id} size={14} />
                <span className="flex-1 text-ui">{ENGINE_LABELS[id]}</span>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-ink-faint">{t('engineOrderHint')}</p>
      </Section>
      {/* 跨引擎视角的兼容性诊断总卡（各引擎子页内另有单引擎过滤视图） */}
      <CompatAuditCard />
      <LogsCard />
    </div>
  );
}

// 每引擎一个子页：只读展示 CLI 自己的配置（本程序永不写入）+ 协议路由
// 开关 + 该引擎的兼容性诊断。未安装时卡片自带安装指引（导航只置灰不禁点）。

function EnginePane({ engine }: { engine: EngineId }): JSX.Element {
  const t = useT();
  const settings = useChatStore((s) => s.settings);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const refreshEngineConfigs = useChatStore((s) => s.refreshEngineConfigs);
  const loadOmpCatalog = useChatStore((s) => s.loadOmpCatalog);
  const loadOpencodeCatalog = useChatStore((s) => s.loadOpencodeCatalog);
  const [snap, setSnap] = useState<EngineConfigsSnapshot | null>(null);
  // ↻ 刷新进行中 — 图标按钮 busy 态换 BrandSpinner（完成即停，回到 ↻）。
  const [reloadBusy, setReloadBusy] = useState(false);

  // ↻ 一次点击同时刷新本页快照与全局 codex 目录/默认档（同一次读取，天然一致）；
  // 显式点击时连当前引擎的模型目录一并强制重拉（否则目录走进程级缓存，
  // 改完 models.yml 点 ↻ 看不到新模型）；切页自动刷新不强拉，避免每次白跑 CLI。
  const reload = (forceCatalog?: boolean): void => {
    setReloadBusy(true);
    const jobs: Promise<unknown>[] = [refreshEngineConfigs().then(setSnap)];
    if (forceCatalog && engine === 'omp') jobs.push(loadOmpCatalog(true));
    if (forceCatalog && engine === 'opencode') jobs.push(loadOpencodeCatalog(true));
    void Promise.allSettled(jobs).then(() => setReloadBusy(false));
  };
  // 切换引擎子页时重读一次 — 配置文件是磁盘上的活物。
  useEffect(() => reload(), [engine]);

  // 路由开关即时保存（同通知开关），并提示仅对新开会话生效。
  const setRouting = (e: 'kimi' | 'codex', on: boolean): void => {
    const routing = { ...(settings?.routing ?? { kimi: false, codex: false }), [e]: on };
    void saveSettings({ routing });
  };
  const routing = settings?.routing ?? { kimi: false, codex: false };

  // antigravity 无 CLI 配置快照 — 账号导入池卡片自成一页。
  if (engine === 'antigravity') {
    return (
      <div className="space-y-5">
        <AntigravityAccountsCard />
        <CompatAuditCard engine="antigravity" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 rounded-xl border border-line bg-bg-panel/50 px-4 py-3">
        <FileLock2 size={15} className="mt-0.5 shrink-0 text-ink-faint" />
        <p className="text-[12px] leading-5 text-ink-faint">{t('modelsReadonlyHint')}</p>
        <button title={t('cfgReload')} onClick={() => reload(true)} disabled={reloadBusy} className="shrink-0 rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink disabled:cursor-default disabled:hover:bg-transparent">
          {reloadBusy ? <BrandSpinner size={13} /> : <RefreshCw size={13} />}
        </button>
      </div>

      {!snap ? (
        <div className="flex flex-col items-center gap-2 py-8 text-ui text-ink-faint">
          {/* 面板内容区级等待按规范用 BrandHero（原来只有一个纯文字…） */}
          <BrandHero size={48} />
          {t('setReadingConfig')}
        </div>
      ) : (
        <>
          {engine === 'codex' && (
            <CodexConfigCard
              snap={snap.codex}
              support={snap.routeSupport.codex}
              routing={routing.codex}
              onToggle={(on) => setRouting('codex', on)}
            />
          )}
          {engine === 'kimi' && (
            <KimiConfigCard
              snap={snap.kimi}
              support={snap.routeSupport.kimi}
              routing={routing.kimi}
              onToggle={(on) => setRouting('kimi', on)}
            />
          )}
          {engine === 'opencode' && <OpencodeConfigCard snap={snap.opencode} />}
          {engine === 'omp' && <OmpConfigCard snap={snap.omp} />}
          {engine === 'claude' && <ClaudeConfigCard snap={snap.claude} />}
        </>
      )}
      <CompatAuditCard engine={engine} />
    </div>
  );
}

function CardShell({
  title,
  configPath,
  routing,
  support,
  onToggle,
  children,
}: {
  title: string;
  configPath: string;
  routing: boolean;
  support: RouteSupport;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}): JSX.Element {
  const t = useT();
  return (
    <div className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3.5">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={configPath}>
          {configPath}
        </span>
        <span className="text-[11px] text-ink-soft">{t('routingSwitch')}</span>
        <Toggle checked={routing} onChange={onToggle} disabled={!support.ok && !routing} />
      </div>
      <div className="mb-3 text-[11px] leading-5 text-ink-faint">
        {routing ? t('routingOnHint') : t('routingOffHint')}
        {!support.ok && support.reason && <span className="ml-1 text-warn">⚠ {support.reason}</span>}
        <span className="ml-1 text-ink-faint/70">{t('routingApplyHint')}</span>
      </div>
      {children}
    </div>
  );
}

function CodexConfigCard({
  snap,
  support,
  routing,
  onToggle,
}: {
  snap: CodexConfigSnapshot;
  support: RouteSupport;
  routing: boolean;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  const t = useT();
  const authLabel =
    snap.authMode === 'chatgpt' ? t('cfgAuthChatGPT') : snap.authMode === 'apikey' ? t('cfgAuthApiKey') : t('cfgAuthNone');
  return (
    <CardShell title="Codex" configPath={snap.configPath} routing={routing} support={support} onToggle={onToggle}>
      {!snap.exists ? (
        <div className="text-ui text-ink-faint">{t('cfgNotFound')}</div>
      ) : snap.error ? (
        <div className="text-ui text-err">{snap.error}</div>
      ) : (
        <div className="space-y-1.5 text-[12px]">
          <ReadonlyRow label={t('cfgActiveModel')} value={`${snap.model ?? '—'}${snap.reasoningEffort ? ` · ${snap.reasoningEffort}` : ''}`} />
          <ReadonlyRow label={t('cfgAuth')} value={authLabel} />
          <ReadonlyRow label={t('cfgActiveProvider')} value={snap.activeProvider ?? t('setBuiltinOpenai')} />
          {snap.providers.length > 0 ? (
            snap.providers.map((p) => (
              <div key={p.id} className="rounded-lg border border-line bg-bg-input px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name ?? p.id}</span>
                  <span className="rounded-md bg-bg-panel px-1.5 text-[10px] text-ink-faint">{p.wireApi}</span>
                  <span className={`rounded-md px-1.5 text-[10px] ${p.hasKey ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
                    {p.hasKey ? t('cfgKeySet') : `${t('cfgKeyMissing')}${p.envKey ? ` (${p.envKey})` : ''}`}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">{p.baseUrl}</div>
              </div>
            ))
          ) : (
            <div className="text-[11.5px] text-ink-faint">{t('cfgNoProviders')}</div>
          )}
        </div>
      )}
    </CardShell>
  );
}

function KimiConfigCard({
  snap,
  support,
  routing,
  onToggle,
}: {
  snap: KimiConfigSnapshot;
  support: RouteSupport;
  routing: boolean;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  const t = useT();
  return (
    <CardShell title="Kimi Code" configPath={snap.configPath} routing={routing} support={support} onToggle={onToggle}>
      {!snap.exists ? (
        <div className="text-ui text-ink-faint">{t('cfgNotFound')}</div>
      ) : snap.error ? (
        <div className="text-ui text-err">{snap.error}</div>
      ) : (
        <div className="space-y-1.5 text-[12px]">
          <ReadonlyRow label={t('cfgActiveModel')} value={snap.defaultModel ?? '—'} />
          {snap.providers.map((p) => (
            <div key={p.id} className="rounded-lg border border-line bg-bg-input px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.id}</span>
                <span className="rounded-md bg-bg-panel px-1.5 text-[10px] text-ink-faint">{p.type}</span>
                <span className={`rounded-md px-1.5 text-[10px] ${p.hasKey ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
                  {p.hasKey ? t('cfgKeySet') : t('cfgKeyMissing')}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">{p.baseUrl}</div>
              {p.models.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {p.models.map((m) => (
                    <span key={m.alias} title={m.model} className="rounded-md bg-bg-panel px-1.5 py-0.5 font-mono text-[10.5px] text-ink-soft">
                      {m.alias}
                      {m.maxContextSize ? ` · ${Math.round(m.maxContextSize / 1024)}K` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </CardShell>
  );
}

function ReadonlyRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[11px] text-ink-faint">{label}</span>
      <span className="min-w-0 truncate font-mono text-[11.5px] text-ink">{value}</span>
    </div>
  );
}

/** opencode 区块 — 无路由开关（不经 ai-server 协议代理），无 provider
 *  管理（凭据/模型完全委托 opencode 自身：zen 免费模型免登录可用）。
 *  catalog 加载后展示「模型展示」管理区 — openchamber 同款黑名单机制，
 *  隐藏的模型不再出现在选择器/赛马配置里（不碰 opencode 配置文件）。 */
function OpencodeConfigCard({ snap }: { snap: OpencodeConfigSnapshot }): JSX.Element {
  const t = useT();
  const catalog = useChatStore((s) => s.opencodeCatalog);
  const loadCatalog = useChatStore((s) => s.loadOpencodeCatalog);
  // 目录拉取进行中（本地态 — store 的 in-flight 标记非响应式，不驱动重绘）
  const [catalogBusy, setCatalogBusy] = useState(false);
  const runLoadCatalog = async (force?: boolean): Promise<void> => {
    setCatalogBusy(true);
    try {
      await loadCatalog(force);
    } finally {
      setCatalogBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3.5">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-[13px] font-semibold">opencode</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={snap.configPath}>
          {snap.configPath ?? ''}
        </span>
        <span className={`rounded-md px-1.5 text-[10px] ${snap.installed ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
          {snap.installed ? `${t('setInstalled')} ${snap.version ?? ''}` : t('engineNotInstalled')}
        </span>
      </div>
      <div className="mb-3 text-[11px] leading-5 text-ink-faint">
        {t('ocHint1')}<span className="font-mono">opencode auth login</span>{t('ocHint2')}
      </div>
      {!snap.installed ? (
        <div className="text-ui text-ink-faint">{t('ocNotFound')}</div>
      ) : (
        <div className="space-y-1.5 text-[12px]">
          {snap.cliPath && <ReadonlyRow label="CLI" value={snap.cliPath} />}
          <ReadonlyRow label="opencode.json" value={snap.configExists ? t('setExists') : t('setNotCreatedOptional')} />
          {catalog ? (
            catalog.error ? (
              <div className="text-[11.5px] text-err">{t('ocProvidersFailed', { err: catalog.error })}</div>
            ) : (
              <OpencodeModelVisibility catalog={catalog} />
            )
          ) : (
            <button
              onClick={() => void runLoadCatalog()}
              disabled={catalogBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-soft transition hover:bg-bg-hover disabled:cursor-default disabled:hover:bg-transparent"
            >
              {catalogBusy && <BrandSpinner size={12} />}
              {t('ocLoadModels')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** omp (Oh My Pi) 区块 — 无路由开关，凭据/模型完全委托 omp 自身（~/.omp，
 *  终端运行 `omp` 登录）。展示安装/版本（pin 基线 17.1.8，越线提示契约
 *  风险）与目录加载；并常驻两条行为提示：子代理免审批、魔法关键词。 */
const OMP_PINNED_VERSION = '17.1.8';

function OmpConfigCard({ snap }: { snap: OmpConfigSnapshot }): JSX.Element {
  const t = useT();
  const catalog = useChatStore((s) => s.ompCatalog);
  const loadCatalog = useChatStore((s) => s.loadOmpCatalog);
  // 目录拉取进行中（本地态 — store 的 in-flight 标记非响应式，不驱动重绘）
  const [catalogBusy, setCatalogBusy] = useState(false);
  const runLoadCatalog = async (force?: boolean): Promise<void> => {
    setCatalogBusy(true);
    try {
      await loadCatalog(force);
    } finally {
      setCatalogBusy(false);
    }
  };
  const versionDrift = snap.installed && snap.version && snap.version !== OMP_PINNED_VERSION;
  return (
    <div className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3.5">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-[13px] font-semibold">Oh My Pi</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={snap.configPath}>
          {snap.configPath ?? ''}
        </span>
        <span className={`rounded-md px-1.5 text-[10px] ${snap.installed ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
          {snap.installed ? `${t('setInstalled')} ${snap.version ?? ''}` : t('engineNotInstalled')}
        </span>
      </div>
      <div className="mb-3 text-[11px] leading-5 text-ink-faint">
        {t('ompHint1')}<span className="font-mono">omp</span>{t('ompHint2')}
        <span className="font-mono">ultrathink / orchestrate / workflowz</span>{t('ompHint3')}
      </div>
      {versionDrift && (
        <div className="mb-2 rounded-md bg-warn/10 px-2.5 py-1 text-[11px] text-warn">
          {t('ompVersionDrift', { v: snap.version ?? '', base: OMP_PINNED_VERSION })}
        </div>
      )}
      {!snap.installed ? (
        <div className="text-ui text-ink-faint">
          {t('ompNotFound1')}<span className="font-mono">irm https://omp.sh/install.ps1 | iex</span>{t('ompNotFound2')}
        </div>
      ) : (
        <div className="space-y-1.5 text-[12px]">
          {snap.cliPath && <ReadonlyRow label="CLI" value={snap.cliPath} />}
          <ReadonlyRow label="~/.omp/agent" value={snap.configExists ? t('setExists') : t('ompNotInited')} />
          {catalog ? (
            catalog.error ? (
              <div className="text-[11.5px] text-err">{t('ompCatalogFailed', { err: catalog.error })}</div>
            ) : catalog.models.length === 0 ? (
              <div className="text-[11.5px] text-ink-faint">{t('ompCatalogEmpty')}</div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-[11.5px] text-ink-faint">
                  <span>{t('ompCatalogCount', { n: catalog.models.length, p: new Set(catalog.models.map((m) => m.provider)).size })}</span>
                  <button
                    onClick={() => void runLoadCatalog(true)}
                    disabled={catalogBusy}
                    className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10.5px] text-ink-soft transition hover:bg-bg-hover disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    {catalogBusy && <BrandSpinner size={11} />}
                    {t('ompRefetch')}
                  </button>
                </div>
                <OmpModelVisibility catalog={catalog} />
              </>
            )
          ) : (
            <button
              onClick={() => void runLoadCatalog()}
              disabled={catalogBusy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-soft transition hover:bg-bg-hover disabled:cursor-default disabled:hover:bg-transparent"
            >
              {catalogBusy && <BrandSpinner size={12} />}
              {t('ompLoadCatalog')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Claude Code 区块 — 无路由开关，凭据/模型完全委托 claude 自身
 *  （终端运行 `claude` 或 `claude login` 登录，或设 ANTHROPIC_API_KEY）。
 *  展示安装/版本/登录布尔态 — 本程序只读不写 ~/.claude，绝不外泄凭据。 */
function ClaudeConfigCard({ snap }: { snap: ClaudeConfigSnapshot }): JSX.Element {
  const t = useT();
  const authLabel =
    snap.authMethod === 'oauth' ? t('clAuthOauth') : snap.authMethod === 'apikey' ? t('clAuthApiKey') : t('cfgAuthNone');
  const mcpConfig = useChatStore((s) => s.settings?.claudeMcpConfig ?? '');
  const cliPath = useChatStore((s) => s.settings?.claudeCliPath ?? '');
  const saveSettings = useChatStore((s) => s.saveSettings);
  const refreshEngineConfigs = useChatStore((s) => s.refreshEngineConfigs);
  const [mcpDraft, setMcpDraft] = useState(mcpConfig);
  const [cliDraft, setCliDraft] = useState(cliPath);
  useEffect(() => setMcpDraft(mcpConfig), [mcpConfig]);
  useEffect(() => setCliDraft(cliPath), [cliPath]);
  // 自定义启动命令变更 → 存盘后重拉快照（主进程探测缓存按入口 keying，自动重探）。
  const saveCliPath = (): void => {
    const next = cliDraft.trim();
    if (next === cliPath) return;
    void saveSettings({ claudeCliPath: next }).then(() => void refreshEngineConfigs());
  };
  return (
    <div className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3.5">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-[13px] font-semibold">Claude Code</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={snap.cliPath}>
          {snap.cliPath ?? ''}
        </span>
        <span className={`rounded-md px-1.5 text-[10px] ${snap.installed ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
          {snap.installed ? `${t('setInstalled')} ${snap.version ?? ''}` : t('engineNotInstalled')}
        </span>
      </div>
      <div className="mb-3 text-[11px] leading-5 text-ink-faint">
        {t('clHint1')}<span className="font-mono">claude login</span>{t('clHint2')}
        <span className="font-mono"> ANTHROPIC_API_KEY</span>{t('clHint3')}
      </div>
      {/* 自定义启动命令：始终可见（自动探测失败时，设它正是修复手段）。
          可填完整路径（cli.js/.cmd/.exe）或 PATH 上的命令名（如 cc）；
          不支持 shell 别名。仅对新开会话生效。 */}
      <div className="mb-3 flex items-center gap-2">
        <span className="w-20 shrink-0 text-[11px] text-ink-faint">{t('clLaunchCmd')}</span>
        <input
          value={cliDraft}
          placeholder={t('clLaunchPlaceholder')}
          onChange={(e) => setCliDraft(e.target.value)}
          onBlur={saveCliPath}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg-input px-2.5 py-1 font-mono text-[11px] outline-none placeholder:text-ink-faint"
        />
      </div>
      {!snap.installed ? (
        <div className="text-ui text-ink-faint">
          {t('clNotFound1')}<span className="font-mono">npm i -g @anthropic-ai/claude-code</span>{t('clNotFound2')}
        </div>
      ) : snap.error ? (
        <div className="text-ui text-err">{snap.error}</div>
      ) : (
        <div className="space-y-1.5 text-[12px]">
          {snap.cliPath && <ReadonlyRow label="CLI" value={snap.cliPath} />}
          <ReadonlyRow label={t('cfgAuth')} value={authLabel} />
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-[11px] text-ink-faint">{t('clLoginState')}</span>
            <span className={`rounded-md px-1.5 text-[10px] ${snap.loggedIn ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
              {snap.loggedIn ? t('clLoggedIn') : t('clNotLoggedIn')}
            </span>
          </div>
          {/* MCP：claude 自身 ~/.claude 的 MCP 服务器无需配置自动加载；此处只为叠加
              额外服务器（指向一个 MCP JSON 文件，→ --mcp-config），仅对新开会话生效。 */}
          <div className="flex items-center gap-2 pt-1">
            <span className="w-20 shrink-0 text-[11px] text-ink-faint">{t('clExtraMcp')}</span>
            <input
              value={mcpDraft}
              placeholder={t('clMcpPlaceholder')}
              onChange={(e) => setMcpDraft(e.target.value)}
              onBlur={() => mcpDraft !== mcpConfig && void saveSettings({ claudeMcpConfig: mcpDraft.trim() })}
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg-input px-2.5 py-1 font-mono text-[11px] outline-none placeholder:text-ink-faint"
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** 额度重置倒计时（与切号弹窗同格式）。 */
function fmtAgyReset(sec?: number): string {
  if (sec == null || sec <= 0) return '';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return translate('agyResetInDays', { d, h });
  if (h > 0) return translate('agyResetInHours', { h, m });
  return translate('agyResetInMins', { m });
}

/** Antigravity 账号导入池 — 列账号 + 额度总览 + 手动切号。本程序只使用
 *  在此显式导入的账号（切号弹窗/额度扫描只认导入池）。导入 = 从
 *  cockpit 账号库拷贝凭据副本到 userData/agy-accounts.json，不需任何
 *  OAuth 登录；移除仅删副本，不碰 cockpit / 当前 keyring。 */
function AntigravityAccountsCard(): JSX.Element {
  const t = useT();
  const sessions = useChatStore((s) => s.sessions);
  const sending = useChatStore((s) => s.sending);
  const races = useRaceStore((s) => s.races);
  const [snap, setSnap] = useState<AgyAccountsSnapshot | null>(null);
  const [quota, setQuota] = useState<Record<string, AgyQuotaInfo>>({});
  const [quotaBusy, setQuotaBusy] = useState(false);
  const [quotaFailed, setQuotaFailed] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [candidates, setCandidates] = useState<AgyImportCandidate[] | null>(null);
  const [candError, setCandError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // agy 新会话默认模型（全局设置，与账号解耦）— 未在 composer 显式选模型时生效。
  const agyDefaultModel = useChatStore((s) => s.settings?.antigravityDefaultModel ?? '');
  const agyHiddenList = useChatStore((s) => s.settings?.antigravityHiddenModels);
  const agyAutoSwitch = useChatStore((s) => s.settings?.antigravityAutoSwitch ?? false);
  const agyThreshold5h = useChatStore((s) => s.settings?.antigravityQuotaThreshold5h ?? 15);
  const agyThreshold7d = useChatStore((s) => s.settings?.antigravityQuotaThreshold7d ?? 5);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const agyHidden = useMemo(() => new Set(agyHiddenList ?? []), [agyHiddenList]);
  const toggleAgyHidden = (slug: string): void => {
    const next = new Set(agyHidden);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    void saveSettings({ antigravityHiddenModels: [...next] });
  };

  const loadQuota = (force?: boolean): void => {
    setQuotaBusy(true);
    setQuotaFailed(false);
    void window.cyberslots
      .agyQuota(force)
      .then((list) => {
        const map: Record<string, AgyQuotaInfo> = {};
        for (const q of list) map[q.accountId] = q;
        setQuota(map);
        setQuotaBusy(false);
      })
      .catch(() => {
        // IPC 异常也要落地为失败态 — 否则行内永远停在「额度加载中」。
        setQuotaBusy(false);
        setQuotaFailed(true);
      });
  };
  useEffect(() => {
    void window.cyberslots.agyAccountsList().then((s) => {
      setSnap(s);
      if (s.accounts.length > 0) loadQuota();
    });
  }, []);

  const openImport = (): void => {
    setImportOpen(true);
    setCandidates(null);
    setCandError(null);
    setPicked(new Set());
    void window.cyberslots.agyImportCandidates().then((r) => {
      setCandidates(r.candidates);
      setCandError(r.error ?? null);
    });
  };
  const togglePick = (id: string): void => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const doImport = (): void => {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    void window.cyberslots.agyAccountsImport([...picked]).then((s) => {
      setSnap(s);
      setBusy(false);
      setImportOpen(false);
      loadQuota(true);
    });
  };
  const remove = (id: string): void => {
    void window.cyberslots.agyAccountRemove(id).then(setSnap);
  };
  /** 从导出文件（[{email, refresh_token}]）导入 — 文件选择/解析全在主进程。 */
  const importFromFile = (): void => {
    if (fileBusy) return;
    setFileBusy(true);
    window.cyberslots
      .agyAccountsImportFile()
      .then((s) => {
        if (s) {
          // null = 用户取消选择，不动现状。
          setSnap(s);
          loadQuota(true);
        }
      })
      .finally(() => setFileBusy(false));
  };
  /** 手动切号（复用切号弹窗同一 IPC）：覆写 keyring，不携带会话续接。
   *  主动切号门禁：有进行中的 antigravity 任务时拒绝 —— keyring 是全局
   *  单槽、即时生效，中途切换会把在飞回合与后续回合劈到两个账号
   *  （在途 agy 进程启动时已绑定旧账号，见集成文档 §3.9）。 */
  const switchTo = (id: string): void => {
    if (switchingId) return;
    if (busyAgy > 0) return;
    setSwitchingId(id);
    setSwitchError(null);
    const from = snap?.active;
    window.cyberslots
      .agyAccountSwitch(id)
      .then((res) => {
        void window.cyberslots.agyAccountsList().then(setSnap);
        // 对话自动跟随：keyring 实时读取，各 antigravity 会话（含赛马角色）
        // 下一回合自然用新账号。给普通会话（非赛马角色，角色会话带 raceId）
        // 插一条跟随公告；赛马靠编排器下一回合自然换号，不插播（同自动切号惯例）。
        for (const m of useChatStore.getState().sessions) {
          if (m.engine === 'antigravity' && !m.raceId && m.status !== 'closed') {
            announceSystem(m.id, t('agyFollowAnnounce', { from: from ?? '?', to: res.email }));
          }
        }
      })
      .catch((e) => setSwitchError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSwitchingId(null));
  };

  /** 进行中的 Antigravity 任务数（主动切号门禁）：
   *  ① antigravity 会话 running/starting/awaiting 或正在发送 —— 覆盖普通
   *     会话与赛马角色会话（角色会话也进 sessions 表，运行态同源）；
   *  ② 兜底扫赛马组：进行中赛马含 antigravity 角色且角色会话尚未收录进
   *     会话表（race.role 事件竞态窗口）时保守视为忙。 */
  const busyAgy = useMemo(() => {
    let n = 0;
    for (const m of sessions) {
      if (m.engine !== 'antigravity') continue;
      if (m.status === 'running' || m.status === 'starting' || m.status === 'awaiting' || sending[m.id]) n++;
    }
    for (const g of Object.values(races)) {
      if (!isRaceActive(g)) continue;
      if (!Object.values(g.roles).some((r) => r?.engine === 'antigravity')) continue;
      for (const sid of Object.values(g.sessions)) {
        if (sid && !sessions.some((m) => m.id === sid)) {
          n++;
          break;
        }
      }
    }
    return n;
  }, [sessions, sending, races]);

  return (
    <div className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3.5">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-[13px] font-semibold">{t('agyAccountsTitle')}</span>
        <span className="min-w-0 flex-1" />
        {snap && (
          <span className="rounded-md bg-bg-panel px-1.5 text-[10px] text-ink-faint">{t('agyImportedCount', { n: snap.accounts.length })}</span>
        )}
        <button
          title={t('quotaRefresh')}
          onClick={() => loadQuota(true)}
          className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
        >
          {quotaBusy ? <BrandSpinner size={13} /> : <RefreshCw size={13} />}
        </button>
      </div>
      <div className="mb-3 text-[11px] leading-5 text-ink-faint">
        {t('agyPoolHint')}
      </div>
      {/* agy 默认模型—未在 composer 显式选模型时生效（已隐藏的模型不列，当前默认除外） */}
      <div className="mb-3 flex items-center gap-2">
        <span className="shrink-0 text-[12px] text-ink-soft">{t('cfgActiveModel')}</span>
        <select
          value={agyDefaultModel}
          onChange={(e) => void saveSettings({ antigravityDefaultModel: e.target.value })}
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg-input px-2 py-1.5 font-mono text-[12px] text-ink-soft outline-none transition focus:border-accent"
        >
          <option value="">{t('agyFollowDefault', { model: ANTIGRAVITY_LABELS['claude-sonnet-4-6']! })}</option>
          {Object.entries(ANTIGRAVITY_LABELS)
            .filter(([slug]) => !agyHidden.has(slug) || slug === agyDefaultModel)
            .map(([slug, label]) => (
              <option key={slug} value={slug}>
                {label}
              </option>
            ))}
        </select>
      </div>
      {/* 隐藏模型—只影响本程序内的模型选择器/赛马配置，不限制 agy 实际可用模型 */}
      <div className="mb-3">
        <div className="mb-1.5 text-[11px] leading-5 text-ink-faint">
          {t('agyHideHint')}
        </div>
        <div className="overflow-hidden rounded-lg border border-line bg-bg-input">
          {Object.entries(ANTIGRAVITY_LABELS).map(([slug, label], i) => {
            const off = agyHidden.has(slug);
            const isDefault = (agyDefaultModel || 'claude-sonnet-4-6') === slug;
            return (
              <div
                key={slug}
                className={`flex items-center gap-2.5 px-3 py-1.5 ${i > 0 ? 'border-t border-line' : ''} ${off ? 'opacity-45' : ''}`}
                title={slug}
              >
                <span className="min-w-0 flex-1 truncate text-[12px]">{label}</span>
                {isDefault && <span className="shrink-0 rounded bg-accent/15 px-1.5 text-[10px] text-accent">{t('defaultBadge')}</span>}
                <button
                  onClick={() => toggleAgyHidden(slug)}
                  title={off ? t('showWord') : t('hideWord')}
                  className="shrink-0 rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
                >
                  {off ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {/* 额度不足自动切号——开启后回合结束主动检测，低于阈值就换有 buffer 的账号；真耗尽报错作兜底 */}
      <div className="mb-3 rounded-lg border border-line bg-bg-input px-3 py-2.5">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={agyAutoSwitch}
            onChange={(e) => void saveSettings({ antigravityAutoSwitch: e.target.checked })}
          />
          <span className="flex-1 text-[12px] font-medium">{t('agyAutoSwitchLabel')}</span>
        </label>
        <div className="mt-1 text-[11px] leading-5 text-ink-faint">
          {t('agyAutoSwitchHint')}
        </div>
        {agyAutoSwitch && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {/* 5h 窗桶小消耗快但自愈快，阈值宜高；7d 窗桶大恢复慢，阈值宜低（否则全池同时不合格） */}
            {(
              [
                [t('agyWin5h'), agyThreshold5h, 'antigravityQuotaThreshold5h'],
                [t('agyWin7d'), agyThreshold7d, 'antigravityQuotaThreshold7d'],
              ] as const
            ).map(([label, value, key]) => (
              <label key={key} className="flex items-center gap-2">
                <span className="shrink-0 text-[12px] text-ink-soft">{label}{t('agyThresholdSuffix')}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={value}
                  onChange={(e) => {
                    const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
                    void saveSettings({ [key]: v });
                  }}
                  className="w-16 rounded-md border border-line bg-bg px-2 py-1 text-right font-mono text-[12px] outline-none transition focus:border-accent"
                />
                <span className="shrink-0 text-[11px] text-ink-faint">%</span>
              </label>
            ))}
            <span className="basis-full text-[11px] leading-4 text-ink-faint">
              {t('agyThresholdHint')}
            </span>
          </div>
        )}
      </div>
      {!snap ? (
        <div className="flex flex-col items-center gap-2 py-6 text-ui text-ink-faint">
          <BrandHero size={48} />
          {t('agyReadingPool')}
        </div>
      ) : (
        <div className="space-y-1.5">
          {snap.accounts.length === 0 && (
            <div className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[12px] text-ink-faint">
              {t('agyNoneImported')}
            </div>
          )}
          {/* 进行中任务门禁提示：存在在跑的 antigravity 任务（含赛马角色）时禁止主动切号 */}
          {busyAgy > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] leading-5 text-warn">
              {t('agyBusySwitch', { n: busyAgy })}
            </div>
          )}
          {/* 卡片网格：当前活动账号置顶，其余保持导入顺序（仅展示层排序）。 */}
          <div className="grid grid-cols-2 gap-2">
            {[...snap.accounts]
              .sort((x, y) => (y.email === snap.active ? 1 : 0) - (x.email === snap.active ? 1 : 0))
              .map((a) => {
                const q = quota[a.id];
                const isActive = snap.active && a.email === snap.active;
                const switching = switchingId === a.id;
                const coolingMs = snap.blocked?.[a.email];
                const cooling = coolingMs !== undefined && coolingMs > Date.now();
                return (
                  <div
                    key={a.id}
                    className={`flex flex-col rounded-xl border p-2.5 transition-colors duration-300 ${isActive ? 'border-accent/50 bg-accent/5' : 'border-line bg-bg-input'}`}
                  >
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={a.email}>
                        {a.email}
                      </span>
                      {cooling && (
                        <span className="shrink-0 rounded bg-warn/15 px-1.5 text-[10px] text-warn">
                          {t('agyCooling')} · {fmtAgyReset(Math.max(1, Math.ceil((coolingMs - Date.now()) / 1000)))}
                        </span>
                      )}
                      {isActive ? (
                        <span className="shrink-0 rounded bg-accent/15 px-1.5 text-[10px] text-accent">{t('agyCurrent')}</span>
                      ) : (
                        <button
                          title={t('agySwitchToTitle')}
                          onClick={() => switchTo(a.id)}
                          disabled={!!switchingId || busyAgy > 0}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-ink-soft transition hover:bg-bg-hover disabled:opacity-50"
                        >
                          {switching && <BrandSpinner size={10} />}
                          {t('agySwitchBtn')}
                        </button>
                      )}
                      <button
                        title={t('agyRemoveTitle')}
                        onClick={() => remove(a.id)}
                        className="shrink-0 rounded-md p-0.5 text-ink-faint transition hover:bg-bg-hover hover:text-err"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <div className="flex-1 rounded-lg bg-bg-panel/60 px-2.5 py-2">
                      {q && q.ok && q.groups.length > 0 ? (
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                          {q.groups.map((g) => {
                            const remain = Math.max(0, Math.round(100 - g.utilization));
                            const color = remain > 30 ? 'text-ok' : remain > 10 ? 'text-warn' : 'text-err';
                            const bar = remain > 30 ? 'bg-ok' : remain > 10 ? 'bg-warn' : 'bg-err';
                            return (
                              <div key={g.group} className="min-w-0">
                                <div className="flex items-baseline justify-between gap-1">
                                  <span className="min-w-0 truncate text-[11px] font-medium text-ink-soft" title={g.models?.join(', ')}>
                                    {agyWindowLabel(t, g.group)}
                                  </span>
                                  <span className={`shrink-0 font-mono text-[11px] ${color}`}>{remain}%</span>
                                </div>
                                <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-bg-active/60">
                                  <span className={`absolute inset-y-0 left-0 rounded-full ${bar}`} style={{ width: `${remain}%` }} />
                                </div>
                                {g.resetsInSeconds != null && (
                                  <div className="mt-0.5 truncate text-[10px] text-ink-faint">{fmtAgyReset(g.resetsInSeconds)}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : q && !q.ok ? (
                        <div className="text-[11px] text-ink-faint">{t('agyQuotaFailedDetail', { err: q.error?.slice(0, 60) ?? '' })}</div>
                      ) : q ? (
                        // ok 但 0 组：响应成功却解析不出分组（字段漂移，主进程已留档）——明示而非空白。
                        <div className="text-[11px] text-ink-faint">{t('agyNoQuotaData')}</div>
                      ) : quotaBusy ? (
                        <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                          <BrandSpinner size={11} /> {t('agyQuotaLoading')}
                        </div>
                      ) : quotaFailed ? (
                        <div className="text-[11px] text-ink-faint">{t('agyQuotaFailedRetry')}</div>
                      ) : (
                        <div className="text-[11px] text-ink-faint">{t('agyQuotaNotLoaded')}</div>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
          {switchError && <div className="text-[11.5px] text-err">{t('agySwitchFailed', { err: switchError })}</div>}
          {snap.error && <div className="text-[11.5px] text-warn">{snap.error}</div>}

          {!importOpen ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={openImport}
                className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] text-ink-soft transition hover:bg-bg-hover"
              >
                <Plus size={13} /> {t('agyImportBtn')}
              </button>
              <button
                title={t('agyImportFileTitle')}
                onClick={importFromFile}
                disabled={fileBusy}
                className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] text-ink-soft transition hover:bg-bg-hover disabled:opacity-50"
              >
                {fileBusy ? <BrandSpinner size={13} /> : <Upload size={13} />} {t('agyImportFileBtn')}
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-line px-3 py-2.5">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[11.5px] font-medium">{t('agyPickAccounts')}</span>
                <span className="flex-1" />
                <button
                  onClick={() => setImportOpen(false)}
                  className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink"
                >
                  <X size={13} />
                </button>
              </div>
              {!candidates ? (
                <div className="flex flex-col items-center gap-2 py-5 text-[11.5px] text-ink-faint">
                  <BrandHero size={48} />
                  {t('agyScanning')}
                </div>
              ) : candError ? (
                <div className="py-2 text-[11.5px] text-err">{candError}</div>
              ) : candidates.length === 0 ? (
                <div className="py-2 text-[11.5px] text-ink-faint">{t('agyNoCandidates')}</div>
              ) : candidates.every((c) => c.imported) ? (
                // 已导入的不再列出 — 全部导过时明示而非空白；刷新凭据走文件导入。
                <div className="py-2 text-[11.5px] text-ink-faint">{t('agyAllImported')}</div>
              ) : (
                <>
                  <div className="max-h-56 space-y-0.5 overflow-y-auto">
                    {candidates
                      .filter((c) => !c.imported)
                      .map((c) => {
                        const disabled = !c.hasToken;
                        return (
                          <label
                            key={c.id}
                            className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-[12px] ${disabled ? 'opacity-45' : 'cursor-pointer hover:bg-bg-hover'}`}
                          >
                            <input
                              type="checkbox"
                              disabled={disabled}
                              checked={picked.has(c.id)}
                              onChange={() => togglePick(c.id)}
                            />
                            <span className="min-w-0 flex-1 truncate">{c.email}</span>
                            {disabled && <span className="shrink-0 text-[10px] text-warn">{t('agyNoToken')}</span>}
                          </label>
                        );
                      })}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={doImport}
                      disabled={picked.size === 0 || busy}
                      className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy && <BrandSpinner size={12} />}
                      {picked.size > 0 ? t('agyImportN', { n: picked.size }) : t('agyImportWord')}
                    </button>
                    <span className="text-[10.5px] text-ink-faint">{t('agyImportedNote')}</span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const AUDIT_KIND_KEYS: Record<CompatAuditKind, MsgKey> = {
  'unknown-event': 'auditUnknownEvent',
  'rejected-method': 'auditRejectedMethod',
  'parse-error': 'auditParseError',
};

/** 引擎兼容性诊断 — 各 adapter 降级点的审计计数（未知事件/被拒方法/
 *  解析失败）。用户侧降级静默，这里是维护者的可见入口：引擎升级后
 *  协议漂移（砍方法/加事件/改格式）第一时间在此显形，原始报文样本
 *  可从 JSONL 日志导出排查。传 engine 时只看该引擎（引擎子页内嵌）。 */
function CompatAuditCard({ engine }: { engine?: EngineId }): JSX.Element {
  const t = useT();
  const audit = useChatStore((s) => s.compatAudit);
  const engines = (Object.entries(audit?.engines ?? {}) as Array<[EngineId, CompatAuditSnapshot['engines'][EngineId]]>).filter(
    ([id]) => !engine || id === engine,
  );
  const hasIssues = engines.some(([, list]) => (list?.length ?? 0) > 0);
  return (
    <div className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3.5">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-[13px] font-semibold">{t('auditTitle')}</span>
        <span className="min-w-0 flex-1" />
        <span className={`rounded-md px-1.5 text-[10px] ${hasIssues ? 'bg-warn/10 text-warn' : 'bg-ok/10 text-ok'}`}>
          {hasIssues ? t('auditHasIssues') : t('auditNoIssues')}
        </span>
      </div>
      <div className="mb-2 text-[11px] leading-5 text-ink-faint">
        {t('auditHint')}
      </div>
      {hasIssues && (
        <div className="mb-2 space-y-2">
          {engines.map(([id, list]) =>
            !list?.length ? null : (
              <div key={id}>
                {/* 引擎子页内嵌时页面语境已明确 — 不重复引擎名小标题 */}
                {!engine && <div className="mb-0.5 text-[11px] font-medium text-ink-soft">{ENGINE_LABELS[id] ?? id}</div>}
                <div className="space-y-0.5">
                  {list.map((e) => (
                    <div key={`${e.kind}:${e.detail}`} className="flex items-center gap-2 text-[11.5px]">
                      <span className="shrink-0 rounded bg-warn/10 px-1 text-[10px] text-warn">{t(AUDIT_KIND_KEYS[e.kind])}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-ink-soft" title={e.detail}>{e.detail}</span>
                      <span className="shrink-0 text-ink-faint">×{e.count}</span>
                      <span className="shrink-0 text-[10.5px] text-ink-faint">{new Date(e.lastTs).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            ),
          )}
        </div>
      )}
      {/* 日志文件只在首条记账后才存在 — 无条目时不给定位按钮。 */}
      {audit && hasIssues && (
        <button
          onClick={() => void window.cyberslots.openIn('explorer', audit.logFile)}
          className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-soft transition hover:bg-bg-hover"
          title={audit.logFile}
        >
          {t('auditOpenLog')}
        </button>
      )}
    </div>
  );
}

/** 程序日志卡 — 本程序自身运行日志（main-/renderer-*.jsonl）的落盘位置与
 *  入口。区别于上面的引擎兼容性审计（那是协议降级记账），这里是会话/
 *  引擎进程/赛马/定时任务等程序行为的排障现场。 */
function LogsCard(): JSX.Element {
  const t = useT();
  const [dir, setDir] = useState('');
  useEffect(() => {
    void window.cyberslots.logsDir().then(setDir).catch(() => undefined);
  }, []);
  return (
    <div className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3.5">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-[13px] font-semibold">{t('logsTitle')}</span>
      </div>
      <div className="mb-2 text-[11px] leading-5 text-ink-faint">{t('logsHint')}</div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void window.cyberslots.logsOpenDir()}
          className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-soft transition hover:bg-bg-hover"
        >
          {t('logsOpenDir')}
        </button>
        {dir && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={dir}>
            {dir}
          </span>
        )}
      </div>
    </div>
  );
}

/** 模型展示管理的归一化行 — opencode/omp 目录各自映射后交给 ModelVisibility 渲染。 */
interface VisibilityRow {
  slug: string;
  providerID: string;
  providerName: string;
  label: string;
  contextWindow?: number;
}

function OpencodeModelVisibility({ catalog }: { catalog: OpencodeCatalog }): JSX.Element {
  const t = useT();
  const hiddenList = useChatStore((s) => s.settings?.opencodeHiddenModels);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const rows = useMemo(
    () =>
      catalog.models.map((m) => ({
        slug: m.slug,
        providerID: m.providerID,
        providerName: m.providerName,
        label: m.displayName ?? m.modelID,
        contextWindow: m.contextWindow,
      })),
    [catalog],
  );
  return (
    <ModelVisibility
      rows={rows}
      hiddenList={hiddenList}
      hint={t('ocHideHint')}
      onPersist={(next) => void saveSettings({ opencodeHiddenModels: next })}
    />
  );
}

/** omp 模型展示管理 — 与 opencode 同款 UI，黑名单存 ompHiddenModels；
 *  只影响本程序内的选择器/赛马配置，不限制 omp 实际可用模型。 */
function OmpModelVisibility({ catalog }: { catalog: OmpCatalog }): JSX.Element {
  const t = useT();
  const hiddenList = useChatStore((s) => s.settings?.ompHiddenModels);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const rows = useMemo(
    () =>
      catalog.models.map((m) => ({
        slug: m.slug,
        providerID: m.provider,
        providerName: m.providerName ?? m.provider,
        label: m.displayName ?? m.modelID,
        contextWindow: m.contextWindow,
      })),
    [catalog],
  );
  return (
    <ModelVisibility
      rows={rows}
      hiddenList={hiddenList}
      hint={t('ompHideHint')}
      onPersist={(next) => void saveSettings({ ompHiddenModels: next })}
    />
  );
}

/** 模型展示管理 — provider 可折叠分组，每行一个眼睛开关（隐藏行半透明
 *  保留在列表里可随时恢复），搭配 provider 级批量隐藏/显示与搜索过滤。
 *  黑名单经 onPersist 即时写回 settings（同本页路由开关 — 不依赖底部保存按钮）。 */
function ModelVisibility({
  rows,
  hiddenList,
  hint,
  onPersist,
}: {
  rows: VisibilityRow[];
  hiddenList: string[] | undefined;
  hint: string;
  onPersist: (next: string[]) => void;
}): JSX.Element {
  const t = useT();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const hidden = useMemo(() => new Set(hiddenList ?? []), [hiddenList]);
  const q = query.trim().toLowerCase();
  const matched = useMemo(
    () =>
      q
        ? rows.filter(
          (m) =>
            m.slug.toLowerCase().includes(q) ||
            m.label.toLowerCase().includes(q) ||
            m.providerName.toLowerCase().includes(q),
        )
        : rows,
    [rows, q],
  );
  /** provider 分组（保持目录顺序）。 */
  const groups = useMemo(() => {
    const out = new Map<string, { name: string; models: VisibilityRow[] }>();
    for (const m of matched) {
      const g = out.get(m.providerID) ?? { name: m.providerName, models: [] };
      g.models.push(m);
      out.set(m.providerID, g);
    }
    return out;
  }, [matched]);

  const persist = (next: Set<string>): void => {
    // 只保留当前目录仍存在的 slug — provider 断开后的残留项顺手清理。
    const alive = new Set(rows.map((m) => m.slug));
    onPersist([...next].filter((s) => alive.has(s)));
  };
  const toggleOne = (slug: string): void => {
    const next = new Set(hidden);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    persist(next);
  };
  const setProvider = (models: VisibilityRow[], hide: boolean): void => {
    const next = new Set(hidden);
    for (const m of models) {
      if (hide) next.add(m.slug);
      else next.delete(m.slug);
    }
    persist(next);
  };
  const toggleExpand = (providerID: string): void => {
    const next = new Set(expanded);
    if (next.has(providerID)) next.delete(providerID);
    else next.add(providerID);
    setExpanded(next);
  };

  const visibleTotal = rows.filter((m) => !hidden.has(m.slug)).length;

  return (
    <div className="pt-2">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="text-ui font-semibold text-ink">{t('mvTitle')}</span>
        <span className="rounded-md bg-bg-panel px-2 py-0.5 text-[11px] text-ink-faint">
          {t('mvShown', { a: visibleTotal, b: rows.length })}
        </span>
        <span className="flex-1" />
        <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-input px-2.5 py-1.5">
          <Search size={13} className="shrink-0 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('ocSearchModel')}
            className="w-44 bg-transparent text-ui outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>
      <div className="mb-2 text-[12px] leading-5 text-ink-faint">{hint}</div>
      <div className="overflow-hidden rounded-lg border border-line bg-bg-input">
        {[...groups.entries()].map(([providerID, g], i) => {
          const open = !!q || expanded.has(providerID);
          const shown = g.models.filter((m) => !hidden.has(m.slug)).length;
          return (
            <div key={providerID} className={i > 0 ? 'border-t border-line' : ''}>
              {/* 组头：折叠开关 + 可见计数 + 批量操作 */}
              <div
                className="group flex cursor-pointer select-none items-center gap-2 px-3 py-2.5 transition hover:bg-bg-hover"
                onClick={() => toggleExpand(providerID)}
              >
                <ChevronRight size={14} className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`} />
                <span className="min-w-0 truncate text-ui font-medium">{g.name}</span>
                <span className={`text-[11.5px] ${shown === 0 ? 'text-warn' : 'text-ink-faint'}`}>
                  {shown}/{g.models.length}
                </span>
                <span className="flex-1" />
                <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setProvider(g.models, true);
                    }}
                    className="rounded-md px-2 py-1 text-[12px] text-ink-soft transition hover:bg-bg-active hover:text-ink"
                  >
                    {t('mvHideAll')}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setProvider(g.models, false);
                    }}
                    className="rounded-md px-2 py-1 text-[12px] text-ink-soft transition hover:bg-bg-active hover:text-ink"
                  >
                    {t('mvShowAll')}
                  </button>
                </div>
              </div>
              {open && (
                <div className="pb-1.5">
                  {g.models.map((m) => {
                    const off = hidden.has(m.slug);
                    return (
                      <div
                        key={m.slug}
                        className={`group flex cursor-pointer items-center gap-2.5 py-2 pl-9 pr-3 transition hover:bg-bg-hover ${off ? 'opacity-45' : ''}`}
                        onClick={() => toggleOne(m.slug)}
                        title={m.slug}
                      >
                        <span className="min-w-0 flex-1 truncate text-ui">{m.label}</span>
                        {m.contextWindow ? (
                          <span className="shrink-0 text-[11px] text-ink-faint">{fmtCtxK(m.contextWindow)}</span>
                        ) : null}
                        {/* 眼睛常驻可见 — 隐藏/显示的可操作性一目了然，hover 提亮 */}
                        <span
                          className={`shrink-0 rounded p-1 transition ${off ? 'text-ink-soft' : 'text-ink-faint/50 group-hover:text-ink-soft'}`}
                          title={off ? t('mvShowModel') : t('mvHideModel')}
                        >
                          {off ? <EyeOff size={15} /> : <Eye size={15} />}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {!groups.size && <div className="px-3 py-2.5 text-[12px] text-ink-faint">{t('ocNoMatch')}</div>}
      </div>
    </div>
  );
}

function fmtCtxK(n: number): string {
  if (n >= 1_000_000) return `${n % 1_000_000 === 0 ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// ------------------------------------------------------------ notifications

// ------------------------------------------------------------------ race

/** 赛马默认配置：各角色默认引擎/模型/思考档 + 第三选手开关。
 *  发起面板打开时以此预填；模型/档位选「跟随默认」（空值）时，
 *  发起面板会自动取引擎默认模型 + 最大思考档。 */
function RacePane({ settings, commit }: PaneProps): JSX.Element {
  const t = useT();
  const { modelOptions, effortOptions } = useRoleCatalogs(true);
  const raceAvailability = useChatStore((s) => s.engineAvailability);
  const engineOrder = useEngineOrder();
  const race = settings.race ?? { enableRacerC: false, roles: {} };

  const patchRole = (role: string, patch: Partial<RaceRoleDefaultSetting>): void => {
    const cur: RaceRoleDefaultSetting = race.roles[role] ?? { engine: 'codex', modelId: '', effort: '' };
    const next = { ...cur, ...patch };
    commit({ race: { ...race, roles: { ...race.roles, [role]: next } } });
  };

  return (
    <div className="space-y-8">
      <Section title={t('raceLineup')}>
        <label className="flex cursor-pointer select-none items-center justify-between">
          <div>
            <div className="text-body">{t('raceEnableCDefault')}</div>
            <div className="mt-0.5 text-[12px] text-ink-faint">{t('raceEnableCHint')}</div>
          </div>
          <input
            type="checkbox"
            checked={race.enableRacerC}
            onChange={(e) => commit({ race: { ...race, enableRacerC: e.target.checked } })}
          />
        </label>
      </Section>

      <Section title={t('raceRoleDefaults')}>
        <div className="mb-1.5 grid grid-cols-[88px_1fr_1.4fr_110px] gap-2 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
          <span>{t('raceColRole')}</span>
          <span>{t('engine')}</span>
          <span>{t('model')}</span>
          <span>{t('effort')}</span>
        </div>
        {RACE_ROLES.map((role) => {
          const d: RaceRoleDefaultSetting = race.roles[role] ?? { engine: 'codex', modelId: '', effort: '' };
          const mOpts = modelOptions(d.engine);
          const effOpts = effortOptions(d.engine, d.modelId);
          return (
            <div key={role} className="mb-1.5 grid grid-cols-[88px_1fr_1.4fr_110px] items-center gap-2">
              <span className="text-[12.5px] font-medium text-ink">{t(raceRoleKey(role))}</span>
              <select
                value={d.engine}
                onChange={(e) => patchRole(role, { engine: e.target.value as EngineId, modelId: '', effort: '' })}
                className="rounded-lg border border-line bg-bg-input px-2 py-1.5 text-[12px] text-ink-soft outline-none transition focus:border-accent"
              >
                {engineOrder.map((eng) => (
                  <option key={eng} value={eng} disabled={raceAvailability ? !raceAvailability[eng] : false}>
                    {ENGINE_LABELS[eng]}
                    {raceAvailability && !raceAvailability[eng] ? t('raceNotInstalled') : ''}
                  </option>
                ))}
              </select>
              <select
                value={d.modelId}
                onChange={(e) => patchRole(role, { modelId: e.target.value, effort: '' })}
                className="min-w-0 rounded-lg border border-line bg-bg-input px-2 py-1.5 font-mono text-[12px] text-ink-soft outline-none transition focus:border-accent"
              >
                <option value="">{t('raceFollowEngineDefault')}</option>
                {d.modelId && !mOpts.some((o) => o.value === d.modelId) && <option value={d.modelId}>{d.modelId}</option>}
                {mOpts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select
                value={d.effort ?? ''}
                onChange={(e) => patchRole(role, { effort: e.target.value })}
                disabled={effOpts.length === 0}
                className="rounded-lg border border-line bg-bg-input px-2 py-1.5 text-[12px] text-ink-soft outline-none transition focus:border-accent disabled:opacity-60"
              >
                <option value="">{t('raceEffortDefaultMax')}</option>
                {effOpts.map((ef) => (
                  <option key={ef} value={ef}>
                    {effortLabel(ef)}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
        <p className="mt-2 text-[11.5px] leading-5 text-ink-faint">
          {t('racePaneHint')}
        </p>
      </Section>
    </div>
  );
}

function NotificationsPane({ settings, commit }: PaneProps): JSX.Element {
  const t = useT();
  const patch = (p: Partial<NotificationSettings>): void => {
    commit({ notifications: { ...settings.notifications, ...p } });
  };

  const rows: Array<{ key: keyof NotificationSettings; label: MsgKey; hint: MsgKey }> = [
    { key: 'taskComplete', label: 'notifyTaskComplete', hint: 'notifyTaskCompleteHint' },
    { key: 'question', label: 'notifyQuestion', hint: 'notifyQuestionHint' },
    { key: 'error', label: 'notifyError', hint: 'notifyErrorHint' },
  ];

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center justify-between rounded-xl border border-line px-4 py-3">
          <div>
            <div className="text-ui font-medium">{t(r.label)}</div>
            <div className="mt-0.5 text-[11.5px] text-ink-faint">{t(r.hint)}</div>
          </div>
          <Toggle checked={settings.notifications[r.key]} onChange={(v) => patch({ [r.key]: v })} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- about

function AboutPane(): JSX.Element {
  const t = useT();
  return (
    <div className="space-y-2 text-ui text-ink-soft">
      {/* 品牌展示位：完整拉霸仪式动效 */}
      <BrandHero size={72} />
      <div className="flex items-center gap-2 text-lg font-semibold text-ink">
        <BrandMark size={22} className="text-accent" />
        {t('appName')} · CyberSlots
      </div>
      <div>{t('aboutText')}</div>
      <div className="font-mono text-[11.5px] text-ink-faint">v0.1.0</div>
    </div>
  );
}

// -------------------------------------------------------------- primitives

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section>
      <div className="mb-2 text-[12px] font-semibold text-ink-soft">{title}</div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-2.5">
      <div className="mb-1 text-[11px] text-ink-faint">{label}</div>
      {children}
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
  small,
}: {
  value: string;
  options: Array<{ id: string; label: string }>;
  onChange: (id: string) => void;
  small?: boolean;
}): JSX.Element {
  // 选中项滑动高亮胶囊 — 与新建会话选引擎同款：测量选中按钮位置，
  // 用绝对定位的胶囊平移过渡代替逐按钮背景瞬移。
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pill, setPill] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const el = btnRefs.current[value];
    if (!el) return;
    setPill((prev) => {
      const next = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
      return prev && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height
        ? prev
        : next;
    });
  }, [value, options]);

  return (
    <div className={`relative inline-flex items-center gap-0.5 rounded-lg border border-line bg-bg-panel ${small ? 'p-0.5' : 'p-1'}`}>
      {pill && (
        <div
          className="pointer-events-none absolute rounded-md bg-bg shadow-sm transition-all duration-300 ease-out"
          style={{ left: pill.left, top: pill.top, width: pill.width, height: pill.height }}
        />
      )}
      {options.map((o) => (
        <button
          key={o.id}
          ref={(el) => { btnRefs.current[o.id] = el; }}
          onClick={() => onChange(o.id)}
          className={`relative rounded-md transition ${small ? 'px-2 py-0.5 text-[10.5px]' : 'px-3.5 py-1.5 text-ui'} ${value === o.id ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'
            }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }): JSX.Element {
  return (
    <button
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`h-5 w-9 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${checked ? 'bg-accent' : 'bg-bg-active'}`}
    >
      <span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  );
}
