/**
 * 真采样音色（FluidR3_GM，MIT 许可）：按 patch 懒加载「拼接 MP3 + 清单」，
 * 循环平铺回放。实时播放 / 离线导出 / 输入试听**共用同一条渲染代码**。
 *
 * 资源：public/instrument-samples/{patch}.mp3 + {patch}.json
 * 产出管线：scripts/build-instrument-samples.mjs（起音对齐 → 循环段检测 →
 * 循环段自身交叉淡化无缝化 → 响度归一 → 拼接编码；每 2 个半音一个采样点）。
 *
 * 许可：内置这些是 FluidR3_GM（CC BY 3.0，Frank Wen），只需署名、可以并进程序包；
 * MusyngKite 那批是 **CC BY-SA 3.0**（有传染性共享），只能做成独立的音色包分发，
 * 不能并进主程序——所以它以 .wsbank 的形式由用户自行导入（见 ui/instrumentBank.ts）。
 *
 * 与钢琴采样（pianoSamples.ts）的区别：钢琴是衰减采样整段回放，
 * 簧/弦/管乐器是**持续发声**——清单里的循环段 [loopStart, loopEnd) 在
 * 运行时按音长平铺，音尾接 90ms 淡出（松键）。
 *
 * 策略（与钢琴采样同款）：
 *   - patch 的采样没加载 / 加载失败 → `instrumentSampleFor` 返回 null，
 *     调用方回落钢琴合成——「还没加载好」和「没有采样」都静默回落；
 *   - 上下文策略：加载不碰 AudioContext（纯 fetch + decode），
 *     由播放方先建好上下文再等加载（Web Audio 手势窗口教训 0.2.101）。
 */

export interface SamplePoint {
  /** 采样点根音（MIDI）：回放别的音按 ratio = 2^((midi-根音)/12) 变调 */
  midi: number;
  /** 该点在拼接 PCM 里的起音位置（样本） */
  start: number;
  /** 循环段起点（样本）：已做自身交叉淡化，平铺无缝 */
  loopStart: number;
  loopEnd: number;
  /** 起音段 + 一段循环的总长（样本） */
  length: number;
  /** 响度归一系数：录音电平不一，统一到与钢琴合成一个量级 */
  gain: number;
}

export interface InstrumentManifest {
  name: string;
  label: string;
  patch: number;
  sampleRate: number;
  license: string;
  points: SamplePoint[];
}

/**
 * 内置真采样音色（打进程序包，随程序分发）。
 * 许可：FluidR3_GM（CC BY 3.0，Frank Wen），经 gleitz/midi-js-soundfonts 预渲染。
 * 音色包（.wsbank）可以**按 GM 号覆盖**这里任何一项——见 registerBankInstrument。
 */
export const INSTRUMENT_LABELS: Record<number, string> = {
  21: '手风琴',
  22: '口琴',
  40: '小提琴',
  65: '中音萨克斯',
  66: '次中音萨克斯',
  73: '长笛',
};

interface Loaded {
  pcm: Float32Array;
  manifest: InstrumentManifest;
}

/** 音色包里注册的音色：还没解码的 MP3 字节 + 它的来源包名 */
interface BankEntry {
  manifest: InstrumentManifest;
  mp3: Uint8Array;
  bank: string;
}

const loaded = new Map<number, Loaded>();
const loading = new Map<number, Promise<Loaded | null>>();
/** patch → 音色包条目；与内置同号时**包优先**（高保真替换内置） */
const banks = new Map<number, BankEntry>();

export function instrumentPatches(): number[] {
  const set = new Set<number>([...Object.keys(INSTRUMENT_LABELS).map(Number), ...banks.keys()]);
  return [...set].sort((a, b) => a - b);
}

export function instrumentLabel(patch: number): string | null {
  return banks.get(patch)?.manifest.label ?? INSTRUMENT_LABELS[patch] ?? null;
}

/**
 * 简略名：去掉括号里的补充（真采样来源、外文原名等），谱面标注与下拉用。
 * 「小提琴（Violin）」→「小提琴」；整个名字都在括号里时原样返回。
 */
