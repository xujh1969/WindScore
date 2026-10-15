/** 根据五线谱墨迹占用扩展行距；不改横坐标、音高或演奏时间。 */
import type { LayoutResult } from './layout';
import type { StaffLayout } from './staff';
import { staffCurveYBounds } from './staffBounds';

export function spaceStaffLines(staff: StaffLayout): void {
  const sp = staff.sp;
  let previousBottom = staff.title?.height ?? 12;
  staff.lines.forEach((line, index) => {
    let top = line.y - 3.5 * sp;
    let bottom = line.y + 2.5 * sp;
    for (const s of line.symbols) {
      if (s.kind === 'barline' && s.repeat === 'end' && (s.repeatTimes ?? 2) > 2) top = Math.min(top, line.y - 3.8 * sp);
      if ((s.kind !== 'note' && s.kind !== 'rest') || s.hidden) continue;
      const stem = s.kind === 'note' && (s.baseTicks ?? s.ticks) < 192
        ? s.beamEnd ?? s.y + (s.up ? -3.5 : 3.5) * sp : s.y;
      top = Math.min(top, s.y - sp, stem - sp * 0.4);
      bottom = Math.max(bottom, s.y + sp, stem + sp * 0.4);
    }
    for (const t of line.tuplets ?? []) top = Math.min(top, t.y - sp);
    for (const group of line.graces) {
      top = Math.min(top, group.beamY - sp * .4, ...group.notes.map(n => n.y - sp));
      bottom = Math.max(bottom, group.arcY);
    }
    const marks = staff.marks.filter(m => m.line === index);
    for (const mark of marks) {
      top = Math.min(top, mark.y);
      bottom = Math.max(bottom, mark.y + mark.height);
    }
    const curves = staff.curves.filter(c => c.line === index);
    for (const c of curves) {
      const bounds = staffCurveYBounds(c);
      top = Math.min(top, bounds.top - sp * .2);
      bottom = Math.max(bottom, bounds.bottom + sp * .2);
    }
    // Keep conductor structures above all notes, graces, annotations and curves.
    const jumps = line.jumps ?? [];
    const jumpWidth = (mark: string): number => (mark === 'segno' ? 2 : mark === 'coda' ? 2.4 : mark === 'tocoda' ? 5.2 : 4.2) * sp;
    jumps.forEach((jump, i) => {
      jump.y = top - 3 * sp;
      for (const previous of jumps.slice(0, i)) {
        if (jump.x < previous.x + jumpWidth(previous.mark) + sp && jump.x + jumpWidth(jump.mark) + sp > previous.x) {
          jump.y = Math.min(jump.y, previous.y - 3 * sp);
        }
      }
    });
    if (jumps.length) top = Math.min(top, ...jumps.map(jump => jump.y));
    for (const volta of line.voltas ?? []) volta.y = top - 2.6 * sp;
    if (line.voltas?.length) top -= 2.6 * sp;
    line.labelY = Math.min(line.y - 4 * sp, top - 1.2 * sp);
    top = line.labelY - sp;
    // 歌词放到最下方音符／连线之后，避免低音加线和下弧线压住文字。
    line.lyricY = Math.max(line.y + 5.4 * sp, bottom + 2 * sp);
    const lyricVerses = [...line.lyrics.map(l => l.verse), ...(line.lyricLines ?? []).map(l => l.verse)];
    if (lyricVerses.length) bottom = line.lyricY + Math.max(...lyricVerses) * 3 * sp + sp;
    const dy = previousBottom + 2 * sp - top;
    line.y += dy;
    line.labelY += dy;
    line.lyricY += dy;
    for (const s of line.symbols) if (s.kind === 'note' || s.kind === 'rest') {
      s.y += dy;
      if (s.beamEnd !== undefined) s.beamEnd += dy;
    }
    for (const b of line.beams) { b.y0 += dy; b.y1 += dy; }
    for (const t of line.tuplets ?? []) t.y += dy;
    for (const group of line.graces) {
      group.hostY += dy; group.beamY += dy; group.arcY += dy;
      group.arc.y0 += dy; group.arc.y1 += dy; group.arc.controlY0 += dy; group.arc.controlY1 += dy;
      for (const n of group.notes) n.y += dy;
    }
    for (const jump of line.jumps ?? []) jump.y += dy;
    for (const volta of line.voltas ?? []) volta.y += dy;
    for (const mark of marks) mark.y += dy;
    for (const c of curves) { c.y0 += dy; c.y1 += dy; c.controlY0 += dy; c.controlY1 += dy; }
    previousBottom = bottom + dy;
  });
  if (staff.lines.length) staff.height = previousBottom + 3 * sp;
}

/** 播放跟随、画布高度等沿用 LayoutResult，行中心须与最终五线谱一致。 */
export function withStaffRows(layout: LayoutResult, staff: StaffLayout): LayoutResult {
  const offsets = new Map<string, number>();
  const lines = layout.lines.map((line, i) => {
    const dy = staff.lines[i].y - line.y;
    for (const it of line.items) offsets.set(it.eventId, dy);
    return { ...line, y: staff.lines[i].y };
  });
  return { ...layout, lines, height: staff.height,
    hitIndex: layout.hitIndex.map(hit => ({ ...hit, y: hit.y + (offsets.get(hit.eventId) ?? 0) })),
    systems: layout.systems?.map(s => ({ ...s,
      top: s.top + staff.lines[s.from].y - layout.lines[s.from].y,
      bottom: s.bottom + staff.lines[s.to - 1].y - layout.lines[s.to - 1].y,
    })),
  };
}
