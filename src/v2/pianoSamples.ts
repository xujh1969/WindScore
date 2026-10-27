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

/** 采样资源的缓存版本号（vite define 注入；node 测试环境无此常量 → 空串） */
declare const __WS_VERSION__: string | undefined;
function cacheBust(url: string): string {
  const v = typeof __WS_VERSION__ !== 'undefined' ? __WS_VERSION__ : '';
  return v ? `${url}?v=${v}` : url;
}

/**
 * 解码后音高自检：抽一个中音区采样点测主频，偏差超过 ±60 音分判定
 * 「偏移表与音频错配」（典型原因：HTTP 缓存留下了新旧版本的 json / mp3 组合）。
 * 错配的采样会**整体变调**（0.4.13 用户实测「换到钢琴音色就变调」），
 * 此时宁可不装采样回纯合成（频率精确），绝不能带着错位采样出声。
 */
function verifySamplePitch(pcm: Float32Array, sr: number, notes: { midi: number; start: number; len: number }[]): boolean {
  const probe = notes.find((n) => n.midi === 69) ?? notes.find((n) => n.midi >= 57 && n.midi <= 72);
  if (!probe) return true;
  const from = probe.start + Math.round(0.3 * sr);
  const to = Math.min(probe.start + Math.round(1.0 * sr), pcm.length);
  if (to - from < 4096) return true; // 段太短没法测，放行
  const seg = pcm.subarray(from, to);
  const expect = 440 * 2 ** ((probe.midi - 69) / 12);
  const mag = (freq: number): number => {
    const w = (2 * Math.PI * freq) / sr;
    const cw = 2 * Math.cos(w);
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < seg.length; i++) { s0 = seg[i] + cw * s1 - s2; s2 = s1; s1 = s0; }
    return Math.sqrt(s1 * s1 + s2 * s2 - cw * s1 * s2) / seg.length;
  };
  let best = 0;
  for (let c = -300; c <= 300; c += 10) {
    const m = mag(expect * 2 ** (c / 1200));
    if (m > best) best = m;
  }
  const at0 = mag(expect);
  return at0 >= best * 0.6; // 主频就在基频附近（±60 音分内）才算对齐
}

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
      const [mp3Buf, jsonRes] = await Promise.all([fetch(cacheBust(mp3Url)), fetch(cacheBust(jsonUrl))]);
      if (!mp3Buf.ok || !jsonRes.ok) return false;
      const manifest = JSON.parse(await jsonRes.text()) as SamplesManifest;
      const decoded = await ctx.decodeAudioData(await mp3Buf.arrayBuffer());
      const ch = decoded.getChannelData(0);
      // decodeAudioData 自动重采样到上下文采样率：清单里的偏移按比例换算
      const ratio = decoded.sampleRate / manifest.sr;
      // 音高自检：偏移表与音频错配（典型是 HTTP 缓存留了新旧组合）会整体变调，
      // 不装采样回纯合成，绝不带着错位出声
      if (!verifySamplePitch(ch, decoded.sampleRate, manifest.notes)) {
        if (typeof console !== 'undefined') console.warn('[WindScore] 钢琴采样自检未通过（疑似缓存了新旧错配的资源），本次会话回退纯合成钢琴');
        return false;
      }
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
