/**
 * Web Audio 合成音（§11）：Oscillator 三角波，不碰 SoundFont。
 * 价值是回归测试而不是听歌：展开后的时值算错了，一耳朵就能听出来。
 */

import { TICKS_PER_BEAT } from './ticks';
import type { TimelineEntry } from './timeline';

const LOOKAHEAD = 0.3; // 提前排程的秒数
const TICK_INTERVAL = 40; // 排程检查间隔 ms
/** 音频相对调用时刻的固定提前量：留一点未来时间，避免 t0 落在过去 */
const START_LEAD = 0.1;

export class Player {
  private ctx: AudioContext | null = null;
  private timer: number | null = null;
  private startedAt = 0;
  private ticksPerSec = 0;
  private index = 0;
  private fromTick = 0;
  private timeline: TimelineEntry[] = [];
  private gain = 0.22;

  get isPlaying(): boolean {
    return this.ctx !== null;
  }

  /**
   * fromTick: 起播时刻。允许落在某个音中间，那个音会从 fromTick 处起声。
   *
   * 返回「音频真正开始发声」还差多少秒（含 AudioContext 初始化耗时）。
   * 调用方必须用这个值对齐时钟，否则时钟先跑、声音后到，
   * 结束回调会在声音播完之前触发，把最后一个音掐掉。
   */
  start(timeline: TimelineEntry[], bpm: number, fromTick = 0): number {
    this.stop();
    if (timeline.length === 0) return 0;

    // 跳过 fromTick 之前就已经结束的条目
    const first = timeline.findIndex((e) => e.endTick > fromTick);
    if (first < 0) return 0;

    const calledAt = performance.now();
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.timeline = timeline;
    this.index = first;
    this.fromTick = fromTick;
    this.ticksPerSec = (bpm / 60) * TICKS_PER_BEAT;
    this.startedAt = ctx.currentTime + START_LEAD;
    const lead = (performance.now() - calledAt) / 1000 + START_LEAD;

    this.timer = window.setInterval(() => {
      if (!this.ctx) return;
      const horizon = this.ctx.currentTime + LOOKAHEAD;
      while (this.index < this.timeline.length) {
        const e = this.timeline[this.index];
        // 跨越起播点的长音：从 fromTick 处起声，不从它的真实起点（过去）起声
        const from = Math.max(e.startTick, this.fromTick);
        const t0 = this.startedAt + (from - this.fromTick) / this.ticksPerSec;
        if (t0 > horizon) break;
        const t1 = this.startedAt + (e.endTick - this.fromTick) / this.ticksPerSec;
        if (e.midi !== null) this.tone(ctx, e.midi, t0, t1);
        this.index += 1;
      }
      const last = this.timeline[this.timeline.length - 1]?.endTick ?? 0;
      const end = this.startedAt + (last - this.fromTick) / this.ticksPerSec;
      if (this.index >= this.timeline.length && this.ctx.currentTime > end + 0.3) this.stop();
    }, TICK_INTERVAL);

    return lead;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      void ctx.close();
    }
    this.index = 0;
  }

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
