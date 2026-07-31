/**
 * EngineIcon — engine brand glyphs (codex = OpenAI knot, kimi = Kimi "K"
 * monogram, opencode = block-cursor mark) as single-color inline
 * SVGs. Path outlines come from simple-icons (CC0). fill="currentColor"
 * keeps the glyph in sync with the surrounding text color, so dark/light
 * themes adapt automatically.
 */

import { TriangleAlert } from 'lucide-react';
import { useId, useMemo } from 'react';

import type { EngineId } from '@shared/types';
import { ENGINE_LABELS } from '@shared/types';
import { enginePseudoWsKey, useT } from '../i18n';
import { useChatStore } from '../store/chatStore';

// 引擎展示名真源已上收到 @shared/types（主进程系统公告共用），此处仅转发。
export { ENGINE_LABELS };

// 引擎一句话简介 / 非原生工作区提示文案已上收到 i18n 词典
// （engineHintKey / enginePseudoWsKey），供新建会话选引擎、设置引擎总览
// 与多目录工作区标注处按当前语言取词。

export const DEFAULT_ENGINE_ORDER: EngineId[] = ['codex', 'opencode', 'kimi', 'omp', 'antigravity', 'claude'];

/** 「非原生工作区」琥珀警示小图标 — 多目录工作区选引擎处标注无原生多根的引擎，
 *  悬浮显「非原生工作区 — 完整说明」；不用文字徽标以免撑宽/截断引擎名。
 *  真多根引擎（codex/claude/omp）返回 null 不占位。 */
export function PseudoWorkspaceBadge({ engine }: { engine: EngineId }): JSX.Element | null {
  const t = useT();
  const hintKey = enginePseudoWsKey(engine);
  if (!hintKey) return null;
  return (
    <span title={`${t('pseudoWsBadge')} — ${t(hintKey)}`} className="shrink-0 text-warn">
      <TriangleAlert size={12} className="block" />
    </span>
  );
}

/** 引擎选择列表的统一顺序：读设置 engineOrder，剔脏值并把缺失引擎
 *  补到末尾（设置未加载时回退默认顺序）。 */
export function useEngineOrder(): EngineId[] {
  const order = useChatStore((s) => s.settings?.engineOrder);
  return useMemo(() => {
    const stored = (order ?? []).filter((e) => DEFAULT_ENGINE_ORDER.includes(e));
    return [...new Set([...stored, ...DEFAULT_ENGINE_ORDER])];
  }, [order]);
}

const ENGINE_PATHS: Record<Exclude<EngineId, 'antigravity'>, string> = {
  codex:
    'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  kimi:
    'M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441',
  // opencode 官方 logo：粗边框的空心竖长方形（块状光标轮廓），边框厚度约占宽度 1/4。
  // 自绘轮廓（opencode 无 simple-icons 条目），内窗反向绕行以镂空；
  // 竖条字形天生光学面积小，故铺满视窗高度以对齐 codex/kimi 的视觉体量。
  opencode:
    'M5.5.5h13A1.5 1.5 0 0 1 20 2v20a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 22V2A1.5 1.5 0 0 1 5.5.5zM8 4.5v15h8v-15z',
  // omp 品牌标识：⌥ Option 符号（omp.sh logo mark）。自绘实心笔画：
  // 左上横线接斜线下行到右下横线 + 右上独立短横线，fill 绘制跟随 currentColor。
  omp: 'M2 5h7.1l8.2 11H22v3h-6.2L7.6 8H2V5zm13 0h7v3h-7V5z',
  // claude 品牌标识：Anthropic 旭日放射星形（simple-icons: claude 完整路径）。
  // 不跟 currentColor，而是用品牌珊瑚橙 var(--claude-brand)（浅/深色各一档，
  // 见 index.css）— 与官方 mark 一致且两种主题下均有足够对比。
  claude:
    'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
};

// antigravity 官方 logo：钟形拱线（Google Antigravity 品牌 mark），描边渐变
// 红→绿→蓝，不随主题变色，故单独走 stroke 渲染分支（见组件内早返回）。
const AGY_ARCH_PATH = 'M2.5 20.5C7.75 20.5 7.75 3.5 12 3.5C16.25 3.5 16.25 20.5 21.5 20.5';
const AGY_STOPS: Array<[string, string]> = [
  ['0%', '#e8654f'],
  ['50%', '#34a853'],
  ['100%', '#4285f4'],
];

/** opencode 品牌银色渐变（金属光泽）：上亮→中暗→下回光，不随主题变色。
 *  其余引擎跟随 currentColor。 */
const METAL_STOPS: Array<[string, string]> = [
  ['0%', '#cfd2d6'],
  ['48%', '#9aa0a8'],
  ['62%', '#8f959d'],
  ['100%', '#b7bbc1'],
];

export function EngineIcon({
  engine,
  size = 14,
  className,
}: {
  engine: EngineId;
  size?: number;
  className?: string;
}): JSX.Element {
  const gradId = useId();
  if (engine === 'antigravity') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
        <defs>
          {/* userSpaceOnUse：拱线两脚近似水平线段，objectBoundingBox 渐变会失效 */}
          <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1="2.5" y1="12" x2="21.5" y2="12">
            {AGY_STOPS.map(([offset, color]) => (
              <stop key={offset} offset={offset} stopColor={color} />
            ))}
          </linearGradient>
        </defs>
        <path d={AGY_ARCH_PATH} stroke={`url(#${gradId})`} strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }
  const metallic = engine === 'opencode';
  // claude 用品牌珊瑚橙：以 currentColor 填充 + inline color=var（比 fill=var 属性
  // 更兼容），颜色由 index.css 的 --claude-brand 按 data-mode 自动切浅/深色。
  const claudeColored = engine === 'claude';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={metallic ? `url(#${gradId})` : 'currentColor'}
      style={claudeColored ? { color: 'var(--claude-brand)' } : undefined}
      aria-hidden="true"
      className={className}
    >
      {metallic && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            {METAL_STOPS.map(([offset, color]) => (
              <stop key={offset} offset={offset} stopColor={color} />
            ))}
          </linearGradient>
        </defs>
      )}
      <path d={ENGINE_PATHS[engine]} />
    </svg>
  );
}
