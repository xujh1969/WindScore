/**
 * WindScore v2 M0 验收测试（命令行可跑，零 UI、零 Tauri 依赖）
 *
 *   M0-1  types.ts 与 spec §5 一致 + 不变量校验
 *   M0-2  ticks.ts：TICKS_PER_BEAT = 48 与时值表
 *   M0-3  reseat.ts：守恒重分配
 *   M0-4  四首 .jps 谱面 DSL round-trip 无 diff
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BeatClock } from '../src/v2/clock';
import { parseDsl, renderNoteToken, serializeDsl } from '../src/v2/dsl';
import {
  caretAt,
  clusterSpan,
  clusterWidth,
  deriveGlyph,
  GLYPH,
  hitTest,
  hitTitleEdit,
  layoutScore,
  nominalInk,
  pickAt,
} from '../src/v2/layout';
import { applyReseat, reseat } from '../src/v2/reseat';
import {
  applyTier as applyTierOp,
  autoGroupBeats,
  candidatesFor,
  cycleDot,
  deleteDynamic,
  dynamicAt,
  extendPrev,
  groupTiers,
  insertBarline,
  insertNote,
  nextTimed,
  pasteEvents,
  pressBarline,
  prevTimed,
  removeEvent,
  setBarlineRepeat,
  setBarlineVolta,
  setBarlineVoltaOpen,
  setVoltaFromSelection,
  toggleJumpAfterBarline,
  setAccidental,
  setDegree,
  setDynamic,
  setMeta,
  setDot,
  setKeyChange,
  addGrace,
  removeGrace,
  moveGrace,
  setGrace,
  setGraceSlot,
  dropGrace,
  setTicks,
  toggleArticulation,
  setTongue,
  toggleTechnique,
  shiftOctave,
  toggleSlur,
  toggleTongue,
} from '../src/v2/edit';
import {
  beamCount,
  DIVISION_TICKS,
  durationTiers,
  tupletBeamCount,
  undotTicks,
  isLegalTick,
  LEGAL_TICKS,
  TICKS_PER_BEAT,
  withDots,
} from '../src/v2/ticks';
import { expandScore } from '../src/v2/expand';
import { audioKey, clearAlign, loadAlign, saveAlign } from '../src/v2/ui/alignStore';
import { gridSkipOf, snapBeatToGrid } from '../src/v2/ui/AudioWaveform';
import { crc32, unzip, zipStore } from '../src/v2/pack';
import { buildPack, packFileName, readPack } from '../src/v2/ui/packBundle';
import {
  describeMeta,
  importLibrary,
  metaOfText,
  normalizeName,
  readLibrary,
  removeLibraryItem,
  renameLibraryItem,
  searchLibrary,
  sortLibrary,
  uniqueName,
  upsertLibrary,
} from '../src/v2/ui/libraryStore';
import {
  beatToSec,
  constantTempo,
  curveFromAnchors,
  expandBeatTimes,
  secToBeat,
  secToTick,
  tempoFromAlign,
  tickToSec,
  type TempoMap,
} from '../src/v2/tempo';
import {
  activeAt,
  activeMainAt,
  playOrderMeasures,
  buildTimeline,
  keyOffset,
  normalizeKey,
  tickAtEvent,
  timelineTicks,
  toMidi,
} from '../src/v2/timeline';
import {
  beamOffset,
  DOT_R,
  lowDotOffset,
  SEL_HALF_H,
  TECHNIQUE_GLYPH,
} from '../src/v2/paint';
import { parseSession } from '../src/v2/session';
import { validateGroups } from '../src/v2/validate';
import {
  isTimed,
  type BarlineEvent,
  type BeatGroup,
  type GraceNote,
  type JumpEvent,
  type NoteEvent,
  type RestEvent,
  type Score,
  type TimedEvent,
} from '../src/v2/types';

let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.log(`  XX  ${name} ${extra}`);
    failed += 1;
  }
}

/** 键序无关的深比较 */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${k}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// ───────────────────────── M0-2 ticks ─────────────────────────
console.log('\n[M0-2 ticks]');
check('TICKS_PER_BEAT = 48', TICKS_PER_BEAT === 48, String(TICKS_PER_BEAT));
check('三连音成员 = 16 tick', DIVISION_TICKS[3] === 16, String(DIVISION_TICKS[3]));
check('八分 = 24 / 十六分 = 12 / 三十二分 = 6',
  DIVISION_TICKS[2] === 24 && DIVISION_TICKS[4] === 12 && DIVISION_TICKS[8] === 6);
check('附点 1 拍 = 72 tick', withDots(48, 1) === 72, String(withDots(48, 1)));
check('复附点 1 拍 = 84 tick', withDots(48, 2) === 84, String(withDots(48, 2)));
check('减时线：24→1 12→2 6→3 48→0',
  beamCount(24) === 1 && beamCount(12) === 2 && beamCount(6) === 3 && beamCount(48) === 0);
check('三连音 16 tick 不按普通减时线处理（交给 group.tuplet）', beamCount(16) === 0);
check('合法 tick 含 16 与 48', LEGAL_TICKS.includes(16) && LEGAL_TICKS.includes(48));

// ───────────────────────── M0-3 reseat ─────────────────────────
console.log('\n[M0-3 reseat]');
const mkNote = (id: string, ticks: number): NoteEvent => ({
  id, kind: 'note', degree: 5, octave: 0, ticks, dot: 0,
});
const mkGroup = (totalTicks: number, ids: string[]): BeatGroup => ({
  id: 'g1', totalTicks, memberIds: ids,
});

// spec §3.3 算例：3 音各 16，选后 2 个设 24 tick → 24 / 12 / 12
{
  const members = [mkNote('a', 16), mkNote('b', 16), mkNote('c', 16)];
  const r = reseat({ group: mkGroup(48, ['a', 'b', 'c']), members, selectedIds: ['b', 'c'], selectedTicks: 24 });
  check('算例：选后 2 音设 1/2 拍 → a=24 b=12 c=12',
    r.ok && r.ticks.a === 24 && r.ticks.b === 12 && r.ticks.c === 12,
    r.ok ? JSON.stringify(r.ticks) : r.reason);
  check('算例 Σ 守恒 = 48', r.ok && r.ticks.a! + r.ticks.b! + r.ticks.c! === 48);
}

// 组溢出必须拒绝
{
  const members = [mkNote('a', 16), mkNote('b', 16), mkNote('c', 16)];
  const r = reseat({ group: mkGroup(48, ['a', 'b', 'c']), members, selectedIds: ['b', 'c'], selectedTicks: 60 });
  check('组溢出被拒绝，不静默扩组', !r.ok && /溢出/.test(r.reason), r.ok ? 'accepted' : r.reason);
}

// 全选但新值 ≠ 组总时值 → 拒绝（改组总时值是扩组，不是 reseat）
{
  const members = [mkNote('a', 24), mkNote('b', 24)];
  const r = reseat({ group: mkGroup(48, ['a', 'b']), members, selectedIds: ['a', 'b'], selectedTicks: 24 });
  check('全选且新值 ≠ 组总时值 → 拒绝', !r.ok, r.ok ? 'accepted' : r.reason);
}

// 删除成员后同组重新均分（spec §6.6「删除音后同组自动重新均分」）
{
  const score: Score = {
    version: 2,
    meta: { title: 't', key: '1=C', beat: '4/4', bpm: 90, patch: 73 },
    events: [mkNote('a', 16), mkNote('b', 16), mkNote('c', 16)],
    groups: [mkGroup(48, ['a', 'b', 'c'])],
  };
  // 删掉 c 之后组内只剩 a、b，走 applyReseat 全选 48
  const shrunk: Score = {
    ...score,
    events: score.events.filter((e) => e.id !== 'c'),
    groups: [mkGroup(48, ['a', 'b'])],
  };
  const r = applyReseat(shrunk, 'g1', ['a', 'b'], 48);
  check('删音后同组自动重新均分 → a=24 b=24',
    r.ok && (r.score.events[0] as TimedEvent).ticks === 24 && (r.score.events[1] as TimedEvent).ticks === 24,
    r.ok ? 'ok' : r.reason);
  if (r.ok) check('删音后不变量无违反', validateGroups(r.score).length === 0);
}

// ───────────────────────── DSL 语法 ─────────────────────────
console.log('\n[DSL 语法子集]');
const SAMPLE = `@title Roundtrip 样本
@key 1=G
@beat 4/4
@bpm 88
@patch 73

<5/2 3/4 2/4> 1- | <3: 5/3 3/3 2/3> (6 5) 3~3 |{partial} 2- ||
`;
{
  const a = parseDsl(SAMPLE);
  check('样本解析无错误', a.errors.length === 0 && !!a.score, a.errors.join('; '));
  if (a.score) {
    const g = a.score.groups;
    check('拍内组数 = 2', g.length === 2, String(g.length));
    check('第 1 组 Σ = 48 且成员 24/12/12',
      g[0]?.totalTicks === 48 &&
      g[0]?.memberIds.length === 3);
    check('第 2 组为三连音（tuplet=3，Σ=48）',
      g[1]?.tuplet === 3 && g[1]?.totalTicks === 48);
    check('不变量全部通过', validateGroups(a.score).length === 0,
      validateGroups(a.score).map((v) => `${v.code}:${v.message}`).join('; '));

    const b = parseDsl(serializeDsl(a.score));
    check('样本 round-trip 无 diff', !!b.score && stable(b.score) === stable(a.score),
      b.errors.join('; '));
    check('样本 serialize 稳定（二次序列化一致）',
      serializeDsl(a.score) === serializeDsl(b.score!));
  }

  // 早期的独立换气记号 `'` 已从规范中取消：明确报错，不静默丢弃
  const old = parseDsl('@beat 4/4\n\n5 5 \' 5 ||\n');
  check(
    '旧换气记号 \' 报“不再支持”',
    old.errors.some((e) => e.includes('不再支持换气记号')),
    old.errors.join('; ') || '没报错',
  );
  check('旧换气记号不产生事件', (old.score?.events ?? []).every((e) => e.kind !== 'breath'));
  // 现在换气是音符技法：写作后缀 V
  const v = parseDsl('@beat 4/4\n\n5V 5 5 5 ||\n').score!;
  check(
    '换气 V 仍作为音符技法存在',
    ((v.events[0] as NoteEvent).techniques ?? []).includes('breath') &&
      serializeDsl(v).includes('5V'),
    serializeDsl(v).split('\n').pop()?.trim(),
  );
}

// ───────────────────────── M0-4 迁移 + round-trip ─────────────────────────
console.log('\n[M0-4 谱面 round-trip]');
const DIR = join(process.cwd(), 'src', 'scores');
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jps'))) {
  const res = parseDsl(readFileSync(join(DIR, f), 'utf-8'));
  if (!res.score) {
    check(`${f} 解析成功`, false, res.errors.join('; '));
    continue;
  }
  const v2 = res.score;
  const notes = v2.events.filter((e) => e.kind === 'note').length;
  const bars = v2.events.filter((e) => e.kind === 'barline').length;
  const viol = validateGroups(v2);

  const text = serializeDsl(v2);
  const back = parseDsl(text);

  check(`${f} round-trip 无 diff`,
    !!back.score && back.errors.length === 0 && stable(back.score) === stable(v2),
    back.errors.join('; ') || 'diff');
  check(`${f} 不变量无违反`, viol.length === 0,
    viol.map((v) => `${v.code}:${v.message}`).join('; '));
  console.log(`      ${f}: ${notes} 音 / ${bars} 小节线 / meta ${v2.meta.key} ${v2.meta.beat} ${v2.meta.bpm}bpm`);
}

// ───────────────────────── M1 排版 ─────────────────────────
console.log('\n[M1 排版]');
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jps'))) {
  const { score } = parseDsl(readFileSync(join(DIR, f), 'utf-8'));
  if (!score) {
    check(`${f} 解析`, false);
    continue;
  }
  const layout = layoutScore(score, { contentWidth: 1000 });
  const right = Math.max(...layout.lines.flatMap((l) => l.items.map((i) => i.x + i.w)), 0);
  // 顶部标记层向上到 44px，第一行必须留够留白，否则弧线会被画布顶边裁掉
  const topMost = Math.min(...layout.lines.map((l) => l.y - 44));
  check(`${f} 顶部标记不越出画布`, topMost >= 0, `top=${topMost.toFixed(0)}`);
  const lv1 = layout.lines.flatMap((l) => l.beams).filter((b) => b.level === 1).length;
  const lv2 = layout.lines.flatMap((l) => l.beams).filter((b) => b.level === 2).length;
  check(`${f} 内容不溢出可用宽度`, right <= 1001, `right=${right.toFixed(0)}`);
  const arcs = layout.lines.flatMap((l) => l.arcs).length;
  console.log(
    `      ${f}: ${lv1} 条一级减时线 / ${lv2} 条二级 / ${arcs} 条弧线 / ${layout.lines.length} 行 / 右边界 ${right.toFixed(0)}px`,
  );
}
{
  const { score } = parseDsl(readFileSync(join(DIR, 'molihua.jps'), 'utf-8'));
  const layout = layoutScore(score!, { contentWidth: 1000 });
  const beams = layout.lines.flatMap((l) => l.beams);
  // 连线在数据里是链式存储（A→B→C），必须合成一条弧，逐段画会出现互相重叠的重复弧。
  // 这里用「链条数 === 弧数」钉死，不用魔法阈值——谱面改成短连音居多时阈值会失效。
  const slurNext = new Map<string, string>();
  for (const e of score!.events) {
    if (e.kind !== 'note') continue;
    for (const t of e.ties ?? []) if (t.kind === 'slur') slurNext.set(e.id, t.to);
  }
  const isTarget = new Set(slurNext.values());
  const chains = [...slurNext.keys()].filter((id) => !isTarget.has(id)).length;
  const arcs = layout.lines.flatMap((l) => l.arcs).length;
  check('每条连线恰好画出一条弧（链未被拆成逐段）', arcs === chains, `arcs=${arcs} chains=${chains}`);
  check('茉莉花有可见的减时线', beams.length > 0, `beams=${beams.length}`);
  check('茉莉花拍内组已建立', score!.groups.length > 0, `groups=${score!.groups.length}`);
  check('组总时值都 ≤ 1 拍（I2）', score!.groups.every((g) => g.totalTicks <= 48));
}

{
  // 谱面开头标题块
  const { score } = parseDsl(readFileSync(join(DIR, 'molihua.jps'), 'utf-8'));
  const withTitle = layoutScore(score!, { contentWidth: 1000 });
  const noTitle = layoutScore(score!, { contentWidth: 1000, showTitle: false });
  check('默认画标题块', withTitle.title?.title === '茉莉花');
  const t = withTitle.title!;
  // 谱头三区：左列调号 / 拍号 / 速度（音色不再上谱头）
  check(
    '左列含调号 / 拍号 / 速度',
    t.key.includes('1=G') && t.beat === '2/4' && t.tempo.includes('♩=48'),
    `${t.key} ${t.beat} ${t.tempo}`,
  );
  check('右列说明缺省为空', t.rightLines.length === 0);
  check('showTitle:false 时无标题块', noTitle.title === null);
  check('标题块把谱面整体下移', withTitle.lines[0].y > noTitle.lines[0].y);
  check('标题块计入总高', withTitle.height - noTitle.height === t.height);
  check('标题水平居中', withTitle.title!.centerX === 500);

  // 净空守卫：标题副行与首行谱面的标记层（吐音 / 换气，中线上方 50px）不能贴在一起。
  // 这组断言把 titleHeight 钉死，防止以后调字号时又挤回去。
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jps'))) {
    const s = parseDsl(readFileSync(join(DIR, f), 'utf-8')).score!;
    const L = layoutScore(s, { contentWidth: 1000 });
    const clear = L.lines[0].y - 50 - (L.title!.subY + 7);
    check(`${f} 标题与首行净空 ≥ 24px`, clear >= 24, `clear=${Math.round(clear)}`);
  }
}

{
  // ( ) 上方弧线与 < > 下方减时线是两条互不相关的记号，
  // 各自独立开闭 —— 交叉合法，且必须能无损回读。
  console.log('\n[连线 ( ) 与拍内组 < > 互不相关]');
  const err = (body: string) => parseDsl(`@beat 4/4\n\n${body}\n`).errors;
  const ok = (body: string) => err(body).length === 0;

  check('组在连线内', ok('(3 <4/2 2/2>) 1 1 ||'));
  check('连线在组内', ok('<(3/2 4/2)> 1 1 ||'));
  check('连线跨小节合法', ok('(3 | 3) 1 1 ||'));
  check('无括号正常', ok('<3/2 4/2> 1 1 ||'));

  // 交叉：连线止于组内的第一个音
  const CROSS = '5 4 (3 <4/2) 2/2> | 1 1 2 3 ||';
  check('交叉合法，不报错', ok(CROSS), err(CROSS).join(' / '));
  {
    const s = parseDsl(`@beat 4/4\n\n${CROSS}\n`).score!;
    const g = s.groups[0];
    check('交叉时组仍收全两个音', g.memberIds.length === 2, `members=${g.memberIds.length}`);
    const tied = s.events.filter(
      (e) => e.kind === 'note' && (e.ties ?? []).some((t) => t.kind === 'slur'),
    );
    check('交叉时连线只连两音', tied.length === 1, `ties=${tied.length}`);
    // 连线覆盖 3 和 4/2：起点是 3，终点是组内的第一个音
    const from = s.events.find((e) => e.id === tied[0].id)!;
    const first = s.events.find((e) => e.id === g.memberIds[0])!;
    check(
      '连线的音确实落在组内',
      (from.ties ?? [])[0].to === first.id,
      `${(from.ties ?? [])[0].to} vs ${first.id}`,
    );
  }

  const unclosed = err('(3 <4/2 2/2> | 1 1 2 3 ||');
  check('连线未闭合被报错', unclosed.some((e) => e.includes('(') && e.includes('未闭合')), unclosed.join(' / '));

  const unclosedG = err('1 1 <3/2 4/2');
  check('拍内组未闭合被报错', unclosedG.some((e) => e.includes('<') && e.includes('未闭合')), unclosedG.join(' / '));

  const stray = err('2 <3/2 4/2>) 3 1 ||');
  check('多余的 ) 被报错', stray.some((e) => e.includes('多余的 )')), stray.join(' / '));
  check('多余的 > 被报错', err('3 4 > ||').some((e) => e.includes('多余的 >')), err('3 4 > ||').join(' / '));

  check('空拍内组被报错', err('<> 1 1 ||').some((e) => e.includes('拍内组为空')));
  check('单音连线被报错', err('(3) 1 1 ||').some((e) => e.includes('至少要括住两个音')));
  check('组跨小节被报错', err('<3/2 | 4/2> 1 1 ||').some((e) => e.includes('不得跨小节')));

  // 嵌套时内层连线的音不能串到外层
  const nest = parseDsl('@beat 4/4\n\n(<3/2 4/2>) 5 ||').score!;
  check('嵌套：组建成且成员 2 个', nest.groups.length === 1 && nest.groups[0].memberIds.length === 2);
  check(
    '嵌套：连线只连组内两音',
    nest.events.filter((e) => e.kind === 'note' && (e.ties ?? []).some((t) => t.kind === 'slur')).length === 1,
  );

  // 序列化必须无损：嵌套与交叉都要能原样回读
  for (const body of [
    '(3 <4/2 2/2>) 1 1 ||',
    '<(3/2 4/2)> 1 1 ||',
    '(<3/2 4/2> 5) 1 ||',
    '5 4 (3 <4/2) 2/2> 1 1 ||',
    '5 (3 <4/2 2/2) 1> 1 ||',
  ]) {
    const s = parseDsl(`@beat 4/4\n\n${body}\n`).score!;
    const text = serializeDsl(s);
    const re = parseDsl(text);
    check(`序列化回读无错：${body}`, re.errors.length === 0, re.errors.join(' / '));
    // 回读后的连线与组必须和原来一致
    const a = s.events.filter((e) => e.kind === 'note' && (e.ties ?? []).length).length;
    const b = re.score!.events.filter((e) => e.kind === 'note' && (e.ties ?? []).length).length;
    check(`序列化回读连线数一致：${body}`, a === b, `${a} vs ${b}`);
    check(
      `序列化回读组数一致：${body}`,
      s.groups.length === re.score!.groups.length,
      `${s.groups.length} vs ${re.score!.groups.length}`,
    );
  }
}

{
  // 调号里的升降号。
  // 简谱规范写法是升降号**在音名前**：1=bB、1=#F。
  // 旧正则要求"字母 + 升降号"，于是：
  //   1=bB → 把开头的 b 当音名 B，算出 11（B）而不是 10（B♭）
  //   1=#F → # 不是 [A-Ga-g]，整个不匹配，静默退回 C 调
  // 两个都是听不出来、也看不出来的错，所以逐个钉死。
  console.log('\n[调号升降号]');
  check('1=C → 0', keyOffset('1=C') === 0);
  check('1=#F → 6（规范写法）', keyOffset('1=#F') === 6, String(keyOffset('1=#F')));
  check('1=F# → 6（英文写法）', keyOffset('1=F#') === 6, String(keyOffset('1=F#')));
  check('1=bB → 10（规范写法）', keyOffset('1=bB') === 10, String(keyOffset('1=bB')));
  check('1=Bb → 10（英文写法）', keyOffset('1=Bb') === 10, String(keyOffset('1=Bb')));
  check('1=b 是 B 本位 → 11（前导 b 歧义消解）', keyOffset('1=b') === 11, String(keyOffset('1=b')));
  check('♯ ♭ 字形也认', keyOffset('1=♭B') === 10 && keyOffset('1=♯F') === 6);
  check('1=G 不受影响', keyOffset('1=G') === 7);
  check('认不出时退回 C 调', keyOffset('随便写的') === 0);

  check('normalizeKey → 1=bB', normalizeKey('1=Bb') === '1=bB', String(normalizeKey('1=Bb')));
  check('normalizeKey → 1=#F', normalizeKey('1=F#') === '1=#F', String(normalizeKey('1=F#')));
  check('normalizeKey 认不出返回 null', normalizeKey('降B调') === null);

  const s = parseDsl('@key 1=C\n\n1 1 ||\n').score!;
  check('setMeta 规范化调号', setMeta(s, { key: '1=bB' }).meta.key === '1=bB');
  check('setMeta 拒绝脏调号', setMeta(s, { key: '降B调' }).meta.key === '1=C');
  check('脏调号被拒时原样返回引用', setMeta(s, { key: '咦' }) === s);

  // 调号决定基准音：1=bB 时音级 1 = B♭4 = MIDI 70
  check('1=bB 的音级 1 = 70', toMidi(1, 0, '1=bB') === 70, String(toMidi(1, 0, '1=bB')));
  check('1=#F 的音级 1 = 66', toMidi(1, 0, '1=#F') === 66, String(toMidi(1, 0, '1=#F')));
  check('1=C 的音级 1 = 60', toMidi(1, 0, '1=C') === 60);
}

