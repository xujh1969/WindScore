/**
 * MusicXML → JPS 转译回归。样例内联，覆盖：
 * 基本时值 / 附点 / 高低八度 / 休止 / 变音（含调号消音）/ 拍号变化 / 换调 /
 * 延音线 / 连线 / 连音组 / 弱起 / 反复 / 终止线 / 多声部 / 多小节休止 / .mxl 解包。
 */
import { deflateRawSync } from 'node:zlib';
import { parseDsl, serializeDsl } from '../src/v2/dsl';
import { layoutScore } from '../src/v2/layout';
import { musicXmlSummary, musicXmlToJps, unzipMusicXml, durationSuffix } from '../src/v2/musicxml';

let ok = 0;
let bad = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    ok += 1;
    console.log(`  ok  ${name}`);
  } else {
    bad += 1;
    console.log(`  XX  ${name} ${detail}`);
  }
};

const parseErrorsOf = (dsl: string): string[] => parseDsl(dsl).errors;

/** 双小节线回归：展开器规定「两根线不能连着站」（0 拍空小节，拍数校验报错） */
const noAdjacentBarlines = (dsl: string): boolean => {
  const events = parseDsl(dsl).score?.events ?? [];
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].kind === 'barline' && events[i - 1].kind === 'barline') return false;
  }
  return events.length > 0;
};

console.log('\n[MusicXML 转译 · 时值后缀]');
{
  const f = (n: number, d: number) => ({ n, d });
  check('1 拍 = 无后缀', durationSuffix(f(1, 1)) === '');
  check('2 拍 = -', durationSuffix(f(2, 1)) === '-');
  check('4 拍 = ---', durationSuffix(f(4, 1)) === '---');
  check('半拍 = /2', durationSuffix(f(1, 2)) === '/2');
  check('四分之一 = /4', durationSuffix(f(1, 4)) === '/4');
  check('附点八分 = ./2（点在除法前，与 NOTE_RE/renderDuration 同构）', durationSuffix(f(3, 4)) === './2');
  check('附点四分 = .', durationSuffix(f(3, 2)) === '.');
  check('复附点 = ..', durationSuffix(f(7, 4)) === '..');
  check('三连音成员不匹配常规写法', durationSuffix(f(1, 3)) === null);
}

// 一首覆盖面较全的单声部谱
const SAMPLE1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>测试曲</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>主旋律</part-name></score-part>
    <score-part id="P2"><part-name>伴奏</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>96</per-minute></metronome></direction-type><sound tempo="96"/></direction>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>B</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>half</type><tie type="start"/><notations><tied type="start"/></notations></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><tie type="stop"/><notations><tied type="stop"/></notations></note>
      <note><rest/><duration>2</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="3">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><notations><articulations><staccato/></articulations></notations></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><notations><slur type="start" number="1"/></notations></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><notations><slur type="stop" number="1"/></notations></note>
    </measure>
    <measure number="4">
      <attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>8</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>A</step><octave>2</octave></pitch><duration>8</duration><voice>1</voice><type>whole</type></note>
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
  </part>
