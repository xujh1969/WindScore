/**
 * 音频转录 → 简谱的纯逻辑层（实验功能「听音成谱」的核心）。
 *
 * 链路：Basic Pitch 输出的原始音符（秒 + MIDI 音高）
 *   1. reduceToMelody  多音轨 → 单旋律（按音量贪心占据时间轴）
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
  /** 0-1，识别模型给出的强度 */
  amp: number;
}

export interface GridNote {
  /** 以 tick 计（48 tick = 1 拍），起点落在 1/16 网格上 */
  startTick: number;
  durTicks: number;
  midi: number;
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
  const ticksPerSec = (bpm / 60) * TICKS_PER_BEAT;
  const sixteenth = TICKS_PER_BEAT / 4;
  const snap = (sec: number): number => Math.round((sec * ticksPerSec) / sixteenth) * sixteenth;
  return reduceToMelody(raw).map((n) => {
    const startTick = Math.max(0, snap(n.start - offsetSec));
    const endTick = Math.max(startTick + sixteenth, snap(n.end - offsetSec));
    return { startTick, durTicks: endTick - startTick, midi: n.midi };
  });
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
 * 剖面做相关，取最匹配的主音。纯统计、无 AI，消除用户填错调号这个
 * 最大的错误源。
 */
export function detectKey(raw: RawNote[]): string {
  const pc = new Array<number>(12).fill(0);
  for (const n of raw) pc[((n.midi % 12) + 12) % 12] += Math.max(0.01, n.end - n.start);
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

/** 单个音符 → DSL 记号（时值就近吸附到简谱能表达的档位，误差交给人工修） */
export function noteToken(midi: number, durTicks: number, key: string): string {
  const { deg, oct, acc } = midiToSyllable(midi, key);
  let base = deg;
  if (acc) base = acc + base;
  if (oct > 0) base += '^'.repeat(oct);
  if (oct < 0) base += 'v'.repeat(-oct);
  const b = durTicks / TICKS_PER_BEAT;
  if (b <= 0.375) return `${base}/4`; // 十六分
  if (b <= 0.71) return `${base}/2`; // 八分
  if (b <= 1.25) return base; // 四分
  if (b <= 1.75) return `${base}.`; // 附点四分
  const beats = Math.max(2, Math.round(b));
  return base + '-'.repeat(beats - 1); // 增时线
}

/**
 * 网格音符 → 每小节一行 DSL 文本。
 * 一拍内 ≥2 个音的包成 <...> 拍组；跨小节的音在小节线处截断（v1 取舍，人工接续音线）；
 * 空拍 / 空小节补 0 休止。
 */
export function measuresToLines(
  notes: GridNote[],
  beatsPerMeasure: number,
  key: string,
): string[] {
  const measureTicks = beatsPerMeasure * TICKS_PER_BEAT;
  const lastEnd = notes.reduce((a, n) => Math.max(a, n.startTick + n.durTicks), 0);
  const count = Math.max(1, Math.ceil(lastEnd / measureTicks));
  const lines: string[] = [];
  for (let m = 0; m < count; m += 1) {
    const from = m * measureTicks;
    const inM = notes
      .filter((n) => n.startTick >= from && n.startTick < from + measureTicks)
      .map((n) => ({ ...n, durTicks: Math.min(n.durTicks, from + measureTicks - n.startTick) }));
    if (inM.length === 0) {
      lines.push(Array(beatsPerMeasure).fill('0').join(' '));
      continue;
    }
    const beats: GridNote[][] = Array.from({ length: beatsPerMeasure }, () => []);
    for (const n of inM) {
      const bi = Math.min(beatsPerMeasure - 1, Math.floor((n.startTick - from) / TICKS_PER_BEAT));
      beats[bi].push(n);
    }
    const toks: string[] = [];
    for (const group of beats) {
      if (group.length === 0) {
        toks.push('0');
      } else if (group.length === 1) {
        toks.push(noteToken(group[0].midi, group[0].durTicks, key));
      } else {
        toks.push(`<${group.map((n) => noteToken(n.midi, n.durTicks, key)).join(' ')}>`);
      }
    }
    lines.push(toks.join(' '));
  }
  return lines;
}
