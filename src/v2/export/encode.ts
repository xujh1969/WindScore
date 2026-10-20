/**
 * 视频编码 + 封装（WebCodecs + mediabunny）。
 *
 * 关键差别：**时间戳是我们给的**，不是墙钟。所以想要第几帧就渲染第几帧，
 * 3 分钟的歌不用等 3 分钟（通常快 5-20 倍），也不必守着标签页。
 *
 * 编码协商（planCodecs）是纯函数，node 里能测；调 WebCodecs 的部分需要浏览器。
 */

import {
  AudioBufferSource,
  BufferTarget,
  VideoSample,
  VideoSampleSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from "mediabunny";
import type { Mix } from "./mix";
import { isTauri } from '../io';

export type VideoCodecId = "avc" | "vp9" | "vp8";
export type AudioCodecId = "aac" | "opus";

export interface CodecPlan {
  container: "mp4" | "webm";
  video: VideoCodecId;
  audio: AudioCodecId | null;
}

/**
 * 挑容器与编解码：**mp4 优先**（微信 / QQ 直接能发），不支持就退 webm。
 *
 * 声音必须跟容器配套（mp4 配 AAC、webm 配 Opus），所以「有画面没声音」
 * 这种组合在决策阶段就被排除——不会等到导完才发现是哑的。
 *
 * @param avail 各编解码器是否可编码（canEncodeVideo / canEncodeAudio 的探测结果）
 * @param wantAudio 是否要声音
 */
export function planCodecs(
  avail: { avc: boolean; aac: boolean; vp9: boolean; vp8: boolean; opus: boolean },
  wantAudio: boolean,
): CodecPlan | null {
  if (avail.avc && (!wantAudio || avail.aac)) {
    return { container: "mp4", video: "avc", audio: wantAudio ? "aac" : null };
  }
  const webmVideo: VideoCodecId | null = avail.vp9 ? "vp9" : avail.vp8 ? "vp8" : null;
  if (webmVideo && (!wantAudio || avail.opus)) {
    return { container: "webm", video: webmVideo, audio: wantAudio ? "opus" : null };
  }
  return null;
}

/** 码率估计：按像素数 × 帧率，1080p30 约 8 Mbps */
export function estimateBitrate(width: number, height: number, fps: number): number {
  return Math.min(16e6, Math.max(1.5e6, Math.round(width * height * fps * 0.13)));
}

export interface FastExportOptions {
  canvas: HTMLCanvasElement;
  fps: number;
  frameCount: number;
  /** 已混好的声音；null = 静音视频 */
  audio: Mix | null;
  /** 把第 i 帧画到 canvas（同步画完即可，编码在 await 里） */
  draw: (frameIndex: number) => void;
  bitrate?: number;
  onProgress?: (ratio: number) => void;
  onStatus?: (status: string) => void;
  /** 返回 true 就地中止（不产出文件） */
  cancelled?: () => boolean;
}

export interface FastExportResult {
  bytes: Uint8Array;
  ext: "mp4" | "webm";
  codec: CodecPlan;
  width: number;
  height: number;
  frames: number;
  seconds: number;
}

/** Float32Array 混合音轨 → 真正的 AudioBuffer（mediabunny 吃这个） */
function toAudioBuffer(mix: Mix): AudioBuffer {
  if (!Number.isFinite(mix.length) || mix.length <= 0) {
    throw new Error(`音频缓冲长度异常（${mix.length}）：混音数据损坏，请检查对轨标定或伴奏文件`);
  }
  const buf = new AudioBuffer({
    numberOfChannels: mix.channels.length,
    length: mix.length,
    sampleRate: mix.sampleRate,
  });
  mix.channels.forEach((ch, i) => buf.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
  return buf;
}

/** 探一遍可用编解码器，交给 planCodecs 决策 */
async function probe(width: number, height: number, fps: number, bitrate: number) {
  const cfg = { width, height, frameRate: fps, bitrate };
  const [avc, vp9, vp8, aac, opus] = await Promise.all([
    getFirstEncodableVideoCodec(["avc"], cfg),
    getFirstEncodableVideoCodec(["vp9"], cfg),
    getFirstEncodableVideoCodec(["vp8"], cfg),
    getFirstEncodableAudioCodec(["aac"], { bitrate: 160e3 }),
    getFirstEncodableAudioCodec(["opus"], { bitrate: 128e3 }),
  ]);
  return { avc: !!avc, vp9: !!vp9, vp8: !!vp8, aac: !!aac, opus: !!opus };
}

/**
 * 离线编码一段视频。**不需要实时播放，也不需要用户守着。**
 *
 * 顺序：探编码 → 建输出 → 先塞声音（一次 add 而已）→ 逐帧画 + 编码 → 收尾。
 * 声音先塞是因为它只要一次 add，而画面要循环几千次；先做掉，编码器不用空等。
 */
export async function exportVideoFast(opts: FastExportOptions): Promise<FastExportResult | null> {
  const { canvas, fps, frameCount, audio, draw } = opts;
  const width = canvas.width;
  const height = canvas.height;
  if (width % 2 || height % 2) throw new Error("画布宽高必须是偶数（H.264 要求）");
  const bitrate = opts.bitrate ?? estimateBitrate(width, height, fps);
  const started = performance.now();
  const nativeLog = isTauri() ? import('@tauri-apps/api/tauri') : null;
  let logQueue: Promise<unknown> = Promise.resolve();
  const diagnostic = (record: object, reset = false): Promise<unknown> => {
    console.info('[video]', record);
    if (nativeLog) logQueue = logQueue.then(async () => (await nativeLog).invoke('log_video_export', {
      line: JSON.stringify({ at: new Date().toISOString(), ...record }), reset,
    })).catch(error => console.debug('[video] diagnostic log unavailable', error));
    return logQueue;
  };
  await diagnostic({ phase: 'start', width, height, fps, frameCount, bitrate, userAgent: navigator.userAgent,
    visibility: document.visibilityState, audioSeconds: audio?.durationSec ?? 0 }, true);
  opts.onStatus?.('正在检查视频编码器');
  const plan = planCodecs(await probe(width, height, fps, bitrate), audio !== null);
  if (!plan) {
    throw new Error(
      audio
        ? "这个浏览器既编不了 MP4(H.264+AAC) 也编不了 WebM(VP9/VP8+Opus)，带声音的视频导不了。可以改用「静音」，或换 Chrome / Edge。"
        : "这个浏览器没有可用的视频编码器（WebCodecs），导不了视频。换 Chrome / Edge 试试。",
    );
  }

  const probeMs = performance.now() - started;
  const target = new BufferTarget();
  const output = new Output({
    format: plan.container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target,
  });
  const videoSource = new VideoSampleSource({
    codec: plan.video,
    bitrate,
    keyFrameInterval: 2, // 每 2 秒一个关键帧：拖进度条时不至于卡住
    alpha: "discard", // 画布有 alpha 通道，H.264 不支持，丢掉
    latencyMode: "quality",
    onEncoderConfig: config => { void diagnostic({ phase: 'encoder-config', config }); },
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const audioSource = audio
    ? new AudioBufferSource({ codec: plan.audio as AudioCodecId, bitrate: 160e3 })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  // start() 必须在任何 add() 之前：没 start 就塞数据会抛
  // 「Output has not started.」（踩过一次）
  await output.start();

  let drawMs = 0;
  let captureMs = 0;
  let encodeWaitMs = 0;
  let audioMs = 0;
  let progressAt = performance.now();
  let statusAt = progressAt;
  try {
    // 声音只有一次 add，先做掉，编码器不用空等画面
    opts.onStatus?.('正在编码音频');
    const audioAt = performance.now();
    if (audioSource && audio) await audioSource.add(toAudioBuffer(audio));
    audioMs = performance.now() - audioAt;
    await diagnostic({ phase: 'audio-ready', audioMs, probeMs, codec: plan });
    opts.onStatus?.(`正在绘制和编码 ${plan.container.toUpperCase()}（自动选择编码器）`);
    for (let i = 0; i < frameCount; i += 1) {
      if (opts.cancelled?.()) {
        await output.cancel();
        await diagnostic({ phase: 'cancelled', frames: i, frameCount, drawMs, captureMs, encodeWaitMs, audioMs, elapsedMs: performance.now() - started });
        return null;
      }
      const drawAt = performance.now();
      draw(i);
      drawMs += performance.now() - drawAt;
      // 时间戳由我们给：第 i 帧就是第 i/fps 秒，与实际耗时无关
      const captureAt = performance.now();
      const sample = new VideoSample(canvas, { timestamp: i / fps, duration: 1 / fps });
      captureMs += performance.now() - captureAt;
      const encodeAt = performance.now();
      try { await videoSource.add(sample); } finally { sample.close(); }
      encodeWaitMs += performance.now() - encodeAt;
      if (performance.now() - progressAt >= 150 || i === frameCount - 1) {
        opts.onProgress?.((i + 1) / frameCount);
        progressAt = performance.now();
      }
      if (performance.now() - statusAt >= 1000 || i === frameCount - 1) {
        const frames = i + 1;
        const elapsed = performance.now() - started - probeMs - audioMs;
        opts.onStatus?.(`${(frames * 1000 / Math.max(1, elapsed)).toFixed(1)}帧/秒 · 绘制${(drawMs / frames).toFixed(1)}ms · 取帧${(captureMs / frames).toFixed(1)}ms · 编码${(encodeWaitMs / frames).toFixed(1)}ms · ${frames}/${frameCount}帧`);
        void diagnostic({ phase: 'progress', frames, frameCount, drawMs, captureMs, encodeWaitMs, elapsedMs: elapsed,
          visibility: document.visibilityState });
        statusAt = performance.now();
      }
    }
    videoSource.close();
    audioSource?.close();
    opts.onStatus?.('正在完成视频封装');
    const finalizeAt = performance.now();
    await output.finalize();
    await diagnostic({ phase: 'complete', probe: Math.round(probeMs), audio: Math.round(audioMs), draw: Math.round(drawMs),
      capture: Math.round(captureMs), encodeWait: Math.round(encodeWaitMs), finalize: Math.round(performance.now() - finalizeAt),
      total: Math.round(performance.now() - started), frames: frameCount, width, height, codec: plan });
  } catch (e) {
    await output.cancel();
    await diagnostic({ phase: 'error', message: String(e), drawMs, encodeWaitMs, audioMs });
    throw e;
  }

  const buffer = target.buffer;
  if (!buffer) throw new Error("编码结束但没拿到数据（浏览器拒绝输出）");
  return {
    bytes: new Uint8Array(buffer),
    ext: plan.container,
    codec: plan,
    width,
    height,
    frames: frameCount,
    seconds: frameCount / fps,
  };
}
