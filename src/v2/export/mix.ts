/**
 * 离线混音：视频导出要先把声音**算出来**，而不是放出来。
 *
 * 之前用 MediaRecorder 实时录，声音只能等它放完（1×）；改成 WebCodecs
 * 离线编码后，整条音轨可以先在这里一次性混好，于是「3 分钟的歌」不必等 3 分钟。
 *
 * 全是数值计算，不碰 Web Audio —— 所以能进 node 单测
 * （真实 AudioBuffer 满足 PcmSource，测试里用普通对象代替）。
 */

/** AudioBuffer 的最小结构 */
export interface PcmSource {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface Mix {
  channels: Float32Array[];
  sampleRate: number;
  length: number;
  durationSec: number;
}

/** 合成音的音量：三角波比正弦响，0.22 与实时合成音听感接近 */
const SYNTH_GAIN = 0.22;

function alloc(durationSec: number, sampleRate: number, channels: number): Mix {
  const length = Math.max(1, Math.round(durationSec * sampleRate));
  return {
    channels: Array.from({ length: channels }, () => new Float32Array(length)),
    sampleRate,
    length,
    durationSec: length / sampleRate,
  };
}

/**
 * 混 stem：按增益叠加，超出目标长度的部分截掉。
 * `offsetSec` 是「音频里对应视频 0 点的位置」——只录第 40 小节起时，
 * 前面那几十秒伴奏要剪掉（伴奏是从曲首开始对齐的）。
 */
export function mixStems(opts: {
  stems: readonly { buffer: PcmSource; gain: number }[];
  durationSec: number;
  sampleRate: number;
  offsetSec?: number;
  channels?: number;
}): Mix {
  const channels = opts.channels ?? 2;
  const mix = alloc(opts.durationSec, opts.sampleRate, channels);
  const offset = Math.max(0, Math.round((opts.offsetSec ?? 0) * opts.sampleRate));

  for (const stem of opts.stems) {
    if (stem.gain <= 0) continue;
    const src = stem.buffer;
    const count = Math.min(mix.length - offset, Math.max(0, src.length - offset));
    if (count <= 0) continue;
    for (let ch = 0; ch < channels; ch += 1) {
      const from = src.getChannelData(Math.min(ch, src.numberOfChannels - 1));
      const into = mix.channels[ch]!;
      for (let i = 0; i < count; i += 1) into[offset + i]! += from[offset + i]! * stem.gain;
    }
  }
  return mix;
}

/**
 * 合成音：把时间轴上的音按三角波 + 包络写进缓冲区。
 *
 * 波形与包络照 `audio.ts` 的实时合成音来（triangle、20ms 淡入、
 * 末尾 50ms 淡出），只是直接算样本、不经 Web Audio —— 听感一样，
 * 而且逐样本可测。startSec / endSec 相对视频 0 点。
 */
export function synthNotes(opts: {
  notes: readonly { startSec: number; endSec: number; midi: number; gain?: number }[];
  durationSec: number;
  sampleRate: number;
  gain?: number;
  channels?: number;
}): Mix {
  const channels = opts.channels ?? 2;
  const mix = alloc(opts.durationSec, opts.sampleRate, channels);
  const peak = opts.gain ?? SYNTH_GAIN;
  const sr = opts.sampleRate;
  const attack = Math.max(1, Math.round(0.02 * sr));

  for (const note of opts.notes) {
    const notePeak = peak * (note.gain ?? 1);
    const t0 = Math.round(note.startSec * sr);
    const t1 = Math.max(t0 + Math.round(0.06 * sr), Math.round(note.endSec * sr));
    const rel = Math.max(t0 + Math.round(0.03 * sr), t1 - Math.round(0.05 * sr));
    const from = Math.max(0, t0);
    const to = Math.min(mix.length, t1);
    if (to <= from) continue;
    const step = 440 * 2 ** ((note.midi - 69) / 12) / sr; // 每样本的相位增量
    for (let i = from; i < to; i += 1) {
      const at = i - t0;
      // 包络：淡入 → 保持 → 淡出
      let env = notePeak;
      if (at < attack) env = (notePeak * at) / attack;
      else if (i > rel) env = (notePeak * (t1 - i)) / Math.max(1, t1 - rel);
      // 三角波：0 → 1 → 0
      const tri = 1 - 4 * Math.abs(((at * step) % 1) - 0.5);
      const v = env * tri;
      for (let ch = 0; ch < channels; ch += 1) mix.channels[ch]![i]! += v;
    }
  }
  return mix;
}

/** 混音里最响的绝对值（自检：全 0 说明静音、或偏移算错了） */
export function peakOf(mix: Mix): number {
  let peak = 0;
  for (const ch of mix.channels) {
    for (const v of ch) {
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  return peak;
}
