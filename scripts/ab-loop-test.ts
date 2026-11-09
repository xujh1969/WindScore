/**
 * AB 点循环播放回归：区间 / B 音值终点 / 周期回绕的纯函数，
 * 外加一次 Player 真排程（假 AudioContext）验证「同一上下文内回绕、不自然收尾」。
 *
 * 跑法：
 *   esbuild scripts/ab-loop-test.ts --bundle --platform=node --format=esm --outfile=.tmp-ab-loop-test.mjs --log-level=error && node .tmp-ab-loop-test.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { abRangeOf, abSoundingEnd, loopSecMapped, loopTickLinear } from '../src/v2/abLoop';
import { Player } from '../src/v2/audio';
import { TICKS_PER_BEAT } from '../src/v2/ticks';
import type { TimelineEntry } from '../src/v2/timeline';

let fails = 0;
function check(name: string, ok: boolean, extra = ''): void {
  if (!ok) fails += 1;
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

const T = TICKS_PER_BEAT;
const A = { start: 1000, end: 1500, eventId: 'a' };
const B = { start: 3000, end: 4200, eventId: 'b' };

console.log('\n[AB 循环 · 区间判定]');
check('没勾选 / 缺 A / 缺 B 都不形成循环区间',
  abRangeOf(A, B, false, 10000) === null
  && abRangeOf(null, B, true, 10000) === null
  && abRangeOf(A, null, true, 10000) === null);
check('区间 = A 的起点 → B 的音值终点',
  JSON.stringify(abRangeOf(A, B, true, 10000)) === JSON.stringify({ from: 1000, to: 4200 }));
check('B 落在 A 之前或区间零长度 → 不循环，退回普通播放',
  abRangeOf({ start: 5000, end: 5500, eventId: 'a2' }, B, true, 10000) === null
  && abRangeOf(A, { start: 1000, end: 1000, eventId: 'b0' }, true, 10000) === null);
check('A、B 选同一颗音符 = 只循环这一颗音（起点到音值走完）',
  JSON.stringify(abRangeOf(A, A, true, 10000)) === JSON.stringify({ from: 1000, to: 1500 }));
check('B 的音值终点越过曲尾时钳到曲尾',
  JSON.stringify(abRangeOf(A, B, true, 3600)) === JSON.stringify({ from: 1000, to: 3600 }));

console.log('\n[AB 循环 · B 音值走完]');
const chain = [
  { startTick: 3000, endTick: 5000 }, // 5~5 合并成的一条长音
  { startTick: 5000, endTick: 5500 },
] as unknown as TimelineEntry[];
check('B 是延音链首音时，终点取合并长音的 endTick', abSoundingEnd(chain, 3000, 4200) === 5000);
check('B 带增时线（单音本体时值）也照样取自身终点', abSoundingEnd([], 3000, 4200) === 4200);
check('B 是休止 / 隐藏音时不产生负长度区间', abSoundingEnd([], 3000, 3000) === 3000);

console.log('\n[AB 循环 · 周期回绕]');
check('线性：区间内正常推进', loopTickLinear(0.05, 100, 100, 200, 1000) === 150);
check('线性：到 B 之后回绕到 A，多轮不漂移',
  loopTickLinear(0.15, 100, 100, 200, 1000) === 150
  && loopTickLinear(0.35, 100, 100, 200, 1000) === 150);
check('线性：从区间中途续播首轮不提前回绕', loopTickLinear(0.02, 160, 100, 200, 1000) === 180);
check('变速 / 伴奏：秒域回绕后再反查 tick',
  loopSecMapped(1, 1, 1, 3) === 2
  && loopSecMapped(3, 1, 1, 3) === 2
  && loopSecMapped(5, 1, 1, 3) === 2);

console.log('\n[AB 循环 · Player 真排程]');
let clockSec = 0;
let timerCb: (() => void) | null = null;
let closed = 0;
class FakeCtx {
  get currentTime(): number { return clockSec; }
  destination = {};
  createGain() { return { gain: { value: 1, setTargetAtTime() { /* noop */ } }, connect() { /* noop */ } }; }
  createBufferSource() { return { buffer: null, connect() { /* noop */ }, start() { /* noop */ }, stop() { /* noop */ } }; }
  close() { closed += 1; return Promise.resolve(); }
}
(globalThis as unknown as { window: unknown }).window = {
  AudioContext: FakeCtx,
  setInterval: (cb: () => void) => { timerCb = cb; return 1; },
};

const entries = [
  [0, T], [T, 2 * T], [2 * T, 3 * T], [3 * T, 4 * T], [4 * T, 5 * T], [5 * T, 6 * T],
].map(([s, e], i) => ({
  eventId: `e${i}`, startTick: s, endTick: e, degree: 1, octave: 0, midi: null,
})) as unknown as TimelineEntry[];

