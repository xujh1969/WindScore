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

import type { LayoutLine } from '../layout';
import type { TimelineEntry } from '../timeline';
import type { ExportLayoutResult } from './render';
import type { StaffLayout } from '../staff';
import { staffCurveYBounds } from '../staffBounds';

export interface Strip {
  /** 拉平后的排版：lines 保留（多声部上下叠放），x 已平移，title 清空 */
  layout: ExportLayoutResult;
  /** 长条总宽（像素） */
  width: number;
  /** 长条高（一个系统的高；多声部 = 该组所有行） */
  height: number;
}

const SYSTEM_GAP = 24;

export function buildStrip(layout: ExportLayoutResult): Strip {
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
  const staffOffsets = new Map<number, { x: number; y: number; row: number; system: number }>();

  for (const [system, group] of groups.entries()) {
    const groupLines = layout.staff ? group : group.filter((l) => l.items.length > 0);
    if (groupLines.length === 0) continue;
    const staff = layout.staff;
    const top = staff
      ? (layout.systems?.[system]?.top ?? Math.min(...groupLines.map(l => {
        const staffLine = layout.staff!.lines[layout.lines.indexOf(l)];
        return (staffLine.labelY ?? staffLine.y - 4 * layout.staff!.sp) - layout.staff!.sp;
      }))) - 100 * staff.glyph.fontSize / 21
      : Math.min(...groupLines.map((l) => l.y)) - lineHeight / 2;
    for (const line of groupLines) {
      const out: LayoutLine = {
        ...line,
        index,
        y: line.y - top + (staff ? 0 : lineHeight / 2),
        items: line.items.map((it) => ({ ...it, x: it.x + dx,
          ...(it.dashXs ? { dashXs: it.dashXs.map(x => x + dx) } : {}),
          ...(it.playXs ? { playXs: it.playXs.map(p => ({ ...p, x: p.x + dx })) } : {}),
        })),
        beams: line.beams.map((b) => ({ ...b, x0: b.x0 + dx, x1: b.x1 + dx })),
        arcs: line.arcs.map((a) => ({ ...a, x0: a.x0 + dx, x1: a.x1 + dx })),
        badges: line.badges.map((b) => ({ ...b, x: b.x + dx })),
        tuplets: line.tuplets.map((t) => ({ ...t, x0: t.x0 + dx, x1: t.x1 + dx })),
        lyricLines: line.lyricLines?.map(l => ({ ...l, x0: l.x0 + dx, x1: l.x1 + dx })),
        voltas: line.voltas.map((v) => ({ ...v, x0: v.x0 + dx, x1: v.x1 + dx })),
        ...(line.hairpins
          ? { hairpins: line.hairpins.map((h) => ({ ...h, x0: h.x0 + dx, x1: h.x1 + dx })) }
          : {}),
      };
      staffOffsets.set(layout.lines.indexOf(line), { x: dx, y: out.y - line.y, row: index, system });
      lines.push(out);
      index += 1;
    }
    maxBottom = Math.max(
      maxBottom,
      ...lines.slice(lines.length - groupLines.length).map((l) => l.y + lineHeight / 2),
    );
    // 每个系统占**等宽**：页面排版本来就把每行两端对齐到 layout.width，
    // 等宽拼接后系统间隔严格恒定（按各行实际墨迹拼会忽大忽小——
    // 小节号 / 歌词这些画在 item 之外的东西会伸进间隔）
    dx += Math.ceil(layout.width + SYSTEM_GAP);
  }

  const width = Math.max(1, dx - SYSTEM_GAP);
  let height = Math.ceil(maxBottom + lineHeight * 0.9);
  if (layout.staff) {
    const s = layout.staff;
    for (const [row, d] of staffOffsets) {
      const line = s.lines[row];
      const bottoms = [line.y + 3 * s.sp];
      for (const g of line.symbols) if (g.kind === 'note' || g.kind === 'rest') {
        bottoms.push(g.y + s.sp, (g.beamEnd ?? g.y + (g.up ? -3.5 : 3.5) * s.sp) + s.sp);
      }
      for (const g of line.graces) bottoms.push(g.arcY, ...g.notes.map(n => n.y + s.sp));
      for (const m of s.marks) if (m.line === row) bottoms.push(m.y + m.height);
      for (const c of s.curves) if (c.line === row) bottoms.push(staffCurveYBounds(c).bottom + s.sp);
      const lyricVerses = [...line.lyrics.map(l => l.verse), ...(line.lyricLines ?? []).map(l => l.verse)];
      if (lyricVerses.length) bottoms.push((line.lyricY ?? line.y + 5.4 * s.sp) + Math.max(...lyricVerses) * 3 * s.sp + s.sp);
      height = Math.max(height, Math.ceil(Math.max(...bottoms) + d.y + 3 * s.sp));
    }
  }
  const staff = layout.staff ? stripStaff(layout.staff, staffOffsets, width, height) : undefined;
  return {
    layout: { ...layout, lines, width, height, title: null, systems: undefined, ...(staff ? { staff } : {}) },
    width,
    height,
  };
}

