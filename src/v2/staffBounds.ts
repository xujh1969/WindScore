import type { StaffLineData } from './staff';

/** 三次贝塞尔实际纵向范围；控制点不一定落在曲线上。 */
export function staffCurveYBounds(curve: { y0: number; y1: number; controlY0: number; controlY1: number }): { top: number; bottom: number } {
  const { y0, y1, controlY0: p1, controlY1: p2 } = curve;
  const a = -y0 + 3 * p1 - 3 * p2 + y1;
  const b = 2 * (y0 - 2 * p1 + p2);
  const c = p1 - y0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-8) {
    if (Math.abs(b) > 1e-8) roots.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) roots.push((-b + Math.sqrt(d)) / (2 * a), (-b - Math.sqrt(d)) / (2 * a));
  }
  const ys = [y0, y1];
  for (const t of roots) if (t > 0 && t < 1) {
    const u = 1 - t;
    ys.push(u ** 3 * y0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t ** 3 * y1);
  }
  return { top: Math.min(...ys), bottom: Math.max(...ys) };
}

/** 行尾可能是不完整小节，不能把位于这些音之前的小节线当成谱表终点。 */
export function staffContentRight(line: StaffLineData, sp: number): number {
  let right = 0;
  let closingBar = -Infinity;
  for (const s of line.symbols) {
    if (s.kind === 'barline') {
      if (s.repeat === 'start') right = Math.max(right, s.x + 1.5 * sp);
      else closingBar = Math.max(closingBar, s.x);
    }
    if (s.kind === 'note' || s.kind === 'rest') {
      const head = s.kind === 'rest' ? .9 * sp : .52 * sp;
      const flag = s.kind === 'note' && s.beams && s.beamEnd === undefined ? 1.1 * sp : 0;
      const dots = s.dots ? (.55 + s.dots * .34) * sp : 0;
      right = Math.max(right, s.x + head + Math.max(flag, dots) + 2);
    }
  }
  for (const group of line.graces) for (const n of group.notes) right = Math.max(right, n.x + .6 * sp + 2);
  return Math.max(right, closingBar);
}
