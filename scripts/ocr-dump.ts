// 诊断脚本：跑一次真模型识别，dump 每个谱行的结构信息（行数/音数/小节线/系统/声部）。
// 用法：npx esbuild scripts/ocr-dump.ts --bundle --platform=node --format=esm --outfile=.tmp-ocr-dump.mjs && node .tmp-ocr-dump.mjs > artifacts/ocr-dump.txt
import { readFileSync } from 'node:fs';
import { setOmrRuntime } from '../src/ocr/dolce/omrkit/runtime';
import { nodeRuntime } from '../src/ocr/dolce/omrkit/runtime.node';
import { installNodeDecoder } from '../src/ocr/dolce/omrkit/decode.node';
import { decodeToBinary } from '../src/ocr/dolce/omrkit/decode';
import { paddleOcrBackend } from '../src/ocr/dolce/omrkit/paddleocr';
import { recognizeJianpu } from '../src/ocr/dolce/omr/jianpu';
import { recognizedToJps } from '../src/ocr/convert/recognizedToJps';

const FILE = process.argv[2] ?? 'tests/chorus_04_yueliang_hechang.png';

setOmrRuntime(nodeRuntime);
installNodeDecoder();

const bytes = readFileSync(FILE);
const bin = await decodeToBinary(new Uint8Array(bytes), 'image/png');
console.log(`image ok`);
const rec = await recognizeJianpu(bin, paddleOcrBackend(), {});
const rows = rec.rows;
console.log(`rows: ${rows.length}`);
rows.forEach((r, i) => {
  console.log(
    `row ${i}: y=${r.topY}..${r.bottomY} nums=${r.nums.length} bars=${r.barlineXs.length}` +
    ` sys=${r.system ?? '-'} voice=${r.voice ?? '-'}` +
    ` first=${r.nums[0] ? String(r.nums[0].num ?? r.nums[0].text ?? '?') : '-'}`,
  );
});
const conv = recognizedToJps(rec);
console.log('--- jps ---');
console.log(conv.text.split('\n').slice(0, 30).join('\n'));
