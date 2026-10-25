/** Event-bound staff annotations. Coordinates are bounding-box top-left corners. */
import type { StaffGlyph, StaffLayout } from './staff';
import type { Score } from './types';
import { scoreParts } from './parts';
import { TECHNIQUE_GLYPH, TECHNIQUE_PATHS, paintTechniqueGeometry, type PaintTheme } from './paint';
import { staffContentRight, staffCurveYBounds } from './staffBounds';
import { staffAccWidth } from './staffInk';
import { TICKS_PER_BEAT } from './ticks';

type TechniquePath = keyof typeof TECHNIQUE_PATHS;
type Shape = 'staccato' | 'tenuto' | 'accent' | 'marcato' | 'fermata' | 'turn' | 'breath';
interface MarkBox {
  line: number;
  eventId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: 'ink' | 'tech' | 'tongue' | 'curve';
  gray?: boolean;
}
export type StaffMark = MarkBox & (
  | { kind: 'text'; text: string; fontSize: number; italic?: boolean; dynamic?: boolean }
  | { kind: 'shape'; shape: Shape }
  | { kind: 'path'; path: TechniquePath }
  | { kind: 'hairpin'; opening0: number; opening1: number }
);

function overlaps(a: Pick<MarkBox, 'x' | 'width'>, b: Pick<MarkBox, 'x' | 'width'>, gap: number): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x;
}

