/** 安卓字号调整必须按屏宽重排，不能靠扩大画布或隐藏溢出来实现。 */
import { readFileSync } from 'node:fs';
import { parseDsl } from '../src/v2/dsl';
import { layoutScore } from '../src/v2/layout';
import { buildStaffLayout } from '../src/v2/staff';
import { staffSystemStarts } from '../src/v2/staffSystems';
import { partScore, scoreParts } from '../src/v2/parts';

let failures = 0;
let reflowed = 0;
let cases = 0;
for (const name of ['molihua-repeat', 'qinghuaci', 'xiaoxingxing', 'ensemble-demo', 'quartet-demo']) {
  const score = parseDsl(readFileSync(`src/scores/${name}.jps`, 'utf8')).score!;
  for (const width of [320, 360, 390, 768, 1024]) for (const fontSize of [14, 21, 32, 42]) {
    const views = width < 760 && score.parts?.length ? scoreParts(score).map(part => partScore(score, part.id)) : [score];
    for (const view of views) {
    cases++;
    const layout = layoutScore(view, { contentWidth: width, fontSize, unit: .7, fitWidth: true, rightPadding: 20 });
    const overflow = layout.lines.flatMap(line => line.items).some(item => item.x < 0 || item.x + item.w > width + .01);
    if (overflow) { failures++; console.error(`超出屏宽：${name} / ${width}px / 字号 ${fontSize}`); }
    const staffLayout = layoutScore(view, { contentWidth: width, fontSize, unit: .7, fitWidth: true, padding: 96 * fontSize / 21, rightPadding: 20, staffPitchMode: 'concert', staffKeySpace: 104 * fontSize / 21 });
    const staff = buildStaffLayout(view, staffLayout, 'concert');
    if ([...staffSystemStarts(staff).values()].some(line => line.staffLeft < 0 || line.staffRight > width + .01)) {
      failures++; console.error(`五线谱超出屏宽：${name} / ${width}px / 字号 ${fontSize}`);
    }
    }
  }
  const small = layoutScore(score, { contentWidth: 360, fontSize: 21, unit: .7, fitWidth: true, rightPadding: 20 });
  const large = layoutScore(score, { contentWidth: 360, fontSize: 42, unit: .7, fitWidth: true, rightPadding: 20 });
  if (large.lines.length > small.lines.length) reflowed++;
  if (large.height <= small.height) { failures++; console.error(`字号增大后排版高度没有增加：${name}`); }
}
if (!reflowed) { failures++; console.error('字号放大没有触发任何自动断行'); }
if (failures) process.exit(1);
console.log(`安卓字号重排：简谱/五线谱各 ${cases} 组屏宽、字号和声部组合无横向溢出，放大后重新断行。`);