export function shortInstrumentLabel(patch: number): string | null {
  const raw = instrumentLabel(patch);
  if (!raw) return null;
  const s = raw.replace(/[（(][^（）()]*[）)]/g, '').trim();
  return s || raw;
}

/** 音色来源：内置 / 音色包名（下拉里标出来，也方便排查「怎么声音变了」） */
export function instrumentSource(patch: number): string {
  const b = banks.get(patch);
  return b ? b.bank : '内置';
}

/** 当前已注册的音色包条目（UI 列出用） */
export function bankInstruments(): { patch: number; label: string; bank: string }[] {
  return [...banks.entries()].map(([patch, e]) => ({ patch, label: e.manifest.label, bank: e.bank }));
}

/**
 * 注册一件音色包里的音色（覆盖同号的内置 / 已注册音色，下次取用时重新解码）。
 * 只登记字节，**不在这里解码**——包里可能有几十件，用哪个才解哪个。
 */
/** 音色包登记变化的订阅者（UI 据此刷新音色下拉，免得拿到过期的列表） */
const bankListeners = new Set<() => void>();

/** 订阅音色包登记变化（导入 / 移除 / 启动恢复都会触发）；返回退订函数 */
export function onInstrumentBanksChange(fn: () => void): () => void {
  bankListeners.add(fn);
  return () => bankListeners.delete(fn);
}

function notifyBanksChanged(): void {
  for (const fn of bankListeners) fn();
}

export function registerBankInstrument(
  manifest: InstrumentManifest,
  mp3: Uint8Array,
  bank: string,
): void {
  banks.set(manifest.patch, { manifest, mp3, bank });
  loaded.delete(manifest.patch);
  loading.delete(manifest.patch);
  notifyBanksChanged();
}

/**
 * 注销一个音色包提供的全部音色（用户在曲库页移除包时调用）。
 * 同号回落内置；包里独占的号直接消失（取不到采样时播放照常回落钢琴合成）。
 * 必须同步清掉已解码的 PCM，否则移除后还在用旧采样响到重开页面。
 */
export function unregisterBank(bank: string): number[] {
  const removed: number[] = [];
  for (const [patch, entry] of [...banks.entries()]) {
    if (entry.bank !== bank) continue;
    banks.delete(patch);
    loaded.delete(patch);
    loading.delete(patch);
    removed.push(patch);
  }
  if (removed.length) notifyBanksChanged();
  return removed;
}

export function isInstrumentLoaded(patch: number): boolean {
  return loaded.has(patch);
}

/**
 * 解码后一次性治理采样点的**循环段**：让 [loopStart, loopEnd) 自己接自己时
 * ① 听不出接缝台阶 ② 没有周期性的忽大忽小。
 *
 * 背景（用户实测）：MusyngKite 音色包的长音在每个循环周期（约 1 秒）接缝处有
 * 明显的一记杂音=「断音」，循环段内还有包络鼓包（听感「中间突然增强」）；
 * 80 BPM 的 3 拍长音正好跨 2~3 次回卷，所以只在慢速长音上、只在某些音上出现。
 * 内置采样出厂已治理过，这两个动作都有幂等保护（没问题就不动），不会对内建音色
 * 造成音色改变；音色包（含第三方 / 旧版）同样受益，且无需重新导入。
 */
/** 接缝交叉淡化的候选窗口：默认 / 上限 / 下限，逐个试（保留最平滑的那个） */
const SEAM_XFADE_SEC = 0.04;
const SEAM_XFADE_SEC_MAX = 0.08;
const SEAM_XFADE_SEC_MIN = 0.02;
const ENV_FRAME_SEC = 0.02;
const ENV_SMOOTH_SEC = 0.08;
/** 电平整形的钳位范围：比出厂管线（0.7~1.6）更收，够把鼓包压平又不改变音色性格 */
const GAIN_MIN = 0.8;
const GAIN_MAX = 1.25;
/** 判定「已经没问题」的阈值 */
const STEADY_OK = 1.22;
/** 电平整形最多做几轮（每轮 ±25%，多轮才能压平 2 倍以上的起伏） */
const STEADY_MAX_PASSES = 6;
/** 段尾/段首电平比低于这个值（或高于它的倒数）判为「单向衰减/渐强」，不压平 */
const DECAY_GUARD = 0.7;

