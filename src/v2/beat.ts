/**
 * 浏览器传统节拍识别：多频带起音 + 周期候选 + 动态规划逐拍跟踪。
 * 谱面速度仅作软先验，谱面长度不参与速度选择；UI 通过 Worker 分析全曲。
 * 恒速拍链可拟合为 BPM/相位，否则输出 beatTimes；谱面原点另外匹配。
 */
import { TICKS_PER_BEAT } from './ticks';
import type { Score } from './types';
import { trackBeatEnvelope, type BeatCandidate } from './beatTracker';

const N = 1024; // FFT 窗长
const HOP = 256; // 帧移
const TARGET_SR = 11025; // 保留 5.5kHz 以下起音信息，降低全曲分析算力。
const MAX_SECONDS = Infinity; // 全曲逐拍跟踪；UI 在 Worker 中分析。

export interface TempoEstimate {
  beatTimes: number[];
  candidates: BeatCandidate[];
  ambiguous: boolean;
  support: number;
  bpm: number;
  /** 音频网格相位（秒）：第 0 拍落在音频的哪里 */
  phaseSec: number;
  /**
   * 谱面原点（音频拍）：谱面第 0 拍 = 音频第几拍。
   * 靠**谱面音符起拍的节奏型**在音频 onset 包络上滑动匹配出来（梳状滤波），
   * 不需要人工锚点。null = 没匹配上（谱面太短 / 音频没这段 / 谱面与音频不是同一首）。
   */
  originBeat: number | null;
  /** 原点的匹配强度（梳状得分 − 局部均值），越大越可信；≤0 表示没比随机强 */
  originScore: number;
  /**
   * 谱面时长 / 音频时长。仅供诊断，不能据此判断速度档或自动更改谱面。
   */
  spanRatio: number;
  /** 恒速判定：分段精化的各段 BPM（空 = 音频太短没法定） */
  segments: number[];
  /** 局部周期 BPM 的极差；与拍链拟合误差共同判断恒速 */
  drift: number;
  /** true = 恒定，false = 疑似变速，null = 段数不足没法定 */
  isConstant: boolean | null;
  /** 拍链支持与周期相关性的综合证据 0–1，不是概率或准确率 */
  confidence: number;
  /** 峰到最近拍点的 RMS 残差（毫秒） */
  residualMs: number;
  /** 落在恒速拍点附近（±1/10 拍）的峰占比 0–1 */
  hitRatio: number;
  /** 参与计算的 onset 峰个数（太少说明这段音频没什么节奏） */
  peakCount: number;
}

/** 降到 ~11kHz：整数倍抽取后块平均，降低高频混叠（不是理想低通） */
function downsample(x: Float32Array, sr: number): { data: Float32Array; sr: number } {
  if (sr <= TARGET_SR) return { data: x, sr };
  const r = Math.max(1, Math.round(sr / TARGET_SR));
  const outLen = Math.floor(x.length / r);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    let s = 0;
    for (let k = 0; k < r; k += 1) s += x[i * r + k];
    out[i] = s / r;
  }
  return { data: out, sr: sr / r };
}

/** 波形平均；检测严重相消时退回能量最强声道。 */
export function mixdown(buffer: AudioBuffer): Float32Array {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const out = new Float32Array(len);
  if (ch === 1) return buffer.getChannelData(0).slice();
  for (let c = 0; c < ch; c += 1) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i += 1) out[i] += d[i] / ch;
  }
  let mixedEnergy = 0, strongestEnergy = 0, strongest = 0;
  for (let i = 0; i < len; i += 16) mixedEnergy += out[i] * out[i];
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    let energy = 0;
    for (let i = 0; i < len; i += 16) energy += d[i] * d[i];
    if (energy > strongestEnergy) { strongestEnergy = energy; strongest = c; }
  }
  if (mixedEnergy < strongestEnergy * 0.1) return buffer.getChannelData(strongest).slice();
  return out;
}

/** 汉宁窗 */
function hanning(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** 预计算旋转因子：e^{-2πik/n}，各阶段按步长取用（比逐次三角函数快得多） */
function twiddles(n: number): { cos: Float64Array; sin: Float64Array } {
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k += 1) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n);
    sin[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  return { cos, sin };
}

