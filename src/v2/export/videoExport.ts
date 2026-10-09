/**
 * 视频导出流程：排版 → 离线混音 → 逐帧渲染 + WebCodecs 编码 → 落盘。
 *
 * 与旧版的根本区别：**不再实时播放**。声音先离线混成一条整轨，
 * 画面按「第 i 帧 = 第 i/fps 秒」逐帧编码，所以快 5-20 倍，也不用守着页面。
 */

import type { Score } from "../types";
import type { AudioStem } from "../audio";
import { secToTick, tickToSec, type TempoMap } from "../tempo";
import { activeHeadsAt, activeMainAt, type TimelineEntry } from "../timeline";
import { TICKS_PER_BEAT } from "../ticks";
import { saveBytesAsFile, type SaveResult } from "../io";
import { exportLayoutFor, safeFileName } from "./tasks";
import { exportVideoFast } from "./encode";
import { mixStems, synthNotes, type Mix } from "./mix";
import { exportTheme, paintVideoFrame } from "./render";
import { lineTickRanges, recordSeconds, scrollTargetY, videoGeometry, type VideoRatio } from "./video";

/** 导出音轨的采样率（伴奏解码出来是多少就用多少，避免二次重采样） */
const MIX_RATE = 44100;

export interface VideoExportOptions {
  score: Score;
  name: string;
  timeline: TimelineEntry[];
  /** 显示用时间线（画原谱时传映射回原谱 id 的那份） */
  displayTimeline?: TimelineEntry[];
  playStyle?: "head" | "band";
  fromTick: number;
  /** 只录一段时的结束 tick（含）；不给 = 到谱面末尾 */
  toTick?: number;
  bpm: number;
  tempo: TempoMap | null;
  stems: AudioStem[];
  dark: boolean;
  ratio: VideoRatio;
  /** 短边像素（720 / 1080 / 1440） */
  shortSide: number;
  fps: number;
  audio: "stems" | "synth" | "none";
  showTitle?: boolean;
  showMeasureNumbers?: boolean;
  onProgress?: (ratio: number) => void;
  cancelled?: () => boolean;
}

/**
 * tick ↔ 秒的换算：**音频模式用 tempo 标定**（tick 是音频时间轴），
 * 合成音 / 静音用谱面速度（tick 是谱面时间轴）。两种口径不能混。
 */
export function tickClock(opts: VideoExportOptions): {
  secondsOf: (tick: number) => number;
  tickAt: (sec: number) => number;
} {
  const useTempo = opts.audio === "stems" && !!opts.tempo;
  const tps = (opts.bpm / 60) * TICKS_PER_BEAT;
  if (useTempo) {
    const tempo = opts.tempo as TempoMap;
    const startSec = tickToSec(tempo, opts.fromTick);
    return {
      secondsOf: (tick) => tickToSec(tempo, tick) - startSec,
      tickAt: (sec) => secToTick(tempo, startSec + sec),
    };
  }
  return {
    secondsOf: (tick) => (tick - opts.fromTick) / tps,
    tickAt: (sec) => opts.fromTick + sec * tps,
  };
}

/**
 * 离线混出整条音轨。
 *
 * stems：伴奏从曲首开始对齐，所以起点就是 fromTick 对应的秒数，剪掉前面即可。
 * synth：时间轴上每个音按谱面速度换算成秒，三角波 + 包络直接写样本。
 */
export function buildExportAudio(opts: VideoExportOptions, seconds: number): Mix | null {
  if (opts.audio === "none") return null;
  const clock = tickClock(opts);
  if (opts.audio === "stems") {
    if (!opts.tempo || opts.stems.length === 0) return null;
    return mixStems({
      stems: opts.stems,
      durationSec: seconds,
      sampleRate: MIX_RATE,
      offsetSec: clock.secondsOf(opts.fromTick),
    });
  }
  const notes = opts.timeline
    .filter((e) => e.midi !== null && !e.grace)
    .map((e) => ({
      startSec: clock.secondsOf(e.startTick),
      endSec: clock.secondsOf(e.endTick),
      midi: e.midi as number,
      gain: e.gain,
    }))
    .filter((n) => n.endSec > 0 && n.startSec < seconds);
  return synthNotes({ notes, durationSec: seconds, sampleRate: MIX_RATE });
}

/** 导出视频并落盘：几分钟的歌通常几十秒出片 */
export async function exportScoreVideoToFile(
  opts: VideoExportOptions,
): Promise<SaveResult & { seconds: number; ext: string; sizeMB: number; codec: string }> {
  const { canvasW, canvasH, geo } = videoGeometry(opts.ratio, opts.shortSide);
  const layout = exportLayoutFor(opts.score, geo, opts.showTitle ?? true);
  const showTl = opts.displayTimeline ?? opts.timeline;
  const ranges = lineTickRanges(layout, showTl);
  const theme = exportTheme(opts.dark);
  const clock = tickClock(opts);
  // 时长沿用统一口径：音频模式以音频放完为准，合成音按谱长
  const seconds = recordSeconds({
    timeline: opts.timeline,
    fromTick: opts.fromTick,
    ...(opts.toTick !== undefined ? { toTick: opts.toTick } : {}),
    bpm: opts.bpm,
    tempo: opts.tempo,
    stems: opts.stems,
    audio: opts.audio,
  });
  const frameCount = Math.max(1, Math.round(seconds * opts.fps));
  const audio = buildExportAudio(opts, seconds);

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("拿不到 2D 画布");
  const scale = Math.max(0.2, Math.min(canvasW / layout.width, 2.4));
  const xOff = Math.max(0, (canvasW - layout.width * scale) / 2);

  const res = await exportVideoFast({
    canvas,
    fps: opts.fps,
    frameCount,
    audio,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.cancelled ? { cancelled: opts.cancelled } : {}),
    draw: (i) => {
      // 离线渲染：滚动位置是 tick 的纯函数，不需要逐帧去「追」目标
      const tick = clock.tickAt(i / opts.fps);
      const act = activeMainAt(showTl, tick);
      paintVideoFrame(ctx, layout, theme, {
        canvasW,
        canvasH,
        scale,
        offsetX: xOff,
        scrollY: scrollTargetY(ranges, tick, scale, canvasH, layout.lineHeight),
        playStyle: opts.playStyle ?? "head",
        playhead: act ? { eventId: act.entry.eventId, frac: act.progress } : null,
        playheads: activeHeadsAt(showTl, tick),
        showMeasureNumbers: opts.showMeasureNumbers ?? true,
        progress: (i + 1) / frameCount,
      });
    },
  });
  if (!res) return { ok: false, path: null, seconds, ext: "-", sizeMB: 0, codec: "-" };

  const saved = await saveBytesAsFile(res.bytes, `${safeFileName(opts.name)}.${res.ext}`, {
    ext: res.ext,
    mime: res.ext === "mp4" ? "video/mp4" : "video/webm",
    label: res.ext === "mp4" ? "MP4 视频" : "WebM 视频",
  });
  return {
    ...saved,
    seconds: res.seconds,
    ext: res.ext,
    codec: res.codec.video + (res.codec.audio ? "+" + res.codec.audio : ""),
    sizeMB: Math.round((res.bytes.length / 1024 / 1024) * 10) / 10,
  };
}
