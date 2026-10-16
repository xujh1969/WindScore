import { pitchShiftChannel, timeStretch } from './pitchShift';

// 不引用 webworker lib（与 DOM lib 冲突），用一个最小结构描述 DedicatedWorkerGlobalScope
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ channels: Float32Array[]; semitones: number; speed: number }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = (event) => {
  try {
    const { channels, semitones, speed } = event.data;
    // 先变调后变速：两步都是 O(n) 量级，顺序对结果影响可忽略；
    // 变速走纯 WSOLA 拉伸（时长 ÷ speed，音高不变）——伴奏加速不升调
    let out = channels;
    if (semitones !== 0) out = out.map((ch) => pitchShiftChannel(ch, semitones));
    if (speed !== 1) out = out.map((ch) => timeStretch(ch, 1 / speed));
    scope.postMessage({ channels: out }, out.map((c) => c.buffer as ArrayBuffer));
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
