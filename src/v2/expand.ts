/**
 * 反复展开（unroll）：把带反复记号的谱面展开成**线性谱**。
 *
 * 这是整套反复功能的唯一复杂点，也是它被隔离成一个纯函数的原因：
 * 播放 / 排版 / 校验 / 导出全都只吃线性事件流，一行都不用改。
 * 编辑永远作用在原谱（带反复记号的那份）上，展开产物是派生、只读的。
 *
 * 支持范围（L1，覆盖绝大多数简谱）：
 *   `|: … :|`         反复段（`:|3` = 共 3 遍，缺省 2 遍）
 *   `[1] … [2] …`     跳房子：第 n 遍走第 n 房
 * 明确拒绝（报错而不是猜）：
 *   D.S. / D.C. / Fine / Coda（L2，后续版本）
 *   嵌套超过 2 层
 *   房子不在反复段内 / 房子号数超出遍数
 *
 * 算法：**带遍数上下文的递归重放**（不是区域复制），嵌套自然成立。
 * 每遍把源事件复制一份、赋新 id、写 originId；再统一修 ties 与拍内组。
 */
import type { BarlineEvent, BeatGroup, Event, JumpMark, Score, TimedEvent } from './types';
import { assembleParts, ensembleIssues, scoreParts, withConductor } from './parts';
import { meterAt } from './meter';

export interface ExpandResult {
  /** 线性谱；结构有错时为 null（错误在 errors 里） */
  score: Score | null;
  /** 阻断性错误：结构不对就不展开，不猜 */
  errors: string[];
  /** 非阻断提示：展开了，但有几处值得看一眼（如某遍没有房子、连线跨边界被断开） */
  warnings: string[];
  /** 原谱事件 id → 它在展开谱里**首次**出现的下标（起播定位用） */
  firstIndex: Map<string, number>;
  /** 展开多遍了哪几个反复段（提示用） */
  repeatedSections: number;
}

/**
 * 记号所在的小节号（从 1 数起），仅用于错误信息——
 * 「第 3 小节的 :| 没有配对的 |:」比「下标 17 处」有用得多。
 * 反复记号本身也是小节线，算作新小节的开始。
 */
export function measureAt(events: Event[], index: number): number {
  let n = 1;
  // 谱面**开头**的小节线是第 1 小节的左边界，不算「结束了一个小节」：
  // 判据是它前面还没有任何音符 / 休止符（|: 开头、或 $s 在 |: 之前的谱都会踩到）
  let seenTimed = false;
  for (let i = 0; i < index; i += 1) {
    const e = events[i];
    if (e.kind === 'note' || e.kind === 'rest') {
      seenTimed = true;
      continue;
    }
    if (e.kind === 'barline' && seenTimed) n += 1;
  }
  return n;
}

interface Ctx {
  /** 当前所在的反复段走到了第几遍（外层反复的遍数留在外层 ctx 里） */
  pass: number;
}

