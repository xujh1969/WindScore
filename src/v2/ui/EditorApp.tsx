import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import molihua from '../../scores/molihua.jps?raw';
import songbie from '../../scores/songbie.jps?raw';
import huanlesong from '../../scores/huanlesong.jps?raw';
import qinghuaci from '../../scores/qinghuaci.jps?raw';
import xiaoxingxing from '../../scores/xiaoxingxing.jps?raw';
import {
  applyTier as applyTierOp,
  autoGroupBeats,
  canonicalDurationBase,
  candidatesFor,
  cycleDot,
  dropGrace,
  moveGrace,
  pasteEvents,
  setGrace,
  setGraceSlot as setGraceSlotOp,
  setKeyChange,
  setHairpin,
  extendPrev,
  insertNote,
  insertRest,
  groupTiers,
  toggleArticulation,
  nextTimed,
  prevTimed,
  removeEvent,
  pressBarline,
  setAccidental,
  setDegree,
  setDot,
  setFermata,
  setMeta,
  setNoteDynamic,
  setOctave,
  toggleTechnique,
  setTicks,
  setTongue,
  shiftOctave,
  toggleSlur,
  toggleTongue,
  type GracePos,
  type TierCandidate,
} from '../edit';
import type { BeatClock } from '../clock';
import { BeatClock as Clock } from '../clock';
import { Player } from '../audio';
import { parseDsl, renderNoteToken, serializeDsl } from '../dsl';
import { fromText, nameOf, openScoreViaDialog, saveScore, type OpenResult } from '../io';
import { ACCIDENTAL_GLYPH, TECHNIQUE_GLYPH } from '../paint';
import { loadSession, saveSession } from '../session';
import { beamCount, durationTiers, TICKS_PER_BEAT, tupletBeamCount, undotTicks, withDots } from '../ticks';
import { buildTimeline, tickAtEvent, timelineTicks } from '../timeline';
import type { Accidental, Degree, Event, GraceNote, Score } from '../types';
import { isTimed } from '../types';
import { validateGroups } from '../validate';
import { ScoreCanvas, type ScorePick } from './ScoreCanvas';

/** 变音记号按钮：本位（无记号）在前，其余按升降序 */
const ACCIDENTAL_CHOICES: (Accidental | undefined)[] = [undefined, '#', 'b', '♮'];
const ACCIDENTAL_NAME: Record<Accidental, string> = { '#': '升', b: '降', '♮': '还原' };

/** 力度档位，由弱到强 */
const DYNAMICS = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];

/** 校验违反的人话分类——I1/I3 这类内部代号用户看不懂，翻成是哪类问题 */
const VIOLATION_LABEL: Record<string, string> = {
  I1: '拍内组',
  I2: '拍内组超一拍',
  I3: '拍内组',
  I4: '时值粒度',
  I5: '连线',
  E1: '数据',
  E2: '数据',
};

/**
 * 转调下拉的调号：**按实际音高从低到高排**（C #C/bD D … B），
 * 等价的两个写法挨在一起。不按「升降调放最后」排——
 * 找 1=#A 时不该先翻过一屏自然调。
 */
const KEY_CHOICES = [
  '1=C',
  '1=#C',
  '1=bD',
  '1=D',
  '1=#D',
  '1=bE',
  '1=E',
  '1=F',
  '1=#F',
  '1=bG',
  '1=G',
  '1=#G',
  '1=bA',
  '1=A',
  '1=#A',
  '1=bB',
  '1=B',
];

/**
 * 时值的人话标签（拍数）：2 拍 / 1 拍 / 1/2 拍 / 1/4 拍 / 1/8 拍 …
 * 标题行用它，而不是把音符也写进去的谱面写法——
 * 「5/2」会被读成五分之二，其实那是音级 5 加 1/2 拍。
 */
function durLabel(ticks: number): string {
  const beats = ticks / TICKS_PER_BEAT;
  if (Number.isInteger(beats)) return `${beats} 拍`;
  for (const den of [2, 3, 4, 6, 8, 12, 16]) {
    const num = Math.round(beats * den);
    if (num > 0 && Math.abs(beats * den - num) < 1e-6) {
      return num === 1 ? `1/${den} 拍` : `${num}/${den} 拍`;
    }
  }
  return `${beats.toFixed(2)} 拍`;
}

/**
 * 调号的 12 个选项：等音合并（#C 与 bD 是同一个调，只留写法更常见的一个），
 * 升降号写法跟简谱习惯——升号用 #（#C #F），降号用 b（bE bA bB）。
 */
const KEY_OPTIONS = [
  '1=C',
  '1=#C',
  '1=D',
  '1=bE',
  '1=E',
  '1=F',
  '1=#F',
  '1=G',
  '1=bA',
  '1=A',
  '1=bB',
  '1=B',
];

/** 一列八度点（高音在数字上、低音在下），简谱里就是这么标的 */
function GlyphDots({ n }: { n: number }) {
  return (
    <span className="v2-glyph-dots">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className="v2-dot" />
      ))}
    </span>
  );
}

/**
 * 简谱写法的可视化按钮文字：数字 + 上方八度点 / 下方减时线。
 *
 * 时值与八度按钮都用它——按钮要长成谱面上的样子，
 * 用户才不必在「3/2」和「数字下面一条横线的 3」之间来回翻译。
 * beams 来自 ticks.beamCount（1/2 拍 1 条、1/4 拍 2 条、1/8 拍 3 条）。
 */
function NotationGlyph({
  degree,
  beams = 0,
  dots = 0,
  accidental,
}: {
  degree: number;
  beams?: number;
  dots?: number;
  /** 变音记号写在数字左边，与简谱 `#4` / `b3` 一致 */
  accidental?: Accidental;
}) {
  return (
    <span className="v2-glyph">
      {dots > 0 ? <GlyphDots n={dots} /> : null}
      {/* 变音记号与数字同一行（写在数字左边），八度点才在上下方 */}
      <span className="v2-glyph-body">
        {accidental ? <span className="v2-glyph-acc">{ACCIDENTAL_GLYPH[accidental]}</span> : null}
        <span className="v2-glyph-digit">{degree}</span>
      </span>
      {beams > 0 ? (
        <span className="v2-glyph-beams">
          {Array.from({ length: beams }, (_, i) => (
            <i key={i} className="v2-beam" />
          ))}
        </span>
      ) : null}
      {dots < 0 ? <GlyphDots n={-dots} /> : null}
    </span>
  );
}

const BUILTIN: { name: string; text: string }[] = [
  { name: '茉莉花', text: molihua },
  { name: '送别', text: songbie },
  { name: '欢乐颂', text: huanlesong },
  { name: '小星星', text: xiaoxingxing },
  { name: '青花瓷', text: qinghuaci },
];

/**
 * 光标模式。
 *   over   = 方块光标，落在某个音上，输入 = 替换这个音
 *   insert = I 形光标，落在缝隙里，输入 = 插入新音
 *
 * 两种模式共用 cursor（缝隙下标 0..events.length）：
 * over 时被选中的音恒为 events[cursor-1]，不需要另存一份索引，
 * 也就不会出现「索引和模式对不上」的中间态。
 */
type CursorMode = 'over' | 'insert';

interface Snap {
  score: Score;
  /** 缝隙下标：0 .. events.length */
  cursor: number;
  /** 选区锚点，null 表示无选区 */
  anchor: number | null;
  mode: CursorMode;
  /**
   * 改动版本号，每次 commit +1。
   * 「有没有未保存的改动」靠它判断——比比对序列化文本可靠，
   * 而且撤销 / 重做会连同 rev 一起回退，撤到已保存那一步就自然显示干净了。
   */
  rev: number;
}

/** 八度面板用中文名，不再显示 ^1 / v2 这类 DSL 记号 */
const OCTAVE_LABEL: Record<number, string> = {
  3: '超高音',
  2: '倍高音',
  1: '高音',
  0: '中音',
  [-1]: '低音',
  [-2]: '倍低音',
  [-3]: '超低音',
};

function octaveName(o: number): string {
  return OCTAVE_LABEL[o] ?? (o > 0 ? `${o} 个高音点` : `${-o} 个低音点`);
}

function beatsPerMeasure(beat: string): number {
  const [n, d] = beat.split('/').map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 4;
  return n * (4 / d);
}

/**
 * v2 写谱器（M1）。
 * 数据链路：.jps → parseDsl → Score → layout → paint；编辑走 edit.ts 纯函数。
 * 录入规则（§6.1）：默认时值 1 拍占位，系统不自动均分，时值由框选 + 档位指定。
 */