export function buildStaffMarks(score: Score, staff: StaffLayout): StaffMark[] {
  const marks: StaffMark[] = [];
  const sp = staff.sp;
  const parts = scoreParts(score);
  // Reserve heads, stems, tuplets and curve bounds only where their x ranges overlap.
  const obstacles: MarkBox[][] = staff.lines.map((line, row) => {
    const boxes: MarkBox[] = [];
    const box = (x: number, y: number, width: number, height: number) => boxes.push({ line: row, eventId: '', x, y, width, height, color: 'ink' });
    for (const s of line.symbols) {
      if (s.kind === 'barline' && s.repeat === 'end' && (s.repeatTimes ?? 2) > 2) {
        box(s.x - 2 * sp, line.y - 3.8 * sp, 4 * sp, 1.6 * sp);
      }
      if ((s.kind !== 'note' && s.kind !== 'rest') || s.hidden) continue;
      const end = s.kind === 'note' && (s.baseTicks ?? s.ticks) < TICKS_PER_BEAT * 4
        ? s.beamEnd ?? s.y + (s.up ? -3.5 : 3.5) * sp : s.y;
      const left = s.x - sp - staffAccWidth(s.accMark, sp);
      box(left, Math.min(s.y - sp, end - sp * .4), s.x + sp - left, Math.abs(s.y - end) + 2 * sp);
    }
    for (const b of line.beams) {
      box(Math.min(b.x0, b.x1) - .2 * sp, Math.min(b.y0, b.y1) - .4 * sp,
        Math.abs(b.x1 - b.x0) + .4 * sp, Math.abs(b.y1 - b.y0) + .8 * sp);
    }
    for (const t of line.tuplets ?? []) {
      const cx = (t.x0 + t.x1) / 2;
      const halfText = [...t.text].length * .5 * sp;
      const left = t.bracket ? Math.min(t.x0, cx - halfText) : cx - halfText;
      const right = t.bracket ? Math.max(t.x1, cx + halfText) : cx + halfText;
      box(left, t.y - sp, right - left, 1.9 * sp);
    }
    for (const group of line.graces) {
      const x = Math.min(group.hostX - sp, ...group.notes.map(n => n.x - sp - staffAccWidth(n.accMark, sp, true)));
      const right = Math.max(group.hostX, group.notes[group.notes.length - 1].x) + sp;
      const top = Math.min(group.beamY - .4 * sp, ...group.notes.map(n => n.y - sp));
      box(x, top, right - x, group.arcY - top);
    }
    for (const c of staff.curves.filter(c => c.line === row)) {
      const { top, bottom } = staffCurveYBounds(c);
      box(c.x0, top - .3 * sp, c.x1 - c.x0, bottom - top + .6 * sp);
    }
    return boxes;
  });
  const place = (mark: StaffMark, above: boolean) => {
    const line = staff.lines[mark.line];
    mark.x = Math.max(sp, Math.min(mark.x, staff.width - mark.width - sp));
    mark.y = above ? line.y - 2.7 * sp - mark.height : line.y + 3 * sp;
    // 仅在两个方向都相交时让位；按离开谱表的方向处理，移动后不会撞回已处理的障碍。
    const gap = .6 * sp;
    const nearby = obstacles[mark.line].filter(b => overlaps(mark, b, .35 * sp))
      .sort((a, b) => above ? b.y - a.y : a.y + a.height - b.y - b.height);
    for (const b of nearby) if (mark.y < b.y + b.height + gap && mark.y + mark.height + gap > b.y) {
      mark.y = above ? b.y - gap - mark.height : b.y + b.height + gap;
    }
    marks.push(mark);
    obstacles[mark.line].push(mark);
  };
  for (const part of parts) {
    const rows = staff.lines.flatMap((line, i) => (line.partId ?? parts[0].id) === part.id ? [i] : []);
    const locations = new Map<string, { row: number; glyph: StaffGlyph }>();
    for (const row of rows) for (const s of staff.lines[row].symbols) {
      if ((s.kind === 'note' || s.kind === 'rest') && !s.hidden) locations.set(s.eventId, { row, glyph: s });
    }
    const order = new Map(part.events.map((e, i) => [e.id, i]));
    const textMark = (eventId: string, row: number, x: number, text: string, color: MarkBox['color'], above: boolean, gray?: boolean, dynamic = false) => {
      const fontSize = sp * (dynamic ? 2 : 1.65);
      const width = Math.min(staff.width - 2 * sp, Math.max(sp, [...text].reduce((n, ch) => n + (/[^\x00-\xff]/.test(ch) ? 1 : .65), 0) * fontSize));
      place({ kind: 'text', line: row, eventId, x: x - width / 2, y: 0, width, height: fontSize * 1.2, text, fontSize, italic: dynamic || text === 'tr', dynamic, color, gray }, above);
    };
    for (let i = 0; i < part.events.length; i++) {
      const e = part.events[i];
      if (e.kind === 'directive' && (e.type === 'dynamic' || e.type === 'tempo' || e.type === 'text')) {
        const next = part.events.slice(i + 1).find(n => locations.has(n.id))
          ?? part.events.slice(0, i).reverse().find(n => locations.has(n.id));
        const at = next ? locations.get(next.id) : undefined;
        if (at) textMark(e.id, at.row, at.glyph.x, e.value, 'ink', e.type !== 'dynamic', false, e.type === 'dynamic');
      }
      if (e.kind !== 'note') continue;
      const at = locations.get(e.id);
      if (!at) continue;
      const { row, glyph } = at;
      const base = { line: row, eventId: e.id, x: glyph.x - sp, y: 0, width: 2 * sp, height: sp, color: 'ink' as const, gray: e.gray };
      for (const shape of e.articulations ?? []) {
        const width = shape === 'staccato' ? .45 * sp : 1.5 * sp;
        place({ ...base, kind: 'shape', shape, x: glyph.x - width / 2, width, height: shape === 'staccato' ? .45 * sp : sp }, true);
      }
      if (e.fermata) place({ ...base, kind: 'shape', shape: 'fermata', height: 1.25 * sp }, true);
      const seen = new Set<string>();
      for (const o of e.ornaments ?? []) {
        if (o.kind === 'appoggiatura') continue; // Its note group belongs to staff grace geometry.
        seen.add(o.kind);
        if (o.kind === 'trill') textMark(e.id, row, glyph.x, 'tr', 'tech', true, e.gray);
        else if (o.kind === 'mordent') place({ ...base, kind: 'path', path: 'mordentUp', color: 'tech' }, true);
        else if (o.kind === 'turn') place({ ...base, kind: 'shape', shape: 'turn', color: 'tech' }, true);
      }
      for (const technique of e.techniques ?? []) {
        if (seen.has(technique)) continue;
        seen.add(technique);
        const t = TECHNIQUE_GLYPH[technique];
        if (technique === 'breath') place({ ...base, kind: 'shape', shape: 'breath', color: 'tongue', x: glyph.x - sp * .65, width: sp * 1.3, height: sp * 1.1 }, true);
        else if (t?.path) place({ ...base, kind: 'path', path: t.path, color: 'tech', height: t.path.startsWith('bend') ? 1.7 * sp : sp }, true);
        else textMark(e.id, row, glyph.x, technique === 'trill' ? 'tr' : technique === 'da' ? t.mark : t?.label ?? technique, 'tech', true, e.gray);
      }
      if (e.tongue) textMark(e.id, row, glyph.x, e.tongue, 'tongue', true, e.gray);
      if (e.mark) textMark(e.id, row, glyph.x, e.mark, 'tech', true, e.gray);
      if (e.dynamic) textMark(e.id, row, glyph.x, e.dynamic, 'ink', false, e.gray, true);
    }
    // Build each range within this part; continuation apertures reflect cumulative width.
    for (const e of part.events) {
      if (e.kind !== 'note' || !e.hairpin) continue;
      const a = locations.get(e.id);
      if (!a) continue;
      const target = e.hairpinTo ? locations.get(e.hairpinTo) : undefined;
      const b = target && (order.get(e.hairpinTo!) ?? -1) > order.get(e.id)! ? target : undefined;
      const segments: { row: number; x: number; width: number }[] = [];
      if (!b) {
        const line = staff.lines[a.row];
        const next = line.symbols.find(s => s.x > a.glyph.x + sp);
        const x = a.glyph.x + .8 * sp;
        segments.push({ row: a.row, x, width: Math.max(sp, Math.min(3.5 * sp, (next?.x ?? staff.width - sp) - x - .5 * sp)) });
      } else for (const row of rows.filter(r => r >= a.row && r <= b.row)) {
        const symbols = staff.lines[row].symbols;
        const notes = symbols.filter((s): s is StaffGlyph => s.kind === 'note' || s.kind === 'rest');
        if (!notes.length) continue;
        const x = row === a.row ? a.glyph.x : Math.max(sp, notes[0].x - sp);
        const end = row === b.row ? b.glyph.x : staffContentRight(staff.lines[row], sp) - 1;
        if (end > x) segments.push({ row, x, width: end - x });
      }
      const total = segments.reduce((n, s) => n + s.width, 0);
      let distance = 0;
      for (const s of segments) {
        const p0 = distance / total, p1 = (distance + s.width) / total;
        place({ kind: 'hairpin', line: s.row, eventId: e.id, x: s.x, y: 0, width: s.width, height: 1.4 * sp, color: 'curve', gray: e.gray, opening0: e.hairpin === 'cresc' ? p0 : 1 - p0, opening1: e.hairpin === 'cresc' ? p1 : 1 - p1 }, false);
        distance += s.width;
      }
    }
  }
  return marks;
}

