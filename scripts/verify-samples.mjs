// 验证抽取的采样：①循环接缝突变 ②**音头不能带前导音块**（MP3 延迟没补时会混入
// 另一个音高的稳态尾巴，听起来每个音前面「咚 / 铛」一下）③生成试听 WAV
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import decode from 'audio-decode';

const SR = 44100;
const PATCHES = [21, 22, 40, 65, 66, 73];
/** 每件用一小段音阶试听（比单音好辨别音色像不像） */
const PHRASE = [60, 62, 64, 65, 67];

/** 运行时渲染逻辑的镜像：最近采样点 + 变调比率 + 循环平铺 + 尾部淡出 */
function renderSampled(mp3Pcm, point, midi, durationSec) {
  const ratio = 2 ** ((midi - point.midi) / 12);
  const outN = Math.round(durationSec * SR);
  const out = new Float32Array(outN);
  const loopLen = point.loopEnd - point.loopStart;
  const read = (idx) => {
    if (idx < point.loopStart) return idx >= point.start ? mp3Pcm[idx] : 0;
    return mp3Pcm[point.loopStart + (((idx - point.loopStart) % loopLen) + loopLen) % loopLen];
  };
  for (let i = 0; i < outN; i++) {
    const src = point.start + i * ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    out[i] = read(i0) * (1 - frac) + read(i0 + 1) * frac;
  }
  const fade = Math.round(0.09 * SR);
  for (let i = 0; i < fade; i++) out[outN - fade + i] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / fade);
  return out;
}

const rms = (x, from, to) => {
  let acc = 0;
  for (let i = from; i < to; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / Math.max(1, to - from));
};

let allOk = true;
const demoChunks = [];
for (const patch of PATCHES) {
  const manifest = JSON.parse(readFileSync(`public/instrument-samples/${patch}.json`, 'utf8'));
  const bytes = readFileSync(`public/instrument-samples/${patch}.mp3`);
  const buf = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const pcm = buf.channelData?.[0] ?? buf.getChannelData(0);
  const midi = 60;
  let point = manifest.points[0];
  for (const p of manifest.points) if (Math.abs(p.midi - midi) < Math.abs(point.midi - midi)) point = p;
  const dur = 4;
  const out = renderSampled(pcm, point, midi, dur);

  // ① 音头检查：起音应从静默起，前 5ms 明显低于 20~80ms（有前导音块的话两者会持平）
  const head5 = rms(out, 0, Math.round(0.005 * SR));
  const body = rms(out, Math.round(0.02 * SR), Math.round(0.08 * SR));
  const headOk = head5 < body * 0.35;
  // ② 接缝检查：循环边界的采样间跳变不超过全曲最大跳变
  const ratio = 2 ** ((midi - point.midi) / 12);
  let maxJump = 0;
  for (let i = 1; i < out.length; i++) {
    const j = Math.abs(out[i] - out[i - 1]);
    if (j > maxJump) maxJump = j;
  }
  const loopLen = Math.round((point.loopEnd - point.loopStart) / ratio);
  const firstSeam = Math.round((point.loopStart - point.start) / ratio);
  let seamPeak = 0;
  for (let b = firstSeam; b < out.length; b += loopLen) {
    for (let k = -2; k <= 2; k++) {
      const i = Math.round(b) + k;
      if (i > 0 && i < out.length) seamPeak = Math.max(seamPeak, Math.abs(out[i] - out[i - 1]));
    }
  }
  const seamOk = seamPeak <= maxJump * 1.5 + 0.01;
  const ok = headOk && seamOk;
  if (!ok) allOk = false;
  console.log(
    `${manifest.label}: 音头 RMS ${head5.toFixed(4)} / 主体 ${body.toFixed(4)} ${headOk ? 'OK' : '有前导音块'}，` +
      `接缝 ${seamPeak.toFixed(4)} / 最大跳变 ${maxJump.toFixed(4)} ${seamOk ? 'OK' : '可疑'}`,
  );

  // 试听：一小段音阶，每音 0.5s
  for (const m of PHRASE) {
    let pt = manifest.points[0];
    for (const p of manifest.points) if (Math.abs(p.midi - m) < Math.abs(pt.midi - m)) pt = p;
    demoChunks.push(renderSampled(pcm, pt, m, 0.5));
  }
  demoChunks.push(new Float32Array(Math.round(0.25 * SR)));
}
mkdirSync('artifacts/demo', { recursive: true });
const total = demoChunks.reduce((a, c) => a + c.length, 0);
const wav = Buffer.alloc(44 + total * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + total * 2, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(total * 2, 40);
let o = 44;
for (const c of demoChunks) for (let i = 0; i < c.length; i++) {
  const v = Math.max(-1, Math.min(1, c[i]));
  wav.writeInt16LE(v < 0 ? v * 0x8000 : v * 0x7fff, o); o += 2;
}
writeFileSync('artifacts/demo/instruments-phrase.wav', wav);
console.log(`\n试听：artifacts/demo/instruments-phrase.wav（手风琴→口琴→小提琴→中音萨→次中音萨→长笛，各 5 个音音阶）`);
console.log(allOk ? '全部通过' : '有未通过项');
process.exit(allOk ? 0 : 1);
