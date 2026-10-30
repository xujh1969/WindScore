/**
 * 节拍器自测：拍号强弱、拍内细分排程、click 采样。
 * 纯 node，秒级。
 */
import {
  clickSample,
  constantMeter,
  meterBeats,
  METRONOME_PATTERNS,
  Metronome,
  metronomeAvailable,
  meterSegmentsOf,
  patternFor,
  scheduleHits,
} from '../src/v2/metronome';
import { TICKS_PER_BEAT } from '../src/v2/ticks';
import { mixMetronome, peakOf } from '../src/v2/export/mix';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok  ${name}`);
  else {
    console.log(`  XX  ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

console.log('[节拍器 · 拍号]');
check('4/4 → 4 拍、每 4 拍强拍', (() => {
  const m = meterBeats('4/4');
  return m.beatsPerBar === 4 && m.strongEvery === 4;
})());
check('3/4 → 3 拍', meterBeats('3/4').beatsPerBar === 3);
check('6/8 → 3 拍（复合拍）', meterBeats('6/8').beatsPerBar === 3);
check('2/4 → 2 拍', meterBeats('2/4').beatsPerBar === 2);
check('乱写拍号退回 4/4', meterBeats('xx').beatsPerBar === 4);

console.log('\n[节拍器 · 拍号段（含中途换拍与弱起）]');
{
  // 事件模型：note 占一拍（6720 tick），barline 不占时值
  const note = (id: string, beats = 1): { kind: string; id: string; ticks: number } => ({
    kind: 'note', id, ticks: beats * 6720,
  });
  const barline = (id: string, beatAfter?: string): { kind: string; id: string; beatAfter?: string } => ({
    kind: 'barline', id, ...(beatAfter ? { beatAfter } : {}),
  });

  // 2/4 两小节 + 换 3/4 两小节：note ×2 | note ×2 |(拍3/4) note ×3 | note ×3 |
  const events = [
    note('a1'), note('a2'), barline('b1'),
    note('a3'), note('a4'), barline('b2', '3/4'),
    note('c1'), note('c2'), note('c3'), barline('b3'),
    note('c4'), note('c5'), note('c6'), barline('b4'),
  ];
  const meterAt = meterSegmentsOf(events, '2/4');
  const hits = scheduleHits({
    fromSec: 0, toSec: 10,
    beatToSec: (b) => b, // 60 BPM：一拍一秒，好换算
    meterAt,
    pattern: patternFor('quarter'),
  });
  const accents = hits.filter((h) => h.accent).map((h) => h.timeSec);
  // 2/4 段：0、2 重音；换 3/4 后：4、7 重音（第 4 秒正好是换拍小节头）
  check('2/4 段每 2 拍一个重音', JSON.stringify(accents.slice(0, 2)) === '[0,2]', JSON.stringify(accents));
  check('换 3/4 后从换拍小节线起每 3 拍一个重音',
    accents.slice(2).join(',') === '4,7', accents.slice(2).join(','));
  check('拍子总数对（2+2+3+3 = 10 拍）', hits.length === 10, String(hits.length));

  // 弱起：0.5 拍不完全小节 → 小节线落在两拍中间（0.5、2.5、4.5），
  // 重音给每个小节里**第一个响的拍**（1、3）——强弱循环仍与小节一一对应
  const pickup = [
    note('p1', 0.5), barline('b0'),
    note('a1'), note('a2'), barline('b1'),
    note('a3'), note('a4'), barline('b2'),
  ];
  const mAt = meterSegmentsOf(pickup, '2/4');
  const phits = scheduleHits({
    fromSec: 0, toSec: 5,
    beatToSec: (b) => b,
    meterAt: mAt,
    pattern: patternFor('quarter'),
  });
  const pAccents = phits.filter((h) => h.accent).map((h) => h.timeSec);
  check('弱起的半拍不算小节头（无重音）', !pAccents.includes(0), JSON.stringify(pAccents));
  check('重音落在每个完整小节的第一个响拍（1、3）',
    pAccents.join(',') === '1,3', pAccents.join(','));

  // 3/8：一小节 1.5 个四分拍（非整数拍），重音给每个小节的第一个响拍（0、2）
  const m38 = meterSegmentsOf([note('x1'), note('x2'), note('x3')], '3/8');
  const h38 = scheduleHits({
    fromSec: 0, toSec: 3,
    beatToSec: (b) => b,
    meterAt: m38,
    pattern: patternFor('quarter'),
  });
  const a38 = h38.filter((h) => h.accent).map((h) => h.timeSec);
  check('3/8 重音给每个小节的第一个响拍（0、2）', a38.join(',') === '0,2', a38.join(','));
}

