/**
 * 时刻表（§11）：把扁平事件流算成带绝对时刻的播放序列。
 * 纯函数，可命令行跑（合成音回归测试的第一步就依赖它）。
 *
 * tie 处理（§9.4）：绘制时保留两个音符，播放 / MIDI 时合并成一个长音。
 */

import { TICKS_PER_BEAT } from './ticks';
import type { Accidental, NoteEvent, Score } from './types';

/** 音级 1..7 相对主音的半音数（自然大调音阶） */
const DEGREE_SEMITONE = [0, 2, 4, 5, 7, 9, 11];

export interface TimelineEntry {
  eventId: string;
  startTick: number;
  endTick: number;
  degree: number;
  octave: number;
  /** 合并延音线后的 MIDI 音高；休止符为 null */
  midi: number | null;
  /** 这条是倚音（挂在主音上的装饰音），不是主音本身 */
  grace?: boolean;
}

/**
 * 倚音的演奏时值：简谱里倚音一律记成 1/4 拍（十六分、两条减时线），
 * 所以播放也按 1/4 拍算，从主音时值里切出来（总时长不变，小节拍数不变）。
 * 主音太短时按「主音至少保留一半」压缩，避免倚音把主音吃光。
 */
export const GRACE_TICKS = TICKS_PER_BEAT / 4;

/** 升 / 降 / 还原记号 → 半音偏移。♯♭ 与 #b 同义 */
export function accidentalOffset(acc?: Accidental): number {
  return acc === '#' ? 1 : acc === 'b' ? -1 : 0;
}

/**
 * 记谱调 "1=G" 中，音级 1 相对 C 的半音数。
 *
 * 升降号**写在音名前面**是简谱规范写法（`1=bB`、`1=#F`），
 * 写在后面是英文写法（`1=Bb`、`1=F#`）——两种都认，♯ ♭ 字形也认。
 *
 * 前导 b 有歧义（既可能是降号，也可能是音名 B）：靠正则回溯消解——
 * 能凑成「b + 另一个音名」才算降号，`1=b` 就是 B 本位。
 * 解析不出来返回 0（按 C 调），保留旧有的容错行为。
 */
