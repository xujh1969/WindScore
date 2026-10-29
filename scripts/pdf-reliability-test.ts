import assert from 'node:assert/strict';
import { a4Geometry } from '../src/v2/export/tasks';
import { buildPdf } from '../src/v2/export/pdf';
import { fromText } from '../src/v2/io';
import { saveScore } from '../src/v2/io';
import { regionHasInk } from '../src/v2/export/render';

for (const landscape of [false, true]) for (const dpi of [96, 150, 300]) {
  const geo = a4Geometry(landscape, dpi, 1);
  assert.ok(Number.isInteger(geo.pageW) && Number.isInteger(geo.pageH), `PDF 图片尺寸必须为整数：${dpi}dpi ${geo.pageW}×${geo.pageH}`);
}
assert.throws(() => buildPdf([{ jpeg: new Uint8Array([255, 216, 255, 217]), width: 1240.17, height: 1753.94 }], 595.28, 841.89), /尺寸/);
const raw = '@title 待修复\r\n\r\n( 5 6 错误记号 |\r\n';
const opened = fromText(raw, '原始文件', 'C:/scores/原始文件.jps');
assert.equal(opened.score, null);
assert.ok(opened.errors.length > 0);
assert.equal(opened.text, raw, '解析失败仍完整保留原文、换行和未知记号');
assert.equal(opened.path, 'C:/scores/原始文件.jps');
let written = '';
const saved = await saveScore(raw, '待修复.jps', {
  name: '待修复.jps', getFile: async () => { throw new Error('不应读文件'); },
  createWritable: async () => ({ write: async (text) => { written = text; }, close: async () => {} }),
});
assert.ok(saved.ok && saved.inPlace);
assert.equal(written, raw, '含错误的草稿必须原样写回，不序列化部分解析结果');
Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => null }) } });
assert.throws(() => regionHasInk({} as HTMLCanvasElement, 0, 0, 100, 100, '#ffffff', true), /校验画布/);
delete (globalThis as unknown as { document?: unknown }).document;
console.log('PDF 整数尺寸与源码修复入口检查通过');
