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
  globals.window = { AudioContext: MockContext, setInterval: () => 0 };
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
    player.stop();
    check('停止后不返回上一轮音频进度', player.currentTick === null);
  } finally {
    player.stop();
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  }
}

console.log(failed === 0 ? '\n播放检查全部通过' : `\n播放检查失败 ${failed} 项`);
if (failed > 0) process.exit(1);
