/**
 * 时间单位（M0-2）：一律用整数 tick，杜绝浮点累积误差。
 * 48 = 16 × 3，能被 1/2/3/4/6/8/12/16 整除，覆盖简谱全部常见时值，
 * 关键是能精确表示三连音（1/3 拍 = 16 tick）。
 */

export const TICKS_PER_BEAT = 48;

/** 常用时值（spec §4 表） */
export const DURATION_TICKS = {
  whole: 192,
  half: 96,
  quarter: 48,
  eighth: 24,
  sixteenth: 12,
  thirtySecond: 6,
  /** 1/3 拍，三连音成员 */
  tripletThird: 16,
  /** 1/6 拍，六连音成员 */
  sextupletSixth: 8,
} as const;

/**
 * DSL 除法记号 /n → tick，一律 48/n。
 * /3 = 16 是三连音成员，/6 = 8 是六连音成员。
 */
export const DIVISION_TICKS: Record<number, number> = {
  1: 48,
  2: 24,
  3: 16,
  4: 12,
  6: 8,
  8: 6,
};

/** tick → DSL 除法记号 */
export const TICK_DIVISIONS: Record<number, number> = {
  48: 1,
  24: 2,
  16: 3,
  12: 4,
  8: 6,
  6: 8,
};

const BASE_DURATIONS = [192, 96, 48, 24, 12, 6];

/** 附点时值：dot=1 → ×1.5，dot=2 → ×1.75 */
export function withDots(base: number, dots: 0 | 1 | 2): number {
  if (dots === 0) return base;
  return Math.round(base * (dots === 1 ? 1.5 : 1.75));
}

/**
 * 合法 tick 集合（不变量 I4 的判据）：
 * 各基础时值（含复附点）+ 连音成员（三连音 16、六连音 8）。
 */
export const LEGAL_TICKS: number[] = (() => {
  const set = new Set<number>();
  for (const b of BASE_DURATIONS) {
    for (const d of [0, 1, 2] as const) set.add(withDots(b, d));
  }
  set.add(DURATION_TICKS.tripletThird);
  set.add(DURATION_TICKS.sextupletSixth);
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
 * 「1 小节」只在它不等于任何整拍档时才单独补一档（如 3/4 的 72 tick）。
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
 * 非 2 的幂（如三连音 16 tick）返回 0，由 BeatGroup.tuplet 决定「组内画线 + 标号 n」。
 */
/**
 * 去掉附点后的时值：`2..`（21 tick）→ 12（八分）。
 * 档位按钮的点亮判断用它——「2..」的档位是八分那颗，附点由附点行单独表达。
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
 * 连音的每个音自己不是 2 的幂（3 连音占 1 拍时每音 16 tick），
 * 直接拿它算 beamCount 会得 0——但谱面上连音明明带着减时线和标号 n。
 *
 * 级别按「这组连音顶替的常规音符」定：n 连音顶替 2^⌊log₂n⌋ 个常规音，
 *   3 连音占 1 拍   → 顶替 2 个八分   → 1 条线
 *   3 连音占半拍   → 顶替 2 个十六分 → 2 条线
 *   6 连音占 1 拍   → 顶替 4 个十六分 → 2 条线
 *   3 连音占 2 拍   → 顶替 2 个四分   → 0 条线（只有标号）
 */
export function tupletBeamCount(totalTicks: number, n: number): number {
  if (n <= 1 || totalTicks <= 0) return 0;
  const replaced = 2 ** Math.floor(Math.log2(n));
  return beamCount(Math.floor(totalTicks / replaced));
}