/** 原地基 2 FFT（n 必须是 2 的幂） */
function fft(re: Float64Array, im: Float64Array, tw: { cos: Float64Array; sin: Float64Array }): void {
  const n = re.length;
  // 位反转置换
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k += 1) {
        const wr = tw.cos[k * stride];
        const wi = tw.sin[k * stride];
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + half];
        const bi = im[i + k + half];
        const vr = br * wr - bi * wi;
        const vi = br * wi + bi * wr;
        re[i + k] = ar + vr;
        im[i + k] = ai + vi;
        re[i + k + half] = ar - vr;
        im[i + k + half] = ai - vi;
      }
    }
  }
}

/**
 * 多频带对数谱流：正差分 → 各带归一 → 局部基线 → 合并并平滑。
 */
export function onsetEnvelope(
  x: Float32Array,
  sr: number,
  n = N,
  hop = HOP,
): { env: Float64Array; t0Sec: number; hopSec: number } {
  const nfr = 1 + Math.floor((x.length - n) / hop);
  const env = new Float64Array(Math.max(nfr - 1, 0));
  const win = hanning(n);
  const tw = twiddles(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const prev = new Float64Array(n / 2 + 1);
  const bands = Array.from({ length: 4 }, () => new Float64Array(env.length));

  for (let f = 0; f < nfr; f += 1) {
    const off = f * hop;
    for (let i = 0; i < n; i += 1) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im, tw);
    for (let i = 0; i <= n / 2; i += 1) {
      const m = Math.log1p(Math.hypot(re[i], im[i]) * 10);
      const delta = Math.max(0, m - prev[i]);
      const hz = i * sr / n;
      const band = hz < 200 ? 0 : hz < 1000 ? 1 : hz < 3000 ? 2 : 3;
      if (f > 0) bands[band][f - 1] += delta;
      prev[i] = m;
    }
  }

  // 各频带单独归一，防止低频贝斯或高频镲片独占全部起音证据。
  env.fill(0);
  for (const band of bands) {
    const sortedBand = Float64Array.from(band).sort();
    const norm = sortedBand[Math.floor(sortedBand.length * 0.9)] || sortedBand[sortedBand.length - 1] || 1;
    const prefix = new Float64Array(band.length + 1);
    for (let i = 0; i < band.length; i++) prefix[i + 1] = prefix[i] + band[i];
    const radius = Math.round(sr / hop / 2);
    for (let i = 0; i < env.length; i++) {
      const a = Math.max(0, i - radius), b = Math.min(env.length, i + radius + 1);
      const baseline = (prefix[b] - prefix[a]) / (b - a);
      env[i] += Math.min(4, Math.max(0, band[i] - baseline * 0.6) / norm);
    }
  }

  // 局部基线已在频带内移除；不用全曲阈值抹掉柔和前奏。
  for (let i = 0; i < env.length; i++) env[i] = Math.log1p(env[i] * 2);
  const k = hanning(5);
  let ks = 0;
  for (let i = 0; i < 5; i += 1) ks += k[i];
  const smoothed = new Float64Array(env.length);
  for (let i = 0; i < env.length; i += 1) {
    let acc = 0;
    for (let j = -2; j <= 2; j += 1) {
      const idx = i + j;
      if (idx >= 0 && idx < env.length) acc += env[idx] * k[j + 2];
    }
    smoothed[i] = acc / ks;
  }
  // 峰时刻用窗中心（对齐 align.py 的口径）：窗是往前滑过固定脉冲的，
  // 脉冲从窗尾进、走到窗中心时权重最大；而 flux 是**差分**，极值出现在斜率最大处
  // = 脉冲位于窗内 3/4 处，所以这个口径比真实 onset 早 ~n/4（11k 下约 23ms）。
  // 不在这里补这个常数：真实音频的 attack 不是理想脉冲，补了反而可能更偏。
  // 相位只是估测起点，用户钉一个锚点后原点会把它吸收掉。
  return { env: smoothed, t0Sec: (hop + n / 2) / sr, hopSec: hop / sr };
}

/**
 * 超过局部自适应阈值的包络极大时刻（秒）。
 *
 * 取局部极大而不是「所有过阈值的帧」：过阈值的帧在峰两侧连成一小片平台，
 * 把它们全算进去会重复统计同一次起音。
 * 再对峰做一次抛物线插值，把时刻定到亚帧精度。
 */