console.log('\n[节拍器 · 复拍子次强拍（GB/T 46845—2025 §6.3.13）]');
{
  const note = (id: string, beats = 1): { kind: string; id: string; ticks: number } => ({
    kind: 'note', id, ticks: beats * 6720,
  });
  const barline = (id: string): { kind: string; id: string } => ({ kind: 'barline', id });

  // 6/8 两小节，八分节奏型（每拍两下）：强弱序列 = 强弱弱 次强弱弱 | 强弱弱 次强弱弱
  // （次强拍落在附点四分大拍上 = 拍内 +半拍的细分点，quarter 节奏型打不到它）
  const ev68 = [note('a1'), note('a2'), note('a3'), barline('b1'), note('a4'), note('a5'), note('a6'), barline('b2')];
  const h68 = scheduleHits({
    fromSec: 0, toSec: 7,
    beatToSec: (b) => b,
    meterAt: meterSegmentsOf(ev68, '6/8'),
    pattern: patternFor('eighth'),
  });
  const lv68 = h68.map((h) => h.level ?? (h.accent ? 'strong' : 'weak')).join(',');
  check(
    '6/8 八分型 = 强弱弱次强弱弱循环',
    lv68 === 'strong,weak,weak,medium,weak,weak,strong,weak,weak,medium,weak,weak,strong,weak',
    lv68,
  );
  // 四分节奏型只打整拍：大拍边界（+1.5 拍）上没有击打点，不出现次强
  const h68q = scheduleHits({
    fromSec: 0, toSec: 7,
    beatToSec: (b) => b,
    meterAt: meterSegmentsOf(ev68, '6/8'),
    pattern: patternFor('quarter'),
  });
  check(
    '6/8 四分型只有强弱两档',
    h68q.every((h) => (h.level ?? (h.accent ? 'strong' : 'weak')) !== 'medium'),
    h68q.map((h) => h.level).join(','),
  );
  // 12/8：四个大拍 = 强 + 三个次强（1.5、3、4.5 拍处）
  const ev128 = Array.from({ length: 6 }, (_, i) => note(`t${i}`));
  const h128 = scheduleHits({
    fromSec: 0, toSec: 6.2,
    beatToSec: (b) => b,
    meterAt: meterSegmentsOf(ev128, '12/8'),
    pattern: patternFor('eighth'),
  });
  const med128 = h128.filter((h) => h.level === 'medium').map((h) => h.timeSec);
  check('12/8 次强在 1.5 / 3 / 4.5 拍', med128.join(',') === '1.5,3,4.5', med128.join(','));
  // 3/8 只有一个大拍：没有次强
  const ev38 = [note('s1'), note('s2'), note('s3')];
  const h38m = scheduleHits({
    fromSec: 0, toSec: 2,
    beatToSec: (b) => b,
    meterAt: meterSegmentsOf(ev38, '3/8'),
    pattern: patternFor('eighth'),
  });
  check('3/8 无次强拍', h38m.every((h) => h.level !== 'medium'), h38m.map((h) => h.level).join(','));
}

