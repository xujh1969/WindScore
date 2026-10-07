/**
 * 导出流程的胶水层：排版 → 逐页/逐帧画到画布 → 产出文件字节。
 *
 * 分工：
 *   pdf.ts    纯计算（分页、PDF 字节组装）
 *   render.ts 绘制（画一页 / 画一帧）
 *   video.ts  比例与滚动的纯计算 + MediaRecorder 封装
 *   本文件    把上面三者串起来，并处理「画布 → JPEG / Blob」的异步转换
 */

import type { LayoutResult } from '../layout';
import type { Score } from '../types';
import { saveBytesAsFile, type SaveResult } from '../io';
import { A4_PT, buildPdf, type PdfImagePage, type PagePlan } from './pdf';
import {
  exportLayout,
  exportTheme,
  footerText,
  paintExportPage,
  planScorePages,
  type PageGeometry,
} from './render';

/** 画布 → JPEG 字节。PDF 每一页就是一张 JPEG，quality 直接决定清晰度与体积 */
function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('这一页画不出来（画布返回了空数据）'));
          return;
        }
        blob.arrayBuffer().then(
          (buf) => resolve(new Uint8Array(buf)),
          () => reject(new Error('读取画布数据失败')),
        );
      },
      'image/jpeg',
      quality,
    );
  });
}

/** 文件名里不能有的字符（Windows 最严） */
export function safeFileName(name: string): string {
  return (name || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

/** A4 页面几何（像素）。横竖屏只差一个宽高比 */
export function a4Geometry(
  landscape: boolean,
  dpi: number,
  scale: number,
): PageGeometry & { ptW: number; ptH: number } {
  const ptW = landscape ? A4_PT.h : A4_PT.w;
  const ptH = landscape ? A4_PT.w : A4_PT.h;
  const pageW = (ptW / 72) * dpi;
  const pageH = (ptH / 72) * dpi;
  return {
    pageW,
    pageH,
    ptW,
    ptH,
    scale,
    marginX: Math.round(pageW * 0.075),
    marginTop: Math.round(pageH * 0.055),
    // 底部留出页脚（歌名-页号/总页数）
    marginBottom: Math.round(pageH * 0.085),
  };
}

/** 导出的排版参数：宽度按「排版坐标」给，绘制时再乘 scale 放大 */
export function exportLayoutFor(
  score: Score,
  geo: PageGeometry,
  showTitle: boolean,
  unit?: number,
): LayoutResult {
  const contentWidth = (geo.pageW - geo.marginX * 2) / geo.scale;
  return exportLayout(score, { contentWidth, showTitle, ...(unit ? { unit } : {}) });
}

/** 排一次版并把行切页 */
export function planExport(
  score: Score,
  geo: PageGeometry,
  showTitle: boolean,
): { layout: LayoutResult; plans: PagePlan[] } {
  const layout = exportLayoutFor(score, geo, showTitle);
  return { layout, plans: planScorePages(layout, geo, showTitle) };
}

export interface PdfExportOptions {
  score: Score;
  /** 用在页脚与文档标题上的歌名 */
  name: string;
  landscape?: boolean;
  /** 渲染分辨率（dpi）。150 打印足够，300 更清晰也更大 */
  dpi?: number;
  /** 版面缩放：谱面 21px 字号在纸面上变成 21 × scale */
  scale?: number;
  showTitle?: boolean;
  showMeasureNumbers?: boolean;
  dark?: boolean;
  quality?: number;
  onProgress?: (ratio: number, note: string) => void;
}

export interface PdfExportResult {
  bytes: Uint8Array;
  pageCount: number;
}

/** 导出 PDF：A4 分页 + 每页页脚「歌名-页号/总页数」 */
export async function exportScorePdf(opts: PdfExportOptions): Promise<PdfExportResult> {
  const geo = a4Geometry(opts.landscape ?? false, opts.dpi ?? 150, opts.scale ?? 1.55);
  const showTitle = opts.showTitle ?? true;
  const { layout, plans } = planExport(opts.score, geo, showTitle);
  if (plans.length === 0) throw new Error('谱面是空的，没什么可导出的');

  const theme = exportTheme(opts.dark ?? false);
  const canvas = document.createElement('canvas');
  canvas.width = geo.pageW;
  canvas.height = geo.pageH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2D 画布');

  const pages: PdfImagePage[] = [];
  for (let i = 0; i < plans.length; i += 1) {
    opts.onProgress?.(i / plans.length, `正在画第 ${i + 1} / ${plans.length} 页`);
    // 画布复用、排版只做一次：每页重画一遍即可
    paintExportPage(ctx, layout, theme, plans[i]!, geo, {
      footer: footerText(opts.name, i + 1, plans.length),
      showMeasureNumbers: opts.showMeasureNumbers ?? true,
    });
    pages.push({
      jpeg: await canvasToJpeg(canvas, opts.quality ?? 0.92),
      width: geo.pageW,
      height: geo.pageH,
    });
    // 让出主线程，几十页时界面才不会卡住
    await new Promise((r) => setTimeout(r, 0));
  }
  opts.onProgress?.(1, '正在生成 PDF 文件');
  return {
    bytes: buildPdf(pages, geo.ptW, geo.ptH, { title: opts.name }),
    pageCount: plans.length,
  };
}

/** 导出 PDF 并落盘 */
export async function exportScorePdfToFile(
  opts: PdfExportOptions,
): Promise<SaveResult & { pageCount: number }> {
  const { bytes, pageCount } = await exportScorePdf(opts);
  const res = await saveBytesAsFile(bytes, `${safeFileName(opts.name)}.pdf`, {
    ext: 'pdf',
    mime: 'application/pdf',
    label: 'PDF 文件',
  });
  return { ...res, pageCount };
}
