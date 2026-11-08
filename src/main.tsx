import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp, type Entry } from './v2/ui/EditorApp';
import { HelpPage } from './v2/ui/HelpCenter';
import { AndroidApp } from './v2/ui/AndroidApp';
import { MusicXmlImport } from './v2/ui/MusicXmlImport';
import './v2/ui/editor.css';

// OCR 页懒加载：onnxruntime-web / pdfjs-dist 只被这条动态分支引用，
// 独立成异步 chunk，其他页面的主包完全不碰它们
const OcrPage = lazy(() => import('./ocr/ui/OcrPage').then((m) => ({ default: m.OcrPage })));

// 白屏救援：错误页给得出下一步（重试 / 回首页 / 复制信息），技术原文折叠展示。
// 手机上没有开发者工具，只贴异常原文等于让用户对着红框发呆。
const showFatal = (message: string): void => {
  try {
    document.querySelectorAll('[data-ws-fatal]').forEach((n) => n.remove());
    const box = document.createElement('div');
    box.className = 'ws-fatal';
    box.setAttribute('data-ws-fatal', '');
    const title = document.createElement('strong');
    title.textContent = '页面出了点问题';
    const hint = document.createElement('p');
    hint.textContent = '可以先重试；若仍然出现，请复制下面的信息反馈给我们。';
    const actions = document.createElement('div');
    actions.className = 'ws-fatal-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试';
    retry.onclick = () => window.location.reload();
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制错误信息';
    copy.onclick = () => {
      if (!navigator.clipboard?.writeText) { copy.textContent = '当前环境不支持复制'; return; }
      void navigator.clipboard.writeText(message).then(
        () => { copy.textContent = '已复制'; },
        () => { copy.textContent = '复制失败'; },
      );
    };
    // 安卓 WebView 没有落地页可回，别给一个点了白屏的按钮
    if (document.body.dataset.entry !== 'android') {
      const home = document.createElement('button');
      home.type = 'button';
      home.textContent = '返回首页';
      home.onclick = () => { window.location.href = './index.html'; };
      actions.append(retry, home, copy);
    } else {
      actions.append(retry, copy);
    }
    const detail = document.createElement('details');
    detail.className = 'ws-fatal-detail';
    const summary = document.createElement('summary');
    summary.textContent = '查看技术信息';
    const raw = document.createElement('pre');
    raw.textContent = message;
    detail.append(summary, raw);
    box.append(title, hint, actions, detail);
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

// 入口识别：HTML 上用 body 的 data-entry 声明（editor / align / library / play / help / musicxml）。
// 同一个 SPA 服务多个单一功能页：共用内核与状态，只是进来落在哪一屏不同。
const entry = document.body.dataset.entry ?? 'app';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <StrictMode>
    {entry === 'android' ? (
      <AndroidApp />
    ) : entry === 'help' ? (
      <HelpPage />
    ) : entry === 'musicxml' ? (
      <MusicXmlImport />
    ) : entry === 'ocr' ? (
      <Suspense fallback={null}>
        <OcrPage />
      </Suspense>
    ) : (
      <EditorApp entry={entry as Entry} />
    )}
  </StrictMode>,
);