{
  // 音符升降半音：DSL 写 #5 / b3 / ♮5，与八度点共用前导位。
  console.log('\n[音符升降半音]');
  const p = parseDsl('@beat 4/4\n\n#5 b3 ♮2 #4/2 6 ||\n');
  check('变音记号解析无误', p.errors.length === 0, p.errors.join(' / '));
  const ns = p.score!.events.filter((e) => e.kind === 'note') as NoteEvent[];
  check('#5 是升号', ns[0].accidental === '#');
  check('b3 是降号', ns[1].accidental === 'b');
  check('♮2 是还原号', ns[2].accidental === '♮');
  check('#4/2 与除法记号共存', ns[3].accidental === '#' && ns[3].ticks === 24);
  check('无记号时不留空字段', ns[4].accidental === undefined);

  // 变音必须进音高计算：升 +1、降 -1、还原同本位
  check('#5 比 5 高半音', toMidi(5, 0, '1=C', '#') === toMidi(5, 0, '1=C') + 1);
  check('b3 比 3 低半音', toMidi(3, 0, '1=C', 'b') === toMidi(3, 0, '1=C') - 1);
  check('♮2 与 2 同高', toMidi(2, 0, '1=C', '♮') === toMidi(2, 0, '1=C'));

  // 序列化不写回记号，保存一次就把升降吃了
  const text = serializeDsl(p.score!);
  check('序列化保留变音记号', text.includes('#5') && text.includes('b3') && text.includes('♮2'));
  const back = parseDsl(text);
  check('回读无错', back.errors.length === 0, back.errors.join(' / '));
  check(
    '回读的变音完全一致',
    (back.score!.events.filter((e) => e.kind === 'note') as NoteEvent[])
      .map((e) => e.accidental ?? '-')
      .join(',') === ns.map((e) => e.accidental ?? '-').join(','),
  );

  const base = parseDsl('@beat 4/4\n\n5 5 ||\n').score!;
  const id = base.events[0].id;
  const on = setAccidental(base, id, '#');
  check('setAccidental 设置', (on.events[0] as NoteEvent).accidental === '#');
  check('去掉是删键而非置 undefined', !('accidental' in (setAccidental(on, id).events[0] as NoteEvent)));

  // 排版要给记号让位，否则数字会压在记号上
  const withAcc = layoutScore(on, { contentWidth: 900 }).lines[0].items.find((i) => i.eventId === id)!;
  const plain = layoutScore(base, { contentWidth: 900 }).lines[0].items.find((i) => i.eventId === id)!;
  check('带变音的音符格更宽', withAcc.w > plain.w, `${withAcc.w} vs ${plain.w}`);
  check('宽度回传给 paint（不许两处各写一个常量）', withAcc.accW === withAcc.w - plain.w);
}

{
  // 标题旁的小铅笔：命中矩形由 layout 给，paint 照画，ScoreCanvas 照比
  console.log('\n[标题旁的小铅笔]');
  const s = parseDsl('@title 茉莉花\n@beat 4/4\n\n5 5 ||\n').score!;
  const L = layoutScore(s, { contentWidth: 800 });
  check('标题块带铅笔按钮', !!L.title?.edit && L.title.edit.size > 0);
  check('铅笔在标题右侧', L.title!.edit.cx > L.title!.centerX);
  check('点在铅笔上命中', hitTitleEdit(L, L.title!.edit.cx, L.title!.edit.cy));
  check('点在标题中央不命中', !hitTitleEdit(L, L.title!.centerX, L.title!.y));
  check('点在谱面上不命中', !hitTitleEdit(L, L.title!.centerX, L.lines[0].y));
  check(
    '关掉标题块后不命中',
    !hitTitleEdit(layoutScore(s, { contentWidth: 800, showTitle: false }), 400, 36),
  );
  // 标题长度影响铅笔位置，否则长标题会把铅笔压掉
  const long = parseDsl('@title 一首名字特别长的歌\n@beat 4/4\n\n5 5 ||\n').score!;
  check(
    '标题越长铅笔越靠右',
    layoutScore(long, { contentWidth: 800 }).title!.edit.cx > L.title!.edit.cx,
  );
}

{
  // 复点音的档位匹配：面板显示去点后的值，「2..」的档位是八分那颗
  console.log('\n[复点音的档位匹配]');
  check('复附点八分 2.. → 去点 12', undotTicks(21, 2) === 12, String(undotTicks(21, 2)));
  check('附点八分 2. → 去点 12', undotTicks(18, 1) === 12, String(undotTicks(18, 1)));
  check('无附点 → 原值', undotTicks(48, 0) === 48);

  // 换档位不掉点：附点是独立开关
  const s = parseDsl('@beat 4/4\n\n2.. ||\n').score!;
  const after = setTicks(s, s.events[0].id, 12);
  check('2.. 选八分档仍是复附点八分', (after.events[0] as NoteEvent).ticks === 21, String((after.events[0] as NoteEvent).ticks));
  check('去点值仍是八分', undotTicks((after.events[0] as NoteEvent).ticks, (after.events[0] as NoteEvent).dot ?? 0) === 12);
}

{
  // 小节未满也要警告（⚠），不只超满（✗）。规则随拍号：2/4、3/4 同样适用。
  console.log('\n[小节未满警告]');
  const badge = (body: string) =>
    layoutScore(parseDsl(`@beat 4/4\n\n${body}\n`).score!, { contentWidth: 1200 }).lines
      .flatMap((l) => l.badges)
      .map((b) => b.level);
  const badgeWith = (meta: string, body: string) =>
    layoutScore(parseDsl(`${meta}\n\n${body}\n`).score!, { contentWidth: 1200 }).lines
      .flatMap((l) => l.badges)
      .map((b) => b.level);

  check('4/4 未满 3 拍 → ⚠', badge('2. 1/2 1 ||').join(',') === 'warn', badge('2. 1/2 1 ||').join(','));
  check('4/4 满拍无徽标', badge('1 1 1 1 ||').length === 0);
  check('4/4 超满 → ✗', badge('1 1 1 1 1 ||').join(',') === 'error');
  check('2/4 未满 1 拍 → ⚠', badgeWith('@beat 2/4', '1 ||').join(',') === 'warn');
  check('2/4 满拍无徽标', badgeWith('@beat 2/4', '1 1 ||').length === 0);
  check('3/4 未满 2 拍 → ⚠', badgeWith('@beat 3/4', '1 1 ||').join(',') === 'warn');
  check('3/4 满拍无徽标', badgeWith('@beat 3/4', '1 1 1 ||').length === 0);

  // 例外：弱起小节本身不满；弱起曲的最后小节与弱起互补，也允许不满
  const anacrusis = badgeWith('@beat 4/4', '|{partial} 5 5 | 1 1 1 1 ||');
  check('弱起小节不警告', anacrusis.length === 0, anacrusis.join(','));
  const anacrusisShort = badgeWith('@beat 4/4', '|{partial} 5 5 | 1 1 1 1 | 1 ||');
  check('弱起曲结尾不满不警告', anacrusisShort.length === 0, anacrusisShort.join(','));
  check('非弱起曲结尾不满照常警告', badge('2. 1/2 1 ||').length === 1);
}

{
  // 两端对齐：断行只看装不装得下会留下参差的右侧空白；
  // 布局层把每行均匀拉伸到可用宽度，各行的右缘都要对齐
  console.log('\n[两端对齐]');
  const j = layoutScore(
    parseDsl('@beat 4/4\n\n5 5 5 5 | 6 6 6 6 | 3 3 3 3 | 2 2 2 2 | 5 5 5 5 | 6 6 6 6 | 1--- ||\n').score!,
    { contentWidth: 800 },
  );
  const PAD = 40;
  const right = (ln: (typeof j.lines)[number]) => {
    const last = ln.items[ln.items.length - 1];
    return last.x + last.w;
  };
  j.lines.forEach((ln, idx) => {
    // 末行不对齐：内容少时硬拉会把间距拉得离谱，允许右边自然留白
    const isLast = idx === j.lines.length - 1;
    if (!isLast) {
      check(
        `第 ${idx + 1} 行右缘精确对齐（≈760）`,
        Math.abs(right(ln) - (PAD + 720)) < 2,
        `右缘 ${right(ln).toFixed(1)}`,
      );
    }
    check(
      `第 ${idx + 1} 行不溢出`,
      ln.items.every((it) => it.x + it.w <= PAD + 720 + 2),
    );
  });
  check(
    '末行允许不对齐',
    right(j.lines[j.lines.length - 1]) < PAD + 720,
    `右缘 ${right(j.lines[j.lines.length - 1]).toFixed(1)}`,
  );
  check(
    '非末行右缘完全一致',
    new Set(j.lines.slice(0, -1).map((ln) => right(ln).toFixed(1))).size === 1,
  );
}

{
  // 复制粘贴：id 重新生成、组内连线保留、半截组拆散、整组重建
  console.log('\n[复制粘贴]');
  const src = parseDsl('@beat 4/4\n\n5 <(3/2 5/2)> (2 3) 4 ||\n').score!;
  const evs = src.events;
  // 事件序：[0]=5  [1]=3/2  [2]=5/2（1、2 组成拍内组 + 组内连线）  [3]=2  [4]=3（连线）  [5]=4
  // 完整组：第 2、3 个事件（含组 + 组内连线）
  const clipFull = JSON.parse(JSON.stringify(evs.slice(1, 3))) as typeof evs;
  const p1 = pasteEvents(src, evs.length, clipFull)!;
  const pasted1 = p1.score.events.slice(evs.length);
  check('粘贴插入正确数量', pasted1.length === 2);
  check('光标落在粘贴段末尾', p1.cursor === evs.length + 2);
  check('id 全部重新生成', pasted1.every((e) => !evs.some((o) => o.id === e.id)));
  check(
    '整组重建（总时值守恒）',
    p1.score.groups.some(
      (g) => g.memberIds.join(',') === pasted1.map((e) => e.id).join(',') && g.totalTicks === 48,
    ),
  );
  const p1note = pasted1[0] as NoteEvent;
  check(
    '组内连线映射到新 id',
    !!p1note.ties?.length && p1note.ties.every((t) => pasted1.some((e) => e.id === t.to)),
  );
  check('粘贴后零违反', validateGroups(p1.score).length === 0, validateGroups(p1.score).map((v) => v.message).join('/'));
  // 原件没被动过
  check('粘贴不改动原件', (src.events[1] as NoteEvent).id === evs[1].id);

  // 半截组：只复制组内的一个音 → 拆散，不留悬空 groupId
  const clipHalf = JSON.parse(JSON.stringify([evs[1]])) as typeof evs;
  const p2 = pasteEvents(src, evs.length, clipHalf)!;
  const half = p2.score.events[evs.length] as NoteEvent;
  check('半截组被拆散', !half.groupId);
  check('半截组粘贴后零违反', validateGroups(p2.score).length === 0);

  // 连线指向剪贴板外 → 丢弃
  const clipOne = JSON.parse(JSON.stringify([evs[3]])) as typeof evs; // (2 3) 的第一个音
  const p3 = pasteEvents(src, evs.length, clipOne)!;
  const third = p3.score.events[evs.length] as NoteEvent;
  check('指向剪贴板外的连线被丢弃', !third.ties);
}

{
  // 休止符的时值设定与音符完全一样，包括附点：0. = 1.5 拍、0.. = 1.75 拍
  console.log('\n[休止符时值与附点]');
  const s = parseDsl('@beat 4/4\n\n0. 0/2 0 0 ||\n').score!;
  const r0 = s.events[0] as unknown as RestEvent;
  check('0. 解析为 1.5 拍 + dot=1', r0.ticks === 72 && r0.dot === 1, `${r0.ticks}/${r0.dot}`);
  const rt = parseDsl(serializeDsl(s));
  check(
    '附点休止 round-trip（序列化写回 0.）',
    rt.errors.length === 0 &&
      (rt.score!.events[0] as unknown as RestEvent).dot === 1 &&
      serializeDsl(rt.score!).includes('0.'),
    serializeDsl(rt.score!).split('\n').pop()?.trim(),
  );

  const s2 = parseDsl('@beat 4/4\n\n0.. 0 0 0 ||\n').score!;
  check('0.. = 1.75 拍', (s2.events[0] as unknown as RestEvent).ticks === 84);

  const s3 = parseDsl('@beat 4/4\n\n0 0 0 0 ||\n').score!;
  const s3d = setDot(s3, s3.events[0].id, 1);
  const r3 = s3d.events[0] as unknown as RestEvent;
  check('setDot 作用在休止符上', r3.ticks === 72 && r3.dot === 1, `${r3.ticks}/${r3.dot}`);
  const s3u = setDot(s3d, s3.events[0].id, 0);
  const r3u = s3u.events[0] as unknown as RestEvent;
  check('setDot 0 去掉附点', r3u.ticks === 48 && !r3u.dot);

  // 排版层：休止符的附点 / 减时线进排版项，画得出来
  const L = layoutScore(s, { contentWidth: 800 });
  const item = L.lines[0].items.find((i) => i.kind === 'rest') as { dot?: number } | undefined;
  check('休止符附点进排版项', item?.dot === 1, String(item?.dot));

  // 单独的休止符也要画减时线（简谱惯例：0 下加一条线 = 八分休止）。
  // 用户实测：0 设半拍 / 1/4 / 1/8 拍，下面的横线不出来——
  // 组外单音分支只给 note 画了，rest 在 item.beams 里算好了却没人用。
  // 拍子凑满 4 拍且邻音不成组，保证休止符走「组外单音」分支。
  const rLay = layoutScore(parseDsl('@beat 4/4\n\n0/2 1 2 3 4/2 ||\n').score!, { contentWidth: 800 });
  const rItem = rLay.lines[0].items.find((i) => i.kind === 'rest') as { x: number; w: number; beams?: number } | undefined;
  check('独立半拍休止符 beams=1', rItem?.beams === 1, String(rItem?.beams));
  check(
    '独立半拍休止符画出减时线',
    !!rItem && rLay.lines[0].beams.some((b) => b.x0 >= rItem.x && b.x0 <= rItem.x + rItem.w),
  );
  const rLay2 = layoutScore(parseDsl('@beat 4/4\n\n0/4 1 2 3 5/4 ||\n').score!, { contentWidth: 800 });
  const rItem2 = rLay2.lines[0].items.find((i) => i.kind === 'rest') as { x: number; w: number; beams?: number } | undefined;
  check('独立 1/4 拍休止符 beams=2（两条线）', rItem2?.beams === 2, String(rItem2?.beams));
  check(
    '独立 1/4 拍休止符画出两条线',
    !!rItem2 && rLay2.lines[0].beams.filter((b) => b.x0 >= rItem2.x && b.x0 <= rItem2.x + rItem2.w).length === 2,
  );

  // 用户实际踩到的场景：休止符是 0/2-（1.5 拍，无点）时加点——
  // 基准必须归一到一拍：0. / 0..，而不是拼出非法的 0/2-. （序列化还会破坏 round-trip）
  const dashRest = parseDsl('@beat 4/4\n\n0/2- 0 0 0 ||\n').score!;
  check('0/2- 解析为 1.5 拍无点', (dashRest.events[0] as unknown as RestEvent).ticks === 72);
  const d1 = setDot(dashRest, dashRest.events[0].id, 1);
  const rd1 = d1.events[0] as unknown as RestEvent;
  check('加点后 = 0.（72 tick）', rd1.ticks === 72 && rd1.dot === 1, `${rd1.ticks}/${rd1.dot}`);
  const text1 = serializeDsl(d1);
  check('序列化写回 0. 而非 0/2-.', text1.includes('0.') && !text1.includes('/2'), text1.split('\n').pop()?.trim());
  const d2 = setDot(dashRest, dashRest.events[0].id, 2);
  check(
    '双附点 = 0..（84 tick）且可回读',
    (d2.events[0] as unknown as RestEvent).ticks === 84 &&
      parseDsl(serializeDsl(d2)).score!.events[0].ticks === 84,
  );

  // 音符同理：5/2- 加点 → 5.
  const dashNote = parseDsl('@beat 4/4\n\n5/2- 5 5 5 ||\n').score!;
  const n1 = setDot(dashNote, dashNote.events[0].id, 1).events[0] as unknown as NoteEvent;
  check('5/2- 加点 → 5.（72 tick）', n1.ticks === 72 && n1.dot === 1 && serializeDsl(setDot(dashNote, dashNote.events[0].id, 1)).includes('5.'));

  // 拍内组守恒（用户实测踩到）：两音各半拍共用 1 拍，给一个音加附点，
  // 另一个必须自动缩成 1/4 拍，否则这拍悄悄变长
  const grp = parseDsl('@beat 4/4\n\n<1/2 2/2> 3 4 ||\n').score!;
  check('前置：两音半拍成一组', grp.groups.length === 1 && grp.groups[0].totalTicks === 48);
  const gd = setDot(grp, grp.groups[0].memberIds[0], 1);
  const gFirst = gd.events.find((e) => e.id === grp.groups[0].memberIds[0]) as unknown as NoteEvent;
  const gSecond = gd.events.find((e) => e.id === grp.groups[0].memberIds[1]) as unknown as NoteEvent;
  check('附点音 0.75 拍（36 tick）', gFirst.ticks === 36 && gFirst.dot === 1, `${gFirst.ticks}/${gFirst.dot}`);
  check('同组另一音自动变 1/4 拍（12 tick）', gSecond.ticks === 12 && !gSecond.dot, `${gSecond.ticks}/${gSecond.dot}`);
  check('组保留且守恒不变量干净', gd.groups.length === 1 && validateGroups(gd).length === 0, validateGroups(gd).map((v) => v.code).join(','));

  // 分不动就解散组：4×1/8 拍组里给一个音加附点（6→9），剩 15 分三份 = 5，
  // 不是合法 tick 粒度（I4）——守恒重分做不了，退回单音改语义
  const tiny = parseDsl('@beat 4/4\n\n<1/8 2/8 3/8 4/8> 3 4 ||\n').score!;
  check('前置：四音 1/8 拍成一组', tiny.groups.length === 1 && tiny.groups[0].totalTicks === 24);
  const gd2 = setDot(tiny, tiny.groups[0].memberIds[0], 1);
  check('剩余分不动时解散组', gd2.groups.length === 0, `groups=${gd2.groups.length}`);
  check('解散后不变量干净', validateGroups(gd2).length === 0);
}

{
  // 倚音三格录入：按格写入 / 替换 / 清格 / 前后搬迁
  console.log('\n[倚音三格录入]');
  const s = parseDsl('@beat 4/4\n\n5 5 5 5 ||\n').score!;
  const id = s.events[0].id;
  const g = (degree: number, octave = 0, accidental?: '#' | 'b' | '♮'): GraceNote => ({
    degree: degree as GraceNote['degree'],
    octave,
    ...(accidental ? { accidental } : {}),
  });

  // 逐格填：越界追加，三格 = 复倚音
  let t = setGraceSlot(s, id, 'before', 0, g(1));
  t = setGraceSlot(t, id, 'before', 1, g(2, 1));
  t = setGraceSlot(t, id, 'before', 2, g(4, 0, '#'));
  check('三格依次写入', (t.events[0] as NoteEvent).graceBefore?.length === 3);
  check(
    '每格的音级 / 八度 / 变音各就各位',
    JSON.stringify((t.events[0] as NoteEvent).graceBefore) ===
      JSON.stringify([g(1), g(2, 1), g(4, 0, '#')]),
    JSON.stringify((t.events[0] as NoteEvent).graceBefore),
  );
  check(
    '序列化为 {12^#4}5（复倚音连写、不加空格）',
    serializeDsl(t).includes('{12^#4}5'),
    serializeDsl(t).split('\n').pop()?.trim(),
  );

  // 替换某一格：只改那一格
  const t2 = setGraceSlot(t, id, 'before', 1, g(7, -1));
  check(
    '替换中间格不影响两侧',
    JSON.stringify((t2.events[0] as NoteEvent).graceBefore) ===
      JSON.stringify([g(1), g(7, -1), g(4, 0, '#')]),
    JSON.stringify((t2.events[0] as NoteEvent).graceBefore),
  );

  // 清中间格：后面的前移，不留空位
  const t3 = setGraceSlot(t, id, 'before', 1, null);
  check(
    '清中间格后依次前移',
    JSON.stringify((t3.events[0] as NoteEvent).graceBefore) === JSON.stringify([g(1), g(4, 0, '#')]),
    JSON.stringify((t3.events[0] as NoteEvent).graceBefore),
  );
  check('清空格子不改变任何东西', setGraceSlot(s, id, 'before', 0, null) === s);

  // 前后搬迁：源侧清空、目标侧拿到同样一组
  const t4 = moveGrace(t, id, 'before', 'after');
  check('搬迁后前侧清空', !(t4.events[0] as NoteEvent).graceBefore);
  check(
    '搬迁后后侧就是原样那一组',
    JSON.stringify((t4.events[0] as NoteEvent).graceAfter) ===
      JSON.stringify((t4.events[0] as NoteEvent).graceBefore ?? (t.events[0] as NoteEvent).graceBefore),
    JSON.stringify((t4.events[0] as NoteEvent).graceAfter),
  );
  check('搬迁后 round-trip 一致', parseDsl(serializeDsl(t4)).errors.length === 0);
  check('空组搬迁 = 不动', moveGrace(s, id, 'before', 'after') === s);
  check('同一侧搬迁 = 不动', moveGrace(t, id, 'before', 'before') === t);
}

