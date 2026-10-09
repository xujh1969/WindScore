import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { lyricInputTokens } from '../lyrics';

/** 真正的文本输入框，让中文输入法完成选字后再处理跳音。 */
export function LyricCell({ value, label, style, register, onCommit, onInsertGap, onDelete, onMove, onExit }: {
  value: string; label: string; style: CSSProperties;
  register: (input: HTMLInputElement | null) => void;
  onCommit: (value: string) => boolean; onInsertGap: () => boolean; onDelete: (offset: number) => boolean; onMove: (offset: number, atStart?: boolean) => void; onExit: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const composing = useRef(false);
  const saved = useRef(value);
  const edited = useRef(false);
  const completedComposition = useRef<string | null>(null);
  const skipBlur = useRef(false);
  const [invalid, setInvalid] = useState(false);
  useLayoutEffect(() => { setDraft(value); saved.current = value; edited.current = false; setInvalid(false); }, [value]);
  const save = (word: string): boolean => {
    if (word === saved.current) { edited.current = false; return true; }
    if (!onCommit(word)) { setInvalid(true); return false; }
    saved.current = lyricInputTokens(word)[0] ?? '';
    setDraft(saved.current);
    edited.current = false;
    setInvalid(false);
    return true;
  };
  const accept = (input: HTMLInputElement, word: string) => {
    setDraft(word); edited.current = true; setInvalid(false);
    const tokens = lyricInputTokens(word);
    if (tokens.length <= 1 || !save(word)) return;
    // 等输入法的最终 input 事件与 React 写回完成，再把焦点交给下一格。
    requestAnimationFrame(() => {
      if (document.activeElement !== input) return;
      skipBlur.current = true;
      onMove(tokens.length);
      skipBlur.current = false;
    });
  };
  return <input ref={register} className="v2-lyric-cell" aria-label={label} aria-invalid={invalid || undefined} style={style} value={draft} placeholder="·" autoComplete="off" spellCheck={false}
    onFocus={(e) => e.currentTarget.select()}
    onChange={(e) => {
      const word = e.currentTarget.value;
      if (composing.current || (e.nativeEvent as InputEvent).isComposing) { setDraft(word); edited.current = true; return; }
      if (completedComposition.current !== null) { completedComposition.current = word; setDraft(word); edited.current = true; return; }
      accept(e.currentTarget, word);
    }}
    onCompositionStart={() => { composing.current = true; completedComposition.current = null; }}
    onCompositionEnd={(e) => {
      composing.current = false;
      completedComposition.current = e.currentTarget.value;
      const input = e.currentTarget;
      setDraft(input.value);
      requestAnimationFrame(() => {
        const word = completedComposition.current;
        completedComposition.current = null;
        if (word !== null) accept(input, word);
      });
    }}
    onBlur={(e) => {
      if (composing.current || skipBlur.current) return;
      if (completedComposition.current !== null) {
        const word = completedComposition.current;
        completedComposition.current = null;
        accept(e.currentTarget, word);
      } else save(e.currentTarget.value);
    }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      if (completedComposition.current !== null) return;
      if (e.ctrlKey || e.metaKey || e.altKey || (e.key === ' ' && e.shiftKey)) return;
      if (e.key === 'Backspace') {
        const input = e.currentTarget;
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? start;
        const previous = !input.value || (start === 0 && end === 0);
        const clearsCell = (start === 0 && end === input.value.length) || (start === end && start === input.value.length && Array.from(input.value).length === 1);
        if (previous || clearsCell) {
          e.preventDefault();
          if (previous && !save(input.value)) return;
          const offset = previous ? -1 : 0;
          let deleted = false;
          skipBlur.current = true;
          flushSync(() => { deleted = onDelete(offset); });
          if (!deleted) { skipBlur.current = false; return; }
          edited.current = false;
          setInvalid(false);
          onMove(offset, true);
          skipBlur.current = false;
          return;
        }
      }
      if (e.key === ' ' && !edited.current && e.currentTarget.value) {
        e.preventDefault();
        if (onInsertGap()) { skipBlur.current = true; onMove(1); skipBlur.current = false; }
        return;
      }
      if (e.key === ' ' || e.key === 'Tab' || e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Enter') {
        e.preventDefault();
        if (!save(e.currentTarget.value)) return;
        onMove(e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault(); if (save(e.currentTarget.value)) onExit();
      }
    }} />;
}
