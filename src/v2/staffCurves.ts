/** 五线谱连线几何：按声部和事件身份定位，跨行只续到同一声部。 */
import type { StaffGlyph, StaffLayout } from './staff';
import { legacyPitch, pitchMidi } from './pitch';
import { scoreParts } from './parts';
import type { Score } from './types';
import { staffContentRight } from './staffBounds';
import { TICKS_PER_BEAT } from './ticks';

export interface StaffCurve {
  line: number;
  kind: 'tie' | 'slur';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  controlY0: number;
  controlY1: number;
}

/** 当前弧形是弦线加抛物线，求外层弧高使其包住内层；共用端点处间距收拢。 */
function enclosingHeight(inner: StaffCurve, x0: number, x1: number, y0: number, y1: number, dir: number, gap: number): number {
  const width = x1 - x0, innerWidth = inner.x1 - inner.x0;
  const alpha = (x0 - inner.x0) / innerWidth, beta = width / innerWidth;
  const innerHeight = (inner.controlY0 - (2 * inner.y0 + inner.y1) / 3) * .75;
  const dy = inner.y1 - inner.y0;
  // 内层曲线减去外层弦线，表示为 a*t²+b*t+c；外层可增加 4h*t*(1-t)。
  const a = dir * -4 * innerHeight * beta * beta;
  const b = dir * (dy * beta + 4 * innerHeight * beta * (1 - 2 * alpha) - (y1 - y0));
  const c = dir * (inner.y0 + dy * alpha + 4 * innerHeight * alpha * (1 - alpha) - y0);
  const from = Math.max(0, (inner.x0 - x0) / width), to = Math.min(1, (inner.x1 - x0) / width);
  const points = [from, to];
  // 导数分子为 (a+b)*t²+2c*t-c，取区间端点与驻点即可求最大弧高。
  const quadratic = a + b;
  if (Math.abs(quadratic) < 1e-8) {
    if (Math.abs(c) > 1e-8) points.push(.5);
  } else {
    const discriminant = c * c + quadratic * c;
    if (discriminant >= 0) points.push((-c + Math.sqrt(discriminant)) / quadratic, (-c - Math.sqrt(discriminant)) / quadratic);
  }
  let height = 0;
  for (const t of points) if (t >= from && t <= to) {
    // 相同端点的分子也为零，用极限避免 0/0。
    const required = t < 1e-8 ? b / 4 : t > 1 - 1e-8 ? -(2 * a + b) / 4
      : (a * t * t + b * t + c) / (4 * t * (1 - t));
    height = Math.max(height, required + gap);
  }
  return height;
}

