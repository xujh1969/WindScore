/**
 * 五线谱绘制（实验功能）：谱表 / 高音谱号 / 调号 / 符头 / 符干 / 符杠 /
 * 休止符 / 小节线 / 反复 / 房子 / 歌词 / 播放指示。
 *
 * 排好版的数据由 staff.ts 的 buildStaffLayout 给出，这里只画不算；
 * 配色沿用 paint.ts 的 PaintTheme，视觉与简谱视图保持一致。
 */

import type { PaintOptions, PaintTheme } from './paint';
import { drawPlayBall, paintScoreTitle } from './paint';
import { accidentalGlyph } from './pitch';
import { playbackX } from './spacing';
import { paintLyricLines } from './lyricLines';
import { paintStaffGrace } from './staffGracePaint';
import { paintStaffMarks } from './staffMarks';
import { TICKS_PER_BEAT } from './ticks';
import { shortInstrumentLabel } from './instrumentSamples';
import { paintStaffStructure } from './staffStructure';
import { paintStaffSystems, type StaffLineStart } from './staffSystems';
import {
  HEAD_RX,
  keySignature,
  restKindOf,
  STEM_OCT,
  type StaffLayout,
  type StaffLineData,
  type StaffSymbol,
} from './staff';

/** 符头：宽 ≈ 1.04 个线间距、高 ≈ 0.72 个 */
const HEAD_RY = 0.36;
const FAM = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
const CLEF_FAM = '"Bravura", "Segoe UI Symbol", "Noto Music", "Maestro", serif';

type StaffCellGlyph = Extract<StaffSymbol, { kind: 'note' | 'rest' }>;
type StaffBarline = Extract<StaffSymbol, { kind: 'barline' }>;

export function paintStaffLayout(
  ctx: CanvasRenderingContext2D,
  staff: StaffLayout,
  theme: PaintTheme,
  o: PaintOptions & { lineRange?: { from: number; to: number }; background?: boolean } = {},
): void {
  ctx.save();
  if (o.background !== false) {
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, staff.width, o.height ?? staff.height);
  }
  if (staff.title) paintScoreTitle(ctx, staff.title, staff.glyph, theme, o.showTitleEdit !== false);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  if (o.playStyle === 'band') {
    const seen = new Set<number>();
    for (const head of o.playheads ?? (o.playhead ? [o.playhead] : [])) {
      const index = staff.lines.findIndex(l => l.symbols.some(s => (s.kind === 'note' || s.kind === 'rest') && s.eventId === head.eventId));
      if (index < 0) continue;
      const line = staff.lines[index];
      const system = line.system ?? index;
      if (seen.has(system)) continue;
      seen.add(system);
      const glyph = line.symbols.find((s): s is StaffCellGlyph => (s.kind === 'note' || s.kind === 'rest') && s.eventId === head.eventId)!;
      const rows = line.system === undefined ? [line] : staff.lines.filter(l => l.system === line.system);
      const x = playbackX({ x: glyph.x, w: glyph.playWidth ?? 0, playXs: glyph.playXs }, head.frac);
      const top = Math.min(...rows.map(l => l.y)) - staff.sp * 2.6;
      const bottom = Math.max(...rows.map(l => l.y)) + staff.sp * 2.6;
      const width = Math.max(6, staff.sp * 0.9);
      ctx.fillStyle = theme.playheadBg;
      ctx.fillRect(x - width / 2, top, width, bottom - top);
      ctx.fillStyle = theme.playhead;
      ctx.fillRect(x - 0.6, top, 1.2, bottom - top);
    }
  }
  const visibleLine = (index: number): boolean => !o.lineRange || (index >= o.lineRange.from && index < o.lineRange.to);
  const starts = paintStaffSystems(ctx, staff, theme, o.lineRange);
  for (const [index, line] of staff.lines.entries()) if (visibleLine(index)) drawStaffLine(ctx, line, staff, theme, o, starts.get(line));
  ctx.strokeStyle = theme.curve;
  ctx.lineWidth = Math.max(1.1, staff.sp * 0.16);
  ctx.lineCap = 'round';
  for (const c of staff.curves) {
    if (!visibleLine(c.line)) continue;
    const dx = (c.x1 - c.x0) / 3;
    ctx.beginPath();
    ctx.moveTo(c.x0, c.y0);
    ctx.bezierCurveTo(c.x0 + dx, c.controlY0, c.x1 - dx, c.controlY1, c.x1, c.y1);
    ctx.stroke();
  }
  paintStaffMarks(ctx, o.lineRange ? { ...staff, marks: staff.marks.filter(m => visibleLine(m.line)) } : staff, theme);
  if (o.playStyle === 'ball' && o.ball) drawPlayBall(ctx, o.ball, theme);
  ctx.restore();
}

