/**
 * 真实钢琴采样（整段回放）：加载 public/piano-samples.mp3 + .json
 * （见 scripts/build-piano-samples.mjs）。
 *
 * 数据是 Salamander Grand Piano v3（Yamaha C5 实录，Alexander Holm，CC-BY 3.0）
 * 按音区裁到 3~8s 的**完整自然衰减**——绝大多数音符从头到尾都是真实录音，
 * 合成延音只兜底（采样未加载）和续超长音（> 采样长度，低能量交接）。
 *
 * 解码用 AudioContext.decodeAudioData（浏览器原生 MP3 解码，零 wasm），
 * 它会自动重采样到所在上下文的采样率——renderNote 里的 sr 比例换算仍保留，
 * 两条路都正确。解码失败（无 AudioContext / 拉取失败 / node 测试环境）
 * 静默回退纯合成，renderNote 的行为对调用方透明。
 *
 * 注册表是模块级单例：实时播放与离线导出跑同一个 renderNote，
 * 只要两边在出声前都调过 loadPianoSamples()，听感必然一致。
 */

/** 一个可用的采样（完整自然衰减段） */
export interface PianoSample {
  /** 采样根音的 midi 号（采样按小三度分布，中间音靠变调重放） */
  midi: number;
  pcm: Float32Array;
  /** 这段数据的采样率（decodeAudioData 已重采样到解码上下文的采样率） */
  sr: number;
}

interface SamplesManifest {
  sr: number;
  notes: { midi: number; start: number; len: number }[];
}

let registry: PianoSample[] = [];
let loading: Promise<boolean> | null = null;

/** 测试用：直接注入采样表（node 测试不经过 fetch / decodeAudioData） */
export function setPianoSamplesForTest(notes: PianoSample[]): void {
  registry = notes;
}

/** 测试用：清空（回到纯合成） */
export function clearPianoSamplesForTest(): void {
  registry = [];
}

/** 解码上下文：OfflineAudioContext 不占音频设备，decodeAudioData 照常可用 */
function decodeContext(): OfflineAudioContext | null {
  const w = window as unknown as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor(1, 44100, 44100);
  } catch {
    return null;
  }
}

/**
 * 拉取并解码采样。幂等：并发/重复调用共享同一次请求。
 * 返回是否装载成功（失败静默——纯合成兜底，不弹错）。
 */
export function loadPianoSamples(
  mp3Url = 'piano-samples.mp3',
  jsonUrl = 'piano-samples.json',
): Promise<boolean> {
  if (registry.length) return Promise.resolve(true);
  if (!loading) {
    loading = (async () => {
      const ctx = decodeContext();
      if (!ctx) return false;
      const [mp3Buf, jsonRes] = await Promise.all([fetch(mp3Url), fetch(jsonUrl)]);
      if (!mp3Buf.ok || !jsonRes.ok) return false;
      const manifest = JSON.parse(await jsonRes.text()) as SamplesManifest;
      const decoded = await ctx.decodeAudioData(await mp3Buf.arrayBuffer());
      const ch = decoded.getChannelData(0);
      // decodeAudioData 自动重采样到上下文采样率：清单里的偏移按比例换算
      const ratio = decoded.sampleRate / manifest.sr;
      registry = manifest.notes.map((n) => ({
        midi: n.midi,
        sr: decoded.sampleRate,
        pcm: ch.subarray(Math.round(n.start * ratio), Math.round((n.start + n.len) * ratio)),
      }));
      return registry.length > 0;
    })().catch(() => false);
  }
  return loading;
}

/**
 * 离 midi 最近的采样根音（采样点按小三度分布，最近距离 ≤ 1.5 半音）。
 * 返回 null 表示没有采样（回退纯合成）。
 */
export function pianoSampleFor(midi: number): { sample: PianoSample; ratio: number } | null {
  if (!registry.length) return null;
  let best: PianoSample | null = null;
  let bestDist = Infinity;
  for (const s of registry) {
    const d = Math.abs(s.midi - midi);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  if (!best) return null;
  return { sample: best, ratio: 2 ** ((midi - best.midi) / 12) };
}
