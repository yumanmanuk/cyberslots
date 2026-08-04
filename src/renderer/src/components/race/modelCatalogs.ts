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

import type { CodexCatalogModel, EngineConfigsSnapshot, EngineId, OmpCatalog, OpencodeCatalog } from '@shared/types';
import { useChatStore } from '../../store/chatStore';

export interface ModelOption {
  value: string;
  label: string;
}

export const CODEX_FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
// 思考深度档位刻意不本地化 —— 各处一律英文显示（产品决定，勿“规范化”回来）。
const EFFORT_LABELS_EN: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', none: 'Off', off: 'Off', auto: 'Auto', thinking: 'Thinking' };
/** Effort label (English-only by design); falls back to the raw effort id. */
export const effortLabel = (ef: string): string => EFFORT_LABELS_EN[ef] ?? ef;

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

/** Claude 思考档（/effort 斜杠命令的档位，与 ClaudeAdapter.CLAUDE_EFFORTS 对齐）。 */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Claude Code 模型别名（`claude --model` 接受别名或全名；与
 *  ClaudeAdapter.CLAUDE_MODEL_SLUGS 对齐）。 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: 'default', label: 'Default（跟随登录）' },
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'haiku', label: 'Claude Haiku' },
];

/** Claude 别名短名（自定义模型覆盖时作后缀，标注实际映射的档位）。 */
const CLAUDE_ALIAS_SHORT: Record<string, string> = { default: 'Default', sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

/** Claude 模型展示名：第三方网关 env 映射了自定义模型 → 「自定义名（别名）」，
 *  否则回落内置别名友好名（Composer 选择器与赛马配置共用）。 */
export function claudeModelLabel(alias: string, custom: string | undefined, lang: 'zh' | 'en'): string {
  if (custom) return `${custom}（${CLAUDE_ALIAS_SHORT[alias] ?? alias}）`;
  if (alias === 'default') return lang === 'en' ? 'Default (follows login)' : 'Default（跟随登录）';
  return CLAUDE_MODELS.find((m) => m.value === alias)?.label ?? alias;
}

/** antigravity slug → 友好显示名（composer 模型选择器 + 设置页默认模型下拉 +
 *  回答信息 tooltip 共用；与 AntigravityAdapter.AGY_MODEL_SLUGS 对齐）。 */
export const ANTIGRAVITY_LABELS: Record<string, string> = {
  'claude-sonnet-4-6': 'Claude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
  'gemini-3.6-flash-high': 'Gemini 3.6 Flash (High)',
  'gemini-3.6-flash-medium': 'Gemini 3.6 Flash (Medium)',
  'gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
};

/** Claude Code 模型别名 → 友好显示名（与 ClaudeAdapter.CLAUDE_MODEL_SLUGS 对齐）。 */
export const CLAUDE_LABELS: Record<string, string> = {
  default: 'Default（默认）',
  sonnet: 'Claude Sonnet',
  opus: 'Claude Opus',
  haiku: 'Claude Haiku',
};

/** 模型 slug → 展示名的统一解析链（Composer 选择器与回答信息 tooltip 共用）：
 *  claude 自定义映射（第三方网关 env）→ codex 目录 displayName → omp 目录
 *  displayName → antigravity/claude 静态表 → 原始 slug。 */
export function modelDisplayLabel(
  engine: EngineId | undefined,
  id: string,
  ctx: {
    codexCatalog?: CodexCatalogModel[];
    ompCatalog?: OmpCatalog | null;
    claudeLabels?: Record<string, string> | null;
    lang: 'zh' | 'en';
  },
): string {
  if (!id) return '';
  if (engine === 'claude') return claudeModelLabel(id, ctx.claudeLabels?.[id], ctx.lang);
  return (
    ctx.codexCatalog?.find((c) => c.slug === id)?.displayName ??
    (engine === 'omp' ? ctx.ompCatalog?.models.find((m) => m.slug === id)?.displayName : undefined) ??
    ANTIGRAVITY_LABELS[id] ??
    CLAUDE_LABELS[id] ??
    id
  );
}

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
  /** 该引擎+模型支持的思考档位（无声明 → 空数组 = 控件禁用）。 */
  effortOptions(engine: EngineId, modelId: string): string[];
}

