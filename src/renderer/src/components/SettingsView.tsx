/**
 * SettingsView — full-page settings with a category rail (通用 / 模型 /
 * 赛马 / 通知 / 关于). 全页实时保存：无草稿/保存钮，每个控件改动
 * 直接按字段 patch 写回 settings。模型页是 CLI 配置的只读快照
 * （~/.kimi-code、~/.codex）加每引擎一个协议路由开关 — 本程序
 * 不提供任何配置文件修改功能。
 */

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bell, Box, ChevronRight, Eye, EyeOff, FileLock2, Info, Plus, RefreshCw, Search, Settings2, Swords, X } from 'lucide-react';

import type { AppSettings, CodexConfigSnapshot, ContextFallbackRule, EngineConfigsSnapshot, EngineId, KimiConfigSnapshot, NotificationSettings, OmpConfigSnapshot, OpencodeCatalog, OpencodeConfigSnapshot, OpencodeModelEntry, RaceRoleDefaultSetting, RouteSupport } from '@shared/types';
import { RACE_ROLES, RACE_ROLE_LABELS } from '@shared/race';
import { useChatStore } from '../store/chatStore';
import { useT, type MsgKey } from '../i18n';
import { ENGINE_LABELS } from './EngineIcon';
import { BrandHero, BrandMark } from './brand';
import { EFFORT_LABELS, RACE_ENGINES, useRoleCatalogs } from './race/modelCatalogs';

type Category = 'general' | 'models' | 'race' | 'notifications' | 'about';

const CATEGORIES: Array<{ id: Category; key: MsgKey; icon: React.ReactNode }> = [
  { id: 'general', key: 'settingsGeneral', icon: <Settings2 size={15} /> },
  { id: 'models', key: 'settingsModels', icon: <Box size={15} /> },
  { id: 'race', key: 'settingsRace', icon: <Swords size={15} /> },
  { id: 'notifications', key: 'settingsNotifications', icon: <Bell size={15} /> },
  { id: 'about', key: 'settingsAbout', icon: <Info size={15} /> },
];

