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
import { isTauri, saveBytesAsFile, type SaveResult } from '../io';
import { logPdfExport } from './pdfDiagnostic';
import { A4_PT, buildPdf, type PdfImagePage, type PagePlan } from './pdf';
import {
  exportLayout,
  exportTheme,
  paintExportPage,
  planScorePages,
  prepareExportLayout,
  regionHasInk,
  footerText,
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
        if (blob.type !== 'image/jpeg') { reject(new Error(`页面编码格式异常：${blob.type || '未知'}，PDF 需要 JPEG`)); return; }
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
  const pageW = Math.round((ptW / 72) * dpi);
  const pageH = Math.round((ptH / 72) * dpi);
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
  diagnosticPath?: string;
}

async function within<T>(job: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([job, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时，请重试或提供诊断日志`)), 20_000); })]); }
  finally { clearTimeout(timer!); }
}

/** 逐行检查谱面内容，不让标题/页脚掩盖正文丢失；完全隐藏的休止行不要求有墨。 */
function verifyPdfRows(canvas: HTMLCanvasElement, layout: ExportLayoutResult, plan: PagePlan, geo: PageGeometry, bg: string): number {
  let checked = 0;
  for (let i = plan.from; i < plan.to; i++) {
    const row = layout.lines[i];
    if (!row.items.some(it => (it.kind === 'note' || it.kind === 'rest') && !it.hidden)) continue;
    const top = Math.max(0, geo.marginTop + (row.y - plan.offset - layout.lineHeight / 2 - 6) * geo.scale);
    const bottom = Math.min(canvas.height - geo.marginBottom, geo.marginTop + (row.y - plan.offset + layout.lineHeight / 2 + 6) * geo.scale);
    if (bottom <= top || !regionHasInk(canvas, geo.marginX, top, canvas.width - 2 * geo.marginX, bottom - top, bg, true)) {
      throw new Error(`第 ${i + 1} 行谱面未通过内容校验，已阻止生成空白 PDF`);
    }
    checked++;
  }
  return checked;
}

/** 编码后重新解码检查，覆盖“像素正常、编码文件空白/格式错误”的另一条失败路径。 */
async function verifyJpeg(bytes: Uint8Array, canvas: HTMLCanvasElement, layout: ExportLayoutResult, plan: PagePlan, geo: PageGeometry, bg: string): Promise<void> {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) throw new Error('PDF 页面编码不是完整的 JPEG');
  const image = new Image();
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
  const decoded = document.createElement('canvas');
  try {
    image.src = url;
    await within(image.decode(), '页面图片解码');
    if (image.naturalWidth !== canvas.width || image.naturalHeight !== canvas.height) throw new Error('PDF 图片实际尺寸与页面声明不一致');
    decoded.width = canvas.width; decoded.height = canvas.height;
    const ctx = decoded.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!ctx || ctx.isContextLost?.()) throw new Error('页面图片校验画布不可用');
    ctx.drawImage(image, 0, 0);
    verifyPdfRows(decoded, layout, plan, geo, bg);
  } finally { image.src = ''; URL.revokeObjectURL(url); decoded.width = 0; decoded.height = 0; }
}

/** 导出 PDF：A4 分页 + 每页页脚「歌名-页号/总页数」 */
export async function exportScorePdf(opts: PdfExportOptions): Promise<PdfExportResult> {
  const diagnosticPath = await logPdfExport({ phase: 'start', version: DIAG(), userAgent: navigator.userAgent, visibility: document.visibilityState,
    dpi: opts.dpi ?? 150, landscape: opts.landscape ?? false, notation: opts.notation ?? 'jianpu', events: opts.score.events.length }, true);
  try {
  // 字体没就绪就画页，标题/音符字符会用回退字形
  await within(document.fonts.ready, '字体准备');
  const paper = a4Geometry(opts.landscape ?? false, opts.dpi ?? 150, opts.scale ?? 1.55);
  const showTitle = opts.showTitle ?? true;
  const { layout, plans, geo } = planExport(opts.score, paper, showTitle, opts.layout, opts);
  if (plans.length === 0) throw new Error('谱面是空的，没什么可导出的');

  const theme = exportTheme(opts.dark ?? false);
  const pages: PdfImagePage[] = [];
  await logPdfExport({ phase: 'planned', pages: plans.length, width: geo.pageW, height: geo.pageH, scale: geo.scale, rows: layout.lines.length, fonts: document.fonts.status });
  for (let i = 0; i < plans.length; i += 1) {
    opts.onProgress?.(i / plans.length, `正在画第 ${i + 1} / ${plans.length} 页`);
    await logPdfExport({ phase: 'page-render', page: i + 1, from: plans[i].from, to: plans[i].to });
    // 从第一笔起在软件后备画布绘制，避免 GPU→CPU 拷贝和跨页复用的上下文残留。
    const canvas = document.createElement('canvas');
    try {
      canvas.width = geo.pageW; canvas.height = geo.pageH;
      const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
      if (!ctx || ctx.isContextLost?.()) throw new Error('PDF 绘制画布不可用');
      paintExportPage(ctx, layout, theme, plans[i], geo, { showMeasureNumbers: opts.showMeasureNumbers ?? true, footer: footerText(opts.name, i + 1, plans.length) });
      if (ctx.isContextLost?.()) throw new Error('PDF 绘制上下文在绘制期间丢失');
      const rows = verifyPdfRows(canvas, layout, plans[i], geo, theme.bg);
      await logPdfExport({ phase: 'page-pixels-verified', page: i + 1, rows });
      const jpeg = await within(canvasToJpeg(canvas, opts.quality ?? .92), '页面图片编码');
      await logPdfExport({ phase: 'page-encoded', page: i + 1, bytes: jpeg.length });
      await verifyJpeg(jpeg, canvas, layout, plans[i], geo, theme.bg);
      await logPdfExport({ phase: 'page-jpeg-verified', page: i + 1, width: canvas.width, height: canvas.height });
      pages.push({ jpeg, width: canvas.width, height: canvas.height });
    } finally { canvas.width = 0; canvas.height = 0; }
    // 让出主线程，几十页时界面才不会卡住
    await new Promise((r) => setTimeout(r, 0));
  }
  opts.onProgress?.(1, '正在生成 PDF 文件');
  const bytes = buildPdf(pages, paper.ptW, paper.ptH, { title: opts.name });
  await logPdfExport({ phase: 'pdf-built', bytes: bytes.length, pages: plans.length });
  return { bytes, pageCount: plans.length, diagnosticPath };
  } catch (error) {
    await logPdfExport({ phase: 'error', message: String(error) });
    throw new Error(`${error instanceof Error ? error.message : error} ${DIAG()}${diagnosticPath ? `；诊断日志：${diagnosticPath}` : ''}`);
  }
}

/** 导出 PDF 并落盘 */
export async function exportScorePdfToFile(
  opts: PdfExportOptions,
): Promise<SaveResult & { pageCount: number }> {
  const { bytes, pageCount, diagnosticPath } = await exportScorePdf(opts);
  try {
  await logPdfExport({ phase: 'save-start', bytes: bytes.length });
  const res = await saveBytesAsFile(bytes, `${safeFileName(opts.name)}.pdf`, {
    ext: 'pdf',
    mime: 'application/pdf',
    label: 'PDF 文件',
  });
  if (res.ok && res.path && isTauri()) {
    const { invoke } = await import('@tauri-apps/api/tauri');
    await invoke('verify_pdf_export', { path: res.path, expectedSize: bytes.length });
  }
  await logPdfExport({ phase: res.ok ? 'save-complete' : 'save-cancelled', bytes: bytes.length, pageCount, diskVerified: res.ok && !!res.path && isTauri() });
  return { ...res, pageCount };
  } catch (error) {
    await logPdfExport({ phase: 'save-error', message: String(error) });
    throw new Error(`${error instanceof Error ? error.message : error}${diagnosticPath ? `；诊断日志：${diagnosticPath}` : ''}`);
  }
}
