/** Offline pixel regression. Set WINDSCORE_CANVAS_MODULE to a local @napi-rs/canvas/index.js. */
import { pathToFileURL } from 'node:url';
import { parseDsl } from '../src/v2/dsl';
import { layoutScore } from '../src/v2/layout';
import { paintLayout, LIGHT_THEME, DARK_THEME } from '../src/v2/paint';
import { paintStaffLayout } from '../src/v2/staffPaint';
import { paintVideoFrame, prepareExportLayout, type ExportLayoutResult } from '../src/v2/export/render';
import { createVideoFramePainter } from '../src/v2/export/frameCache';
import { buildStrip } from '../src/v2/export/strip';

const native = await import(process.env.WINDSCORE_CANVAS_MODULE ? pathToFileURL(process.env.WINDSCORE_CANVAS_MODULE).href : '@napi-rs/canvas');
globalThis.document = { createElement: () => native.createCanvas(1, 1) } as unknown as Document;
globalThis.Path2D = native.Path2D;
type Options = Parameters<typeof paintVideoFrame>[3];

// Full-score rendering before optimization is the pixel reference.
function original(ctx: CanvasRenderingContext2D, layout: ExportLayoutResult, theme: typeof LIGHT_THEME, opts: Options) {
  ctx.save();
  const horizontal = opts.scrollX !== undefined;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = opts.bg ?? theme.bg;
  ctx.fillRect(0, 0, opts.canvasW, opts.canvasH);
  ctx.setTransform(opts.scale, 0, 0, opts.scale,
    horizontal ? -opts.scrollX! : opts.offsetX ?? Math.max(0, (opts.canvasW - layout.width * opts.scale) / 2),
    horizontal ? 0 : -(opts.scrollY ?? 0));
  const paintOpts = { height: (opts.canvasH + (horizontal ? 0 : opts.scrollY ?? 0)) / opts.scale,
    playhead: opts.playhead ?? null, playheads: opts.playheads, playStyle: opts.playStyle ?? 'head',
    ball: opts.ball, showMeasureNumbers: opts.showMeasureNumbers ?? true, showTitleEdit: false };
  if (layout.staff) paintStaffLayout(ctx, layout.staff, opts.bg ? { ...theme, bg: opts.bg } : theme, paintOpts);
  else paintLayout(ctx, layout, theme, paintOpts);
  if (opts.progress !== undefined) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(0, opts.canvasH - 4, opts.canvasW * opts.progress, 4);
  }
  ctx.restore();
}

const { score } = parseDsl('@title Pixel regression\n@key 1=G\n@beat 4/4\n@bpm 96\n\n' + '1/2 2/2 3 4 5 | 6 7 1^ 2^ | '.repeat(40));
const base = layoutScore(score, { contentWidth: 600 });
const staff = prepareExportLayout(score, base, { notation: 'staff' });
const ensembleScore = parseDsl('@format 3\n@title Ensemble\n@key 1=C\n@beat 4/4\n\n@part 1 "Lead"\n' + '1 2 3 4 | '.repeat(12) + '\n@part 2 "Bass"\n' + '5v 6v 7v 1 | '.repeat(12)).score;
const ensemble = layoutScore(ensembleScore, { contentWidth: 600 });
const ensembleStaff = prepareExportLayout(ensembleScore, ensemble, { notation: 'staff' });
const cases = [[base, false, 'jianpu'], [staff, false, 'staff'],
  [buildStrip(base).layout, true, 'strip'], [buildStrip(staff).layout, true, 'staff strip'],
  [ensemble, false, 'ensemble'], [ensembleStaff, false, 'ensemble staff'],
  [buildStrip(ensemble).layout, true, 'ensemble strip'], [buildStrip(ensembleStaff).layout, true, 'ensemble staff strip']] as const;
