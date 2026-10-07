/**
 * WAV → MP3 压缩（纯 JS 的 LAME 编码器，浏览器与 Node 都能跑）。
 *
 * 伴奏原始 wav 一条就是几十上百 MB，放进打包 / 曲库都太重；
 * MP3 192kbps 听感无差、体积只有约 1/10。三条入口都走这里：
 *   - 对轨页载入伴奏（存进曲库前先转，键与引用一起用 mp3 的）
 *   - 打包 .wspack（包里的分轨自动是 mp3）
 *   - 导入打包（老包里若还带着 wav，入库前转掉）
 *
 * 解析失败的 wav（非标准 PCM，比如 ADPCM）走浏览器解码兜底；
 * 连兜底也不行就报错给界面，不会静默存一个坏文件。
 */

import { Mp3Encoder } from '@breezystack/lamejs';

/** LAME 认的采样率（MPEG-1 / 2 / 2.5 的合法档位）；之外的先重采样到 44100 */
const LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

export const DEFAULT_MP3_KBPS = 192;

export function isWavName(name: string): boolean {
  return /\.wav$/i.test(name);
}

export interface PcmData {
  left: Float32Array;
  /** 单声道时为 null */
  right: Float32Array | null;
  sampleRate: number;
}

function readStr(b: DataView, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(b.getUint8(off + i));
  return s;
}

/** 把 [-1,1] 的 float 采样压成 Int16（超界钳住，别让坏采样炸编码器） */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
  }
  return out;
}

/**
 * 纯函数：解析标准 RIFF/WAVE（16 / 24 / 32 位整型 PCM 与 32 位浮点）。
 * 解析不了返回 null——调用方走浏览器解码兜底。Node 里可直接测。
 */
export function parseWav(bytes: Uint8Array): PcmData | null {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 44) return null;
    if (readStr(v, 0, 4) !== 'RIFF' || readStr(v, 8, 4) !== 'WAVE') return null;

    let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
    let dataOff = -1;
    let dataLen = 0;
    let off = 12;
    while (off + 8 <= bytes.byteLength) {
      const id = readStr(v, off, 4);
      const size = v.getUint32(off + 4, true);
      if (id === 'fmt ') {
        fmt = {
          format: v.getUint16(off + 8, true),
          channels: v.getUint16(off + 10, true),
          rate: v.getUint32(off + 12, true),
          bits: v.getUint16(off + 22, true),
        };
      } else if (id === 'data') {
        dataOff = off + 8;
        dataLen = Math.min(size, bytes.byteLength - dataOff);
      }
      off += 8 + size + (size % 2); // chunk 按字对齐
    }
    if (!fmt || dataOff < 0 || dataLen === 0) return null;
    if (fmt.channels < 1 || fmt.channels > 2) return null;

    const mono = fmt.channels === 1;
    const total = Math.floor(dataLen / (fmt.bits / 8) / fmt.channels);
    if (total <= 0) return null;
    const left = new Float32Array(total);
    const right = mono ? null : new Float32Array(total);

    const push = (i: number, ch: number, val: number): void => {
      if (ch === 0) left[i] = val;
      else right![i] = val;
    };
    let p = dataOff;
    for (let i = 0; i < total; i += 1) {
      for (let ch = 0; ch < fmt.channels; ch += 1) {
        if (fmt.bits === 16) {
          const s = v.getInt16(p, true);
          push(i, ch, s / 0x8000);
          p += 2;
        } else if (fmt.bits === 24) {
          const b0 = v.getUint8(p);
          const b1 = v.getUint8(p + 1);
          const b2 = v.getUint8(p + 2);
          let s = (b2 << 16) | (b1 << 8) | b0; // 24 位小端，符号在最高字节
          if (s & 0x800000) s -= 0x1000000;
          push(i, ch, s / 0x800000);
          p += 3;
        } else if (fmt.bits === 32 && fmt.format === 3) {
          push(i, ch, v.getFloat32(p, true));
          p += 4;
        } else if (fmt.bits === 32) {
          const s = v.getInt32(p, true);
          push(i, ch, s / 0x80000000);
          p += 4;
        } else {
          return null; // 8 位之类：懒得支持，走兜底
        }
      }
    }
    return { left, right, sampleRate: fmt.rate };
  } catch {
    return null;
  }
}

/**
 * 纯函数：把 PCM 编成 MP3 字节（Node 里可直接测）。
 * 192kbps 对伴奏是「听不出差别」的档位：一条 80MB 的 wav 压完约 8MB。
 */
export function encodePcmToMp3(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
  kbps = DEFAULT_MP3_KBPS,
): Uint8Array {
  const channels = right ? 2 : 1;
  const enc = new Mp3Encoder(channels, sampleRate, kbps);
  const l = floatToInt16(left);
  const r = right ? floatToInt16(right) : null;
  const blockSize = 1152; // MP3 每帧的样本数
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < l.length; i += blockSize) {
    const lChunk = l.subarray(i, i + blockSize);
    const packed = (r ? enc.encodeBuffer(lChunk, r.subarray(i, i + blockSize)) : enc.encodeBuffer(lChunk)) ?? new Int8Array(0);
    if (packed.length > 0) chunks.push(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
  }
  const tail = enc.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.byteLength));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** mp3 文件名：把扩展名换成 .mp3，其余原样 */
export function mp3NameOf(name: string): string {
  return `${name.replace(/\.[^.]+$/, '')}.mp3`;
}

/**
 * WAV → MP3。优先走纯解析（快，无浏览器 API）；
 * 解析不了（非 PCM wav）或采样率怪异时用 OfflineAudioContext 解码重采样到 44100。
 */
export async function wavToMp3(file: File, kbps = DEFAULT_MP3_KBPS): Promise<File> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pcm = parseWav(bytes);
  if (!pcm || !LAME_RATES.includes(pcm.sampleRate)) {
    // 浏览器解码兜底：顺带把任何采样率重采样到 44100
    const host = new OfflineAudioContext(2, 1, 44100);
    const buf = await host.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    pcm = { left: buf.getChannelData(0), right: buf.numberOfChannels > 1 ? buf.getChannelData(1) : null, sampleRate: buf.sampleRate };
    if (!LAME_RATES.includes(pcm.sampleRate)) pcm.sampleRate = 44100; // decodeAudioData 已重采样到宿主率
  }
  const mp3 = encodePcmToMp3(pcm.left, pcm.right, pcm.sampleRate, kbps);
  // 复制一份再交给 File：Uint8Array<ArrayBufferLike> 不是 BlobPart（io.ts 同款处理）
  return new File([new Uint8Array(mp3)], mp3NameOf(file.name), { type: 'audio/mpeg' });
}

/**wav 就转成 mp3，其他格式原样返回（mp3 / ogg / flac 本来就不大） */
export async function ensureMp3(file: File, kbps = DEFAULT_MP3_KBPS): Promise<File> {
  if (!isWavName(file.name)) return file;
  return wavToMp3(file, kbps);
}
