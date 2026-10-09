/**
 * PNG / SVG 导出：**与 PDF 同一套分页排版**。
 *
 * 输入是导出对话框已经算好的 PDF 分页计划（planExport 的产物：layout + plans + geo），
 * 每一页都走 paintExportPage——所见即所得：PNG/SVG 里的每一页和 PDF 预览逐像素一致，
 * 连页脚、标题只在首页、深浅主题都相同。多页纵向拼接为一张（页间灰色分隔条）。
 */

import type { LayoutResult } from '../layout';
import type { PagePlan } from './pdf';
import { saveBytesAsFile, type SaveResult } from '../io';
import { exportTheme, footerText, paintExportPage, type PageGeometry } from './render';
import { safeFileName } from './tasks';
import { SvgCanvas } from './svg';

/** 相邻两页之间的灰色分隔条高度 */
const PAGE_GAP = 24;

export async function exportScoreImageToFile(opts: {
  name: string;
  format: 'png' | 'svg';
  dark: boolean;
  showMeasureNumbers: boolean;
  layout: LayoutResult;
  plans: PagePlan[];
  geo: PageGeometry;
}): Promise<SaveResult> {
  await document.fonts.ready;
  const { layout, plans, geo } = opts;
  const pages = plans.length;
  const width = Math.ceil(geo.pageW);
  const height = Math.ceil(pages * geo.pageH + (pages - 1) * PAGE_GAP);
  const theme = exportTheme(opts.dark);
  /** 第 i 页的纵向原点：pages 段页 + 页间分隔条 */
  const originY = (i: number): number => Math.round(i * (geo.pageH + PAGE_GAP));
  const footer = (i: number): string => footerText(opts.name, i + 1, pages);

  let bytes: Uint8Array;
  if (opts.format === 'svg') {
    const ctx = new SvgCanvas();
    // 分隔条先铺满整张画布，每页再用自己的底色盖上去
    ctx.fillStyle = '#7f7f7f';
    ctx.fillRect(0, 0, width, height);
    plans.forEach((plan, i) => {
      paintExportPage(ctx as unknown as CanvasRenderingContext2D, layout, theme, plan, geo, {
        footer: footer(i),
        showMeasureNumbers: opts.showMeasureNumbers,
        originY: originY(i),
      });
    });
    bytes = new TextEncoder().encode(ctx.toSvg(width, height, opts.name));
  } else {
    if (width > 16384 || height > 16384 || width * height > 64_000_000) {
      throw new Error('页数 × dpi 超出 PNG 画布上限；请降低 dpi、改用 SVG，或导出分页 PDF');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('拿不到 2D 画布');
    ctx.fillStyle = '#7f7f7f';
    ctx.fillRect(0, 0, width, height);
    plans.forEach((plan, i) => {
      paintExportPage(ctx, layout, theme, plan, geo, {
        footer: footer(i),
        showMeasureNumbers: opts.showMeasureNumbers,
        originY: originY(i),
      });
    });
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('图片生成失败'))), 'image/png'),
    );
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  return saveBytesAsFile(bytes, `${safeFileName(opts.name)}.${opts.format}`, {
    ext: opts.format,
    mime: opts.format === 'png' ? 'image/png' : 'image/svg+xml',
    label: `${opts.format.toUpperCase()} 图片（${pages} 页）`,
  });
}
