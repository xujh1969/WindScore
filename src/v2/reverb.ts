/**
 * 钢琴空间感（琴体共鸣 + 房间混响）：**合成的脉冲响应 + 分区 FFT 卷积**。
 *
 * 为什么不用 Web Audio 的 ConvolverNode：实时与离线导出必须跑同一份代码
 * （导出成品 = 耳朵听到的），ConvolverNode 是原生黑盒，数值上对不齐；
 * 这里的卷积是纯数值，renderNote 末尾对干声直接套用，两条链路天然同源。
 *
 * 厚度从哪来：IR 里埋了 85~330Hz 的琴体木箱模态（低频拖尾），
 * 混响的同时把低中频「垫」起来——这正是真实钢琴在房间里的厚度感。
 *
 * 成本：分区（partitioned）卷积，IR 0.5s 切成 4096 一段缓存频域，
 * 每个信号块只需 1 次正 FFT + 1 次逆 FFT + 少量复乘，
 * 一个 1 秒的音在 JS 里约几毫秒，实时排音扛得住。
 */

/** 迭代基-2 复 FFT（就地） */
function fft(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k += 1) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const xr = re[i + k + half]!;
        const xi = im[i + k + half]!;
        const vr = xr * cr - xi * ci;
        const vi = xr * ci + xi * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i]! /= n;
      im[i]! /= n;
    }
  }
}

interface SpaceCache {
  hop: number;
  fftSize: number;
  partitions: number;
  irFreqRe: Float32Array[];
  irFreqIm: Float32Array[];
  wetGain: number;
  // 复用草稿缓冲，避免每音分配
  fdRe: Float32Array[];
  fdIm: Float32Array[];
  fRe: Float32Array;
  fIm: Float32Array;
  aRe: Float32Array;
  aIm: Float32Array;
}

const cacheBySr = new Map<number, SpaceCache>();

const FFT_SIZE = 8192;
const HOP = FFT_SIZE / 2;
const IR_SEC = 0.5;
const WET = 0.26;

/** 合成 IR：早反射 + 低通渐暗的扩散尾 + 琴体低频模态（确定性的，可测可复现）。
 *  归一在这里做：先按 L2 归一（湿声电平可预期），再按**最大频响幅度**限幅——
 *  窄带模态若不限幅，谐振频点的稳态增益会到 4 倍以上，低音直接嗡成共鸣腔 */
function buildIR(sr: number): Float32Array {
  const len = Math.round(IR_SEC * sr);
  const ir = new Float32Array(len);
  let seed = 20260314;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  // 早反射：头 30ms 里几束离散反射（房间墙面）。同极性——
  // 交替极性会和干声反相相消，余韵反而变薄（0.2.114 实测）
  const early = [0.007, 0.011, 0.014, 0.019, 0.024, 0.029];
  const earlyGain = [0.16, 0.11, 0.09, 0.07, 0.055, 0.045];
  for (let i = 0; i < early.length; i += 1) {
    ir[Math.round(early[i]! * sr)]! += earlyGain[i]!;
  }
  // 扩散尾分两层，都用**噪声**（与干声不相干，能量只会叠加不会反相相消——
  // 纯正弦模态会和干声分音相消，余韵反而变薄，0.2.114 实测）：
  //   a) 空气声：宽带噪声，低通随时间收窄（变暗）
  //   b) 琴体低频：~260Hz 低通噪声拖尾，低中频的「厚度」来自这里
  const tailStart = Math.round(0.03 * sr);
  const tau = 0.16;
  let lpAir = 0;
  let lpBody1 = 0;
  let lpBody2 = 0;
  for (let i = tailStart; i < len; i += 1) {
    const t = i / sr;
    const w = rnd();
    const aAir = 1 - Math.exp((-2 * Math.PI * (4500 - 2600 * (t / IR_SEC))) / sr);
    lpAir += aAir * (w - lpAir);
    ir[i]! += lpAir * Math.exp(-t / tau) * 0.9;
    const aBody = 1 - Math.exp((-2 * Math.PI * 260) / sr);
    lpBody1 += aBody * (w - lpBody1);
    lpBody2 += aBody * (lpBody1 - lpBody2);
    ir[i]! += lpBody2 * Math.exp(-t / 0.22) * 1.5;
  }
  // L2 归一：湿声 RMS = wetGain × 干声 RMS（宽频意义上）
  let energy = 0;
  for (let i = 0; i < len; i += 1) energy += ir[i]! * ir[i]!;
  const norm = Math.sqrt(Math.max(1e-9, energy));
  for (let i = 0; i < len; i += 1) ir[i]! /= norm;
  // 频响限幅：直接 DFT 探测最大稳态增益（含模态频点），压到安全线内——
  // 否则落在模态上的音会被谐振放大数倍（0.2.114 实测低音峰值 1.89）
  let maxMag = 0;
  const probe: number[] = [55, 88, 110, 132, 165, 178, 220, 241, 330, 335, 440, 660, 880, 1760, 3520, 5000];
  for (const f of probe) {
    const w = (2 * Math.PI * f) / sr;
    let re = 0;
    let im = 0;
    for (let i = 0; i < len; i += 1) {
      re += ir[i]! * Math.cos(w * i);
      im -= ir[i]! * Math.sin(w * i);
    }
    maxMag = Math.max(maxMag, Math.hypot(re, im));
  }
  const cap = 0.55 / WET; // 湿声在最坏频点的稳态增益 ≤ 0.55
  if (maxMag * WET > 0.55) {
    const f = cap / maxMag;
    for (let i = 0; i < len; i += 1) ir[i]! *= f;
  }
  return ir;
}