console.log('\n[节拍器 · 排程]');
{
  const beatToSec = (b: number): number => b * 0.5;
  const hits = scheduleHits({
    fromSec: 0,
    toSec: 4,
    beatToSec,
    meterAt: constantMeter(4),
    pattern: patternFor('quarter'),
  });
  check('四分：4 秒 = 8 拍 = 8 下', hits.length === 8, `实际 ${hits.length}`);
  check('强音在小节首拍（第 0、4 拍）', hits.filter((h) => h.accent).length === 2);
  check('第一击在 0 秒', Math.abs(hits[0]!.timeSec) < 1e-9);
  check('第二击在 0.5 秒', Math.abs(hits[1]!.timeSec - 0.5) < 1e-9);
}
{
  const hits = scheduleHits({
    fromSec: 0,
    toSec: 2,
    beatToSec: (b) => b * 0.5,
    meterAt: constantMeter(4),
    pattern: patternFor('eighth'),
  });
  check('八分：2 秒 = 4 拍 = 8 下', hits.length === 8, `实际 ${hits.length}`);
  check('拍内第二下在 +0.25 秒', Math.abs(hits[1]!.timeSec - 0.25) < 1e-9);
}
{
  const hits = scheduleHits({
    fromSec: 0,
    toSec: 2,
    beatToSec: (b) => b * 0.5,
    meterAt: constantMeter(4),
    pattern: patternFor('triplet'),
  });
  check('三连音：2 秒 = 4 拍 = 12 下', hits.length === 12, `实际 ${hits.length}`);
  check('三连音等分在 1/6、1/3 处', Math.abs(hits[1]!.timeSec - 0.5 / 3) < 1e-9);
}
{
  // 变速：拍长不等，细分按比例缩放
  const beatToSec = (b: number): number => (b < 2 ? b * 0.5 : 1 + (b - 2) * 0.25);
  const hits = scheduleHits({
    fromSec: 0,
    toSec: 3,
    beatToSec,
    meterAt: constantMeter(4),
    pattern: patternFor('eighth'),
  });
  const third = hits.find((h) => h.timeSec > 1.0)!;
  check(
    '变速后细分跟着变速（第三拍内的第二下在 1.125 秒）',
    Math.abs(third.timeSec - 1.125) < 1e-9,
    String(third.timeSec),
  );
}
{
  const hits = scheduleHits({
    fromSec: 1,
    toSec: 1.2,
    beatToSec: (b) => b * 0.5,
    meterAt: constantMeter(4),
    pattern: patternFor('quarter'),
  });
  check(
    '只排区间内的击打点',
    hits.length === 1 && Math.abs(hits[0]!.timeSec - 1) < 1e-9,
    `实际 ${hits.length}`,
  );
}

