import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyTier,
  applyTier as applyTierOp,
  autoGroupBeats,
  cycleDot,
  extendSlurRight,
  groupCandidates,
  groupTierOptions,
  insertBarline,
  insertMultibarRest,
  insertNote,
  insertRest,
  prevTimed,
  pressBarline,
  pressRepeatBar,
  removeEvent,
  setBarlineRepeat,
  setBarlineStyle,
  setBarNotation,
  cycleAccidentalAt,
  setDegree,
  setOctave,
  setTicks,
  shiftOctave,
  shiftOctaveMany,
  toggleParen,
  toggleSlur,
  pasteEvents,
  type TierCandidate,
} from '../edit';
import { beatsPerMeasure, meterAt } from '../meter';
import { TICKS_PER_BEAT, durationTiers } from '../ticks';
import { serializeDsl } from '../dsl';
import { buildTimeline } from '../timeline';
import { BeatClock } from '../clock';
import { ScoreCanvas, type ScorePick } from './ScoreCanvas';
import { PadBody, type PadActions, type PadPending } from './PadBody';
import { CustomGroupDialog } from './CustomGroupDialog';
import type { BarlineEvent, BeatGroup, CueStaff, Degree, Event, NoteEvent, RestEvent, Score } from '../types';
import { ExpClose } from './ExpClose';

/**
 * 小字谱录入窗口：选中主谱一个音符后打开，从这颗音起同时奏响。
 *
 * **所见即所得**（0.4.43）：不是文本框拼记号，而是复用编辑区的两大件——
 * 上半 `ScoreCanvas` 实时渲染草稿谱（可点击选中音符），下半 `PadBody`
 * 输入板（音级键盘 / 时值 / 附点 / 减时线 / 连线 / 小节线，与简谱编辑区
 * 完全同款）。所有按钮动作作用于一份独立的草稿 Score（edit.ts 纯函数），
 * 「确定插入主谱」时序列化成 jps 文本连同事件一起存回主谱的 cues。
 */
const CUE_FONT_SCALE = 0.62;

interface Props {
  score: Score;
  /** 锚定音符 id（主谱第一声部），从这颗音起同时奏响 */
  anchorId: string;
  /** 锚定位置的显示文字（如「第 3 小节 · 音 5」） */
  anchorLabel: string;
  /** 该锚已有的小字谱 = 编辑模式（可删除）；缺省 = 新建 */
  existing?: CueStaff;
  /** 编辑 OCR 产物（@小谱 2-3 这种小节范围文本锚）时保留原锚，不改写成音符锚 */
  preserveTextAnchor?: boolean;
  /** 主谱 Ctrl+C 复制的选区事件（与主谱 Ctrl+V 共用同一份剪贴板） */
  clip: Event[];
  clipGroups: BeatGroup[];
  dark?: boolean;
  onSave: (cue: CueStaff) => void;
  onDelete?: () => void;
  onClose: () => void;
}

interface DraftSnap {
  score: Score;
  cursor: number;
  anchor: number | null;
  mode: 'over' | 'insert';
}

/** 草稿谱：meta 跟主谱（拍号/速度/音色），标题清空；事件是独立副本 */
function makeDraft(score: Score, existing?: CueStaff): Score {
  const events: Event[] = existing?.events ? [...existing.events] : [];
  const groups = existing?.groups ? [...existing.groups] : [];
  return {
    version: 2,
    meta: { ...score.meta, title: '', sub: '', notes: [] },
    events,
    groups,
  };
}