function onsetPeaks(env: Float64Array, t0Sec: number, hopSec: number): Float64Array {
  if (env.length < 3) return new Float64Array(0);
  const prefix = new Float64Array(env.length + 1);
  for (let i = 0; i < env.length; i++) prefix[i + 1] = prefix[i] + env[i];
  const sorted = Float64Array.from(env).sort();
  const floor = sorted[Math.floor(sorted.length * 0.5)] * 0.5;
  const times: number[] = [];
  for (let i = 1; i < env.length - 1; i += 1) {
    const y = env[i];
    const radius = Math.round(0.5 / hopSec);
    const a = Math.max(0, i - radius), b = Math.min(env.length, i + radius + 1);
    const thr = (prefix[b] - prefix[a]) / (b - a) * 1.2;
    if (!(y >= env[i - 1] && y > env[i + 1])) continue;
    if (y <= Math.max(thr, floor, 1e-8)) continue;
    // 抛物线插值：用三点的曲率把峰定到帧之间
    const denom = env[i - 1] - 2 * y + env[i + 1];
    const delta = denom !== 0 ? (0.5 * (env[i - 1] - env[i + 1])) / denom : 0;
    times.push(t0Sec + (i + Math.max(-0.5, Math.min(0.5, delta))) * hopSec);
  }
  return Float64Array.from(times);
}

/** 圆周相位聚拢度：候选 BPM 下所有峰折到一拍内，R 越大说明这个 BPM 越对 */
function phaseScore(peaks: Float64Array, bpm: number): { R: number; frac: number } {
  const beat = 60 / bpm;
  let c = 0;
  let s = 0;
  for (let i = 0; i < peaks.length; i += 1) {
    const ang = ((peaks[i] / beat) % 1) * 2 * Math.PI;
    c += Math.cos(ang);
    s += Math.sin(ang);
  }
  c /= peaks.length;
  s /= peaks.length;
  const R = Math.hypot(c, s);
  // 相位：cos/sin 均值的主方向（取模到 [0,1)）
  const frac = ((Math.atan2(s, c) / (2 * Math.PI)) % 1 + 1) % 1;
  return { R, frac };
}

function gridSearch(
  peaks: Float64Array,
  lo: number,
  hi: number,
  step: number,
): { R: number; bpm: number; phaseSec: number } {
  let best = { R: -1, bpm: lo, phaseSec: 0 };
  for (let bpm = lo; bpm <= hi; bpm += step) {
    const { R, frac } = phaseScore(peaks, bpm);
    if (R > best.R) best = { R, bpm, phaseSec: frac * (60 / bpm) };
  }
  return best;
}

/** 质量自报：峰到最近拍点的 RMS 距离（ms）+ 落拍比例（align.py 的 grid_residual_ms） */
function residual(peaks: Float64Array, bpm: number, phaseSec: number): { ms: number; hit: number } {
  const beat = 60 / bpm;
  let sum = 0;
  let hit = 0;
  for (let i = 0; i < peaks.length; i += 1) {
    const rel = ((peaks[i] - phaseSec) / beat) % 1;
    const d = Math.min(Math.abs(rel), 1 - Math.abs(rel)) * beat; // 到最近拍点的距离（秒）
    sum += d * d;
    if (d < beat * 0.1) {
      hit += 1;
    }
  }
  const n = Math.max(1, peaks.length);
  return { ms: Math.sqrt(sum / n) * 1000, hit: hit / Math.max(1, peaks.length) };
}

// ── 恒速判定与人声进入检测（align.py 的移植） ──────────────────

/**
 * 恒速判定（align.py `segment_bpms` 的移植）：音频分若干段，
 * 每段各自在全局值 ±2 BPM 内精化，返回各段 BPM。
 * 与 align.py 的差异：段数按「每段 ≥5s」自适应（2–10 段），
 * 短音频也能出判定，不再整段跳过。
 */