/**
 * 接缝交叉淡化：把循环段尾部与前导素材（紧挨 loopStart 之前的那段）等功率混合，
 * 于是回卷点前后天然接续。只有在回卷处真的存在台阶时才动手。
 */
/**
 * 回卷处的「曲率」代价：把「…段尾三样本 + 循环头三样本」当成连续序列，
 * 二阶差分越小说明接缝越平滑。用它来挑淡化窗口，也用来判定该不该动手。
 */
function seamCost(pcm: Float32Array, point: SamplePoint): number {
  const seq = [point.loopEnd - 3, point.loopEnd - 2, point.loopEnd - 1, point.loopStart, point.loopStart + 1, point.loopStart + 2];
  let cost = 0;
  for (let i = 1; i < seq.length - 1; i++) {
    const a = pcm[seq[i - 1]] ?? 0;
    const b = pcm[seq[i]] ?? 0;
    const c = pcm[seq[i + 1]] ?? 0;
    cost += Math.abs(a - 2 * b + c);
  }
  return cost;
}

export function seamlessLoop(pcm: Float32Array, point: SamplePoint, sampleRate = 44100): void {
  const loopLen = point.loopEnd - point.loopStart;
  if (loopLen <= 8 || point.loopEnd > pcm.length || point.loopStart >= point.loopEnd) return;
  const maxXf = Math.min(Math.round(SEAM_XFADE_SEC_MAX * sampleRate), Math.floor(loopLen / 3));
  if (maxXf < 2) return;
  const backup = pcm.slice(point.loopEnd - maxXf, point.loopEnd);
  let bestCost = seamCost(pcm, point);
  let bestSec = 0; // 0 = 原样最好（出厂已经处理好的采样就不动它）
  for (const sec of [SEAM_XFADE_SEC, SEAM_XFADE_SEC_MAX, SEAM_XFADE_SEC_MIN]) {
    const xf = Math.max(2, Math.min(Math.round(sec * sampleRate), Math.floor(loopLen / 3)));
    const pre = Math.max(point.start, point.loopStart - xf);
    const n = Math.min(xf, point.loopStart - pre);
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / n;
      const wOut = Math.cos((t * Math.PI) / 2);
      const wIn = Math.sin((t * Math.PI) / 2);
      pcm[point.loopEnd - n + i] = backup[backup.length - n + i] * wOut + pcm[pre + i] * wIn;
    }
    const cost = seamCost(pcm, point);
    if (cost < bestCost - 1e-6) { bestCost = cost; bestSec = sec; }
    pcm.set(backup, point.loopEnd - maxXf); // 还原，下次候选从头算
  }
  if (bestSec === 0) return;
  const xf = Math.max(2, Math.min(Math.round(bestSec * sampleRate), Math.floor(loopLen / 3)));
  const pre = Math.max(point.start, point.loopStart - xf);
  const n = Math.min(xf, point.loopStart - pre);
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / n;
    pcm[point.loopEnd - n + i] = backup[backup.length - n + i] * Math.cos((t * Math.PI) / 2) + pcm[pre + i] * Math.sin((t * Math.PI) / 2);
  }
}

/**
 * 循环段电平整形：短时包络向段内中位收拢（±20%），数据必须**环形**处理，
 * 否则循环两端的增益接不上，接缝又被自己破坏。
 */
