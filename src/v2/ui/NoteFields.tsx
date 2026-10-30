/**
 * 音符属性字段组件：右侧属性检查器与浮动输入板**共用同一份实现**——
 * 两边只差摆放位置，不差行为。以前检查器把这些 JSX 内联在 EditorApp 里，
 * 浮动板想补同类功能只能复制一份，迟早漂移（用户 0.2.166 起要求合并两面板）。
 *
 * 每个组件自管自己的临时状态（倚音录入的勾选格、文本框草稿），
 * 状态跟着 note.id 走：调用方用 key={note.id} 挂载，换音自动复位。
 * 都吃 (score, setScore) —— 与检查器同一套写谱入口，撤销历史天然一致。
 */

import { useRef, useState } from 'react';
import {
  annotationTextOf,
  dropGrace,
  moveGrace,
  setAccidental,
  setFermata,
  setFingering,
  setGrace,
  setGraceSlot as setGraceSlotOp,
  setGray,
  setHairpinRange,
  setKeyChange,
  setNoteDynamic,
  setNoteMark,
  setOctavaRange,
  setArpeggio,
  setTremolo,
  setTrillRange,
  setTongue,
  setTextAnnotation,
  toggleArticulation,
  toggleTechnique,
  type GracePos,
} from '../edit';
import type { Accidental, Degree, GraceNote, NoteEvent, Score } from '../types';
import { ACCIDENTAL_GLYPH, TECHNIQUE_GLYPH, TECHNIQUE_PATHS, TECHNIQUE_PATH_SCALE } from '../paint';
import { NotationGlyph } from './NotationGlyph';

/** 变音记号按钮：本位（无记号）在前，升方向 → 降方向 → 还原（GB/T 46845—2025 §6.2.5.1 五种） */
export const ACCIDENTAL_CHOICES: (Accidental | undefined)[] = [undefined, '#', 'x', 'b', 'bb', '♮'];
export const ACCIDENTAL_NAME: Record<Accidental, string> = {
  '#': '升',
  x: '重升',
  b: '降',
  bb: '重降',
  '♮': '还原',
};

/** 力度档位，由弱到强 */
export const DYNAMICS = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];

/** 转调下拉的常用调（五度圈 15 个，含升降） */
export const KEY_CHOICES = [
  '1=C', '1=#C', '1=bD', '1=D', '1=#D', '1=bE', '1=E',
  '1=F', '1=#F', '1=bG', '1=G', '1=#G', '1=bA', '1=A', '1=#A', '1=bB', '1=B',
];

/** 倚音键：一个八度内的 12 个键（7 音级 + 升号变音） */
const GRACE_KEYS: { degree: Degree; accidental?: Accidental }[] = [
  { degree: 1 },
  { degree: 1, accidental: '#' },
  { degree: 2 },
  { degree: 2, accidental: '#' },
  { degree: 3 },
  { degree: 4 },
  { degree: 4, accidental: '#' },
  { degree: 5 },
  { degree: 5, accidental: '#' },
  { degree: 6 },
  { degree: 6, accidental: '#' },
  { degree: 7 },
];

/** 倚音输入框的三排：上=高八度、中=正常、下=低八度 */
const GRACE_ROWS: { octave: number; name: string }[] = [
  { octave: 1, name: '高八度' },
  { octave: 0, name: '正常' },
  { octave: -1, name: '低八度' },
];

const GRACE_COUNT = 3;
const GRACE_SLOTS = Array.from({ length: GRACE_COUNT }, (_, i) => i);

export interface FieldProps {
  score: Score;
  setScore: (s: Score) => void;
  note: NoteEvent;
}

