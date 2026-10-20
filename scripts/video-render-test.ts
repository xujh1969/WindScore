import { parseDsl } from '../src/v2/dsl';
import { layoutScore } from '../src/v2/layout';
import { LIGHT_THEME } from '../src/v2/paint';
import { paintVideoFrame } from '../src/v2/export/render';

let texts = 0;
const ctx = new Proxy({}, {
  get: (_, name) => name === 'measureText'
    ? (text: string) => ({ width: text.length * 12, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 })
    : name === 'fillText' ? () => { texts++; } : () => {},
  set: () => true,
}) as CanvasRenderingContext2D;
const { score } = parseDsl('@title Perf\n@key 1=C\n@beat 4/4\n@bpm 96\n\n' + '1 2 3 4 | '.repeat(300));
const layout = layoutScore(score, { contentWidth: 600 });
paintVideoFrame(ctx, layout, LIGHT_THEME, { canvasW: 600, canvasH: 400, scale: 1 });
if (texts > 300) throw new Error(`Offscreen score still drawn: ${texts} text calls for ${layout.lines.length} lines`);
console.log(`Visible frame: ${texts} text calls for a ${layout.lines.length}-line score`);
