#!/usr/bin/env node
/**
 * 简谱图片预处理：灰度 →（可选）二值化 → 放大 →（可选）按行切条。
 *
 * 为什么需要：八度点 / 附点 / 减时线只有 1–2px，整张长图喂给视觉模型
 * 会被缩到看不清——先放大再喂，识别准确率差距巨大。
 *
 * 依赖 jimp（纯 JS 图像库，无原生模块）：在 skill 目录一次性安装
 *   npm i jimp
 *
 * 用法：
 *   node tools/preprocess.mjs 原图.png 输出前缀 [--scale 2.5] [--rows 0] [--threshold 0] [--invert]
 *
 *   --scale N     放大倍数（默认 2.5；原图已经很大时降到 1.5）
 *   --rows N      按行切成 N 条（默认 0 = 不切；切条时相邻条重叠 8% 高度，防止切断音符）
 *   --threshold N 二值化阈值 0–255（默认 0 = 只转灰度；彩色 / 灰底谱面建议从 170 试起）
 *   --invert      反相（深底浅字的谱面用）
 *
 * 输出：输出前缀-full.png（整图处理结果）；--rows N 时另有 -r1.png … -rN.png
 * 模型逐个读这些文件，而不是读原图。
 */
const argv = process.argv.slice(2);
const input = argv[0];
const prefix = argv[1];
if (!input || !prefix) {
  console.error('用法：node tools/preprocess.mjs 原图.png 输出前缀 [--scale 2.5] [--rows 0] [--threshold 0] [--invert]');
  process.exit(2);
}
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const scale = arg('scale', 2.5);
const rows = Math.max(0, arg('rows', 0));
const threshold = arg('threshold', 0);
const invert = argv.includes('--invert');

let Jimp;
try {
  Jimp = (await import('jimp')).default;
} catch {
  console.error('缺少依赖：先在 skill 目录运行  npm i jimp  （一次性，纯 JS 无原生模块）');
  process.exit(1);
}

const img = await Jimp.read(input);
img.grayscale();
if (invert) img.invert();
if (threshold > 0) {
  // 手动二值化（不依赖 jimp 版本的 threshold API 差异）
  img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
    const v = this.bitmap.data[idx] > threshold ? 255 : 0;
    this.bitmap.data[idx] = v;
    this.bitmap.data[idx + 1] = v;
    this.bitmap.data[idx + 2] = v;
  });
}
const w = img.bitmap.width;
const scaled = img.resize(Math.round(w * scale), Jimp.AUTO);
await scaled.writeAsync(`${prefix}-full.png`);
console.log(`${prefix}-full.png  （${scaled.bitmap.width}×${scaled.bitmap.height}）`);

if (rows > 1) {
  const h = scaled.bitmap.height;
  const sliceH = Math.ceil(h / rows);
  const overlap = Math.round(sliceH * 0.08);
  for (let r = 0; r < rows; r += 1) {
    const y0 = Math.max(0, r * sliceH - (r > 0 ? overlap : 0));
    const h0 = Math.min(h - y0, sliceH + (r > 0 ? overlap : 0) + (r < rows - 1 ? overlap : 0));
    const piece = scaled.clone().crop(0, y0, scaled.bitmap.width, h0);
    await piece.writeAsync(`${prefix}-r${r + 1}.png`);
    console.log(`${prefix}-r${r + 1}.png  （第 ${r + 1}/${rows} 条）`);
  }
  console.log(`提示：相邻条有 ${overlap}px 重叠，跨条的小节以两条中都能看清的那份为准。`);
}
