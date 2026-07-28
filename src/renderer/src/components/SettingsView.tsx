/**
 * SettingsView — full-page settings with a category rail (通用 / 模型 /
 * 通知 / 关于). 模型页是 CLI 配置的只读快照（~/.kimi-code、~/.codex）
 * 加每引擎一个协议路由开关 — 本程序不提供任何配置文件修改功能。
 */

import { useEffect, useState } from 'react';
import { ArrowLeft, Bell, Box, FileLock2, Info, RefreshCw, Settings2 } from 'lucide-react';

import type { AppSettings, CodexConfigSnapshot, EngineConfigsSnapshot, KimiConfigSnapshot, NotificationSettings, OpencodeConfigSnapshot, RouteSupport } from '@shared/types';
import { useChatStore } from '../store/chatStore';
import { useT, type MsgKey } from '../i18n';

type Category = 'general' | 'models' | 'notifications' | 'about';

const CATEGORIES: Array<{ id: Category; key: MsgKey; icon: React.ReactNode }> = [
  { id: 'general', key: 'settingsGeneral', icon: <Settings2 size={15} /> },
  { id: 'models', key: 'settingsModels', icon: <Box size={15} /> },
  { id: 'notifications', key: 'settingsNotifications', icon: <Bell size={15} /> },
  { id: 'about', key: 'settingsAbout', icon: <Info size={15} /> },
];

export default function SettingsView(): JSX.Element | null {
  const t = useT();
  const open = useChatStore((s) => s.settingsOpen);
  const settings = useChatStore((s) => s.settings);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const [category, setCategory] = useState<Category>('general');
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // 只在打开时重置草稿 — 若依赖 settings，即时保存（如通知开关）会
    // 回写 settings 并把其它面板未保存的草稿一并冲掉。
    if (open && settings) {
      setDraft(structuredClone(settings));
      setCategory('general');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || !draft) return null;

  const close = (): void => useChatStore.setState({ settingsOpen: false });
  const save = async (): Promise<void> => {
    await saveSettings(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

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
            {category === 'general' && <GeneralPane draft={draft} setDraft={setDraft} />}
            {category === 'models' && <ModelsPane />}
            {category === 'notifications' && <NotificationsPane draft={draft} setDraft={setDraft} />}
            {category === 'about' && <AboutPane />}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3 px-8 py-3">
          {saved && <span className="text-ui text-ok">{t('saved')}</span>}
          <button onClick={() => void save()} className="rounded-lg bg-accent px-5 py-1.5 text-ui font-medium text-white transition hover:opacity-90">
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- general

interface PaneProps {
  draft: AppSettings;
  setDraft: (s: AppSettings) => void;
}

function GeneralPane({ draft, setDraft }: PaneProps): JSX.Element {
  const t = useT();
  return (
    <div className="space-y-7">
      <Section title={t('language')}>
        <Segmented
          value={draft.language}
          options={[
            { id: 'zh', label: t('langZh') },
            { id: 'en', label: t('langEn') },
          ]}
          onChange={(language) => setDraft({ ...draft, language: language as AppSettings['language'] })}
        />
      </Section>
      <Section title={t('themeMode')}>
        <Segmented
          value={draft.themeMode}
          options={[
            { id: 'light', label: t('modeLight') },
            { id: 'dark', label: t('modeDark') },
            { id: 'system', label: t('modeSystem') },
          ]}
          onChange={(themeMode) => setDraft({ ...draft, themeMode: themeMode as AppSettings['themeMode'] })}
        />
      </Section>
      <Section title={t('themePalette')}>
        <Segmented
          value={draft.themePalette}
          options={[
            { id: 'notion', label: t('paletteNotion') },
            { id: 'solarized', label: t('paletteSolarized') },
            { id: 'everforest', label: t('paletteEverforest') },
          ]}
          onChange={(themePalette) => setDraft({ ...draft, themePalette: themePalette as AppSettings['themePalette'] })}
        />
      </Section>
      <Section title={t('sendKey')}>
        <Segmented
          value={draft.sendKey}
          options={[
            { id: 'enter', label: t('sendEnter') },
            { id: 'ctrl-enter', label: t('sendCtrlEnter') },
          ]}
          onChange={(sendKey) => setDraft({ ...draft, sendKey: sendKey as AppSettings['sendKey'] })}
        />
      </Section>
      <Section title={t('autoCompact')}>
        <Segmented
          value={String(draft.autoCompactRatio)}
          options={[
            { id: '0', label: t('autoCompactOff') },
            { id: '70', label: '70%' },
            { id: '80', label: '80%' },
            { id: '90', label: '90%' },
            { id: '95', label: '95%' },
          ]}
          onChange={(v) => setDraft({ ...draft, autoCompactRatio: Number(v) })}
        />
        <p className="mt-2 text-[11px] leading-5 text-ink-faint">{t('autoCompactHint')}</p>
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
  const [snap, setSnap] = useState<EngineConfigsSnapshot | null>(null);

  const reload = (): void => {
    void window.cyberslots.engineConfigsGet().then(setSnap);
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
        <div className="py-8 text-center text-ui text-ink-faint">…</div>
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

/** opencode 只读区块 — 无路由开关（不经 ai-server 协议代理），无 provider
 *  管理（凭据/模型完全委托 opencode 自身：zen 免费模型免登录可用）。
 *  已连接 provider 列表只展示已缓存的 catalog，按钮手动加载（会启动 server）。 */
function OpencodeConfigCard({ snap }: { snap: OpencodeConfigSnapshot }): JSX.Element {
  const catalog = useChatStore((s) => s.opencodeCatalog);
  const loadCatalog = useChatStore((s) => s.loadOpencodeCatalog);
  const providers = catalog
    ? [...new Map(catalog.models.map((m) => [m.providerID, { name: m.providerName, count: 0 }])).entries()].map(
      ([id, p]) => ({ id, name: p.name, count: catalog.models.filter((m) => m.providerID === id).length }),
    )
    : [];
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
              <div className="flex flex-wrap gap-1">
                {providers.map((p) => (
                  <span key={p.id} className="rounded-md bg-bg-panel px-1.5 py-0.5 font-mono text-[10.5px] text-ink-soft">
                    {p.name} · {p.count} 模型
                  </span>
                ))}
              </div>
            )
          ) : (
            <button
              onClick={() => void loadCatalog()}
              className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-soft transition hover:bg-bg-hover"
            >
              加载已连接 provider 列表（将启动 opencode server）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ notifications

function NotificationsPane({ draft, setDraft }: PaneProps): JSX.Element {
  const t = useT();
  const saveSettings = useChatStore((s) => s.saveSettings);
  // 通知开关即时生效（不依赖底部保存钮）— 否则关了开关忘了点保存，
  // Windows 通知还会继续弹（item 13 实测踩坑）。
  const patch = (p: Partial<NotificationSettings>): void => {
    const notifications = { ...draft.notifications, ...p };
    setDraft({ ...draft, notifications });
    void saveSettings({ notifications });
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
          <Toggle checked={draft.notifications[r.key]} onChange={(v) => patch({ [r.key]: v })} />
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
      <div className="text-lg font-semibold text-ink">{t('appName')} · CyberSlots</div>
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
