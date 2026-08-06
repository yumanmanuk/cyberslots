/**
 * RaceSetup — 发起赛马的配置对话框：任务描述 + 5 个角色（选手A/B、裁判、
 * Builder、审计）各自独立配置引擎/模型/思考档。发令后立即创建并开跑。
 *
 * 模型为下拉选择并预选各引擎默认值、思考深度默认最大档 —— 目录数据源
 * 见共用 hook `useRoleCatalogs`（与重试调参弹窗 RoleTuneDialog 共用）。
 * 工作目录取当前激活会话的 cwd（work 模式）；纯聊天会话则各角色走草稿目录。
 */

import { Flag, X } from 'lucide-react';

import { BrandSpinner } from '../brand';
import { RaceHorse } from '../RaceHorse';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { EngineId, UnifiedMessage } from '@shared/types';
import type { RaceAdoptStrategy, RacePreJudgeMode, RaceRole, RaceRoleConfigs } from '@shared/race';
import { RACER_ROLES, RACE_ROLES } from '@shared/race';
import { adoptStrategyLabel, raceRoleKey, useT } from '../../i18n';
import { useChatStore } from '../../store/chatStore';
import { useRaceStore } from '../../store/raceStore';
import { ENGINE_LABELS, useEngineOrder } from '../EngineIcon';
import { effortLabel, maxEffort, useRoleCatalogs } from './modelCatalogs';

interface RoleDraft {
  engine: EngineId;
  modelId: string;
  effort: string;
}

/** modelId/effort 先留空，目录快照到达后由补默认 effect 填入默认模型 + 最大思考档。 */
const DEFAULT_ROLES: Record<RaceRole, RoleDraft> = {
  racerA: { engine: 'codex', modelId: '', effort: '' },
  racerB: { engine: 'kimi', modelId: '', effort: '' },
  racerC: { engine: 'opencode', modelId: '', effort: '' },
  judge: { engine: 'codex', modelId: '', effort: '' },
  builder: { engine: 'codex', modelId: '', effort: '' },
  auditor: { engine: 'codex', modelId: '', effort: '' },
  // 编排器内部临时角色（AI 初审），复用 judge 配置；不在配置 UI 展示。
  preJudge: { engine: 'codex', modelId: '', effort: '' },
};

/** 宿主对话的压缩摘录（用户/助手正文，尾部截断），作选手背景资料。 */
function buildContextSeed(messages: UnifiedMessage[] | undefined): string {
  if (!messages?.length) return '';
  const lines: string[] = [];
  for (const m of messages) {
    if (m.kind === 'user') lines.push(`用户: ${m.text}`);
    else if (m.kind === 'text') lines.push(`助手: ${m.text}`);
  }
  let t = lines.join('\n\n');
  if (t.length > 8000) t = `…（更早内容已截断）\n${t.slice(-8000)}`;
  return t;
}