export function steadySustain(pcm: Float32Array, point: SamplePoint, sampleRate = 44100): void {
  const loopLen = point.loopEnd - point.loopStart;
  if (loopLen <= sampleRate * 0.06 || point.loopEnd > pcm.length) return;
  const frame = Math.max(16, Math.round(ENV_FRAME_SEC * sampleRate));
  const n = Math.max(8, Math.round(loopLen / frame));
  if (loopLen < n) return;
  // 帧长取 loopLen/n：**必须整除整个循环段**，否则尾部残下几个样本没乘增益，
  // 回卷处电平自己就跳一下（实测残余接缝 5.6，就是这个余数造成的）
  const step = loopLen / n;
  const half = Math.max(1, Math.round(ENV_SMOOTH_SEC / ENV_FRAME_SEC));
  // 单轮 §±25% 的钳位只够压一半左右，实际循环段的起伏常常是 2 倍以上：
  // 逐轮逼近（每轮重新量自己的包络），到容差内或最多 STEADY_MAX_PASSES 轮为止。
  for (let pass = 0; pass < STEADY_MAX_PASSES; pass++) {
    const env = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let acc = 0;
      const from = Math.floor(f * step);
      const to = Math.floor((f + 1) * step);
      for (let i = from; i < to; i++) acc += pcm[point.loopStart + i] * pcm[point.loopStart + i];
      env[f] = Math.sqrt(acc / Math.max(1, to - from));
    }
    const target = Float32Array.from(env).sort()[Math.floor(n / 2)] || 0;
    if (target <= 1e-6) return;
    const smooth = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let acc = 0;
      for (let d = -half; d <= half; d++) acc += env[(f + d + n * 4) % n];
      smooth[f] = acc / (2 * half + 1);
    }
    // 波动已经在容差内就不动它（保护出厂已经稳定的采样，避免改音色）
    let worst = 1;
    for (let f = 0; f < n; f++) {
      const s = smooth[f] > 1e-9 ? smooth[f] : target;
      worst = Math.max(worst, s / target, target / s);
    }
    if (worst <= STEADY_OK) return;
    // **衰减型音色（钢琴 / 钟琴 / 马林巴 / 吉他…）不许压平**：它们的循环段是
    // 自然衰减的尾巴，压平后长音变成不衰减的风琴声，比「起伏」更离谱。
    // 判据：段首 / 段尾的平均电平是单向演进（衰或涨），而不是来回起伏。
    const quarter = Math.max(1, Math.floor(n / 4));
    let headAcc = 0;
    let tailAcc = 0;
    for (let f = 0; f < quarter; f++) headAcc += smooth[f];
    for (let f = n - quarter; f < n; f++) tailAcc += smooth[f];
    const head = headAcc / quarter;
    const tail = tailAcc / quarter;
    const trend = head > 1e-9 ? tail / head : 1;
    if (trend <= DECAY_GUARD || trend >= 1 / DECAY_GUARD) return;
    const gain = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      const s = smooth[f] > 1e-9 ? smooth[f] : target;
      gain[f] = Math.min(GAIN_MAX, Math.max(GAIN_MIN, target / s));
    }
    // 按位置插值（跨回卷处用 (f+1)%n），增益曲线本身环形连续
    for (let i = 0; i < loopLen; i++) {
      const p = i / step;
      const f = Math.min(n - 1, Math.floor(p));
      const t = p - f;
      pcm[point.loopStart + i] *= gain[f] + (gain[(f + 1) % n] - gain[f]) * t;
    }
  }
}

/** 解码一件音色后统一走一遍循环段治理（每个采样点只做一次，代价 O(总样本数)） */
export function prepareSamplePoints(pcm: Float32Array, manifest: InstrumentManifest): void {
  const sr = manifest.sampleRate || 44100;
  for (const p of manifest.points) {
    seamlessLoop(pcm, p, sr);
    steadySustain(pcm, p, sr);
  }
}