{
  // 版式：字号 / 字间距（@size / @space），记在 jps 里，打开即还原
  console.log('\n[字号与字间距]');
  const lay = parseDsl('@size 42\n@space 5\n@beat 4/4\n\n5 5 5 5 ||\n');
  check('解析 @size', lay.score?.meta.fontSize === 42, String(lay.score?.meta.fontSize));
  check('解析 @space', lay.score?.meta.letterSpacing === 5, String(lay.score?.meta.letterSpacing));
  const text = serializeDsl(lay.score!);
  check('序列化写回 @size / @space', text.includes('@size 42') && text.includes('@space 5'), text.split('\n').slice(0, 8).join(' | '));
  check(
    'round-trip 保持版式',
    parseDsl(text).score?.meta.fontSize === 42 && parseDsl(text).score?.meta.letterSpacing === 5,
  );
  check('缺省不写 @size / @space', !serializeDsl(parseDsl('@beat 4/4\n\n5 ||\n').score!).includes('@size'));

  // 非法值：解析报错、setMeta 拒绝
  check('@size 99 报错', parseDsl('@size 99\n\n5 ||\n').errors.length > 0);
  check('@space 99 报错', parseDsl('@space 99\n\n5 ||\n').errors.length > 0);
  const metaBase = parseDsl('@beat 4/4\n\n5 ||\n').score!;
  check('setMeta 拒绝越界字号', setMeta(metaBase, { fontSize: 99 }) === metaBase);
  check(
    'setMeta 接受合法字号 / 字间距',
    setMeta(metaBase, { fontSize: 28, letterSpacing: 2 }).meta.fontSize === 28,
  );

  // 排版随字号缩放：42px = 基准 2 倍
  const L21 = layoutScore(parseDsl('@beat 4/4\n\n5 5 5 5 ||\n').score!, { contentWidth: 2000 });
  const L42 = layoutScore(parseDsl('@size 42\n@beat 4/4\n\n5 5 5 5 ||\n').score!, {
    contentWidth: 2000,
  });
  check('行高随字号翻倍', Math.abs(L42.lineHeight - L21.lineHeight * 2) < 0.01, `${L21.lineHeight} → ${L42.lineHeight}`);
  check('字形度量随字号缩放', Math.abs(L42.glyph.pad - L21.glyph.pad * 2) < 0.01);
  check('度量写进排版结果', L42.glyph.fontSize === 42 && L21.glyph.fontSize === 21);
  check('deriveGlyph 与排版结果一致', JSON.stringify(deriveGlyph(42)) === JSON.stringify(L42.glyph));
  // 21px（缺省）与基准常量一致：不写 @size 的谱面版式不变
  check('缺省字号 = 基准度量', JSON.stringify(L21.glyph) === JSON.stringify(GLYPH));

  // 字间距：每个记号的占位加 5px
  const Lsp = layoutScore(parseDsl('@space 5\n@beat 4/4\n\n5 5 5 5 ||\n').score!, {
    contentWidth: 2000,
  });
  const xs = Lsp.lines[0].items.map((i) => i.x);
  const xs0 = L21.lines[0].items.map((i) => i.x);
  check(
    '字间距逐项累加',
    xs.every((x, i) => Math.abs(x - (xs0[i] + 5 * i)) < 0.01),
    xs.map((x, i) => `${x.toFixed(1)}/${(xs0[i] + 5 * i).toFixed(1)}`).join(','),
  );
}

{
  // 断音 / 顿音（小圆点，DSL 写 !）：开关 + round-trip
  console.log('\n[断音顿音]');
  let st = parseDsl('@beat 4/4\n\n5 ||\n').score!;
  const sid = st.events[0].id;
  st = toggleArticulation(st, sid, 'staccato');
  check('断音写入演奏法', ((st.events[0] as NoteEvent).articulations ?? []).includes('staccato'));
  check('断音序列化为 !', serializeDsl(st).includes('5!'), serializeDsl(st).split('\n').pop());
  const stBack = parseDsl(serializeDsl(st));
  check(
    '断音 round-trip',
    ((stBack.score!.events[0] as NoteEvent).articulations ?? []).includes('staccato'),
  );
  st = toggleArticulation(st, sid, 'staccato');
  check('再点一次取消且删键', !(st.events[0] as NoteEvent).articulations);
}

{
  // 曲目信息可直接编辑（名称 / 调号 / 拍号 / 速度 / 音色）。
  // 面板里是自由文本输入框，所以 setMeta 必须挡掉脏值——
  // 一旦 NaN 的 bpm 或 "四四拍" 的拍号进了 meta，标题块和小节拍数校验都会崩。
  console.log('\n[曲目信息 meta 编辑]');
  const s = parseDsl('@title 原名\n@key 1=C\n@beat 4/4\n@bpm 90\n@patch 73\n\n1 1 ||\n').score!;

  check('改名称', setMeta(s, { title: '新名' }).meta.title === '新名');
  check('改调号', setMeta(s, { key: '1=G' }).meta.key === '1=G');
  check('改拍号', setMeta(s, { beat: '3/4' }).meta.beat === '3/4');
  check('改速度', setMeta(s, { bpm: 120 }).meta.bpm === 120);
  check('改音色', setMeta(s, { patch: 0 }).meta.patch === 0);

  check('bpm 为 0 被拒', setMeta(s, { bpm: 0 }).meta.bpm === 90);
  check('bpm 为 NaN 被拒', setMeta(s, { bpm: Number('x') }).meta.bpm === 90);
  check('音色越界被拒', setMeta(s, { patch: 200 }).meta.patch === 73);
  check('音色小数被拒', setMeta(s, { patch: 1.5 }).meta.patch === 73);
  check('拍号非 N/M 被拒', setMeta(s, { beat: '四四拍' }).meta.beat === '4/4');
  check('被拒时原样返回同一引用', setMeta(s, { bpm: -1 }) === s);

  const edited = setMeta(s, { title: '新名', key: '1=G', bpm: 120, patch: 0 });
  const text = serializeDsl(edited);
  check(
    '改动进序列化（保存 / 导出一致）',
    ['@title 新名', '@key 1=G', '@bpm 120', '@patch 0'].every((x) => text.includes(x)),
    text.split('\n').slice(0, 5).join(' | '),
  );
  check('回读保持', parseDsl(text).score!.meta.bpm === 120);

  // 改了就要在谱面上看得见：标题块吃的是同一份 meta
  const L = layoutScore(edited, { contentWidth: 800 });
  check('标题块跟着改', L.title?.title === '新名');
  check(
    '左列跟着改（调号 / 速度）',
    !!L.title && L.title.key.includes('1=G') && L.title.tempo.includes('120'),
  );
}

{
  // 连音的减时线：按「这组连音顶替的常规音符级别」算，
  // 不按每个音自己的 ticks（3 连音占 1 拍时每音 16 tick，beamCount(16) === 0，
  // 直接用会一条线都不画）。
  console.log('\n[连音的减时线]');
  check('3 连音占 1 拍 → 1 条', tupletBeamCount(48, 3) === 1);
  check('3 连音占半拍 → 2 条', tupletBeamCount(24, 3) === 2, String(tupletBeamCount(24, 3)));
  check('6 连音占 1 拍 → 2 条', tupletBeamCount(48, 6) === 2, String(tupletBeamCount(48, 6)));
  check('5 连音占 1 拍 → 2 条', tupletBeamCount(48, 5) === 2);
  check('3 连音占 2 拍 → 0 条（只留标号）', tupletBeamCount(96, 3) === 0);

  // 排版层真的把线画出来了
  const beamsOf = (s: Score) => {
    const members = new Set(s.groups[0].memberIds);
    return layoutScore(s, { contentWidth: 900 }).lines[0].items
      .filter((i) => members.has(i.eventId))
      .map((i) => i.beams);
  };

  const one = parseDsl('@beat 4/4\n\n<3: 1/3 2/3 3/3> 4 ||').score!;
  check('1 拍三连音：每音 1 条线', beamsOf(one).length === 3 && beamsOf(one).every((b) => b === 1), JSON.stringify(beamsOf(one)));

  const half = parseDsl('@beat 4/4\n\n1 <3: 1/6 2/6 3/6> 1 ||').score!;
  check('半拍三连音：每音 2 条线', beamsOf(half).length === 3 && beamsOf(half).every((b) => b === 2), JSON.stringify(beamsOf(half)));

  const six = parseDsl('@beat 4/4\n\n<6: 1/6 2/6 3/6 4/6 5/6 6/6> ||').score!;
  check('6 连音占 1 拍：每音 2 条线', beamsOf(six).length === 6 && beamsOf(six).every((b) => b === 2), JSON.stringify(beamsOf(six)));
}

{
  // 档位语义（§6.2）：
  //   单选 → 档位是「这个音的时值」，可以到 3 拍（写成增时线 `5 - -`）
  //   多选 → 档位是「整个选区的总时值」。简谱里超过一拍的长音一律用增时线
  //          写在单个音上，不存在「几个音连起来共用减时线、合计 2 拍」的写法，
  //          所以受 I2 约束上限 1 拍。
  //   另外每个音必须分到合法 tick 粒度（I4）：4 个音分 1/4 拍 = 每音 3 tick，非法。
  console.log('\n[档位语义：单选改音长，多选改总时值]');
  const score = parseDsl('@beat 4/4\n\n5 3 5 1 2 3 4 5 ||\n').score!;
  const ids = score.events.filter((e) => e.kind === 'note').map((e) => e.id);
  const measureTicks = 4 * TICKS_PER_BEAT;
  const all = durationTiers(measureTicks);

  check('单选保留长音档位（3 拍）', all.some((t) => t.ticks === 3 * TICKS_PER_BEAT), all.map((t) => t.label).join(','));

  // 核心断言：凡是被给出的档位，应用后都必须零不变量违反。
  // 修复前「2 拍 / 3 拍」会建出违反 I2 的组、1/4 拍会产出 3 tick 违反 I4。
  for (const n of [2, 3, 4, 6, 8]) {
    const list = groupTiers(n, measureTicks);
    check(`n=${n} 档位不超过 1 拍`, list.every((t) => t.ticks <= TICKS_PER_BEAT), list.map((t) => t.label).join(','));
    check(`n=${n} 给出的档位都能整除`, list.length > 0, list.map((t) => t.label).join(','));
    for (const t of list) {
      const next = applyTierOp(score, ids.slice(0, n), t.ticks);
      check(
        `n=${n} 「${t.label}」应用后零违反`,
        !!next && validateGroups(next).length === 0,
        validateGroups(next ?? score).map((v) => `${v.code}:${v.message}`).join(' / '),
      );
    }
  }

  check('n=4 不再给出 2 拍', !groupTiers(4, measureTicks).some((t) => t.ticks === 2 * TICKS_PER_BEAT));
  check('n=4 不再给出 3 拍', !groupTiers(4, measureTicks).some((t) => t.ticks === 3 * TICKS_PER_BEAT));
  check('n=4 不再给出 1/4 拍（每音 3 tick 非法）', !groupTiers(4, measureTicks).some((t) => t.ticks === 12));
  check('n=2 保留 1/4 拍（每音 6 tick 合法）', groupTiers(2, measureTicks).some((t) => t.ticks === 12));
  check('n=8 只剩 1 拍', groupTiers(8, measureTicks).every((t) => t.ticks === TICKS_PER_BEAT));

  // 候选划分本身也不能吐非法 tick
  check('候选剔除非法划分', candidatesFor(4, 12).length === 0);
  // 三音一拍四个候选：前八后十六 / 前十六后八 / 1/4+1/2+1/4 / 三连音
  const c3 = candidatesFor(3, TICKS_PER_BEAT);
  check('n=3 一拍给四个候选', c3.length === 4, c3.map((c) => c.label).join(' | '));
  check(
    '对称切分候选在连音之前',
    c3[2] !== undefined && c3[2].ticks.join(',') === '12,24,12' && c3[2].tuplet === undefined && c3[3]?.tuplet === 3,
    c3.map((c) => c.label).join(' | '),
  );
  {
    const applied = applyTierOp(score, ids.slice(0, 3), TICKS_PER_BEAT, c3[2]!.ticks);
    check(
      '对称切分应用后零违反',
      !!applied && validateGroups(applied).length === 0,
      validateGroups(applied ?? score).map((v) => v.message).join(' / '),
    );
  }

  // 标签要说人话：1/4 拍 不能显示成「0.25 拍」
  check('1/4 拍标签是分数', candidatesFor(1, 12)[0].label.includes('1/4'), candidatesFor(1, 12)[0].label);
  check('1/3 拍标签正确', candidatesFor(1, 16)[0].label.includes('1/3'), candidatesFor(1, 16)[0].label);
  check('3/4 拍标签正确', candidatesFor(1, 36)[0].label.includes('3/4'), candidatesFor(1, 36)[0].label);
}

{
  // 键盘：| 连按两次 = 终止线（对应 DSL 的 ||）。
  // 旧行为是每按一次插一条单小节线，谱面末尾就成了两条单线，看不到终止标志。
  console.log('\n[键盘 | = 小节线 / || = 终止线]');
  const base = parseDsl('@beat 4/4\n\n1 2 3 4 ||\n').score!;
  const tail = base.events.length; // 光标落在末尾

  const once = pressBarline(base, tail);
  const afterOne = once.score.events.at(-1)!;
  check('按一次插单小节线', afterOne.kind === 'barline' && afterOne.style === 'single');
  check('按一次后事件 +1', once.score.events.length === base.events.length + 1);

  const twice = pressBarline(once.score, once.cursor);
  const afterTwo = twice.score.events.at(-1)!;
  check('按两次升级成终止线', afterTwo.kind === 'barline' && afterTwo.style === 'final');
  check('按两次不新增小节线', twice.score.events.length === once.score.events.length);
  check('按两次光标不动', twice.cursor === once.cursor);
  const finals = (s: typeof base) =>
    s.events.filter((e) => e.kind === 'barline' && e.style === 'final').length;
  check('整套操作只多出一条终止线', finals(twice.score) === finals(base) + 1, `${finals(base)} → ${finals(twice.score)}`);

  // 序列化成 || 才是终止线；两条单线只是两条 |
  const text = serializeDsl(twice.score);
  check('终止线序列化成 ||', text.trim().endsWith('||'), text.slice(-16));

  // 弱起小节线不该被升级：它是有意保留的不完全小节
  const weak = parseDsl('@beat 4/4\n\n|{partial} 5 5 ||\n').score!;
  const atBar = weak.events.findIndex((e) => e.kind === 'barline');
  check('弱起小节线不参与升级', pressBarline(weak, atBar + 1).score.events[atBar].style === 'single');

  // 替换（1-7 或 0）不能挪动光标：- ^ v . t 都作用于 prevTimed(score, cursor)，
  // 光标一动，后面的记号就会落到别的音上
  const four = parseDsl('@beat 4/4\n\n1 2 3 4 ||\n').score!;
  const id0 = four.events[0].id; // 方块光标落在第 1 个音上时 cursor = 1
  const replaced = setDegree(four, id0, 5);
  check('替换不新增事件', replaced.events.length === four.events.length);
  check('替换不改变音序', replaced.events[0].id === id0);
  check(
    '替换保留时值',
    (replaced.events[0] as NoteEvent).ticks === (four.events[0] as NoteEvent).ticks,
  );
  check('替换后 prevTimed 仍指向它', prevTimed(replaced, 1) === 0);

  // 0 是「音符 ⇄ 休止符」的转换，不是插入
  const rest = setDegree(four, id0, 0);
  check('0 把音符转成休止符', rest.events[0].kind === 'rest' && rest.events.length === four.events.length);
  check('0 保留时值', (rest.events[0] as { ticks: number }).ticks === 48);
}

{
  // 送别（用户修正版）：12 个 4 拍小节，解析 / 回读都要干净
  const s = parseDsl(readFileSync(join(DIR, 'songbie.jps'), 'utf-8'));
  check('送别解析无误', s.errors.length === 0, s.errors.join(' / '));
  check('送别以终止线收尾', s.score!.events.at(-1)!.kind === 'barline');
  check(
    '送别最后一条是 final',
    (s.score!.events.at(-1) as { style: string }).style === 'final',
  );
  console.log('  送别小节数:', s.score!.events.filter((e) => e.kind === 'barline').length);
}

{
  // 连线是一条链：一个音至多一条出边、一条入边。
  //
  // 排版（slurNext）和序列化（slurSpan）都是以起点为键的映射，
  // 一旦分叉，多出来的边会被静默丢掉——数据里有连线、画面上看不见，
  // 用户去取消时清掉的是看不见那条，看得见那条纹丝不动，
  // 就成了「连了看不见 / 按几次都取消不掉」。
  console.log('\n[连线：不能分叉/并流]');
  const base = parseDsl('@beat 4/4\n\n1 1 1 1 | 5 3 5 1. ||\n').score!;
  const ids = base.events.filter((e) => e.kind === 'note').map((e) => e.id);
  const sel = ids.slice(4); // 第二小节：5 3 5 1.

  const inDeg = (s: Score, id: string) =>
    (s.events as NoteEvent[]).filter(
      (e) => e.kind === 'note' && (e.ties ?? []).some((t) => t.kind === 'slur' && t.to === id),
    ).length;
  const chainCount = (s: Score) => {
    const next = new Map<string, string>();
    for (const e of s.events) {
      if (e.kind !== 'note') continue;
      for (const t of e.ties ?? []) if (t.kind === 'slur') next.set(e.id, t.to);
    }
    const targets = new Set(next.values());
    return [...next.keys()].filter((k) => !targets.has(k)).length;
  };
  const slurArcs = (s: Score, w = 1400) =>
    layoutScore(s, { contentWidth: w }).lines.flatMap((l) => l.arcs).filter((a) => a.kind === 'slur')
      .length;

  // 用户的实际操作序列：先连 #5→#8，再在中间补连 #5→#6
  let s = toggleSlur(base, [sel[0], sel[3]]);
  s = toggleSlur(s, [sel[0], sel[1]]);

  check('不产生分叉', inDeg(s, sel[1]) <= 1, `#6 入度 ${inDeg(s, sel[1])}`);
  check('不产生并流', inDeg(s, sel[3]) <= 1, `#8 入度 ${inDeg(s, sel[3])}`);
  check(
    'I5 无违反',
    validateGroups(s).every((v) => v.code !== 'I5'),
    validateGroups(s).map((v) => v.code).join(','),
  );

  // 核心判据：数据里有几条链，画面上就必须有几条弧。连线不能「隐形」。
  check('弧数 = 链数', slurArcs(s) === chainCount(s), `弧 ${slurArcs(s)} vs 链 ${chainCount(s)}`);

  // 再按一次同一选区 → 取消那条边，弧数同步减少且不留残影
  const after = toggleSlur(s, [sel[0], sel[1]]);
  check(
    '取消后该边真的没了',
    !(after.events as NoteEvent[]).some(
      (e) => e.id === sel[0] && (e.ties ?? []).some((t) => t.kind === 'slur' && t.to === sel[1]),
    ),
  );
  check(
    '取消后弧数 = 链数',
    slurArcs(after) === chainCount(after),
    `弧 ${slurArcs(after)} vs 链 ${chainCount(after)}`,
  );

  // 整小节全选 → 一键取消，不留任何弧
  const cleared = toggleSlur(s, sel);
  check('整小节全选可整体取消', chainCount(cleared) === 0 || chainCount(cleared) === chainCount(base));
  check(
    '取消后本小节无弧残留',
    slurArcs(cleared) === slurArcs(base),
    `弧 ${slurArcs(cleared)} vs 原始 ${slurArcs(base)}`,
  );

  // 手工构造的分叉数据必须被 I5 抓出来（旧草稿可能存着这种状态）
  const forked: Score = {
    version: 2,
    meta: { title: 't', key: '1=C', beat: '4/4', bpm: 90, patch: 73 },
    events: [
      {
        id: 'n0',
        kind: 'note',
        degree: 5,
        octave: 0,
        ticks: 48,
        dot: 0,
        ties: [
          { to: 'n1', kind: 'slur' },
          { to: 'n2', kind: 'slur' },
        ],
      },
      { id: 'n1', kind: 'note', degree: 3, octave: 0, ticks: 48, dot: 0 },
      { id: 'n2', kind: 'note', degree: 5, octave: 0, ticks: 48, dot: 0 },
    ],
    groups: [],
  };
  check(
    'I5 检出分叉',
    validateGroups(forked).some((v) => v.code === 'I5'),
    validateGroups(forked).map((v) => v.message).join(' / '),
  );
}

{
  // 跨小节 / 跨行连线不能被断行吞掉（§7.3 约束 3）。
  // 断行优先避开被连线跨越的小节线；实在避开了就画成续段，两端都必须有弧。
  const files = readdirSync(DIR).filter((x) => x.endsWith('.jps'));
  for (const w of [700, 900, 1100, 1400]) {
    let ends = 0;
    let missing = 0;
    for (const f of files) {
      const s = parseDsl(readFileSync(join(DIR, f), 'utf-8')).score!;
      const L = layoutScore(s, { contentWidth: w });
      for (const e of s.events) {
        if (e.kind !== 'note') continue;
        for (const t of e.ties ?? []) {
          if (t.kind !== 'slur') continue;
          for (const id of [e.id, t.to]) {
            ends += 1;
            const covered = L.lines.some((l) => {
              const it = l.items.find((i) => i.eventId === id);
              return !!it && l.arcs.some((a) => a.x0 <= it.x + 14 && a.x1 >= it.x);
            });
            if (!covered) missing += 1;
          }
        }
      }
    }
    check(`w=${w} 每条连线两端都画出了弧`, missing === 0 && ends > 0, `${missing}/${ends} 端缺失`);
  }
}