export function segmentBpms(x: Float32Array, sr: number, bpm0: number, segments = 10): number[] {
  const out: number[] = [];
  const segLen = Math.floor(x.length / segments);
  const minLen = Math.floor(sr * 5);
  for (let k = 0; k < segments; k += 1) {
    const part = x.subarray(k * segLen, Math.min(x.length, (k + 1) * segLen));
    if (part.length < minLen) continue; // 段太短不出数
    const { env, t0Sec, hopSec } = onsetEnvelope(part, sr);
    // 峰提取用 align.py 的**原口径**（所有过 90 分位的帧，不做局部极大）：
    // 平台帧群聚在同一相位上，不影响圆周均值；而局部极大口径在短段上
    // 实测会多出 ±1.5 BPM 的漂移，把恒速歌误判成变速（青花瓷实测）。
    let mean = 0;
    for (let i = 0; i < env.length; i += 1) mean += env[i];
    mean /= env.length;
    const sortedEnv = Float64Array.from(env).sort();
    const thr = sortedEnv[Math.floor(sortedEnv.length * 0.9)];
    const pk: number[] = [];
    for (let i = 0; i < env.length; i += 1) {
      if (env[i] > mean && env[i] > thr) pk.push(t0Sec + i * hopSec);
    }
    if (pk.length < 8) continue;
    out.push(gridSearch(Float64Array.from(pk), Math.max(30, bpm0 - 2), bpm0 + 2, 0.01).bpm);
  }
  return out;
}

/**
 * 两端各裁掉 trim_ratio 后的极差（align.py `trimmed_spread`）：
 * 首段（前奏峰稀疏）/ 末段（渐弱）不可信，裁掉再比。
 */
export function trimmedSpread(vals: number[], trimRatio = 0.2): number {
  if (vals.length === 0) return 99;
  if (vals.length < 5) return Math.max(...vals) - Math.min(...vals);
  const s = [...vals].sort((a, b) => a - b);
  const k = Math.floor(s.length * trimRatio);
  return s[s.length - 1 - k] - s[k];
}

/**
 * 人声进入点（align.py `vocal_entry_sec` 的移植）：人声分轨在进声前近乎静音，
 * 用短窗 RMS 的「持续越过阈值」判定。阈值 8%：换气 / 气声不算进声；
 * 返回**窗中心**时刻，与 onset 峰的口径一致。
 */
export function vocalEntrySec(x: Float32Array, sr: number, winS = 0.05, ratio = 0.08): number | null {
  const w = Math.max(1, Math.floor(sr * winS));
  const hop = Math.max(1, Math.floor(w / 5));
  const n = Math.floor((x.length - w) / hop);
  if (n <= 0) return null;
  const rms = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let acc = 0;
    for (let k = 0; k < w; k += 1) acc += x[i * hop + k] * x[i * hop + k];
    rms[i] = Math.sqrt(acc / w);
  }
  let max = 0;
  for (let i = 0; i < n; i += 1) if (rms[i] > max) max = rms[i];
  const thr = max * ratio;
  const need = 4; // 连续 4 窗（≈0.2s）才算真的进声
  for (let i = 0; i + need < n; i += 1) {
    if (rms[i] > thr && rms[i + 1] > thr && rms[i + 2] > thr && rms[i + 3] > thr) {
      return (i * hop + w / 2) / sr;
    }
  }
  return null;
}

/** AudioBuffer → 人声进入点（秒）；没有就把 null 交给调用方 */
export function detectVocalEntry(buffer: AudioBuffer): number | null {
  return vocalEntrySec(mixdown(buffer), buffer.sampleRate);
}

/** 谱面音符的**起拍位**（拍，谱面坐标）——与 scripts/align-facts.ts 同口径 */
export function scoreNoteOnsets(score: Score): number[] {
  let tick = 0;
  const out: number[] = [];
  for (const e of score.events) {
    if (e.kind === 'note') out.push(tick / TICKS_PER_BEAT);
    if (e.kind === 'note' || e.kind === 'rest') tick += e.ticks;
  }
  return out;
}

/**
 * 原点匹配（align.py `match_origin` 的移植，梳状滤波）。
 *
 * 把谱面前若干个音符的起拍节奏型当模板，在 onset 包络上滑动：
 * 模板对上时，每个音符起拍都踩在包络峰上 → 平均包络值最大。
 * 只比均值会被「密集响段」骗（那里处处都高），所以减掉同一区间的**局部均值**。
 *
 * 候选里取**最早的 95% 强度匹配**：谱面从头记谱，理应对上最早的那次
 * （主题在歌里重复时会有多个强峰）。
 */
/**
 * 谱面起点模板：前 20 拍 / 48 个音符的起拍节奏型（与 matchOrigin 同口径）。
 * 开头若是密集十六分音符，前几个音只覆盖 3 拍，滑到任何密集段都能「对上」，
 * 所以模板必须跨够拍数才可判别。
 */
