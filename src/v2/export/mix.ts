/**
 * 离线混音：视频导出要先把声音**算出来**，而不是放出来。
 *
 * 之前用 MediaRecorder 实时录，声音只能等它放完（1×）；改成 WebCodecs
 * 离线编码后，整条音轨可以先在这里一次性混好，于是「3 分钟的歌」不必等 3 分钟。
 *
 * 全是数值计算，不碰 Web Audio —— 所以能进 node 单测
 * （真实 AudioBuffer 满足 PcmSource，测试里用普通对象代替）。
 */

import { clickSample, clickSampleMedium, type MetronomeHit } from '../metronome';
import { instrumentSampleFor, renderSampledNote } from '../instrumentSamples';
import { pianoSpec, renderNote } from '../timbre';

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

/** 合成音的音量：钢琴音色的峰值约 0.6，0.28 与实时合成音听感接近 */
const SYNTH_GAIN = 0.28;

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
 * 合成音：把时间轴上的音按**谱面音色**写进缓冲区。
 *
 * 音色选择与实时播放（audio.ts 的 tone）**同一条路**：条目带 patch 且
 * 真采样已加载 → 循环采样回放（手风琴 / 小提琴这些持续乐器）；没加载 /
 * 没采样的 patch → 回落钢琴合成。此前这里写死钢琴，谱面设了音色导出
 * 的视频也不生效（用户实测）——调用方须先用 preloadInstrumentSamples
 * 把涉及的 patch 预加载好，「还在加载」和「没有」都静默回落。
 * 这里算样本、实时那边塞进 AudioBuffer，跑的是同一个渲染器，
 * 所以导出的成品和耳朵里听到的必然一致。
 * 全是数值计算，不经 Web Audio —— 听感一样，而且逐样本可测。
 * startSec / endSec 相对视频 0 点。
 */
export function synthNotes(opts: {
  /**
   * `dyn` / `dynTo`：力度与渐强渐弱的包络（与实时播放同一口径，见 timeline）。
   * 两者不同就在音符内部线性推进——导出的视频里也能听出渐强渐弱。
   * `patch` / `patchOctave`：音色号与音色八度偏移（与实时播放同一口径）。
   */
  notes: readonly {
    startSec: number;
    endSec: number;
    midi: number;
    gain?: number;
    dyn?: number;
    dynTo?: number;
    patch?: number;
    patchOctave?: number;
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

  for (const note of opts.notes) {
    const base = peak * (note.gain ?? 1);
    if (base <= 0) continue;
    const dyn = note.dyn ?? 1;
    const dur = Math.max(0.03, note.endSec - note.startSec);
    // 发声音高 = 记谱音高 + 音色八度（与实时播放一致；变调不进导出——
    // 视频画面是原谱，声音跟谱面走）
    const at = note.midi + (note.patchOctave ?? 0) * 12;
    const inst = instrumentSampleFor(note.patch, at);
    const pcm = inst
      ? renderSampledNote(inst.pcm, inst.point, at, {
          sampleRate: sr,
          durationSec: dur,
          dyn,
          dynTo: note.dynTo ?? dyn,
        })
      : renderNote(pianoSpec(at, dyn), {
          sampleRate: sr,
          durationSec: dur,
          dyn,
          dynTo: note.dynTo ?? dyn,
        });
    const t0 = Math.round(note.startSec * sr);
    const from = Math.max(0, t0);
    const to = Math.min(mix.length, t0 + pcm.length);
    if (to <= from) continue;
    for (let ch = 0; ch < channels; ch += 1) {
      const into = mix.channels[ch]!;
      for (let i = from; i < to; i += 1) {
        into[i]! += pcm[i - t0]! * base;
      }
    }
  }
  return mix;
}

/**
 * 混音里最响的绝对值（自检：全 0 说明静音、或偏移算错了） */
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

/**
 * 把节拍器的 click 叠进已经混好的音轨（纯数值相加）。
 *
 * 与实时播放共用同一份 click 采样（`metronome.clickSample`），
 * 所以导出的成品和耳朵里听到的是同一种木头味。
 * 采样本身很短，逐点叠加的开销可以忽略。
 */
export function mixMetronome(opts: {
  mix: Mix;
  hits: readonly MetronomeHit[];
  volume?: number;
}): Mix {
  const vol = opts.volume ?? 0.5;
  if (!(vol > 0) || opts.hits.length === 0) return opts.mix;
  const sr = opts.mix.sampleRate;
  const accent = clickSample(sr, true);
  const medium = clickSampleMedium(sr);
  const plain = clickSample(sr, false);
  for (const hit of opts.hits) {
    // 三档强弱（GB/T 46845—2025 §6.3.13）：老数据没有 level 时按 accent 推
    const level = hit.level ?? (hit.accent ? 'strong' : 'weak');
    const src = level === 'strong' ? accent : level === 'medium' ? medium : plain;
    const start = Math.round(hit.timeSec * sr);
    if (start < 0) continue;
    const len = Math.min(src.length, opts.mix.length - start);
    if (len <= 0) continue;
    for (const ch of opts.mix.channels) {
      for (let i = 0; i < len; i += 1) ch[start + i]! += src[i]! * vol;
    }
  }
  return opts.mix;
}
