/**
 * 视频导出流程：排版 → 离线混音 → 逐帧渲染 + WebCodecs 编码 → 落盘。
 *
 * 与旧版的根本区别：**不再实时播放**。声音先离线混成一条整轨，
 * 画面按「第 i 帧 = 第 i/fps 秒」逐帧编码，所以快 5-20 倍，也不用守着页面。
 */

import type { Score } from "../types";
import type { AudioStem } from "../audio";
import { buildBallTrack, sampleBallTrail } from '../ball';
import { secToTick, tickToSec, type TempoMap } from "../tempo";
import { activeMainAt, type TimelineEntry } from "../timeline";
import { TICKS_PER_BEAT } from "../ticks";
import { saveBytesAsFile, type SaveResult } from "../io";
import { preloadInstrumentSamples } from "../instrumentSamples";
import { safeFileName } from "./tasks";
import { exportVideoFast } from "./encode";
import { mixStems, synthNotes, mixMetronome, type Mix } from "./mix";
import { scheduleHits, type MetronomeHit, type MetronomePattern, type MeterAt } from "../metronome";
import { exportTheme, paintVideoFrame, prepareExportLayout, type ExportLayoutResult, type ExportNotation } from "./render";
import {
  lineTickRanges,
  recordSeconds,
  scrollTargetY,
  stripCanvasSize,
  videoGeometry,
  videoLayoutFor,
  type VideoRatio,
} from "./video";
import { buildStrip, scrollTargetX, stripTickRanges } from "./strip";

/** 合成音导出采样率；伴奏沿用首条分轨的原采样率 */
const MIX_RATE = 44100;

export interface VideoExportOptions extends ExportNotation {
  score: Score;
  name: string;
  timeline: TimelineEntry[];
  /** 显示用时间线（画原谱时传映射回原谱 id 的那份） */
  displayTimeline?: TimelineEntry[];
  playStyle?: "head" | "band" | "ball";
  activePartId?: string;
  fromTick: number;
  /** 只录一段时的结束 tick（含）；不给 = 到谱面末尾 */
  toTick?: number;
  bpm: number;
  tempo: TempoMap | null;
  /**
   * 合成音导出用的谱中变速曲线（小节线「速96」）：audio === 'synth' 时 tick ↔ 秒
   * 走它；伴奏导出（'stems'）不用它——那边的秒一律跟对轨标定（tempo）走。
   */
  synthTempo?: TempoMap | null;
  stems: AudioStem[];
  dark: boolean;
  ratio: VideoRatio;
  /** 短边像素（720 / 1080 / 1440）。横向长条模式下这个数值直接作为**宽度** */
  shortSide: number;
  fps: number;
  /** 'page' = 纵向整页滚动（默认）；'strip' = 横向长条（绿幕抠像用） */
  mode?: 'page' | 'strip';
  /** 长条模式的页面排版输入（对话框传页面当前显示的那份） */
  layout?: ExportLayoutResult;
  audio: "stems" | "synth" | "none";
  /** 导出音轨里要不要带节拍器（可选）。拍号段与细分决定 click 落在哪 */
  metronome?: {
    pattern: MetronomePattern;
    meterAt: MeterAt;
    volume: number;
  };
  showTitle?: boolean;
  showMeasureNumbers?: boolean;
  onProgress?: (ratio: number) => void;
  onStatus?: (status: string) => void;
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
  const useSynthTempo = opts.audio === "synth" && !!opts.synthTempo;
  const tps = (opts.bpm / 60) * TICKS_PER_BEAT;
  if (useTempo || useSynthTempo) {
    const tempo = (useTempo ? opts.tempo : opts.synthTempo) as TempoMap;
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
 * 导出音轨里的节拍器击打点。
 *
 * 位置按**谱面拍**对齐：小节首拍 = 第 0 拍，强弱（每小节第一拍重音）
 * 因此跟谱面的拍号一致；伴奏模式经 tempo 标定换算成秒，
 * 合成音模式按谱面速度换算——两种模式都落在音乐真正的小节线上。
 */
export function exportMetronomeHits(
  opts: VideoExportOptions,
  seconds: number,
): MetronomeHit[] {
  const m = opts.metronome;
  if (!m) return [];
  const clock = tickClock(opts);
  return scheduleHits({
    fromSec: 0,
    toSec: seconds,
    beatToSec: (b) => clock.secondsOf(b * TICKS_PER_BEAT),
    meterAt: m.meterAt,
    pattern: m.pattern,
    startBeat: Math.max(0, Math.floor(opts.fromTick / TICKS_PER_BEAT)),
  });
}

/**
 * 离线混出整条音轨。
 *
 * stems：伴奏从曲首开始对齐，所以起点就是 fromTick 对应的秒数，剪掉前面即可。
 * synth：时间轴上每个音按谱面速度换算成秒，按条目音色（真采样 / 钢琴合成）
 *   直接写样本——与实时播放同一条音色路径。
 * metronome：可选，混完之后把 click 叠上去（不影响主音轨）。
 */
export function buildExportAudio(opts: VideoExportOptions, seconds: number): Mix | null {
  if (opts.audio === "none") return null;
  const clock = tickClock(opts);
  const mix = buildBaseMix(opts, clock, seconds);
  if (!mix) return null;
  const m = opts.metronome;
  if (!m) return mix;
  return mixMetronome({
    mix,
    hits: exportMetronomeHits(opts, seconds),
    volume: m.volume,
  });
}

/** 不带节拍器的主音轨 */
function buildBaseMix(
  opts: VideoExportOptions,
  clock: { secondsOf: (tick: number) => number },
  seconds: number,
): Mix | null {
  if (opts.audio === "stems") {
    if (!opts.tempo || opts.stems.length === 0) return null;
    const offsetSec = tickToSec(opts.tempo, opts.fromTick);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`导出时长算出异常值（${seconds}）：这首曲子的对轨标定可能已损坏，请到对轨界面重新标定后再导`);
    }
    if (!Number.isFinite(offsetSec)) {
      throw new Error(`伴奏起点算出异常值（${offsetSec}）：这首曲子的对轨标定可能已损坏，请到对轨界面重新标定后再导`);
    }
    for (const s of opts.stems) {
      if (!Number.isFinite(s.buffer.duration) || !Number.isFinite(s.buffer.sampleRate)) {
        throw new Error(`有一个伴奏分轨的音频数据异常（时长 ${s.buffer.duration}s / 采样率 ${s.buffer.sampleRate}），请到对轨界面重新载入该文件`);
      }
    }
    return mixStems({
      stems: opts.stems,
      durationSec: seconds,
      sampleRate: opts.stems[0]!.buffer.sampleRate,
      offsetSec,
    });
  }
  const notes = opts.timeline
    .filter((e) => e.midi !== null)
    .map((e) => ({
      startSec: clock.secondsOf(e.startTick),
      // 倚音多渲染 80ms（与实时播放 audio.ts 的 GRACE_TAIL 同值）：
      // 淡出尾巴盖过主音起音，接缝才顺。此前倚音整条被过滤，导出的视频不响倚音
      endSec: clock.secondsOf(e.endTick) + (e.grace ? 0.08 : 0),
      midi: e.midi as number,
      gain: e.gain,
      // 力度与渐强渐弱：与实时播放同一套包络，导出成品里也听得出来
      dyn: e.dyn,
      dynTo: e.dynTo,
      // 音色：与实时播放同一口径（patch / 音色八度），synthNotes 据此选采样
      patch: e.patch,
      patchOctave: e.patchOctave ?? 0,
    }))
    .filter((n) => n.endSec > 0 && n.startSec < seconds);
  return synthNotes({ notes, durationSec: seconds, sampleRate: MIX_RATE });
}