export function originTemplate(noteOnsets: number[]): number[] | null {
  const tmpl: number[] = [noteOnsets[0]];
  for (let i = 1; i < noteOnsets.length; i += 1) {
    tmpl.push(noteOnsets[i]);
    if (noteOnsets[i] - noteOnsets[0] >= 20 || tmpl.length >= 48) break;
  }
  return tmpl.length < 6 ? null : tmpl;
}

/** 单个原点的梳状得分（模板落在包络峰上 + 分，模板之间 − 分） */
function combAt(
  at: (sec: number) => number,
  tmpl: number[],
  step: number,
  phaseSec: number,
  origin: number,
): number {
  const times = tmpl.map((u) => phaseSec + (origin + u) * step);
  let on = 0;
  for (const t of times) on += at(t);
  on /= times.length;
  let base = 0;
  let n = 0;
  for (let t = times[0]; t <= times[times.length - 1]; t += 0.02) {
    base += at(t);
    n += 1;
  }
  return on - base / Math.max(1, n);
}

function matchOrigin(
  env: Float64Array,
  t0Sec: number,
  hopSec: number,
  noteOnsets: number[],
  bpm: number,
  phaseSec: number,
  originMax: number,
): { originBeat: number; score: number } | null {
  const tmpl = originTemplate(noteOnsets);
  if (!tmpl) return null;

  const tEnd = t0Sec + (env.length - 1) * hopSec;
  const at = (sec: number): number => {
    const x = (sec - t0Sec) / hopSec;
    if (x <= 0) return env[0];
    if (x >= env.length - 1) return env[env.length - 1];
    const i = Math.floor(x);
    return env[i] + (env[i + 1] - env[i]) * (x - i);
  };
  const step = 60 / bpm;
  const comb = (origin: number): number => combAt(at, tmpl, step, phaseSec, origin);

  const cands: { score: number; origin: number }[] = [];
  for (let o = 0; o <= originMax; o += 0.25) {
    if (phaseSec + (o + tmpl[tmpl.length - 1]) * step > tEnd) break;
    cands.push({ score: comb(o), origin: o });
  }
  if (cands.length === 0) return null;
  const top = Math.max(...cands.map((c) => c.score));
  // 阈值：正分数按 95% 取；**负分数**（整段都对不上，真实伴奏上会遇到）要按幅度算，
  // 否则「0.95 × 负数」比最大值还大 → 筛成空数组 → 下面的 reduce 直接抛异常
  const cut = top > 0 ? top * 0.95 : top - Math.abs(top) * 0.05 - 1e-9;
  const strong = cands.filter((c) => c.score >= cut);
  if (strong.length === 0) return null;
  // 峰值必须**突出**才认：均匀的脉冲串（鼓机/纯节拍）能把任何节奏型都「对上」，
  // 那种情况下几乎所有原点都落在 95% 里（实测 18%），而真匹配只有 1%。
  // 不判这一条，谱面与音频毫无关系时也会自信地报一个原点。
  if (cands.length >= 20 && strong.length / cands.length > 0.1) return null;
  let best = strong.reduce((a, b) => (b.origin < a.origin ? b : a));
  // 0.05 拍步进细化
  for (let o = Math.max(0, best.origin - 0.5); o <= best.origin + 0.5; o += 0.05) {
    const v = comb(o);
    if (v > best.score) best = { score: v, origin: o };
  }
  return { originBeat: Math.round(best.origin * 100) / 100, score: Math.round(best.score * 1000) / 1000 };
}

/**
 * 估测恒定 BPM 与相位；给了谱面音符起拍就**连原点一起算出来**（不需要人工锚点）。
 * 样本太短 / 没有节奏峰 → 返回 null（不给一个假的数）。
 */