</score-partwise>`;

console.log('\n[MusicXML 转译 · 声部列表]');
{
  const { summary, errors } = musicXmlSummary(SAMPLE1);
  check('解析无错', errors.length === 0, errors.join('/'));
  check('标题', summary.title === '测试曲', summary.title);
  check('两个声部', summary.parts.length === 2 && summary.parts[0].name === '主旋律' && summary.parts[1].id === 'P2');
}

console.log('\n[MusicXML 转译 · 单声部 P1]');
{
  const { dsl, warnings, errors } = musicXmlToJps(SAMPLE1, ['P1']);
  check('转换无错', errors.length === 0, errors.join('/'));
  check('无告警（F# 由调号消化、时值都可表达）', warnings.length === 0, warnings.join('/'));
  check('谱头：@key 1=G（fifths=1）', dsl.includes('@key 1=G'), dsl);
  check('谱头：@bpm 96', dsl.includes('@bpm 96'));
  check('高音 B（B5）= 3^^（G 调三级，高两个八度点）', dsl.includes(' 3^^ '), dsl);
  check('低音 A（A3）= 2（G 调二级，中音组）', dsl.includes(' 3^^ 2'), dsl);
  check('F#4 在 G 调 = 7 无变音记号（调号已含）', /\| 7-~ 7 0(\s|$)/.test(dsl), dsl);
  check('C#4 在 G 调 = #4（调号外的临时升降）', dsl.includes('#4/2 '), dsl);
  check('延音线 7-~ 7', dsl.includes('7-~ 7 '), dsl);
  check('跳音 6!', dsl.includes('6! '), dsl);
  check('连线 (3^ 2^)', /\(3\^ 2\^\)/.test(dsl), dsl);
  check('拍号变化 | 拍3/4', dsl.includes('| 拍3/4 '), dsl);
  check('终止线 ||', dsl.trimEnd().endsWith('||'), dsl);
  const errs = parseErrorsOf(dsl);
  check('产物可被 DSL 解析', errs.length === 0, errs.join('/'));
  check('无相邻双小节线', noAdjacentBarlines(dsl));
  const score = parseDsl(dsl).score!;
  const layout = layoutScore(score, { contentWidth: 1400 });
  check('排版无拍数徽标', layout.lines.every((l) => l.badges.length === 0), JSON.stringify(layout.lines.flatMap((l) => l.badges)));
  // round-trip 稳定
  check('round-trip 稳定', serializeDsl(score) === serializeDsl(parseDsl(serializeDsl(score)).score!));
}

console.log('\n[MusicXML 转译 · 多声部]');
{
  const { dsl, errors } = musicXmlToJps(SAMPLE1, ['P1', 'P2']);
  check('转换无错', errors.length === 0, errors.join('/'));
  check('@format 3', dsl.includes('@format 3'));
  check('@part 1 "主旋律"', dsl.includes('@part 1 "主旋律"'));
  check('@part 2 "伴奏"', dsl.includes('@part 2 "伴奏"'));
  check('P2 的 G2 = 1v---（G 调主音低一组 + 增时线）', dsl.includes('1v---'), dsl);
  const errs = parseErrorsOf(dsl);
  check('产物可被 DSL 解析（多声部）', errs.length === 0, errs.join('/'));
  const score = parseDsl(dsl).score!;
  check('两个声部', (score.parts?.length ?? 0) + 1 === 2, String(score.parts?.length));
}

console.log('\n[MusicXML 转译 · 连音 / 弱起 / 反复 / 换调 / 多小节休止]');
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>3</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="1">
      <barline location="left"><repeat direction="forward"/></barline>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start" number="1"/></notations></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop" number="1"/></notations></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>9</duration><voice>1</voice><type>half</type><dot/></note>
      <barline location="right"><repeat direction="backward"/></barline>
    </measure>
    <measure number="2">
      <attributes><key><fifths>-2</fifths></key></attributes>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="3">
      <measure-style><multiple-rest>2</multiple-rest></measure-style>
      <note><rest measure="yes"/><duration>12</duration><voice>1</voice></note>
    </measure>
    <measure number="4">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice><type>whole</type></note>
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
  </part>
</score-partwise>`;
  const { dsl, warnings, errors } = musicXmlToJps(xml, ['P1']);
  check('转换无错', errors.length === 0, errors.join('/'));
  check('弱起 |{partial}', dsl.includes('|{partial}'), dsl);
  check('反复开始 |:', dsl.includes('|:'), dsl);
  check('三连音组 <3: 1/3 2/3 3/3>', dsl.includes('<3: 1/3 2/3 3/3>'), dsl);
  check('附点二分 = 3 拍（4--，解析等价）', dsl.includes('4--'), dsl);
  check('反复结束 :|', /:\|/.test(dsl), dsl);
  check('换调 转1=Bb', dsl.includes('转1=Bb'), dsl);
  check('Bb 调里的 Bb4 = 1^---（主音本身无变音；中音 1 = Bb3，故带高音点）', /转1=Bb 1\^---/.test(dsl), dsl);
  check('多小节休止展开（两小节 0---）', (dsl.match(/0---/g) ?? []).length >= 2, dsl);
  check('有展开告警', warnings.some((w) => w.includes('多小节休止')), warnings.join('/'));
  const errs = parseErrorsOf(dsl);
  check('产物可被 DSL 解析', errs.length === 0, errs.join('/'));
  check('无相邻双小节线（弱起+反复）', noAdjacentBarlines(dsl));
  const layout = layoutScore(parseDsl(dsl).score!, { contentWidth: 1400 });
  check('排版无拍数徽标（弱起已豁免）', layout.lines.every((l) => l.badges.length === 0), JSON.stringify(layout.lines.flatMap((l) => l.badges)));
}

