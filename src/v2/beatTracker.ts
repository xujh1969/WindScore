/** 传统逐拍跟踪：局部周期 + 动态规划；不依赖谱面长度。 */
export interface BeatCandidate { bpm: number; score: number; }

export function trackBeatEnvelope(env: Float64Array, hop: number, t0: number, opts: { lo: number; hi: number; hint?: number; fixed?: number }) {
  const n = env.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];
  const novelty = Float64Array.from(env, (v, i) => {
    const a = Math.max(0, i - Math.round(0.5 / hop));
    const b = Math.min(n, i + Math.round(0.5 / hop) + 1);
    return Math.max(0, v - (prefix[b] - prefix[a]) / (b - a));
  });
  const scale = Float64Array.from(novelty).sort()[Math.floor(n * 0.95)] || 1;
  for (let i = 0; i < n; i++) novelty[i] = Math.min(4, novelty[i] / scale);
  const correlation = (bpm: number, from = 0, to = n): number => {
    const lag = 60 / bpm / hop;
    let dot = 0, aa = 0, bb = 0;
    for (let i = from + Math.ceil(lag); i < to; i++) {
      const j = i - lag, k = Math.floor(j), f = j - k;
      const a = novelty[i], b = novelty[k] * (1 - f) + novelty[k + 1] * f;
      dot += a * b; aa += a * a; bb += b * b;
    }
    return dot / Math.sqrt(Math.max(1e-12, aa * bb));
  };
  const scan: BeatCandidate[] = [];
  for (let b = opts.lo; b <= opts.hi; b += 0.5) scan.push({ bpm: b, score: correlation(b) });
  const maxima = scan.filter((v, i) => v.score >= (scan[i - 1]?.score ?? -1) && v.score >= (scan[i + 1]?.score ?? -1));
  const hint = opts.hint && opts.hint >= opts.lo && opts.hint <= opts.hi ? opts.hint : 0;
  if (hint) maxima.push({ bpm: hint, score: correlation(hint) });
  const rank = (c: BeatCandidate) => c.score + (hint ? 0.06 * Math.exp(-Math.pow(Math.log(c.bpm / hint) / 0.12, 2)) : 0);
  maxima.sort((a, b) => rank(b) - rank(a));
  const distinct = maxima.filter((v, i, all) => !all.slice(0, i).some((a) => Math.abs(Math.log(a.bpm / v.bpm)) < 0.04));
  const candidates = distinct.slice(0, 5);
  let bpm = opts.fixed || candidates[0]?.bpm || 120;
  if (!opts.fixed) {
    let best = correlation(bpm);
    const center = bpm;
    for (let b = center - 0.6; b <= center + 0.6; b += 0.02) {
      if (b < opts.lo || b > opts.hi) continue;
      const s = correlation(b);
      if (s > best) { bpm = b; best = s; }
    }
  }
  // 每 4 秒更新周期，16 秒上下文；同时约束全局速度，避免局部误差累积到另一速度档。
  const periods = new Float64Array(n);
  const segments: number[] = [];
  const block = Math.max(1, Math.round(4 / hop));
  let local = bpm;
  for (let from = 0; from < n; from += block) {
    let chosen = local, best = -Infinity;
    if (!opts.fixed) {
      for (let b = Math.max(opts.lo, bpm * 0.9, local * 0.95); b <= Math.min(opts.hi, bpm * 1.1, local * 1.05); b += 0.25) {
        const s = correlation(b, Math.max(0, from - block * 2), Math.min(n, from + block * 2))
          - 8 * Math.pow(Math.log(b / bpm), 2) - 3 * Math.pow(Math.log(b / local), 2);
        if (s > best) { best = s; chosen = b; }
      }
      if (best < 0.12) chosen = local; // 无节奏证据时保留周期，不能追噪声。
    }
    local = chosen;
    segments.push(local);
    periods.fill(60 / local / hop, from, Math.min(n, from + block));
  }
  const dp = new Float64Array(n), back = new Int32Array(n).fill(-1);
  let end = 0, bestEnd = 0;
  for (let i = 0; i < n; i++) {
    const period = periods[i];
    let best = 0;
    // 弱拍可插入预测位置，但不能为了追旋律起音频繁缩短或拉长一拍。
    for (let d = Math.max(1, Math.floor(period * 0.8)); d <= Math.ceil(period * 1.25) && d <= i; d++) {
      const value = dp[i - d] - 100 * Math.pow(Math.log(d / period), 2);
      if (value > best) { best = value; back[i] = i - d; }
    }
    dp[i] = novelty[i] + best;
    if (novelty[i] > 0.25 && dp[i] >= bestEnd) { bestEnd = dp[i]; end = i; }
  }
  const frames: number[] = [];
  for (let i = end; i >= 0; i = back[i]) { frames.push(i); if (back[i] < 0) break; }
  frames.reverse();
  while (frames.length && novelty[frames[0]] < 0.25) frames.shift();
  const beatTimes = frames.map((i) => {
    const a = novelty[Math.max(0, i - 1)], b = novelty[i], c = novelty[Math.min(n - 1, i + 1)];
    const den = a - 2 * b + c;
    const delta = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
    return t0 + (i + delta) * hop;
  });
  const support = frames.length ? frames.filter((i) => novelty[i] > 0.25).length / frames.length : 0;
  const strength = correlation(bpm);
  const ambiguous = !opts.fixed && !!candidates[1] && rank(candidates[0]) - rank(candidates[1]) < 0.04;
  return { bpm, beatTimes, segments, candidates, ambiguous, confidence: Math.min(1, support * 0.6 + strength * 0.4), support };
}
