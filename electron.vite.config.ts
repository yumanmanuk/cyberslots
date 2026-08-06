import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// HMR_OFF=1 时冻结渲染进程热更新（配合 dev:frozen 使用）
const hmrOff = process.env.HMR_OFF === '1';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    server: {
      port: 7777,
      strictPort: true,
      hmr: !hmrOff,
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react()],
  },
});
