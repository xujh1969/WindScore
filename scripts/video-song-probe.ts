/** Run the production export pipeline on the user's reproduction fixture; save dialog is replaced at bundle time. */
import { readTextFile, readBinaryFile } from '@tauri-apps/api/fs';
import { invoke } from '@tauri-apps/api/tauri';
import { parseDsl } from '../src/v2/dsl';
import { expandScore } from '../src/v2/expand';
import { buildTimeline } from '../src/v2/timeline';
import { curveFromAnchors } from '../src/v2/tempo';
import { exportScoreVideoToFile } from '../src/v2/export/videoExport';

const report = (event: object) => invoke('benchmark_event', { event });
const originalInfo = console.info;
console.info = (...args: unknown[]) => {
  const record = args[1] as { phase?: string } | undefined;
  if (args[0] === '[video]' && ['encoder-trial', 'encoder-selected', 'encoder-config', 'complete'].includes(record?.phase ?? '')) {
    void report({ test: 'production diagnostic', ...record });
  }
  originalInfo(...args);
};
try {
  const started = performance.now();
  await report({ test: 'production pipeline / Xifuren / 1080p30 / ball / dark', environment: navigator.userAgent });
  const parsed = parseDsl(await readTextFile('C:/Users/AYOU/Desktop/WindScore/music/息夫人/息夫人.jps'));
  if (!parsed.score || parsed.errors.length) throw new Error(parsed.errors.join('; '));
  const score = parsed.score;
  const saved = JSON.parse(await readTextFile('C:/Users/AYOU/Desktop/WindScore/.tmp-video-probe/song.json')).align['12'];
  const tempo = curveFromAnchors(saved.anchors, { ...saved.tempoDraft,
    totalBeats: score.events.reduce((sum, event) => sum + ('ticks' in event ? event.ticks : 0), 0) / 48,
  });
  const audioBytes = await readBinaryFile('C:/Users/AYOU/Desktop/WindScore/music/息夫人/息夫人.mp3');
  const context = new OfflineAudioContext(2, 1, 44100);
  const buffer = await context.decodeAudioData(new Uint8Array(audioBytes).buffer);
  const played = expandScore(score).score ?? score;
  const timeline = buildTimeline(played);
  const displayTimeline = buildTimeline(played, { mergeTies: false });
  await report({ test: 'song decoded', seconds: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
    notes: timeline.length, loadMs: performance.now() - started });
  let progress = 0;
  let lastReport = 0;
  const exportAt = performance.now();
  const result = await exportScoreVideoToFile({ score, name: 'Xifuren diagnostic', timeline, displayTimeline,
    tempo, bpm: score.meta.bpm, stems: [{ buffer, gain: 1 }], audio: 'stems', fromTick: 0,
    ratio: 'r16x9', shortSide: 1080, fps: 30, dark: true, playStyle: 'ball',
    cancelled: () => performance.now() - exportAt > 240000,
    onProgress: ratio => { progress = ratio; },
    onStatus: status => {
      if (performance.now() - lastReport > 5000) {
        lastReport = performance.now();
        void report({ test: 'production progress', elapsedMs: performance.now() - exportAt, progress, status });
      }
    },
  });
  await report({ test: 'production result', elapsedMs: performance.now() - exportAt, result, done: true });
} catch (error) { await report({ done: true, fatal: String(error) }); }
