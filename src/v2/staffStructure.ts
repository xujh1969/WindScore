/** Conductor jump signs and actual, possibly continued, volta spans. */
import type { PaintTheme } from './paint';
import type { StaffLineData } from './staff';
import { SEGNO_SYMBOL, MUSIC_SYMBOL_FONT } from './musicSymbols';

const FAM = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

export function paintStaffStructure(ctx: CanvasRenderingContext2D, line: StaffLineData, sp: number, theme: PaintTheme): void {
  ctx.save();
  ctx.strokeStyle = theme.ink;
  ctx.fillStyle = theme.ink;
  ctx.lineWidth = Math.max(1, .15 * sp);
  ctx.lineCap = 'round';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${1.6 * sp}px ${FAM}`;
  for (const v of line.voltas ?? []) {
    ctx.beginPath();
    ctx.moveTo(v.x0, v.y + (v.cont ? 0 : 1.5 * sp));
    ctx.lineTo(v.x0, v.y);
    ctx.lineTo(v.x1, v.y);
    if (!v.open) ctx.lineTo(v.x1, v.y + 1.5 * sp);
    ctx.stroke();
    ctx.fillText(`${v.cont ? '(' : ''}${v.numbers.join(',')}${v.cont ? ')' : '.'}`, v.x0 + .4 * sp, v.y + 1.1 * sp);
    if (v.jump) {
      ctx.save();
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'right';
      ctx.fillText('↩', v.x1 - .3 * sp, v.y + 1.1 * sp);
      ctx.restore();
    }
  }
  for (const j of line.jumps ?? []) {
    const y = j.y + 1.1 * sp;
    if (j.mark === 'segno') {
      ctx.save();
      ctx.font = `${sp * 2.1}px ${MUSIC_SYMBOL_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(SEGNO_SYMBOL, j.x + sp, y);
      ctx.restore();
    } else if (j.mark === 'coda' || j.mark === 'tocoda') {
      const x = j.x + (j.mark === 'tocoda' ? 3.9 : 1.2) * sp;
      if (j.mark === 'tocoda') ctx.fillText('To', j.x, y);
      ctx.beginPath();
      ctx.arc(x, y, .8 * sp, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 1.2 * sp, y);
      ctx.lineTo(x + 1.2 * sp, y);
      ctx.moveTo(x, y - 1.2 * sp);
      ctx.lineTo(x, y + 1.2 * sp);
      ctx.stroke();
    } else {
      ctx.fillText(({ fine: 'Fine', dc: 'D.C.', ds: 'D.S.' })[j.mark], j.x, y);
    }
  }
  ctx.restore();
}