export function paintStaffMarks(ctx: CanvasRenderingContext2D, staff: StaffLayout, theme: PaintTheme): void {
  for (const m of staff.marks) {
    ctx.save();
    ctx.fillStyle = ctx.strokeStyle = m.gray ? theme.muted : theme[m.color];
    ctx.lineWidth = Math.max(1, staff.sp * .16);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const cx = m.x + m.width / 2, cy = m.y + m.height / 2;
    if (m.kind === 'text') {
      ctx.font = `${m.italic ? 'italic ' : ''}${m.dynamic ? 'bold ' : ''}${m.fontSize}px ${m.dynamic || m.text === 'tr' ? 'Georgia, "Times New Roman", serif' : '"Microsoft YaHei", system-ui, sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.text, cx, cy, m.width);
    } else if (m.kind === 'path') {
      const shape = TECHNIQUE_PATHS[m.path];
      ctx.translate(cx, cy);
      const scale = Math.min(m.width / 15, m.height / (m.path.startsWith('bend') ? 13 : 7));
      ctx.scale(scale, shape.flip ? -scale : scale);
      ctx.lineWidth = shape.strokeWidth;
      paintTechniqueGeometry(ctx, m.path);
    } else {
      ctx.beginPath();
      if (m.kind === 'hairpin') {
        for (const sign of [-1, 1]) {
          ctx.moveTo(m.x, cy + sign * m.height * .5 * m.opening0);
          ctx.lineTo(m.x + m.width, cy + sign * m.height * .5 * m.opening1);
        }
      } else if (m.shape === 'staccato') {
        ctx.arc(cx, cy, m.width / 2, 0, Math.PI * 2); ctx.fill();
      } else if (m.shape === 'tenuto') {
        ctx.moveTo(m.x, cy); ctx.lineTo(m.x + m.width, cy);
      } else if (m.shape === 'accent') {
        ctx.moveTo(m.x, m.y); ctx.lineTo(m.x + m.width, cy); ctx.lineTo(m.x, m.y + m.height);
      } else if (m.shape === 'marcato') {
        ctx.moveTo(m.x, m.y + m.height); ctx.lineTo(cx, m.y); ctx.lineTo(m.x + m.width, m.y + m.height);
      } else if (m.shape === 'breath') {
        ctx.moveTo(m.x, m.y); ctx.lineTo(cx, m.y + m.height); ctx.lineTo(m.x + m.width, m.y);
      } else if (m.shape === 'fermata') {
        ctx.ellipse(cx, m.y + m.height * .85, m.width * .48, m.height * .75, 0, Math.PI, 2 * Math.PI);
        ctx.stroke(); ctx.beginPath(); ctx.arc(cx, m.y + m.height * .75, m.height * .12, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.moveTo(m.x, cy);
        ctx.bezierCurveTo(m.x, m.y, cx, m.y, cx, cy);
        ctx.bezierCurveTo(cx, m.y + m.height, m.x + m.width, m.y + m.height, m.x + m.width, cy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
