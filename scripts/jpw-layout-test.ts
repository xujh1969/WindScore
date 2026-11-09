import assert from 'node:assert/strict';
import { parseDsl } from '../src/v2/dsl';
import { layoutScore, noteDigitCenter } from '../src/v2/layout';
import { LIGHT_THEME, paintLayout } from '../src/v2/paint';
import { TICKS_PER_BEAT } from '../src/v2/ticks';
import { planScorePages } from '../src/v2/export/render';
import { lyricTextOffset } from '../src/v2/lyricLines';
import { SvgCanvas } from '../src/v2/export/svg';
import { balancedBreaks } from '../src/v2/spacing';
import { notationDigitInkHeight, notationLyricFontSize } from '../src/v2/notationFont';

const layout = (body: string, width = 800) => layoutScore(parseDsl('@format 3\n@beat 2/4\n@size 21\n@space 0\n' + body).score!,
  { contentWidth: width, unit: 33.6 / TICKS_PER_BEAT, showTitle: false });
const checks: [string, () => void][] = [];
checks.push(['印刷谱面使用统一黑墨', () => {
  assert.equal(LIGHT_THEME.ink, '#000000');
  assert.equal(LIGHT_THEME.curve, LIGHT_THEME.ink);
  assert.equal(LIGHT_THEME.bar, LIGHT_THEME.ink);
}]);
checks.push(['短音自然宽度较紧，拍组之间较松', () => {
  const L = layout('1/ 2/ 3/ 4/ | 5/ 6/ 7/ 1/ ||', 1000000);
  const n = L.lines[0].items.filter(i => i.kind === 'note');
  assert.ok(n[1].w > n[0].w + 1, `${n[0].w} / ${n[1].w}`);
}]);
checks.push(['歌词正文对准数字，标点挂在右侧且不压扁', () => {
  const L = layout('3 5 |\n歌词1: 你， 我');
  const calls: { t: string; x: number; y: number; max?: number; align: string }[] = [];
  const state: Record<string, any> = { font: '', textAlign: 'left', textBaseline: 'middle',
    measureText: (t: string) => ({ width: Array.from(t).length * (Number(/([\d.]+)px/.exec(state.font)?.[1]) || 21) }),
    fillText: (t: string, x: number, y: number, max?: number) => calls.push({ t, x, y, max, align: state.textAlign }),
  };
  const ctx = new Proxy(state, { get: (t, p: string) => p in t ? t[p] : () => {}, set: (t, p: string, v) => { t[p] = v; return true; } }) as CanvasRenderingContext2D;
  paintLayout(ctx, L, LIGHT_THEME, { showTitleEdit: false });
  const word = calls.find(c => c.t === '你，')!;
  assert.ok(word);
  const center = noteDigitCenter(L.lines[0].items.find(i => i.kind === 'note')!, L.glyph);
  assert.ok(Math.abs(word.x - notationLyricFontSize(L.glyph.fontSize) / 2 - center) < 1e-8);
  assert.equal(word.max, undefined);
  assert.ok(word.y - L.lines[0].y <= 38, String(word.y - L.lines[0].y));
}]);
checks.push(['局部渐变不撑大前奏及其他歌词行，分页按实际行带', () => {
  const plain = layout('1 2 | 换行\n3 4 | 换行\n5 6 |\n歌词1: _ _ 你 我 他 呀\n歌词2: _ _ 春 风 花 月', 300);
  const marked = layout('1 2 | 换行\n3 4 | 换行\ncresc[ 5 6 ]hairpin |\n歌词1: _ _ 你 我 他 呀\n歌词2: _ _ 春 风 花 月', 300);
  assert.ok(plain.lines.length >= 3);
  assert.equal(marked.lines[1].y - marked.lines[0].y, plain.lines[1].y - plain.lines[0].y);
  assert.ok(plain.lines[1].y - plain.lines[0].y < plain.lines[2].y - plain.lines[1].y);
  const pages = planScorePages(marked, { pageW: 800, pageH: 260, marginX: 20, marginTop: 10, marginBottom: 10, scale: 1 }, false);
  assert.equal(pages[0].from, 0);
  assert.equal(pages.at(-1)!.to, marked.lines.length);
}]);
let failed = 0;
checks.push(['高八度延长音记号完整落在本行带内', () => {
  const score = parseDsl('@format 3\n@beat 2/4\n1 2 | 换行 3^ 4 |').score!;
  const note = score.events.find(e => e.kind === 'note' && e.octave === 1)!;
  if (note.kind === 'note') note.fermata = true;
  const L = layoutScore(score, { contentWidth: 800, showTitle: false });
  assert.ok((L.lines[1].above ?? L.lineHeight / 2) >= 50 * L.glyph.fontSize / 21);
}]);
checks.push(['ASCII引号挂在歌词正文旁，内部英文撇号不拆开', () => {
  assert.ok(lyricTextOffset('"你', 16) < 0);
  assert.ok(lyricTextOffset('好"', 16) > 0);
  assert.equal(lyricTextOffset("don't", 16), 0);
}]);
checks.push(['SVG保留小节线虚线并嵌入离线字体定义', () => {
  const host = globalThis as unknown as { document?: unknown };
  const original = host.document;
  host.document = { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 10 }) }) }) };
  try {
    const svg = new SvgCanvas() as SvgCanvas & { setLineDash: (dash: number[]) => void };
    svg.setLineDash([4, 3]); svg.save(); svg.setLineDash([]); svg.restore();
    svg.beginPath(); svg.moveTo(0, 0); svg.lineTo(0, 20); svg.stroke();
    const text = svg.toSvg(50, 50, 'test', '@font-face{font-family:test}');
    assert.ok(text.includes('stroke-dasharray="4 3"'));
    assert.ok(text.includes('@font-face'));
  } finally { host.document = original; }
}]);
checks.push(['显式换行前的过长乐句均衡分行，不留下单小节撑满整行', () => {
  const units = Array.from({ length: 9 }, (_, i) => ({ ideal: 100, min: 100, weight: 1, forced: i === 6 }));
  const starts = balancedBreaks(units, 600);
  assert.ok(!starts.includes(6), starts.join(','));
  assert.ok(starts.includes(7));
}]);
checks.push(['按JPW实测墨高校准线条、八度点与小节线比例', () => {
  const g = layout('1 2 |').glyph;
  const h = notationDigitInkHeight(g.fontSize);
  assert.ok(Math.abs(2 * g.barHalf / h - 2.1) < .08, '小节线总高');
  assert.ok(Math.abs(2 * g.dotR / h - .21) < .025, '八度点直径');
  assert.ok(Math.abs(g.octaveBase / h - .833) < .04, '高八度点位置');
  assert.ok(Math.abs(g.beamTop / h - .74) < .03, '数字底到减时线净空');
  assert.ok(Math.abs(g.beamStep / h - .20) < .02, '减时线层距');
  assert.ok(Math.abs(g.dashW / h - .667) < .02, '增时线长度');
  assert.ok(Math.abs(g.dashLine / h - .142) < .015, '增时线粗度独立于减时线');
  const headed = layoutScore(parseDsl('@format 3\n@title 对照\n@sub 女声独唱\n@beat 2/4\n1 2 |').score!, { contentWidth: 800 });
  assert.ok(Math.abs(headed.title!.subY - headed.title!.colY - 6) < 1e-8, '副标题与调号同带');
  assert.ok(Math.abs((headed.title!.subY - headed.title!.y) / notationDigitInkHeight(headed.glyph.fontSize) - 3.714) < .01, '标题层次');
  const aligned = layout('1 2 | 换行 3 4 ||');
  const tail = aligned.lines[0].items.at(-1)!;
  assert.ok(Math.abs(tail.x + tail.w / 2 - 760) < 1e-8, '可见小节线中心对齐右边界');
}]);
checks.push(['显式纸面行可温和收紧，数字墨迹与最小留白不相撞', () => {
  const score = parseDsl('@format 3\n@size 24\n@beat 4/4\n1 2 3 4 | 1 2 3 4 | 1 2 3 4 | 1 2 3 4 | 换行 1 2 3 4 ||').score!;
  const wide = layoutScore(score, { contentWidth: 10000, justifyMax: 1, showTitle: false });
  const natural = wide.lines[0].items.reduce((sum, it) => sum + it.w, 0);
  const L = layoutScore(score, { contentWidth: 80 + natural * .97, showTitle: false });
  assert.equal(L.lines[0].items.filter(it => it.kind === 'barline').length, 4);
  const notes = L.lines[0].items.filter(it => it.kind === 'note');
  for (let i = 1; i < notes.length; i++) assert.ok(notes[i].x - notes[i - 1].x >= L.glyph.nominalWidth + 3 * L.glyph.fontSize / 21 - .01);
}]);
for (const [name, check] of checks) {
  try { check(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, String(e)); }
}
if (failed) process.exitCode = 1;
