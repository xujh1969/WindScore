import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { candidateGlyph } from '../edit';
import type { TierCandidate } from '../edit';
import { TICKS_PER_BEAT } from '../ticks';
import { GroupGlyph } from './GroupGlyph';
import { DurationGlyph, NotationGlyph, SlurGlyph } from './NotationGlyph';
import {
  AnnotationField,
  DynamicsField,
  GraceField,
  GrayField,
  HairpinField,
  KeyChangeField,
  TechniqueField,
} from './NoteFields';
import type { BarlineEvent, JumpMark, NoteEvent, RestEvent, Score } from '../types';
import { instrumentPatches, instrumentLabel } from '../instrumentSamples';
import { SEGNO_SYMBOL, MUSIC_SYMBOL_FONT } from '../musicSymbols';

/**
 * 小节线按钮的记号图形：照谱面画法画——反复的**粗线总在外侧**（远离反复的音乐）：
 * 反复开始 = 粗线、细线、两点（点在右）；反复结束 = 两点、细线、粗线（点在左）；
 * 终止 = 细线、粗线；双细线 = 两根等粗细线（乐段结束）。
 */
function BarlineGlyph({ kind }: { kind: 'single' | 'repeat-start' | 'repeat-end' | 'repeat-both' | 'double' | 'final' }): ReactNode {
  const line = (x: number, thick = false): ReactNode => (
    <line key={x} x1={x} y1={2} x2={x} y2={16} stroke="currentColor" strokeWidth={thick ? 2.8 : 1.3} />
  );
  const dots = (x: number): ReactNode => (
    <g fill="currentColor">
      <circle cx={x} cy={6} r={1.7} />
      <circle cx={x} cy={12} r={1.7} />
    </g>
  );
  return (
    <svg width="15" height="18" viewBox="0 0 16 18" aria-hidden="true" style={{ display: 'block', margin: '0 auto' }}>
      {kind === 'single' && line(8)}
      {kind === 'repeat-start' && (
        <>
          {line(1.5, true)}
          {line(5.5)}
          {dots(9.5)}
        </>
      )}
      {kind === 'repeat-end' && (
        <>
          {dots(2.5)}
          {line(6.5)}
          {line(10.5, true)}
        </>
      )}
      {kind === 'repeat-both' && (
        <>
          {dots(1)}
          {line(4)}
          {line(8, true)}
          {line(12)}
          {dots(15)}
        </>
      )}
      {kind === 'double' && (
        <>
          {line(5.5)}
          {line(10.5)}
        </>
      )}
      {kind === 'final' && (
        <>
          {line(5.5)}
          {line(10, true)}
        </>
      )}
    </svg>
  );
}

/** 音值组合的候选（与属性面板同一份 pending，面板里就地渲染） */
export interface PadPending {
  count: number;
  /** 这些音要凑成的总时值 */
  ticks: number;
  /** 每个音的音级（休止符 0，仅显示用） */
  degrees: number[];
  cands: TierCandidate[];
}

export interface PadActions {
  /** 音级：光标在音上时改音级，否则插入新音（octave 由按钮所在的八度排决定） */
  note: (degree: number, octave: number) => void;
  /** 0：休止符 */
  rest: () => void;
  /** X：无音高音符（打击 / 拍手 / 念节奏），发声、无固定音高 */
  x: () => void;
  barline: () => void;
  /**
   * 带属性的小节线：反复开始 `|:` / 反复结束 `:|` / 双细线 `‖`（乐段结束）/ 终止 `||`。
   * 光标左边（或被选中）那根线就地改，没有就先插一根再设——不会多出一条线。
   */
  barlineAs: (kind: 'repeat-start' | 'repeat-end' | 'repeat-both' | 'double' | 'final') => void;
  /** 变音记号循环：升 # → 降 b → 还原 ♮ → 无（跟随调号） */
  accidental: () => void;
  dot: () => void;
  breakLine: () => void;
  /** 升 8 / 降 8（对光标左侧的音） */
  octave: (delta: number) => void;
  paren: (side: 'open' | 'close') => void;
  /** 选了多个音 = 建链 / 取消；单光标 = 向右多连一个音 */
  slur: () => void;
  duration: (ticks: number) => void;
  /** 音值组合：ticks = 这几个音要凑成的总时值（弹出常用候选） */
  group: (ticks: number) => void;
  /** 应用某个常用组合候选（与属性面板候选同一写回路径） */
  applyGroup: (cand: TierCandidate) => void;
  /** 打开自定义组合弹窗（依附当前候选） */
  openCustomGroup: () => void;
  /** 取消本次组合，收起候选 */
  cancelGroup: () => void;
  /** 删除（与键盘 Backspace 等价）：删替换目标，否则删光标左边的音 */
  del: () => void;
}

