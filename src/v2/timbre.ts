/**
 * 钢琴音色（混合）：**一份音色描述 + 一个渲染器**，实时播放与离线导出共用。
 *
 * 真实钢琴采样（Salamander Grand，CC-BY，见 pianoSamples.ts）整段回放：
 * 绝大多数音符从头到尾都是真实录音（含自然衰减与槌击），合成只兜底
 * （采样未加载）并给长过采样（3~8s）的超长音续尾——交接只发生在低能量处。
 *
 * 钢琴音色的几件事，缺一件就立刻露馅：
 *   1. 泛音列**各自独立衰减**——高次泛音先死，声音越走越暗（这是音色的灵魂）
 *   2. 槌击噪声——起音那一下的撞击（琴键不粘毛毡时更亮更硬）
 *   3. 非谐性——真实琴弦的泛音略微高于整数倍（低音弦更明显）
 *   4. 音区滤波 + 力度层——低音闷、高音亮；轻弹暗、重弹亮
 *   5. **双弦拍音**——中低音区每音 2~3 根微失谐的琴弦，互相产生 0.3~2 Hz
 *      的慢幅拍（音量轻轻起伏）。这是人耳区分「真钢琴 vs 电钢」最灵敏的特征，
 *      用调幅等价实现（两个近频正弦之和 ≡ 载波 + 调幅），不增加振荡器数量
 *   6. **双段衰减**——琴弦先快衰减再留慢尾音；单一指数听起来发「直」
 *   7. 琴体共鸣——低频箱体共鸣（低音厚）+ 2.2kHz 共振峰 + 高频存在感
 *
 * 渲染器是纯数值计算（不碰 Web Audio），所以能进 node 单测；
 * 实时播放把渲染出来的样本塞进 AudioBuffer，导出把它混进总轨——
 * 两条链路**跑的是同一份代码**，导出成品和耳朵里听到的必然一致。
 */
import { pianoSampleFor } from './pianoSamples';
import { applyPianoSpace } from './reverb';

/** 一个泛音（partial） */
export interface PartialSpec {
  /** 频率倍率（含非谐性：真实琴弦的泛音略高于整数倍） */
  ratio: number;
  /** 初始振幅（已归一化，所有泛音之和 = 1，最坏情况全同相也不过 1） */
  amp: number;
  /** 主段衰减时间常数（秒）：越大余韵越长 */
  decay: number;
  /** 尾段衰减时间常数（秒）：双段衰减的慢段（缺省 = 单段衰减） */
  decay2?: number;
  /** 尾段振幅占比 0~1（与 decay2 搭配；缺省 0） */
  mix2?: number;
  /** 双弦失谐拍频（Hz，调幅速率；缺省 0 = 无拍） */
  beat?: number;
  /** 拍音深度 0~1：1 = 两根弦等幅（包络会摆到 0） */
  beatDepth?: number;
}

/** 槌击噪声 */
export interface HammerSpec {
  /** 强度 */
  amp: number;
  /** 衰减时间常数（秒） */
  decay: number;
  /** 带通中心频率（Hz） */
  tone: number;
}

/** 音区滤波（整音的亮度） */
export interface ToneSpec {
  /** 低通截止频率（Hz） */
  cutoff: number;
}

export interface TimbreSpec {
  /** 基频（Hz） */
  freq: number;
  partials: PartialSpec[];
  hammer: HammerSpec;
  tone: ToneSpec;
  /** 起音时间（秒） */
  attack: number;
  /** 松键（制音器）时间（秒） */
  release: number;
  /** 音高（midi 号）：用于挑选真实起音采样（缺省 = 不用采样） */
  midi?: number;
}

/** 音区归一化的两端：最低音 A0、最高音 C8 */
const A0 = 21;
const C8 = 108;

/**
 * 按音高与力度算出这个音该有的音色。
 *
 * @param midi     音高（已经算上升降调）
 * @param velocity 力度（0~1）：越大越亮、槌击越重
 */
