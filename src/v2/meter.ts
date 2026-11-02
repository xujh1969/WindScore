import type { Score } from './types';
import { TICKS_PER_BEAT } from './ticks';

/** 单段拍号："6/8" 这种分子/分母形式 */
export interface MeterSegment {
  num: number;
  den: number;
}

const SEG_RE = /^([1-9]\d*)\/(1|2|4|8|16|32)$/;

/**
 * 解析拍号串为段列表：
 *   - "4/4"          → [{4,4}]
 *   - "6/8+9/8"      → [{6,8},{9,8}]（混合拍/第二节拍，GB/T 46845 §5.3 拍号并排写法）
 *   - 非法/旧遗留值   → null
 */
export function parseMeter(value: string): MeterSegment[] | null {
  if (!value) return null;
  const segs: MeterSegment[] = [];
  for (const part of value.split('+')) {
    const m = SEG_RE.exec(part.trim());
    if (!m || Number(m[1]) > 32) return null;
    segs.push({ num: Number(m[1]), den: Number(m[2]) });
  }
  return segs.length ? segs : null;
}

export function validMeter(value: string): boolean {
  return parseMeter(value) !== null;
}

/** 一小节的拍数（四分 = 1 拍口径）：混合拍 = 各段之和（6/8+9/8 = 3 + 4½ = 7½ 拍） */
export function beatsPerMeasure(beat: string): number {
  const segs = parseMeter(beat);
  if (!segs) {
    // 旧遗留值兜底（不该出现，但不炸）
    const [n, d] = beat.split('/').map(Number);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 4;
    return n * (4 / d);
  }
  return segs.reduce((a, s) => a + s.num * (4 / s.den), 0);
}

export function meterAt(score: Score, index: number): string {
  let beat = score.meta.beat;
  for (let i = 0; i < index; i++) {
    const e = score.events[i];
    if (e.kind === 'barline' && e.beatAfter) beat = e.beatAfter;
  }
  return beat;
}

/**
 * 连通分组单位（一个减时线组允许的总时值上限，口径A：四分 = 1 拍）。
 *
 * 依据《简谱音值组合对照手册（常见拍子）》§2/§4/§7：
 *   - 2/4、3/4、4/4、2/2：单拍子，边界 1 拍（2/2 习惯上也以四分为单位连通）
 *   - 6/8、9/8、12/8：复拍子，边界 = 1 大拍 = 3 个八分 = 1½ 拍
 *   - 3/8：连通边界就是小节本身 = 3 个八分 = 1½ 拍
 *   - 6/4：复拍子，边界 = 1 大拍 = 3 个四分 = 3 拍
 *   - 混合拍（6/8+9/8 这类 N/M+N/M）：各段全是复拍子（分母 8、分子 6/9/12）时
 *     大拍仍是 1½ 拍，边界统一；否则暂按 1 拍（混合单拍子的分组方案待小节线注记落地）
 */
export function groupTicks(beat: string): number {
  if (beat === '3/8') return Math.round(TICKS_PER_BEAT * 1.5);
  const m = /^(\d+)\/(2|4|8|16)$/.exec(beat);
  if (m && [6, 9, 12].includes(Number(m[1]))) {
    // 大拍 = 3 个基础音符；基础音符按时值分母换算成口径A拍数（四分 = 1 拍）
    const base = { 2: 2, 4: 1, 8: 0.5, 16: 0.25 }[Number(m[2]) as 2 | 4 | 8 | 16];
    return Math.round(TICKS_PER_BEAT * base * 3);
  }
  // 混合拍：全段复拍子 → 大拍 1½ 拍
  const segs = parseMeter(beat);
  if (segs && segs.length > 1 && segs.every((s) => s.den === 8 && [6, 9, 12].includes(s.num))) {
    return Math.round(TICKS_PER_BEAT * 1.5);
  }
  return TICKS_PER_BEAT;
}

/**
 * 该拍子里**允许共用减时线的组合总时值**（拍数，口径A），手册 §7 速查表：
 *   - 2 分体系（单拍子）：对半细分 —— 1、½、¼、⅛ 拍
 *   - 3 分体系（复拍子）：大拍的 1、⅔、½、⅓、¼ ——
 *     6/8 系即 1½、1、¾、½、3/8 拍；6/4 即 3、2、1½、1、¾ 拍
 * 某个音数能不能凑成某档由 candidatesFor 判断，这里只给「档位表」。
 */
export function groupTierBeats(beat: string): number[] {
  const unit = groupTicks(beat) / TICKS_PER_BEAT;
  if (unit === 1) return [1, 0.5, 0.25, 0.125];
  return [unit, (unit * 2) / 3, unit / 2, unit / 3, unit / 4];
}
