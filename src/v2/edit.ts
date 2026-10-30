/**
 * 编辑操作（M1）：全部是 Score -> Score 的纯函数，可单测、可命令行跑。
 * 与渲染无关，与 UI 无关。
 *
 * 录入规则（§6.1）：默认时值 1 拍作为占位值，系统绝不自动均分（Q25），
 * 时值必须由用户后续通过框选 + 档位指定。
 */

import { assembleParts, partScore, scoreParts } from './parts';
import { distribute } from './reseat';
import { normalizeKey } from './timeline';
import { beatsPerMeasure, groupTicks, groupTierBeats, meterAt } from './meter';
import {
  isLegalTick,
  TICKS_PER_BEAT,
  tupletBeamCount,
  withDots,
  undotTicks,
  type DurationTier,
} from './ticks';
import { isTimed, type JumpEvent, type JumpMark } from './types';
import type {
  Accidental,
  Articulation,
  BarlineEvent,
  BeatGroup,
  Degree,
  GraceNote,
  Event,
  NoteEvent,
  RestEvent,
  Score,
  ScoreMeta,
  TimedEvent,
} from './types';

/** 光标导航：从缝隙 from 往左找最近的音符 / 休止，找不到返回 -1（一头一尾的特例） */
export function prevTimed(score: Score, from: number): number {
  for (let i = from - 1; i >= 0; i -= 1) {
    if (isTimed(score.events[i])) return i;
  }
  return -1;
}

/** 光标导航：从缝隙 from 往右找最近的音符 / 休止，找不到返回 -1 */
export function nextTimed(score: Score, from: number): number {
  for (let i = from; i < score.events.length; i += 1) {
    if (isTimed(score.events[i])) return i;
  }
  return -1;
}

const QUARTER = TICKS_PER_BEAT;

function maxSeq(ids: string[], prefix: string): number {
  let m = 0;
  for (const id of ids) {
    const local = id.split(':').pop()!;
    const n = Number(local.startsWith(prefix) ? local.slice(prefix.length) : NaN);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m;
}

function newIds(score: Score): { ev: string; grp: string } {
  const ns = score.part ? `p${score.part.id}:` : '';
  return {
    ev: `${ns}e${maxSeq(score.events.map((e) => e.id), 'e') + 1}`,
    grp: `${ns}g${maxSeq(score.groups.map((g) => g.id), 'g') + 1}`,
  };
}

/**
 * 跳转记号（L2）的所见即所得编辑：挂 / 换 / 摘选中**小节线后面**的那颗。
 *
 * 记号永远是独立事件（跟 DSL 的 `$s` 写在小节线后面一致）：
 *   - 线后没有跳转记号 → 插入
 *   - 线后已是同一颗   → 摘掉（再点一次取消）
 *   - 线后是另一颗     → 原地换（一根线只挂一颗，不叠罗汉）
 * mark 传 null = 摘掉。
 */
export function toggleJumpAfterBarline(
  score: Score,
  barlineId: string,
  mark: JumpMark | null,
): Score {
  const idx = score.events.findIndex((e) => e.id === barlineId);
  if (idx < 0 || score.events[idx].kind !== 'barline') return score;
  const next = score.events[idx + 1];
  const existing = next && next.kind === 'jump' ? next : null;

  if (!mark || existing?.mark === mark) {
    if (!existing) return score;
    return { ...score, events: score.events.filter((e) => e.id !== existing.id) };
  }
  const id = newIds(score).ev;
  const ev: JumpEvent = { id, kind: 'jump', mark };
  const events = [...score.events];
  if (existing) events.splice(idx + 1, 1, ev);
  else events.splice(idx + 1, 0, ev);
  return { ...score, events };
}

function insert(score: Score, at: number, ev: Event): Score {
  const events = score.events.slice();
  events.splice(Math.max(0, Math.min(at, events.length)), 0, ev);
  return { ...score, events };
}

// ───────────────────────── 复制 / 粘贴 ─────────────────────────

/**
 * 把剪贴板里的事件粘贴到 at 位置。
 *
 *   - id 全部重新生成（副本与原件互不相干，改副本不动原件）
 *   - 副本内部的连线 / 延音线保留（映射到新 id）；指向剪贴板之外的直接丢弃
 *   - 拍内组只有**整组**都在剪贴板里才重建（新组 id、总时值按成员重算）；
 *     半截组直接拆散——半个组在记谱上没有意义，留着只会报 I3
 */
export function pasteEvents(
  score: Score,
  at: number,
  clip: Event[],
  clipGroups: BeatGroup[] = score.groups,
): { score: Score; cursor: number } | null {
  if (clip.length === 0) return null;

  let seq = maxSeq(score.events.map((e) => e.id), 'e');
  let gseq = maxSeq(score.groups.map((g) => g.id), 'g');
  const ns = score.part ? `p${score.part.id}:` : '';

  const idMap = new Map<string, string>();
  const fresh = clip.map((e) => {
    const id = `${ns}e${++seq}`;
    idMap.set(e.id, id);
    return { ...e, id };
  });

  const clipIds = new Set(clip.map((e) => e.id));
  const groupMap = new Map<string, string>();
  for (const g of clipGroups) {
    if (g.memberIds.length > 0 && g.memberIds.every((id) => clipIds.has(id))) {
      groupMap.set(g.id, `${ns}g${++gseq}`);
    }
  }

  const cloned = fresh.map((e, i) => {
    const next = { ...e } as Event & { ties?: unknown; groupId?: string };
    const orig = clip[i];
    if (next.kind === 'note' && orig.kind === 'note' && orig.hairpinTo) {
      next.hairpinTo = idMap.get(orig.hairpinTo);
      if (!next.hairpinTo) { delete next.hairpinTo; delete next.hairpin; }
    }
    if (orig.kind === 'note' && orig.ties?.length) {
      const ties = orig.ties
        .filter((t) => idMap.has(t.to))
        .map((t) => ({ to: idMap.get(t.to)!, kind: t.kind }));
      if (ties.length) next.ties = ties;
      else delete next.ties;
    }
    const gid = orig.kind === 'note' || orig.kind === 'rest' ? groupMap.get(orig.groupId ?? '') : undefined;
    if (gid) next.groupId = gid;
    else delete next.groupId;
    return next as Event;
  });

  const newGroups: BeatGroup[] = clipGroups
    .filter((g) => groupMap.has(g.id))
    .map((g) => {
      const newId = groupMap.get(g.id)!;
      const members = cloned.filter(
        (e): e is TimedEvent => isTimed(e) && (e as { groupId?: string }).groupId === newId,
      );
      return {
        id: newId,
        totalTicks: members.reduce((a, m) => a + m.ticks, 0),
        memberIds: members.map((m) => m.id),
        ...(g.tuplet ? { tuplet: g.tuplet } : {}),
      };
    });

  const events = score.events.slice();
  const at2 = Math.max(0, Math.min(at, events.length));
  events.splice(at2, 0, ...cloned);
  return {
    score: { ...score, events, groups: [...score.groups, ...newGroups] },
    cursor: at2 + cloned.length,
  };
}

// ───────────────────────── 插入 ─────────────────────────
export function insertNote(score: Score, at: number, degree: Degree, octave = 0): Score {
  const id = newIds(score).ev;
  const note: NoteEvent = { id, kind: 'note', degree, octave, ticks: QUARTER, dot: 0 };
  return normalizeMultibarRests(insert(score, at, note));
}

export function insertRest(score: Score, at: number, x = false): Score {
  const id = newIds(score).ev;
  const rest: RestEvent = { id, kind: 'rest', ticks: QUARTER };
  // X 符号（无音高音符）：外形与发声都不同，时值机制与休止符一致
  if (x) rest.x = true;
  return normalizeMultibarRests(insert(score, at, rest));
}

export function insertBarline(score: Score, at: number, style: 'single' | 'double' | 'final' = 'single'): Score {
  const id = newIds(score).ev;
  return normalizeMultibarRests(insert(score, at, { id, kind: 'barline', style }));
}

/**
 * 改曲目信息（标题 / 调号 / 拍号 / 速度 / 音色）。
 *
 * 只接受合法值——面板里的输入框是自由文本，脏值一旦写进 meta，
 * 排版（标题块）和小节拍数校验都会跟着崩，所以在这里挡掉：
 *   - bpm 必须是有限正数
 *   - patch 必须是 0–127 的整数（MIDI program 号）
 *   - beat 必须是 `N/M` 形式，否则 beatsPerMeasure 会算出 NaN
 * 非法值原样返回，调用方据此把输入框退回旧值。
 */
export function setMeta(score: Score, patch: Partial<ScoreMeta>): Score {
  const next = { ...score.meta, ...patch };

  if ('bpm' in patch && (!Number.isFinite(next.bpm) || next.bpm <= 0)) return score;
  if (
    'patch' in patch &&
    (!Number.isInteger(next.patch) || next.patch < 0 || next.patch > 255)
  ) {
    return score;
  }
  if ('beat' in patch && !/^\d+\/\d+$/.test(next.beat)) return score;
  // 版式参数：越界直接拒绝（脏字号会让排版度量整体算出 NaN 或把谱面撑爆）
  if (
    'fontSize' in patch &&
    next.fontSize !== undefined &&
    (!Number.isFinite(next.fontSize) || next.fontSize < 12 || next.fontSize > 56)
  ) {
    return score;
  }
  if (
    'letterSpacing' in patch &&
    next.letterSpacing !== undefined &&
    (!Number.isFinite(next.letterSpacing) || next.letterSpacing < -20 || next.letterSpacing > 20)
  ) {
    return score;
  }
  if (
    'lineGap' in patch &&
    next.lineGap !== undefined &&
    (!Number.isFinite(next.lineGap) || next.lineGap < 0 || next.lineGap > 48)
  ) {
    return score;
  }
  if ('key' in patch) {
    // 调号直接决定 toMidi 的基准音，认不出来的写法必须拒绝而不是放行
    const k = normalizeKey(next.key);
    if (!k) return score;
    next.key = k;
  }

  return { ...score, meta: next };
}

/**
 * 改变音记号。acc 省略 = 去掉记号（回到跟随调号的本位音）。
 * 去掉时要删键而不是置 undefined，保持与解析结果一致（round-trip 才干净）。
 */
export function setAccidental(score: Score, id: string, acc?: Accidental): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (acc) copy.accidental = acc;
      else delete copy.accidental;
      return copy;
    }),
  };
}

/** 改小节线样式。键盘上连按两次 `|` 就是终止线（对应 DSL 的 `||`） */
export function setBarlineStyle(score: Score, id: string, style: 'single' | 'double' | 'final'): Score {
  return {
    ...score,
    events: score.events.map((e) => (e.id === id && e.kind === 'barline' ? { ...e, style } : e)),
  };
}

/**
 * 键盘上按一次 `|`（`\` 同义）：
 *   左边已经是单小节线 → 就地升级成终止线
 *   否则               → 插入一条单小节线
 *
 * DSL 里 `||` 是 final，键盘上也该如此。若按一次插一条单线，
 * 谱面末尾连按两次就得到两条单线——看不到终止标志。
 */
export function pressBarline(score: Score, at: number): { score: Score; cursor: number } {
  const left = at > 0 ? score.events[at - 1] : undefined;
  if (left && left.kind === 'barline' && left.style === 'single' && !left.partial) {
    return { score: setBarlineStyle(score, left.id, 'final'), cursor: at };
  }
  return { score: insertBarline(score, at), cursor: at + 1 };
}

/**
 * 光标所在小节（左右最近的小节线之间）是不是小节反复（𝄍）小节。
 * 反复号替代整小节记谱（GB/T 46845—2025 §5.8.4）——里面不能再写音符，
 * 输入路径（键盘数字 / 0 / X / | 和浮动板同款按钮）用它拦截。
 */
