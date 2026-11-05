// 浏览器侧的图片/PDF 解码：createImageBitmap + OffscreenCanvas，PDF 经 pdf.js 光栅化。
// **只有这个文件碰这些 API**——识别管线其余部分经 decode.ts 的注入点拿解码能力
// （同 staffomr/browser.ts 的分工约定）。
import { setImageDecoder, type RgbaImage } from "./decode";
import { openPdf } from "./pdf.browser";

const PDF_W = 2000; // 所有 PDF 页按此宽度光栅化

/** 图片字节 → RGBA（原尺寸；超宽缩图交给 decode.ts 统一做）。 */
async function decodeImage(bytes: Uint8Array, mime?: string): Promise<RgbaImage> {
  const blob = new Blob([bytes as BlobPart], mime ? { type: mime } : undefined);
  const bmp = await createImageBitmap(blob);
  const { canvas, ctx } = newCanvas(bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: img.width, height: img.height };
}

function newCanvas(w: number, h: number, software = false): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  // OffscreenCanvas 的参数按 WebIDL 是 unsigned long：±Infinity 直接抛
  // 「Failed to construct 'OffscreenCanvas': Value is not of type 'unsigned long'」。
  // 异常 PDF 页（MediaBox 宽 0 之类）会把渲染宽算成 Infinity——这里兜底成 1×1 白页，
  // 页数与识别长图的页序必须一一对应，不能跳页（北国之春.pdf 实测）。
  const cw = Number.isFinite(w) ? Math.max(1, Math.round(w)) : 1;
  const ch = Number.isFinite(h) ? Math.max(1, Math.round(h)) : 1;
  const canvas = new OffscreenCanvas(cw, ch);
  // software：willReadFrequently 走软件后备画布。GPU 后备画布在大尺寸下 getImageData
  // 回读可能整块丢内容（WebView2 实测全白 → 预览空白、识别全空）；只在回读自检失败后的
  // 重画时启用，正常机器行为一字不变。
  const ctx = canvas.getContext("2d", software ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  return { canvas, ctx };
}

/** 整页光栅化：扫描图、文字和矢量都走同一路径，保留页面方向与所有内容。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pdfPageToCanvas(page: any, software = false): Promise<OffscreenCanvas> {
  const base = page.getViewport({ scale: 1 }).width;
  // 宽 0 的异常页别把 scale 放大到 Infinity（OffscreenCanvas 会直接抛错），退回原尺寸让 newCanvas 兜底
  const viewport = page.getViewport({ scale: base > 0 ? PDF_W / base : 1 });
  const w = Math.round(viewport.width);
  const h = Math.round(viewport.height);
  const { canvas, ctx } = newCanvas(w, h, software);
  ctx.fillStyle = "#fff"; // PDF 背景透明 → 铺白底，二值化才认得墨迹
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** 粗判「这张光栅图里有没有墨」：铺白底的乐谱页正常必有暗像素。 */
function imageHasInk(data: Uint8ClampedArray): boolean {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 16 && data[i] < 200) return true;
  }
  return false;
}

/** 单页 → ImageData：GPU 后备画布在大尺寸下 getImageData 回读可能整块丢内容
 *  （WebView2 实测全白 → 预览空白、识别全空，页面渲染本身没报错）。回读后自检，
 *  无墨（且不是 1×1 异常兜底页）就换软件后备画布重画一遍再读。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pdfPageToImageData(page: any): Promise<ImageData> {
  let canvas = await pdfPageToCanvas(page);
  let img = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  if (!imageHasInk(img.data) && canvas.width * canvas.height > 1) {
    canvas = await pdfPageToCanvas(page, true);
    img = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  }
  return img;
}

/** PDF 字节 → ImageData：逐页取图后竖向拼接为一张白底长图。 */
async function pdfToImageData(bytes: Uint8Array): Promise<ImageData> {
  const { pdf } = await openPdf(bytes);
  const imgs: ImageData[] = [];
  let totalH = 0;
  let maxW = 1;
  for (let i = 1; i <= pdf.numPages; i++) {
    const img = await pdfPageToImageData(await pdf.getPage(i));
    imgs.push(img);
    totalH += img.height;
    maxW = Math.max(maxW, img.width);
  }
  let { ctx } = newCanvas(maxW, totalH);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, maxW, Math.max(1, totalH));
  let y = 0;
  for (const img of imgs) {
    ctx.putImageData(img, 0, y);
    y += img.height;
  }
  let out = ctx.getImageData(0, 0, maxW, Math.max(1, totalH));
  if (!imageHasInk(out.data) && imgs.some((img) => imageHasInk(img.data))) {
    ({ ctx } = newCanvas(maxW, totalH, true));
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, maxW, Math.max(1, totalH));
    y = 0;
    for (const img of imgs) {
      ctx.putImageData(img, 0, y);
      y += img.height;
    }
    out = ctx.getImageData(0, 0, maxW, Math.max(1, totalH));
  }
  return out;
}

/** [WindScore OCR 页] PDF 逐页 → RGBA 图数组（不拼接）。
 *  供预览和识别共用，文档与 worker 在取完像素后释放。 */
export async function pdfPagesToImages(bytes: Uint8Array): Promise<RgbaImage[]> {
  const { pdf } = await openPdf(bytes);
  try {
    const out: RgbaImage[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const img = await pdfPageToImageData(await pdf.getPage(i));
      out.push({ data: img.data, width: img.width, height: img.height });
    }
    return out;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** 装配浏览器解码器。由 `browser.ts::installBrowserOmr` 调用。 */
export function installBrowserDecoder(): void {
  setImageDecoder(decodeImage, async (bytes) => {
    const img = await pdfToImageData(bytes);
    return { data: img.data, width: img.width, height: img.height };
  });
}
