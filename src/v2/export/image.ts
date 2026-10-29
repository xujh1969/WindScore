/**
 * PNG / SVG 导出：**连续长图**（不分页）。
 *
 * 与 PDF 共用同一套排版（layout/geo 与 planExport 的产物），但不再按页切开：
 * 整谱从上到下一次画完，标题在最上，没有页脚页号，也没有页间分隔。
 * 宽 = 版面宽 + 左右边距（与 PDF 版心同宽）。
 *
 * 绘制安全策略（0.4.15–0.4.17 的教训）：
 *   - 文字/矢量只画在**条尺寸的小画布**上（GPU 默认，与 PDF 每页同尺寸级别，
 *     小画布回读在各类显卡上都可靠）；
 *   - 拼接画布只做整条 blit 与最终编码，固定走内存后备（willReadFrequently），
 *     它上面没有任何矢量/文字绘制，不会触发软件光栅的文本歪斜问题；
 *   - GPU 条探不到墨就换 CPU 重画；拼接后按排版逐行检查，不能把绘制失败当留白；
 *   - PNG 编码后重新解码并逐行复查，避免编码阶段丢失中间内容。
 */

import { saveBytesAsFile, type SaveResult } from '../io';
import { exportTheme, paintExportImageBand, regionHasInk, type PageGeometry, type ExportLayoutResult } from './render';
import { safeFileName } from './tasks';
import { SvgCanvas } from './svg';

declare const __WS_VERSION__: string;

/** 报错时附上内部版本号：区分用户跑的是新包还是 WebView2 缓存的旧脚本 */
const DIAG = `（WindScore ${__WS_VERSION__}）`;

/** 长图分条绘制的条高（px）。条内画布尺寸与 PDF 页同级，回读可靠 */
const BAND = 2048;