function getCache(sr: number): SpaceCache {
  const hit = cacheBySr.get(sr);
  if (hit) return hit;
  const ir = buildIR(sr);
  const partitions = Math.ceil(ir.length / HOP);
  const irFreqRe: Float32Array[] = [];
  const irFreqIm: Float32Array[] = [];
  const pr = new Float32Array(FFT_SIZE);
  const pi = new Float32Array(FFT_SIZE);
  for (let p = 0; p < partitions; p += 1) {
    pr.fill(0);
    pi.fill(0);
    for (let i = 0; i < HOP && p * HOP + i < ir.length; i += 1) pr[i] = ir[p * HOP + i]!;
    fft(pr, pi, false);
    irFreqRe.push(pr.slice());
    irFreqIm.push(pi.slice());
  }
  const fdRe: Float32Array[] = [];
  const fdIm: Float32Array[] = [];
  for (let p = 0; p < partitions; p += 1) {
    fdRe.push(new Float32Array(FFT_SIZE));
    fdIm.push(new Float32Array(FFT_SIZE));
  }
  const cache: SpaceCache = {
    hop: HOP,
    fftSize: FFT_SIZE,
    partitions,
    irFreqRe,
    irFreqIm,
    wetGain: WET,
    fdRe,
    fdIm,
    fRe: new Float32Array(FFT_SIZE),
    fIm: new Float32Array(FFT_SIZE),
    aRe: new Float32Array(FFT_SIZE),
    aIm: new Float32Array(FFT_SIZE),
  };
  cacheBySr.set(sr, cache);
  return cache;
}

/**
 * 给一段干声（单音的渲染结果）就地叠加琴体 + 房间湿声。
 * 分区 FFT 卷积：湿声缓冲独立累加再混回，不改动干声本身。
 */
export function applyPianoSpace(pcm: Float32Array, sr: number): void {
  const c = getCache(sr);
  const wet = new Float32Array(pcm.length + c.hop * c.partitions);
  const nBlocks = Math.ceil(pcm.length / c.hop);
  const { fRe, fIm, aRe, aIm, fdRe, fdIm, irFreqRe, irFreqIm } = c;
  // 频域延迟线跨音复用，必须清零——否则上一音的残留会泄进这一音
  for (let p = 0; p < c.partitions; p += 1) {
    fdRe[p]!.fill(0);
    fdIm[p]!.fill(0);
  }
  for (let b = 0; b < nBlocks; b += 1) {
    const slot = b % c.partitions;
    // 当前块进频域延迟线
    fRe.fill(0);
    fIm.fill(0);
    const s0 = b * c.hop;
    for (let i = 0; i < c.hop && s0 + i < pcm.length; i += 1) fRe[i] = pcm[s0 + i]!;
    fft(fRe, fIm, false);
    fdRe[slot].set(fRe);
    fdIm[slot].set(fIm);
    // Y = Σ X_{b-p} · H_p（频域延迟线循环取用）
    aRe.fill(0);
    aIm.fill(0);
    for (let p = 0; p < c.partitions; p += 1) {
      const sl = ((b - p) % c.partitions + c.partitions) % c.partitions;
      const xr = fdRe[sl]!;
      const xi = fdIm[sl]!;
      const hr = irFreqRe[p]!;
      const hi = irFreqIm[p]!;
      for (let i = 0; i < c.fftSize; i += 1) {
        aRe[i] += xr[i]! * hr[i]! - xi[i]! * hi[i]!;
        aIm[i] += xr[i]! * hi[i]! + xi[i]! * hr[i]!;
      }
    }
    fft(aRe, aIm, true);
    for (let i = 0; i < c.hop; i += 1) {
      const o = s0 + i;
      if (o < wet.length) wet[o] += aRe[i]!;
    }
  }
  for (let i = 0; i < pcm.length; i += 1) pcm[i]! += wet[i]! * c.wetGain;
}

/** 测试用：暴露合成 IR（守 IR 的形状性质） */
export function pianoIRFor(sr: number): Float32Array {
  return buildIR(sr);
}
