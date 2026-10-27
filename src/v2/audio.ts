/**
 * 声音播放：谱面合成音（M7）、伴奏 stem 播放（M9）、波形标定试听器。
 *
 * 两种播放模式的时钟不一样，这是整个音频部分最容易搞错的地方：
 *   - 合成音：tick 是**谱面时间轴**，秒 = (tick − fromTick) / (BPM/60 × 每拍 tick)
 *   - 伴奏：  tick 是**音频时间轴**，秒一律走 tempo 标定（tickToSec）
 * 所以 `audioMode` 一开，时间换算就整体切到 tempo 上。
 */

import { tickToSec, secToTick, type TempoMap } from './tempo';
import { TICKS_PER_BEAT } from './ticks';
import { pianoSpec, renderNote } from './timbre';
import { instrumentSampleFor, renderSampledNote } from './instrumentSamples';
import type { TimelineEntry } from './timeline';
import { timelineTicks } from './timeline';

/** 排一次音的提前量（秒）：建 AudioContext 与解算要时间，太紧会切掉开头 */
const START_LEAD = 0.1;
/**
 * 倚音的发声延长（秒）：真采样的松键淡出收在时值终点那一瞬，主音起音又是
 * 一记全新的起音瞬态，接缝上一瞬安静一瞬爆开，听感生硬（用户实测「倚音
 * 演奏过渡不够丝滑」）。倚音多渲染 80ms，让淡出尾巴盖过主音的起音——
 * 接缝从「切断再起」变成重叠过渡。钢琴合成本来就有 release 拖尾，多加无害。
 */
const GRACE_TAIL = 0.08;
/** 合成音调度的时间窗（秒）：只提前排这么多，省得一次性排几千个音 */
const SCHEDULE_AHEAD = 0.3;
const TIMER_MS = 40;

export interface AudioStem {
  buffer: AudioBuffer;
  gain: number;
}

export interface AudioStartOptions {
  timeline: TimelineEntry[];
  tempo: TempoMap;
  fromTick: number;
  stems: AudioStem[];
  /** 伴奏之上是否叠合成音 */
  synth?: boolean;
  /** 整体升降调（半音）：伴奏走离线变调 buffer，合成声部在这里按频率偏移，两层保持同调 */
  semitones?: number;
  onEnded?: () => void;
}

/** 浏览器可能还没有 webkit 前缀 */
function newAudioContext(): AudioContext {
  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  return new Ctor();
}

/**
 * 全局唯一发声通道：任何一端（伴奏 Player / 波形试听 AudioPreview）起播前，
 * 先把别处正在响的停掉。各类自己的 stop() 只能保证「自己不叠自己」；
 * 两端之间（以及组件重挂载换出新实例时）靠这张注册表互斥——
 * 就算 UI 层漏了一次互斥调用（播放状态与播放器实际状态脱节），
 * 也绝不会出现两条音频同时响（用户实测踩过：点波形几次，多层声音叠着放）。
 */
let sounding: { stop(): void } | null = null;

/** 起播前认领发声通道：先停掉别的，再把 self 顶上去（self 自己的 stop 已在调用方先行执行） */
function claimAudio(self: { stop(): void }): void {
  if (sounding && sounding !== self) sounding.stop();
  sounding = self;
}

/** 播放结束 / 主动停止时归还通道 */
function releaseAudio(self: { stop(): void }): void {
  if (sounding === self) sounding = null;
}

export class Player {
  private ctx: AudioContext | null = null;
  private timer: number | null = null;
  /** 合成音模式的起点（ctx 时钟） */
  private startedAt = 0;
  private ticksPerSec = 0;
  private index = 0;
  private fromTick = 0;
  private timeline: TimelineEntry[] = [];
  /** 合成音总音量（钢琴音色的峰值约 0.6，0.28 是听感合适的值） */
  gain = 0.28;
  private audioMode = false;
  /** ctx 时刻 when 对应的音频位置 startSec（秒） */
  private when = 0;
  private startSec = 0;
  /** 音频自然放完的 ctx 时刻（谱尾 ≠ 音频终点） */
  private audioEndSec = Infinity;
  private sources: AudioBufferSourceNode[] = [];
  private stemGains: GainNode[] = [];
  private partBuses = new Map<string, GainNode>();
  private endedCb: (() => void) | null = null;
  private tempo: TempoMap | null = null;
  /** 整体升降调（半音）：只作用于合成声部的振荡器频率；伴奏变调在 buffer 层完成 */
  private semitones = 0;

