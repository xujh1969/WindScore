/**
 * 视频导出的纯计算部分：比例 → 画布尺寸、行 ↔ tick 区间、滚动目标、时长口径。
 *
 * 编码与封装在 encode.ts（需要 WebCodecs），流程胶水在 videoExport.ts。
 * 这里全部不碰浏览器 API，所以能进 node 单测。
 */

import type { LayoutResult } from "../layout";
import type { PageGeometry } from "./render";
import type { AudioStem } from "../audio";
import type { TempoMap } from "../tempo";
import { tickToSec } from "../tempo";
import { timelineTicks, type TimelineEntry } from "../timeline";
import { TICKS_PER_BEAT } from "../ticks";

/** 画面比例：竖屏 / 横屏 / 方形各档常见比例，id 就是 r<宽>x<高> */
export type VideoRatio =
  | "r9x16"
  | "r16x9"
  | "r16x10"
  | "r10x16"
  | "r4x3"
  | "r3x4"
  | "r3x2"
  | "r2x3"
  | "r1x1";

export interface VideoRatioSpec {
  id: VideoRatio;
  label: string;
  /** 宽高比（不必约分，够算画布尺寸就行） */
  w: number;
  h: number;
  /** 按钮悬停提示：这档比例适合什么场景 */
  hint: string;
}

export const VIDEO_RATIOS: readonly VideoRatioSpec[] = [
  { id: "r9x16", label: "9:16 竖屏", w: 9, h: 16, hint: "手机全屏竖看" },
  { id: "r16x9", label: "16:9 横屏", w: 16, h: 9, hint: "手机全屏横看" },
  { id: "r16x10", label: "16:10 横屏", w: 16, h: 10, hint: "横屏里偏高的一档" },
  { id: "r10x16", label: "10:16 竖屏", w: 10, h: 16, hint: "竖屏里偏宽的一档" },
  { id: "r4x3", label: "4:3 横屏", w: 4, h: 3, hint: "平板 / 投影" },
  { id: "r3x4", label: "3:4 竖屏", w: 3, h: 4, hint: "平板竖看" },
  { id: "r3x2", label: "3:2 横屏", w: 3, h: 2, hint: "相机横构图" },
  { id: "r2x3", label: "2:3 竖屏", w: 2, h: 3, hint: "相机竖构图" },
  { id: "r1x1", label: "1:1 方形", w: 1, h: 1, hint: "方形画面" },
];

/**
 * 画布尺寸：给定比例与**短边**像素，凑出偶数边长。
 * H.264 要求宽高为偶数，所以在这里取整而不是编码时取整。
 */
export function videoCanvasSize(ratio: VideoRatio, shortSide: number): { w: number; h: number } {
  const spec = VIDEO_RATIOS.find((r) => r.id === ratio) ?? VIDEO_RATIOS[0]!;
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  return spec.w >= spec.h
    ? { w: even((shortSide * spec.w) / spec.h), h: even(shortSide) }
    : { w: even(shortSide), h: even((shortSide * spec.h) / spec.w) };
}

/** 一行在时间轴上占的那一段（tick 区间 + 版面基线 y） */
export interface LineTickRange {
  from: number;
  to: number;
  y: number;
}

/**
 * 版面行 → 时间区间。用于「正在唱哪一行」→ 画面滚到哪。
 *
 * 时间线条目带的是**谱面事件 id**，排版结果里每个 item 也带 eventId，两边直接
 * 对得上。没有发声事件的行（只有小节线 / 房子的空行）跳过：滚动会从上一行
 * 自然过渡到下一行，中间那行照样经过屏幕。
 */
