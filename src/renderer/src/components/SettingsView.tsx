/**
 * SettingsView — modal settings page: providers (endpoint/key/model),
 * default model, theme. Keys display masked; leaving the field untouched
 * keeps the stored secret (main process guards against mask write-back).
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import type { AppSettings, ProviderSettings } from '@shared/types';
import { useChatStore } from '../store/chatStore';

const THEMES: Array<{ id: AppSettings['theme']; label: string }> = [
  { id: 'notion', label: 'Notion 阅读' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

export default function SettingsView(): JSX.Element | null {
  const open = useChatStore((s) => s.settingsOpen);
  const settings = useChatStore((s) => s.settings);
  const saveSettings = useChatStore((s) => s.saveSettings);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open && settings) setDraft(structuredClone(settings));
  }, [open, settings]);

  if (!open || !draft) return null;

  const close = (): void => useChatStore.setState({ settingsOpen: false });
  const save = async (): Promise<void> => {
    await saveSettings(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const patchProvider = (id: string, patch: Partial<ProviderSettings>): void => {
    setDraft({
      ...draft,
      providers: draft.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  };

  const allModels = draft.providers.flatMap((p) => p.models.map((m) => m.alias));

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={close}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[640px] flex-col overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-sm font-semibold">设置</span>
          <button onClick={close} className="rounded p-1 text-ink-faint hover:bg-bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {/* 外观 */}
          <section>
            <SectionTitle>外观主题</SectionTitle>
            <div className="flex gap-2">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setDraft({ ...draft, theme: t.id })}
                  className={`rounded-lg border px-3.5 py-1.5 text-ui ${
                    draft.theme === t.id ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-soft hover:bg-bg-hover'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          {/* 默认模型 */}
          <section>
            <SectionTitle>默认模型（新会话）</SectionTitle>
            <select
              value={draft.defaultModelId}
              onChange={(e) => setDraft({ ...draft, defaultModelId: e.target.value })}
              className="w-64 rounded-lg border border-line bg-bg-input px-2.5 py-1.5 text-ui outline-none focus:border-accent"
            >
              {allModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </section>

          {/* Providers */}
          <section>
            <SectionTitle>模型供应商（Token Plan）</SectionTitle>
            <div className="space-y-4">
              {draft.providers.map((p) => (
                <div key={p.id} className="rounded-xl border border-line bg-bg-panel/50 px-4 py-3">
                  <div className="mb-2 text-ui font-semibold uppercase tracking-wide text-ink-soft">{p.id}</div>
                  <Field label="Base URL">
                    <input
                      value={p.baseUrl}
                      onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                      className="w-full rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
                    />
                  </Field>
                  <Field label="API Key">
                    <input
                      value={p.apiKey}
                      onChange={(e) => patchProvider(p.id, { apiKey: e.target.value })}
                      placeholder="粘贴新 Key 覆盖；保持掩码不变则沿用已保存的"
                      spellCheck={false}
                      className="w-full rounded-lg border border-line bg-bg-input px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
                    />
                  </Field>
                  <Field label="模型（别名 = 上游 ID）">
                    <div className="flex flex-wrap gap-1.5">
                      {p.models.map((m) => (
                        <span key={m.alias} className="rounded bg-bg-active px-2 py-0.5 font-mono text-[11px]">
                          {m.alias} · {Math.round(m.maxContextSize / 1024)}K
                        </span>
                      ))}
                    </div>
                  </Field>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-5 text-ink-faint">
              保存后新启动的会话生效（config.toml 会重新生成）；密钥经 safeStorage 加密存储，不入 git。
            </p>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          {saved && <span className="text-ui text-ok">已保存 ✓</span>}
          <button onClick={close} className="rounded-lg border border-line px-4 py-1.5 text-ui text-ink-soft hover:bg-bg-hover">
            关闭
          </button>
          <button onClick={() => void save()} className="rounded-lg bg-accent px-4 py-1.5 text-ui font-medium text-white hover:opacity-90">
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-2">
      <div className="mb-1 text-[11px] text-ink-faint">{label}</div>
      {children}
    </div>
  );
}
