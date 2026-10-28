/**
 * 时刻表（§11）：把扁平事件流算成带绝对时刻的播放序列。
 * 纯函数，可命令行跑（合成音回归测试的第一步就依赖它）。
 *
 * tie 处理（§9.4）：绘制时保留两个音符，播放 / MIDI 时合并成一个长音。
 */

import { TICKS_PER_BEAT } from './ticks';
import { measureAt } from './expand';
import { partScore, scoreParts } from './parts';
import type { Accidental, Event as ScoreEvent, NoteEvent, Score } from './types';
import { accidentalOffset as pitchAccidentalOffset, keyOffset as pitchKeyOffset, toMidi as pitchToMidi } from './pitch';


export interface TimelineEntry {
  eventId: string;
  startTick: number;
  endTick: number;
  degree: number;
  octave: number;
  /** 合并延音线后的 MIDI 音高；休止符为 null */
  midi: number | null;
  /** 无音高音符（X）：不按 MIDI 音高发声，起音时刻打一记打击声（木鱼音色） */
  perc?: boolean;
  /** 这条是倚音（挂在主音上的装饰音），不是主音本身 */
  grace?: boolean;
  partId?: string;
  gain?: number;
  /** 这条音用什么音色渲染（GM patch 号）：多声部来自声部设置（缺省跟曲目），单声部来自曲目 */
  patch?: number;
  /** 音色的八度偏移（±1 = 升/降八度）：音区不合适时整体挪，不改记谱 */
  patchOctave?: number;
  /**
   * 力度乘数：音符的力度记号（pp…ff）乘上它所在的渐强/渐弱范围在**起音时刻**
   * 的取值。1 = 不变。
   */
  dyn?: number;
  /**
   * 本音**结束**时刻的力度乘数。与 `dyn` 不同即这条音内部线性推进——
   * 一个长音横跨半个渐强范围时，听起来是连续渐强，不是逐音跳档。
   */
  dynTo?: number;
}

/**
 * 倚音的演奏时值：简谱里倚音一律记成 1/4 拍（十六分、两条减时线），
 * 所以播放也按 1/4 拍算，从主音时值里切出来（总时长不变，小节拍数不变）。
 * 主音太短时按「主音至少保留一半」压缩，避免倚音把主音吃光。
 */
export const GRACE_TICKS = TICKS_PER_BEAT / 4;

/** 力度档位 → 播放音量乘数（mf 为基准的常用比例） */
const DYNAMIC_GAIN: Record<string, number> = {
  pp: 0.35,
  p: 0.5,
  mp: 0.65,
  mf: 0.82,
  f: 0.92,
  ff: 1,
};
/** 渐强的起点、渐弱的终点（相对该音自身力度） */
const CRESC_LO = 0.6;
const DIM_LO = 0.5;

/** 升 / 降 / 还原记号 → 半音偏移。♯♭ 与 #b 同义 */
export function accidentalOffset(acc?: Accidental): number {
  return pitchAccidentalOffset(acc);
}

/**
 * 记谱调 "1=G" 中，音级 1 相对 C 的半音数。
 *
 * 音名落在**最靠近 C 的八度**（-5..+6）：
 *   G=-5  A=-3  B=-1  C=0  D=+2  E=+4  F=+5  F#=+6
 * 否则 bB 会算成 +10（比 C 高出一个小七度），合成音整体高得刺耳——
 * 应该是比 C 低 2 个半音（用户实测反馈）。
 *
 * 升降号**写在音名前面**是简谱规范写法（`1=bB`、`1=#F`），
 * 写在后面是英文写法（`1=Bb`、`1=F#`）——两种都认，♯ ♭ 字形也认。
 *
 * 前导 b 有歧义（既可能是降号，也可能是音名 B）：靠正则回溯消解——
 * 能凑成「b + 另一个音名」才算降号，`1=b` 就是 B 本位。
 * 解析不出来返回 0（按 C 调），保留旧有的容错行为。
 */
export function keyOffset(key: string): number {
  return pitchKeyOffset(key);
}

/**
 * 把记谱调统一成简谱规范写法：升降号写在音名前（`1=bB`、`1=#F`）。
 * 认不出来返回 null，由调用方拒绝——脏调号会让 toMidi 静默按 C 调算。
 */