console.log('\n[节拍器 · 隔拍节奏型]');
{
  // BPM 高时「每拍一下」太乱：每 2 拍一下（4/4 打 1、3 拍）、每小节一下。
  // stride 相对**小节锚**对齐，不是绝对拍对齐——换拍/弱起也要跟着小节走
  const hits2 = scheduleHits({
    fromSec: 0,
    toSec: 8,
    beatToSec: (b) => b, // 60 BPM：一拍一秒
    meterAt: constantMeter(4),
    pattern: patternFor('half'),
  });
  const t2 = hits2.map((h) => h.timeSec).join(',');
  check('每 2 拍一下：8 秒内打 0、2、4、6 秒', t2 === '0,2,4,6', t2);
  check('重音只落在小节首拍（0、4 秒）',
    hits2.filter((h) => h.accent).map((h) => h.timeSec).join(',') === '0,4',
    hits2.filter((h) => h.accent).map((h) => h.timeSec).join(','));

  const hitsBar = scheduleHits({
    fromSec: 0,
    toSec: 8,
    beatToSec: (b) => b,
    meterAt: constantMeter(4),
    pattern: patternFor('bar'),
  });
  check('每小节一下：只打 0、4 秒',
    hitsBar.map((h) => h.timeSec).join(',') === '0,4',
    hitsBar.map((h) => h.timeSec).join(','));
  check('每小节一下全是重音', hitsBar.every((h) => h.accent));

  // 换拍对齐：2/4 两小节 + 3/4 一小节。stride 2 应跟着**各自小节的锚**走：
  // 2/4 段打拍 0、2（1、1），3/4 段打拍 4、6？——不对，锚在 4：inBar=0、1、2，
  // 只有 0 对齐 → 3/4 段只打第 1 拍（拍 4）
  const events = [
    { kind: 'note', ticks: 6720 }, { kind: 'note', ticks: 6720 }, { kind: 'barline' },
    { kind: 'note', ticks: 6720 }, { kind: 'note', ticks: 6720 }, { kind: 'barline' },
    { kind: 'note', ticks: 6720 }, { kind: 'note', ticks: 6720 }, { kind: 'note', ticks: 6720 }, { kind: 'barline' },
  ];
  const mAt = meterSegmentsOf(events, '2/4');
  const hitsX = scheduleHits({
    fromSec: 0,
    toSec: 7,
    beatToSec: (b) => b,
    meterAt: mAt,
    pattern: patternFor('half'),
  });
  check('换拍后每小节从重音拍数起（2/4 段打 2、锚前不打；3/4 段打 4、6）',
    hitsX.map((h) => h.timeSec).join(',') === '2,4,6',
    hitsX.map((h) => h.timeSec).join(','));

  // 弱起：0.5 拍不完全小节，锚在 0.5。stride 2 在弱起里对不齐就不打，
  // 第一个完整小节锚（0.5）起每 2 拍一下：0.5、2.5、4.5
  const pickup = [
    { kind: 'note', ticks: 3360 }, { kind: 'barline' },
    { kind: 'note', ticks: 6720 }, { kind: 'note', ticks: 6720 }, { kind: 'barline' },
    { kind: 'note', ticks: 6720 }, { kind: 'note', ticks: 6720 }, { kind: 'barline' },
  ];
  const pAt = meterSegmentsOf(pickup, '2/4');
  const hitsP = scheduleHits({
    fromSec: 0,
    toSec: 5,
    beatToSec: (b) => b,
    meterAt: pAt,
    pattern: patternFor('half'),
  });
  check('弱起曲 stride 对齐每个小节的首响拍（1、3，弱起拍不打）',
    hitsP.map((h) => h.timeSec).join(',') === '1,3',
    hitsP.map((h) => h.timeSec).join(','));
}

console.log('\n[节拍器 · 绝对拍对齐]');
{
  // 从第 8 拍开始（第 8 拍是 4/4 的小节首拍）→ 重音必须落在它身上
  const hits = scheduleHits({
    fromSec: 0,
    toSec: 2,
    beatToSec: (b) => (b - 8) * 0.5,
    meterAt: constantMeter(4),
    pattern: patternFor('quarter'),
    startBeat: 8,
  });
  check('startBeat 之前的拍不排', hits.length === 4, `实际 ${hits.length}`);
  check('第一击落在第 8 拍（0 秒）', Math.abs(hits[0]!.timeSec) < 1e-9, String(hits[0]?.timeSec));
  check('第 8 拍是重音（4/4 的小节首拍）', hits[0]!.accent === true);
  check('第 9 拍不是重音', hits[1]!.accent === false);
}
{
  // 伴奏模式常见：谱面第 0 拍对应音频第 36 拍。拍号强弱按**谱面拍**算
  const hits = scheduleHits({
    fromSec: 0,
    toSec: 1.25,
    beatToSec: (b) => b * 0.25,
    meterAt: constantMeter(4),
    pattern: patternFor('quarter'),
    startBeat: 0,
  });
  check('谱面第 0 拍就是小节首拍（重音）', hits[0]!.accent === true);
  check('第 4 拍又是小节首拍（重音）', hits[4]!.accent === true);
  check('其余拍不重音', hits.filter((h) => h.accent).length === 2);
}

