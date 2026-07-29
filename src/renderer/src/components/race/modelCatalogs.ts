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

export const RACE_ENGINES: EngineId[] = ['codex', 'opencode', 'kimi', 'omp'];
export const CODEX_FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const EFFORT_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高', xhigh: '极致', none: '关', off: '关', auto: '自动' };

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
  const [snap, setSnap] = useState<EngineConfigsSnapshot | null>(null);

  useEffect(() => {
    if (!active) return;
    void refreshEngineConfigs().then(setSnap);
    void loadOpencodeCatalog();
    void loadOmpCatalog();
  }, [active, loadOpencodeCatalog, loadOmpCatalog, refreshEngineConfigs]);

  // 遵守设置页的隐藏黑名单 — 赛马配置里也不展示被隐藏的 opencode 模型。
  const hidden = new Set(hiddenList ?? []);
  const ocVisible = (ocCatalog?.models ?? []).filter((m) => !hidden.has(m.slug));

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
    return ocVisible.map((m) => ({ value: m.slug, label: m.displayName ?? m.slug }));
  };

  const defaultModel = (engine: EngineId): string => {
    if (engine === 'codex') return snap?.codex.model ?? snap?.codex.catalogModels?.[0]?.slug ?? '';
    if (engine === 'kimi') return snap?.kimi.defaultModel ?? modelOptions('kimi')[0]?.value ?? '';
    if (engine === 'omp') return ompCatalog?.models[0]?.slug ?? '';
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
    return [];
  };

  return { snap, ocCatalog, ompCatalog, modelOptions, defaultModel, effortOptions };
}
