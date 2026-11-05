/**
 * 齐唱展开（unison expansion）：把小节线上的「同N-M」「分」标记
 * 展开成各声部的真实事件拷贝。
 *
 * 这是齐唱功能的唯一复杂点，与反复展开（expand.ts）同一设计哲学：
 * 数据层原样保存标记；展开产物是派生、只读的，播放 / 导出吃展开谱，
 * 显示层画原谱（小节线上标「同2-3」「分」）。
 *
 * 语义：
 *   「同2-3」  从这条小节线之后起，声部 2、3 暂停自己的内容，改唱第一声部；
 *   「分」      目标声部恢复唱自己的内容；
 *   段 = 同 → 分（或下一根「同」、曲终）。可在全曲多处出现，各段独立展开。
 *
 * 展开 = 对每个目标声部：删除自己该小节区间内的音符 / 休止（保留小节线等结构），
 * 拷入第一声部区间内的音符 / 休止（歌词一并拷贝——齐唱共用歌词）。
 * 段边界按**小节号**对齐，不按 tick——各声部小节内的音数 / 时值不必相同，
 * tick 网格会在内容不同的声部间错位；小节号是两声部唯一的公共坐标系。
 * 纯重算：对展开谱再次展开结果不变（幂等），调用方无需缓存。
 */
import type { Event, Score, ScorePart } from './types';

/** 事件下标处的线结束的是第几小节（与 expand.measureAt 同口径）。
 * 曲首引导小节线（`| 5 5 |` 开头那根，前面没有任何音符/休止）不结束任何小节，
 * 返回 0——挂「同N-M」的段从小节 1 起（曲首齐唱场景，OCR 转换器依赖此口径）。 */
function measureOf(events: Event[], idx: number): number {
  let n = 1;
  let seenTimed = false;
  for (let i = 0; i < idx; i += 1) {
    const e = events[i];
    if (e.kind === 'note' || e.kind === 'rest') {
      seenTimed = true;
      continue;
    }
    if (e.kind === 'barline' && seenTimed) n += 1;
  }
  return seenTimed ? n : 0;
}

/**
 * 按小节号切：删除小节号 ∈ (m0, m1] 的音符 / 休止（m1 = Infinity = 到曲终），
 * 小节线等结构保留。返回 [区间前, 区间后] 两段事件。
 */
function sliceByMeasures(events: Event[], m0: number, m1: number): { before: Event[]; after: Event[] } {
  const before: Event[] = [];
  const after: Event[] = [];
  let n = 1;
  let seenTimed = false;
  for (const e of events) {
    if (e.kind === 'note' || e.kind === 'rest') {
      seenTimed = true;
      if (n > m0 && n <= m1) continue; // 齐唱区间内的 timed 丢弃
      (n <= m0 ? before : after).push(e);
      continue;
    }
    // 曲首引导小节线（前面没有任何音符/休止）：它不结束任何小节，
    // m0=0（曲首「同」）时必须留在前段，否则会被挪到克隆音符之后
    if (e.kind === 'barline' && !seenTimed) {
      before.push(e);
      continue;
    }
    // 区间内出现的小节线留在「后段」开头（保持相对顺序）；其余按位置分边
    (n <= m0 ? before : after).push(e);
    if (e.kind === 'barline' && seenTimed) n += 1;
  }
  return { before, after };
}

export function expandUnisons(score: Score): Score {
  const parts = score.parts;
  if (!parts?.length) return score;
  const events = score.events;
  // ── 第一声部扫描齐唱段：同 开段（隐式结束上一段）、分 收段、曲终收尾 ──
  const segs: { fromIdx: number; toIdx: number; m0: number; m1: number; targets: number[] }[] = [];
  let open: { fromIdx: number; m0: number; targets: number[] } | null = null;
  const close = (openSeg: { fromIdx: number; m0: number; targets: number[] }, toIdx: number, m1: number): void => {
    segs.push({ ...openSeg, toIdx, m1: Math.max(m1, openSeg.m0) });
  };
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (e.kind !== 'barline') continue;
    if (e.unisonAfter?.length) {
      if (open) close(open, i, measureOf(events, i));
      open = { fromIdx: i, m0: measureOf(events, i), targets: e.unisonAfter };
    } else if (e.splitAfter && open) {
      close(open, i, measureOf(events, i));
      open = null;
    }
  }
  if (open) close(open, events.length, Infinity);
  if (!segs.length) return score;

  const newParts: ScorePart[] = parts.map((part, pi) => {
    const partNo = pi + 2; // parts[0] 是第 2 声部
    const mySegs = segs.filter((s) => s.targets.includes(partNo));
    if (!mySegs.length) return part;
    let eventsPart = part.events;
    for (const [si, seg] of mySegs.entries()) {
      const { before, after } = sliceByMeasures(eventsPart, seg.m0, seg.m1);
      // 拷入第一声部区间内的音符 / 休止：新 id（避免跨声部撞车）、
      // 剥 groupId（拍组归各声部自己的 groups，齐唱拷贝暂不复制组——
      // 连音括号不跟随，时值本身不受影响），歌词随音符走（齐唱共用歌词）
      let n = 0;
      const clones: Event[] = [];
      for (let i = seg.fromIdx + 1; i < seg.toIdx; i += 1) {
        const e = events[i];
        if (e.kind !== 'note' && e.kind !== 'rest') continue;
        const clone = structuredClone(e) as unknown as Record<string, unknown>;
        delete clone.groupId;
        clones.push({ ...clone, id: `${e.id}u${partNo}x${si}n${n++}` } as unknown as Event);
      }
      eventsPart = [...before, ...clones, ...after];
    }
    return { ...part, events: eventsPart };
  });
  return { ...score, parts: newParts };
}
