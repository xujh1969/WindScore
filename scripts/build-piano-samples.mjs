/**
 * 钢琴采样构建管线（开发期工具，产物已提交进仓库，平时无需重跑）。
 *
 * 成熟做法 = **整段采样回放**：每个音裁到 3~8s（低音长、高音短，按自然衰减
 * 速度分配），绝大多数音符从头到尾都是真实录音，不存在「采样→合成」交接；
 * 合成延音只作两件事：采样未加载时的兜底、超过采样长度的超长音续尾。
 *
 * 数据源：Salamander Grand Piano v3（Yamaha C5 实录，Alexander Holm，
 * CC-BY 3.0）——npm 包 @audio-samples/piano-mp3-velocity12（30 个小三度
 * 采样点、第 12 力度层、44.1kHz、每音 20~30s 完整自然衰减）。
 *
 * 输出：public/piano-samples.mp3（全部音符拼接、单声道 96kbps，~2MB）
 *      public/piano-samples.json（清单：采样率 + 每音的起止样本）
 * 运行时 src/v2/pianoSamples.ts 用 AudioContext.decodeAudioData 解码
 * （浏览器原生解码会自动重采样到设备采样率），失败回退纯合成。
 *
 * 跑法：node scripts/build-piano-samples.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mp3Encoder } from '@breezystack/lamejs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const audioDir = join(root, 'node_modules/@audio-samples/piano-mp3-velocity12/audio');
const OUT_MP3 = join(root, 'public/piano-samples.mp3');
const OUT_JSON = join(root, 'public/piano-samples.json');

const NOTE_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function nameToMidi(name) {
  const m = /^([A-G])(#?)(-?\d)v12\.mp3$/.exec(name);
  if (!m) throw new Error(`无法识别的文件名 ${name}`);
  const midi = (Number(m[3]) + 1) * 12 + NOTE_SEMITONE[m[1]] + (m[2] ? 1 : 0);
  if (midi < 21 || midi > 108) throw new Error(`音高越界 ${name} → ${midi}`);
  return midi;
}

const { default: decode } = await import('audio-decode');

const files = readdirSync(audioDir).filter((f) => f.endsWith('.mp3'));
const notes = [];
for (const f of files) {
  const midi = nameToMidi(f);
  const decoded = await decode(readFileSync(join(audioDir, f)));
  const chans = decoded.channelData;
  let src = chans[0];
  if (chans.length > 1) {
    src = new Float32Array(chans[0].length);
    for (let i = 0; i < src.length; i += 1) src[i] = (chans[0][i] + chans[1][i]) / 2;
  }
  if (decoded.sampleRate !== 44100) throw new Error(`意外的采样率 ${decoded.sampleRate}（${f}）`);
  notes.push({ midi, pcm: src });
}
notes.sort((a, b) => a.midi - b.midi);
console.log(`解码 ${notes.length} 个音（44100Hz 单声道）`);

// ── 起音对齐 + 裁剪 + 淡入淡出 ────────────────────────────────
const SR = 44100;
const FADE_IN = Math.round(0.003 * SR); // 3ms 余弦淡入：削掉槌击最尖的起音边缘（音头「砸」感的来源之一）
const FADE_OUT = Math.round(0.03 * SR); // 淡出：自然衰减尾部（此时已接近不可闻）
for (const note of notes) {
  const pcm = note.pcm;
  let peak = 0;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  // 真实起音 = 短时能量的**跳变点**，不能用「超过峰值 X%」的阈值法——
  // 低码率 MP3 在槌击前会留下几十毫秒的低电平预回声拖影（-20~-30dB），
  // 阈值法会裁到它，每个音前面就挂了个幽灵倚音（0.2.113 实测）
  const HOP = 32;
  const WIN = 256;
  const winRms = (w) => {
    let e = 0;
    const s0 = w * HOP;
    for (let i = s0; i < s0 + WIN && i < pcm.length; i += 1) e += pcm[i] * pcm[i];
    return Math.sqrt(e / WIN);
  };
  const nWin = Math.floor((pcm.length - WIN) / HOP);
  let onset = -1;
  for (let w = 1; w < nWin; w += 1) {
    const r1 = winRms(w);
    const r0 = winRms(w - 1);
    if (r1 > peak * 0.12 && r1 > r0 * 3) {
      onset = w * HOP;
      break;
    }
  }
  if (onset < 0) onset = pcm.findIndex((v) => Math.abs(v) > peak * 0.02);
  const start = Math.max(0, onset - Math.round(0.002 * SR));
  const p = (note.midi - 21) / 87; // 音区 0~1
  // 裁到 3~8s：低音衰减慢裁长、高音衰减快裁短。绝大多数音符一生都在采样里，
  // 合成延音只续超过采样长度的超长音（低能量交接，听不出换源）
  const dur = 3 + 5 * (1 - p);
  const len = Math.min(Math.round(dur * SR), pcm.length - start);
  const crop = pcm.slice(start, start + len);
  for (let i = 0; i < FADE_IN; i += 1) crop[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / FADE_IN);
  for (let i = 0; i < FADE_OUT; i += 1) crop[crop.length - 1 - i] *= i / FADE_OUT;
  note.pcm = crop;

  // ── 包络整形：抹平录音自带的拍音起伏与音腹后回鼓 ────────────
  // 实测（0.2.118）：原始录音泛音衰减完后拖着一条会波动、甚至重新鼓包的
  // 宽带余波（琴体共鸣 + 底噪，A2 在 4~8s 回升到峰值的 -22dB），听感就是
  // 长音「忽大忽小」。做法与商业音色库的后期一致：平滑包络 → 重平滑后取
  // 运行最小值得到「只降不升」的衰减目标 → 增益 = 目标/实际（钳 ±4dB），
  // 把起伏压平，同时保留整体衰减形状与一点活性（不做满校正）。
  {
    const HOP = 441; // 10ms
    const WIN = 2205; // 50ms
    const nWin = Math.floor((crop.length - WIN) / HOP);
    if (nWin > 8) {
      let p2 = 0;
      for (const v of crop) p2 = Math.max(p2, Math.abs(v));
      const env = new Float64Array(nWin);
      for (let w = 0; w < nWin; w += 1) {
        let e = 0;
        const s0 = w * HOP;
        for (let i = s0; i < s0 + WIN; i += 1) e += crop[i] * crop[i];
        env[w] = Math.sqrt(e / WIN);
      }
      const S = 30; // ±300ms 重平滑：滤掉拍音周期的起伏，只留衰减趋势
      const sm = new Float64Array(nWin);
      for (let w = 0; w < nWin; w += 1) {
        let s = 0;
        let c = 0;
        for (let k = Math.max(0, w - S); k <= Math.min(nWin - 1, w + S); k += 1) {
          s += env[k];
          c += 1;
        }
        sm[w] = s / c;
      }
      const tgt = new Float64Array(nWin);
      tgt[0] = sm[0];
      for (let w = 1; w < nWin; w += 1) tgt[w] = Math.min(sm[w], tgt[w - 1]);
      const gain = new Float64Array(nWin);
      for (let w = 0; w < nWin; w += 1) {
        gain[w] = env[w] > p2 * 1e-4 ? Math.min(1.6, Math.max(0.6, tgt[w] / env[w])) : 1;
      }
      for (let i = 0; i < crop.length; i += 1) {
        const wp = i / HOP - 0.5;
        const w0 = Math.max(0, Math.min(nWin - 1, Math.floor(wp)));
        const w1 = Math.min(nWin - 1, w0 + 1);
        const u = Math.max(0, Math.min(1, wp - w0));
        crop[i] *= gain[w0] + (gain[w1] - gain[w0]) * u;
      }
    }
  }
}

// ── 全局归一（保相对响度平衡，只乘一个总系数） ────────────────
let globalPeak = 0;
for (const { pcm } of notes) for (const v of pcm) globalPeak = Math.max(globalPeak, Math.abs(v));
const gain = 0.8 / globalPeak;
console.log(`全局峰值 ${globalPeak.toFixed(3)} → 归一系数 ${gain.toFixed(3)}`);

// ── 拼接 + 编码 MP3（单文件一次编码：段间零填充对齐，清单记样本偏移） ──
const segments = notes.map((n) => {
  const out = new Float32Array(n.pcm.length);
  for (let i = 0; i < n.pcm.length; i += 1) out[i] = Math.max(-1, Math.min(1, n.pcm[i] * gain));
  return out;
});
const manifest = { sr: SR, notes: [] };
let cursor = 0;
for (let i = 0; i < notes.length; i += 1) {
  manifest.notes.push({ midi: notes[i].midi, start: cursor, len: segments[i].length });
  cursor += segments[i].length;
}
const all = new Float32Array(cursor);
for (let i = 0; i < segments.length; i += 1) all.set(segments[i], manifest.notes[i].start);

const enc = new Mp3Encoder(1, SR, 96);
const i16 = new Int16Array(all.length);
for (let i = 0; i < all.length; i += 1) {
  const v = all[i];
  i16[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
}
const chunks = [];
const BLOCK = 1152;
for (let i = 0; i < i16.length; i += BLOCK) {
  const packed = enc.encodeBuffer(i16.subarray(i, Math.min(i16.length, i + BLOCK)));
  if (packed.length > 0) chunks.push(Uint8Array.from(packed));
}
const tail = enc.flush();
if (tail.length > 0) chunks.push(Uint8Array.from(tail));
const mp3 = Buffer.concat(chunks);
writeFileSync(OUT_MP3, mp3);
writeFileSync(OUT_JSON, JSON.stringify(manifest));
const totalSec = (cursor / SR).toFixed(1);
console.log(`写出 ${OUT_MP3}：${(mp3.length / 1024 / 1024).toFixed(2)} MB（${totalSec}s 音频 @96kbps）`);
console.log(`写出 ${OUT_JSON}：${notes.length} 音，裁剪 ${notes.map((n) => (n.pcm.length / SR).toFixed(1)).join(', ')}s`);
console.log('解码后内存占用约 ' + ((cursor * 4) / 1024 / 1024).toFixed(0) + ' MB（Float32，按设备采样率还可能上浮）');