console.log('\n[MusicXML 转译 · 兼容映射（力度 / 渐变 / 八度段 / 装饰记号）]');
{
  // 覆盖：力度 p、渐强 wedge→cresc[]hairpin、颤音 r、换气 V、
  // 8va 段、震音 zz、琶音 a、延长号 @、换行（print new-system）、滑音线进「未支持」清单
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <direction><direction-type><wedge type="crescendo"/></direction-type></direction>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><notations><ornaments><trill-mark/></ornaments></notations></note>
      <direction><direction-type><wedge type="stop"/></direction-type></direction>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><notations><articulations><breath-mark/></articulations></notations></note>
    </measure>
    <measure number="2">
      <print new-system="yes"/>
      <direction><direction-type><octave-shift type="up" size="8"/></direction-type></direction>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>half</type><notations><arpeggiate/><ornaments><tremolo>2</tremolo></ornaments></notations></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>half</type><notations><fermata/></notations></note>
      <direction><direction-type><octave-shift type="stop"/></direction-type></direction>
    </measure>
    <measure number="3">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>whole</type><notations><glissando type="start" number="1"/></notations></note>
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
  </part>
</score-partwise>`;
  const { dsl, warnings, errors } = musicXmlToJps(xml, ['P1']);
  check('转换无错', errors.length === 0, errors.join('/'));
  check('力度 p → 独立 token 绑下一个音', dsl.includes('p 1 '), dsl);
  check('渐强 wedge → cresc[ … ]hairpin', dsl.includes('cresc[ 2 3r ]hairpin'), dsl);
  check('颤音 trill-mark → 3r', dsl.includes('3r '), dsl);
  check('换气 breath-mark → 4V', dsl.includes('4V'), dsl);
  check('print new-system → 换行（紧接小节线）', /\| 换行 /.test(dsl), dsl);
  check('8va 段 + 震音 zz + 琶音 a', /\b8va\[ 5-zza/.test(dsl), dsl);
  check('延长号 fermata → 6-@，段收 ]8', /6-@ \]8/.test(dsl), dsl);
  check('滑音线进未支持清单', warnings.some((w) => w.includes('未支持') && w.includes('滑音线')), warnings.join('/'));
  const errs = parseErrorsOf(dsl);
  check('产物可被 DSL 解析', errs.length === 0, errs.join('/'));
  check('无相邻双小节线', noAdjacentBarlines(dsl));
  const score = parseDsl(dsl).score!;
  const layout = layoutScore(score, { contentWidth: 1400 });
  check('排版无拍数徽标', layout.lines.every((l) => l.badges.length === 0), JSON.stringify(layout.lines.flatMap((l) => l.badges)));
  check('round-trip 稳定', serializeDsl(score) === serializeDsl(parseDsl(serializeDsl(score)).score!));

  // 复合拍子求和：3+2/8 → 5/8
  const xml2 = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>V</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>3+2</beats><beat-type>8</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
  </part>
</score-partwise>`;
  const r2 = musicXmlToJps(xml2, ['P1']);
  check('复合拍子 3+2/8 求和为 5/8（谱头 @beat 5/8）', r2.dsl.includes('@beat 5/8'), r2.dsl);
  check('复合拍子有近似告警', r2.warnings.some((w) => w.includes('复合拍子')), r2.warnings.join('/'));
  check('复合拍子产物可解析', parseErrorsOf(r2.dsl).length === 0, parseErrorsOf(r2.dsl).join('/'));
  const l2 = layoutScore(parseDsl(r2.dsl).score!, { contentWidth: 1400 });
  check('复合拍子排版无徽标', l2.lines.every((l) => l.badges.length === 0), JSON.stringify(l2.lines.flatMap((l) => l.badges)));
}