export function inRepeatMeasure(score: Score, cursor: number): boolean {
  let lo = Math.max(0, Math.min(cursor, score.events.length));
  while (lo > 0 && score.events[lo - 1]?.kind !== 'barline') lo -= 1;
  let hi = lo;
  while (hi < score.events.length && score.events[hi]?.kind !== 'barline') hi += 1;
  for (let i = lo; i < hi; i += 1) {
    const e = score.events[i];
    if (e.kind === 'rest' && (e as RestEvent).repeatBar) return true;
  }
  return false;
}

/**
 * 小节反复 % 键（𝄍 按钮 / 未来的快捷键）。光标必须**紧跟小节线**——
 * % 重复的是「这根线之前的那个小节」，前面是音符就没有可重复的锚点。
 *
 *   第 1 次按：插入 [整小节 % 休止, 小节线]——谱面画出单小节反复记号和收尾线；
 *   第 2 次按（左边那格已是 %）：再插一组——两格 % 中间的小节线画双小节反复记号
 *     （两条斜线，左右各一点，国标 §5.8.4）；
 *   第 3 次按：取消小节重复——把两组 [%, 线] 拆掉，回到重复之前的样子。
 *
 * 返回 null = 这次按键无效（光标前面不是小节线）。
 */
export function pressRepeatBar(score: Score, at: number): { score: Score; cursor: number } | null {
  const prev = at > 0 ? score.events[at - 1] : undefined;
  if (!prev || prev.kind !== 'barline') return null;
  // 数光标左边已连着的 % 小节个数（…B % B % [光标]）
  let count = 0;
  for (let i = at; i >= 2; i -= 2) {
    const bar = score.events[i - 1];
    const cell = score.events[i - 2];
    if (bar?.kind === 'barline' && cell?.kind === 'rest' && (cell as RestEvent).repeatBar) count += 1;
    else break;
  }
  if (count >= 2) {
    // 取消：光标左边依次是 [%2][B][%1][B0]（at−1…at−4），把两组 [%, 线] 拆掉
    const events = score.events.slice();
    events.splice(at - 4, 4);
    return { score: { ...score, events }, cursor: at - 4 };
  }
  const s1 = insertRest(score, at);
  const fresh = s1.events[at];
  if (!fresh || fresh.kind !== 'rest') return null;
  const s2 = toggleRepeatBar(s1, fresh.id);
  const s3 = insertBarline(s2, at + 1);
  return { score: s3, cursor: at + 2 };
}

// ───────────────────────── 小节线的反复属性 ─────────────────────────

/**
 * 改一根小节线的反复属性。**就地改，绝不新增事件**：
 * 反复记号就是这条线自己的状态（`|` → `|:` / `:|`），
 * 若像早期那样往光标处插一个独立记号，谱面就会多出一条线（`| |: 5 6 …`）。
 *
 * repeat 传 undefined = 取消（回到普通小节线）；`'both'`（双向反复 `:||:`）=
 * 既是上一段的结束又是下一段的开始。
 */
export function setBarlineRepeat(
  score: Score,
  id: string,
  repeat?: 'start' | 'end' | 'both',
  times?: number,
): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'barline') return e;
      const bar: BarlineEvent = { ...e };
      if (repeat) {
        bar.repeat = repeat;
        if (repeat === 'end') bar.times = Math.max(2, Math.round(times ?? bar.times ?? 2));
      } else {
        delete bar.repeat;
      }
      if (repeat !== 'end') delete bar.times;
      return bar;
    }),
  };
}

/** 改反复遍数（`:|3`）；传 2 就是缺省的两遍 */
export function setRepeatTimes(score: Score, id: string, times: number): Score {
  return {
    ...score,
    events: score.events.map((e) =>
      e.id === id && e.kind === 'barline' && e.repeat === 'end'
        ? { ...e, times: Math.max(2, Math.round(times)) }
        : e,
    ),
  };
}

/**
 * 设 / 清跳房子：`[1]` 表示「从这条线起，后面这一房是第 1 遍的结尾」。
 * 房的范围到下一个带房子的线（或所在反复段的那根 `:|`）为止，所以只设开头。
 * numbers 传 undefined = 取消这个房。
 */
export function setBarlineVolta(score: Score, id: string, numbers?: number[]): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'barline') return e;
      const bar: BarlineEvent = { ...e };
      if (numbers && numbers.length > 0) bar.volta = [...numbers];
      else delete bar.volta;
      return bar;
    }),
  };
}

/** 切换房子的「右端开放」（简谱惯例：长房 / 跨行房开放，两三小节的短房画右钩） */
export function setBarlineVoltaOpen(score: Score, id: string, open: boolean): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'barline') return e;
      const bar: BarlineEvent = { ...e };
      if (open) bar.voltaOpen = true;
      else delete bar.voltaOpen;
      return bar;
    }),
  };
}

/**
 * 把「完整小节」选区直接设成第 n 房——比逐根点小节线顺手得多：
 *
 *   - 选区头**前面**那根小节线 = 房子左墙，挂上 [n]（房子向右自动延伸）
 *   - 选区尾**后面**那根小节线 = 自动变反复结束 :|（房子右端正好收口在它上面）
 *   - 左墙本身是旧段的 :| 时先拆掉：两间房必须同处一段（|: A [1] B [2] C :|），
 *     拆完旧 |: 自然变成容纳两房的段首——这正是用户从单房扩成双房时的实际路径
 *
 * 返回 null = 选区不是完整小节 / 段首没有 |:（error 里说明给 UI 显示）。
 */
export function setVoltaFromSelection(
  score: Score,
  ids: string[],
  n: number,
): { score: Score | null; error?: string } {
  if (ids.length === 0) return { score: null, error: '先选中音符' };
  const positions = ids
    .map((id) => score.events.findIndex((e) => e.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (positions.length !== ids.length) return { score: null, error: '选区不连续' };
  const first = positions[0];
  const last = positions[positions.length - 1];
  // 选区是**时值事件**的集合：跨多小节时中间的小节线（以及换气等装饰）不在选区里，
  // 不算断开；但范围内的时值事件必须全被选中——漏选中间的音就不是「完整小节」
  const selected = new Set(positions);
  for (let i = first; i <= last; i += 1) {
    const ev = score.events[i];
    if ((ev.kind === 'note' || ev.kind === 'rest') && !selected.has(i)) {
      return { score: null, error: '选区中间有没选到的音——房子要罩住整小节，请整小节选满' };
    }
  }
  const wall = first > 0 ? score.events[first - 1] : undefined;
  const tail = last + 1 < score.events.length ? score.events[last + 1] : undefined;
  if (!wall || wall.kind !== 'barline') {
    return { score: null, error: '要从整小节的开头选起（选区前一根应是小节线）' };
  }
  if (!tail || tail.kind !== 'barline') {
    return { score: null, error: '要选到整小节的结尾（选区后一根应是小节线）' };
  }

  // 段首检查：墙之前要有还没闭合的 |:。墙自身是旧 :| 时按「将被拆掉」处理，
  // 不当闭合算——拆完之后旧 |: 正好管到新加的这间房
  const stack: number[] = [];
  for (let i = 0; i < first; i += 1) {
    const ev = score.events[i];
    if (ev.kind !== 'barline') continue;
    const bar = ev as BarlineEvent;
    if (bar.repeat === 'start') stack.push(i);
    else if (bar.repeat === 'end' && i !== first - 1) stack.pop();
  }
  if (stack.length === 0) {
    return { score: null, error: '选区前面没有反复起点 |:——先选中段首那根小节线设成 |:，再来挂房子' };
  }

  const wallId = wall.id;
  let next = score;
  if ((wall as BarlineEvent).repeat === 'end') {
    next = setBarlineRepeat(next, wallId, undefined);
  }
  next = setBarlineRepeat(next, tail.id, 'end');
  next = setBarlineVolta(next, wallId, [n]);
  // 右端开合不用在这里定：排版层自动判断（下一根线是 :| → 封闭，否则开放），
  // voltaOpen 仅作手动覆盖
  return { score: next };
}

// ───────────────────────── 修改单个事件 ─────────────────────────

/** 增时线 -：给光标前的最近一个音符 / 休止加 1 拍 */
export function extendPrev(score: Score, at: number): { score: Score; ok: boolean } {
  for (let i = at - 1; i >= 0; i -= 1) {
    const ev = score.events[i];
    if (ev.kind === 'note' || ev.kind === 'rest') {
      const patched: TimedEvent =
        ev.kind === 'note'
          ? { ...ev, ticks: ev.ticks + QUARTER, dot: 0 }
          : { ...ev, ticks: ev.ticks + QUARTER };
      return {
        score: { ...score, events: score.events.map((e, idx) => (idx === i ? patched : e)) },
        ok: true,
      };
    }
    if (ev.kind === 'barline') break; // 不跨小节延长
  }
  return { score, ok: false };
}

/**
 * 八度 ^ / v，可叠加（§6.6 Alt+↑/↓ 在此由 delta 表达）。
 * 封顶 ±3（三个八度点）：属性面板 setOctave 同样限 ±3，两条路必须一致，
 * 否则键盘能把音推到面板点不回来、序列化出 ^^^^ 这种超纲写法
 */
export function shiftOctave(score: Score, id: string, delta: number): Score {
  return {
    ...score,
    events: score.events.map((e) =>
      e.id === id && e.kind === 'note'
        ? { ...e, octave: Math.max(-3, Math.min(3, e.octave + delta)) }
        : e,
    ),
  };
}

/** 升 / 降 8 度作用于整个选区（所有选中音一起移动），封顶规则与 shiftOctave 一致 */
export function shiftOctaveMany(score: Score, ids: readonly string[], delta: number): Score {
  const set = new Set(ids);
  return {
    ...score,
    events: score.events.map((e) =>
      set.has(e.id) && e.kind === 'note'
        ? { ...e, octave: Math.max(-3, Math.min(3, e.octave + delta)) }
        : e,
    ),
  };
}

/**
 * JP-Word 同款八度**循环**（` / ~ / · 三键）：同方向连按，1 个点 → 2 个点 →
 * 3 个点 → 无点，再按重新开始。与 shiftOctave 的「封顶移动」是两种语义——
 * 封顶是 ^ / v 的（到头就停住），循环是这颗键的（到头回无点）。
 */
export function cycleOctave(score: Score, id: string, dir: 1 | -1): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const next = e.octave + dir;
      // 越过 ±3 就回到无点：升 3 → 0、降 -3 → 0
      return { ...e, octave: next > 3 || next < -3 ? 0 : next };
    }),
  };
}

/**
 * 吐音标记：v 传 T / K，省略 = 去掉。双吐就是 T K 交替标在连续音符上。
 * 与换气 V 互斥——三个都属于「气息」，一次只做一个：标吐音就摘掉换气。
 */
export function setTongue(score: Score, id: string, v?: 'T' | 'K'): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (v) {
        copy.tongue = v;
        if (copy.techniques?.includes('breath')) {
          const rest = copy.techniques.filter((x) => x !== 'breath');
          if (rest.length) copy.techniques = rest;
          else delete copy.techniques;
        }
      } else delete copy.tongue;
      return copy;
    }),
  };
}

/** 键盘 t 键：单吐开关（有 T 就去掉，没有就标 T） */
export function toggleTongue(score: Score, id: string): Score {
  const cur = score.events.find((e) => e.id === id);
  return setTongue(score, id, cur && cur.kind === 'note' && cur.tongue === 'T' ? undefined : 'T');
}

/** 技法记号，可多选：values 是完整的新集合（空数组 / 省略 = 清空） */
export function setTechniques(score: Score, id: string, values?: string[]): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (values && values.length) copy.techniques = values;
      else delete copy.techniques;
      return copy;
    }),
  };
}

