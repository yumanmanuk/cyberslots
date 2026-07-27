/** Tailwind — design tokens follow the codex-desktop/Notion visual identity.
 *  Colors are CSS variables so themes swap at the data-palette / data-mode
 *  attribute level without touching component classes.
 *
 *  withAlpha：CSS 变量色默认不支持 `/N` 透明度修饰符（`bg-err/10` 这类
 *  类会静默不生成，曾导致错误卡片退回近白默认边框）。只在透明度为
 *  纯数字且 <1 时生成 color-mix；其余一律原样 var() —— 普通类（如
 *  border-line）若被卷入 Tailwind 的 --tw-*-opacity 变量 calc 联动，
 *  个别解析路径失败会让全部边框退白（实测踩坑）。 */
const withAlpha = (variable) => ({ opacityValue }) => {
  const n = Number(opacityValue);
  if (!Number.isFinite(n) || n >= 1) return `var(${variable})`;
  return `color-mix(in srgb, var(${variable}) ${n * 100}%, transparent)`;
};

export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-mode="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: withAlpha('--bg'),
        'bg-canvas': withAlpha('--bg-canvas'),
        'bg-panel': withAlpha('--bg-panel'),
        'bg-hover': withAlpha('--bg-hover'),
        'bg-active': withAlpha('--bg-active'),
        'bg-input': withAlpha('--bg-input'),
        ink: withAlpha('--ink'),
        'ink-soft': withAlpha('--ink-soft'),
        'ink-faint': withAlpha('--ink-faint'),
        line: withAlpha('--line'),
        accent: withAlpha('--accent'),
        'accent-soft': withAlpha('--accent-soft'),
        ok: withAlpha('--ok'),
        warn: withAlpha('--warn'),
        err: withAlpha('--err'),
        info: withAlpha('--info'),
      },
      fontFamily: {
        sans: ['"Noto Sans SC"', 'Montserrat', 'system-ui', 'Segoe UI', 'sans-serif'],
        mono: ['Iosevka', '"Cascadia Code"', 'Consolas', 'monospace'],
      },
      fontSize: {
        ui: ['13px', '20px'],
        body: ['15px', '1.7'],
      },
    },
  },
  plugins: [],
};
