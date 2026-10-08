/**
 * 播放音源「等一下」判定的测试。
 *
 * 回归背景：伴奏是异步从本地读回 + 解码的，这段时间 playSource 已经是
 * 「伴奏」但 audioReady 为假——按播放会静默退回合成音，听起来就是
 * 「选了伴奏却播 MIDI」（exe 走磁盘比 Web 慢，必踩）。
 * 修复 = 选了伴奏且正在恢复时，先等恢复完成再放。
 */
import { shouldWaitForAudio } from '../src/v2/ui/playGate';

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

console.log(failed === 0 ? '\n播放音源判定测试全部通过' : `\n播放音源判定测试失败 ${failed} 项`);
if (failed > 0) process.exit(1);