/** 延长音（弧线加点的 ⌒）：开关。对应 DSL 的 @ */
export function setFermata(score: Score, id: string): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (copy.fermata) delete copy.fermata;
      else copy.fermata = true;
      return copy;
    }),
  };
}

/**
 * 自定义记号：面板输入框打的 ≤3 个汉字 / 符号，原样画在音符上方。
 * 空串 / 超长 / 含方括号都拒绝（括号是 DSL 的定界符，放不进来）。
 */
export function setNoteMark(score: Score, id: string, v: string | undefined): Score {
  const text = (v ?? '').trim();
  if (text.length > 3 || /[[\]]/.test(text)) return score;
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (text) copy.mark = text;
      else delete copy.mark;
      return copy;
    }),
  };
}

/** 指法（GB/T 46845—2025 §7.11.5）：音符正下方的小字数字 0-5（'0'=空弦）；省略 = 去掉 */
export function setFingering(score: Score, id: string, v?: string): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (v) copy.fingering = v;
      else delete copy.fingering;
      return copy;
    }),
  };
}

/**
 * 多小节休止（GB/T 46845—2025 §6.3.7.3）：在光标处插入 0*N（N ≥ 1）。
 * 与 DSL 解析同一套拆解：N 个整小节休止 + N−1 根结构化隐藏小节线——
 * 拍数校验、小节号、断行全走既有机制，序列化合并回 0*N。
 * 时值按光标处生效的拍号算整小节。
 */
export function insertMultibarRest(score: Score, at: number, measures: number): Score {
  const n = Math.max(1, Math.min(999, Math.round(measures)));
  const mt = Math.round(beatsPerMeasure(meterAt(score, at)) * TICKS_PER_BEAT);
  const ns = score.part ? `p${score.part.id}:` : '';
  let seq = maxSeq(score.events.map((e) => e.id), 'e');
  const fresh = (): string => `${ns}e${++seq}`;
  const added: Event[] = [];
  for (let i = 0; i < n; i += 1) {
    if (i > 0) added.push({ id: fresh(), kind: 'barline', style: 'single', hidden: true, multibarDiv: true });
    added.push(
      i === 0
        ? { id: fresh(), kind: 'rest', ticks: mt, multibar: n }
        : { id: fresh(), kind: 'rest', ticks: mt, multibarCont: true },
    );
  }
  const events = score.events.slice();
  const at2 = Math.max(0, Math.min(at, events.length));
  events.splice(at2, 0, ...added);
  return normalizeMultibarRests({ ...score, events });
}

/**
 * 多小节休止的剩余小节数重算：编辑（删格 / 加格）后按**实际连续的休止格**
 * 重新计数——首格写 multibar = 段内格数，其余格统一 multibarCont，
 * 没了左右休止格的结构化分隔线（multibarDiv）安全清掉。
 * 用户手写的隐藏小节线 `|*` 没有这个标记，永远不动。
 */
export function normalizeMultibarRests(score: Score): Score {
  let evs = score.events;
  const isMbCell = (e: Event | undefined): e is RestEvent =>
    !!e && e.kind === 'rest' && !!(e.multibar || e.multibarCont);
  const isDiv = (e: Event | undefined): boolean =>
    !!e && e.kind === 'barline' && e.hidden === true && e.multibarDiv === true;

  // ⓪ 两格直接相邻（中间什么都没有，如 0×2 后紧接再插 0×3）→ 补一根结构线并成一段
  {
    const patched = evs.slice();
    let inserted = 0;
    for (let k = 0; k + 1 < patched.length; k += 1) {
      if (isMbCell(patched[k]) && isMbCell(patched[k + 1])) {
        const ns = score.part ? `p${score.part.id}:` : '';
        const id = `${ns}e-norm${k}-${patched.length}`;
        patched.splice(k + 1, 0, { id, kind: 'barline', style: 'single', hidden: true, multibarDiv: true });
        inserted += 1;
        k += 2;
      }
    }
    if (inserted) evs = patched;
  }

  // ① 收集段：格、(结构线 格)*，至少一格
  const runs: { cells: number[] }[] = [];
  let i = 0;
  while (i < evs.length) {
    if (!isMbCell(evs[i])) {
      i += 1;
      continue;
    }
    const cells: number[] = [i];
    let j = i;
    while (isDiv(evs[j + 1]) && isMbCell(evs[j + 2])) {
      cells.push(j + 2);
      j += 2;
    }
    runs.push({ cells });
    i = j + 1;
  }
  if (!runs.length) return score;

  // ② 清掉没有左右格的结构线（段收拢后剩下的孤儿）
  const inRun = new Set<number>();
  for (const r of runs) for (const c of r.cells) inRun.add(c);
  const divIdx = new Set<number>();
  for (let k = 0; k < evs.length; k += 1) {
    if (!isDiv(evs[k])) continue;
    if (inRun.has(k - 1) && inRun.has(k + 1)) continue; // 段内分隔，保留
    divIdx.add(k);
  }

  let changed = divIdx.size > 0;
  const events = evs.filter((_, k) => !divIdx.has(k));
  // ③ 重计数：每段首格 multibar = 格数、清 cont；其余格 cont、清 multibar
  const idRuns: { head: string; tails: string[]; n: number }[] = [];
  {
    let k = 0;
    while (k < events.length) {
      if (!isMbCell(events[k])) {
        k += 1;
        continue;
      }
      const cells: string[] = [events[k].id];
      let j = k;
      while (isDiv(events[j + 1]) && isMbCell(events[j + 2])) {
        cells.push(events[j + 2].id);
        j += 2;
      }
      idRuns.push({ head: cells[0], tails: cells.slice(1), n: cells.length });
      k = j + 1;
    }
  }
  const headIds = new Set(idRuns.map((r) => r.head));
  const tailIds = new Set(idRuns.flatMap((r) => r.tails));
  const out = events.map((e) => {
    if (e.kind !== 'rest') return e;
    if (headIds.has(e.id)) {
      const n = idRuns.find((r) => r.head === e.id)!.n;
      if (e.multibar !== n || e.multibarCont) {
        changed = true;
        return { ...e, multibar: n, multibarCont: undefined } as RestEvent;
      }
      return e;
    }
    if (tailIds.has(e.id)) {
      if (!e.multibarCont || e.multibar !== undefined) {
        changed = true;
        return { ...e, multibarCont: true, multibar: undefined } as RestEvent;
      }
      return e;
    }
    return e;
  });
  return changed ? { ...score, events: out } : score;
}

/**
 * 高 / 低八度演奏段（GB/T 46845—2025 §6.2.6）：选区首音至末音整体升 / 降八度。
 * kind 传 con-va / con-vb = 八度重复（con 8）：原声保留，另叠一份高 / 低八度同响。
 * 与渐强范围（setHairpinRange）同一套区间操作：段起点挂 octava + octavaTo 指向末音；
 * 与选区交叉的旧段先清掉（不许嵌套）。kind 省略 = 清除选区相关段。
 * 区间记号 8va[ … ]8 需要 @format 3，这里与 setHairpinRange 一样强制升到 format 3。
 */
export function setOctavaRange(score: Score, ids: string[], kind?: 'va' | 'vb' | 'con-va' | 'con-vb'): Score {
  const set = new Set(ids);
  const positions = score.events.flatMap((e, i) => (e.kind === 'note' && set.has(e.id) ? [i] : []));
  const lo = positions[0];
  const hi = positions[positions.length - 1];
  if (kind && (positions.length < 2 || lo === undefined || hi === undefined)) return score;
  if (!kind) {
    // 清除：选中段里的任意一个音（选区与段区间相交）就拆掉整段
    if (!positions.length) return score;
    const selLo = lo;
    const selHi = hi;
    const events = score.events.map((e, i) => {
      if (e.kind !== 'note' || !(e.octava || e.octavaTo)) return e;
      const endIdx = e.octavaTo ? score.events.findIndex((q) => q.id === e.octavaTo) : i;
      const startIdx = e.octava ? i : endIdx;
      const segLo = Math.min(i, startIdx < 0 ? i : startIdx);
      const segHi = Math.max(i, endIdx < 0 ? i : endIdx);
      if (segHi < selLo || segLo > selHi) return e;
      const copy = { ...e };
      delete copy.octava;
      delete copy.octavaTo;
      return copy;
    });
    return { ...score, events };
  }
  const events = score.events.map((e, i) => {
    if (e.kind !== 'note') return e;
    // 起点音**先于**交叉清理应用新段：循环三态（8va → con 8 → 取消）再次套用时，
    // 选区自己的旧段起点就在 lo 上，若先走交叉清理会直接 return 清空版——
    // 新 kind 没机会写上，表现成「再按 = 取消」而不是切换（用户实测）
    if (i === lo) return { ...e, octava: kind, octavaTo: score.events[hi].id };
    const endIdx = e.octavaTo ? score.events.findIndex((q) => q.id === e.octavaTo) : -1;
    // 与选区交叉的旧段（起点在选区内 / 终点在选区内）先拆
    if (e.octava || e.octavaTo) {
      const crosses =
        (i >= lo && i <= hi) ||
        (endIdx >= lo && endIdx <= hi) ||
        (e.octavaTo ? set.has(e.octavaTo) : false);
      if (crosses) {
        const copy = { ...e };
        delete copy.octava;
        delete copy.octavaTo;
        return copy;
      }
    }
    return e;
  });
  return { ...score, format: 3, events };
}

/**
 * 小节反复号 %（GB/T 46845—2025 §5.8.4）：本小节内容与上一小节完全相同，
 * 谱面画 𝄍，播放时重复上一小节的发声。只对普通休止符开（X 音符不行）；
 * 打开时把时值补成整小节（DSL 的 '%' 反解析就是整小节，必须同口径才能无损往返），
 * 关掉保留整小节时值，用户可再用时值排改回去。
 */
export function toggleRepeatBar(score: Score, id: string): Score {
  const idx = score.events.findIndex((e) => e.id === id);
  if (idx < 0) return score;
  const ev = score.events[idx];
  if (ev.kind !== 'rest' || ev.x) return score;
  const measureTicks = Math.round(beatsPerMeasure(meterAt(score, idx)) * TICKS_PER_BEAT);
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'rest') return e;
      const r = e as RestEvent;
      if (r.repeatBar) {
        const copy = { ...r };
        delete copy.repeatBar;
        return copy;
      }
      return { ...r, repeatBar: true, ticks: measureTicks, dot: 0 };
    }),
  };
}

/**
 * 批量灰显 / 复原（前奏 / 间奏提示）：选中的音符与休止符画成灰色。
 * 纯视觉标记，播放与时值校验不受影响。ids 里不是音 / 休止的（小节线等）自动跳过。
 */
export function setGray(score: Score, ids: string[], gray: boolean): Score {
  const set = new Set(ids);
  return {
    ...score,
    events: score.events.map((e) => {
      if (!set.has(e.id)) return e;
      if (e.kind !== 'note' && e.kind !== 'rest') return e;
      const copy = { ...e };
      if (gray) copy.gray = true;
      else delete copy.gray;
      return copy;
    }),
  };
}

/**
 * 转调：从此音起改用新调（记谱写作 `转1=G`，面板在音符属性里）。
 * 传 undefined / 空串 = 清除。非法调号原样拒绝——脏调号会让 toMidi 静默按 C 调算。
 */
export function setKeyChange(score: Score, id: string, key?: string): Score {
  if (key === undefined || key.trim() === '') {
    return {
      ...score,
      events: score.events.map((e) => {
        if (e.id !== id || e.kind !== 'note' || !e.keyChange) return e;
        const copy = { ...e };
        delete copy.keyChange;
        return copy;
      }),
    };
  }
  const norm = normalizeKey(key);
  if (!norm) return score;
  return {
    ...score,
    events: score.events.map((e) =>
      e.id === id && e.kind === 'note' ? { ...e, keyChange: norm } : e,
    ),
  };
}

