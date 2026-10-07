/**
 * 浏览器端 BPM / 相位估测（导入伴奏后当场算，不再只能等 Python）。
 *
 * 算法与 `scripts/align.py` 同源（决策 A8），口径逐行对齐：
 *   ① onset 强度包络：谱流正向差分（spectral flux），半波整流 → 压缩 → 平滑
 *   ② 取包络 90 分位以上的峰，峰时刻用**窗中心**（f*hop + n/2）
 *   ③ 网格搜索 55–200 BPM：每个候选 BPM 下把所有峰折到圆周上算聚拢度 R，最大者即真 BPM
 *      （R = |mean(e^{i2πφ})|，φ 是峰在一拍里的相位；BPM 猜对了峰才会挤在一起）
 *   ④ 在 ±0.1 BPM 内以 0.002 步长细化一轮
 *   ⑤ 质量自报：峰到最近拍点的 RMS 残差（ms）与落拍比例——用来判断「这个数能不能信」
 *
 * 与离线标定文件的分工：这里是**当场估个大概**（几秒内出数，用来把谱面速度改对）；
 * 精确对齐仍可导入 align.json 对齐参数文件（旧版离线管线或人工标定产出）。
 *
 * 纯函数、不碰 AudioContext：入参是 Float32Array + 采样率，所以能在 Node 里跑测试。
 */
import { TICKS_PER_BEAT } from './ticks';
import type { Score } from './types';

const N = 1024; // FFT 窗长
const HOP = 256; // 帧移
const TARGET_SR = 11025; // 与 align.py 一致：BPM 只需要低频骨架，降采样省 4 倍算力
const MAX_SECONDS = 150; // 只分析前 150s：BPM 通常全曲恒定，省掉长曲的等待

export interface TempoEstimate {
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
   * 谱面时长 / 音频时长。整曲转录的谱按对的速度放，这个值 ≈ 1；
   * 倍速错了就是 0.5 或 2——这是判「谱面该走多快」最硬的证据。
   */
  spanRatio: number;
  /** 恒速判定：分段精化的各段 BPM（空 = 音频太短没法定） */
  segments: number[];
  /** 各段 BPM 的截尾极差；≤0.5 判恒定（align.py 同标准） */
  drift: number;
  /** true = 恒定，false = 疑似变速，null = 段数不足没法定 */
  isConstant: boolean | null;
  /** 相位聚拢度 0–1，越大越可信（干净鼓点 ~0.5+，稀疏伴奏可能只有 0.2） */
  confidence: number;
  /** 峰到最近拍点的 RMS 残差（毫秒） */
  residualMs: number;
  /** 落在拍点附近（±1/4 拍）的峰占比 0–1 */
  hitRatio: number;
  /** 参与计算的 onset 峰个数（太少说明这段音频没什么节奏） */
  peakCount: number;
}

/** 降到 ~11kHz：整数倍抽取后块平均，避免混叠 */
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

/** 混合成立体声→单声道（能量平均，不是简单相加，免得削顶） */
export function mixdown(buffer: AudioBuffer): Float32Array {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const out = new Float32Array(len);
  if (ch === 1) return buffer.getChannelData(0).slice();
  for (let c = 0; c < ch; c += 1) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i += 1) out[i] += d[i] / ch;
  }
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
 * onset 强度包络（谱流）：flux(帧 f) = Σ max(|X_f| − |X_{f−1}|, 0)
 * 与 align.py 的 `onset_env` 同口径：半波整流 → 减中位数 → log1p(×5) → 5 点汉宁平滑。
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

  for (let f = 0; f < nfr; f += 1) {
    const off = f * hop;
    for (let i = 0; i < n; i += 1) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im, tw);
    let flux = 0;
    for (let i = 0; i <= n / 2; i += 1) {
      const m = Math.hypot(re[i], im[i]);
      if (m > prev[i]) flux += m - prev[i];
      prev[i] = m;
    }
    if (f > 0) env[f - 1] = flux;
  }

  // 减中位数（去掉底噪）→ 对数压缩 → 平滑
  const sorted = Float64Array.from(env).sort();
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  for (let i = 0; i < env.length; i += 1) env[i] = Math.log1p(Math.max(env[i] - median, 0) * 5);
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
  return { env: smoothed, t0Sec: n / 2 / sr, hopSec: hop / sr };
}

/**
 * 包络 90 分位以上的**局部极大**时刻（秒）。
 *
 * 取局部极大而不是「所有过阈值的帧」：过阈值的帧在峰两侧连成一小片平台，
 * 把它们全算进去，均值会被平台偏早的那一侧拖着走（实测相位早 38ms）。
 * 再对峰做一次抛物线插值，把时刻定到亚帧精度（实测残差 ~5ms）。
 */
