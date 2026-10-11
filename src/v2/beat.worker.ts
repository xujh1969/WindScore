import { estimateTempo } from './beat';

self.onmessage = (event: MessageEvent<{ samples: Float32Array; sampleRate: number; options: Parameters<typeof estimateTempo>[2] }>) => {
  try {
    const { samples, sampleRate, options } = event.data;
    self.postMessage({ result: estimateTempo(samples, sampleRate, options) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