function drawStaffLine(
  ctx: CanvasRenderingContext2D,
  line: StaffLineData,
  staff: StaffLayout,
  theme: PaintTheme,
  o: PaintOptions,
  start: StaffLineStart | undefined,
): void {
  const sp = staff.sp;
  const u = sp / 2;
  const bottom = line.y + 2 * sp; // 底线 E4
  const yAt = (step: number): number => bottom - step * u;

  paintStaffStructure(ctx, line, sp, theme);
  const glyphs = line.symbols.filter((s): s is StaffCellGlyph => s.kind === 'note' || s.kind === 'rest');
  if (!start) return;

  /**
   * 谱号位置与谱线的左右端点。谱线两端**与内容对齐**（用户实测两轮）：
   * - 左端 = 谱号墨迹左缘，谱号 / 调号 / 拍号都画在谱线之内；
   * - 右端覆盖所有音符／倚音；结尾有小节线时收在竖线上。
   */
  const sig = keySignature(line.key);
  const { showMeter, clefX, staffLeft, staffRight } = start;
  // 谱线颜色跟音符同墨（记谱惯例就是同一支笔），浅灰在白底上看不清
  ctx.strokeStyle = theme.ink;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  // 谱表始终以竖线封口；有正式小节线时在后面按原样覆盖绘制。
  ctx.beginPath();
  ctx.moveTo(staffLeft, bottom - 4 * sp); ctx.lineTo(staffLeft, bottom);
  ctx.moveTo(staffRight, bottom - 4 * sp); ctx.lineTo(staffRight, bottom);
  ctx.stroke();
  for (let i = 0; i < 5; i += 1) {
    const y = bottom - i * sp;
    ctx.beginPath();
    ctx.moveTo(staffLeft, y);
    ctx.lineTo(staffRight, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 高音谱号 + 调号：贴着谱表左端，不挤占音符的横向位置
  if (line.clef === 'bass') {
    drawFClef(ctx, clefX, yAt(6), sp, theme);
  } else drawGClef(ctx, clefX, yAt(4), sp, theme);
  let kx = clefX + 2 * sp;
  for (const [i, st] of sig.steps.entries()) {
    drawAccidental(ctx, kx, yAt(st - (line.clef === 'bass' ? 2 : 0)), sp, accidentalGlyph(sig.alters[i]), theme);
    kx += 0.9 * sp;
  }
  ctx.save();
  ctx.font = `${Math.round(sp * 1.25)}px ${FAM}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'left';
  ctx.fillText(line.label, staffLeft, line.labelY ?? bottom - sp * 6);
  ctx.restore();

  // 拍号：首行及变拍后的新行显示，普通续行不重复。
  if (showMeter) {
    const [num, den] = (line.beat ?? staff.beat).split('/');
    ctx.font = `700 ${Math.round(sp * 2.3)}px ${FAM}`;
    ctx.fillStyle = theme.ink;
    ctx.fillText(num ?? '4', kx + sp * 0.7, yAt(6));
    ctx.fillText(den ?? '4', kx + sp * 0.7, yAt(2));
  }

  /**
   * 小节号：写在谱表上方那条专属带里（排版层按开关留好位置，见 staffSpacing）。
   * 以前 `showMeasureNumbers` 传进五线谱却没人读，曲谱设置里开关对它无效。
   * 数字跟着小节线的墨迹中心——与简谱同一口径（谱面开头那根边界线不编号）。
   */
  if (staff.showMeasureNumbers && o.showMeasureNumbers !== false && line.measureY !== undefined) {
    ctx.save();
    ctx.font = `600 ${Math.round(sp * 1.25)}px ${FAM}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of line.symbols) {
      if (s.kind !== 'barline' || s.measure === undefined) continue;
      ctx.fillText(String(s.measure), s.x, line.measureY);
    }
    ctx.restore();
  }

  // 小节线 / 反复记号
  for (const s of line.symbols) {
    if (s.kind === 'barline') drawBarline(ctx, s, bottom, sp, theme);
    if (s.kind === 'meter') {
      const [num, den] = s.beat.split('/');
      ctx.font = `700 ${Math.round(sp * 2.3)}px ${FAM}`;
      ctx.fillStyle = theme.ink;
      ctx.fillText(num ?? '4', s.x + sp, yAt(6));
      ctx.fillText(den ?? '4', s.x + sp, yAt(2));
    }
    if (s.kind === 'key') {
      let x = s.x;
      const old = keySignature(s.previousKey);
      const next = keySignature(s.key);
      {
        for (const [i, st] of old.steps.entries()) {
          if (old.sharp === next.sharp && next.alters[i] === old.alters[i]) continue;
          drawAccidental(ctx, x, yAt(st - (line.clef === 'bass' ? 2 : 0)), sp, '♮', theme);
          x += sp * 0.7;
        }
      }
      for (const [i, st] of next.steps.entries()) {
        drawAccidental(ctx, x, yAt(st - (line.clef === 'bass' ? 2 : 0)), sp, accidentalGlyph(next.alters[i]), theme);
        x += sp * 0.7;
      }
    }
  }

  // 底色先画、音符后画：播放不改变符头、符干和变音记号本身的颜色。
  const heads = o.playheads ?? (o.playhead ? [o.playhead] : []);
  const active = new Set(o.playStyle === 'ball' || o.playStyle === 'band' ? [] : heads.map(h => h.eventId));
  ctx.save();
  ctx.lineWidth = Math.max(0.8, sp * 0.1);
  for (const s of glyphs) {
    const selected = o.focusId === s.eventId || o.selectedIds?.has(s.eventId);
    if (s.hidden || (!selected && !active.has(s.eventId))) continue;
    ctx.fillStyle = selected ? theme.selected : theme.playheadBg;
    ctx.strokeStyle = selected ? theme.accent : theme.playhead;
    ctx.beginPath();
    ctx.roundRect(s.x - sp * 1.1, s.y - sp * 0.9, sp * 2.2, sp * 1.8, sp * 0.35);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();

  // 符杠（画在符干末端；符头随后覆盖其上）
  ctx.save();
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = Math.max(1.6, 0.46 * sp);
  ctx.lineCap = 'butt';
  for (const b of line.beams) {
    ctx.strokeStyle = b.gray ? theme.muted : theme.ink;
    ctx.beginPath();
    ctx.moveTo(b.x0, b.y0);
    ctx.lineTo(b.x1, b.y1);
    ctx.stroke();
  }
  ctx.restore();

  // 符干（全音符没有符干）：带符杠的音画到**符杠上**（长度随斜杠变），
  // 没符杠的音用固定长度（一个八度）。粗细按记谱惯例取 ~0.15sp——
  // 1.5px 起跳在 7.5px 线间距下偏粗（用户实测），1px 起跳又细到看不清
  ctx.lineWidth = Math.max(1.15, 0.15 * sp);
  for (const s of glyphs) {
    if (s.kind !== 'note' || (s.baseTicks ?? s.ticks) >= TICKS_PER_BEAT * 4) continue;
    // 与 staff.ts 的 stemX 同一公式：符干贴着符头右缘（上）/ 左缘（下）
    const sx = s.x + (s.up ? 1 : -1) * (sp * HEAD_RX - 0.4);
    const end = s.beamEnd ?? s.y + (s.up ? -STEM_OCT * u : STEM_OCT * u);
    ctx.strokeStyle = s.gray ? theme.muted : theme.ink;
    ctx.beginPath();
    ctx.moveTo(sx, s.y);
    ctx.lineTo(sx, end);
    ctx.stroke();
    if (s.beamEnd === undefined) {
      const dir = s.up ? 1 : -1;
      ctx.fillStyle = s.gray ? theme.muted : theme.ink;
      for (let i = 0; i < s.beams; i += 1) {
        const fy = end + dir * i * sp * 0.65;
        ctx.beginPath();
        ctx.moveTo(sx, fy);
        ctx.bezierCurveTo(sx + sp * 1.3, fy + dir * sp * 0.6, sx + sp * 1.2, fy + dir * sp * 1.5, sx + sp * 0.45, fy + dir * sp * 2);
        ctx.bezierCurveTo(sx + sp * 0.9, fy + dir * sp, sx + sp * 0.65, fy + dir * sp * 0.9, sx, fy + dir * sp * 0.45);
        ctx.fill();
      }
    }
  }

  // 符头 / 休止符
  for (const s of glyphs) drawCell(ctx, s, sp, theme);
  for (const group of line.graces) paintStaffGrace(ctx, group, sp, theme);

  for (const tuplet of line.tuplets ?? []) {
    const cx = (tuplet.x0 + tuplet.x1) / 2;
    ctx.fillStyle = theme.ink;
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 1;
    ctx.font = `600 ${Math.round(sp * 1.5)}px ${FAM}`;
    ctx.fillText(tuplet.text, cx, tuplet.y);
    if (tuplet.bracket) {
      const gap = ctx.measureText(tuplet.text).width / 2 + sp * 0.35;
      ctx.beginPath();
      ctx.moveTo(tuplet.x0, tuplet.y + sp * 0.6);
      ctx.lineTo(tuplet.x0, tuplet.y);
      ctx.lineTo(cx - gap, tuplet.y);
      ctx.moveTo(cx + gap, tuplet.y);
      ctx.lineTo(tuplet.x1, tuplet.y);
      ctx.lineTo(tuplet.x1, tuplet.y + sp * 0.6);
      ctx.stroke();
    }
  }

  // 歌词
  if (line.lyrics.length) {
    ctx.font = `600 ${Math.round(sp * 2)}px ${FAM}`;
    ctx.fillStyle = theme.ink;
    for (const l of line.lyrics) {
      ctx.fillText(l.text, l.x, (line.lyricY ?? bottom + 3.4 * sp) + l.verse * sp * 3);
    }
  }
  ctx.strokeStyle = theme.ink;
  paintLyricLines(ctx, line.lyricLines, verse => (line.lyricY ?? bottom + 3.4 * sp) + verse * sp * 3, sp * 2);

}

function drawCell(
  ctx: CanvasRenderingContext2D,
  s: StaffCellGlyph,
  sp: number,
  theme: PaintTheme,
): void {
  if (s.hidden) return;
  const rx = sp * HEAD_RX;
  const ry = sp * HEAD_RY;
  ctx.save();
  const ink = s.gray ? theme.muted : theme.ink;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;

  if (s.kind === 'rest') {
    drawRest(ctx, s.x, s.y, restKindOf(s.baseTicks ?? s.ticks), sp, theme);
    for (let i = 0; i < s.dots; i += 1) {
      ctx.beginPath();
      ctx.arc(s.x + sp * (0.9 + i * 0.34), s.y - sp * 0.5, Math.max(1, sp * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  // 加线：线在偶数格、间在奇数格，谱表外的偶数格各补一条
  ctx.lineWidth = 1;
  const ledger = (st: number): void => {
    const dy = (s.step - st) * (sp / 2);
    const y = Math.round(s.y + dy) + 0.5;
    ctx.beginPath();
    ctx.moveTo(s.x - rx - sp * 0.28, y);
    ctx.lineTo(s.x + rx + sp * 0.28, y);
    ctx.stroke();
  };
  for (let st = -2; st >= s.step; st -= 2) ledger(st);
  for (let st = 10; st <= s.step; st += 2) ledger(st);

  // 临时升降号
  if (s.accMark) {
    drawAccidental(ctx, s.x - rx - sp * 0.42, s.y, sp, s.accMark, theme);
  }

  // 符头：二分 / 全音符空心，其余实心
  ctx.beginPath();
  ctx.ellipse(s.x, s.y, rx, ry, -0.35, 0, Math.PI * 2);
  if ((s.baseTicks ?? s.ticks) >= TICKS_PER_BEAT * 2) ctx.stroke();
  else ctx.fill();

  // 附点：贴在符头右侧、略高一点（避开谱线）
  for (let i = 0; i < s.dots; i += 1) {
    ctx.beginPath();
    ctx.arc(s.x + rx + sp * 0.36 + i * sp * 0.34, s.y - sp * 0.1, Math.max(1, sp * 0.12), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 按实际字形墨迹居中，避免字体的 middle 基线把低音谱号抬到谱表上方。 */
function drawFClef(ctx: CanvasRenderingContext2D, x: number, fY: number, sp: number, theme: PaintTheme): void {
  ctx.save();
  ctx.font = `${Math.round(sp * 3.4)}px ${CLEF_FAM}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme.ink;
  const symbol = '\u{1D122}';
  const metrics = ctx.measureText(symbol);
  const centerY = fY + .75 * sp;
  ctx.fillText(symbol, x, centerY + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
  ctx.restore();
}

/** 临时升降号，也用来画调号里的升降号 */
function drawAccidental(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  sp: number,
  mark: string,
  theme: PaintTheme,
): void {
  ctx.save();
  ctx.font = `600 ${Math.round(sp * 2.1)}px ${CLEF_FAM}, ${FAM}`;
  ctx.fillStyle = theme.ink;
  ctx.fillText(mark, x, y);
  ctx.restore();
}

/**
 * 高音谱号（G 谱号）：直接用 Unicode 音乐符号 𝄞（U+1D11E）。
 * 手画贝塞尔曲线怎么调都像个「小卷线」（用户实测），字形则是排印级的标准形；
 * Windows 8+ 的 Segoe UI Symbol 自带该字符，后面再挂 Bravura / Noto Music 兜底。
 * 字号取 4.2sp，避免谱号压过整行音符；
 * 螺旋对准 G 线（step 2）：螺旋转点在字形中心上方 ≈0.23em，随字号等比。
 */
function drawGClef(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  sp: number,
  theme: PaintTheme,
): void {
  ctx.save();
  const fs = sp * 4.2;
  ctx.font = `${Math.round(fs)}px ${CLEF_FAM}`;
  ctx.fillStyle = theme.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 螺旋比字形中心高 0.23em，要落到 G 线（cy − sp）：字形中心 = G线 + 0.23em − sp
  ctx.fillText('\u{1D11E}', cx, cy + 0.23 * fs - sp);
  ctx.restore();
}

/** 休止符：全 / 二分用方块，四分及以下用折线加旗 */
function drawRest(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  kind: string,
  sp: number,
  theme: PaintTheme,
): void {
  ctx.save();
  ctx.strokeStyle = theme.ink;
  ctx.fillStyle = theme.ink;
  ctx.lineWidth = Math.max(1.1, 0.14 * sp);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (kind === 'whole') {
    ctx.fillRect(x - sp * 0.45, y - sp, sp * 0.9, sp * 0.5);
  } else if (kind === 'half') {
    ctx.fillRect(x - sp * 0.45, y - sp * 0.5, sp * 0.9, sp * 0.5);
  } else if (kind === 'quarter') {
    const top = y - sp * 1.2;
    ctx.beginPath();
    ctx.moveTo(x - sp * 0.3, top);
    ctx.lineTo(x + sp * 0.42, top + sp * 0.7);
    ctx.lineTo(x - sp * 0.3, top + sp * 1.5);
    ctx.lineTo(x + sp * 0.42, top + sp * 2.3);
    ctx.stroke();
  } else {
    const flags = kind === 'eighth' ? 1 : kind === 'sixteenth' ? 2 : 3;
    const top = y - sp * 0.8;
    ctx.beginPath();
    ctx.moveTo(x + sp * 0.45, top);
    ctx.lineTo(x - sp * 0.15, top + sp * (1.6 + (flags - 1) * 0.6));
    ctx.stroke();
    for (let i = 0; i < flags; i += 1) {
      const fy = top + i * sp * 0.6;
      ctx.beginPath();
      ctx.arc(x - sp * 0.15, fy + sp * 0.2, sp * 0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - sp * 0.15, fy + sp * 0.4);
      ctx.quadraticCurveTo(x + sp * 0.3, fy + sp * 0.5, x + sp * 0.45 - i * sp * 0.13, fy);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** 小节线：普通 / 终止线 / 反复（两侧加双点） */
function drawBarline(
  ctx: CanvasRenderingContext2D,
  s: StaffBarline,
  bottom: number,
  sp: number,
  theme: PaintTheme,
): void {
  const y0 = bottom - 4 * sp;
  ctx.save();
  ctx.strokeStyle = s.repeat ? theme.ink : s.final ? theme.barFinal : theme.bar;
  const stroke = (x: number, width: number) => {
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  };
  const thin = Math.max(.9, sp * .115), heavy = Math.max(2.2, sp * .28);
  stroke(s.x, s.repeat || s.final ? heavy : thin);
  if (s.repeat === 'both') {
    // 双向反复（:||:）：粗线居中，两侧各「细线 + 点」（画法与单侧反复一致）
    stroke(s.x, heavy);
    stroke(s.x - sp * 0.6, thin);
    stroke(s.x + sp * 0.6, thin);
    ctx.fillStyle = theme.ink;
    for (const yy of [bottom - sp * 1.5, bottom - sp * 2.5]) {
      for (const dx of [-sp * 1.25, sp * 1.25]) {
        ctx.beginPath();
        ctx.arc(s.x + dx, yy, Math.max(1.2, sp * 0.17), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (s.repeat) {
    const dir = s.repeat === 'start' ? 1 : -1;
    stroke(s.x + dir * sp * .6, thin);
    ctx.fillStyle = theme.ink;
    for (const yy of [bottom - sp * 1.5, bottom - sp * 2.5]) {
      ctx.beginPath();
      ctx.arc(s.x + dir * sp * 1.25, yy, Math.max(1.2, sp * .17), 0, Math.PI * 2);
      ctx.fill();
    }
    if (s.repeat === 'end' && (s.repeatTimes ?? 2) > 2) {
      ctx.font = `600 ${sp * 1.3}px ${FAM}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`×${s.repeatTimes}`, s.x, y0 - sp);
    }
  } else if (s.final) stroke(s.x - sp * .6, thin);
  else if (s.double) stroke(s.x - sp * .6, thin);
  ctx.restore();
  // 谱中变速 / 换音色标注（0.4.10）：小节线上方「♩=96 · 小提琴」，
  // muted 灰不抢音符的注意力；音色只写简略名，括号备注只留在下拉列表里
  const labels: string[] = [];
  if (s.bpmAfter !== undefined) labels.push(`♩=${s.bpmAfter}`);
  if (s.patchAfter !== undefined) labels.push(shortInstrumentLabel(s.patchAfter) ?? `音色 ${s.patchAfter}`);
  if (labels.length) {
    ctx.save();
    ctx.font = `600 ${Math.round(sp * 1.4)}px ${FAM}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(labels.join(' · '), s.x, y0 - sp * 1.4);
    ctx.restore();
  }
}