let checks = 0;
for (const [layout, horizontal, label] of cases) for (const theme of [LIGHT_THEME, DARK_THEME]) {
  const ref = native.createCanvas(780, 520);
  const out = native.createCanvas(780, 520);
  const refCtx = ref.getContext('2d');
  const outCtx = out.getContext('2d');
  const cached = createVideoFramePainter(outCtx, layout, theme);
  for (const style of ['head', 'band', 'ball'] as const) {
    for (const row of [0, 2, layout.lines.length - 1]) {
      const line = layout.lines[row];
      const item = line.items.find(it => it.kind === 'note')!;
      for (const fraction of [0.1, 0.4, 0.8]) {
        const system = layout.systems?.find(sys => row >= sys.from && row < sys.to);
        const activeLines = system ? layout.lines.slice(system.from, system.to) : [line];
        const opts: Options = { canvasW: 780, canvasH: 520, scale: 1.3, playStyle: style,
          playheads: activeLines.flatMap(activeLine => {
            const note = activeLine.items.find(it => it.kind === 'note');
            return note ? [{ eventId: note.eventId, frac: fraction }] : [];
          }),
          ...(horizontal ? { scrollX: Math.max(0, item.x * 1.3 - 100.25) } : { scrollY: Math.max(0, line.y * 1.3 - 180.25) }),
          ...(style === 'ball' ? { ball: { x: item.x, y: line.y - 35, r: 5, hot: fraction, trail: [] } } : {}),
          progress: fraction };
        original(refCtx, layout, theme, opts);
        cached(opts);
        const expected = refCtx.getImageData(0, 0, 780, 520).data;
        const actual = outCtx.getImageData(0, 0, 780, 520).data;
        let different = 0;
        let maxDelta = 0;
        const changed: number[] = [];
        for (let index = 0; index < expected.length; index += 4) {
          const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(expected[index + channel] - actual[index + channel])));
          if (delta > 3) { different++; changed.push(index / 4); }
          maxDelta = Math.max(maxDelta, delta);
        }
        // Raster compositing may introduce tiny rounding differences; geometry must remain identical.
        if (different > 10) {
          const fs = await import('node:fs');
          fs.mkdirSync('artifacts', { recursive: true });
          fs.writeFileSync('artifacts/video-expected.png', ref.toBuffer('image/png'));
          fs.writeFileSync('artifacts/video-actual.png', out.toBuffer('image/png'));
          console.log('difference bounds', { left: Math.min(...changed.map(p => p % 780)), right: Math.max(...changed.map(p => p % 780)), top: Math.min(...changed.map(p => Math.floor(p / 780))), bottom: Math.max(...changed.map(p => Math.floor(p / 780))) });
          throw new Error(`${label} ${theme.dark ? 'dark' : 'light'} ${style} row ${row} frac ${fraction}: ${different} changed pixels, max delta ${maxDelta}`);
        }
        checks++;
      }
    }
  }
}
console.log(`${checks} offline pixel comparisons passed (jianpu/staff, page/strip, head/band/ball, both themes).`);

// Rendering only: does not measure WebView/WebCodecs or disk throughput.
const perfLayout = layoutScore(parseDsl('@beat 4/4\n\n' + '1 2 3 4 | '.repeat(300)).score, { contentWidth: 600 });
function renderTime(cached: boolean): number {
  const canvas = native.createCanvas(780, 520);
  const ctx = canvas.getContext('2d');
  const paint = cached ? createVideoFramePainter(ctx, perfLayout, LIGHT_THEME)
    : (opts: Options) => original(ctx, perfLayout, LIGHT_THEME, opts);
  const started = performance.now();
  for (let frame = 0; frame < 60; frame++) paint({ canvasW: 780, canvasH: 520, scale: 1.3,
    playheads: [{ eventId: perfLayout.lines[0].items[0].eventId, frac: frame / 60 }], playStyle: 'head' });
  return performance.now() - started;
}
const beforeMs = renderTime(false);
const afterMs = renderTime(true);
console.log(`Offline 300-line / 60-frame rendering: ${beforeMs.toFixed(0)}ms -> ${afterMs.toFixed(0)}ms (${(beforeMs / afterMs).toFixed(1)}x).`);
