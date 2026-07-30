/**
 * useRoleCatalogs — 赛马角色配置共用的「引擎→模型/思考档」目录数据源，
 * RaceSetup（发起面板）与 RoleTuneDialog（重试前调参）共用：
 * codex ← catalog + config.toml 默认；kimi ← providers 别名 + default_model；
 * opencode ← catalog + defaults；omp ← `omp models --json` 目录（无凭据时
 * 空目录 → 引擎默认，思考档固定 off/auto — probe-omp-findings §3/§4）。
 * 激活时经 chatStore.refreshEngineConfigs 重读快照（一次 IPC 两处受益）
 * + 懒加载 opencode/omp 目录。
 */

import { useEffect, useState } from 'react';

import type { EngineConfigsSnapshot, EngineId, OmpCatalog, OpencodeCatalog } from '@shared/types';
import { useChatStore } from '../../store/chatStore';

export interface ModelOption {
  value: string;
  label: string;
}

export const CODEX_FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const EFFORT_LABELS: Record<string, string> = { minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极致', max: '最大', none: '关', off: '关', auto: '自动', thinking: '开' };

/** antigravity 静态模型清单（slug 取自 `agy models` 实测，见 headless-mode.md）。
 *  adapter 接受任意合法 slug；gemini flash slug 已含档位，claude 系支持 --effort。 */
const ANTIGRAVITY_MODELS: ModelOption[] = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { value: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
  { value: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
  { value: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)' },
  { value: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)' },
];
const ANTIGRAVITY_CLAUDE_EFFORTS = ['low', 'medium', 'high'];

/** omp 的 ACP 思考值域＝off/auto + 模型目录 thinking[] 精细档（动态扩展）。 */
const OMP_BASE_EFFORTS = ['off', 'auto'];

/** 需求约定：思考深度默认取最大档（档位列表按 catalog 声明从低到高）。 */
export const maxEffort = (opts: string[]): string => opts[opts.length - 1] ?? '';

export interface RoleCatalogs {
  /** 原始快照（供调用方的默认值回填 effect 做依赖，避免每渲染重跑）。 */
  snap: EngineConfigsSnapshot | null;
  ocCatalog: OpencodeCatalog | null;
  ompCatalog: OmpCatalog | null;
  modelOptions(engine: EngineId): ModelOption[];
  defaultModel(engine: EngineId): string;
  /** 该引擎+模型支持的思考档位（kimi 无思考档 → 空数组 = 控件禁用）。 */
  effortOptions(engine: EngineId, modelId: string): string[];
}

export function useRoleCatalogs(active: boolean): RoleCatalogs {
  const ocCatalog = useChatStore((s) => s.opencodeCatalog);
  const ompCatalog = useChatStore((s) => s.ompCatalog);
  const loadOpencodeCatalog = useChatStore((s) => s.loadOpencodeCatalog);
  const loadOmpCatalog = useChatStore((s) => s.loadOmpCatalog);
  const refreshEngineConfigs = useChatStore((s) => s.refreshEngineConfigs);
  const hiddenList = useChatStore((s) => s.settings?.opencodeHiddenModels);
  const agyHiddenList = useChatStore((s) => s.settings?.antigravityHiddenModels);
  const [snap, setSnap] = useState<EngineConfigsSnapshot | null>(null);

  useEffect(() => {
    if (!active) return;
    void refreshEngineConfigs().then(setSnap);
    void loadOpencodeCatalog();
    void loadOmpCatalog();
  }, [active, loadOpencodeCatalog, loadOmpCatalog, refreshEngineConfigs]);

  // 遵守设置页的隐藏黑名单 — 赛马配置里也不展示被隐藏的 opencode/antigravity 模型。
  const hidden = new Set(hiddenList ?? []);
  const ocVisible = (ocCatalog?.models ?? []).filter((m) => !hidden.has(m.slug));
  const agyHidden = new Set(agyHiddenList ?? []);

  const modelOptions = (engine: EngineId): ModelOption[] => {
    if (engine === 'codex') {
      return (snap?.codex.catalogModels ?? []).map((m) => ({ value: m.slug, label: m.displayName ?? m.slug }));
    }
    if (engine === 'kimi') {
      const aliases = (snap?.kimi.providers ?? []).flatMap((p) => p.models.map((m) => m.alias));
      return [...new Set(aliases)].map((a) => ({ value: a, label: a }));
    }
    if (engine === 'omp') {
      return (ompCatalog?.models ?? []).map((m) => ({ value: m.slug, label: m.displayName ?? m.slug }));
    }
    if (engine === 'antigravity') {
      return ANTIGRAVITY_MODELS.filter((m) => !agyHidden.has(m.value));
    }
    return ocVisible.map((m) => ({ value: m.slug, label: m.displayName ?? m.slug }));
  };

  const defaultModel = (engine: EngineId): string => {
    if (engine === 'codex') return snap?.codex.model ?? snap?.codex.catalogModels?.[0]?.slug ?? '';
    if (engine === 'kimi') return snap?.kimi.defaultModel ?? modelOptions('kimi')[0]?.value ?? '';
    if (engine === 'omp') return ompCatalog?.models[0]?.slug ?? '';
    if (engine === 'antigravity') return 'claude-sonnet-4-6';
    if (ocCatalog) {
      const def = ocVisible.find((m) => ocCatalog.defaults[m.providerID] === m.modelID);
      return def?.slug ?? ocVisible[0]?.slug ?? '';
    }
    return '';
  };

  const effortOptions = (engine: EngineId, modelId: string): string[] => {
    if (engine === 'codex') {
      const entry = snap?.codex.catalogModels?.find((m) => m.slug === modelId);
      return entry?.efforts?.length ? entry.efforts : CODEX_FALLBACK_EFFORTS;
    }
    if (engine === 'opencode') {
      return ocCatalog?.models.find((m) => m.slug === modelId)?.efforts ?? [];
    }
    if (engine === 'omp') {
      // 值域 = off/auto + 目录 thinking[] 精细档；非 reasoning 模型禁用控件。
      const entry = ompCatalog?.models.find((m) => m.slug === modelId);
      if (entry && entry.reasoning === false) return [];
      return entry?.efforts?.length ? [...OMP_BASE_EFFORTS, ...entry.efforts] : OMP_BASE_EFFORTS;
    }
    if (engine === 'antigravity') {
      // claude 系支持 low/medium/high；gemini flash slug 已含档位→禁用控件。
      return /^claude/i.test(modelId) ? ANTIGRAVITY_CLAUDE_EFFORTS : [];
    }
    return [];
  };

  return { snap, ocCatalog, ompCatalog, modelOptions, defaultModel, effortOptions };
}