/** 解码并登记一件音色（纯 PCM，不建播放用上下文） */
async function decodeInto(patch: number, manifest: InstrumentManifest, bytes: ArrayBuffer): Promise<Loaded | null> {
  try {
    // 解码宿主：OfflineAudioContext 的 decodeAudioData（与钢琴采样同一策略）
    const host = new OfflineAudioContext(1, 1, manifest.sampleRate || 44100);
    const buf = await host.decodeAudioData(bytes);
    const ch = buf.numberOfChannels;
    const pcm = new Float32Array(buf.length);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < pcm.length; i++) pcm[i] += d[i] / ch;
    }
    // MP3 解码的样本数可能与清单略有出入：越界的采样点直接判定为不可用，
    // 免得读取时拿到 undefined 变 NaN（整颗音后半截静音）
    for (const p of manifest.points) {
      if (p.start >= pcm.length || p.loopEnd > pcm.length || p.loopEnd <= p.loopStart) {
        p.loopEnd = Math.min(p.loopEnd, Math.max(p.loopStart + 1, pcm.length));
        p.start = Math.min(p.start, pcm.length - 1);
      }
    }
    prepareSamplePoints(pcm, manifest);
    const l: Loaded = { pcm, manifest };
    loaded.set(patch, l);
    return l;
  } catch {
    return null;
  }
}

/**
 * 加载一件音色：音色包优先（同号覆盖内置），其次内置资源，都失败就回落钢琴合成。
 * 不建播放用上下文，失败一律静默。
 */
export async function loadInstrumentSamples(patch: number): Promise<boolean> {
  if (loaded.has(patch)) return true;
  const pending = loading.get(patch);
  if (pending) return (await pending) !== null;
  const task = (async (): Promise<Loaded | null> => {
    const bank = banks.get(patch);
    if (bank) {
      // decodeAudioData 会接管 ArrayBuffer，传副本，避免把包里的字节掏空
      const copy = bank.mp3.slice().buffer;
      const l = await decodeInto(patch, bank.manifest, copy);
      if (l) return l;
    }
    try {
      // 相对路径与 pianoSamples 一致（各入口页都在根目录），不依赖打包器的 BASE_URL；
      // 带版本参数防 HTTP 缓存留新旧错配（偏移表与音频对不上 = 特定音区整体变调）
      const v = typeof __WS_VERSION__ !== 'undefined' ? __WS_VERSION__ : '';
      const suffix = v ? `?v=${v}` : '';
      const [mp3Res, jsonRes] = await Promise.all([
        fetch(`instrument-samples/${patch}.mp3${suffix}`),
        fetch(`instrument-samples/${patch}.json${suffix}`),
      ]);
      if (!mp3Res.ok || !jsonRes.ok) return null;
      const manifest = (await jsonRes.json()) as InstrumentManifest;
      return await decodeInto(patch, manifest, await mp3Res.arrayBuffer());
    } catch {
      return null;
    }
  })();
  loading.set(patch, task);
  return (await task) !== null;
}

/** 采样资源的缓存版本号（vite define 注入；node 测试环境无此常量 → 空串） */
declare const __WS_VERSION__: string | undefined;

/** 播放前预加载一批音色（去重、失败静默——回落合成）。**0 号也要**：装了三角钢琴包时它是真采样（0.4.13 实测过滤掉会导致换到音 0 听到的音色与标注不符） */
export async function preloadInstrumentSamples(patches: (number | undefined)[]): Promise<void> {
  const set = new Set(patches.filter((p): p is number => p !== undefined));
  await Promise.all([...set].map(loadInstrumentSamples));
}

/**
 * 取某 patch 某音的采样：**最近的采样点**（管弦乐音色随音高变化平缓，
 * ±1 半音变调听不出）。没加载 / 没清单 → null，调用方回落钢琴合成。
 */
export function instrumentSampleFor(
  patch: number | undefined,
  midi: number,
): { pcm: Float32Array; point: SamplePoint } | null {
  if (patch === undefined) return null;
  const l = loaded.get(patch);
  if (!l) return null;
  let best = l.manifest.points[0];
  for (const p of l.manifest.points) {
    if (Math.abs(p.midi - midi) < Math.abs(best.midi - midi)) best = p;
  }
  return { pcm: l.pcm, point: best };
}