  /** 播放中热切某条 stem 的音量（30ms 平滑，不会「啪」地一声） */
  setStemGain(index: number, value: number): void {
    const g = this.stemGains[index];
    if (!g || !this.ctx) return;
    g.gain.setTargetAtTime(Math.max(0, Math.min(1, value)), this.ctx.currentTime, 0.03);
  }

  /** 声部混音设置热更新，不重新起播或移动播放头。 */
  setPartGains(timeline: TimelineEntry[]): void {
    const gains = new Map(timeline.filter((e) => e.partId).map((e) => [e.partId!, e.gain ?? 1]));
    this.timeline = this.timeline.map((e) => e.partId && gains.has(e.partId) ? { ...e, gain: gains.get(e.partId) } : e);
    if (!this.ctx) return;
    for (const [id, bus] of this.partBuses) bus.gain.setTargetAtTime(gains.get(id) ?? 0, this.ctx.currentTime, 0.03);
  }

  get isPlaying(): boolean {
    return this.ctx !== null;
  }

  /** 当前音频位置（秒）：伴奏模式 / 合成音变速曲线模式有值；恒定合成音为 null（走线性时钟） */
  get currentSec(): number | null {
    if (!this.ctx) return null;
    if (this.audioMode) return Math.max(0, this.ctx.currentTime - this.when) + this.startSec;
    if (this.tempo) return Math.max(0, this.ctx.currentTime - this.startedAt) + this.startSec;
    return null;
  }

  /** 两种模式都以实际发声的 AudioContext 为时钟，保留任意起播 tick。 */
  get currentTick(): number | null {
    if (!this.ctx) return null;
    const sec = this.currentSec;
    if (sec !== null && this.tempo) return secToTick(this.tempo, sec);
    if (!this.audioMode) return this.fromTick + Math.max(0, this.ctx.currentTime - this.startedAt) * this.ticksPerSec;
    return null;
  }

  /**
   * 合成音起播。返回真实起播延迟（秒）：建 AudioContext 与解算要时间，
   * 调用方要拿它对轨（例如把波形标定的起点往后挪）。
   *
   * `bpmOrMap`：传 BPM（恒定速度，tick 线性换算）或 **TempoMap**（谱中变速
   * 「速96」的曲线，秒走 tickToSec；调用方负责先按倍速 scaleTempo）。
   * 变速只改变发声时刻，排程循环的「按 tick 排」结构不变——曲线在 tick 域
   * 单调递增，`at > until` 的提前截断依然正确。
   */
  start(timeline: TimelineEntry[], bpmOrMap: number | TempoMap, fromTick = 0, semitones = 0): number {
    this.stop();
    if (timeline.length === 0) return 0;
    claimAudio(this);
    this.semitones = semitones;
    const first = timeline.findIndex((e) => e.endTick > fromTick);
    if (first < 0) return 0;

    const map = typeof bpmOrMap === 'object' ? bpmOrMap : null;
    const calledAt = performance.now();
    const ctx = newAudioContext();
    this.ctx = ctx;
    this.timeline = timeline;
    this.index = first;
    this.fromTick = fromTick;
    this.audioMode = false;
    this.tempo = map;
    this.ticksPerSec = map ? 0 : ((bpmOrMap as number) / 60) * TICKS_PER_BEAT;
    this.startedAt = ctx.currentTime + START_LEAD;
    // 曲线模式的 currentSec 复用音频模式的公式：when = 起播 ctx 时刻，startSec = 起播 tick 的秒
    if (map) {
      this.when = this.startedAt;
      this.startSec = tickToSec(map, fromTick);
    }

    const lead = (performance.now() - calledAt) / 1000 + START_LEAD;
    this.timer = window.setInterval(() => {
      if (!this.ctx) return;
      const until = this.ctx.currentTime + SCHEDULE_AHEAD;
      const at = (tick: number): number =>
        map
          ? this.startedAt + tickToSec(map, tick) - this.startSec
          : this.startedAt + (tick - this.fromTick) / this.ticksPerSec;
      for (; this.index < this.timeline.length; ) {
        const e = this.timeline[this.index]!;
        const from = Math.max(e.startTick, this.fromTick);
        const at0 = at(from);
        if (at0 > until) break;
        const endAt = at(e.endTick);
        if (e.midi !== null && (e.partId || (e.gain ?? 1) > 0)) {
          this.tone(ctx, e.midi, at0, endAt, e.gain, e.partId, e.dyn ?? 1, e.dynTo ?? e.dyn ?? 1, e.patch, e.patchOctave ?? 0, e.grace === true);
        }
        this.index += 1;
      }
      const lastEnd = timelineTicks(this.timeline);
      const finishAt = at(lastEnd);
      if (this.index >= this.timeline.length && this.ctx.currentTime > finishAt + 0.3) this.stop();
    }, TIMER_MS);
    return lead;
  }

