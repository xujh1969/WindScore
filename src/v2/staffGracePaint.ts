import type { StaffGraceGroup } from './staffGrace';
import type { PaintTheme } from './paint';

/** 小符头和符干缩小，音高格距和加线位置仍对齐整张谱表。 */
export function paintStaffGrace(ctx: CanvasRenderingContext2D, group: StaffGraceGroup, sp: number, theme: PaintTheme): void {
  ctx.save();
  const size = 0.62;
  const rx = sp * 0.52 * size, ry = sp * 0.36 * size;
  ctx.fillStyle = ctx.strokeStyle = group.gray ? theme.muted : theme.ink;
  ctx.lineWidth = Math.max(0.8, sp * 0.1);
  for (const n of group.notes) {
    ctx.beginPath();
    ctx.ellipse(n.x, n.y, rx, ry, -0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(n.x + rx, n.y);
    ctx.lineTo(n.x + rx, group.beamY);
    ctx.stroke();
    for (const step of [...Array.from({length: Math.max(0, Math.floor(-n.step / 2))}, (_, i) => -2 * (i + 1)),
      ...Array.from({length: Math.max(0, Math.floor((n.step - 8) / 2))}, (_, i) => 10 + 2 * i)]) {
      const y = n.y + (n.step - step) * sp / 2;
      ctx.beginPath(); ctx.moveTo(n.x - rx - sp * .2, y); ctx.lineTo(n.x + rx + sp * .2, y); ctx.stroke();
    }
    if (n.accMark) {
      ctx.font = `${sp * 1.55}px "Segoe UI Symbol", "Microsoft YaHei", serif`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(n.accMark, n.x - rx - sp * .2, n.y);
    }
  }
  // 沿用现有倚音的十六分音符形态，不另改其演奏时值。
  for (let level = 0; level < 2; level++) {
    const y = group.beamY + level * sp * .45;
    const first = group.notes[0], last = group.notes[group.notes.length - 1];
    if (group.notes.length > 1) {
      ctx.lineWidth = Math.max(1, sp * .22);
      ctx.beginPath(); ctx.moveTo(first.x + rx, y); ctx.lineTo(last.x + rx, y); ctx.stroke();
    } else {
      const x = first.x + rx;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + sp * .85, y + sp * .4, x + sp * .75, y + sp, x + sp * .25, y + sp * 1.3);
      ctx.bezierCurveTo(x + sp * .5, y + sp * .6, x + sp * .4, y + sp * .55, x, y + sp * .3);
      ctx.fill();
    }
  }
  const { x0, y0, x1, y1, controlY0, controlY1 } = group.arc;
  if (x1 > x0) {
    const dx = (x1 - x0) / 3;
    ctx.strokeStyle = group.gray ? theme.muted : theme.curve; ctx.lineWidth = Math.max(.8, sp * .11);
    ctx.beginPath(); ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(x0 + dx, controlY0, x1 - dx, controlY1, x1, y1);
    ctx.stroke();
  }
  ctx.restore();
}
