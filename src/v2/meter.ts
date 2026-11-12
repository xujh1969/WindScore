import type { Score } from './types';
import { MAX_TUPLET_SPAN_BEATS, TICKS_PER_BEAT } from './ticks';

/** 单段拍号："6/8" 这种分子/分母形式 */
export interface MeterSegment {
  num: number;
  den: number;
}

const SEG_RE = /^([1-9]\d*)\/(1|2|4|8|16|32)$/;

/**
 * 解析拍号串为段列表：
 *   - "4/4"          → [{4,4}]
 *   - "6/8|9/8"      → [{6,8},{9,8}]（备选拍号/交替拍子：一小节可以是其中**任一段**的拍数，
 *     GB/T 46845 拍号并排印法——不是相加！）
 *   - 兼容旧写法 "+"（曾误作各段相加）：读入仍接受，语义同样按备选
 *   - 非法/旧遗留值   → null
 */
export function parseMeter(value: string): MeterSegment[] | null {
  if (!value) return null;
  const segs: MeterSegment[] = [];
  for (const part of value.split(/[|+]/)) {
    const m = SEG_RE.exec(part.trim());
    if (!m || Number(m[1]) > 32) return null;
    segs.push({ num: Number(m[1]), den: Number(m[2]) });
  }
  return segs.length ? segs : null;
}

export function validMeter(value: string): boolean {
  return parseMeter(value) !== null;
}

/**
 * 各备选拍号的一小节拍数（四分 = 1 拍口径）：交替拍子的小节可以是其中**任何一个**。
 * 小节拍数校验（layout 徽标）用它；拍数满足任一项即正确。
 */
export function meterBeatOptions(beat: string): number[] {
  const segs = parseMeter(beat);
  if (!segs) {
    // 旧遗留值兜底（不该出现，但不炸）
    const [n, d] = beat.split('/').map(Number);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return [4];
    return [n * (4 / d)];
  }
  return segs.map((s) => s.num * (4 / s.den));
}

/**
 * 一小节的拍数（四分 = 1 拍口径）：取**首段**（主拍号）。
 * 供必须给单值的场合用——多小节休止 / 小节反复整小节休止的长度、节拍器小节长、
 * 编辑面板的拍档位。拍数校验不走这里（走 meterBeatOptions 的备选判定）。
 */
export function beatsPerMeasure(beat: string): number {
  return meterBeatOptions(beat)[0] ?? 4;
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
 * 该拍子里的**组合总时值档位**（拍数，口径A）：
 *   - 2 分体系（单拍子）：对半细分 —— 1、½、¼、⅛ 拍
 *   - 3 分体系（复拍子）：大拍的 1、⅔、½、⅓、¼ ——
 *     6/8 系即 1½、1、¾、½、3/8 拍；6/4 即 3、2、1½、1、¾ 拍
 *   - 跨拍连音档：整数拍跨度 2…小节容量（GB/T 46845—2025 §6.3.12 连音符
 *     均分**原时值**，连音号括住整组；§6.3.13 的「减时线不跨单位拍」约束的是
 *     普通减时线组，不是连音组）。**国标没有按拍号限制连音**，所以 4/4 也
 *     给 2/3/4 拍档，可放两拍三连音；跨拍档由 groupCandidates 只放行连音候选。
 * 组不得跨小节线，故上界取小节容量；另设 8 拍运行时上界防止极端拍号
 * （parseMeter 允许分子到 32）铺出几十个档位按钮。
 * 某个音数能不能凑成某档由 candidatesFor 判断，这里只给「档位表」。
 */
export function groupTierBeats(beat: string): number[] {
  const unit = groupTicks(beat) / TICKS_PER_BEAT;
  // 坏拍号兜底：groupTicks/parseMeter 都不抛错，但可能给出非有限值
  if (!Number.isFinite(unit) || unit <= 0) return [1, 0.5, 0.25, 0.125];
  const out = unit === 1
    ? [1, 0.5, 0.25, 0.125]
    : [unit, (unit * 2) / 3, unit / 2, unit / 3, unit / 4];
  const options = meterBeatOptions(beat).filter((b) => Number.isFinite(b) && b > 0);
  const cap = options.length ? Math.max(...options) : 4;
  // 复拍子原有的 4/3 × 大拍档（6/8 → 2 拍、6/4 → 4 拍）。非整数跨度的档
  // 没有可序列化的连音写法，只在恰好是整数拍时保留。
  const wide = (unit * 4) / 3;
  if (Number.isInteger(wide) && wide <= cap + 1e-9 && !out.some((b) => Math.abs(b - wide) < 1e-9)) {
    out.unshift(wide);
  }
  const maxSpan = Math.min(Math.floor(cap + 1e-9), MAX_TUPLET_SPAN_BEATS);
  const extra: number[] = [];
  for (let s = 2; s <= maxSpan; s += 1) {
    if (Number.isFinite(s) && !out.some((b) => Math.abs(b - s) < 1e-9)) extra.push(s);
  }
  // 档位按从大到小摆放，新增的整数拍档补在最前
  return [...extra.reverse(), ...out];
}
