/**
 * 编辑操作（M1）：全部是 Score -> Score 的纯函数，可单测、可命令行跑。
 * 与渲染无关，与 UI 无关。
 *
 * 录入规则（§6.1）：默认时值 1 拍作为占位值，系统绝不自动均分（Q25），
 * 时值必须由用户后续通过框选 + 档位指定。
 */

import { distribute } from './reseat';
import { normalizeKey } from './timeline';
import {
  durationTiers,
  isLegalTick,
  TICKS_PER_BEAT,
  withDots,
  type DurationTier,
} from './ticks';
import { isTimed } from './types';
import type {
  Accidental,
  Articulation,
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
    const n = Number(id.startsWith(prefix) ? id.slice(prefix.length) : NaN);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m;
}

function newIds(score: Score): { ev: string; grp: string } {
  return {
    ev: `e${maxSeq(score.events.map((e) => e.id), 'e') + 1}`,
    grp: `g${maxSeq(score.groups.map((g) => g.id), 'g') + 1}`,
  };
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
): { score: Score; cursor: number } | null {
  if (clip.length === 0) return null;

  let seq = maxSeq(score.events.map((e) => e.id), 'e');
  let gseq = maxSeq(score.groups.map((g) => g.id), 'g');

  const idMap = new Map<string, string>();
  const fresh = clip.map((e) => {
    const id = `e${++seq}`;
    idMap.set(e.id, id);
    return { ...e, id };
  });

  const clipIds = new Set(clip.map((e) => e.id));
  const groupMap = new Map<string, string>();
  for (const g of score.groups) {
    if (g.memberIds.length > 0 && g.memberIds.every((id) => clipIds.has(id))) {
      groupMap.set(g.id, `g${++gseq}`);
    }
  }

  const cloned = fresh.map((e, i) => {
    const next = { ...e } as Event & { ties?: unknown; groupId?: string };
    const orig = clip[i];
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

  const newGroups: BeatGroup[] = score.groups
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
  return insert(score, at, note);
}

export function insertRest(score: Score, at: number): Score {
  const id = newIds(score).ev;
  const rest: RestEvent = { id, kind: 'rest', ticks: QUARTER };
  return insert(score, at, rest);
}

export function insertBarline(score: Score, at: number, style: 'single' | 'final' = 'single'): Score {
  const id = newIds(score).ev;
  return insert(score, at, { id, kind: 'barline', style });
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
    (!Number.isInteger(next.patch) || next.patch < 0 || next.patch > 127)
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
    (!Number.isFinite(next.letterSpacing) || next.letterSpacing < -4 || next.letterSpacing > 24)
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
export function setBarlineStyle(score: Score, id: string, style: 'single' | 'final'): Score {
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

/** 八度 ^ / v，可叠加（§6.6 Alt+↑/↓ 在此由 delta 表达） */
export function shiftOctave(score: Score, id: string, delta: number): Score {
  return {
    ...score,
    events: score.events.map((e) =>
      e.id === id && e.kind === 'note' ? { ...e, octave: e.octave + delta } : e,
    ),
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
export function setHairpin(score: Score, id: string, v?: 'cresc' | 'dim'): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
      const copy = { ...e };
      if (v && v !== e.hairpin) copy.hairpin = v;
      else delete copy.hairpin;
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

/** 附点 .：0 -> 1 -> 2 -> 0 循环，时值随附点数重算 */
export function cycleDot(score: Score, id: string): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      if (e.id !== id || e.kind !== 'note') return e;
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

  const events = score.events.filter((e) => e.id !== id);

  let groups = score.groups;
  const gid = (target as { groupId?: string }).groupId;
  if (gid) {
    const g = score.groups.find((x) => x.id === gid);
    if (g) {
      const memberIds = g.memberIds.filter((m) => m !== id);
      if (memberIds.length >= 2) {
        const parts = distribute(g.totalTicks, memberIds.length);
        const byId: Record<string, number> = {};
        memberIds.forEach((m, i) => (byId[m] = parts[i]));
        const patched = events.map((e) =>
          e.id in byId ? { ...e, ticks: byId[e.id] } : e,
        );
        return {
          ...score,
          events: patched,
          groups: groups.map((x) => (x.id === gid ? { ...x, memberIds } : x)),
        };
      }
      // 剩不到 2 个成员 -> 解散组
      groups = groups.filter((x) => x.id !== gid);
    }
  }

  return { ...score, events, groups };
}

// ───────────────────────── 拍内组与档位 ─────────────────────────

export interface TierCandidate {
  label: string;
  ticks: number[];
  tuplet?: number;
}

function beatLabel(t: number): string {
  const beats = t / TICKS_PER_BEAT;
  if (Number.isInteger(beats)) return `${beats} 拍`;
  // 1/4 拍、1/3 拍（三连音）、3/4 拍（附点八分）都要说成人话。
  // 只试 2 的幂会漏掉 1/3，只试 1/2 会把 1/4 显示成「0.25 拍」。
  for (const den of [2, 3, 4, 6, 8, 12, 16]) {
    const num = Math.round(beats * den);
    if (num > 0 && Math.abs(beats * den - num) < 1e-6) {
      return num === 1 ? `1/${den} 拍` : `${num}/${den} 拍`;
    }
  }
  return `${beats.toFixed(2)} 拍`;
}

/**
 * 候选划分（§6.4）：n 为 2 的幂时均分无歧义直接应用；
 * n = 3/5/6/7 时给出前八后十六、前十六后八、n 连音三选一。
 */
export function candidatesFor(n: number, totalTicks: number): TierCandidate[] {
  const even = totalTicks / n;
  /** 每个音的 tick 都必须是合法粒度，否则写回去就是 I4 违反（如 3 tick） */
  const legal = (c: TierCandidate): boolean => c.ticks.every((x) => isLegalTick(x));

  if (n === 1) return [{ label: `整 ${beatLabel(totalTicks)}`, ticks: [totalTicks] }];
  if (n === 2 || n === 4 || n === 8) {
    return Number.isInteger(even)
      ? [{ label: `均分，每音 ${beatLabel(even)}`, ticks: Array(n).fill(even) }].filter(legal)
      : [];
  }

  const out: TierCandidate[] = [];
  const half = totalTicks / 2;
  const restEach = half / (n - 1);
  if (Number.isInteger(half) && Number.isInteger(restEach) && restEach > 0) {
    out.push({ label: `前八后十六（${beatLabel(half)} + ${n - 1}×${beatLabel(restEach)}）`, ticks: [half, ...Array(n - 1).fill(restEach)] });
    out.push({ label: `前十六后八（${n - 1}×${beatLabel(restEach)} + ${beatLabel(half)}）`, ticks: [...Array(n - 1).fill(restEach), half] });
  }
  // 三音的对称切分：两侧十六分夹一个八分（1/4 + 1/2 + 1/4）——切分音的常见形态
  const quarter = totalTicks / 4;
  if (n === 3 && Number.isInteger(quarter) && quarter > 0) {
    out.push({ label: '前1/4拍 + 中1/2拍 + 后1/4拍', ticks: [quarter, totalTicks / 2, quarter] });
  }
  const tupletEach = Math.round(even);
  if (tupletEach > 0) {
    out.push({ label: `${n} 连音（每音 ${beatLabel(tupletEach)}，标号 ${n}）`, ticks: Array(n).fill(tupletEach), tuplet: n });
  }
  return out.filter(legal);
}

/**
 * 选区档位：多选时档位的语义是「**整个选区的总时值**」，不是每个音的时值。
 *
 * 受 I2 约束，总时值不能超过 1 拍——简谱里超过一拍的长音用增时线写在**单个音**上
 * （`5 - -`），不存在「几个音连起来共用一条减时线、合计 2 拍」的写法。
 * 所以选多音时不该给「2 拍 / 3 拍 / 1 小节」这类档位：按下去会建出违反 I2 的拍内组。
 *
 * 同时要求划分出来的每个音都是合法 tick 粒度（I4）：
 * 4 个音分 1/4 拍 = 每音 3 tick，不是合法时值，这一档就不该出现。
 */
export function groupTiers(n: number, measureTicks: number): DurationTier[] {
  return durationTiers(measureTicks).filter(
    (t) => t.ticks <= TICKS_PER_BEAT && candidatesFor(n, t.ticks).length > 0,
  );
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
  const gid = (members[0] as { groupId?: string }).groupId;

  let groups: BeatGroup[];
  if (gid) {
    groups = score.groups.map((g) =>
      g.id === gid
        ? {
            ...g,
            totalTicks: sum,
            memberIds: members.map((m) => m.id),
            ...(tuplet ? { tuplet } : {}),
          }
        : g,
    );
  } else {
    const id = newIds(score).grp;
    groups = [
      ...score.groups,
      {
        id,
        totalTicks: sum,
        memberIds: members.map((m) => m.id),
        ...(tuplet ? { tuplet } : {}),
      },
    ];
  }

  const byId: Record<string, number> = {};
  members.forEach((m, i) => (byId[m.id] = parts[i]));

  return {
    ...score,
    groups,
    events: score.events.map((e) => {
      const inSel = e.id in byId;
      const patched = inSel ? { ...e, ticks: byId[e.id] } : e;
      if (!inSel) return patched;
      return { ...patched, groupId: gid ?? groups[groups.length - 1].id };
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
  const grouped = new Set<string>();
  for (const g of score.groups) for (const id of g.memberIds) grouped.add(id);
  const existing = new Set(score.groups.map((g) => g.memberIds.join(',')));

  const added: BeatGroup[] = [];
  let seq = maxSeq(score.groups.map((g) => g.id), 'g');
  let tick = 0;
  let run: string[] = [];
  let sum = 0;

  const flush = (): void => {
    if (run.length >= 2 && sum === TICKS_PER_BEAT && !existing.has(run.join(','))) {
      seq += 1;
      added.push({ id: `g${seq}`, totalTicks: TICKS_PER_BEAT, memberIds: [...run] });
    }
    run = [];
    sum = 0;
  };

  for (const ev of score.events) {
    if (ev.kind === 'barline') {
      flush();
      continue;
    }
    if (ev.kind !== 'note' && ev.kind !== 'rest') continue; // 换气 / 力度不打断

    if (grouped.has(ev.id)) {
      flush();
      tick += ev.ticks;
      continue;
    }
    if (tick % TICKS_PER_BEAT === 0) {
      run = [ev.id];
      sum = ev.ticks;
    } else if (run.length > 0) {
      run.push(ev.id);
      sum += ev.ticks;
    }
    tick += ev.ticks;
    if (sum >= TICKS_PER_BEAT) flush();
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
  for (const b of [192, 96, 48, 24, 12, 6]) {
    if (ticks === b) return b;
    if (ticks === withDots(b, 1)) return b;
    if (ticks === withDots(b, 2)) return b;
  }
  return undefined;
}

export function setDot(score: Score, id: string, dots: 0 | 1 | 2): Score {
  return {
    ...score,
    events: score.events.map((e) => {
      // 休止符与音符一样可带附点（0. = 1.5 拍）
      if (e.id !== id || (e.kind !== 'note' && e.kind !== 'rest')) return e;
      const prev = e.dot ?? 0;
      // 基准时值：带点的按点数还原；不带点的先归一到「加点前基准」
      const base =
        prev > 0 ? e.ticks / (prev === 1 ? 1.5 : 1.75) : (canonicalDurationBase(e.ticks) ?? e.ticks);
      return { ...e, dot: dots, ticks: withDots(base, dots) };
    }),
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