/** 小节线模式的动作集（互斥：点中竖线时整个面板切换成这些） */
export interface PadBarlineActions {
  setBeatAfter: (v?: string) => void;
  /** 此线之后的速度（BPM，20–300）：只影响合成音播放/导出/节拍器，伴奏跟对轨同步点走 */
  setBpmAfter: (v?: number) => void;
  /** 此线之后的音色（0–255）：只影响合成音 */
  setPatchAfter: (v?: number) => void;
  setBreakAfter: (v?: 'line' | 'page') => void;
  setRepeat: (repeat: 'start' | 'end' | 'both') => void;
  setRepeatTimes: (n: number) => void;
  setVolta: (n: number) => void;
  toggleFinal: () => void;
  toggleDouble: () => void;
  toggleVoltaOpen: () => void;
  toggleJump: (mark: JumpMark | null) => void;
}

const BAR_BEATS = ['2/4', '3/4', '4/4', '5/4', '6/4', '2/2', '3/8', '6/8', '9/8', '12/8'];

/**
 * 小节线换音色的候选：真采样音色（内置 ∪ 已装音色包）∪ 钢琴（0）。
 * **必须在渲染时现取**：音色包是运行时注册的，模块顶层缓存一次会把后导入的
 * 排箫等全部漏掉（0.4.12 实测「导入的音色不在列表里」）。
 * 0 号特殊：没包覆盖时是合成钢琴；包覆盖了（如整套 GM 包的「三角钢琴」）就
 * 跟随包——不能两个都列（都是 0 号，选哪个都是同一个声音）。
 */
const patchOptions = (): number[] => {
  const list = instrumentPatches();
  return list.includes(0) ? list : [0, ...list];
};
const patchOptionLabel = (p: number): string =>
  p === 0 && !instrumentLabel(p) ? '钢琴（合成）' : `${p} ${instrumentLabel(p) ?? ''}`.trim();

/**
 * 谱中变速输入：自由输入 20–300 的整数，失焦 / 回车才提交；
 * 提交时钳到合法区间，并与该线之前的有效 BPM 比较——
 * 一次跳变超过一倍（≥2× 或 ≤½×）时提示确认，避免手滑写出离谱的速度。
 */
function BpmAfterField({ value, prevBpm, onCommit }: { value?: number; prevBpm: number; onCommit: (v?: number) => void }) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => { setDraft(value === undefined ? '' : String(value)); }, [value]);
  const raw = draft.trim();
  const n = raw === '' ? NaN : Math.round(Number(raw));
  const valid = Number.isFinite(n);
  const clamped = Math.max(20, Math.min(300, n));
  const outOfRange = valid && clamped !== n;
  const jump = valid && !outOfRange && (clamped >= prevBpm * 2 || clamped <= prevBpm / 2);
  const commit = () => {
    if (raw === '') { onCommit(undefined); return; }
    if (!valid) { setDraft(value === undefined ? '' : String(value)); return; }
    onCommit(clamped);
  };
  return (
    <div className="v2-field">
      <span className="v2-field-label">此线之后的速度（BPM）</span>
      <input
        className="v2-bpm-input"
        type="number"
        inputMode="numeric"
        min={20}
        max={300}
        step={1}
        placeholder="沿用之前的速度"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      {outOfRange ? <p className="v2-hint">超出 20–300，将按边界处理</p> : null}
      {jump ? <p className="v2-hint">与该线之前的 {prevBpm} BPM 相比变化超过一倍，请确认是否需要这么大的幅度</p> : null}
    </div>
  );
}

