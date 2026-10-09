/**
 * 音频转录 → 简谱的纯逻辑层（实验功能「听音成谱」的核心）。
 *
 * 链路：GAME 输出的原始音符（秒 + MIDI 音高）
 *   1. 读取专用人声模型输出的单声部音符，不按音量重新挑旋律
 *   2. quantizeNotes   按用户标定的 BPM 量化到 1/16 网格（确定性算法，节奏不靠猜）
 *   3. midiToSyllable  MIDI 绝对音高 → 首调唱名（1=X 的相对音级 + 八度点 + 变化音）
 *   4. measuresToText  网格音符 → 每小节 DSL 文本（减时线 / 附点 / 增时线 / 拍组）
 *
 * 全部是纯函数，Node 里直接测（scripts/lab-test.ts）。
 */

import { TICKS_PER_BEAT } from '../types';

export interface RawNote {
  /** 秒 */
  start: number;
  end: number;
  /** MIDI 音高（60 = 中央 C） */
  midi: number;
  /** 兼容旧转录数据的强度字段；GAME 不提供此值，固定为 1 */
  amp: number;
  /** 草稿校音时回溯原始音符，不写入谱面 */
  sourceIndex?: number;
  graceBefore?: number[];
  graceSourceIndices?: number[];
}

export interface GridNote {
  /** 以 tick 计（48 tick = 1 拍），起点落在 1/16 网格上 */
  startTick: number;
  durTicks: number;
  midi: number;
  sourceIndex?: number;
  graceBefore?: number[];
  graceSourceIndices?: number[];
}

/** 保守整理前倚音：只收紧邻长主音的短级进音，保留半音与原音高。 */
export function collectGraceNotes(raw: RawNote[], bpm: number): RawNote[] {
  const sorted = [...raw].sort((a, b) => a.start - b.start);
  const out: RawNote[] = [];
  const limit = Math.min(0.12, 60 / bpm / 4);
  for (let i = 0; i < sorted.length; i += 1) {
    const n = sorted[i];
    const next = sorted[i + 1];
    const duration = n.end - n.start;
    const interval = next ? Math.abs(Math.round(next.midi) - Math.round(n.midi)) : 0;
    if (next && duration > 0 && duration <= limit && next.start >= n.start
      && next.start - n.end >= -0.02 && next.start - n.end <= 0.04
      && next.end - next.start >= Math.max(duration * 3, 0.18)
      && interval >= 1 && interval <= 2) {
      out.push({ ...next, start: n.start, graceBefore: [n.midi],
        graceSourceIndices: n.sourceIndex === undefined ? undefined : [n.sourceIndex] });
      i += 1;
    } else out.push({ ...n });
  }
  return out;
}

