import { parseDsl } from '../src/v2/dsl';
import { setHairpinRange, setMeta } from '../src/v2/edit';
import { layoutScore } from '../src/v2/layout';
import { paintLayout } from '../src/v2/paint';
import type { LayoutResult, PaintTheme } from '../src/v2/layout';
import * as fs from 'node:fs';

const segments: { x1: number; y1: number; x2: number; y2: number }[] = [];
let pen: { x: number; y: number } | null = null;
let cur: { x: number; y: number } | null = null;
const seg = (x2: number, y2: number) => { if (cur) segments.push({ x1: cur.x, y1: cur.y, x2, y2 }); cur = { x: x2, y: y2 }; };
const ctx: any = {
  setTransform() {}, fillRect() {}, fillText() {}, measureText: () => ({ width: 13 }),
  save() {}, restore() {}, fill() {}, stroke() { if (pen && cur) segments.push({ x1: pen.x, y1: pen.y, x2: cur.x, y2: cur.y }); },
  beginPath() { pen = null; cur = null; },
  moveTo(x: number, y: number) { pen = { x, y }; cur = { x, y }; },
  lineTo(x: number, y: number) { seg(x, y); },
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    if (!cur) return;
    for (let i = 1; i <= 12; i++) { const t = i / 12; const mx = (1 - t) * (1 - t) * cur.x + 2 * (1 - t) * t * cx + t * t * x; const my = (1 - t) * (1 - t) * cur.y + 2 * (1 - t) * t * cy + t * t * y; seg(mx, my); }
  },
  arc() {}, ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, a0: number, a1: number) {
    if (!cur) return;
    for (let i = 1; i <= 16; i++) { const a = a0 + (a1 - a0) * (i / 16); seg(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); }
  },
  roundRect() {}, clip() {}, translate() {}, rotate() {}, scale() {}, drawImage() {},
  createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
  setLineDash() {},
};
for (const k of ['fillStyle', 'strokeStyle', 'font', 'textAlign', 'textBaseline', 'lineWidth', 'lineCap', 'lineJoin', 'globalAlpha', 'globalCompositeOperation', 'shadowColor', 'shadowBlur', 'canvas']) Object.defineProperty(ctx, k, { set() {}, get() { return null; } });

const text = fs.readFileSync('C:/Users/AYOU/Desktop/月光下的凤尾竹.jps', 'utf8');
let s = parseDsl(text).score!;
s = setMeta(s, { fontSize: 23 });
const notes = s.events.filter((e) => e.kind === 'note') as { id: string }[];
s = setHairpinRange(s, notes.slice(-2).map((n) => n.id), 'dim');
const lay: LayoutResult = layoutScore(s, { contentWidth: 900 });
const theme = { dark: true } as PaintTheme;
paintLayout(ctx as any, lay, theme, { height: lay.height + 32, playheads: [] });

const last = lay.lines[lay.lines.length - 1]!;
console.log('spans:', JSON.stringify((last.hairpins ?? []).map((p) => ({ ...p, x0: +p.x0.toFixed(1), x1: +p.x1.toFixed(1), so: +p.startOpen.toFixed(2), eo: +p.endOpen.toFixed(2) }))));
const y = last.y;
const k = lay.glyph.fontSize / 21;
const cy = y + 20 * k + 14 * k;
console.log('line.y:', y.toFixed(1), 'k:', k.toFixed(3), 'cy≈', cy.toFixed(1), 'markBottom guess 20k');
// 画整行（y-30 到 y+55）
const x0 = Math.min(...last.items.map((it) => it.x)) - 10;
const x1 = Math.max(...last.items.map((it) => it.x + it.w)) + 10;
const W = 118, H = 26;
const yTop = y - 34, yBot = y + 56;
const grid: string[][] = Array.from({ length: H }, () => Array(W).fill(' '));
for (const sg of segments) {
  if (Math.max(sg.y1, sg.y2) < yTop || Math.min(sg.y1, sg.y2) > yBot) continue;
  if (Math.max(sg.x1, sg.x2) < x0 || Math.min(sg.x1, sg.x2) > x1) continue;
  const steps = Math.ceil(Math.hypot(sg.x2 - sg.x1, sg.y2 - sg.y1)) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = sg.x1 + (sg.x2 - sg.x1) * t;
    const py = sg.y1 + (sg.y2 - sg.y1) * t;
    if (px < x0 || px > x1 || py < yTop || py > yBot) continue;
    const gx = Math.round(((px - x0) / (x1 - x0)) * (W - 1));
    const gy = Math.round(((py - yTop) / (yBot - yTop)) * (H - 1));
    if (grid[gy]?.[gx] === ' ') grid[gy][gx] = '·';
  }
}
console.log(grid.map((r) => r.join('')).join('\n'));
// 楔形线段精确坐标（x 在 span 范围内、y 在行下方 20-60px）
for (const sg of segments) {
  if (sg.y1 < y + 18 && sg.y2 < y + 18) continue;
  if (sg.x1 < 150 || sg.x1 > 340) continue;
  console.log('seg', sg.x1.toFixed(1), sg.y1.toFixed(1), '→', sg.x2.toFixed(1), sg.y2.toFixed(1));
}
