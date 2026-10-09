import type { TempoEstimate } from '../beat';
import { mixdown } from '../beat';

export type Track = 'vocal' | 'music' | 'drums' | 'bass' | 'other';
export const TRACKS: { id: Track; label: string; role: string }[] = [
  { id: 'vocal', label: '人声', role: '主旋律来源' },
  { id: 'music', label: '完整伴奏', role: '两分轨里的音乐' },
  { id: 'drums', label: '鼓', role: '优先节奏参考' },
  { id: 'bass', label: '贝斯', role: '节奏参考' },
  { id: 'other', label: '其他乐器', role: '四分轨里的 Other' },
];
export function rhythmSource(files: Partial<Record<Track, File>>): Track | null {
  return (['drums', 'music', 'bass', 'other', 'vocal'] as Track[]).find((t) => files[t]) ?? null;
}
export function analyzeRhythm(buffer: AudioBuffer, signal: AbortSignal): Promise<TempoEstimate | null> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./rhythm.worker.ts', import.meta.url), { type: 'module' });
    const cleanup = (): void => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = (): void => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (e): void => {
      cleanup();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.estimate);
    };
    worker.onerror = (): void => { cleanup(); reject(new Error('节奏分析失败')); };
    const audio = mixdown(buffer);
    worker.postMessage({ audio, sampleRate: buffer.sampleRate }, [audio.buffer]);
  });
}
