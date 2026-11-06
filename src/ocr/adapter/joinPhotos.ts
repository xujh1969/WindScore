// 多张照片 → 一张竖拼长图：识别输入与对比页左栏共用**同一份像素**，
// 这样识别框坐标天然对齐，不需要任何折算。
// PDF 的逐页二值拼接走 adapter/pdfPages.ts，本文件只管图片。

/** 与 dolce/omrkit/decode.ts 的 fitWidth(MAX_W) 同口径：宽不超过 2200 时 OCR 不会再缩整图。 */
const MAX_W = 2200;
/** 浏览器画布的面积/单边保护：超过就整体等比收敛，避免 toBlob 丢瓦片。 */
const MAX_PIXELS = 60_000_000;
const MAX_SIDE = 16384;

export interface PhotoSource {
  name: string;
  url: string;
  w: number;
  h: number;
  bytes: Uint8Array;
  mime: string;
}

export interface JoinPlan {
  /** 长图宽度（最宽页缩放后的宽度，窄页右侧补白） */
  w: number;
  h: number;
  widths: number[];
  heights: number[];
  /** 相对原图的统一缩放系数 */
  scale: number;
}

/** 文件名自然排序：2.jpg 排在 10.jpg 前面，中文按拼音，序号小的在前。 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
export function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => collator.compare(a.name, b.name));
}

/**
 * 纯函数：算出长图尺寸与每页绘制尺寸。抽出来是为了能脱离画布单测。
 * 各页宽度不同时按最宽页补白（与 PDF 竖拼一致），不拉伸变形。
 */
export function planJoin(photos: ReadonlyArray<{ w: number; h: number }>): JoinPlan {
  const maxW = Math.max(1, ...photos.map((p) => p.w));
  let scale = Math.min(1, MAX_W / maxW);
  const rawH = photos.reduce((sum, p) => sum + p.h * scale, 0);
  // 高度或面积超上限时整册等比缩小（宽度同步缩小，保持每页原有清晰度比例）
  const k = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, maxW * scale * rawH)), MAX_SIDE / Math.max(1, rawH));
  scale *= k;
  const widths = photos.map((p) => Math.max(1, Math.round(p.w * scale)));
  const heights = photos.map((p) => Math.max(1, Math.round(p.h * scale)));
  return {
    w: Math.max(1, Math.round(maxW * scale)),
    h: heights.reduce((a, b) => a + b, 0),
    widths,
    heights,
    scale,
  };
}

export interface JoinedPhoto {
  bytes: Uint8Array;
  url: string;
  w: number;
  h: number;
}

/** 解码成可 drawImage 的对象；没有 createImageBitmap 的浏览器退回 <img>。 */
async function drawableOf(p: PhotoSource): Promise<{ img: CanvasImageSource; close(): void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      // new Uint8Array(...) 把 ArrayBufferLike 收窄成普通 ArrayBuffer，满足 BlobPart 约束
      const bmp = await createImageBitmap(new Blob([new Uint8Array(p.bytes)], { type: p.mime }));
      return { img: bmp, close: () => bmp.close() };
    } catch {
      /* 落回 <img> */
    }
  }
  const im = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片解码失败：${p.name}`));
    img.src = p.url;
  });
  return { img: im, close: () => {} };
}

/** File → 预览 URL + 原始字节 + 尺寸（与拼接时同一解码口径，避免 EXIF 方向造成拉伸）。 */
export async function loadPhotoSource(file: File): Promise<PhotoSource> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || 'image/png';
  const url = URL.createObjectURL(file);
  let w = 0;
  let h = 0;
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      w = bmp.width;
      h = bmp.height;
      bmp.close();
    } catch {
      /* 落回 <img> */
    }
  }
  if (!w || !h) {
    const im = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`无法读取图片尺寸：${file.name}`));
      img.src = url;
    });
    w = im.naturalWidth;
    h = im.naturalHeight;
  }
  if (!w || !h) throw new Error(`无法读取图片尺寸：${file.name}`);
  return { name: file.name, url, w, h, bytes, mime };
}

/**
 * 按传入顺序（调用方已按文件名排序）竖拼成一张 PNG 长图。
 * 用 willReadFrequently 的软件画布做 blit：本项目导出长图踩过「大画布 GPU
 * 回读丢瓦片」的坑，纯图片 blit 走内存后备最稳（不画文字，不会有字形歪斜）。
 * 拼出的空白会由 recognizeWithProgress 的墨量检查拦下并明确报错。
 */
export async function joinPhotos(photos: ReadonlyArray<PhotoSource>): Promise<JoinedPhoto> {
  if (!photos.length) throw new Error('没有可拼接的图片');
  const plan = planJoin(photos);
  const canvas = document.createElement('canvas');
  canvas.width = plan.w;
  canvas.height = plan.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持画布，无法拼接长图');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.w, plan.h);
  let y = 0;
  for (let i = 0; i < photos.length; i += 1) {
    const p = photos[i]!;
    const { img, close } = await drawableOf(p);
    try {
      ctx.drawImage(img, 0, y, plan.widths[i]!, plan.heights[i]!);
    } finally {
      close();
    }
    y += plan.heights[i]!;
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('长图编码失败，请少传几张或换用较小的图片'))), 'image/png');
  });
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    url: URL.createObjectURL(blob),
    w: plan.w,
    h: plan.h,
  };
}