// ───────────────────────── 倚音 ─────────────────────────

/** 倚音挂在主音的哪个位置 */
export type GracePos = 'before' | 'after';

const graceField = (pos: GracePos): 'graceBefore' | 'graceAfter' =>
  pos === 'before' ? 'graceBefore' : 'graceAfter';

/**
 * 设置某音的倚音序列（不占时值）。传 undefined / 空数组 = 清除。
 * 面板的加 / 删 / 清空都走它，保证只有一条写入口。
 */
export function setGrace(
  score: Score,
  id: string,
  pos: GracePos,
  list: GraceNote[] | undefined,
): Score {
  const field = graceField(pos);
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      if (!list || list.length === 0) {
        if (!e[field]) return e;
        const copy = { ...e };
        delete copy[field];
        return copy;
      }
      return { ...e, [field]: list };
    }),
  };
}

/**
 * 设定倚音序列里的**某一格**（三格录入框用）：越界则追加，传 null = 清掉这一格。
 *
 * 中间格清掉后后面的依次前移——三格是「位置」不是「带洞的槽」，
 * 数据模型里也不存在空洞（序列化出来是 `{12 3}`，没有占位符）。
 */
export function setGraceSlot(
  score: Score,
  id: string,
  pos: GracePos,
  index: number,
  g: GraceNote | null,
): Score {
  const note = score.events.find((e) => e.id === id);
  if (!note || note.kind !== 'note') return score;
  const list = [...(pos === 'before' ? note.graceBefore ?? [] : note.graceAfter ?? [])];
  if (g === null) {
    if (index < 0 || index >= list.length) return score; // 空格子再清 = 什么都没发生
    list.splice(index, 1);
  } else if (index < 0) {
    return score;
  } else if (index >= list.length) {
    list.push(g);
  } else {
    list[index] = g;
  }
  return setGrace(score, id, pos, list);
}

/**
 * 把整组倚音挪到另一侧（前 ↔ 后）。三格录入界面里「勾前 / 勾后」就是靠它，
 * 源侧清空、目标侧的原有倚音由调用方先判断（这里只搬运，不合并、不覆盖）。
 */
export function moveGrace(score: Score, id: string, from: GracePos, to: GracePos): Score {
  const note = score.events.find((e) => e.id === id);
  if (!note || note.kind !== 'note' || from === to) return score;
  const list = from === 'before' ? note.graceBefore ?? [] : note.graceAfter ?? [];
  if (list.length === 0) return score;
  return setGrace(setGrace(score, id, from, undefined), id, to, list);
}

/** 追加一颗倚音。靠主音的那颗永远排在最后（前倚音）/ 最前（后倚音）由面板决定顺序 */
export function addGrace(
  score: Score,
  id: string,
  pos: GracePos,
  g: GraceNote,
  at?: number,
): Score {
  const note = score.events.find((e) => e.id === id);
  if (!note || note.kind !== 'note') return score;
  const list = [...(pos === 'before' ? note.graceBefore ?? [] : note.graceAfter ?? [])];
  list.splice(at === undefined ? list.length : at, 0, g);
  return setGrace(score, id, pos, list);
}

/** 删掉第 index 颗倚音 */
export function removeGrace(score: Score, id: string, pos: GracePos, index: number): Score {
  const note = score.events.find((e) => e.id === id);
  if (!note || note.kind !== 'note') return score;
  const list = [...(pos === 'before' ? note.graceBefore ?? [] : note.graceAfter ?? [])];
  if (index < 0 || index >= list.length) return score;
  list.splice(index, 1);
  return setGrace(score, id, pos, list);
}

/**
 * 解除倚音：把倚音还原成独立音符（各按 1 拍插入主音前 / 后），主音恢复完整时值。
 * 编辑时「加错了想改回普通音符」的退路。
 */
export function dropGrace(score: Score, id: string, pos: GracePos): Score {
  const idx = score.events.findIndex((e) => e.id === id);
  const note = idx >= 0 ? score.events[idx] : undefined;
  if (!note || note.kind !== 'note') return score;
  const list = pos === 'before' ? note.graceBefore ?? [] : note.graceAfter ?? [];
  if (list.length === 0) return score;

  const fresh: NoteEvent[] = list.map((g, i) => ({
    id: `${id}g${pos}${i}`,
    kind: 'note',
    degree: g.degree,
    octave: g.octave,
    ticks: QUARTER,
    dot: 0,
    ...(g.accidental ? { accidental: g.accidental } : {}),
  }));
  const cleaned = setGrace(score, id, pos, undefined);
  const at = pos === 'before' ? idx : idx + 1;
  const events = cleaned.events.slice();
  events.splice(at, 0, ...fresh);
  return { ...cleaned, events };
}

/** 断音 / 顿音（小圆点，DSL 写 !）：开关。作用在演奏法 articulations 上 */
export function toggleArticulation(score: Score, id: string, a: Articulation): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const list = (e.articulations ?? []).filter((x) => x !== a);
      if (list.length === (e.articulations ?? []).length) list.push(a);
      if (list.length === 0) {
        const copy = { ...e };
        delete copy.articulations;
        return copy;
      }
      return { ...e, articulations: list };
    }),
  };
}

/**
 * 技法开关：**互斥**——一个音同时只标一种技法。
 * 点亮的再点一次 = 去掉；点别的 = 换成那个。
 * 不是多选：多个技法并排画会挤成一团，记谱上也没有「同时花舌又打音」的写法。
 * 标换气时去掉吐音——T / K / 换气三者互斥。
 */
export function toggleTechnique(score: Score, id: string, v: string): Score {
  const cur = score.events.find((e) => e.id === id);
  const list = cur && cur.kind === 'note' ? (cur.techniques ?? []) : [];
  const has = list.includes(v);
  const next = has ? [] : [v];
  const base = v === 'breath' && !has ? setTongue(score, id) : score;
  return setTechniques(base, id, next);
}

/**
 * 力度跟音符绑定：v 传力度值，省略或与当前相同 = 去掉（面板按钮即开关）。
 * 画在音符下方，不再是独立事件。
 */
export function setNoteDynamic(score: Score, id: string, v?: string): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (v && v !== e.dynamic) copy.dynamic = v;
      else delete copy.dynamic;
      return copy;
    }),
  };
}

/** 渐强 / 渐弱，跟音符绑定：再点一次同一项 = 去掉 */
export function setHairpinRange(score: Score, ids: string[], kind?: 'cresc' | 'dim'): Score {
  const positions = score.events.flatMap((e, i) => e.kind === 'note' && ids.includes(e.id) ? [i] : []);
  if (positions.length < 2) return score;
  const lo = positions[0];
  const hi = positions[positions.length - 1];
  const events = score.events.map((e, i) => {
    if (e.kind !== 'note') return e;
    const end = score.events.findIndex((item) => item.id === e.hairpinTo);
    const clean = (i >= lo && i <= hi) || (e.hairpinTo && i <= hi && end >= lo);
    const copy = { ...e };
    if (clean) { delete copy.hairpin; delete copy.hairpinTo; }
    if (i === lo && kind) { copy.hairpin = kind; copy.hairpinTo = score.events[hi].id; }
    return copy;
  });
  return { ...score, format: 3, events };
}

export function setBarNotation(score: Score, id: string, change: Pick<BarlineEvent, 'beatAfter' | 'breakAfter' | 'bpmAfter' | 'patchAfter' | 'dashed' | 'free'>): Score {
  return { ...score, format: 3, events: score.events.map((e) => e.id === id && e.kind === 'barline' ? { ...e, ...change } : e) };
}

/**
 * 选区颤音（GB/T 46845—2025 §7.5.3）：tr 标在首音上，波浪线从 tr 右侧
 * 连续拉到末音的尾部（末音带 trillEnd 标记）。再点一次整段取消。
 */
export function setTrillRange(score: Score, ids: string[]): Score {
  const set = new Set(ids);
  const positions = score.events.flatMap((e, i) => (e.kind === 'note' && set.has(e.id) ? [i] : []));
  if (positions.length < 2) return score;
  const lo = positions[0];
  const hi = positions[positions.length - 1];
  const first = score.events[lo] as NoteEvent;
  const last = score.events[hi] as NoteEvent;
  // 已套用（首音有 trill 且末音有 trillEnd）→ 这次是整段取消
  const applied = (first.techniques ?? []).includes('trill') && last.trillEnd === true;
  return {
    ...score,
    events: score.events.map((e, i) => {
      if (e.kind !== 'note' || !set.has(e.id)) return e;
      const copy = { ...e };
      if (applied) {
        if (i === lo) {
          const tech = (copy.techniques ?? []).filter((t) => t !== 'trill');
          if (tech.length) copy.techniques = tech;
          else delete copy.techniques;
        }
        if (copy.trillEnd) delete copy.trillEnd;
      } else {
        if (i === lo && !(copy.techniques ?? []).includes('trill')) {
          copy.techniques = [...(copy.techniques ?? []), 'trill'];
        }
        if (i === hi) copy.trillEnd = true;
        else if (copy.trillEnd) delete copy.trillEnd;
      }
      return copy;
    }),
  };
}

/** 琶音（GB/T 46845—2025 §7.7）：音符左侧波状竖线，开关 */
export function setArpeggio(score: Score, id: string): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (copy.arpeggio) delete copy.arpeggio;
      else copy.arpeggio = true;
      return copy;
    }),
  };
}

/** 震音（GB/T 46845—2025 §7.8）：斜线数 1–3；省略 = 去掉。n 与当前相同也 = 去掉 */
export function setTremolo(score: Score, id: string, n?: 1 | 2 | 3): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (n && n !== e.tremolo) copy.tremolo = n;
      else delete copy.tremolo;
      return copy;
    }),
  };
}

export function setHairpin(score: Score, id: string, v?: 'cresc' | 'dim'): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (v && v !== e.hairpin) copy.hairpin = v;
      else delete copy.hairpin;
      delete copy.hairpinTo;
      return copy;
    }),
  };
}

/** 光标边上（前一个或后一个）的力度记号，没有则 null */
export function dynamicAt(
  score: Score,
  at: number,
): { id: string; value: string } | null {
  for (const i of [at - 1, at]) {
    const e = score.events[i];
    if (e && e.kind === 'directive' && e.type === 'dynamic') {
      return { id: e.id, value: e.value };
    }
  }
  return null;
}

/**
 * 设力度：同一位置已经有力度记号就**替换**，而不是再插一个——
 * 否则 pp p mp mf f ff 能一路叠上去，谱面下方挤成一排谁也不知道哪个有效。
 */
export function setDynamic(score: Score, at: number, value: string): Score {
  const existing = dynamicAt(score, at);
  if (!existing) return insertDynamic(score, at, value);
  return {
    ...score,
    events: score.events.map((e) =>
      e.id === existing.id && e.kind === 'directive' ? { ...e, value } : e,
    ),
  };
}

/** 删掉光标边上的力度记号 */
export function deleteDynamic(score: Score, at: number): Score {
  const existing = dynamicAt(score, at);
  return existing ? removeEvent(score, existing.id) : score;
}

// ── 文字标注（段落标注）：紧贴音符前的 (文字) 指令 ──────────────────

/**
 * 找紧贴某音符/休止符**前面**的文字标注文本；没有返回 null。
 * 「紧贴」= 往前扫只会经过其他指令（力度 mf 之类可以夹在中间），
 * 遇到音符 / 休止 / 小节线就停——隔了结构的标注不属于这个音。
 */