console.log('\n[节拍器 · 导出叠加]');
{
  const mix = {
    channels: [new Float32Array(44100), new Float32Array(44100)],
    sampleRate: 44100,
    length: 44100,
    durationSec: 1,
  };
  const hits = scheduleHits({
    fromSec: 0,
    toSec: 1,
    beatToSec: (b) => b * 0.5,
    meterAt: constantMeter(4),
    pattern: patternFor('quarter'),
  });
  mixMetronome({ mix, hits, volume: 1 });
  const peak = peakOf(mix);
  check('click 混进了缓冲区（不是全 0）', peak > 0.1, `峰值 ${peak}`);
  check('只打在拍点上（0.5 秒处有声音）', Math.abs(mix.channels[0]![Math.round(0.5 * 44100)]!) > 0.05);
  check('拍点之外基本是静音', Math.abs(mix.channels[0]![Math.round(0.25 * 44100)]!) < 1e-6);
  check('左右声道一致（单声道 click 复制过去）', mix.channels[0]![100] === mix.channels[1]![100]);
}
{
  const mix = {
    channels: [new Float32Array(44100)],
    sampleRate: 44100,
    length: 44100,
    durationSec: 1,
  };
  const before = peakOf(mix);
  mixMetronome({ mix, hits: [], volume: 1 });
  check('没有击打点时不动混音', peakOf(mix) === before);
}

console.log('\n[节拍器 · 节奏型表]');
check(
  '预设覆盖四分/八分/三连音/十六分',
  ['quarter', 'eighth', 'triplet', 'sixteenth'].every((id) => !!patternFor(id)),
);
check(
  '细分位置都在一拍之内',
  METRONOME_PATTERNS.every((p) => p.offsets.every((o) => o >= 0 && o < TICKS_PER_BEAT)),
);
check('未知 id 退回四分', patternFor('nope').id === 'quarter');

console.log('\n[节拍器 · click 采样]');
{
  const a = clickSample(44100, true);
  const p = clickSample(44100, false);
  check('重音比轻拍响', Math.max(...a) > Math.max(...p));
  check('采样长度合理（几毫秒到几十毫秒）', a.length > 100 && a.length < 44100 * 0.2);
  check('末尾衰减到接近 0', Math.abs(a[a.length - 1]!) < 0.01);
  check('同一参数结果一致（可测）', clickSample(44100, true)[100] === a[100]);
}

console.log('\n[节拍器 · 出现的场景]');
{
  // 规则：只在合成音的播放场景出现
  check('记谱页（简谱剪辑）一直有', metronomeAvailable('score', 'synth') && metronomeAvailable('score', 'audio'));
  check('播放页选合成音时有', metronomeAvailable('play', 'synth'));
  check('播放页选伴奏时没有', !metronomeAvailable('play', 'audio'));
  check('动态谱生成页选合成音时有', metronomeAvailable('align', 'synth'));
  check('动态谱生成页选伴奏时没有', !metronomeAvailable('align', 'audio'));
}