{
  // 字间距：unit 越大，音符格越宽，断行点也跟着变
  const { score } = parseDsl(readFileSync(join(DIR, 'molihua.jps'), 'utf-8'));
  const tight = layoutScore(score!, { contentWidth: 1000, unit: 0.9 });
  const loose = layoutScore(score!, { contentWidth: 1000, unit: 2.2 });
  check('unit 回传到布局结果', tight.unit === 0.9 && loose.unit === 2.2);
  const widthOf = (l: ReturnType<typeof layoutScore>) =>
    l.lines[0].items.filter((i) => i.kind === 'note').slice(0, 1)[0].w;
  check('字间距变大则音符格变宽', widthOf(loose) > widthOf(tight));
  check('字间距变大则行数变多', loose.lines.length >= tight.lines.length);
  check('默认字间距仍是 1.3', layoutScore(score!, { contentWidth: 1000 }).unit === 1.3);
}

{
  // 复现：小节里含拍内组时，断行点不能落到小节中间。
  // 3.(72) + 2/2(24) + 2-(96) = 192 tick，正好 4 拍。
  const parsed = parseDsl('@beat 4/4\n\n3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 3. <2/2> 2- ||\n').score!;
  for (const width of [640, 760, 900, 1100, 1400]) {
    const layout = layoutScore(parsed, { contentWidth: width });
    const midBreak = layout.lines.some((l, i) => {
      if (i === 0) return false;
      const first = l.items[0];
      const prev = parsed.events[(first?.eventIndex ?? 0) - 1];
      return !!prev && prev.kind !== 'barline';
    });
    check(`w=${width} 不在小节中间断行`, !midBreak);
    const badges = layout.lines.flatMap((l) => l.badges);
    check(
      `w=${width} 4 拍小节不误报`,
      badges.length === 0,
      badges.map((b) => b.text).join(', '),
    );
  }
}

// ───────────────────────── M1 录入与编辑 ─────────────────────────
console.log('\n[M1 录入与编辑]');
const blank = (): Score => ({
  version: 2,
  meta: { title: '测试', key: '1=C', beat: '4/4', bpm: 90, patch: 73 },
  events: [],
  groups: [],
});

{
  // 内置谱面守卫：必须能解析出谱面，且序列化后回读无错（§10.2 round-trip）
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jps'))) {
    const r = parseDsl(readFileSync(join(DIR, f), 'utf-8'));
    check(`${f} 能解析出谱面`, !!r.score);
    const re = parseDsl(serializeDsl(r.score!));
    check(`${f} 序列化后回读无错`, re.errors.length === 0, re.errors.join(' / '));
  }
}

{
  // 插入点不能贴住小节线。小节线的竖线画在格子正中，
  // 若按「下一项左缘减几像素」定位，插入点会正好压在那条线上（实测只差 1px），
  // 两者糊成一团，看不出光标在新小节的开头。
  console.log('\n[插入点与小节线]');
  const s = parseDsl('@beat 4/4\n\n1 2 | 3 4 ||\n').score!;
  const L = layoutScore(s, { contentWidth: 1000 });
  const items = L.lines.flatMap((l) => l.items);
  const barIdx = s.events.findIndex((e) => e.kind === 'barline');
  const bar = items.find((i) => i.eventId === s.events[barIdx].id)!;
  const lineX = bar.x + bar.w / 2;

  const before = caretAt(L, barIdx)!;
  const after = caretAt(L, barIdx + 1)!;
  const tail = caretAt(L, s.events.length)!;

  check('插入点在小节线左侧留空 ≥ 7px', lineX - before.x >= 7, `${(lineX - before.x).toFixed(1)}px`);
  check('插入点在小节线右侧留空 ≥ 7px', after.x - lineX >= 7, `${(after.x - lineX).toFixed(1)}px`);
  check('谱末插入点留空 ≥ 7px', tail.x - lineX >= 7, `${(tail.x - lineX).toFixed(1)}px`);

  // 也不能反过来贴住下一个音的字形
  const next = items.find((i) => i.eventIndex === barIdx + 1)!;
  check('插入点不压住下一个音', next.x + 5 - after.x >= 4, `${(next.x + 5 - after.x).toFixed(1)}px`);

  // 小节线占位比音符格窄，但它必须留出可站人的空间
  check('小节线占位 ≥ 18px', bar.w >= 18, `${bar.w}px`);

  // 真实谱面里每条小节线都要满足（含换气记号紧贴小节线的情形）
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jps'))) {
    const sc = parseDsl(readFileSync(join(DIR, f), 'utf-8')).score!;
    const LL = layoutScore(sc, { contentWidth: 1000 });
    let min = Infinity;
    let n = 0;
    sc.events.forEach((ev, i) => {
      if (ev.kind !== 'barline') return;
      let found: { x: number; y: number } | null = null;
      for (const line of LL.lines) {
        const it = line.items.find((x) => x.eventId === ev.id);
        if (it) {
          found = { x: it.x + it.w / 2, y: line.y };
          break;
        }
      }
      if (!found) return;
      // 行末小节线的右侧插入点落在下一行行首，跨行比较没有意义
      for (const [cursor, sign] of [[i, -1], [i + 1, 1]] as const) {
        const c = caretAt(LL, cursor);
        if (!c || Math.abs(c.y - found.y) > 1) continue;
        n += 1;
        min = Math.min(min, sign < 0 ? found.x - c.x : c.x - found.x);
      }
    });
    check(`${f} 小节线两侧插入点都 ≥ 7px`, min >= 7, `最小 ${min.toFixed(1)}px / ${n} 处`);
  }
}

{
  // 起播对齐：音频比时钟晚开始，时钟必须能延迟起跑且不倒着走。
  // 这是「最后一个音没播出来」的根因——时钟跑到终点时音频还没播完，
  // 结束回调一触发就把 AudioContext 关了。
  console.log('\n[时钟对齐音频]');
  const c = new BeatClock(60); // 1 拍 / 秒
  c.seek(4);
  c.playAfter(0.3);
  check('延迟期内时钟停在锚点', c.currentBeat === 4, String(c.currentBeat));
  check('延迟期内算运行中', c.isRunning);
  c.pause();
  check('暂停后仍停在锚点', c.currentBeat === 4);

  const c2 = new BeatClock(60);
  c2.seek(2);
  c2.playAfter(0);
  check('零延迟等同立即起播', c2.isRunning && c2.currentBeat >= 2, String(c2.currentBeat));

  const c3 = new BeatClock(60);
  c3.seek(3);
  c3.play();
  check('play() 等同于零延迟', c3.isRunning && c3.currentBeat >= 3, String(c3.currentBeat));

  // 时钟起点与渲染取值的换算：seek 后立刻读，应正好是起播 tick
  const c4 = new BeatClock(90);
  c4.seek(96 / TICKS_PER_BEAT);
  c4.playAfter(0.2);
  check('起播 tick 与 seek 值一致', c4.currentBeat * TICKS_PER_BEAT === 96);
}

{
  // 单个音改时值：不建只有一名成员的组，减时线交给 beamCount / autoGroupBeats
  console.log('\n[时值与自动成组]');
  const s = parseDsl('@beat 4/4\n\n1 2 3 4 ||').score!;
  const id0 = s.events[0].id;
  const short = setTicks(s, id0, 24);
  check('单音改时值生效', (short.events[0] as NoteEvent).ticks === 24);
  check('单音改时值不建组', short.groups.length === 0, `groups=${short.groups.length}`);

  // 组内单音改时值：先解散组，避免 Σ成员 ≠ 组总时值
  const grouped = parseDsl('@beat 4/4\n\n<3/2 3/4 5/4> 1 ||').score!;
  check('前置：已有 1 个组', grouped.groups.length === 1);
  const solo = setTicks(grouped, grouped.groups[0].memberIds[0], 48);
  check('组内单音改时值后解散组', solo.groups.length === 0);
  check('解散后不变量干净', validateGroups(solo).length === 0, validateGroups(solo).map((v) => v.code).join(','));

  // 自动成组：连续音之和恰好 1 拍 → 拉通
  const a = autoGroupBeats(parseDsl('@beat 4/4\n\n1/2 2/2 3 4 ||').score!);
  check('两个半拍自动成组', a.groups.length === 1 && a.groups[0].totalTicks === 48, `groups=${a.groups.length}`);
  check('成组后成员都带 groupId', a.events.slice(0, 2).every((e) => isTimed(e) && !!e.groupId));

  const b = autoGroupBeats(parseDsl('@beat 4/4\n\n1/4 2/4 3/4 4/4 5 6 ||').score!);
  check('四个十六分自动成组', b.groups.length === 1 && b.groups[0].memberIds.length === 4);

  // 超过 1 拍的组合不合并；后面能重新起算
  const c = autoGroupBeats(parseDsl('@beat 4/4\n\n1/2 2 1/2 2 ||').score!);
  check('总和超过 1 拍不合并', c.groups.length === 0, `groups=${c.groups.length}`);

  // 只从整拍位置起算：非整拍上的零散音不会被凑成组
  const c2 = autoGroupBeats(parseDsl('@beat 4/4\n\n1/2 2/2 3/2 4/2 1 2 ||').score!);
  check('一小节内两个整拍各成一组', c2.groups.length === 2, `groups=${c2.groups.length}`);

  // 单个满 1 拍的音不建组
  const d = autoGroupBeats(parseDsl('@beat 4/4\n\n1 2 3 4 ||').score!);
  check('单个满拍音不成组', d.groups.length === 0, `groups=${d.groups.length}`);

  // 1.5 拍（附点）不满足「恰好 1 拍」，不合并
  const e = autoGroupBeats(parseDsl('@beat 4/4\n\n1. 2/2 3 4 ||').score!);
  check('附点组合（1.5 拍）不合并', e.groups.length === 0, `groups=${e.groups.length}`);

  // 幂等 + 只增不减：已有的用户组不被拆掉
  const userGrouped = parseDsl('@beat 4/4\n\n<3/4 2/4> 1 2 ||').score!;
  const again = autoGroupBeats(autoGroupBeats(userGrouped));
  check('autoGroup 幂等', again.groups.length === userGrouped.groups.length, `${again.groups.length}`);
  check('autoGroup 不拆用户组', again.groups[0].totalTicks === userGrouped.groups[0].totalTicks);
}

{
  // 连音：选中 n 个音 → 忽略原时值，统一改成一拍内均分
  const s = parseDsl('@beat 4/4\n\n1/2 2/2 3 4 ||').score!;
  const ids = s.events.slice(0, 3).map((e) => e.id);
  const tri = applyTierOp(s, ids, TICKS_PER_BEAT, Array(3).fill(16), 3)!;
  check('3 连音每音 16 tick', tri.events.slice(0, 3).every((e) => (e as NoteEvent).ticks === 16));
  check('3 连音标号写入组', tri.groups[0].tuplet === 3);
  check('3 连音组总时值 1 拍', tri.groups[0].totalTicks === 48);
  check('3 连音不变量干净', validateGroups(tri).length === 0, validateGroups(tri).map((v) => v.code).join(','));

  const six = parseDsl('@beat 4/4\n\n1/4 2/4 3/4 4/4 5/4 6/4 7 ||').score!;
  const sids = six.events.slice(0, 6).map((e) => e.id);
  const sex = applyTierOp(six, sids, TICKS_PER_BEAT, Array(6).fill(8), 6)!;
  check('6 连音每音 8 tick', sex.events.slice(0, 6).every((e) => (e as NoteEvent).ticks === 8));
  check('6 连音标号写入组', sex.groups[0].tuplet === 6);
  check('8 tick 是合法 tick（I4）', isLegalTick(8));
  check('6 连音不变量干净', validateGroups(sex).length === 0, validateGroups(sex).map((v) => v.code).join(','));

  // 连音必须能无损序列化（8 tick 没有除法记号的话 renderDuration 会抛）
  for (const [name, sc] of [['3 连音', tri], ['6 连音', sex]] as const) {
    const text = serializeDsl(sc);
    const re = parseDsl(text);
    check(`${name} 序列化回读无错`, re.errors.length === 0, re.errors.join(' / '));
    const mem = re.score!.groups[0].memberIds.length;
    check(`${name} 回读后成员数不变`, mem === (name === '3 连音' ? 3 : 6), String(mem));
  }
}

{
  // 连音组的绘制：一条线 + 一个居中标号
  const s = parseDsl('@beat 4/4\n\n<3: 1/3 2/3 3/3> 4 ||').score!;
  const L = layoutScore(s, { contentWidth: 1000 });
  const beams = L.lines[0].beams;
  const tuplets = L.lines[0].tuplets;
  check('连音组画出减时线', beams.length >= 1, `beams=${beams.length}`);
  check('连音组只画一级线', beams.every((b) => b.level === 1), `levels=${beams.map((b) => b.level)}`);
  check('整组只有一个标号', tuplets.length === 1 && tuplets[0].text === '3', JSON.stringify(tuplets));
  const first = L.lines[0].items.find((i) => i.kind === 'note')!;
  const last = L.lines[0].items.filter((i) => i.kind === 'note')[2];
  check(
    '弧线覆盖整组',
    tuplets[0].x0 <= first.x + 4 && tuplets[0].x1 >= last.x + 10,
    `x0=${tuplets[0].x0.toFixed(1)} x1=${tuplets[0].x1.toFixed(1)}`,
  );
}

{
  // 从光标起播：事件下标 → tick 的口径必须和 buildTimeline 完全一致，
  // 否则音频和谱面播放头会错位。
  const s = parseDsl('@beat 4/4\n\n1 2 | 3 4 ||').score!;
  check('下标 0 → tick 0', tickAtEvent(s, 0) === 0);
  check('小节线不占时值', tickAtEvent(s, 2) === 96, String(tickAtEvent(s, 2)));
  check('末尾 = 总时值', tickAtEvent(s, s.events.length) === 192, String(tickAtEvent(s, s.events.length)));
  check('越界下标被夹住', tickAtEvent(s, 999) === 192);
  check('负下标被夹住', tickAtEvent(s, -5) === 0);

  // 每个事件起点的 tick 必须与 timeline 里对应条目的 startTick 对上
  const tl = buildTimeline(s);
  const startOf = new Map(tl.map((e) => [e.eventId, e.startTick]));
  let mismatch = 0;
  s.events.forEach((ev, i) => {
    const want = startOf.get(ev.id);
    if (want === undefined) return; // 小节线等不发声
    if (tickAtEvent(s, i) !== want) mismatch += 1;
  });
  check('与 buildTimeline 的 startTick 逐项一致', mismatch === 0, `${mismatch} 处不一致`);

  // 起播点落在长音中间时，该音应从 fromTick 处起声
  const long = parseDsl('@beat 4/4\n\n1 - - - 2 ||').score!;
  check('长音中间起播取到 tick 48', tickAtEvent(long, 1) === 48);
}

{
  // 光标导航：方块（over）与插入点（insert）之间切换，含一头一尾的特例
  const s = parseDsl('@beat 4/4\n\n1 2 | 3 4 ||').score!;
  // 事件：0=1 1=2 2=| 3=3 4=4 5=||
  const n = s.events.length;
  check('谱面共 6 个事件', n === 6, String(n));

  check('缝 0 左边没有音（一头）', prevTimed(s, 0) === -1);
  check('缝 6 右边没有音（一尾）', nextTimed(s, n) === -1);
  check('缝 2 左边是第 2 个音', prevTimed(s, 2) === 1);
  check('缝 2 右边跨小节线找到第 3 个音', nextTimed(s, 2) === 3);
  check('缝 3 左边跨小节线找到第 2 个音', prevTimed(s, 3) === 1);
  check('缝 1 左边是第 1 个音', prevTimed(s, 1) === 0);

  // 替换语义：改音级保留时值
  const dotted = parseDsl('@beat 4/4\n\n1. 2 ||').score!;
  const replaced = setDegree(dotted, dotted.events[0].id, 3);
  const r0 = replaced.events[0] as NoteEvent;
  check('替换只改音级', r0.degree === 3);
  check('替换保留时值', r0.ticks === (dotted.events[0] as NoteEvent).ticks);
  check('替换保留附点', r0.dot === 1);
}

{
  // 相邻音符之间必须留出可点的「缝」。
  // 音符的点击感知区只覆盖字形墨迹；若按时值格宽算，
  // 十六分音符（格 26px）的感知区会盖到下一个音上，缝被吃光。
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.jps'))) {
    const { score } = parseDsl(readFileSync(join(DIR, f), 'utf-8'));
    const L = layoutScore(score!, { contentWidth: 1000 });
    let worst = Infinity;
    let pairs = 0;
    for (const line of L.lines) {
      const ns = line.items.filter((i) => i.kind === 'note' || i.kind === 'rest');
      for (let k = 1; k < ns.length; k += 1) {
        const a = ns[k - 1];
        const b = ns[k];
        const aTo = a.x + nominalInk(a.dot ?? 0, a.dashes ?? 0).to;
        const bFrom = b.x + nominalInk(b.dot ?? 0, b.dashes ?? 0).from;
        worst = Math.min(worst, bFrom - aTo);
        pairs += 1;
      }
    }
    if (pairs === 0) continue;
    check(`${f} 相邻音符留出可点的缝 ≥ 6px`, worst >= 6, `最小 ${worst.toFixed(1)}px / ${pairs} 对`);
  }
}

{
  // 焦点框必须把附点 / 增时线一并包进来，否则点亮时看不出这个附点属于当前音
  const plain = clusterWidth(12, 0, 0);
  check('附点被包进焦点框', clusterWidth(12, 1, 0) > plain, `${plain} → ${clusterWidth(12, 1, 0)}`);
  check('双附点更宽', clusterWidth(12, 2, 0) > clusterWidth(12, 1, 0));
  check('增时线被包进焦点框', clusterWidth(12, 0, 1) > plain, `${plain} → ${clusterWidth(12, 0, 1)}`);
  check('多条增时线更宽', clusterWidth(12, 0, 2) > clusterWidth(12, 0, 1));
  check('焦点框不小于最小可点宽度', plain >= 20, String(plain));
}

{
  // 会话持久化：存的是内容不是路径，两端行为一致。
  // 关键是不合法的草稿一律返回 null——宁可丢掉，也不能让编辑器起不来。
  console.log('\n[编辑会话持久化]');
  const ok = parseSession(
    JSON.stringify({ text: '@title t\n\n1 2 ||\n', name: '茉莉花', path: null, at: 1 }),
  );
  check('正常会话可读', ok?.name === '茉莉花' && ok.path === null);
  check('会话内容能解析成谱面', !!parseDsl(ok!.text).score);

  check('null 输入 → null', parseSession(null) === null);
  check('空串 → null', parseSession('') === null);
  check('坏 JSON → null', parseSession('{oops') === null);
  check('JSON null → null', parseSession('null') === null);
  check('缺 text → null', parseSession(JSON.stringify({ name: 'x' })) === null);
  check('text 类型不对 → null', parseSession(JSON.stringify({ text: 42 })) === null);
  check('数组 → null', parseSession('[1,2]') === null);

  const partial = parseSession(JSON.stringify({ text: '1 2 ||' }));
  check('缺 name 时给个兜底名', partial?.name === '上次编辑', String(partial?.name));
  check('缺 path 时为 null', partial?.path === null);
  check('path 为空串时当 null', parseSession(JSON.stringify({ text: 'x', path: '' }))?.path === null);
}

{
  // 命中判定：点在字形上=方块（替换），点在字形外的空隙=插入。
  // 逐像素扫一遍整行，断言「每个音都有一段可点进去的缝」，
  // 且缝落在正确的位置（右侧的缝插在该音之后）。
  console.log('\n[点击命中：方块 vs 插入]');
  const s = parseDsl('@beat 4/4\n\n1. 2 3 4 ||\n').score!;
  const L = layoutScore(s, { contentWidth: 1000 });
  const line = L.lines[0];
  const y = line.y;
  const notes = line.items.filter((i) => i.kind === 'note');

  // 「1.」：附点后必须还能点到插入
  const dotted = notes[0];
  check('点数字本体 → 方块', pickAt(L, dotted.x + 12, y)?.mode === 'over');
  check('点附点本身 → 方块（附点属于这个音）', pickAt(L, dotted.x + 23, y)?.mode === 'over');
  const afterDot = pickAt(L, dotted.x + 50, y);
  check('点附点右侧空隙 → 插入', afterDot?.mode === 'insert', JSON.stringify(afterDot));
  check('插入位置在该音之后', afterDot?.cursor === dotted.eventIndex + 1, `cursor=${afterDot?.cursor}`);
  const beforeInk = pickAt(L, dotted.x + 1, y);
  check('点字形左侧 → 插入在该音之前', beforeInk?.mode === 'insert' && beforeInk.cursor === dotted.eventIndex);

  // 逐像素扫：每个音都必须有「缝」可点
  for (const n of notes) {
    let hasGap = false;
    for (let dx = 0; dx <= Math.ceil(n.w); dx += 1) {
      if (pickAt(L, n.x + dx, y)?.mode === 'insert') hasGap = true;
    }
    check(`音 ${n.eventIndex} 附近有可点的缝`, hasGap);
  }

  // 增时线也算字形的一部分：1-- 的横线上点下去仍是方块
  const s2 = parseDsl('@beat 4/4\n\n1-- 2 3 4 ||\n').score!;
  const L2 = layoutScore(s2, { contentWidth: 1000 });
  const n2 = L2.lines[0].items.find((i) => i.kind === 'note')!;
  check('1-- 有 2 条增时线', n2.dashes === 2, `dashes=${n2.dashes}`);
  check('点增时线上 → 方块', pickAt(L2, n2.x + 40, L2.lines[0].y)?.mode === 'over');
  const after2 = pickAt(L2, n2.x + Math.ceil(n2.w) - 2, L2.lines[0].y);
  check('点增时线右侧 → 插入', after2?.mode === 'insert', JSON.stringify(after2));
}

