/**
 * SFZ 采样库 → WindScore 音色包（.wsbank）转换器。
 *
 * 用法：npx esbuild 打包后 node 运行，参数写在脚本末尾的 CONFIG（样本库目录、
 * 输出文件、音色号与名字）。
 *
 * 输入要求（阿里二胡这类「一键一采样」的库最合适）：
 *   - SFZ map 文件：<region> 每块 sample/lokey/hikey/pitch_keycenter（可选 seq_position）
 *   - WAV：PCM 16/24/32-bit（int 或 float），单/立体声，任意采样率（会重采样到 44100）
 *
 * 处理：取 seq_position=1（第一轮替）→ 解码为单声道 → 找持续段做循环
 *   → 每点峰值归一到 0.35（gain=1）→ 拼接 → MP3_DELAY 补偿 → 编码 MP3
 *   → 走 prepareSamplePoints 循环治理（接缝淡化 + 电平整形，见 0.4.7）
 *   → zipStore 打包成 .wsbank（patch 用 128-255 扩展音色号）。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { Mp3Encoder } from '@breezystack/lamejs';
import { zipStore } from '../src/v2/pack';
import { prepareSamplePoints, type SamplePoint } from '../src/v2/instrumentSamples';

const SR = 44100;
/** MP3 解码域的固定延迟（内置管线同款）：解码输出比编码输入晚这么多样本 */
const MP3_DELAY = 1105;
/** 每个采样点归一的峰值 */
const PEAK = 0.35;

/* ── WAV 解码（16/24/32-bit int、32-bit float；立体声取平均） ── */
function decodeWav(bytes: Uint8Array): { pcm: Float32Array; sampleRate: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || new TextDecoder().decode(bytes.slice(0, 4)) !== 'RIFF') throw new Error('不是 WAV');
  let off = 12;
  let fmt = 1, channels = 1, sampleRate = SR, bits = 16;
  let data: Uint8Array | null = null;
  while (off + 8 <= bytes.length) {
    const id = new TextDecoder().decode(bytes.slice(off, off + 4));
    const size = dv.getUint32(off + 4, true);
    const body = bytes.slice(off + 8, off + 8 + size);
    if (id === 'fmt ') {
      fmt = dv.getUint16(off + 8, true);
      channels = dv.getUint16(off + 10, true);
      sampleRate = dv.getUint32(off + 12, true);
      bits = dv.getUint16(off + 22, true);
    } else if (id === 'data') data = body;
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error('WAV 缺 data 块');
  const n = Math.floor(data.length / (channels * (bits / 8)));
  const pcm = new Float32Array(n);
  const bps = bits / 8;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bps;
      let v = 0;
      if (fmt === 3 && bits === 32) v = dv.getFloat32(p, true);
      else if (bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (bits === 24) {
        const x = (data[p] << 8) | (data[p + 1] << 16) | (data[p + 2] << 24);
        v = x / 2147483648;
      } else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
      else if (bits === 8) v = (data[p] - 128) / 128;
      sum += v;
    }
    pcm[i] = sum / channels;
  }
  return { pcm, sampleRate };
}

/** 线性插值重采样到 44100 */
function resample(pcm: Float32Array, from: number): Float32Array {
  if (from === SR) return pcm;
  const n = Math.round((pcm.length * SR) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = (i * from) / SR;
    const i0 = Math.floor(src);
    const t = src - i0;
    out[i] = (pcm[i0] ?? 0) * (1 - t) + (pcm[i0 + 1] ?? 0) * t;
  }
  return out;
}

/* ── SFZ 解析 ── */
interface SfzRegion { sample: string; lokey: number; hikey: number; keycenter: number; seq: number }
function parseSfz(text: string, baseDir: string): SfzRegion[] {
  const out: SfzRegion[] = [];
  let cur: Partial<SfzRegion> | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('<region>')) { cur = { lokey: -1, hikey: -1, keycenter: -1, seq: 1 }; continue; }
    if (line.startsWith('<') || !cur) continue;
    const m = /^(\w+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'sample') cur.sample = resolve(baseDir, value.replace(/\\/g, '/'));
    else if (key === 'lokey') cur.lokey = Number(value);
    else if (key === 'hikey') cur.hikey = Number(value);
    else if (key === 'pitch_keycenter') cur.keycenter = Number(value);
    else if (key === 'seq_position') cur.seq = Number(value);
    if (cur.sample && cur.lokey >= 0) out.push(cur as SfzRegion);
  }
  return out;
}