async function within<T>(job: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([job, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时，请重试或降低 dpi ${DIAG}`)), 20_000); })]); }
  finally { clearTimeout(timer!); }
}

/** 只检查实际含音符/休止符的行；使用小画布，避免校验时再分配一张长图。 */
function verifyImageRows(source: CanvasImageSource, width: number, height: number, layout: ExportLayoutResult, geo: PageGeometry, bg: string): void {
  const probe = document.createElement('canvas');
  try {
    probe.width = width;
    for (const [i, row] of layout.lines.entries()) {
      if (!row.items.some(it => (it.kind === 'note' || it.kind === 'rest') && !it.hidden)) continue;
      const top = Math.max(0, Math.floor(geo.marginTop + (row.y - layout.lineHeight / 2 - 6) * geo.scale));
      const bottom = Math.min(height, Math.ceil(geo.marginTop + (row.y + layout.lineHeight / 2 + 6) * geo.scale));
      if (bottom <= top) throw new Error(`第 ${i + 1} 行超出图片范围 ${DIAG}`);
      probe.height = bottom - top;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      if (!ctx || ctx.isContextLost?.()) throw new Error(`图片校验画布不可用 ${DIAG}`);
      ctx.drawImage(source, 0, top, width, bottom - top, 0, 0, width, bottom - top);
      if (!regionHasInk(probe, geo.marginX, 0, width - 2 * geo.marginX, bottom - top, bg, true)) {
        throw new Error(`第 ${i + 1} 行谱面内容丢失，已阻止保存不完整的 PNG；请重试或改用 SVG/PDF ${DIAG}`);
      }
    }
  } finally { probe.width = 0; probe.height = 0; }
}

export async function exportScoreImageToFile(opts: {
  name: string;
  format: 'png' | 'svg';
  dark: boolean;
  showMeasureNumbers: boolean;
  layout: ExportLayoutResult;
  geo: PageGeometry;
}): Promise<SaveResult> {
  await within(document.fonts.ready, '字体准备');
  const { layout, geo } = opts;
  const theme = exportTheme(opts.dark);
  const width = Math.ceil(layout.width * geo.scale + geo.marginX * 2);
  const height = Math.ceil(geo.marginTop + layout.height * geo.scale + geo.marginTop);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !Number.isFinite(geo.scale) || geo.scale <= 0) {
    throw new Error(`图片排版尺寸无效 ${DIAG}`);
  }

  let bytes: Uint8Array;
  if (opts.format === 'svg') {
    const ctx = new SvgCanvas();
    paintExportImageBand(ctx as unknown as CanvasRenderingContext2D, layout, theme, geo, {
      bandTop: 0,
      bandW: width,
      bandH: height,
      showMeasureNumbers: opts.showMeasureNumbers,
    });
    bytes = new TextEncoder().encode(ctx.toSvg(width, height, opts.name));
  } else {
    if (width > 16384 || height > 16384 || width * height > 64_000_000) {
      throw new Error('图片尺寸超出 PNG 画布上限；请降低 dpi 或导出分页 PDF');
    }
    const canvas = document.createElement('canvas');
    const bands = new Set<HTMLCanvasElement>();
    try {
      canvas.width = width;
      canvas.height = height;
      // 拼接画布固定走内存后备：个别显卡驱动对大画布的 GPU 回读会丢瓦片（表现为
      // 导出中间整段空白）。它只做整条拷贝与最终编码，没有任何矢量/文字绘制。
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('拿不到 2D 画布');
      // GPU 条未检出内容时，在软件画布上重画；最终仍须通过逐行校验。
      const paintCpuBand = (bandTop: number, bandH: number): HTMLCanvasElement => {
        const cpu = document.createElement('canvas');
        bands.add(cpu);
        cpu.width = width;
        cpu.height = bandH;
        const cctx = cpu.getContext('2d', { willReadFrequently: true });
        if (!cctx) throw new Error('拿不到 2D 画布');
        paintExportImageBand(cctx, layout, theme, geo, { bandTop, bandW: width, bandH, showMeasureNumbers: opts.showMeasureNumbers });
        return cpu;
      };
      for (let bandTop = 0; bandTop < height; bandTop += BAND) {
        const bandH = Math.min(BAND, height - bandTop);
        const index = Math.floor(bandTop / BAND) + 1;
        // 自检区间与内容区取交集：上下留白垫底不算墨；条画布上用条内坐标
        // （条高只有 bandH，第 2 条的绝对 y=2048 已越界）
        const inkY = Math.max(bandTop, Math.floor(geo.marginTop));
        const inkBottom = Math.min(bandTop + bandH, Math.ceil(geo.marginTop + layout.height * geo.scale));
        const localY = Math.max(0, inkY - bandTop);
        const localBottom = Math.min(bandH, inkBottom - bandTop);
        const hasRegion = localBottom > localY;
        const localH = Math.max(0, localBottom - localY);
        let band = document.createElement('canvas');
        bands.add(band);
        band.width = width;
        band.height = bandH;
        let bctx = band.getContext('2d');
        if (!bctx) throw new Error('拿不到 2D 画布');
        paintExportImageBand(bctx, layout, theme, geo, { bandTop, bandW: width, bandH, showMeasureNumbers: opts.showMeasureNumbers });
        // 期望 = 这条真的画上了墨（以 CPU 画布为准）；纯留白的条不做拼入自检
        let expect = hasRegion && regionHasInk(band, 0, localY, width, localH, theme.bg, true);
        let cpuBand: HTMLCanvasElement | null = null;
        if (!expect) {
          cpuBand = paintCpuBand(bandTop, bandH);
          expect = hasRegion && regionHasInk(cpuBand, 0, localY, width, localH, theme.bg, true);
          if (expect) {
            band = cpuBand;
          } else {
            console.warn(`[WindScore] PNG 第 ${index} 条未检出内容，等待逐行校验`);
          }
        }
        ctx.drawImage(band, 0, bandTop);
        if (expect) {
          // 等一拍再自检：个别 WebView 上整条拷贝是异步落地的，立刻读会读到空
          await new Promise((r) => setTimeout(r, 0));
          if (!regionHasInk(canvas, 0, inkY, width, inkBottom - inkY, theme.bg, true)) {
            // 有墨的条拼入后读不到墨：换 CPU 条重拼一次（内存到内存拷贝不经过 GPU）
            if (!cpuBand) cpuBand = paintCpuBand(bandTop, bandH);
            ctx.drawImage(cpuBand, 0, bandTop);
            await new Promise((r) => setTimeout(r, 0));
            if (!regionHasInk(canvas, 0, inkY, width, inkBottom - inkY, theme.bg, true)) {
              throw new Error(`第 ${index} 条拼入长图时丢失，请改用 SVG 或 PDF 导出 ${DIAG}`);
            }
          }
        }
        for (const used of bands) { used.width = 0; used.height = 0; }
        bands.clear();
      }
      if (ctx.isContextLost?.()) throw new Error(`图片拼接画布上下文已丢失 ${DIAG}`);
      verifyImageRows(canvas, width, height, layout, geo, theme.bg);
      const blob = await within(new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('图片生成失败'))), 'image/png'),
      ), 'PNG 编码');
      if (blob.type !== 'image/png') throw new Error(`图片编码格式不是 PNG ${DIAG}`);
      bytes = new Uint8Array(await blob.arrayBuffer());
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) throw new Error(`PNG 文件头无效 ${DIAG}`);
      const image = new Image();
      const url = URL.createObjectURL(blob);
      try {
        image.src = url;
        await within(image.decode(), 'PNG 解码校验');
        if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error(`PNG 编码前后尺寸不一致 ${DIAG}`);
        verifyImageRows(image, width, height, layout, geo, theme.bg);
      } finally { image.src = ''; URL.revokeObjectURL(url); }
    } finally {
      for (const used of bands) { used.width = 0; used.height = 0; }
      canvas.width = 0; canvas.height = 0;
    }
  }
  return saveBytesAsFile(bytes, `${safeFileName(opts.name)}.${opts.format}`, {
    ext: opts.format,
    mime: opts.format === 'png' ? 'image/png' : 'image/svg+xml',
    label: `${opts.format.toUpperCase()} 长图（连续不分页）`,
  });
}