export function CueDialog({ score, anchorId, anchorLabel, existing, preserveTextAnchor, clip, clipGroups, dark = false, onSave, onDelete, onClose }: Props) {
  const [snap, setSnap] = useState<DraftSnap>(() => ({
    score: makeDraft(score, existing),
    cursor: existing?.events?.length ?? 0,
    anchor: null,
    mode: 'insert',
  }));
  const [pending, setPending] = useState<{ ids: string[]; ticks: number; cands: TierCandidate[] } | null>(null);
  const [customGroupOpen, setCustomGroupOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const clockRef = useRef<BeatClock>(new BeatClock(90));

  const commit = (patch: Partial<DraftSnap>): void => {
    setSnap((s) => {
      const next = { ...s, ...patch, rev: 0 };
      // 与主编辑器一致：谱面变了重推拍内组
      if (patch.score) {
        const regrouped = autoGroupBeats(patch.score);
        return { ...next, score: regrouped };
      }
      return next;
    });
  };
  const setScoreInPlace = (next: Score): void => commit({ score: next });

  const draft = snap.score;
  const overEvent = snap.mode === 'over' && snap.anchor === null && snap.cursor > 0
    ? draft.events[snap.cursor - 1]
    : undefined;
  const overId = overEvent && (overEvent.kind === 'note' || overEvent.kind === 'rest') ? overEvent.id : undefined;
  const overBarline = overEvent && overEvent.kind === 'barline' ? (overEvent as BarlineEvent) : null;
  const range = snap.anchor !== null
    ? { lo: Math.min(snap.anchor, snap.cursor), hi: Math.max(snap.anchor, snap.cursor) }
    : null;
  const selectedTimedIds = range
    ? draft.events.slice(range.lo, range.hi).filter((e) => e.kind === 'note' || e.kind === 'rest').map((e) => e.id)
    : overId
      ? [overId]
      : [];
  const selectedIds = useMemo(() => {
    const ids = range
      ? draft.events.slice(range.lo, range.hi).map((e) => e.id)
      : overEvent
        ? [overEvent.id]
        : [];
    return new Set(ids);
  }, [range?.lo, range?.hi, draft.events, overEvent]);

  const padLeftId = (): string | null => {
    const i = prevTimed(draft, snap.cursor);
    return i >= 0 ? draft.events[i].id : null;
  };

  const padActions = useMemo<PadActions>(() => ({
    note: (d, oct) => {
      if (d === 0) {
        if (overId) setScoreInPlace(setDegree(draft, overId, 0));
        else commit({ score: insertRest(draft, snap.cursor), cursor: snap.cursor + 1, anchor: null, mode: 'insert' });
        return;
      }
      if (overId) {
        setScoreInPlace(setOctave(setDegree(draft, overId, d), overId, oct));
        return;
      }
      commit({
        score: insertNote(draft, snap.cursor, d as Degree, oct),
        cursor: snap.cursor + 1,
        anchor: null,
        mode: 'insert',
      });
    },
    rest: () => {
      if (overId) setScoreInPlace(setDegree(draft, overId, 0));
      else commit({ score: insertRest(draft, snap.cursor), cursor: snap.cursor + 1, anchor: null, mode: 'insert' });
    },
    x: () => {
      commit({ score: insertRest(draft, snap.cursor, true), cursor: snap.cursor + 1, anchor: null, mode: 'insert' });
    },
    repeatBar: () => {
      const r = pressRepeatBar(draft, snap.cursor);
      if (!r) {
        setMsg('小节反复要在小节线之后按：先按 | 再按 𝄍');
        return;
      }
      commit({ score: r.score, cursor: r.cursor, anchor: null, mode: 'insert' });
    },
    multibarRest: (n) => {
      commit({ score: insertMultibarRest(draft, snap.cursor, n), cursor: snap.cursor + 2 * n - 1, anchor: null, mode: 'insert' });
    },
    barline: () => {
      const r = pressBarline(draft, snap.cursor);
      commit({ score: r.score, cursor: r.cursor, anchor: null, mode: 'insert' });
    },
    barlineAs: (kind) => {
      const left = snap.cursor > 0 ? draft.events[snap.cursor - 1] : undefined;
      const target = overBarline ?? (left && left.kind === 'barline' ? (left as BarlineEvent) : null);
      const apply = (s: Score, id: string): Score => {
        const styled = setBarlineStyle(s, id, kind === 'final' ? 'final' : kind === 'double' ? 'double' : 'single');
        return setBarlineRepeat(
          styled,
          id,
          kind === 'repeat-start' ? 'start' : kind === 'repeat-end' ? 'end' : kind === 'repeat-both' ? 'both' : undefined,
          2,
        );
      };
      if (target) {
        setScoreInPlace(apply(draft, target.id));
        return;
      }
      const s = insertBarline(draft, snap.cursor);
      const fresh = s.events[snap.cursor];
      if (!fresh || fresh.kind !== 'barline') return;
      commit({ score: apply(s, fresh.id), cursor: snap.cursor + 1, anchor: null, mode: 'insert' });
    },
    toggleDashedCursor: () => {
      const left = snap.cursor > 0 ? draft.events[snap.cursor - 1] : undefined;
      const target = overBarline ?? (left && left.kind === 'barline' ? (left as BarlineEvent) : null);
      if (target) {
        setScoreInPlace(setBarlineStyle(setBarNotation(draft, target.id, { dashed: !target.dashed }), target.id, target.dashed ? (target.style ?? 'single') : 'single'));
        return;
      }
      const s = insertBarline(draft, snap.cursor);
      const fresh = s.events[snap.cursor];
      if (!fresh || fresh.kind !== 'barline') return;
      commit({ score: setBarNotation(s, fresh.id, { dashed: true }), cursor: snap.cursor + 1, anchor: null, mode: 'insert' });
    },
    accidental: (kind) => {
      const id = padLeftId();
      if (id) setScoreInPlace(cycleAccidentalAt(draft, id, kind));
    },
    dot: () => {
      const id = padLeftId();
      if (id) setScoreInPlace(cycleDot(draft, id));
    },
    breakLine: () => {
      // 小字谱不需要换行标记：主谱分行由主谱自己的换行决定
    },
    octave: (delta) => {
      if (selectedTimedIds.length >= 2) {
        setScoreInPlace(shiftOctaveMany(draft, selectedTimedIds, delta));
        return;
      }
      const id = padLeftId();
      if (id) setScoreInPlace(shiftOctave(draft, id, delta));
    },
    paren: (side) => {
      const id = overEvent && (overEvent.kind === 'note' || overEvent.kind === 'rest') ? overEvent.id : padLeftId();
      if (id) setScoreInPlace(toggleParen(draft, id, side));
    },
    slur: () => {
      if (selectedTimedIds.length >= 2) {
        commit({ score: toggleSlur(draft, selectedTimedIds) });
        return;
      }
      const id = padLeftId();
      if (id) setScoreInPlace(extendSlurRight(draft, id));
    },
    duration: (ticks) => {
      if (selectedTimedIds.length >= 2) {
        // 多音同改时值：按组合档位凑不齐就提示（主编辑器走 pending 流程，这里直接均摊）
        const cands = groupCandidates(selectedTimedIds.length, ticks, meterAt(draft, snap.cursor));
        const cand = cands[0];
        const next = cand ? applyTier(draft, selectedTimedIds, ticks, cand.ticks, cand.tuplet, cand.dots) : null;
        if (next) setScoreInPlace(next);
        else setMsg('这些音凑不成这个总时值（试试点两个音后用音值组合）');
        return;
      }
      const id = padLeftId();
      if (id) setScoreInPlace(setTicks(draft, id, ticks));
    },
    group: (ticks) => {
      if (selectedTimedIds.length < 2) {
        setMsg('音值组合：先拖选至少两个音符');
        return;
      }
      setPending({ ids: [...selectedTimedIds], ticks, cands: groupCandidates(selectedTimedIds.length, ticks, meterAt(draft, snap.cursor)) });
    },
    applyGroup: (cand) => {
      if (!pending) return;
      const next = applyTier(draft, pending.ids, pending.ticks, cand.ticks, cand.tuplet, cand.dots);
      if (next) commit({ score: next });
      setPending(null);
    },
    openCustomGroup: () => {
      if (pending) setCustomGroupOpen(true);
    },
    cancelGroup: () => setPending(null),
    del: () => {
      if (range) {
        const ids = draft.events.slice(range.lo, range.hi).map((e) => e.id);
        let s = draft;
        for (const id of ids) s = removeEvent(s, id);
        commit({ score: s, cursor: range.lo, anchor: null, mode: 'insert' });
        return;
      }
      if (overId) {
        commit({ score: removeEvent(draft, overId), cursor: Math.max(0, snap.cursor - 1), anchor: null, mode: 'insert' });
      } else if (snap.cursor > 0) {
        commit({ score: removeEvent(draft, draft.events[snap.cursor - 1].id), cursor: snap.cursor - 1, anchor: null, mode: 'insert' });
      }
    },
  }), [draft, snap, overId, overEvent, overBarline, selectedTimedIds, pending, range]);

  // 时值档位（与主编辑器同源：光标处拍号 → 大拍 tick → 档位表）
  const beat = meterAt(draft, snap.cursor);
  const beatTicks = Math.round(beatsPerMeasure(beat) * TICKS_PER_BEAT);
  const tiers = useMemo(() => durationTiers(beatTicks), [beatTicks]);
  const groupTargets = useMemo(
    () => groupTierOptions(beat).map((t) => ({
      ...t,
      ok: selectedTimedIds.length >= 2 && groupCandidates(selectedTimedIds.length, t.ticks, beat).length > 0,
    })),
    [beat, selectedTimedIds.length],
  );

  const timeline = useMemo(() => buildTimeline(draft), [draft]);

  // 「确定插入主谱」：草稿序列化成 jps 文本（剥掉谱头），事件直接引用草稿
  const buildCue = (): CueStaff => {
    const full = serializeDsl(draft);
    const segs = full.split('\n\n');
    const text = segs.length > 1 ? segs.slice(1).join('\n\n') : full;
    // 文本锚（@小谱 2-3）编辑后仍是文本锚：写成音符锚会把「一段小节上方」的
    // 小字谱变成「从某音一直拉到行末」，位置反而错。未传语义=清除，显式剥键。
    const src: CueStaff = existing ?? { id: `cue${Date.now().toString(36)}`, text: '' };
    // 两套锚不能共存：写音符锚时把文本锚字段显式剥掉（spread 不会自动清除），
    // 否则 layout / 序列化各按各的优先级，数据里留着互相矛盾的 anchorStart 与 anchorId。
    const { anchorId: _old, anchorStart: _s, anchorEnd: _e, ...rest } = src;
    void _s; void _e;
    const keepText = !!preserveTextAnchor && existing?.anchorStart !== undefined && !existing.anchorId;
    return {
      ...rest,
      ...(keepText
        ? { anchorStart: existing!.anchorStart, ...(existing!.anchorEnd !== undefined ? { anchorEnd: existing!.anchorEnd } : {}) }
        : { anchorId }),
      // 名称输入已取消（0.4.46）：编辑旧数据时保留原有名称，新建不带
      ...(existing?.name ? { name: existing.name } : {}),
      text,
      events: draft.events,
      groups: draft.groups,
    };
  };

  /**
   * 把主谱 Ctrl+C 复制的片段贴进草稿：OCR 把小字谱误认进主谱时，
   * 不用对着弹窗后面模糊的原图重敲，选中那段复制过来再粘进小字谱即可。
   * 走与主谱 Ctrl+V 完全相同的 pasteEvents，id / 连线 / 拍内组都会重映射。
   */
  const pasteFromMain = (): void => {
    if (clip.length === 0) {
      setMsg('请先在主谱选中那段音符按 Ctrl+C 复制，再回到这里粘贴');
      return;
    }
    const r = pasteEvents(draft, snap.cursor, clip, clipGroups);
    if (!r) return;
    const start = Math.max(0, r.cursor - clip.length);
    commit({ score: r.score, cursor: r.cursor, anchor: start, mode: 'insert' });
    setPending(null);
    setMsg(`已粘贴 ${clip.length} 个事件（已选中，可继续修改；主谱里误识别的那段记得删掉）`);
  };

  const padPending: PadPending | null = pending
    ? {
        count: pending.ids.length,
        ticks: pending.ticks,
        degrees: pending.ids.map((id) => {
          const e = draft.events.find((x) => x.id === id);
          return e && e.kind === 'note' ? (e as NoteEvent).degree : 0;
        }),
        cands: pending.cands,
      }
    : null;

  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(''), 4000);
    return () => window.clearTimeout(t);
  }, [msg]);

  // 草稿自己的键盘处理：Ctrl+V 粘贴主谱片段、Delete/Backspace 删音、
  // 方向键移动光标、Esc 关窗。主编辑器的全局键盘 handler 在本窗口打开时
  // 会让路（cueTarget 守卫），没有这里这段的话 Del/Backspace 会「没反应」。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        pasteFromMain();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        padActions.del();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setSnap((s) => {
          const n = s.score.events.length;
          if (s.mode === 'over') {
            return e.key === 'ArrowLeft'
              ? { ...s, cursor: Math.max(0, s.cursor - 1), mode: 'insert' as const }
              : { ...s, cursor: Math.min(n, s.cursor), mode: 'insert' as const };
          }
          const c = s.cursor + (e.key === 'ArrowLeft' ? -1 : 1);
          return c < 0 || c > n ? s : { ...s, cursor: c };
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [padActions, onClose, pasteFromMain]);

  const empty = draft.events.length === 0;

  return (
    <div className="v2-exp-mask v2-cue-mask" onClick={onClose}>
      <div className="v2-exp v2-cue-dialog" role="dialog" aria-label="小字谱录入" onClick={(e) => e.stopPropagation()}>
        <div className="v2-exp-head">
          <span>小字谱 · 锚定 {anchorLabel}（播放时从这里同时奏响）</span>
          <ExpClose onClose={onClose} />
        </div>
        <div className="v2-cue-scroll">
          {empty ? <p className="v2-hint" style={{ margin: '0 0 6px' }}>用下面的输入板录入，或粘贴主谱里复制的片段；点谱面选中音符修改</p> : null}
          {/* 草稿谱实时渲染（可点击选中） */}
          <div
            className="v2-cue-canvas"
            style={{
              border: '1px solid var(--border, #ccc)',
              borderRadius: 6,
              overflow: 'hidden',
              background: 'var(--surface, #fff)',
            }}
          >
            <ScoreCanvas
              score={draft}
              dark={dark}
              fontSize={Math.max(14, 21 * CUE_FONT_SCALE)}
              headerless
              selectedIds={selectedIds}
              cursor={snap.cursor}
              timeline={timeline}
              focusId={overId ?? null}
              showCaret={snap.mode !== 'over'}
              playing={false}
              clock={clockRef.current}
              onPick={(a: ScorePick, b: ScorePick | null) => {
                if (b) {
                  commit({ cursor: b.cursor, anchor: a.cursor, mode: 'insert' });
                  setPending(null);
                } else {
                  commit({ cursor: a.cursor, anchor: null, mode: a.mode });
                  setPending(null);
                }
              }}
              onEnded={() => {}}
            />
          </div>
          {msg ? <p style={{ color: 'var(--warn, #b45309)', fontSize: 12, margin: '4px 0 0' }}>{msg}</p> : null}
          {/* 与简谱编辑区同款的输入板：与谱面输入区之间留固定空隙 */}
          <div className="v2-cue-pad">
          <PadBody
            actions={padActions}
            score={draft}
            target={overEvent && (overEvent.kind === 'note' || overEvent.kind === 'rest') ? (overEvent as NoteEvent | RestEvent) : null}
            batchIds={selectedTimedIds}
            rangeCount={range ? range.hi - range.lo : 0}
            onSetScore={setScoreInPlace}
            onAnnotate={(next) => commit({ score: next })}
            barline={null}
            barlineActions={{
              setBeatAfter: () => setMsg('小字谱不单独设拍号，跟随主谱'),
              setBpmAfter: () => setMsg('小字谱不单独设速度，跟随主谱'),
              setPatchAfter: () => setMsg('小字谱不单独设音色，跟随主谱'),
              setBreakAfter: () => {},
              setRepeat: () => {},
              setRepeatTimes: () => {},
              setVolta: () => {},
              toggleFinal: () => {},
              toggleDouble: () => {},
              toggleVoltaOpen: () => {},
              toggleDashed: () => {},
              toggleFree: () => {},
              toggleJump: () => {},
            }}
            jumpAfter={null}
            playOrder={null}
            canEditConductor={false}
            volta={{ ok: false, error: null }}
            doSelectionVolta={() => {}}
            tiers={tiers}
            groupTargets={groupTargets}
            selectedCount={selectedTimedIds.length}
            pending={padPending}
            cueMode
          />
          </div>
        </div>
        <div className="v2-cue-foot">
          <div className="v2-cue-foot-left">
            <button
              className="v2-meta-btn"
              onClick={pasteFromMain}
              disabled={clip.length === 0}
              title="把主谱里 Ctrl+C 复制的片段贴进小字谱（也可直接按 Ctrl+V）"
            >
              粘贴主谱片段
            </button>
            {existing && onDelete ? (
              <button
                className="v2-meta-btn"
                onClick={() => {
                  onDelete();
                  onClose();
                }}
              >
                删除
              </button>
            ) : null}
          </div>
          <button
            className="v2-meta-btn"
            onClick={() => {
              onSave(buildCue());
              onClose();
            }}
            disabled={empty}
          >
            确定插入主谱
          </button>
        </div>
      </div>
      {/* 自定义音值组合弹窗（与主编辑器同一组件，作用于草稿） */}
      {customGroupOpen && pending ? (
        <CustomGroupDialog
          totalTicks={pending.ticks}
          beat={meterAt(draft, snap.cursor)}
          members={pending.ids.map((id) => {
            const e = draft.events.find((x) => x.id === id);
            return {
              id,
              kind: e && (e.kind === 'note' || e.kind === 'rest') ? e.kind : 'note',
              degree: e && e.kind === 'note' ? e.degree : 0,
            };
          })}
          initialTicks={pending.ids.map((id) => {
            const e = draft.events.find((x) => x.id === id);
            return e && (e.kind === 'note' || e.kind === 'rest') ? e.ticks : 0;
          })}
          initialTuplet={
            draft.groups.find(
              (g) => g.totalTicks === pending.ticks && pending.ids.every((id) => g.memberIds.includes(id)),
            )?.tuplet
          }
          onApply={(ticks, tuplet, dots) => {
            const next = applyTierOp(draft, pending.ids, pending.ticks, ticks, tuplet, dots);
            if (next) commit({ score: next });
            setCustomGroupOpen(false);
            setPending(null);
          }}
          onClose={() => setCustomGroupOpen(false)}
        />
      ) : null}
    </div>
  );
}