export function textAnnotationOf(score: Score, noteId: string): string | null {
  const idx = score.events.findIndex((e) => e.id === noteId);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const e = score.events[i];
    if (e.kind !== 'directive') break;
    if (e.type === 'text') return e.value;
  }
  return null;
}

/**
 * 标注框里显示什么：**只**看段落文字标注。
 * 括号是另一回事（有自己的按钮、存成全角 （ ） 指令），不混进这个框——
 * 早先「没文字时把括号显示成 ()」会让人以为括号就是标注、改一个动另一个。
 */
export function annotationTextOf(score: Score, noteId: string): string {
  return textAnnotationOf(score, noteId) ?? '';
}

/** 音符左右两侧的括号记号（'(' 在前、')' 在后），用于查询按钮点亮状态 */
export function parenFlagsOf(score: Score, noteId: string): { open: boolean; close: boolean } {
  const idx = score.events.findIndex((e) => e.id === noteId);
  if (idx < 0) return { open: false, close: false };
  const isParen = (e: Event | undefined, ch: string): boolean =>
    !!e && e.kind === 'directive' && e.type === 'paren' && e.value === ch;
  return {
    open: isParen(score.events[idx - 1], '('),
    close: isParen(score.events[idx + 1], ')'),
  };
}

/**
 * 加 / 去左右括号：已有一个就删掉，没有就在音符前（(）或后（)）插一个。
 *
 * 为什么是两个独立记号而不是「选中区间加括号」：一段音符常常跨好几行，
 * 头一个音和末一个音不在同一行，按区间操作既选不准也说不清括号画在哪。
 */
export function toggleParen(score: Score, noteId: string, side: 'open' | 'close'): Score {
  const idx = score.events.findIndex((e) => e.id === noteId);
  if (idx < 0) return score;
  const ch = side === 'open' ? '(' : ')';
  const at = side === 'open' ? idx - 1 : idx + 1;
  const cur = score.events[at];
  if (cur && cur.kind === 'directive' && cur.type === 'paren' && cur.value === ch) {
    return { ...score, events: score.events.filter((_, i) => i !== at) };
  }
  const ns = score.part ? `p${score.part.id}:` : '';
  const id = `${ns}e${maxSeq(score.events.map((e) => e.id), 'e') + 1}`;
  const ev: Event = { id, kind: 'directive', type: 'paren', value: ch };
  const events = [...score.events];
  events.splice(side === 'open' ? idx : idx + 1, 0, ev);
  return { ...score, events };
}

/** 摘掉音符前的段落文字标注 */
function stripText(score: Score, noteId: string): Score {
  const idx = score.events.findIndex((e) => e.id === noteId);
  if (idx < 0) return score;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const e = score.events[i];
    if (e.kind !== 'directive') break;
    if (e.type === 'text') {
      return { ...score, events: score.events.filter((_, j) => j !== i) };
    }
  }
  return score;
}

/**
 * 设置 / 修改 / 删除音符前的文字标注（脚本里的 `(前奏)` 段落标记）。
 *
 * **只写了括号字符（( / ) / ()）时走另一条路**：那不是文字，是画在音符
 * 左右两侧的括号记号（paren directive）——用户从标注框输入 ( 就是想在
 * 音符左边看到 (，包成 `((` 画到音符下方完全不是他要的。
 * 半角括号在**脚本源码**里确实是连音线写法，但这只影响文本层：内部一律存
 * 成 paren directive、回写时用全角 （ ），与连音线互不干扰。
 */
/**
 * 设置 / 修改 / 删除音符前的文字标注（脚本里的 `(前奏)` 段落标记）。
 * text 为空串 = 删除；已有标注 = 改文字；都没有 = 在音符前插入新指令。
 *
 * **只管文字，不碰括号**：括号由 toggleParen 独立增删（存成全角 （ ） 指令），
 * 这里既不读也不写它——早先写标注会顺手摘掉括号、输入 ( 又会去切括号，
 * 两件事互相覆盖，改一个另一个就没了。
 */
export function setTextAnnotation(score: Score, noteId: string, text: string): Score {
  const idx = score.events.findIndex((e) => e.id === noteId);
  if (idx < 0) return score;
  if (score.events[idx].kind !== 'note' && score.events[idx].kind !== 'rest') return score;
  // 半角 ( ) 是 `(标注)` 的定界符，写进正文会让文件读不回来——摘掉。
  // 要括号请用括号按钮（存成全角），两条路互不干扰
  const trimmed = text.replace(/[()]/g, '').trim();

  if (!trimmed) return stripText(score, noteId);

  let di = -1;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const e = score.events[i];
    if (e.kind !== 'directive') break;
    if (e.type === 'text') {
      di = i;
      break;
    }
  }
  const events = [...score.events];
  if (di >= 0) {
    events[di] = { ...events[di], value: trimmed } as Event;
  } else {
    const ns = score.part ? `p${score.part.id}:` : '';
    const id = `${ns}e${maxSeq(score.events.map((e) => e.id), 'e') + 1}`;
    events.splice(idx, 0, { id, kind: 'directive', type: 'text', value: trimmed });
  }
  return { ...score, events };
}

/** 附点 .：0 -> 1 -> 2 -> 0 循环，时值随附点数重算 */
export function cycleDot(score: Score, id: string): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || (e.kind !== 'note' && e.kind !== 'rest')) return e;
      const next = (((e.dot ?? 0) + 1) % 3) as 0 | 1 | 2;
      // 去掉旧附点再按新附点数还原：base = ticks / 旧系数
      const prev = e.dot ?? 0;
      const prevFactor = prev === 0 ? 1 : prev === 1 ? 1.5 : 1.75;
      const base = e.ticks / prevFactor;
      return { ...e, dot: next, ticks: withDots(base, next) };
    }),
  };
}

/** 删除事件；若它属于拍内组，删除后同组按守恒重新均分（§6.3 / §6.6） */
export function removeEvent(score: Score, id: string): Score {
  const target = score.events.find((e) => e.id === id);
  if (!target) return score;

  const events = score.events.filter((e) => e.id !== id).map((e) => {
    if (e.kind !== 'note' || e.hairpinTo !== id) return e;
    const { hairpinTo: _to, hairpin: _kind, ...rest } = e;
    return rest;
  });

  let groups = score.groups;
  const gid = (target as { groupId?: string }).groupId;
  if (gid) {
    const g = score.groups.find((x) => x.id === gid);
    if (g) {
      const memberIds = g.memberIds.filter((m) => m !== id);
      const parts = memberIds.length >= 2 ? distribute(g.totalTicks, memberIds.length) : [];
      // 重均分必须**全员合法 tick**：1½ 拍组（9/8 的 10080）删成 5 音会均分出
      // 2016（=10080/5）——不在合法时值表里、也没有记谱写法，序列化直接抛
      // 「没有对应的写法」白屏（用户实测删空乐谱）。与 setDot 同一守卫惯例：
      // 分不出合法值就解散组，各音保留原时值——删音本来就让总时值缩水，
      // 小节未满交给拍数校验徽标说话。
      const ok = parts.length === memberIds.length && parts.every((p) => isLegalTick(p) && p > 0);
      if (ok) {
        const byId: Record<string, number> = {};
        memberIds.forEach((m, i) => (byId[m] = parts[i]!));
        const patched = events.map((e) => {
          if (!(e.id in byId)) return e;
          const v = byId[e.id]!;
          // 重均分的值必须重算附点：残留旧 dot 会造出 tick 与附点矛盾的状态
          //（如 2240 = 1/3 拍却带 dot=1，序列化反推不出写法直接抛错白屏）。
          // decodeDuration 优先无附点解；连音成员（1/3 拍等）不在值域 → 显式清 0
          return { ...e, ticks: v, dot: decodeDuration(v)?.dots ?? 0 };
        });
        return {
          ...score,
          events: patched,
          groups: groups.map((x) => (x.id === gid ? { ...x, memberIds } : x)),
        };
      }
      // 剩不到 2 个成员，或重均分产不出合法时值 → 解散组
      groups = groups.filter((x) => x.id !== gid);
    }
  }

  // 删掉多小节休止的格子后，剩余格数重算（multibar 数字跟着变）
  return normalizeMultibarRests({ ...score, events, groups });
}

// ───────────────────────── 拍内组与档位 ─────────────────────────

export interface TierCandidate {
  label: string;
  ticks: number[];
  tuplet?: number;
  /**
   * 与 ticks 对齐的每音附点数（缺省全 0）。附点切分必须带上——
   * 「半拍+附点」= 36 tick，不写 dot 的话排版会画成四分音符的错样
   * （beamCount(36)=0，也没有增时线），数字看着是一拍响出来只有 0.75。
   */
  dots?: (0 | 1 | 2)[];
}

export function beatLabel(t: number): string {
  const beats = t / TICKS_PER_BEAT;
  if (Number.isInteger(beats)) return `${beats} 拍`;
  // 1/4 拍、1/3 拍（三连音）、3/4 拍（附点八分）都要说成人话。
  // 只试 2 的幂会漏掉 1/3，只试 1/2 会把 1/4 显示成「0.25 拍」。
  for (const den of [2, 3, 4, 5, 6, 7, 8, 12, 16]) {
    const num = Math.round(beats * den);
    if (num > 0 && Math.abs(beats * den - num) < 1e-6) {
      return num === 1 ? `1/${den} 拍` : `${num}/${den} 拍`;
    }
  }
  return `${beats.toFixed(2)} 拍`;
}

/**
 * 候选划分（§6.4）：均分、前八后十六 / 前十六后八、附点切分（两音）、
 * 对称切分（三音）、二分组合，以及 n = 3/5/6/7 时的 n 连音。
 * 常用组合覆盖所有音数——哪怕只有均分一档也要弹面板（用户要求：
 * 4/6/7/8 音选档位后要能看到候选并有「自定义组合」入口，不能静默画默认值）。
 */