export function keyOffset(key: string): number {
  const body = /1\s*=\s*(.+)$/.exec(key)?.[1] ?? key;
  const m = /^\s*([#b♯♭]?)\s*([A-Ga-g])\s*([#b♯♭]?)/.exec(body);
  if (!m) return 0;
  const base: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const acc = (c: string) => (c === '#' || c === '♯' ? 1 : c === 'b' || c === '♭' ? -1 : 0);
  return (base[m[2].toLowerCase()] ?? 0) + acc(m[1]) + acc(m[3]);
}

/**
 * 把记谱调统一成简谱规范写法：升降号写在音名前（`1=bB`、`1=#F`）。
 * 认不出来返回 null，由调用方拒绝——脏调号会让 toMidi 静默按 C 调算。
 */
export function normalizeKey(key: string): string | null {
  const m = /^\s*1\s*=\s*([#b♯♭]?)\s*([A-Ga-g])\s*([#b♯♭]?)\s*$/.exec(key);
  if (!m) return null;
  const char = m[1] || m[3];
  const acc = char === '#' || char === '♯' ? '#' : char === 'b' || char === '♭' ? 'b' : '';
  return `1=${acc}${m[2].toUpperCase()}`;
}

/** degree + octave + 变音记号 + 记谱调 → MIDI note number（不做移调，§11） */
export function toMidi(
  degree: number,
  octave: number,
  key: string,
  accidental?: Accidental,
): number {
  const semis =
    DEGREE_SEMITONE[degree - 1] + keyOffset(key) + octave * 12 + accidentalOffset(accidental);
  return 60 + semis;
}

export function buildTimeline(score: Score): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const byId = new Map(score.events.map((e) => [e.id, e]));
  let tick = 0;
  /** 当前生效的调号：遇到带 keyChange 的音符就切换（含该音本身） */
  let curKey = score.meta.key;

  for (const ev of score.events) {
    if (ev.kind !== 'note' && ev.kind !== 'rest') continue; // 小节线 / 换气不占时值

    if (ev.kind === 'rest') {
      out.push({ eventId: ev.id, startTick: tick, endTick: tick + ev.ticks, degree: 0, octave: 0, midi: null });
      tick += ev.ticks;
      continue;
    }

    // 转调：到达这个音符起，后面的音都改用新调（含这个音自己）
    if (ev.keyChange) curKey = ev.keyChange;

    // ── 倚音 ──
    // 不占时值：从主音时值里切。前倚音占开头、后倚音占结尾，主音至少留一半。
    const gBefore = ev.graceBefore ?? [];
    const gAfter = ev.graceAfter ?? [];
    const graceCount = gBefore.length + gAfter.length;
    const each = graceCount > 0 ? Math.min(GRACE_TICKS, Math.floor(ev.ticks / 2 / graceCount)) : 0;
    const beforeTicks = each * gBefore.length;
    const afterTicks = each * gAfter.length;
    if (graceCount > 0) {
      let gs = tick;
      for (const g of gBefore) {
        out.push({
          eventId: ev.id,
          startTick: gs,
          endTick: gs + each,
          degree: g.degree,
          octave: g.octave,
          midi: toMidi(g.degree, g.octave, curKey, g.accidental),
          grace: true,
        });
        gs += each;
      }
      gs = tick + ev.ticks - afterTicks;
      for (const g of gAfter) {
        out.push({
          eventId: ev.id,
          startTick: gs,
          endTick: gs + each,
          degree: g.degree,
          octave: g.octave,
          midi: toMidi(g.degree, g.octave, curKey, g.accidental),
          grace: true,
        });
        gs += each;
      }
    }

    // 延音线 / 弧线：与前一个同音高的长音合并，不再触发 attack——
    // 画了连音线的同音高相邻音要连续演奏，不能变成两个音。
    // 连线记在前一个音上（延音线 DSL 写 5~5；弧线是 toggleSlur 建的 slur），
    // 所以要查 prev 的 outgoing ties。
    const prev = out[out.length - 1];
    const prevNote = prev ? (byId.get(prev.eventId) as NoteEvent | undefined) : undefined;
    const linkedFromPrev = prevNote
      ? (prevNote.ties ?? []).some(
          (t) => (t.kind === 'tie' || t.kind === 'slur') && t.to === ev.id,
        )
      : false;
    if (
      graceCount === 0 && // 带倚音的音要重新起声，不能并进前一个长音
      linkedFromPrev &&
      prev &&
      prev.midi !== null &&
      prev.endTick === tick &&
      prevNote &&
      prevNote.degree === ev.degree &&
      prevNote.octave === ev.octave &&
      (prevNote.accidental ?? '') === (ev.accidental ?? '') && // 变音不同就不是同一个音，不能合并
      // 音高必须真的相同：中间夹了转调（含这个音自己的转调）时，
      // 同样的音级已经落到另一个音高上，再合并就会把转调吞掉——
      // 听感上「这个音开始的转调」变成从下一个音才生效，甚至完全不生效。
      prev.midi === toMidi(ev.degree, ev.octave, curKey, ev.accidental)
    ) {
      prev.endTick = tick + ev.ticks;
      tick += ev.ticks;
      continue;
    }

    // 主音：前倚音占掉开头、后倚音占掉结尾，中间才是主音本身
    out.push({
      eventId: ev.id,
      startTick: tick + beforeTicks,
      endTick: tick + ev.ticks - afterTicks,
      degree: ev.degree,
      octave: ev.octave,
      midi: toMidi(ev.degree, ev.octave, curKey, ev.accidental),
    });
    tick += ev.ticks;
  }

  return out;
}

export function timelineTicks(tl: TimelineEntry[]): number {
  return tl.length ? tl[tl.length - 1].endTick : 0;
}

/**
 * 事件下标 → 该位置对应的 tick。
 * 口径必须与 buildTimeline 一致：只有 note / rest 占时值，
 * 小节线、换气、力度都不推进时间（延音线合并也不改变总量）。
 *
 * 用于「从光标处起播」把插入点换算成起播时刻。
 */
export function tickAtEvent(score: Score, index: number): number {
  const end = Math.min(Math.max(index, 0), score.events.length);
  let tick = 0;
  for (let i = 0; i < end; i += 1) {
    const ev = score.events[i];
    if (ev.kind === 'note' || ev.kind === 'rest') tick += ev.ticks;
  }
  return tick;
}

/** 某一 tick 上正在发声的条目及其内部进度（0..1） */
export function activeAt(
  tl: TimelineEntry[],
  tick: number,
): { entry: TimelineEntry; progress: number } | null {
  for (const e of tl) {
    if (tick >= e.startTick && tick < e.endTick) {
      const span = e.endTick - e.startTick;
      return { entry: e, progress: span > 0 ? (tick - e.startTick) / span : 0 };
    }
  }
  return null;
}

export function tickToBeat(tick: number): number {
  return tick / TICKS_PER_BEAT;
}
