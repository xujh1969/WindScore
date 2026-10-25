import { useMemo, useState } from 'react';
import { TICKS_PER_BEAT, isLegalTick } from '../ticks';
import { beatLabel, decodeDuration, groupCandidates, MAX_BEAMS } from '../edit';
import { ExpClose } from './ExpClose';

export interface CustomGroupMember {
  id: string;
  kind: 'note' | 'rest';
  /** 音级（休止符为 0，仅显示用） */
  degree: number;
}

interface Props {
  /** 要凑成的总时值（tick）：从「总时值」档位带进来（复拍子大拍档可到 1½/3 拍） */
  totalTicks: number;
  /** 光标所在拍号：3 分体系大拍档的预填候选按小拍网格出 */
  beat?: string;
  /** 选中的成员（连续选区顺序） */
  members: CustomGroupMember[];
  /** 选区当前已设置的时值（逐音 tick，与 members 同序）：打开时预填进弹窗 */
  initialTicks?: number[];
  /** 选区当前所属组的连音级别（当前是连音组合时勾选框直接勾上） */
  initialTuplet?: number;
  onApply: (ticks: number[], tuplet: number | undefined, dots: (0 | 1 | 2)[]) => void;
  onClose: () => void;
}

interface MemberState {
  beams: number;
  dots: 0 | 1 | 2;
}

/** 减时线 b + 附点 d 的时值（tick）：基准 ÷ 2^b × 附点系数 */
function valueOf(beams: number, dots: 0 | 1 | 2): number {
  return Math.round((TICKS_PER_BEAT / 2 ** beams) * (dots === 0 ? 1 : dots === 1 ? 1.5 : 1.75));
}

/** 均分值向下取到最近的常规时值线数（预填兜底） */
function fallbackBeams(totalTicks: number, n: number): number {
  const even = totalTicks / n;
  if (even >= TICKS_PER_BEAT) return 0;
  let beams = 0;
  while (beams < MAX_BEAMS && TICKS_PER_BEAT / 2 ** (beams + 1) >= even) beams += 1;
  return beams;
}

/**
 * 自定义音值组合：逐音点亮附点与减时线，实时合计，凑齐目标才能应用。
 *
 * 覆盖性：每音的值域是封闭的（基准 ÷ 2^线 × 附点系数），任何「和恰好等于
 * 目标」的非连音组合都能逐音表达——把组合穷举变成 N 次独立单音选择。
 * 连音成员（1/3、1/5 拍…）不在此值域：成员数 3/5/6/7 时提供「按连音均分」
 * 勾选（勾上后线/点锁定为连音标准，只剩对勾），与 candidatesFor 的连音
 * 候选同一条写回路径。
 */
