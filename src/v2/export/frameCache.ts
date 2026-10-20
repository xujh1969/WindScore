import { drawPlayBall, type PaintTheme } from '../paint';
import { paintVideoFrame, type ExportLayoutResult } from './render';

type FrameOptions = Parameters<typeof paintVideoFrame>[3];

/** Cache a stationary viewport; repaint the active rows with the original painter so ink/highlight order stays intact. */
export function createVideoFramePainter(ctx: CanvasRenderingContext2D, layout: ExportLayoutResult, theme: PaintTheme) {
  // Staff curves and glyph antialiasing can cross repair edges; keep exact vector rendering with viewport culling.
  if (layout.staff) return (opts: FrameOptions): void => paintVideoFrame(ctx, layout, theme, opts);
  const canvas = document.createElement('canvas');
  const cached = canvas.getContext('2d');
  if (!cached) throw new Error('拿不到视频缓存画布');
  const rows = new Map<string, number[]>();
  layout.lines.forEach((line, index) => {
    for (const item of line.items) {
      const indices = rows.get(item.eventId) ?? [];
      if (!indices.includes(index)) indices.push(index);
      rows.set(item.eventId, indices);
    }
  });
  let key = '';
  let lastViewport = '';
  return (opts: FrameOptions): void => {
    ctx.save();
    try {
      const nextKey = JSON.stringify([opts.canvasW, opts.canvasH, opts.scale, opts.offsetX, opts.scrollX, opts.scrollY, opts.bg, opts.showMeasureNumbers]);
      // During continuous scrolling use one vector render, rather than building a cache every frame.
      if (nextKey !== lastViewport) {
        lastViewport = nextKey;
        key = '';
        paintVideoFrame(ctx, layout, theme, opts);
        return;
      }
      if (nextKey !== key) {
        canvas.width = opts.canvasW;
        canvas.height = opts.canvasH;
        paintVideoFrame(cached, layout, theme, { ...opts, playhead: null, playheads: [], ball: null, progress: undefined });
        key = nextKey;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(canvas, 0, 0);
      const heads = opts.playheads ?? (opts.playhead ? [opts.playhead] : []);
      const indices = new Set(heads.flatMap(head => rows.get(head.eventId) ?? []));
      if (indices.size) {
        // Repaint the full active system; neighbouring ink is included in the clipped redraw.
        for (const sys of layout.systems ?? []) {
          if ([...indices].some(index => index >= sys.from && index < sys.to)) {
            for (let index = sys.from; index < sys.to; index++) indices.add(index);
          }
        }
        const pad = layout.lineHeight;
        let from = Infinity;
        let to = -Infinity;
        for (const index of indices) {
          const line = layout.lines[index];
          if (opts.scrollX !== undefined) {
            for (const item of line.items) { from = Math.min(from, item.x - pad); to = Math.max(to, item.x + item.w + pad); }
          } else {
            const y = layout.staff?.lines[index]?.y ?? line.y;
            from = Math.min(from, y - pad);
            to = Math.max(to, y + pad);
            for (const symbol of layout.staff?.lines[index]?.symbols ?? []) if ('y' in symbol) {
              from = Math.min(from, symbol.y - pad);
              to = Math.max(to, symbol.y + pad);
            }
          }
        }
        const horizontal = opts.scrollX !== undefined;
        const offset = horizontal ? opts.scrollX! : opts.scrollY ?? 0;
        // Integer clip edges avoid compositing the same antialiased ink twice at a fractional boundary.
        const start = Math.floor(from * opts.scale - offset);
        const end = Math.ceil(to * opts.scale - offset);
        ctx.save();
        ctx.beginPath();
        if (horizontal) ctx.rect(start, 0, end - start, opts.canvasH);
        else ctx.rect(0, start, opts.canvasW, end - start);
        ctx.clip();
        paintVideoFrame(ctx, layout, theme, { ...opts, ball: null, progress: undefined,
          redraw: horizontal ? { left: from, right: to, top: -Infinity, bottom: Infinity }
            : { left: -Infinity, right: Infinity, top: from, bottom: to },
        });
        ctx.restore();
      }
      const horizontal = opts.scrollX !== undefined;
      ctx.setTransform(opts.scale, 0, 0, opts.scale,
        horizontal ? -opts.scrollX! : opts.offsetX ?? Math.max(0, (opts.canvasW - layout.width * opts.scale) / 2),
        horizontal ? 0 : -(opts.scrollY ?? 0));
      if (opts.ball) drawPlayBall(ctx, opts.ball, theme);
      if (opts.progress !== undefined) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = theme.accent;
        ctx.fillRect(0, opts.canvasH - 4, opts.canvasW * Math.max(0, Math.min(1, opts.progress)), 4);
      }
    } finally {
      ctx.restore();
    }
  };
}
