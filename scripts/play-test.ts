/**
 * 播放音源「等一下」判定的测试。
 *
 * 回归背景：伴奏是异步从本地读回 + 解码的，这段时间 playSource 已经是
 * 「伴奏」但 audioReady 为假——按播放会静默退回合成音，听起来就是
 * 「选了伴奏却播 MIDI」（exe 走磁盘比 Web 慢，必踩）。
 * 修复 = 选了伴奏且正在恢复时，先等恢复完成再放。
 */
import { shouldWaitForAudio } from '../src/v2/ui/playGate';
import { Player } from '../src/v2/audio';
import { constantTempo } from '../src/v2/tempo';
import { buildTimeline } from '../src/v2/timeline';
import { parseDsl } from '../src/v2/dsl';

let failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failed += 1;
    console.log(`  XX  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

console.log('[播放 · 音源等待判定]');
{
  check(
    '选了伴奏且正在恢复 → 要等（这条就是「选了伴奏却播 MIDI」的根因）',
    shouldWaitForAudio('audio', true) === true,
  );
  check('伴奏已就绪（不在恢复中）→ 不等，直接放', shouldWaitForAudio('audio', false) === false);
  check('合成音永远不等', shouldWaitForAudio('synth', true) === false && shouldWaitForAudio('synth', false) === false);
}

console.log('[播放 · 音频时钟与任意起点]');
{
  class MockContext {
    static latest: MockContext;
    currentTime = 10;
    destination = {};
    constructor() { MockContext.latest = this; }
    close() { return Promise.resolve(); }
    createBufferSource() { return { connect() {}, start() {}, stop() {}, buffer: null }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
  }
  const globals = globalThis as unknown as { window?: unknown };
  const previous = globals.window;
  let schedule = () => {};
  globals.window = { AudioContext: MockContext, setInterval: (fn: () => void) => { schedule = fn; return 0; } };
  const player = new Player();
  const timeline = [{ eventId: 'note', startTick: 0, endTick: 1000, degree: 1, octave: 0, midi: 60 }];
  const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-6;
  try {
    player.start(timeline, 120, 96);
    check('合成音从曲中起播，提前量期间保持选中拍位', near(player.currentTick, 96));
    MockContext.latest.currentTime = 11.1;
    check('合成音按音频时钟前进，包含起播偏移', near(player.currentTick, 192));
    check('音频时钟暂停时视觉进度不自行前进', near(player.currentTick, 192));
    player.start(timeline, 60, 240);
    check('重新选择起点不会继承上一轮进度', near(player.currentTick, 240));
    MockContext.latest.currentTime = 11.1;
    check('重新起播后采用新的速度', near(player.currentTick, 288));
    const tempo = constantTempo(120, 2, 0);
    const stems = [{ buffer: { duration: 60 } as AudioBuffer, gain: 1 }];
    player.startAudio({ timeline, tempo, fromTick: 144, stems });
    check('伴奏从曲中起播，提前量期间不倒退', near(player.currentTick, 144));
    MockContext.latest.currentTime = 10.6;
    check('伴奏沿同一标定时间轴前进', near(player.currentTick, 192));
    player.startAudio({ timeline, tempo, fromTick: -1000, stems });
    check('早于音频开头的请求与实际音频零秒一致', near(player.currentSec, 0) && near(player.currentTick, -192));
    player.startAudio({ timeline, tempo, fromTick: 2000, stems, synth: false });
    check('谱面结束后的伴奏尾奏仍可定位播放', player.isPlaying && near(player.currentTick, 2000));
    player.startAudio({ timeline, tempo, fromTick: 0, stems: [...stems, { buffer: { duration: 10 } as AudioBuffer, gain: 1 }], synth: false });
    MockContext.latest.currentTime = 30; schedule();
    check('分轨时长不同，较短分轨结束不截断较长伴奏', player.isPlaying);
    player.startAudio({ timeline, tempo, fromTick: 100000, stems, synth: false });
    check('超过伴奏结尾的定位不启动空播放', !player.isPlaying);
    player.stop();
    check('停止后不返回上一轮音频进度', player.currentTick === null);
  } finally {
    player.stop();
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  }
}

console.log('\n[播放 · 力度与渐强渐弱包络]');
{
  const dyn = (src: string): { from: number; to: number }[] =>
    buildTimeline(parseDsl(src).score!)
      .filter((e) => e.midi !== null && !e.grace)
      .map((e) => ({ from: e.dyn ?? 1, to: e.dynTo ?? e.dyn ?? 1 }));

  // 渐强：起点 0.6 → 终点 1，逐音连续（不是跳档）
  const cresc = dyn('@format 3\n@beat 4/4\n\ncresc[ 5 6 7 1^ ]hairpin ||\n');
  check('渐强从 0.6 走到 1', cresc.length === 4 && Math.abs(cresc[0].from - 0.6) < 0.01 && Math.abs(cresc[3].to - 1) < 0.01);
  check(
    '渐强逐音连续（前一音终点 = 后一音起点）',
    cresc.every((d, i) => i === 0 || Math.abs(d.from - cresc[i - 1].to) < 0.01),
  );
  // 渐弱：反过来
  const dim = dyn('@format 3\n@beat 4/4\n\ndim[ 5 6 7 1^ ]hairpin ||\n');
  check('渐弱从 1 走到 0.5', dim.length === 4 && Math.abs(dim[0].from - 1) < 0.01 && Math.abs(dim[3].to - 0.5) < 0.01);
  // 长音横跨范围：自己那一截内连续推进（不是整段一个音量）
  const long = dyn('@format 3\n@beat 4/4\n\ncresc[ 5-- 6 ]hairpin ||\n');
  check('长音内部也连续推进', long.length === 2 && long[0].from < long[0].to && Math.abs(long[0].to - long[1].from) < 0.01);
  // 力度档位本身
  const levels = dyn('@beat 4/4\n\np 5 f 6 mp 7 ff 1^ ||\n');
  check(
    '力度档位进包络（p 0.5 / f 0.92 / mp 0.65 / ff 1）',
    levels.length === 4 &&
      Math.abs(levels[0].from - 0.5) < 0.01 &&
      Math.abs(levels[1].from - 0.92) < 0.01 &&
      Math.abs(levels[2].from - 0.65) < 0.01 &&
      Math.abs(levels[3].from - 1) < 0.01,
  );
  // p 段里的渐强不能冲到最强：范围继承起始力度
  const soft = dyn('@format 3\n@beat 4/4\n\np cresc[ 5 6 7 1^ ]hairpin ||\n');
  check('p 段内的渐强不会冲到最强（终点 ≈ 0.5）', Math.abs(soft[3].to - 0.5) < 0.01, String(soft[3].to));
  // 没有记号时完全不变（老谱面不会被改响度）
  const plain = dyn('@beat 4/4\n\n5 6 7 1^ ||\n');
  check('无力度记号 → 包络恒为 1', plain.every((d) => d.from === 1 && d.to === 1));
}

console.log(failed === 0 ? '\n播放检查全部通过' : `\n播放检查失败 ${failed} 项`);
if (failed > 0) process.exit(1);
