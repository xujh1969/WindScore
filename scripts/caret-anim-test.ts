/**
 * 光标跨行 / 跨连谱系统时的「视口跟随 + 移动光标引导」回归（jsdom 真挂载）。
 *
 * 用户实测过两次「动画没出现」：点击时 mousedown 会先 setDragFrom，
 * 若在那帧把旧插入点清掉，mouseup 后就判不出跳跃；另外浮层曾放在滚动
 * 内容里（absolute），可能被裁剪 / 盖住。这里同时验证两条路径：
 *   ① 键盘键入 / 粘贴导致 cursor 跨行 → 平滑滚动 + 带位移的动画
 *   ② 真派发 mousedown/mouseup 后再跨行 → 动画仍从点击位置起步
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/editor.html', pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
const define = (key: string, value: unknown): void => {
  try { Object.defineProperty(g, key, { value, writable: true, configurable: true }); } catch { /* readonly */ }
};
define('window', dom.window);
define('document', dom.window.document);
define('navigator', dom.window.navigator);
define('HTMLElement', dom.window.HTMLElement);
define('HTMLInputElement', dom.window.HTMLInputElement);
define('Element', dom.window.Element);
define('Node', dom.window.Node);
define('Event', dom.window.Event);
define('MouseEvent', dom.window.MouseEvent);
define('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
define('IS_REACT_ACT_ENVIRONMENT', true);
define('matchMedia', () => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
define('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
define('requestAnimationFrame', (fn: (t: number) => void) => dom.window.requestAnimationFrame(fn));
define('cancelAnimationFrame', (id: number) => dom.window.cancelAnimationFrame(id));

let st = 0, sl = 0;
const proto = dom.window.Element.prototype as unknown as Record<string, unknown>;
Object.defineProperty(proto, 'scrollTop', { get: () => st, set: (v: number) => { st = Number(v) || 0; }, configurable: true });
Object.defineProperty(proto, 'scrollLeft', { get: () => sl, set: (v: number) => { sl = Number(v) || 0; }, configurable: true });
for (const [k, v] of Object.entries({ clientHeight: 600, clientWidth: 900, scrollHeight: 4000, scrollWidth: 1000 })) {
  Object.defineProperty(proto, k, { get: () => v, configurable: true });
}
proto.getBoundingClientRect = function (this: Element) {
  const isCanvas = this.tagName === 'CANVAS';
  return { left: isCanvas ? -sl : 0, top: isCanvas ? -st : 0, width: isCanvas ? 1000 : 900, height: isCanvas ? 4000 : 600,
    right: isCanvas ? 1000 - sl : 900, bottom: isCanvas ? 4000 - st : 600, x: 0, y: 0, toJSON() {} };
};
const animCalls: { frames: unknown[]; opts: { duration?: number } }[] = [];
proto.animate = function (this: Element, frames: unknown[], opts: { duration?: number }) {
  animCalls.push({ frames, opts: opts ?? {} });
  return { cancel() {}, finished: Promise.resolve() };
};
proto.getAnimations = () => [];
// canvas 2D 万能桩
const makeStub = (): unknown => new Proxy(function stub() {} as unknown as Record<string, unknown>, {
  get: (target, prop) => {
    if (prop === Symbol.toPrimitive) return () => 0;
    if (prop === 'width' || prop === 'height') return 0;
    const cached = target[prop as string];
    if (cached !== undefined) return cached;
    if (prop === 'measureText') return (s: string) => ({ width: String(s).length * 8 });
    return (target[prop as string] = makeStub());
  },
  set: () => true,
  apply: () => makeStub(),
});
dom.window.HTMLCanvasElement.prototype.getContext = (() => makeStub()) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'ok  ' : 'XX  '}${name}${detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const main = async (): Promise<void> => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ScoreCanvas } = await import('../src/v2/ui/ScoreCanvas');
  const { parseDsl } = await import('../src/v2/dsl');
  const { buildTimeline } = await import('../src/v2/timeline');
  const { BeatClock } = await import('../src/v2/clock');
  const { readFileSync } = await import('node:fs');
  const act = async (fn: () => void | Promise<void>): Promise<void> => {
    const maybe = (React as unknown as { act?: (f: () => unknown) => unknown }).act;
    if (maybe) await maybe(() => fn()); else fn();
    await new Promise((r) => setTimeout(r, 0));
  };

  // 足够多的音符 → 自动折成多行，Δy 远超 40
  const body = Array.from({ length: 30 }, () => '1 2 3 4 |').join(' ');
  const score = parseDsl(`@beat 4/4\n\n${body} ||\n`).score!;
  const timeline = buildTimeline(score);
  const clock = new BeatClock();
  let layout: ReturnType<typeof import('../src/v2/layout').layoutScore> | null = null;
  const root = createRoot(dom.window.document.getElementById('root')!);
  const render = (cursor: number) => root.render(React.createElement(ScoreCanvas, {
    score, activePartId: '1', dark: false, selectedIds: new Set<string>(), cursor,
    timeline, playing: false, clock, showCaret: true, showBreaks: true,
    onPick: () => {}, onEnded: () => {}, onLayout: (l) => { layout = l; },
  }));

  await act(() => render(1));
  check('挂载后有排版', !!layout && layout!.lines.length > 1, `lines=${layout?.lines.length}`);
  const lineY = layout!.lines[0].y;
  const far = layout!.lines.filter((ln) => ln.y - lineY > 40 && ln.items.some((it) => it.eventIndex >= 0)).at(-1);
  check('存在 y 相差 >40 的后续行', !!far, `y0=${lineY} y1=${far?.y}`);
  const farCursor = far?.items.find((it) => it.eventIndex >= 0)?.eventIndex ?? -1;
  check('后续行有可定位的 eventIndex', farCursor >= 0, String(farCursor));

  animCalls.length = 0;
  await act(() => render(farCursor));
  const ghost = dom.window.document.querySelector('.v2-caret-ghost') as HTMLElement | null;
  check('浮层节点存在', !!ghost);
  check('跨行跳跃触发了动画', animCalls.length > 0, `calls=${animCalls.length}`);
  const frames = animCalls[0]?.frames as { transform?: string; opacity: number; offset: number }[] | undefined;
  const moving = !!frames && frames.some((f) => f.transform && /translate\([^0]/.test(f.transform));
  check('动画含非零位移（光标移动）', moving, JSON.stringify(frames?.map((f) => f.transform)));
  // 「先在起点生成一枚光标、停一下、再移动」：至少两帧静止且完全可见，且中间有 offset 间隔
  const still = frames?.filter((f) => f.transform?.startsWith('translate(0px, 0px)') && f.opacity === 1) ?? [];
  check('起点先生成光标并停留（≥2 个静止可见关键帧）', still.length >= 2 && still.at(-1)!.offset - still[0].offset >= 0.1,
    `still=${still.length} offsets=${still.map((f) => f.offset).join(',')}`);
  check('总时长放慢到 1 秒', animCalls[0]?.opts.duration === 1000, String(animCalls[0]?.opts.duration));
  check('浮层定位已写入', !!ghost && ghost.style.left !== '' && ghost.style.top !== '', `${ghost?.style.left} / ${ghost?.style.top}`);
  const css = readFileSync('src/v2/ui/editor.css', 'utf8');
  check('浮层 CSS 是 position:fixed', /\.v2-caret-ghost\s*\{[^}]*position:\s*fixed/.test(css));
  check('浮层有 I 形光标上下衬线', /\.v2-caret-ghost::before/.test(css) && /\.v2-caret-ghost::after/.test(css));
  await new Promise((r) => setTimeout(r, 80)); // 等平滑滚动的几帧落地
  check('视口跟随滚动（scrollTop 被写过且为正）', st > 0, `scrollTop=${st}`);

  // 点击路径：mousedown 会 setDragFrom，mouseup 才清。旧实现在 mousedown 那帧
  // 把 lastCaretPoint 清成 null，导致 mouseup 后判不出跳跃 → 动画永不出现。
  // 这里真派发鼠标事件，再把上层 onPick 换算出的 cursor 作为新 props 回灌。
  let pickedCursor = -1;
  const renderWithClick = (cursor: number) => root.render(React.createElement(ScoreCanvas, {
    score, activePartId: '1', dark: false, selectedIds: new Set<string>(), cursor,
    timeline, playing: false, clock, showCaret: true, showBreaks: true,
    onPick: (a: { cursor: number }) => { pickedCursor = a.cursor; }, onEnded: () => {}, onLayout: (l) => { layout = l; },
  }));
  await act(() => renderWithClick(1));
  st = 0; sl = 0;
  const canvas = dom.window.document.querySelector('canvas') as HTMLCanvasElement;
  const mouse = (type: string) => canvas.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 195, button: 0 }));
  animCalls.length = 0;
  await act(() => { mouse('mousedown'); });
  check('点击命中谱面并给出插入位置', pickedCursor >= 0, String(pickedCursor));
  // 真实交互里 onPick 当场让上层回灌 cursor：回灌这一帧 dragFrom 还在，
  // effect 让过；mouseup 帧才是动画真正播放的那一帧。
  await act(() => renderWithClick(farCursor));
  await act(() => { mouse('mouseup'); });
  check('点击后再跨行：dragFrom 不再吃掉动画起点', animCalls.length > 0, `calls=${animCalls.length}`);
  const ghost2 = dom.window.document.querySelector('.v2-caret-ghost') as HTMLElement;
  check('动画从点击位置（clientX=100）起步', !!animCalls.length && ghost2.style.left.startsWith('100px'), ghost2.style.left);

  // 回归：把视口滚回去、再点同一位置。cursor / focusId / events 全不变，
  // 旧实现被幂等 key 吞掉（且 jumped=false，光标没动），动画再也不播。
  st = 0; sl = 0;
  animCalls.length = 0;
  await act(() => { mouse('mousedown'); });
  await act(() => { mouse('mouseup'); });
  await act(() => renderWithClick(farCursor));
  const ghost3 = dom.window.document.querySelector('.v2-caret-ghost') as HTMLElement;
  check('滚回去再点同一位置：动画再次播放', animCalls.length > 0, `calls=${animCalls.length}`);
  check('重播仍从点击处起步', !!animCalls.length && ghost3.style.left.startsWith('100px'), ghost3.style.left);
  check('重播仍是完整 1 秒分段动画', animCalls[0]?.opts.duration === 1000, String(animCalls[0]?.opts.duration));
  // 没有新点击时，同样的 props 不该重复播动画
  animCalls.length = 0;
  await act(() => renderWithClick(farCursor));
  check('无新点击时不重复播放', animCalls.length === 0, `calls=${animCalls.length}`);

  root.unmount();
  console.log(failed === 0 ? '\nCARET ANIM PASS' : `\nCARET ANIM FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
};
void main();
