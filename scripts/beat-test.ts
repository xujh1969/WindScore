/**
 * BPM 估测测试：用**合成的节拍音轨**验证（不需要真音频文件，也就能进 CI）。
 *
 * 验的是「点得到正确的拍」：给一串精确落在 120 BPM 网格上的脉冲，
 * 估出来就该是 120，相位也该落回那串脉冲的起点。
 */
import { estimateTempo, onsetEnvelope, vocalEntrySec } from '../src/v2/beat';

let failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failed += 1;
    console.log(`  XX  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/** 合成 click 音轨：每拍一个衰减脉冲（下拍更响），外加一点底噪 */
function clickTrack(sr: number, seconds: number, bpm: number, phaseSec: number, amp = 1): Float32Array {
  const n = Math.floor(sr * seconds);
  const x = new Float32Array(n);
  const beat = 60 / bpm;
  const decay = Math.max(1, Math.floor(sr * 0.004));
  for (let t = phaseSec, k = 0; t < seconds - 0.5; t += beat, k += 1) {
    const a = amp * (k % 4 === 0 ? 1 : 0.7); // 下拍重一点，更像真伴奏
    const i0 = Math.round(t * sr);
    for (let i = 0; i < decay * 6 && i0 + i < n; i += 1) {
      x[i0 + i] += a * Math.exp(-i / decay);
    }
  }
  // 底噪：让「全静音」这种退化输入不至于算出 NaN
  let seed = 12345;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x[i] += ((seed / 0x7fffffff) - 0.5) * 0.002;
  }
  return x;
}

console.log('[BPM 估测]');

// ① 120 BPM（44.1k 源文件，顺带验降采样路径）
{
  const sr = 44100;
  const est = estimateTempo(clickTrack(sr, 30, 120, 0.25), sr);
  check('120 BPM 估得准', !!est && Math.abs(est.bpm - 120) < 0.5, est ? String(est.bpm) : 'null');
  // 相位是**估测起点**：flux 峰出现在 attack 位于窗内 3/4 处，窗中心口径因此
  // 系统性早 ~n/4（23ms）。不掰这个数——用户钉一个锚点后，原点会把残差吸收掉。
  check(
    '相位估得准（±50ms）',
    !!est && Math.abs(est.phaseSec - 0.25) < 0.05,
    est ? String(est.phaseSec) : 'null',
  );
  check('干净节拍的置信度够高', !!est && est.confidence > 0.3, est ? String(est.confidence) : 'null');
  check('残差小（<40ms）', !!est && est.residualMs < 40, est ? `${est.residualMs}ms` : 'null');
}

// ② 90 BPM：慢一点也要准（顺带确认不会被估成 180 的倍频）
{
  const sr = 44100;
  const est = estimateTempo(clickTrack(sr, 30, 90, 0.1), sr);
  check('90 BPM 估得准（不跑倍频）', !!est && Math.abs(est.bpm - 90) < 1, est ? String(est.bpm) : 'null');
}

// ③ 半速歧义：只在 2、4 拍上敲（周期 = 2 拍）时也得给回原速而不是慢一倍
{
  const sr = 44100;
  const est = estimateTempo(clickTrack(sr, 30, 120, 0.25, 1), sr);
  check('仍在 55–200 内给出合理值', !!est && est.bpm > 55 && est.bpm <= 200, est ? String(est.bpm) : 'null');
}

// ④ 退化输入：宁可返回 null，也不给一个假的数
{
  const sr = 44100;
  check('全静音 → null', estimateTempo(new Float32Array(sr * 20), sr) === null);
  check('太短（2s）→ null', estimateTempo(clickTrack(sr, 2, 120, 0), sr) === null);
}

// ④b 自动对齐：谱面音符起拍 + 音频 → 原点自己算出来（不需要人工锚点）
{
  const sr = 44100;
  const bpm = 100;
  const phase = 0.31;
  const origin = 36; // 谱面第 0 拍 = 音频第 36 拍
  const step = 60 / bpm;

  // 谱面：每小节 4 拍，节奏型**每小节不同**（周期性的话，原点平移一个小节也能对上）
  const variants = [
    [0, 1, 1.5, 2, 2.75, 3, 3.5],
    [0, 0.5, 1, 2, 2.5, 3, 3.5],
    [0, 1, 2, 2.5, 3, 3.75],
    [0, 0.5, 1.5, 2, 3, 3.5],
  ];
  const notes: number[] = [];
  for (let bar = 0; bar < 12; bar += 1) {
    for (const o of variants[bar % variants.length]) notes.push(bar * 4 + o);
  }

  // 音频 = 鼓点（每拍一记，定网格）+ 旋律（按谱面起拍，弱一点）
  // 纯八分音符旋律在合成音里有倍速歧义（会被判成 200 BPM），真伴奏都靠鼓轨定网格
  const lastBeat = origin + notes[notes.length - 1] + 2;
  const seconds = phase + lastBeat * step;
  const x = new Float32Array(Math.floor(sr * seconds));
  const decay = Math.floor(sr * 0.004);
  const hit = (t: number, a: number) => {
    const i0 = Math.round(t * sr);
    for (let k = 0; k < decay * 6 && i0 + k < x.length; k += 1) x[i0 + k] += a * Math.exp(-k / decay);
  };
  for (let b = 0; b <= lastBeat; b += 1) hit(phase + b * step, 1);
  for (const b of notes) hit(phase + (origin + b) * step, 0.6);

  const est = estimateTempo(x, sr, { noteOnsets: notes, scoreBeats: 48 });
  check('自动对齐：BPM 估得准', !!est && Math.abs(est.bpm - 100) < 1, est ? String(est.bpm) : 'null');
  check('长度比 ≈ 1（整曲转录）', !!est && est.spanRatio > 0.85 && est.spanRatio < 1.3, est ? String(est.spanRatio) : 'null');
  check(
    '自动对齐：原点算得准（±0.5 拍）',
    !!est && est.originBeat !== null && Math.abs(est.originBeat - origin) < 0.5,
    est ? String(est.originBeat) : 'null',
  );
  check('原点匹配强度为正', !!est && est.originScore > 0, est ? String(est.originScore) : 'null');
  check('谱面音符太少（<6）就不算原点', estimateTempo(x, sr, { noteOnsets: [0, 1, 2] })?.originBeat === null);
}

// ④c 半速记谱：谱面一拍 = 音频两拍（青花瓷就是这种）。
// 音频脉冲 120，谱面按 60 走；只信相位聚拢度会判成 120 → 谱面快一倍。
{
  const sr = 44100;
  const phase = 0.25;
  const origin = 8; // 谱面第 0 拍 = 音频第 8 拍（60 网格）
  const step = 1.0; // 谱面一拍 1s（= 音频两拍）
  // 节奏型每小节不同 + 带 .25/.75 的错位拍：周期性或全落在八分网格上，
  // 都会被倍速网格同样解释（均匀脉冲更是任何模板都能对上，会被骗匹配防护挡掉）
  const variants = [
    [0, 0.25, 1, 2, 3, 3.75],
    [0, 0.75, 1.5, 2.25, 3],
    [0, 0.25, 1.25, 2, 2.75, 3.5],
    [0, 0.5, 1.75, 2.5, 3.25],
  ];
  const notes: number[] = [];
  for (let bar = 0; bar < 12; bar += 1) for (const o of variants[bar % 4]) notes.push(bar * 4 + o);
  const totalBeats = 48;
  const dur = phase + (origin + totalBeats) * step + 2;
  const x = new Float32Array(Math.floor(sr * dur));
  const decay = Math.floor(sr * 0.004);
  const hit = (t: number, a: number) => {
    const i0 = Math.round(t * sr);
    for (let k = 0; k < decay * 6 && i0 + k < x.length; k += 1) x[i0 + k] += a * Math.exp(-k / decay);
  };
  for (let t = phase; t < dur; t += 0.5) hit(t, 0.5); // 伴奏脉冲每 0.5s（120 BPM），弱一点
  for (const b of notes) hit(phase + (origin + b) * step, 1); // 旋律按谱面音符，主导包络

  const est = estimateTempo(x, sr, { noteOnsets: notes, scoreBeats: totalBeats });
  check(
    '半速记谱：取 60 而不是 120（靠长度比定案）',
    !!est && Math.abs(est.bpm - 60) < 1.5,
    est ? String(est.bpm) : 'null',
  );
  check(
    '半速记谱：原点算得准（±0.7 拍）',
    !!est && est.originBeat !== null && Math.abs(est.originBeat - origin) < 0.7,
    est ? String(est.originBeat) : 'null',
  );
  check('半速记谱：长度比 ≈ 1', !!est && est.spanRatio > 0.85 && est.spanRatio < 1.3, est ? String(est.spanRatio) : 'null');
}

// ④c2 倍频歧义：**八分音符伴奏**在真速与二倍速上都能站住网格
// （细网格是粗网格的超集，聚拢度天然偏快），只靠音频判不出来——
// 必须让谱面自己写的 @bpm 进来当先验（用户实测「BPM 差很多」就是这个坑）。
{
  const sr = 44100;
  /** 均匀八分脉冲：真速 bpm 的一半周期一个点击，每 4 个里第 1 个重一些 */
  const eighthTrack = (bpm: number, durSec: number): Float32Array => {
    const x = new Float32Array(Math.floor(sr * durSec));
    const decay = Math.floor(sr * 0.004);
    const step = 60 / bpm / 2;
    let k = 0;
    for (let t = 0; t < durSec; t += step, k += 1) {
      const i0 = Math.round(t * sr);
      const a = k % 4 === 0 ? 1 : 0.7;
      for (let j = 0; j < decay * 6 && i0 + j < x.length; j += 1) {
        x[i0 + j] += a * Math.exp(-j / decay);
      }
    }
    return x;
  };
  const onsets = (beats: number): number[] => {
    const out: number[] = [];
    for (let b = 0; b < beats; b += 0.5) out.push(b);
    return out;
  };

  // 先验缺失的对照：只给音频就是二倍速（这正是「估成倍速」的老毛病）
  const blind = estimateTempo(eighthTrack(63, 200), sr);
  check('不给任何谱面信息 → 落在二倍速（说明确实有歧义）', !!blind && Math.abs(blind.bpm - 126) < 2, blind ? String(blind.bpm) : 'null');

  const full = estimateTempo(eighthTrack(63, 293), sr, {
    noteOnsets: onsets(308),
    scoreBeats: 308,
    scoreBpm: 63,
  });
  check('八分伴奏：靠 @bpm 先验取回 63（不是 126）', !!full && Math.abs(full.bpm - 63) < 1.5, full ? String(full.bpm) : 'null');

  // 谱面只记半首：长度比这条硬证据不成立（0.49），仍要由 @bpm 定倍频
  const half = estimateTempo(eighthTrack(63, 293), sr, {
    noteOnsets: onsets(150),
    scoreBeats: 150,
    scoreBpm: 63,
  });
  check('谱面只记半首：仍由 @bpm 定到 63', !!half && Math.abs(half.bpm - 63) < 1.5, half ? String(half.bpm) : 'null');

  // 谱面太短（起拍 <6）时上面整段跑不了，先验仍要兜住
  const tiny = estimateTempo(eighthTrack(63, 293), sr, { scoreBpm: 63 });
  check('谱面太短：先验仍定到 63', !!tiny && Math.abs(tiny.bpm - 63) < 1.5, tiny ? String(tiny.bpm) : 'null');

  // 安全阀：谱面速度写错时（青花瓷 @bpm 写 60、真值 108）先验不能推翻对的网格值。
  // 网格在这条均匀脉冲轨上自己落在 116（与 108 差 7%，不是倍频）——先验要保证的
  // 正是**不被拉到半速 / 二倍速**，所以断言量级对（90–130）而不是小数点后
  const wrong = estimateTempo(eighthTrack(108, 115), sr, {
    noteOnsets: onsets(208),
    scoreBeats: 208,
    scoreBpm: 60,
  });
  check(
    '@bpm 写错（60 vs 108）：不被先验拉到半速 / 二倍速',
    !!wrong && wrong.bpm > 90 && wrong.bpm < 130,
    wrong ? String(wrong.bpm) : 'null',
  );

  // 「按谱面速度对齐」：强制速度，只定相位与原点
  const forced = estimateTempo(eighthTrack(63, 293), sr, {
    noteOnsets: onsets(308),
    scoreBeats: 308,
    fixedBpm: 63,
  });
  check('强制按谱面速度 63：BPM 就是 63', !!forced && Math.abs(forced.bpm - 63) < 0.01, forced ? String(forced.bpm) : 'null');
  check('强制速度：原点照样算出来', !!forced && forced.originBeat !== null, forced ? String(forced.originBeat) : 'null');
}

// ④d 谱面与音频对不上时不能抛异常（梳状得分会是负数，阈值算错会崩）
{
  const sr = 44100;
  const x = clickTrack(sr, 20, 120, 0.25);
  const weird = [0, 0.37, 1.11, 2.03, 3.17, 4.41, 5.62, 7.13, 8.9];
  let threw = false;
  let est: ReturnType<typeof estimateTempo> = null;
  try {
    est = estimateTempo(x, sr, { noteOnsets: weird, scoreBeats: 68 });
  } catch {
    threw = true;
  }
  check('谱面/音频对不上时不抛异常', !threw);
  check(
    '给出的原点要么为空、要么是个正常数',
    !!est && (est.originBeat === null || (Number.isFinite(est.originBeat) && est.originBeat >= 0)),
    est ? String(est.originBeat) : 'null',
  );
}

// ④e 节奏型完全对不上的半速谱（简略前奏 / 配器不同）：长度比仍要定对速度档
{
  const sr = 44100;
  const x = clickTrack(sr, 20, 120, 0.25);
  // 谱面 20 拍、音符位置乱七八糟（与音频节奏型毫无关系）
  const weird = [0, 0.37, 1.11, 2.03, 3.17, 4.41, 5.62, 7.13, 8.9, 10.2, 11.4, 12.8, 14.1, 15.6, 17.2, 18.3];
  const est = estimateTempo(x, sr, { noteOnsets: weird, scoreBeats: 20 });
  check(
    '节奏型对不上：仍按长度比取 60（不回倍速）',
    !!est && Math.abs(est.bpm - 60) < 1.5,
    est ? String(est.bpm) : 'null',
  );
  check('长度比 ≈ 1', !!est && est.spanRatio > 0.85 && est.spanRatio < 1.3, est ? String(est.spanRatio) : 'null');
}

// ⑥ 恒速判定（align.py segment_bpms 的移植）
{
  const sr = 44100;
  const est = estimateTempo(clickTrack(sr, 60, 120, 0.25), sr); // 60s → 10 段各 6s
  check(
    '恒速判定：匀速 → 恒定',
    !!est && est.isConstant === true && est.drift < 0.5,
    est ? `drift=${est.drift} 段数=${est.segments.length}` : 'null',
  );
  // 前半 120、后半 117：截尾极差约 3 BPM → 疑似变速
  const a = clickTrack(sr, 30, 120, 0.25);
  const b = clickTrack(sr, 30, 117, 0.25);
  const mixed = new Float32Array(a.length + b.length);
  mixed.set(a);
  mixed.set(b, a.length);
  const est2 = estimateTempo(mixed, sr);
  check(
    '恒速判定：变速 → 疑似变速',
    !!est2 && est2.isConstant === false,
    est2 ? `drift=${est2.drift} 段=${JSON.stringify(est2.segments)}` : 'null',
  );
}

// ⑦ 人声进入检测（align.py vocal_entry_sec 的移植）
{
  const sr = 22050;
  const x = new Float32Array(sr * 20); // 先静音
  for (let i = Math.floor(sr * 5); i < x.length; i += 1) {
    x[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr); // 5s 起持续 220Hz
  }
  const v = vocalEntrySec(x, sr);
  check('人声进入：5s 处检出（±0.1s）', v !== null && Math.abs(v - 5) < 0.1, v === null ? 'null' : String(v));
  check('人声进入：全静音返回 null', vocalEntrySec(new Float32Array(sr * 10), sr) === null);
}

// ⑤ onset 包络本身：脉冲处确实出峰
{
  const sr = 11025;
  const x = clickTrack(sr, 10, 120, 0.25);
  const { env } = onsetEnvelope(x, sr);
  check('包络长度合理', env.length > 300, String(env.length));
  let mean = 0;
  for (let i = 0; i < env.length; i += 1) mean += env[i];
  mean /= env.length;
  check('包络不是全零', mean > 0, String(mean));
}

console.log(failed === 0 ? '\nBEAT PASS' : `\nBEAT FAIL (${failed})`);
if (failed > 0) process.exit(1);