/**
 * 真采样渲染（纯数值，不碰 Web Audio——与钢琴 renderNote 同约定，可进 node 单测）：
 * 最近点按 ratio 变调 → 起音段 → 循环段平铺到音长 → 力度包络 → 松键 90ms 淡出。
 *
 * **衰减型乐器（钢琴 / 钟琴 / 马林巴 / 吉他…）不回卷**（0.4.12）：它们的循环段
 * 是自然衰减中的尾巴（head/tail 电平单向演进，同 steadySustain 的 DECAY_GUARD
 * 判据），照持续乐器那样平铺 = 每 ~1s 电平跳回循环头，长音听着周期性「重新
 * 敲响」，与合成钢琴的自然衰减判若两琴。衰减点顺着读到循环段尽头，最后 0.25s
 * 余弦淡出收口（拼接 MP3 里 loopEnd 之后已是下一个采样点的数据，绝不能越过）。
 */
export function renderSampledNote(
  pcm: Float32Array,
  point: SamplePoint,
  midi: number,
  opts: { sampleRate: number; durationSec: number; dyn?: number; dynTo?: number },
): Float32Array {
  const sr = opts.sampleRate;
  const dyn = opts.dyn ?? 1;
  const dynTo = opts.dynTo ?? dyn;
  const outN = Math.max(Math.round(0.06 * sr), Math.round(opts.durationSec * sr));
  const out = new Float32Array(outN);
  const ratio = 2 ** ((midi - point.midi) / 12);
  const loopLen = point.loopEnd - point.loopStart;
  // 衰减型判据：循环段头 / 尾各取 1/8 段 RMS，比值 ≤ 0.7 即单向衰减（与
  // steadySustain 的 DECAY_GUARD 同值；双向往返起伏的持续乐器不会触发）
  let decay = false;
  if (loopLen > 0) {
    const q = Math.max(16, Math.floor(loopLen / 8));
    const rms = (from: number, to: number): number => {
      let acc = 0;
      const n = Math.max(1, Math.min(to, pcm.length) - from);
      for (let i = from; i < Math.min(to, pcm.length); i++) acc += pcm[i] * pcm[i];
      return Math.sqrt(acc / n);
    };
    const head = rms(point.loopStart, point.loopStart + q);
    const tail = rms(point.loopEnd - q, point.loopEnd);
    decay = head > 1e-6 && tail / head <= DECAY_GUARD;
  }
  const read = (idx: number): number => {
    if (idx < point.loopStart) return idx >= point.start ? pcm[idx] : 0;
    if (decay) return idx < point.loopEnd ? pcm[idx] : 0; // 衰减点不回卷
    return pcm[point.loopStart + (((idx - point.loopStart) % loopLen) + loopLen) % loopLen];
  };
  for (let i = 0; i < outN; i++) {
    const src = point.start + i * ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    out[i] = read(i0) * (1 - frac) + read(i0 + 1) * frac;
  }
  // 衰减点：到循环段尽头前的 0.25s 余弦淡出（输出域换算），避免读穿到下一个采样点
  if (decay) {
    const totalSrc = point.loopEnd - point.start;
    const fadeI = Math.max(0, Math.round(totalSrc / ratio) - Math.round(0.25 * sr));
    const fadeLen = Math.min(outN - fadeI, Math.round(0.25 * sr));
    for (let i = fadeI; i < outN; i++) {
      out[i] *= i < fadeI + fadeLen ? 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeI)) / Math.max(1, fadeLen)) : 0;
    }
  }
  // 响度：采样点已归一到峰值 0.35，这里乘清单 gain 与力度包络。
  // 力度只控音量（亮度是采样录好的）；dyn→dynTo 线性推进与钢琴渲染同一约定
  for (let i = 0; i < outN; i++) {
    const d = dynTo !== dyn ? dyn + (dynTo - dyn) * (i / outN) : dyn;
    out[i] *= point.gain * (0.6 + 0.4 * d);
  }
  // 松键淡出 90ms（持续乐器没有自然释放，靠这条收口）
  const fade = Math.min(outN, Math.round(0.09 * sr));
  for (let i = 0; i < fade; i++) out[outN - fade + i] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / fade);
  return out;
}
