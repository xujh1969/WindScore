/**
 * BeatGroup 不变量校验（M0-1 / spec §5.3）
 *
 *   I1  Σ member.ticks === group.totalTicks
 *   I2  group.totalTicks ≤ TICKS_PER_BEAT
 *   I3  memberIds 在 events 中连续（中间只允许 breath）
 *   I4  totalTicks 与成员 tick 都落在合法 tick 粒度
 *
 * 原则（§7.2）：只报错，绝不静默修正。
 */

import { isLegalTick, LEGAL_TICKS, TICKS_PER_BEAT } from './ticks';
import { isTimed, type Event, type RestEvent, type Score } from './types';
import { groupTicks, meterAt, validMeter } from './meter';
import { gbNote } from './gb';

export type InvariantCode = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'E1' | 'E2';

export interface Violation {
  code: InvariantCode;
  /** 拍内组相关的问题才带组 id；连线相关的问题留空 */
  groupId?: string;
  message: string;
}

export function validateGroups(score: Score): Violation[] {
  if (score.parts?.length) {
    return [{ ...score, parts: undefined }, ...score.parts.map((p) => ({ ...score, events: p.events, groups: p.groups, part: p, parts: undefined }))]
      .flatMap((s) => validateGroups(s).map((v) => ({ ...v, message: `${s.part?.name ?? '声部 1'}：${v.message}` })));
  }
  const out: Violation[] = [];
  const index = new Map<string, number>();
  score.events.forEach((e, i) => index.set(e.id, i));
  for (const [i, e] of score.events.entries()) {
    if (e.kind === 'barline' && e.beatAfter && !validMeter(e.beatAfter)) out.push({ code: 'E2', message: `拍号不合法：${e.beatAfter}${gbNote('meter')}` });
    if (e.kind === 'barline' && e.bpmAfter !== undefined && (!Number.isInteger(e.bpmAfter) || e.bpmAfter < 20 || e.bpmAfter > 300)) out.push({ code: 'E2', message: `速度不合法（应为 20-300 的整数）：${e.bpmAfter}` });
    if (e.kind === 'barline' && e.patchAfter !== undefined && (!Number.isInteger(e.patchAfter) || e.patchAfter < 0 || e.patchAfter > 255)) out.push({ code: 'E2', message: `音色号不合法（应为 0-255 的整数）：${e.patchAfter}` });
    if (e.kind === 'note' && e.hairpinTo) {
      const target = index.get(e.hairpinTo) ?? -1;
      if (!e.hairpin || target <= i || score.events[target]?.kind !== 'note') out.push({ code: 'I5', message: `渐强/渐弱终点必须是同声部的后续音符${gbNote('hairpin')}` });
    }
  }

  // 小节反复小节不能再有其他发声内容（GB/T 46845—2025 §5.8.4：
  // 反复号替代整小节记谱）——同一小节里 𝄍 与音符 / 其他休止混写即报错
  {
    let start = 0;
    let no = 1;
    for (let i = 0; i <= score.events.length; i += 1) {
      const e = score.events[i];
      if (i === score.events.length || e.kind === 'barline') {
        const timed = score.events.slice(start, i).filter((q) => isTimed(q));
        const rb = timed.filter((q) => q.kind === 'rest' && (q as RestEvent).repeatBar);
        if (rb.length && timed.length > rb.length) {
          out.push({ code: 'E2', message: `第 ${no} 小节是小节反复（𝄍），不能再写其他音符${gbNote('repeatBar')}` });
        }
        start = i + 1;
        no += 1;
      }
    }
  }

  for (const g of score.groups) {
    if (g.id === '' || g === undefined) continue;

    // E1：成员必须存在且有时值
    const members = g.memberIds.map((id) => score.events[index.get(id) ?? -1]);
    if (members.some((m) => m === undefined)) {
      out.push({ code: 'E1', groupId: g.id, message: '成员 id 不存在于 events' });
      continue;
    }
    if (members.some((m) => !isTimed(m!))) {
      out.push({ code: 'E2', groupId: g.id, message: '成员必须是 note / rest' });
      continue;
    }

    // I1 守恒
    const sum = (members as { ticks: number }[]).reduce((a, m) => a + m.ticks, 0);
    if (sum !== g.totalTicks) {
      out.push({
        code: 'I1',
        groupId: g.id,
        message: `Σ 成员时值 ${sum} ≠ 组总时值 ${g.totalTicks}`,
      });
    }

    // I2 组不跨拍
    const maxGroup = score.format === 3 && !g.tuplet ? groupTicks(meterAt(score, index.get(g.memberIds[0]) ?? 0)) : TICKS_PER_BEAT;
    if (g.totalTicks > maxGroup) {
      out.push({
        code: 'I2',
        groupId: g.id,
        message: `组总时值 ${g.totalTicks} 超过拍组上限（${maxGroup} tick）${gbNote('beatGroups')}`,
      });
    }

    // I3 成员在 events 中连续（换气已改成音符技法，不再有夹在中间的独立事件）
    const positions = g.memberIds.map((id) => index.get(id)!).sort((a, b) => a - b);
    const lo = positions[0];
    const hi = positions[positions.length - 1];
    const inside = new Set(positions);
    const gaps: Event[] = [];
    for (let i = lo; i <= hi; i++) {
      const ev = score.events[i];
      if (!inside.has(i)) gaps.push(ev);
    }
    if (gaps.length > 0) {
      out.push({
        code: 'I3',
        groupId: g.id,
        message: `成员不连续，中间夹了 ${gaps.length} 个别的事件（首个 ${gaps[0].kind}）`,
      });
    }

    // I4 合法 tick 粒度
    if (!isLegalTick(g.totalTicks)) {
      out.push({
        code: 'I4',
        groupId: g.id,
        message: `组总时值 ${g.totalTicks} 不是合法 tick（候选 ${LEGAL_TICKS.join('/')}）${gbNote('duration')}`,
      });
    }
    for (const m of members as { id: string; ticks: number }[]) {
      if (!isLegalTick(m.ticks)) {
        out.push({
          code: 'I4',
          groupId: g.id,
          message: `成员 ${m.id} 时值 ${m.ticks} 不是合法 tick${gbNote('duration')}`,
        });
      }
    }
  }

  // ── I5：连线是一条链，不能分叉也不能并流 ──
  // 每个音至多一条外向连线、至多一条内向连线。
  //
  // 这条不是洁癖：slurNext（排版）和 slurSpan（序列化）都是**以起点为键的映射**，
  // 一旦分叉，多出来的那条边会被静默丢弃——数据里有连线，画面上看不见；
  // 用户去「取消」时清掉的是看不见的那条，看得见的那条当然纹丝不动，
  // 表现为「连了看不见 / 取消不掉」。
  {
    const outDeg = new Map<string, number>();
    const inDeg = new Map<string, number>();
    for (const e of score.events) {
      if (e.kind !== 'note') continue;
      for (const t of e.ties ?? []) {
        if (t.kind !== 'slur') continue;
        outDeg.set(e.id, (outDeg.get(e.id) ?? 0) + 1);
        inDeg.set(t.to, (inDeg.get(t.to) ?? 0) + 1);
      }
    }
    for (const [id, n] of outDeg) {
      if (n > 1) {
        out.push({
          code: 'I5',
          message: `音序 ${(index.get(id) ?? 0) + 1} 有 ${n} 条外向连线：连线不能分叉`,
        });
      }
    }
    for (const [id, n] of inDeg) {
      if (n > 1) {
        out.push({
          code: 'I5',
          message: `音序 ${(index.get(id) ?? 0) + 1} 有 ${n} 条内向连线：连线不能并流`,
        });
      }
    }
  }

  return out;
}

