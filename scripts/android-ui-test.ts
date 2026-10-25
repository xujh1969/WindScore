/**
 * 安卓 UI 自动化测试：防止「改一处、白一片」的功能退化。
 *
 * ① 冒烟：EditorApp 安卓播放页（android-player）在 jsdom 里 renderToString，
 *    渲染抛错 = 手机上白屏。分别验证默认状态与「有每曲偏好」状态（含五线谱恢复）。
 * ② 交互：真挂载 AndroidPlayer（react-dom/client），点开设置、点开下拉、
 *    选中选项——验证选项面板会关闭、回调带正确值、五线谱调性选择器按需出现。
 *
 * 跑法：npm run test:android（已接入测试链），或单独 esbuild + node 本文件。
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body data-entry="android"><div id="root"></div></body></html>', {
  url: 'https://appassets.androidplatform.net/assets/android.html',
  pretendToBeVisual: true,
});

// jsdom 全局注入：组件代码按浏览器环境书写，测试里必须先把全局对象摆好再 import 组件。
// 新版 Node 的部分全局（navigator 等）只读，用 defineProperty 防御式覆盖。
const g = globalThis as unknown as Record<string, unknown>;
const define = (key: string, value: unknown): void => {
  try { Object.defineProperty(g, key, { value, writable: true, configurable: true }); }
  catch { /* 全局只读（如 Node 自带 navigator）就保留原值 */ }
};
define('window', dom.window);
define('document', dom.window.document);
define('navigator', dom.window.navigator);
define('localStorage', dom.window.localStorage);
define('sessionStorage', dom.window.sessionStorage);
define('location', dom.window.location);
define('history', dom.window.history);
define('HTMLElement', dom.window.HTMLElement);
define('HTMLInputElement', dom.window.HTMLInputElement);
define('Element', dom.window.Element);
define('Node', dom.window.Node);
define('Event', dom.window.Event);
define('MouseEvent', dom.window.MouseEvent);
define('KeyboardEvent', dom.window.KeyboardEvent);
define('CustomEvent', dom.window.CustomEvent);
define('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
define('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
define('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
define('IS_REACT_ACT_ENVIRONMENT', true);
define('matchMedia', () => ({ // jsdom 未实现 matchMedia，手写桩
  matches: false, media: '', onchange: null,
  addEventListener: (): void => {}, removeEventListener: (): void => {},
  addListener: (): void => {}, removeListener: (): void => {},
  dispatchEvent: (): boolean => false,
}));
// jsdom 缺的浏览器 API：组件 effect 会用到（真实设备上都有）
define('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
{
  // canvas 2D 上下文桩：任何属性访问/方法调用都返回万能桩；参与运算时退化为 0/''，不抛错
  const makeStub = (): unknown => new Proxy(function stub() { /* 万能空函数 */ } as unknown as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === 'width' || prop === 'height') return 0;
      const cached = target[prop as string];
      return cached !== undefined ? cached : (target[prop as string] = makeStub());
    },
    set: () => true,
    apply: () => makeStub(),
  });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => makeStub()) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
}
{
  // jsdom 未实现 <dialog>.showModal：补最小桩，弹窗行为（打开/关闭）照常可测
  const dlg = dom.window.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  if (typeof dlg.showModal !== 'function') {
    dlg.showModal = function showModal(this: HTMLDialogElement): void { this.open = true; };
  }
  if (typeof dlg.close !== 'function') {
    dlg.close = function close(this: HTMLDialogElement): void { this.open = false; };
  }
  // jsdom 未实现 Element.scrollIntoView：空桩即可
  const elProto = dom.window.Element.prototype as unknown as Record<string, unknown>;
  if (typeof elProto.scrollIntoView !== 'function') {
    elProto.scrollIntoView = function scrollIntoView(): void { /* no-op */ };
  }
}
// jsdom 没有 IndexedDB：库存储走本地兜底即可，测试不触库

let pass = 0;
const fail = (msg: string): never => { console.error(`XX ${msg}`); process.exit(1); };
const ok = (msg: string) => { pass++; console.log(`ok ${msg}`); };
const click = (el: Element): void => {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
};