export default function RaceSetup(): JSX.Element | null {
  const t = useT();
  const open = useRaceStore((s) => s.setupOpen);
  const closeSetup = useRaceStore((s) => s.closeSetup);
  const startRace = useRaceStore((s) => s.startRace);
  const activeMeta = useChatStore((s) => s.sessions.find((m) => m.id === s.activeSessionId));
  const parentMessages = useChatStore((s) => (s.activeSessionId ? s.ui[s.activeSessionId]?.messages : undefined));
  const raceDefaults = useChatStore((s) => s.settings?.race);
  const availability = useChatStore((s) => s.engineAvailability);
  const engineOrder = useEngineOrder();
  const { snap, ocCatalog, modelOptions, defaultModel, effortOptions } = useRoleCatalogs(open);
  const [prompt, setPrompt] = useState('');
  const [roles, setRoles] = useState<Record<RaceRole, RoleDraft>>(DEFAULT_ROLES);
  const [includeC, setIncludeC] = useState(false);
  const [withContext, setWithContext] = useState(true);
  const [preJudgeMode, setPreJudgeMode] = useState<RacePreJudgeMode>('off');
  const [designateStrategy, setDesignateStrategy] = useState<RaceAdoptStrategy | undefined>(undefined);
  const [designateComment, setDesignateComment] = useState('');
  const [starting, setStarting] = useState(false);
  // AI 初审滑动胶囊：测量选中按钮位置，用 transform/宽度过渡实现平移而非瞬移（同新会话页引擎切换）。
  const preJudgeTabRefs = useRef<Partial<Record<RacePreJudgeMode, HTMLButtonElement | null>>>({});
  const [preJudgePill, setPreJudgePill] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = preJudgeTabRefs.current[preJudgeMode];
    if (!el) return;
    setPreJudgePill({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
  }, [preJudgeMode]);

  // 打开时从「设置 → 赛马」预填各角色默认（空模型/空档位由下方
  // 补默认 effect 接管 → 引擎默认模型 + 最大思考档），C 开关也跟设置。
  useEffect(() => {
    if (!open) return;
    setIncludeC(raceDefaults?.enableRacerC ?? false);
    setPreJudgeMode(raceDefaults?.defaultPreJudgeMode ?? 'off');
    setDesignateStrategy(raceDefaults?.defaultDesignateStrategy);
    setDesignateComment('');
    const rs = raceDefaults?.roles ?? {};
    setRoles(() => {
      const next = { ...DEFAULT_ROLES };
      for (const r of [...RACE_ROLES, 'preJudge'] as RaceRole[]) {
        const d = rs[r];
        if (d) next[r] = { engine: d.engine, modelId: d.modelId ?? '', effort: d.effort ?? '' };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 目录到达后补默认：只填「尚未选择」的模型；思考档无效/为空时取最大档。
  useEffect(() => {
    if (!open) return;
    setRoles((prev) => {
      const next = { ...prev };
      for (const r of [...RACE_ROLES, 'preJudge'] as RaceRole[]) {
        const d = next[r];
        const modelId = d.modelId || defaultModel(d.engine);
        const opts = effortOptions(d.engine, modelId);
        const effort = d.effort && opts.includes(d.effort) ? d.effort : maxEffort(opts);
        next[r] = { ...d, modelId, effort };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, snap, ocCatalog]);

  if (!open) return null;
  const cwd = activeMeta?.chatMode === 'work' ? activeMeta.cwd : '';
  const hasHistory = !!parentMessages?.some((m) => m.kind === 'user' || m.kind === 'text');
  // A/B 必选；C 可选（行内开关控制是否参赛）。
  const visibleRoles = RACE_ROLES.filter((r) => r !== 'racerC' || includeC);

  const onEngine = (role: RaceRole, engine: EngineId): void =>
    setRoles((prev) => {
      const modelId = defaultModel(engine);
      return { ...prev, [role]: { engine, modelId, effort: maxEffort(effortOptions(engine, modelId)) } };
    });

  const onModel = (role: RaceRole, modelId: string): void =>
    setRoles((prev) => {
      const cur = prev[role];
      const opts = effortOptions(cur.engine, modelId);
      const effort = cur.effort && opts.includes(cur.effort) ? cur.effort : maxEffort(opts);
      return { ...prev, [role]: { ...cur, modelId, effort } };
    });

  const fire = async (): Promise<void> => {
    const text = prompt.trim();
    if (!text || starting) return;
    setStarting(true);
    try {
      const cfg = Object.fromEntries(
        visibleRoles.map((r) => [
          r,
          { engine: roles[r].engine, modelId: roles[r].modelId.trim(), effort: roles[r].effort || undefined },
        ]),
      ) as unknown as RaceRoleConfigs;
      // AI 初审开启时携带 preJudge 角色配置（独立于 judge，避免上下文污染）
      if (preJudgeMode === 'suggest' || preJudgeMode === 'auto') {
        cfg.preJudge = { engine: roles.preJudge.engine, modelId: roles.preJudge.modelId.trim(), effort: roles.preJudge.effort || undefined };
      }
      const seed = withContext && hasHistory ? buildContextSeed(parentMessages) : '';
      await startRace(text, cwd, cfg, activeMeta?.id, seed || undefined, preJudgeMode, preJudgeMode === 'designate' ? designateStrategy : undefined, preJudgeMode === 'designate' ? designateComment || undefined : undefined);
      setPrompt('');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={closeSetup}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86vh] w-[720px] flex-col rounded-2xl border border-line bg-bg p-5 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-semibold"><RaceHorse size={16} className="shrink-0" />{t('raceSetupTitle')}</span>
          <button onClick={closeSetup} className="rounded-md p-1 text-ink-faint transition hover:bg-bg-hover hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('raceSetupPromptPlaceholder')}
          className="mb-3 min-h-24 w-full resize-y rounded-xl border border-line bg-bg-input px-3 py-2.5 text-[13px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent"
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mb-1.5 grid grid-cols-[88px_1fr_1.4fr_96px] gap-2 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint">
            <span>{t('raceColRole')}</span>
            <span>{t('engine')}</span>
            <span>{t('model')}</span>
            <span>{t('effort')}</span>
          </div>
          {visibleRoles.map((role) => {
            const d = roles[role];
            const mOpts = modelOptions(d.engine);
            const effOpts = effortOptions(d.engine, d.modelId);
            return (
              <div key={role} className="mb-1.5 grid grid-cols-[88px_1fr_1.4fr_96px] items-center gap-2">
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
                  {/* 目录为空时兜底「引擎默认」；当前值不在目录里时补一项避免丢选 */}
                  {mOpts.length === 0 && <option value="">{t('raceEngineDefault')}</option>}
                  {d.modelId && !mOpts.some((o) => o.value === d.modelId) && (
                    <option value={d.modelId}>{d.modelId}</option>
                  )}
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
                    onChange={(e) => setRoles((prev) => ({ ...prev, [role]: { ...prev[role], effort: e.target.value } }))}
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
        </div>

        <label className="mt-2 flex cursor-pointer select-none items-center gap-2 text-[12px] text-ink-soft">
          <input type="checkbox" checked={includeC} onChange={(e) => setIncludeC(e.target.checked)} />
          {t('raceEnableRacerC')}
        </label>

        {hasHistory && (
          <label className="mt-2 flex cursor-pointer select-none items-center gap-2 text-[12px] text-ink-soft">
            <input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} />
            {t('raceWithContext')}
          </label>
        )}

        {/* 工作目录 */}
        <div className="mt-3 flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={cwd || t('raceDraftDir')}>
            {t('raceCwdLabel')}{cwd || t('raceCwdNone')}
          </span>
        </div>

        {/* AI 初审 —— 引擎选项卡风格（同新会话页引擎切换动效）+ preJudge 配置行（开启时显示）。
            放最底部紧贴发令按钮，主从关系由分段自然表达。 */}
        <div className="mt-3">
          <div className="mb-2 text-[12px] font-medium text-ink-soft">{t('racePreJudgeLabel')}</div>
          <div className="relative flex items-center gap-1 rounded-xl border border-line bg-bg-panel p-1">
            {preJudgePill && (
              <div
                className="pointer-events-none absolute rounded-lg bg-bg shadow-sm transition-all duration-300 ease-out"
                style={{ left: preJudgePill.left, top: preJudgePill.top, width: preJudgePill.width, height: preJudgePill.height }}
              />
            )}
            {(['off', 'suggest', 'designate', 'auto'] as const).map((mode) => (
              <button
                key={mode}
                ref={(el) => { preJudgeTabRefs.current[mode] = el; }}
                title={t(`racePreJudgeTooltip_${mode}`)}
                onClick={() => setPreJudgeMode(mode)}
                className={`relative flex-1 rounded-lg px-4 py-1.5 text-[12px] transition ${preJudgeMode === mode
                  ? 'font-medium text-ink'
                  : 'text-ink-soft hover:text-ink'
                  }`}
              >
                <span className="grid">
                  <span aria-hidden className="invisible whitespace-nowrap font-medium [grid-area:1/1]">{t(`racePreJudgeMode_${mode}`)}</span>
                  <span className="whitespace-nowrap [grid-area:1/1]">{t(`racePreJudgeMode_${mode}`)}</span>
                </span>
              </button>
            ))}
          </div>
          {/* preJudge 角色配置行（仅 suggest/auto 显示）—— 引擎/模型/思考深度，同主角色表格列宽 */}
          {(preJudgeMode === 'suggest' || preJudgeMode === 'auto') && (
            <div className="mt-2 grid grid-cols-[88px_1fr_1.4fr_96px] items-center gap-2">
              <span className="text-[12.5px] font-medium text-ink">{t('raceRolePreJudge')}</span>
              <select
                value={roles.preJudge.engine}
                onChange={(e) => onEngine('preJudge', e.target.value as EngineId)}
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
                value={roles.preJudge.modelId}
                onChange={(e) => onModel('preJudge', e.target.value)}
                className="min-w-0 rounded-lg border border-line bg-bg-input px-2 py-1.5 font-mono text-[12px] text-ink-soft outline-none transition focus:border-accent"
              >
                {(() => {
                  const mOpts = modelOptions(roles.preJudge.engine);
                  return (
                    <>
                      {mOpts.length === 0 && <option value="">{t('raceEngineDefault')}</option>}
                      {roles.preJudge.modelId && !mOpts.some((o) => o.value === roles.preJudge.modelId) && (
                        <option value={roles.preJudge.modelId}>{roles.preJudge.modelId}</option>
                      )}
                      {mOpts.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </>
                  );
                })()}
              </select>
              {(() => {
                const effOpts = effortOptions(roles.preJudge.engine, roles.preJudge.modelId);
                if (effOpts.length === 0) return (
                  <select disabled value="" className="rounded-lg border border-line bg-bg-input px-2 py-1.5 text-[12px] text-ink-faint opacity-60 outline-none">
                    <option value="">{t('raceEffortDefault')}</option>
                  </select>
                );
                return (
                  <select
                    value={roles.preJudge.effort}
                    onChange={(e) => setRoles((prev) => ({ ...prev, preJudge: { ...prev.preJudge, effort: e.target.value } }))}
                    className="rounded-lg border border-line bg-bg-input px-2 py-1.5 text-[12px] text-ink-soft outline-none transition focus:border-accent"
                  >
                    {effOpts.map((ef) => (
                      <option key={ef} value={ef}>
                        {effortLabel(ef)}
                      </option>
                    ))}
                  </select>
                );
              })()}
            </div>
          )}
          {preJudgeMode === 'designate' && (
            <div className="mt-2">
              <div className="mb-1.5 text-[12px] font-medium text-ink-soft">{t('raceDesignateStrategyLabel')}</div>
              <div className={`mb-2 grid gap-2 ${includeC ? 'grid-cols-3' : 'grid-cols-2'}`}>
                {(() => {
                  const letters = RACER_ROLES.filter(r => r !== 'racerC' || includeC)
                    .map(r => ({ racerA: 'A', racerB: 'B', racerC: 'C' })[r]);
                  const strategies: RaceAdoptStrategy[] = [
                    ...letters.map(l => `adopt${l}` as RaceAdoptStrategy),
                    ...letters.map(l => `prefer${l}` as RaceAdoptStrategy),
                  ];
                  return strategies.map(st => (
                    <button key={st} onClick={() => setDesignateStrategy(st)}
                      className={`rounded-xl border px-3 py-2 text-[12px] transition ${designateStrategy === st
                        ? 'border-accent bg-accent-soft font-semibold text-accent'
                        : 'border-line bg-bg-input text-ink-soft hover:bg-bg-hover hover:text-ink'}`}>
                      {adoptStrategyLabel(t, st)}
                    </button>
                  ));
                })()}
              </div>
              <textarea
                value={designateComment}
                onChange={e => setDesignateComment(e.target.value)}
                placeholder={t('raceDesignateCommentPlaceholder')}
                className="min-h-12 w-full resize-y rounded-xl border border-line bg-bg-input px-3 py-2 text-[12px] text-ink outline-none transition placeholder:text-ink-faint focus:border-accent"
              />
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center justify-end">
          <button
            disabled={!prompt.trim() || starting || (preJudgeMode === 'designate' && !designateStrategy)}
            onClick={() => void fire()}
            className="flex items-center gap-1.5 rounded-xl bg-accent px-5 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-30"
          >
            {starting ? <BrandSpinner size={13} /> : <Flag size={13} />} {starting ? t('raceFiring') : t('raceFire')}
          </button>
        </div>
      </div>
    </div>
  );
}