export function candidatesFor(n: number, totalTicks: number): TierCandidate[] {
  const even = totalTicks / n;
  /** 每个音的 tick 都必须是合法粒度，否则写回去就是 I4 违反（如 3 tick） */
  const legal = (c: TierCandidate): boolean => c.ticks.every((x) => isLegalTick(x));
  const same = (a: TierCandidate, b: TierCandidate): boolean =>
    a.tuplet === b.tuplet &&
    JSON.stringify(a.ticks) === JSON.stringify(b.ticks) &&
    JSON.stringify(a.dots ?? null) === JSON.stringify(b.dots ?? null);
  const push = (out: TierCandidate[], c: TierCandidate): void => {
    if (!legal(c)) return;
    if (out.some((x) => same(x, c))) return;
    out.push(c);
  };

  if (n === 1) return [{ label: `整 ${beatLabel(totalTicks)}`, ticks: [totalTicks] }];

  const out: TierCandidate[] = [];

  // 前八后十六 / 前十六后八的泛化：前（后）一半时值 + 其余均分（n=2 退化成均分，不重复给）。
  // 「前八后十六」这个名字只对真·八分+十六分（2 幂体系）成立；6/8 系的
  // ¾拍+2×3/8 拍这类划分套这个名字会误导（八/十六是 2 幂词汇），用通用写法。
  // 两侧成员都必须**可书写**（decode 可解或靠增时线）：n=4 时 restEach 会算出
  // 1/6 拍（1120，六连音成员值），单独出现在非连音组里没有对应记号，不能给
  const writable = (t: number): boolean => !!decodeDuration(t) || durationShape(t).dashes > 0;
  const half = totalTicks / 2;
  const restEach = half / (n - 1);
  if (n >= 3 && Number.isInteger(half) && Number.isInteger(restEach) && restEach > 0
    && writable(half) && writable(restEach)) {
    const classic = half === TICKS_PER_BEAT / 2 && restEach === TICKS_PER_BEAT / 4;
    const fwd = classic ? '前八后十六' : `前 ${beatLabel(half)}`;
    const bwd = classic ? '前十六后八' : `后 ${n - 1}×${beatLabel(restEach)}`;
    push(out, { label: `${fwd}（${beatLabel(half)} + ${n - 1}×${beatLabel(restEach)}）`, ticks: [half, ...Array(n - 1).fill(restEach)] });
    push(out, { label: `${bwd}（${n - 1}×${beatLabel(restEach)} + ${beatLabel(half)}）`, ticks: [...Array(n - 1).fill(restEach), half] });
  }
  // 两音的附点切分：附点音占 3t/4、短音占 t/4，两个方向各一档。
  // 附点音的基准正好是均分值（1.5 × t/2 = 3t/4），所以带 dot=1。
  // t 不能被 4 整除或 3t/4 不是合法 tick（如 t=12 → 9/3、t=36 → 27）就自然出局。
  if (n === 2 && totalTicks % 4 === 0) {
    const q = totalTicks / 4;
    const a = totalTicks - q;
    const dotted = (first: boolean): TierCandidate => ({
      label: `${first ? '前音' : '后音'}附点 ${beatLabel(a)} + ${first ? '后音' : '前音'} ${beatLabel(q)}`,
      ticks: first ? [a, q] : [q, a],
      dots: first ? [1, 0] : [0, 1],
    });
    push(out, dotted(true));
    push(out, dotted(false));
  }
  // 三音的对称切分：两侧短音夹一个长音（1/4 + 1/2 + 1/4）——切分音的常见形态
  const quarter = totalTicks / 4;
  if (n === 3 && Number.isInteger(quarter) && quarter > 0) {
    push(out, {
      label: `前 ${beatLabel(quarter)} + 中 ${beatLabel(totalTicks / 2)} + 后 ${beatLabel(quarter)}`,
      ticks: [quarter, totalTicks / 2, quarter],
    });
  }
  // 二分组合：前 m 音均分前半 + 后 n-m 音均分后半。两侧的均分值都必须是
  // **可书写的常规时值**（带连音语义的混合划分 applyTier 表达不了，跳过）。
  // 从中间的切分点向外取，最多两档——控制候选数量（用户要求常用而非穷举）
  if (n >= 4) {
    const ms = Array.from({ length: n - 1 }, (_, i) => i + 1).sort(
      (a, b) => Math.abs(a - n / 2) - Math.abs(b - n / 2),
    );
    let added = 0;
    for (const m of ms) {
      if (added >= 2) break;
      const a = half / m;
      const b = half / (n - m);
      if (a <= 0 || b <= 0 || !Number.isInteger(a) || !Number.isInteger(b)) continue;
      if (!decodeDuration(a) || !decodeDuration(b)) continue;
      const before = out.length;
      push(out, {
        label: `前 ${m} 音各 ${beatLabel(a)} + 后 ${n - m} 音各 ${beatLabel(b)}`,
        ticks: [...Array(m).fill(a), ...Array(n - m).fill(b)],
      });
      if (out.length > before) added += 1;
    }
  }
  // 均分殿后：均分值能写成常规时值（decodeDuration 可解）就是普通均分，
  // 不管几个音——6/8 里 3 个八分凑满一大拍是**自然划分**，不是三连音（手册 §4.2）；
  // 只有均分值本身不可书写（1 拍 ÷ 3 = 2240 这种）才挂连音标号，且仅 3/5/6/7 音。
  // 连音组还有**跨度 ≤ 1 拍**的硬约束（I2 对连音组恒按 1 拍封顶；两拍连音
  // 在现有 DSL 无无损写法），6/4 的 2 拍档 × 6 音就不该出六连音候选
  if (Number.isInteger(even) && even > 0) {
    const plain = decodeDuration(even);
    if (plain) {
      push(out, { label: `均分，每音 ${beatLabel(even)}`, ticks: Array(n).fill(even) });
    } else if ([3, 5, 6, 7].includes(n) && totalTicks <= TICKS_PER_BEAT) {
      push(out, { label: `${n} 连音（每音 ${beatLabel(even)}，标号 ${n}）`, ticks: Array(n).fill(even), tuplet: n });
    }
    // 都不行（如 2 拍 ÷ 6 = 1/3 拍碎片：写不了常规值、连音又超跨度）就不给这档，
    // 面板里该档位自然禁用——不能塞一个画不出来也写不回的候选
  }
  return out.filter(legal);
}

/**
 * 3 分体系大拍的常用划分（手册 §4.2/§4.3）：在大拍的 **3 个小拍网格**上枚举——
 * 每个小拍要么与相邻格合并成附点值（2 格 = 附点四分）、要么整格 1 音、
 * 要么对半/四分细分（C/2、C/4）。出来的都是「三个八分」「附点四分+八分」
 * 「十六分十六分八分八分」这类真常用组合。
 *
 * 不能套泛用模板：前八后十六那套按 2 幂切，在 1½ 拍上会产出
 * 「附点八分 + 2×附点十六分」这种每音带点、跨小拍格的划分——合法但很少用
 * （用户实测 9/8 三音候选全是这种，视觉上还分不出差异）。
 */
export function compoundCandidates(n: number, unitTicks: number): TierCandidate[] {
  const C = unitTicks / 3;
  if (!Number.isInteger(C) || C <= 0 || n < 2) return [];
  const half = C / 2;
  const quarter = C / 4;
  if (!Number.isInteger(half) || !Number.isInteger(quarter) || quarter <= 0) return [];
  const out: TierCandidate[] = [];
  const seen = new Set<string>();
  const emit = (acc: number[]): void => {
    const key = acc.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    // 标签：全等 → 均分；否则按连续等值段压缩（「1 拍 + 2×1/4 拍」）
    if (acc.every((t) => t === acc[0])) {
      out.push({ label: `均分，每音 ${beatLabel(acc[0])}`, ticks: [...acc] });
      return;
    }
    const runs: string[] = [];
    let i = 0;
    while (i < acc.length) {
      let j = i;
      while (j < acc.length && acc[j] === acc[i]) j += 1;
      runs.push((j - i > 1 ? `${j - i}×` : '') + beatLabel(acc[i]));
      i = j;
    }
    out.push({ label: runs.join(' + '), ticks: [...acc] });
  };
  const rec = (cell: number, left: number, acc: number[]): void => {
    if (cell === 3) {
      if (left === 0) emit(acc);
      return;
    }
    if (left <= 0) return;
    if (left > (3 - cell) * 4) return; // 剩余格每格最多细分成 4 音
    if (cell <= 1) rec(cell + 2, left - 1, [...acc, 2 * C]); // 相邻两格合并 = 附点值
    rec(cell + 1, left - 1, [...acc, C]); // 整格 1 音
    if (left >= 2) rec(cell + 1, left - 2, [...acc, half, half]); // 对半细分
    if (left >= 4) rec(cell + 1, left - 4, [...acc, quarter, quarter, quarter, quarter]); // 四分细分
  };
  rec(0, n, []);
  // 越「均衡」越常用（均分 > 一处细分 > 多处细分），同分保持枚举序；控量给常用
  const rank = (c: TierCandidate): number => Math.max(...c.ticks) / Math.min(...c.ticks);
  return out.sort((a, b) => rank(a) - rank(b)).slice(0, 6);
}

/**
 * 音值组合流程的候选入口（属性面板 / 浮动输入板 / 自定义弹窗共用）：
 * 目标恰好是所在拍号的**大拍**且为 3 分体系（6/8 系 1½ 拍、6/4 3 拍）时，
 * 按小拍网格出常用划分；其余（单拍子全部档位、复拍子的子档位）走泛用模板——
 * 那套模板本来就是按 2 幂体系调的，1 拍以内的划分它给得又准又常用。
 */
export function groupCandidates(n: number, totalTicks: number, beat?: string): TierCandidate[] {
  const unit = beat ? groupTicks(beat) : 0;
  if (unit && unit !== TICKS_PER_BEAT && totalTicks === unit) {
    const cands = compoundCandidates(n, totalTicks);
    if (cands.length) return cands;
  }
  return candidatesFor(n, totalTicks);
}

/**
 * 候选成员的**画法**（减时线 + 附点），属性面板与浮动输入板的候选预览共用。
 *
 * 成员是 3 分体系值（5040 = 附点八分、2520 = 附点十六分）时，
 * `beamCount` 这类 2 幂公式会算出 0 条线——必须走 decodeDuration 反推，
 * 附点也一起反推，否则 9/8 的候选全是裸数字，视觉上分不出差异（用户实测）。
 * 连音成员 decodeDuration 解不出来，按连音层数画线、附点用候选自带的。
 */
export function candidateGlyph(
  cand: TierCandidate,
  totalTicks: number,
): { beams: number[]; dots: (0 | 1 | 2)[]; dashes: number[] } {
  return {
    beams: cand.ticks.map((t) =>
      cand.tuplet ? tupletBeamCount(totalTicks, cand.tuplet) : decodeDuration(t)?.beams ?? 0,
    ),
    dots: cand.ticks.map((_, i) => cand.dots?.[i] ?? decodeDuration(cand.ticks[i])?.dots ?? 0),
    // 超过一拍的成员靠增时线写（附点二分 = `1-.`）：预览里也要画出来，
    // 否则 6/4 的 3 拍档候选全是裸数字，看不出时值差异
    dashes: cand.tuplet ? cand.ticks.map(() => 0) : cand.ticks.map((t) => durationShape(t).dashes),
  };
}

/**
 * 音值组合的**全部档位**（不分音数，浮动输入板用它摆按钮、再按音数禁用）：
 * 来自拍号的连通档位表（meter.groupTierBeats，手册 §7）——
 * 4/4 系是 1/½/¼/⅛ 拍，6/8 系是 1½/1/¾/½/3/8 拍，6/4 是 3/2/1½/1/¾ 拍。
 */
export function groupTierOptions(beat: string): DurationTier[] {
  return groupTierBeats(beat)
    .map((b) => {
      const ticks = Math.round(b * TICKS_PER_BEAT);
      return { label: beatLabel(ticks), ticks };
    })
    .filter((t) => t.ticks > 0);
}

/**
 * 选区档位：多选时档位的语义是「**整个选区的总时值**」，不是每个音的时值。
 *
 * 上限是所在拍号的**连通单位**（groupTicks：单拍子 1 拍、6/8 系 1½ 拍、6/4 3 拍）——
 * 组不能跨大拍（手册 §6：跨大拍必须断开，只能用延音线），所以档位表按拍号出：
 * 6/8 里组合最多凑 1½ 拍，4/4 里最多 1 拍。
 *
 * 同时要求划分出来的每个音都是合法 tick 粒度（I4）：
 * 4 个音分 1/4 拍 = 每音 3 tick，不是合法时值，这一档就不该出现。
 */
export function groupTiers(n: number, beat: string): DurationTier[] {
  return groupTierOptions(beat).filter(
    (t) => n >= 2 && groupCandidates(n, t.ticks, beat).length > 0,
  );
}

/** 自定义组合的减时线上限（3 线 = 1/8 拍，三十二分）。要表达更细分值时放宽这里 */
export const MAX_BEAMS = 3;

/**
 * 时值反解成「减时线 + 附点」（自定义组合弹窗的值域）：
 * ticks = 基准 ÷ 2^线 × 附点系数（先剥线再套点，与 DSL 写回校验同构——
 * 口径不一致的组合会被静默丢弃，这是 0.2.125 记过的坑）。
 * 连音成员（1/3、1/5 拍…）不在此值域内，返回 null——那些走均分路径。
 */