export function pianoSpec(midi: number, velocity = 1): TimbreSpec {
  const v = Math.max(0.05, Math.min(1, velocity));
  const freq = 440 * 2 ** ((midi - 69) / 12);
  // 音区：0 = 最低音，1 = 最高音
  const p = Math.max(0, Math.min(1, (midi - A0) / (C8 - A0)));

  // 泛音个数：低音弦粗、频谱厚，泛音多而强；高音弦细但根数仍在（单弦）
  const count = Math.max(6, Math.min(14, Math.round(7 + 7 * p)));
  // 基音余韵：低音拖得长，高音一敲就散
  const t1 = 0.55 + 9.5 * (1 - p) ** 1.7;
  // 非谐性系数 B：低音弦更硬，泛音偏离整数倍更明显
  const inharm = 3.5e-5 + 7e-5 * (1 - p);
  // 频谱倾斜：低频滚降快一点，低音区更陡
  const alpha = 1.15 + 0.45 * (1 - p);
  // 双弦失谐：同音的 2~3 根弦略失谐 → 慢幅拍。拍频按音高做确定性伪随机
  //（同一音每次相同、相邻音各不相同），最高音区是单弦，没有拍
  const rnd = (x: number): number => {
    const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const beatHz = 0.3 + 0.9 * rnd(midi);
  // 深度收敛在 ±2dB 上下：真钢琴调准的同音弦拍音是细微的「活」感，不是颤音
  const beatAmt = 0.3 * (1 - p) ** 0.8;

  const raw: { ratio: number; amp: number; decay: number }[] = [];
  let sum = 0;
  for (let n = 1; n <= count; n += 1) {
    // 非谐性：第 n 泛音的实际频率 = n·f0·√(1+B·n²)
    const ratio = n * Math.sqrt(1 + inharm * n * n);
    const f = freq * ratio;
    let amp = n ** -alpha;
    // 琴体共振峰：2 kHz 附近鼓一下（钢琴箱体的标志）
    amp *= 1 + 0.55 * Math.exp(-(((f - 2200) / 1400) ** 2));
    // 低频箱体共鸣：~115 Hz 的木箱共鸣，低音区的厚度来自这里；~210 Hz 补中低频
    amp *= 1 + 0.65 * Math.exp(-(((f - 115) / 75) ** 2));
    amp *= 1 + 0.22 * Math.exp(-(((f - 210) / 110) ** 2));
    // 高频存在感：3.2 kHz 附近一点亮，起音更「钉」
    amp *= 1 + 0.18 * Math.exp(-(((f - 3200) / 900) ** 2));
    // 力度层：越强，高次泛音越多（越亮）
    amp *= 0.55 + 0.45 * v + 0.22 * (v - 0.5) * (n - 1);
    // 双段衰减的基准：高次泛音先死
    const decay = t1 / (1 + 0.42 * (n - 1) ** 0.85);
    raw.push({ ratio, amp, decay });
    sum += amp;
  }
  const partials: PartialSpec[] = raw.map((r, i) => ({
    ratio: r.ratio,
    amp: r.amp / sum,
    // 主段（快）+ 尾段（慢）：真琴弦先衰减快、后留长尾，单一指数发直
    decay: r.decay * 0.5,
    decay2: r.decay * 1.8,
    mix2: 0.3,
    // 拍频随泛音号升高而变快（失谐弦的 n 次泛音失谐量也是 n 倍），封顶到粗糙感以下
    beat: Math.min(11, beatHz * (i + 1)),
    beatDepth: beatAmt,
  }));

  return {
    freq,
    midi,
    partials,
    hammer: {
      amp: 0.09 * (0.35 + 0.65 * v),
      decay: 0.01 + 0.012 * (1 - p),
      tone: 2400 + 1900 * p,
    },
    tone: { cutoff: 1700 + 7400 * p + 1200 * v },
    attack: 0.002 + 0.004 * (1 - p),
    release: 0.06 + 0.05 * (1 - p),
  };
}

export interface RenderOptions {
  sampleRate: number;
  /** 音符时长（秒）：从起音到松键 */
  durationSec: number;
  /** 起音力度（振幅比例） */
  dyn?: number;
  /** 渐强渐弱的终点力度 */
  dynTo?: number;
  /** 关掉琴体共鸣 + 房间混响（默认开；测试对照用） */
  space?: boolean;
}

/**
 * 把一个音渲染成样本。
 *
 * 输出已归一化（峰值 ≈ 1），调用方自己决定放多大。
 * 纯数值计算：相位用复数旋转递推（不逐样本调 Math.sin），衰减用每样本乘一个系数。
 */
export function renderNote(spec: TimbreSpec, opts: RenderOptions): Float32Array {
  const sr = opts.sampleRate;
  const dur = Math.max(0.03, opts.durationSec);
  const n = Math.max(1, Math.round((dur + spec.release) * sr));
  const out = new Float32Array(n);
  const dyn = opts.dyn ?? 1;
  const dynTo = opts.dynTo ?? dyn;

  // ── 真实采样（Salamander，CC-BY）：有就用、没有就纯合成 ──────
  // 全采样整段回放：采样覆盖整个音符（含松键制音），合成只在两种情况出声——
  // ① 采样未加载（兜底）② 音符长过采样（在采样低能量尾部交接续尾）。
  // 采样自身吃同一条制音器包络，短音不会被采样拖长
  const ps = spec.midi !== undefined ? pianoSampleFor(spec.midi) : null;
  let holdN = 0; // 合成在此之前的样本数里静音（采样领唱）
  let crossN = 0; // 交接淡化宽度
  let samplePcm: Float32Array | null = null;
  let sampleSpeed = 1; // 采样读取速度 = 变调比 × (采样率/输出采样率)
  if (ps) {
    samplePcm = ps.sample.pcm;
    // 关键：采样数据自带采样率（44.1k），输出是 AudioContext 的（常是 48k）——
    // 不换算就会整体播放偏快 1.47 个半音（0.2.113 前的实测音高不准根因）
    sampleSpeed = ps.ratio * (ps.sample.sr / sr);
    const avail = Math.ceil(samplePcm.length / sampleSpeed);
    if (avail >= n) {
      // 全采样整段回放：采样覆盖整个音符（含松键制音），合成全程静音——
      // 正常音符从头到尾都是真实录音，不存在任何交接。0.2.118 实测教训：
      // 若在此情形仍走交接，淡入的合成会在音符结尾的制音器段落补一记
      // 全额响度（采样此时已自然衰减变轻），耳朵听到「衰减被放大」
      holdN = n;
      crossN = 0;
    } else {
      // 超长音（长过采样）：合成在采样真正的低能量尾部等功率接手
      crossN = Math.min(Math.round(0.2 * sr), Math.max(1, avail >> 2));
      holdN = Math.max(0, avail - crossN);
    }
  }

  // ── 主包络：起音 →（渐强/渐弱）→ 松键后的制音器 ──────────────
  const attackN = Math.max(1, Math.round(spec.attack * sr));
  const relStart = Math.min(n - 1, Math.round(dur * sr));
  const env = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    if (i < attackN) env[i] = i / attackN;
    else if (i < relStart) {
      env[i] = dyn + (dynTo - dyn) * ((i - attackN) / Math.max(1, relStart - attackN));
    } else {
      // 制音器压住琴弦：平方衰减，比线性收得更快更像真琴
      const u = (i - relStart) / Math.max(1, n - relStart);
      env[i] = dynTo * (1 - u) * (1 - u);
    }
    // 有采样时，合成音在采样段内让位、交接区等功率淡入（sin），与采样的 cos 互补
    if (holdN > 0) {
      if (i < holdN) env[i] = 0;
      else if (i < holdN + crossN) {
        const u = (i - holdN) / crossN;
        env[i] *= Math.sin((u * Math.PI) / 2);
      }
    }
  }

  // ── 泛音列：各自独立衰减（双段）+ 双弦拍音（调幅） ───────────
  // 两个近频正弦之和 ≡ 载波 + 调幅：拍音不用第二个振荡器，
  // 乘一个慢速余弦包络即可，频谱上与真实双弦完全等价。
  // 采样覆盖整音时合成全程静音（env 全 0），直接跳过省掉整段计算
  if (holdN < n) {
    for (const p of spec.partials) {
      const w = (2 * Math.PI * spec.freq * p.ratio) / sr;
      const cw = Math.cos(w);
      const sw = Math.sin(w);
      let s = 0; // sin(相位)
      let c = 1; // cos(相位)
      const mix2 = p.mix2 ?? 0;
      let a1 = p.amp * (1 - mix2); // 主段（快衰减）
      let a2 = p.amp * mix2; // 尾段（慢衰减）
      const k1 = Math.exp(-1 / (p.decay * sr));
      const k2 = a2 > 0 && p.decay2 ? Math.exp(-1 / (p.decay2 * sr)) : 0;
      const bd = p.beatDepth ?? 0;
      const hasBeat = bd > 0 && !!p.beat && p.beat > 0;
      const bBase = 1 - bd * 0.5;
      const bHalf = bd * 0.5;
      const bw = hasBeat ? (2 * Math.PI * p.beat!) / sr : 0;
      const bcw = Math.cos(bw);
      const bsw = Math.sin(bw);
      let bs = 0; // 拍频载波的 sin（相位从中点起，起音就是平均振幅）
      let bc = 1;
      for (let i = 0; i < n; i += 1) {
        a1 *= k1;
        if (a2 > 0) a2 *= k2;
        let fac = 1;
        if (hasBeat) {
          const nbs = bs * bcw + bc * bsw;
          const nbc = bc * bcw - bs * bsw;
          bs = nbs;
          bc = nbc;
          fac = bBase + bHalf * bs;
        }
        out[i]! += (a1 + a2) * fac * env[i]! * s;
        const ns = s * cw + c * sw;
        const nc = c * cw - s * sw;
        s = ns;
        c = nc;
        // 复数旋转的模会缓慢漂移，每 8192 个样本归一化一次（误差 ~1e-11，肉耳无感）
        if ((i & 8191) === 8191) {
          const m = Math.sqrt(s * s + c * c);
          if (m > 0) {
            s /= m;
            c /= m;
          }
          if (hasBeat) {
            const bm = Math.sqrt(bs * bs + bc * bc);
            if (bm > 0) {
              bs /= bm;
              bc /= bm;
            }
          }
        }
      }
    }
  }

  // ── 槌击噪声：起音那一下的撞击（采样覆盖整音时同样跳过——真录音自带槌击） ──
  if (holdN < n) {
    const len = Math.min(n, Math.round(spec.hammer.decay * 5 * sr));
    if (len > 2 && spec.hammer.amp > 0) {
      const hpF = spec.hammer.tone * 0.55;
      const lpF = spec.hammer.tone * 1.9;
      const aHp = 1 - Math.exp((-2 * Math.PI * hpF) / sr);
      const aLp = 1 - Math.exp((-2 * Math.PI * lpF) / sr);
      const k = Math.exp(-1 / (spec.hammer.decay * sr));
      let lpHp = 0;
      let lpLp = 0;
      let seed = 20260301; // 固定种子：同一个音每次渲染结果一致（可测、可复现）
      for (let i = 0; i < len; i += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const white = (seed / 0xffffffff) * 2 - 1;
        lpHp += aHp * (white - lpHp);
        const hp = white - lpHp; // 一阶高通：去掉低频
        lpLp += aLp * (hp - lpLp); // 一阶低通：去掉高频 → 带通
        const e = k ** i;
        out[i]! += lpLp * e * spec.hammer.amp * env[i]!;
      }
    }
  }

  // ── 音区滤波：两级一阶低通（低音区把泛音压暗） ───────────────
  {
    const fc = Math.min(spec.tone.cutoff, sr * 0.45);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
    let lp1 = 0;
    let lp2 = 0;
    for (let i = 0; i < n; i += 1) {
      lp1 += a * (out[i]! - lp1);
      lp2 += a * (lp1 - lp2);
      out[i] = lp2;
    }
  }

  // ── 混入真实起音采样 ─────────────────────────────────────────
  // 放在音区滤波**之后**：采样已经是真实录音的自然音色，再过低通会二次发闷。
  // 变调用窗梳 sinc 插值（32 抽头）：真实录音是宽带信号（槌击噪声铺满频段），
  // 上移变调用线性插值会把 Nyquist 附近的内容折叠成刺耳的混叠——「难听」的另一根因
  if (samplePcm) {
    const g = 0.85;
    // 采样段也吃 dyn→dynTo 渐强渐弱（单力度层的标准做法：增益骑包络）——
    // 长采样后渐强记号必须在整个采样段内生效。注意不含合成的起音坡：
    // 采样本身就是真实起音，再叠 4ms 线性坡会把槌击钝掉
    const dynRamp = (i: number): number => {
      if (i >= relStart) return dynTo;
      return dyn + (dynTo - dyn) * Math.min(1, i / Math.max(1, relStart));
    };
    // ── 交接电平匹配：让合成延音进场时的响度 = 采样当时的响度 ──
    // 不匹配的话耳朵会听到「真琴起音 → 另一个响度的电钢延音」，
    // 像先后奏了两个音（0.2.113 实测）。合成的实际电平在滤波后测量，
    // 采样电平取交接区起点前的 RMS（那时它还没开始让位淡出）
    {
      const a = Math.min(n, holdN + crossN);
      const b = Math.min(n, a + Math.round(0.12 * sr));
      if (b - a > 64) {
        let se = 0;
        for (let i = a; i < b; i += 1) se += out[i]! * out[i]!;
        const synthRms = Math.sqrt(se / (b - a));
        const s0 = Math.max(0, Math.floor((holdN - crossN) * sampleSpeed));
        const s1 = Math.min(samplePcm.length, Math.floor(holdN * sampleSpeed));
        let pe = 0;
        for (let i = s0; i < s1; i += 1) pe += samplePcm[i]! * samplePcm[i]!;
        const pcmRms = s1 > s0 ? Math.sqrt(pe / (s1 - s0)) : 0;
        const match = synthRms > 1e-4 && pcmRms > 1e-5
          // 钳位范围必须宽：长音的采样尾部自然衰减到很低的电平，
          // 合成要跟着降到同一水平——钳太高就会「先变小再变大」（0.2.116 实测）。
          // 下限 0.12 防止极端情况把延音压没；上限 2.2 兜底弱采样
          ? Math.min(2.2, Math.max(0.12, pcmRms / synthRms))
          : 1;
        if (match !== 1) for (let i = 0; i < n; i += 1) out[i]! *= match;
      }
    }
    const table = sincTableOf();
    const i0Off = SINC_TAPS / 2 - 1;
    // 音头整形（采样库里「力度层」的廉价等价物）：
    // ① 力度越轻，槌击瞬态相对音身越弱（真琴软击的头/身比更小）
    // ② 整体把起音的「砸」感削掉约 1.4dB，60ms 内平滑过渡回音身
    const headN = Math.round(0.06 * sr);
    const atkRel = Math.sqrt(Math.max(0.05, dyn)) * 0.85;
    for (let i = 0; i < n; i += 1) {
      const pos = i * sampleSpeed;
      if (pos + i0Off + 1 >= samplePcm.length) break;
      const ip = Math.floor(pos);
      const row = Math.min(SINC_PHASES - 1, Math.round((pos - ip) * SINC_PHASES)) * SINC_TAPS;
      let v = 0;
      for (let k = 0; k < SINC_TAPS; k += 1) v += (samplePcm[ip - i0Off + k] ?? 0) * table[row + k];
      if (i >= relStart) {
        // 松键：与合成共用同一条制音器包络
        const u = (i - relStart) / Math.max(1, n - relStart);
        v *= (1 - u) * (1 - u);
      }
      if (i >= holdN) v *= Math.cos(((i - holdN) / Math.max(1, crossN) * Math.PI) / 2);
      let head = 1;
      if (i < headN) {
        const u = i / headN;
        const ss = u * u * (3 - 2 * u);
        head = atkRel + (1 - atkRel) * ss;
      }
      out[i]! += v * g * dynRamp(i) * head;
    }
  }

  // ── 琴体共鸣 + 房间混响（纯数值卷积，实时/导出同源） ─────────
  if (opts.space !== false) applyPianoSpace(out, sr);

  return out;
}

// ── 采样插值的窗梳 sinc 相位表（懒构建一次） ─────────────────
const SINC_PHASES = 512;
const SINC_TAPS = 32;
let sincCache: Float32Array | null = null;
function sincTableOf(): Float32Array {
  if (sincCache) return sincCache;
  const t = new Float32Array(SINC_PHASES * SINC_TAPS);
  for (let p = 0; p < SINC_PHASES; p += 1) {
    const frac = p / SINC_PHASES;
    for (let k = 0; k < SINC_TAPS; k += 1) {
      const x = k - (SINC_TAPS / 2 - 1) - frac;
      const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      // Hann 窗（中心为峰、两端为 0）抑制截断旁瓣
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (SINC_TAPS / 2));
      t[p * SINC_TAPS + k] = s * w;
    }
  }
  sincCache = t;
  return t;
}
