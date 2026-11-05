// 括号像素级诊断：把指定连通块区域的二值图打成 ASCII，看细笔括号在二值化后的真实列结构。
// 运行：npx esbuild scripts/ocr-paren-dump.ts --bundle --platform=node --format=cjs
//       --external:sharp --outfile=.tmp-paren-dump.cjs --log-level=error
//       然后 NODE_PATH=C:\Users\AYOU\Desktop\ScoreOCR\node_modules node .tmp-paren-dump.cjs
import sharp from 'sharp';
import { connectedComponents } from '../src/ocr/dolce/omrkit/ccl';
import { rgbaToBinary } from '../src/ocr/dolce/omrkit/preprocess';

const FILE = 'C:/Users/AYOU/Desktop/ScoreOCR/tests/chorus_04_yueliang_hechang.png';
const REGIONS = [
  { name: '前奏开括号（约 x36,y350）', x: 24, y: 340, w: 30, h: 44 },
  { name: '前奏收括号（约 x1240,y350）', x: 1226, y: 340, w: 30, h: 44 },
];

async function main() {
  const { data, info } = await sharp(FILE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, info.width * info.height * 4);
  const bin = rgbaToBinary(rgba, info.width, info.height);
  const comps = connectedComponents(bin, 8);
  for (const r of REGIONS) {
    console.log(`\n=== ${r.name} ===`);
    for (let y = r.y; y < r.y + r.h; y++) {
      let line = '';
      for (let x = r.x; x < r.x + r.w; x++) line += bin.data[y * bin.w + x] ? '#' : '·';
      console.log(String(y).padStart(4) + ' ' + line);
    }
    // 该区域连通块的逐列 run 结构
    for (const c of comps) {
      if (c.bbox.x + c.bbox.w < r.x || c.bbox.x > r.x + r.w || c.bbox.y + c.bbox.h < r.y || c.bbox.y > r.y + r.h) continue;
      if (c.bbox.h < 10) continue;
      console.log(`  组件 bbox=${JSON.stringify(c.bbox)} area=${c.area}`);
      for (let x = c.bbox.x; x < c.bbox.x + c.bbox.w; x++) {
        const rs: string[] = [];
        let s = -1;
        for (let y = c.bbox.y; y < c.bbox.y + c.bbox.h; y++) {
          if (bin.data[y * bin.w + x]) {
            if (s < 0) s = y;
          } else if (s >= 0) {
            rs.push(`${s}-${y - 1}`);
            s = -1;
          }
        }
        if (s >= 0) rs.push(`${s}-${c.bbox.y + c.bbox.h - 1}`);
        console.log(`    col ${x}: ${rs.length ? rs.join(' , ') : '空'}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
