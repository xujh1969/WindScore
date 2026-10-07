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
import type { TimelineEntry } from './timeline';

/** 排一次音的提前量（秒）：建 AudioContext 与解算要时间，太紧会切掉开头 */
const START_LEAD = 0.1;
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
  onEnded?: () => void;
}

/** 浏览器可能还没有 webkit 前缀 */
function newAudioContext(): AudioContext {
  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  return new Ctor();
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
  /** 合成音总音量（三角波比正弦响，0.22 是听感合适的值） */
  gain = 0.22;
  private audioMode = false;
  /** ctx 时刻 when 对应的音频位置 startSec（秒） */
  private when = 0;
  private startSec = 0;
  /** 音频自然放完的 ctx 时刻（谱尾 ≠ 音频终点） */
  private audioEndSec = Infinity;
  private sources: AudioBufferSourceNode[] = [];
  private stemGains: GainNode[] = [];
  private endedCb: (() => void) | null = null;
  private tempo: TempoMap | null = null;

  /** 播放中热切某条 stem 的音量（30ms 平滑，不会「啪」地一声） */
  setStemGain(index: number, value: number): void {
    const g = this.stemGains[index];
    if (!g || !this.ctx) return;
    g.gain.setTargetAtTime(Math.max(0, Math.min(1, value)), this.ctx.currentTime, 0.03);
  }

  get isPlaying(): boolean {
    return this.ctx !== null;
  }

  /** 音频模式下的当前音频位置（秒）；合成音 / 未播放时 null */
  get currentSec(): number | null {
    if (!this.ctx || !this.audioMode) return null;
    return this.ctx.currentTime - this.when + this.startSec;
  }

  /** 音频模式下的当前 tick（secToTick 反查；可能为负） */
  get currentTick(): number | null {
    const sec = this.currentSec;
    if (sec === null || !this.tempo) return null;
    return secToTick(this.tempo, sec);
  }

  /**
   * 合成音起播。返回真实起播延迟（秒）：建 AudioContext 与解算要时间，
   * 调用方要拿它对轨（例如把波形标定的起点往后挪）。
   */
  start(timeline: TimelineEntry[], bpm: number, fromTick = 0): number {
    this.stop();
    if (timeline.length === 0) return 0;
    const first = timeline.findIndex((e) => e.endTick > fromTick);
    if (first < 0) return 0;

    const calledAt = performance.now();
    const ctx = newAudioContext();
    this.ctx = ctx;
    this.timeline = timeline;
    this.index = first;
    this.fromTick = fromTick;
    this.audioMode = false;
    this.tempo = null;
    this.ticksPerSec = (bpm / 60) * TICKS_PER_BEAT;
    this.startedAt = ctx.currentTime + START_LEAD;

    const lead = (performance.now() - calledAt) / 1000 + START_LEAD;
    this.timer = window.setInterval(() => {
      if (!this.ctx) return;
      const until = this.ctx.currentTime + SCHEDULE_AHEAD;
      for (; this.index < this.timeline.length; ) {
        const e = this.timeline[this.index]!;
        const from = Math.max(e.startTick, this.fromTick);
        const at = this.startedAt + (from - this.fromTick) / this.ticksPerSec;
        if (at > until) break;
        const endAt = this.startedAt + (e.endTick - this.fromTick) / this.ticksPerSec;
        if (e.midi !== null) this.tone(ctx, e.midi, at, endAt);
        this.index += 1;
      }
      const lastEnd = this.timeline[this.timeline.length - 1]?.endTick ?? 0;
      const finishAt = this.startedAt + (lastEnd - this.fromTick) / this.ticksPerSec;
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
    const { timeline, tempo, fromTick, stems, synth, onEnded } = opts;
    if (timeline.length === 0 || stems.length === 0) return 0;

    const first = timeline.findIndex((e) => e.endTick > fromTick);
    if (first < 0) return 0;

    const calledAt = performance.now();
    const ctx = newAudioContext();
    this.ctx = ctx;
    this.timeline = timeline;
    this.index = first;
    this.fromTick = fromTick;
    this.tempo = tempo;
    this.audioMode = true;
    this.endedCb = onEnded ?? null;

    const startSec = tickToSec(tempo, fromTick);
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
    const shortest = Math.min(...stems.map((s) => s.buffer.duration));
    this.audioEndSec = this.when + Math.max(0.1, shortest - offset);

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
        if (e.midi !== null && t1 > this.ctx.currentTime) {
          this.tone(this.ctx, e.midi, Math.max(t0, this.ctx.currentTime), t1);
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
    this.endedCb = null;
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      void ctx.close();
    }
    this.index = 0;
    this.audioMode = false;
    this.tempo = null;
  }

  /** 一个音：三角波 + 20ms 淡入 / 末尾 50ms 淡出 */
  private tone(ctx: AudioContext, midi: number, t0: number, t1: number): void {
    const freq = 440 * 2 ** ((midi - 69) / 12);
    const end = Math.max(t1, t0 + 0.06);
    const rel = Math.max(t0 + 0.03, end - 0.05);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(this.gain, t0 + 0.02);
    g.gain.setValueAtTime(this.gain, rel);
    g.gain.linearRampToValueAtTime(0, end);

    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(end + 0.02);
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

  start(stems: AudioStem[], startSec: number, onEnded?: () => void): void {
    this.stop();
    if (stems.length === 0) return;
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
  }
}
