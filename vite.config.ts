import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
    // 多入口：落地页 + 编辑（记谱 / 对轨）+ 曲库管理 + 演奏
    // （共用同一个 SPA，靠 body[data-entry] 决定落在哪一屏）
    rollupOptions: {
      input: {
        index: 'index.html',
        editor: 'editor.html',
        library: 'library.html',
        play: 'play.html',
      },
    },
  },
});