console.log('\n[MusicXML 转译 · 鼓声部（unpitched → X / forward → 休止）]');
{
  // 鼓谱三大来源：unpitched 音符、<forward> 时间推进、同拍多面鼓（和弦）
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Drums</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>6</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign></clef></attributes>
      <note><unpitched><display-step>E</display-step><display-octave>4</display-octave></unpitched><duration>6</duration><voice>1</voice><type>quarter</type></note>
      <note><chord/><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>6</duration><voice>1</voice><type>quarter</type></note>
      <forward><duration>6</duration><voice>1</voice></forward>
      <note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>12</duration><voice>1</voice><type>half</type></note>
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
    <measure number="2">
      <note><unpitched><display-step>E</display-step><display-octave>4</display-octave></unpitched><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="start" number="1"/></notations></note>
      <note><unpitched><display-step>E</display-step><display-octave>4</display-octave></unpitched><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
      <note><unpitched><display-step>E</display-step><display-octave>4</display-octave></unpitched><duration>2</duration><voice>1</voice><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification><notations><tuplet type="stop" number="1"/></notations></note>
      <note><rest/><duration>18</duration><voice>1</voice><type>half</type><dot/></note>
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
  </part>
</score-partwise>`;
  const { dsl, warnings, errors } = musicXmlToJps(xml, ['P1']);
  check('转换无错', errors.length === 0, errors.join('/'));
  check('unpitched → X 无音高音符（含 forward 休止）', dsl.includes('X 0 X-'), dsl);
  const drumFirst = musicXmlToJps(xml, ['P1'], { melody: 'first' });
  check('同拍多面鼓只留一个（first 策略和弦告警）', drumFirst.warnings.some((w) => w.includes('和弦只保留了一个音')), drumFirst.warnings.join('/'));
  check('不再报「打击乐已跳过」', !warnings.some((w) => w.includes('unpitched，已跳过')), warnings.join('/'));
  check('鼓的连音 → 拍内组 X/3', dsl.includes('<3: X/3 X/3 X/3>'), dsl);
  const errs = parseErrorsOf(dsl);
  check('产物可被 DSL 解析', errs.length === 0, errs.join('/'));
  check('无相邻双小节线', noAdjacentBarlines(dsl));
  const layout = layoutScore(parseDsl(dsl).score!, { contentWidth: 1400 });
  check('拍数满（休止不再缺拍）', layout.lines.every((l) => l.badges.length === 0), JSON.stringify(layout.lines.flatMap((l) => l.badges)));
  check('round-trip 稳定', serializeDsl(parseDsl(dsl).score!) === serializeDsl(parseDsl(serializeDsl(parseDsl(dsl).score!)).score!));
}

console.log('\n[MusicXML 转译 · 主旋律提取（天空线）]');
{
  // 三个小节：①旋律在第二层（伴奏全在下面）②旋律长音被伴奏高音打断 → 延音线接回
  // ③只有一拍有声、其余静默 → 补休止。伴奏用 backup + voice 2 书写。
  const note = (step: string, oct: number, dur: number, voice: number, type: string): string =>
    `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>${voice}</voice><type>${type}</type></note>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      ${note('C', 4, 2, 1, 'quarter')}${note('E', 4, 2, 1, 'quarter')}${note('G', 4, 2, 1, 'quarter')}${note('E', 4, 2, 1, 'quarter')}
      <backup><duration>8</duration></backup>
      ${note('A', 4, 4, 2, 'half')}${note('B', 4, 4, 2, 'half')}
    </measure>
    <measure number="2">
      ${note('C', 4, 2, 1, 'quarter')}${note('B', 4, 2, 1, 'quarter')}${note('C', 4, 2, 1, 'quarter')}${note('C', 4, 2, 1, 'quarter')}
      <backup><duration>8</duration></backup>
      ${note('G', 4, 8, 2, 'whole')}
    </measure>
    <measure number="3">
      ${note('C', 4, 2, 1, 'quarter')}
      <note><rest/><duration>6</duration><voice>1</voice><type>half</type><dot/></note>
    </measure>
    <measure number="4">
      <note><rest/><duration>5</duration><voice>1</voice><type>quarter</type></note>
      ${note('C', 4, 3, 1, 'half')}
    </measure>
  </part>
</score-partwise>`;
  const { dsl, warnings, errors } = musicXmlToJps(xml, ['P1']);
  check('转换无错', errors.length === 0, errors.join('/'));
  check('旋律在第二层 → 取第二层（6- 7-）', dsl.includes('6- 7-'), dsl);
  check('长音被更高音打断 → 分段重击（5 7 5-，延音线只连同音高）', dsl.includes('5 7 5-'), dsl);
  check('静默片段补休止（1 0--）', dsl.includes('1 0--'), dsl);
  // 2.5 拍静默 = 增时线+附点混合时值：必须写成附点二分休止 0.-，
  // 只搜纯整拍/纯细分会被 nearestSuffix 向上近似成 0--（3 拍），小节超拍 4.5/4 ✗
  check('2.5 拍静默 → 附点二分休止 0.-（增时线+附点混合时值）', dsl.includes('0.-'), dsl);
  check('durationSuffix 混合时值：5/2 → .-', durationSuffix({ n: 5, d: 2 }) === '.-', String(durationSuffix({ n: 5, d: 2 })));
  check('有天空线告警', warnings.some((w) => w.includes('天空线')), warnings.join('/'));
  const errs = parseErrorsOf(dsl);
  check('产物可被 DSL 解析', errs.length === 0, errs.join('/'));
  check('无相邻双小节线', noAdjacentBarlines(dsl));
  const layout = layoutScore(parseDsl(dsl).score!, { contentWidth: 1400 });
  check('拍数全部正确', layout.lines.every((l) => l.badges.length === 0), JSON.stringify(layout.lines.flatMap((l) => l.badges)));
  const score = parseDsl(dsl).score!;
  check('round-trip 稳定', serializeDsl(score) === serializeDsl(parseDsl(serializeDsl(score)).score!));
  // 同一份谱用「只转第一层」→ 只剩伴奏
  const r2 = musicXmlToJps(xml, ['P1'], { melody: 'first' });
  check('first 策略只取第一层（1 3 5 3）', r2.dsl.includes('1 3 5 3'), r2.dsl);
  check('first 策略有「只转第一层」告警', r2.warnings.some((w) => w.includes('只转换了第一层')), r2.warnings.join('/'));
  check('first 策略产物可解析', parseErrorsOf(r2.dsl).length === 0, parseErrorsOf(r2.dsl).join('/'));
}

console.log('\n[MusicXML 转译 · 符干方向识别主旋律]');
{
  // 两声部钢琴谱惯例：主旋律符干朝上（voice 1）、伴奏符干朝下。
  // 故意把伴奏层写在文档前面：主声部判定若只看「最先出现的层」会抓错，
  // 显式 <stem> 启发（朝上明显占优的那层）应把主旋律纠正回 voice 1。
  const note = (step: string, oct: number, dur: number, voice: number, stem: string): string =>
    `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>${voice}</voice><stem>${stem}</stem><type>quarter</type></note>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      ${note('C', 4, 2, 2, 'down')}${note('E', 4, 2, 2, 'down')}${note('G', 4, 2, 2, 'down')}${note('E', 4, 2, 2, 'down')}
      <backup><duration>8</duration></backup>
      ${note('G', 4, 2, 1, 'up')}${note('A', 4, 2, 1, 'up')}${note('B', 4, 2, 1, 'up')}${note('C', 5, 2, 1, 'up')}
    </measure>
  </part>
</score-partwise>`;
  const r1 = musicXmlToJps(xml, ['P1'], { melody: 'first' });
  check('符干启发：first 策略抓到主旋律层（5 6 7 1^），不是先出现的伴奏', r1.dsl.includes('5 6 7 1^'), r1.dsl);
  check('符干启发：主旋律层判定有告警', r1.warnings.some((w) => w.includes('按符干方向')), r1.warnings.join('/'));
  check('符干启发：first 产物可解析', parseErrorsOf(r1.dsl).length === 0, parseErrorsOf(r1.dsl).join('/'));
  const rt = musicXmlToJps(xml, ['P1']);
  check('符干启发：天空线取最高音不变（旋律本来就更高）', rt.dsl.includes('5 6 7 1^'), rt.dsl);
  const errs = parseErrorsOf(rt.dsl);
  check('符干启发：天空线产物可解析', errs.length === 0, errs.join('/'));
  const layout = layoutScore(parseDsl(rt.dsl).score!, { contentWidth: 1400 });
  check('符干启发：拍数满', layout.lines.every((l) => l.badges.length === 0), JSON.stringify(layout.lines.flatMap((l) => l.badges)));
  // 单声部谱的符干方向是按音高几何自动算的（上下交替），与主旋律无关——
  // 启发必须不触发（无告警），转换结果与不写符干完全一致
  const single = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      ${note('C', 5, 2, 1, 'down')}${note('A', 4, 2, 1, 'up')}${note('B', 4, 2, 1, 'up')}${note('C', 5, 2, 1, 'down')}
    </measure>
  </part>
</score-partwise>`;
  const rs = musicXmlToJps(single, ['P1'], { melody: 'first' });
  check('单声部谱：符干启发不触发（无告警）', !rs.warnings.some((w) => w.includes('按符干方向')), rs.warnings.join('/'));
  check('单声部谱：转换结果正常', rs.dsl.includes('1^ 6 7 1^'), rs.dsl);
}

