/**
 * 钢琴音色自测：音色描述的性质 + 渲染出来的声音。
 * 纯 node（渲染器不碰 Web Audio），秒级。
 */
import { pianoSpec, renderNote } from '../src/v2/timbre';
import { synthNotes } from '../src/v2/export/mix';
import { pianoSampleFor, setPianoSamplesForTest, clearPianoSamplesForTest } from '../src/v2/pianoSamples';
import { applyPianoSpace, pianoIRFor } from '../src/v2/reverb';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok  ${name}`);
  else {
    console.log(`  XX  ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

/** Goertzel：量一段信号在某个频率上的能量 */
function goertzel(samples: Float32Array, sr: number, freq: number): number {
  const n = samples.length;
  const k = Math.round((n * freq) / sr);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    const s0 = samples[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

/** 某段样本的均方根 */
function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

console.log('[音色 · 音色描述]');
{
  const low = pianoSpec(33, 1); // A1
  const high = pianoSpec(93, 1); // A6
  check('低音泛音少、高音泛音多', high.partials.length > low.partials.length,
    `${low.partials.length} vs ${high.partials.length}`);
  check('泛音数在 4~14 之间', low.partials.length >= 4 && high.partials.length <= 14);
}
{
  const spec = pianoSpec(60, 1);
  const sum = spec.partials.reduce((a, p) => a + p.amp, 0);
  check('泛音振幅归一化（和 ≈ 1）', Math.abs(sum - 1) < 1e-6, String(sum));
}
{
  const spec = pianoSpec(60, 1);
  let monotonic = true;
  for (let i = 1; i < spec.partials.length; i += 1) {
    if (spec.partials[i]!.decay > spec.partials[i - 1]!.decay + 1e-9) monotonic = false;
  }
  check('高次泛音衰减更快（音色的灵魂）', monotonic);
}
{
  const spec = pianoSpec(33, 1);
  // 非谐性：第 n 泛音略高于 n 倍基频，且偏离随 n 增大
  let grew = true;
  for (let i = 1; i < spec.partials.length - 1; i += 1) {
    const d0 = spec.partials[i]!.ratio / (i + 1) - 1;
    const d1 = spec.partials[i + 1]!.ratio / (i + 2) - 1;
    if (d1 <= d0) grew = false;
    if (d0 <= 0) grew = false;
  }
  check('非谐性存在且随泛音号增大（真实琴弦）', grew);
  const high = pianoSpec(93, 1);
  const dLow = spec.partials[3]!.ratio / 4 - 1;
  const dHigh = high.partials[3]!.ratio / 4 - 1;
  check('低音弦的非谐性更明显', dLow > dHigh, `${dLow} vs ${dHigh}`);
}
{
  const soft = pianoSpec(60, 0.25);
  const hard = pianoSpec(60, 1);
  check('力度大 → 音色更亮（截止频率更高）', hard.tone.cutoff > soft.tone.cutoff);
  check('力度大 → 槌击更重', hard.hammer.amp > soft.hammer.amp);
  check('低音区更闷、高音区更亮', pianoSpec(93, 1).tone.cutoff > pianoSpec(33, 1).tone.cutoff);
}
{
  // 双弦拍音：中低音区有（2~3 根微失谐弦），最高音区单弦没有
  const mid = pianoSpec(57, 1); // A3
  check('中音区有拍音参数', (mid.partials[0]!.beat ?? 0) > 0 && (mid.partials[0]!.beatDepth ?? 0) > 0,
    `${mid.partials[0]!.beat}/${mid.partials[0]!.beatDepth}`);
  check('拍音深度不超过 1', (mid.partials[0]!.beatDepth ?? 0) <= 1);
  check('最高音区单弦无拍', (pianoSpec(108, 1).partials[0]!.beatDepth ?? 0) < 0.01);
  check('拍频确定性（同一音每次相同）', pianoSpec(57, 1).partials[0]!.beat === pianoSpec(57, 1).partials[0]!.beat);
  check('双段衰减：尾段比主段慢且有占比', mid.partials[0]!.decay2! > mid.partials[0]!.decay &&
    (mid.partials[0]!.mix2 ?? 0) > 0 && (mid.partials[0]!.mix2 ?? 0) < 1);
}
{
  // 拍音听感：单泛音 + 拍音 = 调幅，包络按拍频起伏（真钢琴的「活」感来源）
  const sr = 44100;
  const base = pianoSpec(69, 1);
  const beated: typeof base = {
    ...base,
    partials: [{ ratio: 1, amp: 1, decay: 20, beat: 4, beatDepth: 1 }],
    hammer: { ...base.hammer, amp: 0 },
    tone: { cutoff: 15000 },
  };
  const pcm = renderNote(beated, { sampleRate: sr, durationSec: 1 });
  const near = (t: number): number => rms(pcm, Math.round(t * sr), Math.round((t + 0.02) * sr));
  // 包络 = 0.5+0.5·sin(2π·4t)：峰在 0.0625s（周期 0.25s），谷在 0.1875s
  const loud = near(0.0525);
  const quiet = near(0.1775);
  check('拍音包络按拍频起伏', quiet < loud * 0.35, `${quiet} vs ${loud}`);
}

console.log('\n[音色 · 渲染]');
{
  const sr = 44100;
  const pcm = renderNote(pianoSpec(69, 1), { sampleRate: sr, durationSec: 0.5 });
  check('长度 =（时长 + 制音器）× 采样率', pcm.length > 0.5 * sr && pcm.length < 0.75 * sr, String(pcm.length));
  check('没有 NaN / Infinity', pcm.every((v) => Number.isFinite(v)));
  const peak = Math.max(...Array.from(pcm, Math.abs));
  check('峰值不削顶（≤ 1.2）', peak <= 1.2, String(peak));
}
{
  // 音高对不对：基频能量必须压过邻近频率
  const sr = 44100;
  const pcm = renderNote(pianoSpec(69, 1), { sampleRate: sr, durationSec: 0.5 });
  const at440 = goertzel(pcm.subarray(0, 22050), sr, 440);
  const at500 = goertzel(pcm.subarray(0, 22050), sr, 500);
  check('A4 = 440 Hz（基频能量最大）', at440 > at500 * 3, `${at440} vs ${at500}`);
}
{
  // 琴弦在衰减：基音的余韵长，但高次泛音先死——所以声音越走越暗
  const sr = 44100;
  const pcm = renderNote(pianoSpec(60, 1), { sampleRate: sr, durationSec: 1 });
  const head = rms(pcm, 0, Math.round(0.2 * sr));
  const tail = rms(pcm, Math.round(0.8 * sr), Math.round(1.0 * sr));
  check('声音随时间衰减', tail < head, `${tail} vs ${head}`);
  const headHi = goertzel(pcm.subarray(0, Math.round(0.2 * sr)), sr, 2000);
  const tailHi = goertzel(pcm.subarray(Math.round(0.8 * sr), Math.round(1.0 * sr)), sr, 2000);
  check('高次泛音先死（声音越走越暗）', tailHi < headHi * 0.7, `${tailHi} vs ${headHi}`);
}
{
  // 制音器：松键之后应该很快收掉
  const sr = 44100;
  const pcm = renderNote(pianoSpec(60, 1), { sampleRate: sr, durationSec: 0.3 });
  const before = rms(pcm, Math.round(0.25 * sr), Math.round(0.3 * sr));
  const after = rms(pcm, Math.round(0.35 * sr), pcm.length);
  check('松键后被制音器压住', after < before * 0.3, `${after} vs ${before}`);
}
{
  // 确定性：同样参数两次渲染完全一致
  const a = renderNote(pianoSpec(64, 0.8), { sampleRate: 44100, durationSec: 0.2 });
  const b = renderNote(pianoSpec(64, 0.8), { sampleRate: 44100, durationSec: 0.2 });
  check('同样参数结果一致（可测、可复现）', a[123] === b[123] && a.length === b.length);
}
{
  // 力度层：重弹的高次泛音更多（高频能量更高）
  const sr = 44100;
  const soft = renderNote(pianoSpec(60, 0.2), { sampleRate: sr, durationSec: 0.4 });
  const hard = renderNote(pianoSpec(60, 1), { sampleRate: sr, durationSec: 0.4 });
  const hi = (x: Float32Array): number => goertzel(x.subarray(0, 8000), sr, 1800);
  check('重弹的高频更足', hi(hard) > hi(soft) * 1.2, `${hi(hard)} vs ${hi(soft)}`);
}
{
  // 渐强渐弱：后半段应该比前半段响
  const sr = 44100;
  const pcm = renderNote(pianoSpec(60, 1), { sampleRate: sr, durationSec: 1, dyn: 0.3, dynTo: 1 });
  const head = rms(pcm, Math.round(0.05 * sr), Math.round(0.2 * sr));
  const tail = rms(pcm, Math.round(0.8 * sr), Math.round(0.95 * sr));
  // 阈值 1.3：拍音（双弦失谐的响度起伏，±2dB）会在这两个窗口间走相位，留出余地
  // 阈值 1.25：拍音与混响湿声都会在两个窗口间走相位，留出余地
  check('渐强渐弱生效（dyn → dynTo）', tail > head * 1.25, `${tail} vs ${head}`);
}

console.log('\n[音色 · 实时与导出同源]');
{
  // 导出走的是同一个渲染器：手算一遍的样本应与 synthNotes 混出来的完全相同
  const sr = 44100;
  const notes = [{ startSec: 0.25, endSec: 0.75, midi: 60, dyn: 0.9 }];
  const mix = synthNotes({ notes, durationSec: 1.5, sampleRate: sr, gain: 1 });
  const pcm = renderNote(pianoSpec(60, 0.9), { sampleRate: sr, durationSec: 0.5, dyn: 0.9, dynTo: 0.9 });
  const offset = Math.round(0.25 * sr);
  let same = true;
  for (let i = 0; i < pcm.length && offset + i < mix.length; i += 1) {
    if (Math.abs(mix.channels[0]![offset + i]! - pcm[i]!) > 1e-6) same = false;
  }
  check('导出混音 = 实时渲染的同一份样本', same);
}

console.log('\n[音色 · 真实采样混合]');
{
  // 行为断言用**合成的假采样**（衰减正弦，故意裁短到 0.5s 逼出交接路径）。
  // 真实资产（piano-samples.mp3，3~8s 整段自然衰减）由 scripts/piano-demo.ts
  // 在 node 侧用 audio-decode 全量加载验证；这里守的是渲染器的混合机制本身
  const sr = 44100;
  const fake = (midi: number, dur: number): PianoSample => {
    const f = 440 * 2 ** ((midi - 69) / 12);
    const n = Math.round(dur * sr);
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const t = i / sr;
      pcm[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t / (dur * 0.4)) * 0.8;
    }
    return { midi, pcm, sr };
  };
  // 小三度布点（与真实资产同构），保证任意 midi 的最近采样 ≤ 1.5 半音
  setPianoSamplesForTest([fake(48, 0.5), fake(60, 0.5), fake(63, 0.5), fake(72, 0.5)]);
  const ps = pianoSampleFor(60);
  check('C4 命中采样且变调 ≤ 1.5 半音', !!ps &&
    ps.ratio <= 2 ** (1.5 / 12) + 1e-9 && ps.ratio >= 2 ** (-1.5 / 12) - 1e-9,
    ps ? ps.ratio.toFixed(4) : 'null');
  const pcm = renderNote(pianoSpec(60, 1), { sampleRate: sr, durationSec: 0.5 });
  // 起音段 = 采样 × 增益 × 音头整形（g = 0.85，dyn = 1 → atkRel = 0.85）
  const g = 0.85;
  const s = ps!.sample.pcm;
  const headN = Math.round(0.06 * sr);
  let same = true;
  for (let i = 20; i < 200 && same; i += 1) {
    const u = i / headN;
    const head = 0.85 + 0.15 * u * u * (3 - 2 * u);
    if (Math.abs(pcm[i]! - s[i]! * g * head) > 1e-6) same = false;
  }
  check('起音段 = 采样 × 增益 × 音头整形（合成让位）', same);
  // 假采样 0.5s：松键前的尾段应已交给合成延音（低能量交接）
  const pcmLong = renderNote(pianoSpec(60, 1), { sampleRate: sr, durationSec: 1.6 });
  check('长音尾段合成延音接管（尾部有能量）', rms(pcmLong, Math.round(1.0 * sr), Math.round(1.55 * sr)) > 0.01,
    rms(pcmLong, Math.round(1.0 * sr), Math.round(1.55 * sr)).toFixed(4));
  // 长音响度轨迹平滑：交接处不允许「凹坑后跳起」（采样衰减变小 → 合成进场变大，
  // 0.2.116 实测，根因是电平匹配钳位太窄）——相邻 100ms 窗的 RMS 必须连贯
  {
    const win = Math.round(0.1 * sr);
    const rs: number[] = [];
    for (let s0 = Math.round(0.25 * sr); s0 + win <= Math.round(2.0 * sr); s0 += win) {
      rs.push(rms(pcmLong, s0, s0 + win));
    }
    let jumpy = '';
    for (let i = 1; i < rs.length; i += 1) {
      const r = rs[i]! / Math.max(1e-9, rs[i - 1]!);
      if (r > 2.2 || r < 0.45) jumpy += ` #${i}:${r.toFixed(2)}`;
    }
    check('长音交接处响度轨迹平滑（无变小又变大）', jumpy === '', jumpy || '平滑');
  }
  // 全采样整段回放：采样覆盖整音时不得交接给合成——0.2.118 实测，
  // 结尾制音段淡入的合成会在衰减里补一记全额响度（「衰减被放大」的听感来源）
  {
    setPianoSamplesForTest([fake(48, 0.5), fake(60, 2), fake(63, 0.5), fake(72, 0.5)]);
    const pc = renderNote(pianoSpec(60, 1), { sampleRate: sr, durationSec: 0.8, space: false });
    // 全程响度轨迹必须单调下降，不允许任何一段再鼓起来
    const w = Math.round(0.05 * sr);
    let swell = '';
    let prev = Infinity;
    for (let p0 = Math.round(0.3 * sr); p0 + w <= pc.length; p0 += w) {
      const r = rms(pc, p0, p0 + w);
      if (r > prev * 1.02) swell += ` @${(p0 / sr).toFixed(2)}s×${(r / prev).toFixed(2)}`;
      prev = r;
    }
    check('采样覆盖整音：衰减全程单调，无合成补音', swell === '', swell || '单调');
  }
  // 力度 dynamics：软击的槌击瞬态要相对音身更弱（头/身比变小）——
  // 全采样方案里这是「力度层」的等价物，否则轻弹重弹一样砸
  {
    const headBody = (d: number): number => {
      const p = renderNote(pianoSpec(60, d), { sampleRate: sr, durationSec: 0.6, dyn: d, space: false });
      return rms(p, 0, Math.round(0.04 * sr)) / rms(p, Math.round(0.15 * sr), Math.round(0.35 * sr));
    };
    const hard = headBody(1);
    const soft = headBody(0.3);
    check('力度轻 → 音头相对更弱（软击头/身比小）', soft < hard * 0.8,
      `soft ${soft.toFixed(2)} vs hard ${hard.toFixed(2)}`);
  }
  check('采样段无 NaN', pcm.every((v) => Number.isFinite(v)));
  // 采样缺失时回到纯合成：开头不再是采样
  clearPianoSamplesForTest();
  const pure = renderNote(pianoSpec(60, 1), { sampleRate: sr, durationSec: 0.5 });
  check('无采样回退纯合成', Math.abs(pure[100]! - s[100]! * g) > 1e-6);
  // 输出采样率 ≠ 采样采样率（浏览器 AudioContext 常是 48k）：
  // 读取速度必须换算，否则整体播放偏快 1.47 半音（0.2.112 实测音高不准根因）
  setPianoSamplesForTest([fake(48, 0.5), fake(60, 0.5), fake(63, 0.5), fake(72, 0.5)]);
  const pcm48 = renderNote(pianoSpec(60, 1), { sampleRate: 48000, durationSec: 0.3 });
  const head48 = pcm48.slice(0, Math.round(0.15 * 48000));
  const at261 = goertzel(head48, 48000, 261.63);
  const at284 = goertzel(head48, 48000, 261.63 * 2 ** (1.476 / 12)); // 48k/44.1k 直读会偏到这
  check('48kHz 输出音高正确（不做采样率换算会偏高 1.5 半音）', at261 > at284 * 2, `${at261.toFixed(4)} vs ${at284.toFixed(4)}`);
  // 上移变调的混叠检查：C#4（61）用 C4（60）采样上移 1 半音，基频仍要压过混叠镜像
  const sharp = renderNote(pianoSpec(61, 1), { sampleRate: 48000, durationSec: 0.2 });
  const headSharp = sharp.slice(0, Math.round(0.1 * 48000));
  const at277 = goertzel(headSharp, 48000, 277.18);
  const atAlias = goertzel(headSharp, 48000, 277.18 * 2 ** (5.5 / 12)); // 近 Nyquist 折叠区
  check('上移变调无刺耳混叠', at277 > atAlias * 2, `${at277.toFixed(4)} vs ${atAlias.toFixed(4)}`);
  clearPianoSamplesForTest();
}

console.log('\n[音色 · 琴体共鸣与混响]');
{
  const sr = 44100;
  const ir = pianoIRFor(sr);
  // 冲激响应回放：单位冲激卷积后应还原 IR × wetGain（0.26）
  const delta = new Float32Array(Math.round(0.2 * sr));
  delta[0] = 1;
  applyPianoSpace(delta, sr);
  const tap7ms = Math.round(0.007 * sr);
  check('卷积单位冲激 = IR × 湿声增益（首反射落位）',
    Math.abs(delta[tap7ms]! - ir[tap7ms]! * 0.26) < 1e-4 && Math.abs(delta[Math.round(0.002 * sr)]!) < 1e-6,
    `@7ms=${delta[tap7ms]!.toFixed(4)}`);
  // 琴体模态：对真实音符做「开/关混响」对照，松键后的余韵必须变厚
  const withSpace = renderNote(pianoSpec(33, 1), { sampleRate: sr, durationSec: 0.4 });
  const withoutSpace = renderNote(pianoSpec(33, 1), { sampleRate: sr, durationSec: 0.4, space: false });
  const tailWith = rms(withSpace, Math.round(0.42 * sr), withSpace.length);
  const tailWithout = rms(withoutSpace, Math.round(0.42 * sr), withoutSpace.length);
  check('混响让松键后余韵变厚（厚度）', tailWith > tailWithout * 1.15, `${tailWith.toFixed(4)} vs ${tailWithout.toFixed(4)}`);
  // 实际音符：混响让松键后的余韵变厚，但确定性不破
  const a = renderNote(pianoSpec(48, 1), { sampleRate: sr, durationSec: 0.8 });
  const b = renderNote(pianoSpec(48, 1), { sampleRate: sr, durationSec: 0.8 });
  check('加混响后渲染仍确定', a[1234] === b[1234]);
  const peak = Math.max(...Array.from(a, Math.abs));
  check('混响后峰值仍不削顶（≤ 1.25）', peak <= 1.25, String(peak.toFixed(3)));
}

console.log(failed === 0 ? '\nTIMBRE 全部通过' : `\nTIMBRE FAIL (${failed})`);
if (failed > 0) process.exitCode = 1;
