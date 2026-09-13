import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp } from './v2/ui/EditorApp';
import './v2/ui/editor.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <StrictMode>
    <EditorApp />
  </StrictMode>,
);
