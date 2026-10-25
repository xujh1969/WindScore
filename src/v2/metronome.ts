/**
 * 节拍器 · 纯计算部分：节奏型（拍内细分）、拍号强弱、click 采样、击打点排程。
 *
 * 细分位置用**拍内整数 tick 偏移**表达（6720 tick = 一拍），
 * 和编辑器里的时值网格是同一套刻度：十六分 = 1680、三连音 = 2240。
 * 只跟**变速**，不跟移调——移调不改变节拍。
 * 这一层不碰 Web Audio，可以在 node 里直接测。
 */

import { TICKS_PER_BEAT } from './ticks';

export interface MetronomePattern {
  id: string;
  label: string;
  /** 每拍内的细分位置（拍内 tick 偏移，含 0 = 拍点本身） */
  offsets: number[];
  /** 与 offsets 对应：是否为重音 */
  accents: boolean[];
  /**
   * 每 n 拍打一次（相对**小节锚**对齐：4/4 的 n=2 就是打 1、3 拍）。
   * 默认 1 = 每拍都打。BPM 高时「每拍一下」会很乱，隔拍打更从容（用户实测）。
   */
  stride?: number;
  /** 只打每小节的第一拍（BPM 很高时的最简打点），与 stride 互斥 */
  downbeatOnly?: boolean;
}

const q = TICKS_PER_BEAT;

function pat(
  id: string,
  label: string,
  offsets: number[],
  accents?: boolean[],
  extra?: Pick<MetronomePattern, 'stride' | 'downbeatOnly'>,
): MetronomePattern {
  return {
    id,
    label,
    offsets,
    accents: accents ?? offsets.map((_, i) => i === 0),
    ...extra,
  };
}

/** 节奏型（细分）预设：拍内怎么分、隔几拍打 */
export const METRONOME_PATTERNS: MetronomePattern[] = [
  pat('quarter', '四分（每拍一下）', [0]),
  pat('half', '每 2 拍一下（4/4 打 1、3 拍）', [0], undefined, { stride: 2 }),
  pat('bar', '每小节一下', [0], undefined, { downbeatOnly: true }),
  pat('eighth', '八分（每拍两下）', [0, q / 2]),
  pat('triplet', '三连音（每拍三下）', [0, q / 3, (q * 2) / 3]),
  pat('sixteenth', '十六分（每拍四下）', [0, q / 4, q / 2, (q * 3) / 4]),
  pat('dotted-eighth', '附点八分（长-短-短）', [0, q / 2, (q * 3) / 4]),
  pat('syncopated', '切分（短-长-短）', [0, q / 4, q / 2, (q * 3) / 4], [true, false, true, false]),
  pat('triplet-sixteenth', '三连音里再细分（每拍六下）', [
    0,
    q / 6,
    q / 3,
    q / 2,
    (q * 2) / 3,
    (q * 5) / 6,
  ]),
];

export function patternFor(id: string): MetronomePattern {
  return METRONOME_PATTERNS.find((p) => p.id === id) ?? METRONOME_PATTERNS[0]!;
}

/**
 * 这一拍要不要打：downbeatOnly 只打小节头（重音逻辑本身就是
 * 「小节里第一个响拍」，弱起自动豁免）；stride n 是**小节内模式**——
 * 每小节从第一个响拍（= 重音所在拍）数起，打第 1、1+n、1+2n…拍，
 * 小节一重置。4/4 的 n=2 就是打 1、3 拍（用户要求）；
 * 弱起锚落在半拍上时首响拍相对锚有偏移，从**首响整拍**数起，
 * 曲头弱起里对不上的拍不打。
 * scheduleHits 与 Metronome.pump 两处排程共用，保证口径一致。
 */