/* ── 主流程 ── */
function buildBankFromSfz(cfg: {
  sfz: string;            // map 文件
  out: string;            // 输出 .wsbank
  bankName: string;       // 包名
  patch: number;          // 128-255
  label: string;          // 音色名（下拉里显示的）
  license: string;
  /** 循环段范围（占采样长度的比例）；没有内建循环的库靠它取持续段 */
  loopFrom?: number;
  loopTo?: number;
}) {
  // SFZ 里的 sample 路径自带一级 ".."（相对 Programs/），基准取 maps 上两级
  const regions = parseSfz(readFileSync(cfg.sfz, 'utf8'), dirname(cfg.sfz) + '/../..');
  // 每个键取第一轮替（seq_position 1 或缺省）
  const byKey = new Map<number, SfzRegion>();
  for (const r of regions) {
    if (r.seq !== 1) continue;
    const key = r.keycenter >= 0 ? r.keycenter : r.lokey;
    if (!byKey.has(key)) byKey.set(key, r);
  }
  const keys = [...byKey.keys()].sort((a, b) => a - b);
  if (!keys.length) throw new Error('SFZ 里没有可用 region');
  console.log(`解析到 ${keys.length} 个键（${keys[0]}–${keys[keys.length - 1]}）`);

  // 解码 + 拼接
  const chunks: Float32Array[] = [];
  const points: SamplePoint[] = [];
  let cursor = 0;
  for (const key of keys) {
    const r = byKey.get(key)!;
    const { pcm: rawPcm, sampleRate } = decodeWav(new Uint8Array(readFileSync(r.sample)));
    let pcm = resample(rawPcm, sampleRate);
    // 峰值归一
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    const g = peak > 1e-6 ? PEAK / peak : 1;
    for (let i = 0; i < pcm.length; i++) pcm[i] *= g;
    // 循环段：持续段比例（默认 35%~92%，至少 0.25s）
    const from = Math.max(0, Math.floor(pcm.length * (cfg.loopFrom ?? 0.35)));
    let to = Math.min(pcm.length - 16, Math.floor(pcm.length * (cfg.loopTo ?? 0.92)));
    if (to - from < SR * 0.25) to = Math.min(pcm.length - 16, from + Math.round(SR * 0.25));
    if (to <= from) throw new Error(`${r.sample} 太短，无法取循环段`);
    points.push({ midi: key, start: cursor, loopStart: cursor + from, loopEnd: cursor + to, length: pcm.length, gain: 1 });
    chunks.push(pcm);
    cursor += pcm.length;
  }
  const pcm = new Float32Array(cursor);
  let off = 0;
  for (const c of chunks) { pcm.set(c, off); off += c.length; }
  // MP3_DELAY 补偿
  for (const p of points) { p.start += MP3_DELAY; p.loopStart += MP3_DELAY; p.loopEnd += MP3_DELAY; }
  // 循环段治理（接缝 + 电平），与运行时同码
  prepareSamplePoints(pcm, { sampleRate: SR, points } as never);

  // MP3 编码（单声道 192kbps）
  const int16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) int16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
  const enc = new Mp3Encoder(1, SR, 192);
  const mp3Parts: Uint8Array[] = [];
  const BLOCK = 1152 * 20;
  for (let i = 0; i < int16.length; i += BLOCK) {
    const buf = enc.encodeBuffer(int16.subarray(i, Math.min(int16.length, i + BLOCK)));
    if (buf.length) mp3Parts.push(new Uint8Array(buf));
  }
  const tail = enc.flush();
  if (tail.length) mp3Parts.push(new Uint8Array(tail));
  const mp3 = Buffer.concat(mp3Parts.map((u) => Buffer.from(u)));

  const jsonName = `${cfg.name}.json`;
  const mp3Name = `${cfg.name}.mp3`;
  const manifest = {
    kind: 'windscore-soundbank' as const,
    version: 1 as const,
    name: cfg.bankName,
    license: cfg.license,
    instruments: [{ patch: cfg.patch, label: cfg.label, mp3: mp3Name, json: jsonName }],
  };
  const instJson = { sampleRate: SR, label: cfg.label, patch: cfg.patch, points };
  const zip = zipStore([
    { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest)) },
    { name: jsonName, data: new TextEncoder().encode(JSON.stringify(instJson)) },
    { name: mp3Name, data: mp3 },
  ]);
  writeFileSync(cfg.out, zip);
  console.log(`已生成 ${cfg.out}（${(zip.length / 1024 / 1024).toFixed(1)}MB，patch ${cfg.patch} ${cfg.label}，${points.length} 个采样点）`);
}

/* ── 配置：阿里二胡（CC0） ── */
const ROOT = resolve('.tmp-erhu/aliexpress-erhu-main');
buildBankFromSfz({
  sfz: join(ROOT, 'Programs/modules/maps/erhu_sus_map.sfz'),
  out: 'artifacts/releases/音色库/WindScore-音色包-开源民乐-二胡.wsbank',
  bankName: '开源民乐·二胡（Aliexpress Erhu, CC0）',
  patch: 128,
  label: '二胡（真采样）',
  license: 'CC0 1.0（sfzinstruments/aliexpress-erhu）',
});
