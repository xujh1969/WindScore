/** 连音组编号／括线避开倚音和连线；先定位，再由技法文字与行距继续避让。 */
import type { StaffLayout } from './staff';
import { staffAccWidth } from './staffInk';
import { staffCurveYBounds } from './staffBounds';

interface Obstacle { left: number; right: number; top: number; bottom: number; }

export function positionStaffTuplets(staff: StaffLayout): void {
  const sp = staff.sp;
  for (const [row, line] of staff.lines.entries()) {
    const obstacles: Obstacle[] = [];
    for (const group of line.graces) obstacles.push({
      left: Math.min(...group.notes.map(n => n.x - .55 * sp - staffAccWidth(n.accMark, sp, true))),
      right: Math.max(...group.notes.map(n => n.x + sp)),
      top: Math.min(group.beamY - .4 * sp, ...group.notes.map(n => n.y - sp)),
      bottom: group.arcY,
    });
    for (const curve of staff.curves) if (curve.line === row) {
      const { top, bottom } = staffCurveYBounds(curve);
      obstacles.push({ left: curve.x0, right: curve.x1, top: top - .2 * sp, bottom: bottom + .2 * sp });
    }
    for (const tuplet of line.tuplets ?? []) {
      const cx = (tuplet.x0 + tuplet.x1) / 2;
      const halfText = [...tuplet.text].length * .5 * sp;
      const left = Math.min(tuplet.x0, cx - halfText), right = Math.max(tuplet.x1, cx + halfText);
      // 从较低的障碍向上检查，抬高后不会再撞回已经经过的障碍。
      const overlapping = obstacles.filter(b => left < b.right + .4 * sp && right + .4 * sp > b.left)
        .sort((a, b) => b.top - a.top);
      for (const box of overlapping) if (tuplet.y + .9 * sp > box.top && tuplet.y - .9 * sp < box.bottom) {
        tuplet.y = box.top - 1.4 * sp;
      }
      obstacles.push({ left, right, top: tuplet.y - .9 * sp, bottom: tuplet.y + .9 * sp });
    }
  }
}
