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
      // 相对路径与 pianoSamples 一致（各入口页都在根目录），不依赖打包器的 BASE_URL
      const [mp3Res, jsonRes] = await Promise.all([
        fetch(`instrument-samples/${patch}.mp3`),
        fetch(`instrument-samples/${patch}.json`),
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

/** 播放前预加载一批音色（去重、失败静默——回落合成） */
export async function preloadInstrumentSamples(patches: (number | undefined)[]): Promise<void> {
  const set = new Set(patches.filter((p): p is number => p !== undefined && p > 0));
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
  const read = (idx: number): number => {
    if (idx < point.loopStart) return idx >= point.start ? pcm[idx] : 0;
    return pcm[point.loopStart + (((idx - point.loopStart) % loopLen) + loopLen) % loopLen];
  };
  for (let i = 0; i < outN; i++) {
    const src = point.start + i * ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    out[i] = read(i0) * (1 - frac) + read(i0 + 1) * frac;
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
