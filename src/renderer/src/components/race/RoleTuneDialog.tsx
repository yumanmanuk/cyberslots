/**
 * RoleTuneDialog — 重试前调整选手 A/B/C 与裁判的引擎/模型/思考档。
 * 保存后由编排器落盘：引擎/模型变更 → 该角色旧会话弃用（保留为普通
 * 会话），下次重跑阶段时以新配置重建；思考档变更下次 prompt 即生效。
 * 选手需配合「↻ 重试当前阶段」或「↩ 重跑双规划」；裁判在出方案/修订
 * 进行中或已报错时，保存即自动按新配置重跑该步。
 */

import { X } from 'lucide-react';

import { BrandSpinner } from '../brand';
import { useEffect, useState } from 'react';

import type { EngineId } from '@shared/types';
import type { RacerRole } from '@shared/race';
import { RACER_ROLES } from '@shared/race';
import { raceRoleKey, useT } from '../../i18n';
import { useRaceStore } from '../../store/raceStore';
import { useChatStore } from '../../store/chatStore';
import { ENGINE_LABELS, useEngineOrder } from '../EngineIcon';
import { effortLabel, maxEffort, useRoleCatalogs } from './modelCatalogs';

type TuneRole = RacerRole | 'judge';

/** 可调角色全集（按展示顺序）：参赛选手 + 裁判。 */
const TUNE_ROLES: readonly TuneRole[] = [...RACER_ROLES, 'judge'];

interface RoleDraft {
  engine: EngineId;
  modelId: string;
  effort: string;
}

export default function RoleTuneDialog(): JSX.Element | null {
  const t = useT();
  const open = useRaceStore((s) => s.tuneOpen);
  const closeTune = useRaceStore((s) => s.closeTune);
  const updateRole = useRaceStore((s) => s.updateRole);
  const race = useRaceStore((s) => (s.activeRaceId ? s.races[s.activeRaceId] : undefined));
  const availability = useChatStore((s) => s.engineAvailability);
  const engineOrder = useEngineOrder();
  const { modelOptions, defaultModel, effortOptions } = useRoleCatalogs(open);
  const [drafts, setDrafts] = useState<Partial<Record<TuneRole, RoleDraft>> | null>(null);
  const [saving, setSaving] = useState(false);
  // 参赛选手（未启用的 C 不展示）+ 裁判。
  const tuneRoles = TUNE_ROLES.filter((r) => !!race?.roles[r]);

  // 打开时从当前赛马配置初始化草稿。
  useEffect(() => {
    if (!open || !race) return;
    const next: Partial<Record<TuneRole, RoleDraft>> = {};
    for (const r of TUNE_ROLES) {
      const cfg = race.roles[r];
      if (cfg) next[r] = { engine: cfg.engine, modelId: cfg.modelId, effort: cfg.effort ?? '' };
    }
    setDrafts(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, race?.id]);

  if (!open || !race || !drafts) return null;

  const patch = (role: TuneRole, p: Partial<RoleDraft>): void =>
    setDrafts((prev) => (prev?.[role] ? { ...prev, [role]: { ...prev[role]!, ...p } } : prev));

  const onEngine = (role: TuneRole, engine: EngineId): void => {
    const modelId = defaultModel(engine);
    patch(role, { engine, modelId, effort: maxEffort(effortOptions(engine, modelId)) });
  };

  const onModel = (role: TuneRole, modelId: string): void => {
    const d = drafts[role];
    if (!d) return;
    const opts = effortOptions(d.engine, modelId);
    patch(role, { modelId, effort: d.effort && opts.includes(d.effort) ? d.effort : maxEffort(opts) });
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      for (const role of tuneRoles) {
        const d = drafts[role];
        if (!d) continue;
        await updateRole(role, { engine: d.engine, modelId: d.modelId.trim(), effort: d.effort || undefined });
      }
      closeTune();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={closeTune}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[620px] rounded-2xl border border-line bg-bg p-5 shadow-2xl"
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-semibold">{t('raceTuneDialogTitle')}</span>
          <button onClick={closeTune} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="mb-4 text-[11.5px] text-ink-faint">
          {t('raceTuneDialogHint')}
        </div>

        <div className="mb-1.5 grid grid-cols-[72px_1fr_1.4fr_96px] gap-2 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
          <span>{t('raceColRole')}</span>
          <span>{t('engine')}</span>
          <span>{t('model')}</span>
          <span>{t('effort')}</span>
        </div>
        {tuneRoles.map((role) => {
          const d = drafts[role];
          if (!d) return null;
          const mOpts = modelOptions(d.engine);
          const effOpts = effortOptions(d.engine, d.modelId);
          return (
            <div key={role} className="mb-1.5 grid grid-cols-[72px_1fr_1.4fr_96px] items-center gap-2">
              <span className="text-[12.5px] font-medium text-ink">{t(raceRoleKey(role))}</span>
              <select
                value={d.engine}
                onChange={(e) => onEngine(role, e.target.value as EngineId)}
                className="rounded-lg border border-line bg-bg-input px-2 py-1.5 text-[12px] text-ink-soft outline-none transition focus:border-accent"
              >
                {engineOrder.map((eng) => (
                  <option key={eng} value={eng} disabled={availability ? !availability[eng] : false}>
                    {ENGINE_LABELS[eng]}
                    {availability && !availability[eng] ? t('raceNotInstalled') : ''}
                  </option>
                ))}
              </select>
              <select
                value={d.modelId}
                onChange={(e) => onModel(role, e.target.value)}
                className="min-w-0 rounded-lg border border-line bg-bg-input px-2 py-1.5 font-mono text-[12px] text-ink-soft outline-none transition focus:border-accent"
              >
                {mOpts.length === 0 && <option value="">{t('raceEngineDefault')}</option>}
                {d.modelId && !mOpts.some((o) => o.value === d.modelId) && <option value={d.modelId}>{d.modelId}</option>}
                {mOpts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {effOpts.length === 0 ? (
                <select
                  disabled
                  value=""
                  className="rounded-lg border border-line bg-bg-input px-2 py-1.5 text-[12px] text-ink-faint opacity-60 outline-none"
                >
                  <option value="">{t('raceEffortDefault')}</option>
                </select>
              ) : (
                <select
                  value={d.effort}
                  onChange={(e) => patch(role, { effort: e.target.value })}
                  className="rounded-lg border border-line bg-bg-input px-2 py-1.5 text-[12px] text-ink-soft outline-none transition focus:border-accent"
                >
                  {effOpts.map((ef) => (
                    <option key={ef} value={ef}>
                      {effortLabel(ef)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={closeTune}
            className="rounded-xl border border-line px-4 py-2 text-[12.5px] text-ink-soft transition hover:bg-bg-hover"
          >
            {t('cancel')}
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
          >
            {saving && <BrandSpinner size={12} />}
            {saving ? t('raceSaving') : t('raceSaveConfig')}
          </button>
        </div>
      </div>
    </div>
  );
}