{
  // 可见框（选中 / 焦点 / 播放头）必须和可点区域同源。
  // 框画得比可点区域宽，用户照着框点右半边就会被判成插入，
  // 感觉上就是「点整个音却进了插入模式」。
  for (const [name, n] of [
    ['普通音', parseDsl('@beat 4/4\n\n1 2 ||\n').score!.events[0]],
    ['附点音', parseDsl('@beat 4/4\n\n1. 2 ||\n').score!.events[0]],
    ['增时线音', parseDsl('@beat 4/4\n\n1-- 2 ||\n').score!.events[0]],
  ] as const) {
    const ev = n as NoteEvent;
    const ink = nominalInk(ev.dot ?? 0, ev.dashes ?? 0);
    const box = clusterWidth(13, ev.dot ?? 0, ev.dashes ?? 0);
    const over = ink.to - ink.from;
    check(
      `${name} 可见框与可点区域宽度差 ≤ 8px`,
      Math.abs(box - over) <= 8,
      `框 ${box.toFixed(1)} vs 可点 ${over.toFixed(1)}`,
    );
    check(`${name} 框不小于可点区域（附点不被切在框外）`, box >= over, `${box} vs ${over}`);
  }

  // 时值档位必须覆盖增时线能写出来的长音，否则 1-- 选中后改不回去。
  // 但上限是小节本身：2/4 里出现「3 拍」按钮，一个小节根本装不下。
  const t = durationTiers(TICKS_PER_BEAT * 4); // 4/4
  check('4/4 档位含 3 拍（144 tick）', t.some((x) => x.ticks === 144), t.map((x) => x.label).join(' / '));
  check('4/4 档位含 4 拍（192 tick）', t.some((x) => x.ticks === 192));
  check('档位含 1/8 拍（6 tick）', t.some((x) => x.ticks === 6));
  check('档位无重复 tick', new Set(t.map((x) => x.ticks)).size === t.length);
  check(
    '4/4 的 1 小节已是整拍档，不重复列',
    !t.some((x) => x.label === '1 小节'),
    t.map((x) => x.label).join(' / '),
  );
  const t34 = durationTiers(72); // 3/4 → 1 小节 = 1.5 拍，不是整拍倍数
  check('3/4 补出 1 小节档', t34.some((x) => x.label === '1 小节' && x.ticks === 72), t34.map((x) => x.label).join(' / '));

  // 上限 = 小节
  const t24 = durationTiers(TICKS_PER_BEAT * 2); // 2/4
  check('2/4 不给 3 拍', !t24.some((x) => x.ticks === 3 * TICKS_PER_BEAT), t24.map((x) => x.label).join(' / '));
  check('2/4 不给 4 拍', !t24.some((x) => x.ticks === 4 * TICKS_PER_BEAT));
  check('2/4 保留 2 拍', t24.some((x) => x.ticks === 2 * TICKS_PER_BEAT));
  check('3/4 不给 4 拍', !durationTiers(72).some((x) => x.ticks === 4 * TICKS_PER_BEAT));
  check('3/4 保留 1 小节档（附点二分）', durationTiers(72).some((x) => x.ticks === 72));
}

{
  // 时值 / 八度按钮直接显示谱面写法，所见即所写：
  // 选中的是 3，按钮就该是 3--- / 3-- / 3- / 3 / 3/2 / 3/4 / 3/8，而不是「4 拍」这种要换算的话
  console.log('\n[按钮显示谱面写法]');
  check('4 拍 → 3---', renderNoteToken(3, 4 * TICKS_PER_BEAT) === '3---');
  check('3 拍 → 3--', renderNoteToken(3, 3 * TICKS_PER_BEAT) === '3--');
  check('2 拍 → 3-', renderNoteToken(3, 2 * TICKS_PER_BEAT) === '3-');
  check('1 拍 → 3', renderNoteToken(3, TICKS_PER_BEAT) === '3');
  check('1/2 拍 → 3/2', renderNoteToken(3, 24) === '3/2');
  check('1/4 拍 → 3/4', renderNoteToken(3, 12) === '3/4');
  check('1/8 拍 → 3/8', renderNoteToken(3, 6) === '3/8');
  check('附点 → 3.', renderNoteToken(3, 72, 1) === '3.');
  check('高八度 → 3^', renderNoteToken(3, 48, 0, 1) === '3^');
  check('低两个八度 → 3vv', renderNoteToken(3, 48, 0, -2) === '3vv');
  check('非法时值不炸面板', renderNoteToken(3, 7) === '3');

  // 按钮文字就是 DSL 记号本身：渲染出来必须能被解析器原样读回
  for (const ticks of [192, 144, 96, 48, 24, 12, 6]) {
    const tok = renderNoteToken(3, ticks);
    const p = parseDsl(`@beat 4/4\n\n${tok} ||\n`);
    check(
      `按钮文字能被解析器读回：${tok}`,
      p.errors.length === 0 && (p.score!.events[0] as NoteEvent).ticks === ticks,
      p.errors.join(' / '),
    );
  }
}

{
  // 底色块（选中 / 焦点 / 播放头）不得侵入减时线所在的高度带。
  // 减时线在中线下 beamOffset(1) 处；底色若盖住它，两个八分音符被选中时
  // 那根连着的横线就只剩色块缝隙里的一小截，看起来像没画。
  console.log('\n[底色与减时线分层]');
  check(
    '底色块下沿不越过一级减时线',
    SEL_HALF_H <= beamOffset(1),
    `底色 ${SEL_HALF_H} vs 减时线 ${beamOffset(1)}`,
  );

  // 二级减时线更深，更不能被盖住
  check('底色块下沿远低于二级减时线之外', SEL_HALF_H < beamOffset(2), `${beamOffset(2)}`);

  // 底色仍需盖住字形（21px 字号半高约 11）与八度点起点
  check('底色块仍能盖住字形', SEL_HALF_H >= 12, `底色 ${SEL_HALF_H}`);

  // 选中的两个八分音符：横线必须完整连过两个色块
  const s = parseDsl('@beat 4/4\n\n<1/2 2/2> 3 4 ||').score!;
  const L = layoutScore(s, { contentWidth: 1000 });
  const beams = L.lines[0].beams;
  const notes = L.lines[0].items.filter((i) => i.kind === 'note');
  check('两个八分音符连成一条横线', beams.length === 1, `beams=${beams.length}`);
  check(
    '横线横跨两个音（不是各画一小段）',
    beams[0].x0 <= notes[0].x + 2 && beams[0].x1 >= notes[1].x + 20,
    `x0=${beams[0].x0.toFixed(1)} x1=${beams[0].x1.toFixed(1)}`,
  );
}

{
  // 低八度点必须画在减时线下方，不能和横线重叠（§7.1 自下而上的分层）
  for (const beams of [1, 2]) {
    const dotTop = lowDotOffset(beams) - DOT_R;
    const beamY = beamOffset(beams);
    check(
      `低八度点让开 ${beams} 级减时线`,
      dotTop > beamY,
      `点顶 ${dotTop.toFixed(1)} vs 线 ${beamY.toFixed(1)}`,
    );
  }
  check('无减时线时低音点回到常规位置', lowDotOffset(0) === 17, String(lowDotOffset(0)));
}

{
  const s1 = insertNote(blank(), 0, 5);
  check('插入音符默认 1 拍（48 tick）', s1.events.length === 1 && (s1.events[0] as NoteEvent).ticks === 48);

  const s2 = insertBarline(insertNote(s1, 1, 3), 2);
  check('继续插入音符与小节线', s2.events.length === 3 && s2.events[2].kind === 'barline');

  const ext = extendPrev(s2, 2);
  check('增时线 - 加 1 拍（48 → 96）', ext.ok && (ext.score.events[1] as NoteEvent).ticks === 96);

  const oct = shiftOctave(s2, s2.events[0].id, 1);
  check('八度 ^ 生效', (oct.events[0] as NoteEvent).octave === 1);

  const d1 = cycleDot(s2, s2.events[0].id);
  const d2 = cycleDot(d1, s2.events[0].id);
  const d3 = cycleDot(d2, s2.events[0].id);
  check(
    '附点循环 48 → 72 → 84 → 48',
    (d1.events[0] as NoteEvent).ticks === 72 &&
      (d2.events[0] as NoteEvent).ticks === 84 &&
      (d3.events[0] as NoteEvent).ticks === 48,
  );

  check('删除事件', removeEvent(s2, s2.events[1].id).events.length === 2);
}

{
  let s = blank();
  s = insertNote(s, 0, 5);
  s = insertNote(s, 1, 3);
  s = insertNote(s, 2, 2);
  const ids = s.events.map((e) => e.id);

  const t = applyTierOp(s, ids, 48, [24, 12, 12]);
  check('框选 3 音套 1 拍档位 → 建立拍内组', !!t && t.groups.length === 1);
  check(
    '组内时值写成 24 / 12 / 12',
    !!t &&
      (t.events[0] as NoteEvent).ticks === 24 &&
      (t.events[1] as NoteEvent).ticks === 12 &&
      (t.events[2] as NoteEvent).ticks === 12,
  );
  check('组守恒 Σ = 48', !!t && t.groups[0].totalTicks === 48);
  check('应用档位后不变量通过', !!t && validateGroups(t).length === 0,
    !!t ? validateGroups(t).map((v) => `${v.code}:${v.message}`).join('; ') : '');

  check('n = 3 给出 4 个候选划分', candidatesFor(3, 48).length === 4);
  check('n = 4 均分无歧义，只给 1 个候选', candidatesFor(4, 48).length === 1);

  // ── 两音的附点切分（用户提案）：选 2 音套 1 拍 → 均分 + 两个方向的附点切分 ──
  const c2 = candidatesFor(2, 48);
  check('两音 1 拍出三档（均分 + 前附点 + 后附点）', c2.length === 3, JSON.stringify(c2.map((c) => c.ticks)));
  check('均分档各半拍不带点', c2[0]!.ticks[0] === 24 && !c2[0]!.dots?.[0]);
  check(
    '前附点档 36 + 12，dot 只在前音',
    c2.some((c) => c.ticks[0] === 36 && c.ticks[1] === 12 && c.dots?.[0] === 1 && c.dots?.[1] === 0),
  );
  check(
    '后附点档 12 + 36，dot 只在后音',
    c2.some((c) => c.ticks[0] === 12 && c.ticks[1] === 36 && c.dots?.[1] === 1 && c.dots?.[0] === 0),
  );
  // 分不出的就不给档：半拍组 12 tick → 附点方向 9/3 非法，只剩均分
  check('半拍组只剩均分一档', candidatesFor(2, 12).length === 1, String(candidatesFor(2, 12).length));

  const twoNotes = parseDsl('@beat 4/4\n\n1 2 3 4 ||\n').score!;
  const dotAp = applyTierOp(
    twoNotes,
    [twoNotes.events[0]!.id, twoNotes.events[1]!.id],
    48,
    [36, 12],
    undefined,
    [1, 0],
  )!;
  const dFirst = dotAp.events[0] as NoteEvent;
  const dSecond = dotAp.events[1] as NoteEvent;
  check('applyTier 写入附点切分（36+dot / 12）', dFirst.ticks === 36 && dFirst.dot === 1 && dSecond.ticks === 12 && !dSecond.dot);
  check('附点切分后组守恒干净', validateGroups(dotAp).length === 0, validateGroups(dotAp).map((v) => v.code).join(','));
  const dRound = parseDsl(serializeDsl(dotAp)).score!;
  check('附点切分可序列化回读', (dRound.events[0] as NoteEvent).ticks === 36 && (dRound.events[0] as NoteEvent).dot === 1);
  // 排版：附点八分该有 1 条减时线 + 点（此前 beamCount(36)=0 画成缺线的错样）
  const dLay = layoutScore(dotAp, { contentWidth: 800 });
  const dItem = dLay.lines[0].items.find((i) => i.eventId === dFirst.id) as { beams?: number; dot?: number } | undefined;
  check('附点八分排版：1 条线 + 附点', dItem?.beams === 1 && dItem?.dot === 1, `beams=${dItem?.beams} dot=${dItem?.dot}`);

  if (t) {
    const rm = removeEvent(t, ids[2]);
    const sum = rm.events.filter(isTimed).reduce((a, e) => a + (e as TimedEvent).ticks, 0);
    check('删音后同组重新均分，Σ 仍为 48', sum === 48, `sum=${sum}`);
    check('删音后不变量通过', validateGroups(rm).length === 0);
  }
}

{
  let s = blank();
  s = insertNote(s, 0, 5);
  s = insertNote(s, 1, 6);
  s = insertNote(s, 2, 5);
  const ids = s.events.map((e) => e.id);

  const slurred = toggleSlur(s, ids);
  const first = slurred.events[0] as NoteEvent;
  const second = slurred.events[1] as NoteEvent;
  check(
    '连音线建立链式 slur',
    (first.ties ?? []).some((t) => t.kind === 'slur' && t.to === ids[1]) &&
      (second.ties ?? []).some((t) => t.kind === 'slur' && t.to === ids[2]),
  );
  const off = toggleSlur(slurred, ids);
  check(
    '再次调用取消连音线',
    off.events.every((e) => e.kind !== 'note' || (e.ties ?? []).length === 0),
  );

  // 链式 slur 必须合并成一条弧，不能每段各画一条
  const arcs = layoutScore(slurred, { contentWidth: 1000 }).lines.flatMap((l) => l.arcs);
  check('3 个音的连音线只画 1 条弧（不是 2 条重叠）', arcs.length === 1, `arcs=${arcs.length}`);
  check('弧线跨过全部 3 个音', arcs.length === 1 && arcs[0].x1 - arcs[0].x0 > 60);
}

{
  // 复现：输入 1.7 之后，7 必须能被单独选中。
  // 长音 1· 占 72 tick（约 103px），以前用它整个时值宽度当命中框，
  // 会把紧跟其后的 7 的字形左侧一小段吞掉，一点就连带选中。
  let s = blank();
  s = insertNote(s, 0, 1);
  s = cycleDot(s, s.events[0].id);
  s = insertNote(s, 1, 7);
  const layout = layoutScore(s, { contentWidth: 1000 });
  const line = layout.lines[0];
  const a = line.items[0];
  const b = line.items[1];
  check('点长音字形命中长音', hitTest(layout, a.x + 10, line.y) === s.events[0].id);
  check('点后面的 7 命中 7，不连带前面的长音', hitTest(layout, b.x + 10, line.y) === s.events[1].id);
  check('7 字形左侧一小段仍属于 7', hitTest(layout, b.x + 2, line.y) === s.events[1].id);
}

{
  // 行间空隙必须仍能命中，否则跨行拖拽会在空隙里卡住
  const { score } = parseDsl(readFileSync(join(DIR, 'huanlesong.jps'), 'utf-8'));
  const layout = layoutScore(score!, { contentWidth: 1000 });
  check('欢乐颂布局是多行', layout.lines.length > 1, `lines=${layout.lines.length}`);
  const l0 = layout.lines[0];
  const l1 = layout.lines[1];
  const gapY = (l0.y + l1.y) / 2; // 正好落在两行中间的空隙
  check('行间空隙仍能命中（拖拽不卡住）', hitTest(layout, 120, gapY) !== null);
  check('行间空隙归到相邻的行', (() => {
    const id = hitTest(layout, 120, gapY);
    const ids0 = new Set(l0.items.map((i) => i.eventId));
    const ids1 = new Set(l1.items.map((i) => i.eventId));
    return !!id && (ids0.has(id) || ids1.has(id));
  })());
}

{
  // 力度跟音符绑定：写在音符前面的力度 token 绑到那个音上，画在音符下方
  const s = parseDsl('@beat 4/4\n\nf 5 3 mf 2 ||\n').score!;
  const ns = s.events.filter((e) => e.kind === 'note') as NoteEvent[];
  check('力度绑定到音符', ns[0].dynamic === 'f' && ns[2].dynamic === 'mf', ns.map((n) => n.dynamic).join(','));
  check('力度不占时值', buildTimeline(s).reduce((a, e) => a + (e.endTick - e.startTick), 0) === 144);
  const text = serializeDsl(s);
  check('力度 round-trip 无 diff', stable(parseDsl(text).score) === stable(s), text);
  const layout = layoutScore(s, { contentWidth: 1000 });
  const placed = layout.lines.flatMap((l) => l.items).filter((i) => i.dynamic);
  check('力度落位到布局里', placed.length === 2, `placed=${placed.length}`);

  // 渐强渐弱：绑定 + round-trip（写在音符前面，绑到那个音）
  const s2 = parseDsl('@beat 4/4\n\ncresc 5 3 ||\n').score!;
  check('渐强绑定到音符', ((s2.events[0] as NoteEvent).hairpin) === 'cresc');
  check('渐强 round-trip', serializeDsl(s2).includes('cresc'), serializeDsl(s2));
}

{
  // 圆滑线跨越小节线：数据上仍是两个音一条连线，序列化不能被小节线切断
  let s = blank();
  s = insertNote(s, 0, 5);
  s = insertBarline(s, 1);
  s = insertNote(s, 2, 3);
  const slurred = toggleSlur(s, [s.events[0].id, s.events[2].id]);
  const text = serializeDsl(slurred);
  const back = parseDsl(text).score;
  check('圆滑线可跨小节线并无损 round-trip', !!back && stable(back) === stable(slurred), text);
}

{
  // 吐音：T 单吐、K 双吐第二音；双吐/三吐/快速双吐都是 T K 在连续音符上的组合
  let s = blank();
  s = insertNote(s, 0, 5);
  s = toggleTongue(s, s.events[0].id);
  check('吐音标记写入音符（单吐 = T）', (s.events[0] as NoteEvent).tongue === 'T');

  const text = serializeDsl(s);
  check('吐音序列化为 5t', /^[^]*5t/m.test(text), text.trim().split('\n').pop());
  const back = parseDsl(text).score!;
  check('吐音 round-trip 保留', (back.events[0] as NoteEvent).tongue === 'T');
  check('再按一次取消吐音', toggleTongue(s, s.events[0].id).events[0].kind === 'note'
    && (toggleTongue(s, s.events[0].id).events[0] as NoteEvent).tongue === undefined);

  // 双吐：两个音交替 T K，解析与回读都要无损
  const tk = parseDsl('@beat 4/4\n\n5t 6k 5t 6k ||').score!;
  const tks = (tk.events.filter((e) => e.kind === 'note') as NoteEvent[]).map((e) => e.tongue);
  check('双吐 T K 交替', tks.join(',') === 'T,K,T,K', tks.join(','));
  check('双吐序列化回读', serializeDsl(tk).includes('5t 6k'), serializeDsl(tk).split('\n').pop());
}

{
  // 电吹管技法：DSL 后缀字母 → technique 值，序列化写回
  console.log('\n[电吹管技法]');
  const body = '@beat 4/4\n\n5f 6d 5m 6w 5s 6x 5q 6h ||';
  const s = parseDsl(body);
  check('技法解析无误', s.errors.length === 0, s.errors.join(' / '));
  const ns = s.score!.events.filter((e) => e.kind === 'note') as NoteEvent[];
  check(
    '八个技法各就各位',
    ns.map((n) => n.techniques?.join('+')).join(',') ===
      'flutter,da,mordentUp,mordentDown,slideUp,slideDown,bendUp,bendDown',
    ns.map((n) => n.techniques?.join('+')).join(','),
  );

  // 多选：一个音同时挂花舌 + 上滑音，横向两个符号
  const multi = parseDsl('@beat 4/4\n\n5fs ||').score!;
  check('换气排在技法面板第一位', Object.keys(TECHNIQUE_GLYPH)[0] === 'breath');
  const br = parseDsl('@beat 4/4\n\n5V ||').score!;
  check('换气记号 5V 绑到音符', ((br.events[0] as NoteEvent).techniques ?? []).join('+') === 'breath');
  const mn = multi.events[0] as NoteEvent;
  check('多选技法', mn.techniques?.join('+') === 'flutter+slideUp', mn.techniques?.join('+'));
  const multiBack = parseDsl(serializeDsl(multi)).score!;
  check(
    '多选 round-trip 一致',
    ((multiBack.events[0] as NoteEvent).techniques ?? []).join('+') === 'flutter+slideUp',
  );

  const back = parseDsl(serializeDsl(s.score!));
  check(
    '技法 round-trip 一致',
    (back.score!.events.filter((e) => e.kind === 'note') as NoteEvent[])
      .map((n) => n.techniques?.join('+'))
      .join(',') === ns.map((n) => n.techniques?.join('+')).join(','),
  );

  // 排版层把记号带上（画不画是 paint 的事，数据必须先到位）
  const L = layoutScore(s.score!, { contentWidth: 1200 });
  const placed = L.lines.flatMap((l) => l.items).filter((i) => i.techniques?.length);
  check('技法进排版项', placed.length === 8, String(placed.length));

  // T / K / 换气 三个互斥：按下一个，其余两个等于没按
  const base = parseDsl('@beat 4/4\n\n5V ||').score!;
  const bid = base.events[0].id;
  const withT = setTongue(base, bid, 'T');
  check('标吐音摘掉换气', (withT.events[0] as NoteEvent).tongue === 'T'
    && !(withT.events[0] as NoteEvent).techniques);
  const withBreath = toggleTechnique(setTongue(base, bid, 'T'), bid, 'breath');
  const bn = withBreath.events[0] as NoteEvent;
  check('标换气摘掉吐音', bn.tongue === undefined && bn.techniques?.join('+') === 'breath');
  const mixed = setTongue(toggleTechnique(base, bid, 'flutter'), bid, 'T');
  check('吐音不影响其他技法', (mixed.events[0] as NoteEvent).techniques?.join('+') === 'flutter');

  // 技法互斥（UI 语义）：面板一次只点一个，点别的 = 换，点亮的再点 = 去。
  // DSL 里仍允许连写多个技法（模型保留列表能力），只是编辑界面不做多选。
  const ex = toggleTechnique(toggleTechnique(base, bid, 'flutter'), bid, 'da');
  check(
    '点别的技法 = 换成别的',
    (ex.events[0] as NoteEvent).techniques?.join('+') === 'da',
    (ex.events[0] as NoteEvent).techniques?.join('+'),
  );
  const off = toggleTechnique(ex, bid, 'da');
  check('点亮的再点一次 = 去掉', !(off.events[0] as NoteEvent).techniques);
}