console.log('\n[MusicXML 转译 · 钢琴高低音谱表合并（天空线）]');
{
  // 钢琴谱：一个 <part> 两根谱表（<staves>2），高音谱表 voice 1、低音谱表 voice 5。
  // 主旋律小节 1 在高音谱表，小节 2 沉到低音谱表（左手越手弹旋律）——
  // 天空线把**全部声部层**（跨谱表）放到同一时间轴取最高音，旋律走到哪都抓得到。
  // <staff> 元素本身不参与判定（声部层才是结构），只作为 XML 合法性出现在样例里。
  const note = (step: string, oct: number, dur: number, voice: number, stem: string, staff: number): string =>
    `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>${dur}</duration><voice>${voice}</voice><stem>${stem}</stem><staff>${staff}</staff><type>quarter</type></note>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>
      ${note('G', 4, 2, 1, 'up', 1)}${note('A', 4, 2, 1, 'up', 1)}${note('B', 4, 2, 1, 'up', 1)}${note('C', 5, 2, 1, 'up', 1)}
      <backup><duration>8</duration></backup>
      ${note('C', 3, 2, 5, 'down', 2)}${note('E', 3, 2, 5, 'down', 2)}${note('G', 3, 2, 5, 'down', 2)}${note('E', 3, 2, 5, 'down', 2)}
    </measure>
    <measure number="2">
      ${note('E', 4, 2, 1, 'up', 2)}${note('D', 4, 2, 1, 'up', 2)}${note('C', 4, 2, 1, 'up', 2)}${note('D', 4, 2, 1, 'up', 2)}
      <backup><duration>8</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><voice>5</voice><stem>down</stem><staff>2</staff><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
  const { dsl, warnings, errors } = musicXmlToJps(xml, ['P1']);
  check('转换无错', errors.length === 0, errors.join('/'));
  check('小节 1：高音谱表旋律被抓到（5 6 7 1^）', dsl.includes('5 6 7 1^'), dsl);
  check('小节 2：旋律沉到低音谱表仍被抓到（3 2 1 2），低音只留持续长音以下的部分', dsl.includes('3 2 1 2'), dsl);
  check('跨谱表同层：first 策略按声部层抓（两个谱表的 voice 1 都是主旋律）', musicXmlToJps(xml, ['P1'], { melody: 'first' }).dsl.includes('3 2 1 2'), '');
  check('符干启发把主声部定在 voice 1（两个谱表合并后朝上占优）', warnings.some((w) => w.includes('按符干方向')), warnings.join('/'));
  const errs = parseErrorsOf(dsl);
  check('产物可被 DSL 解析', errs.length === 0, errs.join('/'));
  const layout = layoutScore(parseDsl(dsl).score!, { contentWidth: 1400 });
  check('拍数全部正确', layout.lines.every((l) => l.badges.length === 0), JSON.stringify(layout.lines.flatMap((l) => l.badges)));
  const score = parseDsl(dsl).score!;
  check('round-trip 稳定', serializeDsl(score) === serializeDsl(parseDsl(serializeDsl(score)).score!));
}

console.log('\n[MusicXML 转译 · 调号与首调转换]');
{
  // 首调唱名：音名字母相对调主音的位置（1=F 时 F→1、Bb→4），调内音零变音记号；
  // 八度点按绝对音高反解，保证按 @key 播放时音高与 XML 完全一致
  const note = (step: string, oct: number, alter: number | null, dur = 2): string =>
    `<note><pitch><step>${step}</step>${alter !== null ? `<alter>${alter}</alter>` : ''}<octave>${oct}</octave></pitch><duration>${dur}</duration><voice>1</voice><type>quarter</type></note>`;
  const attrs = (fifths: number): string =>
    `<attributes><divisions>2</divisions><key><fifths>${fifths}</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;
  const head = '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list><part id="P1">';
  const tail = '</part></score-partwise>';

  // F 大调：F G A Bb C → 1 2 3 4 5，零变音记号；B 自然音 → #4
  const rF = musicXmlToJps(
    `${head}<measure number="1">${attrs(-1)}${note('F', 4, null)}${note('G', 4, null)}${note('A', 4, null)}${note('B', 4, -1)}${note('C', 5, null)}${note('B', 4, 0)}</measure>${tail}`,
    ['P1'],
  );
  check('F 调首调：F G A Bb C → 1 2 3 4（无变音）', rF.dsl.includes('1 2 3 4'), rF.dsl);
  check('F 调首调：C5 → 5（中音组不带点）', rF.dsl.includes(' 5 '), rF.dsl);
  check('F 调首调：B 自然音 → #4', rF.dsl.includes('#4'), rF.dsl);
  check('F 调首调：@key 1=F', rF.dsl.includes('@key 1=F'), rF.dsl);
  const eF = parseErrorsOf(rF.dsl);
  check('F 调产物可解析', eF.length === 0, eF.join('/'));

  // G 大调：中音 1 = G3（WindScore 语义），G4 起的旋律带高音点
  const rG = musicXmlToJps(
    `${head}<measure number="1">${attrs(1)}${note('G', 4, null)}${note('A', 4, null)}${note('B', 4, null)}${note('D', 5, null)}</measure>${tail}`,
    ['P1'],
  );
  check('G 调首调：G4 A4 B4 D5 → 1^ 2^ 3^ 5^', rG.dsl.includes('1^ 2^ 3^ 5^'), rG.dsl);
  check('G 调首调：@key 1=G，调内音无变音', rG.dsl.includes('@key 1=G') && !rG.dsl.includes('#'), rG.dsl);

  // 调号缺失（fifths=0）但内容是 D 大调（D F# A C# B）→ 自动判为 1=D，零变音
  const rD = musicXmlToJps(
    `${head}<measure number="1">${attrs(0)}${note('D', 4, null)}${note('F', 4, 1)}${note('A', 4, null)}${note('C', 5, 1)}${note('B', 4, null)}</measure>${tail}`,
    ['P1'],
  );
  check('调号推断：fifths=0 的 D 大调内容判为 1=D', rD.dsl.includes('@key 1=D'), rD.dsl);
  check('调号推断：D F# A C# B → 1 3 5 7 6（无 #1/#4）', rD.dsl.includes('1 3 5 7 6'), rD.dsl);
  check('调号推断：改判有告警', rD.warnings.some((w) => w.includes('音高内容明显属于')), rD.warnings.join('/'));
  const eD = parseErrorsOf(rD.dsl);
  check('推断产物可解析', eD.length === 0, eD.join('/'));

  // 真 C 大调内容不误判（声部声明优先）
  const rC = musicXmlToJps(
    `${head}<measure number="1">${attrs(0)}${note('C', 4, null)}${note('E', 4, null)}${note('G', 4, null)}${note('C', 5, null)}</measure>${tail}`,
    ['P1'],
  );
  check('真 C 大调：维持 1=C、无误判告警', rC.dsl.includes('@key 1=C') && !rC.warnings.some((w) => w.includes('音高内容明显属于')), rC.warnings.join('/') + rC.dsl);
}

