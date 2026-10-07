import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp, type Entry } from './v2/ui/EditorApp';
import './v2/ui/editor.css';

// 入口识别：HTML 上用 body 的 data-entry 声明（editor / align / library / play）。
// 同一个 SPA 服务四个单一功能页：共用内核与状态，只是进来落在哪一屏不同。
const entry = (document.body.dataset.entry ?? 'app') as Entry;

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <StrictMode>
    <EditorApp entry={entry} />
  </StrictMode>,
);