export function patternHitsBeat(pattern: MetronomePattern, seg: MeterSegment, beat: number): boolean {
  if (pattern.downbeatOnly) return barAccentAt(seg, beat);
  const stride = pattern.stride ?? 1;
  if (stride <= 1) return true;
  const anchorBeats = seg.anchorTick / TICKS_PER_BEAT;
  const barBeats = seg.barTicks / TICKS_PER_BEAT;
  const firstHit = Math.ceil(anchorBeats - 1e-9); // 小节里第一个响的整拍
  const k = beat - firstHit;
  if (k < 0) return false; // 曲头弱起：还没进第一个完整小节，不打
  // 拍号是小节的整数倍拍（3/8 的 1.5 除外）时按小节内偏移折回；
  // 非整数拍退化成按整拍数取模（3/8 每小节才 1.5 拍，隔拍语义本来就模糊）
  const j = barBeats % 1 < 1e-9 ? k % barBeats : k % Math.ceil(barBeats);
  return Math.abs(j / stride - Math.round(j / stride)) < 1e-6;
}

/**
 * 拍号 → 每小节几拍、强拍间隔几拍。
 * 4/4 → 4 拍、每 4 拍一个强拍；6/8 → 3 拍、每 3 拍一个强拍。
 * 只做**展示**用（面板上告诉用户强弱怎么打）；真正的击打强弱走 meterSegmentsOf，
 * 因为它还要处理小节线换拍和弱起小节。
 */
export function meterBeats(beat: string): { beatsPerBar: number; strongEvery: number } {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(beat.trim());
  if (!m) return { beatsPerBar: 4, strongEvery: 4 };
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) {
    return { beatsPerBar: 4, strongEvery: 4 };
  }
  const beatsPerBar = Math.max(1, Math.round((num * 4) / den));
  return { beatsPerBar, strongEvery: beatsPerBar };
}

/** 拍号 → 一小节多少 tick。6720 tick 一拍时所有合法拍号都是整数（3/8 = 10080） */
export function barTicksOf(beat: string): number {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(beat.trim());
  if (!m) return 4 * TICKS_PER_BEAT;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 4 * TICKS_PER_BEAT;
  return Math.max(1, Math.round(((num * 4) / den) * TICKS_PER_BEAT));
}

/** 拍号段：从 fromTick（含）起用这套拍号；小节线落在 anchorTick + k×barTicks 上 */
export interface MeterSegment {
  fromTick: number;
  anchorTick: number;
  barTicks: number;
}

/** 「这个位置属于哪套拍号」的查询 */
export type MeterAt = (tick: number) => MeterSegment;

/** 恒定拍号的便捷构造（测试 / 简单场景用） */
export function constantMeter(beatsPerBar: number): MeterAt {
  const seg: MeterSegment = { fromTick: 0, anchorTick: 0, barTicks: beatsPerBar * TICKS_PER_BEAT };
  return () => seg;
}

/**
 * 这一拍是不是它所在小节的**第一拍**。
 *
 * 规则：小节线落在「上一拍与本拍之间（含本拍）」→ 本拍是小节里第一个响的拍 → 重音。
 * 不要求小节线正好压在整拍上：弱起小节（如 0.5 拍不完全小节）、3/8 这类
 * 非整数拍的拍号，小节线会落在两拍中间——那时重音给小节里的**第一个响拍**，
 * 强弱循环仍然和谱面小节一一对应，只是整体挪到最近的拍点上。
 */
function barAccentAt(seg: MeterSegment, beat: number): boolean {
  const anchorBeats = seg.anchorTick / TICKS_PER_BEAT;
  const barBeats = seg.barTicks / TICKS_PER_BEAT;
  const k = Math.floor((beat - anchorBeats) / barBeats + 1e-9);
  const lastBarStart = anchorBeats + k * barBeats;
  return lastBarStart > beat - 1 + 1e-9;
}

/**
 * 谱面事件 → 拍号段查询，**支持小节线上的中途换拍**（DSL「拍3/4」）。
 *
 * 逐事件累计时值拿到每根小节线的位置；`beatAfter` 从那根线**之后**生效，
 * 所以新段落的强拍锚在那根小节线上。第一根小节线也当锚——
 * 这样弱起（不完全小节）自动对齐：弱起里的拍不算小节头，不该响重音。
 * 非整数拍的拍号（3/8、5/8：一小节不是整数个四分拍）也不会错位——
 * 只有正好落在小节线上的拍才给重音，其余都是轻拍。
 */