export function CustomGroupDialog({ totalTicks, beat, members, initialTicks, initialTuplet, onApply, onClose }: Props) {
  const n = members.length;
  // 连音均分只在 3/5/6/7 音出现：2/4/8 音的均分本来就是常规时值，不需要连音。
  // 且**均分值本身要不可书写**（1 拍÷3=2240 这种）才需要连音标号——
  // 6/8 系里 1½ 拍÷3 = 3360 是普通八分，是自然划分，勾了反而会画出错误的「3」
  const tupletAvailable = useMemo(() => {
    if (![3, 5, 6, 7].includes(n)) return false;
    // 连音组跨度 ≤ 1 拍（I2 对连音组恒按 1 拍封顶，两拍连音现有 DSL 写不了）
    if (totalTicks > TICKS_PER_BEAT) return false;
    const each = Math.round(totalTicks / n);
    return Number.isInteger(totalTicks / n) && each > 0 && isLegalTick(each) && !decodeDuration(each);
  }, [n, totalTicks]);
  const tupletEach = useMemo(() => Math.round(totalTicks / n), [totalTicks, n]);

  // 预填：选区已有组合时**代入当前样子**（逐音反解为线+点，连音组合直接勾上
  // 连音模式）；全新选区取 candidatesFor 里第一个可完整反解的常规候选
  //（通常是「前八后十六」这类常见骨架），没有就按均分向下取线
  const [states, setStates] = useState<MemberState[]>(() => {
    // 只有「选区现在已经凑成了目标时值」才代入现状。初次选中（各音还是各自
    // 原时值、合计远超目标）不能代入——否则预填出满屏灰线（用户实测）
    const initialSum = initialTicks?.reduce((a, b) => a + b, 0);
    if (initialTicks && initialTicks.length === n && initialSum === totalTicks) {
      const decoded = initialTicks.map((t) => decodeDuration(t));
      if (decoded.every((d) => d)) {
        return decoded.map((d) => ({ beams: d!.beams, dots: d!.dots }));
      }
    }
    const fromCands = groupCandidates(n, totalTicks, beat).find(
      (c) => !c.tuplet && c.ticks.every((t) => decodeDuration(t)),
    );
    if (fromCands) {
      return fromCands.ticks.map((t) => {
        const d = decodeDuration(t)!;
        return { beams: d.beams, dots: d.dots };
      });
    }
    return Array.from({ length: n }, () => ({ beams: fallbackBeams(totalTicks, n), dots: 0 as const }));
  });
  const [tupletMode, setTupletMode] = useState(initialTuplet === n && [3, 5, 6, 7].includes(n));

  const patch = (i: number, next: Partial<MemberState>): void => {
    setStates((old) => old.map((s, j) => (j === i ? { ...s, ...next } : s)));
  };

  const ticks = states.map((s) => valueOf(s.beams, s.dots));
  const sum = ticks.reduce((a, b) => a + b, 0);
  const exact = sum === totalTicks;
  const over = sum > totalTicks;
  const diff = Math.abs(sum - totalTicks);

  const locked = tupletAvailable && tupletMode;

  const apply = (): void => {
    if (locked) {
      onApply(Array(n).fill(tupletEach), n, Array(n).fill(0));
      return;
    }
    if (!exact) return;
    onApply(ticks, undefined, states.map((s) => s.dots));
  };

  return (
    <div className="v2-exp-mask" onClick={onClose}>
      <div
        className="v2-exp v2-custom-group"
        role="dialog"
        aria-label="自定义音值组合"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="v2-exp-head">
          <span>
            自定义组合 · 凑成 {beatLabel(totalTicks)} · {n} 个音
          </span>
          <ExpClose onClose={onClose} />
        </div>

        {tupletAvailable ? (
          <label className="v2-cg-tuplet">
            <input
              type="checkbox"
              checked={tupletMode}
              onChange={(e) => setTupletMode(e.target.checked)}
            />
            按连音均分（{n} 连音 · 每音 {beatLabel(tupletEach)} 拍，标号 {n}；线与附点自动定，不再逐音改）
          </label>
        ) : null}

        <div className={`v2-cg-row${locked ? ' is-locked' : ''}`}>
          {members.map((m, i) => {
            const s = states[i]!;
            const shown = locked ? { beams: 1, dots: 0 as const } : s;
            const shownValue = locked ? tupletEach : ticks[i]!;
            return (
              <div className="v2-cg-col" key={m.id}>
                {/* 附点贴在音符右侧（记谱里附点就写在音的右边） */}
                <div className="v2-cg-head">
                  <span className={`v2-cg-digit${m.kind === 'rest' ? ' is-rest' : ''}`}>
                    {m.kind === 'note' ? m.degree : 0}
                  </span>
                  <div className="v2-cg-dots">
                    {[1, 2].map((k) => (
                      <button
                        key={k}
                        type="button"
                        className={`v2-cg-dot${shown.dots >= k ? ' is-on' : ''}`}
                        disabled={locked || (k === 2 && shown.dots === 0)}
                        title={k === 1 ? '附点（+1/2）' : '复附点（再 +1/4）'}
                        onClick={() => patch(i, { dots: (s.dots >= k ? k - 1 : k) as 0 | 1 | 2 })}
                      />
                    ))}
                  </div>
                </div>
                <div className="v2-cg-beams">
                  {Array.from({ length: MAX_BEAMS }, (_, j) => {
                    const k = j + 1;
                    return (
                      <button
                        key={k}
                        type="button"
                        className={`v2-cg-beam${shown.beams >= k ? ' is-on' : ''}`}
                        disabled={locked}
                        title={`减时线 ${k}（${beatLabel(TICKS_PER_BEAT / 2 ** (k - 1))} 基准）`}
                        onClick={() => patch(i, { beams: s.beams >= k ? k - 1 : k })}
                      />
                    );
                  })}
                </div>
                <span className="v2-cg-value">{beatLabel(shownValue)}</span>
              </div>
            );
          })}
        </div>

        <div className="v2-cg-foot">
          <div className="v2-cg-meter">
            <div className="v2-cg-meter-slot">
              <div
                className={`v2-cg-meter-fill${exact ? ' is-exact' : over ? ' is-over' : ''}`}
                style={{ width: `${Math.min(100, (sum / totalTicks) * 100)}%` }}
              />
            </div>
            <div className="v2-cg-sum" role="status">
              {exact
                ? `合计 ${beatLabel(sum)} · 正好等于目标 ${beatLabel(totalTicks)}，可以应用`
                : over
                  ? `合计 ${beatLabel(sum)} / ${beatLabel(totalTicks)} · 超出 ${beatLabel(diff)}，减短一些音`
                  : `合计 ${beatLabel(sum)} / ${beatLabel(totalTicks)} · 还差 ${beatLabel(diff)}`}
            </div>
          </div>
          <button
            type="button"
            className={`v2-cg-apply${exact || locked ? ' is-ready' : ''}`}
            disabled={!exact && !locked}
            title={locked ? '应用连音均分' : exact ? '应用这个组合' : '合计还没凑齐目标时值'}
            onClick={apply}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5 12.5 4.5 4.5L19 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
