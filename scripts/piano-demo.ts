/**
 * 音色对比试听：同一串音分别用「纯合成」与「真实整段采样」渲染，
 * 输出两个 WAV 到 artifacts/demo/，供耳朵验收。
 *
 * 跑法：npx esbuild scripts/piano-demo.ts --bundle --platform=node --format=esm
 *       --external:audio-decode --outfile=.tmp-piano-demo.mjs --log-level=error
 *       && node .tmp-piano-demo.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import decode from 'audio-decode';
import { renderNote, pianoSpec } from '../src/v2/timbre';
import { type PianoSample, setPianoSamplesForTest, clearPianoSamplesForTest } from '../src/v2/pianoSamples';

const SR = 48000; // 浏览器 AudioContext 常见采样率：demo 用它验收真实条件下的音高
const TOTAL = 8.2;

// A3 单音 → 升一个半音（听变调接缝）→ A4 长音 → 和弦 → 低音 A2
const NOTES: { midi: number; t: number; dur: number; dyn?: number }[] = [
  { midi: 57, t: 0.0, dur: 0.9 },
  { midi: 58, t: 1.0, dur: 0.9 },
  { midi: 69, t: 2.0, dur: 1.6 },
  { midi: 64, t: 3.8, dur: 1.4, dyn: 0.7 },
  { midi: 69, t: 3.8, dur: 1.4, dyn: 0.9 },
  { midi: 45, t: 5.4, dur: 2.2, dyn: 1 },
];

/** 与 build-piano-samples.mjs 的清单格式一致 */
interface Manifest {
  sr: number;
  notes: { midi: number; start: number; len: number }[];
}

async function loadSamples(): Promise<boolean> {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'public', 'piano-samples.json'), 'utf-8'),
  ) as Manifest;
  const buf = readFileSync(join(process.cwd(), 'public', 'piano-samples.mp3'));
  const decoded = await decode(new Uint8Array(buf).buffer as ArrayBuffer);
  // audio-decode 返回 { channelData: Float32Array[], sampleRate }，与 Web Audio 的 AudioBuffer 略异
  const ch = decoded.channelData[0]!;
  const ratio = decoded.sampleRate / manifest.sr;
  const notes: PianoSample[] = manifest.notes.map((n) => ({
    midi: n.midi,
    sr: decoded.sampleRate,
    pcm: ch.subarray(Math.round(n.start * ratio), Math.round((n.start + n.len) * ratio)),
  }));
  setPianoSamplesForTest(notes);
  return notes.length > 0;
}

function renderMix(withSamples: boolean): Float32Array {
  if (!withSamples) clearPianoSamplesForTest();
  const out = new Float32Array(Math.round(TOTAL * SR));
  for (const n of NOTES) {
    const pcm = renderNote(pianoSpec(n.midi, n.dyn ?? 1), { sampleRate: SR, durationSec: n.dur, dyn: n.dyn ?? 1 });
    const off = Math.round(n.t * SR);
    for (let i = 0; i < pcm.length && off + i < out.length; i += 1) out[off + i] += pcm[i]!;
  }
  // 轻限幅，避免叠加处削顶
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.95) for (let i = 0; i < out.length; i += 1) out[i] *= 0.95 / peak;
  return out;
}

function writeWav(path: string, pcm: Float32Array): void {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const str = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm.length; i += 1) dv.setInt16(44 + i * 2, Math.round(pcm[i]! * 32767), true);
  writeFileSync(path, Buffer.from(buf));
}

const dir = join(process.cwd(), 'artifacts', 'demo');
mkdirSync(dir, { recursive: true });
writeWav(join(dir, 'piano-synth.wav'), renderMix(false));
const ok = await loadSamples();
if (!ok) {
  console.error('采样装载失败，piano-hybrid.wav 将与 synth 相同');
}
writeWav(join(dir, 'piano-hybrid.wav'), renderMix(true));
clearPianoSamplesForTest();
console.log(`试听文件已生成：${dir}`);
console.log('  piano-synth.wav  纯合成（兜底音色）');
console.log('  piano-hybrid.wav 真实整段采样（全衰减回放，仅超长音由合成续尾）');
console.log('内容：A3 / 升半音 A3（听变调接缝）/ A4 长音 / E4+A4 和弦 / A2 低音');