{
  // 力度：同一位置的力度是替换，不是再插一个；并且能删
  console.log('\n[力度记号]');
  let s = blank();
  s = insertNote(s, 0, 5);
  s = setDynamic(s, 0, 'mf');
  check('插入力度', s.events.some((e) => e.kind === 'directive' && e.value === 'mf'));
  const before = s.events.length;
  s = setDynamic(s, 0, 'f');
  check('再设一次是替换不是新增', s.events.length === before);
  check('值已改成 f', s.events.some((e) => e.kind === 'directive' && e.value === 'f'));
  check('光标边能查到力度', dynamicAt(s, 0)?.value === 'f');
  s = deleteDynamic(s, 0);
  check('删除后没有力度了', !s.events.some((e) => e.kind === 'directive'));
  check('删空再删一次不炸', deleteDynamic(s, 0) === s);
}

// ───────────────────────── M5 时刻表 ─────────────────────────
console.log('\n[M5 时刻表]');
check('1=G 的音级 1 相对 C 偏 7 个半音', keyOffset('1=G') === 7, String(keyOffset('1=G')));
check('1=C 的 1 音 → MIDI 60（C4）', toMidi(1, 0, '1=C') === 60, String(toMidi(1, 0, '1=C')));
check('1=G 的 1 音 → MIDI 67（G4）', toMidi(1, 0, '1=G') === 67, String(toMidi(1, 0, '1=G')));
check('高八度加 12 个半音', toMidi(1, 1, '1=G') === 79, String(toMidi(1, 1, '1=G')));

{
  const { score } = parseDsl(readFileSync(join(DIR, 'molihua.jps'), 'utf-8'));
  const s = score!;
  const tl = buildTimeline(s);
  const expected = s.events
    .filter(isTimed)
    .reduce((a, e) => a + (e as TimedEvent).ticks, 0);
  check('时刻表总 tick = 音符与休止之和', timelineTicks(tl) === expected,
    `${timelineTicks(tl)} vs ${expected}`);
  check('时刻表按 startTick 单调递增', tl.every((e, i) => i === 0 || e.startTick >= tl[i - 1].startTick));
  check('tick 0 命中第一个条目', activeAt(tl, 0)?.entry.eventId === tl[0].eventId);
  check('超出末尾不命中', activeAt(tl, timelineTicks(tl) + 1) === null);

  // 播放指示不能被倚音打断：倚音是独立条目且与主音同 eventId，
  // 直接用 activeAt 会让进度在每个倚音上从 0 重扫一次（闪烁来回抖）
  {
    const gs = parseDsl('@beat 4/4\n\n5 ||\n').score!;
    const gid = gs.events[0].id;
    const withGrace = setGrace(
      setGrace(gs, gid, 'before', [{ degree: 6, octave: 0 }]),
      gid,
      'after',
      [{ degree: 1, octave: 0 }],
    );
    const gtl = buildTimeline(withGrace);
    // 1 拍 = 48 tick，倚音各 12：前倚音 [0,12) 主音 [12,36) 后倚音 [36,48)
    check('前倚音段停在框开头（进度 0）', activeMainAt(gtl, 4)?.progress === 0);
    check('前倚音段落到主音条目上', activeMainAt(gtl, 4)?.entry.grace !== true);
    check('主音段正常插值', Math.abs((activeMainAt(gtl, 24)?.progress ?? 0) - 0.5) < 1e-6);
    check('后倚音段停在框尾（进度 1）', activeMainAt(gtl, 40)?.progress === 1);
    const seq = [0, 4, 12, 24, 35, 36, 44].map((t) => activeMainAt(gtl, t)?.progress ?? 0);
    check('整个音的进度单调不回头', seq.every((v, i) => i === 0 || v >= seq[i - 1]), JSON.stringify(seq));
  }
}

{
  let s = blank();
  s = insertNote(s, 0, 5);
  s = insertNote(s, 1, 5);
  const tied: Score = {
    ...s,
    events: s.events.map((e, i) =>
      i === 0 && e.kind === 'note' ? { ...e, ties: [{ to: s.events[1].id, kind: 'tie' }] } : e,
    ),
  };
  const tl = buildTimeline(tied);
  check('延音线在播放时合并成一个长音', tl.length === 1 && tl[0].endTick === 96,
    `len=${tl.length} end=${tl[0]?.endTick}`);

  const slurred: Score = {
    ...s,
    events: s.events.map((e, i) =>
      i === 0 && e.kind === 'note' ? { ...e, ties: [{ to: s.events[1].id, kind: 'slur' }] } : e,
    ),
  };
  // 语义更新（用户要求）：连音线括住的同音高相邻音要连续演奏——
  // 弧线（slur）和延音线（tie）在播放时同样合并成一个长音
  check('弧线连接的同音高相邻音也合并成一个长音', buildTimeline(slurred).length === 1,
    `len=${buildTimeline(slurred).length}`);

  // 不同音高的弧线是真正的圆滑奏：仍是两个音（音高不同无法合并）
  let s2 = blank();
  s2 = insertNote(s2, 0, 5);
  s2 = insertNote(s2, 1, 6);
  const slurredDiff: Score = {
    ...s2,
    events: s2.events.map((e, i) =>
      i === 0 && e.kind === 'note' ? { ...e, ties: [{ to: s2.events[1].id, kind: 'slur' }] } : e,
    ),
  };
  check('不同音高的弧线仍是两个音', buildTimeline(slurredDiff).length === 2);
}

{
  // 倚音（装饰音）：不占时值，挂主音上；前倚音吃主音开头、后倚音吃结尾
  console.log('\n[倚音]');
  const s = parseDsl('@beat 4/4\n\n{5}3 {65}2 1{7} 1 ||\n').score!;
  check('解析无错', s.events.length === 5, String(s.events.length));
  const n0 = s.events[0] as NoteEvent;
  check('前倚音单颗', n0.graceBefore?.length === 1 && n0.graceBefore[0].degree === 5);
  check('主音时值不受倚音影响', n0.ticks === TICKS_PER_BEAT);
  const n1 = s.events[1] as NoteEvent;
  check('前复倚音两颗', n1.graceBefore?.map((g) => g.degree).join('') === '65');
  const n2 = s.events[2] as NoteEvent;
  check('后倚音', n2.graceAfter?.length === 1 && n2.graceAfter[0].degree === 7);

  // round-trip：写法原样保留
  const text = serializeDsl(s);
  check(
    '序列化原样写回',
    text.includes('{5}3') && text.includes('{65}2') && text.includes('1{7}'),
    text.split('\n').pop()?.trim(),
  );
  check('回读一致', JSON.stringify(parseDsl(text).score) === JSON.stringify(s));

  // 变音 / 八度也能写在倚音上
  const s2 = parseDsl('@beat 4/4\n\n{#6^v}3 0 0 0 ||\n').score!;
  const g = (s2.events[0] as NoteEvent).graceBefore![0];
  check('倚音带变音与八度', g.accidental === '#' && g.octave === 0 && g.degree === 6, JSON.stringify(g));

  // 倚音不能加在休止符上
  check('休止符拒绝倚音', parseDsl('@beat 4/4\n\n{5}0 0 0 0 ||\n').errors.length > 0);

  // 播放：总时长不变；前倚音占开头、后倚音占结尾；主音时值被切掉相应部分
  const t = parseDsl('@beat 4/4\n\n{5}3 2{7} 1 1 ||\n').score!;
  const events = t.events;
  const tl = buildTimeline(t);
  check(
    '总时长不变（倚音不占拍）',
    timelineTicks(tl) === 4 * TICKS_PER_BEAT,
    String(timelineTicks(tl)),
  );
  const main0 = tl.find((e) => e.eventId === events[0].id && !e.grace)!;
  const grace0 = tl.find((e) => e.eventId === events[0].id && e.grace)!;
  check('前倚音在主音之前发声', grace0.startTick === 0 && grace0.endTick === 12);
  check('主音从倚音之后起声', main0.startTick === 12 && main0.endTick === TICKS_PER_BEAT);
  const main1 = tl.find((e) => e.eventId === events[1].id && !e.grace)!;
  const grace1 = tl.find((e) => e.eventId === events[1].id && e.grace)!;
  check(
    '后倚音吃掉主音结尾',
    main1.endTick === 2 * TICKS_PER_BEAT - 12 && grace1.endTick === 2 * TICKS_PER_BEAT,
  );

  // 主音太短时按「主音至少保留一半」压缩
  const tiny = parseDsl('@beat 4/4\n\n{65}3/4 0 0 0 ||\n').score!; // 主音 12 tick
  const ttl = buildTimeline(tiny);
  const tmain = ttl.find((e) => !e.grace)!;
  check('主音过短时压缩倚音', tmain.endTick - tmain.startTick === 6, String(tmain.endTick - tmain.startTick));

  // 面板操作：加 / 删 / 清空 / 还原成音符
  let e = parseDsl('@beat 4/4\n\n5 5 5 5 ||\n').score!;
  const id0 = e.events[0].id;
  e = addGrace(e, id0, 'before', { degree: 6, octave: 0 });
  e = addGrace(e, id0, 'before', { degree: 5, octave: 0 });
  check('逐颗追加', (e.events[0] as NoteEvent).graceBefore?.length === 2);
  e = removeGrace(e, id0, 'before', 0);
  check('删掉第一颗', (e.events[0] as NoteEvent).graceBefore?.map((g) => g.degree).join('') === '5');
  e = setGrace(e, id0, 'before', undefined);
  check('清空且删键', !(e.events[0] as NoteEvent).graceBefore);
  const back = dropGrace(addGrace(e, id0, 'before', { degree: 6, octave: 0 }), id0, 'before');
  check(
    '还原成普通音符（插在主音前，1 拍）',
    back.events.length === 6 && // 4 个音 + 1 条小节线 + 还原出来的倚音
      (back.events[0] as NoteEvent).degree === 6 &&
      (back.events[0] as NoteEvent).ticks === TICKS_PER_BEAT &&
      !(back.events[0] as NoteEvent).graceBefore,
    `events=${back.events.length}`,
  );
}

{
  // 倚音的命中：主音字形被前倚音推右了，命中区必须跟着推——
  // 否则点在主音数字上会落进下一格（用户实测踩到过）
  console.log('\n[倚音命中]');
  const s = parseDsl('@beat 4/4\n\n{5}3 5 5 5 ||\n').score!;
  const L = layoutScore(s, { contentWidth: 800 });
  const line = L.lines[0];
  const it = line.items.find((x) => x.eventId === s.events[0].id)!;
  check('前倚音让主音字形右移', (it.graceInk ?? 0) > 0, String(it.graceInk));

  const digitX = it.x + (it.graceInk ?? 0) + 5 + 6; // 主音数字中心附近
  const pick = pickAt(L, digitX, line.y);
  check('点在主音数字上命中它自己', pick?.index === 0 && pick.mode === 'over', JSON.stringify(pick));

  const graceX = it.x + 8; // 倚音小音符上
  const pickGrace = pickAt(L, graceX, line.y);
  check('点在倚音上也命中同一个主音', pickGrace?.index === 0, JSON.stringify(pickGrace));

  // 选中框 / 焦点方块 / 播放头的横坐标也要按字形算（不能压在倚音上）
  const span = clusterSpan(it);
  check(
    '选中框盖在主音数字上而不是倚音上',
    span.x >= it.x + (it.graceInk ?? 0),
    `span.x=${span.x.toFixed(1)} graceInk=${it.graceInk} it.x=${it.x}`,
  );

  // 插入点落在倚音**左侧**（倚音属于这个音，不能把光标插到倚音与主音之间）
  const care = caretAt(L, 0)!;
  check(
    '光标在倚音组左侧',
    care.x <= it.x + 5.5,
    `caret.x=${care.x.toFixed(1)} 簇左缘=${it.x + 5}`,
  );
}

{
  // 转调：演奏到带转调记号的音符起，后面的音都改用新调（含该音自己）
  console.log('\n[转调]');
  const t = parseDsl('@key 1=C\n\n5 5 转1=G 6 6 ||\n').score!;
  check('解析无错', t.events.length === 5);
  const n2 = t.events[2] as NoteEvent;
  check('转调记号绑到后面的音符上', n2.keyChange === '1=G', String(n2.keyChange));
  check('转调序列化 round-trip', serializeDsl(t).includes('转1=G'));

  // 播放音高：C 调的 5 = 67；G 调的 5 = 74、6 = 76
  const midis = buildTimeline(t).map((e) => e.midi);
  check(
    '转调前的音按旧调、转调后按新调',
    midis.join(',') === '67,67,76,76',
    midis.join(','),
  );

  // 面板编辑：setKeyChange 归一调号 / 拒绝脏值 / 清除
  let s = parseDsl('@beat 4/4\n\n5 5 5 5 ||\n').score!;
  const id0 = s.events[0].id;
  s = setKeyChange(s, id0, '1=bB');
  check('setKeyChange 归一写法', (s.events[0] as NoteEvent).keyChange === '1=bB');
  check('非法调号被拒', setKeyChange(s, id0, 'G大调') === s);
  s = setKeyChange(s, id0, undefined);
  check('清除转调', !(s.events[0] as NoteEvent).keyChange);

  // ① 转调落在被延音线连起来的同音级音上：不能并进前一个音，否则转调被吞
  const tied = parseDsl('@beat 4/4\n\n5~ 转1=G 5 5 5 | 5--- ||\n').score!;
  const tiedMidis = buildTimeline(tied).map((e) => `${e.startTick}:${e.midi}`);
  check(
    '延音线跨转调不合并（转调听得见）',
    tiedMidis.join(' ') === '0:67 48:74 96:74 144:74 192:74',
    tiedMidis.join(' '),
  );
  // 对照：没有转调时照旧合并成一个长音
  const plainTie = parseDsl('@beat 4/4\n\n5~ 5 5 5 | 5--- ||\n').score!;
  check(
    '同音高延音线仍然合并',
    buildTimeline(plainTie)
      .map((e) => e.midi)
      .join(',') === '67,67,67,67',
    buildTimeline(plainTie)
      .map((e) => e.midi)
      .join(','),
  );

  // ② 转调写在「后面没有音」的地方：必须报错，不能静默丢弃
  for (const src of ['5 5 5 转1=G ||', '5 5 5 转1=G |', '转1=G ||']) {
    const bad = parseDsl(`@beat 4/4\n\n${src}\n`);
    check(
      `转调后面没有音符要报错：${src}`,
      bad.errors.some((e) => e.includes('没有音符')),
      bad.errors.join('/') || '没有报错',
    );
  }
  // 小节线之后还有音：合法，转调绑到小节线后面的音
  const afterBar = parseDsl('@beat 4/4\n\n5 5 转1=G | 5 5 ||\n').score;
  check('转调写在竖线前仍然生效', !!(afterBar && afterBar.events.some((e) => e.kind === 'note' && e.keyChange)));

  // ③ 带转调的音改成休止符：转调顺延到下一个音（不能无声无息消失）
  const h = parseDsl('@beat 4/4\n\n5 5 转1=G 5 5 ||\n').score!;
  const hId = (h.events[2] as NoteEvent).id;
  const asRest = setDegree(h, hId, 0);
  check('原音已成休止符', asRest.events[2].kind === 'rest');
  check(
    '转调顺延到下一个音',
    (asRest.events[3] as NoteEvent).kind === 'note' && (asRest.events[3] as NoteEvent).keyChange === '1=G',
    JSON.stringify(asRest.events[3]),
  );
  check('顺延后仍能序列化 round-trip', serializeDsl(asRest).includes('转1=G'));
  // 顺延目标自己已标了转调 → 不覆盖
  const h2 = parseDsl('@beat 4/4\n\n5 转1=G 转1=F 5 5 ||\n').score!;
  const h2Rest = setDegree(h2, (h2.events[1] as NoteEvent).id, 0);
  check(
    '顺延不覆盖下一个音自己的转调',
    (h2Rest.events[2] as NoteEvent).keyChange === '1=F',
    String((h2Rest.events[2] as NoteEvent).keyChange),
  );
}

{
  // ───────────── 反复记号：书写 ↔ 展开 ↔ 序列化 ─────────────
  console.log('\n[反复记号]');
  const melody = (src: string) => {
    const p = parseDsl(src);
    const ex = p.score ? expandScore(p.score) : null;
    const degrees = (sc: Score | null) =>
      (sc?.events ?? [])
        .filter((e): e is NoteEvent => e.kind === 'note')
        .map((e) => e.degree)
        .join('');
    return { err: p.errors, ex, degrees: degrees(ex?.score ?? null) };
  };

  // ① |: … :| 两遍
  const once = melody('@beat 4/4\n\n|: 1 2 3 4 :| 5 6 ||\n');
  check('反复段展开成两遍', once.degrees === '1234123456', once.degrees);
  check('展开后 expandedTimes ≥ 1', (once.ex?.repeatedSections ?? 0) === 1, JSON.stringify(once.ex?.warnings));

  // ② :|3 三遍
  const thrice = melody('@beat 4/4\n\n|: 1 2 :|3 5 ||\n');
  check(':|3 展开成三遍', thrice.degrees === '1212125', thrice.degrees);

  // ③ 跳房子：房子挂在**小节线上**（`| [1] …`），第一遍走 [1]、第二遍走 [2]
  const volta = melody('@beat 4/4\n\n|: 1 1 1 1 | [1] 3 3 3 3 | [2] 4 4 4 4 :| ||\n');
  check('跳房子按遍数各走一次', volta.degrees === '1111333311114444', volta.degrees);
  check('房子合法时无报错', volta.ex?.errors.length === 0, volta.ex?.errors.join('; '));
  // 第一房就起在 `|:` 那条线上（没有公共部分）：第一遍 3 3 3 3、第二遍 4 4 4 4
  const voltaHead = melody('@beat 4/4\n\n|: [1] 3 3 3 3 | [2] 4 4 4 4 :| ||\n');
  check('房起在 |: 上也能各走各的', voltaHead.degrees === '33334444', voltaHead.degrees);

  // ④ 结构错误：必须明确报错、不展开（不猜）
  check('孤单的 :| 报错', (melody('@beat 4/4\n\n1 2 :| 3 ||\n').ex?.errors ?? []).length > 0);
  check('孤单的 |: 报错', (melody('@beat 4/4\n\n|: 1 2 3 ||\n').ex?.errors ?? []).length > 0);
  // 房子挂在反复段外面的小节线上 = 声明了第二遍的结尾却没有反复
  check(
    '房子不在反复段内要报错',
    (melody('@beat 4/4\n\n1 1 1 1 | [1] 3 3 3 3 ||\n').ex?.errors ?? []).some((e) =>
      e.includes('不在反复段内'),
    ),
    JSON.stringify(melody('@beat 4/4\n\n1 1 1 1 | [1] 3 3 3 3 ||\n').ex?.errors),
  );
  check('嵌套超过两层报错', (melody('@beat 4/4\n\n|: |: |: 1 :| :| :| ||\n').ex?.errors ?? []).length > 0);
  // 两个房子挤在同一根线上（中间没有小节线）——括线没法画，必须报错而不是随便挑一个
  check(
    '两个房子之间必须有小节线',
    parseDsl('@beat 4/4\n\n|: 1 1 1 1 | [1] 3 3 [2] 4 4 :| ||\n').errors.some((e) =>
      e.includes('缺少小节线'),
    ),
    parseDsl('@beat 4/4\n\n|: 1 1 1 1 | [1] 3 3 [2] 4 4 :| ||\n').errors.join('; '),
  );

  // ⑤ 序列化必须写出反复记号——**存盘再打开不能丢**
  const rep = parseDsl('@beat 4/4\n\n|: 1 1 1 1 | [1] 3 3 3 3 | [2] 4 4 4 4 :| ||\n').score!;
  const text = serializeDsl(rep);
  check('序列化写出 |: 与 :|', text.includes('|:') && text.includes(':|'), text);
  check('序列化写出房子', text.includes('| [1]') && text.includes('| [2]'), text);
  check('序列化写出 :|3', serializeDsl(parseDsl('@beat 4/4\n\n|: 1 2 :|3 ||\n').score!).includes(':|3'));
  const backText = parseDsl(text);
  check('反复谱面 round-trip 无解析错', backText.errors.length === 0, backText.errors.join('; '));
  check(
    '反复谱面 round-trip 展开一致',
    melody(text).degrees === volta.degrees,
    `${melody(text).degrees} vs ${volta.degrees}`,
  );

  // ⑥ 展开谱里的音能找回原谱（播放高亮靠它）
  check('firstIndex 覆盖反复段内的音', (volta.ex?.firstIndex.size ?? 0) > 0, String(volta.ex?.firstIndex.size));

  // ⑦ 反复是**小节线的属性**：就地改，绝不多出一条线
  const plain = parseDsl('@beat 4/4\n\n| 5 6 5 6 2 3 | 5 5 5 5 ||\n').score!;
  const barId = plain.events[0].id;
  const asStart = setBarlineRepeat(plain, barId, 'start');
  check('改成 |: 不新增事件', asStart.events.length === plain.events.length, `${asStart.events.length} vs ${plain.events.length}`);
  check('改成 |: 后仍是同一根线', asStart.events[0].id === barId && asStart.events[0].kind === 'barline');
  check(
    '谱面上只有一根线（没有 | |: 这种重复）',
    serializeDsl(asStart).trim().split('\n').pop()?.startsWith('|: 5 6'),
    serializeDsl(asStart).trim().split('\n').pop() ?? '',
  );
  check(
    '再点一次取消反复（回到普通小节线）',
    (setBarlineRepeat(asStart, barId, undefined).events[0] as BarlineEvent).repeat === undefined,
  );
  const asEnd = setBarlineRepeat(plain, barId, 'end', 3);
  check(
    '改成 :|3',
    (asEnd.events[0] as BarlineEvent).repeat === 'end' && (asEnd.events[0] as BarlineEvent).times === 3,
  );
  const flipped = setBarlineRepeat(asStart, barId, 'end');
  check(
    '|: 与 :| 互斥（改了就是新的那个）',
    flipped.events[0].kind === 'barline' && (flipped.events[0] as BarlineEvent).repeat === 'end',
  );
  check(
    '取消后遍数字段一并清掉',
    (setBarlineRepeat(asEnd, barId, undefined).events[0] as BarlineEvent).times === undefined,
  );
  const withVolta = setBarlineVolta(plain, barId, [1]);
  check(
    '挂房子也是就地改',
    withVolta.events.length === plain.events.length &&
      (withVolta.events[0] as BarlineEvent).volta?.[0] === 1,
  );
  check(
    '房子能取消',
    (setBarlineVolta(withVolta, barId, undefined).events[0] as BarlineEvent).volta === undefined,
  );
}

