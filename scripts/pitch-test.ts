/**
 * 变调内核（pitchShift.ts）回归：频率搬移正确、时长严格保持、恒等还原。
 * 用零交叉计数估主频（正弦波下足够精确），不需要 FFT。
 */
import { pitchShiftChannel, resample, timeStretch } from '../src/v2/pitchShift';
import { constantTempo, scaleTempo, secToTick, tickToSec, type TempoMap } from '../src/v2/tempo';

/** 长度比较的容差（帧级） */
const FRAME_SLACK = 4096;

let failed = 0;
function check(name: string, cond: boolean, detail: string): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}  ${detail}`);
  }
}

/** 正弦波（秒→样本） */
function sine(freq: number, seconds: number, rate = 44100): Float32Array {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** 零交叉估频：取同向穿越**间距的中位数**。总数÷时长会被幅度波纹的
 * 偶发缺失过零和静音尾拉低（0.2.43 调试实测：间距 100–101 全对，
 * 但计数法给出 416Hz），中位数对这两者都鲁棒 */
function coreFreq(x: Float32Array, rate = 44100): number {
  const gaps: number[] = [];
  let prev = -1;
  for (let i = 1; i < x.length; i += 1) {
    if (x[i - 1]! < 0 && x[i]! >= 0) {
      if (prev >= 0) gaps.push(i - prev);
      prev = i;
    }
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return rate / gaps[Math.floor(gaps.length / 2)]!;
}

const rate = 44100;

for (const semitones of [-3, -2, -1, 1, 2, 3]) {
  const input = sine(440, 1.0);
  const out = pitchShiftChannel(input, semitones);
  const expected = 440 * 2 ** (semitones / 12);
  const got = coreFreq(out);
  check(
    `升降至 ${semitones > 0 ? '+' : ''}${semitones} 半音频率正确`,
    // 3% ≈ 半个半音：稳态正弦是 WSOLA 的最坏输入（处处等相关，搜索无从锁定
    // 真实周期，只能做到部分相位对齐）；真实音乐的偏差远小于此
    Math.abs(got - expected) / expected < 0.03,
    `期望 ${expected.toFixed(1)}Hz，实测 ${got.toFixed(1)}Hz`,
  );
  check(
    `升降至 ${semitones > 0 ? '+' : ''}${semitones} 半音时长不变`,
    Math.abs(out.length - input.length) <= 2,
    `输入 ${input.length}，输出 ${out.length}`,
  );
}

{
  const input = sine(440, 0.5);
  const out = pitchShiftChannel(input, 0);
  check(
    '0 半音恒等还原',
    out.length === input.length && out.every((v, i) => v === input[i]),
    '应逐样本相等',
  );
}

{
  const stretched = timeStretch(sine(440, 1.0), 1.5);
  check(
    'WSOLA 拉伸长度 = 输入 × alpha',
    Math.abs(stretched.length - 44100 * 1.5) <= FRAME_SLACK,
    `期望 ${Math.round(44100 * 1.5)}，实测 ${stretched.length}`,
  );
  const f = coreFreq(stretched);
  check('WSOLA 拉伸后音高不变', Math.abs(f - 440) / 440 < 0.01, `实测 ${f.toFixed(1)}Hz`);
}

{
  const out = resample(sine(440, 1.0), 1.189207, 37000);
  check('重采样长度等于指定输出长度', out.length === 37000, `实测 ${out.length}`);
}

// 小幅度：短音频不崩
{
  const tiny = sine(440, 0.01);
  const out = pitchShiftChannel(tiny, 2);
  check('极短音频不崩且长度保持', out.length === tiny.length && out.every((v) => Number.isFinite(v)), `长度 ${out.length}`);
}

// scaleTempo：倍速下 tick↔秒 整体缩放，指示条与变速伴奏保持同步
{
  const base = constantTempo(96, 0.31, 36);
  for (const factor of [0.75, 1.25]) {
    const scaled = scaleTempo(base, factor);
    const t = 480; // 任意谱面 tick
    check(
      `scaleTempo ×${factor}：tickToSec 缩为 1/${factor}`,
      Math.abs(tickToSec(scaled as TempoMap, t) - tickToSec(base, t) / factor) < 1e-9,
      `原 ${tickToSec(base, t).toFixed(4)}s，缩放后 ${tickToSec(scaled as TempoMap, t).toFixed(4)}s`,
    );
    const sec = 12.5;
    check(
      `scaleTempo ×${factor}：secToTick 反查一致`,
      Math.abs(secToTick(scaled as TempoMap, sec / factor) - secToTick(base, sec)) < 1e-6,
      'sec/factor 反查应与原速同 tick',
    );
  }
  check('scaleTempo ×1 返回原对象', scaleTempo(base, 1) === base, '应原样返回');
}

// WSOLA 变速：时长 ÷ 倍速，音高不变
{
  const input = sine(440, 1.0);
  const spedUp = timeStretch(input, 1 / 1.25);
  check(
    'WSOLA 1.25× 时长 = 输入 / 1.25',
    Math.abs(spedUp.length - input.length / 1.25) <= FRAME_SLACK,
    `期望 ${Math.round(input.length / 1.25)}，实测 ${spedUp.length}`,
  );
  check('WSOLA 变速后音高不变', Math.abs(coreFreq(spedUp) - 440) / 440 < 0.01, `实测 ${coreFreq(spedUp).toFixed(1)}Hz`);
}

// 脉冲串回归（0.2.43「两个声音」bug）：时间拉伸改变的是事件**间距**（×alpha），
// 事件数守恒。δ 累积漂移 / 搜索锁边界会破坏间距（间距退回原值 = 原地重播）。
// 纯正弦的频率检验抓不住这类退化（重播的还是同频率），间距检验能抓住
{
  const P = 4410; // 每 0.1s 一个脉冲
  const pulseTrain = (pulses: number): Float32Array => {
    const x = new Float32Array(pulses * P);
    for (let p = 0; p < pulses; p += 1) {
      for (let i = 0; i < 400; i += 1) {
        x[p * P + i] = Math.sin((2 * Math.PI * 600 * i) / 44100) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 400));
      }
    }
    return x;
  };
  // 突发区间：|x|>0.2 进区间，连续 300 采样 |x|<0.2 才算区间结束
  // （600Hz 正弦的 |x| 会在 0.5 附近反复穿越，直接数过零会把一个脉冲数成好几个）
  const positions = (x: Float32Array): number[] => {
    const pos: number[] = [];
    let inBurst = false;
    let quiet = 0;
    for (let i = 0; i < x.length; i += 1) {
      if (Math.abs(x[i]!) > 0.2) {
        if (!inBurst) pos.push(i);
        inBurst = true;
        quiet = 0;
      } else if (inBurst) {
        quiet += 1;
        if (quiet > 300) inBurst = false;
      }
    }
    return pos;
  };
  const medianGap = (pos: number[]): number => {
    const gaps = pos.slice(1).map((p, i) => p - pos[i]!).sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)] ?? 0;
  };
  {
    const pos = positions(timeStretch(pulseTrain(20), 1.25));
    check('拉伸 1.25× 脉冲数守恒', Math.abs(pos.length - 20) <= 1, `期望 20±1，实测 ${pos.length}`);
    check('拉伸 1.25× 间距 ×1.25（不重播）', Math.abs(medianGap(pos) - P * 1.25) / P < 0.1, `期望 ${P * 1.25}±10%，实测 ${medianGap(pos)}`);
  }
  {
    const pos = positions(timeStretch(pulseTrain(20), 0.8));
    check('压缩 0.8× 脉冲数守恒', Math.abs(pos.length - 20) <= 1, `期望 20±1，实测 ${pos.length}`);
    check('压缩 0.8× 间距 ×0.8（不丢失）', Math.abs(medianGap(pos) - P * 0.8) / P < 0.1, `期望 ${P * 0.8}±10%，实测 ${medianGap(pos)}`);
  }
}

console.log(failed === 0 ? 'PITCH OK' : `PITCH FAIL (${failed})`);
if (failed > 0) process.exit(1);
