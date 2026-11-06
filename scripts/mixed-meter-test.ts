// 备选拍号（交替拍子，6/8|9/8 等第二节拍）回归测试。
// 语义：**小节可以是第一节拍或第二节拍的拍数（任一满足即正确），不是相加**。
// 覆盖：validMeter / meterBeatOptions / beatsPerMeasure / groupTicks、DSL 解析与
// round-trip、谱中转拍、拍数校验徽标（满足任一拍号的小节不报错）。
import { parseDsl, serializeDsl } from '../src/v2/dsl';
import { validMeter, beatsPerMeasure, meterBeatOptions, groupTicks } from '../src/v2/meter';
import { layoutScore } from '../src/v2/layout';
import { setMeta } from '../src/v2/edit';

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
check('备选拍号 6/8|9/8 合法', validMeter('6/8|9/8'));
check('三段备选 9/8|6/8|6/8 合法', validMeter('9/8|6/8|6/8'));
check('段非法 6/8|9/7 拒绝', !validMeter('6/8|9/7'));
check('空段 6/8| 拒绝', !validMeter('6/8|'));
check('旧写法 + 读入仍兼容（语义=备选）', validMeter('6/8+9/8'));
check('遗留垃圾仍拒绝', !validMeter('哈哈哈'));

console.log('── setMeta（曲目信息「第二节拍」下拉的写入链路）──');
{
  const s = parseDsl('@beat 4/4\n\n1 2 3 4 ||\n').score!;
  const mixed = setMeta(s, { beat: '4/4|3/4' });
  check('setMeta 接受备选拍号（下拉选第二节拍生效）', mixed.meta.beat === '4/4|3/4', mixed.meta.beat);
  const back = parseDsl(serializeDsl(mixed)).score!;
  check('写回 DSL 并读回保持', back.meta.beat === '4/4|3/4', back.meta.beat);
  check('setMeta 拒绝脏拍号', setMeta(s, { beat: '哈哈哈' }).meta.beat === '4/4');
  check('setMeta 拒绝残缺备选', setMeta(s, { beat: '4/4|' }).meta.beat === '4/4');
}

console.log('── meterBeatOptions / beatsPerMeasure ──');
check('4/4 → [4]', JSON.stringify(meterBeatOptions('4/4')) === '[4]');
check('6/8|9/8 → [3, 4.5]', JSON.stringify(meterBeatOptions('6/8|9/8')) === '[3,4.5]', JSON.stringify(meterBeatOptions('6/8|9/8')));
check('旧 + 写法同语义 → [3, 4.5]', JSON.stringify(meterBeatOptions('6/8+9/8')) === '[3,4.5]');
check('beatsPerMeasure 取首段（3 拍）', beatsPerMeasure('6/8|9/8') === 3);
check('垃圾串回落 4 拍', beatsPerMeasure('哈哈哈') === 4);

console.log('── groupTicks（复拍子大拍 1½）──');
check('6/8|9/8 连通边界 = 1.5 拍（两段都是复拍子）', groupTicks('6/8|9/8') === Math.round(6720 * 1.5));
check('6/8|3/4（混合单拍子）暂按 1 拍', groupTicks('6/8|3/4') === 6720);

console.log('── DSL 解析与 round-trip ──');
{
  const p = parseDsl('@format 3\n@title 备选拍号\n@key 1=C\n@beat 6/8|9/8\n@bpm 96\n\n1 2 3 | 1/ 2/ 3/ 4/ 5/ 6/ 7/ 1^/ 2^/ |\n');
  check('@beat 6/8|9/8 解析无错', p.errors.length === 0, p.errors.join('; '));
  check('meta.beat 保留备选串', p.score?.meta.beat === '6/8|9/8');
  const s = p.score ? serializeDsl(p.score) : '';
  check('serialize 回写 @beat 6/8|9/8', s.includes('@beat 6/8|9/8'));
}
{
  // 谱中转拍
  const p = parseDsl('@format 3\n@key 1=C\n@beat 6/8\n@bpm 96\n\n1 2 3 4 5 6 | 拍9/8 1 2 3 4 5 6 7 1^ |\n');
  check('谱中 拍9/8 无错', p.errors.length === 0, p.errors.join('; '));
  const p2 = parseDsl('@format 3\n@key 1=C\n@beat 6/8\n@bpm 96\n\n1 2 3 4 5 6 | 拍6/8|9/8 1 2 3 |\n');
  check('谱中 拍6/8|9/8 无错', p2.errors.length === 0, p2.errors.join('; '));
  const bar = p2.score?.events.find((e) => e.kind === 'barline' && e.beatAfter);
  check('beatAfter 存备选串', bar && 'beatAfter' in bar && bar.beatAfter === '6/8|9/8');
}