export function lineTickRanges(
  layout: LayoutResult,
  timeline: TimelineEntry[],
): LineTickRange[] {
  const startOf = new Map<string, number>();
  const endOf = new Map<string, number>();
  for (const e of timeline) {
    if (!startOf.has(e.eventId)) startOf.set(e.eventId, e.startTick);
    endOf.set(e.eventId, Math.max(endOf.get(e.eventId) ?? 0, e.endTick));
  }
  const out: LineTickRange[] = [];
  const rows = layout.systems?.map((system) => ({ y: system.top + layout.lineHeight / 2, items: layout.lines.slice(system.from, system.to).flatMap((line) => line.items) })) ?? layout.lines;
  for (const ln of rows) {
    let from = Infinity;
    let to = -Infinity;
    for (const it of ln.items) {
      const s = startOf.get(it.eventId);
      if (s === undefined) continue;
      from = Math.min(from, s);
      to = Math.max(to, endOf.get(it.eventId) ?? s);
    }
    if (from === Infinity) continue;
    const prev = out[out.length - 1];
    // 相邻两行之间不留缝：上一行结束直接接这一行开始
    out.push({ from: prev ? Math.min(prev.to, from) : from, to, y: ln.y });
  }
  return out;
}

/**
 * 目标滚动量（像素）：让当前行停在画面上方 38% 处。
 * 行与行之间按进度插值，滚动看起来是连续的，不会一格一格跳。
 */
export function scrollTargetY(
  ranges: readonly LineTickRange[],
  tick: number,
  scale: number,
  viewportH: number,
  lineHeight = 0,
): number {
  if (ranges.length === 0) return 0;
  let y = ranges[0]!.y;
  for (let i = 0; i < ranges.length; i += 1) {
    const r = ranges[i]!;
    if (tick < r.from) break;
    const next = ranges[i + 1];
    if (!next || tick < next.from) {
      const p = next
        ? Math.max(0, Math.min(1, (tick - r.from) / Math.max(1, next.from - r.from)))
        : 0;
      y = r.y + p * lineHeight * 0.5;
      break;
    }
    y = r.y;
  }
  return Math.max(0, y * scale - viewportH * 0.38);
}

/**
 * 视频总时长：音频模式以**音频放完**为准（谱面只转录半首歌时也照实录）。
 * `toTick` 给定时（只录一段）以它为界。
 */
export function recordSeconds(opts: {
  timeline: TimelineEntry[];
  fromTick: number;
  /** 结束 tick（含）；不给 = 到谱面末尾 */
  toTick?: number;
  bpm: number;
  tempo: TempoMap | null;
  stems: AudioStem[];
  audio: "stems" | "synth" | "none";
}): number {
  const tps = (opts.bpm / 60) * TICKS_PER_BEAT;
  const endTick = Math.max(opts.fromTick + 1, opts.toTick ?? timelineTicks(opts.timeline));
  const scoreSec = Math.max(0.1, (endTick - opts.fromTick) / tps);
  if (opts.audio === "stems" && opts.tempo && opts.stems.length > 0) {
    const startSec = tickToSec(opts.tempo, opts.fromTick);
    const audioEnd = Math.min(...opts.stems.map((s) => s.buffer.duration));
    // 选了段落就以 tick 为界；没选段落时**以音频放完为准**
    // （谱面只转录了半首歌时，也要把整条音频录进去）
    const end = opts.toTick === undefined ? audioEnd : Math.min(audioEnd, tickToSec(opts.tempo, endTick));
    return Math.max(0.1, end - startSec) + 0.4;
  }
  return scoreSec + 0.4;
}

/**
 * 视频的画面参数：按**短边**定字号（每行小节数随比例变），
 * 横向能放下的宽度另算，所以竖屏不会把一行拉得又长又挤。
 */
export function videoGeometry(
  ratio: VideoRatio,
  shortSide: number,
): { canvasW: number; canvasH: number; geo: PageGeometry } {
  const { w, h } = videoCanvasSize(ratio, shortSide);
  const scale = Math.max(1.1, Math.min(2.6, shortSide / 620));
  const margin = Math.round(Math.min(w, h) * 0.04);
  return {
    canvasW: w,
    canvasH: h,
    geo: {
      pageW: w,
      pageH: h,
      scale,
      marginX: margin,
      marginTop: margin,
      marginBottom: Math.round(margin * 1.2),
    },
  };
}