export function normalizeKey(key: string): string | null {
  const m = /^\s*1\s*=\s*([#b♯♭]?)\s*([A-Ga-g])\s*([#b♯♭]?)\s*$/.exec(key);
  if (!m) return null;
  const char = m[1] || m[3];
  const acc = char === '#' || char === '♯' ? '#' : char === 'b' || char === '♭' ? 'b' : '';
  return `1=${acc}${m[2].toUpperCase()}`;
}

/** degree + octave + 变音记号 + 记谱调 → MIDI note number（不做移调，§11） */
export function toMidi(
  degree: number,
  octave: number,
  key: string,
  accidental?: Accidental,
): number {
  return pitchToMidi(degree, octave, key, accidental);
}

/**
 * 时间线条目的 eventId 用哪种口径：
 *   - `source`（默认）= **原谱 id**（展开出的克隆用 originId）。播放、合成音、
 *     伴奏对齐都只认 tick，用哪种都行；而原谱 id 能反查回谱面事件，最通用。
 *   - `own` = 该事件**自己的 id**（展开出的克隆是 `n12~2`）。
 *     显示**展开谱**时必须用这个：排版结果的 item.eventId 取自 ev.id，
 *     播放指示按 id 找音符——口径不一致就一个都找不到（副歌第二遍没有指示）。
 */
export type TimelineIdFlavor = 'source' | 'own';

/**
 * 谱中换音色点（小节线「音5」）：fromTick 起本声部改用此音色。
 * tick 口径与 tickAtEvent 相同：只有 note / rest 占时值。
 */
function patchChangesOf(events: ScoreEvent[]): { fromTick: number; patch: number }[] {
  const out: { fromTick: number; patch: number }[] = [];
  let tick = 0;
  for (const ev of events) {
    if (ev.kind === 'barline' && typeof ev.patchAfter === 'number') out.push({ fromTick: tick, patch: ev.patchAfter });
    if (ev.kind === 'note' || ev.kind === 'rest') tick += ev.ticks;
  }
  return out;
}

/** tick 处生效的谱中音色覆盖（没有则 undefined，沿用谱头 / 声部设置） */
function patchAt(changes: { fromTick: number; patch: number }[], tick: number): number | undefined {
  let patch: number | undefined;
  for (const c of changes) {
    if (c.fromTick > tick) break;
    patch = c.patch;
  }
  return patch;
}

export function buildTimeline(score: Score, opts: { ids?: TimelineIdFlavor; mergeTies?: boolean } = {}): TimelineEntry[] {
  if (score.part || score.parts?.length) {
    const parts = scoreParts(score);
    const solo = parts.some((p) => p.solo);
    return parts.flatMap((part) => {
      const single = partScore(score, part.id);
      const { part: _part, ...plain } = single;
      const gain = part.muted || (solo && !part.solo) ? 0 : part.gain / Math.max(1, Math.sqrt(parts.length));
      const changes = patchChangesOf(plain.events ?? []);
      return buildTimeline(plain, opts).map((e) => ({
        ...e,
        partId: part.id,
        gain,
        patch: patchAt(changes, e.startTick) ?? part.patch ?? score.meta.patch,
        patchOctave: part.patchOctave ?? score.meta.patchOctave,
      }));
    }).sort((a, b) => a.startTick - b.startTick || a.endTick - b.endTick);
  }
  const out: TimelineEntry[] = [];
  const byId = new Map(score.events.map((e) => [e.id, e]));

  /**
   * 力度与渐强渐弱 → 音量包络（F06）。
   * 以前 `hairpin` 只是记谱（画个楔形），合成播放完全没反应；现在按范围生成乘数：
   * 渐强从 0.6 线性推到 1、渐弱从 1 推到 0.5，**按 tick 而非按音推进**——
   * 一个长音横跨范围的一半时，它自己那一截里也在连续涨落，不是逐音跳档。
   * 与音符自身的力度档位相乘（p 段里的渐强不会比 f 段响），
   * 声部音量 / 静音 / 独奏仍走 entry.gain，两层互不干扰。
   */
  const tickOf = new Map<string, { start: number; end: number }>();
  {
    let t = 0;
    for (const ev of score.events) {
      if (ev.kind !== 'note' && ev.kind !== 'rest') continue;
      if (ev.kind === 'note') tickOf.set(ev.id, { start: t, end: t + ev.ticks });
      t += ev.ticks;
    }
  }
  const hairpins: { start: number; end: number; kind: 'cresc' | 'dim'; level: number }[] = [];
  for (const ev of score.events) {
    if (ev.kind !== 'note' || !ev.hairpin || !ev.hairpinTo) continue;
    const a = tickOf.get(ev.id);
    const b = tickOf.get(ev.hairpinTo);
    if (!a || !b || b.end <= a.start) continue;
    // 范围起点当时的力度：范围里没另标力度的音沿用它。
    // 否则 `p cresc[…]` 只有首音是 p、后面按 1.0 走，渐强变成「从极弱冲到最强」
    hairpins.push({ start: a.start, end: b.end, kind: ev.hairpin, level: DYNAMIC_GAIN[ev.dynamic ?? ''] ?? 1 });
  }
  /** 某 tick 所属的渐变范围；不在任何范围里 = undefined */
  const rangeAt = (t: number) => hairpins.find((h) => t >= h.start && t <= h.end);
  /** 某 tick 落在渐变范围里的位置 → 乘数；不在任何范围里 = 1 */
  const hairpinFactor = (t: number): number => {
    const h = rangeAt(t);
    if (!h) return 1;
    const p = Math.min(1, Math.max(0, (t - h.start) / Math.max(1, h.end - h.start)));
    return h.kind === 'cresc' ? CRESC_LO + (1 - CRESC_LO) * p : 1 - (1 - DIM_LO) * p;
  };
  /** 条目 id：口径由 opts.ids 决定 */
  const eid = (ev: { id: string; originId?: string }): string =>
    opts.ids === 'own' ? ev.id : (ev.originId ?? ev.id);
  let tick = 0;
  /** 当前生效的调号：遇到带 keyChange 的音符就切换（含该音本身） */
  let curKey = score.meta.key;
  /**
   * 延音链状态：链尾音符 id + 链条主音条目在 out 里的下标。
   * 链式延音 5~5~5 时第二颗并进第一颗的条目，第三颗必须查**第二颗**的
   * outgoing ties 才知道自己要延续——旧代码永远查第一颗，链上第三颗起
   * 全部重新起声（用户实测：跨小节三个 5，第三个又多响了一次）。
   */
  let chainTailId: string | null = null;
  let chainMainIdx: number | null = null;

  for (const ev of score.events) {
    if (ev.kind !== 'note' && ev.kind !== 'rest') continue; // 小节线 / 换气不占时值

    if (ev.kind === 'rest') {
      // X 符号（x 变体）：起音时刻打一记打击声；普通休止完全静默
      out.push({ eventId: eid(ev), startTick: tick, endTick: tick + ev.ticks, degree: 0, octave: 0, midi: null, ...(ev.x ? { perc: true } : {}) });
      tick += ev.ticks;
      chainTailId = null; // 休止切断延音链
      chainMainIdx = null;
      continue;
    }

    // 转调：到达这个音符起，后面的音都改用新调（含这个音自己）
    if (ev.keyChange) curKey = ev.keyChange;

    // 本音的力度包络：力度档位 × 渐强/渐弱在本音起止时刻的取值。
    // 本音没标力度但落在某个渐变范围里 → 沿用该范围起点的力度（见 hairpins）
    const level = DYNAMIC_GAIN[ev.dynamic ?? ''] ?? rangeAt(tick)?.level ?? 1;
    const dyn = level * hairpinFactor(tick);
    const dynTo = level * hairpinFactor(tick + ev.ticks);

    // ── 倚音 ──
    // 不占时值：从主音时值里切。前倚音占开头、后倚音占结尾，主音至少留一半。
    const gBefore = ev.graceBefore ?? [];
    const gAfter = ev.graceAfter ?? [];
    const graceCount = gBefore.length + gAfter.length;
    const each = graceCount > 0 ? Math.min(GRACE_TICKS, Math.floor(ev.ticks / 2 / graceCount)) : 0;
    const beforeTicks = each * gBefore.length;
    const afterTicks = each * gAfter.length;
    if (graceCount > 0) {
      let gs = tick;
      for (const g of gBefore) {
        out.push({
          eventId: eid(ev),
          startTick: gs,
          endTick: gs + each,
          degree: g.degree,
          octave: g.octave,
          midi: toMidi(g.degree, g.octave, curKey, g.accidental),
          grace: true,
          // 倚音短到不需要内部推进，取主音起音时刻的力度即可
          dyn: level * hairpinFactor(gs),
        });
        gs += each;
      }
      gs = tick + ev.ticks - afterTicks;
      for (const g of gAfter) {
        out.push({
          eventId: eid(ev),
          startTick: gs,
          endTick: gs + each,
          degree: g.degree,
          octave: g.octave,
          midi: toMidi(g.degree, g.octave, curKey, g.accidental),
          grace: true,
          dyn: level * hairpinFactor(gs),
        });
        gs += each;
      }
    }

    // 延音线 / 弧线：与前一个同音高的长音合并，不再触发 attack——
    // 画了连音线的同音高相邻音要连续演奏，不能变成两个音。
    // 连线记在前一个音上（延音线 DSL 写 5~5；弧线是 toggleSlur 建的 slur），
    // 所以要查「延音链尾」的 outgoing ties：链式 5~5~5 时第二颗已并进
    // 第一颗的条目，第三颗必须查第二颗的 ties（旧代码查第一颗，链上
    // 第三颗起全部重新起声——用户实测「跨小节三个 5，第三个又多响一次」）。
    const tailNote = chainTailId ? (byId.get(chainTailId) as NoteEvent | undefined) : undefined;
    const mainEntry = chainMainIdx !== null ? out[chainMainIdx] : undefined;
    const linkedFromPrev = tailNote
      ? (tailNote.ties ?? []).some(
          (t) => (t.kind === 'tie' || t.kind === 'slur') && t.to === ev.id,
        )
      : false;
    if (
      opts.mergeTies !== false && // 显示时间线保留每个音的拍位，声音时间线仍合并延音
      graceCount === 0 && // 带倚音的音要重新起声，不能并进前一个长音
      linkedFromPrev &&
      mainEntry &&
      mainEntry.midi !== null &&
      mainEntry.endTick === tick && // 链条正好走到当前时刻：中间被倚音 / 休止打断就合不上
      tailNote &&
      tailNote.degree === ev.degree &&
      tailNote.octave === ev.octave &&
      (tailNote.accidental ?? '') === (ev.accidental ?? '') && // 变音不同就不是同一个音，不能合并
      // 音高必须真的相同：中间夹了转调（含这个音自己的转调）时，
      // 同样的音级已经落到另一个音高上，再合并就会把转调吞掉——
      // 听感上「这个音开始的转调」变成从下一个音才生效，甚至完全不生效。
      mainEntry.midi === toMidi(ev.degree, ev.octave, curKey, ev.accidental)
    ) {
      mainEntry.endTick = tick + ev.ticks;
      // 合并进长音后，包络终点跟着延到这一颗的末尾——跨小节的渐强
      // 不会被延音线切成两段
      mainEntry.dynTo = dynTo;
      tick += ev.ticks;
      chainTailId = ev.id; // 链尾前移：下一颗音要查这一颗的 ties
      continue;
    }

    // 主音：前倚音占掉开头、后倚音占掉结尾，中间才是主音本身
    out.push({
      eventId: eid(ev),
      startTick: tick + beforeTicks,
      endTick: tick + ev.ticks - afterTicks,
      degree: ev.degree,
      octave: ev.octave,
      midi: toMidi(ev.degree, ev.octave, curKey, ev.accidental),
      dyn,
      dynTo,
    });
    tick += ev.ticks;
    chainTailId = ev.id;
    chainMainIdx = out.length - 1;
  }

  // 单声部：音色跟曲目设置走（小节线「音5」从那根线之后覆盖；多声部已在上面按声部附好各自的 patch）
  const changes = patchChangesOf(score.events);
  return out.sort((a, b) => a.startTick - b.startTick).map((e) => ({
    ...e,
    patch: patchAt(changes, e.startTick) ?? score.meta.patch,
    patchOctave: score.meta.patchOctave,
  }));
}

export function timelineTicks(tl: TimelineEntry[]): number {
  return tl.reduce((end, e) => Math.max(end, e.endTick), 0);
}

/**
 * 事件下标 → 该位置对应的 tick。
 * 口径必须与 buildTimeline 一致：只有 note / rest 占时值，
 * 小节线、换气、力度都不推进时间（延音线合并也不改变总量）。
 *
 * 用于「从光标处起播」把插入点换算成起播时刻。
 */
export function tickAtEvent(score: Score, index: number): number {
  const end = Math.min(Math.max(index, 0), score.events.length);
  let tick = 0;
  for (let i = 0; i < end; i += 1) {
    const ev = score.events[i];
    if (ev.kind === 'note' || ev.kind === 'rest') tick += ev.ticks;
  }
  return tick;
}

/** 某一 tick 上正在发声的条目及其内部进度（0..1） */
export function activeAt(
  tl: TimelineEntry[],
  tick: number,
): { entry: TimelineEntry; progress: number } | null {
  for (const e of tl) {
    if (tick >= e.startTick && tick < e.endTick) {
      const span = e.endTick - e.startTick;
      return { entry: e, progress: span > 0 ? (tick - e.startTick) / span : 0 };
    }
  }
  return null;
}

/**
 * 展开后的**实际演奏顺序**（按小节）：反复与跳转写了不一定弹对，
 * 用耳朵逐句核对很慢——把播放路径列出来就能一眼看出
 * 「跳回的是不是这一段、结束句有没有被跳到」。
 *
 * 返回连续小节区间的文本序列（如 ['1–11','12–21','12–21','22–36','26–40']）；
 * 谱里既没有反复也没有跳转时返回 null（顺序就是 1..N，不必提示）。
 */
export function playOrderMeasures(src: ScoreEvent[], played: ScoreEvent[]): string[] | null {
  const hasStructure = src.some(
    (e) => e.kind === 'jump' || (e.kind === 'barline' && (e as { repeat?: string }).repeat),
  );
  if (!hasStructure) return null;
  const idxById = new Map(src.map((e, i) => [e.id, i]));
  const seq: number[] = [];
  for (const e of played) {
    // 只看**时值事件**：小节线 / 跳转记号只是装饰，不决定「正在演奏第几小节」
    if (e.kind !== 'note' && e.kind !== 'rest') continue;
    const i = idxById.get((e as { originId?: string }).originId ?? e.id);
    if (i === undefined) continue;
    const m = measureAt(src, i);
    if (seq[seq.length - 1] !== m) seq.push(m); // 同一小节内的连续事件压成一个
  }
  const runs: string[] = [];
  let start = -1;
  let prev = -1;
  const flush = (): void => {
    if (start > 0) runs.push(start === prev ? `${start}` : `${start}–${prev}`);
  };
  for (const m of seq) {
    if (m === prev + 1) {
      prev = m;
      continue;
    }
    flush();
    start = m;
    prev = m;
  }
  flush();
  return runs.length ? runs : null;
}

/**
 * 播放指示（高亮 / 竖线）用的 act：**只认主音**条目。
 *
 * 倚音在时间线里是独立条目（从主音时值里切出来，eventId 与主音相同）。
 * 直接用 activeAt 时，每走到一颗倚音，progress 都从 0 再走一遍——
 * 指示条在同一个主音框里反复从左边重新扫一次，看着就是闪烁来回抖（用户实测）。
 * 这里把倚音段并回主音：前倚音段 = 0（站在框的开头等主音），
 * 后倚音段 = 1（主音已走完，停在框尾），主音段照常插值——整体单调向前。
 */
export function activeMainAt(
  tl: TimelineEntry[],
  tick: number,
): { entry: TimelineEntry; progress: number } | null {
  const act = activeAt(tl, tick);
  if (!act || !act.entry.grace) return act;
  const main = tl.find((e) => e.eventId === act.entry.eventId && !e.grace);
  if (!main) return act;
  const span = main.endTick - main.startTick;
  const p = span > 0 ? (tick - main.startTick) / span : 0;
  return { entry: main, progress: Math.max(0, Math.min(1, p)) };
}

/** 同时发声的声部各自拥有一个播放头，静音不会隐藏其谱面进度。 */
export function activeHeadsAt(tl: TimelineEntry[], tick: number): { eventId: string; frac: number }[] {
  const ids = new Set(tl.map((e) => e.partId ?? ''));
  return [...ids].flatMap((id) => {
    const active = activeMainAt(tl.filter((e) => (e.partId ?? '') === id), tick);
    return active ? [{ eventId: active.entry.eventId, frac: active.progress }] : [];
  });
}

