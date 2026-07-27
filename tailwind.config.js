/** Tailwind — design tokens follow the codex-desktop/Notion visual identity.
 *  Colors are CSS variables so themes swap at the data-palette / data-mode
 *  attribute level without touching component classes. */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-mode="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-canvas': 'var(--bg-canvas)',
        'bg-panel': 'var(--bg-panel)',
        'bg-hover': 'var(--bg-hover)',
        'bg-active': 'var(--bg-active)',
        'bg-input': 'var(--bg-input)',
        ink: 'var(--ink)',
        'ink-soft': 'var(--ink-soft)',
        'ink-faint': 'var(--ink-faint)',
        line: 'var(--line)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        err: 'var(--err)',
        info: 'var(--info)',
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