interface FakeCtx {
  state: string;
  currentTime: number;
  sampleRate: number;
  destination: unknown;
  created: number;
  closed: number;
  resumed: number;
  started: number[];
  stops: number[];
  createBuffer(ch: number, len: number, sr: number): { getChannelData(c: number): Float32Array; duration: number };
  createBufferSource(): { buffer: unknown; connect(x: unknown): void; start(t: number): void; stop(): void };
  createGain(): { gain: { value: number }; connect(x: unknown): void };
  resume(): Promise<void>;
  close(): Promise<void>;
}
/** 假上下文的登记表：引擎测试块和拍内细分回归块共用 */
const fakeContexts: FakeCtx[] = [];
{
  // 假 AudioContext：能看出「上下文有没有建起来 / 有没有被挂起 / 有没有被关掉」
  const makeCtx = (): FakeCtx => {
    const ctx: FakeCtx = {
      state: 'running',
      currentTime: 0,
      sampleRate: 48000,
      destination: {},
      created: 0,
      closed: 0,
      resumed: 0,
      started: [],
      stops: [],
      createBuffer(_ch, len, _sr) {
        const data = new Float32Array(len);
        return { getChannelData: () => data, duration: len / _sr };
      },
      createBufferSource() {
        return {
          buffer: null,
          connect() { /* 假图：不用真连 */ },
          start(t: number) { ctx.started.push(t); },
          stop() { ctx.stops.push(ctx.currentTime); },
        };
      },
      createGain() {
        return { gain: { value: 1 }, connect() { /* 假图 */ } };
      },
      resume() { ctx.resumed += 1; ctx.state = 'running'; return Promise.resolve(); },
      close() { ctx.closed += 1; ctx.state = 'closed'; return Promise.resolve(); },
    };
    return ctx;
  };
  class FakeAudioContext {
    constructor() {
      const ctx = makeCtx();
      fakeContexts.push(ctx);
      return ctx as unknown as FakeAudioContext;
    }
  }
  (globalThis as unknown as { window: unknown }).window = {
    AudioContext: FakeAudioContext,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
}

console.log('\n[节拍器 · 引擎与自动播放策略]');
{
  const contexts = fakeContexts;

  const m = new Metronome();
  check('unlock 会建出音频上下文', contexts.length === 0);
  m.unlock();
  check('unlock 后上下文已建好', contexts.length === 1, String(contexts.length));
  check('unlock 后上下文是 running（出声的前提）', contexts[0]!.state === 'running');

  m.start({ beatToSec: (b) => (b * 60) / 120, meterAt: constantMeter(4), pattern: patternFor('quarter'), volume: 0.8 }, 0);
  check('start 不新建上下文（复用已解锁的那个）', contexts.length === 1, String(contexts.length));

  // 手动推进时钟，触发一次排程
  contexts[0]!.currentTime = 1;
  (m as unknown as { pump(): void }).pump();
  check('排程后有 click 被排出去', contexts[0]!.started.length > 0, String(contexts[0]!.started.length));

  m.stop();
  check('stop 不关上下文（否则下次 start 会被自动播放策略挂起）', contexts[0]!.closed === 0);
  check('stop 后不再排 click', (() => {
    const before = contexts[0]!.started.length;
    contexts[0]!.currentTime = 5;
    (m as unknown as { pump(): void }).pump();
    return contexts[0]!.started.length === before;
  })());

  m.dispose();
  check('dispose 才关上下文', contexts[0]!.closed === 1, String(contexts[0]!.closed));

  // 挂起的上下文：pump 会先试着救活，而不是默默排一堆永远不响的 click
  const m2 = new Metronome();
  m2.start({ beatToSec: (b) => (b * 60) / 120, meterAt: constantMeter(4), pattern: patternFor('quarter'), volume: 0.8 }, 0);
  const ctx2 = contexts[contexts.length - 1]!;
  ctx2.state = 'suspended';
  ctx2.started.length = 0;
  const resumedBefore = ctx2.resumed;
  (m2 as unknown as { pump(): void }).pump();
  check(
    '上下文被挂起时先 resume，不排 click',
    ctx2.resumed > resumedBefore && ctx2.started.length === 0,
    `resume ${ctx2.resumed} / click ${ctx2.started.length}`,
  );
  m2.dispose();

  // 挂起态 start：锚点必须等真正 running 才定（0.3.6 修）——
  // 播放中途第一次开节拍器，上下文刚建好时 currentTime 冻结在旧值，
  // 拿它锚定整串 click 相对音乐永久错位（用户实测「曲中开节拍器不同步」）
  const m3 = new Metronome();
  // 让这个块里**新建**的上下文一出生就是挂起态，且 resume 不立刻生效
  // （真浏览器的 resume 是异步的：start() 那一刻 state 还是 suspended，
  // currentTime 冻结在 0 附近）——ensureContext 在 start() 内部创建，只能从构造器拦
  const win = globalThis as unknown as { window: { AudioContext: new () => unknown } };
  const PrevAC = win.window.AudioContext;
  let firstSuspended = true;
  win.window.AudioContext = class {
    constructor() {
      const c = new PrevAC() as unknown as FakeCtx;
      if (firstSuspended) {
        firstSuspended = false;
        c.state = 'suspended';
        c.resume = () => {
          c.resumed += 1;
          return Promise.resolve(); // 故意不改 state：模拟异步 resume 还没回来
        };
      }
      return c;
    }
  } as never;
  m3.start({ beatToSec: (b) => (b * 60) / 120, meterAt: constantMeter(4), pattern: patternFor('quarter'), volume: 0.8 }, 4.4, 0);
  win.window.AudioContext = PrevAC;
  const ctx3b = contexts[contexts.length - 1]!;
  check('挂起态 start 不立刻排 click', ctx3b.started.length === 0, String(ctx3b.started.length));
  (m3 as unknown as { pump(): void }).pump();
  // 上下文「resume 完成」：此刻 currentTime 才可信（墙钟流逝由补锚公式自动扣回）
  ctx3b.state = 'running';
  ctx3b.currentTime = 0.02;
  (m3 as unknown as { pump(): void }).pump();
  // 120BPM：fromBeat 4.4 → 下一个整拍是第 5 拍。锚 = currentTime(0.02) - 墙钟流逝(≈0) = 0.02，
  // 第 5 拍落在 0.02 + (2.5-2.2) = 0.32；挂起期间错过的拍整拍跳过，不补响
  const clicks = ctx3b.started.filter((t) => t >= 0).sort((a, b) => a - b);
  check('running 后补锚：下一整拍落在正确的 ctx 时刻', clicks.length > 0 && Math.abs(clicks[0]! - 0.32) < 0.02, String(clicks[0]));
  m3.dispose();
}

console.log('\n[节拍器 · 速度只认谱面]');
{
  // 引擎里没有 BPM 这个概念：给什么换算就按什么打。
  // 同一段排程，喂 120 BPM 与 60 BPM 两张换算表，同一拍的击打时刻应该正好差一倍。
  const run = (secPerBeat: number): number[] => {
    const hits = scheduleHits({
      fromSec: 0,
      toSec: 5,
      beatToSec: (b) => b * secPerBeat,
      meterAt: constantMeter(4),
      pattern: patternFor('quarter'),
    });
    return hits.map((h) => h.timeSec);
  };
  const fast = run(0.5); // 120 BPM
  const slow = run(1); // 60 BPM
  check('120 BPM：第 4 拍落在 2 秒', Math.abs(fast[4]! - 2) < 1e-9, String(fast[4]));
  check('60 BPM：第 4 拍落在 4 秒', Math.abs(slow[4]! - 4) < 1e-9, String(slow[4]));
  check('速度减半 → 同一拍的时刻正好差一倍', Math.abs(slow[4]! - fast[4]! * 2) < 1e-9);
}

console.log('\n[节拍器 · 拍内细分必须真的排出去]');
{
  // 回归：曾经把拍内第二下按「排程窗口」截掉——窗口 0.3s，90 BPM 一拍 0.67s，
  // 第二下永远在窗口外被丢，所有节奏型听起来都一样。这里用引擎 + 假上下文守住。
  const m = new Metronome();
  m.start({
    beatToSec: (b) => (b * 60) / 90, // 90 BPM
    meterAt: constantMeter(4),
    pattern: patternFor('eighth'),
    volume: 0.8,
  }, 0);
  const ctx = fakeContexts[fakeContexts.length - 1]!;
  ctx.started.length = 0;
  (m as unknown as { pump(): void }).pump();
  // 第一拍（0.08s 起）应该排出两声：正拍 + 半拍，缺一不可
  check('八分节奏型：一拍排出两声', ctx.started.length === 2, String(ctx.started.length));
  const sorted = [...ctx.started].sort((a, b) => a - b);
  check('两声正好差半拍（0.333s）', Math.abs((sorted[1]! - sorted[0]!) - 1 / 3) < 1e-9, String(sorted[1]! - sorted[0]!));
  check('窗口外的第二下也排了（不被截掉）', sorted[1]! > 0.3, String(sorted[1]!));

  // 停表时撤掉已排程的 click：停了不该再蹦「鬼拍」
  (m as unknown as { pump(): void }).pump();
  const before = ctx.started.length;
  m.stop();
  check('stop 撤掉未响的 click', ctx.stops.length > 0, String(ctx.stops.length));
  check('stop 后不再排 click', (() => {
    ctx.currentTime = 0.5;
    (m as unknown as { pump(): void }).pump();
    return ctx.started.length === before;
  })());
  m.dispose();
}

console.log(failed === 0 ? '\nMETRONOME 全部通过' : `\nMETRONOME FAIL (${failed})`);
if (failed > 0) process.exitCode = 1;
