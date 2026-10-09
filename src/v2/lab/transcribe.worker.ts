/**
 * CPU 识别专用 Worker。
 *
 * 为什么存在：TFJS 的 CPU 后端运算是同步的，放在主线程会把页面整个卡死
 * （进度条不动、界面无响应，用户以为崩了）。Worker 里没有 WebGL，
 * 但 CPU 后端恰恰不需要 WebGL——把整条推理挪进来，主线程保持响应。
 *
 * 收 { audio: Float32Array(22050Hz 单声道) }，回 { type:'progress'|'done'|'error' }。
 */

import '@tensorflow/tfjs';

export interface WorkerOut {
  type: 'progress' | 'done' | 'error';
  percent?: number;
  notes?: {
    start: number;
    end: number;
    midi: number;
    amp: number;
  }[];
  message?: string;
}

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const audio = e.data.audio as Float32Array;
  try {
    const tf = await import('@tensorflow/tfjs');
    await tf.setBackend('cpu');
    await tf.ready();
    const { BasicPitch } = await import('@spotify/basic-pitch');
    const { noteFramesToTime, outputToNotesPoly } = await import('@spotify/basic-pitch');

    // 绝对路径：Worker 的相对 URL 基于脚本自身（assets/ 深处），不能相对
    const bp = new BasicPitch('/bp-model/model.json');
    const frames: number[][] = [];
    const onsets: number[][] = [];
    await bp.evaluateModel(
      audio,
      (f, o) => {
        frames.push(...(f as number[][]));
        onsets.push(...(o as number[][]));
      },
      (p) => {
        (self as unknown as Worker).postMessage({ type: 'progress', percent: p } satisfies WorkerOut);
      },
    );
    const notes = outputToNotesPoly(frames, onsets);
    const events = noteFramesToTime(notes);
    (self as unknown as Worker).postMessage({
      type: 'done',
      notes: events.map((ev) => ({
        start: ev.startTimeSeconds,
        end: ev.startTimeSeconds + ev.durationSeconds,
        midi: ev.pitchMidi,
        amp: ev.amplitude ?? 0.5,
      })),
    } satisfies WorkerOut);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      message: (err as Error)?.message ?? String(err),
    } satisfies WorkerOut);
  }
};
