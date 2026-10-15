/** Staff-only horizontal ink estimates; no Canvas or playback dependency. */
import type { GlyphMetrics } from './layout';
import { accidentalGlyph, keyAlter, legacyPitch, writtenKey, writtenPitch, type StaffInstrument, type StaffPitchMode } from './pitch';
import type { GraceNote, Score } from './types';

export function staffAccWidth(mark: string, sp: number, grace = false): number {
  if (!mark) return 0;
  const count = mark === '𝄪' || mark === '𝄫' ? 1.4 : Array.from(mark).length;
  return sp * ((grace ? 1.05 : 1.45) * count + .25);
}

export function staffGraceInk(notes: GraceNote[], glyph: GlyphMetrics, key: string,
  mode: StaffPitchMode, instrument: StaffInstrument | undefined, state: Map<string, number>) {
  const sp = Math.max(6, glyph.fontSize / 2.8);
  const pitchKey = writtenKey(key, mode, instrument);
  let width = 0;
  const placed = notes.map(note => {
    const pitch = writtenPitch(legacyPitch(note.degree, note.octave, key, note.accidental), mode, instrument);
    const identity = `${pitch.step}:${pitch.octave}`;
    const old = state.get(identity) ?? keyAlter(pitchKey, pitch.step);
    const accMark = old === pitch.alter ? '' : accidentalGlyph(pitch.alter);
    state.set(identity, pitch.alter);
    const accW = staffAccWidth(accMark, sp, true);
    const x = width + accW + glyph.graceW * .35;
    width += glyph.graceW + accW;
    return { pitch, accMark, x };
  });
  return { notes: placed, width };
}

export interface StaffEventInk { accW: number; before: number; after: number; }

export function measureStaffInk(score: Score, glyph: GlyphMetrics, mode: StaffPitchMode): Map<string, StaffEventInk> {
  const instrument = score.part?.staffInstrument;
  const sp = Math.max(6, glyph.fontSize / 2.8);
  const pitches = new Map<string, ReturnType<typeof writtenPitch>>();
  let key = score.meta.key;
  for (const event of score.events) {
    if (event.kind !== 'note') continue;
    key = event.keyChange ?? key;
    pitches.set(event.id, writtenPitch(legacyPitch(event.degree, event.octave, key, event.accidental), mode, instrument));
  }
  const tiedInto = new Set<string>();
  for (const event of score.events) {
    if (event.kind !== 'note') continue;
    const from = pitches.get(event.id)!;
    for (const tie of event.ties ?? []) {
      const to = pitches.get(tie.to);
      if (tie.kind === 'tie' && to && from.step === to.step && from.octave === to.octave && from.alter === to.alter) tiedInto.add(tie.to);
    }
  }
  const result = new Map<string, StaffEventInk>();
  const state = new Map<string, number>();
  key = score.meta.key;
  for (const event of score.events) {
    if (event.kind === 'barline') state.clear();
    if (event.kind !== 'note') continue;
    if (event.keyChange) { key = event.keyChange; state.clear(); }
    const before = staffGraceInk(event.graceBefore ?? [], glyph, key, mode, instrument, state).width;
    const pitch = pitches.get(event.id)!;
    const identity = `${pitch.step}:${pitch.octave}`;
    const old = state.get(identity) ?? keyAlter(writtenKey(key, mode, instrument), pitch.step);
    const mark = tiedInto.has(event.id) || old === pitch.alter && event.accidental !== '♮' ? '' : accidentalGlyph(pitch.alter);
    if (!tiedInto.has(event.id)) state.set(identity, pitch.alter);
    const after = staffGraceInk(event.graceAfter ?? [], glyph, key, mode, instrument, state).width;
    result.set(event.id, { accW: staffAccWidth(mark, sp), before: before ? before + glyph.graceGap : 0,
      after: after ? after + sp * 1.5 : 0 });
  }
  return result;
}
