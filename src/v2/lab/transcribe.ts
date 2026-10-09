/** 专用歌声识别连接本机 GAME；不把音频发送到远程服务。 */
import type { RawNote } from './quantize';

const SERVICE = 'http://127.0.0.1:8766';
export const SAMPLE_RATE = 22050;
export interface ServiceState {
  ready: boolean;
  engine: string;
  missing: string[];
  token: string;
}
export async function checkService(signal?: AbortSignal): Promise<ServiceState> {
  try {
    const r = await fetch(`${SERVICE}/health`, { signal: signal ?? AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('服务响应异常');
    const data = await r.json();
    if (data.engine !== 'GAME' || typeof data.token !== 'string' || typeof data.ready !== 'boolean') {
      throw new Error('服务版本不匹配');
    }
    return data;
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error('本机识别服务未连接，请运行 npm run lab:serve');
  }
}

export async function decodeAudio(file: File): Promise<AudioBuffer> {
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    await ctx.close();
  }
}
export async function toMono22050(buffer: AudioBuffer): Promise<Float32Array> {
  const off = new OfflineAudioContext(1, Math.ceil(buffer.duration * SAMPLE_RATE), SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}

/** 浏览器先统一解码，服务只接收有限大小的单声道 PCM WAV。 */
export function pcmWav(samples: Float32Array): Blob {
  const data = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(data);
  const text = (at: number, s: string): void => { [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0))); };
  text(0, 'RIFF'); v.setUint32(4, data.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * (s < 0 ? 32768 : 32767)), true));
  return new Blob([data], { type: 'audio/wav' });
}

export async function transcribe(audio: Float32Array, opts: {
  language: string;
  signal: AbortSignal;
  onMessage: (message: string) => void;
}): Promise<RawNote[]> {
  const { token, ready } = await checkService(opts.signal);
  if (!ready) throw new Error('人声识别模型未安装，请运行 npm run lab:setup');
  const headers = { 'X-WindScore-Token': token };
  let job: string | null = null;
  let completed = false;
  // 创建请求不能被提前中断，否则服务已接受任务却无法取得 id 来取消。
  try {
    opts.signal.throwIfAborted();
    const start = await fetch(`${SERVICE}/jobs?language=${encodeURIComponent(opts.language)}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: pcmWav(audio),
    });
    const created = await start.json();
    if (!start.ok) throw new Error(created.message ?? '创建识别任务失败');
    job = created.id;
    for (;;) {
      opts.signal.throwIfAborted();
      const r = await fetch(`${SERVICE}/jobs/${job}`, { headers, signal: opts.signal });
      const result = await r.json();
      if (!r.ok) throw new Error(result.message ?? '读取识别结果失败');
      if (result.status === 'done') {
        if (!Array.isArray(result.notes)) throw new Error('识别结果格式错误');
        completed = true;
        return result.notes;
      }
      if (result.status === 'error' || result.status === 'cancelled') throw new Error(result.message);
      opts.onMessage(result.message);
      await new Promise<void>((resolve, reject) => {
        const aborted = (): void => { clearTimeout(timer); reject(opts.signal.reason); };
        const timer = setTimeout(() => { opts.signal.removeEventListener('abort', aborted); resolve(); }, 1000);
        opts.signal.addEventListener('abort', aborted, { once: true });
      });
    }
  } finally {
    if (!completed && job) {
      await fetch(`${SERVICE}/jobs/${job}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(4000) }).catch(() => {});
    }
  }
}