export function expandScore(score: Score): ExpandResult {
  if (score.parts?.length) {
    const parts = scoreParts(score);
    const results = parts.map((part) => expandScore(withConductor(score, part.id)));
    const errors = [...ensembleIssues(score), ...results.flatMap((r, i) => r.errors.map((e) => `${parts[i].name}：${e}`))];
    const firstIndex = new Map(results.flatMap((r) => [...r.firstIndex]));
    return {
      score: errors.length || results.some((r) => !r.score) ? null : assembleParts(score, results.map((r, i) => ({ ...parts[i], events: r.score!.events, groups: r.score!.groups }))),
      errors, warnings: results.flatMap((r, i) => r.warnings.map((e) => `${parts[i].name}：${e}`)), firstIndex,
      repeatedSections: results[0]?.repeatedSections ?? 0,
    };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const events = score.events;

  // ── ① 结构检查：配对、嵌套、房子归属。有问题就不展开 ──
  /** 这一根线是不是小节线（反复记号就是带属性的小节线） */
  const barAt = (i: number): BarlineEvent | null =>
    events[i] && events[i].kind === 'barline' ? (events[i] as BarlineEvent) : null;

  const repeatPair = new Map<number, number>(); // |: 下标 → :| 下标
  const stack: number[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (ev.kind === 'jump') continue; // 跳转记号不参与反复配对，②b 阶段解析
    const bar = barAt(i);
    if (!bar) continue;

    if (bar.repeat === 'start') {
      stack.push(i);
      if (stack.length > 2) {
        errors.push(`第 ${measureAt(events, i)} 小节的 |: 让嵌套超过了 2 层（暂不支持更深的嵌套）`);
      }
    } else if (bar.repeat === 'end') {
      const start = stack.pop();
      if (start === undefined) {
        errors.push(`第 ${measureAt(events, i)} 小节的 :| 没有配对的 |:`);
      } else {
        repeatPair.set(start, i);
      }
      const times = bar.times ?? 2;
      if (!Number.isInteger(times) || times < 2) {
        errors.push(`第 ${measureAt(events, i)} 小节的 :| 重复遍数应为 2 以上（当前 ${times}）`);
      }
    }
  }
  for (const s of stack) {
    errors.push(`第 ${measureAt(events, s)} 小节的 |: 没有配对的 :|`);
  }

  /**
   * 容纳下标 i 的**最内层**反复段（[|: 下标, :| 下标]）。
   * 房子就挂在 `|:` 那条线上也算在内（`|: [1] … [2] … :|`：第一房从段首开始）。
   */
  const enclosing = (i: number): [number, number] | undefined => {
    let best: [number, number] | undefined;
    for (const [s, e] of repeatPair) if (s <= i && i < e && (!best || s > best[0])) best = [s, e];
    return best;
  };
  const timesOf = (endIdx: number): number => (barAt(endIdx)?.times ?? 2);

  // 跳房子：挂在某根小节线上，范围 = 本线 → 下一条带房子的线 / 所在反复段的 :|
  const voltaEnd = new Map<number, number>();
  for (let i = 0; i < events.length; i += 1) {
    const bar = barAt(i);
    if (!bar?.volta) continue;

    const sec = enclosing(i);
    if (!sec) {
      errors.push(`第 ${measureAt(events, i)} 小节的 [${bar.volta.join(',')}] 不在反复段内`);
      continue;
    }
    const times = timesOf(sec[1]);
    const bad = bar.volta.filter((n) => n < 1 || n > times);
    if (bad.length > 0) {
      errors.push(`第 ${measureAt(events, i)} 小节的房子号 ${bad.join(',')} 超出反复遍数 ${times}`);
    }
    let end = sec[1];
    for (let j = i + 1; j < sec[1]; j += 1) {
      if (barAt(j)?.volta) {
        end = j;
        break;
      }
    }
    voltaEnd.set(i, end);
  }

  // 房子号断档检查：`|: A [1] B [3] C :|` 这种第 2 遍无房可进才是真问题
  // （那一遍只奏公共部分，多半是漏标）。
  // 但**最后一遍没房是完全合法的**——`|: A [1] B :|` 就是标准的「第一遍房子」：
  // 第 2 遍跳过 [1] 只奏 A。所以只对「断档」（缺的遍数小于已有的最大房号）报警
  for (const [s, e] of repeatPair) {
    const numbers: number[] = [];
    for (let i = s; i < e; i += 1) {
      const v = barAt(i)?.volta;
      if (v) numbers.push(...v);
    }
    if (numbers.length === 0) continue;
    const times = timesOf(e);
    const maxHouse = Math.max(...numbers);
    const missing = Array.from({ length: times }, (_, i) => i + 1).filter(
      (p) => !numbers.includes(p) && p < maxHouse,
    );
    if (missing.length > 0) {
      warnings.push(
        `第 ${measureAt(events, s)} 小节起的反复段：第 ${missing.join('、')} 遍没有对应的房子`,
      );
    }
  }

  if (errors.length > 0) {
    return { score: null, errors, warnings, firstIndex: new Map(), repeatedSections: 0 };
  }

  // ── ② 递归重放：带遍数上下文逐事件发出 ──
  // ②b 的跳转解析会在这一份线性流上再走一遍（D.S. 后重播的部分要重新克隆），
  // 所以必须是 let
  let out: Event[] = [];
  const firstIndex = new Map<string, number>();
  const emitCount = new Map<string, number>();
  /** 展开谱里带 groupId 的组，按“同一遍里连续出现”重建 */
  const groups: BeatGroup[] = [];
  const groupSeq = new Map<string, number>();
  let curGroup: { srcId: string; group: BeatGroup } | null = null;
  let repeatedSections = 0;

  const push = (ev: Event, override?: Partial<Event>): void => {
    const n = (emitCount.get(ev.id) ?? 0) + 1;
    emitCount.set(ev.id, n);
    // 只出现一次的事件保持原 id（没反复的谱面展开后与原来逐字节一致）；
    // 复制出来的第 2、3 份加 `~n` 后缀保证唯一
    const id = n === 1 ? ev.id : `${ev.id}~${n}`;
    const copy: Event = { ...ev, ...override, id, originId: ev.id } as Event;

    if (!firstIndex.has(ev.id)) firstIndex.set(ev.id, out.length);

    // 拍内组：源组每被完整重放一次，就重建一个新的组
    const gid = (copy as TimedEvent).groupId;
    if (gid) {
      if (!curGroup || curGroup.srcId !== gid) {
        const k = (groupSeq.get(gid) ?? 0) + 1;
        groupSeq.set(gid, k);
        const src = score.groups.find((g) => g.id === gid);
        const group: BeatGroup = {
          id: k === 1 ? gid : `${gid}~${k}`,
          totalTicks: 0,
          memberIds: [],
          ...(src?.tuplet ? { tuplet: src.tuplet } : {}),
        };
        groups.push(group);
        curGroup = { srcId: gid, group };
      }
      (copy as TimedEvent).groupId = curGroup.group.id;
      curGroup.group.memberIds.push(id);
      curGroup.group.totalTicks += (copy as TimedEvent).ticks;
    } else if (copy.kind === 'note' || copy.kind === 'rest') {
      curGroup = null;
    }

    out.push(copy);
  };

  /**
   * 小节线（含反复记号）在展开产物里就是普通小节线。
   * 两根线不能连着站——中间会凭空多出一个 0 拍的空小节，拍数校验立刻报错。
   *   曲首的 `|:` 前面什么都没有 → 不补线
   *   后面那根线**顶掉**前面那根 → 源谱的 `||` 覆盖展开时补的分隔线，
   *   反复段结尾接下一段时也正好只留一根
   */
  const pushBar = (ev: Event): void => {
    if (out.length === 0) return;
    if (out[out.length - 1].kind === 'barline') out.pop();
    const bar = ev as BarlineEvent;
    // 展开产物是**线性谱**，不再有反复：这条线上的 repeat / times / volta 一律抹掉
    // （漏抹的话展开谱会带着 [1] / :| 出门，再展开一次就报「没有配对的 |:」）
    push(ev, {
      kind: 'barline',
      style: bar.style,
      repeat: undefined,
      times: undefined,
      volta: undefined,
      voltaOpen: undefined,
      ...(bar.partial ? { partial: true } : {}),
    } as Partial<Event>);
  };

  /**
   * 反复段的**某一遍**：公共部分每遍都走，房子按遍数各走各的。
   *
   * 单独抽出来是因为「第一房就起在 `|:` 那条线上」时没有公共部分
   * （`|: [1] 3 3 | [2] 4 4 :|`）——若在 emitRange 里边走边判，
   * 第二遍会先把 3 3 也放出来，因为它前面没有房子线可挡。
   */
  const emitPass = (s: number, e: number, pass: number): void => {
    const houses: number[] = [];
    for (let i = s; i < e; i += 1) if (barAt(i)?.volta) houses.push(i);
    if (houses.length === 0) {
      emitRange(s + 1, e, { pass });
      return;
    }
    // 段首到第一个房子之间 = 每遍都走的公共部分
    if (houses[0] > s) emitRange(s + 1, houses[0], { pass });
    for (const h of houses) {
      const end = voltaEnd.get(h) ?? e;
      if (!(barAt(h)?.volta ?? []).includes(pass)) continue;
      pushBar(events[h]); // 房子的括线起在这条小节线上
      emitRange(h + 1, end, { pass });
    }
  };

  const emitRange = (from: number, to: number, ctx: Ctx): void => {
    let i = from;
    while (i < to) {
      const ev = events[i];
      const bar = barAt(i);

      if (bar?.repeat === 'start') {
        const end = repeatPair.get(i);
        if (end === undefined || end >= to) {
          i += 1;
          continue; // 结构错误已在 ① 报过
        }
        const times = Math.max(2, timesOf(end));
        repeatedSections += 1;
        pushBar(ev); // `|:` 本身是一条小节线
        for (let p = 1; p <= times; p += 1) {
          // 第二遍起在前面补一条分隔线（就是反复段结束那道线）
          if (p > 1) pushBar(events[end]);
          emitPass(i, end, p);
        }
        // 收尾：源谱在 `:|` 之后还接内容（`… :| 2 2 2 2 ||`）时，这道线就是那段的分隔；
        // 后面若是 `||`，pushBar 会让它顶掉这一根，不会出现 `| ||`
        pushBar(events[end]);
        i = end + 1;
        continue;
      }

      if (bar?.repeat === 'end') {
        // 正常情况下由 `|:` 分支在每遍收尾时发出；这里兜底（结构错误时）
        pushBar(ev);
        i += 1;
        continue;
      }

      if (bar?.volta) {
        const end = voltaEnd.get(i) ?? to;
        // 这一遍不走这个房 → 整段跳过（房与房之间的内容必须各自包在区间内）
        if (bar.volta.includes(ctx.pass)) {
          pushBar(ev); // 房子的括线起在小节线上，这根线不能少
          emitRange(i + 1, end, ctx);
        }
        i = end + 1;
        continue;
      }

      if (bar) {
        pushBar(ev);
        i += 1;
        continue;
      }

      push(ev);
      i += 1;
    }
  };

  emitRange(0, events.length, { pass: 1 });

  // ── ②b 跳转记号解析（L2）：D.S. / D.C. / To ⊕ / ⊕ / Fine ──
  // 在反复展开后的线性流上做一次走谱：遇到 D.S.（或 D.C.）跳到 𝄋（或开头），
  // 之后遇到 To ⊕ 跳到 ⊕，遇到 Fine 结束。约定：**𝄋 → To ⊕ 这段两次奏得一样**——
  // 回跳后按原样重跑整段（含段内反复的第二遍），这样 `𝄋 |: A [1] B :| To ⊕` 这类
  // 结构才不会在第二遍把 [2] 房 / 第二遍整段丢掉。不会死循环：段内反复已在
  // phase A 摊平，回跳只执行一次（jumped 标志）。
  {
    const idxOf = (mark: JumpMark): number =>
      out.findIndex((e) => e.kind === 'jump' && e.mark === mark);
    const segno = idxOf('segno');
    const ds = idxOf('ds');
    const dc = idxOf('dc');
    const tocoda = idxOf('tocoda');
    const coda = idxOf('coda');
    const hasJump = [ds, dc, tocoda].some((i) => i >= 0);

    if (ds >= 0 && segno < 0) {
      errors.push('D.S. 找不到跳回目标 𝄋（请用 $s 在反复起点标上 segno）');
    }
    if (tocoda >= 0 && coda < 0) {
      errors.push('To ⊕ 找不到跳转目标 ⊕（请用 $x 在结束句开头标上 coda）');
    }

    if (hasJump && errors.length === 0) {
      const emitCount = new Map<string, number>();
      const clone = (ev: Event): Event => {
        const n = (emitCount.get(ev.id) ?? 0) + 1;
        emitCount.set(ev.id, n);
        // 第一次经过保持原 id（谱面高亮 / 组引用都认它）；D.S. 后重播的加 #n 后缀
        return n === 1 ? ev : ({ ...ev, id: `${ev.id}#${n}` } as Event);
      };
      const walked: Event[] = [];
      let i = 0;
      let jumped = false; // 已执行过 D.S. / D.C.
      let inCoda = false; // 已跳进 ⊕（跳回只执行一次）
      let guard = out.length * 3 + 16;
      while (i < out.length && guard-- > 0) {
        const ev = out[i];
        if (ev.kind === 'jump') {
          if (ev.mark === 'ds' || ev.mark === 'dc') {
            if (jumped) {
              i += 1; // 第二份记号（反复复制出来的）：跳转已执行过，不再跳
              continue;
            }
            jumped = true;
            walked.push(clone(ev));
            i = ev.mark === 'dc' ? 0 : segno;
            continue;
          }
          if (ev.mark === 'tocoda') {
            if (jumped && !inCoda) {
              if (coda < 0 || coda <= i) {
                errors.push('⊕ 必须在 To ⊕ **之后**（跳转只能向前）');
                i += 1;
                continue;
              }
              walked.push(clone(ev));
              inCoda = true;
              i = coda;
              continue;
            }
            walked.push(clone(ev));
            i += 1;
            continue;
          }
          if (ev.mark === 'fine' && jumped) {
            walked.push(clone(ev));
            break; // al Fine：到此结束
          }
          walked.push(clone(ev));
          i += 1;
          continue;
        }
        // 𝄋 → To ⊕ 这一段**两次听起来必须一样**，所以回跳后按原样重跑整段，
        // 包括段内反复的第二遍（phase A 复制出来的克隆，id 带 ~）。
        // 旧约定是「跳回去后段内反复不再反复」，那会让带房子的段在第二遍
        // 只奏 [1] 房、把 [2] 房整段丢掉（实测 灰姑娘：副歌少奏一遍）。
        // 不会死循环：段内反复早在 phase A 就摊平成线性流了，这里只是重放
        walked.push(clone(ev));
        i += 1;
      }
      out = walked;
    }
  }

  // ── ③ 收尾：终止线、ties、组总时值 ──
  // 回跳后恢复源小节的拍号，不能沿用刚演奏完的尾段拍号。
  const sourceIndex = new Map(events.map((e, i) => [e.id, i]));
  let currentBeat = score.meta.beat;
  for (let i = 0; i < out.length; i++) {
    const ev = out[i];
    if (ev.kind === 'barline') { if (ev.beatAfter) currentBeat = ev.beatAfter; continue; }
    if (ev.kind !== 'note' && ev.kind !== 'rest') continue;
    const source = sourceIndex.get(ev.originId ?? ev.id);
    if (source === undefined) continue;
    const beat = meterAt(score, source);
    if (beat === currentBeat) continue;
    let boundary = i - 1;
    while (boundary >= 0 && out[boundary].kind !== 'barline' && !('ticks' in out[boundary])) boundary--;
    const bar = out[boundary];
    if (bar?.kind === 'barline') bar.beatAfter = beat;
    else { out.splice(i, 0, { id: `${ev.id}:meter`, kind: 'barline', style: 'single', beatAfter: beat }); i++; }
    currentBeat = beat;
  }
  firstIndex.clear();
  out.forEach((e, i) => { if (e.originId && !firstIndex.has(e.originId)) firstIndex.set(e.originId, i); });
  for (let i = 0; i < out.length; i++) {
    const ev = out[i];
    if (ev.kind !== 'note' || !ev.hairpinTo) continue;
    let target: Event | undefined;
    let previous = sourceIndex.get(ev.originId ?? ev.id) ?? -1;
    for (let j = i + 1; j < out.length; j++) {
      const next = out[j];
      if (next.kind !== 'note' && next.kind !== 'rest') continue;
      const at = sourceIndex.get(next.originId ?? next.id) ?? -1;
      if (at <= previous) break;
      if (next.kind === 'note' && next.originId === ev.hairpinTo) { target = next; break; }
      previous = at;
    }
    if (target) ev.hairpinTo = target.id;
    else { delete ev.hairpinTo; delete ev.hairpin; warnings.push('渐强/渐弱范围跨过反复或跳转边界，展开时已移除该范围'); }
  }

  // 展开谱的最后要有终止线：源谱末尾是 :| 时它顶替了终止线
  const last = out[out.length - 1];
  if (!last) {
    return { score: null, errors: ['谱面为空'], warnings, firstIndex, repeatedSections };
  }
  if (last.kind === 'barline') {
    (last as BarlineEvent).style = 'final';
  } else {
    out.push({ id: `${last.id}·end`, kind: 'barline', style: 'final', originId: last.id });
  }

  // ties / slur 的 to 指向源 id，展开后必须改指展开谱里的 id。
  // 指向的音若不在**紧接着的下一颗**（跨反复边界），弧线已经断开 → 丢弃并提示。
  for (let i = 0; i < out.length; i += 1) {
    const ev = out[i];
    if (ev.kind !== 'note' || !ev.ties?.length) continue;
    const next = out.slice(i + 1).find((e) => e.kind === 'note' || e.kind === 'rest');
    const kept = ev.ties.filter((t) => next && next.originId === t.to);
    if (kept.length !== ev.ties.length) {
      const at = events.findIndex((e) => e.id === ev.originId);
      warnings.push(`第 ${at >= 0 ? measureAt(events, at) : '?'} 小节处的连线跨了反复边界，已断开`);
    }
    if (kept.length > 0) ev.ties = kept;
    else delete ev.ties;
  }

  // ②b 的跳转错误（如 D.S. 没有 𝄋）也要拦：结构有错就不给展开谱
  return {
    score: errors.length > 0 ? null : { ...score, events: out, groups },
    errors,
    warnings,
    firstIndex,
    repeatedSections,
  };
}
