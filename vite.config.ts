import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

/**
 * 版本号以 package.json 为唯一来源：HTML 里写 %APP_VERSION%，构建 / 预览时替换。
 * 界面不硬编码版本号，改一处就够（递增见 npm run version）。
 */
function versionInject(): Plugin {
  return {
    name: 'windscore-version',
    transformIndexHtml: (html) => html.replace(/%APP_VERSION%/g, pkg.version),
  };
}

export default defineConfig({
  plugins: [react(), versionInject()],
  clearScreen: false,
  // 识别 Worker 里动态 import TFJS（代码分割），iife 格式不支持，必须 es
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
    // 多入口：落地页 + 简谱编辑 + 动态谱生成（对轨）+ 曲库管理 + 演奏
    // （共用同一个 SPA，靠 body[data-entry] 决定落在哪一屏）
    rollupOptions: {
      input: {
        index: 'index.html',
        editor: 'editor.html',
        align: 'align.html',
        library: 'library.html',
        play: 'play.html',
        lab: 'lab.html',
        help: 'help.html',
      },
    },
  },
});
