/**
 * 简谱写法的可视化：数字 + 八度点（高音在上 / 低音在下）+ 减时线 / 增时线。
 *
 * 按钮要长成谱面上的样子，用户才不必在「3/2」和「数字下面一条横线的 3」
 * 之间来回翻译（样式见 editor.css 的 .v2-glyph）。编辑面板与浮动输入板共用。
 */

import { durationShape } from '../edit';
import { ACCIDENTAL_GLYPH } from '../paint';
import type { Accidental } from '../types';

/** 一列八度点（高音在数字上、低音在下），简谱里就是这么标的 */
export function GlyphDots({ n }: { n: number }) {
  return (
    <span className="v2-glyph-dots">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className="v2-dot" />
      ))}
    </span>
  );
}

/** 减时线：1/2 拍 1 条、1/4 拍 2 条、1/8 拍 3 条，压在数字下面 */
export function GlyphBeams({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="v2-glyph-beams">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className="v2-beam" />
      ))}
    </span>
  );
}

/**
 * 一个音符长什么样：数字 + 上下八度点 + 下方减时线。
 * dots 为正 = 上方加点（高音），为负 = 下方加点（低音）。
 */
export function NotationGlyph({
  degree,
  beams = 0,
  dots = 0,
  accidental,
}: {
  degree: number;
  beams?: number;
  dots?: number;
  /** 变音记号写在数字左边，与简谱 `#4` / `b3` 一致 */
  accidental?: Accidental;
}) {
  return (
    <span className="v2-glyph">
      {dots > 0 ? <GlyphDots n={dots} /> : null}
      {/* 变音记号与数字同一行（写在数字左边），八度点才在上下方 */}
      <span className="v2-glyph-body">
        {accidental ? <span className="v2-glyph-acc">{ACCIDENTAL_GLYPH[accidental]}</span> : null}
        <span className="v2-glyph-digit">{degree}</span>
      </span>
      <GlyphBeams n={beams} />
      {dots < 0 ? <GlyphDots n={-dots} /> : null}
    </span>
  );
}

/**
 * 连音线图标：谱面上就是一条拱起的弧（⌒），两端搭在音符上。
 * 按钮用它代替「连音线」三个字——属性面板与浮动输入板共用。
 */
export function SlurGlyph() {
  return (
    <svg className="v2-slur-icon" width="18" height="9" viewBox="0 0 24 12" aria-hidden focusable="false">
      <path d="M2 10.5 C 6 1.5, 18 1.5, 22 10.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 时值的形象画法：`5` / `5−`（增时线）/ `5·`（附点）/ 数字下加横线（减时线）。
 * 画的是谱面上的样子，不是「1/4 拍」这种要换算的文字。
 */
export function DurationGlyph({ degree, ticks }: { degree: number | string; ticks: number }) {
  const { dashes, beams, dots } = durationShape(ticks);
  return (
    <span className="v2-glyph">
      <span className="v2-glyph-body">
        <span className="v2-glyph-digit">{degree}</span>
        {dashes ? <span className="v2-glyph-tail">{'-'.repeat(dashes)}</span> : null}
        {dots ? <span className="v2-glyph-tail">{'.'.repeat(dots)}</span> : null}
      </span>
      <GlyphBeams n={beams} />
    </span>
  );
}