export function decodeDuration(ticks: number): { beams: number; dots: 0 | 1 | 2 } | null {
  if (!isLegalTick(ticks)) return null;
  for (let beams = 0; beams <= MAX_BEAMS; beams += 1) {
    const unit = TICKS_PER_BEAT / 2 ** beams;
    for (const dots of [0, 1, 2] as const) {
      if (Math.round(unit * (dots === 0 ? 1 : dots === 1 ? 1.5 : 1.75)) === ticks) {
        return { beams, dots };
      }
    }
  }
  return null;
}

/**
 * 时值拆成谱面上的零件：几条增时线 + 几条减时线 + 几个附点。
 *
 * 先按整拍剥增时线（`5 - -` = 3 拍），剩下的零头再按「减时线 + 附点」反解
 * （`5·` = 1.5 拍、`5` 下加一线再加点 = 3/4 拍）——与谱面写法一一对应。
 * 时值按钮 / 输入板要把时值画成谱面的样子，就靠它，不能靠「1/4 拍」这种文字。
 */
export function durationShape(ticks: number): { dashes: number; beams: number; dots: number } {
  const dashes = Math.max(0, Math.floor(ticks / TICKS_PER_BEAT + 1e-9) - 1);
  const d = decodeDuration(ticks - dashes * TICKS_PER_BEAT);
  return { dashes, beams: d?.beams ?? 0, dots: d?.dots ?? 0 };
}

/**
 * 应用档位：把选中的连续音符打包成（或重设）一个拍内组，并按给定划分写回时值。
 * 返回 null 表示选区不合法。
 */
export function applyTier(
  score: Score,
  ids: string[],
  totalTicks: number,
  ticks?: number[],
  tuplet?: number,
  dots?: (0 | 1 | 2)[],
): Score | null {
  if (ids.length === 0) return null;

  // 选区必须在 events 中连续，且只能是 note / rest
  const positions = ids
    .map((id) => score.events.findIndex((e) => e.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (positions.length !== ids.length) return null;
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] !== positions[i - 1] + 1) return null;
  }
  const members = positions.map((i) => score.events[i]);
  if (members.some((m) => m.kind !== 'note' && m.kind !== 'rest')) return null;

  // 划分：显式给出则用之，否则均分
  const parts = ticks && ticks.length === members.length ? ticks : distribute(totalTicks, members.length);
  const sum = parts.reduce((a, b) => a + b, 0);
  // 受选区影响的已有组：组里含**任一**选中音就算。只按首成员的组改写的话，
  // 跨组选区（框住 A 组尾 + B 组头）会让 B 组原样留着这些成员——一个音同时
  // 挂两个组，谱面两根同层减时线画在同一位置（用户实测线段重叠），序列化
  // 还会写出互相嵌套的 < >。
  const byGroup = new Map<string, BeatGroup>();
  for (const m of members) {
    const g0 = (m as { groupId?: string }).groupId;
    if (!g0 || byGroup.has(g0)) continue;
    const g = score.groups.find((x) => x.id === g0);
    if (g) byGroup.set(g0, g);
  }
  const memberKey = members.map((m) => m.id).join(',');
  const exact =
    byGroup.size === 1 && [...byGroup.values()][0]!.memberIds.join(',') === memberKey
      ? [...byGroup.values()][0]!
      : undefined;

  let groups: BeatGroup[];
  let newGid: string;
  const freed = new Set<string>();
  if (exact) {
    // 选区恰好等于这个组：就地改写（保留组 id）。必须**显式剥掉**旧 tuplet：
    // 不传 tuplet（弹窗取消勾选连音、改成自由组合）而组上还挂着 tuplet 的话，
    // 绘制照旧标连音——用户实测「取消勾选改了组合，点对勾还是连音」就是这个坑
    groups = score.groups.map((g) => {
      if (g.id !== exact.id) return g;
      const { tuplet: _old, ...rest } = g;
      return {
        ...rest,
        auto: undefined,
        totalTicks: sum,
        memberIds: members.map((m) => m.id),
        ...(tuplet ? { tuplet } : {}),
      };
    });
    newGid = exact.id;
  } else {
    // 其余情况（原来无组 / 跨组 / 组的子集或超集）：含选中音的组**整体解散**——
    // 抽走成员后的残组凑不满原总时值（违反 I1），不能留着。解散释放的成员
    // 由随后的 autoGroupBeats 按拍重新归组。
    const selected = new Set(members.map((m) => m.id));
    for (const g of byGroup.values()) {
      for (const id of g.memberIds) if (!selected.has(id)) freed.add(id);
    }
    newGid = newIds(score).grp;
    groups = [
      ...score.groups.filter((g) => !byGroup.has(g.id)),
      {
        id: newGid,
        totalTicks: sum,
        memberIds: members.map((m) => m.id),
        ...(tuplet ? { tuplet } : {}),
      },
    ];
  }

  const byId: Record<string, { ticks: number; dot: 0 | 1 | 2 }> = {};
  // dot：候选显式给的优先；没给的**按 tick 反推**——3 分体系成员本身带附点
  // （5040 = 附点八分），写 dot=0 会造出 tick/dot 矛盾，serializeDsl 直接抛
  // 「没有对应的写法」（0.2.147 同款坑：任何写 ticks 的代码都要同步重算 dot）
  members.forEach(
    (m, i) => (byId[m.id] = { ticks: parts[i], dot: dots?.[i] ?? decodeDuration(parts[i])?.dots ?? 0 }),
  );

  return {
    ...score,
    groups,
    events: score.events.map((e) => {
      const p = byId[e.id];
      if (p) {
        // dot 一律显式写（0 = 无点）：附点切分换档后旧附点不能残留
        return { ...e, ticks: p.ticks, dot: p.dot, groupId: newGid };
      }
      // 被解散组的落选成员：组没了，groupId 一并清掉（挂空引用会让
      // 序列化 / 校验口径错乱）
      if (freed.has(e.id)) {
        const { groupId: _g, ...rest } = e as Event & { groupId?: string };
        return rest as Event;
      }
      return e;
    }),
  };
}

/**
 * 单个音符改时值。
 *
 * 不走 applyTier：一个音单独成组只会产出一个 `g` 空壳（序列化还会多写一层 `<>`），
 * 而改动组内单个成员又会破坏 Σ成员 = 组总时值（I1）。
 * 所以先把所在组解散再改时值——组里原本的减时线由 autoGroupBeats 重新推导。
 * 单独的八分 / 十六分音符即使不在组里，layout 也会按 beamCount 自行画线。
 */
export function setTicks(score: Score, id: string, ticks: number): Score {
  const ev = score.events.find((e) => e.id === id);
  if (!ev || !isTimed(ev)) return score;
  const dot = (ev as { dot?: 0 | 1 | 2 }).dot ?? 0;
  const gid = (ev as { groupId?: string }).groupId;
  const base = gid ? ungroup(score, gid) : score;
  // 附点是独立开关：换档位不掉点。2.. 选八分档，得到的是附点八分
  const target = withDots(ticks, dot);
  return {
    ...base,
    events: base.events.map((e) => (e.id === id ? { ...e, ticks: target } : e)),
  };
}

/**
 * 自动成组：连续音符若时值之和恰好 1 拍，就打包成一个拍内组，
 * 让减时线连续拉通（不必手动框选再套档位）。
 *
 * 约束：
 *   - 只从整拍位置起算；跨拍的组合（如附点共 1.5 拍）不合并
 *   - 至少 2 个音；单个满 1 拍的音不建组
 *   - **只增不减**：已存在的组（含用户手动建的）一律不动，
 *     所以反复调用是幂等的，也不会把用户的意图拆掉
 */
export function autoGroupBeats(score: Score): Score {
  const noteIds = new Set(score.events.filter((e) => e.kind === 'note').map((e) => e.id));
  if (score.events.some((e) => e.kind === 'note' && e.hairpinTo && !noteIds.has(e.hairpinTo))) {
    score = { ...score, events: score.events.map((e) => {
      if (e.kind !== 'note' || !e.hairpinTo || noteIds.has(e.hairpinTo)) return e;
      const { hairpinTo: _to, hairpin: _kind, ...rest } = e;
      return rest;
    }) };
  }
  if (score.format === 3 && score.groups.some((g) => g.auto)) {
    const keep = score.groups.filter((g) => !g.auto);
    const keptIds = new Set(keep.map((g) => g.id));
    score = { ...score, groups: keep, events: score.events.map((e) => {
      if ('groupId' in e && e.groupId && !keptIds.has(e.groupId)) {
        const { groupId: _g, ...rest } = e;
        return rest;
      }
      return e;
    }) };
  }
  let beatTicks = score.format === 3 ? groupTicks(score.meta.beat) : TICKS_PER_BEAT;
  const grouped = new Set<string>();
  for (const g of score.groups) for (const id of g.memberIds) grouped.add(id);
  const existing = new Set(score.groups.map((g) => g.memberIds.join(',')));

  const added: BeatGroup[] = [];
  let seq = maxSeq(score.groups.map((g) => g.id), 'g');
  let tick = 0;
  let run: string[] = [];
  let sum = 0;

  const flush = (): void => {
    const shortOnly = run.every((id) => {
      const e = score.events.find((event) => event.id === id);
      return e && isTimed(e) && undotTicks(e.ticks, e.dot ?? 0) < TICKS_PER_BEAT;
    });
    if (run.length >= 2 && sum === beatTicks && shortOnly && !existing.has(run.join(','))) {
      seq += 1;
      added.push({ id: `${score.part ? `p${score.part.id}:` : ''}g${seq}`, totalTicks: beatTicks, memberIds: [...run], ...(score.format === 3 ? { auto: true } : {}) });
    }
    run = [];
    sum = 0;
  };

  for (const ev of score.events) {
    if (ev.kind === 'barline') {
      flush();
      if (score.format === 3) tick = 0;
      if (score.format === 3 && ev.beatAfter) beatTicks = groupTicks(ev.beatAfter);
      continue;
    }
    if (ev.kind !== 'note' && ev.kind !== 'rest') continue; // 换气 / 力度不打断

    if (grouped.has(ev.id)) {
      flush();
      tick += ev.ticks;
      continue;
    }
    if (tick % beatTicks === 0) {
      run = [ev.id];
      sum = ev.ticks;
    } else if (run.length > 0) {
      run.push(ev.id);
      sum += ev.ticks;
    }
    tick += ev.ticks;
    if (sum >= beatTicks) flush();
  }
  flush();

  if (added.length === 0) return score;
  const gidOf = new Map<string, string>();
  for (const g of added) for (const id of g.memberIds) gidOf.set(id, g.id);
  return {
    ...score,
    groups: [...score.groups, ...added],
    events: score.events.map((e) =>
      gidOf.has(e.id) ? { ...e, groupId: gidOf.get(e.id)! } : e,
    ),
  };
}

/**
 * 换拍号后的善后：乐曲中途变拍（如 6/8 变 4/4）时，原有组可能超过**新**拍号的
 * 连通单位（6/8 的 1½ 拍组在 4/4 里越界，违反 I2）。这里把超限的组就地解散，
 * 交给 autoGroupBeats 按新单位重新分组——能凑满一单位的自动成组，
 * 凑不满的留作散音，减时线按各自时值画。连音组不动（连音边界不在单位上，
 * 解掉它会让标号消失，用户得重新指定）。
 *
 * 只该在**拍号确实变了**的时候调用（小节线检查器改拍号、曲信息改拍号）；
 * 平时的编辑走 autoGroupBeats 就够，不能把用户手动建的组拆掉。
 */
