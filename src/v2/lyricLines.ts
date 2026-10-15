/** 共享歌词连接几何；谱式只提供最终文字中心及行边界。 */
import type { Event } from './types';

export interface LyricLine { x0: number; x1: number; verse: number; kind: 'extend' | 'hyphen'; }
interface LyricAnchor { id: string; x: number; widths: number[]; leftAligned?: boolean; }
interface LyricRow { left: number; right: number; notes: LyricAnchor[]; }
export function lyricTextWidth(text: string, fontSize: number): number {
  return Array.from(text).reduce((sum, ch) => sum + (/[^\x00-\xff]|[MWmw@%]/.test(ch) ? 1 : /[A-Z]/.test(ch) ? .8 : .65) * fontSize, 0);
}

export function projectLyricLines(events: Event[], rows: LyricRow[], fontSize: number): LyricLine[][] {
  const result: LyricLine[][] = rows.map(() => []);
  const positions = new Map(rows.flatMap((row, ri) => row.notes.map(n => [n.id, { ...n, row: ri }] as const)));
  type Position = NonNullable<ReturnType<typeof positions.get>>;
  const verses = Math.max(0, ...events.map(e => e.kind === 'note' ? e.lyricLinks?.length ?? 0 : 0));
  const connect = (a: Position, b: Position, verse: number, kind: LyricLine['kind'], fromWord: boolean) => {
    const start = a.x + (fromWord ? (a.widths[verse] ?? 0) * (a.leftAligned ? 1 : .5) + .18 * fontSize : a.leftAligned ? .5 * fontSize : 0);
    const end = b.x + (kind === 'extend' ? (b.leftAligned ? .85 : .35) * fontSize : -(b.leftAligned ? 0 : (b.widths[verse] ?? 0) / 2) - .18 * fontSize);
    for (let row = a.row; row <= b.row; row++) {
      const x0 = row === a.row ? start : rows[row].left;
      const x1 = row === b.row ? end : rows[row].right;
      if (x1 > x0) result[row].push({ x0, x1, verse, kind });
    }
  };
  for (let verse = 0; verse < verses; verse++) {
    let previous: { at: Position; word: boolean } | null = null;
    let hyphen: Position | null = null;
    for (const event of events) {
      if (event.kind === 'rest') { previous = null; hyphen = null; }
      if (event.kind !== 'note') continue;
      const at = positions.get(event.id);
      if (!at) { previous = null; hyphen = null; continue; }
      const word = event.lyrics?.[verse] ?? '';
      const link = event.lyricLinks?.[verse];
      if (word) {
        if (hyphen) connect(hyphen, at, verse, 'hyphen', true);
        hyphen = link === 'hyphen' ? at : null;
        previous = { at, word: true };
      } else if (link === 'extend' && previous) {
        connect(previous.at, at, verse, 'extend', previous.word);
        previous = { at, word: false };
        hyphen = null;
      } else previous = null;
    }
  }
  return result;
}

export function paintLyricLines(ctx: CanvasRenderingContext2D, lines: LyricLine[] | undefined, y: (verse: number) => number, fontSize: number): void {
  if (!lines?.length) return;
  ctx.save();
  ctx.lineWidth = Math.max(.9, fontSize * .065);
  ctx.beginPath();
  for (const line of lines) {
    if (line.kind === 'extend') {
      ctx.moveTo(line.x0, y(line.verse) + fontSize * .4);
      ctx.lineTo(line.x1, y(line.verse) + fontSize * .4);
    } else {
      const width = line.x1 - line.x0;
      if (width < fontSize * .25) continue;
      const count = Math.max(1, Math.ceil(width / (fontSize * 2.8)));
      const dash = Math.min(fontSize * .45, width * .65 / count);
      for (let i = 0; i < count; i++) {
        const x = line.x0 + width * (i + .5) / count;
        ctx.moveTo(x - dash / 2, y(line.verse)); ctx.lineTo(x + dash / 2, y(line.verse));
      }
    }
  }
  ctx.stroke(); ctx.restore();
}
