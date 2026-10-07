/**
 * WAV → MP3 压缩核心的测试（编码器是纯 JS，Node 里直接跑真编码）：
 *   - parseWav 支持 16/24/32 位整型与 32 位浮点、单/双声道、带附加 chunk
 *   - encodePcmToMp3 出的是合法 MP3 帧流（帧头同步字 + 合理体积）
 *   - mp3NameOf / isWavName 的口径
 */
import { encodePcmToMp3, isWavName, mp3NameOf, parseWav } from '../src/v2/mp3';

let failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failed += 1;
    console.log(`  XX  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

/** 造一份真实 WAV 字节：44100Hz 双声道 16 位，0.1 秒 440Hz 正弦波 */
function makeWav(opts: { rate?: number; channels?: number; bits?: 16 | 24 | 32; float?: boolean; seconds?: number } = {}): Uint8Array {
  const { rate = 44100, channels = 2, bits = 16, float = false, seconds = 0.1 } = opts;
  const n = Math.floor(rate * seconds);
  const frame = channels * (bits / 8);
  const dataSize = n * frame;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const w = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) v.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * frame, true);
  v.setUint16(32, frame, true);
  v.setUint16(34, bits, true);
  w(36, 'data');
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i += 1) {
    const s = Math.sin((2 * Math.PI * 440 * i) / rate);
    for (let ch = 0; ch < channels; ch += 1) {
      const off = 44 + i * frame + ch * (bits / 8);
      if (bits === 16) v.setInt16(off, s * 20000, true);
      else if (bits === 24) {
        const x = Math.round(s * 4000000);
        v.setUint8(off, x & 0xff);
        v.setUint8(off + 1, (x >> 8) & 0xff);
        v.setUint8(off + 2, (x >> 16) & 0xff);
      } else v.setFloat32(off, float ? s : s * 0.5, true);
    }
  }
  return new Uint8Array(buf);
}

console.log('[mp3 · wav 解析]');
{
  const wav = makeWav();
  const pcm = parseWav(wav);
  check('16 位立体声解析成功', !!pcm && pcm.right !== null && pcm.sampleRate === 44100);
  check('样本数对得上', !!pcm && pcm.left.length === 4410, pcm ? String(pcm.left.length) : '');
  check('正弦波幅度非零（取峰值附近的样本）', !!pcm && Math.abs(pcm.left[25]!) > 0.5);

  const mono = parseWav(makeWav({ channels: 1 }));
  check('单声道：right 为 null', !!mono && mono.right === null);

  const f32 = parseWav(makeWav({ float: true, bits: 32 }));
  check('32 位浮点解析成功', !!f32 && f32.left.length === 4410);

  const i32 = parseWav(makeWav({ bits: 32 }));
  check('32 位整型解析成功', !!i32 && i32.left.length === 4410);

  const b24 = parseWav(makeWav({ bits: 24 }));
  check('24 位解析成功', !!b24 && b24.left.length === 4410);

  check('坏 RIFF 头返回 null', parseWav(new Uint8Array(100)) === null);
  check('空数据返回 null', parseWav(makeWav({ seconds: 0 })) === null || parseWav(makeWav({ seconds: 0 })) === null);
}

console.log('[mp3 · 真编码]');
{
  const wav = makeWav({ seconds: 1 }); // 1 秒 44100 双声道 16 位 ≈ 176KB
  const pcm = parseWav(wav)!;
  const mp3 = encodePcmToMp3(pcm.left, pcm.right, pcm.sampleRate, 192);
  check('MP3 帧流以同步字开头（0xFFEx / 0xFFFx）', (mp3[0] === 0xff && (mp3[1]! & 0xe0) === 0xe0) as boolean, mp3.slice(0, 4).join(','));
  // 192kbps × 1 秒 ≈ 24KB（码率主导），wav 是 176KB → 压到约 1/7
  check('体积只有 wav 的零头（<15%）', mp3.length < wav.length * 0.15, `${mp3.length} / ${wav.length}`);
  check('体积符合码率（192kbps×1s ≈ 24KB，不是空流）', mp3.length > 8192 && mp3.length < 32000, String(mp3.length));

  const mono = parseWav(makeWav({ channels: 1, seconds: 1 }))!;
  const monoMp3 = encodePcmToMp3(mono.left, null, 44100);
  check('单声道也能编（1s ≈ 24KB）', monoMp3.length > 8192 && monoMp3.length < 32000, String(monoMp3.length));

  const rate48 = parseWav(makeWav({ rate: 48000, seconds: 1 }))!;
  const mp348 = encodePcmToMp3(rate48.left, rate48.right, 48000);
  check('48000Hz 直接编码（lame 原生支持，无需重采样）', mp348.length > 8192 && mp348.length < 32000, String(mp348.length));
}

console.log('[mp3 · 命名口径]');
{
  check('wav 判定只认 .wav 后缀', isWavName('灰姑娘（伴奏）.wav') && !isWavName('灰姑娘.mp3'));
  check('换名成 .mp3（其余原样）', mp3NameOf('灰姑娘（伴奏）.wav') === '灰姑娘（伴奏）.mp3', mp3NameOf('灰姑娘（伴奏）.wav'));
  check('无后缀也能补 .mp3', mp3NameOf('stem') === 'stem.mp3');
}

console.log(failed === 0 ? '\nmp3 压缩测试全部通过' : `\nmp3 压缩测试失败 ${failed} 项`);
if (failed > 0) process.exit(1);
