/**
 * 生成 Tauri 所需图标（无外部依赖，纯 Node 手写 PNG / ICO / ICNS）
 * 图案：香槟金渐变底 + 白色音符（符头 + 符干 + 符尾）
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'src-tauri', 'icons');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** pixel(x, y, size) -> [r,g,b,a] */
function renderPNG(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

function windScorePixel(x, y, size) {
  const t = y / size;
  // 香槟金渐变：#E8C98A -> #C9A227
  let r = Math.round(232 + (201 - 232) * t);
  let g = Math.round(201 + (162 - 201) * t);
  let b = Math.round(138 + (39 - 138) * t);

  const white = [255, 255, 255, 255];
  // 符头（略倾斜的圆）
  if (inEllipse(x, y, size * 0.4, size * 0.7, size * 0.19, size * 0.145)) return white;
  // 符干
  if (x >= size * 0.55 && x < size * 0.63 && y >= size * 0.22 && y < size * 0.7) return white;
  // 符尾
  if (x >= size * 0.6 && x < size * 0.82 && y >= size * 0.2 && y < size * 0.4) {
    const k = (y - size * 0.2) / (size * 0.2);
    if (x < size * 0.6 + (size * 0.22) * (1 - k)) return white;
  }
  return [r, g, b, 255];
}

/** 从 RGBA 像素生成 ICO（32x32，含 AND mask） */
function renderICO(size, pixel) {
  const rowSize = size * 4;
  const xor = Buffer.alloc(rowSize * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      // DIB 自下而上，BGRA
      const off = ((size - 1 - y) * size + x) * 4;
      xor[off] = b;
      xor[off + 1] = g;
      xor[off + 2] = r;
      xor[off + 3] = a;
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(maskRow * size); // 全 0 = 不透明

  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8); // XOR + AND
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(xor.length + andMask.length, 20);

  const image = Buffer.concat([dib, xor, andMask]);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, image]);
}

/** ICNS：仅含 ic07（128x128 PNG） */
function renderICNS(png128) {
  const block = Buffer.concat([Buffer.from('ic07', 'ascii'), (() => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(png128.length + 8, 0);
    return l;
  })(), png128]);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(block.length + 8, 4);
  return Buffer.concat([head, block]);
}

fs.mkdirSync(OUT, { recursive: true });

const p32 = renderPNG(32, windScorePixel);
const p128 = renderPNG(128, windScorePixel);
const p256 = renderPNG(256, windScorePixel);
const p512 = renderPNG(512, windScorePixel);

fs.writeFileSync(path.join(OUT, '32x32.png'), p32);
fs.writeFileSync(path.join(OUT, '128x128.png'), p128);
fs.writeFileSync(path.join(OUT, '128x128@2x.png'), p256);
fs.writeFileSync(path.join(OUT, 'icon.png'), p512);
fs.writeFileSync(path.join(OUT, 'icon.ico'), renderICO(32, windScorePixel));
fs.writeFileSync(path.join(OUT, 'icon.icns'), renderICNS(p128));

console.log('icons generated:', fs.readdirSync(OUT).join(', '));
