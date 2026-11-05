// 括号探针 v2（调试脚本）：对样张跑 parenSideOf 并打印**括号候选行的全部窄组件**的判定细节
// （含被门槛拒掉的组件与原因），用于诊断「为什么没配成对」。
// 运行：npx esbuild scripts/ocr-paren-probe.ts --bundle --platform=node --format=cjs
//       --external:sharp --outfile=.tmp-paren-probe.cjs --log-level=error
//       然后 NODE_PATH=C:\Users\AYOU\Desktop\ScoreOCR\node_modules node .tmp-paren-probe.cjs
import sharp from 'sharp';
import { connectedComponents } from '../src/ocr/dolce/omrkit/ccl';
import { rgbaToBinary } from '../src/ocr/dolce/omrkit/preprocess';
import { parenSideOf } from '../src/ocr/adapter/parenSlurs';
import type { Binary, Rect } from '../src/ocr/dolce/omrkit/types';

const FILE = 'C:/Users/AYOU/Desktop/ScoreOCR/tests/chorus_04_yueliang_hechang.png';
const ROW_BANDS = [
  { name: '前奏行 y≈340-390', y0: 340, y1: 390 },
];

/** 与 parenSideOf 相同的列结构统计，但返回细节而不是结论。 */
function detail(bin: Binary, b: Rect) {
  const runs: number[][][] = [];
  let ink = 0;
  for (let x = b.x; x < b.x + b.w; x++) {
    const rs: number[][] = [];
    let s = -1;
    for (let y = b.y; y < b.y + b.h; y++) {
      if (bin.data[y * bin.w + x]) {
        ink++;
        if (s < 0) s = y;
      } else if (s >= 0) {
        rs.push([s, y - 1]);
        s = -1;
      }
    }
    if (s >= 0) rs.push([s, b.y + b.h - 1]);
    runs.push(rs);
  }
  return { runs, ink };
}

async function main() {
  const { data, info } = await sharp(FILE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, info.width * info.height * 4);
  const bin = rgbaToBinary(rgba, info.width, info.height);
  const comps = connectedComponents(bin, 8);
  const solid = comps.filter((c) => {
    const { w, h } = c.bbox;
    return h >= 12 && h <= 70 && w <= h * 1.4 && c.area >= w * h * 0.35;
  });
  const hs = solid.map((c) => c.bbox.h).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)] ?? 0;
  console.log(`数字中位高≈${medH}（实心组件 ${solid.length} 个）`);
  for (const band of ROW_BANDS) {
    console.log(`\n=== ${band.name} ===`);
    const bandComps = comps
      .filter((c) => c.bbox.y >= band.y0 && c.bbox.y + c.bbox.h <= band.y1 && c.bbox.h >= 12)
      .sort((a, b) => a.bbox.x - b.bbox.x);
    for (const c of bandComps) {
      const { x, y, w, h } = c.bbox;
      const side = parenSideOf(bin, c.bbox, medH);
      const d = detail(bin, c.bbox);
      const twoRuns = d.runs.filter((r) => r.length === 2).length;
      const singles = d.runs.filter((r) => r.length === 1).length;
      const fill = (d.ink / (w * h)).toFixed(2);
      const gate =
        w > medH * 0.45 ? `宽超门(w/med=${(w / medH).toFixed(2)})`
        : h < medH * 0.8 || h > medH * 1.9 ? `高超门(h/med=${(h / medH).toFixed(2)})`
        : d.ink / (w * h) > 0.5 ? `墨超门(fill=${fill})`
        : twoRuns < 3 ? `双支列不足(${twoRuns})`
        : '—';
      console.log(
        `  x=${String(x).padStart(4)} y=${String(y).padStart(4)} w=${String(w).padStart(2)} h=${String(h).padStart(2)} ` +
          `fill=${fill} 单列=${singles} 双列=${twoRuns} → ${side ?? `拒（${gate}）`}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
