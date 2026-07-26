/**
 * SettingsView — full-page settings with a category rail (通用 / 模型 /
 * 通知 / 关于), replacing the old single modal. Providers are fully
 * generic (cc-switch style): add from presets or custom, protocol
 * drives automatic routing; keys stay masked.
 */

import { useEffect, useState } from 'react';
import { ArrowLeft, Bell, Box, ChevronDown, Info, Plus, Settings2, Trash2 } from 'lucide-react';

import type { AppSettings, NotificationSettings, ProviderSettings } from '@shared/types';
import { PROVIDER_PRESETS, type ProviderPreset } from '@shared/presets';
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
    if (open && settings) {
      setDraft(structuredClone(settings));
      setCategory('general');
    }
  }, [open, settings]);

  if (!open || !draft) return null;

  const close = (): void => useChatStore.setState({ settingsOpen: false });
  const save = async (): Promise<void> => {
    await saveSettings(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

  return (
    <div className="absolute inset-0 z-30 flex bg-bg">
      {/* 分类导航 */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-bg-panel px-3 pb-4 pt-3">
        <button onClick={close} className="mb-3 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-ui text-ink-soft transition hover:bg-bg-hover hover:text-ink">
          <ArrowLeft size={15} /> {t('back')}
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            className={`mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-ui transition ${
              category === c.id ? 'bg-bg-active font-medium text-ink' : 'text-ink-soft hover:bg-bg-hover'
            }`}
          >
            {c.icon} {t(c.key)}
          </button>
        ))}
      </aside>

      {/* 内容区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-8 py-8">
            <h1 className="mb-6 text-xl font-semibold">{t(CATEGORIES.find((c) => c.id === category)!.key)}</h1>
            {category === 'general' && <GeneralPane draft={draft} setDraft={setDraft} />}
            {category === 'models' && <ModelsPane draft={draft} setDraft={setDraft} />}
            {category === 'notifications' && <NotificationsPane draft={draft} setDraft={setDraft} />}
            {category === 'about' && <AboutPane />}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-line px-8 py-3">
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
      <Section title={t('appearance')}>
        <Segmented
          value={draft.theme}
          options={[
            { id: 'notion', label: t('themeNotion') },
            { id: 'light', label: t('themeLight') },
            { id: 'dark', label: t('themeDark') },
          ]}
          onChange={(theme) => setDraft({ ...draft, theme: theme as AppSettings['theme'] })}
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
      <Section title={t('defaultModel')}>
        <select
          value={draft.defaultModelId}
          onChange={(e) => setDraft({ ...draft, defaultModelId: e.target.value })}
          className="w-64 rounded-lg border border-line bg-bg-input px-2.5 py-1.5 text-ui outline-none transition focus:border-accent"
        >
          {draft.providers.flatMap((p) => p.models.map((m) => m.alias)).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Section>
    </div>
  );
}

// ----------------------------------------------------------------- models

function ModelsPane({ draft, setDraft }: PaneProps): JSX.Element {
  const t = useT();
  const [presetOpen, setPresetOpen] = useState(false);

  const patchProvider = (id: string, patch: Partial<ProviderSettings>): void => {
    setDraft({ ...draft, providers: draft.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  };

  const addFromPreset = (preset: ProviderPreset | null): void => {
    const id = preset ? uniqueId(preset.id, draft.providers) : `custom-${crypto.randomUUID().slice(0, 8)}`;
    const provider: ProviderSettings = preset
      ? { id, name: preset.name, baseUrl: preset.baseUrl, protocol: preset.protocol, apiKey: '', models: structuredClone(preset.models), ...(preset.customHeaders ? { customHeaders: preset.customHeaders } : {}) }
      : { id, name: '', baseUrl: '', protocol: 'openai_chat', apiKey: '', models: [] };
    setDraft({ ...draft, providers: [...draft.providers, provider] });
    setPresetOpen(false);
  };

  return (
    <div className="space-y-5">
      <p className="text-[12px] leading-5 text-ink-faint">{t('providersHint')}</p>

      {draft.providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          onPatch={(patch) => patchProvider(p.id, patch)}
          onRemove={() => setDraft({ ...draft, providers: draft.providers.filter((x) => x.id !== p.id) })}
        />
      ))}

      <div className="relative">
        <button
          onClick={() => setPresetOpen(!presetOpen)}
          className="flex items-center gap-2 rounded-lg border border-dashed border-line px-4 py-2 text-ui text-ink-soft transition hover:border-accent hover:text-accent"
        >
          <Plus size={14} /> {t('addProvider')}
          <ChevronDown size={12} />
        </button>
        {presetOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setPresetOpen(false)} />
            <div className="absolute left-0 top-11 z-20 w-64 rounded-xl border border-line bg-bg-input py-1.5 shadow-lg">
              <div className="px-3 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">{t('choosePreset')}</div>
              {PROVIDER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => addFromPreset(preset)}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-ui text-ink transition hover:bg-bg-hover"
                >
                  <span>{preset.name}</span>
                  <span className="font-mono text-[10px] text-ink-faint">{preset.protocol === 'openai_chat' ? 'chat' : 'responses'}</span>
                </button>
              ))}
              <div className="mx-3 my-1 border-t border-line" />
              <button onClick={() => addFromPreset(null)} className="block w-full px-3 py-1.5 text-left text-ui text-ink-soft transition hover:bg-bg-hover">
                {t('customProvider')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ProviderCard({
  provider: p,
  onPatch,
  onRemove,
}: {
  provider: ProviderSettings;
  onPatch: (patch: Partial<ProviderSettings>) => void;
  onRemove: () => void;
}): JSX.Element {
  const t = useT();
  return (
    <div className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3.5">
      <div className="mb-3 flex items-center gap-2">
        <input
          value={p.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder={t('providerName')}
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1.5 py-0.5 text-[13px] font-semibold outline-none transition hover:border-line focus:border-accent"
        />
        <Segmented
          small
          value={p.protocol}
          options={[
            { id: 'openai_chat', label: 'Chat' },
            { id: 'openai_responses', label: 'Responses' },
          ]}
          onChange={(protocol) => onPatch({ protocol: protocol as ProviderSettings['protocol'] })}
        />
        <button title={t('remove')} onClick={onRemove} className="rounded-md p-1.5 text-ink-faint transition hover:bg-bg-hover hover:text-err">
          <Trash2 size={14} />
        </button>
      </div>

      <Field label="Base URL">
        <input
          value={p.baseUrl}
          onChange={(e) => onPatch({ baseUrl: e.target.value })}
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-[12px] outline-none transition focus:border-accent"
        />
      </Field>
      <Field label="API Key">
        <input
          value={p.apiKey}
          onChange={(e) => onPatch({ apiKey: e.target.value })}
          placeholder={t('apiKeyPlaceholder')}
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-[12px] outline-none transition focus:border-accent"
        />
      </Field>

      <Field label={t('models')}>
        <div className="space-y-1.5">
          {p.models.map((m, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={m.alias}
                onChange={(e) => onPatch({ models: p.models.map((x, j) => (j === i ? { ...x, alias: e.target.value } : x)) })}
                placeholder={t('modelAlias')}
                spellCheck={false}
                className="w-36 rounded-lg border border-line bg-bg-input px-2 py-1 font-mono text-[11.5px] outline-none transition focus:border-accent"
              />
              <input
                value={m.model}
                onChange={(e) => onPatch({ models: p.models.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)) })}
                placeholder={t('modelUpstreamId')}
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-line bg-bg-input px-2 py-1 font-mono text-[11.5px] outline-none transition focus:border-accent"
              />
              <input
                value={Math.round(m.maxContextSize / 1024)}
                onChange={(e) =>
                  onPatch({
                    models: p.models.map((x, j) => (j === i ? { ...x, maxContextSize: (Number(e.target.value) || 0) * 1024 } : x)),
                  })
                }
                title={t('contextSize')}
                className="w-16 rounded-lg border border-line bg-bg-input px-2 py-1 text-right font-mono text-[11.5px] outline-none transition focus:border-accent"
              />
              <button
                onClick={() => onPatch({ models: p.models.filter((_, j) => j !== i) })}
                className="rounded-md p-1 text-ink-faint transition hover:text-err"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button
            onClick={() => onPatch({ models: [...p.models, { alias: '', model: '', maxContextSize: 131072 }] })}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] text-ink-faint transition hover:text-accent"
          >
            <Plus size={12} /> {t('addModel')}
          </button>
        </div>
      </Field>
    </div>
  );
}

function uniqueId(base: string, providers: ProviderSettings[]): string {
  if (!providers.some((p) => p.id === base)) return base;
  let n = 2;
  while (providers.some((p) => p.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ------------------------------------------------------------ notifications

function NotificationsPane({ draft, setDraft }: PaneProps): JSX.Element {
  const t = useT();
  const patch = (p: Partial<NotificationSettings>): void =>
    setDraft({ ...draft, notifications: { ...draft.notifications, ...p } });

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
          className={`rounded-md transition ${small ? 'px-2 py-0.5 text-[10.5px]' : 'px-3.5 py-1.5 text-ui'} ${
            value === o.id ? 'bg-bg font-medium text-ink shadow-sm' : 'text-ink-soft hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-bg-active'}`}
    >
      <span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  );
}