export function meterSegmentsOf(
  events: readonly {
    kind: string;
    ticks?: number;
    beatAfter?: string;
  }[],
  initialBeat: string,
): MeterAt {
  const segs: MeterSegment[] = [{ fromTick: 0, anchorTick: 0, barTicks: barTicksOf(initialBeat) }];
  let tick = 0;
  let current = initialBeat;
  let anchored = false;
  for (const ev of events) {
    if (ev.kind === 'note' || ev.kind === 'rest') {
      tick += ev.ticks ?? 0;
      continue;
    }
    if (ev.kind !== 'barline') continue;
    if (!anchored) {
      // 第一根小节线 = 第一个完整小节的头，弱起时它不在 0
      segs[0] = { fromTick: 0, anchorTick: tick, barTicks: barTicksOf(current) };
      anchored = true;
    }
    if (ev.beatAfter && ev.beatAfter !== current) {
      current = ev.beatAfter;
      segs.push({ fromTick: tick, anchorTick: tick, barTicks: barTicksOf(current) });
    }
  }
  return (tickAt: number): MeterSegment => {
    let seg = segs[0]!;
    for (const s of segs) {
      if (s.fromTick <= tickAt) seg = s;
      else break;
    }
    return seg;
  };
}

/**
 * 节拍器的一击：短促的木鱼声。
 * 高频正弦 + 极短的噪声瞬态（槌击感），指数衰减。
 * 固定种子的伪随机，保证同一参数每次结果一致（可测试）。
 */
export function clickSample(sampleRate: number, accent: boolean): Float32Array {
  const dur = accent ? 0.055 : 0.04;
  const n = Math.max(1, Math.floor(sampleRate * dur));
  const out = new Float32Array(n);
  const freq = accent ? 1860 : 1240;
  const amp = accent ? 0.85 : 0.45;
  const decay = accent ? 95 : 135;
  let seed = accent ? 20260101 : 20260202;
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    const env = Math.exp(-t * decay);
    const body = Math.sin(2 * Math.PI * freq * t) * amp;
    const transient = noise * Math.exp(-t * 340) * 0.3;
    out[i] = (body + transient) * env;
  }
  return out;
}

export interface MetronomeHit {
  /** 相对起点的秒数 */
  timeSec: number;
  /** 是否重音 */
  accent: boolean;
}

/**
 * 节拍器在哪些场景出现：**只在「合成音」的播放场景**。
 *
 * - 记谱页（简谱剪辑）放的一直是合成音 → 一直有
 * - 播放页 / 动态谱生成页：选「伴奏」时暂时不做
 *
 * 理由：伴奏的拍格来自对轨标定，和谱面的拍号未必一致，
 * 让节拍器跟着伴奏跑容易对错位；合成音按谱面速度逐拍算，拍格绝对准。
 *
 * 抽成纯函数是为了这条规则能进单测——UI 里散着写判断，没人记得改。
 */
export function metronomeAvailable(mode: string, playSource: 'synth' | 'audio'): boolean {
  return mode === 'score' || playSource === 'synth';
}

/**
 * 排出一段时间内的所有击打点。
 *
 * @param fromSec   起点（秒）
 * @param toSec     终点（秒）
 * @param beatToSec 拍 → 秒的换算。入参是**绝对谱面拍**（小节首拍 = 0），
 *                  所以强弱（每小节第一拍重音）才能跟谱面的拍号对上；
 *                  恒定速度传常数函数；变速跟随传 tempo 标定
 * @param meterAt   这个位置属于哪套拍号（谱面拍 tick → 段落）。
 *                  小节线换拍、弱起小节都由它决定
 * @param startBeat 从第几拍开始排（绝对谱面拍）。默认 0；
 *                  从曲子中段开始导出时用它跳过前面空转的那些拍
 */
