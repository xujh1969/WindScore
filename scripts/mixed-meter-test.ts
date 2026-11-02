// 混合拍（6/8+9/8 等第二节拍）回归测试。
// 覆盖：validMeter / beatsPerMeasure / groupTicks、DSL 解析与 round-trip、
// 谱中转拍、拍数校验徽标（满足标定节拍的小节不报错）。
import { parseDsl, serializeDsl } from '../src/v2/dsl';
import { validMeter, beatsPerMeasure, groupTicks } from '../src/v2/meter';
import { layoutScore } from '../src/v2/layout';

function allBadges(l: ReturnType<typeof layoutScore>): { text: string }[] {
  return (l as unknown as { lines: { badges: { text: string } }[] }).lines.flatMap((ln) => ln.badges);
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('── validMeter ──');
check('单拍号 4/4 合法', validMeter('4/4'));
check('混合拍 6/8+9/8 合法', validMeter('6/8+9/8'));
check('混合拍 9/8+6/8+6/8 合法', validMeter('9/8+6/8+6/8'));
check('混合拍段非法 6/8+9/7 拒绝', !validMeter('6/8+9/7'));
check('混合拍空段 6/8+ 拒绝', !validMeter('6/8+'));
check('遗留垃圾仍拒绝', !validMeter('哈哈哈'));

console.log('── beatsPerMeasure（各段之和）──');
check('4/4 = 4 拍', beatsPerMeasure('4/4') === 4);
check('6/8 = 3 拍', beatsPerMeasure('6/8') === 3);
check('6/8+9/8 = 7.5 拍', beatsPerMeasure('6/8+9/8') === 7.5);
check('9/8+6/8+6/8 = 10.5 拍', Math.abs(beatsPerMeasure('9/8+6/8+6/8') - 10.5) < 1e-9);
check('垃圾串回落 4 拍', beatsPerMeasure('哈哈哈') === 4);

console.log('── groupTicks（混合复拍子大拍 1½）──');
check('6/8+9/8 连通边界 = 1.5 拍', groupTicks('6/8+9/8') === Math.round(6720 * 1.5));
check('6/8+3/4（混合单拍子）暂按 1 拍', groupTicks('6/8+3/4') === 6720);

console.log('── DSL 解析与 round-trip ──');
{
  const p = parseDsl('@format 3\n@title 混合拍\n@key 1=C\n@beat 6/8+9/8\n@bpm 96\n\n1 2 3 4 5 6 7 1^/ |\n');
  check('@beat 6/8+9/8 解析无错', p.errors.length === 0, p.errors.join('; '));
  check('meta.beat 保留混合串', p.score?.meta.beat === '6/8+9/8');
  const s = p.score ? serializeDsl(p.score) : '';
  check('serialize 回写 @beat 6/8+9/8', s.includes('@beat 6/8+9/8'));
}
{
  // 谱中转拍
  const p = parseDsl('@format 3\n@key 1=C\n@beat 6/8\n@bpm 96\n\n1 2 3 4 5 6 | 拍9/8 1 2 3 4 5 6 7 1^ |\n');
  check('谱中 拍9/8 无错', p.errors.length === 0, p.errors.join('; '));
  const p2 = parseDsl('@format 3\n@key 1=C\n@beat 6/8\n@bpm 96\n\n1 2 3 4 5 6 | 拍6/8+9/8 1 2 3 4 5 6 7 1^/ |\n');
  check('谱中 拍6/8+9/8 无错', p2.errors.length === 0, p2.errors.join('; '));
  const bar = p2.score?.events.find((e) => e.kind === 'barline' && e.beatAfter);
  check('beatAfter 存混合串', bar && 'beatAfter' in bar && bar.beatAfter === '6/8+9/8');
}

console.log('── 拍数校验（满足标定节拍的小节判定正确）──');
{
  // 6/8+9/8 = 7.5 拍：7.5 拍的小节应无徽标；4 拍的小节应 ⚠
  const good = parseDsl('@format 3\n@key 1=C\n@beat 6/8+9/8\n@bpm 96\n\n1 2 3 4 5 6 7 1^/ |\n');
  const layout = layoutScore(good.score!, { contentWidth: 1200, fitWidth: true });
  check('7.5 拍小节无徽标', allBadges(layout).length === 0, JSON.stringify(allBadges(layout).map((b) => b.text)));

  const bad = parseDsl('@format 3\n@key 1=C\n@beat 6/8+9/8\n@bpm 96\n\n1 2 3 4 |\n');
  const layout2 = layoutScore(bad.score!, { contentWidth: 1200, fitWidth: true });
  check('4 拍小节报 ⚠', allBadges(layout2).some((b) => b.text.includes('⚠')), JSON.stringify(allBadges(layout2).map((b) => b.text)));

  // 谱中转入混合拍后同样按新标定校验
  const mid = parseDsl('@format 3\n@key 1=C\n@beat 3/4\n@bpm 96\n\n1 2 3 | 拍6/8+9/8 1 2 3 4 5 6 7 1^/ |\n');
  const layout3 = layoutScore(mid.score!, { contentWidth: 1200, fitWidth: true });
  check('转入混合拍后 7.5 拍小节无徽标', allBadges(layout3).length === 0, JSON.stringify(allBadges(layout3).map((b) => b.text)));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