  /**
   * 音频模式：排真实 stem（可选叠合成音），时刻全走 tempo 标定。
   *
   * 起播锚是 `startSec = tickToSec(fromTick)`：`when`（ctx 时钟上的起播点）
   * 对应音频位置 startSec，之后任何 tick 的发生时刻 = when + tickToSec(tick) − startSec。
   * 这样 fromTick 落在曲中任意位置（含间奏后）都天然对齐，不需要额外偏移。
   */
  startAudio(opts: AudioStartOptions): number {
    this.stop();
    const { timeline, tempo, fromTick, stems, synth, semitones, onEnded } = opts;
    if (timeline.length === 0 || stems.length === 0) return 0;
    const startSec = Math.max(0, tickToSec(tempo, fromTick));
    const duration = Math.max(...stems.map(s => s.buffer.duration));
    if (startSec >= duration) return 0;
    claimAudio(this);
    this.semitones = semitones ?? 0;

    const first = timeline.findIndex((e) => e.endTick > fromTick);
    const calledAt = performance.now();
    const ctx = newAudioContext();
    this.ctx = ctx;
    this.timeline = timeline;
    this.index = first < 0 ? timeline.length : first;
    this.fromTick = fromTick;
    this.tempo = tempo;
    this.audioMode = true;
    this.endedCb = onEnded ?? null;

    this.startSec = startSec;
    this.when = ctx.currentTime + START_LEAD;
    const lead = (performance.now() - calledAt) / 1000 + START_LEAD;

    this.sources = [];
    this.stemGains = [];
    for (const stem of stems) {
      const src = ctx.createBufferSource();
      src.buffer = stem.buffer;
      const g = ctx.createGain();
      g.gain.value = Math.max(0, Math.min(1, stem.gain));
      src.connect(g);
      g.connect(ctx.destination);
      this.sources.push(src);
      this.stemGains.push(g);
    }
    const offset = Math.max(0, startSec);
    for (const src of this.sources) src.start(this.when, offset);
    this.audioEndSec = this.when + Math.max(0.1, duration - offset);

    this.timer = window.setInterval(() => this.scheduleSynth(synth ?? false), TIMER_MS);
    return lead;
  }

  /** 按 tempo 标定把到点的音排进去（伴奏模式下由定时器驱动） */
  private scheduleSynth(withSynth: boolean): void {
    if (!this.ctx || !this.tempo) return;
    const until = this.ctx.currentTime + SCHEDULE_AHEAD;
    const at = (tick: number): number => this.when + tickToSec(this.tempo!, tick) - this.startSec;
    if (withSynth) {
      for (; this.index < this.timeline.length; ) {
        const e = this.timeline[this.index]!;
        const from = Math.max(e.startTick, this.fromTick);
        const t0 = at(from);
        if (t0 > until) break;
        const t1 = at(e.endTick);
        if (e.midi !== null && (e.partId || (e.gain ?? 1) > 0) && t1 > this.ctx.currentTime) {
          this.tone(this.ctx, e.midi, Math.max(t0, this.ctx.currentTime), t1, e.gain, e.partId,
            e.dyn ?? 1, e.dynTo ?? e.dyn ?? 1, e.patch, e.patchOctave ?? 0, e.grace === true);
        }
        this.index += 1;
      }
    }
    if (this.ctx.currentTime > this.audioEndSec + 0.3) {
      const cb = this.endedCb;
      this.stop();
      cb?.();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* 还没 start 过的源调用 stop 会抛，忽略 */
      }
    }
    this.sources = [];
    this.stemGains = [];
    this.partBuses.clear();
    this.endedCb = null;
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      void ctx.close();
    }
    this.index = 0;
    this.audioMode = false;
    this.tempo = null;
    this.semitones = 0;
    releaseAudio(this);
  }

  /**
   * 一个音：钢琴音色（泛音列各自衰减 + 槌击噪声 + 非谐性 + 音区滤波）。
   *
   * 音色与离线导出**共用一份代码**（`src/v2/timbre.ts`）：这里把音渲染成
   * 样本再塞进 AudioBuffer，导出时把同样的样本混进总轨——
   * 所以导出的成品和耳朵里听到的必然是同一个声音。
   * `dyn`／`dynTo` 是力度与渐强渐弱（F06）：两者不同就在音符内部线性推进，
   * 长音听起来是连续涨落；相等时与恒音量完全一致。
   */
  private tone(
    ctx: AudioContext,
    midi: number,
    t0: number,
    t1: number,
    gain = 1,
    partId?: string,
    dyn = 1,
    dynTo = dyn,
    patch?: number,
    patchOctave = 0,
    grace = false,
  ): void {
    const dur = Math.max(0.06, t1 - t0) + (grace ? GRACE_TAIL : 0);
    // 发声音高 = 记谱音高 + 变调 + 音色八度（音色八度只挪发声，不动记谱）
    const at = midi + this.semitones + patchOctave * 12;
    // 音色选择：条目带了 patch 且真采样已加载 → 循环采样回放；
    // 没加载 / 没采样的 patch → 回落钢琴合成（「还在加载」和「没有」都静默处理）
    const inst = instrumentSampleFor(patch, at);
    const pcm = inst
      ? renderSampledNote(inst.pcm, inst.point, at, {
          sampleRate: ctx.sampleRate,
          durationSec: dur,
          dyn,
          dynTo,
        })
      : renderNote(pianoSpec(at, dyn), {
          sampleRate: ctx.sampleRate,
          durationSec: dur,
          dyn,
          dynTo,
        });
    const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
    buf.getChannelData(0).set(pcm);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const base = partId ? 1 : gain;
    g.gain.value = this.gain * base;

    src.connect(g);
    if (partId) {
      let bus = this.partBuses.get(partId);
      if (!bus) { bus = ctx.createGain(); bus.gain.value = gain; bus.connect(ctx.destination); this.partBuses.set(partId, bus); }
      g.connect(bus);
    } else g.connect(ctx.destination);
    src.start(t0);
  }
}