export function estimateTempo(
  samples: Float32Array,
  sampleRate: number,
  opts?: {
    bpmLo?: number;
    bpmHi?: number;
    maxSeconds?: number;
    noteOnsets?: number[];
    /** 谱面总拍数（含休止）：判「谱面铺满整首」用 */
    scoreBeats?: number;
    /**
     * 谱面 @bpm 是速度候选排序的软参考，不能覆盖音频证据。
     */
    scoreBpm?: number;
    /** 强制按这个 BPM 对齐（「按谱面速度对齐」按钮）：跳过网格搜索，只定相位与原点 */
    fixedBpm?: number;
  },
): TempoEstimate | null {
  const lo = opts?.bpmLo ?? 55;
  const hi = opts?.bpmHi ?? 200;
  const maxSec = opts?.maxSeconds ?? MAX_SECONDS;

  const cut = Math.min(samples.length, Math.floor(sampleRate * maxSec));
  const mono = samples.subarray(0, cut);
  const { data, sr } = downsample(mono, sampleRate);
  if (data.length < sr * 4) return null; // < 4s 没法定
  /** 全曲时长（不是被截断到 maxSeconds 的分析段）：原点搜索范围要按它算 */
  const durSec = samples.length / sampleRate;

  const { env, t0Sec, hopSec } = onsetEnvelope(data, sr);
  const peaks = onsetPeaks(env, t0Sec, hopSec);
  if (peaks.length < 16) return null;

  const tracked = trackBeatEnvelope(env, hopSec, t0Sec, {
    lo, hi, hint: opts?.scoreBpm, fixed: opts?.fixedBpm,
  });
  if (tracked.beatTimes.length < 8) return null;
  let bpm = tracked.bpm;
  const times = tracked.beatTimes;
  // 用整条拍链拟合速度与相位；只有链条接近直线才采用恒速形式。
  const meanIndex = (times.length - 1) / 2;
  const meanTime = times.reduce((a, b) => a + b, 0) / times.length;
  let cov = 0, variance = 0;
  for (let i = 0; i < times.length; i++) { cov += (i - meanIndex) * (times[i] - meanTime); variance += (i - meanIndex) ** 2; }
  const step = opts?.fixedBpm ? 60 / opts.fixedBpm : cov / variance;
  const intercept = meanTime - meanIndex * step;
  const fitError = Math.sqrt(times.reduce((sum, t, i) => sum + (t - intercept - i * step) ** 2, 0) / times.length);
  const drift = tracked.segments.length ? Math.max(...tracked.segments) - Math.min(...tracked.segments) : 0;
  const isConstant = !!opts?.fixedBpm || (fitError < 0.04 && drift < 1.5);
  if (isConstant && !opts?.fixedBpm) bpm = 60 / step;
  const phaseSec = isConstant ? ((intercept % step) + step) % step : times[0];
  const beatTimes = isConstant ? times.map((_, i) => intercept + i * step) : times;
  let originBeat: number | null = null;
  let originScore = 0;
  // 节拍和谱面起点独立判断；不再用整首长度强行选择倍速或放宽匹配。
  if (isConstant && opts?.noteOnsets && opts.noteOnsets.length >= 6) {
    const originMax = Math.max(0, durSec * bpm / 60 - Math.max(...opts.noteOnsets));
    const match = matchOrigin(env, t0Sec, hopSec, opts.noteOnsets, bpm, phaseSec, originMax);
    if (match && match.score > 0.15) { originBeat = match.originBeat; originScore = match.score; }
  }
  const quality = residual(peaks, bpm, phaseSec);
  return {
    bpm: Math.round(bpm * 100) / 100,
    phaseSec: Math.round(phaseSec * 1000) / 1000,
    originBeat, originScore,
    spanRatio: originBeat !== null && opts?.scoreBeats ? opts.scoreBeats * 60 / bpm / Math.max(1, durSec - phaseSec - originBeat * 60 / bpm) : 0,
    segments: tracked.segments, drift, isConstant,
    confidence: tracked.confidence, support: tracked.support,
    residualMs: Math.round(quality.ms * 10) / 10, hitRatio: quality.hit,
    peakCount: peaks.length, beatTimes, candidates: tracked.candidates, ambiguous: tracked.ambiguous,
  };
}

/** AudioBuffer → 同步估测；UI 使用 beatClient 的 Worker 入口。 */
export function estimateTempoOfBuffer(
  buffer: AudioBuffer,
  opts?: {
    noteOnsets?: number[];
    scoreBeats?: number;
    /** 谱面 @bpm：倍频歧义的先验 */
    scoreBpm?: number;
    /** 强制按这个速度对齐（跳过网格搜索） */
    fixedBpm?: number;
  },
): TempoEstimate | null {
  return estimateTempo(mixdown(buffer), buffer.sampleRate, opts);
}
