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

import { isLegalTick, LEGAL_TICKS } from './ticks';
import { isTimed, TICKS_PER_BEAT, type Event, type Score } from './types';

export type InvariantCode = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'E1' | 'E2';

export interface Violation {
  code: InvariantCode;
  /** 拍内组相关的问题才带组 id；连线相关的问题留空 */
  groupId?: string;
  message: string;
}

export function validateGroups(score: Score): Violation[] {
  const out: Violation[] = [];
  const index = new Map<string, number>();
  score.events.forEach((e, i) => index.set(e.id, i));

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
    if (g.totalTicks > TICKS_PER_BEAT) {
      out.push({
        code: 'I2',
        groupId: g.id,
        message: `组总时值 ${g.totalTicks} 超过 1 拍（${TICKS_PER_BEAT} tick）`,
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
        message: `组总时值 ${g.totalTicks} 不是合法 tick（候选 ${LEGAL_TICKS.join('/')}）`,
      });
    }
    for (const m of members as { id: string; ticks: number }[]) {
      if (!isLegalTick(m.ticks)) {
        out.push({
          code: 'I4',
          groupId: g.id,
          message: `成员 ${m.id} 时值 ${m.ticks} 不是合法 tick`,
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

/** 开发期断言：违反即崩（spec §6.3「开发期即崩，不留隐患」） */
export function assertInvariants(score: Score): void {
  const v = validateGroups(score);
  if (v.length > 0) {
    const detail = v.map((x) => `[${x.code}] ${x.groupId}: ${x.message}`).join('\n  ');
    throw new Error(`BeatGroup 不变量违反：\n  ${detail}`);
  }
}
