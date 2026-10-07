/**
 * 导出 PDF（A4 分页 + 页尾页码）。
 *
 * 做法：**每一页就是一张 JPEG 图**，整页塞进 PDF。
 *   - 不嵌字体、不做矢量排版 → 页脚里的中文歌名白拿（canvas 已经在页面上画好了，
 *     PDF 里只是一块像素），也不用做字体子集化（一个中文字体动辄十几 MB）
 *   - 代价：文件比矢量 PDF 大、不能选文字/检索。对「打印出来 / 发给别人看」
 *     这个用途刚好够用；真要矢量输出应该另做一条 jps → PDF 的排版路径。
 *
 * 这一文件**不碰 canvas**，全是纯计算，所以能进 node 单测：
 * 分页（planPages）与字节组装（buildPdf）都与画布无关。
 */

/** A4 尺寸（PDF 点，1pt = 1/72 inch） */
export const A4_PT = { w: 595.28, h: 841.89 } as const;

/** 一页 PDF 的内容：一整页的位图 */
export interface PdfImagePage {
  /** JPEG 字节（canvas.toBlob('image/jpeg') 的结果） */
  jpeg: Uint8Array;
  width: number;
  height: number;
}

/** 一页的可用纵向区间（**排版坐标**，不是像素） */
export interface PageBand {
  top: number;
  bottom: number;
}

/** 一页装哪些行，以及为了把首行摆到带顶要平移多少 */
export interface PagePlan {
  /** 行下标区间 [from, to) */
  from: number;
  to: number;
  /** 绘制时把版面整体上移这个量（排版坐标） */
  offset: number;
}

/**
 * 按「每页可用带」把谱面行分页。
 *
 * 每页都有一个 offset：绘制时把版面整体上移这么多，让**该页首行落在带顶**。
 * 这不是可有可无的偏移——不摆齐的话，换页后那一行的绝对 y 仍可能落在带底之下，
 * 于是永远开不出新页（死循环 / 空页）。
 *
 * @param lineY    每行的基线 y（排版坐标，必须递增）
 * @param lineH    行高。半行高之外再多留 6px：房子的遍数数字会画到行顶上方约 39px
 * @param firstBand 首页可用带
 * @param restBand 其余页可用带
 * @param firstOffset 首页的 offset。首页要保住标题块，所以一般不摆齐（传 0）；
 *                   标题顶到页边时传一个正值把内容整体下移
 */
export function planPages(
  lineY: readonly number[],
  lineH: number,
  firstBand: PageBand,
  restBand: PageBand,
  firstOffset = 0,
): PagePlan[] {
  if (lineY.length === 0) return [];
  const half = lineH / 2 + 6;
  const pages: PagePlan[] = [];
  let from = 0;
  let band = firstBand;
  let offset = firstOffset;

  for (let i = 0; i < lineY.length; i += 1) {
    if (i > from && lineY[i]! - offset + half > band.bottom) {
      pages.push({ from, to: i, offset });
      from = i;
      band = restBand;
      // 新的一页从带顶开始摆：让首行的**上沿**（不是基线）贴住带顶，
      // 否则它上方的减时线 / 房子数字会探出版心
      offset = lineY[i]! - band.top - half;
      continue;
    }
    // 带高连一行都装不下（单行就高过整页）：硬放这一页，别开空白页也别死循环
    if (i === from && lineY[i]! - offset + half > band.bottom) {
      pages.push({ from, to: i + 1, offset });
      from = i + 1;
    }
  }
  if (from < lineY.length) pages.push({ from, to: lineY.length, offset });
  return pages;
}

// ─────────────────────────── 字节组装 ───────────────────────────

class ByteSink {
  private parts: Uint8Array[] = [];
  private total = 0;
  private enc = new TextEncoder();

  get length(): number {
    return this.total;
  }

  /** 二进制与 ASCII 文本混排：偏移量按字节算，所以文本一律走 TextEncoder */
  push(data: Uint8Array | string): void {
    const b = typeof data === 'string' ? this.enc.encode(data) : data;
    this.parts.push(b);
    this.total += b.length;
  }

  toUint8(): Uint8Array {
    const out = new Uint8Array(this.total);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');

/**
 * PDF 文本串（UTF-16BE + BOM 的十六进制写法）。
 * PDF 里除字体外没有「编码」概念，非 Latin-1 的文字就靠这个约定；
 * 这样文档标题里的中文歌名在阅读器属性栏里也是对的。
 */
export function pdfTextString(s: string): string {
  let out = '<FEFF';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c > 0xffff) {
      const v = c - 0x10000;
      out += hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
    } else {
      out += hex4(c);
    }
  }
  return `${out}>`;
}

/**
 * 组装 PDF：每页一个 XObject 位图铺满整页。
 *
 * 对象编号：1 = Catalog，2 = Pages，3 = Info，之后**每页三个**
 * （位图 XObject + 内容流 + `/Type /Page` 页对象）。
 * 少写页对象是最容易犯也最致命的错：页树的 /Kids 必须指向 **Page**，
 * 指向图片的话查看器按规范找不到任何页 → 打开是空白（踩过一次）。
 *
 * xref 表必须逐字节对齐，所以所有偏移都按**字节**累加（文本统一走 TextEncoder，
 * 不能用 string.length）。
 */
export function buildPdf(
  pages: readonly PdfImagePage[],
  pageW: number,
  pageH: number,
  meta: { title?: string } = {},
): Uint8Array {
  const sink = new ByteSink();
  const imgObj = (i: number): number => 4 + i * 3;
  const contentObj = (i: number): number => 5 + i * 3;
  const pageObj = (i: number): number => 6 + i * 3;
  const objCount = 3 + pages.length * 3;

  sink.push('%PDF-1.4\n');
  // 二进制注释：告诉工具「这是二进制文件」，别按文本处理
  sink.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  /** 记录每个对象的起始偏移（写 xref 用） */
  const offsets: number[] = new Array(objCount + 1).fill(0);
  const begin = (num: number): void => {
    offsets[num] = sink.length;
    sink.push(`${num} 0 obj\n`);
  };

  begin(1);
  sink.push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  begin(2);
  sink.push(
    `<< /Type /Pages /Kids [ ${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')} ] ` +
      `/Count ${pages.length} >>\nendobj\n`,
  );

  begin(3);
  sink.push(
    `<< /Title ${pdfTextString(meta.title ?? 'WindScore 导出')} /Producer ${pdfTextString('WindScore')} >>\nendobj\n`,
  );

  pages.forEach((p, i) => {
    begin(imgObj(i));
    sink.push(
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
    );
    sink.push(p.jpeg);
    sink.push('\nendstream\nendobj\n');

    // 位图按页面尺寸铺满（页面与图同宽高比，直接拉满即可）
    const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
    begin(contentObj(i));
    sink.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

    begin(pageObj(i));
    sink.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
        `/Resources << /XObject << /Im0 ${imgObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>\nendobj\n`,
    );
  });

  const xrefAt = sink.length;
  sink.push(`xref\n0 ${objCount + 1}\n`);
  // 0 号是链表头，必须占一行；每条固定 20 字节（%010d %05d n␣␊）
  sink.push('0000000000 65535 f \n');
  for (let n = 1; n <= objCount; n += 1) {
    sink.push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  }
  sink.push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R /Info 3 0 R >>\n`);
  sink.push(`startxref\n${xrefAt}\n%%EOF\n`);

  return sink.toUint8();
}
