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
  CanvasSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from "mediabunny";
import type { Mix } from "./mix";

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
  const cfg = { width, height, framerate: fps, bitrate };
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

  const plan = planCodecs(await probe(width, height, fps, bitrate), audio !== null);
  if (!plan) {
    throw new Error(
      audio
        ? "这个浏览器既编不了 MP4(H.264+AAC) 也编不了 WebM(VP9/VP8+Opus)，带声音的视频导不了。可以改用「静音」，或换 Chrome / Edge。"
        : "这个浏览器没有可用的视频编码器（WebCodecs），导不了视频。换 Chrome / Edge 试试。",
    );
  }

  const target = new BufferTarget();
  const output = new Output({
    format: plan.container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target,
  });
  const videoSource = new CanvasSource(canvas, {
    codec: plan.video,
    bitrate,
    keyFrameInterval: 2, // 每 2 秒一个关键帧：拖进度条时不至于卡住
    alpha: "discard", // 画布有 alpha 通道，H.264 不支持，丢掉
    latencyMode: "quality",
  });
  output.addVideoTrack(videoSource);
  const audioSource = audio
    ? new AudioBufferSource({ codec: plan.audio as AudioCodecId, bitrate: 160e3 })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  // start() 必须在任何 add() 之前：没 start 就塞数据会抛
  // 「Output has not started.」（踩过一次）
  await output.start();

  try {
    // 声音只有一次 add，先做掉，编码器不用空等画面
    if (audioSource && audio) await audioSource.add(toAudioBuffer(audio));
    for (let i = 0; i < frameCount; i += 1) {
      if (opts.cancelled?.()) {
        output.cancel();
        return null;
      }
      draw(i);
      // 时间戳由我们给：第 i 帧就是第 i/fps 秒，与实际耗时无关
      await videoSource.add(i / fps, 1 / fps);
      if (i % 5 === 0 || i === frameCount - 1) opts.onProgress?.((i + 1) / frameCount);
    }
    videoSource.close();
    audioSource?.close();
    await output.finalize();
  } catch (e) {
    output.cancel();
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
