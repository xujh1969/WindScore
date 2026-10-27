/**
 * 输入试听：每敲入 / 替换一个音符，立刻响一声它的钢琴音高。
 *
 * 音色与播放共用一份代码（timbre.ts 的 renderNote，采样加载后是真钢琴），
 * 但与 Player 完全独立——不碰播放的上下文、不占排程窗口，随手输入随手响。
 *
 * Web Audio 策略（0.2.101 教训）：
 *   - AudioContext 在**用户手势内**同步懒建（按键 / 点按钮就是手势），建完立刻
 *     resume()——新建的上下文默认 suspended，不 resume 排进去的音一个都不响；
 *   - 不 close()：预览贯穿整个编辑会话，关了下次重建又要重新过策略；
 *   - 失败静默：无音频环境（自动化测试 / 权限）不弹错、不影响输入。
 */

import { pianoSpec, renderNote } from './timbre';
import { instrumentSampleFor, isInstrumentLoaded, loadInstrumentSamples, renderSampledNote } from './instrumentSamples';

let ctx: AudioContext | null = null;
/** 在响的源（只做引用计数，防止极端连打下的无限累积） */
const live: AudioBufferSourceNode[] = [];
/** 同时在响的上限：超过就掐掉最旧的（快速连打时短音叠短音，听不清还费电） */
const MAX_LIVE = 6;
/** 单声长度（秒）：覆盖起音 + 一段自然衰减，足够辨认音高 */
const DUR = 0.45;

/** 输入试听静音开关的持久化键（只管输入 / 点音的这一声，与播放无关） */
const MUTE_KEY = 'windscore.preview-muted';

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 静音开关（0.2.187，用户要求）：关掉之后输入音符、点击音符都不出声。
 * 模块级而不是组件 state——试听的调用点分散在点击 / 输入板 / 替换三处，
 * 统一在发声口拦一道最省心，也不用在每条调用链上透传 props。
 */
let muted = readMuted();

export function isPreviewMuted(): boolean {
  return muted;
}

export function setPreviewMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    /* 无存储环境（隐私模式 / 自动化测试）就不持久化，本次会话内仍生效 */
  }
  if (value) stopLive();
}

/** 掐掉正在响的试听音（切到静音时立即生效，不用等它自己响完） */
function stopLive(): void {
  for (const s of live) {
    try {
      s.stop();
    } catch {
      /* 还没 start 过的源调用 stop 会抛，忽略 */
    }
  }
  live.length = 0;
}

export function previewNote(midi: number, gain = 0.28, patch?: number, patchOctave = 0): void {
  // 静音时直接返回：连 AudioContext 都不建，免得静音了还去解锁音频、白占一个上下文
  if (muted) return;
  const at = midi + patchOctave * 12;
  // 指定的音色是真采样但**还没解码**（懒加载：播放前才批量解码）→ 现在拉起解码，
  // 解码完成用真音色补这一声。不能先响一声钢琴凑合：点音听到的必须是指定的
  // 声部音色，否则用户以为音色没生效（0.3.8 修，用户实测）。解码失败回落钢琴。
  if (patch !== undefined && !instrumentSampleFor(patch, at) && !isInstrumentLoaded(patch)) {
    void loadInstrumentSamples(patch)
      .catch(() => false)
      .then(() => {
        if (!muted) playPreview(midi, gain, at, patch, patchOctave);
      });
    return;
  }
  playPreview(midi, gain, at, patch, patchOctave);
}

function playPreview(midi: number, gain: number, at: number, patch?: number, patchOctave = 0): void {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    // 音色与播放同一套选择：当前声部有真采样且已加载 → 真采样；否则钢琴合成
    // 发声音高同样加音色八度，试听和播放听到的才是一个高度
    const inst = instrumentSampleFor(patch, at);
    const pcm = inst
      ? renderSampledNote(inst.pcm, inst.point, at, {
          sampleRate: ctx.sampleRate,
          durationSec: DUR,
          dyn: 1,
        })
      : renderNote(pianoSpec(at, 1), {
          sampleRate: ctx.sampleRate,
          durationSec: DUR,
          dyn: 1,
        });
    const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
    buf.getChannelData(0).set(pcm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(ctx.destination);
    src.start();
    live.push(src);
    while (live.length > MAX_LIVE) {
      const old = live.shift();
      try {
        old?.stop();
      } catch {
        /* 还没 start 过的源调用 stop 会抛，忽略 */
      }
    }
    src.onended = () => {
      const i = live.indexOf(src);
      if (i >= 0) live.splice(i, 1);
    };
  } catch {
    /* 没有音频环境就静默跳过 */
  }
}

/** 组件卸载时释放（与 Player.dispose 同一惯例：只在卸载时关上下文） */
export function disposePreview(): void {
  stopLive();
  const c = ctx;
  ctx = null;
  void c?.close().catch(() => undefined);
}