/** 导出视频并落盘：几分钟的歌通常几十秒出片 */
export async function exportScoreVideoToFile(
  opts: VideoExportOptions,
): Promise<SaveResult & { seconds: number; ext: string; sizeMB: number; codec: string }> {
  const { canvasW: pageW, canvasH: pageH, geo } = videoGeometry(opts.ratio, opts.shortSide);
  const sourceLayout = opts.layout
    ? (opts.layout.staff ? opts.layout : prepareExportLayout(opts.score, opts.layout, opts))
    : videoLayoutFor(opts.score, opts.ratio, opts.shortSide, opts.showTitle ?? true, opts);
  const title = opts.showTitle === false ? null : sourceLayout.title;
  const layout = { ...sourceLayout, title,
    ...(sourceLayout.staff ? { staff: { ...sourceLayout.staff, title } } : {}),
  };
  const showTl = opts.displayTimeline ?? opts.timeline;
  const theme = exportTheme(opts.dark);

  // 滚动横幅模式：把整份排版拉平成一条横带（忽略换行 / 分页），
  // 宽度 = 界面设定的数值，高度 = 一行谱（多声部一组）× 缩放。
  // 底色随外观：深色 = 纯黑（配「滤色」叠加），浅色 = 纯白（配「正片叠底」叠加）
  const isStrip = opts.ratio === 'strip';
  const strip = isStrip ? buildStrip(layout) : null;
  const STRIP_SCALE = geo.scale;
  const stripSize = strip ? stripCanvasSize(opts.shortSide, strip.height, STRIP_SCALE) : null;
  const canvasW = stripSize ? stripSize.w : pageW;
  const canvasH = stripSize ? stripSize.h : pageH;
  const stripTheme = strip
    ? { ...theme, bg: opts.dark ? '#000000' : '#ffffff' }
    : theme;
  const stripRanges = strip ? stripTickRanges(strip.layout, showTl) : null;
  const lineRanges = strip ? null : lineTickRanges(layout, showTl);
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
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`视频时长算出异常值（${seconds} 秒）：请检查谱面速度或对轨标定`);
  }
  const frameCount = Math.max(1, Math.round(seconds * opts.fps));
  opts.onStatus?.('正在准备谱面和混音');
  // 合成音导出前先把谱面涉及的真采样加载好：synthNotes 里「没加载」会静默
  // 回落钢琴合成，不预载的话设了手风琴 / 小提琴导出来还是钢琴（用户实测）。
  // 已加载时是空操作；失败也静默（回落合成，与实时播放同策略）。
  if (opts.audio === "synth") {
    await preloadInstrumentSamples(opts.timeline.map((e) => e.patch));
  }
  const mixAt = performance.now();
  const audio = buildExportAudio(opts, seconds);
  console.info('[video] mix ms', Math.round(performance.now() - mixAt));
  const ballLayout = strip?.layout ?? layout;
  const followPartId = ballLayout.lines.some(line => line.partId === opts.activePartId)
    ? opts.activePartId : ballLayout.lines[0]?.partId;
  let landingPositions: Map<string, { x: number; y: number }> | undefined;
  if (opts.playStyle === 'ball' && ballLayout.staff) {
    const staff = ballLayout.staff;
    const k = staff.glyph.fontSize / 21;
    landingPositions = new Map();
    for (const line of staff.lines) {
      if (followPartId && line.partId && line.partId !== followPartId) continue;
      for (const s of line.symbols) if ((s.kind === 'note' || s.kind === 'rest') && !s.hidden) {
        landingPositions.set(s.eventId, { x: s.x, y: s.y - staff.sp * 0.36 - (3.7 + 3) * k });
      }
    }
  }
  const ballTrack = opts.playStyle === 'ball' ? buildBallTrack(ballLayout, showTl, followPartId, landingPositions) : null;
  const ballTrail: { x: number; y: number }[] = [];

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("拿不到 2D 画布");
  const scale = geo.scale;
  const xOff = Math.max(0, (canvasW - layout.width * scale) / 2);
  const partTimelines = new Map<string, TimelineEntry[]>();
  for (const entry of showTl) {
    const id = entry.partId ?? '';
    const entries = partTimelines.get(id) ?? [];
    entries.push(entry);
    partTimelines.set(id, entries);
  }

  const res = await exportVideoFast({
    canvas,
    fps: opts.fps,
    frameCount,
    audio,
    onStatus: opts.onStatus,
    ...(opts.onProgress ? { onProgress: (ratio: number) => opts.onProgress!(ratio * 0.97) } : {}),
    ...(opts.cancelled ? { cancelled: opts.cancelled } : {}),
    draw: (i) => {
      // 离线渲染：滚动位置是 tick 的纯函数，不需要逐帧去「追」目标
      const tick = clock.tickAt(i / opts.fps);
      const ball = ballTrack ? sampleBallTrail(ballTrack, tick, opts.fromTick, ballTrail) : null;
      const act = activeMainAt(showTl, tick);
      const playheads = [...partTimelines.values()].flatMap(entries => {
        const active = activeMainAt(entries, tick);
        return active ? [{ eventId: active.entry.eventId, frac: active.progress }] : [];
      });
      if (strip && stripSize && stripRanges) {
        paintVideoFrame(ctx, strip.layout, stripTheme, {
          canvasW,
          canvasH,
          scale,
          scrollX: scrollTargetX(stripRanges, tick, scale, canvasW, strip.width),
          playStyle: opts.playStyle ?? "head",
          ball,
          playhead: act ? { eventId: act.entry.eventId, frac: act.progress } : null,
          playheads,
          showMeasureNumbers: opts.showMeasureNumbers ?? true,
          progress: (i + 1) / frameCount,
        });
        return;
      }
      paintVideoFrame(ctx, layout, theme, {
        canvasW,
        canvasH,
        scale,
        offsetX: xOff,
        scrollY: scrollTargetY(lineRanges ?? [], tick, scale, canvasH, layout.lineHeight),
        playStyle: opts.playStyle ?? "head",
        ball,
        playhead: act ? { eventId: act.entry.eventId, frac: act.progress } : null,
        playheads,
        showMeasureNumbers: opts.showMeasureNumbers ?? true,
        progress: (i + 1) / frameCount,
      });
    },
  });
  if (!res) return { ok: false, path: null, seconds, ext: "-", sizeMB: 0, codec: "-" };

  opts.onStatus?.('请选择视频保存位置，随后写入文件');
  const saved = await saveBytesAsFile(res.bytes, `${safeFileName(opts.name)}.${res.ext}`, {
    ext: res.ext,
    mime: res.ext === "mp4" ? "video/mp4" : "video/webm",
    label: res.ext === "mp4" ? "MP4 视频" : "WebM 视频",
    // 写盘阶段也要有进度：视频几十上百 MB，写的时候不吭声会被当成卡死（用户实测）
    onWriteProgress: (done, total) => {
      opts.onStatus?.('正在写入视频文件');
      opts.onProgress?.(0.97 + 0.03 * (done / Math.max(1, total)));
    },
  });
  if (saved.ok) opts.onProgress?.(1);
  return {
    ...saved,
    seconds: res.seconds,
    ext: res.ext,
    codec: res.codec.video + (res.codec.audio ? "+" + res.codec.audio : ""),
    sizeMB: Math.round((res.bytes.length / 1024 / 1024) * 10) / 10,
  };
}
