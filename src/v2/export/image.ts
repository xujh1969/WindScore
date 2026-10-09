import type { Score } from '../types';
import { paintLayout } from '../paint';
import { saveBytesAsFile, type SaveResult } from '../io';
import { exportLayout, exportTheme } from './render';
import { safeFileName } from './tasks';
import { SvgCanvas } from './svg';

export async function exportScoreImageToFile(opts: { score: Score; name: string; format: 'png' | 'svg'; width: number; dark: boolean; showTitle: boolean; showMeasureNumbers: boolean }): Promise<SaveResult> {
  await document.fonts.ready;
  const layout = exportLayout(opts.score, { contentWidth: opts.width, showTitle: opts.showTitle });
  const width = Math.ceil(layout.width), height = Math.ceil(layout.height);
  const theme = exportTheme(opts.dark);
  let bytes: Uint8Array;
  if (opts.format === 'svg') {
    const ctx = new SvgCanvas();
    paintLayout(ctx as unknown as CanvasRenderingContext2D, layout, theme, { showMeasureNumbers: opts.showMeasureNumbers });
    bytes = new TextEncoder().encode(ctx.toSvg(width, height, opts.name));
  } else {
    if (width > 16384 || height > 16384 || width * height > 64_000_000) throw new Error('谱面过长，PNG 超出画布限制；请改用 SVG 或分页 PDF');
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('拿不到 2D 画布');
    paintLayout(ctx, layout, theme, { showMeasureNumbers: opts.showMeasureNumbers });
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('图片生成失败')), 'image/png'));
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  return saveBytesAsFile(bytes, `${safeFileName(opts.name)}.${opts.format}`, { ext: opts.format, mime: opts.format === 'png' ? 'image/png' : 'image/svg+xml', label: `${opts.format.toUpperCase()} 图片` });
}