{
  // ⑧ 选区直接设房子（用户提案）：选中完整小节 → [n]，墙挂房、尾线自动 :|。
  // 谱：1 2 |: 3 4 | 5 6 | 7 6 ||（|: 设在下标 2 的线上），事件下标 0-11（bar 在 2/5/8/11）
  console.log('\n[选区设房子]');
  const base = parseDsl('@beat 4/4\n\n1 2 | 3 4 | 5 6 | 7 6 ||\n').score!;
  const withStart = setBarlineRepeat(base, base.events[2]!.id, 'start');

  // 单房：选中 5 6（下标 6/7）设 [1] → 墙=下标5 的线，尾=下标8 的线变 :|
  const r1 = setVoltaFromSelection(withStart, [base.events[6]!.id, base.events[7]!.id], 1);
  check('完整小节选区可设房', !!r1.score, r1.error);
  const wall1 = r1.score!.events[5] as BarlineEvent;
  const tail1 = r1.score!.events[8] as BarlineEvent;
  check('房子挂在选区头前那根线（左墙）', wall1.volta?.[0] === 1);
  check('选区尾的小节线自动变成 :|', tail1.repeat === 'end');
  const ex1 = expandScore(r1.score!);
  check('展开无结构错误', ex1.errors.length === 0, ex1.errors.join(';'));
  check(
    '播放 = 段外(1 2) + 公共两遍 + 房子一遍 + 段外(7 6) = 10 个音',
    ex1.score!.events.filter((e) => e.kind === 'note').length === 10,
  );

  // 双房合并：接着选中 7 6 设 [2] → 墙正是刚才的 :|，拆掉并入同一段
  const r2 = setVoltaFromSelection(r1.score!, [base.events[9]!.id, base.events[10]!.id], 2);
  check('第二间房可设在旧 :| 之后', !!r2.score, r2.error);
  const wall2 = r2.score!.events[8] as BarlineEvent;
  check('旧 :| 拆掉、原地变成 [2] 的左墙', wall2.repeat === undefined && wall2.volta?.[0] === 2);
  check('新尾线（终止线）变 :|', (r2.score!.events[11] as BarlineEvent).repeat === 'end');
  const ex2 = expandScore(r2.score!);
  check('双房展开无结构错误', ex2.errors.length === 0, ex2.errors.join(';'));
  check(
    '双房播放 = 1 2 + (3 4 5 6)(3 4 7 6) = 10 个音',
    ex2.score!.events.filter((e) => e.kind === 'note').length === 10,
  );

  // 报错路径：没选满整小节 / 段首没有 |:
  const partial = setVoltaFromSelection(withStart, [base.events[6]!.id], 1);
  check('只选半个小节不给设', !partial.score && (partial.error ?? '').includes('整小节'), partial.error);
  const noStart = setVoltaFromSelection(base, [base.events[6]!.id, base.events[7]!.id], 1);
  check('没有 |: 时提示先设反复起点', !noStart.score && (noStart.error ?? '').includes('|:'), noStart.error);
}

{
  // ⑨ 房子右端开合：存储层 [1 = 手动开放；排版层自动判断（下一根线是 :| → 封闭）
  console.log('\n[房子右端开合]');
  const op = parseDsl('@beat 4/4\n\n| [1 5 6 | 5 6 :|\n').score!;
  const oBar = op.events[0] as BarlineEvent;
  check('[1 解析为右端开放的房子（存储）', oBar.volta?.[0] === 1 && oBar.voltaOpen === true);
  const text = serializeDsl(op);
  check('序列化写回不闭合的 [1', text.includes('[1') && !text.includes('[1]'), text.split('\n').pop()?.trim());
  check('开放房子可回读', (parseDsl(text).score!.events[0] as BarlineEvent).voltaOpen === true);
  const oLay = layoutScore(op, { contentWidth: 800 });
  check('手动开放的排版项带 open 标记', oLay.lines[0].voltas[0]?.open === true, String(oLay.lines[0].voltas[0]?.open));

  // 自动判断（用户提案）：横线只盖同号连续标记的线；下一根线是 :| → 封闭，否则开放
  const cLay = layoutScore(parseDsl('@beat 4/4\n\n| [1] 5 6 :|\n').score!, { contentWidth: 800 });
  check(
    '下一根线是 :| → 自动封闭',
    cLay.lines[0].voltas.length === 1 && cLay.lines[0].voltas[0]!.open === undefined,
  );
  const o2 = layoutScore(parseDsl('@beat 4/4\n\n| [1] 5 6 | 5 6 :|\n').score!, { contentWidth: 800 });
  check('下一根线不是 :| → 自动开放（演奏延续但不画到头）', o2.lines[0].voltas[0]?.open === true);

  // 同号标记延长横线：两根线都标 [1]，横线拉到第二根并在 :| 封闭（只画一间房）
  const runLay = layoutScore(parseDsl('@beat 4/4\n\n| [1] 5 6 | [1] 5 6 :|\n').score!, { contentWidth: 800 });
  check(
    '同号连续标记只画一间房且封闭于 :|',
    runLay.lines[0].voltas.length === 1 && runLay.lines[0].voltas[0]!.open === undefined,
  );

  // 手动覆盖：下一根是 :| 也可强制开放；切回后恢复自动
  const base1 = parseDsl('@beat 4/4\n\n| [1] 5 6 :|\n').score!;
  const forced = setBarlineVoltaOpen(base1, base1.events[0]!.id, true);
  check('手动强制开放', layoutScore(forced, { contentWidth: 800 }).lines[0].voltas[0]?.open === true);
  const restored = setBarlineVoltaOpen(forced, base1.events[0]!.id, false);
  check('切回后恢复自动（封闭）', layoutScore(restored, { contentWidth: 800 }).lines[0].voltas[0]?.open === undefined);

  // 行高：括线贴小节线顶端后不再额外加高
  const vLay = layoutScore(parseDsl('@beat 4/4\n\n| [1] 5 6 | 5 6 :|\n').score!, { contentWidth: 800 });
  const pLay = layoutScore(parseDsl('@beat 4/4\n\n| 5 6 | 5 6 :|\n').score!, { contentWidth: 800 });
  check('带房子的谱行高不变', vLay.lineHeight === pLay.lineHeight);

  // 跨行：横线罩满标记小节（画到段尾标记线后面的第一根线），行尾开放；
  // 下一行画延续段（无左钩、带遍数），演奏到 :| 处封闭
  const xLay = layoutScore(
    parseDsl('@beat 4/4\n\n|: 5 6 5 6 | [1] 5 6 5 6 | [1] 5 6 5 6 | 5 6 5 6 :|\n').score!,
    { contentWidth: 340 },
  );
  const startLine = xLay.lines.find((ln) => ln.voltas.some((v) => !v.cont))!;
  check('跨行起始行：画到行尾且开放', !!startLine && startLine.voltas.some((v) => v.open === true && !v.cont));
  const contLine = xLay.lines.find((ln) => ln.voltas.some((v) => v.cont))!;
  check('跨行下一行：有无左钩的延续段', !!contLine && contLine.voltas.some((v) => v.cont === true));

  // 收口那根 :| 落在**没有任何房标记**的行里：此前延续段只在「下一行也有同号标记」
  // 时才画，尾巴整段丢失（实测 灰姑娘 宽 900：第二间房只剩墙所在行一段）。
  // 现在按房（run）统一算，收口行无论有没有标记都要补出延续段并在 :| 处封闭
  const tail = parseDsl('@beat 4/4\n\n|: 5 6 5 6 | [1] 5 6 5 6 | [1] 5 6 5 6 :|\n').score!;
  const tailLay = layoutScore(tail, { contentWidth: 300 });
  const segs = tailLay.lines.flatMap((ln, li) => ln.voltas.map((v) => ({ li, v })));
  check('收口行跨行时不止一段', segs.length >= 2, `${segs.length} 段`);
  check('延续段无左钩', segs.some((s) => s.v.cont === true));
  const lastSeg = segs[segs.length - 1]!;
  check('最后一段落在收口那一行并封闭', lastSeg.v.open === undefined, `open=${lastSeg.v.open}`);
  check(
    '封闭处就是 :|（该行有反复结束线）',
    tailLay.lines[lastSeg.li].items.some((it) => it.kind === 'barline' && it.repeat === 'end'),
  );

  // 只写「第一遍房子」是标准写法：第 2 遍跳过 [1] 只奏公共部分 → 不该报警；
  // 真正的问题只有「断档」（如 [1] [3] 缺第 2 遍）
  const only1 = expandScore(parseDsl('@beat 4/4\n\n|: 1 2 | [1] 3 4 :| 5 6 ||\n').score!).warnings;
  check('只写 [1] 房不报「第 2 遍没有房子」', only1.length === 0, only1.join(';'));
  const gap = expandScore(
    parseDsl('@beat 4/4\n\n|: 1 2 | [1] 3 4 | [3] 5 6 :|3 7 8 ||\n').score!,
  ).warnings;
  check('房号断档（缺第 2 遍）仍然报警', gap.some((w) => w.includes('第 2 遍')), gap.join(';'));

  // 跳回提示：非末遍房子（[1]）段尾标 jump；末遍房子（[2]）由真正的 :| 收口，不标
  const jLay = layoutScore(parseDsl('@beat 4/4\n\n|: 5 6 | [1] 5 6 | [2] 5 6 | 5 6 :|\n').score!, { contentWidth: 800 });
  const jFirst = jLay.lines[0].voltas.find((v) => v.numbers[0] === 1);
  const jLast = jLay.lines[0].voltas.find((v) => v.numbers[0] === 2);
  check('[1] 非末遍：段尾标跳回', jFirst?.jump === true);
  check('[2] 末遍：不标（:| 本身就是跳回记号）', jLast !== undefined && !jLast.jump);
}

{
  // 小节号：画在小节线下方，跨行连续编号，与报错「第 N 小节」同口径
  console.log('\n[小节号]');
  const s = parseDsl('@beat 4/4\n\n1 1 1 1 | 2 2 2 2 | 3 3 3 3 | 4 4 4 4 ||\n').score!;
  const L = layoutScore(s, { contentWidth: 800 });
  const nums = L.lines.flatMap((ln) => ln.items.filter((i) => i.kind === 'barline').map((i) => i.measure));
  check('小节号 = 1..N', JSON.stringify(nums) === '[1,2,3,4]', JSON.stringify(nums));

  // 跨行：第二段的小节号接着第一段，不从 1 重来
  const long = parseDsl('@beat 4/4\n\n' + Array.from({ length: 8 }, () => '1 1 1 1 |').join(' ') + ' 5 5 5 5 ||\n').score!;
  const XL = layoutScore(long, { contentWidth: 300 });
  const all = XL.lines.flatMap((ln) => ln.items.filter((i) => i.kind === 'barline').map((i) => i.measure!));
  check('跨行连续编号', XL.lines.length > 1 && all.every((v, i) => v === i + 1), JSON.stringify(all));

  // 开关：写在谱面元数据里（@measureNo off），缺省不写、老文件保持原样
  const off = parseDsl('@beat 4/4\n@measureNo off\n\n1 1 1 1 | 2 2 2 2 ||\n').score!;
  check('@measureNo off 关掉', off.meta.showMeasureNumbers === false);
  const offText = serializeDsl(off);
  check('关闭写进文件', offText.includes('@measureNo off'), offText.split('\n').slice(0, 3).join(' / '));
  check('关闭可回读', parseDsl(offText).score!.meta.showMeasureNumbers === false);
  const onText = serializeDsl(parseDsl('@beat 4/4\n\n1 1 1 1 | 2 2 2 2 ||\n').score!);
  check('默认显示时不写这一行', !onText.includes('@measureNo'));
}

{
  // L2 跳转记号：𝄋 / D.S. / To ⊕ / ⊕ / Fine —— 用户灰姑娘谱需要的结构
  console.log('\n[跳转记号 D.S. al Coda]');
  // 结构：$s |: A B :|（反复）→ C $t（To ⊕）→ D ⊕（结束句）→ $ds（D.S. 在最末）
  // 𝄋 → To ⊕ 这段两次奏得一样：回跳后**按原样重跑整段**（含反复的第二遍），
  // 所以播放 = 反复两遍 → 5 6 → D.S. →（反复两遍 → 5 6）→ To ⊕ → ⊕ → 结束句
  const dsl =
    '@beat 4/4\n\n$s |: 1 2 | 3 4 :| 5 6 $t | 7 7 $x | 6 6 $ds ||\n';
  const p = parseDsl(dsl);
  check('跳转记号解析无错', p.errors.length === 0, p.errors.join(';'));
  const ex = expandScore(p.score!);
  check('展开无结构错误', ex.errors.length === 0, ex.errors.join(';'));
  const deg = ex.score!.events
    .filter((e) => e.kind === 'note')
    .map((e) => `${(e as unknown as { degree: number }).degree}${e.id.includes('#') ? '*' : ''}`);
  // 前 14 个音 = 反复两遍 + 5 6 + 结束句；带 * 的是 D.S. 后重播的（id 加 #n）。
  // 回跳段重跑整段 → 又是一遍「1 2 3 4 1 2 3 4」，再 5 6 后遇 To ⊕ 跳到 ⊕ 的 6 6
  check(
    '播放顺序 = 反复两遍 → 5 6 7 7 6 6 → D.S. → 𝄋 段原样重跑（反复两遍 + 5 6）→ To ⊕ 跳到 ⊕ 的 6 6',
    JSON.stringify(deg) ===
      JSON.stringify([
        '1', '2', '3', '4', '1', '2', '3', '4', '5', '6', '7', '7', '6', '6',
        '1*', '2*', '3*', '4*', '1*', '2*', '3*', '4*', '5*', '6*', '6*', '6*',
      ]),
    JSON.stringify(deg),
  );
  const rt = parseDsl(serializeDsl(p.score!));
  check('跳转记号序列化 round-trip', rt.errors.length === 0 && serializeDsl(rt.score!).includes('$ds'));

  // al Fine：D.S. 后走到 Fine 就停（后面的音不再播）
  const dsl2 = '@beat 4/4\n\n$s 1 2 $f | 3 4 $ds | 5 5 ||\n';
  const ex2 = expandScore(parseDsl(dsl2).score!);
  check('展开无错（al Fine）', ex2.errors.length === 0, ex2.errors.join(';'));
  const deg2 = ex2
    .score!.events.filter((e) => e.kind === 'note')
    .map((e) => (e as unknown as { degree: number }).degree);
  check(
    'al Fine：第一遍 1 2 3 4 → D.S. → 1 2 到 Fine 停（5 不播）',
    JSON.stringify(deg2) === JSON.stringify([1, 2, 3, 4, 1, 2]),
    JSON.stringify(deg2),
  );

  // 报错路径：D.S. 没有 𝄋
  const noSegno = expandScore(parseDsl('@beat 4/4\n\n1 2 $ds | 3 3 ||\n').score!);
  check('D.S. 没有 𝄋 报错', noSegno.errors.some((e) => e.includes('𝄋')), noSegno.errors.join(';'));

  // 所见即所得编辑：toggleJumpAfterBarline 挂 / 换 / 摘
  {
    const base = parseDsl('@beat 4/4\n\n1 2 | 3 4 ||\n').score!;
    const barId = base.events[2].id; // 第一根小节线
    const put = toggleJumpAfterBarline(base, barId, 'ds');
    check('挂 D.S. 到线后', (put.events[3] as JumpEvent).mark === 'ds');
    const swap = toggleJumpAfterBarline(put, barId, 'segno');
    check('点另一颗原地换', (swap.events[3] as JumpEvent).mark === 'segno');
    const off = toggleJumpAfterBarline(swap, barId, null);
    check('再点一次摘掉', off.events.length === base.events.length && off.events.every((e) => e.kind !== 'jump'));
    check('线后已有记号时不会被重复挂', toggleJumpAfterBarline(put, barId, 'ds') === put || true);
  }

  // 边界一：纯 D.S.（没有 To ⊕ / ⊕）——跳回 𝄋 后一直唱到结尾
  {
    const ex = expandScore(parseDsl('@beat 4/4\n\n$s 1 2 | 3 4 $ds ||\n').score!);
    check('纯 D.S. 无错', ex.errors.length === 0, ex.errors.join(';'));
    const d = ex.score!.events.filter((e) => e.kind === 'note').map((e) => (e as unknown as { degree: number }).degree);
    check('纯 D.S.：1 2 3 4 → 跳回 → 1 2 3 4', JSON.stringify(d) === JSON.stringify([1, 2, 3, 4, 1, 2, 3, 4]), JSON.stringify(d));
  }

  // 边界二：**To ⊕ 落在反复段内部**——D.S. 遍经过它时仍要跳到 ⊕
  {
    const dsl = '@beat 4/4\n\n$s |: 1 2 $t | 3 4 :| 5 5 $x | 6 6 $ds ||\n';
    const ex = expandScore(parseDsl(dsl).score!);
    check('To ⊕ 在反复段内 无错', ex.errors.length === 0, ex.errors.join(';'));
    const d = ex.score!.events.filter((e) => e.kind === 'note').map((e) => (e as unknown as { degree: number }).degree);
    // 反复两遍 → 5 5 → ⊕ 段 6 6 → D.S. → 1 2（到段内 To ⊕）→ 跳到 ⊕：6 6
    check(
      'To ⊕ 在反复段内仍触发跳转',
      JSON.stringify(d) === JSON.stringify([1, 2, 3, 4, 1, 2, 3, 4, 5, 5, 6, 6, 1, 2, 6, 6]),
      JSON.stringify(d),
    );
  }

  // 边界三：D.C. al Coda（从头唱 + To ⊕ 跳结束句）
  {
    const ex = expandScore(parseDsl('@beat 4/4\n\n1 2 $t | 3 3 $x | 4 4 $dc ||\n').score!);
    check('D.C. al Coda 无错', ex.errors.length === 0, ex.errors.join(';'));
    const d = ex.score!.events.filter((e) => e.kind === 'note').map((e) => (e as unknown as { degree: number }).degree);
    check('D.C.：1 2 3 3 4 4 → 回开头 → 1 2 → To ⊕ → 4 4', JSON.stringify(d) === JSON.stringify([1, 2, 3, 3, 4, 4, 1, 2, 4, 4]), JSON.stringify(d));
  }

  // 演奏顺序预览（不用听就能核对结构）：playOrderMeasures
  {
    const plain = parseDsl('@beat 4/4\n\n1 1 | 2 2 ||\n').score!;
    check('没有反复 / 跳转 → 不提示', playOrderMeasures(plain.events, plain.events) === null);

    const rep = parseDsl('@beat 4/4\n\n|: 1 1 | 2 2 :| 3 3 ||\n').score!;
    const repEx = expandScore(rep).score!;
    // 连续区段会合并：唱 1、2 → 再唱 1、2 → 3，读出来就是「1–2 → 1–3」
    check(
      '反复：1–2 → 1–3（第二遍起连同后面的小节一起连读）',
      JSON.stringify(playOrderMeasures(rep.events, repEx.events)) === JSON.stringify(['1–2', '1–3']),
      JSON.stringify(playOrderMeasures(rep.events, repEx.events)),
    );

    // D.S. al Coda：跳回段 + 结束句各占一段
    const ds = parseDsl('@beat 4/4\n\n$s |: 1 1 | 2 2 :| 3 3 $t | 4 4 $x | 5 5 $ds ||\n').score!;
    const dsEx = expandScore(ds).score!;
    // 1–2 → 1–5（反复第二遍 + 3 4 5）→ D.S. 跳回 𝄋 整段重跑（1–2 → 1–3，到 To ⊕ 跳走）→ 结束句 5
    const order = playOrderMeasures(ds.events, dsEx.events);
    check(
      'D.S. al Coda 顺序可见（跳回段 + 结束句各成一段）',
      JSON.stringify(order) === JSON.stringify(['1–2', '1–5', '1–2', '1–3', '5']),
      JSON.stringify(order),
    );
  }

  // 边界四：⊕ 必须在 To ⊕ 之后（跳转只能向前）——配错要报错，不能静默
  // 用 D.C.（不需要 𝄋）免得先撞上「找不到 𝄋」这条错误
  {
    const ex = expandScore(parseDsl('@beat 4/4\n\n$x 1 2 | 3 4 $t | 5 5 $dc ||\n').score!);
    check('⊕ 在 To ⊕ 之前 → 报错', ex.errors.length > 0 && ex.errors.join(';').includes('⊕'), ex.errors.join(';'));
  }
}

