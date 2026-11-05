// 临时诊断：Node 侧跑识别 + 连谱号检测内部转储
import { readFileSync } from 'node:fs';
import { setOmrRuntime } from '../src/ocr/dolce/omrkit/runtime';
import { nodeRuntime } from '../src/ocr/dolce/omrkit/runtime.node';
import { installNodeDecoder } from '../src/ocr/dolce/omrkit/decode.node';
import { decodeToBinary } from '../src/ocr/dolce/omrkit/decode';
import { paddleOcrBackend } from '../src/ocr/dolce/omrkit/paddleocr';
import { recognizeJianpu } from '../src/ocr/dolce/omr/jianpu';

const FILE = process.argv[2] ?? 'tests/chorus_03_za_xiwang_tianyeshang_3shengbu.jpg';

async function main() {
  setOmrRuntime(nodeRuntime);
  installNodeDecoder();

  const dump: unknown[] = [];
  (globalThis as { __omrBraceDump?: unknown[] }).__omrBraceDump = dump;
  (globalThis as { __omrProbe?: Record<string, number> }).__omrProbe = {};

  const bytes = readFileSync(FILE);
  const bin = await decodeToBinary(new Uint8Array(bytes), 'image/jpeg');
  const rec = await recognizeJianpu(bin, paddleOcrBackend(), {});
  console.log('bin:', bin.w, 'x', bin.h, ' rows:', rec.rows.length);
  for (const d of dump) console.log(JSON.stringify(d));
  console.log('--- probes ---');
  console.log(JSON.stringify((globalThis as { __omrProbe: Record<string, number> }).__omrProbe, null, 1));
  console.log('--- rows ---');
  rec.rows.forEach((r, i) => {
    console.log(`row ${i}: y=${r.topY}..${r.bottomY} nums=${r.nums.length} bars=${r.barlineXs.length} sys=${r.system ?? '-'} voice=${r.voice ?? '-'}`);
  });
}

void main();
