/** 五线谱各声部共用起始边界；重奏系统左侧使用弯钩连接符和细竖线。 */
import { keySignature, type StaffLayout, type StaffLineData } from './staff';
import { staffContentRight } from './staffBounds';
import { staffAccWidth } from './staffInk';
import type { PaintTheme } from './paint';

export interface StaffLineStart {
  staffLeft: number;
  staffRight: number;
  clefX: number;
  showMeter: boolean;
}

export function staffSystemStarts(staff: StaffLayout): Map<StaffLineData, StaffLineStart> {
  const starts = new Map<StaffLineData, StaffLineStart>();
  const previousMeters = new Map<string | undefined, string | undefined>();
  const groups = new Map<number, { line: StaffLineData; index: number }[]>();
  const sp = staff.sp;
  for (const [index, line] of staff.lines.entries()) {
    const showMeter = !previousMeters.has(line.partId) || previousMeters.get(line.partId) !== line.beat;
    previousMeters.set(line.partId, line.beat);
    const glyphs = line.symbols.filter(s => s.kind === 'note' || s.kind === 'rest');
    const signatureWidth = sp * (3 + keySignature(line.key).count * .9 + (showMeter ? 2.6 : 0));
    // 行首以最左侧的实际内容为准，不能只看被倚音／转调推右的主符头。
    const firstX = glyphs.length ? Math.min(
      ...glyphs.map(s => s.x - staffAccWidth(s.kind === 'note' || s.kind === 'rest' ? s.accMark : '', sp)),
      ...line.graces.flatMap(g => g.notes.map(n => n.x - staffAccWidth(n.accMark, sp, true) - sp * .52)),
      ...line.symbols.filter(s => s.kind === 'key').map(s => s.x - sp * .5),
      ...line.symbols.filter(s => s.kind === 'barline' && s.repeat === 'start').map(s => s.x - sp * .3),
    )
      : Math.min(...line.symbols.map(s => s.x), ...(line.jumps ?? []).map(j => j.x), ...(line.voltas ?? []).map(v => v.x0), line.contentX ?? Infinity);
    const clefX = Number.isFinite(firstX) ? firstX - signatureWidth : (staff.title?.leftX ?? 96 * staff.glyph.fontSize / 21) + .8 * sp;
    starts.set(line, { staffLeft: clefX - .8 * sp,
      staffRight: Math.max(staffContentRight(line, sp), clefX + signatureWidth + sp), clefX, showMeter });
    if (line.system !== undefined) {
      const rows = groups.get(line.system) ?? [];
      rows.push({ line, index });
      groups.set(line.system, rows);
    }
  }
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const populated = rows.map(({ line }) => starts.get(line)!);
    const staffLeft = Math.min(...populated.map(s => s.staffLeft));
    const staffRight = Math.max(...populated.map(s => s.staffRight));
    for (const { line } of rows) starts.set(line, {
      staffLeft, staffRight, clefX: staffLeft + .8 * sp,
      showMeter: starts.get(line)?.showMeter ?? populated[0].showMeter,
    });
  }
  return starts;
}

/** 命中和绘制共用谱号坐标；不借用主音符的点击区域。 */
export function hitStaffClef(staff: StaffLayout, x: number, y: number): StaffLineData | null {
  const sp = staff.sp;
  for (const [line, start] of staffSystemStarts(staff)) {
    if (x >= start.staffLeft + .15 * sp && x <= start.clefX + 1.3 * sp && y >= line.y - 3 * sp && y <= line.y + 3 * sp) return line;
  }
  return null;
}

export function paintStaffSystems(ctx: CanvasRenderingContext2D, staff: StaffLayout, theme: PaintTheme,
  range?: { from: number; to: number }): Map<StaffLineData, StaffLineStart> {
  const starts = staffSystemStarts(staff);
  const sp = staff.sp;
  const groups = new Map<number, { line: StaffLineData; index: number }[]>();
  staff.lines.forEach((line, index) => {
    if (line.system === undefined) return;
    const rows = groups.get(line.system) ?? [];
    rows.push({ line, index }); groups.set(line.system, rows);
  });
  for (const rows of groups.values()) {
    if (rows.length < 2 || range && rows.some(row => row.index < range.from || row.index >= range.to)) continue;
    const staffLeft = starts.get(rows[0].line)!.staffLeft;
    const top = rows[0].line.y - 2 * sp;
    const bottom = rows[rows.length - 1].line.y + 2 * sp;
    const k = staff.glyph.fontSize / 21;
    const x = staffLeft - 10 * k;
    ctx.save();
    ctx.fillStyle = theme.ink;
    ctx.beginPath();
    ctx.moveTo(x + 8 * k, top - 5 * k);
    ctx.bezierCurveTo(x + 5 * k, top, x - 1.5 * k, top, x - 1.5 * k, top + 5 * k);
    ctx.lineTo(x - 1.5 * k, bottom - 5 * k);
    ctx.bezierCurveTo(x - 1.5 * k, bottom, x + 5 * k, bottom, x + 8 * k, bottom + 5 * k);
    ctx.bezierCurveTo(x + 6 * k, bottom - k, x + 1.5 * k, bottom - 2 * k, x + 1.5 * k, bottom - 6 * k);
    ctx.lineTo(x + 1.5 * k, top + 6 * k);
    ctx.bezierCurveTo(x + 1.5 * k, top + 2 * k, x + 6 * k, top + k, x + 8 * k, top - 5 * k);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = Math.max(1, k);
    ctx.beginPath();
    ctx.moveTo(staffLeft, top);
    ctx.lineTo(staffLeft, bottom);
    ctx.stroke();
    ctx.restore();
  }
  return starts;
}