console.log('\n[MusicXML 转译 · 乐器音色自动配置]');
{
  // 转换时按声部乐器名自动配音色：midi-program 优先，其次名称模糊匹配
  // （「Grand Piano / 原声钢琴 / 钢琴右手」都算钢琴），都不行退长笛 73
  const note = '<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>';
  const attrs = '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>';
  const single = (name: string, program: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>${name}</part-name>${program}</score-part></part-list><part id="P1"><measure number="1">${attrs}${note}</measure></part></score-partwise>`;
  const at = (dsl: string): string => dsl.split('\n').find((l) => l.startsWith('@patch'))?.trim() ?? '(无)';
  check('Grand Piano → 0', at(musicXmlToJps(single('Grand Piano', ''), ['P1']).dsl) === '@patch 0', at(musicXmlToJps(single('Grand Piano', ''), ['P1']).dsl));
  check('原声钢琴 → 0', at(musicXmlToJps(single('原声钢琴 · 合并声部', ''), ['P1']).dsl) === '@patch 0', '');
  check('小提琴 → 40', at(musicXmlToJps(single('小提琴', ''), ['P1']).dsl) === '@patch 40', '');
  check('Electric Bass → 33', at(musicXmlToJps(single('Electric Bass', ''), ['P1']).dsl) === '@patch 33', '');
  check('Bassoon → 70（不被 bass 子串误配）', at(musicXmlToJps(single('Bassoon', ''), ['P1']).dsl) === '@patch 70', '');
  check('Bass Drum → 0（drum 优先于 bass）', at(musicXmlToJps(single('Bass Drum', ''), ['P1']).dsl) === '@patch 0', '');
  check('midi-program 41 → 40（1 基转 0 基，覆盖名称匹配）', at(musicXmlToJps(single('长笛', '<midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>41</midi-program></midi-instrument>'), ['P1']).dsl) === '@patch 40', '');
  check('无法识别的名称退长笛 73', at(musicXmlToJps(single('未知乐器', ''), ['P1']).dsl) === '@patch 73', '');

  // 多声部：每条 @part 各配各的音色
  const two = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">
<part-list><score-part id="P1"><part-name>Grand Piano</part-name></score-part><score-part id="P2"><part-name>小提琴</part-name></score-part></part-list>
<part id="P1"><measure number="1">${attrs}${note}</measure></part>
<part id="P2"><measure number="1">${attrs}${note.replace('<octave>4</octave>', '<octave>5</octave>')}</measure></part>
</score-partwise>`;
  const rm = musicXmlToJps(two, ['P1', 'P2']);
  check('多声部：P1 配 0、P2 配 40（声部级 @patch）', /@part 1 "Grand Piano"\n@patch 0/.test(rm.dsl) && /@part 2 "小提琴"\n@patch 40/.test(rm.dsl), rm.dsl);
  const eM = parseErrorsOf(rm.dsl);
  check('多声部产物可解析', eM.length === 0, eM.join('/'));
}

console.log('\n[MusicXML 转译 · 守卫]');
{
  check('空选择被拒', musicXmlToJps(SAMPLE1, []).errors.some((e) => e.includes('至少')));
  check('不存在的声部被拒', musicXmlToJps(SAMPLE1, ['P9']).errors.length > 0);
  const bad = musicXmlToJps('<不是谱>', ['P1']);
  check('非 MusicXML 输入报错不抛', bad.errors.length > 0 && bad.dsl === '');
}

console.log('\n[MusicXML 转译 · .mxl 解包]');
{
  // 手工构造 zip：store + deflate 两个条目，container.xml 指定 rootfile
  const enc = new TextEncoder();
  const chunks: number[] = [];
  const locals: { off: number; name: string; method: number; size: number }[] = [];
  const pushLocal = (name: string, method: number, data: Uint8Array): void => {
    const nameBytes = enc.encode(name);
    const off = chunks.length;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(8, method, true);
    head.setUint32(18, data.length, true);
    head.setUint16(26, nameBytes.length, true);
    chunks.push(...new Uint8Array(head.buffer), ...nameBytes, ...data);
    locals.push({ off, name, method, size: data.length });
  };
  const container = `<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>`;
  pushLocal('META-INF/container.xml', 0, enc.encode(container));
  const scoreData = deflateRawSync(enc.encode(SAMPLE1));
  pushLocal('score.xml', 8, scoreData);
  // 中央目录 + EOCD
  const cdStart = chunks.length;
  for (const l of locals) {
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(10, l.method, true);
    head.setUint32(20, l.size, true);
    head.setUint32(24, l.size, true);
    head.setUint16(28, l.name.length, true);
    head.setUint32(42, l.off, true);
    chunks.push(...new Uint8Array(head.buffer), ...enc.encode(l.name));
  }
  const cdSize = chunks.length - cdStart;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, locals.length, true);
  eocd.setUint16(10, locals.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  chunks.push(...new Uint8Array(eocd.buffer));
  const xml = await unzipMusicXml(new Uint8Array(chunks));
  check('解包得到主 XML（rootfile 指定）', xml.includes('score-partwise'));
  const { dsl, errors } = musicXmlToJps(xml, ['P1']);
  check('解包后可转换', errors.length === 0 && dsl.includes('@title 测试曲'), errors.join('/'));
}

console.log('\n[MusicXML 转译 · X 无音高音符的现代省写 round-trip]');
{
  // normalizeModern 的省写展开正则曾漏掉 X/x：format-3 谱里八分 X 序列化成 X/，
  // 复解析展开不回来 → 「无法解析的记号：X/」（多声部导入打击乐声部必踩）
  const dsl = '@format 3\n@title t\n@part 1 "A"\nX/ 3 |\n@part 2 "B"\n5/2 3 |\n';
  const p = parseDsl(dsl);
  check('样例可解析', !!p.score, p.errors.join('/'));
  const again = p.score ? parseDsl(serializeDsl(p.score)) : { score: null, errors: ['样例未解析'] };
  check('X/ 省写序列化后可复解析', !!again.score && again.errors.length === 0, again.errors.join('/'));
}

console.log(`\n${bad === 0 ? 'MUSICXML PASS' : `MUSICXML FAIL (${bad})`}`);
process.exitCode = bad === 0 ? 0 : 1;
