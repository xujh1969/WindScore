import { useEffect, useRef } from 'react';

/**
 * 弹窗右上角的 × 关闭按钮：所有弹窗统一用这一个组件。
 *
 * 规矩（用户定的）：**所有弹窗的关闭按钮都是 ×，都放在窗口右上角**——
 * 不要再发明「关闭」「暂不」「完成」这类文字按钮当关闭用，
 * 位置也不许贴在标题旁边（.v2-exp-head 有 space-between，会把它推到最右）。
 */
export function ExpClose({ onClose, disabled, title = '关闭' }: { onClose: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="v2-exp-close" aria-label="关闭" title={title} onClick={onClose} disabled={disabled}>
      ×
    </button>
  );
}

/**
 * 弹窗统一 Esc 关闭：遮罩是 div 而不是原生 <dialog>，键盘焦点未必落在弹窗内，
 * 所以监听 window 而不是给遮罩加 onKeyDown。enabled=false（导出中/忙）时不响应。
 * onClose 用 ref 兜住，调用方不必包 useCallback。
 */
export function useEscapeClose(onClose: () => void, enabled = true): void {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