function onsetPeaks(env: Float64Array, t0Sec: number, hopSec: number): Float64Array {
  if (env.length < 3) return new Float64Array(0);
  let mean = 0;
  for (let i = 0; i < env.length; i += 1) mean += env[i];
  mean /= env.length;
  const sorted = Float64Array.from(env).sort();
  const thr = sorted[Math.floor(sorted.length * 0.9)];
  const times: number[] = [];
  for (let i = 1; i < env.length - 1; i += 1) {
    const y = env[i];
    if (y <= mean) continue;
    if (!(y >= env[i - 1] && y > env[i + 1])) continue;
    if (y < thr) continue;
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
    if (d < beat * 0.25) {
      sum += d * d;
      hit += 1;
    }
  }
  const n = Math.max(1, hit);
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
  /** 放宽「峰值必须突出」这条：慢网格上合格候选天然更多，严格判会一律被挡 */
  relaxPeak = false,
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
  if (!relaxPeak && cands.length >= 20 && strong.length / cands.length > 0.1) return null;
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
     * 谱面自己写的 @bpm ——**倍频歧义的先验**。
     * 八分音符伴奏在「真速」与「二倍速」上都能站住网格（细网格是粗网格的超集），
     * 光靠峰值聚拢度一定偏向偏快的那个；而你亲手写的 @bpm 才是靠谱的那一票。
     * 只在长度比这条硬证据没定案时用它。
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

  // fixedBpm：不搜速度，只在这个速度上定相位 / 原点（用户说「就按谱面速度来」）
  const forced = opts?.fixedBpm && opts.fixedBpm > 0 ? opts.fixedBpm : 0;
  const coarse = forced
    ? { bpm: forced, phaseSec: 0 }
    : gridSearch(peaks, lo, hi, 0.02);
  const fine = forced
    ? { bpm: forced, phaseSec: phaseScore(peaks, forced).frac * (60 / forced) }
    : gridSearch(peaks, Math.max(lo, coarse.bpm - 0.1), Math.min(hi, coarse.bpm + 0.1), 0.002);

  let bpm = fine.bpm;
  let phaseSec = fine.phaseSec;
  let originBeat: number | null = null;
  let originScore = 0;
  let spanRatio = 0;

  // 恒速判定（音频脉冲档，与谱面无关）：按**全曲**分段精化看各段 BPM 是否一致。
  // 不能用 150s 分析段分段——段边界与 align.py 不同会得出不同结果
  // （青花瓷实测：全曲分段 drift 0.16「恒定」，分析段分段 0.55 误报变速）
  const segSrc = downsample(samples, sampleRate);
  const segCount = Math.max(2, Math.min(10, Math.floor(durSec / 5)));
  const segments = segmentBpms(segSrc.data, segSrc.sr, fine.bpm, segCount);
  const drift = trimmedSpread(segments);
  const isConstant: boolean | null = segments.length >= 2 ? drift <= 0.5 : null;

  /**
   * 谱面原点 + BPM 复核（给了谱面音符起拍才算；复用上面那份包络，省一次）。
   *
   * 为什么不能只信相位聚拢度 R：细网格是粗网格的超集，所以「倍速」的 R 天然不低于
   * 真速（100 BPM 带八分音符旋律时实测 R(200)=0.89 > R(100)=0.50），一定偏向偏快的那个。
   *
   * 为什么也不能只信梳状得分：真实伴奏上各倍速的梳状得分常常差不到 10%
   * （青花瓷实测：108 → 1.111、54 → 1.031、216 → 0.568），判不出来。
   *
   * 真正能定案的是**谱面时长 / 音频时长**：整曲转录的谱，按对的速度放，
   * 这个比值必须 ≈ 1；倍速错了就是 0.5 或 2（青花瓷：108 → 0.48、54 → 0.97）。
   * 所以先按这条挑速度，再用梳状得分定原点，最后才在选定速度附近精化。
   */
  const notes = opts?.noteOnsets;
  const totalScoreBeats = opts?.scoreBeats;

  /**
   * b 是否是网格速度的**整倍频**（相差 2 的整数次幂）。
   *
   * 这是采纳 @bpm 先验的安全阀：谱面上写的速度也可能是错的
   * （青花瓷实测 @bpm 写 60、实际 108），盲目信它就把对的网格值推翻了。
   * 只有当音频里真的存在「@bpm 的 2ⁿ 倍」这条脉冲时（八分/十六分音符伴奏
   * 正是这种情形），才说明 @bpm 与音频同源，可以拿它定倍频。
   */
  const octaveOf = (b: number): boolean => {
    if (!b || b <= 0) return false;
    const oct = Math.log2(fine.bpm / b);
    return Math.abs(oct - Math.round(oct)) < 0.12;
  };
  if (notes && notes.length >= 6) {
    const totalBeats = Math.max(...notes);
    /** 每个候选速度的扫描结果（key = bpm） */
    const res = new Map<number, { phase: number; origin: number; score: number }>();
    const evalAt = (b: number): void => {
      // 下限放宽到「测得脉冲的一半」：半速记谱的谱面速度就在那里，
      // 不能拿网格搜索的先验（55–200）把它卡掉（青花瓷 54.0 < 55，实测被拒）
      if (b < Math.min(lo, fine.bpm / 2) || b > hi) return;
      const { frac } = phaseScore(peaks, b);
      const ph = frac * (60 / b);
      // 原点范围按**全曲时长**算：分析只覆盖前 150s，但半速谱面的原点可能靠后，
      // 用分析段算会把真原点判成越界（青花瓷 54 档的真原点 2.5 就被卡成 0 了）
      const originMax = Math.max(0, durSec / (60 / b) - totalBeats);
      // 先严格；被「峰值突出度」挡掉而又有长度比这条硬证据时，放宽再来一次
      const m =
        matchOrigin(env, t0Sec, hopSec, notes, b, ph, originMax) ??
        (totalScoreBeats ? matchOrigin(env, t0Sec, hopSec, notes, b, ph, originMax, true) : null);
      if (!m) return;
      const cur = res.get(b);
      if (!cur || m.score > cur.score) res.set(b, { phase: ph, origin: m.originBeat, score: m.score });
    };

    // ① 倍速候选（真值几乎总在这三个里）。
    // 只卡上限：这些候选来自**实测的**脉冲，网格搜索的先验下限（55）管不着它——
    // 半速记谱的谱面速度 = 脉冲/2，可能低于 55（青花瓷 54.0 就这么被拒过）。
    // 谱面 @bpm 自己也是候选（含它的倍频/分频）——网格可能锁在它的二倍速上，
    // 而那个「更快的」档在 R 上永远占优，不给 @bpm 进场机会就永远选错
    const scoreBpm = opts?.scoreBpm ?? 0;
    const candSet = forced
      ? [forced]
      : [
          fine.bpm,
          fine.bpm / 2,
          fine.bpm * 2,
          ...(scoreBpm > 0 ? [scoreBpm, scoreBpm / 2, scoreBpm * 2] : []),
        ];
    for (const cand of candSet) {
      if (cand > hi) continue;
      // 「慢一半」的 R 会塌到接近 0（八分音符在慢网格上落在半拍处、正负抵消），
      // 但那可能正是正确答案——有长度比或谱面 @bpm 撑腰时就不能用 R 把它卡掉。
      // 快的候选反过来仍要卡：细网格天然占优（超集）。
      const shielded = cand < fine.bpm && (!!totalScoreBeats || scoreBpm > 0);
      if (cand !== fine.bpm && !shielded && phaseScore(peaks, cand).R < 0.15) {
        continue;
      }
      evalAt(cand);
    }

    // ② 挑速度：谱面「正好铺满整首」的那个优先
    /** 谱面「正好铺满整首」的那个候选优先（durSec 见上：全曲时长） */
    let pick: { bpm: number; phase: number; origin: number; score: number } | null = null;
    const best = [...res.entries()].reduce<{ bpm: number; phase: number; origin: number; score: number } | null>(
      (acc, [b, v]) => (!acc || v.score > acc.score ? { bpm: b, ...v } : acc),
      null,
    );
    /** 谱面按速度 b、原点 o 放完要多久 / 音频从谱面起点算还剩多久（比值 ≈1 = 整曲转录） */
    const spanVsRest = (b: number, phase: number, origin: number): number => {
      const step = 60 / b;
      const remaining = durSec - (phase + origin * step);
      if (remaining <= 5 || !totalScoreBeats) return 0;
      return (totalScoreBeats * step) / remaining;
    };

    if (best) pick = best;
    /** 长度比定案：唯一能铺满整首的倍速档（硬证据，优先于梳状得分） */
    const fits =
      best && totalScoreBeats
        ? [...res.entries()].filter(([b, v]) => {
            const ratio = spanVsRest(b, v.phase, v.origin);
            return ratio >= 0.85 && ratio <= 1.3;
          })
        : [];
    const spanChosen = fits.length === 1;
    if (spanChosen) {
      // 长度比（硬证据）定案，优先级最高
      // 不再要求该档的梳状得分接近最高——谱面与编曲有出入时（简略前奏、配器不同），
      // 梳状得分会是负的（青花瓷实测 54 档 = −0.19），拿它当门槛会把正确的
      // 速度档拒掉，用户就被迫手点「减速/加速」。
      pick = { bpm: fits[0][0], ...fits[0][1] };
    } else if (!spanChosen && best && opts?.scoreBpm && octaveOf(opts.scoreBpm)) {
      // ②b 谱面 @bpm 先验：长度比没定案时（谱面只记了半首 / 音频有长尾静音），
      // 倍频只能靠「你亲手写的速度」来定。取与 @bpm 最接近的那个候选——
      // 八分音符伴奏在真速与二倍速上都能站住网格，R 一定偏快，不能交给它判
      const target = opts.scoreBpm;
      const near = [...res.entries()]
        .filter(([b]) => octaveOf(b)) // 只在与网格同源（倍频）的候选里挑
        .sort((a, b) => Math.abs(Math.log(a[0] / target)) - Math.abs(Math.log(b[0] / target)))
        .find(([, v]) => Number.isFinite(v.score));
      if (near) pick = { bpm: near[0], ...near[1] };
    }

    // ③ 在选定的速度附近精化（错 1% 在 20 拍模板上就漂 0.2 拍，得分立刻掉）。
    // 只在**梳状选出的档**上精化：长度比定的档，其梳状得分往往是噪声
    // （谱面与编曲对不上时是负的），精化会被噪声牵着走（实测 60 漂成 62.4）。
    // 长度比定的速度本身是硬证据，网格测量值已经足够准（±0.05 BPM）。
    if (pick && pick.score > 0 && !spanChosen) {
      const around = pick.bpm;
      // 精化窗口收窄到 ±2%（真实速度漂移 <1%，窗口开到 ±8% 时细网格又会
      // 凭「超集」占便宜，把 108 一路推到 116——实测踩到）
      const coarse = Math.max(0.05, around * 0.005);
      for (let b = around * 0.97; b <= around * 1.03; b += coarse) evalAt(b);
      const fineStep = Math.max(0.01, around * 0.001);
      for (let b = around - coarse; b <= around + coarse; b += fineStep) evalAt(b);
      // 精化必须留在同一个倍速档里；得分接近时（5% 内）取**离基准最近的那个**，
      // 不让细网格把速度往快里拽
      const cands = [...res.entries()].filter(([b]) => b >= around * 0.98 && b <= around * 1.02);
      const top = cands.reduce<{ bpm: number; phase: number; origin: number; score: number } | null>(
        (acc, [b, v]) => (!acc || v.score > acc.score ? { bpm: b, ...v } : acc),
        null,
      );
      const refined = top
        ? (cands
            .filter(([, v]) => v.score >= top.score * 0.95)
            .sort((a, b) => Math.abs(a[0] - around) - Math.abs(b[0] - around))
            .map(([b, v]) => ({ bpm: b, ...v }))[0] ?? top)
        : null;
      if (refined && refined.score > pick.score) pick = refined;
    }

    // 采纳：梳状对得上，或由长度比定的档（此时得分可能为负——那只是
    // 「谱面节奏型与编曲对不上」，不代表速度错）
    if (pick && (pick.score > 0 || totalScoreBeats)) {
      bpm = pick.bpm;
      phaseSec = pick.phase;
      originBeat = pick.origin;
      originScore = pick.score;
      spanRatio = Math.round(spanVsRest(pick.bpm, pick.phase, pick.origin) * 100) / 100;
    }
  }

  // 谱面太短（起拍 <6 个）时上面整段都跑不了，倍频就没人判——
  // 此时只剩 @bpm 这一票：音频里若有「@bpm 的 2ⁿ 倍」这条脉冲，就按 @bpm 定档。
  // 同样要过 octaveOf 这道安全阀（谱面速度写错时不会被带偏）
  if ((!notes || notes.length < 6) && !forced && opts?.scoreBpm && octaveOf(opts.scoreBpm)) {
    bpm = opts.scoreBpm;
    phaseSec = Math.round(phaseScore(peaks, bpm).frac * (60 / bpm) * 1000) / 1000;
  }

  const { ms, hit } = residual(peaks, bpm, phaseSec);
  return {
    bpm: Math.round(bpm * 100) / 100,
    phaseSec: Math.round(phaseSec * 1000) / 1000,
    originBeat,
    originScore,
    spanRatio,
    segments,
    drift: Math.round(drift * 100) / 100,
    isConstant,
    confidence: Math.round(phaseScore(peaks, bpm).R * 1000) / 1000,
    residualMs: Math.round(ms * 10) / 10,
    hitRatio: Math.round(hit * 100) / 100,
    peakCount: peaks.length,
  };
}

/** AudioBuffer → 估测（UI 用这个入口） */
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
