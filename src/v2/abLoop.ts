/**
 * AB 点循环播放：区间判定与回绕换算（纯函数，播放内核 / UI / 测试共用）。
 *
 * A、B 一律存**绝对 tick**，不存事件 id：谱面展开反复后同一个 id 会出现多份克隆
 * （`n12~2`），存 id 分不清「第几遍」；tick 才是播放时间轴上唯一的位置。
 */
import type { TimelineEntry } from './timeline';

/** 一个循环点：选中音符的起点、以及它真正响完的位置。 */
export interface AbPoint {
  start: number;
  end: number;
  eventId: string;
}

/** 有效的循环区间：从 A 的起点播到 B 的音值终点，然后回到 A。 */
export interface AbRange {
  from: number;
  to: number;
}

/**
 * 只有「勾了循环 + A/B 都设好 + B 在 A 之后」才形成区间；
 * 任何不满足的情况都返回 null，播放按传统逻辑走，绝不半途截断。
 */
export function abRangeOf(
  a: AbPoint | null,
  b: AbPoint | null,
  enabled: boolean,
  totalTicks: number,
): AbRange | null {
  if (!enabled || !a || !b) return null;
  const from = Math.max(0, a.start);
  const to = Math.min(totalTicks, Math.max(b.end, b.start));
  return to > from ? { from, to } : null;
}

/**
 * B 点必须落在「这颗音真正响完」的位置：播放时间线把增时线记在音符自身时值里，
 * 又把延音链（`5~5~5`）合并成一条长音，那条长音的 endTick 就是整条链的终点。
 * 休止符 / 隐藏音不产生发声条目，回退到事件自己的时值终点。
 */
export function abSoundingEnd(timeline: readonly TimelineEntry[], tick: number, fallback: number): number {
  let end = fallback;
  for (const e of timeline) {
    if (e.startTick <= tick && e.endTick > tick) end = Math.max(end, e.endTick);
  }
  return Math.max(end, tick);
}

/** 恒定速度：把「本周期已经过的秒数」换算成回绕后的绝对 tick。 */
export function loopTickLinear(
  elapsedSec: number,
  anchorTick: number,
  from: number,
  to: number,
  ticksPerSec: number,
): number {
  const raw = anchorTick + Math.max(0, elapsedSec) * ticksPerSec;
  if (raw <= to) return raw;
  const len = Math.max(1, to - from);
  return from + (((raw - to) % len) + len) % len;
}

/** 变速曲线 / 伴奏标定：先在秒域回绕，再由调用方反查 tick。 */
export function loopSecMapped(elapsedSec: number, anchorSec: number, fromSec: number, toSec: number): number {
  const raw = anchorSec + Math.max(0, elapsedSec);
  if (raw <= toSec) return raw;
  const len = Math.max(1e-6, toSec - fromSec);
  return fromSec + (((raw - toSec) % len) + len) % len;
}