/**
 * 音频试听器（波形标定用）：从任意位置起播 stem，与谱面播放完全独立。
 *
 * 波形上点一下 → 从那里试听，用来找「这个音对应音频的哪一刻」；
 * 找到后回谱面选中音符、点「绑定」。与谱面播放互斥（UI 层保证）。
 */
export class AudioPreview {
  private ctx: AudioContext | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private stemGains: GainNode[] = [];
  private when = 0;
  private startSec = 0;
  private endSec = Infinity;
  private timer: number | null = null;
  private endedCb: (() => void) | null = null;

  get isPlaying(): boolean {
    return this.ctx !== null;
  }

  get currentSec(): number | null {
    return this.ctx ? this.ctx.currentTime - this.when + this.startSec : null;
  }

  /**
   * 从 startSec 起播 stem。maxSec 给定时**放到就停**（波形点击试听用：
   * 放 N 拍自动停，不用手动掐）——以音频时钟计时，与试听结束走同一条路。
   */
  start(stems: AudioStem[], startSec: number, onEnded?: () => void, maxSec?: number): void {
    this.stop();
    if (stems.length === 0) return;
    claimAudio(this);
    const ctx = newAudioContext();
    this.ctx = ctx;
    this.endedCb = onEnded ?? null;
    this.startSec = Math.max(0, startSec);
    this.when = ctx.currentTime + 0.05;
    const from = this.startSec;
    for (const stem of stems) {
      const src = ctx.createBufferSource();
      src.buffer = stem.buffer;
      const g = ctx.createGain();
      g.gain.value = Math.max(0, Math.min(1, stem.gain));
      src.connect(g);
      g.connect(ctx.destination);
      this.sources.push(src);
      this.stemGains.push(g);
      src.start(this.when, Math.min(from, Math.max(0, stem.buffer.duration - 0.05)));
    }
    const shortest = Math.min(...stems.map((s) => s.buffer.duration));
    this.endSec = this.when + Math.max(0.1, shortest - from);
    if (maxSec !== undefined && maxSec > 0) this.endSec = Math.min(this.endSec, this.when + maxSec);
    this.timer = window.setInterval(() => {
      if (this.ctx && this.ctx.currentTime > this.endSec + 0.2) {
        const cb = this.endedCb;
        this.stop();
        cb?.();
      }
    }, 100);
  }

  setStemGain(index: number, value: number): void {
    const g = this.stemGains[index];
    if (!g || !this.ctx) return;
    g.gain.setTargetAtTime(Math.max(0, Math.min(1, value)), this.ctx.currentTime, 0.03);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* 同上：还没 start 过的源会抛 */
      }
    }
    this.sources = [];
    this.stemGains = [];
    this.endedCb = null;
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      void ctx.close();
    }
    releaseAudio(this);
  }
}
