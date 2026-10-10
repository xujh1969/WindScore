/**
 * 以 BPM 为基准的内部时钟，无音频也能驱动谱面。
 * 规范 §2 / §11：M5 播放引擎与 M6 播放器直接复用本类。
 */
export class BeatClock {
  private bps: number;
  private anchorBeat = 0;
  private anchorTs = 0;
  private running = false;

  constructor(bpm: number) {
    this.bps = bpm / 60;
  }

  setBpm(bpm: number): void {
    const b = this.currentBeat;
    this.bps = bpm / 60;
    this.anchorBeat = b;
    this.anchorTs = performance.now();
  }

  get bpm(): number {
    return this.bps * 60;
  }

  /** 每秒走多少拍：光球停止后的余跳要用真实时间外推 tick */
  get beatsPerSec(): number {
    return this.bps;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentBeat(): number {
    if (!this.running) return this.anchorBeat;
    const elapsed = (performance.now() - this.anchorTs) / 1000;
    // 还没到起播时刻（延迟对齐音频）：停在锚点，不要倒着走
    if (elapsed <= 0) return this.anchorBeat;
    return this.anchorBeat + elapsed * this.bps;
  }

  play(): void {
    if (this.running) return;
    this.playAfter(0);
  }

  /**
   * 延迟 seconds 秒再开始走。
   *
   * 用来对齐音频：AudioContext 初始化 + 排程提前量会让声音比时钟晚开始，
   * 不补这个差值的话播放头会整体跑在声音前面，末尾还会把最后一个音掐掉。
   */
  playAfter(seconds: number): void {
    this.anchorBeat = this.currentBeat;
    this.anchorTs = performance.now() + Math.max(0, seconds) * 1000;
    this.running = true;
  }

  pause(): void {
    this.anchorBeat = this.currentBeat;
    this.running = false;
  }

  stop(): void {
    this.anchorBeat = 0;
    this.anchorTs = performance.now();
    this.running = false;
  }

  seek(beat: number): void {
    this.anchorBeat = Math.max(0, beat);
    this.anchorTs = performance.now();
  }
}