interface Props {
  actions: PadActions;
  /** 时值档位（拍 / 分数拍），来自 durationTiers */
  tiers: { label: string; ticks: number }[];
  /**
   * 音值组合档位：来自光标所在小节拍号的连通档位表（手册 §7）——
   * 4/4 系 1/½/¼/⅛ 拍，6/8 系 1½/1/¾/½/3/8 拍，6/4 3/2/1½/1/¾ 拍。
   * ok 由编辑器按当前选中音数算好（能不能划分出常用组合）。
   */
  groupTargets: { label: string; ticks: number; ok: boolean }[];
  /** 当前选中的音符数：决定音值组合哪几档可用（2–8 个音） */
  selectedCount: number;
  /** 音值组合候选（点了目标拍数后出现；null = 没有进行中的组合） */
  pending: PadPending | null;
  /** 谱面数据：字段组件（技法/倚音/力度…）直接读写 */
  score: Score;
  /** 目标：选中（或光标左侧）的音符 / 休止符——面板按钮按它点亮当前状态 */
  target: NoteEvent | RestEvent | null;
  /** 批量选中的音（≥2 才显示选区操作） */
  batchIds: string[];
  /** 直接写谱（与属性面板同一入口，撤销历史一致） */
  onSetScore: (s: Score) => void;
  /** 提交段落标注（编辑器负责光标位移与撤销） */
  onAnnotate: (next: Score, shift: number) => void;
  /** 点选中的小节线；**与音符编辑互斥**——点线时整个面板只显示小节线编辑 */
  barline: BarlineEvent | null;
  barlineActions: PadBarlineActions;
  jumpAfter: JumpMark | null;
  playOrder: string[] | null;
  canEditConductor: boolean;
  /** 选区跳房子：ok = 当前选区能设为房子（选区头前是小节线墙） */
  volta: { ok: boolean; error: string | null };
  doSelectionVolta: (n: number) => void;
}

/**
 * 音级键：一排一个八度，每排 7 个音直接摆出来。
 *
 * 不做「先选高音 / 低音再按数字」的切换——多一次点击，还容易忘了当前停在哪档。
 * 八度按简谱本来的样子标：高音数字上方加点、低音下方加点，看一眼就知道是哪一排。
 */
interface OctaveRowDef {
  name: string;
  oct: number;
}

/** 常用的三排摆在面板最上面，一伸手就够着 */
const OCTAVE_ROWS: OctaveRowDef[] = [
  { name: '高音', oct: 1 },
  { name: '中音', oct: 0 },
  { name: '低音', oct: -1 },
];

/** 高高音 / 低低音极少用到，压到面板最底下（时值排之后），别占着前排的位置 */
const EXTREME_ROWS: OctaveRowDef[] = [
  { name: '高高音', oct: 2 },
  { name: '低低音', oct: -2 },
];

/**
 * 时值按钮上画的样子：用 x 占位，不写具体音级——
 * 写 5-- 容易被当成「按下去就输入 5」，x-- 才只是个时值样子。
 */
const SAMPLE_DEGREE = 'x';

/** 一排音级键：7 个音，八度由这一排的 oct 决定 */
function OctaveRow({ row, actions, na, litDegree, litOct }: { row: OctaveRowDef; actions: PadActions; na?: boolean; litDegree?: number; litOct?: number }) {
  // 中音排（不加八度点的那排）用主色标出来，跟上下两排一眼分得开
  const mid = row.oct === 0 ? ' v2-pad-mid' : '';
  return (
    <div className="v2-grid v2-grid-7">
      {[1, 2, 3, 4, 5, 6, 7].map((d) => (
        <button
          key={d}
          disabled={na}
          className={`v2-btn v2-pad-num${mid}${litDegree === d && litOct === row.oct ? ' is-on' : ''}`}
          onClick={() => actions.note(d, row.oct)}
          title={`${row.name} ${d}`}
          aria-label={`${row.name} ${d}`}
        >
          <NotationGlyph degree={d} dots={row.oct} />
        </button>
      ))}
    </div>
  );
}