console.log('── 拍数校验（小节满足任一拍号即无徽标）──');
{
  // 6/8|9/8：3 拍（6/8）与 4.5 拍（9/8）的小节都应无徽标
  const good = parseDsl('@format 3\n@key 1=C\n@beat 6/8|9/8\n@bpm 96\n\n1 2 3 | 1/ 2/ 3/ 4/ 5/ 6/ 7/ 1^/ 2^/ |\n');
  const layout = layoutScore(good.score!, { contentWidth: 1200, fitWidth: true });
  check('3 拍小节无徽标', allBadges(layout).length === 0, JSON.stringify(allBadges(layout).map((b) => b.text)));

  const bad = parseDsl('@format 3\n@key 1=C\n@beat 6/8|9/8\n@bpm 96\n\n1 2 3 4 |\n');
  const layout2 = layoutScore(bad.score!, { contentWidth: 1200, fitWidth: true });
  check('4 拍小节（不匹配任一段）报徽标', allBadges(layout2).length > 0, JSON.stringify(allBadges(layout2).map((b) => b.text)));
  check('徽标带「或」标定', allBadges(layout2).every((b) => b.text.includes('或')), JSON.stringify(allBadges(layout2).map((b) => b.text)));

  // 谱中转入备选拍号后同样按新标定校验
  const mid = parseDsl('@format 3\n@key 1=C\n@beat 3/4\n@bpm 96\n\n1 2 3 | 拍6/8|9/8 1 2 3 |\n');
  const layout3 = layoutScore(mid.score!, { contentWidth: 1200, fitWidth: true });
  check('转入备选拍号后 3 拍小节无徽标', allBadges(layout3).length === 0, JSON.stringify(allBadges(layout3).map((b) => b.text)));
}

console.log('── 三段及以上交替拍号（梁祝 4/4|2/4|1/4 实测）──');
check('1/4 合法', validMeter('1/4'));
check('四段 4/4|2/4|1/4|1/8 合法', validMeter('4/4|2/4|1/4|1/8'));
check('三段拍数 → [4,2,1]', JSON.stringify(meterBeatOptions('4/4|2/4|1/4')) === '[4,2,1]', JSON.stringify(meterBeatOptions('4/4|2/4|1/4')));
check('beatsPerMeasure 仍取首段 4 拍', beatsPerMeasure('4/4|2/4|1/4') === 4);
{
  const p = parseDsl('@format 3\n@key 1=C\n@beat 4/4|2/4|1/4\n@bpm 96\n\n1 2 3 4 | 1 2 | 1 | 1 2 3 4 ||\n');
  check('三段 @beat 解析无错', p.errors.length === 0, p.errors.join('; '));
  check('三段 round-trip 保留原串', serializeDsl(p.score!).includes('@beat 4/4|2/4|1/4'));
  const layout = layoutScore(p.score!, { contentWidth: 1200, fitWidth: true });
  check('4 / 2 / 1 拍小节都无徽标', allBadges(layout).length === 0, JSON.stringify(allBadges(layout).map((b) => b.text)));
  const bad = parseDsl('@format 3\n@key 1=C\n@beat 4/4|2/4\n@bpm 96\n\n1 2 3 4 | 1 | 1 2 3 4 ||\n');
  const badLayout = layoutScore(bad.score!, { contentWidth: 1200, fitWidth: true });
  check('少一段时 1 拍小节报徽标', allBadges(badLayout).length > 0, JSON.stringify(allBadges(badLayout).map((b) => b.text)));
  const s = parseDsl('@beat 4/4\n\n1 2 3 4 ||\n').score!;
  check('setMeta 接受三段拍号', setMeta(s, { beat: '4/4|2/4|1/4' }).meta.beat === '4/4|2/4|1/4');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