/** Translate the completed staff geometry with the same offsets as its source rows. */
function stripStaff(staff: StaffLayout,
  offsets: ReadonlyMap<number, { x: number; y: number; row: number; system: number }>,
  width: number, height: number): StaffLayout {
  return { ...staff, width, height, title: null,
    lines: staff.lines.flatMap((line, i) => {
      const d = offsets.get(i);
      if (!d) return [];
      return [{ ...line, y: line.y + d.y, system: d.system,
        ...(line.contentX !== undefined ? { contentX: line.contentX + d.x } : {}),
        ...(line.lyricY !== undefined ? { lyricY: line.lyricY + d.y } : {}),
        ...(line.labelY !== undefined ? { labelY: line.labelY + d.y } : {}),
        symbols: line.symbols.map(s => ({ ...s, x: s.x + d.x,
          ...((s.kind === 'note' || s.kind === 'rest') ? { y: s.y + d.y,
            ...(s.beamEnd !== undefined ? { beamEnd: s.beamEnd + d.y } : {}),
            ...(s.playXs ? { playXs: s.playXs.map(p => ({ ...p, x: p.x + d.x })) } : {}),
          } : {}),
        })),
        jumps: line.jumps?.map(j => ({ ...j, x: j.x + d.x, y: j.y + d.y })),
        voltas: line.voltas?.map(v => ({ ...v, x0: v.x0 + d.x, x1: v.x1 + d.x, y: v.y + d.y })),
        beams: line.beams.map(b => ({ ...b, x0: b.x0 + d.x, x1: b.x1 + d.x, y0: b.y0 + d.y, y1: b.y1 + d.y })),
        tuplets: line.tuplets?.map(t => ({ ...t, x0: t.x0 + d.x, x1: t.x1 + d.x, y: t.y + d.y })),
        lyrics: line.lyrics.map(l => ({ ...l, x: l.x + d.x })),
        lyricLines: line.lyricLines?.map(l => ({ ...l, x0: l.x0 + d.x, x1: l.x1 + d.x })),
        graces: line.graces.map(g => ({ ...g,
          hostX: g.hostX + d.x, hostY: g.hostY + d.y,
          beamY: g.beamY + d.y, arcY: g.arcY + d.y,
          notes: g.notes.map(n => ({ ...n, x: n.x + d.x, y: n.y + d.y })),
          arc: { ...g.arc, x0: g.arc.x0 + d.x, x1: g.arc.x1 + d.x,
            y0: g.arc.y0 + d.y, y1: g.arc.y1 + d.y,
            controlY0: g.arc.controlY0 + d.y, controlY1: g.arc.controlY1 + d.y },
        })),
      }];
    }),
    curves: staff.curves.flatMap(c => {
      const d = offsets.get(c.line);
      return d ? [{ ...c, line: d.row, x0: c.x0 + d.x, x1: c.x1 + d.x,
        y0: c.y0 + d.y, y1: c.y1 + d.y,
        controlY0: c.controlY0 + d.y, controlY1: c.controlY1 + d.y }] : [];
    }),
    marks: staff.marks.flatMap(m => {
      const d = offsets.get(m.line);
      return d ? [{ ...m, line: d.row, x: m.x + d.x, y: m.y + d.y }] : [];
    }),
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
export function stripTickRanges(layout: ExportLayoutResult, timeline: TimelineEntry[]): StripXRange[] {
  const xOf = new Map<string, number>();
  if (layout.staff) for (const line of layout.staff.lines) {
    for (const s of line.symbols) if ((s.kind === 'note' || s.kind === 'rest') && !s.hidden) {
      if (!xOf.has(s.eventId)) xOf.set(s.eventId, s.x);
    }
  }
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
