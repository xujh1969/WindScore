import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import AudioWaveform from '../src/v2/ui/AudioWaveform';
/** Native regression: keep the real waveform mounted, pause it for export, then resume it. */
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
  const style = document.createElement('style');
  style.textContent = '.v2-wave{width:1100px;height:106px;position:relative}.v2-wave canvas{position:absolute;inset:0;width:100%;height:100%}';
  document.head.append(style);
  const root = document.createElement('div'); document.body.append(root);
  const mounted = createRoot(root);
  let rafCalls=0, rafMs=0, rafMax=0;
  const originalRaf=window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame=callback=>originalRaf(at=>{const start=performance.now();callback(at);const ms=performance.now()-start;rafCalls++;rafMs+=ms;rafMax=Math.max(rafMax,ms)});
  const renderWave = (paused: boolean) => mounted.render(createElement(AudioWaveform,{paused,stems:[{name:'Xifuren',buffer,on:true}],tempo,
    gridBpm:saved.tempoDraft.bpm,gridPhase:saved.tempoDraft.phaseSec,gridTimes:saved.tempoDraft.beatTimes,
    beatsPerMeasure:4,markerSec:null,markerBeat:null,snap:true,originSec:0,vocalSec:null,anchors:saved.anchors,
    getPlaySec:()=>null,previewing:false,dark:true,duration:buffer.duration,
    onSeek:()=>{},onStop:()=>{},onBind:()=>{},canBind:false}));
  renderWave(false);
  await new Promise(resolve=>setTimeout(resolve,1000));
  const played = expandScore(score).score ?? score;
  const timeline = buildTimeline(played);
  const displayTimeline = buildTimeline(played, { mergeTies: false });
  await report({ test: 'song decoded', seconds: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
    notes: timeline.length, loadMs: performance.now() - started });
  let progress = 0;
  let lastReport = 0;
  const exportAt = performance.now();
  const result = await exportScoreVideoToFile({ score, name: 'Xifuren diagnostic', timeline, displayTimeline,
    tempo, bpm: score.meta.bpm, stems: [{ buffer, gain: 1 }], audio: 'stems', fromTick: 0, toTick: 192,
    ratio: 'r16x9', shortSide: 1080, fps: 30, dark: true, playStyle: 'ball',
    cancelled: () => performance.now() - exportAt > 5000,
    onProgress: ratio => { progress = ratio; },
    onStatus: status => {
      if (performance.now() - lastReport > 5000) {
        lastReport = performance.now();
        void report({ test: 'production progress', elapsedMs: performance.now() - exportAt, progress, status });
      }
    },
  });
  await report({test:'waveform raf timings',rafCalls,rafMs,rafMax});
  await report({ test: 'wave mounted', elapsedMs: performance.now() - exportAt, result });
  renderWave(true);
  await new Promise(resolve=>setTimeout(resolve,200));
  const pausedRafCalls = rafCalls;
  const nextAt = performance.now();
  const next = await exportScoreVideoToFile({ score, name: 'Xifuren diagnostic', timeline, displayTimeline,
    tempo, bpm: score.meta.bpm, stems: [{ buffer, gain: 1 }], audio: 'stems', fromTick: 0,
    ratio: 'r16x9', shortSide: 1080, fps: 30, dark: true, playStyle: 'ball',
    cancelled: () => performance.now() - nextAt > 240000 });
  if (!next.ok || rafCalls !== pausedRafCalls) throw Error('Paused waveform/export regression');
  await report({test:'wave paused / full song',elapsedMs:performance.now()-nextAt,result:next,pausedRafCalls,rafCalls});
  renderWave(false);
  await new Promise(resolve=>setTimeout(resolve,300));
  if (rafCalls <= pausedRafCalls) throw Error('Waveform failed to resume');
  mounted.unmount();
  await report({test:'wave resumed',rafCalls,passed:true,done:true});
} catch (error) { await report({ done: true, fatal: String(error) }); }
