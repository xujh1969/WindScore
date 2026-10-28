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
  paintExportPage,
  planScorePages,
  prepareExportLayout,
  regionHasInk,
  type ExportLayoutResult,
  type ExportNotation,
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

declare const __WS_VERSION__: string;

/** 报错时附上内部版本号：区分用户跑的是新包还是 WebView2 缓存的旧脚本 */
const DIAG = (): string =>
  `（WindScore ${typeof __WS_VERSION__ === 'undefined' ? 'dev' : __WS_VERSION__}）`;

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
    marginX: pageW * 0.075,
    marginTop: pageH * 0.055,
    // 底部留出页脚（歌名-页号/总页数）
    marginBottom: pageH * 0.085,
  };
}

/** 导出的排版参数：宽度按「排版坐标」给，绘制时再乘 scale 放大 */
export function exportLayoutFor(
  score: Score,
  geo: PageGeometry,
  showTitle: boolean,
  unit?: number,
  notation: ExportNotation = {},
): ExportLayoutResult {
  const contentWidth = (geo.pageW - geo.marginX * 2) / geo.scale;
  return exportLayout(score, { contentWidth, showTitle, ...(unit ? { unit } : {}), ...notation });
}

/** 排一次版并把行切页 */
export function planExport(
  score: Score,
  geo: PageGeometry,
  showTitle: boolean,
  visibleLayout?: LayoutResult,
  notation: ExportNotation = {},
): { layout: ExportLayoutResult; plans: PagePlan[]; geo: PageGeometry } {
  const base: ExportLayoutResult = visibleLayout ? { ...visibleLayout, title: showTitle ? visibleLayout.title : null } : exportLayoutFor(score, geo, showTitle, undefined, notation);
  const layout = base.staff ? { ...base, staff: { ...base.staff, title: base.title } } : prepareExportLayout(score, base, notation);
  const fitted = visibleLayout ? { ...geo, scale: (geo.pageW - geo.marginX * 2) / layout.width } : geo;
  return { layout, plans: planScorePages(layout, fitted, showTitle), geo: fitted };
}

export interface PdfExportOptions extends ExportNotation {
  score: Score;
  /** 页面已经排好的谱面，保持每行内容与字形比例，仅适配纸张并分页。 */
  layout?: LayoutResult;
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
  // 字体没就绪就画页，标题/音符字符会用回退字形
  await document.fonts.ready;
  const paper = a4Geometry(opts.landscape ?? false, opts.dpi ?? 150, opts.scale ?? 1.55);
  const showTitle = opts.showTitle ?? true;
  const { layout, plans, geo } = planExport(opts.score, paper, showTitle, opts.layout, opts);
  if (plans.length === 0) throw new Error('谱面是空的，没什么可导出的');

  const theme = exportTheme(opts.dark ?? false);
  const canvas = document.createElement('canvas');
  canvas.width = geo.pageW;
  canvas.height = geo.pageH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('拿不到 2D 画布');

  const pages: PdfImagePage[] = [];
  // 编码副本固定走内存后备：个别显卡驱动对 GPU 画布的读回会丢瓦片（整页空白/断段）。
  // 每页先在 GPU 画布上绘制（与界面同一渲染路径，好机器零变化），整页拷贝到副本再编码；
  // 副本上做墨迹自检，空白就在副本上用 CPU 重画这一页，仍空白才报错。
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const copyCtx = copy.getContext('2d', { willReadFrequently: true });
  if (!copyCtx) throw new Error('拿不到 2D 画布');
  for (let i = 0; i < plans.length; i += 1) {
    opts.onProgress?.(i / plans.length, `正在画第 ${i + 1} / ${plans.length} 页`);
    const pageOpts = { showMeasureNumbers: opts.showMeasureNumbers ?? true };
    // 画布复用、排版只做一次：每页重画一遍即可
    paintExportPage(ctx, layout, theme, plans[i]!, geo, pageOpts);
    copyCtx.setTransform(1, 0, 0, 1, 0, 0);
    copyCtx.clearRect(0, 0, copy.width, copy.height);
    copyCtx.drawImage(canvas, 0, 0);
    // 等一拍再自检：个别 WebView 上 GPU→软件画布的整页拷贝是异步落地的，
    // 立刻读会读到空（PNG 长图同款教训；0.4.18 的同步自检在部分 Win11 上失效）
    await new Promise((r) => setTimeout(r, 0));
    if (!regionHasInk(copy, 0, 0, copy.width, copy.height, theme.bg)) {
      // CPU 重画前先清干净：防止半落地的内容与重画混叠
      copyCtx.clearRect(0, 0, copy.width, copy.height);
      paintExportPage(copyCtx, layout, theme, plans[i]!, geo, pageOpts);
      await new Promise((r) => setTimeout(r, 0));
      if (!regionHasInk(copy, 0, 0, copy.width, copy.height, theme.bg)) {
        throw new Error(`第 ${i + 1} 页画不上内容，请改导出 SVG 或 PNG 长图，或更新显卡驱动后重试 ${DIAG()}`);
      }
    }
    pages.push({
      jpeg: await canvasToJpeg(copy, opts.quality ?? 0.92),
      width: geo.pageW,
      height: geo.pageH,
    });
    // 让出主线程，几十页时界面才不会卡住
    await new Promise((r) => setTimeout(r, 0));
  }
  opts.onProgress?.(1, '正在生成 PDF 文件');
  return {
    bytes: buildPdf(pages, paper.ptW, paper.ptH, { title: opts.name }),
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