const p = new Player();
const startedAt = 0.1; // START_LEAD
clockSec = 0;
p.start(entries, 60, T, 0, { from: T, to: 3 * T });
clockSec = startedAt;
timerCb?.();
check('循环起播落在 A 点', Math.abs((p.currentTick ?? -1) - T) < 1, `tick=${p.currentTick}`);
// 往后推 1 秒（BPM 60 下区间长 2 拍 = 2 秒，这里还在首轮）
clockSec = startedAt + 1;
timerCb?.();
const mid = p.currentTick ?? -1;
check('区间内播放头线性推进', mid > T && mid < 3 * T, `tick=${mid}`);
// 推过 B 好几轮
clockSec = startedAt + 7;
timerCb?.();
timerCb?.();
const looped = p.currentTick ?? -1;
check('跨过 B 后播放头回绕，始终落在 [A, B)',
  looped >= T && looped < 3 * T, `tick=${looped}`);
check('循环不关 AudioContext（无断音接缝）、播放状态不结束', p.isPlaying && closed === 0, `closed=${closed}`);
const pIndex = (p as unknown as { index: number }).index;
// 指针停在「第一个起点 ≥ B」的条目上等下一轮排程窗口是正常的；
// 关键是它永远推进不到 B 之后的条目（index 3 是门槛，4/5 一次都不许排）
check('排程指针翻回区间内，B 之后的音符永不被排进去',
  pIndex >= 1 && pIndex < 4 && pIndex < entries.length, `index=${pIndex}`);

p.stop();
closed = 0;
const plain = new Player();
clockSec = 0;
plain.start(entries, 60, 0, 0, null);
clockSec = startedAt + 10;
timerCb?.();
check('loop=null 时普通播放仍会播完自动收尾', !plain.isPlaying);

console.log('\n[AB 循环 · 三端接线守门]');
const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const audio = src('src/v2/audio.ts');
const app = src('src/v2/ui/EditorApp.tsx');
const an = src('src/v2/ui/AndroidPlayer.tsx');
const ctl = src('src/v2/ui/AbLoopControls.tsx');
const css = src('src/v2/ui/editor.css');
const acss = src('src/v2/ui/android.css');
check('合成音与伴奏两条起播链路都接了区间参数',
  audio.includes('start(timeline: TimelineEntry[], bpmOrMap: number | TempoMap, fromTick = 0, semitones = 0, loop: AbRange | null = null)')
  && audio.includes('loop?: AbRange | null')
  && app.includes('loop: abRange')
  && app.includes(', transpose, abRange)'));
check('循环起播从 A 开始、不插前奏，图标关闭时走原逻辑',
  app.includes('fromOverride ?? (abRange ? abRange.from : playFromTick)')
  && app.includes('playIntro && !abRange')
  && app.includes("abRangeOf(abA, abB, abEnabled, timelineTicks(timeline))"));
check('A / B 可重设，循环图标夹在两者之间并可开关；清除按钮与逻辑已删干净',
  app.includes("setAbPoint('A')") && app.includes("setAbPoint('B')")
  && app.includes('const toggleAbLoop')
  && !app.includes('clearAbLoop') && !app.includes('onAbClear') && !app.includes('onClear=')
  && ctl.includes('aria-pressed={p.aSet}') && ctl.includes('aria-pressed={p.enabled}')
  && ctl.includes('p.onToggle(!p.enabled)') && ctl.includes('viewBox="0 0 1024 1024"')
  && !ctl.includes('type="checkbox"') && !ctl.includes('ClearIcon') && !ctl.includes('-clear')
  && ctl.indexOf('onClick={p.onSetA}') < ctl.indexOf('p.onToggle(!p.enabled)')
  && ctl.indexOf('p.onToggle(!p.enabled)') < ctl.indexOf('onClick={p.onSetB}'));
check('PC 工具条只在播放页挂控件，安卓走同一个组件',
  app.includes("mode === 'play' ? (") && app.includes('variant="pc"')
  && app.includes('abA={!!abA}') && app.includes('onAbToggle={toggleAbLoop}')
  && an.includes('variant="android"') && an.includes('onToggle={p.onAbToggle}')
  && !an.includes('onAbClear'));
check('两端都有设点变色与循环图标高亮 / 灰暗两态，勾选框和清除样式已移除',
  css.includes('.v2-ab-btn.is-on') && css.includes('.v2-ab-loop.is-on')
  && css.includes('.v2-ab-loop:not(.is-on)') && css.includes('.v2-ab-loop svg')
  && !css.includes('.v2-ab-check') && !css.includes('.v2-ab-clear')
  && acss.includes('.an-ab-btn.is-on') && acss.includes('.an-ab-loop.is-on')
  && acss.includes('.an-ab-loop:not(.is-on)') && acss.includes('.an-ab-loop svg')
  && !acss.includes('.an-ab-check') && !acss.includes('.an-ab-clear'));

console.log(fails === 0 ? '\nAB LOOP PASS' : `\nAB LOOP FAIL (${fails})`);
if (fails > 0) process.exitCode = 1;
