import type { BarlineEvent, Event, PartInfo, Score, ScorePart } from './types';
import { TICKS_PER_BEAT, TICK_DIVISIONS } from './ticks';

export const DEFAULT_PART: PartInfo = { id: '1', name: '声部 1', gain: 1 };

export function scoreParts(score: Score): ScorePart[] {
  return [{ ...(score.part ?? DEFAULT_PART), events: score.events, groups: score.groups }, ...(score.parts ?? [])];
}

export function partScore(score: Score, id: string): Score {
  const part = scoreParts(score).find((p) => p.id === id) ?? scoreParts(score)[0];
  const { events, groups, ...info } = part;
  const { parts: _parts, part: _part, ...base } = score;
  return { ...base, events, groups, ...(score.part ? { part: info } : {}) };
}

export function assembleParts(score: Score, parts: ScorePart[]): Score {
  const [first, ...rest] = parts;
  const { events, groups, ...part } = first;
  const assembled: Score = { ...score, format: 3, events, groups, part, parts: rest };
  return { ...assembled, parts: rest.map((p) => {
    const aligned = withConductor(assembled, p.id);
    return { ...p, events: aligned.events };
  }) };
}

export function replacePart(score: Score, next: Score): Score {
  if (!score.part) return next;
  const id = next.part?.id ?? score.part.id;
  return assembleParts({ ...score, meta: next.meta }, scoreParts(score).map((p) =>
    p.id === id ? { ...p, events: next.events, groups: next.groups, ...next.part } : p));
}

/** 解析/复制声部时连线和拍组一起重映射。 */
export function namespacePart(score: Score, info: PartInfo): ScorePart {
  const ids = new Map(score.events.map((e, i) => [e.id, `p${info.id}:e${i + 1}`]));
  const gids = new Map(score.groups.map((g, i) => [g.id, `p${info.id}:g${i + 1}`]));
  return {
    ...info,
    events: score.events.map((e) => ({ ...e, id: ids.get(e.id)!,
      ...('groupId' in e && e.groupId ? { groupId: gids.get(e.groupId) } : {}),
      ...(e.kind === 'note' && e.ties ? { ties: e.ties.map((t) => ({ ...t, to: ids.get(t.to)! })) } : {}),
      ...(e.kind === 'note' && e.hairpinTo ? { hairpinTo: ids.get(e.hairpinTo) } : {}),
    })),
    groups: score.groups.map((g) => ({ ...g, id: gids.get(g.id)!, memberIds: g.memberIds.map((id) => ids.get(id)!) })),
  };
}

export interface PartMeasure { from: number; to: number; ticks: number; }

export function partMeasures(events: Event[]): PartMeasure[] {
  const out: PartMeasure[] = [];
  let from = 0;
  let ticks = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === 'note' || e.kind === 'rest') ticks += e.ticks;
    if (e.kind === 'barline' && ticks > 0) {
      out.push({ from, to: i + 1, ticks });
      from = i + 1;
      ticks = 0;
    }
  }
  if (ticks > 0) out.push({ from, to: events.length, ticks });
  return out;
}

export function ensembleIssues(score: Score): string[] {
  if (!score.parts?.length) return [];
  const parts = scoreParts(score);
  const measures = parts.map((p) => partMeasures(p.events));
  const out: string[] = [];
  parts.slice(1).forEach((p, pi) => {
    const current = measures[pi + 1];
    if (current.length !== measures[0].length) out.push(`${p.name}有 ${current.length} 小节，${parts[0].name}有 ${measures[0].length} 小节`);
    current.forEach((m, i) => {
      if (measures[0][i] && m.ticks !== measures[0][i].ticks) out.push(`${p.name}第 ${i + 1} 小节为 ${m.ticks / TICKS_PER_BEAT} 拍，与${parts[0].name}不一致`);
    });
  });
  return out;
}

