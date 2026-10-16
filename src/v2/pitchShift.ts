/**
 * 离线变调（F07 前置基建）：伴奏升降调，变速不变调 + 变调不变速的组合。
 *
 * 原理：升 r = 2^(semitones/12) 倍音高等价于
 *   1. WSOLA 把信号时长拉伸 r 倍（音高不变），
 *   2. 再按步长 r 重采样读出（时长还原，音高 × r）。
 * 降调同理（r < 1，先压缩再慢读）。
 *
 * WSOLA（Verhelst & Sluijter）：50% 重叠 Hann 窗逐帧叠加；每帧在名义分析位
 * ± 容差内搜索，使帧首与上一帧的「自然延续」段最相似，从而拼接处相位连续，
 * 听不出接缝。搜索用点积做相似度，跨步粗搜 + 邻域细搜控成本。
 *
 * 纯函数、无 DOM 依赖，可在 Node / Web Worker 里直接跑（scripts/pitch-test.ts）。
 */

/** 合成帧长（样本）：44.1kHz 下约 46ms，覆盖绝大多数乐器的稳态段 */
const FRAME = 2048;
/** 合成跳步 = FRAME/2，Hann 窗 50% 重叠满足恒定叠加 */
const HS = FRAME >> 1;
/** 相似度搜索容差：±256 样本（约 ±6ms）足够吸收相位错位 */
const TOL = 256;
/** 粗搜步长；命中后再 ±4 内逐样本细搜 */
const COARSE = 4;

/** Hann 窗（逐次重算太贵，模块级缓存一份） */
const HANN = (() => {
  const w = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  return w;
})();

/**
 * WSOLA 时长拉伸：输出时长 = 输入 × alpha，音高不变。
 * alpha > 1 变长（慢放），alpha < 1 变短（加快）。
 */
export function timeStretch(x: Float32Array, alpha: number): Float32Array {
  if (x.length === 0) return x.slice();
  if (Math.abs(alpha - 1) < 1e-6) return x.slice();
  const N = x.length;
  const ha = HS / alpha;
  // 搜索窗保持满 ±TOL：窗内的「完美续接」解虽然偶尔让帧间消耗抖动，
  // 但它保证交叉淡化两侧相位连续——实测缩小窗口换来的梳状滤波远更难听
  //（0.2.43 曾用自适应窗导致音质明显劣化，已回退）。防「双重声」靠的是
  // 下面 nominal 独立推进（δ 不累积）这一条。
  const outLen = Math.ceil(N * alpha);
  const y = new Float32Array(outLen + FRAME);
  const wsum = new Float32Array(outLen + FRAME);

  let outPos = 0;
  let prevAna = 0; // 上一帧实际读取起点
  let nominal = 0; // 本帧名义读取起点（**独立推进** += ha，不从实际位累积）
  let first = true;

  while (outPos + FRAME < y.length) {
    let ana: number;
    if (first) {
      ana = 0;
      first = false;
      if (ana + FRAME > N) break;
    } else {
      // 自然延续：上一帧后半段在原信号里本该接上的那一段。
      // nominal 含非整 ha，必须取整：数组只能按整数下标取（小数下标是 undefined → NaN）
      const natStart = prevAna + HS;
      const center = Math.round(nominal);
      // 平局归中：无信息段（静音/弱相关）不偏移。若从 -Infinity 起步，
      // 平局会选最早的候选（δ = -TOL），与周期信号的系统性偏移一起造成漂移
      let best = center;
      let bestScore = 0;
      const lo = Math.max(0, center - TOL);
      const hi = Math.min(N - FRAME, center + TOL);
      for (let cand = lo; cand <= hi; cand += COARSE) {
        let score = 0;
        for (let i = 0; i < HS; i += 1) score += x[cand + i]! * x[natStart + i]!;
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      // 细搜：粗搜跨步可能错过峰顶
      const fineLo = Math.max(lo, best - COARSE);
      const fineHi = Math.min(hi, best + COARSE);
      for (let cand = fineLo; cand <= fineHi; cand += 1) {
        let score = 0;
        for (let i = 0; i < HS; i += 1) score += x[cand + i]! * x[natStart + i]!;
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      ana = best;
      if (ana + FRAME > N) break;
    }
    for (let i = 0; i < FRAME; i += 1) {
      const w = HANN[i]!;
      y[outPos + i]! += x[ana + i]! * w;
      wsum[outPos + i]! += w;
    }
    outPos += HS;
    prevAna = ana;
    // 关键：名义位只按 ha 推进，搜索偏移 δ **不**带进下一帧。
    // 之前写成 nominal = ana + ha，δ 逐帧累积——周期性音乐会让搜索稳定
    // 锁在 δ ≈ HS − ha，分析指针每帧多走约 150 采样，片段被反复重播，
    // 听感就是「两个声音一起放」（0.2.43 实测踩到）
    nominal += ha;
    if (nominal + FRAME + TOL > N) break;
  }

  // 归一化：修掉首尾未叠满的窗缘
  const out = y.subarray(0, outLen);
  for (let i = 0; i < outLen; i += 1) {
    const w = wsum[i]!;
    if (w > 1e-6) out[i]! /= w;
  }
  return out;
}

/** 线性插值重采样：输出第 i 个样本 ≈ x[i × step]，音高 × step、时长 ÷ step。 */
export function resample(x: Float32Array, step: number, outLen: number): Float32Array {
  const out = new Float32Array(outLen);
  if (x.length === 0) return out;
  for (let i = 0; i < outLen; i += 1) {
    const p = i * step;
    const j = Math.floor(p);
    if (j >= x.length - 1) { out[i] = x[x.length - 1]!; break; }
    const frac = p - j;
    out[i] = x[j]! * (1 - frac) + x[j + 1]! * frac;
  }
  return out;
}

/**
 * 变调核心：semitones 个半音，输出时长与输入一致。
 * 先 WSOLA 拉伸 r 倍再按步长 r 读出；r > 1 时高频理论上会混叠，
 * 但 ±3 半音内混叠起始点在 18.5kHz 以上，对伴奏内容可忽略。
 */
export function pitchShiftChannel(x: Float32Array, semitones: number): Float32Array {
  if (x.length === 0 || semitones === 0) return x.slice();
  const r = 2 ** (semitones / 12);
  const stretched = timeStretch(x, r);
  return resample(stretched, r, x.length);
}
