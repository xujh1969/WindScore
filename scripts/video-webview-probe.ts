/** Bounded encoding benchmark inside a standalone Tauri/WebView2 test host. No network or user files. */
import { CanvasSource, AudioBufferSource, Output, BufferTarget, Mp4OutputFormat } from 'mediabunny';
import { invoke } from '@tauri-apps/api/tauri';
import { readTextFile } from '@tauri-apps/api/fs';
import { parseDsl } from '../src/v2/dsl';
import { videoLayoutFor, videoGeometry, lineTickRanges, scrollTargetY } from '../src/v2/export/video';
import { createVideoFramePainter } from '../src/v2/export/frameCache';
import { paintVideoFrame } from '../src/v2/export/render';
import { LIGHT_THEME, DARK_THEME } from '../src/v2/paint';
import { buildTimeline, activeMainAt } from '../src/v2/timeline';
import { constantTempo, curveFromAnchors, secToTick, tickToSec } from '../src/v2/tempo';
import { buildBallTrack, sampleBallTrail } from '../src/v2/ball';
import { expandScore } from '../src/v2/expand';

const report = (event: object) => invoke('benchmark_event', { event });
let songText: string | undefined;
let alignment: any;
async function testAudio() {
  const output = new Output({ target: new BufferTarget(), format: new Mp4OutputFormat() });
  const source = new AudioBufferSource({ codec: 'aac', bitrate: 160e3 });
  output.addAudioTrack(source);
  const started = performance.now();
  const timeout = setTimeout(() => { void output.cancel(); }, 15000);
  try {
    await output.start();
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: 44100 * 360, sampleRate: 44100 });
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let index = 0; index < data.length; index++) data[index] = Math.sin(index * 440 * Math.PI * 2 / 44100) * 0.1;
    }
    const fillMs = performance.now() - started;
    await source.add(buffer);
    source.close();
    await output.finalize();
    await report({ name: '6 minute AAC audio', fillMs, elapsedMs: performance.now() - started });
  } catch (error) { await report({ name: '6 minute AAC audio', elapsedMs: performance.now() - started, error: String(error) }); }
  finally { clearTimeout(timeout); }
}
async function test(name: string, hardware: 'no-preference' | 'prefer-hardware', fastStart: boolean, timer: boolean, renderer?: 'vector' | 'cache', ball = false, dark = false, offsetSec = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext('2d')!;
  const score = parseDsl(songText ?? '@title Probe\n@key 1=C\n@beat 4/4\n@bpm 96\n\n' + '1 2 3 4 | '.repeat(150)).score;
  if (!score) throw new Error('Score parse failed');
  const layout = videoLayoutFor(score, 'r16x9', 1080, true);
  const theme = dark ? DARK_THEME : LIGHT_THEME;
  const cached = createVideoFramePainter(ctx, layout, theme);
  const geometry = videoGeometry('r16x9', 1080);
  const played = expandScore(score).score ?? score;
  const timeline = buildTimeline(played, { mergeTies: false });
  const tempo = alignment ? curveFromAnchors(alignment.anchors, { ...alignment.tempoDraft,
    totalBeats: score.events.reduce((sum, event) => sum + ('ticks' in event ? event.ticks : 0), 0) / 48,
  }) : constantTempo(96, 0, 0);
  const startSec = tickToSec(tempo, 0);
  const ranges = lineTickRanges(layout, timeline);
  const ballTrack = buildBallTrack(layout, timeline, undefined);
  const trail: { x: number; y: number }[] = [];
  const output = new Output({ target: new BufferTarget(), format: new Mp4OutputFormat(fastStart ? {} : { fastStart: false }) });
  let config: unknown;
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: 8087040, latencyMode: 'quality', alpha: 'discard', keyFrameInterval: 2,
    hardwareAcceleration: hardware, onEncoderConfig: value => { config = value; } });
  output.addVideoTrack(source, { frameRate: 30 });
  let frames = 0;
  let drawMs = 0;
  let encodeMs = 0;
  let yieldMs = 0;
  const started = performance.now();
  let progressAt = started;
  let stopped = false;
  const timeout = setTimeout(() => { stopped = true; void output.cancel(); }, 15000);
  try {
    await output.start();
    while (frames < 60 && !stopped) {
      const drawAt = performance.now();
      if (renderer) {
        const tick = secToTick(tempo, startSec + offsetSec + frames / 30);
        const active = activeMainAt(timeline, tick)!;
        const opts = { canvasW: 1920, canvasH: 1080, scale: geometry.geo.scale,
          scrollY: scrollTargetY(ranges, tick, geometry.geo.scale, 1080, layout.lineHeight),
          playheads: [{ eventId: active.entry.eventId, frac: active.progress }], progress: frames / 60,
          playStyle: ball ? 'ball' as const : 'head' as const,
          ...(ball && ballTrack ? { ball: sampleBallTrail(ballTrack, tick, 0, trail) } : {}),
        };
        if (renderer === 'cache') cached(opts);
        else paintVideoFrame(ctx, layout, theme, opts);
      } else {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = '#242424'; ctx.font = '36px sans-serif';
      for (let row = 0; row < 10; row++) ctx.fillText('1 2 3 4 5 6 7 1 2 3 4 5 6', 70, 100 + row * 80);
      ctx.fillStyle = '#d9b23c'; ctx.fillRect(100 + frames * 5, 0, 3, 1080);
      }
      drawMs += performance.now() - drawAt;
      const encodeAt = performance.now();
      await source.add(frames / 30, 1 / 30);
      encodeMs += performance.now() - encodeAt;
      frames++;
      if (timer && performance.now() - progressAt >= 150) {
        const yieldAt = performance.now();
        await new Promise(resolve => setTimeout(resolve, 0));
        yieldMs += performance.now() - yieldAt;
        progressAt = performance.now();
      }
    }
    if (!stopped) { source.close(); await output.finalize(); }
    await report({ name, hardware, fastStart, timer, frames, drawMs, encodeMs, yieldMs, elapsedMs: performance.now() - started, stopped, config });
  } catch (error) {
    await output.cancel();
    await report({ name, frames, drawMs, encodeMs, yieldMs, elapsedMs: performance.now() - started, stopped, error: String(error), config });
  } finally { clearTimeout(timeout); }
}

try {
  await report({ environment: navigator.userAgent, visibility: document.visibilityState });
  songText = await readTextFile('C:/Users/AYOU/Desktop/WindScore/music/息夫人/息夫人.jps');
  alignment = JSON.parse(await readTextFile('C:/Users/AYOU/Desktop/WindScore/.tmp-video-probe/song.json')).align['12'];
  await test('Xifuren light vector', 'no-preference', true, false, 'vector', true);
  await test('Xifuren light cache', 'prefer-hardware', false, true, 'cache', true);
  await test('Xifuren dark vector', 'no-preference', true, false, 'vector', true, true);
  await test('Xifuren dark cache', 'prefer-hardware', false, true, 'cache', true, true);
  await test('Xifuren at 36s vector', 'no-preference', true, false, 'vector', true, true, 36);
  await test('Xifuren at 36s cache', 'prefer-hardware', false, true, 'cache', true, true, 36);
  await report({ done: true });
} catch (error) { await report({ done: true, fatal: String(error) }); }
