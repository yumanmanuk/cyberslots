/**
 * 思考深度生效档 — 单一真源。
 *
 * EffortPicker 的显示值与 sendPromptTo 的下发值共用本模块的解析结果，
 * 保证「界面显示哪个档，引擎就跑哪个档」（所见即所得）：用户没有主动
 * 选档时，展示的默认档（config 默认/目录默认/末档）同样是用户意图 ——
 * 引擎会话档是引擎侧持久状态（kimi KAP 服务端会话 / claude /effort /
 * omp ACP config），程序重启后 override 内存态清空，若不把展示档显式
 * 下发，引擎会静默沿用残留档，界面与实际运行脱节（显示 High 实跑 Low）。
 *
 * 返回 undefined = 该引擎/模型无档位面（控件隐藏、不下发）：
 * antigravity 无档位面；omp/opencode 目录懒加载未就绪；模型无思考档
 * 声明（kimi 无可选档 / omp 非 reasoning / opencode 无 variants）。
 */

import type { CodexCatalogModel, EngineId, KimiConfigModel, OmpCatalog, OpencodeCatalog } from '@shared/types';

/** codex 系通用四档（无 catalog 声明时的兜底值域）。 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
/** claude 思考档（/effort 斜杠命令值域，与 ClaudeAdapter.CLAUDE_EFFORTS 对齐）。 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** omp ACP 面基础两档（精细档由目录 thinking[] 扩展；下发时适配器原值
 *  直发、被拒降级 auto，见 OmpAdapter.applyThinking）。 */
export const OMP_BASE_EFFORTS = ['off', 'auto'];

export interface EffectiveEffort {
  /** 生效档（显示值 = 下发值）。 */
  value: string;
  /** 可选档位列表（滑轨）。 */
  options: string[];
  /** value 在 options 中的下标。 */
  index: number;
  /** 是否可显式下发：override 生效，或引擎/配置提供了可靠默认档。
   *  false = 展示值仅作预览（opencode 目录无默认档字段且未显选），
   *  发送时不下发，跟随引擎当前档。 */
  explicit: boolean;
}

export interface EffortResolveContext {
  engine: EngineId | undefined;
  /** 用户显式选择（store.efforts[sessionId]）；不在值域内按未选处理。 */
  override: string | undefined;
  /** 当前模型：models.current || available[0] || meta.modelId（引擎未运行时
   *  三者皆可空 → undefined；解析器按无匹配处理）。 */
  activeModel: string | undefined;
  kimiModels: KimiConfigModel[];
  codexCatalog: CodexCatalogModel[];
  codexDefaultEffort: string | undefined;
  opencodeCatalog: OpencodeCatalog | null | undefined;
  ompCatalog: OmpCatalog | null | undefined;
  /** omp ACP 运行时推送的 thinking 配置选项值域（优先于静态目录）。 */
  ompThinking?: { current: string; available: string[] };
}

function finalize(override: string | undefined, options: string[], fallback: string, explicit = true): EffectiveEffort {
  const value = override && options.includes(override) ? override : fallback;
  return { value, options, index: Math.max(0, options.indexOf(value)), explicit };
}

export function resolveEffectiveEffort(ctx: EffortResolveContext): EffectiveEffort | undefined {
  switch (ctx.engine) {
    case 'kimi': {
      // 值域 = config.toml support_efforts 声明（off 行规则已在主进程合成）。
      const entry = ctx.kimiModels.find((m) => m.alias === ctx.activeModel);
      const options = entry?.efforts ?? [];
      if (options.length < 2) return undefined; // 无可选 → 控件隐藏，不下发
      return finalize(ctx.override, options, entry?.defaultEffort ?? options[options.length - 1]!);
    }
    case 'omp': {
      // ACP 运行时推送的 thinking configOptions 优先（精细档 = off/auto/high/max 等）。
      if (ctx.ompThinking?.available.length) {
        const options = ctx.ompThinking.available;
        return finalize(ctx.override, options, ctx.ompThinking.current || options[0]!);
      }
      // ACP 未推送时，回退到静态目录（omp models --json）。
      if (!ctx.ompCatalog) return undefined;
      const entry = ctx.ompCatalog.models.find((m) => m.slug === ctx.activeModel);
      if (entry && entry.reasoning === false) return undefined; // 非思考模型无档位面
      const options = entry?.efforts?.length ? [...OMP_BASE_EFFORTS, ...entry.efforts] : OMP_BASE_EFFORTS;
      // 需求约定「默认取最大档」：目录兜底默认取末档（auto 或精细档最高档）。
      return finalize(ctx.override, options, options[options.length - 1]!);
    }
    case 'claude':
      // 固定五档；未显选时展示默认 max —— 下发即 /effort 显式设置。
      return finalize(ctx.override, CLAUDE_EFFORTS, 'max');
    case 'opencode': {
      const entry = ctx.opencodeCatalog?.models.find((m) => m.slug === ctx.activeModel);
      const options = entry?.efforts ?? [];
      if (!options.length) return undefined; // 无 reasoning variants → 无档位面
      if (ctx.override && options.includes(ctx.override)) return finalize(ctx.override, options, ctx.override);
      if (entry?.defaultEffort && options.includes(entry.defaultEffort)) {
        return finalize(undefined, options, entry.defaultEffort);
      }
      // 目录没有默认档字段（/config/providers 未提供）：未显选时展示首个
      // variant 仅作预览；explicit=false → 发送不下发，跟随服务端默认。
      return finalize(undefined, options, options[0]!, false);
    }
    case 'codex': {
      // 与 codex 自身优先级一致：override → 配置 model_reasoning_effort →
      // catalog 模型默认 → medium → 值域末档。
      const entry = ctx.codexCatalog.find((m) => m.slug === ctx.activeModel);
      const options = entry?.efforts ?? EFFORTS;
      for (const c of [ctx.override, ctx.codexDefaultEffort, entry?.defaultEffort, 'medium']) {
        if (c && options.includes(c)) return finalize(undefined, options, c);
      }
      return finalize(undefined, options, options[options.length - 1]!);
    }
    default:
      return undefined; // antigravity 等：无档位面，不下发
  }
}