export function resplitOversizedGroups(score: Score): Score {
  // 多声部：每个声部各自重排（拍号跟该声部的小节线走，全局 events 交错着
  // 别的声部的小节线，meterAt 直接扫会串）——与 EditorApp 的逐声部
  // autoGroupBeats 同一套模式
  if (score.parts?.length) {
    return assembleParts(
      score,
      scoreParts(score).map((p) => {
        const fixed = resplitOversizedGroups(partScore(score, p.id));
        return { ...p, events: fixed.events, groups: fixed.groups };
      }),
    );
  }
  const index = new Map<string, number>();
  score.events.forEach((e, i) => index.set(e.id, i));
  const dropped = new Set<string>();
  for (const g of score.groups) {
    if (g.tuplet) continue;
    const start = index.get(g.memberIds[0] ?? '') ?? -1;
    if (start < 0) continue;
    const unit = score.format === 3 ? groupTicks(meterAt(score, start)) : TICKS_PER_BEAT;
    if (g.totalTicks > unit) dropped.add(g.id);
  }
  if (dropped.size === 0) return score;
  const kept = score.groups.filter((g) => !dropped.has(g.id));
  const keptIds = new Set(kept.flatMap((g) => g.memberIds));
  return autoGroupBeats({
    ...score,
    groups: kept,
    events: score.events.map((e) => {
      if ('groupId' in e && e.groupId && !keptIds.has(e.groupId)) {
        const { groupId: _g, ...rest } = e;
        return rest;
      }
      return e;
    }),
  });
}

/** 解散拍内组，成员保留当前时值 */
export function ungroup(score: Score, groupId: string): Score {
  const g = score.groups.find((x) => x.id === groupId);
  if (!g) return score;
  return {
    ...score,
    groups: score.groups.filter((x) => x.id !== groupId),
    events: score.events.map((e) => {
      if ((e as { groupId?: string }).groupId !== groupId) return e;
      const copy = { ...e } as Event & { groupId?: string };
      delete copy.groupId;
      return copy;
    }),
  };
}

// ───────────────────────── 属性检查器用的单点操作 ─────────────────────────

/**
 * 改音级；degree 0 表示转成休止符。
 *
 * 音 → 休止符时，挂在这个音上的**转调顺延到下一个音**：休止符承载不了调号，
 * 而「从这里起转调」是位置记号，不该跟着音一起消失（按 0 把标了转调的音改成休止符，
 * 整段转调就无声无息没了）。顺延语义与 DSL 一致：`转1=G 0 5` 里转调落在那个 5 上。
 */
export function setDegree(score: Score, id: string, degree: number): Score {
  const at = score.events.findIndex((e) => e.id === id);
  const cur = at >= 0 ? score.events[at] : undefined;
  const handOver =
    degree === 0 && cur?.kind === 'note' && cur.keyChange
      ? { key: cur.keyChange, from: at }
      : null;

  const events = score.events.map((e, i) => {
    if (i !== at) return e;
    if (degree === 0) {
      if (e.kind !== 'note') return e; // 只有音符能转成休止符
      const rest: RestEvent = { id: e.id, kind: 'rest', ticks: e.ticks };
      if (e.groupId) rest.groupId = e.groupId;
      return rest;
    }
    if (e.kind === 'note') return { ...e, degree: degree as Degree };
    if (e.kind === 'rest') {
      const note: NoteEvent = {
        id: e.id,
        kind: 'note',
        degree: degree as Degree,
        octave: 0,
        ticks: e.ticks,
        dot: 0,
      };
      if (e.groupId) note.groupId = e.groupId;
      return note;
    }
    return e;
  });

  if (handOver) {
    // 顺延到后面第一个音符；它自己已经标了别的转调就不覆盖（后写的指令更明确）
    for (let i = handOver.from + 1; i < events.length; i += 1) {
      const e = events[i];
      if (e.kind !== 'note') continue;
      if (!e.keyChange) events[i] = { ...e, keyChange: handOver.key };
      break;
    }
  }

  return { ...score, events };
}

/** 直接设定八度（属性面板用，不用叠加） */
export function setOctave(score: Score, id: string, octave: number): Score {
  return {
    ...score,
    events: score.events.map((e) =>
      e.id === id && e.kind === 'note' ? { ...e, octave: Math.max(-3, Math.min(3, octave)) } : e,
    ),
  };
}

/** 直接设定附点数 */
/**
 * 给定时值，找出它「加点前」的基准时值：
 *   72（1.5 拍）→ 48（写成附点 `5.`，而不是 `5/2-` 再加点）
 * 命中顺序：正好是基准 → 1.5×基准 → 1.75×基准。
 * 找不到（连音成员 16/8 等）返回 undefined。
 *
 * 附点按钮的显示与 setDot 都走它：对 `5/2-` 这类「除法+增时线」写法加点，
 * 若直接拿 72 乘 1.5 会得到 108——序列化成 `5./2-`，回读却变成 84，round-trip 破坏。
 * 归一到 48 后加点才是 `5.`（72），声音不变、写法合法、可无损还原。
 */
export function canonicalDurationBase(ticks: number): number | undefined {
  for (const b of [TICKS_PER_BEAT * 4, TICKS_PER_BEAT * 2, TICKS_PER_BEAT, TICKS_PER_BEAT / 2, TICKS_PER_BEAT / 4, TICKS_PER_BEAT / 8]) {
    if (ticks === b) return b;
    if (ticks === withDots(b, 1)) return b;
    if (ticks === withDots(b, 2)) return b;
  }
  return undefined;
}

export function setDot(score: Score, id: string, dots: 0 | 1 | 2): Score {
  const ev = score.events.find((e) => e.id === id);
  if (!ev || (ev.kind !== 'note' && ev.kind !== 'rest')) return score;
  const prev = ev.dot ?? 0;
  // 基准时值：带点的按点数还原；不带点的先归一到「加点前基准」
  const base =
    prev > 0 ? ev.ticks / (prev === 1 ? 1.5 : 1.75) : (canonicalDurationBase(ev.ticks) ?? ev.ticks);
  const target = withDots(base, dots);

  // 拍内组守恒（I1）：本音加点占掉多少，同组其余成员按守恒重分——
  // 两音 1 拍组里给一个音加附点（0.5 → 0.75 拍），另一个自动变 1/4 拍，
  // 否则 Σ成员 ≠ 组总时值，这拍就悄悄变长了。分不动（剩余不够最小合法粒度）
  // 才解散组，退回「单音改」的语义（与 setTicks 一致）。
  const gid = (ev as { groupId?: string }).groupId;
  const g = gid ? score.groups.find((x) => x.id === gid) : undefined;
  if (g) {
    const others = g.memberIds.filter((m) => m !== id);
    const remain = g.totalTicks - target;
    const parts = remain > 0 ? distribute(remain, others.length) : [];
    const ok = others.length >= 1 && parts.length === others.length && parts.every((p) => isLegalTick(p) && p > 0);
    if (ok) {
      const byId: Record<string, number> = {};
      others.forEach((m, i) => (byId[m] = parts[i]));
      return {
        ...score,
        events: score.events.map((e) => {
          if (e.id === id) return { ...e, dot: dots, ticks: target };
          // 重分直接给定 tick，旧附点必须清掉（带点的 ticks 不再是纯时值）
          return e.id in byId ? { ...e, ticks: byId[e.id], dot: 0 } : e;
        }),
      };
    }
    const dissolved = ungroup(score, gid!);
    return {
      ...dissolved,
      events: dissolved.events.map((e) => (e.id === id ? { ...e, dot: dots, ticks: target } : e)),
    };
  }

  return {
    ...score,
    events: score.events.map((e) => (e.id === id ? { ...e, dot: dots, ticks: target } : e)),
  };
}

/** 插入力度记号（不占时值，画在谱行下方） */
export function insertDynamic(score: Score, at: number, value: string): Score {
  const id = newIds(score).ev;
  return insert(score, at, { id, kind: 'directive', type: 'dynamic', value });
}

// ───────────────────────── 连线 ─────────────────────────

/**
 * 圆滑线：给一段连续的音符建立链式 slur（重复调用可取消）。
 *
 * 开关语义：**只要选区内已经存在连线，就整体取消；否则整体建立**。
 * 不用「全部都有边才取消」——那样选区里只连了一部分时，按下去是补齐而不是取消，
 * 用户会发现「按几次都取消不掉」。现在一次按键必定可逆。
 *
 * 另一个约束：一个音**至多一条出边、至多一条入边**，连线是一条链，不分叉也不并流。
 * 这条不是洁癖：排版（slurNext）和序列化（slurSpan）都是以起点为键的映射，
 * 一旦分叉，多出来的边会被静默丢掉，数据里有连线而画面上看不见；
 * 用户去取消时清掉的是看不见那条，看得见那条纹丝不动。
 * 所以建立新边时就把同源 / 同目标的旧边一并清掉。
 */
export function toggleSlur(score: Score, ids: string[]): Score {
  const notes = ids
    .map((id) => score.events.find((e) => e.id === id))
    .filter((e): e is NoteEvent => !!e && e.kind === 'note');
  if (notes.length < 2) return score;

  const noteIds = new Set(notes.map((n) => n.id));
  /** 选区内是否已经有连线（两端都在选区内） */
  const hasAny = notes.some((n) =>
    (n.ties ?? []).some((t) => t.kind === 'slur' && noteIds.has(t.to)),
  );

  /** 本次要新建的边：起点 → 终点 */
  const addOut = new Map<string, string>();
  const addIn = new Set<string>();
  if (!hasAny) {
    for (let i = 0; i < notes.length - 1; i += 1) {
      addOut.set(notes[i].id, notes[i + 1].id);
      addIn.add(notes[i + 1].id);
    }
  }

  return {
    ...score,
    events: score.events.map((e) => {
      if (e.kind !== 'note') return e;
      const ties = e.ties ?? [];

      const kept = ties.filter((t) => {
        if (t.kind !== 'slur') return true;
        // 选区内部的旧边：取消时全清，建立时由下面统一重加
        if (noteIds.has(e.id) && noteIds.has(t.to)) return false;
        // 本音马上要有一条新出边，旧出边会造成分叉
        if (addOut.has(e.id)) return false;
        // 目标马上会有一条新入边，这条旧边会造成并流
        if (addIn.has(t.to)) return false;
        return true;
      });

      const next = addOut.has(e.id)
        ? [...kept, { to: addOut.get(e.id)!, kind: 'slur' as const }]
        : kept;

      if (next.length === 0) {
        const copy = { ...e };
        delete copy.ties; // 删掉键，保持与解析结果一致
        return copy;
      }
      return { ...e, ties: next };
    }),
  };
}

/**
 * 连音线**向右续连一个音**（浮动输入板的「连音线」按钮）：
 * 从 startId 沿已有 slur 链走到末端，再向右连下一个音（末端按定义没有出边，
 * 所以每次调用都是「多连一个」）。不跨小节线 / 跳转记号。
 *
 * 与 toggleSlur 的「选区建链 / 整段取消」互补——用户按一次多连一个音，
 * 再按一次再多连一个音（浮动输入板要求）。
 */
export function extendSlurRight(score: Score, startId: string): Score {
  const byId = new Map<string, Event>(score.events.map((e) => [e.id, e]));
  const first = byId.get(startId);
  if (!first || first.kind !== 'note') return score;
  let last: NoteEvent = first;
  // 沿出边走到链末端（guard 防环）
  for (let guard = 0; guard <= score.events.length; guard += 1) {
    const out = last.ties?.find((t) => t.kind === 'slur');
    if (!out) break;
    const next = byId.get(out.to);
    if (!next || next.kind !== 'note') break;
    last = next;
  }
  // 右邻第一个音符（不跨小节线 / 跳转）
  const from = score.events.findIndex((e) => e.id === last.id);
  let target: string | null = null;
  for (let i = from + 1; i < score.events.length; i += 1) {
    const e = score.events[i];
    if (!e) break;
    if (e.kind === 'note') {
      target = e.id;
      break;
    }
    if (e.kind === 'barline' || e.kind === 'jump') break;
  }
  if (!target) return score;
  return toggleSlur(score, [last.id, target]);
}
