/** 音高真值与音名拼写。旧简谱始终按既有实际音高解释。 */
import type { Accidental } from './types';

const LETTERS = 'CDEFGAB';
const NATURAL = [0, 2, 4, 5, 7, 9, 11];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export type StaffPitchMode = 'concert' | 'transposed';
export type StaffClef = 'treble' | 'bass';
export type StaffClefSetting = StaffClef | 'auto';
export interface SpelledPitch { step: number; alter: number; octave: number }
export const STAFF_INSTRUMENTS = [
  { id: 'concert', label: 'C 调（无移调）', diatonic: 0, chromatic: 0 },
  { id: 'clarinet-bb', label: 'B♭ 单簧管', diatonic: -1, chromatic: -2 },
  { id: 'tenor-sax-bb', label: 'B♭ 次中音萨克斯', diatonic: -8, chromatic: -14 },
  { id: 'alto-sax-eb', label: 'E♭ 中音萨克斯', diatonic: -5, chromatic: -9 },
] as const;
export type StaffInstrument = typeof STAFF_INSTRUMENTS[number]['id'];
export function isStaffInstrument(value: string): value is StaffInstrument {
  return STAFF_INSTRUMENTS.some(p => p.id === value);
}
export function instrumentOf(id?: StaffInstrument) {
  return STAFF_INSTRUMENTS.find(p => p.id === id) ?? STAFF_INSTRUMENTS[0];
}

export function accidentalOffset(acc?: Accidental): number {
  // 重升 +2 / 重降 -2（GB/T 46845—2025 §6.2.5.1 五种变音号）
  return acc === '#' ? 1 : acc === 'x' ? 2 : acc === 'b' ? -1 : acc === 'bb' ? -2 : 0;
}

/**
 * 调号字符串 → 主音音名 / 偏移 的缓存。
 * 这两个函数用正则解析 `1=G` 这类文本，而它们在排版里是**每颗音**都要调几次
 * （音高、临时变音、调号…）。实测 2000 小节的谱上这两处连同正则吃掉三成以上
 * CPU——全曲调号就那么几个，缓存一次即可（key 字符串是不可变的，安全）。
 */
const TONIC_CACHE = new Map<string, SpelledPitch>();
const OFFSET_CACHE = new Map<string, number>();

/** 保留旧行为：主音落在离 C4 最近的八度，G 为 G3。 */
export function keyOffset(key: string): number {
  const cached = OFFSET_CACHE.get(key);
  if (cached !== undefined) return cached;
  const body = /1\s*=\s*(.+)$/.exec(key)?.[1] ?? key;
  const m = /^\s*([#b♯♭]?)\s*([A-Ga-g])\s*([#b♯♭]?)/.exec(body);
  if (!m) {
    OFFSET_CACHE.set(key, 0);
    return 0;
  }
  const base: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const acc = (c: string) => (c === '#' || c === '♯' ? 1 : c === 'b' || c === '♭' ? -1 : 0);
  const off = (base[m[2].toLowerCase()] ?? 0) + acc(m[1]) + acc(m[3]);
  const out = off > 6 ? off - 12 : off;
  OFFSET_CACHE.set(key, out);
  return out;
}
export function toMidi(degree: number, octave: number, key: string, accidental?: Accidental): number {
  return 60 + MAJOR[degree - 1] + keyOffset(key) + octave * 12 + accidentalOffset(accidental);
}
export function pitchMidi(p: SpelledPitch): number {
  return 12 * (p.octave + 1) + NATURAL[p.step] + p.alter;
}
export function keyTonic(key: string): SpelledPitch {
  const cached = TONIC_CACHE.get(key);
  if (cached) return cached;
  const body = key.replace(/^\s*1\s*=\s*/, '');
  const m = /^\s*([#b♯♭]{0,2})([A-Ga-g])([#b♯♭]{0,2})\s*$/.exec(body);
  if (!m) {
    const fallback: SpelledPitch = { step: 0, alter: 0, octave: 4 };
    TONIC_CACHE.set(key, fallback);
    return fallback;
  }
  const mark = m[1] || m[3];
  const out: SpelledPitch = {
    step: LETTERS.indexOf(m[2].toUpperCase()),
    alter: /[#♯]/.test(mark) ? mark.length : /[b♭]/.test(mark) ? -mark.length : 0,
    octave: 4,
  };
  TONIC_CACHE.set(key, out);
  return out;
}
export function legacyPitch(degree: number, octave: number, key: string, accidental?: Accidental): SpelledPitch {
  const step = (keyTonic(key).step + degree - 1) % 7;
  const midi = toMidi(degree, octave, key, accidental);
  const oct = Math.round((midi - 12 - NATURAL[step]) / 12);
  return { step, octave: oct, alter: midi - (12 * (oct + 1) + NATURAL[step]) };
}
export function transposePitch(p: SpelledPitch, diatonic: number, chromatic: number): SpelledPitch {
  const absolute = p.octave * 7 + p.step + diatonic;
  const octave = Math.floor(absolute / 7);
  const step = ((absolute % 7) + 7) % 7;
  return { step, octave, alter: pitchMidi(p) + chromatic - (12 * (octave + 1) + NATURAL[step]) };
}
export function writtenPitch(p: SpelledPitch, mode: StaffPitchMode, instrument?: StaffInstrument): SpelledPitch {
  const t = instrumentOf(instrument);
  return mode === 'concert' ? p : transposePitch(p, -t.diatonic, -t.chromatic);
}
export function writtenKey(key: string, mode: StaffPitchMode, instrument?: StaffInstrument): string {
  const p = writtenPitch(keyTonic(key), mode, instrument);
  return `1=${(p.alter > 0 ? '#' : 'b').repeat(Math.abs(p.alter))}${LETTERS[p.step]}`;
}
export function keyFifths(key: string): number {
  const p = keyTonic(key);
  const fifths = [0, 2, 4, -1, 1, 3, 5][p.step] + p.alter * 7;
  return fifths;
}
export function keyAlter(key: string, step: number): number {
  const t = keyTonic(key);
  const degree = (step - t.step + 7) % 7;
  const diatonic = t.step + degree;
  const natural = NATURAL[step] + (diatonic >= 7 ? 12 : 0);
  return NATURAL[t.step] + t.alter + MAJOR[degree] - natural;
}
export function accidentalGlyph(alter: number): string {
  if (alter === 0) return '♮';
  if (alter === 2) return '𝄪';
  if (alter === -2) return '𝄫';
  return (alter > 0 ? '♯' : '♭').repeat(Math.abs(alter));
}