export function scheduleHits(opts: {
  fromSec: number;
  toSec: number;
  beatToSec: (beat: number) => number;
  meterAt: MeterAt;
  pattern: MetronomePattern;
  startBeat?: number;
}): MetronomeHit[] {
  const { fromSec, toSec, beatToSec, meterAt, pattern } = opts;
  const hits: MetronomeHit[] = [];
  if (!(toSec > fromSec)) return hits;
  const first = Math.max(0, Math.floor(opts.startBeat ?? 0));
  const maxBeats = 20000;
  for (let beat = first; beat < first + maxBeats; beat += 1) {
    const beatSec = beatToSec(beat);
    if (beatSec >= toSec) break;
    const tick = beat * TICKS_PER_BEAT;
    const seg = meterAt(tick);
    // stride / downbeatOnly：这一拍该不该打（隔拍打、每小节一下）
    if (!patternHitsBeat(pattern, seg, beat)) continue;
    // 强弱按**谱面位置**算：这一拍是不是它所在小节的第一拍。
    // 换拍、弱起、非整数拍（3/8）都由 barAccentAt 统一对齐
    const barAccent = barAccentAt(seg, beat);
    for (let k = 0; k < pattern.offsets.length; k += 1) {
      const off = pattern.offsets[k]!;
      const t = beatSec + (off / TICKS_PER_BEAT) * (beatToSec(beat + 1) - beatSec);
      // 区间取左闭右开：正好落在 toSec 的那一击归下一段
      if (t < fromSec || t >= toSec) continue;
      hits.push({ timeSec: t, accent: barAccent && (pattern.accents[k] ?? false) });
    }
  }
  hits.sort((a, b) => a.timeSec - b.timeSec);
  return hits;
}

export interface MetronomeOptions {
  /**
   * 拍 → 秒的换算。**必填**：节拍器没有自己的速度，
   * 速度一律由谱面给（恒速就是谱面 BPM，变速就传 tempo 标定）。
   */
  beatToSec: (beat: number) => number;
  /** 这个谱面 tick 属于哪套拍号（强弱跟着它走，含小节线换拍） */
  meterAt: MeterAt;
  pattern?: MetronomePattern;
  /** 音量 0~1 */
  volume?: number;
}

const TIMER_MS = 40;
const SCHEDULE_AHEAD = 0.3;

/**
 * 节拍器引擎：自己管一个 AudioContext，自己排程。
 *
 * 与音乐是**并行**关系（不是替代）：它按自己的时钟打拍，
 * 启动时对齐到音乐的当前拍，之后各走各的——两个 AudioContext 走同一硬件时钟，
 * 漂移远小于人耳可感阈值。
 *
 * 速度**只认谱面**：引擎里没有 BPM 这个概念，得由调用方把「拍 → 秒」喂进来。
 * 这样就不可能出现「节拍器按自己的速度打，和曲子对不上」的情况。
 */
export class Metronome {
  private ctx: AudioContext | null = null;
  private timer: number | null = null;
  private click: { accent: AudioBuffer; plain: AudioBuffer } | null = null;
  /** 已排程还没响完的 click：停表时要撤掉，不然停了还会蹦出一两声「鬼拍」 */
  private active: { src: AudioBufferSourceNode; end: number }[] = [];
  private startSec = 0;
  /** start() 时刻的墙钟（秒）：上下文没跑起来时锚点要等 running 后补算用 */
  private startWall = 0;
  /** start() 传入的第一拍延迟：needAnchor 补算时要用它（相对 start() 时刻） */
  private pendingDelay = 0;
  /** true = 上下文还没真正 running，锚点待 pump 里补算（见 start / pump） */
  private needAnchor = false;
  /** 起拍时那一拍对应的秒（相对节拍器自己的起点） */
  private baseSec = 0;
  /** 下一个要打的整拍（永远是整数拍，节拍格不跑偏） */
  private nextBeat = 0;
  private beatToSec: (beat: number) => number = () => 0;
  private meterAt: MeterAt = constantMeter(4);
  private pattern: MetronomePattern = METRONOME_PATTERNS[0]!;
  private volume = 0.6;
  private playing = false;

  get isPlaying(): boolean {
    return this.playing;
  }

  setPattern(pattern: MetronomePattern): void {
    this.pattern = pattern;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
  }

