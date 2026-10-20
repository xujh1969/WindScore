/** Compare frame capture and encoder backpressure in the local native probe. */
import { VideoSample, VideoSampleSource, BufferTarget, Output, Mp4OutputFormat } from 'mediabunny';
import { invoke } from '@tauri-apps/api/tauri';

const report = (event: object) => invoke('benchmark_event', { event });
try {
  for (const direct of [false, true]) for (const cpu of [false, true]) for (const hardware of ['no-preference', 'prefer-software'] as const) {
    const canvas = document.createElement('canvas');
    canvas.width = 1920; canvas.height = 1080;
    const ctx = canvas.getContext('2d', { willReadFrequently: cpu, alpha: false })!;
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const source = new VideoSampleSource({ codec: 'avc', bitrate: 8087040, latencyMode: 'quality', alpha: 'discard',
      hardwareAcceleration: hardware, onEncoderConfig: config => { void report({ direct, cpu, hardware, config }); } });
    output.addVideoTrack(source, { frameRate: 30 });
    let drawMs = 0, captureMs = 0, waitMs = 0;
    const started = performance.now();
    try {
      await output.start();
      for (let i = 0; i < 90; i++) {
        let at = performance.now();
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1920, 1080);
        ctx.fillStyle = '#222'; ctx.font = '36px sans-serif';
        for (let row = 0; row < 10; row++) ctx.fillText('1 2 3 4 5 6 7 1 2 3 4 5 6', 70, 100 + row * 80);
        ctx.fillStyle = '#d9b23c'; ctx.fillRect(100 + i * 5, 0, 3, 1080);
        drawMs += performance.now() - at;
        at = performance.now();
        const sample = direct
          ? new VideoSample(new VideoFrame(canvas, { timestamp: Math.round(i / 30 * 1e6), alpha: 'discard' }), { timestamp: i / 30, duration: 1 / 30 })
          : new VideoSample(canvas, { timestamp: i / 30, duration: 1 / 30 });
        captureMs += performance.now() - at;
        at = performance.now();
        try { await source.add(sample); } finally { sample.close(); }
        waitMs += performance.now() - at;
      }
      source.close(); await output.finalize();
      await report({ test: 'capture / encoder', direct, cpu, hardware, drawMs, captureMs, waitMs, totalMs: performance.now() - started });
    } catch (error) { await output.cancel(); await report({ direct, cpu, hardware, error: String(error) }); }
  }
  await report({ done: true });
} catch (error) { await report({ done: true, fatal: String(error) }); }
