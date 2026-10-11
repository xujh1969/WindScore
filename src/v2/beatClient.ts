import { mixdown, type TempoEstimate } from './beat';
import type { estimateTempo } from './beat';

export function analyzeBeats(buffer: AudioBuffer, options: Parameters<typeof estimateTempo>[2], signal: AbortSignal): Promise<TempoEstimate | null> {
  const samples = mixdown(buffer);
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
    const worker = new Worker(new URL('./beat.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(new DOMException('已取消', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ result: TempoEstimate | null; error?: string }>) => {
      finish();
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
    };
    worker.onerror = (event) => { finish(); reject(new Error(event.message || '节拍分析失败')); };
    worker.postMessage({ samples, sampleRate: buffer.sampleRate, options }, [samples.buffer]);
  });
}

/** 分轨长度通常相同，不能靠“最长”挑节奏输入。 */
export function rhythmSource<T extends { name: string; buffer: AudioBuffer }>(stems: T[]): T | undefined {
  const priority = (name: string) => /drum|鼓|percuss/i.test(name) ? 4 : /伴奏|accompan|instrument|other|其他|music/i.test(name) ? 3 : /bass|贝斯/i.test(name) ? 2 : /vocal|人声|voice/i.test(name) ? 0 : 1;
  return [...stems].sort((a, b) => priority(b.name) - priority(a.name) || b.buffer.duration - a.buffer.duration)[0];
}