export function useRoleCatalogs(active: boolean): RoleCatalogs {
  const lang = useChatStore((s) => s.settings?.language ?? 'zh');
  const ocCatalog = useChatStore((s) => s.opencodeCatalog);
  const ompCatalog = useChatStore((s) => s.ompCatalog);
  const loadOpencodeCatalog = useChatStore((s) => s.loadOpencodeCatalog);
  const loadOmpCatalog = useChatStore((s) => s.loadOmpCatalog);
  const refreshEngineConfigs = useChatStore((s) => s.refreshEngineConfigs);
  const hiddenList = useChatStore((s) => s.settings?.opencodeHiddenModels);
  const ompHiddenList = useChatStore((s) => s.settings?.ompHiddenModels);
  const agyHiddenList = useChatStore((s) => s.settings?.antigravityHiddenModels);
  const [snap, setSnap] = useState<EngineConfigsSnapshot | null>(null);

  useEffect(() => {
    if (!active) return;
    void refreshEngineConfigs().then(setSnap);
    void loadOpencodeCatalog();
    void loadOmpCatalog();
  }, [active, loadOpencodeCatalog, loadOmpCatalog, refreshEngineConfigs]);

  // 遵守设置页的隐藏黑名单 — 赛马配置里也不展示被隐藏的 opencode/omp/antigravity 模型。
  const hidden = new Set(hiddenList ?? []);
  const ocVisible = (ocCatalog?.models ?? []).filter((m) => !hidden.has(m.slug));
  const ompHidden = new Set(ompHiddenList ?? []);
  const ompVisible = (ompCatalog?.models ?? []).filter((m) => !ompHidden.has(m.slug));
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
      return ompVisible.map((m) => ({ value: m.slug, label: m.displayName ?? m.slug }));
    }
    if (engine === 'antigravity') {
      return ANTIGRAVITY_MODELS.filter((m) => !agyHidden.has(m.value));
    }
    if (engine === 'claude') {
      const labels = snap?.claude.modelLabels;
      return CLAUDE_MODELS.map((m) => ({ ...m, label: claudeModelLabel(m.value, labels?.[m.value], lang) }));
    }
    return ocVisible.map((m) => ({ value: m.slug, label: m.displayName ?? m.slug }));
  };

  const defaultModel = (engine: EngineId): string => {
    if (engine === 'codex') return snap?.codex.model ?? snap?.codex.catalogModels?.[0]?.slug ?? '';
    if (engine === 'kimi') return snap?.kimi.defaultModel ?? modelOptions('kimi')[0]?.value ?? '';
    if (engine === 'omp') return ompVisible[0]?.slug ?? '';
    if (engine === 'antigravity') return 'claude-sonnet-4-6';
    if (engine === 'claude') return 'default';
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
    if (engine === 'kimi') {
      // 值域来自 config.toml 的 support_efforts 声明（off + 档位，
      // always_thinking 模型无 off）；无声明的模型禁用控件。
      const entry = (snap?.kimi.providers ?? []).flatMap((p) => p.models).find((m) => m.alias === modelId);
      return entry?.efforts?.length && entry.efforts.length >= 2 ? entry.efforts : [];
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
      // 仅档位独立的 claude 系支持 low/medium/high；gemini flash slug 已含档位、
      // claude …-thinking slug 同理烧死（实测 --effort 直报 not supported）→ 禁用控件。
      return /^claude/i.test(modelId) && !/thinking/i.test(modelId) ? ANTIGRAVITY_CLAUDE_EFFORTS : [];
    }
    if (engine === 'claude') {
      // Claude 思考档是运行时 /effort 斜杠命令（适配器回合间热切），
      // 赛马角色也可预配思考档（首个 prompt 前先发 /effort）。
      return CLAUDE_EFFORTS;
    }
    return [];
  };

  return { snap, ocCatalog, ompCatalog, modelOptions, defaultModel, effortOptions };
}