/**
 * 输入板主体（原「浮动输入板」并入右侧编辑栏后的形态）：
 * 习惯用输入板录入的人不必记键盘，音符录入 / 小节线 / 音符属性一个面板全包。
 *
 * 点中小节线时整块切换成小节线编辑（与音符编辑互斥）；
 * 批量选中 ≥2 音时只留选区有意义的排。
 * 所有按钮都作用在**光标处 / 光标左侧的音**上，与键盘输入等价。
 */
export function PadBody({
  actions,
  tiers,
  groupTargets,
  selectedCount,
  pending,
  score,
  target,
  batchIds,
  onSetScore,
  onAnnotate,
  barline,
  barlineActions,
  jumpAfter,
  playOrder,
  canEditConductor,
  volta,
  doSelectionVolta,
}: Props) {
  /**
   * 批量选中 ≥2 个音 = 选区模式：只留「对整段有意义」的按钮，
   * 音符输入类（音级键盘 / 休止 / 小节线插入 / 变音 / 八度 / 括号…）全部隐藏——
   * 它们作用在光标处或单个音上，选区下点了只会让人困惑。
   */
  const isRange = selectedCount >= 2;
  const dur = tiers.filter((t) => t.ticks <= TICKS_PER_BEAT * 4);
  // 音值组合档位的可用性（ok）由编辑器按选中音数算好随 props 传入；
  // selectedCount 只用于禁用态的提示文案
  const groups = groupTargets;

  // ── 按钮点亮：目标音当前的属性直接映到对应按钮上（选了什么亮什么）──
  const note = target && target.kind === 'note' ? target : null;
  const isRest = target?.kind === 'rest' && !target.x;
  const isX = target?.kind === 'rest' && target.x === true;
  // 括号是独立的 directive 事件，紧贴在目标音前 / 后（toggleParen 就这么插）
  const tIdx = target ? score.events.findIndex((e) => e.id === target.id) : -1;
  const evAt = (i: number): string | null => {
    const ev = i >= 0 && i < score.events.length ? score.events[i] : null;
    return ev && ev.kind === 'directive' && ev.type === 'paren' ? ev.value : null;
  };
  const parenOpen = tIdx >= 0 && evAt(tIdx - 1) === '(';
  const parenClose = tIdx >= 0 && evAt(tIdx + 1) === ')';
  // 该小节线之前的有效速度：谱头 BPM 或上游小节线的「速xx」——变速跳变检查的基准
  let prevBpm = score.meta.bpm;
  {
    const bIdx = barline ? score.events.findIndex((e) => e.id === barline.id) : -1;
    for (let i = 0; i < bIdx; i++) {
      const ev = score.events[i];
      if (ev.kind === 'barline' && typeof ev.bpmAfter === 'number') prevBpm = ev.bpmAfter;
    }
  }

  // 谱中换音色（patchAfter）是**声部私有**属性（0.4.22 起）：首声部与非首声部
  // 都要能改自己这根线的音色，所以这个字段在 canEditConductor 门内外各渲染一份
  const patchAfterField = (
    <div className="v2-field">
      <span className="v2-field-label">此线之后的音色{canEditConductor ? '' : '（本声部）'}</span>
      <select
        className="v2-meta-input"
        value={barline?.patchAfter ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          barlineActions.setPatchAfter(v === '' ? undefined : Number(v));
        }}
      >
        <option value="">沿用之前的音色</option>
        {patchOptions().map((p) => <option key={p} value={p}>{patchOptionLabel(p)}</option>)}
        {barline?.patchAfter != null && !patchOptions().includes(barline.patchAfter) ? (
          <option value={barline.patchAfter}>{patchOptionLabel(barline.patchAfter)}</option>
        ) : null}
      </select>
    </div>
  );

  return (
    <div className="v2-pad-body">
      {barline ? (
        <>
        {!canEditConductor ? (
          <>
          <p className="v2-hint">全谱的拍号、速度、反复、跳房子与跳转由首声部控制，切回首声部再编辑。音色是各声部自己的设置，在这里改本声部的。</p>
          {patchAfterField}
          </>
        ) : (
        <>
        <div className="v2-field">
          <span className="v2-field-label">此线之后的拍号</span>
          <select className="v2-meta-input" value={barline.beatAfter ?? ''} onChange={(e) => barlineActions.setBeatAfter(e.target.value || undefined)}>
            <option value="">沿用之前的拍号</option>
            {BAR_BEATS.map((beat) => <option key={beat} value={beat}>{beat}</option>)}
            {barline.beatAfter && !BAR_BEATS.includes(barline.beatAfter) ? <option value={barline.beatAfter}>{barline.beatAfter}</option> : null}
          </select>
        </div>
        <BpmAfterField value={barline.bpmAfter} prevBpm={prevBpm} onCommit={(v) => barlineActions.setBpmAfter(v)} />
        {patchAfterField}
        <div className="v2-field">
          <span className="v2-field-label">此线之后的排版</span>
          <div className="v2-grid">
            <button className={`v2-btn ${!barline.breakAfter ? 'is-on' : ''}`} onClick={() => barlineActions.setBreakAfter(undefined)}>自动</button>
            <button className={`v2-btn ${barline.breakAfter === 'line' ? 'is-on' : ''}`} onClick={() => barlineActions.setBreakAfter('line')}>换行</button>
            <button className={`v2-btn ${barline.breakAfter === 'page' ? 'is-on' : ''}`} onClick={() => barlineActions.setBreakAfter('page')}>分页</button>
          </div>
        </div>
        <div className="v2-grid v2-grid-5">
          <button className={`v2-btn ${barline.repeat === 'start' ? 'is-on' : ''}`} onClick={() => barlineActions.setRepeat('start')} title="把这条线改成反复开始 |:（再点一次取消）">|:</button>
          <button className={`v2-btn ${barline.repeat === 'end' ? 'is-on' : ''}`} onClick={() => barlineActions.setRepeat('end')} title="把这条线改成反复结束 :|（再点一次取消）">:|</button>
          <button className={`v2-btn ${barline.repeat === 'both' ? 'is-on' : ''}`} onClick={() => barlineActions.setRepeat('both')} title="双向反复 :||:——既是上一段的反复结束，又是下一段的反复开始（再点一次取消）">:||:</button>
          <span className="v2-field-label v2-inline-label">遍数</span>
          <select className="v2-grace-pick" value={barline.repeat === 'end' ? (barline.times ?? 2) : 2} disabled={barline.repeat !== 'end'} onChange={(e) => barlineActions.setRepeatTimes(Number(e.target.value))}>
            {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="v2-grace-bar">
          <span className="v2-field-label v2-inline-label">房子</span>
          {[1, 2, 3].map((n) => (
            <button key={n} className={`v2-btn ${(barline.volta ?? []).includes(n) ? 'is-on' : ''}`} onClick={() => barlineActions.setVolta(n)} title={`房子 [${n}] 的左墙设在这根线，向右自动延伸到 :| 或下一间房`}>[{n}]</button>
          ))}
          <button className={`v2-btn ${barline.style === 'double' ? 'is-on' : ''}`} onClick={() => barlineActions.toggleDouble()} title="双细线 ‖：乐段结束（再点一次变回普通小节线）">‖</button>
          <button className={`v2-btn ${barline.style === 'final' ? 'is-on' : ''}`} onClick={() => barlineActions.toggleFinal()} title="终止线 ||：细线+粗线，全曲结束（再点一次变回普通小节线）">||</button>
          {barline.volta ? (
            <button className={`v2-btn ${barline.voltaOpen ? 'is-on' : ''}`} title="手动强制右端开放（通常自动判断，点一下可覆盖）" onClick={() => barlineActions.toggleVoltaOpen()}>右端开放</button>
          ) : null}
        </div>
        <div className="v2-field">
          <span className="v2-field-label">跳转记号（挂在这条线后面）</span>
          <div className="v2-grid">
            {(
              [
                ['segno', '𝄋 起点', 'D.S. 的跳回目标（记号出现在反复起点）'],
                ['ds', 'D.S.', '唱到这里跳回 𝄋'],
                ['tocoda', 'To ⊕', 'D.S. 遍唱到这里，跳到 ⊕'],
                ['coda', '⊕', '结束句从这里开始'],
                ['fine', 'Fine', '到此结束（al Fine）'],
                ['dc', 'D.C.', '从头再唱一遍'],
              ] as [JumpMark, string, string][]
            ).map(([mark, label, tip]) => (
              <button key={mark} className={`v2-btn ${jumpAfter === mark ? 'is-on' : ''}`} title={tip} onClick={() => barlineActions.toggleJump(jumpAfter === mark ? null : mark)}>
                {mark === 'segno' ? <><span style={{ fontFamily: MUSIC_SYMBOL_FONT, fontSize: '1.2em', lineHeight: 1, verticalAlign: '-0.12em' }}>{SEGNO_SYMBOL}</span> 起点</> : label}
              </button>
            ))}
          </div>
        </div>
        {playOrder ? <p className="v2-hint">演奏顺序：<b>第 {playOrder.join(' → ')} 小节</b></p> : null}
        </>
        )}
        </>
      ) : (
      <>
        {!isRange &&
        OCTAVE_ROWS.map((row) => (
          <OctaveRow key={row.oct} row={row} actions={actions} litDegree={note?.degree} litOct={note?.octave} />
        ))}

        {/* 常驻排：批量选中时也一直在这——删除 / 连音线是选区操作，位置永不移动 */}
        <div className="v2-pad-tools">
          {/* 删除（Backspace 的等价按钮）：几何画的回退箭头，⌫ 字符不是每台机器都有 */}
          <button
            className="v2-btn"
            onClick={() => actions.del()}
            title="删除（键盘 Backspace）：批量选中时一次删光选区；否则替换模式下删当前音，插入模式下删光标左边的音"
            aria-label="删除"
          >
            <svg width={17} height={13} viewBox="0 0 24 18" aria-hidden="true">
              <path
                d="M8.5 1.5 H20.5 a1.8 1.8 0 0 1 1.8 1.8 v11.4 a1.8 1.8 0 0 1 -1.8 1.8 H8.5 L1.5 9 Z"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinejoin="round"
              />
              <path
                d="M11.5 6.2 l5.6 5.6 M17.1 6.2 l-5.6 5.6"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
              />
            </svg>
          </button>
          {/* 连音线：多选整段连 / 取消，单光标向右多连一个——选区下也有意义 */}
          <button
            className={`v2-btn${note?.ties?.some((t) => t.kind === 'slur') ? ' is-on' : ''}`}
            onClick={() => actions.slur()}
            title="连音线 ⌒：选了多个音就整段连 / 取消；单光标则向右多连一个音"
            aria-label="连音线"
          >
            <SlurGlyph />
          </button>
          {/* 升 / 降 8 度：多选时所有选中音一起移动，选区下同样有意义，所以常驻 */}
          <button
            className="v2-btn"
            onClick={() => actions.octave(1)}
            title="升 8 度 ↑8（快捷键 ~）：多选时所有选中音一起升，否则作用于光标左侧的音"
            aria-label="升 8 度"
          >
            <span className="v2-pad-octbtn">
              <span className="v2-pad-arrow">↑</span>8
            </span>
          </button>
          <button
            className="v2-btn"
            onClick={() => actions.octave(-1)}
            title="降 8 度 ↓8（快捷键 ·）：多选时所有选中音一起降，否则作用于光标左侧的音"
            aria-label="降 8 度"
          >
            <span className="v2-pad-octbtn">
              <span className="v2-pad-arrow">↓</span>8
            </span>
          </button>
        </div>

        {/* 输入排：批量选中时整排隐藏——这些按钮作用在光标处 / 单个音上，选区下没意义 */}
        {!isRange && (
        <div className="v2-pad-tools">
          <button className="v2-btn" onClick={() => actions.barline()} title="小节线 |（连按两次变终止线）">
            <BarlineGlyph kind="single" />
          </button>
          <button
            className="v2-btn"
            onClick={() => actions.barlineAs('repeat-start')}
            title="反复开始：粗线、细线、两点（光标左边那根小节线就地变成它）"
          >
            <BarlineGlyph kind="repeat-start" />
          </button>
          <button
            className="v2-btn"
            onClick={() => actions.barlineAs('repeat-end')}
            title="反复结束：两点、细线、粗线（默认 2 遍，遍数在这里上面那根线的面板里改）"
          >
            <BarlineGlyph kind="repeat-end" />
          </button>
          <button
            className="v2-btn"
            onClick={() => actions.barlineAs('repeat-both')}
            title="双向反复 :||:——既是上一段的反复结束，又是下一段的反复开始（光标左边那根小节线就地变成它）"
          >
            <BarlineGlyph kind="repeat-both" />
          </button>
          <button
            className="v2-btn"
            onClick={() => actions.barlineAs('double')}
            title="双细线 ‖：乐段结束（光标左边那根小节线就地变成它）"
          >
            <BarlineGlyph kind="double" />
          </button>
          <button
            className="v2-btn"
            onClick={() => actions.barlineAs('final')}
            title="终止线：细线、粗线（全曲结束；光标左边那根小节线就地变成它）"
          >
            <BarlineGlyph kind="final" />
          </button>
          <button className={`v2-btn${isRest ? ' is-on' : ''}`} onClick={() => actions.rest()} title="0 休止符">
            0
          </button>
          <button className={`v2-btn${isX ? ' is-on' : ''}`} onClick={() => actions.x()} title="X 无音高音符（打击 / 拍手 / 念节奏）：发声、无固定音高，时值与附点同音符">
            X
          </button>
          <button className={`v2-btn${(target?.dot ?? 0) > 0 ? ' is-on' : ''}`} onClick={() => actions.dot()} title="附点 .（目标音带附点时点亮）">
            {/* 文本「·」太细小，画成加粗的实心圆点 */}
            <svg width="15" height="18" viewBox="0 0 16 18" aria-hidden="true" style={{ display: 'block', margin: '0 auto' }}>
              <circle cx={8} cy={9} r={3.2} fill="currentColor" />
            </svg>
          </button>
          {/* 增时线 - 不给按钮：与时值排的 x− 系长音按钮重复（键盘 - 键仍可用） */}
          <button
            className="v2-btn"
            onClick={() => actions.breakLine()}
            title="换行 ↵（光标要落在小节线上；再按一次取消换行）"
            aria-label="换行"
          >
            ↵
          </button>
        </div>
        )}

        {!isRange && (
        <div className="v2-pad-tools">
          {/* 变音记号：按一次换一档，升 → 降 → 还原 → 无；目标音带变音时点亮并显示当前档 */}
          <button
            className={`v2-btn${note?.accidental ? ' is-on' : ''}`}
            onClick={() => actions.accidental()}
            title="变音记号循环：升 # → 降 b → 还原 ♮ → 无（跟随调号），对光标左侧的音"
            aria-label="变音记号循环"
          >
            {note?.accidental ?? <span style={{ fontSize: '0.85em' }}>#/b</span>}
          </button>
          <button className={`v2-btn${parenOpen ? ' is-on' : ''}`} onClick={() => actions.paren('open')} title="左括号（">
            （
          </button>
          <button className={`v2-btn${parenClose ? ' is-on' : ''}`} onClick={() => actions.paren('close')} title="右括号）">
            ）
          </button>
        </div>
        )}

        {/* 音值组合：仅批量选中时显示——单音 / 插入光标下它整排禁用，只会占地方。
            与下面的时值排互斥：选区看这里，单音看时值排 */}
        {isRange && (
        <div className="v2-pad-row">
          <span className="v2-field-label">音值组合（选中 2-8 个音）</span>
          <div className="v2-pad-tools">
            {groups.map((g) => (
              <button
                key={g.label}
                className="v2-btn"
                disabled={!g.ok}
                onClick={() => actions.group(g.ticks)}
                title={
                  selectedCount < 2
                    ? '音值组合：先选中 2-8 个音'
                    : g.ok
                      ? `音值组合：选中的 ${selectedCount} 个音合起来凑 ${g.label}`
                      : `${selectedCount} 个音凑不出 ${g.label}（最细分到 1/8 拍）`
                }
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
        )}

        {/* 常用组合候选：点了目标拍数就地展开（与属性面板同一份 pending、
            同一条写回路径） */}
        {pending ? (
          <div className="v2-pad-row v2-pad-pending">
            <span className="v2-field-label">选择划分（{pending.count} 个音）</span>
            <div className="v2-pad-cands">
              {pending.cands.map((c, i) => {
                const g = candidateGlyph(c, pending.ticks);
                return (
                  <button key={i} className="v2-btn" title={c.label} onClick={() => actions.applyGroup(c)}>
                    <GroupGlyph degrees={pending.degrees} beams={g.beams} tuplet={c.tuplet} dots={g.dots} dashes={g.dashes} />
                  </button>
                );
              })}
            </div>
            <div className="v2-pad-tools">
              <button className="v2-btn" onClick={() => actions.openCustomGroup()}>
                自定义组合…
              </button>
              <button className="v2-btn" onClick={() => actions.cancelGroup()}>
                取消
              </button>
            </div>
          </div>
        ) : null}

        {/* 时值排：单音 / 插入光标时显示；批量选中时隐藏——整段改时值走音值组合排
            （档位受拍号连通单位约束，时值排的 2 拍以上长音对选区无意义） */}
        {!isRange && (
        <div className="v2-pad-row">
          <span className="v2-field-label">时值（所选音符）</span>
          <div className="v2-grid v2-grid-4">
            {dur.map((t) => (
              <button
                key={t.label}
                className={`v2-btn${target && target.ticks === t.ticks ? ' is-on' : ''}`}
                onClick={() => actions.duration(t.ticks)}
                title={t.label}
                aria-label={t.label}
              >
                {/* 画成谱面上的样子：增时线 / 附点 / 减时线，不写「1/4 拍」让人换算 */}
                <DurationGlyph degree={SAMPLE_DEGREE} ticks={t.ticks} />
              </button>
            ))}
          </div>
        </div>
        )}

        {/* 极少用的两排压在最底下：高高音（上方两点）、低低音（下方两点） */}
        {!isRange &&
        EXTREME_ROWS.map((row) => (
          <OctaveRow key={row.oct} row={row} actions={actions} litDegree={note?.degree} litOct={note?.octave} />
        ))}

        {note ? (
          // key 挂 note.id：换选一个音就重挂载并自动展开——选中即展开，
          // 不用再点一次；展开后仍可手动收起，收起状态保持到下一次换选
          <details key={`sec-${note.id}`} className="v2-pad-sec" open>
            <summary>技法 · 倚音 · 力度 · 记号（作用于选中的音）</summary>
            {/* 变音记号不在这里：前面工具排的 # 按钮就是它（循环切换），避免重复 */}
            <GraceField key={`p-${note.id}`} score={score} setScore={onSetScore} note={note} />
            <KeyChangeField score={score} setScore={onSetScore} note={note} />
            <TechniqueField key={`t-${note.id}`} score={score} setScore={onSetScore} note={note} />
            <DynamicsField score={score} setScore={onSetScore} note={note} />
            <AnnotationField score={score} note={note} onApply={(next, shift) => onAnnotate(next, shift)} />
          </details>
        ) : null}
        {batchIds.length >= 2 ? (
          <details key={`sel-${batchIds.join(',')}`} className="v2-pad-sec" open>
            <summary>选区操作（{batchIds.length} 个音）</summary>
            <div className="v2-field">
              <span className="v2-field-label">跳房子（选中完整小节）</span>
              <div className="v2-grid">
                {[1, 2, 3].map((nv) => (
                  <button key={nv} className="v2-btn" disabled={!volta.ok} onClick={() => doSelectionVolta(nv)}
                    title="选区头前那根线挂上房子（左墙），选区尾的小节线自动变成 :|">[{nv}]</button>
                ))}
              </div>
              <p className="v2-hint">
                {volta.error ?? '整段小节一次跨进房子；再加第二间房时选中它的完整小节点 [2]，旧 :| 会自动并进同一段。'}
              </p>
            </div>
            <GrayField score={score} setScore={onSetScore} ids={batchIds} />
            <HairpinField score={score} setScore={onSetScore} ids={batchIds} />
          </details>
        ) : null}
      </>
      )}
    </div>
  );
}
