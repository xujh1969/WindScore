/**
 * 「听音成谱」的识别调用层。
 *
 * 为什么不用 Web Worker：Basic Pitch 依赖 TensorFlow.js，Worker 里没有 WebGL，
 * 会退到 CPU 后端——整曲要慢一个数量级。改在主线程动态加载（import() 分包），
 * evaluateModel 每处理一批帧就 await 一次，UI 不会卡死，进度照常刷新。
 *
 * 模型资源（~900KB，量化版）随应用打包在 public/bp-model/，完全离线可用。
 */

import type { RawNote } from './quantize';

export const MODEL_URL = 'bp-model/model.json';
/** Basic Pitch 固定输入采样率 */
export const SAMPLE_RATE = 22050;

/** 把任意解码出的 AudioBuffer 重采样成模型要的单声道 22050Hz */
export async function toMono22050(buffer: AudioBuffer): Promise<Float32Array> {
  const off = new OfflineAudioContext(1, Math.ceil(buffer.duration * SAMPLE_RATE), SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0).slice();
}

export interface TranscribeEvents {
  onProgress?: (percent: number) => void;
  /** 后端确定后回调（'webgl' 快 / 'cpu' 慢），用于界面提示 */
  onBackend?: (backend: 'webgl' | 'cpu') => void;
}

/**
 * 选 TFJS 后端。部分机器的 GPU/驱动（或 WebView2 关了硬件加速）编译不了
 * WebGL 着色器，报「Failed to compile fragment shader」——所以不能只看
 * setBackend 是否成功，还要真的跑一次矩阵乘法强制着色器编译，失败退 CPU。
 */
async function pickBackend(): Promise<'webgl' | 'cpu'> {
  const tf = await import('@tensorflow/tfjs');
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    tf.tidy(() => tf.matMul(tf.randomNormal([16, 16]), tf.randomNormal([16, 16])).dataSync());
    return 'webgl';
  } catch {
    await tf.setBackend('cpu');
    await tf.ready();
    return 'cpu';
  }
}

/**
 * 识别一段 22050Hz 单声道音频，返回以秒计的音符序列。
 *
 * 路由：
 *   - GPU 探测通过 → 主线程跑（WebGL 快，但要防着色器懒编译半路炸 → 兜底重跑）
 *   - 探测失败 / GPU 半路炸 → **Worker 里跑 CPU**——TFJS 的 CPU 运算是同步的，
 *     主线程跑会把页面卡死（进度条不动、界面无响应）；Worker 的 CPU 后端
 *     不需要 WebGL，主线程保持响应，进度照常走
 */
export async function transcribe(
  audio: Float32Array,
  { onProgress, onBackend }: TranscribeEvents = {},
): Promise<RawNote[]> {
  const backend = await pickBackend();
  onBackend?.(backend);
  if (backend === 'cpu') return runInWorker(audio, { onProgress });
  try {
    return await runInference(audio, { onProgress });
  } catch (e) {
    // WebGL 半路炸（典型：模型里的算子编译着色器失败）→ Worker CPU 重跑一次
    onBackend?.('cpu');
    return runInWorker(audio, { onProgress });
  }
}

/** CPU 识别挪进 Worker：传所有权（transfer），主线程的副本作废（本来也不再使用） */
function runInWorker(
  audio: Float32Array,
  { onProgress }: TranscribeEvents,
): Promise<RawNote[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./transcribe.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; percent?: number; notes?: RawNote[]; message?: string };
      if (m.type === 'progress') {
        onProgress?.(m.percent ?? 0);
      } else if (m.type === 'done') {
        w.terminate();
        resolve(m.notes ?? []);
      } else {
        w.terminate();
        reject(new Error(m.message ?? '识别 Worker 失败'));
      }
    };
    w.onerror = (ev) => {
      w.terminate();
      reject(new Error(ev.message || '识别 Worker 加载失败'));
    };
    w.postMessage({ audio }, [audio.buffer]);
  });
}

async function runInference(
  audio: Float32Array,
  { onProgress }: TranscribeEvents,
): Promise<RawNote[]> {
  const { BasicPitch } = await import('@spotify/basic-pitch');
  const { noteFramesToTime, outputToNotesPoly } = await import('@spotify/basic-pitch');

  const bp = new BasicPitch(MODEL_URL);
  const frames: number[][] = [];
  const onsets: number[][] = [];
  await bp.evaluateModel(
    audio,
    (f, o) => {
      frames.push(...(f as number[][]));
      onsets.push(...(o as number[][]));
    },
    (p) => onProgress?.(p),
  );
  const notes = outputToNotesPoly(frames, onsets);
  const events = noteFramesToTime(notes);
  return events.map((e) => ({
    start: e.startTimeSeconds,
    end: e.startTimeSeconds + e.durationSeconds,
    midi: e.pitchMidi,
    amp: e.amplitude ?? 0.5,
  }));
}
