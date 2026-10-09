/**
 * 「听音成谱」纯逻辑层测试（quantize.ts / toDsl.ts）。
 * 识别模型本身没法在 Node 里测，这里钉住的是确定性部分：
 * 多→单、量化、唱名转换、DSL 生成。
 */

import { detectKey, keyToTonic, measuresToLines, midiToSyllable, noteToken, quantizeNotes, reduceToMelody, type RawNote } from '../src/v2/lab/quantize';
import { buildDsl } from '../src/v2/lab/toDsl';

let failed = 0;
let total = 0;
function check(name: string, ok: boolean, detail = ''): void {
  total += 1;
  if (ok) console.log(`  ok  ${name}`);
  else {
    failed += 1;
    console.log(`  XX  ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

console.log('[听音成谱 · 多转单]');
{
  const raw: RawNote[] = [
    { start: 0, end: 1, midi: 60, amp: 0.9 },
    { start: 0.2, end: 0.5, midi: 64, amp: 0.4 }, // 弱音叠在强音上：应让位
    { start: 1, end: 1.5, midi: 67, amp: 0.3 },
    { start: 1.2, end: 1.6, midi: 72, amp: 0.8 }, // 强音后到：截掉前段重叠
  ];
  const mel = reduceToMelody(raw);
  check('重叠段让位给更响的音', mel.length === 3, JSON.stringify(mel));
  check('按时间排序', mel.every((n, i) => i === 0 || n.start >= mel[i - 1].start));
  const cut = mel.find((n) => n.midi === 67);
  // 强音从 1.2s 起：弱音保留自己前面的非重叠段 [1, 1.2]
  check('被截断的音保留非重叠部分', !!cut && cut.start === 1 && Math.abs(cut.end - 1.2) < 1e-9, JSON.stringify(cut));
}

console.log('[听音成谱 · 量化]');
{
  // bpm=120 → 1 拍 0.5s；offset 0.25s 模拟前奏
  const raw: RawNote[] = [
    { start: 0.25, end: 0.75, midi: 60, amp: 0.9 }, // 整 1 拍
    { start: 0.75, end: 0.9, midi: 62, amp: 0.8 }, // 0.15s = 0.3 拍 → 吸附 1/16
  ];
  const g = quantizeNotes(raw, 120, 0.25);
  check('首拍对齐网格起点', g[0].startTick === 0, JSON.stringify(g[0]));
  check('整拍时长 = 48 tick', g[0].durTicks === 48, `${g[0].durTicks}`);
  check('短音吸附到 1/16 (12 tick)', g[1].startTick === 48 && g[1].durTicks === 12, JSON.stringify(g[1]));
  check('起点不早于 0', quantizeNotes([{ start: 0.1, end: 0.4, midi: 60, amp: 1 }], 120, 0.25)[0].startTick === 0);
}

console.log('[听音成谱 · 唱名]');
{
  check('1=C 主音是 C', keyToTonic('1=C') === 0);
  check('1=bB 主音是 10', keyToTonic('1=bB') === 10);
  check('C4=唱名1中音区', midiToSyllable(60, '1=C').deg === '1' && midiToSyllable(60, '1=C').oct === 0);
  check('B4=7 中音区', midiToSyllable(71, '1=C').deg === '7' && midiToSyllable(71, '1=C').oct === 0);
  check('C5=高音1', midiToSyllable(72, '1=C').oct === 1);
  check('C3=低音1', midiToSyllable(48, '1=C').oct === -1);
  // 1=G 时 A4=2（首调），midi 69
  check('1=G 时 A=2', midiToSyllable(69, '1=G').deg === '2');
  check('1=G 时 F# 是自然 7 级（首调不写升号）', midiToSyllable(66, '1=G').deg === '7' && midiToSyllable(66, '1=G').acc === '');
  check('黑键等距取升', midiToSyllable(61, '1=C').acc === '#');
  // 1=G 的自然音级 G A B C D E F#：F#（66）权重最高 → 应检出 1=G
  const gMajor: RawNote[] = [67, 69, 71, 72, 74, 76, 78].map((midi, i) => ({
    start: i * 0.5,
    end: i * 0.5 + 0.45,
    midi,
    amp: 1,
  }));
  check('G 大调音集检出 1=G', detectKey(gMajor) === '1=G', detectKey(gMajor));
  const cMajor: RawNote[] = [60, 62, 64, 65, 67, 69, 71].map((midi, i) => ({
    start: i * 0.5,
    end: i * 0.5 + 0.45,
    midi,
    amp: 1,
  }));
  check('C 大调音集检出 1=C', detectKey(cMajor) === '1=C', detectKey(cMajor));
}

console.log('[听音成谱 · DSL 记号]');
{
  // 时长吸附：48=四分 / 24=八分 / 12=十六分 / 72=附点 / 96=增时线一条
  check('四分', noteToken(60, 48, '1=C') === '1');
  check('八分', noteToken(60, 24, '1=C') === '1/2');
  check('十六分', noteToken(60, 12, '1=C') === '1/4');
  check('附点四分', noteToken(60, 72, '1=C') === '1.');
  check('二分=增时线', noteToken(60, 96, '1=C') === '1-');
  check('全音符=三条线', noteToken(60, 192, '1=C') === '1---');
  check('高音点', noteToken(72, 48, '1=C') === '1^');
  check('低音点', noteToken(48, 48, '1=C') === '1v');
  check('变化音前缀', noteToken(61, 48, '1=C') === '#1');
}

console.log('[听音成谱 · 小节与整谱]');
{
  // 4/4，两小节：| 1 2 3 4 | 5 6 7 1^ |，中间空拍补 0
  const notes = quantizeNotes(
    [
      { start: 0, end: 0.5, midi: 60, amp: 1 },
      { start: 0.5, end: 1, midi: 62, amp: 1 },
      { start: 1, end: 1.5, midi: 64, amp: 1 },
      { start: 1.5, end: 2, midi: 65, amp: 1 },
      { start: 2, end: 2.5, midi: 67, amp: 1 },
      { start: 2.5, end: 3, midi: 69, amp: 1 },
      { start: 3, end: 3.5, midi: 71, amp: 1 },
      { start: 3.5, end: 4, midi: 72, amp: 1 },
    ],
    120,
    0,
  );
  const lines = measuresToLines(notes, 4, '1=C');
  check('两小节两行', lines.length === 2, JSON.stringify(lines));
  check('第一小节四个四分', lines[0] === '1 2 3 4', lines[0]);
  check('八分拍组包 <>', (() => {
    const g = measuresToLines(quantizeNotes([{ start: 0, end: 0.25, midi: 60, amp: 1 }, { start: 0.25, end: 0.5, midi: 62, amp: 1 }], 120, 0), 4, '1=C');
    return g[0].startsWith('<1/2 2/2>');
  })());
  // 空小节补休止
  const sparse = measuresToLines(quantizeNotes([{ start: 2, end: 2.5, midi: 60, amp: 1 }], 120, 0), 4, '1=C');
  check('空小节补 0 休止', sparse[0] === '0 0 0 0' && sparse[1] === '1 0 0 0', JSON.stringify(sparse));

  const text = buildDsl({ title: '测试', key: '1=C', beat: '4/4', bpm: 120, note: '人声主旋律（AI 转录）', notes });
  check('头部含 @sub/@note', text.includes('@bpm 120') && text.includes('@note 人声主旋律（AI 转录）'));
  check('正文按 4 小节一行', !text.split('\n\n')[1].includes('\n'));
  // 生成的谱必须能被自家解析器吃回去（往返闭环交给 v2-test 的 parseDsl 套件）
}

console.log(failed === 0 ? `\n听音成谱测试全部通过（${total} 项）` : `\n听音成谱测试失败 ${failed}/${total} 项`);
if (failed > 0) process.exit(1);
