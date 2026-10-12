import { parseDsl } from '../src/v2/dsl';
import { setHairpinRange, setMeta } from '../src/v2/edit';
import { layoutScore } from '../src/v2/layout';
import { paintLayout } from '../src/v2/paint';
import type { LayoutResult, PaintTheme } from '../src/v2/layout';
import * as fs from 'node:fs';

// 软件光栅化：把 paintLayout 的所有绘制画进像素缓冲，导出 BMP 供人工检查
const W = 940, H = 400;
const buf = Buffer.alloc(W * H * 3, 0x18); // 深色底 #18181b
const setPx = (x: number, y: number, r: number, g: number, b: number) => {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 3;
  buf[o] = b; buf[o + 1] = g; buf[o + 2] = r;
};
const colorOf = { stroke: [217, 178, 60], fill: [228, 228, 227], other: [120, 120, 130] };
let mode: 'stroke' | 'fill' | 'other' = 'other';
let pen: { x: number; y: number } | null = null;
let cur: { x: number; y: number } | null = null;
const line = (x1: number, y1: number, x2: number, y2: number) => {
  const c = colorOf[mode];
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    setPx(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, c[0], c[1], c[2]);
  }
};
const ctx: any = {
  setTransform() {}, measureText: () => ({ width: 13 }),
  save() {}, restore() {}, clip() {}, translate() {}, rotate() {}, scale() {},
  beginPath() { pen = null; cur = null; },
  moveTo(x: number, y: number) { pen = { x, y }; cur = { x, y }; },
  lineTo(x: number, y: number) { if (cur) line(cur.x, cur.y, x, y); cur = { x, y }; },
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    if (!cur) return;
    for (let i = 1; i <= 24; i++) { const t = i / 24; const mx = (1 - t) ** 2 * cur.x + 2 * (1 - t) * t * cx + t * t * x; const my = (1 - t) ** 2 * cur.y + 2 * (1 - t) * t * cy + t * t * y; line(cur.x, cur.y, mx, my); cur = { x: mx, y: my }; }
  },
  arc(x: number, y: number, r: number) { if (cur) line(cur.x, cur.y, x + r, y); },
  ellipse(cx: number, cy: number, rx: number, ry: number, _rot: number, a0: number, a1: number) {
    for (let i = 0; i <= 32; i++) { const a = a0 + (a1 - a0) * (i / 32); setPx(cx + rx * Math.cos(a), cy + ry * Math.sin(a), colorOf[mode][0], colorOf[mode][1], colorOf[mode][2]); }
  },
  roundRect(x: number, y: number, w: number, h: number) {
    for (let xx = 0; xx < w; xx++) { setPx(x + xx, y, 90, 71, 21); setPx(x + xx, y + h, 90, 71, 21); }
    for (let yy = 0; yy < h; yy++) { setPx(x, y + yy, 90, 71, 21); setPx(x + w, y + yy, 90, 71, 21); }
  },
  fillRect(x: number, y: number, w: number, h: number) {
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) setPx(x + xx, y + yy, colorOf[mode][0], colorOf[mode][1], colorOf[mode][2]);
  },
  fillText(t: string, x: number, y: number) {
    // 文字画成 5px 高的小块占位（能看出位置，不追求字形）
    for (let d = 0; d < String(t).length * 6; d++) for (let yy = 0; yy < 5; yy++) setPx(x + d, y - 4 + yy, 200, 200, 210);
  },
  stroke() {}, fill() {},
  createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
  setLineDash() {},
};
for (const k of ['font', 'textAlign', 'textBaseline', 'lineWidth', 'lineCap', 'lineJoin', 'globalAlpha', 'shadowColor', 'shadowBlur', 'canvas']) Object.defineProperty(ctx, k, { set() {}, get() { return null; } });
Object.defineProperty(ctx, 'globalCompositeOperation', { set(v: any) { mode = v === 'lighter' ? 'other' : mode; }, get() { return null; } });
// strokeStyle/fillStyle 驱动 mode
Object.defineProperty(ctx, 'strokeStyle', { set() { mode = 'stroke'; }, get() { return null; } });
Object.defineProperty(ctx, 'fillStyle', { set(v: any) { mode = v === '#18181b' || v === '#ffffff' ? 'other' : 'fill'; }, get() { return null; } });

const text = fs.readFileSync('C:/Users/AYOU/Desktop/月光下的凤尾竹.jps', 'utf8');
let s = parseDsl(text).score!;
s = setMeta(s, { fontSize: 23 });
const notes = s.events.filter((e) => e.kind === 'note') as { id: string }[];
s = setHairpinRange(s, notes.slice(-2).map((n) => n.id), 'dim');
const lay: LayoutResult = layoutScore(s, { contentWidth: 900 });
const theme = { dark: true } as unknown as PaintTheme;
// 只渲染最后一行：把 transform 平移到该行
const last = lay.lines[lay.lines.length - 1]!;
const offY = 60 - last.y; // 把最后一行平移到画布 y=60 处
const ctxShift: any = new Proxy(ctx, {
  get(t, prop) {
    if (prop === 'moveTo' || prop === 'lineTo' || prop === 'quadraticCurveTo' || prop === 'ellipse' || prop === 'roundRect') {
      return (...args: any[]) => {
        const c = t[prop];
        // y 平移：倒数第二个/特定位置参数是 y——逐方法处理
        if (prop === 'moveTo' || prop === 'lineTo') { args[1] += offY - 0; return c.call(t, args[0], args[1]); }
        if (prop === 'quadraticCurveTo') { args[1] += offY; args[3] += offY; return c.call(t, ...args); }
        if (prop === 'ellipse') { args[1] += offY; return c.call(t, ...args); }
        if (prop === 'roundRect') { args[1] += offY; return c.call(t, ...args); }
      };
    }
    if (prop === 'fillRect' || prop === 'fillText') {
      return (...args: any[]) => { const c = t[prop]; if (prop === 'fillRect') { args[1] += offY; } else { args[1] += offY; } return c.call(t, ...args); };
    }
    return (t as any)[prop];
  },
});
paintLayout(ctxShift, lay, theme, { height: H, playheads: [] });

// PNG 导出（RGB，zlib 压缩）
import { deflateSync } from 'node:zlib';
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (d: Buffer): number => { let c = 0xffffffff; for (const b of d) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4); len.writeUInt32LE(data.length, 0); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
const raw = Buffer.alloc(H * (1 + W * 3));
for (let yy = 0; yy < H; yy++) {
  raw[yy * (1 + W * 3)] = 0; // filter none
  buf.copy(raw, yy * (1 + W * 3) + 1, yy * W * 3, (yy + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync('.tmp-wedge.png', png);
console.log('written .tmp-wedge.png; last line y=', last.y.toFixed(0));
