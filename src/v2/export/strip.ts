/**
 * 横向长条（绿幕视频用）：把整份排版拉平成一条横带。
 *
 * - 系统（重奏 = 上下多行组成的一组）逐个**横向拼接**，系统间留间隙；
 *   简谱里设定的换行 / 分页在这里全部忽略——「把简谱拉成一个长条」。
 * - 多声部系统保留组内上下相对位置：声部行在长条里仍然是上下叠放。
 * - 所有 x 类坐标（item / 减时线 / 弧线 / 房子 / 力度楔形）整体平移。
 *
 * 纯函数，Node 里可直接测（scripts/export-test.ts）。
 */

import type { LayoutLine, LayoutResult } from '../layout';
import type { TimelineEntry } from '../timeline';

export interface Strip {
  /** 拉平后的排版：lines 保留（多声部上下叠放），x 已平移，title 清空 */
  layout: LayoutResult;
  /** 长条总宽（像素） */
  width: number;
  /** 长条高（一个系统的高；多声部 = 该组所有行） */
  height: number;
}

const SYSTEM_GAP = 90;

export function buildStrip(layout: LayoutResult): Strip {
  // 分系统：ensemble 填了 systems（行下标区间），直接用；
  // 单声部没有 systems → 每行自成一组
  const groups: LayoutLine[][] = layout.systems
    ? layout.systems.map((sys) => layout.lines.slice(sys.from, sys.to))
    : layout.lines.map((line) => [line]);

  const lineHeight = layout.lineHeight;
  const lines: LayoutLine[] = [];
  let dx = 0;
  let maxBottom = 0;
  let index = 0;

  for (const group of groups) {
    const groupLines = group.filter((l) => l.items.length > 0);
    if (groupLines.length === 0) continue;
    const top = Math.min(...groupLines.map((l) => l.y)) - lineHeight / 2;
    let ink = 0;
    for (const line of groupLines) {
      const out: LayoutLine = {
        ...line,
        index,
        y: line.y - top + lineHeight / 2,
        items: line.items.map((it) => ({ ...it, x: it.x + dx })),
        beams: line.beams.map((b) => ({ ...b, x0: b.x0 + dx, x1: b.x1 + dx })),
        arcs: line.arcs.map((a) => ({ ...a, x0: a.x0 + dx, x1: a.x1 + dx })),
        badges: line.badges.map((b) => ({ ...b, x: b.x + dx })),
        tuplets: line.tuplets.map((t) => ({ ...t, x0: t.x0 + dx, x1: t.x1 + dx })),
        voltas: line.voltas.map((v) => ({ ...v, x0: v.x0 + dx, x1: v.x1 + dx })),
        ...(line.hairpins
          ? { hairpins: line.hairpins.map((h) => ({ ...h, x0: h.x0 + dx, x1: h.x1 + dx })) }
          : {}),
      };
      for (const it of out.items) ink = Math.max(ink, it.x + it.w);
      for (const b of out.beams) ink = Math.max(ink, b.x1);
      lines.push(out);
      index += 1;
    }
    maxBottom = Math.max(
      maxBottom,
      ...lines.slice(lines.length - groupLines.length).map((l) => l.y + lineHeight / 2),
    );
    dx += Math.ceil(ink + SYSTEM_GAP);
  }

  const width = Math.max(1, dx);
  const height = Math.ceil(maxBottom + lineHeight * 0.9);
  return {
    layout: { ...layout, lines, width, height, title: null, systems: undefined },
    width,
    height,
  };
}

/** 长条上的一段（tick 区间 + 该区间在长条上的 x 起点与墨迹宽） */
export interface StripXRange {
  from: number;
  to: number;
  x: number;
}

/**
 * 时间线条目 → 长条上的 x 区间。与 video.ts 的 lineTickRanges 同口径，
 * 只是把「行基线 y」换成「条带 x」。
 */
export function stripTickRanges(layout: LayoutResult, timeline: TimelineEntry[]): StripXRange[] {
  const xOf = new Map<string, number>();
  for (const line of layout.lines) {
    for (const it of line.items) {
      if (!xOf.has(it.eventId)) xOf.set(it.eventId, it.x);
    }
  }
  const rows: StripXRange[] = [];
  for (const e of [...timeline].sort((a, b) => a.startTick - b.startTick)) {
    const x = xOf.get(e.eventId);
    if (x === undefined) continue;
    // 不做区间合并：相邻音首尾相接是常态，一合并整条谱就只剩一段，
    // 插值滚动就没法逐音推进了
    rows.push({ from: e.startTick, to: Math.max(e.endTick, e.startTick + 1), x });
  }
  return rows;
}

/**
 * 横向滚动目标（像素）：当前音停在画面左侧 30% 处，音与音之间按进度插值，
 * 滚动连续不跳格。超出长条两端时钳住。
 */
export function scrollTargetX(
  ranges: readonly StripXRange[],
  tick: number,
  scale: number,
  viewportW: number,
  stripW: number,
): number {
  if (ranges.length === 0) return 0;
  let x = ranges[0]!.x;
  for (let i = 0; i < ranges.length; i += 1) {
    const r = ranges[i]!;
    if (tick < r.from) break;
    const next = ranges[i + 1];
    if (!next || tick < next.from) {
      const p = next
        ? Math.max(0, Math.min(1, (tick - r.from) / Math.max(1, next.from - r.from)))
        : 0;
      x = r.x + p * (next ? Math.max(0, next.x - r.x) : 0);
      break;
    }
    x = r.x;
  }
  const max = Math.max(0, stripW * scale - viewportW);
  return Math.max(0, Math.min(max, x * scale - viewportW * 0.3));
}