/** 变音记号：本位 / 升 / 降 / 还原 四档直选（当前档点亮） */
export function AccidentalField({ score, setScore, note }: FieldProps) {
  return (
    <div className="v2-field">
      <span className="v2-field-label">
        变音记号
        {note.accidental ? `，当前 ${ACCIDENTAL_NAME[note.accidental]}` : '（跟随调号）'}
      </span>
      <div className="v2-grid v2-grid-4">
        {ACCIDENTAL_CHOICES.map((a) => (
          <button
            key={a ?? 'none'}
            className={note.accidental === a ? 'v2-btn is-on' : 'v2-btn'}
            onClick={() => setScore(setAccidental(score, note.id, a))}
            title={a ? `${ACCIDENTAL_NAME[a]}半音` : '去掉记号，跟随调号'}
          >
            {a ? ACCIDENTAL_GLYPH[a] : '本位'}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 转调：演奏到此音起，后面的音都改用这个调（下拉选常用调，第一项清除） */
export function KeyChangeField({ score, setScore, note }: FieldProps) {
  return (
    <div className="v2-field">
      <span className="v2-field-label">转调（演奏到此音起改用新调，选第一项清除）</span>
      <select
        className="v2-meta-input"
        value={note.keyChange ?? ''}
        onChange={(e) => setScore(setKeyChange(score, note.id, e.target.value || undefined))}
      >
        <option value="">（不转调）</option>
        {KEY_CHOICES.map((k) => (
          <option key={k} value={k}>
            转{k}
          </option>
        ))}
        {note.keyChange && !KEY_CHOICES.includes(note.keyChange) ? (
          <option value={note.keyChange}>转{note.keyChange}</option>
        ) : null}
      </select>
    </div>
  );
}

/**
 * 指法（GB/T 46845—2025 §7.11.5）：音符正下方的小字数字 0-5，
 * 0 = 空弦 / 不按。电吹管玩家用它标按键指法。
 */
export function FingeringField({ score, setScore, note }: FieldProps) {
  return (
    <div className="v2-field">
      <span className="v2-field-label">指法（音符下方小字）</span>
      <div className="v2-grace-bar">
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className={note.fingering === String(n) ? 'v2-btn is-on' : 'v2-btn'}
            onClick={() =>
              setScore(setFingering(score, note.id, note.fingering === String(n) ? undefined : String(n)))
            }
            title={n === 0 ? '空弦 / 不按（0）' : `指法 ${n}（再点一次去掉）`}
          >
            {n}
          </button>
        ))}
        <button
          className={note.fingering ? 'v2-btn' : 'v2-btn is-on'}
          onClick={() => setScore(setFingering(score, note.id))}
          title="不标指法"
        >
          无
        </button>
      </div>
    </div>
  );
}

/**
 * 气息与技法 + 自定义记号。同一类内互斥：一个音同时只有一种技法、
 * 一种吐音（T 与 K 也互斥）；符号在音符上方横向排列。
 * 琶音 / 震音（GB/T 46845—2025 §7.7 / §7.8）也是音符记号，同区摆放：
 * 琶音是开关；震音一颗按钮循环 无→1→2→3 条斜线（按一次加一条）。
 */
export function TechniqueField({ score, setScore, note }: FieldProps) {
  const markInputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="v2-field">
      <span className="v2-field-label">气息与技法（标在音符上方）</span>
      <div className="v2-grid v2-grid-4">
        <button
          className={`v2-btn v2-btn-breath ${(note.techniques ?? []).includes('breath') ? 'is-on' : ''}`}
          onClick={() => setScore(toggleTechnique(score, note.id, 'breath'))}
          title="换气，谱面标作 V"
        >
          换气 V
        </button>
        <button
          className={`v2-btn v2-btn-breath ${note.tongue === 'T' ? 'is-on' : ''}`}
          onClick={() => setScore(setTongue(score, note.id, note.tongue === 'T' ? undefined : 'T'))}
          title="单吐"
        >
          单吐 T
        </button>
        <button
          className={`v2-btn v2-btn-breath ${note.tongue === 'K' ? 'is-on' : ''}`}
          onClick={() => setScore(setTongue(score, note.id, note.tongue === 'K' ? undefined : 'K'))}
          title="双吐的第二音"
        >
          双吐 K
        </button>
        <button
          className={`v2-btn v2-btn-breath ${(note.articulations ?? []).includes('staccato') ? 'is-on' : ''}`}
          onClick={() => setScore(toggleArticulation(score, note.id, 'staccato'))}
          title="断音 / 顿音，谱面标作小圆点"
        >
          断音 ·
        </button>
        <button
          className={note.fermata ? 'v2-btn is-on' : 'v2-btn'}
          onClick={() => setScore(setFermata(score, note.id))}
          title="延音，谱面标作 ⌒ 加点"
        >
          <span className="v2-ferm-glyph" aria-hidden>
            <i>⌒</i>
            <i>·</i>
          </span>
          延音
        </button>
        <button
          className={note.arpeggio ? 'v2-btn is-on' : 'v2-btn'}
          onClick={() => setScore(setArpeggio(score, note.id))}
          title="琶音：音符右侧画波状竖线（GB/T 46845—2025 §7.7；再点一次去掉）"
        >
          琶音 ≈
        </button>
        <button
          className={note.tremolo ? 'v2-btn is-on' : 'v2-btn'}
          onClick={() =>
            setScore(setTremolo(score, note.id, note.tremolo === 3 ? undefined : (((note.tremolo ?? 0) + 1) as 1 | 2 | 3)))
          }
          title={
            note.tremolo
              ? `震音 ${note.tremolo} 条斜线：播放时把该音均分成 ${2 ** note.tremolo} 份快速重复；再点一次加一条，3 条后回无（GB/T 46845—2025 §7.8）`
              : '震音：按一次加一条斜线（1 → 2 → 3 → 无 循环）；播放把该音均分成 2^n 份快速重复（GB/T 46845—2025 §7.8）'
          }
        >
          震音
          {/* 三条斜线的小图标（震音记号的样子），当前条数点亮、其余变淡 */}
          <svg width="17" height="13" viewBox="0 0 17 13" aria-hidden style={{ marginLeft: 4, verticalAlign: '-2px' }}>
            {[0, 1, 2].map((i) => (
              <line
                key={i}
                x1={2.5 + i * 4.5}
                y1="11.5"
                x2={6.5 + i * 4.5}
                y2="1.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                opacity={i < (note.tremolo ?? 0) ? 1 : 0.25}
              />
            ))}
          </svg>
        </button>
        {Object.entries(TECHNIQUE_GLYPH)
          .filter(([value]) => value !== 'breath')
          .map(([value, g]) => (
            <button
              key={value}
              className={(note.techniques ?? []).includes(value) ? 'v2-btn is-on' : 'v2-btn'}
              onClick={() => setScore(toggleTechnique(score, note.id, value))}
              title={g.path ? `${g.label}，谱面使用与此图标一致的记号` : `${g.label}，谱面标作 ${g.mark}`}
            >
              {g.path ? (
                <svg
                  width={20 * TECHNIQUE_PATH_SCALE[g.path]}
                  height={18 * TECHNIQUE_PATH_SCALE[g.path]}
                  viewBox="-10 -9 20 18"
                  aria-hidden="true"
                  style={{ verticalAlign: 'middle', marginRight: 4 }}
                >
                  <path
                    d={TECHNIQUE_PATHS[g.path].d}
                    transform={TECHNIQUE_PATHS[g.path].flip ? 'scale(1 -1)' : undefined}
                    fill={TECHNIQUE_PATHS[g.path].fill ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth={TECHNIQUE_PATHS[g.path].strokeWidth}
                    strokeLinejoin={TECHNIQUE_PATHS[g.path].fill ? 'round' : 'miter'}
                    strokeLinecap={TECHNIQUE_PATHS[g.path].fill ? 'round' : 'butt'}
                  />
                </svg>
              ) : (
                <span className="v2-mark-prefix" aria-hidden>{g.mark}</span>
              )}
              {g.label}
            </button>
          ))}
      </div>
      {/*
        自定义记号：最多 3 个汉字 / 符号，原样标在音符上方（跟在技法后面）。
        **非受控**输入框（defaultValue + key=note.id）：React 全程不碰 DOM value——
        受控值一改（哪怕是 slice 截断）就会中止中文组曲、把未转换的拼音原样提交。
        写谱只在回车 / 失焦 / 按 ✓ 时发生。
      */}
      <div className="v2-grace-bar v2-mark-bar" style={{ marginTop: 6 }}>
        <input
          key={note.id}
          ref={markInputRef}
          className="v2-meta-input"
          defaultValue={note.mark ?? ''}
          placeholder="自定义记号（≤3 字，如：气、滑、花）"
          title="最多 3 个汉字或符号，原样写在音符上方。清空 = 去掉。回车、点别处或按 ✓ 生效"
          onBlur={(e) => {
            setScore(setNoteMark(score, note.id, e.currentTarget.value.slice(0, 3)));
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            setScore(setNoteMark(score, note.id, e.currentTarget.value.slice(0, 3)));
            markInputRef.current?.blur();
          }}
        />
        <button
          className="v2-btn v2-btn-breath"
          title="确认，写进谱面"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            setScore(setNoteMark(score, note.id, (markInputRef.current?.value ?? '').slice(0, 3)))
          }
        >
          ✓
        </button>
      </div>
    </div>
  );
}

/**
 * 倚音：不占时值，挂在主音上。1 颗 = 单倚音，2 颗以上 = 复倚音。
 * 录制顺序按谱面念法：勾前 / 后（互斥）→ 点格子 → 在下面的小键盘上点音符。
 * 播放时前倚音吃主音开头、后倚音吃结尾，各切 1/4 拍。
 * 录入状态（勾哪侧 / 开哪格）是组件内部状态，跟着 note.id 走。
 */
export function GraceField({ score, setScore, note }: FieldProps) {
  const [side, setSide] = useState<GracePos | null>(() => {
    const hasBefore = (note.graceBefore?.length ?? 0) > 0;
    const hasAfter = (note.graceAfter?.length ?? 0) > 0;
    return hasAfter && !hasBefore ? 'after' : 'before';
  });
  const [slot, setSlot] = useState<number | null>(null);

  /** 三格里显示的那一组（跟着勾选框走；都没勾就是空的） */
  const list: GraceNote[] = side === 'after' ? note.graceAfter ?? [] : side === 'before' ? note.graceBefore ?? [] : [];

  /** 点前 / 后勾选框：再点已勾的 = 清掉这一侧；换侧时把当前组搬过去（目标侧空才搬） */
  const pickSide = (s: GracePos) => {
    if (side === s) {
      setScore(setGrace(score, note.id, s, undefined));
      setSide(null);
      setSlot(null);
      return;
    }
    const other: GracePos = s === 'before' ? 'after' : 'before';
    const target = (s === 'before' ? note.graceBefore : note.graceAfter) ?? [];
    const moving = (other === 'before' ? note.graceBefore : note.graceAfter) ?? [];
    if (target.length === 0 && moving.length > 0) {
      setScore(moveGrace(score, note.id, other, s));
    }
    setSide(s);
  };

  const put = (octave: number, key: { degree: Degree; accidental?: Accidental }) => {
    if (slot === null) return;
    setScore(setGraceSlotOp(score, note.id, side ?? 'before', slot, { degree: key.degree, octave, accidental: key.accidental }));
    setSlot(slot >= GRACE_COUNT - 1 ? null : slot + 1);
  };

  return (
    <div className="v2-field">
      <span className="v2-field-label">倚音（不占时值，最多 3 颗）</span>
      <div className="v2-grace-bar">
        <label className="v2-grace-check" title="勾上 = 这三格是前倚音">
          <input type="checkbox" checked={side === 'before'} onChange={() => pickSide('before')} />
          前
        </label>
        {GRACE_SLOTS.map((i) => {
          const g = list[i];
          return (
            <button
              key={i}
              className={`v2-grace-slot ${g ? 'is-filled' : ''} ${slot === i ? 'is-open' : ''}`}
              title={g ? '点击修改这一颗' : '点击输入这一颗'}
              onClick={() => {
                if (side === null) setSide('before');
                setSlot(slot === i ? null : i);
              }}
            >
              {g ? <NotationGlyph degree={g.degree} dots={g.octave} accidental={g.accidental} /> : null}
            </button>
          );
        })}
        <label className="v2-grace-check" title="勾上 = 这三格是后倚音">
          <input type="checkbox" checked={side === 'after'} onChange={() => pickSide('after')} />
          后
        </label>
        <button
          className="v2-btn"
          disabled={list.length === 0}
          title="删除这个音上的全部倚音（前后两侧都清）"
          onClick={() => {
            // 两侧都要清：必须在同一份 score 基础上链式算好再一次性 setScore，
            // 连发两次 setScore(同一份旧 score) 会互相覆盖（后一次赢）
            let s = setGrace(score, note.id, 'before', undefined);
            s = setGrace(s, note.id, 'after', undefined);
            setScore(s);
            setSide('before');
            setSlot(null);
          }}
        >
          清除
        </button>
      </div>
      {slot !== null ? (
        <div className="v2-grace-picker">
          {GRACE_ROWS.map((row) => (
            <div key={row.name} className="v2-grace-row" title={row.name}>
              {GRACE_KEYS.map((key) => (
                <button
                  key={`${row.octave}-${key.degree}-${key.accidental ?? ''}`}
                  className={`v2-btn v2-grace-key${key.accidental ? ' is-acc' : ''}`}
                  title={key.accidental ? `${key.accidental}${key.degree}（变音键）` : undefined}
                  onClick={() => put(row.octave, key)}
                >
                  <NotationGlyph degree={key.degree} dots={row.octave} accidental={key.accidental} />
                </button>
              ))}
            </div>
          ))}
          <div className="v2-grace-foot">
            <span className="v2-hint">正在输入第 {slot + 1} 格</span>
            <span className="v2-grace-foot-btns">
              {list[slot] ? (
                <button
                  className="v2-btn"
                  onClick={() => setScore(setGraceSlotOp(score, note.id, side ?? 'before', slot, null))}
                >
                  清空本格
                </button>
              ) : null}
              {side && list.length > 0 ? (
                <button
                  className="v2-btn"
                  title="把这几颗倚音还原成普通音符（各 1 拍）"
                  onClick={() => setScore(dropGrace(score, note.id, side))}
                >
                  还原成音符
                </button>
              ) : null}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 力度跟音符绑定（画在音符下方）：按钮即开关，点亮的再点一次就去掉 */
export function DynamicsField({ score, setScore, note }: FieldProps) {
  return (
    <div className="v2-field">
      <span className="v2-field-label">力度（标在音符下方）</span>
      <div className="v2-grid v2-grid-4">
        {DYNAMICS.map((v) => (
          <button
            key={v}
            className={note.dynamic === v ? 'v2-btn is-on' : 'v2-btn'}
            onClick={() => setScore(setNoteDynamic(score, note.id, v))}
            title={note.dynamic === v ? '再点一次去掉' : `标 ${v}`}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 段落文字标注（谱面显示为 (文字)）。草稿式输入：回车 / 点别处 / 按 ✓ 才提交。
 * onApply(nextScore, cursorShift)：插入 / 删除 directive 会改变它后面所有事件的
 * 下标，光标必须跟着挪（否则焦点落到标注自己身上，输入框当场卸载、中文输入法
 * 被打断）——两边的面板各自用自己的 commit 口径接住这个位移。
 */
export function AnnotationField({
  score,
  note,
  onApply,
}: {
  score: Score;
  note: NoteEvent;
  onApply: (next: Score, cursorShift: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string) => {
    const next = setTextAnnotation(score, note.id, text);
    if (next === score) return;
    onApply(next, next.events.length - score.events.length);
  };
  return (
    <div className="v2-field">
      <span className="v2-field-label">标注（段落文字）</span>
      <div className="v2-grace-bar v2-mark-bar">
        <input
          className="v2-meta-input"
          value={draft ?? annotationTextOf(score, note.id)}
          placeholder="如：前奏（与下面的括号互不影响）"
          title="段落文字标注（谱面显示为 (文字)）。左右括号是独立的一对按钮，在这里打字不会动括号、点括号也不会动文字。回车、点别处或按 ✓ 提交"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft === null) return;
            commit(draft);
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            commit(draft ?? '');
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }}
        />
        <button
          className="v2-btn v2-btn-breath"
          title="确认，写进谱面"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            commit(draft ?? annotationTextOf(score, note.id));
            setDraft(null);
          }}
        >
          ✓
        </button>
      </div>
    </div>
  );
}

/** 选区：跨音力度范围（渐强 / 渐弱，首音至末音） */
export function HairpinField({ score, setScore, ids }: { score: Score; setScore: (s: Score) => void; ids: string[] }) {
  const noteCount = ids.filter((id) => score.events.find((e) => e.id === id)?.kind === 'note').length;
  return (
    <div className="v2-field">
      <span className="v2-field-label">跨音力度范围（首音至末音）</span>
      <div className="v2-grid">
        <button className="v2-btn" disabled={noteCount < 2} onClick={() => setScore(setHairpinRange(score, ids, 'cresc'))}>
          渐强
        </button>
        <button className="v2-btn" disabled={noteCount < 2} onClick={() => setScore(setHairpinRange(score, ids, 'dim'))}>
          渐弱
        </button>
        <button className="v2-btn" onClick={() => setScore(setHairpinRange(score, ids))}>
          清除范围
        </button>
      </div>
    </div>
  );
}

/** 选区：高低八度演奏段（8va / 8vb，首音至末音整体升降八度，GB/T 46845—2025 §6.2.6）。
 * 循环三态（与小节反复号同一惯例）：无 → 8va/8vb → con 8（八度重复）→ 取消 */
export function OctavaField({ score, setScore, ids }: { score: Score; setScore: (s: Score) => void; ids: string[] }) {
  const set = new Set(ids);
  const notes = score.events.filter((e) => e.kind === 'note' && set.has(e.id)) as NoteEvent[];
  const lit = notes[0]?.octava ?? null;
  return (
    <div className="v2-field">
      <span className="v2-field-label">高低八度演奏段（首音至末音）</span>
      <div className="v2-grid">
        <button
          className={`v2-btn${lit === 'va' || lit === 'con-va' ? ' is-on' : ''}`}
          disabled={notes.length < 2}
          onClick={() =>
            setScore(setOctavaRange(score, ids, lit === 'va' ? 'con-va' : lit === 'con-va' ? undefined : 'va'))
          }
          title="第 1 次整体升八度（8va + 虚线）；第 2 次高八度重复（斜体 con 8 + 虚线，原声与高八度同响）；第 3 次取消（GB/T 46845—2025 §6.2.6；需要 @format 3，会自动升级）"
        >
          {lit === 'con-va' ? 'con 8 ↑' : '8va ↑'}
        </button>
        <button
          className={`v2-btn${lit === 'vb' || lit === 'con-vb' ? ' is-on' : ''}`}
          disabled={notes.length < 2}
          onClick={() =>
            setScore(setOctavaRange(score, ids, lit === 'vb' ? 'con-vb' : lit === 'con-vb' ? undefined : 'vb'))
          }
          title="第 1 次整体降八度（8vb + 虚线）；第 2 次低八度重复（斜体 con 8 + 虚线，原声与低八度同响）；第 3 次取消"
        >
          {lit === 'con-vb' ? 'con 8 ↓' : '8vb ↓'}
        </button>
        <button
          className="v2-btn"
          onClick={() => setScore(setOctavaRange(score, ids))}
          title="去掉选中段落的高 / 低八度演奏段"
        >
          清除
        </button>
      </div>
    </div>
  );
}

/** 选区：颤音 tr——tr 标在首音上，波浪线连续拉到末音尾部（GB/T 46845—2025 §7.5.3） */
export function TrillField({ score, setScore, ids }: { score: Score; setScore: (s: Score) => void; ids: string[] }) {
  const set = new Set(ids);
  const notes = score.events.filter((e) => e.kind === 'note' && set.has(e.id)) as NoteEvent[];
  const applied = (notes[0]?.techniques ?? []).includes('trill') && notes[notes.length - 1]?.trillEnd === true;
  return (
    <div className="v2-field">
      <span className="v2-field-label">颤音 tr（首音至末音）</span>
      <div className="v2-grid">
        <button
          className={`v2-btn${applied ? ' is-on' : ''}`}
          disabled={notes.length < 2}
          onClick={() => setScore(setTrillRange(score, ids))}
          title="tr 标在第一个音上，波浪线从 tr 右侧连续拉到最后一个音的尾部（GB/T 46845—2025 §7.5.3）；再点一次整段取消"
        >
          tr ﹏﹏﹏
        </button>
      </div>
    </div>
  );
}

/** 选区：批量灰显 / 复原（前奏间奏提示，播放不受影响） */
export function GrayField({ score, setScore, ids }: { score: Score; setScore: (s: Score) => void; ids: string[] }) {
  return (
    <div className="v2-field">
      <span className="v2-field-label">灰显（前奏 / 间奏提示）</span>
      <div className="v2-grid">
        <button
          className="v2-btn"
          disabled={ids.length === 0}
          onClick={() => setScore(setGray(score, ids, true))}
          title="把选中的音符 / 休止画成灰色：提示这段是前奏或间奏，不用吹奏（播放不受影响）"
        >
          灰显
        </button>
        <button
          className="v2-btn"
          disabled={ids.length === 0}
          onClick={() => setScore(setGray(score, ids, false))}
          title="把选中的音符 / 休止恢复为正常颜色"
        >
          复原
        </button>
      </div>
    </div>
  );
}