/** 多 → 单：音量大的音先占据时间轴，后来的音只能落在空隙里（剩太短就丢） */
export function reduceToMelody(raw: RawNote[]): RawNote[] {
  const taken: RawNote[] = [];
  const byAmp = [...raw].sort((a, b) => b.amp - a.amp);
  for (const n of byAmp) {
    let segs: [number, number][] = [[n.start, n.end]];
    for (const t of taken) {
      const next: [number, number][] = [];
      for (const [s, e] of segs) {
        if (t.end <= s || t.start >= e) {
          next.push([s, e]);
          continue;
        }
        if (t.start > s) next.push([s, t.start]);
        if (t.end < e) next.push([t.end, e]);
      }
      segs = next;
    }
    for (const [s, e] of segs) {
      if (e - s >= 0.06) taken.push({ ...n, start: s, end: e });
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** 量化到 1/16 网格。offsetSec = 第一个正拍在音频里的位置（秒），对不齐整谱节奏都会歪 */
export function quantizeNotes(raw: RawNote[], bpm: number, offsetSec: number): GridNote[] {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300 || !Number.isFinite(offsetSec)) {
    throw new Error('速度或首拍位置无效');
  }
  const ticksPerSec = (bpm / 60) * TICKS_PER_BEAT;
  const sixteenth = TICKS_PER_BEAT / 4;
  const snap = (sec: number): number => Math.round((sec * ticksPerSec) / sixteenth) * sixteenth;
  const out: GridNote[] = [];
  for (const n of [...raw].sort((a, b) => a.start - b.start)) {
    if (![n.start, n.end, n.midi].every(Number.isFinite) || n.end <= n.start || n.end <= offsetSec) continue;
    const startTick = Math.max(0, snap(n.start - offsetSec));
    const endTick = Math.max(startTick + sixteenth, snap(n.end - offsetSec));
    const prev = out[out.length - 1];
    // 量化不能制造复音；后一个起音保留，前一个音在起音处结束。
    if (prev && prev.startTick + prev.durTicks > startTick) {
      prev.durTicks = startTick - prev.startTick;
      if (prev.durTicks <= 0) out.pop();
    }
    out.push({ startTick, durTicks: endTick - startTick, midi: Math.round(n.midi),
      ...(n.sourceIndex === undefined ? {} : { sourceIndex: n.sourceIndex }),
      ...(n.graceBefore ? { graceBefore: n.graceBefore.map(Math.round), graceSourceIndices: n.graceSourceIndices } : {}) });
  }
  return out;
}

/** '1=A' / '1=bB' → 主音的音高类（C=0） */
export function keyToTonic(key: string): number {
  const m = /1\s*=\s*([#b]?)([A-G])/i.exec(key.trim());
  if (!m) return 0;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const acc = m[1] === '#' ? 1 : m[1] === 'b' ? -1 : 0;
  return (base[m[2].toUpperCase()] + acc + 12) % 12;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/**
 * 自动调号检测（Krumhansl-Kessler）：时长加权的音高类分布与自然大调
 * 剖面做相关，建议最匹配的大调记谱调号；短片段、转调等仍需人工确认。
 */
export function detectKey(raw: RawNote[]): string {
  const pc = new Array<number>(12).fill(0);
  for (const n of raw) {
    if ([n.midi, n.start, n.end].every(Number.isFinite) && n.end > n.start) {
      pc[((Math.round(n.midi) % 12) + 12) % 12] += n.end - n.start;
    }
  }
  if (pc.reduce((a, b) => a + b, 0) === 0) return '1=C';
  const MY = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const corr = (shift: number): number => {
    // 剖面第 i 档对应主音 + i 半音的音高类
    const x = pc.map((_, i) => pc[(shift + i) % 12]);
    const mx = x.reduce((a, b) => a + b, 0) / 12;
    const my = MY.reduce((a, b) => a + b, 0) / 12;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < 12; i += 1) {
      num += (x[i] - mx) * (MY[i] - my);
      dx += (x[i] - mx) ** 2;
      dy += (MY[i] - my) ** 2;
    }
    return num / (Math.sqrt(dx * dy) || 1);
  };
  let best = 0;
  let bestC = -2;
  for (let s = 0; s < 12; s += 1) {
    const c = corr(s);
    if (c > bestC) {
      bestC = c;
      best = s;
    }
  }
  // 简谱惯例：# 写在字母前（1=#C），keyToTonic 按这个口径解析
  const NAMES = ['C', '#C', 'D', '#D', 'E', 'F', '#F', 'G', '#G', 'A', '#A', 'B'];
  return `1=${NAMES[best]}`;
}

export interface Syllable {
  /** 唱名 1-7 */
  deg: string;
  /** 相对八度：0 = 中音区（不加点），1 = 高音 ^，-1 = 低音 v */
  oct: number;
  /** 变化音记号（落在自然音级之间时往最近的靠，等距取升） */
  acc: '' | '#' | 'b';
}

/** MIDI 绝对音高 → 首调唱名。主音锚在 midi 60-71 之间作为中音区的 1 */
export function midiToSyllable(midi: number, key: string): Syllable {
  const tonic = keyToTonic(key);
  const oct = Math.floor((midi - (tonic + 60)) / 12);
  const pc = (((midi - tonic) % 12) + 12) % 12;
  const idx = MAJOR.indexOf(pc);
  if (idx >= 0) return { deg: String(idx + 1), oct, acc: '' };
  let i = 0;
  while (i < 7 && MAJOR[i] < pc) i += 1;
  const above = MAJOR[i % 7] > pc ? MAJOR[i % 7] : MAJOR[i % 7] + 12;
  const below = MAJOR[(i + 6) % 7];
  if (pc - below <= above - pc) return { deg: String(((i + 6) % 7) + 1), oct, acc: '#' };
  return { deg: String(i + 1), oct, acc: 'b' };
}

/** 单个音符 → 精确 DSL 时值；不将三十六 tick 等附点时值取整。 */
export function noteToken(midi: number, durTicks: number, key: string): string {
  const { deg, oct, acc } = midiToSyllable(midi, key);
  let base = deg;
  if (acc) base = acc + base;
  if (oct > 0) base += '^'.repeat(oct);
  if (oct < 0) base += 'v'.repeat(-oct);
  return base + durationSuffix(durTicks);
}

function durationSuffix(ticks: number): string {
  for (const [base, suffix] of [[48, ''], [24, '/2'], [12, '/4'], [6, '/8']] as const) {
    if (ticks === base) return suffix;
    if (ticks === base * 1.5) return `.${suffix}`;
    if (ticks === base * 1.75) return `..${suffix}`;
  }
  if (ticks > 48 && ticks % 48 === 0) return '-'.repeat(ticks / 48 - 1);
  throw new Error(`无法表达的音符时值：${ticks}`);
}

/** 网格覆盖整个小节；长音在拍/小节边界分片并用延音线连接，空隙补真实休止。 */
export function measuresToLines(
  notes: GridNote[],
  beatsPerMeasure: number,
  key: string,
): string[] {
  const measureTicks = beatsPerMeasure * TICKS_PER_BEAT;
  if (!Number.isInteger(beatsPerMeasure) || beatsPerMeasure < 1 || beatsPerMeasure > 12) {
    throw new Error('不支持的每小节拍数');
  }
  const lastEnd = notes.reduce((a, n) => Math.max(a, n.startTick + n.durTicks), 0);
  const count = Math.max(1, Math.ceil(lastEnd / measureTicks));
  const lines: string[] = [];
  for (let m = 0; m < count; m += 1) {
    const from = m * measureTicks;
    const toks: string[] = [];
    for (let b = 0; b < beatsPerMeasure; b += 1) {
      let at = from + b * TICKS_PER_BEAT;
      const end = at + TICKS_PER_BEAT;
      const group: string[] = [];
      while (at < end) {
        const note = notes.find((n) => n.startTick <= at && n.startTick + n.durTicks > at);
        const next = notes.find((n) => n.startTick > at);
        const until = Math.min(end, note ? note.startTick + note.durTicks : (next?.startTick ?? end));
        // 12/24/36/48 都有精确写法；外部输入也必须落在十六分网格。
        const ticks = until - at;
        const grace = note?.graceBefore?.length && at === note.startTick
          ? `{${note.graceBefore.map((midi) => noteToken(midi, 48, key)).join('')}}` : '';
        const token = note ? grace + noteToken(note.midi, ticks, key) : `0${durationSuffix(ticks)}`;
        group.push(token + (note && until < note.startTick + note.durTicks ? '~' : ''));
        at = until;
      }
      toks.push(group.length > 1 ? `<${group.join(' ')}>` : group[0]);
    }
    lines.push(toks.join(' '));
  }
  return lines;
}