  /**
   * 拿到（或新建）音频上下文与 click 采样，并确保它在跑。
   *
   * 自动播放策略：浏览器只在「有用户手势」时才允许出声，新建/挂起的
   * AudioContext 的 currentTime 根本不走 —— 排进去的 click 一个都不会响，
   * 而且**没有任何报错**。所以每次用到之前都 resume 一遍。
   */
  private ensureContext(): AudioContext | null {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      const ctx = new Ctor();
      this.ctx = ctx;
      const sr = ctx.sampleRate;
      const mk = (samples: Float32Array): AudioBuffer => {
        const buf = ctx.createBuffer(1, samples.length, sr);
        buf.getChannelData(0).set(samples);
        return buf;
      };
      this.click = {
        accent: mk(clickSample(sr, true)),
        plain: mk(clickSample(sr, false)),
      };
    }
    this.resume();
    return this.ctx;
  }

  /**
   * 立刻打一声（不改变打拍状态）。
   * 用途：确认声音通不通；顺带把被自动播放策略挂起的上下文救活
   *（这个点击本身就是用户手势）。
   */
  clickOnce(accent = true): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.click) return;
    const src = ctx.createBufferSource();
    src.buffer = accent ? this.click.accent : this.click.plain;
    const g = ctx.createGain();
    g.gain.value = this.volume;
    src.connect(g);
    g.connect(ctx.destination);
    src.start(ctx.currentTime + 0.02);
  }

  /**
   * 立刻把音频上下文建好并解锁（**必须在用户手势里调**）。
   *
   * 浏览器只在「有用户手势」时才允许出声。手势的窗口只有几秒，
   * 而播放前可能要先做几秒的变调/变速处理——等处理完再建上下文，
   * 窗口早就过了，上下文会被挂起：**排进去的 click 一个都不响，还没有任何报错**。
   * 所以在用户点「开面板 / 开节拍器」的那一刻就把上下文建好，之后一直复用。
   */
  unlock(): void {
    this.ensureContext();
  }

  /**
   * 开始打拍。
   * @param fromBeat 从第几拍开始（0 = 起点）
   * @param delaySec 第一拍还要等几秒才响。与音乐一起起播时必须传音乐的
   *   lead-in（音频上下文初始化 + START_LEAD）：不传的话 click 会抢在
   *   第一个音符前面（最多几百毫秒），听起来像被拍子追着跑（用户实测）。
   *   播放中途按当前拍重起时传 0——此刻音乐正在响 fromBeat 这一拍。
   */
  start(opts: MetronomeOptions, fromBeat = 0, delaySec = 0): void {
    this.stopTimer();
    this.beatToSec = opts.beatToSec;
    this.meterAt = opts.meterAt;
    this.pattern = opts.pattern ?? this.pattern;
    this.volume = opts.volume ?? this.volume;

    const ctx = this.ensureContext();
    if (!ctx) return;
    // 记下 start() 时刻的墙钟：上下文没跑起来时 currentTime 不可信，
    // 得等它真正 running 才能锚（见 pump 里的 needAnchor 分支）
    this.startWall = performance.now() / 1000;
    this.pendingDelay = delaySec;
    // **刚建好 / 被自动播放策略挂起的上下文，currentTime 冻结在旧值**（新建的
    // 停在 0 附近，等音频线程转起来才走）。拿它锚定的话整串 click 都错位——
    // 播放中途第一次开节拍器就是这条路径，用户实测「不同步，重开才同步」。
    this.needAnchor = ctx.state !== 'running';
    if (!this.needAnchor) this.startSec = ctx.currentTime + delaySec;
    this.baseSec = this.secOf(fromBeat);
    // 只在整拍上打：从半拍处起播时，第一下落在下一个整拍（不跑偏）
    this.nextBeat = Math.ceil(fromBeat - 1e-9);
    this.playing = true;

    this.timer = window.setInterval(() => this.pump(), TIMER_MS);
  }

  /**
   * 恢复音频上下文。
   *
   * 浏览器只在「有用户手势」时才允许出声；被策略挂起时 context.state 是
   * 'suspended'。这里幂等地反复试：用户下一次点击就会把它救活。
   */
  resume(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'running') return;
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => { /* 等下一次手势 */ });
    } catch {
      /* 老浏览器没有 resume：忽略 */
    }
  }

  /** 音频上下文是否真的在走（false = 被自动播放策略挂着，不会有声音） */
  get audible(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * 停止打拍。
   *
   * **不关音频上下文**：留着它下次才能立刻出声（关掉再新建会重新撞上
   * 自动播放策略）。上下文只在组件卸载时 dispose。
   */
  stop(): void {
    this.stopTimer();
    // 撤掉已排程但还没响的 click：窗口外那部分是「整拍一起排」多排出去的，
    // 不撤的话停表之后还会蹦出最多一两声
    for (const s of this.active) {
      try { s.src.stop(); } catch { /* 已经响完的 stop 会抛，忽略 */ }
    }
    this.active = [];
    this.playing = false;
    this.nextBeat = 0;
    this.baseSec = 0;
    this.needAnchor = false;
  }

  /** 彻底关掉（组件卸载时调用） */
  dispose(): void {
    this.stop();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      this.click = null;
      void ctx.close();
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 当前拍 → 秒（相对起点）。速度只认谱面给的换算表 */
  private secOf(beat: number): number {
    return this.beatToSec(beat);
  }

  private pump(): void {
    const ctx = this.ctx;
    if (!ctx || !this.click || !this.playing) return;
    // 被自动播放策略挂着时 currentTime 不走，排了也是白排：先试着救活
    if (ctx.state !== 'running') {
      this.resume();
      return;
    }
    const until = ctx.currentTime + SCHEDULE_AHEAD;
    // start() 时上下文还没跑起来：此刻它已 running，currentTime 是可信的——
    // 现在才锚。start() 到现在流逝的墙钟要补回去（delaySec 相对 start() 时刻），
    // 否则整串 click 相对音乐永久错位（错多少取决于上下文启动耗时）。
    if (this.needAnchor) {
      this.needAnchor = false;
      this.startSec = ctx.currentTime - (performance.now() / 1000 - this.startWall) + this.pendingDelay;
      // 挂起期间音乐已经走远的话，锚点落在过去——整拍跳到下一个还没响的位置，
      // 别把错过的拍连排一串、一开表就补响一通
      const late = ctx.currentTime - (this.startSec + (this.secOf(this.nextBeat) - this.baseSec));
      if (late > 0.05) {
        const beatLen = Math.max(0.05, this.secOf(this.nextBeat + 1) - this.secOf(this.nextBeat));
        this.nextBeat += Math.ceil(late / beatLen);
      }
    }
    for (let guard = 0; guard < 64; guard += 1) {
      const beat = this.nextBeat;
      const beatSec = this.secOf(beat);
      // 相对起拍点的时刻：baseSec 是起拍那一拍的时刻
      const at = this.startSec + (beatSec - this.baseSec);
      if (at > until) break;
      const beatLen = this.secOf(beat + 1) - beatSec;
      // 强弱按**谱面位置**算：这一拍是不是它所在小节的第一拍。
      // 2/4、3/4、4/4 各按各的小节来，小节线中途换拍、弱起小节也跟着对
      const tick = beat * TICKS_PER_BEAT;
      const seg = this.meterAt(tick);
      const barAccent = barAccentAt(seg, beat);
      // stride / downbeatOnly：这一拍该不该打（与 scheduleHits 同一个纯函数）
      if (patternHitsBeat(this.pattern, seg, beat)) {
        for (let k = 0; k < this.pattern.offsets.length; k += 1) {
          const off = this.pattern.offsets[k]!;
          const t = at + (off / TICKS_PER_BEAT) * beatLen;
          // 注意：拍内细分**不能**按 until 截断——排程窗口只有 0.3 秒，
          // 而 90 BPM 的一拍就有 0.67 秒，拍内第二下永远在窗口外，
          // 一截断就全变成「每拍一下」，节奏型等于没起作用。
          // 所以整拍一起排，最多排到窗口外一拍，Audio 自己会准点响。
          const accent = barAccent && (this.pattern.accents[k] ?? false);
          const src = ctx.createBufferSource();
          src.buffer = accent ? this.click.accent : this.click.plain;
          const g = ctx.createGain();
          g.gain.value = this.volume;
          src.connect(g);
          g.connect(ctx.destination);
          src.start(Math.max(ctx.currentTime, t));
          this.active.push({ src, end: t + src.buffer.duration });
        }
      }
      this.nextBeat = beat + 1;
      // 已响完的 click 从列表里清掉，别让它越积越多
      if (guard % 8 === 7) this.active = this.active.filter((s) => s.end > ctx.currentTime);
    }
  }
}
