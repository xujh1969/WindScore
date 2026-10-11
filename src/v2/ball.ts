import type { LayoutResult } from './layout';
import type { TimelineEntry } from './timeline';
import { TICKS_PER_BEAT } from './ticks';

/** 播放光球的一帧状态（绘制在所有谱面层之上） */
export interface BallDraw {
  x: number;
  y: number;
  r: number;
  /** 落地照亮强度 0..1：下落段渐强，落点附近最亮 */
  hot: number;
  /** 透明度 0..1：曲末余跳渐隐用，正常飞行恒为 1 */
  alpha: number;
  trail: { x: number; y: number }[];
}

/**
 * 光球轨迹的静态部分：音符落点序列 + 尺寸。
 * 建一次、求值多次——拖尾要按固定 tick 步长补插中间点（掉帧时帧间距很大），
 * 不能每插一个点就把整个落点表重建一遍。
 */
export interface BallTrack {
  onsets: { tick: number; end: number; x: number; y: number }[];
  k: number;
  r: number;
}

/** 建轨迹：音符落点 = **数字字形**正上方（与 paint 层的数字起笔公式一致） */
export function buildBallTrack(
  layout: LayoutResult,
  timeline: TimelineEntry[],
  followPartId: string | undefined,
): BallTrack | null {
  const k = layout.glyph.fontSize / 21;
  const pos = new Map<string, { x: number; y: number }>();
  for (const line of layout.lines) {
    if (followPartId && line.partId && line.partId !== followPartId) continue;
    for (const it of line.items) {
      if (it.kind !== 'note' && it.kind !== 'rest') continue;
      if (pos.has(it.eventId)) continue;
      // 击中点 = 数字字形正上方：数字从 x+pad 起笔（变音记号 / 前倚音再右移），
      // 宽取标称数字宽。不能用 it.x + it.w/2——那条会落在增时线（5-- 的 -）上方
      const cx =
        it.x + layout.glyph.pad + (it.accW ?? 0) + (it.graceInk ?? 0) + layout.glyph.nominalWidth / 2;
      pos.set(it.eventId, { x: cx, y: line.y });
    }
  }
  /** 落点序列：主音条目按 startTick 排；同一时刻只留一个（和弦 / 声部副本），尾音取最长 */
  const onsets: { tick: number; end: number; x: number; y: number }[] = [];
  for (const e of timeline) {
    if (e.grace) continue;
    const p = pos.get(e.eventId);
    if (!p) continue;
    const last = onsets[onsets.length - 1];
    if (last && last.tick === e.startTick) {
      last.end = Math.max(last.end, e.endTick);
      continue;
    }
    onsets.push({ tick: e.startTick, end: e.endTick, x: p.x, y: p.y });
  }
  if (onsets.length === 0) return null;
  /**
   * 停靠高度：球停 / 落地时悬在音符字形顶上（再抬 5px，用户实测的视觉高度）。
   * 数字按 textBaseline='middle' 画在 line.y，墨顶 ≈ y − 0.35em；再往上一个球半径。
   */
  const r = 3.7 * k;
  const rest = layout.glyph.fontSize * 0.35 + r + 5 * k;
  for (const o of onsets) o.y -= rest;
  return { onsets, k, r };
}

/**
 * 求值：按当前 tick 在「上一颗音起点 → 下一颗音起点」之间定位。
 * 物理规律 = 抛物线（水平匀速、竖直先升后降，正是重力轨迹）；
 * **音一响球就从音顶跃起**，沿弧线飞向下一颗音，在它响起的瞬间正好落到音顶——
 * 长音（5- / 5--）也是一整段飞行，中途不停。
 * 曲末：先停在最后一个音上直到尾音结束，再沿一段更高更远的余跳跃起并渐渐消隐。
 */
function evalBallTrack(track: BallTrack, tick: number, trail: { x: number; y: number }[]): BallDraw | null {
  const { onsets, k, r } = track;
  if (tick < onsets[0]!.tick) return null;
  let i = 0;
  let hi = onsets.length;
  while (i + 1 < hi) {
    const mid = (i + hi) >>> 1;
    if (onsets[mid]!.tick <= tick) i = mid;
    else hi = mid;
  }
  const a = onsets[i]!;
  const b = onsets[i + 1];
  if (b && b.tick > a.tick) {
    // 音一响就起跳：整个音长就是飞行时间，长音（5- / 5--）不再中途停驻
    const u = (tick - a.tick) / (b.tick - a.tick);
    // 抛物线：水平匀速、竖直先升后降——这正是重力下的轨迹
    const x = a.x + (b.x - a.x) * u;
    const h = Math.min(
      90 * k,
      (14 + Math.abs(b.x - a.x) * 0.2 + Math.abs(b.y - a.y) * 0.6) * k,
    );
    const y = a.y + (b.y - a.y) * u - h * 4 * u * (1 - u);
    // 落地照亮强度：下落段渐强，落地瞬间最亮
    const hot = u > 0.55 ? (u - 0.55) / 0.45 : 0;
    return { x, y, r, hot, alpha: 1, trail };
  }
  // 曲末：先**停在最后一个音上**，保持到尾音（最后一颗音的声音）真正结束；
  // 然后沿一段比常规跳跃**更高更远**的余跳跃起，同时渐渐消隐
  if (tick <= a.end) return { x: a.x, y: a.y, r, hot: 0.5, alpha: 1, trail };
  const prev = onsets[i - 1];
  const span = prev ? (a.x - prev.x) * 1.5 : 50 * k;
  const h = prev
    ? Math.min(
        120 * k,
        (14 + Math.abs(a.x - prev.x) * 0.2 + Math.abs(a.y - prev.y) * 0.6) * k,
      ) * 1.6
    : 46 * k;
  const vTicks = TICKS_PER_BEAT * 0.8;
  const u = Math.min(1, (tick - a.end) / vTicks);
  if (u >= 1) return null; // 余跳结束：球彻底消隐
  return { x: a.x + span * u, y: a.y - h * 4 * u * (1 - u), r, hot: 0, alpha: 1 - u, trail };
}

/** 所有页面按相同拍距采样拖尾，避免帧率不同导致尾长、亮度不同。 */
export function sampleBallTrail(track: BallTrack, tick: number, startTick: number, trail: { x: number; y: number }[]): BallDraw | null {
  trail.length = 0;
  const step = TICKS_PER_BEAT * 0.05;
  const first = Math.max(startTick, track.onsets[0].tick);
  for (let i = 19; i >= 0; i--) {
    const t = tick - i * step;
    if (t < first) continue;
    const point = evalBallTrack(track, t, trail);
    if (point) trail.push({ x: point.x, y: point.y });
  }
  return evalBallTrack(track, tick, trail);
}

