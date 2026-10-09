import { estimateTempo } from '../beat';
self.onmessage = (e: MessageEvent<{ audio: Float32Array; sampleRate: number }>): void => {
  try {
    self.postMessage({ estimate: estimateTempo(e.data.audio, e.data.sampleRate) });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