/** 首声部定义全谱的反复/跳转，其他声部按相同小节边界继承。 */
export function withConductor(score: Score, id: string): Score {
  const target = partScore(score, id);
  if (!score.part || id === score.part.id) return target;
  const sourceMeasures = partMeasures(score.events);
  const targetMeasures = partMeasures(target.events);
  const clean = target.events.filter((e) => e.kind !== 'jump').map((e): Event => {
    if (e.kind !== 'barline') return e;
    const { repeat: _r, times: _t, volta: _v, voltaOpen: _o, beatAfter: _b, breakAfter: _br, ...bar } = e;
    return bar;
  });
  const sourceStarts = [0, ...sourceMeasures.map((m) => m.to)];
  const targetStarts = [0, ...targetMeasures.map((m) => m.to)];
  const sourceHead = score.events.slice(0, score.events.findIndex((e) => 'ticks' in e));
  const targetHead = target.events.slice(0, target.events.findIndex((e) => 'ticks' in e));
  for (let boundary = sourceStarts.length - 1; boundary >= 0; boundary--) {
    const at = sourceStarts[boundary];
    const src = boundary === 0 ? sourceHead.find((e) => e.kind === 'barline') : score.events[at - 1];
    const dstOriginal = boundary === 0 ? targetHead.find((e) => e.kind === 'barline') : target.events[(targetStarts[boundary] ?? 0) - 1];
    let index = dstOriginal ? clean.findIndex((e) => e.id === dstOriginal.id) : -1;
    if (src?.kind === 'barline') {
      const attributes = { repeat: src.repeat, times: src.times, volta: src.volta, voltaOpen: src.voltaOpen, partial: src.partial, beatAfter: src.beatAfter, breakAfter: src.breakAfter };
      if (clean[index]?.kind === 'barline') clean[index] = { ...clean[index], ...attributes } as BarlineEvent;
      else if (boundary === 0) {
        clean.unshift({ id: `p${id}:conductor:start`, kind: 'barline', style: 'single', ...attributes });
        index = 0;
      }
    }
    const jumps: Event[] = [];
    const following: Event[] = boundary === 0 ? sourceHead : [];
    if (boundary > 0) for (let j = at; j < score.events.length && !('ticks' in score.events[j]) && score.events[j].kind !== 'barline'; j++) following.push(score.events[j]);
    for (const e of following) {
      if (e.kind === 'jump') jumps.push({ ...e, id: `p${id}:conductor:${e.id}` });
    }
    if (jumps.length) clean.splice(Math.max(0, index + 1), 0, ...jumps);
  }
  return { ...target, events: clean };
}

export function addPart(score: Score): Score {
  const parts = scoreParts(score);
  const id = String(Math.max(...parts.map((p) => Number(p.id) || 0)) + 1);
  const measures = partMeasures(score.events);
  const events: Event[] = [];
  let seq = 0;
  const eid = () => `p${id}:e${++seq}`;
  if (score.events[0]?.kind === 'barline') events.push({ ...score.events[0], id: eid() });
  for (const m of measures) {
    const dots = ([0, 1, 2] as const).find((dot) => {
      let base = m.ticks / (dot === 0 ? 1 : dot === 1 ? 1.5 : 1.75);
      if (!Number.isInteger(base)) return false;
      while (base > TICKS_PER_BEAT) base -= TICKS_PER_BEAT;
      return TICK_DIVISIONS[base] !== undefined;
    });
    if (dots !== undefined) events.push({ id: eid(), kind: 'rest', ticks: m.ticks, dot: dots });
    else for (const e of score.events.slice(m.from, m.to)) {
      if (e.kind === 'note' || e.kind === 'rest') events.push({ id: eid(), kind: 'rest', ticks: e.ticks, dot: e.dot });
    }
    const end = score.events[m.to - 1];
    events.push(end?.kind === 'barline' ? { ...end, id: eid() } : { id: eid(), kind: 'barline', style: 'single' });
  }
  return assembleParts(score, [...parts, { id, name: `声部 ${id}`, gain: 1, events, groups: [] }]);
}
