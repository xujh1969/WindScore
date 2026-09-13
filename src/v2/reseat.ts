/**
 * 守恒重分配 reseat（M0-3 / spec §3.3）
 *
 *   选中成员均分用户指定的时值，未选成员共同吸收剩余的全部。
 *   写回后 Σ 必须仍然等于 group.totalTicks。
 *
 * 两处规范留白，此处显式补齐（均以「不变量 I1 不可破」为准）：
 *   1. spec 写「未选成员数 == 0 → 全员均分 selectedTicks」，但那样在
 *      selectedTicks ≠ totalTicks 时会破坏 I1。改组总时值是「扩组」操作，
 *      不属于 reseat，因此全选且新值 ≠ 组总时值时直接拒绝并说明原因。
 *   2. spec 写「不能整除 → 落到附近合法 tick」，但硬落会破坏 I1。
 *      这里改为整数精确分配保证 I1，再把不合法的成员 tick 作为 warning 抛出，
 *      由调用方决定是否调整组总时值。
 */

import { isLegalTick, TICKS_PER_BEAT } from './ticks';
import { isTimed, type BeatGroup, type Score, type TimedEvent } from './types';

export interface ReseatRequest {
  group: BeatGroup;
  /** 按 memberIds 顺序 */
  members: TimedEvent[];
  selectedIds: string[];
  /** 用户指定的「选中部分」总时值 */
  selectedTicks: number;
}

export type ReseatFailure = { ok: false; reason: string };
export type ReseatSuccess = {
  ok: true;
  /** eventId → 新 tick */
  ticks: Record<string, number>;
  warnings: string[];
};
export type ReseatResult = ReseatSuccess | ReseatFailure;

/** 整数均分：余数摊到前几个，保证总和精确 */
export function distribute(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

export function reseat(req: ReseatRequest): ReseatResult {
  const { group, members, selectedIds, selectedTicks } = req;
  const sel = new Set(selectedIds);
  const selected = members.filter((m) => sel.has(m.id));
  const unselected = members.filter((m) => !sel.has(m.id));

  if (selected.length === 0) return { ok: false, reason: '未选中任何成员' };
  if (!Number.isInteger(selectedTicks) || selectedTicks < 0) {
    return { ok: false, reason: `时值必须是非负整数 tick，收到 ${selectedTicks}` };
  }

  const restTicks = group.totalTicks - selectedTicks;
  if (restTicks < 0) {
    return {
      ok: false,
      reason: `组溢出：新时值 ${selectedTicks} 超过组总时值 ${group.totalTicks}，请先扩组或减小值`,
    };
  }

  const ticks: Record<string, number> = {};
  if (unselected.length === 0) {
    // 全选：只能整体等于组总时值，否则属于改组总时值（扩组）
    if (selectedTicks !== group.totalTicks) {
      return {
        ok: false,
        reason: `已选中全部成员，新时值必须等于组总时值 ${group.totalTicks}；要改成 ${selectedTicks} 请先扩组`,
      };
    }
    const parts = distribute(selectedTicks, selected.length);
    selected.forEach((m, i) => (ticks[m.id] = parts[i]));
  } else {
    const selParts = distribute(selectedTicks, selected.length);
    selected.forEach((m, i) => (ticks[m.id] = selParts[i]));
    const restParts = distribute(restTicks, unselected.length);
    unselected.forEach((m, i) => (ticks[m.id] = restParts[i]));
  }

  const sum = members.reduce((a, m) => a + ticks[m.id], 0);
  if (sum !== group.totalTicks) {
    throw new Error(`reseat 内部错误：Σ=${sum} ≠ totalTicks=${group.totalTicks}`);
  }

  const warnings: string[] = [];
  for (const m of members) {
    const t = ticks[m.id];
    if (!isLegalTick(t)) {
      warnings.push(`成员 ${m.id} 得到 ${t} tick，不是合法粒度，建议调整组总时值`);
    }
    if (t > TICKS_PER_BEAT) {
      warnings.push(`成员 ${m.id} 得到 ${t} tick，已超过 1 拍`);
    }
  }

  return { ok: true, ticks, warnings };
}

/** 在 Score 上执行 reseat，返回新的 Score（不修改入参） */
export function applyReseat(
  score: Score,
  groupId: string,
  selectedIds: string[],
  selectedTicks: number,
): { ok: true; score: Score; warnings: string[] } | ReseatFailure {
  const group = score.groups.find((g) => g.id === groupId);
  if (!group) return { ok: false, reason: `找不到拍内组 ${groupId}` };

  const members: TimedEvent[] = [];
  for (const id of group.memberIds) {
    const ev = score.events.find((e) => e.id === id);
    if (!ev || !isTimed(ev)) return { ok: false, reason: `组成员 ${id} 无效` };
    members.push(ev);
  }

  const res = reseat({ group, members, selectedIds, selectedTicks });
  if (!res.ok) return res;

  return {
    ok: true,
    score: {
      ...score,
      events: score.events.map((e) =>
        e.id in res.ticks ? { ...e, ticks: res.ticks[e.id] } : e,
      ),
    },
    warnings: res.warnings,
  };
}