export default function SettingsView(): JSX.Element | null {
  const t = useT();
  const open = useChatStore((s) => s.settingsOpen);
  const settings = useChatStore((s) => s.settings);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const [category, setCategory] = useState<Category>('general');

  useEffect(() => {
    if (open) setCategory('general');
  }, [open]);

  if (!open || !settings) return null;

  const close = (): void => useChatStore.setState({ settingsOpen: false });
  // 全页实时保存：单一数据源（store settings）+ 按字段 patch 写回，
  // 无草稿快照（旧快照整体回写会冲掉其他面板的即时改动）。
  const commit = (patch: Partial<AppSettings>): void => void saveSettings(patch);

  return (
    <div className="absolute inset-0 z-30 flex bg-bg-canvas">
      {/* 分类导航 — 与画布同色融合 */}
      <aside className="flex w-56 shrink-0 flex-col px-3 pb-4 pt-3">
        <button onClick={close} className="mb-3 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-ui text-ink-soft transition hover:bg-bg-hover hover:text-ink">
          <ArrowLeft size={15} /> {t('back')}
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            className={`mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-ui transition ${category === c.id ? 'bg-bg-active font-medium text-ink' : 'text-ink-soft hover:bg-bg-hover'
              }`}
          >
            {c.icon} {t(c.key)}
          </button>
        ))}
      </aside>

      {/* 内容区 — 与主界面同款左上大圆角浮层 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[20px] bg-bg shadow-sm">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-8 py-8">
            <h1 className="mb-6 text-xl font-semibold">{t(CATEGORIES.find((c) => c.id === category)!.key)}</h1>
            {category === 'general' && <GeneralPane settings={settings} commit={commit} />}
            {category === 'models' && <ModelsPane />}
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
      <Section title={t('themePalette')}>
        <Segmented
          value={settings.themePalette}
          options={[
            { id: 'notion', label: t('paletteNotion') },
            { id: 'solarized', label: t('paletteSolarized') },
            { id: 'everforest', label: t('paletteEverforest') },
          ]}
          onChange={(themePalette) => commit({ themePalette: themePalette as AppSettings['themePalette'] })}
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

// ----------------------------------------------------------------- models
// 只读展示 CLI 自己的配置（本程序永不写入）+ 每引擎的协议路由开关。

function ModelsPane(): JSX.Element {
  const t = useT();
  const settings = useChatStore((s) => s.settings);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const refreshEngineConfigs = useChatStore((s) => s.refreshEngineConfigs);
  const [snap, setSnap] = useState<EngineConfigsSnapshot | null>(null);

  // ↻ 一次点击同时刷新本页快照与全局 codex 目录/默认档（同一次读取，天然一致）。
  const reload = (): void => {
    void refreshEngineConfigs().then(setSnap);
  };
  useEffect(reload, []);

  // 路由开关即时保存（同通知开关），并提示仅对新开会话生效。
  const setRouting = (engine: 'kimi' | 'codex', on: boolean): void => {
    const routing = { ...(settings?.routing ?? { kimi: false, codex: false }), [engine]: on };
    void saveSettings({ routing });
  };

  const routing = settings?.routing ?? { kimi: false, codex: false };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 rounded-xl border border-line bg-bg-panel/50 px-4 py-3">
        <FileLock2 size={15} className="mt-0.5 shrink-0 text-ink-faint" />
        <p className="text-[12px] leading-5 text-ink-faint">{t('modelsReadonlyHint')}</p>
        <button title={t('cfgReload')} onClick={reload} className="shrink-0 rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
          <RefreshCw size={13} />
        </button>
      </div>

      {!snap ? (
        <div className="flex flex-col items-center gap-2 py-8 text-ui text-ink-faint">
          {/* 面板内容区级等待按规范用 BrandHero（原来只有一个纯文字…） */}
          <BrandHero size={48} />
          读取引擎配置…
        </div>
      ) : (
        <>
          <CodexConfigCard
            snap={snap.codex}
            support={snap.routeSupport.codex}
            routing={routing.codex}
            onToggle={(on) => setRouting('codex', on)}
          />
          <KimiConfigCard
            snap={snap.kimi}
            support={snap.routeSupport.kimi}
            routing={routing.kimi}
            onToggle={(on) => setRouting('kimi', on)}
          />
          <OpencodeConfigCard snap={snap.opencode} />
          <OmpConfigCard snap={snap.omp} />
        </>
      )}
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
          <ReadonlyRow label={t('cfgActiveProvider')} value={snap.activeProvider ?? 'openai（内置）'} />
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
  const catalog = useChatStore((s) => s.opencodeCatalog);
  const loadCatalog = useChatStore((s) => s.loadOpencodeCatalog);
  return (
    <div className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3.5">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-[13px] font-semibold">opencode</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={snap.configPath}>
          {snap.configPath ?? ''}
        </span>
        <span className={`rounded-md px-1.5 text-[10px] ${snap.installed ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
          {snap.installed ? `已安装 ${snap.version ?? ''}` : '未安装'}
        </span>
      </div>
      <div className="mb-3 text-[11px] leading-5 text-ink-faint">
        新增 provider / 登录请在 opencode CLI 中操作（终端运行 <span className="font-mono">opencode auth login</span>），
        本程序不管理凭据；zen 免费模型无需登录开箱即用。
      </div>
      {!snap.installed ? (
        <div className="text-ui text-ink-faint">未找到 opencode CLI — 运行 npm i -g opencode-ai 安装后刷新。</div>
      ) : (
        <div className="space-y-1.5 text-[12px]">
          {snap.cliPath && <ReadonlyRow label="CLI" value={snap.cliPath} />}
          <ReadonlyRow label="opencode.json" value={snap.configExists ? '存在' : '未创建（可选）'} />
          {catalog ? (
            catalog.error ? (
              <div className="text-[11.5px] text-err">provider 列表加载失败：{catalog.error}</div>
            ) : (
              <OpencodeModelVisibility catalog={catalog} />
            )
          ) : (
            <button
              onClick={() => void loadCatalog()}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-soft transition hover:bg-bg-hover"
            >
              加载模型列表，管理展示哪些模型（将启动 opencode server）
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
  const catalog = useChatStore((s) => s.ompCatalog);
  const loadCatalog = useChatStore((s) => s.loadOmpCatalog);
  const versionDrift = snap.installed && snap.version && snap.version !== OMP_PINNED_VERSION;
  return (
    <div className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3.5">
      <div className="mb-1 flex items-center gap-3">
        <span className="text-[13px] font-semibold">Oh My Pi</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={snap.configPath}>
          {snap.configPath ?? ''}
        </span>
        <span className={`rounded-md px-1.5 text-[10px] ${snap.installed ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}`}>
          {snap.installed ? `已安装 ${snap.version ?? ''}` : '未安装'}
        </span>
      </div>
      <div className="mb-3 text-[11px] leading-5 text-ink-faint">
        登录/provider 配置请在终端运行 <span className="font-mono">omp</span> 完成（支持 Kimi/MiniMax/GLM/Copilot 等订阅），
        本程序只读不写 ~/.omp。注意：omp 对无界面子代理（task）强制自动批准，主会话审批不约束它们；
        正文里的 <span className="font-mono">ultrathink / orchestrate / workflowz</span> 会触发特殊行为（输入框会提示）。
      </div>
      {versionDrift && (
        <div className="mb-2 rounded-md bg-warn/10 px-2.5 py-1 text-[11px] text-warn">
          当前版本 {snap.version} 与实测基线 {OMP_PINNED_VERSION} 不一致 — omp 迭代快，协议行为可能漂移，异常时优先回退基线版本。
        </div>
      )}
      {!snap.installed ? (
        <div className="text-ui text-ink-faint">
          未找到 omp CLI — PowerShell 运行 <span className="font-mono">irm https://omp.sh/install.ps1 | iex</span> 安装后刷新。
        </div>
      ) : (
        <div className="space-y-1.5 text-[12px]">
          {snap.cliPath && <ReadonlyRow label="CLI" value={snap.cliPath} />}
          <ReadonlyRow label="~/.omp/agent" value={snap.configExists ? '存在' : '未初始化（首次运行 omp 后生成）'} />
          {catalog ? (
            catalog.error ? (
              <div className="text-[11.5px] text-err">模型目录加载失败：{catalog.error}</div>
            ) : catalog.models.length === 0 ? (
              <div className="text-[11.5px] text-ink-faint">目录为空 — 在终端运行 omp 完成登录/配 key 后重新加载。</div>
            ) : (
              <div className="flex items-center gap-2 text-[11.5px] text-ink-faint">
                <span>模型目录：{catalog.models.length} 个（{new Set(catalog.models.map((m) => m.provider)).size} 个 provider）</span>
                <button
                  onClick={() => void loadCatalog(true)}
                  className="rounded-md border border-line px-1.5 py-0.5 text-[10.5px] text-ink-soft transition hover:bg-bg-hover"
                >
                  重拉
                </button>
              </div>
            )
          ) : (
            <button
              onClick={() => void loadCatalog()}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-soft transition hover:bg-bg-hover"
            >
              加载模型目录（omp models --json）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 模型展示管理 — provider 可折叠分组，每行一个眼睛开关（隐藏行半透明
 *  保留在列表里可随时恢复），搭配 provider 级批量隐藏/显示与搜索过滤。
 *  黑名单即时写回 settings（同本页路由开关 — 不依赖底部保存按钮）。 */
function OpencodeModelVisibility({ catalog }: { catalog: OpencodeCatalog }): JSX.Element {
  const settings = useChatStore((s) => s.settings);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const hidden = useMemo(() => new Set(settings?.opencodeHiddenModels ?? []), [settings]);
  const q = query.trim().toLowerCase();
  const matched = useMemo(
    () =>
      q
        ? catalog.models.filter(
          (m) =>
            m.slug.toLowerCase().includes(q) ||
            (m.displayName ?? '').toLowerCase().includes(q) ||
            m.providerName.toLowerCase().includes(q),
        )
        : catalog.models,
    [catalog, q],
  );
  /** provider 分组（保持 catalog 顺序）。 */
  const groups = useMemo(() => {
    const out = new Map<string, { name: string; models: OpencodeModelEntry[] }>();
    for (const m of matched) {
      const g = out.get(m.providerID) ?? { name: m.providerName, models: [] };
      g.models.push(m);
      out.set(m.providerID, g);
    }
    return out;
  }, [matched]);

  const persist = (next: Set<string>): void => {
    // 只保留当前 catalog 仍存在的 slug — provider 断开后的残留项顺手清理。
    const alive = new Set(catalog.models.map((m) => m.slug));
    void saveSettings({ opencodeHiddenModels: [...next].filter((s) => alive.has(s)) });
  };
  const toggleOne = (slug: string): void => {
    const next = new Set(hidden);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    persist(next);
  };
  const setProvider = (models: OpencodeModelEntry[], hide: boolean): void => {
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

  const visibleTotal = catalog.models.filter((m) => !hidden.has(m.slug)).length;

  return (
    <div className="pt-2">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="text-ui font-semibold text-ink">模型展示</span>
        <span className="rounded-md bg-bg-panel px-2 py-0.5 text-[11px] text-ink-faint">
          显示 {visibleTotal} / {catalog.models.length}
        </span>
        <span className="flex-1" />
        <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-input px-2.5 py-1.5">
          <Search size={13} className="shrink-0 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型…"
            className="w-44 bg-transparent text-ui outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>
      <div className="mb-2 text-[12px] leading-5 text-ink-faint">
        隐藏不常用的模型 — 只影响本程序内的模型选择器，不修改 opencode 配置。
      </div>
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
                    全部隐藏
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setProvider(g.models, false);
                    }}
                    className="rounded-md px-2 py-1 text-[12px] text-ink-soft transition hover:bg-bg-active hover:text-ink"
                  >
                    全部显示
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
                        <span className="min-w-0 flex-1 truncate text-ui">{m.displayName ?? m.modelID}</span>
                        {m.contextWindow ? (
                          <span className="shrink-0 text-[11px] text-ink-faint">{fmtCtxK(m.contextWindow)}</span>
                        ) : null}
                        {/* 眼睛常驻可见 — 隐藏/显示的可操作性一目了然，hover 提亮 */}
                        <span
                          className={`shrink-0 rounded p-1 transition ${off ? 'text-ink-soft' : 'text-ink-faint/50 group-hover:text-ink-soft'}`}
                          title={off ? '显示该模型' : '隐藏该模型'}
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
        {!groups.size && <div className="px-3 py-2.5 text-[12px] text-ink-faint">无匹配模型</div>}
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
  const { modelOptions, effortOptions } = useRoleCatalogs(true);
  const raceAvailability = useChatStore((s) => s.engineAvailability);
  const race = settings.race ?? { enableRacerC: false, roles: {} };

  const patchRole = (role: string, patch: Partial<RaceRoleDefaultSetting>): void => {
    const cur: RaceRoleDefaultSetting = race.roles[role] ?? { engine: 'codex', modelId: '', effort: '' };
    const next = { ...cur, ...patch };
    commit({ race: { ...race, roles: { ...race.roles, [role]: next } } });
  };

  return (
    <div className="space-y-8">
      <Section title="参赛阵容">
        <label className="flex cursor-pointer select-none items-center justify-between">
          <div>
            <div className="text-body">默认启用第三选手（选手 C）</div>
            <div className="mt-0.5 text-[12px] text-ink-faint">选手 A/B 必选；C 可选，发起面板里也可临时开关</div>
          </div>
          <input
            type="checkbox"
            checked={race.enableRacerC}
            onChange={(e) => commit({ race: { ...race, enableRacerC: e.target.checked } })}
          />
        </label>
      </Section>

      <Section title="各角色默认（引擎 / 模型 / 思考深度）">
        <div className="mb-1.5 grid grid-cols-[88px_1fr_1.4fr_110px] gap-2 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
          <span>角色</span>
          <span>引擎</span>
          <span>模型</span>
          <span>思考深度</span>
        </div>
        {RACE_ROLES.map((role) => {
          const d: RaceRoleDefaultSetting = race.roles[role] ?? { engine: 'codex', modelId: '', effort: '' };
          const mOpts = modelOptions(d.engine);
          const effOpts = effortOptions(d.engine, d.modelId);
          return (
            <div key={role} className="mb-1.5 grid grid-cols-[88px_1fr_1.4fr_110px] items-center gap-2">
              <span className="text-[12.5px] font-medium text-ink">{RACE_ROLE_LABELS[role]}</span>
              <select
                value={d.engine}
                onChange={(e) => patchRole(role, { engine: e.target.value as EngineId, modelId: '', effort: '' })}
                className="rounded-lg border border-line bg-bg-input px-2 py-1.5 text-[12px] text-ink-soft outline-none transition focus:border-accent"
              >
                {RACE_ENGINES.map((eng) => (
                  <option key={eng} value={eng} disabled={raceAvailability ? !raceAvailability[eng] : false}>
                    {ENGINE_LABELS[eng]}
                    {raceAvailability && !raceAvailability[eng] ? '（未安装）' : ''}
                  </option>
                ))}
              </select>
              <select
                value={d.modelId}
                onChange={(e) => patchRole(role, { modelId: e.target.value, effort: '' })}
                className="min-w-0 rounded-lg border border-line bg-bg-input px-2 py-1.5 font-mono text-[12px] text-ink-soft outline-none transition focus:border-accent"
              >
                <option value="">跟随引擎默认</option>
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
                <option value="">默认（最大档）</option>
                {effOpts.map((ef) => (
                  <option key={ef} value={ef}>
                    {EFFORT_LABELS[ef] ?? ef}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
        <p className="mt-2 text-[11.5px] leading-5 text-ink-faint">
          这里是发起赛马时的预填默认；每场赛马仍可在发起面板里临时调整。
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
  return (
    <div className={`inline-flex items-center gap-0.5 rounded-lg border border-line bg-bg-panel ${small ? 'p-0.5' : 'p-1'}`}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-md transition ${small ? 'px-2 py-0.5 text-[10.5px]' : 'px-3.5 py-1.5 text-ui'} ${value === o.id ? 'bg-bg font-medium text-ink shadow-sm' : 'text-ink-soft hover:text-ink'
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
