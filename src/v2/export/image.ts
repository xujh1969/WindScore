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
 *   - **CPU 软件画布是这条内容的 ground truth**：GPU 条探不到墨就换 CPU 重画；
 *     连 CPU 都探不到墨说明这条本来就是留白——合法，照常拼入，不报错；
 *   - 只有「条上有墨、纯内存拷贝进大画布后墨没了」才是真故障，重拼一次仍丢才报错。
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

export async function exportScoreImageToFile(opts: {
  name: string;
  format: 'png' | 'svg';
  dark: boolean;
  showMeasureNumbers: boolean;
  layout: ExportLayoutResult;
  geo: PageGeometry;
}): Promise<SaveResult> {
  await document.fonts.ready;
  const { layout, geo } = opts;
  const theme = exportTheme(opts.dark);
  const width = Math.ceil(layout.width * geo.scale + geo.marginX * 2);
  const height = Math.ceil(geo.marginTop + layout.height * geo.scale + geo.marginTop);

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
    canvas.width = width;
    canvas.height = height;
    // 拼接画布固定走内存后备：个别显卡驱动对大画布的 GPU 回读会丢瓦片（表现为
    // 导出中间整段空白）。它只做整条拷贝与最终编码，没有任何矢量/文字绘制。
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('拿不到 2D 画布');
    // 在软件画布上重画一条（不抛错）：CPU 画布是内容的 ground truth
    const paintCpuBand = (bandTop: number, bandH: number): HTMLCanvasElement => {
      const cpu = document.createElement('canvas');
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
      band.width = width;
      band.height = bandH;
      let bctx = band.getContext('2d');
      if (!bctx) throw new Error('拿不到 2D 画布');
      paintExportImageBand(bctx, layout, theme, geo, { bandTop, bandW: width, bandH, showMeasureNumbers: opts.showMeasureNumbers });
      // 期望 = 这条真的画上了墨（以 CPU 画布为准）；纯留白的条不做拼入自检
      let expect = hasRegion && regionHasInk(band, 0, localY, width, localH, theme.bg);
      let cpuBand: HTMLCanvasElement | null = null;
      if (!expect) {
        cpuBand = paintCpuBand(bandTop, bandH);
        expect = hasRegion && regionHasInk(cpuBand, 0, localY, width, localH, theme.bg);
        if (expect) {
          band = cpuBand;
        } else {
          console.warn(`[WindScore] PNG 第 ${index} 条为纯留白（合法），跳过自检`);
        }
      }
      ctx.drawImage(band, 0, bandTop);
      if (!expect) continue;
      // 等一拍再自检：个别 WebView 上整条拷贝是异步落地的，立刻读会读到空
      await new Promise((r) => setTimeout(r, 0));
      if (!regionHasInk(canvas, 0, inkY, width, inkBottom - inkY, theme.bg)) {
        // 有墨的条拼入后读不到墨：换 CPU 条重拼一次（内存到内存拷贝不经过 GPU）
        if (!cpuBand) cpuBand = paintCpuBand(bandTop, bandH);
        ctx.drawImage(cpuBand, 0, bandTop);
        await new Promise((r) => setTimeout(r, 0));
        if (!regionHasInk(canvas, 0, inkY, width, inkBottom - inkY, theme.bg)) {
          throw new Error(`第 ${index} 条拼入长图时丢失，请改用 SVG 或 PDF 导出 ${DIAG}`);
        }
      }
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('图片生成失败'))), 'image/png'),
    );
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  return saveBytesAsFile(bytes, `${safeFileName(opts.name)}.${opts.format}`, {
    ext: opts.format,
    mime: opts.format === 'png' ? 'image/png' : 'image/svg+xml',
    label: `${opts.format.toUpperCase()} 长图（连续不分页）`,
  });
}
