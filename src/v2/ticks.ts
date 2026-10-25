/**
 * 时间单位（M0-2）：一律用整数 tick，杜绝浮点累积误差。
 *
 * 6720 = 2^6 × 3 × 5 × 7，能被 1/2/3/4/5/6/7/8 整除：
 *   - 覆盖简谱全部常见时值（整拍、附点、增时线）
 *   - 关键：能精确表示 3/5/6/7 连音成员（1/3 = 2240、1/5 = 1344、1/6 = 1120、1/7 = 960）
 *   - 三十二分音符（840）的附点/复附点仍是整数（1260 / 1470），序列化可无损还原
 *
 * 早先这里用 48（= 16×3），只能精确表示 3/6 连音；五连音需要 1/5 拍 = 9.6 tick，
 * 数学上无整数解，所以把精度提到 6720。落盘格式是 DSL 文本（/n 记号不变），
 * 老谱零迁移：同样的 /3 文本，解析出的 tick 变大但相对关系不变。
 */

/** 一拍 = 6720 tick */
export const TICKS_PER_BEAT = 6720;

/** 一拍的默认像素宽度（px）：旧 48 tick × 1.3 px/tick = 62.4，改精度后视觉完全一致 */
export const PX_PER_BEAT_DEFAULT = 62.4;

/** 常用时值（spec §4 表） */
export const DURATION_TICKS = {
  whole: 26880,
  half: 13440,
  quarter: 6720,
  eighth: 3360,
  sixteenth: 1680,
  thirtySecond: 840,
  /** 1/3 拍，三连音成员 */
  tripletThird: 2240,
  /** 1/5 拍，五连音成员 */
  quintupletFifth: 1344,
  /** 1/6 拍，六连音成员 */
  sextupletSixth: 1120,
  /** 1/7 拍，七连音成员 */
  septupletSeventh: 960,
} as const;

/**
 * DSL 除法记号 /n → tick，一律 TICKS_PER_BEAT/n。
 * /3 = 2240 是三连音成员，/5 = 1344 五连音，/6 = 1120 六连音，/7 = 960 七连音。
 */
export const DIVISION_TICKS: Record<number, number> = {
  1: 6720,
  2: 3360,
  3: 2240,
  4: 1680,
  5: 1344,
  6: 1120,
  7: 960,
  8: 840,
};

/** tick → DSL 除法记号 */
export const TICK_DIVISIONS: Record<number, number> = {
  6720: 1,
  3360: 2,
  2240: 3,
  1680: 4,
  1344: 5,
  1120: 6,
  960: 7,
  840: 8,
};

const BASE_DURATIONS = [26880, 13440, 6720, 3360, 1680, 840];

/** 附点时值：dot=1 → ×1.5，dot=2 → ×1.75（6720 精度下全是整数，无取整误差） */
export function withDots(base: number, dots: 0 | 1 | 2): number {
  if (dots === 0) return base;
  return Math.round(base * (dots === 1 ? 1.5 : 1.75));
}

/**
 * 合法 tick 集合（不变量 I4 的判据）：
 * 各基础时值（含复附点）+ 连音成员（3/5/6/7 连音）。
 */
export const LEGAL_TICKS: number[] = (() => {
  const set = new Set<number>();
  for (const b of BASE_DURATIONS) {
    for (const d of [0, 1, 2] as const) set.add(withDots(b, d));
  }
  set.add(DURATION_TICKS.tripletThird);
  set.add(DURATION_TICKS.quintupletFifth);
  set.add(DURATION_TICKS.sextupletSixth);
  set.add(DURATION_TICKS.septupletSeventh);
  return [...set].sort((a, b) => a - b);
})();

const LEGAL_SET = new Set(LEGAL_TICKS);

export function isLegalTick(t: number): boolean {
  return LEGAL_SET.has(t);
}

export interface DurationTier {
  label: string;
  ticks: number;
}

/**
 * 时值档位：选区总时值的候选。
 *
 * 必须包含 3 拍——它靠增时线写出来（`1--`），如果档位表里没有，
 * 这种长音一旦选中就再也改不回去了。但上限是小节本身：
 * 2/4 里不该出现「3 拍」「4 拍」的按钮，一个小节装不下它。
 * 「1 小节」只在它不等于任何整拍档时才单独补一档（如 3/4 的 3/4 拍）。
 */
export function durationTiers(measureTicks: number): DurationTier[] {
  const list: DurationTier[] = [4, 3, 2, 1, 0.5, 0.25, 0.125]
    .map((b) => ({
      label: Number.isInteger(b) ? `${b} 拍` : `1/${Math.round(1 / b)} 拍`,
      ticks: Math.round(b * TICKS_PER_BEAT),
    }))
    .filter((t) => t.ticks <= measureTicks);
  if (measureTicks > 0 && !list.some((t) => t.ticks === measureTicks)) {
    list.unshift({ label: '1 小节', ticks: measureTicks });
  }
  return list;
}

/**
 * 减时线条数。
 * 非 2 的幂（如三连音 2240 tick）返回 0，由 BeatGroup.tuplet 决定「组内画线 + 标号 n」。
 */
/**
 * 去掉附点后的时值：`2..`（2940 tick）→ 1680（十六分）。
 * 档位按钮的点亮判断用它——「2..」的档位是十六分那颗，附点由附点行单独表达。
 */
export function undotTicks(ticks: number, dot: 0 | 1 | 2): number {
  const factor = dot === 1 ? 1.5 : dot === 2 ? 1.75 : 1;
  return Math.round(ticks / factor);
}

export function beamCount(ticks: number): number {  if (ticks <= 0 || ticks >= TICKS_PER_BEAT) return 0;
  const ratio = TICKS_PER_BEAT / ticks;
  if (!Number.isInteger(ratio)) return 0;
  const n = Math.log2(ratio);
  return Number.isInteger(n) ? n : 0;
}

/**
 * 连音组的减时线条数。
 *
 * 连音的每个音自己不是 2 的幂（3 连音占 1 拍时每音 2240 tick），
 * 直接拿它算 beamCount 会得 0——但谱面上连音明明带着减时线和标号 n。
 *
 * 级别按「这组连音顶替的常规音符」定：n 连音顶替 2^⌊log₂n⌋ 个常规音，
 *   3 连音占 1 拍   → 顶替 2 个八分   → 1 条线
 *   3 连音占半拍   → 顶替 2 个十六分 → 2 条线
 *   6 连音占 1 拍   → 顶替 4 个十六分 → 2 条线
 *   5 / 7 连音占 1 拍 → 顶替 4 个十六分 → 2 条线
 *   3 连音占 2 拍   → 顶替 2 个四分   → 0 条线（只有标号）
 */
export function tupletBeamCount(totalTicks: number, n: number): number {
  if (n <= 1 || totalTicks <= 0) return 0;
  const replaced = 2 ** Math.floor(Math.log2(n));
  return beamCount(Math.floor(totalTicks / replaced));
}
