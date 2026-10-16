/**
 * 变调变速客户端：把 stems 逐条送进 Worker 离线处理，结果按
 * （曲名：长度｜半音数｜倍速）缓存在会话内存里——同一组参数只算一次。
 *
 * AudioBuffer.getChannelData 返回的视图指向其内部存储，直接 Transfer
 * 会把原 AudioBuffer 一起 detach，所以先拷贝一份再发；返回的也是新
 * AudioBuffer，原 stems 不受影响（对齐/分析仍用原音频）。
 */

/** 会话内缓存：key → 各声道 Float32Array */
const cache = new Map<string, Float32Array[]>();

/** 最小结构类型：编辑器的 stem 是 {name, buffer, on}，AudioStem 是 {buffer, gain}，都满足 */
type StemLike = { buffer: AudioBuffer; name?: string };

/** stem 的会话内身份：曲名 + 采样数 + 声道数足以区分「同一份解码结果」 */
function stemKey(stem: StemLike, semitones: number, speed: number, index: number): string {
  const name = stem.name ?? `stem${index}`;
  return `${name}:${stem.buffer.length}:${stem.buffer.numberOfChannels}|s${semitones}|x${speed.toFixed(2)}`;
}

/** 从 AudioBuffer 取出可转移的声道拷贝 */
function extractChannels(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    channels.push(new Float32Array(buffer.getChannelData(ch)));
  }
  return channels;
}

/** 由 Float32Array 重建 AudioBuffer（AudioBuffer 构造器不可用时退回 OfflineAudioContext） */
function rebuildBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  // 我们的数组都由 new Float32Array 创建、底层是普通 ArrayBuffer；lib 类型宽泛需要收敛
  const plain = channels as Float32Array<ArrayBuffer>[];
  try {
    const buf = new AudioBuffer({ numberOfChannels: plain.length, length: plain[0]!.length, sampleRate });
    plain.forEach((ch, i) => buf.copyToChannel(ch, i));
    return buf;
  } catch {
    const host = new OfflineAudioContext(plain.length, plain[0]!.length, sampleRate);
    const buf = host.createBuffer(plain.length, plain[0]!.length, sampleRate);
    plain.forEach((ch, i) => buf.copyToChannel(ch, i));
    return buf;
  }
}

/**
 * 全部 stem 离线变调 semitones 个半音、变速 speed 倍（speed > 1 加速）。
 * 两者都不动时原样返回。缓存命中即秒回；未命中走 Worker
 * （3 分钟曲子约 1–5 秒，不卡 UI），变速时长 = 原时长 / speed。
 */
export async function pitchShiftStems(
  stems: StemLike[],
  semitones: number,
  speed = 1,
): Promise<AudioBuffer[]> {
  if (semitones === 0 && speed === 1) return stems.map((s) => s.buffer);
  const keys = stems.map((s, i) => stemKey(s, semitones, speed, i));
  const pending: { key: string; channels: Float32Array[] }[] = [];
  const results = new Map<string, Float32Array[]>();
  keys.forEach((key, i) => {
    const hit = cache.get(key);
    if (hit) results.set(key, hit);
    else pending.push({ key, channels: extractChannels(stems[i]!.buffer) });
  });
  if (pending.length > 0) {
    const worker = new Worker(new URL('./pitchShift.worker.ts', import.meta.url), { type: 'module' });
    try {
      // 串行处理：单个 worker 的 onmessage 只有一个，并发任务会互相抢回包
      for (const job of pending) {
        await new Promise<void>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<{ channels?: Float32Array[]; error?: string }>) => {
            if (event.data.error) { reject(new Error(event.data.error)); return; }
            const channels = event.data.channels;
            if (!channels) { reject(new Error('变调结果为空')); return; }
            cache.set(job.key, channels);
            results.set(job.key, channels);
            resolve();
          };
          worker.onerror = (event) => reject(new Error(event.message || '变调处理失败'));
          worker.postMessage({ channels: job.channels, semitones, speed }, job.channels.map((c) => c.buffer));
        });
      }
    } finally {
      worker.terminate();
    }
  }
  return keys.map((key, i) => rebuildBuffer(results.get(key)!, stems[i]!.buffer.sampleRate));
}