export function buildStaffCurves(score: Score, staff: StaffLayout): StaffCurve[] {
  const curves: StaffCurve[] = [];
  const sp = staff.sp;
  const parts = scoreParts(score);
  for (const part of parts) {
    const rows = staff.lines.flatMap((line, i) => (line.partId ?? parts[0].id) === part.id ? [i] : []);
    const locations = new Map<string, { row: number; glyph: StaffGlyph }>();
    for (const row of rows) for (const s of staff.lines[row].symbols) {
      if (s.kind === 'note') locations.set(s.eventId, { row, glyph: s });
    }
    const pitches = new Map<string, number>();
    const order = new Map(part.events.map((e, i) => [e.id, i]));
    let key = score.meta.key;
    for (const e of part.events) if (e.kind === 'note') {
      key = e.keyChange ?? key;
      pitches.set(e.id, pitchMidi(legacyPitch(e.degree, e.octave, key, e.accidental)));
    }
    const slurNext = new Map<string, string[]>();
    const incoming = new Map<string, number>();
    const ranges: { from: string; to: string; kind: 'tie' | 'slur' }[] = [];
    for (const e of part.events) if (e.kind === 'note') for (const t of e.ties ?? []) {
      if (!locations.has(t.to) || (order.get(t.to) ?? -1) <= order.get(e.id)!) continue;
      if (t.kind === 'slur') {
        const next = slurNext.get(e.id) ?? [];
        if (!next.includes(t.to)) {
          next.push(t.to);
          incoming.set(t.to, (incoming.get(t.to) ?? 0) + 1);
        }
        slurNext.set(e.id, next);
      }
      else if (pitches.get(e.id) === pitches.get(t.to)) ranges.push({ from: e.id, to: t.to, kind: 'tie' });
    }
    const consumed = new Set<string>();
    for (const [from, next] of slurNext) for (const target of next) {
      if (consumed.has(`${from}:${target}`)) continue;
      let to = target;
      while (next.length === 1 && incoming.get(to) === 1 && slurNext.get(to)?.length === 1) {
        const end = slurNext.get(to)![0];
        consumed.add(`${to}:${end}`);
        to = end; // 仅合并无分叉／汇合的向后连接，不丢弃嵌套分支。
      }
      ranges.push({ from, to, kind: 'slur' });
    }
    ranges.sort((a, b) => (order.get(a.to)! - order.get(a.from)!) - (order.get(b.to)! - order.get(b.from)!)
      || (a.kind === 'tie' ? 0 : 1) - (b.kind === 'tie' ? 0 : 1));
    const placed: { curve: StaffCurve; from: number; to: number }[] = [];
    for (const range of ranges) {
      const a = locations.get(range.from), b = locations.get(range.to);
      if (!a || !b) continue;
      const preferredDir = a.glyph.up ? 1 : -1;
      let chosenDir: number | undefined;
      for (const row of rows.filter(r => r >= a.row && r <= b.row)) {
        const line = staff.lines[row];
        const notes = line.symbols.filter((s): s is StaffGlyph => s.kind === 'note' || s.kind === 'rest');
        if (!notes.length) continue;
        const first = row === a.row, last = row === b.row;
        const x0 = first ? a.glyph.x + sp * 0.55 : notes[0].x - sp * 2.2;
        const x1 = last ? b.glyph.x - sp * 0.55 : staffContentRight(line, sp) - 1;
        if (x1 <= x0) continue;
        const start = first ? a.glyph : notes[0];
        const end = last ? b.glyph : notes[notes.length - 1];
        const stemEnd = (n: StaffGlyph) => n.kind === 'note' && (n.baseTicks ?? n.ticks) < TICKS_PER_BEAT * 4
          ? n.beamEnd ?? n.y + (n.up ? -3.5 : 3.5) * sp : n.y;
        // 两端固定在符头附近，端点自身的符干不参与抬高曲线。
        const between = notes.filter(n => n !== start && n !== end && n.x > x0 && n.x < x1);
        const candidates = (chosenDir !== undefined ? [chosenDir] : range.kind === 'tie' ? [preferredDir] : [preferredDir, -preferredDir]).map(dir => {
          const anchor = (n: StaffGlyph) => n.y + dir * sp * 0.65;
          const y0 = anchor(start), y1 = anchor(end);
          const width = x1 - x0;
          let height = Math.min((range.kind === 'tie' ? 0.7 : 1.5) * sp, Math.max(0.25 * sp, width * 0.12));
          if (range.kind === 'slur') for (const n of between) {
            const t = (n.x - x0) / width;
            const bound = dir < 0 ? Math.min(n.y - sp * 0.8, stemEnd(n) - sp * 0.4)
              : Math.max(n.y + sp * 0.8, stemEnd(n) + sp * 0.4);
            // 控制点位于弦线的 1/3、2/3 处，实际曲线偏移为 4h·t·(1-t)。
            height = Math.max(height, dir * (bound - (y0 + (y1 - y0) * t)) / (4 * t * (1 - t)));
          }
          for (const previous of placed) {
            if (previous.from < order.get(range.from)! || previous.to > order.get(range.to)!) continue;
            const inner = previous.curve;
            if (inner.line !== row || inner.x0 < x0 - .01 || inner.x1 > x1 + .01) continue;
            const innerDir = Math.sign(inner.controlY0 - (2 * inner.y0 + inner.y1) / 3);
            if (innerDir === dir) height = Math.max(height, enclosingHeight(inner, x0, x1, y0, y1, dir, sp * .65));
          }
          const offset = dir * height * 4 / 3;
          const cost = height + (Math.abs(y0 - start.y) + Math.abs(y1 - end.y)) * 0.12
            + (dir === preferredDir ? 0 : sp * 0.3);
          return { dir, y0, y1, controlY0: y0 + (y1 - y0) / 3 + offset,
            controlY1: y0 + (y1 - y0) * 2 / 3 + offset, cost };
        });
        const best = candidates.reduce((a, b) => a.cost <= b.cost ? a : b);
        chosenDir = best.dir;
        const curve = { line: row, kind: range.kind, x0, x1, y0: best.y0, y1: best.y1,
          controlY0: best.controlY0, controlY1: best.controlY1 };
        curves.push(curve);
        placed.push({ curve, from: order.get(range.from)!, to: order.get(range.to)! });
      }
    }
  }
  return curves;
}
