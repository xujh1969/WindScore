import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp, type Entry } from './v2/ui/EditorApp';
import { HelpPage } from './v2/ui/HelpCenter';
import { AndroidApp } from './v2/ui/AndroidApp';
import './v2/ui/editor.css';

// 白屏救援：任何未捕获的错误直接画在页面上。手机上没有开发者工具，
// 白屏 = 用户只能看到一片空白无从反馈；把错误原文显示出来才能定位问题。
const showFatal = (message: string): void => {
  try {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:10px;right:10px;bottom:10px;z-index:99999;background:#b44036;color:#fff;font:12px/1.5 monospace;padding:10px;border-radius:8px;white-space:pre-wrap;max-height:45%;overflow:auto';
    box.textContent = message;
    document.body.appendChild(box);
  } catch { /* 页面连 body 都没有时无能为力 */ }
};
window.addEventListener('error', (e) => {
  // ResizeObserver 的循环警告是良性的：观察回调里重设了画布高度（响应式断行），
  // 容器尺寸又变了一帧，浏览器就会把「loop completed with undelivered
  // notifications」作为 error 抛到 window。它不代表任何功能损坏，
  // 各大 SPA 都是直接过滤（React 官方 issue 有讨论）——不滤的话
  // 红框会时不时弹出来吓用户。其余错误照常显示
  if (/ResizeObserver loop/i.test(e.message)) return;
  showFatal(`页面错误：${e.message}`);
});
window.addEventListener('unhandledrejection', (e) => showFatal(`异步错误：${String(e.reason)}`));

// 入口识别：HTML 上用 body 的 data-entry 声明（editor / align / library / play / help）。
// 同一个 SPA 服务多个单一功能页：共用内核与状态，只是进来落在哪一屏不同。
const entry = document.body.dataset.entry ?? 'app';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <StrictMode>
    {entry === 'android' ? <AndroidApp /> : entry === 'help' ? <HelpPage /> : <EditorApp entry={entry as Entry} />}
  </StrictMode>,
);
