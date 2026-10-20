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
  // 守卫：坏数据（标定损坏、时长算出 NaN/Infinity）以前会变成
  // 「Invalid array length」这类玄学错误，这里拦下来说人话。
  if (!Number.isFinite(durationSec)) throw new Error(`混音时长异常（${durationSec}）：请检查对轨标定或重新保存这份谱`);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 384000) throw new Error(`音频采样率异常（${sampleRate}）：伴奏文件可能已损坏`);
  const length = Math.max(1, Math.round(durationSec * sampleRate));
  // 3 小时 × 48kHz ≈ 5.2 亿样本，超过基本就是坏数据
  if (length > 3 * 3600 * 192000) throw new Error(`音频太长（约 ${Math.round(durationSec / 60)} 分钟），无法离线混音`);
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
  const offsetSec = opts.offsetSec ?? 0;

  for (const stem of opts.stems) {
    if (stem.gain <= 0) continue;
    const src = stem.buffer;
    const ratio = src.sampleRate / opts.sampleRate;
    const offset = offsetSec * src.sampleRate;
    const start = Math.max(0, Math.ceil(-offset / ratio));
    const end = Math.min(mix.length, Math.ceil((src.length - offset) / ratio));
    if (end <= start) continue;
    for (let ch = 0; ch < channels; ch += 1) {
      const from = src.getChannelData(Math.min(ch, src.numberOfChannels - 1));
      const into = mix.channels[ch]!;
      for (let i = start; i < end; i += 1) {
        const position = offset + i * ratio;
        const index = Math.floor(position);
        const fraction = position - index;
        const a = from[index]!;
        const b = from[Math.min(index + 1, src.length - 1)]!;
        into[i]! += (a + (b - a) * fraction) * stem.gain;
      }
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
  /**
   * `dyn` / `dynTo`：力度与渐强渐弱的包络（与实时播放同一口径，见 timeline）。
   * 两者不同就在音符内部线性推进——导出的视频里也能听出渐强渐弱。
   */
  notes: readonly {
    startSec: number;
    endSec: number;
    midi: number;
    gain?: number;
    dyn?: number;
    dynTo?: number;
  }[];
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
    const base = peak * (note.gain ?? 1);
    const notePeak = base * (note.dyn ?? 1);
    const noteEnd = base * (note.dynTo ?? note.dyn ?? 1);
    const t0 = Math.round(note.startSec * sr);
    const t1 = Math.max(t0 + Math.round(0.06 * sr), Math.round(note.endSec * sr));
    const rel = Math.max(t0 + Math.round(0.03 * sr), t1 - Math.round(0.05 * sr));
    const from = Math.max(0, t0);
    const to = Math.min(mix.length, t1);
    if (to <= from) continue;
    const step = 440 * 2 ** ((note.midi - 69) / 12) / sr; // 每样本的相位增量
    const swellFrom = t0 + attack;
    const swellSpan = Math.max(1, rel - swellFrom);
    for (let i = from; i < to; i += 1) {
      const at = i - t0;
      // 包络：淡入 →（渐强/渐弱推进）→ 淡出
      let env = notePeak;
      if (at < attack) env = (notePeak * at) / attack;
      else if (i > rel) env = (noteEnd * (t1 - i)) / Math.max(1, t1 - rel);
      else if (noteEnd !== notePeak) {
        const u = Math.min(1, Math.max(0, (i - swellFrom) / swellSpan));
        env = notePeak + (noteEnd - notePeak) * u;
      }
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
