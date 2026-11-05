// 前奏括号校正的单测：合成字形验证 parenSideOf 的方向判据，再走 correctParenSlurs 全流程。
// 运行：esbuild scripts/paren-slur-test.ts --bundle --platform=node --format=esm
//       --outfile=.tmp-paren-slur-test.mjs --log-level=error && node .tmp-paren-slur-test.mjs
import { correctParenSlurs, parenSideOf } from '../src/ocr/adapter/parenSlurs';
import type { Binary, JpNum, RecognizedScore, StaffRow } from '../src/ocr/dolce/omrkit/types';

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? 'ok' : 'XX'}  ${name}`);
  if (!ok) failed++;
}

const W = 160;
const MED = 26; // 字号
const CY = 40;

function blank(): Binary {
  return { w: W, h: 80, data: new Uint8Array(W * 80) };
}
function dot(bin: Binary, x: number, y: number): void {
  if (x >= 0 && x < bin.w && y >= 0 && y < bin.h) bin.data[y * bin.w + x] = 1;
}

/** 画一段椭圆弧：t ∈ [t0,t1]，px = cx + side·rx·cos t，py = cy + ry·sin t。
 *  side=-1：凸朝左、开口朝右（即 "("）；side=+1：")"。 */
function drawArc(bin: Binary, cx: number, cy: number, rx: number, ry: number, side: -1 | 1, t0 = -1.45, t1 = 1.45): void {
  const steps = 120;
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const px = Math.round(cx + side * rx * Math.cos(t));
    const py = Math.round(cy + ry * Math.sin(t));
    dot(bin, px, py);
    dot(bin, px + 1, py);
  }
}
/** 完整椭圆轮廓（"0"）。 */
function drawZero(bin: Binary, cx: number, cy: number, rx: number, ry: number): void {
  drawArc(bin, cx, cy, rx, ry, -1);
  drawArc(bin, cx, cy, rx, ry, 1);
}
function drawOne(bin: Binary, cx: number, cy: number, h: number): void {
  for (let y = cy - h / 2; y < cy + h / 2; y++) {
    dot(bin, cx, Math.round(y));
    dot(bin, cx + 1, Math.round(y));
  }
  for (let x = cx - 4; x <= cx; x++) dot(bin, x, cy - h / 2); // 旗笔
}
/** 区域内的紧致包围盒（从实际墨反推）。 */
function tight(bin: Binary, x0: number, x1: number): { x: number; y: number; w: number; h: number } {
  let xA = 1e9, xB = -1, yA = 1e9, yB = -1;
  for (let y = 0; y < bin.h; y++)
    for (let x = x0; x <= x1 && x < bin.w; x++)
      if (bin.data[y * bin.w + x]) {
        if (x < xA) xA = x;
        if (x > xB) xB = x;
        if (y < yA) yA = y;
        if (y > yB) yB = y;
      }
  return { x: xA, y: yA, w: xB - xA + 1, h: yB - yA + 1 };
}

// ── parenSideOf：方向判据 ──
{
  const bin = blank();
  drawArc(bin, 30, CY, 5, MED / 2, -1);
  check('( 判为 open', parenSideOf(bin, tight(bin, 20, 40), MED) === 'open');

  const bin2 = blank();
  drawArc(bin2, 30, CY, 5, MED / 2, 1);
  check(') 判为 close', parenSideOf(bin2, tight(bin2, 20, 40), MED) === 'close');

  const bin3 = blank();
  drawZero(bin3, 30, CY, 8, MED / 2);
  check('0 不判为括弧（两侧都有切线列/宽）', parenSideOf(bin3, tight(bin3, 15, 45), MED) === null);

  const bin4 = blank();
  drawOne(bin4, 30, CY, MED);
  check('1 不判为括弧（无双支列）', parenSideOf(bin4, tight(bin4, 20, 40), MED) === null);

  const bin5 = blank();
  drawArc(bin5, 30, CY, 5, MED, -1); // 高 2 字号
  check('超高细弧不收（高门）', parenSideOf(bin5, tight(bin5, 20, 40), MED) === null);
}

// ── correctParenSlurs：全流程 ──
type Glyph = { kind: 'paren-l' | 'paren-r' | 'zero' | 'one' | 'five'; x: number };

function drawGlyph(bin: Binary, g: Glyph): { x0: number; x1: number } {
  const { kind, x } = g;
  if (kind === 'paren-l') {
    drawArc(bin, x + 5, CY, 5, MED / 2, -1);
    return { x0: x - 1, x1: x + 8 };
  }
  if (kind === 'paren-r') {
    drawArc(bin, x + 1, CY, 5, MED / 2, 1);
    return { x0: x - 1, x1: x + 8 };
  }
  if (kind === 'zero') {
    drawZero(bin, x + 8, CY, 8, MED / 2);
    return { x0: x - 1, x1: x + 17 };
  }
  // one / five：竖笔（校正只看 digit 字段与 bbox 形状，音符主体画法无关紧要）
  drawOne(bin, x + 4, CY, MED);
  return { x0: x - 1, x1: x + 9 };
}

function buildRow(digits: Glyph[]): { row: StaffRow; bin: Binary } {
  const bin = blank();
  const spans = digits.map((g) => drawGlyph(bin, g));
  const digitOf: Record<Glyph['kind'], number> = { 'paren-l': 1, 'paren-r': 0, zero: 0, one: 1, five: 5 };
  const nums: JpNum[] = digits.map((g, i) => ({
    digit: digitOf[g.kind],
    bbox: tight(bin, spans[i]!.x0, spans[i]!.x1),
  }));
  return { row: { topY: 0, bottomY: 60, nums, barlineXs: [] }, bin };
}

{
  // 一对前奏括号包住三个音 → 括号删除、连线挂到首尾音
  const digits: Glyph[] = [
    { kind: 'paren-l', x: 10 },
    { kind: 'five', x: 30 },
    { kind: 'five', x: 50 },
    { kind: 'five', x: 70 },
    { kind: 'paren-r', x: 90 },
  ];
  const { row, bin } = buildRow(digits);
  const score = fakeScore([row]);
  const pairs = correctParenSlurs(score, bin);
  check('一对括号 → pairs=1', pairs === 1);
  check('括号块被删除（剩 3 个音）', row.nums.length === 3);
  check('首音打 parenBefore 标记', row.nums[0]!.parenBefore === true);
  check('末音打 parenAfter 标记', row.nums[2]!.parenAfter === true);
  check('中间音无标记', !row.nums[1]!.parenBefore && !row.nums[1]!.parenAfter);
}

{
  // 真的 1 和 0 混在行里：不成对、不构成弧 → 原样保留
  const digits: Glyph[] = [
    { kind: 'one', x: 10 },
    { kind: 'five', x: 30 },
    { kind: 'zero', x: 60 },
  ];
  const { row, bin } = buildRow(digits);
  const score = fakeScore([row]);
  const pairs = correctParenSlurs(score, bin);
  check('真 1/0 不被误改（pairs=0）', pairs === 0 && row.nums.length === 3);
}

{
  // 一行两对括号
  const digits: Glyph[] = [
    { kind: 'paren-l', x: 8 },
    { kind: 'five', x: 24 },
    { kind: 'paren-r', x: 40 },
    { kind: 'five', x: 60 },
    { kind: 'paren-l', x: 80 },
    { kind: 'five', x: 96 },
    { kind: 'paren-r', x: 112 },
  ];
  const { row, bin } = buildRow(digits);
  const score = fakeScore([row]);
  const pairs = correctParenSlurs(score, bin);
  check('两对括号 → pairs=2', pairs === 2 && row.nums.length === 3);
}

function fakeScore(rows: StaffRow[]): RecognizedScore {
  return { key: 'C', fifths: 0, beats: 4, beatType: 4, rows } as unknown as RecognizedScore;
}

// ── DSL 侧：全角（ ）→ paren 指令，序列化 round-trip（依赖的 WindScore 既有能力）──
{
  const { parseDsl, serializeDsl } = await import('../src/v2/dsl');
  const p = parseDsl('@beat 4/4\n\n（ 5 6 7 ） ||\n');
  const parens = (p.score?.events ?? []).filter((e) => e.kind === 'directive' && e.type === 'paren');
  check('DSL（ ）解析为 2 个 paren 指令', parens.length === 2 && parens[0]!.value === '(' && parens[1]!.value === ')');
  const back = serializeDsl(p.score!);
  check('DSL 括号序列化 round-trip', back.includes('（') && back.includes('）'));
}

{
  // 括号比数字高 1.3× 且被读成 2（chorus_04 形态）：tall 分支也收
  const bin = blank();
  drawArc(bin, 15, CY, 5, (MED * 1.3) / 2, -1);
  drawArc(bin, 95, CY, 5, (MED * 1.3) / 2, 1);
  const mk = (x0: number, digit: number): JpNum => ({ digit, bbox: tight(bin, x0, x0 + 22) });
  const row: StaffRow = {
    topY: 0,
    bottomY: 60,
    nums: [mk(8, 2), { digit: 5, bbox: { x: 40, y: CY - MED / 2, w: 8, h: MED } }, { digit: 5, bbox: { x: 55, y: CY - MED / 2, w: 8, h: MED } }, { digit: 5, bbox: { x: 70, y: CY - MED / 2, w: 8, h: MED } }, mk(88, 2)],
    barlineXs: [],
  };
  const score = fakeScore([row]);
  const pairs = correctParenSlurs(score, bin);
  check('高 1.3× 的括号即使被读成 2 也校正', pairs === 1 && row.nums.length === 3 && row.nums[0]!.parenBefore === true);
}

{
  // 正常高度的 2（非弧竖笔）：不校正
  const bin = blank();
  drawOne(bin, 24, CY, MED);
  const row: StaffRow = {
    topY: 0,
    bottomY: 60,
    nums: [
      { digit: 2, bbox: tight(bin, 15, 35) },
      { digit: 5, bbox: { x: 45, y: CY - MED / 2, w: 8, h: MED } },
    ],
    barlineXs: [],
  };
  const score = fakeScore([row]);
  const pairs = correctParenSlurs(score, bin);
  check('正常高度的 2 不校正', pairs === 0 && row.nums.length === 2);
}

console.log(failed ? `\nPAREN FAIL (${failed})` : '\nPAREN 全部通过');
if (failed) process.exit(1);
