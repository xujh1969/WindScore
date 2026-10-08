/**
 * 播放音源的「等一下」判定。
 *
 * 背景：伴奏是**异步**从本地读回来 + 解码的（读盘 + decodeAudioData，几百毫秒到
 * 几秒，exe 走磁盘比 Web 慢得多）。这段时间里 playSource 已经是「伴奏」，
 * 但伴奏还没到，audioReady 为假——此时按播放会静默退回合成音，听起来就像
 * 「选了伴奏却播 MIDI」。所以选了伴奏又在恢复中时，先等恢复完成再放。
 *
 * 单独抽成纯函数：这条判定是 bug 的核心，Node 里可以直接测。
 */

/** 播放音源（'synth' = 合成 MIDI，'audio' = 对轨后的伴奏分轨） */
export type PlaySource = 'synth' | 'audio';

/**
 * 按播放时是否该先等伴奏恢复完。
 *   - 选了伴奏 + 正在恢复 → 要等（否则用户听到的是合成音，与界面显示不符）
 *   - 其余（合成音 / 伴奏已就绪 / 没在恢复）→ 不等，直接放
 */
export function shouldWaitForAudio(playSource: PlaySource, restoring: boolean): boolean {
  return playSource === 'audio' && restoring;
}
