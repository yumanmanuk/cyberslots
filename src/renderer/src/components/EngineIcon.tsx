/**
 * EngineIcon — engine brand glyphs (codex = OpenAI knot, kimi = Kimi "K"
 * monogram, opencode = block-cursor mark) as single-color inline
 * SVGs. Path outlines come from simple-icons (CC0). fill="currentColor"
 * keeps the glyph in sync with the surrounding text color, so dark/light
 * themes adapt automatically.
 */

import { useId } from 'react';

import type { EngineId } from '@shared/types';

export const ENGINE_LABELS: Record<EngineId, string> = {
  codex: 'Codex',
  kimi: 'Kimi Code',
  opencode: 'opencode',
};

const ENGINE_PATHS: Record<EngineId, string> = {
  codex:
    'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  kimi:
    'M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441',
  // opencode 官方 logo：粗边框的空心竖长方形（块状光标轮廓），边框厚度约占宽度 1/4。
  // 自绘轮廓（opencode 无 simple-icons 条目），内窗反向绕行以镂空；
  // 竖条字形天生光学面积小，故铺满视窗高度以对齐 codex/kimi 的视觉体量。
  opencode:
    'M5.5.5h13A1.5 1.5 0 0 1 20 2v20a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 22V2A1.5 1.5 0 0 1 5.5.5zM8 4.5v15h8v-15z',
};

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
  const metallic = engine === 'opencode';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={metallic ? `url(#${gradId})` : 'currentColor'}
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
