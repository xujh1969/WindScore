/**
 * 打包文件的容器：最小可用的 **ZIP（store 方式，不压缩）**。
 *
 * 为什么自己写：一首打包要塞进谱面（几 KB）+ 标定（几 KB）+ 伴奏（几 MB 到几十 MB），
 * 而伴奏本身已经是压缩过的（mp3 / wav），再压一遍几乎不减体积、还多耗时间。
 * 自研 store 方式的 zip 一百多行就够，零依赖，产出又是任何系统都能打开的标准格式。
 *
 * 只用两种块：本地文件头 + 数据、中央目录 + EOCD。不写数据描述符，
 * CRC / 大小都预先算好——解压端因此只需顺着中央目录读，非常稳。
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// ── CRC32 ────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── 写 ────────────────────────────────────────────────────

const enc = new TextEncoder();

/**
 * DOS 时间戳（本地时区）。zip 里只有 2 秒精度，够用——
 * 打包文件的时间主要给人看，不参与任何逻辑。
 */
function dosTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * 打包成 zip 字节流。
 * 文件名统一 UTF-8（置 general purpose bit 11），中文曲名不会变乱码。
 */
export function zipStore(entries: ZipEntry[], when = new Date()): Uint8Array {
  const { time, date } = dosTime(when);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length + e.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 本地文件头签名
    lv.setUint16(4, 20, true); // 解压所需版本
    lv.setUint16(6, 0x0800, true); // bit 11：文件名是 UTF-8
    lv.setUint16(8, 0, true); // 方式 0 = 不压缩
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // 扩展字段长度
    local.set(name, 30);
    local.set(e.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // 产生者版本
    cv.setUint16(6, 20, true); // 解压所需版本
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true); // 本地头的偏移
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const total = (a: Uint8Array[]): number => a.reduce((n, x) => n + x.length, 0);
  const centralSize = total(centrals);
  const out = new Uint8Array(total(locals) + centralSize + 22);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  for (const c of centrals) {
    out.set(c, p);
    p += c.length;
  }
  const ev = new DataView(out.buffer, p);
  ev.setUint32(0, 0x06054b50, true); // EOCD
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, total(locals), true);
  return out;
}

// ── 读 ────────────────────────────────────────────────────

const dec = new TextDecoder();

/** 从尾部往前找 EOCD（末尾可能有注释，长度写在 EOCD 里） */
function findEocd(data: Uint8Array): number {
  const min = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= min; i -= 1) {
    if (new DataView(data.buffer, data.byteOffset + i, 4).getUint32(0, true) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 解出 zip 里的所有条目。
 * 只认**不压缩**的条目（我们自己写的就是这种）；遇到压缩过的明确报错，
 * 不静默给出乱码——那比报错更难查。
 */
export function unzip(data: Uint8Array): ZipEntry[] {
  const eocd = findEocd(data);
  if (eocd < 0) throw new Error('不是有效的 zip 打包文件（找不到结尾标记）');
  const ev = new DataView(data.buffer, data.byteOffset + eocd);
  const count = ev.getUint16(10, true);
  let p = ev.getUint32(16, true); // 中央目录起点（相对文件头）
  const out: ZipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    const dv = new DataView(data.buffer, data.byteOffset + p);
    if (dv.getUint32(0, true) !== 0x02014b50) throw new Error('打包文件的目录损坏');
    const method = dv.getUint16(10, true);
    const size = dv.getUint32(24, true);
    const nameLen = dv.getUint16(28, true);
    const extraLen = dv.getUint16(30, true);
    const commentLen = dv.getUint16(32, true);
    const localAt = dv.getUint32(42, true);
    const name = dec.decode(data.subarray(p + 46, p + 46 + nameLen));

    if (method !== 0) throw new Error(`打包里的 ${name} 是压缩过的，本应用只支持不压缩的打包`);
    const lv = new DataView(data.buffer, data.byteOffset + localAt);
    const lNameLen = lv.getUint16(26, true);
    const lExtraLen = lv.getUint16(28, true);
    const bodyAt = localAt + 30 + lNameLen + lExtraLen;
    out.push({ name, data: data.slice(bodyAt, bodyAt + size) });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
