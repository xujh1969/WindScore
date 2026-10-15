/** 不占额外拍位的倚音几何。小音符仍使用主谱表的音高格距。 */
import type { GlyphMetrics } from './layout';
import { staffGraceInk } from './staffInk';
import { type StaffClef, type StaffInstrument, type StaffPitchMode } from './pitch';
import type { GraceNote } from './types';

export interface StaffGraceNote {
  x: number;
  y: number;
  step: number;
  accMark: string;
}
export interface StaffGraceGroup {
  hostId: string;
  side: 'before' | 'after';
  notes: StaffGraceNote[];
  beamY: number;
  hostX: number;
  hostY: number;
  arcY: number;
  arc: { x0: number; y0: number; x1: number; y1: number; controlY0: number; controlY1: number };
  gray?: boolean;
}

export function placeStaffGrace(notes: GraceNote[], side: 'before' | 'after', hostId: string,
  hostX: number, hostY: number, lineY: number, sp: number, glyph: GlyphMetrics,
  key: string, mode: StaffPitchMode, instrument: StaffInstrument | undefined, clef: StaffClef,
  state: Map<string, number>, gray?: boolean, hostAccW = 0): StaffGraceGroup {
  const ink = staffGraceInk(notes, glyph, key, mode, instrument, state);
  const firstX = side === 'before'
    ? hostX - ink.width - glyph.graceGap - hostAccW
    : hostX + sp * 1.5;
  const placed = ink.notes.map(({ pitch: p, accMark, x }) => {
    const step = p.step + 7 * p.octave - 30 + (clef === 'bass' ? 12 : 0);
    return { x: firstX + x, y: lineY + 2 * sp - step * sp / 2, step, accMark };
  });
  const from = side === 'before' ? placed[0] : { x: hostX, y: hostY };
  const to = side === 'before' ? { x: hostX, y: hostY } : placed[placed.length - 1];
  const x0 = from.x + sp * .3, x1 = to.x - sp * .3;
  const y0 = from.y + sp * .6, y1 = to.y + sp * .6;
  let height = Math.min(sp * .8, Math.max(0, x1 - x0) * .12);
  for (const n of placed) {
    const t = (n.x - x0) / (x1 - x0);
    if (t <= 0 || t >= 1) continue;
    height = Math.max(height, (n.y + sp * .55 - (y0 + (y1 - y0) * t)) / (4 * t * (1 - t)));
  }
  const arc = { x0, y0, x1, y1, controlY0: y0 + (y1 - y0) / 3 + height * 4 / 3,
    controlY1: y0 + (y1 - y0) * 2 / 3 + height * 4 / 3 };
  return { hostId, side, notes: placed, hostX, hostY, arc,
    beamY: Math.min(...placed.map(n => n.y)) - sp * 2.4,
    arcY: Math.max(y0, y1, arc.controlY0, arc.controlY1),
    gray };
}
