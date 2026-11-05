// PDF 按整页转图并二值化，预览与识别复用同一组像素。
import { pdfPagesToImages } from '../dolce/omrkit/decode.browser'
import { rgbaToBinary } from '../dolce/omrkit/preprocess'
import type { Binary } from '../dolce/omrkit/types'

/** PDF 字节 → 每页一张二值图（按页序）。 */
export async function decodePdfPageBins(bytes: Uint8Array): Promise<Binary[]> {
  const imgs = await pdfPagesToImages(bytes)
  return imgs.map((img) => rgbaToBinary(img.data, img.width, img.height))
}

/** 复用已预览的页面像素，避免识别时再次打开 PDF / GPU 回读。 */
export function joinPdfPageBins(pages: Binary[]): Binary {
  const w = Math.max(...pages.map(p => p.w));
  const h = pages.reduce((sum, p) => sum + p.h, 0);
  const data = new Uint8Array(w * h);
  let y = 0;
  for (const p of pages) {
    for (let row = 0; row < p.h; row++) {
      data.set(p.data.subarray(row * p.w, (row + 1) * p.w), (y + row) * w);
    }
    y += p.h;
  }
  return { w, h, data };
}