const main = async (): Promise<void> => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { EditorApp } = await import('../src/v2/ui/EditorApp');
  const { AndroidPlayer } = await import('../src/v2/ui/AndroidPlayer');
  const { metaOfText } = await import('../src/v2/ui/libraryStore');

  const demoText = `@title=测试曲
@bpm=80
1 2 3 1 | 1 2 3 1 |`;

  const song = {
    id: 'song-1', name: '测试曲', text: demoText, updatedAt: 1,
    meta: metaOfText(demoText, '测试曲'),
  };

  // 真挂载（不是 SSR）：客户端渲染与真机一致，effect 也会跑，渲染抛错当场暴露
  const mountEditor = async (): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> => {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    await act(() => root.render(React.createElement(EditorApp, {
      entry: 'android-player', androidItem: song, androidDark: false,
      androidPreview: false, onAndroidBack: () => {},
    })));
    return { container, unmount: async () => { await act(() => root.unmount()); container.remove(); } };
  };

  // ---------- ① 冒烟：安卓播放页渲染（默认状态） ----------
  let mounted = await mountEditor();
  let html = mounted.container.innerHTML;
  if (!html.includes('an-player')) fail('安卓播放页没有渲染出播放器结构');
  if (!html.includes('测试曲')) fail('播放页没有显示曲名');
  if (!html.includes('简谱')) fail('默认记谱方式应是简谱');
  await mounted.unmount();
  ok('安卓播放页渲染冒烟（默认 简谱/head）');

  // ---------- ①b 冒烟：有每曲偏好时恢复五线谱 + 移调谱 + 光球 ----------
  dom.window.localStorage.setItem('ws-an-view:测试曲', JSON.stringify({
    font: 30, gap: 6, lineGap: 12, style: 'ball', notation: 'staff', pitch: 'transposed',
  }));
  mounted = await mountEditor();
  html = mounted.container.innerHTML;
  if (!html.includes('五线谱')) fail('每曲偏好 notation=staff 未恢复（标题应显示五线谱）');
  await mounted.unmount();
  dom.window.localStorage.removeItem('ws-an-view:测试曲');
  ok('每曲偏好恢复冒烟（五线谱/移调/字号/光球）');

  // ---------- ② AndroidPlayer 交互：设置弹窗 + 自绘下拉 ----------
  const calls: { notation?: boolean; style?: string; pitch?: string } = {};
  const noop = (): void => {};
  const props = {
    title: '测试曲', playing: false, busy: false, restoring: false, audioReady: true,
    duration: 60, getSeconds: () => 0, onSeek: noop, onToggle: noop, onReplay: noop, onBack: noop,
    renderScore: () => React.createElement('div', {}, '谱面占位'),
    notation: 'staff' as const, onNotation: (v: boolean) => { calls.notation = v; },
    parts: [], selectedPart: '', allowTotal: true, onPart: noop,
    source: 'synth' as const, onSource: noop,
    font: 21, onFont: noop, onResetFont: noop, gap: 0, onGap: noop,
    lineGap: 0, onLineGap: noop,
    style: 'head' as const, onStyle: (v: 'head' | 'band' | 'ball') => { calls.style = v; },
    stems: [], onStem: noop, onStemsAll: noop, onStemsNoVocal: noop,
    expanded: false, canExpand: false, onExpand: noop,
    transpose: 0, onTranspose: noop, speed: 1, onSpeed: noop,
    pitch: 'concert' as const, onPitch: (v: 'concert' | 'transposed') => { calls.pitch = v; },
  };
  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  await act(() => root.render(React.createElement(AndroidPlayer, props)));

  // 打开设置弹窗
  const settingsBtn = container.querySelector('[aria-label="播放设置"]');
  if (!settingsBtn) fail('找不到「设置」按钮');
  await act(() => click(settingsBtn!));
  if (!container.textContent?.includes('五线谱调性')) fail('五线谱模式下设置里应出现「五线谱调性」');
  ok('设置弹窗打开，五线谱调性选择器按需出现');

  // 打开「记谱方式」下拉 → 选「简谱」→ 面板应自动关闭且回调收到 false
  const selects = Array.from(container.querySelectorAll('.an-select'));
  const notationSelect = selects.find((el) => el.textContent === '五线谱');
  if (!notationSelect) fail('找不到记谱方式下拉（当前值 五线谱）');
  await act(() => click(notationSelect!));
  let sheet = container.querySelector('.an-select-sheet');
  if (!sheet) fail('点击下拉按钮后选项卡没有弹出');
  // 回归：点选项卡空白处收起后，不得被 label 转发回触发按钮而立刻弹开（真机 0.2.96 的「选完不关闭」）
  await act(() => click(sheet!));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  if (container.querySelector('.an-select-sheet')) fail('点空白收起后选项卡又弹回（label 转发触发按钮重开）');
  ok('点选项卡空白处收起，不被 label 转发弹回');
  // 重新打开，走正常选择流程
  await act(() => click(notationSelect!));
  sheet = container.querySelector('.an-select-sheet');
  if (!sheet) fail('第二次点击下拉按钮后选项卡没有弹出');
  const list = container.querySelector('.an-select-list');
  if (!list) fail('选项列表没有渲染');
  const jianpuOpt = Array.from(list!.querySelectorAll('.an-select-option')).find((el) => el.textContent?.startsWith('简谱'));
  if (!jianpuOpt) fail('选项列表里没有「简谱」');
  await act(() => click(jianpuOpt!));
  sheet = container.querySelector('.an-select-sheet');
  if (sheet) fail('选中选项后选项卡没有自动关闭（就是实测的卡住问题）');
  if (calls.notation !== false) fail(`选中简谱后 onNotation 应收到 false，实际 ${calls.notation}`);
  ok('自绘下拉：弹出 → 选简谱 → 自动关闭 → 回调 false');

  // 五线谱调性下拉：选移调谱
  const pitchSelect = Array.from(container.querySelectorAll('.an-select')).find((el) => el.textContent === '实音谱（按实际音高）');
  if (!pitchSelect) fail('找不到五线谱调性下拉');
  await act(() => click(pitchSelect!));
  const pitchList = container.querySelector('.an-select-list');
  const transposedOpt = Array.from(pitchList!.querySelectorAll('.an-select-option')).find((el) => el.textContent?.startsWith('乐器移调谱'));
  if (!transposedOpt) fail('调性下拉里没有「乐器移调谱」');
  await act(() => click(transposedOpt!));
  if (calls.pitch !== 'transposed') fail(`选移调谱后 onPitch 应收到 transposed，实际 ${calls.pitch}`);
  if (container.querySelector('.an-select-sheet')) fail('调性下拉选完没有关闭');
  ok('五线谱调性：实音 → 移调谱，回调与关闭正常');

  // 定位：选项卡应带内联坐标（贴着触发按钮，而不是固定屏幕底部）
  // 受控 props 不变，触发按钮仍显示「实音谱（按实际音高）」
  await act(() => click(Array.from(container.querySelectorAll('.an-select')).find((el) => el.textContent === '实音谱（按实际音高）')!));
  const positioned = container.querySelector('.an-select-list') as HTMLElement | null;
  if (!positioned || !positioned.style.left || !positioned.style.top) fail('选项卡没有按触发按钮位置定位');
  await act(() => click(container.querySelector('.an-select-list')!)); // 点选项之间的缝隙：应冒泡到选项卡收起
  if (container.querySelector('.an-select-sheet')) fail('点选项缝隙后选项卡没有收起');
  ok('下拉按触发按钮位置定位（不再固定屏幕底部）');

  // 练习参数与 PC 端对齐：升降调 ±5（11 档）、速度 0.60–1.40×——超出范围 WSOLA 明显失真
  const transposeSel = Array.from(container.querySelectorAll('.an-select')).find((el) => el.textContent === '原调');
  if (!transposeSel) fail('找不到升降调下拉');
  await act(() => click(transposeSel!));
  const tOpts = Array.from(container.querySelectorAll('.an-select-option'));
  if (tOpts.length !== 11) fail(`升降调应为 11 档（±5 半音），实际 ${tOpts.length} 档`);
  if (tOpts.some((el) => /[+-](6|7|8|9|1[0-2]) 半音/.test(el.textContent ?? ''))) fail('升降调出现 ±5 以外的档位');
  await act(() => click(container.querySelector('.an-select-sheet')!));
  const speedInput = container.querySelector('input[aria-label="播放速度"]') as HTMLInputElement | null;
  if (!speedInput) fail('找不到播放速度滑条');
  if (speedInput.min !== '0.6' || speedInput.max !== '1.4') fail(`播放速度范围应为 0.6–1.4，实际 ${speedInput.min}–${speedInput.max}`);
  ok('练习参数与 PC 端对齐（升降调 ±5 半音 11 档、速度 0.60–1.40×）');

  await act(() => root.unmount());
  console.log(`\n安卓 UI 测试全部通过（${pass} 项）`);
};

// react act 环境：React 18.3 起 act 从 'react' 导出；必须 await 其返回的 thenable，
// 否则 act 队列不闭合，后续事件里的 setState 会被挂起不提交（表现为「第二次点击无效」）
async function act(fn: () => void | Promise<void>): Promise<void> {
  const React = await import('react');
  const maybe = (React as unknown as { act?: (f: () => unknown) => unknown }).act;
  if (maybe) await maybe(() => fn());
  else fn();
  await new Promise((r) => setTimeout(r, 0));
}

main().catch((e) => { console.error(`XX 测试执行失败：${e instanceof Error ? e.stack : e}`); process.exit(1); });