export function EditorApp() {
  /** 深浅主题。初始值跟系统，之后由工具栏手动切换，不再随系统变 */
  const [dark, setDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );
  const [active, setActive] = useState('');
  const [snap, setSnap] = useState<Snap>({
    score: emptyScore(),
    cursor: 0,
    anchor: null,
    mode: 'insert',
    rev: 0,
  });
  /** 最近一次「已落盘 / 刚载入」时的 rev。与 snap.rev 不等就有未保存的改动 */
  const [savedRev, setSavedRev] = useState(0);
  /** 真实文件路径。Tauri 才拿得到；浏览器端始终为 null */
  const [path, setPath] = useState<string | null>(null);
  const [past, setPast] = useState<Snap[]>([]);
  const [future, setFuture] = useState<Snap[]>([]);
  const [pending, setPending] = useState<{ ids: string[]; ticks: number; cands: TierCandidate[] } | null>(
    null,
  );
  const [draft, setDraft] = useState('');
  /** 整体视图：要么看简谱，要么看源码。源码不再塞在属性栏里。 */
  const [view, setView] = useState<'score' | 'source'>('score');
  /** 复制粘贴的剪贴板：选区事件的深拷贝（粘贴时由 pasteEvents 重新生成 id） */
  const [clip, setClip] = useState<Event[]>([]);
  /**
   * 播放指示方式：
   *   head = 跟着当前音跳的色块 + 平滑横移的竖线（旧方式）
   *   band = 从当前行行首开始、随音乐不断变宽的高亮条（更好跟）
   */
  const [playStyle, setPlayStyle] = useState<'head' | 'band'>('head');
  /** 工具栏正中的谱面校验明细是否展开 */
  const [checkOpen, setCheckOpen] = useState(false);
  /**
   * 倚音录入：`graceSide` = 前 / 后（互斥，null = 都不勾），
   * `graceSlot` = 正在输入的那一格（null = 输入框收起）。
   * 三格共用一套状态，切音时由下面的 effect 复位。
   */
  const [graceSide, setGraceSide] = useState<GracePos | null>('before');
  const [graceSlot, setGraceSlot] = useState<number | null>(null);
  /**
   * 曲目信息编辑面板是否展开。点谱面标题旁的铅笔才打开。
   * 与音符属性互斥：改音符是改音符，改曲目信息是改曲目信息，不混在一个面板里。
   */
  const [songInfoOpen, setSongInfoOpen] = useState(false);
  /** 字间距：每 tick 像素宽，直接喂给 layoutScore 的 unit */
  const [spacing, setSpacing] = useState(1.3);
  /** 源码面板默认只读。主编辑路径是点选 + 键盘 + 属性面板。 */

  const [msg, setMsg] = useState('');
  const dslRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const clockRef = useRef<BeatClock>(new Clock(90));
  const playerRef = useRef<Player>(new Player());
  const [playing, setPlaying] = useState(false);

  const stopPlay = useCallback(() => {
    playerRef.current.stop();
    clockRef.current.pause();
    clockRef.current.seek(0);
    setPlaying(false);
  }, []);

  // 主题不再跟随系统：初始值取系统偏好，之后完全由工具栏的浅色/深色开关决定
  /**
   * 提交一次改动。参数是补丁而不是完整 Snap：
   * 调用点不用重复抄 cursor / anchor / mode，也就不容易把光标状态写丢。
   */
  const commit = useCallback(
    (next: Partial<Snap>) => {
      setPast((p) => [...p, snap].slice(-200));
      setFuture([]);
      setSnap((s) => {
        const merged = { ...s, ...next };
        // 时值一变就重新推导拍内组：连续音加起来正好 1 拍时自动拉通减时线。
        // autoGroupBeats 只增不减且幂等，所以每次提交都跑是安全的。
        const score =
          merged.score === s.score ? merged.score : autoGroupBeats(merged.score);
        return { ...merged, score, rev: s.rev + 1 };
      });
    },
    [snap],
  );

  /** 载入一份内容，并把「已保存」基准对齐到它 */
  const load = useCallback(
    (name: string, text: string, file: string | null = null) => {
      const res = parseDsl(text);
      if (!res.score) return;
      setSnap({
        score: res.score,
        cursor: res.score.events.length,
        anchor: null,
        mode: 'insert',
        rev: 0,
      });
      setPast([]);
      setFuture([]);
      setPending(null);
      setActive(name);
      setPath(file);
      setSavedRev(0);
      stopPlay();
    },
    [stopPlay],
  );

  // 启动：优先接着上次改；没有草稿才载入内置曲
  useEffect(() => {
    const s = loadSession();
    if (s) {
      const res = parseDsl(s.text);
      if (res.score) {
        load(s.name, s.text, s.path);
        setMsg('已恢复上次编辑的内容');
        return;
      }
    }
    load(BUILTIN[0].name, BUILTIN[0].text);
  }, [load]);

  const adopt = useCallback(
    (res: OpenResult) => {
      if (!res.score) {
        setMsg(res.errors.length ? `打开失败：${res.errors[0]}` : '解析失败');
        return;
      }
      setSnap({
        score: res.score,
        cursor: res.score.events.length,
        anchor: null,
        mode: 'insert',
        rev: 0,
      });
      setPast([]);
      setFuture([]);
      setPending(null);
      setActive(res.name);
      setPath(res.path);
      setSavedRev(0);
      setMsg(`已打开 ${res.name}`);
      stopPlay();
    },
    [stopPlay],
  );

  const onNew = useCallback(() => {
    setSnap({ score: emptyScore(), cursor: 0, anchor: null, mode: 'insert', rev: 0 });
    setPast([]);
    setFuture([]);
    setPending(null);
    setActive('新建谱面');
    setPath(null);
    setSavedRev(0);
    setMsg('已新建空白谱面');
    stopPlay();
  }, [stopPlay]);

  const onOpen = useCallback(async () => {
    const res = await openScoreViaDialog();
    if (res) adopt(res);
    else fileRef.current?.click(); // 浏览器预览：退化成文件选择框
  }, [adopt]);

  const onFilePicked = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      adopt(fromText(await f.text(), f.name.replace(/\.(jps|txt)$/i, '')));
    },
    [adopt],
  );

  const onSave = useCallback(async () => {
    const cur = snap.score;
    const r = await saveScore(cur, `${cur.meta.title || '未命名'}.jps`);
    if (!r.ok) {
      setMsg('保存取消');
      return;
    }
    if (r.path) setPath(r.path);
    setSavedRev(snap.rev);
    setMsg(
      r.path
        ? `已保存到 ${nameOf(r.path)}`
        : '已导出到浏览器下载目录（网页端拿不到文件路径）',
    );
  }, [snap]);

  const score = snap.score;
  /** 有未保存的改动 */
  const dirty = snap.rev !== savedRev;
  const serialized = useMemo(() => (score.events.length ? serializeDsl(score) : ''), [score]);
  const violations = useMemo(() => validateGroups(score), [score]);
  const timeline = useMemo(() => buildTimeline(score), [score]);

  /**
   * 起播时刻，跟随光标。
   *   方块态 → 从被选中的那个音起播（想听的就是它）
   *   插入态 → 从光标右边的音起播
   * 光标已经在末尾时退回从头播，免得播放键变成死键。
   */
  const playFromTick = useMemo(() => {
    const total = timelineTicks(timeline);
    const at = snap.mode === 'over' ? Math.max(0, snap.cursor - 1) : snap.cursor;
    const from = tickAtEvent(score, at);
    return from >= total ? 0 : from;
  }, [timeline, score, snap.mode, snap.cursor]);

  const startPlay = useCallback(() => {
    if (timeline.length === 0) return;
    const bpm = score.meta.bpm;
    // 先起音频、拿到它真正发声的时刻，再让时钟对齐到那个时刻起跑。
    // 顺序不能反：AudioContext 初始化有耗时，时钟先跑就会跑到声音前面。
    const lead = playerRef.current.start(timeline, bpm, playFromTick);
    clockRef.current.setBpm(bpm);
    clockRef.current.seek(playFromTick / TICKS_PER_BEAT);
    clockRef.current.playAfter(lead);
    setPlaying(true);
  }, [timeline, score, playFromTick]);

  /**
   * 视觉上播到最后。这里**不**停音频：
   * 对齐误差和输出延迟加起来还有几十毫秒，硬停会把最后一个音的尾音切掉。
   * Player 自己在音频播完后会收尾，届时也不再有新声音。
   */
  const onPlayEnded = useCallback(() => {
    clockRef.current.pause();
    clockRef.current.seek(0);
    setPlaying(false);
  }, []);

  const beatTicks = Math.round(beatsPerMeasure(score.meta.beat) * TICKS_PER_BEAT);
  /** 单选：档位就是「这个音的时值」，长音（3/4 拍）也要能改回去 */
  const tiers = useMemo(() => durationTiers(beatTicks), [beatTicks]);

  const range = useMemo<[number, number] | null>(() => {
    if (snap.anchor === null) return null;
    const lo = Math.min(snap.anchor, snap.cursor);
    const hi = Math.max(snap.anchor, snap.cursor);
    return hi > lo ? [lo, hi] : null;
  }, [snap.anchor, snap.cursor]);

  // 方块光标选中的音。over 模式下恒为 events[cursor-1]，
  // 所以「选中谁」和「插入到哪儿」不会出现各存一份、彼此对不上的情况。
  const overEvent =
    snap.mode === 'over' && snap.anchor === null && snap.cursor > 0
      ? score.events[snap.cursor - 1]
      : undefined;
  const overId = overEvent && isTimed(overEvent) ? overEvent.id : null;

  const selectedIds = useMemo(() => {
    const s = new Set<string>();
    if (!range) return s;
    for (let i = range[0]; i < range[1]; i += 1) s.add(score.events[i].id);
    return s;
  }, [range, score]);

  const undo = useCallback(() => {
    if (!past.length) return;
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [snap, ...f]);
    setSnap(prev);
  }, [past, snap]);

  const redo = useCallback(() => {
    if (!future.length) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, snap]);
    setSnap(next);
  }, [future, snap]);

  // 时值操作的作用对象：有选区就用选区，否则用方块光标选中的那个音。
  // 「选中一个音符也能改音长」就靠这一条。
  const selectedTimedIds = useMemo(() => {
    if (range) {
      return score.events
        .slice(range[0], range[1])
        .filter(isTimed)
        .map((e) => e.id);
    }
    return overId ? [overId] : [];
  }, [range, overId, score]);

  /**
   * 选区档位表：多选时档位的语义变成「整个选区的总时值」，
   * 受 I2 约束上限 1 拍，且每个音都要分到合法 tick（I4）。
   * 所以选区和单音用的不是同一份表——「3 拍」在单选时是合法长音，
   * 在选区里却会建出总时值 3 拍的拍内组。
   */
  const groupTierList = useMemo(
    () => groupTiers(selectedTimedIds.length, beatTicks),
    [selectedTimedIds.length, beatTicks],
  );

  // 属性检查器的焦点：无选区时取光标前一个事件
  /**
   * 属性检查器的焦点 = 方块光标**正压着**的那个事件。
   *
   * 不能取「插入点左边的音」：插入状态下面板会显示前一个音的音级 / 时值 / 八度……
   * 看上去像已经选中了它，可实际选中集合是空的（selectedTimedIds 用 overId），
   * 于是"显示的状态"和"操作的对象"分离，容易误改。
   * 插入点就该什么都不显示——想改某个音，点它一下变成方块光标。
   */
  const focus = overEvent;

  const setScore = useCallback(
    (next: Score) => {
      commit({ ...snap, score: next });
    },
    [commit, snap],
  );

  // ───────────────────────── 倚音录入（三格 + 前/后互斥） ─────────────────────────

  /**
   * 换到别的音时把录入状态复位：勾选框回到这颗音实际有倚音的那一侧
   * （两侧都有只可能来自源码写法，按「前」展示），并收起输入框。
   * 依赖只有 id——编辑过程中不要抢用户正在选的那一侧。
   */
  useEffect(() => {
    if (!focus || focus.kind !== 'note') {
      setGraceSlot(null);
      return;
    }
    const hasBefore = (focus.graceBefore?.length ?? 0) > 0;
    const hasAfter = (focus.graceAfter?.length ?? 0) > 0;
    setGraceSide(hasAfter && !hasBefore ? 'after' : 'before');
    setGraceSlot(null);
  }, [focus?.id]);

  /** 三格里显示的那一组（跟着勾选框走；都没勾就是空的） */
  const graceList: GraceNote[] =
    focus && focus.kind === 'note'
      ? graceSide === 'after'
        ? focus.graceAfter ?? []
        : graceSide === 'before'
          ? focus.graceBefore ?? []
          : []
      : [];

  /**
   * 点前 / 后勾选框。
   *   再点已勾的那个 = 取消勾选，并清掉这一侧的倚音（等价于「这个音不要倚音」）
   *   换到另一侧 = 把当前这组搬过去（勾了后面就是后倚音）；目标侧本来就有倚音
   *   （只可能来自源码 / 旧文件）时只切视图，绝不动数据，免得悄悄吞掉一组
   */
  const pickGraceSide = useCallback(
    (side: GracePos) => {
      if (!focus || focus.kind !== 'note') return;
      if (graceSide === side) {
        setScore(setGrace(score, focus.id, side, undefined));
        setGraceSide(null);
        setGraceSlot(null);
        return;
      }
      const other: GracePos = side === 'before' ? 'after' : 'before';
      const target = (side === 'before' ? focus.graceBefore : focus.graceAfter) ?? [];
      const moving = other === 'before' ? focus.graceBefore ?? [] : focus.graceAfter ?? [];
      setGraceSide(side);
      if (target.length === 0 && moving.length > 0) {
        setScore(moveGrace(score, focus.id, other, side));
      }
    },
    [focus, graceSide, score, setScore],
  );

  /** 点某一格：打开输入框（再点同一格 = 收起）。什么都没勾时默认按前倚音录入 */
  const openGraceSlot = useCallback(
    (i: number) => {
      if (!focus || focus.kind !== 'note') return;
      if (graceSide === null) setGraceSide('before');
      setGraceSlot(graceSlot === i ? null : i);
    },
    [focus, graceSide, graceSlot],
  );

  /** 输入框里点一个键：写入当前格；再点同一格会自动跳到下一格，填满最后一格就收起 */
  const putGrace = useCallback(
    (octave: number, key: { degree: Degree; accidental?: Accidental }) => {
      if (!focus || focus.kind !== 'note' || graceSlot === null) return;
      const side = graceSide ?? 'before';
      const g: GraceNote = { degree: key.degree, octave };
      if (key.accidental) g.accidental = key.accidental;
      setScore(setGraceSlotOp(score, focus.id, side, graceSlot, g));
      setGraceSlot(graceSlot >= GRACE_COUNT - 1 ? null : graceSlot + 1);
    },
    [focus, graceSide, graceSlot, score, setScore],
  );

  /** 清除本格：三格里的某一格不要了 */
  const clearGraceSlot = useCallback(() => {
    if (!focus || focus.kind !== 'note' || graceSlot === null) return;
    setScore(setGraceSlotOp(score, focus.id, graceSide ?? 'before', graceSlot, null));
  }, [focus, graceSide, graceSlot, score, setScore]);

  /** 清除：前、后两侧的倚音全删光，勾选框一并取消 */
  const clearGrace = useCallback(() => {
    if (!focus || focus.kind !== 'note') return;
    setScore(setGrace(setGrace(score, focus.id, 'before', undefined), focus.id, 'after', undefined));
    setGraceSide(null);
    setGraceSlot(null);
  }, [focus, score, setScore]);

  /**
   * 鼠标选中。
   *   点在音上   → over 模式，方块光标，之后输入是替换
   *   点在缝隙里 → insert 模式，I 形光标，之后输入是插入
   *   拖拉跨了多个事件 → 建立区间选区（用于套时值档位）
   */
  const handlePick = useCallback((a: ScorePick, b: ScorePick | null) => {
    // 画布上任何一次非铅笔点击（音符 / 缝隙 / 空白处按最近邻回退）都离开曲目信息：
    // 改音符和改曲目信息互斥，见 songInfoOpen 的注释
    setSongInfoOpen(false);
    setSnap((s) => {
      if (b && b.index !== a.index) {
        const lo = Math.min(a.index, b.index);
        const hi = Math.max(a.index, b.index);
        return { ...s, cursor: hi + 1, anchor: lo, mode: 'insert' };
      }
      return { ...s, cursor: a.cursor, anchor: null, mode: a.mode };
    });
  }, []);

  const deleteSelection = useCallback(() => {
    if (!range) return;
    let s = score;
    for (const e of score.events.slice(range[0], range[1])) s = removeEvent(s, e.id);
    commit({ score: s, cursor: range[0], anchor: null, mode: 'insert' });
  }, [range, score, snap, commit]);

  const useTier = useCallback(
    (ticks: number) => {
      const ids = selectedTimedIds;
      if (ids.length === 0) return;
      // 单个音直接改时值，不建只有一名成员的组；减时线交给 autoGroupBeats / beamCount
      if (ids.length === 1) {
        commit({ score: setTicks(score, ids[0], ticks) });
        return;
      }
      const cands = candidatesFor(ids.length, ticks);
      if (cands.length === 0) return;
      if (cands.length === 1) {
        const next = applyTierOp(score, ids, ticks, cands[0].ticks, cands[0].tuplet);
        if (next) commit({ score: next });
        return;
      }
      setPending({ ids, ticks, cands });
    },
    [selectedTimedIds, score, commit],
  );

  // 连音不走独立按钮：选区选 1 拍时候选面板里就有「n 连音」，
  // 单选下面板也没有它的位置（见属性检查器里那段注释）。

  const doSlur = useCallback(() => {
    if (selectedTimedIds.length < 2) return;
    commit({ ...snap, score: toggleSlur(score, selectedTimedIds) });
  }, [selectedTimedIds, score, snap, commit]);

  // ─────────── 键盘 ───────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (k === 'y') {
          e.preventDefault();
          redo();
        } else if (k === 's') {
          e.preventDefault();
          void onSave();
        } else if (k === 'l') {
          e.preventDefault();
          doSlur();
        } else if (k === 'c') {
          // 复制选区（画布上没有文本选区，浏览器默认复制行为无意义）
          if (range) {
            e.preventDefault();
            setClip(JSON.parse(JSON.stringify(score.events.slice(range[0], range[1]))) as Event[]);
            setMsg(`已复制 ${range[1] - range[0]} 个事件`);
          }
        } else if (k === 'v') {
          if (clip.length > 0) {
            e.preventDefault();
            const r = pasteEvents(score, snap.cursor, clip);
            if (r) {
              // 粘贴后**选中刚贴上的段落**：贴进来的内容和原音符一模一样，
              // 不高亮的话用户根本发现不了它贴在了哪
              const start = Math.max(0, r.cursor - clip.length);
              commit({
                score: r.score,
                cursor: r.cursor,
                anchor: start,
                mode: 'insert',
              });
              setMsg(`已粘贴 ${clip.length} 个事件（已选中，可继续拖动或 Ctrl+V 重复粘贴）`);
            }
          }
        }
        return;
      }

      const n = score.events.length;
      const cur = snap.cursor;

      if (e.key >= '1' && e.key <= '7') {
        e.preventDefault();
        const d = Number(e.key) as Degree;
        if (overId) {
          // 替换：只改音级，保留时值与附点。
          // 替换完立刻转成插入点，让后续输入继续往后写。
          // 否则 1-7 是「替换」、而 - ^ v . t 是「作用于左边的音」，
          // 两组键语义不一致：输入 1--0 时那个 0 会回头把刚输入的 1 吃掉。
          commit({ score: setDegree(score, overId, d), mode: 'insert', anchor: null });
        } else {
          commit({ score: insertNote(score, cur, d), cursor: cur + 1, anchor: null, mode: 'insert' });
        }
        return;
      }

      switch (e.key) {
        case '0':
          e.preventDefault();
          if (overId) {
            // 与 1-7 同理：转成休止符后回到插入点
            commit({ score: setDegree(score, overId, 0), mode: 'insert', anchor: null });
          } else {
            commit({ score: insertRest(score, cur), cursor: cur + 1, anchor: null, mode: 'insert' });
          }
          return;
        case '|':
        case '\\': {
          e.preventDefault();
          // 连按两次 = 终止线（规则见 pressBarline）：
          // 第一次插单小节线，第二次就地把左边那条升级成 final。
          const r = pressBarline(score, cur);
          commit({ score: r.score, cursor: r.cursor, anchor: null, mode: 'insert' });
          return;
        }
        // 换气没有独立记号：用「气息与技法」里的 换气 V（跟着音符走）
        case '-': {
          e.preventDefault();
          const r = extendPrev(score, cur);
          if (r.ok) commit({ score: r.score });
          return;
        }
        case '^':
        case 'v':
        case '.':
        case 't': {
          e.preventDefault();
          // 一律作用于光标左边最近的那个音：over 模式下就是被选中的音，
          // insert 模式下遇到小节线也能正确落到前一个音上。
          const k = prevTimed(score, cur);
          if (k < 0) return;
          const prev = score.events[k];
          if (prev.kind !== 'note') return;
          const next =
            e.key === '.'
              ? cycleDot(score, prev.id)
              : e.key === 't'
                ? toggleTongue(score, prev.id)
                : shiftOctave(score, prev.id, e.key === '^' ? 1 : -1);
          commit({ score: next });
          return;
        }
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) {
            if (cur > 0) setSnap({ ...snap, cursor: cur - 1, anchor: snap.anchor ?? cur });
            return;
          }
          if (snap.mode === 'over') {
            // 方块 → 退到它左边的缝
            setSnap({ ...snap, cursor: Math.max(0, cur - 1), anchor: null, mode: 'insert' });
          } else {
            // 缝 → 落到左边最近的音上；左边没音了（一头）就留在缝里
            const k = prevTimed(score, cur);
            if (k >= 0) setSnap({ ...snap, cursor: k + 1, anchor: null, mode: 'over' });
          }
          return;
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) {
            if (cur < n) setSnap({ ...snap, cursor: cur + 1, anchor: snap.anchor ?? cur });
            return;
          }
          if (snap.mode === 'over') {
            // 方块 → 进到它右边的缝
            setSnap({ ...snap, cursor: Math.min(n, cur), anchor: null, mode: 'insert' });
          } else {
            // 缝 → 落到右边最近的音上；右边没音了（一尾）就留在缝里
            const j = nextTimed(score, cur);
            if (j >= 0) setSnap({ ...snap, cursor: j + 1, anchor: null, mode: 'over' });
          }
          return;
        case 'Backspace':
          e.preventDefault();
          if (overId) {
            commit({
              score: removeEvent(score, overId),
              cursor: Math.max(0, cur - 1),
              anchor: null,
              mode: 'insert',
            });
          } else if (cur > 0) {
            commit({
              score: removeEvent(score, score.events[cur - 1].id),
              cursor: cur - 1,
              anchor: null,
            });
          }
          return;
        case 'Delete':
          e.preventDefault();
          if (overId) {
            commit({
              score: removeEvent(score, overId),
              cursor: Math.max(0, cur - 1),
              anchor: null,
              mode: 'insert',
            });
          } else if (cur < n) {
            commit({ score: removeEvent(score, score.events[cur].id) });
          }
          return;
        case 'Escape':
          setPending(null);
          setSnap({ ...snap, anchor: null, mode: 'insert' });
          return;
        default:
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [score, snap, commit, undo, redo, useTier, doSlur, range, clip]);

  // DSL 面板：谱面变化时同步文本
  useEffect(() => {
    setDraft(serialized);
  }, [serialized]);

  // 切到源码视图就把焦点交给编辑器，省一次多余的点击
  useEffect(() => {
    if (view === 'source') dslRef.current?.focus();
  }, [view]);

  // 编辑内容自动落一份到本地，防刷新 / 崩溃丢工作。
  // 存内容不存路径，所以两端行为一致，也不怕文件被移走。
  useEffect(() => {
    const t = window.setTimeout(() => {
      saveSession({ text: serialized, name: active, path });
    }, 600);
    return () => window.clearTimeout(t);
  }, [serialized, active, path]);

  const applyDraft = () => {
    const res = parseDsl(draft);
    if (!res.score) {
      // 错误已经在下方的实时解析列表里了，不用重复弹
      setMsg(res.errors.length ? res.errors[0] : '解析失败');
      return;
    }
    // 播放中改谱必须先停：播放循环每帧重绘 + 强制滚动，
    // 谱面在它底下被换掉，新旧两套布局来回拉扯就是「画面一直抖」
    stopPlay();
    commit({ score: res.score, cursor: res.score.events.length, anchor: null });
  };

  /**
   * 切视图。从源码回简谱时，**草稿能解析就自动应用**——
   * 以前必须手动按「应用」，忘了就出现「源码改了、谱面没变」的错位；
   * 解析不过则留在源码视图（错误就在列表里），切过去只会看到旧谱面，更糊涂。
   */
  const switchView = useCallback(
    (next: 'score' | 'source') => {
      if (next === 'score' && view === 'source' && draft !== serialized) {
        const res = parseDsl(draft);
        if (res.score) {
          stopPlay();
          commit({ score: res.score, cursor: res.score.events.length, anchor: null });
        } else {
          setMsg(res.errors.length ? res.errors[0] : '解析失败');
          return;
        }
      }
      setView(next);
    },
    [view, draft, serialized, stopPlay, commit],
  );

  /** 源码视图的**实时**解析：编辑过程中错误列表跟着变，修好立即消失 */
  const draftParse = useMemo(() => (view === 'source' ? parseDsl(draft) : null), [view, draft]);
  const draftErrors = draftParse?.errors ?? [];

  const notes = score.events.filter((e) => e.kind === 'note').length;

  return (
    <div className="v2-app" data-theme={dark ? 'dark' : 'light'}>
      <header className="v2-head">
        <div className="v2-brand">
          WindScore <span className="v2-brand-tag">写谱器</span>
        </div>
        {/* 曲目信息只在谱面标题块 + 曲目信息面板出现，工具栏不再重复一遍 */}
        <div className="v2-file" title={path ?? '当前内容还没落到文件里'}>
          <span className={dirty ? 'v2-file-badge is-dirty' : 'v2-file-badge'}>
            {dirty ? '● 有未保存的改动' : '已保存'}
          </span>
          <span className="v2-file-name">{path ? nameOf(path) : '未保存到文件'}</span>
        </div>
        {/* 谱面校验：挪到工具栏正中。通过时只显示一行字，有问题才可点开明细 */}
        <div className="v2-head-check">
          <button
            className={violations.length === 0 ? 'v2-check is-ok' : 'v2-check is-bad'}
            onClick={() => setCheckOpen((v) => !v)}
            title={violations.length === 0 ? '每小节拍数、拍内组、连线都没问题' : '点开看具体问题'}
          >
            {violations.length === 0 ? '谱面校验通过' : `谱面校验：${violations.length} 处问题`}
          </button>
          {checkOpen && violations.length > 0 ? (
            <ul className="v2-diag v2-check-list">
              {violations.map((v, i) => (
                <li key={i} className={v.code === 'I4' ? 'is-warn' : 'is-error'}>
                  <b>{VIOLATION_LABEL[v.code] ?? '谱面'}</b> {v.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="v2-head-actions">
          <button className="v2-btn" onClick={onNew}>
            新建
          </button>
          <button className="v2-btn" onClick={onOpen}>
            打开
          </button>
          <button className="v2-btn" onClick={onSave} disabled={score.events.length === 0}>
            保存
          </button>
          <button className="v2-btn" onClick={undo} disabled={!past.length}>
            撤销
          </button>
          <button className="v2-btn" onClick={redo} disabled={!future.length}>
            重做
          </button>
          <input ref={fileRef} type="file" accept=".jps,.txt" hidden onChange={onFilePicked} />
        </div>
      </header>

      {/* view 是布局级状态：源码视图下右栏整块收起，让编辑器铺满 */}
      <div className="v2-body" data-view={view}>
        <main className="v2-stage">
          <div className="v2-bar">
            <div className="v2-library">
              <label className="v2-library-label" htmlFor="v2-library">
                示例乐谱
              </label>
              <select
                id="v2-library"
                className="v2-library-select"
                value={BUILTIN.some((s) => s.name === active) ? active : ''}
                onChange={(e) => {
                  const s = BUILTIN.find((x) => x.name === e.target.value);
                  if (s) load(s.name, s.text);
                }}
              >
                {!BUILTIN.some((s) => s.name === active) ? (
                  <option value="">{active || '（当前谱面）'}</option>
                ) : null}
                {BUILTIN.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="v2-transport">
              <button
                className="v2-btn"
                onClick={playing ? stopPlay : startPlay}
                disabled={timeline.length === 0}
              >
                {playing ? '停止' : '播放'}
              </button>
              {/* 「69 音序」原来是播放序列总长，不跟着光标走——
                  跟着光标走的是「第几拍起」。写清楚，别让人以为是光标位置 */}
              <span
                className="v2-tiers-label"
                title="起播位置跟随当前光标；后面是全曲可播放的音符总数"
              >
                {playing
                  ? '播放中'
                  : playFromTick > 0
                    ? `从第 ${trimTick(playFromTick)} 拍起播 · 共 ${timeline.length} 音`
                    : `从头播放 · 共 ${timeline.length} 音`}
              </span>
            </div>

            <div className="v2-spacing">
              {/* 这条只影响编辑视图的横向密度（每拍多少像素），不写入文件；
                  与曲目信息里记进 jps 的「字间距」是两回事，名字必须分开 */}
              <label htmlFor="v2-spacing" title="编辑视图的音符横向密度（每拍像素），不随文件保存。要改谱面本身的字间距请到曲目信息面板">
                音符间距
              </label>
              <input
                id="v2-spacing"
                type="range"
                min={0.5}
                max={2.4}
                step={0.05}
                value={spacing}
                onChange={(e) => setSpacing(Number(e.target.value))}
              />
              <output className="v2-spacing-val" htmlFor="v2-spacing">
                {spacing.toFixed(2)}×
              </output>
            </div>

            {/* 播放指示方式：两种指示各有偏好，交给用户选 */}
            <div className="v2-spacing">
              <span className="v2-playstyle-label">播放指示</span>
              <div className="v2-view-switch">
                <button
                  className={playStyle === 'head' ? 'v2-seg is-on' : 'v2-seg'}
                  onClick={() => setPlayStyle('head')}
                  title="跟着当前音跳的色块 + 平滑横移的竖线"
                >
                  光标
                </button>
                <button
                  className={playStyle === 'band' ? 'v2-seg is-on' : 'v2-seg'}
                  onClick={() => setPlayStyle('band')}
                  title="从当前行行首开始、随音乐变宽的高亮条"
                >
                  高亮条
                </button>
              </div>
            </div>

            {/* 简谱 / 源码整体切换：源码不是属性栏里的一个小格子，而是另一套视图 */}
            <div className="v2-view-switch">
              <button
                className={view === 'score' ? 'v2-seg is-on' : 'v2-seg'}
                onClick={() => switchView('score')}
              >
                简谱
              </button>
              <button
                className={view === 'source' ? 'v2-seg is-on' : 'v2-seg'}
                onClick={() => switchView('source')}
              >
                源码
              </button>
            </div>

            {/* 深浅主题：CSS 变量与画布配色一起切，不跟系统走 */}
            <div className="v2-view-switch">
              <button
                className={!dark ? 'v2-seg is-on' : 'v2-seg'}
                onClick={() => setDark(false)}
              >
                浅色
              </button>
              <button className={dark ? 'v2-seg is-on' : 'v2-seg'} onClick={() => setDark(true)}>
                深色
              </button>
            </div>
          </div>

          {view === 'score' ? (
            <>
              <ScoreCanvas
                score={score}
                dark={dark}
                unit={spacing}
                selectedIds={selectedIds}
                cursor={snap.cursor}
                timeline={timeline}
                playing={playing}
                clock={clockRef.current}
                onEnded={onPlayEnded}
                onPick={handlePick}
                focusId={overId}
                showCaret={snap.mode === 'insert'}
                playStyle={playStyle}
                onEditTitle={() => setSongInfoOpen((v) => !v)}
                onBlankClick={() => setSongInfoOpen(false)}
              />

              <div className="v2-status">
                <span>{notes} 音</span>
                <span>{score.events.length} 事件</span>
                <span>
                  光标 {snap.cursor} · {snap.mode === 'over' ? '方块（输入替换）' : '插入点'}
                </span>
                <span>
                  {range ? `已选 ${range[1] - range[0]} 个` : overId ? '已选中 1 个音' : '未选中'}
                </span>
                {msg ? <span className="v2-msg">{msg}</span> : null}
                <span className="v2-keys">
                  1-7 音 · 0 休止 · | 小节线（连按两次=终止线） · 拖拉建选区（拖到边缘自动滚动） ·
                  Shift+点击 选中到此处 · Ctrl+C/V 复制 / 粘贴 ·
                  - ^ v . t 修改紧挨着光标左边的那一个音 · 例：输入 5 后连按 --，得到 5--（三拍）
                </span>
              </div>
            </>
          ) : (
            <div className="v2-source">
              <textarea
                ref={dslRef}
                className="v2-dsl v2-dsl-full"
                value={draft}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="v2-dsl-actions">
                <button className="v2-btn" onClick={applyDraft}>
                  应用
                </button>
                <button className="v2-btn" onClick={() => setDraft(serialized)}>
                  丢弃改动
                </button>
                <span className="v2-hint">
                  按「应用」重新解析（切回简谱时也会自动应用）；解析不通过不会改动谱面。
                </span>
              </div>
              {/* 实时解析：改一个字符就重查，修好了红字立即消失，不用先「应用」再验证 */}
              {draftErrors.length > 0 ? (
                <ul className="v2-diag">
                  {draftErrors.map((e, i) => (
                    <li key={i} className="is-error">
                      {e}
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="v2-diag">
                  <li className="is-ok">
                    解析通过 · {draftParse?.score?.events.length ?? 0} 事件（按「应用」或切回简谱写回）
                  </li>
                </ul>
              )}
            </div>
          )}
        </main>

        <aside className="v2-side">
          {/*
            曲目信息（对应 DSL 的 @title @key @beat @bpm @patch）。
            只在点了谱面标题旁的铅笔时出现，和音符属性互斥：
            改曲目信息和改音符是两件事，不该挤在同一个面板里同时可见。
          */}
          <div className={songInfoOpen ? 'v2-side-block' : 'v2-side-block is-hidden'}>
            <div className="v2-side-title">曲目信息</div>
            <div className="v2-meta">
              <MetaInput
                label="名称"
                value={score.meta.title}
                onCommit={(v) => setScore(setMeta(score, { title: v }))}
              />
              <MetaSelect
                label="调号"
                value={score.meta.key}
                options={KEY_OPTIONS}
                onCommit={(v) => setScore(setMeta(score, { key: v }))}
              />
              <MetaInput
                label="拍号"
                value={score.meta.beat}
                placeholder="4/4"
                onCommit={(v) => setScore(setMeta(score, { beat: v }))}
              />
              <MetaInput
                label="速度"
                type="number"
                value={score.meta.bpm}
                min={20}
                max={300}
                onCommit={(v) => setScore(setMeta(score, { bpm: Number(v) }))}
              />
              <MetaInput
                label="音色"
                type="number"
                value={score.meta.patch}
                min={0}
                max={127}
                onCommit={(v) => setScore(setMeta(score, { patch: Number(v) }))}
              />
              {/* 版式：字号 / 字间距，记进 jps（@size / @space），打开即还原 */}
              <MetaInput
                label="字号"
                type="number"
                value={score.meta.fontSize ?? 21}
                min={12}
                max={56}
                onCommit={(v) => setScore(setMeta(score, { fontSize: Number(v) }))}
              />
              <MetaInput
                label="字间距"
                type="number"
                value={score.meta.letterSpacing ?? 0}
                min={-4}
                max={24}
                onCommit={(v) => setScore(setMeta(score, { letterSpacing: Number(v) }))}
              />
            </div>
            <p className="v2-hint">
              调号支持升降号：1=bB、1=#F（♭B / ♯F 也认）。速度单位是 BPM，音色是 MIDI 音色号
              0–127。字号 / 字间距随文件保存。改完按回车或点别处生效。
            </p>
          </div>

          {/* 属性检查器：点选什么就改什么，不需要记语法。打开曲目信息时让位 */}
          <div className={songInfoOpen ? 'v2-side-block is-hidden' : 'v2-side-block'}>
            <div className="v2-side-title v2-inspector-title">
              <span>
                {range
                  ? `已选 ${range[1] - range[0]} 个事件`
                  : focus
                    ? `选中 ${eventLabel(focus)}`
                    : snap.mode === 'insert'
                      ? '插入点：未选中任何音'
                      : '属性'}
              </span>
              {/* 当前时值排进标题行。带附点的音显示去点后的值——
                  「2..」的档位是八分那颗，附点在附点行单独表达。
                  用拍数标签（1/2 拍）而不是谱面写法（5/2）：后者会被读成五分之二 */}
              {focus && (focus.kind === 'note' || focus.kind === 'rest') ? (
                <span className="v2-title-token">
                  时值 {durLabel(undotTicks(focus.ticks, focus.dot ?? 0))}
                </span>
              ) : null}
            </div>

            {range ? (
              <>
                <div className="v2-field">
                  {/*
                    多选时档位是「整个选区的总时值」，不是每个音的时值。
                    受 I2 约束总时值 ≤ 1 拍，所以这里只列 1 拍及以内的档位——
                    简谱里超过一拍的长音用增时线写在单个音上，没有「几个音连起来合计 2 拍」的写法。
                  */}
                  <span className="v2-field-label">
                    总时值（{selectedTimedIds.length} 个音均分，上限 1 拍）
                  </span>
                  <div className="v2-grid v2-grid-4">
                    {groupTierList.map((t) => (
                      <button key={t.label} className="v2-btn" onClick={() => useTier(t.ticks)}>
                        {t.label}
                      </button>
                    ))}
                    {groupTierList.length < tiers.length ? (
                      <span className="v2-tiers-label">
                        2 拍以上长音请写增时线（-）
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="v2-field">
                  <span className="v2-field-label">区间操作</span>
                  <div className="v2-grid">
                    <button
                      className="v2-btn"
                      onClick={doSlur}
                      disabled={selectedTimedIds.length < 2}
                    >
                      连音线
                    </button>
                    <button className="v2-btn" onClick={deleteSelection}>
                      删除所选
                    </button>
                  </div>
                </div>
              </>
            ) : focus && focus.kind === 'note' ? (
              <>
                {/*
                  单选时不出现连音相关的东西：连音线至少要两个音，
                  3/6 连音也要正好选中那么多音，单选下一律不可用，
                  摆在这里只会让面板多一块永远点不动的区域。
                  连音线在选区的「区间操作」里，连音在选 1 拍弹出的候选面板里。
                */}
                <div className="v2-field">
                  <span className="v2-field-label">音级</span>
                  <div className="v2-grid v2-grid-7">
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <button
                        key={d}
                        className={focus.degree === d ? 'v2-btn is-on' : 'v2-btn'}
                        onClick={() => setScore(setDegree(score, focus.id, d))}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="v2-field">
                  <span className="v2-field-label">八度</span>
                  <div className="v2-grid v2-grid-5">
                    {[2, 1, 0, -1, -2].map((o) => (
                      <button
                        key={o}
                        className={focus.octave === o ? 'v2-btn is-on' : 'v2-btn'}
                        onClick={() => setScore(setOctave(score, focus.id, o))}
                        title={octaveName(o)}
                      >
                        {/* 八度用简谱本来的样子：高音数字上加圆点，低音数字下加圆点 */}
                        <NotationGlyph degree={focus.degree} dots={o} />
                      </button>
                    ))}
                  </div>
                </div>
                <div className="v2-field">
                  <span className="v2-field-label">
                    变音记号
                    {focus.accidental
                      ? `，当前 ${ACCIDENTAL_NAME[focus.accidental]}`
                      : '（跟随调号）'}
                  </span>
                  <div className="v2-grid v2-grid-4">
                    {ACCIDENTAL_CHOICES.map((a) => (
                      <button
                        key={a ?? 'none'}
                        className={focus.accidental === a ? 'v2-btn is-on' : 'v2-btn'}
                        onClick={() => setScore(setAccidental(score, focus.id, a))}
                        title={a ? `${ACCIDENTAL_NAME[a]}半音` : '去掉记号，跟随调号'}
                      >
                        {a ? ACCIDENTAL_GLYPH[a] : '本位'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="v2-field">
                  {/*
                    转调：演奏到此音起，后面的音都改用这个调。
                    下拉框给常用调（五度圈 15 个，含升降），不用手打、也不怕写错。
                  */}
                  <span className="v2-field-label">转调（演奏到此音起改用新调，选第一项清除）</span>
                  <select
                    className="v2-meta-input"
                    value={focus.keyChange ?? ''}
                    onChange={(e) =>
                      setScore(setKeyChange(score, focus.id, e.target.value || undefined))
                    }
                  >
                    <option value="">（不转调）</option>
                    {KEY_CHOICES.map((k) => (
                      <option key={k} value={k}>
                        转{k}
                      </option>
                    ))}
                    {focus.keyChange && !KEY_CHOICES.includes(focus.keyChange) ? (
                      <option value={focus.keyChange}>转{focus.keyChange}</option>
                    ) : null}
                  </select>
                </div>
                <div className="v2-field">
                  {/*
                    倚音：不占时值，挂在主音上。1 颗 = 单倚音，2 颗以上 = 复倚音。
                    录制顺序按谱面念法：勾前 / 后（互斥）→ 点格子 → 在下面的输入框里点音符。
                    播放时前倚音吃主音开头、后倚音吃结尾，各切 1/4 拍。
                  */}
                  <span className="v2-field-label">倚音（不占时值，最多 3 颗）</span>
                  <div className="v2-grace-bar">
                    <label className="v2-grace-check" title="勾上 = 这三格是前倚音">
                      <input
                        type="checkbox"
                        checked={graceSide === 'before'}
                        onChange={() => pickGraceSide('before')}
                      />
                      前
                    </label>
                    {GRACE_SLOTS.map((i) => {
                      const g = graceList[i];
                      return (
                        <button
                          key={i}
                          className={`v2-grace-slot ${g ? 'is-filled' : ''} ${
                            graceSlot === i ? 'is-open' : ''
                          }`}
                          title={g ? '点击修改这一颗' : '点击输入这一颗'}
                          onClick={() => openGraceSlot(i)}
                        >
                          {g ? (
                            <NotationGlyph
                              degree={g.degree}
                              dots={g.octave}
                              accidental={g.accidental}
                            />
                          ) : null}
                        </button>
                      );
                    })}
                    <label className="v2-grace-check" title="勾上 = 这三格是后倚音">
                      <input
                        type="checkbox"
                        checked={graceSide === 'after'}
                        onChange={() => pickGraceSide('after')}
                      />
                      后
                    </label>
                    <button
                      className="v2-btn"
                      disabled={graceList.length === 0}
                      title="删除这个音上的全部倚音（前后两侧都清）"
                      onClick={clearGrace}
                    >
                      清除
                    </button>
                  </div>
                  {graceSlot !== null ? (
                    <div className="v2-grace-picker">
                      {GRACE_ROWS.map((row) => (
                        <div key={row.name} className="v2-grace-row" title={row.name}>
                          {GRACE_KEYS.map((key) => (
                            <button
                              key={`${row.octave}-${key.degree}-${key.accidental ?? ''}`}
                              className="v2-btn v2-grace-key"
                              onClick={() => putGrace(row.octave, key)}
                            >
                              <NotationGlyph
                                degree={key.degree}
                                dots={row.octave}
                                accidental={key.accidental}
                              />
                            </button>
                          ))}
                        </div>
                      ))}
                      <div className="v2-grace-foot">
                        <span className="v2-hint">正在输入第 {graceSlot + 1} 格</span>
                        <span className="v2-grace-foot-btns">
                          {graceList[graceSlot] ? (
                            <button className="v2-btn" onClick={clearGraceSlot}>
                              清空本格
                            </button>
                          ) : null}
                          {graceSide && graceList.length > 0 ? (
                            <button
                              className="v2-btn"
                              title="把这几颗倚音还原成普通音符（各 1 拍）"
                              onClick={() => setScore(dropGrace(score, focus.id, graceSide))}
                            >
                              还原成音符
                            </button>
                          ) : null}
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
                {/*
                  时值 + 附点合并成一排：时值组内单选（点亮的再点一次回到 1 拍），
                  附点组内单选（点亮的再点一次 = 无）。两组互不干预。
                  与休止符分支共用同一个组件——休止符的时值设定和音符完全一样。
                */}
                <DurationDotsField
                  focus={focus}
                  tiers={tiers}
                  useTier={useTier}
                  onDot={(d) => setScore(setDot(score, focus.id, d))}
                />
                {/*
                  吐音 + 技法合成一排。同一类内互斥：一个音同时只有一种技法、
                  一种吐音（T 与 K 也互斥）；符号在音符上方横向排列。
                */}
                <div className="v2-field">
                  <span className="v2-field-label">气息与技法（标在音符上方）</span>
                  <div className="v2-grid v2-grid-4">
                    {/* 换气 V 固定第一排第一个。黄边一组 = 演奏时舌头 / 换气的小动作，
                        其余技法走默认配色，点亮后统一加深 */}
                    <button
                      className={`v2-btn v2-btn-breath ${
                        (focus.techniques ?? []).includes('breath') ? 'is-on' : ''
                      }`}
                      onClick={() => setScore(toggleTechnique(score, focus.id, 'breath'))}
                      title="换气，谱面标作 V"
                    >
                      换气 V
                    </button>
                    <button
                      className={`v2-btn v2-btn-breath ${focus.tongue === 'T' ? 'is-on' : ''}`}
                      onClick={() =>
                        setScore(setTongue(score, focus.id, focus.tongue === 'T' ? undefined : 'T'))
                      }
                      title="单吐"
                    >
                      单吐 T
                    </button>
                    <button
                      className={`v2-btn v2-btn-breath ${focus.tongue === 'K' ? 'is-on' : ''}`}
                      onClick={() =>
                        setScore(setTongue(score, focus.id, focus.tongue === 'K' ? undefined : 'K'))
                      }
                      title="双吐的第二音"
                    >
                      双吐 K
                    </button>
                    <button
                      className={`v2-btn v2-btn-breath ${
                        (focus.articulations ?? []).includes('staccato') ? 'is-on' : ''
                      }`}
                      onClick={() => setScore(toggleArticulation(score, focus.id, 'staccato'))}
                      title="断音 / 顿音，谱面标作小圆点"
                    >
                      断音 ·
                    </button>
                    <button
                      className={focus.fermata ? 'v2-btn is-on' : 'v2-btn'}
                      onClick={() => setScore(setFermata(score, focus.id))}
                      title="延长音，谱面标作 ⌒ 加点"
                    >
                      延长音
                    </button>
                    {Object.entries(TECHNIQUE_GLYPH)
                      .filter(([value]) => value !== 'breath')
                      .map(([value, g]) => (
                        <button
                          key={value}
                          className={
                            (focus.techniques ?? []).includes(value) ? 'v2-btn is-on' : 'v2-btn'
                          }
                          onClick={() => setScore(toggleTechnique(score, focus.id, value))}
                          title={`${g.label}，谱面标作 ${g.mark}`}
                        >
                          {g.label}
                        </button>
                      ))}
                  </div>
                </div>
                <div className="v2-field">
                  {/*
                    力度跟音符绑定（画在音符下方），不再是插在缝隙里的独立事件：
                    按钮即开关，点亮的再点一次就去掉。
                  */}
                  <span className="v2-field-label">力度 · 渐强渐弱（标在音符下方）</span>
                  <div className="v2-grid v2-grid-4">
                    {DYNAMICS.map((v) => (
                      <button
                        key={v}
                        className={focus.dynamic === v ? 'v2-btn is-on' : 'v2-btn'}
                        onClick={() => setScore(setNoteDynamic(score, focus.id, v))}
                        title={focus.dynamic === v ? '再点一次去掉' : `标 ${v}`}
                      >
                        {v}
                      </button>
                    ))}
                    <button
                      className={focus.hairpin === 'cresc' ? 'v2-btn is-on' : 'v2-btn'}
                      onClick={() => setScore(setHairpin(score, focus.id, 'cresc'))}
                      title="渐强，再点一次去掉"
                    >
                      渐强
                    </button>
                    <button
                      className={focus.hairpin === 'dim' ? 'v2-btn is-on' : 'v2-btn'}
                      onClick={() => setScore(setHairpin(score, focus.id, 'dim'))}
                      title="渐弱，再点一次去掉"
                    >
                      渐弱
                    </button>
                  </div>
                </div>
              </>
            ) : focus && focus.kind === 'rest' ? (
              <>
                <div className="v2-field">
                  <span className="v2-field-label">休止符，点音级可转成音符</span>
                  <div className="v2-grid v2-grid-7">
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <button
                        key={d}
                        className="v2-btn"
                        onClick={() => setScore(setDegree(score, focus.id, d))}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
                {/* 休止符的时值 / 附点与音符完全同一套：0. = 1.5 拍休止 */}
                <DurationDotsField
                  focus={focus}
                  tiers={tiers}
                  useTier={useTier}
                  onDot={(d) => setScore(setDot(score, focus.id, d))}
                />
              </>
            ) : (
              <p className="v2-hint">
                {focus
                  ? `当前是${eventLabel(focus)}，可以用 Delete 删除。`
                  : '点谱面上的音符来修改，或直接按 1-7 输入。'}
              </p>
            )}
          </div>

          {pending ? (
            <div className="v2-side-block">
              <div className="v2-side-title">选择划分（{pending.ids.length} 个音）</div>
              {/*
                候选不用文字描述，直接画出选中音符的实际样子——
                每个方案一排记号（选中什么音就画什么音，休止符画 0），
                连音方案带标号。文字标签降级为悬停提示。
              */}
              <ul className="v2-diag">
                {pending.cands.map((c, i) => {
                  const degrees = pending.ids.map((id) => {
                    const e = score.events.find((x) => x.id === id);
                    return e && e.kind === 'note' ? e.degree : 0;
                  });
                  return (
                    <li key={i}>
                      <button
                        className="v2-btn v2-cand"
                        title={c.label}
                        onClick={() => {
                          const next = applyTierOp(score, pending.ids, pending.ticks, c.ticks, c.tuplet);
                          if (next) commit({ ...snap, score: next });
                          setPending(null);
                        }}
                      >
                        <GroupGlyph
                          degrees={degrees}
                          beams={c.ticks.map((t) =>
                            c.tuplet ? tupletBeamCount(pending.ticks, c.tuplet) : beamCount(t),
                          )}
                          tuplet={c.tuplet}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button className="v2-btn" onClick={() => setPending(null)}>
                取消
              </button>
            </div>
            ) : null}
        </aside>
      </div>
    </div>
  );
}

/**
 * 曲目信息输入框（名称 / 调号 / 拍号 / 速度 / 音色）。
 *
 * **即时生效**：合法值每敲一个字符就 commit，不等失焦——
 * 改完立刻能在谱面标题块上看到结果。
 *
 * 但聚焦期间显示的是本地草稿，不是外部值：调号有格式校验，
 * 若直接显示外部值，打到「1=bB」的中间态「1」会被 setMeta 拒掉，
 * 受控输入弹回旧值，用户根本打不完。聚焦时放宽、失焦时对齐。
 */
function MetaInput({
  label,
  value,
  onCommit,
  type = 'text',
  min,
  max,
  placeholder,
}: {
  label: string;
  value: string | number;
  onCommit: (v: string) => void;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  const external = String(value);
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(external);

  const tryCommit = (raw: string) => {
    if (type !== 'number') {
      onCommit(raw);
      return;
    }
    if (raw.trim() === '') return; // 数字框清空的瞬间不当作 0
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    onCommit(String(Math.min(max ?? n, Math.max(min ?? n, n))));
  };

  return (
    <label className="v2-meta-row">
      <span className="v2-meta-label">{label}</span>
      <input
        className="v2-meta-input"
        type={type}
        min={min}
        max={max}
        placeholder={placeholder}
        value={focused ? draft : external}
        onFocus={() => {
          setFocused(true);
          setDraft(external);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          tryCommit(e.target.value);
        }}
        onBlur={() => {
          setFocused(false);
          setDraft(external);
        }}
      />
    </label>
  );
}

/** 下拉框型的曲目信息项（调号）。选项外的值（旧谱 / 手输）会排在最前，不丢 */
function MetaSelect({
  label,
  value,
  options,
  onCommit,
}: {
  label: string;
  value: string;
  options: string[];
  onCommit: (v: string) => void;
}) {
  const external = String(value);
  const opts = options.includes(external) ? options : [external, ...options];
  return (
    <label className="v2-meta-row">
      <span className="v2-meta-label">{label}</span>
      <select
        className="v2-meta-input"
        value={external}
        onChange={(e) => onCommit(e.target.value)}
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * 组划分候选的预览：按**谱面的实际画法**渲染——
 * 减时线在组内连成横线（第 lv 层线从第一个带 lv+1 条线的音连到最后一个），
 * 连音在上方画断弧、断口里坐标号。与 canvas 的 BeatGroup / tuplet 绘制同构。
 */
function GroupGlyph({
  degrees,
  beams,
  tuplet,
}: {
  degrees: number[];
  /** 每个音的减时线条数 */
  beams: number[];
  tuplet?: number;
}) {
  const max = Math.max(0, ...beams);
  const n = degrees.length || 1;
  return (
    <span className="v2-ggroup">
      {tuplet ? (
        <span className="v2-ggroup-arc">
          <i className="v2-ggroup-tuplet">{tuplet}</i>
        </span>
      ) : null}
      <span className="v2-ggroup-row">
        {degrees.map((d, j) => (
          <span key={j} className="v2-ggroup-note">
            {d}
          </span>
        ))}
        {Array.from({ length: max }, (_, lv) => {
          // 同一层级的线按「连续段」分段画：1/4+1/2+1/4 的二级线是
          // 两侧各一段短线，中间的八分音只有一级——不能一条线穿过去
          const idx = beams.map((b, j) => (b > lv ? j : -1)).filter((j) => j >= 0);
          const runs: number[][] = [];
          for (const j of idx) {
            const last = runs[runs.length - 1];
            if (last && j === last[last.length - 1] + 1) last.push(j);
            else runs.push([j]);
          }
          // 与 canvas 一致：一级线贴着音符，级别越大越往下（短线在长线下方）
          return runs.map((run, k) => {
            const from = run[0];
            const to = run[run.length - 1];
            const left = (from + 0.18) / n;
            const width = ((to - from + 0.64) / n) * 100;
            return (
              <i
                key={`${lv}-${k}`}
                className="v2-ggroup-beam"
                style={{ left: `${left * 100}%`, width: `${width}%`, bottom: (max - 1 - lv) * 5 + 1 }}
              />
            );
          });
        })}
      </span>
    </span>
  );
}

/**
 * 倚音录入框的音级键（三排共用）：`1 #1 2 #2 3 4 #4 5 #5 6 #6 7`。
 * 三排分别是高八度 / 正常 / 低八度，所以这里只管音级与变音记号。
 */
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

/** 三格录入框（单倚音 / 复倚音，最多三颗） */
const GRACE_COUNT = 3;
const GRACE_SLOTS = Array.from({ length: GRACE_COUNT }, (_, i) => i);

/** 附点按钮的基准时值：带点按点数还原；不带点归一到「加点前基准」（0/2- → 48） */
function dotBase(focus: { ticks: number; dot?: 0 | 1 | 2 }): number {
  const dot = focus.dot ?? 0;
  if (dot > 0) return undotTicks(focus.ticks, dot);
  return canonicalDurationBase(focus.ticks) ?? focus.ticks;
}

/**
 * 时值档位 + 附点：音符与休止符共用——休止符的时值设定和音符完全一样
 * （`0-`、`0/2`、`0.` 都是合法写法），休止符用 0 当音级。
 */
function DurationDotsField({
  focus,
  tiers,
  useTier,
  onDot,
}: {
  focus: { ticks: number; dot?: 0 | 1 | 2; degree?: number };
  tiers: { label: string; ticks: number }[];
  useTier: (ticks: number) => void;
  onDot: (dots: 0 | 1 | 2) => void;
}) {
  const degree = focus.degree ?? 0;
  return (
    <div className="v2-field">
      <span className="v2-field-label">时值（再点一次取消，回到 1 拍）· 附点</span>
      <div className="v2-grid v2-grid-5">
        {tiers.map((t) => {
          const active = undotTicks(focus.ticks, focus.dot ?? 0) === t.ticks;
          return (
            <button
              key={t.label}
              className={active ? 'v2-btn is-on' : 'v2-btn'}
              onClick={() => useTier(active ? TICKS_PER_BEAT : t.ticks)}
              title={t.label}
            >
              {/*
                一拍以内用减时线画（1/2 拍 = 数字下一条横线），
                一拍以上用增时线写（2 拍 = 3-）——各自本来的样子
              */}
              {t.ticks < TICKS_PER_BEAT ? (
                <NotationGlyph degree={degree} beams={beamCount(t.ticks)} />
              ) : (
                renderNoteToken(degree, t.ticks)
              )}
            </button>
          );
        })}
        {([1, 2] as const).map((d) => (
          <button
            key={d}
            /* 附点是「装饰记号」不是时值本身，配色要和左边的时值档位区分开 */
            className={`v2-btn v2-btn-orn ${(focus.dot ?? 0) === d ? 'is-on' : ''}`}
            onClick={() => onDot((focus.dot ?? 0) === d ? 0 : d)}
            title={`${d} 个附点`}
          >
            {/* 显示成「音符后加点」。一拍以内画实际样子（数字 + 减时线 + 右侧的点），
                与左边时值按钮同构——写成 DSL 文本会出现 1./4 这种没人读得懂的东西。
                先把当前时值归一到加点前基准（0/2- 这类 1.5 拍写法的基准是一拍），
                所以 1.5 拍的休止符显示 0. / 0..，而不是拼出非法的 0/2-. */}
            {(() => {
              const b = dotBase(focus);
              return b < TICKS_PER_BEAT ? (
                <span className="v2-dotglyph">
                  <NotationGlyph degree={degree} beams={beamCount(b)} />
                  <span className="v2-dotglyph-dot">{'.'.repeat(d)}</span>
                </span>
              ) : (
                renderNoteToken(degree, withDots(b, d), d)
              );
            })()}
          </button>
        ))}
      </div>
    </div>
  );
}

function eventLabel(e: Event): string {
  switch (e.kind) {
    case 'note':
      return e.octave === 0
        ? `音符 ${e.degree}`
        : `音符 ${octaveName(e.octave)}${e.degree}`;
    case 'rest':
      return '休止符';
    case 'barline':
      return '小节线';
    case 'directive':
      return `指示 ${e.value}`;
    default:
      return '记号';
  }
}

function trimTick(tick: number): string {
  const beats = tick / TICKS_PER_BEAT;
  return Number.isInteger(beats) ? String(beats) : beats.toFixed(1);
}

function emptyScore(): Score {
  return {
    version: 2,
    meta: { title: '未命名曲谱', key: '1=C', beat: '4/4', bpm: 90, patch: 73 },
    events: [],
    groups: [],
  };
}