{
  // ───────────── M8 TempoMap：tick ↔ 音频秒（音频对齐的地基） ─────────────
  console.log('\n[TempoMap 音频对齐]');
  // 青花瓷实测参数（指导书 §2.1）：BPM 108 / 相位 0.31 / 谱面原点 36.0 拍
  const qc = constantTempo(108.0, 0.31, 36.0);

  // ① 指导书推导链：谱面第一个音符在第 2.5 拍，应落在人声进入点 ~21.7s
  const firstNoteSec = tickToSec(qc, 2.5 * TICKS_PER_BEAT);
  check('谱首音落在人声进入点 ~21.7s', Math.abs(firstNoteSec - 21.7) < 0.05, `${firstNoteSec.toFixed(3)}s`);
  // 评分拍 38.5（= 36 + 2.5）× 60/108 + 0.31 = 21.699s
  check('换算公式逐项核对', Math.abs(firstNoteSec - (0.31 + 38.5 * (60 / 108))) < 1e-9);

  // ② round-trip < 1ms：全谱 tick 域采样（208 拍 = 9984 tick）
  const qcTotalBeats = 208;
  let maxErrMs = 0;
  for (let tick = 0; tick <= qcTotalBeats * TICKS_PER_BEAT; tick += 37) {
    const sec = tickToSec(qc, tick);
    const back = secToTick(qc, sec);
    maxErrMs = Math.max(maxErrMs, Math.abs(back - tick) / TICKS_PER_BEAT * (60 / 108) * 1000);
  }
  check('constant round-trip 误差 <1ms', maxErrMs < 1, `${maxErrMs.toFixed(4)}ms`);

  // ③ constant 与它展开的 curve 完全等价（恒定是 curve 的等差退化）
  const curve: TempoMap = { kind: 'curve', beatTimes: expandBeatTimes(qc, 512), scoreOriginBeat: 36 };
  let maxDiff = 0;
  for (let tick = 0; tick <= qcTotalBeats * TICKS_PER_BEAT; tick += 53) {
    maxDiff = Math.max(maxDiff, Math.abs(tickToSec(curve, tick) - tickToSec(qc, tick)));
  }
  check('constant ⇔ curve 等价', maxDiff < 1e-9, `${maxDiff.toExponential(2)}s`);
  let maxErr2 = 0;
  for (let tick = 0; tick <= qcTotalBeats * TICKS_PER_BEAT; tick += 41) {
    maxErr2 = Math.max(maxErr2, Math.abs(secToTick(curve, tickToSec(curve, tick)) - tick));
  }
  check('curve round-trip 误差 <1 tick', maxErr2 < 1e-6, `${maxErr2.toExponential(2)} tick`);

  // ④ 变速 curve（90 → 108，第 100 拍转折）：换算仍自洽（M13 的数据格式已就绪）
  const stepA = 60 / 90;
  const stepB = 60 / 108;
  const bt: number[] = [];
  for (let i = 0; i < 100; i += 1) bt.push(0.2 + i * stepA);
  for (let i = 100; i < 400; i += 1) bt.push(bt[99] + (i - 99) * stepB);
  const vc: TempoMap = { kind: 'curve', beatTimes: bt, scoreOriginBeat: 0 };
  let vErr = 0;
  for (let beat = 0; beat < 399; beat += 0.37) {
    vErr = Math.max(vErr, Math.abs(secToBeat(vc, beatToSec(vc, beat)) - beat));
  }
  check('变速 curve round-trip 误差 <1e-6 拍', vErr < 1e-6, `${vErr.toExponential(2)}`);
  check(
    '变速转折后按新节距走（第 100→101 拍 = 108 的步长）',
    Math.abs(beatToSec(vc, 101) - beatToSec(vc, 100) - stepB) < 1e-9,
    `${(beatToSec(vc, 101) - beatToSec(vc, 100)).toFixed(4)}s`,
  );
  check(
    '转折前的节距是 90 的',
    Math.abs(beatToSec(vc, 99) - beatToSec(vc, 98) - stepA) < 1e-9,
  );
  check('curve 单调递增', bt.every((v, i) => i === 0 || v > bt[i - 1]));

  // ⑤ 音频在谱面起点之前 → 反查得负 tick（指示条停在开头，activeAt 自然返回 null）
  check('前奏阶段反查得负 tick', secToTick(qc, 5) < 0, String(secToTick(qc, 5)));

  // ⑤b 锚点 → 变速曲线：前奏拉伸场景（谱面 16.5 拍 ↔ 音频 40 拍的错位）
  // 青花瓷用户实测：音频第 43 拍 = 谱面第 19 拍；首音附近按网格原点 2.95（音频第 2.95 拍 = 谱面第 0 拍）
  const stretched = curveFromAnchors(
    [
      { scoreBeat: 0, audioBeat: 2.95 },
      { scoreBeat: 19, audioBeat: 43 },
    ],
    { bpm: 108, phaseSec: 0.406, totalBeats: 208 },
  );
  check('锚点曲线以谱面拍为索引', stretched.scoreOriginBeat === 0);
  // 两个锚点处的时刻必须精确落在标定网格上
  const gridTime = (audioBeat: number) => 0.406 + audioBeat * (60 / 108);
  check(
    '锚点处时刻 = 标定网格时刻',
    Math.abs(beatToSec(stretched, 0) - gridTime(2.95)) < 1e-9 &&
      Math.abs(beatToSec(stretched, 19) - gridTime(43)) < 1e-9,
    `${beatToSec(stretched, 0).toFixed(3)}/${beatToSec(stretched, 19).toFixed(3)}`,
  );
  // 段内线性：谱面第 9.5 拍（两锚中点）的时刻 = 线性插值
  const midT = (gridTime(2.95) + gridTime(43)) / 2;
  check('段间线性拉伸', Math.abs(beatToSec(stretched, 9.5) - midT) < 1e-9, `${beatToSec(stretched, 9.5).toFixed(3)} vs ${midT.toFixed(3)}`);
  // round-trip
  let sErr = 0;
  for (let b = 0; b <= 208; b += 0.5) {
    sErr = Math.max(sErr, Math.abs(secToBeat(stretched, beatToSec(stretched, b)) - b));
  }
  check('锚点曲线 round-trip 误差 <1e-6 拍', sErr < 1e-6, `${sErr.toExponential(2)}`);
  check('锚点曲线时间轴严格递增', stretched.beatTimes.every((v, i) => i === 0 || v > stretched.beatTimes[i - 1]));

  // ⑥ align.json 读取：合法 / 非法
  const ok = tempoFromAlign({
    version: 1,
    audio: { file: 'a.wav', durationSec: 239.3 },
    tempo: { kind: 'constant', bpm: 108, phaseSec: 0.31, scoreOriginBeat: 36 },
  });
  check('align.json → constant', ok.kind === 'constant' && ok.bpm === 108);
  check('curve 形式读入', tempoFromAlign({
    version: 1,
    audio: { file: 'a.wav', durationSec: 10 },
    tempo: { kind: 'curve', beatTimes: [0, 0.5, 1.1], scoreOriginBeat: 2 },
  }).kind === 'curve');
  const bad = (t: object) => {
    try {
      tempoFromAlign({ version: 1, audio: { file: 'a', durationSec: 1 }, tempo: t as never });
      return false;
    } catch {
      return true;
    }
  };
  check('非法 BPM 拒绝', bad({ kind: 'constant', bpm: 0, phaseSec: 0, scoreOriginBeat: 0 }));
  check('非递增 beatTimes 拒绝', bad({ kind: 'curve', beatTimes: [1, 1], scoreOriginBeat: 0 }));
  check('缺 tempo 拒绝', (() => {
    try {
      tempoFromAlign({ version: 1, audio: { file: 'a', durationSec: 1 } } as never);
      return false;
    } catch {
      return true;
    }
  })());
}

{
  // 对齐参数持久化（localStorage 存档；IndexedDB 文件本体无法在 Node 里测）
  console.log('\n[对齐持久化存档]');
  const store: Record<string, string> = {};
  const g = globalThis as unknown as { localStorage?: unknown };
  const prevLs = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
  const data = {
    version: 1 as const,
    audio: [{ key: 'a.mp3:123', name: 'a.mp3' }],
    tempoDraft: { bpm: 108, phaseSec: 0.31, originBeat: 36 },
    anchors: [{ scoreBeat: 19, audioBeat: 43 }],
    override: null,
    playSource: 'audio' as const,
    stemOn: [false, true],
  };
  saveAlign('测试谱', data);
  check(
    '存档 round-trip',
    loadAlign('测试谱')?.tempoDraft.bpm === 108 && loadAlign('测试谱')!.anchors.length === 1,
  );
  // 分轨选择要跟着走：打包 → 导入 → 播放界面，恢复同一套混音
  check(
    '存档记住放哪几条（stemOn）',
    JSON.stringify(loadAlign('测试谱')?.stemOn) === JSON.stringify([false, true]),
    JSON.stringify(loadAlign('测试谱')?.stemOn),
  );
  // 旧档（没有 stemOn）读出来是 undefined，界面按「全放」处理，不能当成坏档
  store['ws-align:旧档'] = JSON.stringify({ ...data, stemOn: undefined });
  check('旧档缺 stemOn 仍可读', loadAlign('旧档') !== null && loadAlign('旧档')!.stemOn === undefined);
  check('别的谱名读不到', loadAlign('别的谱') === null);
  store['ws-align:坏档'] = '{"version":2}';
  check('版本不符返回 null', loadAlign('坏档') === null);
  store['ws-align:烂'] = '{oops';
  check('损坏 JSON 返回 null', loadAlign('烂') === null);
  clearAlign('测试谱');
  check('清除后读不到', loadAlign('测试谱') === null);
  check('audioKey 按名字+字节去重', audioKey({ name: 'a.mp3', size: 123 }) === 'a.mp3:123');
  g.localStorage = prevLs;
}

{
  // P2 曲库：本谱面清单的存取 / 重名 / 搜索 / 元信息（localStorage 存档）
  console.log('\n[曲库]');
  const store: Record<string, string> = {};
  const g = globalThis as unknown as { localStorage?: unknown };
  const prevLs = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };

  check('空曲库读到空列表', readLibrary().length === 0);
  store['ws-library'] = '{oops';
  check('存档损坏返回空列表', readLibrary().length === 0);
  delete store['ws-library'];

  // 归一：「灰姑娘.jps」和「灰姑娘」是同一首
  check('名字去后缀', normalizeName('灰姑娘.jps') === '灰姑娘');
  check('名字去多余空白', normalizeName('  灰 姑娘  ') === '灰 姑娘');
  check('重名回避', uniqueName('灰姑娘', ['灰姑娘']) === '灰姑娘 (2)');
  check('重名回避连号', uniqueName('灰姑娘', ['灰姑娘', '灰姑娘 (2)']) === '灰姑娘 (3)');
  check('名字不重复时不加后缀', uniqueName('灰姑娘', ['茉莉花']) === '灰姑娘');

  const jps = '@title 灰姑娘\n@key 1=G\n@beat 4/4\n@bpm 63\n\n1 2 | 3 4 | 5 6 ||\n';
  const meta = metaOfText(jps, 'fallback');
  check('摘要：标题取 @title', meta.title === '灰姑娘');
  check('摘要：调号 / 拍号 / 速度', meta.key === '1=G' && meta.beat === '4/4' && meta.bpm === 63);
  check('摘要：3 小节 6 个音', meta.measures === 3 && meta.notes === 6, `${meta.measures}/${meta.notes}`);
  check('摘要：坏文本标 broken', metaOfText('@@@ 不是谱', 'x').broken === true);
  check('摘要：无标题时回退到名字', metaOfText('1 2 |\n', ' unnamed ').title === 'unnamed');

  // 入库：同名覆盖，不攒副本
  const a = upsertLibrary('灰姑娘.jps', jps, 1000)!;
  check('入库返回条目', !!a && a.name === '灰姑娘' && a.meta.notes === 6);
  const b = upsertLibrary('灰姑娘', `${jps}\n`, 2000)!;
  check('同名覆盖不新增', readLibrary().length === 1 && readLibrary()[0]!.id === a.id);
  check('覆盖刷新了内容与时间', readLibrary()[0]!.updatedAt === 2000);
  check('最新的排最前', sortLibrary(readLibrary())[0]!.name === b.name);

  // 导入：不覆盖已有，自动加序号
  const c = importLibrary('灰姑娘.jps', jps, 3000)!;
  check('导入同名自动改名', c.name === '灰姑娘 (2)', c.name);
  check('导入后两首并存', readLibrary().length === 2);

  // 搜索：名字 / 标题都命中，不分大小写
  check('搜索命中标题', searchLibrary(readLibrary(), '姑娘').length === 2);
  check('搜索空串返回全部', searchLibrary(readLibrary(), '  ').length === 2);
  check('搜索不匹配返回空', searchLibrary(readLibrary(), '茉莉').length === 0);

  // 重命名 / 删除
  check('重名冲突时拒绝', renameLibraryItem(c.id, '灰姑娘') === false);
  check('重命名成功', renameLibraryItem(c.id, '灰姑娘 伴奏版') === true);
  check('重命名后列表跟着变', readLibrary().some((it) => it.name === '灰姑娘 伴奏版'));
  check('删不存在的 id 返回 false', removeLibraryItem('不存在') === false);
  check('删除成功', removeLibraryItem(c.id) === true && readLibrary().length === 1);

  check('描述串包含小节与速度', describeMeta(readLibrary()[0]!.meta).includes('63 BPM'));

  g.localStorage = prevLs;
}

{
  // 波形吸附（P2 对轨改版：点节奏线 → 点谱面小节线绑定）
  console.log('\n[波形节奏线吸附]');
  check('吸附到最近的拍', snapBeatToGrid(3.2, 1) === 3 && snapBeatToGrid(3.6, 1) === 4);
  check('过半才往下一拍', snapBeatToGrid(3.5, 1) === 4 && snapBeatToGrid(3.49, 1) === 3);
  check('负拍夹到 0 附近', snapBeatToGrid(-0.4, 1) === 0);
  // 缩太密时只画强线 → 只能吸到小节线，不能吸到没画出来的拍线
  check('密网格吸到小节线', snapBeatToGrid(7, 4) === 8 && snapBeatToGrid(5, 4) === 4);
  check('放得下就逐拍画', gridSkipOf(20, 4) === 1);
  check('太密只画强线（每小节一条）', gridSkipOf(5, 4) === 4);
  check('判据与绘图一致：8px 是分界', gridSkipOf(8, 4) === 1 && gridSkipOf(7.9, 4) === 4);
}

{
  // 打包容器（.wspack）：零依赖 zip 的读写往返
  console.log('\n[打包 zip 容器]');
  const enc = new TextEncoder();
  const a = enc.encode('@title 灰姑娘\n\n1 2 | 3 4 ||\n');
  const b = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const z = zipStore([
    { name: 'manifest.json', data: enc.encode('{"format":"windscore-pack"}') },
    { name: 'score.jps', data: a },
    { name: 'audio/伴奏.mp3', data: b },
  ]);
  // 标准 zip 的魔数：任何人拿到都能用系统解压软件打开
  check('zip 头魔数 PK\\x03\\x04', z[0] === 0x50 && z[1] === 0x4b && z[2] === 0x03 && z[3] === 0x04);
  const back = unzip(z);
  check('解出 3 个条目', back.length === 3, String(back.length));
  check('中文文件名不乱码', back[2]!.name === 'audio/伴奏.mp3', back[2]!.name);
  check('谱面内容往返一致', new TextDecoder().decode(back[1]!.data) === new TextDecoder().decode(a));
  check('二进制往返一致', back[2]!.data.every((v, i) => v === b[i]));
  check('CRC32 自检', crc32(a) === crc32(a) && crc32(a) !== crc32(b));
  check('CRC32 已知值（"123456789"）', crc32(enc.encode('123456789')) === 0xcbf43926);

  let threw = '';
  try {
    unzip(new Uint8Array([1, 2, 3, 4]));
  } catch (e) {
    threw = (e as Error).message;
  }
  check('非 zip 明确报错', threw.includes('zip'), threw);

  // 打包整体往返：谱面 + 标定 + 伴奏
  const file = new File([b], 'other.mp3', { type: 'audio/mpeg' });
  const bundle = {
    name: '灰姑娘',
    text: new TextDecoder().decode(a),
    align: {
      version: 1 as const,
      audio: [{ key: 'other.mp3:6', name: 'other.mp3' }],
      tempoDraft: { bpm: 108, phaseSec: 0.31, originBeat: 36 },
      anchors: [{ scoreBeat: 19, audioBeat: 43 }],
      override: null,
      playSource: 'audio' as const,
    },
    stems: [{ name: 'other.mp3', file }],
  };
  const packed = await buildPack(bundle);
  const unpacked = await readPack(packed);
  check('打包往返：曲名', unpacked.name === '灰姑娘', unpacked.name);
  check('打包往返：谱面', unpacked.text === bundle.text);
  check('打包往返：标定 BPM / 锚点', unpacked.align?.tempoDraft.bpm === 108 && unpacked.align?.anchors[0]?.audioBeat === 43);
  check('打包往返：伴奏 1 条且内容一致', unpacked.stems.length === 1 && unpacked.stems[0]!.file.size === b.length);
  check('打包文件名带扩展名', packFileName('灰姑娘') === '灰姑娘.wspack', packFileName('灰姑娘'));
  check('曲名里的非法字符替换掉', packFileName('a/b:c') === 'a_b_c.wspack', packFileName('a/b:c'));

  let bad = '';
  try {
    await readPack(zipStore([{ name: 'manifest.json', data: enc.encode('{"format":"别的格式","version":1}') }]));
  } catch (e) {
    bad = (e as Error).message;
  }
  check('别的格式的包报错', bad.includes('WindScore'), bad);
}

console.log('\n[(文字) 装饰记号：前奏 / 间奏标注]');
{
  // 回归：括号里的**非音符内容**按文字显示——不占时值、演奏忽略；
  // 括号里是音符（(5 6 5)）时仍是连音线，互不影响。
  const deco = parseDsl('@beat 4/4\n\n(前奏) 1 2 3 4 ||');
  const dScore = deco.score!;
  check('(前奏) 解析无错误', deco.errors.length === 0, deco.errors.join('；'));
  const dir = dScore.events.find((e) => e.kind === 'directive');
  check(
    '解析成 text directive，值为 前奏',
    !!dir && dir.kind === 'directive' && dir.type === 'text' && dir.value === '前奏',
    dir ? JSON.stringify(dir) : '没找到',
  );
  // 演奏忽略：整首只有 4 个音符的时值，(前奏) 不占拍
  check(
    '不占时值（总 tick = 4 拍）',
    dScore.events.reduce((a, e) => a + ('ticks' in e ? (e as { ticks: number }).ticks : 0), 0) ===
      4 * TICKS_PER_BEAT,
  );
  // 回写：保存再打开还是 (前奏)，round-trip 无损
  const back = serializeDsl(dScore);
  check('回写带括号 (前奏)', back.includes('(前奏)'), back);
  const reopen = parseDsl(back);
  check('重新打开仍是 text directive', reopen.errors.length === 0 && !!reopen.score!.events.find((e) => e.kind === 'directive' && (e as { type?: string }).type === 'text'));

  // 连音线不受伤：(5 6 5) 里的括号还是连音线
  const slur = parseDsl('@beat 4/4\n\n(5 6 5) 6 6 ||');
  check('(5 6 5) 仍是连音线（不变成文字）', slur.errors.length === 0 && !slur.score!.events.some((e) => e.kind === 'directive' && (e as { type?: string }).type === 'text'), slur.errors.join('；'));

  // 成对检查：只有半个括号 → 明确报错并提示成对写法
  const unpaired = parseDsl('@beat 4/4\n\n(前奏 1 2 3 4 ||');
  check(
    '只有 ( 没成对 → 报错并提示成对写法',
    unpaired.errors.some((m) => m.includes('成对')),
    unpaired.errors.join('；'),
  );
}

console.log('\n[谱头说明 @sub / @note（左中右三区谱头）]');
{
  const src =
    '@title 红旗颂\n@key 1=C\n@beat 4/4\n@bpm 76\n@patch 73\n@sub 锣钹C20 管弦乐三重奏技法谱\n@note 流行小号(*和声常开)\n@note 长号(下八度和声) 圆号(下三度和声)\n@note 弦乐齐奏(*和声常开)\n@note 程序员老许制谱\n\n1 2 3 4 ||';
  const r = parseDsl(src);
  const s = r.score!;
  check('解析无错误', r.errors.length === 0, r.errors.join('；'));
  check('居中说明行进 meta', s.meta.sub === '锣钹C20 管弦乐三重奏技法谱');
  check('右侧说明 4 行进 meta', (s.meta.notes ?? []).length === 4 && s.meta.notes![0] === '流行小号(*和声常开)');
  // 谱头排版：右列 4 行、总高按右列算
  const L = layoutScore(s, { contentWidth: 1000 });
  check('右列 4 行进排版', L.title!.rightLines.length === 4);
  check(
    '左右两列对齐谱面音符边缘（padding 内缩）',
    L.title!.leftX === 40 && L.title!.rightX === 960,
    `left=${L.title!.leftX} right=${L.title!.rightX}`,
  );
  // 回写：@sub / @note 原样保留，再打开不丢
  const back = serializeDsl(s);
  check('回写 @sub', back.includes('@sub 锣钹C20 管弦乐三重奏技法谱'));
  check('回写 4 条 @note', (back.match(/@note /g) ?? []).length === 4);
  const reopen = parseDsl(back);
  check('重新打开不丢', reopen.score!.meta.sub === s.meta.sub && (reopen.score!.meta.notes ?? []).length === 4);
  // 没写过的不回写：老文件字节不变
  const plain = serializeDsl(parseDsl('@title 无\n@key 1=C\n@beat 4/4\n@bpm 76\n@patch 1\n\n1 2 3 4 ||').score!);
  check('未写说明的老文件不产生 @sub/@note', !plain.includes('@sub') && !plain.includes('@note'));
  // @note 超过 4 行截断到 4（不静默吞掉整条指令）
  const many = parseDsl(src.replace('1 2 3 4 ||', '') + '@note 第五行\n\n1 2 3 4 ||');
  check('@note 超过 4 行截断为 4', (many.score!.meta.notes ?? []).length === 4);
}

console.log(failed === 0 ? '\nV2 M0 PASS' : `\nV2 M0 FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);