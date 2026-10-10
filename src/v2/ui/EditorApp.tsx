import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import molihua from '../../scores/molihua.jps?raw';
import molihuaRepeat from '../../scores/molihua-repeat.jps?raw';
import songbie from '../../scores/songbie.jps?raw';
import huanlesong from '../../scores/huanlesong.jps?raw';
import qinghuaci from '../../scores/qinghuaci.jps?raw';
import xiaoxingxing from '../../scores/xiaoxingxing.jps?raw';
import ensembleDemo from '../../scores/ensemble-demo.jps?raw';
import notationPhase2Demo from '../../scores/notation-phase2-demo.jps?raw';
import lyricsDemo from '../../scores/lyrics-demo.jps?raw';
import quartetDemo from '../../scores/quartet-demo.jps?raw';
import { meterAt } from '../meter';
import type { LayoutOptions, LayoutResult } from '../layout';
import { deleteLyricPosition, insertLyricGap, lyricTrackNames, writeLyricInput } from '../lyrics';
import {
  annotationTextOf,
  parenFlagsOf,
  setTextAnnotation,
  toggleParen,
} from '../edit';
import { HelpDialog } from './HelpCenter';
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
  setHairpinRange,
  setBarNotation,
  extendPrev,
  insertNote,
  insertRest,
  setBarlineRepeat,
  setBarlineStyle,
  setBarlineVolta,
  setBarlineVoltaOpen,
  setVoltaFromSelection,
  toggleJumpAfterBarline,
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
  setRepeatTimes,
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
import { DEFAULT_META, parseDsl, renderNoteToken, serializeDsl } from '../dsl';
import {
  fromText,
  nameOf,
  openScoreViaDialog,
  saveBytesAsFile,
  saveScore,
  type OpenResult,
} from '../io';
import { ACCIDENTAL_GLYPH, TECHNIQUE_GLYPH } from '../paint';
import { loadSession, saveSession } from '../session';
import { beamCount, durationTiers, TICKS_PER_BEAT, tupletBeamCount, undotTicks, withDots } from '../ticks';
import { expandScore, measureAt } from '../expand';
import {
  audioKey,
  clearAlign,
  getAudio,
  loadAlign,
  putAudio,
  saveAlign,
  type AlignPersist,
} from './alignStore';
import { ensureMp3 } from '../mp3';
import { shouldWaitForAudio } from './playGate';
import {
  buildTimeline,
  playOrderMeasures,
  tickAtEvent,
  timelineTicks,
} from '../timeline';
import type { Accidental, BarlineEvent, BeatGroup, Degree, Event, GraceNote, JumpMark, Score } from '../types';
import { constantTempo, curveFromAnchors, secToTick, tempoFromAlign, tickToSec, type TempoMap } from '../tempo';
import { detectVocalEntry, estimateTempoOfBuffer, scoreNoteOnsets, type TempoEstimate } from '../beat';
import { AudioPreview } from '../audio';
import AudioWaveform from './AudioWaveform';
import { isTimed } from '../types';
import { validateGroups } from '../validate';
import { ScoreCanvas, type ScorePick } from './ScoreCanvas';
import { LibraryScreen } from './LibraryScreen';
import { LibrarySetupDialog } from './LibrarySetupDialog';
import { initStore } from './storeInit';
import { defaultLibraryPath, isLibraryConfigured, onStoreBackendChange } from './storeBackend';
import { isTauri } from '../io';
import { DiscoverScreen } from './DiscoverScreen';
import { ExportDialog } from './ExportDialog';
import { buildPack, packFileName } from './packBundle';
import { upsertLibrary, type LibraryItem } from './libraryStore';
import { assembleParts, partScore, replacePart, scoreParts } from '../parts';
import { PartsPanel } from './PartsPanel';

/** 变音记号按钮：本位（无记号）在前，其余按升降序 */
const ACCIDENTAL_CHOICES: (Accidental | undefined)[] = [undefined, '#', 'b', '♮'];
/** 播放界面的空选区：引用必须稳定，内联 new Set() 每次渲染都会触发整谱重排 */
const EMPTY_SELECTED: ReadonlySet<string> = new Set();
const ACCIDENTAL_NAME: Record<Accidental, string> = { '#': '升', b: '降', '♮': '还原' };

/** 力度档位，由弱到强 */
const DYNAMICS = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];

/**
 * 恒定 BPM 三参数的默认值。换谱 / 新建时一律回到它——
 * 不重置的话，上一首的 BPM / 相位 / 原点会残留到新谱上：
 * 新音频估测不自信时（设计上不写入）界面显示的就是上一首的旧值
 */
const DEFAULT_TEMPO_DRAFT = { bpm: 108, phaseSec: 0.31, originBeat: 36 };

/** 秒 → m:ss.s（界面上说人话用，不暴露「相位」这类术语） */
function fmtClock(sec: number): string {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.max(0, sec) - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** 校验违反的人话分类——I1/I3 这类内部代号用户看不懂，翻成是哪类问题 */
const VIOLATION_LABEL: Record<string, string> = {
  I1: '拍内组',
  I2: '拍内组超一拍',
  I3: '拍内组',
  I4: '时值粒度',
  I5: '连线',
  E1: '数据',
  E2: '数据',
  R1: '反复',
  R2: '反复',
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
  { name: '茉莉花（反复）', text: molihuaRepeat },
  { name: '送别', text: songbie },
  { name: '欢乐颂', text: huanlesong },
  { name: '小星星', text: xiaoxingxing },
  { name: '青花瓷', text: qinghuaci },
  { name: '欢乐颂（二重奏示例）', text: ensembleDemo },
  { name: '拍号与力度范围（重奏示例）', text: notationPhase2Demo },
  { name: '多段歌词（重奏示例）', text: lyricsDemo },
  { name: '小星星（四声部示例）', text: quartetDemo },
];

/** 播放页观看偏好的本地存取（字号 / 字距；null = 跟随谱面） */
function readPlayViewPref(): { font: number | null; gap: number | null } {
  try {
    const v = JSON.parse(localStorage.getItem('ws-playview') ?? 'null') as {
      font?: number | null;
      gap?: number | null;
    } | null;
    if (!v) return { font: null, gap: null };
    return {
      font: typeof v.font === 'number' ? v.font : null,
      gap: typeof v.gap === 'number' ? v.gap : null,
    };
  } catch {
    return { font: null, gap: null };
  }
}
const playViewPref = readPlayViewPref();

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
  partId?: string;
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
/*
 * 应用入口（HTML 的 body[data-entry]）：
 *   app     — 内嵌模式（各段切换都在）
 *   editor  — 简谱编辑：记谱
 *   align   — 动态谱生成：配伴奏与对齐
 *   library — 曲库管理单功能页（可编辑曲库）
 *   play    — 动态谱演奏：曲库查询 + 播放（不导入 / 不打包 / 不删除）
 * 编辑、生成与曲库单功能页显示左上角「返回首页」。
 */
export type Entry = 'app' | 'editor' | 'align' | 'library' | 'play';

export function EditorApp({ entry = 'app' }: { entry?: Entry }) {
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
  const [helpOpen, setHelpOpen] = useState(false);
  const [lyricSelection, setLyricSelection] = useState<{ partId: string; verse: number; session: number } | null>(null);
  const [totalView, setTotalView] = useState(true);
  /**
   * 顶层模式：
   *   「记谱」写谱（新建 / 打开 / 保存）
   *   「对轨」配伴奏并对齐节奏（只做打包——把整首存成压缩包）
   *   「曲库」管一批谱（导入压缩包建库 / 打包导出）
   *   「播放」只放不编：简谱显示 + 伴奏播放（从曲库点一首进来就是它）
   * 各屏任务粒度完全不同，工具也彻底分开。
   * 单功能页（entry ≠ app）直接落在自己那一屏，也不显示模式开关。
   * 模式记忆到 localStorage，只在 app 入口生效。
   */
  const [mode, setMode] = useState<'score' | 'align' | 'library' | 'play' | 'discover'>(() => {
    if (entry === 'play') return 'discover'; // 独立入口：首屏是动态谱首页，点歌才进播放
    if (entry !== 'app') {
      return entry === 'library' ? 'library' : entry === 'align' ? 'align' : 'score';
    }
    const saved = localStorage.getItem('ws-mode');
    return saved === 'align' || saved === 'library' || saved === 'play' ? saved : 'score';
  });
  useEffect(() => {
    localStorage.setItem('ws-mode', mode);
    if (mode === 'align' && view === 'source') setView('score'); // 对轨只认谱面视图
    // 离开对轨 = 退出配对：不然回到记谱模式，光标还是绑定样式、
    // 小节线上还挂着靶标，点一条线会莫名其妙绑个锚点
    if (mode !== 'align') {
      setWavePos(null);
      setWaveBeat(null);
    }
  }, [mode, view]);
  /** 复制粘贴的剪贴板：选区事件的深拷贝（粘贴时由 pasteEvents 重新生成 id） */
  const [clip, setClip] = useState<Event[]>([]);
  const [clipGroups, setClipGroups] = useState<BeatGroup[]>([]);
  /**
   * 播放指示方式：
   *   head = 跟着当前音跳的色块 + 平滑横移的竖线（旧方式）
   *   band = 从当前行行首开始、随音乐不断变宽的高亮条（更好跟）
   *   ball = 发光小球拖着渐变尾巴、按抛物线轨迹逐音跳跃（深色发光、浅色彩色点+阴影）
   * 存 localStorage：播放页（动态谱演奏 / 曲库播放）的观众设一次就长期有效
   */
  const [playStyle, setPlayStyle] = useState<'head' | 'band' | 'ball'>(() => {
    try {
      const v = localStorage.getItem('ws-playstyle');
      return v === 'band' || v === 'ball' ? v : 'head';
    } catch {
      return 'head';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('ws-playstyle', playStyle);
    } catch {
      /* 隐私模式等存不了就算了 */
    }
  }, [playStyle]);
  /** 对轨页「音轨分离工具下载」的说明弹窗 */
  const [tramaOpen, setTramaOpen] = useState(false);
  /**
   * 播放页的观看偏好：字号 / 字距（覆盖谱面自带设置；null = 跟随谱面）。
   * 存 localStorage——play.html 的观众（看谱的人）设一次就长期有效，
   * 且只影响播放界面的显示，谱面文件本身一个字节都不动。
   */
  const [playFont, setPlayFont] = useState<number | null>(() => playViewPref.font);
  const [playGap, setPlayGap] = useState<number | null>(() => playViewPref.gap);
  useEffect(() => {
    localStorage.setItem('ws-playview', JSON.stringify({ font: playFont, gap: playGap }));
  }, [playFont, playGap]);
  /** 工具栏正中的谱面校验明细是否展开 */
  const [checkOpen, setCheckOpen] = useState(false);
  /**
   * 「先配置曲库位置」引导窗：进入曲库管理或动态谱演奏首页时，
   * 若曲库位置还没配置（exe 首次运行没选目录且数据目录为空 / Web 没选过文件夹）就弹。
   * storeReady = 存储探测完成，在此之前不弹（exe 启动瞬间探测还没回来，别闪窗）。
   */
  const [storeReady, setStoreReady] = useState(false);
  const storeReadyRef = useRef(false);
  const [setupOpen, setSetupOpen] = useState(false);
  useEffect(() => {
    void initStore().then(() => {
      storeReadyRef.current = true;
      setStoreReady(true);
      setSetupOpen(!isLibraryConfigured());
    });
    const recheck = (): void => {
      if (storeReadyRef.current) setSetupOpen(!isLibraryConfigured());
    };
    return onStoreBackendChange(recheck);
  }, []);
  useEffect(() => {
    // 进曲库管理 / 演奏首页时再查一次（配置好之前每次进入都提醒）
    if ((mode === 'discover' || mode === 'library') && storeReadyRef.current) {
      setSetupOpen(!isLibraryConfigured());
    }
  }, [mode, storeReady]);
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
  /**
   * 编辑视图的横向密度（每 tick 像素宽）。曾经是界面滑杆「音符间距」，因与
   * 曲目信息里跟谱保存的「字间距」（@space）语义重叠、且不随文件走，已按
   * 用户要求移除控件——密度固定为 0.70（沿用原默认值，视觉不变）。
   * 想调谱面本身的间距请用曲目信息面板的「字间距」。
   */
  const EDITOR_UNIT = 0.7;
  /** 源码面板默认只读。主编辑路径是点选 + 键盘 + 属性面板。 */

  const [msg, setMsg] = useState('');
  const dslRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const clockRef = useRef<BeatClock>(new Clock(90));
  const playerRef = useRef<Player>(new Player());
  const [playing, setPlaying] = useState(false);

  // ─────────── 音频对齐（M9/M11）：真实音频 + TempoMap 驱动指示条 ───────────
  const [stems, setStems] = useState<{ name: string; buffer: AudioBuffer; on: boolean }[]>([]);
  /** align.json 里的 curve 形式（变速歌）；恒定歌走下面三个标量 */
  const [tempoOverride, setTempoOverride] = useState<TempoMap | null>(null);
  /** 恒定 BPM 三参数：BPM / 音频网格相位 / 谱面原点（拍） */
  const [tempoDraft, setTempoDraft] = useState({ ...DEFAULT_TEMPO_DRAFT });
  /**
   * 当前已对准的谱面拍（「对准这里」/ 绑定锚点时记下）。
   * ÷2 / ×2 缩放速度时**以它为轴**——这个点的时刻保持不变，
   * 前后所有音围绕它拉伸。没有它，缩放只能以谱面第 0 拍为轴，
   * 你对准的人声位置就会被挪走（实测差 10 秒）。
   */
  const [pivotBeat, setPivotBeat] = useState(0);
  const [playSource, setPlaySource] = useState<'synth' | 'audio'>('synth');
  /**
   * 从头播放时**连伴奏前奏一起放**（默认开）：谱面记的是从进唱开始，
   * 伴奏前面那段前奏不该被跳过——跳过了就永远听不到前奏。
   */
  const [playIntro, setPlayIntro] = useState(true);
  // 音频对齐面板常驻可见（用户要求）——不再有开合状态
  /**
   * 锚点配对模式：波形上选中的音频拍（null = 未在配对）。
   * 配对中点谱面音符 → 绑成锚点，原点自动重算。
   */
  const [anchors, setAnchors] = useState<{ scoreBeat: number; audioBeat: number }[]>([]);
  /** 波形上被选为绑定起始点的位置（秒） */
  const [wavePos, setWavePos] = useState<number | null>(null);
  /** 起始点吸附到的音频拍（整拍）；关掉吸附时为 null，按精确时刻换算 */
  const [waveBeat, setWaveBeat] = useState<number | null>(null);
  /**
   * 点波形时是否吸附到最近的节奏线（默认开）。
   * 网格本身还没标准时（BPM / 相位都是猜的）吸附会把你按在错的拍上——
   * 这时关掉它，回到「人耳点的位置就是准绳」。
   */
  const [waveSnap, setWaveSnap] = useState(true);
  /**
   * 绑定成功的弹窗（toast）：几秒后自动收起，点一下也能关。
   * key 用时间戳——连续绑两个锚点时强制重新挂动画、重置计时
   */
  const [bindToast, setBindToast] = useState<{ title: string; body: string; key: number } | null>(null);
  useEffect(() => {
    if (!bindToast) return;
    const t = window.setTimeout(() => setBindToast(null), 4500);
    return () => window.clearTimeout(t);
  }, [bindToast]);
  const [previewing, setPreviewing] = useState(false);
  const previewRef = useRef<AudioPreview>(new AudioPreview());
  /**
   * 对轨页侧栏的两个页签：伴奏对轨 / 简谱编辑。
   * 听着伴奏改谱是刚需（缺前奏、缺间奏要当场补），所以编辑能力直接放进对轨页，
   * 用页签分开——两边原有的内容都不动。记忆到本地，重开停在上一回的页签。
   */
  const [alignTab, setAlignTab] = useState<'align' | 'edit'>(() =>
    localStorage.getItem('ws-align-tab') === 'edit' ? 'edit' : 'align',
  );
  /** 只有「简谱编辑」页签下谱面才吃编辑键；对轨页签下谱面只读（点小节线是绑定，不是改谱） */
  const canEditScore = mode === 'score' || (mode === 'align' && alignTab === 'edit');
  /**
   * 侧栏分流（替换掉原来按 data-mode 隐藏的 CSS 规则）：
   * 记谱屏只有编辑面板（对齐面板完全隐藏，零干扰写谱）；
   * 对轨屏按页签二选一——伴奏对轨 / 简谱编辑。
   */
  const showEditBlocks = mode !== 'align' || alignTab === 'edit';
  const showAlignBlock = mode === 'align' && alignTab === 'align';
  /** 切到编辑页签 = 退出对轨配对：不然点小节线会去绑定，而不是选中它改 */
  const switchAlignTab = useCallback((tab: 'align' | 'edit') => {
    setAlignTab(tab);
    localStorage.setItem('ws-align-tab', tab);
    if (tab === 'edit') {
      setWavePos(null);
      setWaveBeat(null);
      previewRef.current.stop();
      setPreviewing(false);
    }
  }, []);
  /**
   * 点击波形试听时放几拍就停（默认 8 拍）：找对齐点只需要听一小段，
   * 一直放会盖住后面的操作。顶栏可改，记忆到 localStorage。
   */
  const [previewBeats, setPreviewBeats] = useState(() => {
    const v = Number(localStorage.getItem('ws-preview-beats'));
    return Number.isFinite(v) && v >= 1 ? Math.min(64, Math.round(v)) : 8;
  });
  useEffect(() => {
    localStorage.setItem('ws-preview-beats', String(previewBeats));
  }, [previewBeats]);
  /**
   * 快速锚定：已知「谱面第 X 拍 = 音频第 Y 拍」时直接填。
   * 两个框会**跟着操作自动填**：点波形 → 音频拍；选中音符 → 谱面拍。
   * （早期这两个框写死 19 / 43 的示例值，点波形也不动，
   *   看上去像「怎么点都是 19 ↔ 43」，其实那只是没人管的默认值。）
   */
  const [quickAnchor, setQuickAnchor] = useState({ score: 0, audio: 0 });
  /** 导入伴奏时估出来的 BPM / 相位（见 src/v2/beat.ts） */
  const [tempoEst, setTempoEst] = useState<TempoEstimate | null>(null);
  /**
   * 跟着音乐打拍子定速度：自动测速锁错倍频（谱 8 拍对上音频 17 拍这类）时
   * 的人工补救——armed 时每按一次空格记一拍，几拍后中位数就是真实速度
   */
  const [tapping, setTapping] = useState(false);
  /** 打拍的音频时刻（秒），最多留 16 个（越靠后的间隔越稳） */
  const [taps, setTaps] = useState<number[]>([]);
  const [waveHover, setWaveHover] = useState<{ beat: number; bar: number; sec: number } | null>(null);
  const [audioMsg, setAudioMsg] = useState('');
  /** 检测到的人声进入时刻（秒）：仅在载入了人声分轨（文件名含 vocal/人声/voice）时才有值 */
  const [vocalSec, setVocalSec] = useState<number | null>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);
  /** 每条 stem 对应的 IndexedDB 存储键（与 stems 同序），持久化时写进存档 */
  const stemKeysRef = useRef<string[]>([]);
  /** 已为哪个谱面做过恢复尝试——防止恢复完成前，保存 effect 拿空状态覆盖存档 */
  const restoredRef = useRef('');
  /**
   * 正在从本地恢复伴奏（读 IndexedDB + 解码）。
   * 必须是**显式状态**：早先那个「正在从本地恢复伴奏…」是推导出来的
   * （stems 为空 && 存档声称有伴奏），伴奏没恢复成功时就永远挂着——
   * 表现就是「导入打包后一直显示恢复中」。
   */
  const [restoring, setRestoring] = useState(false);
  /**
   * 「打开」次数：每次载入谱面 +1。
   * 恢复流程的 effect 依赖它——否则**重开同一首**时 active 没变、effect 不重跑，
   * 伴奏就再也读不回来（曲库里点开刚导入的那首，正是这个症状）。
   */
  const [restoreToken, setRestoreToken] = useState(0);
  /** 本次恢复的唯一标识（谱名 + 第几次打开）：既挡 StrictMode 重跑，也用来丢弃过期结果 */
  const restoreKeyRef = useRef('');

  const stopPlay = useCallback(() => {
    playerRef.current.stop();
    clockRef.current.pause();
    clockRef.current.seek(0);
    setPlaying(false);
  }, []);

  /**
   * 自动对齐：谱面音符起拍 + 音频 onset → BPM / 相位 / **原点**一次算完（不用锚点）。
   *
   * 拆成独立函数是因为它得能**重跑**——换了一段谱、或上次没对上改了谱之后，
   * 不该逼用户重新导入一遍音频。grid 参数给导入时用（此刻 stems 状态还没更新）。
   */
  const runAutoAlign = useCallback(
    async (prefix = '', grid?: AudioBuffer, fixedBpm = 0): Promise<TempoEstimate | null> => {
      const src = grid ?? stems.reduce((a, b) => (b.buffer.duration > a.buffer.duration ? b : a), stems[0])?.buffer;
      if (!src) {
        setAudioMsg(`${prefix}先载入伴奏音频。`);
        return null;
      }
      setAudioMsg(
        `${prefix}正在自动对齐（${fixedBpm ? `按谱面速度 ${Math.round(fixedBpm)} 定相位 / 原点` : '搜 BPM / 相位 / 原点'}）…`,
      );
      await new Promise((r) => setTimeout(r, 30)); // 让上面这句先画出来
      const est = estimateTempoOfBuffer(src, {
        noteOnsets: scoreNoteOnsets(snap.score),
        scoreBeats: totalScoreBeats(snap.score),
        // 谱面自己写的速度 = 倍频歧义的先验：八分音符伴奏在真速与二倍速上
        // 都能站住网格，不把它喂进去，估测一定偏向偏快的那个
        scoreBpm: score.meta.bpm,
        ...(fixedBpm ? { fixedBpm } : {}),
      });
      setTempoEst(est);
      // 人声分轨（文件名含 vocal / 人声 / voice）：自动检测进入点，波形上画标记
      const vocalStem = stems.find((s) => /vocal|人声|voice/i.test(s.name));
      const vSec = vocalStem ? detectVocalEntry(vocalStem.buffer) : null;
      setVocalSec(vSec);
      /*
       * 采纳门槛。原来只认「相位聚拢度 R ≥ 0.15」——这条在**八分音符伴奏**上
       * 正好把正确答案卡掉：真速档有一半音落在半拍处、R 相互抵消（实测 63 BPM
       * 的 R 只有 0.002），界面于是留着上一次的旧值，看上去就是「识别错了」。
       * 改成三条任一即可：找到原点、落拍率够、或聚拢度够。
       */
      const usable =
        !!est && (est.originBeat !== null || est.hitRatio >= 0.2 || est.confidence >= 0.15);
      if (est && usable) {
        setTempoDraft((d) => ({
          ...d,
          bpm: est.bpm,
          phaseSec: est.phaseSec,
          ...(est.originBeat !== null ? { originBeat: est.originBeat } : {}),
        }));
        // 对齐成了锚点就多余了；而且锚点存的是「当前网格的拍号」，BPM 一改就失效
        if (est.originBeat !== null) setAnchors([]);
        // 顺手把**谱面速度**（@bpm）也改对：合成音模式跟伴奏一个速度才不会打架。
        // 只在「铺满整首」这条硬证据成立时才改——否则 @bpm 是先验，
        // 被一个没定案的倍速覆盖掉，下次重跑连参照都没了（撤销可还原）
        const wantBpm = Math.round(est.bpm);
        const oldBpm = Math.round(snap.score.meta.bpm);
        const decided = !!est.spanRatio && est.spanRatio >= 0.85 && est.spanRatio <= 1.3;
        let syncNote = `谱面速度 @bpm 保持 ${oldBpm}（这次没定案，先验留着下次用）。`;
        if (decided && Math.abs(wantBpm - oldBpm) >= 1) {
          setScore(setMeta(snap.score, { bpm: wantBpm }));
          syncNote = `谱面速度 @bpm 已同步 ${oldBpm} → ${wantBpm}（撤销可还原）。`;
        }
        setAudioMsg(
          `${prefix}估测 ≈${wantBpm} 拍/分（${est.confidence >= 0.5 ? '比较可信' : est.confidence >= 0.25 ? '不太有把握' : '很不可靠'}）。` +
            (est.isConstant === false ? `⚠ 疑似变速（极差 ${est.drift} BPM），请多绑对齐点。` : '') +
            (est.originBeat !== null
              ? `谱面开头 = 音频第 ${est.originBeat} 拍，点播放核对；不准就拖节奏线或打拍定速。`
              : '原点没匹配上：点节奏线 → 点谱面小节线绑一个对齐点。') +
            (vSec !== null ? `人声约 ${vSec.toFixed(1)}s 进入（紫线）。` : '') +
            syncNote,
        );
      } else {
        setAudioMsg(
          prefix +
            (est
              ? `自动测速 ≈${Math.round(est.bpm)} 拍/分，但把握不大，没有自动采用——点「跟着音乐打拍子定速度」人工定准。`
              : '这段音频没测出稳定节拍（可能太安静或太自由）——点「跟着音乐打拍子定速度」人工定。'),
        );
      }
      return est;
    },
    // setScore 声明在后面（TDZ），只在这里的函数体里用，不能进依赖数组
    [stems, snap.score],
  );

  /** 载入音频 stem（可多选；等长对齐的伴奏 / 人声一起选） */
  const onAudioPicked = useCallback(
    async (files: FileList | null) => {
      // **先同步拷贝**：onChange 里紧跟的 `e.target.value = ''` 会立刻清空
      // FileList——等解码 await 完再读 files 就是空的（实测导致持久化整个失效）
      const picked = files ? [...files] : [];
      if (picked.length === 0) return;
      try {
        // wav 先压成 mp3 再入库：本地存的、打包带走的都是 mp3（体积约 1/10），
        // 后面的键（文件名:字节数）与引用全部跟着 mp3 走，播放/打包/导入三方一致
        setAudioMsg('正在压缩 wav → mp3…（大文件要等一会儿）');
        const mp3s = await Promise.all(picked.map((f) => ensureMp3(f)));
        // 解码宿主不需要真的出声：OfflineAudioContext 最省事
        const host = new OfflineAudioContext(2, 1, 44100);
        const decoded = await Promise.all(
          mp3s.map(async (f) => ({
            name: f.name,
            buffer: await host.decodeAudioData(await f.arrayBuffer()),
            on: true,
          })),
        );
        setStems(decoded);
        // 伴奏文件本体进存储（按 文件名:字节数 去重），刷新 / 重开自动恢复
        stemKeysRef.current = mp3s.map(audioKey);
        mp3s.forEach((f) => void putAudio(audioKey(f), f));
        setPlaySource('audio'); // 载入伴奏就是为了跟伴奏，默认就切过去
        const durs = [...new Set(decoded.map((d) => d.buffer.duration.toFixed(2)))].join(' / ');
        // 用最长那条 stem（通常是完整伴奏）；鼓点最清楚的那条更准，但这里无从知道哪条是鼓
        const grid = decoded.reduce((a, b) => (b.buffer.duration > a.buffer.duration ? b : a));
        // 先让波形画出来再开跑分析：自动对齐是重活（几十 MB 音频找节拍），
        // 不让出主线程的话，setStems 触发的渲染要等它跑完才轮得到——
        // exe 上就表现为「载入了却半天不见波形」
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
        await runAutoAlign(
          `已载入 ${decoded.length} 条 stem（${durs}s）：${decoded.map((d) => d.name).join('、')}。`,
          grid.buffer,
        );
      } catch (err) {
        setAudioMsg(`音频解码失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [runAutoAlign],
  );

  // ─────────── 对齐参数持久化：按谱面自动恢复 / 保存 ───────────
  // 换谱（active 变化）时先清内存，再从存档恢复该谱上次的对齐与伴奏。
  // 启动时也走这里——刷新页面后伴奏和标定自动回来，不用重新导入
  useEffect(() => {
    // 「打开同一首」也要重新恢复：active 没变时 effect 不会重跑，
    // 于是伴奏读不回来（从曲库点开刚导进来的那首就会这样）
    const runKey = `${active}#${restoreToken}`;
    if (restoreKeyRef.current === runKey) return;
    const token = runKey;
    void (async () => {
      // 等存储后端就绪再恢复：exe 要读磁盘（数据目录里的 library.json / align.json /
      // audio/*），不等就会读到空库、恢复出「没有伴奏」的结果。
      // 放在这里等（而不是事后补跑一次）是关键：事后补跑会落在用户操作之后，
      // 把刚载入的伴奏与刚对好的标定冲掉，还重复解码一遍分轨。
      await initStore();
      // 等待期间又切了谱 / 又点了一次打开：这一轮作废
      if (restoreKeyRef.current === token) return;
      restoreKeyRef.current = token;
      restoredRef.current = active; // 保存 effect 的闸门：本谱已开始恢复
      setStems([]);
      setAnchors([]);
      setTempoOverride(null);
      setTempoEst(null);
      setVocalSec(null);
      setPlaySource('synth');
      setTempoDraft({ ...DEFAULT_TEMPO_DRAFT }); // 不留上一首的三参数
      stemKeysRef.current = [];
      // 显式的「正在恢复」标志：只在真的有伴奏要恢复时置上，
      // 由下面的 finally 负责落地。此前是推导出来的（stems 空 + 存档说有伴奏），
      // 一旦伴奏没恢复成功就永远停在「正在恢复…」上（导入打包后卡住就是这个）
      setRestoring(false);
      const saved = loadAlign(active);
      if (!saved) return;
      if (saved.audio.length > 0) setRestoring(true);
      setTempoDraft(saved.tempoDraft);
      setAnchors(saved.anchors);
      setPlaySource(saved.playSource);
      if (saved.override) {
        try {
          setTempoOverride(tempoFromAlign(saved.override as never));
        } catch {
          /* 存档里的曲线坏了就当没有 */
        }
      }
      try {
        const host = new OfflineAudioContext(2, 1, 44100);
        const files = await Promise.all(saved.audio.map((ref) => getAudio(ref.key)));
        const decoded = (
          await Promise.all(
            files.map(async (f, i) => {
              if (!f) return null;
              try {
                return {
                  name: saved.audio[i]!.name,
                  buffer: await host.decodeAudioData(await f.arrayBuffer()),
                  // 恢复上次放哪几条：上首关掉的人声，这次进来还是关掉的
                  on: saved.stemOn?.[i] ?? true,
                };
              } catch {
                return null; // 单条解码失败跳过，不挡其余的
              }
            }),
          )
        ).filter((d): d is { name: string; buffer: AudioBuffer; on: boolean } => d !== null);

        // 期间可能已经切到别的谱 / 又点了一次打开：那时这份结果是过期的，丢掉
        if (restoreKeyRef.current !== token) return;
        if (decoded.length > 0) {
          stemKeysRef.current = saved.audio.map((a) => a.key);
          setStems(decoded);
          const off = decoded.filter((d) => !d.on).length;
          setAudioMsg(
            `已恢复上次的对齐（${saved.tempoDraft.bpm} BPM · ${decoded.length} 条伴奏` +
              (off ? `，其中 ${off} 条静音` : '') +
              '），无需重新载入。',
          );
        } else {
          setStems([]);
          setAudioMsg('找到上次的对齐参数，但伴奏文件已不在本机缓存里——请重新载入音频或重新导入打包。');
        }
      } finally {
        // 无论成败都要落地这个标志，否则「正在恢复…」会一直挂着
        if (restoreKeyRef.current === token) setRestoring(false);
      }
    })();
  }, [active, restoreToken]);

  // 参数一变就落盘。两个闸门：本谱的恢复还没做过不存（防止拿空状态覆盖存档）；
  // 没有伴奏不存（纯参数改动不产生半套存档）
  useEffect(() => {
    if (restoredRef.current !== active || stems.length === 0) return;
    const data: AlignPersist = {
      version: 1,
      audio: stemKeysRef.current.map((key, i) => ({ key, name: stems[i]?.name ?? key })),
      tempoDraft,
      anchors,
      override: tempoOverride,
      playSource,
      // 放哪几条也存：下次打开（含从曲库进播放界面）就是同一套混音
      stemOn: stems.map((s) => s.on),
    };
    saveAlign(active, data);
  }, [active, stems, tempoDraft, anchors, tempoOverride, playSource]);

  /**
   * 清除本谱的音频对齐（载入的伴奏 + 锚点 + 速度标定 + 播放源）。
   * 音频文件本体不删：键是「文件名:字节数」，多首谱共享同一份，
   * 这里的清除只断开本谱的引用（下次再载入同名文件秒回，不用重新解码落盘）。
   */
  const clearAudioAlign = useCallback(() => {
    stopPlay();
    setStems([]);
    setAnchors([]);
    setTempoOverride(null);
    setTempoEst(null);
    setVocalSec(null);
    setPlaySource('synth');
    setTempoDraft({ ...DEFAULT_TEMPO_DRAFT });
    stemKeysRef.current = [];
    clearAlign(active);
    setAudioMsg('已清除本谱的伴奏与标定（音频文件保留，重载同一文件秒回）。');
  }, [active, stopPlay]);

  /**
   * 单独开关某条 stem。播放中就热切（Player 里做 30ms 平滑，不会「啪」）；
   * 没在播就只改状态，下次起播按这个开关排。
   */
  const toggleStem = useCallback(
    (index: number) => {
      setStems((list) => {
        const next = list.map((s, i) => (i === index ? { ...s, on: !s.on } : s));
        if (playerRef.current.isPlaying) playerRef.current.setStemGain(index, next[index].on ? 1 : 0);
        previewRef.current.setStemGain(index, next[index].on ? 1 : 0);
        return next;
      });
    },
    [],
  );

  /**
   * 批量设分轨开关（「全放」/「无人声」）。播放中同样热切：
   * 逐条 setStemGain 由 Player 做 30ms 平滑，不会「啪」地一声。
   */
  const setStemsOn = useCallback((pick: (name: string) => boolean) => {
    setStems((list) => {
      const next = list.map((s) => ({ ...s, on: pick(s.name) }));
      if (playerRef.current.isPlaying) {
        next.forEach((s, i) => playerRef.current.setStemGain(i, s.on ? 1 : 0));
      }
      next.forEach((s, i) => previewRef.current.setStemGain(i, s.on ? 1 : 0));
      return next;
    });
  }, []);

  /** 人声分轨的常见命名：vocal / vocals / voice / 人声 / 唱 */
  const isVocalName = (name: string): boolean => /vocal|voice|人声|演唱|唱/i.test(name);

  // 主题不再跟随系统：初始值取系统偏好，之后完全由工具栏的浅色/深色开关决定
  /**
   * 提交一次改动。参数是补丁而不是完整 Snap：
   * 调用点不用重复抄 cursor / anchor / mode，也就不容易把光标状态写丢。
   */
  const commit = useCallback(
    (next: Partial<Snap>, whole = false) => {
      setPast((p) => [...p, snap].slice(-200));
      setFuture([]);
      setSnap((s) => {
        const merged = { ...s, ...next };
        if (merged.score !== s.score && merged.score.format !== 3) merged.score = { ...merged.score, format: 3 };
        // 时值一变就重新推导拍内组：连续音加起来正好 1 拍时自动拉通减时线。
        // autoGroupBeats 只增不减且幂等，所以每次提交都跑是安全的。
        const score = merged.score === s.score ? s.score : whole
          ? merged.score.part ? assembleParts(merged.score, scoreParts(merged.score).map((p) => {
              const projected = autoGroupBeats(partScore(merged.score, p.id));
              return { ...p, events: projected.events, groups: projected.groups };
            })) : autoGroupBeats(merged.score)
          : replacePart(s.score, autoGroupBeats(merged.score));
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
      setLyricSelection(null);
      setSnap({
        score: { ...res.score, format: 3 },
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

  // 曲库存储的启动探测放在**恢复流程内部**（见 restore effect 里的 await initStore()），
  // 不再在这里「水合完再补一拍恢复」——那一拍会落在用户操作之后：
  // 把刚载入的伴奏 / 刚对好的标定与锚点又冲掉一次（exe 读盘慢，必踩），
  // 还会把分轨重复解码一遍（表现为载入音频后长时间卡住才见波形）。

  const adopt = useCallback(
    (res: OpenResult) => {
      if (!res.score) {
        setMsg(res.errors.length ? `打开失败：${res.errors[0]}` : '解析失败');
        return;
      }
      setLyricSelection(null);
      setSnap({
        score: { ...res.score, format: 3 },
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
      // 换谱面 = 换歌：旧伴奏与对轨标定作废（同 onNew），播放源回合成音
      setStems([]);
      setTempoOverride(null);
      setAnchors([]);
      setTempoEst(null);
      setPlaySource('synth');
      setTempoDraft({ ...DEFAULT_TEMPO_DRAFT });
      setAudioMsg('');
      // 换谱 = 重新走一遍恢复：同名重开时 active 没变，靠这个令牌才不会再读一次
      setRestoreToken((t) => t + 1);
    },
    [stopPlay],
  );

  const onNew = useCallback(() => {
    setLyricSelection(null);
    setSnap({ score: emptyScore(), cursor: 0, anchor: null, mode: 'insert', rev: 0 });
    setPast([]);
    setFuture([]);
    setPending(null);
    setActive('新建谱面');
    setPath(null);
    setSavedRev(0);
    setMsg('已新建空白谱面');
    stopPlay();
    // 换了谱面，旧歌的对轨标定全部作废——否则新谱还挂着旧伴奏播
    // （实测：新建谱面后一播放出来的是上一首的伴奏）。播放源回合成音。
    setStems([]);
    setTempoOverride(null);
    setAnchors([]);
    setTempoEst(null);
    setPlaySource('synth');
    setTempoDraft({ ...DEFAULT_TEMPO_DRAFT });
    setAudioMsg('');
    // 「新建谱面」是公共名字：上一首叫这个名字的谱存过的对齐不能复活
    clearAlign('新建谱面');
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
    // 顺手同步回曲库：对轨屏也能改谱（补前奏 / 间奏），
    // 只写文件不入库的话，回曲库看到的还是改前的那份。
    // 没连曲库文件夹时 upsertLibrary 返回 null，忽略即可。
    const name = cur.meta.title || active || '未命名';
    const inLibrary = upsertLibrary(name, serializeDsl(cur));
    setMsg(
      (r.path
        ? `已保存到 ${nameOf(r.path)}`
        : '已导出到浏览器下载目录（网页端拿不到文件路径）') +
        (inLibrary ? `，并更新曲库「${name}」` : ''),
    );
  }, [snap, active]);

  /**
   * 对轨界面的「打包」：当前这首 → 一个 .wspack 压缩包
   * （谱面 + 伴奏分轨 + 对轨标定）。伴奏本体从 IndexedDB 取（按存储键），
   * 标定用**此刻**的三参数与锚点——刚配好的还没落存档也要能打包走。
   */
  const packCurrent = useCallback(async () => {
    const cur = snap.score;
    const text = scoreParts(cur).some((p) => p.events.length) ? serializeDsl(cur) : '';
    if (!text) {
      setMsg('打包：当前没有谱面内容');
      return;
    }
    const name = cur.meta.title && cur.meta.title !== DEFAULT_META.title ? cur.meta.title : active;
    const audio = stemKeysRef.current.map((key, i) => ({ key, name: stems[i]?.name ?? key }));
    const files: { name: string; file: File }[] = [];
    for (const ref of audio) {
      const f = await getAudio(ref.key);
      if (f) files.push({ name: ref.name, file: f });
    }
    const align: AlignPersist = {
      version: 1,
      audio,
      tempoDraft,
      anchors,
      override: tempoOverride,
      playSource,
    };
    const bytes = await buildPack({ name, text, align, stems: files });
    const r = await saveBytesAsFile(bytes, packFileName(name));
    setMsg(
      !r.ok
        ? '打包取消'
        : `已打包 ${packFileName(name)}：谱面 + ${files.length} 条伴奏 + 标定` +
            (files.length ? '' : '（当前没有伴奏，只有谱面与标定）'),
    );
  }, [snap.score, active, stems, tempoDraft, anchors, tempoOverride, playSource]);

  /**
   * 从曲库点开一首：与 adopt 同口径（换谱即换歌，旧伴奏 / 标定作废）。
   * 点行 = 进播放界面；行里的「对轨」按钮才进编辑。
   */
  const loadLibraryItem = useCallback(
    (item: LibraryItem, target: 'play' | 'align'): boolean => {
      const res = fromText(item.text, item.name);
      if (!res.score) {
        setMsg(`${item.name} 解析失败——曲库里这份内容有问题，建议删除后重新导入`);
        return false;
      }
      adopt(res);
      setMode(target);
      return true;
    },
    [adopt],
  );
  const playLibraryItem = useCallback(
    (item: LibraryItem) => {
      loadLibraryItem(item, 'play');
    },
    [loadLibraryItem],
  );
  const editLibraryItem = useCallback(
    (item: LibraryItem) => {
      if (entry === 'app') { loadLibraryItem(item, 'align'); return; }
      const res = fromText(item.text, item.name);
      if (!res.score) { setMsg(`${item.name} 解析失败，请先修正谱面`); return; }
      saveSession({ text: item.text, name: res.name, path: null });
      window.location.href = './align.html';
    },
    [entry, loadLibraryItem],
  );

  const documentScore = snap.score;
  const activePartId = scoreParts(documentScore).find((p) => p.id === snap.partId)?.id ?? scoreParts(documentScore)[0].id;
  const score = useMemo(() => partScore(documentScore, activePartId), [documentScore, activePartId]);
  const lyricVerse = lyricSelection?.partId === activePartId && lyricSelection.verse < lyricTrackNames(score).length ? lyricSelection.verse : null;
  const canEditConductor = !documentScore.part || activePartId === documentScore.part.id;
  /** 播放页生效的字号 / 字距：观看偏好优先，没设过就跟随谱面自带设置 */
  const effFont = playFont ?? (score.meta.fontSize ?? 21);
  const effGap = playGap ?? (score.meta.letterSpacing ?? 0);
  /** 有未保存的改动 */
  const dirty = snap.rev !== savedRev;
  const serialized = useMemo(() => (documentScore.format === 3 || scoreParts(documentScore).some((p) => p.events.length) || documentScore.part ? serializeDsl(documentScore) : ''), [documentScore]);
  const violations = useMemo(() => validateGroups(documentScore), [documentScore]);

  const audioTempo = useMemo<TempoMap | null>(() => {
    // ≥2 个锚点 → 分段线性变速曲线（前奏长度不一致就靠它拉伸对齐）
    if (anchors.length >= 2) {
      try {
        let ticks = 0;
        for (const e of score.events) if (isTimed(e)) ticks += e.ticks;
        return curveFromAnchors(anchors, {
          bpm: tempoDraft.bpm,
          phaseSec: tempoDraft.phaseSec,
          totalBeats: ticks / TICKS_PER_BEAT,
        });
      } catch {
        // 锚点钉反了等：退回下面的常量路线，错误信息已在绑定时报过
      }
    }
    if (tempoOverride) return tempoOverride;
    try {
      return constantTempo(tempoDraft.bpm, tempoDraft.phaseSec, tempoDraft.originBeat);
    } catch {
      return null;
    }
  }, [anchors, tempoDraft, tempoOverride, score]);
  const audioReady = stems.length > 0 && audioTempo !== null;

  /**
   * 两点实测速度：两个锚点之间，谱面走了 Δ拍、音频用了 Δ秒 → 真实 BPM。
   * 起点钉对了却还在飘，看这个数跟面板里填的差多少就知道差多少速度。
   */
  const impliedBpm = useMemo(() => {
    if (anchors.length < 2) return null;
    const s = [...anchors].sort((a, b) => a.scoreBeat - b.scoreBeat);
    const a = s[0];
    const b = s[s.length - 1];
    const dt = ((b.audioBeat - a.audioBeat) * 60) / tempoDraft.bpm;
    const db = b.scoreBeat - a.scoreBeat;
    if (dt <= 0 || db <= 0) return null;
    return Math.round(((db * 60) / dt) * 10) / 10;
  }, [anchors, tempoDraft.bpm]);

  /**
   * 把音频速度整体乘 k（÷2 / ×2 / 用两点实测值），**以已绑定的锚点为轴**。
   *
   * 「谱面跑得太快」最常见的一因是估成倍速：细网格是粗网格的超集，相位聚拢度
   * 天然偏快，谱面与音频又没匹配上（自动对齐没成），没人来纠正，只能靠人判断。
   *
   * 缩放时锚点与原点必须**按同一条不变量**换算：映射是
   * `t(拍) = 相位 + (原点 + 拍) × 60/BPM`。要让某个谱面拍 pivot 的时刻不变，
   * 需要 `原点' = k × 原点 + (k − 1) × pivot`——
   * 只把原点乘 k 等于以「谱面第 0 拍」为轴，锚点在第 19 拍时映射会整体挪掉十几秒。
   */
  const rescaleTempo = useCallback(
    (k: number, note: string) => {
      // 轴 = 你最后一次对准的那个谱面拍（对准这里 / 绑定锚点时记下的）
      const pivot = pivotBeat;
      setTempoDraft((d) => ({
        ...d,
        bpm: Math.round(d.bpm * k * 100) / 100,
        originBeat: Math.round((k * d.originBeat + (k - 1) * pivot) * 100) / 100,
      }));
      // 锚点存的是「当前网格的拍号」，单位随 BPM 变，必须同步乘 k
      setAnchors((list) => list.map((a) => ({ ...a, audioBeat: a.audioBeat * k })));
      setTempoOverride(null); // 有曲线就按新锚点重建（曲线里的时刻是从旧锚点算出来的）
      setAudioMsg(note);
    },
    [anchors, pivotBeat],
  );

  const scaleTempo = useCallback(
    (k: number) =>
      rescaleTempo(
        k,
        `音频 BPM ${k < 1 ? '减半' : '翻倍'} → 谱面走速同比${k < 1 ? '变慢' : '变快'}；` +
          `你对准的位置（谱面第 ${pivotBeat} 拍）保持不变。` +
          `看波形上的网格线是否压在鼓点上。`,
      ),
    [rescaleTempo, pivotBeat],
  );

  /** 谱面总拍数（含休止符）：用来做「谱面长度 vs 音频长度」的体检 */
  const scoreBeats = useMemo(() => totalScoreBeats(score), [score]);

  /**
   * 体检：谱面按当前 BPM 要放多久 vs 音频从谱面起点算还剩多久。
   * 倍速估错时这两个数差一倍，比用耳朵判断快得多（青花瓷这类整曲转录的谱，
   * 两者本来就应该基本相等）。
   */
  const spanAudit = useMemo(() => {
    if (!audioTempo || audioTempo.kind !== 'constant' || stems.length === 0) return null;
    const dur = Math.max(...stems.map((s) => s.buffer.duration));
    const step = 60 / audioTempo.bpm;
    const span = scoreBeats * step;
    const remaining = dur - (audioTempo.phaseSec + audioTempo.scoreOriginBeat * step);
    if (!(remaining > 1)) return null;
    return { span, remaining, ratio: span / remaining };
  }, [audioTempo, stems, scoreBeats]);

  /** 两个锚点之间的谱面跨度（拍）：跨度越小，点击误差被放大得越厉害 */
  const anchorSpan = useMemo(() => {
    if (anchors.length < 2) return 0;
    const bs = anchors.map((a) => a.scoreBeat);
    return Math.max(...bs) - Math.min(...bs);
  }, [anchors]);

  /**
   * 对准这里：波形上点的这一刻 = 某颗谱面音符响起的时刻。
   * 参照音符：谱面里**选中的那颗**；没选就是第一颗音。
   * 两种语义（按当前对齐状态分流）：
   *   恒定映射（无曲线）→ 单锚点语义：钉住一处，整谱反推。
   *   变速曲线（≥2 锚点）→ **微调语义**：在选中音的拍位上加一个锚点，曲线在该处钉准。
   *     ——绝不能清锚点：那是把 17:8 这种实测速率差打回单一 BPM，
   *     对准点之后必然整体漂移（实测踩过：怎么对齐都「不对」就是它）。
   * 波形默认吸附到节奏线；网格本身还不准（BPM / 相位都是猜的）时先取消
   * 「吸附节奏线」，人耳点的位置才是准绳。
   */
  const alignHere = useCallback(() => {
    if (wavePos === null || !stems.length) return;
    const onsets = scoreNoteOnsets(score);
    if (onsets.length < 6) {
      setAudioMsg('谱面音符太少（<6），请展开「高级参数」用锚点对齐。');
      return;
    }
    // 参照音符：谱面里选中的那颗；没选就是第一颗音（此处自行计算，
    // 因为 focusScoreBeat 声明在本函数之后）
    const selIdx = snap.mode === 'over' ? snap.cursor - 1 : -1;
    const selEv = selIdx >= 0 ? score.events[selIdx] : undefined;
    const usedSelection = !!selEv && isTimed(selEv);
    const refBeat = usedSelection ? tickAtEvent(score, selIdx) / TICKS_PER_BEAT : onsets[0];
    const clickedBeat =
      Math.round(((wavePos - tempoDraft.phaseSec) / (60 / tempoDraft.bpm)) * 100) / 100;
    if (anchors.length >= 2) {
      // 微调语义：加锚点而不是清场。（commitAnchor 声明在本函数之后，内联同款逻辑）
      setPivotBeat(refBeat);
      setAnchors((list) => [
        ...list.filter((x) => x.scoreBeat !== refBeat),
        { scoreBeat: refBeat, audioBeat: clickedBeat },
      ]);
      setTempoOverride(null);
      setAudioMsg(
        `已微调：谱面第 ${refBeat} 拍 = 音频第 ${clickedBeat} 拍，` +
          '变速曲线在此处重新钉准（之前的锚点全部保留）。',
      );
      return;
    }
    const origin = Math.round((clickedBeat - refBeat) * 100) / 100;
    setPivotBeat(refBeat);
    setTempoDraft((d) => ({ ...d, originBeat: origin }));
    setAnchors([]);
    setTempoOverride(null);
    setAudioMsg(
      `已对准：谱面第 ${refBeat} 拍 = 音频 ${wavePos.toFixed(2)}s（原点 = 音频第 ${origin} 拍）。` +
        (usedSelection ? '' : '（没选音符，默认对了谱面第一颗音）') +
        '这颗音之前的部分自动反推；之后跟不跟得住看速度档。锚点已清空。',
    );
  }, [wavePos, stems, snap, tempoDraft, score, anchors]);

  const applyImpliedBpm = useCallback(() => {
    if (impliedBpm === null) return;
    rescaleTempo(
      impliedBpm / tempoDraft.bpm,
      `已按两点实测把音频 BPM 改成 ${impliedBpm}（锚点位置不变，走速同比缩放）`,
    );
  }, [impliedBpm, tempoDraft.bpm, rescaleTempo]);

  /**
   * 当前选中的音符/休止符所在的**谱面拍**（null = 没选或选的不是音符）。
   * 顺手用它把「快速锚定」的谱面拍框填上——用户选中哪个音，框里就该是那一拍，
   * 不该停在一个示例数字上让人以为点了没反应。
   */
  const focusScoreBeat = useMemo(() => {
    const idx = snap.mode === 'over' ? snap.cursor - 1 : -1;
    const ev = idx >= 0 ? score.events[idx] : undefined;
    return ev && isTimed(ev) ? tickAtEvent(score, idx) / TICKS_PER_BEAT : null;
  }, [snap, score]);
  const focusTimed = focusScoreBeat !== null;
  useEffect(() => {
    if (focusScoreBeat !== null) {
      setQuickAnchor((q) => ({ ...q, score: Math.round(focusScoreBeat * 10) / 10 }));
    }
  }, [focusScoreBeat]);

  /**
   * 反复展开：**播放只吃线性谱**（这是整套反复功能里最省事的一条约定）。
   * 编辑永远作用在带反复记号的原谱上；展开产物是派生的、只读的。
   * 结构有错（配对不上 / 房子越界）或谱面本来没有反复记号时，退回原谱。
   */
  const expansion = useMemo(() => expandScore(documentScore), [documentScore]);
  const playScore = expansion.score ?? documentScore;
  const timeline = useMemo(() => buildTimeline(playScore), [playScore]);

  /**
   * 播放界面的「展开反复」开关：把带反复 / 跳转记号的原谱换成**拉平后的线性谱**。
   *
   * null = 跟着谱面走：带反复的谱**默认展开**，因为只有展开谱的时间轴才和播放
   * 对得上（指示条落点才准）；用户手动选过之后就一直按用户选的来。
   */
  const [expandViewPick, setExpandViewPick] = useState<boolean | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const visibleLayout = useRef<{ layout: LayoutResult; options: LayoutOptions } | null>(null);
  const rememberLayout = useCallback((layout: LayoutResult, options: LayoutOptions) => { visibleLayout.current = { layout, options }; }, []);

  /** 反复相关的诊断：阻断错误与提示一并挂到工具栏的「谱面校验」里 */
  const repeatDiag = useMemo(
    () => [
      ...expansion.errors.map((m) => ({ code: 'R1', message: m })),
      ...expansion.warnings.map((m) => ({ code: 'R2', message: m })),
    ],
    [expansion],
  );
  const issues = useMemo(() => [...violations, ...repeatDiag], [violations, repeatDiag]);

  /**
   * 起播时刻，跟随光标。
   *   方块态 → 从被选中的那个音起播（想听的就是它）
   *   插入态 → 从光标右边的音起播
   * 光标已经在末尾时退回从头播，免得播放键变成死键。
   * 有反复时下标要在**展开谱**里找：第二遍、第三遍只是同一颗音的复制品。
   */
  const playFromTick = useMemo(() => {
    const total = timelineTicks(timeline);
    const at = snap.mode === 'over' ? Math.max(0, snap.cursor - 1) : snap.cursor;
    let src = Math.max(0, Math.min(at, score.events.length));
    while (src < score.events.length && !isTimed(score.events[src])) src += 1;
    const srcId = score.events[src]?.id;
    const from = tickAtEvent(partScore(playScore, activePartId), srcId ? (expansion.firstIndex.get(srcId) ?? src) : 0);
    return from >= total ? 0 : from;
  }, [timeline, playScore, score, expansion, snap.mode, snap.cursor, activePartId]);

  const startPlayNow = useCallback(() => {
    if (documentScore.parts?.length && expansion.errors.length) { setMsg(`重奏暂不能播放：${expansion.errors[0]}`); return; }
    if (timeline.length === 0) return;
    previewRef.current.stop(); // 试听与谱面播放互斥
    setPreviewing(false);
    const bpm = score.meta.bpm;
    // 音频模式：stem + TempoMap 齐备且用户选了「伴奏音频」。
    // **记谱页除外**：那里只放合成 MIDI——编辑时听的是「谱面写对了没有」，
    // 伴奏是对轨后的成品，混进来只会干扰；想跟伴奏去播放页，那边有开关。
    // 对轨页仍放伴奏（对齐本来就要听着伴奏调）。
    // 谱尾行为（指导书 §9.3）：音频比谱长时，指示条到尾就停，音频继续放完。
    if (playSource === 'audio' && audioReady && mode !== 'score') {
      // 前奏：谱面记的是从进唱开始，伴奏前面还整段前奏。
      // 从头播时把起播点推到音频 0 秒（secToTick 反查，通常为负 tick = 谱面起点之前），
      // 前奏就会照常放完再进谱面；关掉则老样子——从谱面起点直接开始
      // playFromTick 未必正好 0（谱首有弱起 / 小节线时会落在第一拍内），
      // 所以判据用「从开头附近起播」而不是严格等于 0
      const introTick =
        playIntro && playFromTick <= TICKS_PER_BEAT
          ? Math.min(0, secToTick(audioTempo!, 0))
          : playFromTick;
      playerRef.current.startAudio({
        timeline,
        tempo: audioTempo!,
        fromTick: introTick,
        stems: stems.map((s) => ({ buffer: s.buffer, gain: s.on ? 1 : 0 })),
        synth: false,
        onEnded: () => setPlaying(false),
      });
      setPlaying(true);
      return;
    }
    // 先起音频、拿到它真正发声的时刻，再让时钟对齐到那个时刻起跑。
    // 顺序不能反：AudioContext 初始化有耗时，时钟先跑就会跑到声音前面。
    const lead = playerRef.current.start(timeline, bpm, playFromTick);
    clockRef.current.setBpm(bpm);
    clockRef.current.seek(playFromTick / TICKS_PER_BEAT);
    clockRef.current.playAfter(lead);
    setPlaying(true);
  }, [timeline, score, playFromTick, playSource, audioReady, audioTempo, stems, mode, documentScore, expansion.errors, playIntro]);

  // ── 跟着音乐打拍子定速度 ─────────────────────────────────────
  // 自动测速的失败模式是锁错倍频（17:8 就是 2.125 倍），数学上无法从错网格自救。
  // 人耳不会错：跟着音乐打 4-8 拍，间隔取中位数（抗手抖）就是真实速度，
  // 第一拍的位置就是网格起点。全程不出现「相位 / 原点」字眼。

  /** 记一拍：当前音频位置（秒）。只在音频播放中有效 */
  const recordTap = useCallback(() => {
    const sec = playerRef.current.currentSec;
    if (sec === null) return;
    setTaps((list) => [...list, Math.round(sec * 1000) / 1000].slice(-16));
  }, []);

  /** 开始打拍：伴奏**从绝对 0 秒**起播（前奏也一起听，节奏从哪进就从哪打） */
  const startTapping = useCallback(() => {
    if (!stems.length) return;
    previewRef.current.stop();
    setPreviewing(false);
    setTaps([]);
    setTapping(true);
    playerRef.current.startAudio({
      timeline,
      // 不能传现行 audioTempo：它正是要被推翻的错误标定，
      // startSec = tickToSec(0) 会落在曲子中间（0.2.23 实测踩到）。
      // 恒等映射让 tick 0 = 音频 0 秒，伴奏从头放；synth:false 下
      // tempo 只影响指示条，打拍期间用不到
      tempo: constantTempo(60, 0, 0),
      fromTick: 0,
      stems: stems.map((s) => ({ buffer: s.buffer, gain: s.on ? 1 : 0 })),
      synth: false,
      onEnded: () => setPlaying(false),
    });
    setPlaying(true);
  }, [stems, timeline]);

  /**
   * 网格起点微调（« ‹ › » 四个按钮）：整条网格**连同挂在它上面的对齐**一起平移。
   *
   * 为什么不用重建锚点：锚点存的是「网格拍号」，相位一变它们的绝对时刻自然跟着变
   * ——这正是想要的效果（打拍的第一下常有几十毫秒手抖，整条一起挪就正过来了）。
   * 只有换**网格间距**（BPM）时才需要按时刻不变重建，见 applyTaps / rescaleTempo。
   */
  const nudgePhase = useCallback((deltaSec: number) => {
    setTempoDraft((d) => ({
      ...d,
      phaseSec: Math.round((d.phaseSec + deltaSec) * 1000) / 1000,
    }));
    // 变速曲线里存的是绝对时刻（beatTimes），网格动了它必须一起动，
    // 否则会出现「网格线挪了、谱面没动」的错位
    setTempoOverride((m) =>
      m && m.kind === 'curve'
        ? { ...m, beatTimes: m.beatTimes.map((t) => Math.round((t + deltaSec) * 1000) / 1000) }
        : m,
    );
  }, []);

  /** 打拍估速：相邻间隔的中位数 → BPM。少于 3 拍不成（2 个间隔方差太大） */
  const tapBpm = useMemo(() => {
    if (taps.length < 3) return null;
    const iv = taps.slice(1).map((t, i) => t - taps[i]!);
    const sorted = [...iv].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)]!;
    return med >= 0.15 ? 60 / med : null; // 间隔 <0.15s 多半是手抖双击，不采纳
  }, [taps]);

  /** 打拍模式吃掉空格：只记拍，不落谱面快捷键 */
  useEffect(() => {
    if (!tapping) return;
    const h = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      recordTap();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tapping, recordTap]);

  /**
   * 采纳打拍结果。换网格必须保时刻：旧网格第 k 拍的秒数 t = 旧起点 + k×旧拍长，
   * 新网格拍号 = (t − 新起点)/新拍长——已钉的锚点 / 原点按同一公式换算，
   * 换完速度后已对齐的部分依然对齐，不用重绑。
   */
  const applyTaps = useCallback(() => {
    if (tapBpm === null || taps.length < 2) return;
    const newPhase = taps[0]!;
    const old = tempoDraft;
    const toNewBeat = (oldBeat: number): number =>
      Math.round(((old.phaseSec + oldBeat * (60 / old.bpm) - newPhase) / (60 / tapBpm)) * 100) / 100;
    setTempoDraft((d) => ({
      ...d,
      bpm: Math.round(tapBpm * 100) / 100,
      phaseSec: Math.round(newPhase * 1000) / 1000,
      originBeat: toNewBeat(d.originBeat),
    }));
    setAnchors((list) => list.map((a) => ({ ...a, audioBeat: toNewBeat(a.audioBeat) })));
    setTempoOverride(null);
    setTapping(false);
    setPlaying(false);
    playerRef.current.stop();
    setAudioMsg(
      `速度已按你的打拍定为 ≈${Math.round(tapBpm * 10) / 10} 拍/分，网格线应该正好压在鼓点上了。` +
        '下一步对准开头：波形点人声开口处 → 谱面选中那颗音 → 点「对准这里」。' +
        (anchors.length ? '已绑的锚点已按新速度自动换算，不用重绑。' : ''),
    );
  }, [tapBpm, taps, tempoDraft, anchors.length]);

  /**
   * 打拍自动结算：最后一拍之后 2 秒没有新拍 → 自动采纳。
   * 打拍本来的终点就是「打够了」，停手即结算——比找按钮顺手，也不用解释按钮。
   */
  const applyTapsRef = useRef(applyTaps);
  applyTapsRef.current = applyTaps;
  useEffect(() => {
    if (!tapping || taps.length < 3) return;
    const id = window.setTimeout(() => applyTapsRef.current(), 2000);
    return () => window.clearTimeout(id);
  }, [tapping, taps]);

  // 恢复中的等待机制：restoring 由恢复流程的 finally 落地，这里把等待者叫醒
  const restoringRef = useRef(restoring);
  const restoreWaiters = useRef<(() => void)[]>([]);
  useEffect(() => {
    restoringRef.current = restoring;
    if (!restoring) {
      const ws = restoreWaiters.current;
      restoreWaiters.current = [];
      for (const w of ws) w();
    }
  }, [restoring]);

  /** 等伴奏恢复完（带 10 秒兜底，绝不让播放按钮永久卡住） */
  const waitRestore = useCallback(
    () =>
      new Promise<void>((resolve) => {
        if (!restoringRef.current) {
          resolve();
          return;
        }
        restoreWaiters.current.push(resolve);
        setTimeout(resolve, 10_000);
      }),
    [],
  );

  /**
   * 播放入口。选了伴奏但伴奏还在读盘 / 解码时**先等它**：
   * 之前不等就直接落进合成音分支，界面显示「伴奏」而耳朵听到 MIDI
   * （exe 走磁盘比 Web 慢，这个窗口大到用户必踩）。
   * 等完再调 startPlayNow —— 走 ref 取**最新**那份闭包，
   * 否则会拿等之前的 audioReady（那时还是 false）又播成合成音。
   */
  const startPlayRef = useRef(startPlayNow);
  startPlayRef.current = startPlayNow;
  const startPlay = useCallback(() => {
    if (!shouldWaitForAudio(playSource, restoring)) {
      startPlayRef.current();
      return;
    }
    setAudioMsg('伴奏正在从本地恢复，稍等一下就按伴奏放…');
    void waitRestore().then(() => startPlayRef.current());
  }, [playSource, restoring, waitRestore]);

  /**
   * 播放 tick 的唯一出口：音频模式反查 secToTick（变速下唯一正确的做法），
   * 合成音模式走 BeatClock。ScoreCanvas 每帧调一次。
   */
  const getPlayTick = useCallback((): number | null => {
    const t = playerRef.current.currentTick;
    if (t !== null) return t;
    return clockRef.current.currentBeat * TICKS_PER_BEAT;
  }, []);

  // 调试钩子：端到端测试从外面读播放状态（currentSec / currentTick / tempo）
  useEffect(() => {
    (window as unknown as { __windscore?: unknown }).__windscore = {
      clock: clockRef.current,
      getPlayTick,
      tempo: audioTempo,
      stemCount: stems.length,
      stemNames: stems.map((s) => s.name),
      playing,
      wavePos,
      focusTimed,
      snapMode: snap.mode,
      cursor: snap.cursor,
      focusKind: focus?.kind ?? null,
      focusId: overId,
      active,
      tempoDraft,
      anchors,
      audioMsg,
      stemKeys: stemKeysRef.current,
    };
  });

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

  const beatTicks = Math.round(beatsPerMeasure(meterAt(score, snap.cursor)) * TICKS_PER_BEAT);
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

  /** 段落标注的编辑草稿（null = 没在编辑，显示谱面里的值） */
  const [annotDraft, setAnnotDraft] = useState<string | null>(null);
  /** 当前音左右两侧是否已加了括号（按钮点亮用） */
  const parenFlags = useMemo(
    () => (focus && isTimed(focus) ? parenFlagsOf(score, focus.id) : { open: false, close: false }),
    [focus, score],
  );

  /**
   * 提交段落标注。插入 / 删除 directive 会改变它后面所有事件的下标，
   * 而选中的音是按下标取的（events[cursor-1]）——光标必须跟着挪，
   * 否则提交完焦点就跑到标注自己身上，面板一换、输入框又没了。
   */
  const commitAnnotation = useCallback(
    (text: string) => {
      if (!focus || (focus.kind !== 'note' && focus.kind !== 'rest')) return;
      const next = setTextAnnotation(score, focus.id, text);
      if (next === score) return;
      const shift = next.events.length - score.events.length;
      commit({ ...snap, score: next, cursor: snap.cursor + shift });
    },
    [focus, score, snap, commit],
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
   * 波形上定好的那个点 = 音频第几拍。
   * 吸附开着时就是整拍（点在节奏线上）；关掉时按精确时刻换算，允许小数。
   */
  const audioBeatOfWave = useMemo(() => {
    if (waveBeat !== null) return waveBeat;
    if (wavePos === null) return null;
    return (wavePos - tempoDraft.phaseSec) / (60 / tempoDraft.bpm);
  }, [waveBeat, wavePos, tempoDraft]);

  /**
   * 落一个锚点：谱面某处（小节线 / 音符的拍位）↔ 音频那个节奏点。
   * 恒定 BPM 下一个锚点定死原点；≥2 个锚点自动合成变速曲线（段间线性拉伸）。
   */
  const commitAnchor = useCallback(
    (scoreBeat: number, audioBeat: number, what: string, extra = '') => {
      setPivotBeat(scoreBeat);
      setAnchors((list) => [
        ...list.filter((x) => x.scoreBeat !== scoreBeat),
        { scoreBeat, audioBeat },
      ]);
      setTempoOverride(null);
      if (anchors.length + 1 < 2) {
        setTempoDraft((d) => ({ ...d, originBeat: Math.round((audioBeat - scoreBeat) * 100) / 100 }));
      }
      const detail =
        `${what} ↔ 音频第 ${Math.round(audioBeat * 10) / 10} 拍` +
        (anchors.length + 1 >= 2
          ? ' · 两点之间按变速曲线拉伸（前奏比谱面长也能跟住）'
          : ' · 再绑一个更靠后的位置，前奏即可自动拉伸');
      setAudioMsg(`已绑定：${detail}。${extra}`);
      // 绑定是低频而关键的一步，成没成必须**弹出来**说——
      // 光靠侧栏底部那行小字，眼睛还在谱面上根本注意不到
      setBindToast({
        title: '绑定成功',
        body: `${detail}${extra ? `。${extra}` : ''}`,
        key: Date.now(),
      });
      previewRef.current.stop();
      setPreviewing(false);
    },
    [anchors, setAudioMsg, setAnchors, setTempoDraft, setTempoOverride, setPivotBeat, setPreviewing],
  );

  /**
   * 波形定点后，在谱面上点**小节线**即绑定（新流程）。
   *
   * 为什么不拿单颗音去对：音的拍位会被弱起 / 倚音 / 附点搅浑，而小节线是
   * 干净的界点；且波形上那些节奏线一眼可辨，点线比在密集音符里挑一颗省事。
   * 音符仍可绑（老流程保留），两种都走 commitAnchor。
   */
  const bindPick = useCallback(
    (idx: number, extra = ''): boolean => {
      if (wavePos === null || audioBeatOfWave === null) return false;
      const ev = score.events[idx];
      if (!ev) return false;
      if (ev.kind === 'barline') {
        commitAnchor(
          tickAtEvent(score, idx) / TICKS_PER_BEAT,
          audioBeatOfWave,
          `第 ${measureAt(score.events, idx)} 小节线`,
          extra,
        );
        return true;
      }
      if (isTimed(ev)) {
        const beat = tickAtEvent(score, idx) / TICKS_PER_BEAT;
        commitAnchor(beat, audioBeatOfWave, `谱面第 ${Math.round(beat * 10) / 10} 拍`, extra);
        return true;
      }
      return false;
    },
    [wavePos, audioBeatOfWave, score, commitAnchor],
  );

  /**
   * 点「谱面开头」靶标 = 绑定**谱面第 0 拍**。
   * 简谱开头不画小节线，但音频最前面那个节奏点常常正对应谱面开头——
   * 给它一个和小节线同款的靶标，交互就不用分叉成「还有一个按钮」。
   */
  const bindScoreStart = useCallback((): boolean => {
    if (audioBeatOfWave === null) return false;
    commitAnchor(0, audioBeatOfWave, '谱面开头（第 0 拍）');
    setWavePos(null);
    setWaveBeat(null);
    return true;
  }, [audioBeatOfWave, commitAnchor]);

  /**
   * 边播边修（对轨的核心验证循环）：播放中听到指示条与伴奏错位 →
   * 按 N（或状态条「不对，在这对齐」）→ 就地暂停 → 当前时刻变成波形定点 →
   * 点谱面小节线 / 音符完成绑定 → 空格继续播。
   * 不吸附：播放头此刻的位置就是准绳，吸到错误的网格线上等于没修。
   */
  const markMisalign = useCallback(() => {
    if (mode !== 'align' || !audioReady) return;
    const sec = playerRef.current.currentSec;
    if (sec === null) return;
    playerRef.current.stop();
    clockRef.current.pause();
    setPlaying(false);
    setWavePos(sec);
    setWaveBeat(Math.round(((sec - tempoDraft.phaseSec) / (60 / tempoDraft.bpm)) * 100) / 100);
  }, [mode, audioReady, tempoDraft]);

  /** 删除某条节奏线上的对齐点（浮层「删除此对齐点」）；对齐回退到其余锚点 / 自动标定 */
  const deleteAnchorAt = useCallback(
    (audioBeat: number) => {
      setAnchors((list) => list.filter((a) => Math.abs(a.audioBeat - audioBeat) > 0.5));
      setAudioMsg('已删除该对齐点；对齐回退到其余锚点或自动标定。');
    },
    [],
  );

  /**
   * 鼠标选中。
   *   点在音上   → over 模式，方块光标，之后输入是替换
   *   点在缝隙里 → insert 模式，I 形光标，之后输入是插入
   *   拖拉跨了多个事件 → 建立区间选区（用于套时值档位）
   *
   * 波形上已经定过点（对轨配对中）时，点在**小节线**上 = 绑定锚点，
   * 绑完照常选中这条线，不打断编辑。
   */
  const handlePick = useCallback(
    (a: ScorePick, b: ScorePick | null) => {
      // 画布上任何一次非铅笔点击（音符 / 缝隙 / 空白处按最近邻回退）都离开曲目信息：
      // 改音符和改曲目信息互斥，见 songInfoOpen 的注释
      setSongInfoOpen(false);
      // 绑完就退出配对：否则你后面只是想看看别的线，点一下就又绑一个。
      // 侧栏在「简谱编辑」页签时不绑——那时点谱面是选中 / 改谱，不是绑定对齐点
      if (
        !b &&
        (!a.partId || a.partId === activePartId) &&
        wavePos !== null &&
        alignTab === 'align' &&
        bindPick(a.index)
      ) {
        setWavePos(null);
        setWaveBeat(null);
      }
      setSnap((s) => {
        if (a.partId && b?.partId && a.partId !== b.partId) return s;
        if (b && b.index !== a.index) {
          const lo = Math.min(a.index, b.index);
          const hi = Math.max(a.index, b.index);
          return { ...s, partId: a.partId ?? activePartId, cursor: hi + 1, anchor: lo, mode: 'insert' };
        }
        return { ...s, partId: a.partId ?? activePartId, cursor: a.cursor, anchor: null, mode: a.mode };
      });
    },
    [bindPick, wavePos, activePartId],
  );

  /**
   * 波形点击 = 设定试听起始点，并**立即从那里试听**（与谱面播放互斥）。
   * 反复点反复听，找到「这条节奏线对应谱面哪一处的界」。
   * 吸附开着时 sec 已经落在某条节奏线上，beat 就是那条线的拍号。
   */
  const seekWave = useCallback(
    (sec: number, beat: number) => {
      setWavePos(sec);
      setWaveBeat(Math.round(beat * 100) / 100);
      // 点哪儿就把「音频第几拍」填进快速锚定：那两个框必须反映你刚点的位置
      setQuickAnchor((q) => ({ ...q, audio: Math.round(beat * 10) / 10 }));
      // 无条件停谱面播放：播放标志可能与播放器实际状态脱节，
      // 靠标志判断会漏停，试听叠上去就是两条音频（音频层另有全局互斥兜底）
      playerRef.current.stop();
      clockRef.current.pause();
      setPlaying(false);
      // 放 previewBeats 拍就停（拍长按当前网格 BPM 算）：找对齐点听一小段就够
      previewRef.current.start(
        stems.map((s) => ({ buffer: s.buffer, gain: s.on ? 1 : 0 })),
        sec,
        () => setPreviewing(false),
        (previewBeats * 60) / tempoDraft.bpm,
      );
      setPreviewing(true);
    },
    [stems, previewBeats, tempoDraft.bpm],
  );

  const stopPreview = useCallback(() => {
    previewRef.current.stop();
    setPreviewing(false);
  }, []);

  /**
   * 面板上的「绑定」按钮：把波形起点绑到**当前选中的**谱面对象
   * （小节线优先——拍位干净；否则选中的音符）。
   * vocal = 「人声起点对齐」：走的是同一个锚点机制，只是文案与提示不同。
   */
  const bindAnchor = useCallback(
    (vocal = false) => {
      if (wavePos === null || audioBeatOfWave === null) {
        setAudioMsg('绑定：先在波形上点一条节奏线（会从那里试听）');
        return;
      }
      const idx = snap.mode === 'over' ? snap.cursor - 1 : -1;
      const ev = idx >= 0 ? score.events[idx] : undefined;
      if (!ev || (ev.kind !== 'barline' && !isTimed(ev))) {
        setAudioMsg('绑定：请先在谱面上点选一根小节线（或一颗音符）');
        return;
      }
      if (
        bindPick(
          idx,
          vocal
            ? '这颗音之前的前奏按此自动反推，不必与音频一致；之后能否跟住取决于速度档——不对就用「谱面跑太快/太慢」校正。'
            : '',
        )
      ) {
        return;
      }
      setAudioMsg('绑定：这里没有可绑的对象——点一根小节线，或一颗音符');
    },
    [wavePos, audioBeatOfWave, snap, score, bindPick, setAudioMsg],
  );

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
        const next = applyTierOp(score, ids, ticks, cands[0].ticks, cands[0].tuplet, cands[0].dots);
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

  /**
   * 选中完整小节时，「区间操作」里给出跳房子：比逐根点小节线直观。
   * 可用性检查直接复用 setVoltaFromSelection（纯函数跑一遍拿 error）。
   */
  const selectionVolta = useMemo(
    () => setVoltaFromSelection(score, selectedTimedIds, 1),
    [score, selectedTimedIds],
  );
  const doSelectionVolta = useCallback(
    (n: number) => {
      const r = setVoltaFromSelection(score, selectedTimedIds, n);
      if (!r.score) {
        setMsg(r.error ?? '无法设为房子');
        return;
      }
      commit({ ...snap, score: r.score });
      setMsg(`选中小节已设为 [${n}] 房，选区尾的小节线变成了 :|`);
    },
    [score, selectedTimedIds, snap, commit],
  );

  // ─────────── 小节线属性（点谱面里那条竖线选中它，在这里改） ───────────
  const barlineFocus = focus && focus.kind === 'barline' ? (focus as BarlineEvent) : null;

  /**
   * 展开后的**实际演奏顺序**（按小节区间）：反复与跳转是「写了不一定弹对」的
   * 结构，用耳朵逐句核对很慢——这里直接把播放路径列出来，
   * 一眼看出「跳回的是不是这一段、结束句有没有被跳到」。
   * 只在谱里有反复 / 跳转时才提示。
   */
  const playOrder = useMemo(
    () => playOrderMeasures(documentScore.events, playScore.events),
    [playScore, documentScore],
  );

  /** 这首有没有反复 / 跳转结构——没有的话「展开反复」是空开关，直接置灰 */
  const canExpandView = !!playOrder && playOrder.length > 1;
  const expandView = expandViewPick ?? canExpandView;
  const setExpandView = setExpandViewPick;
  /** 屏幕上是哪一份谱：展开 = 拉平后的线性谱，原谱 = 带记号的原样 */
  const fullViewScore = expandView ? playScore : documentScore;
  const viewScore = totalView ? fullViewScore : partScore(fullViewScore, activePartId);

  /**
   * **显示用**的时间线：id 口径必须和屏幕上的谱面一致。
   *
   * 排版结果的 item.eventId 取自谱面事件的 `ev.id`，而时间线默认用 `originId`
   * （原谱 id）。两者不一致时播放指示按 id 一个都找不到——展开谱里的反复克隆
   * （`n12~2`）正好撞上这个坑，副歌第二遍就没有任何指示。
   * 所以：显示展开谱用 `own` 口径，显示原谱用默认的 `source` 口径。
   * tick 两者一致（都按展开后的时间轴算），伴奏对齐与滚动不受影响。
   */
  const displayTimeline = useMemo(
    () => (expandView ? buildTimeline(playScore, { ids: 'own' }) : timeline),
    [playScore, timeline, expandView],
  );
  const selectPart = (id: string) => {
    setLyricSelection(null);
    setPending(null);
    setSnap((s) => ({ ...s, partId: id, cursor: 0, anchor: null, mode: 'insert' }));
  };
  const changeParts = (next: Score, id?: string, liveMix = false) => {
    if (!liveMix) stopPlay();
    setPending(null);
    commit({ score: next, partId: id ?? activePartId, ...(id ? { cursor: 0, anchor: null, mode: 'insert' as const } : {}) }, true);
    if (liveMix) {
      const expanded = expandScore(next);
      playerRef.current.setPartGains(buildTimeline(expanded.score ?? next));
    }
  };
  const selectLyrics = (partId: string, verse: number | null) => {
    stopPlay();
    setPending(null);
    setSnap((s) => ({ ...s, partId, anchor: null, ...(partId !== activePartId ? { cursor: 0, mode: 'insert' as const } : {}) }));
    setLyricSelection((previous) => verse === null ? null : { partId, verse, session: (previous?.session ?? 0) + 1 });
  };

  /** 演奏顺序里每一小节的起始 tick（`[小节1, 小节2, …]`）：录片段时按小节号换 tick */
  const measureTicks = useMemo(() => {
    const out: number[] = [];
    let tick = 0;
    for (let i = 0; i < playScore.events.length; i += 1) {
      const ev = playScore.events[i]!;
      const m = measureAt(playScore.events, i);
      while (out.length < m - 1) out.push(tick);
      if (out.length === m - 1) out.push(tick);
      if ('ticks' in ev) tick += ev.ticks as number;
    }
    return out;
  }, [playScore]);

  /** 选中线的后面挂着的那颗跳转记号（null = 没有）——按钮点亮 / 摘除都看它 */
  const jumpAfterFocus = useMemo(() => {
    if (!barlineFocus) return null;
    const idx = score.events.findIndex((e) => e.id === barlineFocus.id);
    const next = score.events[idx + 1];
    return next && next.kind === 'jump' ? next.mark : null;
  }, [barlineFocus, score]);

  /** 焦点在哪个小节（从 1 数起）。与反复报错的 measureAt 同口径，
   *  报错说「第 12 小节」时选中那个音看到的就是同一个 12 */
  const focusMeasure = useMemo(() => {
    if (!focus) return null;
    const idx = score.events.findIndex((e) => e.id === focus.id);
    return idx >= 0 ? measureAt(score.events, idx) : null;
  }, [focus, score]);

  /** 把选中的小节线变成 `|` / `|:` / `:|`；再点一次当前状态 = 取消 */
  const setRepeat = useCallback(
    (repeat?: 'start' | 'end') => {
      if (!barlineFocus) return;
      const next = barlineFocus.repeat === repeat ? undefined : repeat;
      setScore(setBarlineRepeat(score, barlineFocus.id, next));
    },
    [barlineFocus, score, setScore],
  );

  /** 跳房子：点一次设上、再点一次取消（同一根线只属于一个房） */
  const setVolta = useCallback(
    (n: number) => {
      if (!barlineFocus) return;
      const cur = barlineFocus.volta ?? [];
      setScore(setBarlineVolta(score, barlineFocus.id, cur.includes(n) ? undefined : [n]));
    },
    [barlineFocus, score, setScore],
  );

  // ─────────── 键盘 ───────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (lyricVerse !== null) {
        if (e.key === 'Escape') setLyricSelection(null);
        if (!(e.ctrlKey || e.metaKey) || !['z', 'y', 's'].includes(e.key.toLowerCase())) return;
      }
      // Esc 退出「对轨配对」（波形上定过点、等你点小节线）：
      // 定点错了不想绑就按它，光标与靶标立刻收掉，试听也一并停
      // （绑定成功时同样会停，见 commitAnchor）。放在 align 的早退之前——
      // 配对只发生在对轨模式
      if (e.key === 'Escape' && wavePos !== null) {
        setWavePos(null);
        setWaveBeat(null);
        previewRef.current.stop();
        setPreviewing(false);
        return;
      }
      // 边播边修：播放中听到指示条跟不上伴奏 → N 键在此刻就地暂停并准备加对齐点
      if (mode === 'align' && (e.key === 'n' || e.key === 'N') && playing) {
        e.preventDefault();
        markMisalign();
        return;
      }
      // Ctrl/Cmd+S 随时可存：对轨页也能改谱，两个页签下都要能存盘
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void onSave();
        return;
      }
      // 编辑键只认记谱屏；对轨屏切到「简谱编辑」页签后同样可编辑
      // （对着伴奏补前奏 / 间奏就是要在这一屏改）。其余屏一律不响应——
      // 播放 / 曲库 / 动态谱首页里按 1-7、退格，不能偷偷改那份看不见的谱子
      // （编辑器不渲染 ≠ 状态不在）
      if (!canEditScore) return;

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
            setClipGroups(JSON.parse(JSON.stringify(score.groups)) as BeatGroup[]);
            setMsg(`已复制 ${range[1] - range[0]} 个事件`);
          }
        } else if (k === 'v') {
          if (clip.length > 0) {
            e.preventDefault();
            const r = pasteEvents(score, snap.cursor, clip, clipGroups);
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
        case '/': {
          // 减时线档位：四分 → 八分 → 十六分 → 三十二分 → 回四分。
          // 附点是独立开关不掉点（附点四分减半 = 附点八分）；增时线长音先回到一拍
          e.preventDefault();
          const k = prevTimed(score, cur);
          if (k < 0) return;
          const prev = score.events[k];
          if (prev.kind !== 'note' && prev.kind !== 'rest') return;
          const dot = prev.dot ?? 0;
          const base = undotTicks(prev.ticks, dot);
          commit({ score: setTicks(score, prev.id, base > 6 ? base / 2 : TICKS_PER_BEAT) });
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
          } else if (focus && !isTimed(focus)) {
            // 选中的是**小节线**：删的是这条线，不是它右边的那个音
            commit({
              score: removeEvent(score, focus.id),
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
  }, [score, snap, commit, undo, redo, useTier, doSlur, range, clip, clipGroups, mode, wavePos, lyricVerse, playing, markMisalign, onSave]);

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
    commit({ score: res.score, partId: res.score.part?.id, cursor: res.score.events.length, anchor: null }, true);
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
          commit({ score: res.score, partId: res.score.part?.id, cursor: res.score.events.length, anchor: null }, true);
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

  /**
   * 伴奏还在从本地恢复（读 IndexedDB + 解码要一会儿）。
   * 没有这个中间态，从曲库点进播放会先闪一句「这首还没有伴奏」——
   * 明明存着，只是还没读完。
   */
  const restoringAudio = restoring;
  /** 存档声称有伴奏、本机却拿不到（缓存被清 / 换了浏览器）——要说清是哪一种 */
  const audioLost = !restoring && stems.length === 0 && !!loadAlign(active)?.audio?.length;

  /*
   * 模式开关。抽出来是为了在下面的条件渲染之外求值——
   * 「编辑器只在非曲库模式渲染」那支里 mode 会被收窄成 'score' | 'align'，
   * 在里面写 mode === 'library' 会被当成永远不成立（也就点不回曲库）。
   * 单功能页不显示它：这一屏只干一件事，跳去别的屏反而是干扰。
   */
  return (
    <div className="v2-app" data-theme={dark ? 'dark' : 'light'} data-entry={entry}>
      {/* play.html 是独立入口：整行顶栏（含返回首页、品牌、文件状态、校验、深色）不显示，播放页有自己的工具条。要切深浅色去记谱页，那里切过一次这里就沿用。 */}
      <header className="v2-head">
        <div className="v2-brand">
          {/*
            返回首页：编辑页与曲库管理页都有——它们是从落地页点进来的，
            任何时候都能一步回去。
            play.html 的顶栏整行不显示（独立入口，播放页自带工具条），
            它的返回入口做在播放界面里，见 DiscoverScreen.homeHref 与播放工具条。
          */}
          {entry === 'editor' || entry === 'align' || entry === 'library' ? (
            <a className="v2-home-btn" href="./index.html" title="回到首页">
              ← 返回首页
            </a>
          ) : null}
          <span className="v2-brand-name">
            WindScore <span className="v2-brand-tag">{entry === 'align' ? '动态谱生成' : entry === 'editor' ? '简谱编辑' : '写谱器'}</span>
          </span>
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
            className={issues.length === 0 ? 'v2-check is-ok' : 'v2-check is-bad'}
            onClick={() => setCheckOpen((v) => !v)}
            title={
              issues.length === 0
                ? '每小节拍数、拍内组、连线、反复结构都没问题'
                : '点开看具体问题'
            }
          >
            {issues.length === 0 ? '谱面校验通过' : `谱面校验：${issues.length} 处问题`}
          </button>
          {checkOpen && issues.length > 0 ? (
            <ul className="v2-diag v2-check-list">
              {issues.map((v, i) => (
                <li key={i} className={v.code === 'I4' || v.code === 'R2' ? 'is-warn' : 'is-error'}>
                  <b>{VIOLATION_LABEL[v.code] ?? '谱面'}</b> {v.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {/*
          工具栏按模式分流：
            记谱 → 新建 / 打开 / 保存 / 撤销 / 重做（只动谱面 .jps）
            对轨 → 打开（换一首来对）+ 打包（配好了存成压缩包）
            曲库 → 界面自带动作，工具栏不放
          对轨也需要「打开」：换歌对轨是常事，让用户先回记谱页再绕一圈
          是不必要的（打开后走 adopt，旧伴奏 / 旧标定自动作废）。
        */}
        <div className="v2-head-actions">
          {mode === 'score' ? (
            <>
              <button className="v2-btn" onClick={onNew}>
                新建
              </button>
              <button className="v2-btn" onClick={onOpen}>
                打开
              </button>
              <button className="v2-btn" onClick={onSave} disabled={score.events.length === 0}>
                保存
              </button>
              <button
                className="v2-btn"
                title="导出当前曲谱为 PDF，可选择总谱或分谱"
                onClick={() => {
                  if (view === 'source' && draft !== serialized) {
                    const res = parseDsl(draft);
                    if (!res.score || res.errors.length) {
                      setMsg(res.errors[0] || '解析失败，请先修正源码再导出');
                      return;
                    }
                    stopPlay();
                    commit({ score: res.score, partId: res.score.part?.id, cursor: res.score.events.length, anchor: null }, true);
                  }
                  setExportOpen(true);
                }}
              >
                导出 PDF
              </button>
              <button className="v2-btn" onClick={undo} disabled={!past.length}>
                撤销
              </button>
              <button className="v2-btn" onClick={redo} disabled={!future.length}>
                重做
              </button>
            </>
          ) : null}
          {mode === 'align' ? (
            <>
              <button className="v2-btn" onClick={onOpen} title="换一首简谱来对轨">
                打开
              </button>
              {/* 对轨页能改谱（补前奏 / 间奏），所以要有独立的保存入口：
                  存 .jps 文件，并同步回曲库；未保存的改动会标出来 */}
              <button
                className="v2-btn"
                title={`把当前谱面存成 .jps（含在「简谱编辑」页签里的修改），并更新曲库${dirty ? '；有未保存的改动' : ''}`}
                onClick={() => void onSave()}
                disabled={score.events.length === 0}
              >
                保存{dirty ? ' •' : ''}
              </button>
              <button
                className="v2-btn"
                title="导出 PDF / 图片 / 视频——配好伴奏的视频直接带伴奏音"
                onClick={() => setExportOpen(true)}
              >
                导出
              </button>
              <button
                className="v2-btn"
                disabled={!serialized}
                title="把当前这首（谱面 + 伴奏 + 对轨标定）打包成一个 .wspack 压缩包"
                onClick={() => void packCurrent()}
              >
                打包
              </button>
              <button
                className="v2-btn"
                title="先把整首歌分成人声 / 伴奏分轨，再把分轨载入这里对齐"
                onClick={() => setTramaOpen(true)}
              >
                音轨分离
              </button>
              {/* 编辑页签下才给撤销 / 重做：改谱要能回头 */}
              {alignTab === 'edit' ? (
                <>
                  <button className="v2-btn" onClick={undo} disabled={!past.length}>
                    撤销
                  </button>
                  <button className="v2-btn" onClick={redo} disabled={!future.length}>
                    重做
                  </button>
                </>
              ) : null}
              {/* 点击波形试听放几拍就停（找对齐点听一小段就够，不用手动掐） */}
              <label
                className="v2-grace-check"
                title="点击波形试听时放几拍就自动停；拍长按当前网格速度计算"
              >
                试听
                <input
                  className="v2-num"
                  style={{ width: 44 }}
                  type="number"
                  min={1}
                  max={64}
                  value={previewBeats}
                  onChange={(e) => {
                    const v = Math.round(Number(e.target.value));
                    if (Number.isFinite(v)) setPreviewBeats(Math.max(1, Math.min(64, v)));
                  }}
                />
                拍
              </label>
            </>
          ) : null}
          {mode !== 'play' && mode !== 'discover' ? <button className="v2-btn" aria-haspopup="dialog" onClick={() => setHelpOpen(true)}>帮助</button> : null}
          {/* 文件选择框两种模式共用（浏览器预览时没有 Tauri 对话框，靠它兜底） */}
          <input ref={fileRef} type="file" accept=".jps,.txt" hidden onChange={onFilePicked} />
        </div>
        </header>
      {/*
        播放界面：只放不编——简谱显示 + 伴奏播放。
        复用编辑器的整套播放机制（startPlay / getPlayTick / 指示条自动滚动），
        但没有侧栏、没有工具条：这是一首录完之后「打开就听」的地方
      */}
      {mode === 'play' ? (
        <div className="v2-play">
          <div className="v2-play-bar">
            {entry === 'play' ? (
              <>
                {/* 与编辑页顶栏那枚同款（.v2-home-btn），两入口长得一样 */}
                <a className="v2-home-btn" href="./index.html" title="回到首页">
                  ← 返回首页
                </a>
                <button
                  className="v2-btn"
                  onClick={() => setMode('discover')}
                  title="回到动态谱首页"
                >
                  ← 动态谱
                </button>
              </>
            ) : null}
            <span className="v2-play-title">
              {score.meta.title || active}
              {expandView && canExpandView ? (
                <span className="v2-play-tag" title="反复与跳转已按顺序铺开，导出也用这份">
                  已展开反复
                </span>
              ) : null}
            </span>
            <button
              className={`v2-btn ${playing ? 'is-on' : ''}`}
              onClick={() => (playing ? stopPlay() : startPlay())}
              disabled={timeline.length === 0}
              title={playing ? '停止' : '播放'}
            >
              {playing ? '⏹ 停止' : '▶ 播放'}
            </button>
            <div className="v2-view-switch" title="跟着伴奏放（用对好的标定），或用合成音">
              <button
                className={playSource === 'audio' ? 'v2-seg is-on' : 'v2-seg'}
                disabled={!audioReady || restoring}
                title={
                  restoring
                    ? '伴奏正在从本地恢复，好了就能按伴奏放'
                    : '跟着伴奏放（用对好的标定）'
                }
                onClick={() => setPlaySource('audio')}
              >
                伴奏
              </button>
              <button
                className={playSource === 'synth' ? 'v2-seg is-on' : 'v2-seg'}
                onClick={() => setPlaySource('synth')}
              >
                合成音
              </button>
            </div>
            {/* 字号 / 字距：观看偏好，只影响播放界面的显示，谱面文件不变；⟲ 恢复跟随谱面 */}
            <div className="v2-play-adj" title="字号（只影响播放界面，谱面本身不变）">
              <span>字号</span>
              <input
                type="range"
                min={14}
                max={42}
                step={1}
                value={effFont}
                onChange={(e) => setPlayFont(Number(e.target.value))}
              />
              <output>{effFont}px</output>
              {playFont !== null ? (
                <button className="v2-play-reset" onClick={() => setPlayFont(null)} title="恢复跟随谱面设置">
                  ⟲
                </button>
              ) : null}
            </div>
            <div className="v2-play-adj" title="字间距（观看偏好）">
              <span>字距</span>
              <input
                type="range"
                min={-6}
                max={24}
                step={1}
                value={effGap}
                onChange={(e) => setPlayGap(Number(e.target.value))}
              />
              <output>{effGap}px</output>
              {playGap !== null ? (
                <button className="v2-play-reset" onClick={() => setPlayGap(null)} title="恢复跟随谱面设置">
                  ⟲
                </button>
              ) : null}
            </div>
            {/* 展开反复：显示拉平后的线性谱（导出的 PDF / 视频也跟着用这份） */}
            <div
              className="v2-view-switch"
              title={
                canExpandView
                  ? '把反复与 D.S. 按顺序铺开：显示的就是真正在奏的每一遍'
                  : '这首没有反复或跳转记号，本来就是线性谱'
              }
            >
              <button
                className={!expandView ? 'v2-seg is-on' : 'v2-seg'}
                disabled={!canExpandView}
                onClick={() => setExpandView(false)}
              >
                原谱
              </button>
              <button
                className={expandView ? 'v2-seg is-on' : 'v2-seg'}
                disabled={!canExpandView}
                onClick={() => setExpandView(true)}
              >
                展开反复
              </button>
            </div>
            {/* 播放指示方式：原来只在记谱的属性栏里，播放时想换得切回去 */}
            <div className="v2-view-switch" title="播放时用哪种指示">
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
              <button
                className={playStyle === 'ball' ? 'v2-seg is-on' : 'v2-seg'}
                onClick={() => setPlayStyle('ball')}
                title="发光小球拖着渐变尾巴，按抛物线轨迹逐音跳跃"
              >
                光球
              </button>
            </div>
            <span className="v2-play-note">
              {restoringAudio
                ? '正在从本地恢复伴奏…'
                : audioReady
                  ? playSource === 'audio'
                    ? '跟伴奏放：指示条按对轨标定走'
                    : '合成音：想跟伴奏就切回「伴奏」'
                  : audioLost
                    ? entry === 'play'
                      ? '伴奏文件不在本机缓存里了——到主程序的对轨界面重新载入'
                      : '伴奏文件不在本机缓存里了——到对轨界面重新载入，或重新导入那个 .wspack'
                    : entry === 'play'
                      ? '这首还没有伴奏——在主程序对轨界面载入伴奏并打包即可'
                      : '这首还没有伴奏——去曲库导入打包，或在对轨界面载入伴奏'}
              {expandView && canExpandView ? '（显示的是拉平后的线性谱）' : ''}
            </span>
            {/* 导出放在工具条最右：这一排里只有它会离开当前界面 */}
            <button
              className="v2-btn v2-play-export"
              onClick={() => setExportOpen(true)}
              title="导出 PDF / 视频"
            >
              导出
            </button>
            <button className="v2-btn" aria-haspopup="dialog" onClick={() => setHelpOpen(true)}>帮助</button>
          </div>
          {/*
            分轨开关：打包进去几条就能挑几条放。人声常常已经录在伴奏里，
            练习时只想要伴奏 —— 逐条勾选，播放中即时生效（30ms 平滑，不炸耳朵），
            选择按谱面记住：下次从曲库进播放界面还是这套混音。
          */}
          {stems.length > 0 ? (
            <div className="v2-play-stems">
              <span className="v2-play-stems-label">分轨</span>
              {stems.map((s, i) => (
                <label
                  key={s.name + i}
                  className="v2-grace-check"
                  title={s.on ? '点击静音这条' : '点击放这条'}
                >
                  <input type="checkbox" checked={s.on} onChange={() => toggleStem(i)} />
                  {s.name.replace(/\.(wav|mp3|ogg|flac|m4a)$/i, '')}
                  {isVocalName(s.name) ? <span className="v2-play-stem-tag">人声</span> : null}
                </label>
              ))}
              <button className="v2-btn" onClick={() => setStemsOn(() => true)} title="所有分轨都放">
                全放
              </button>
              <button
                className="v2-btn"
                disabled={!stems.some((s) => isVocalName(s.name))}
                onClick={() => setStemsOn((name: string) => !isVocalName(name))}
                title="关掉人声分轨，只放伴奏（练习用）"
              >
                无人声
              </button>
            </div>
          ) : null}

          {documentScore.part ? <PartsPanel score={documentScore} activeId={activePartId} total={totalView} readOnly onSelect={selectPart} onTotal={setTotalView} onChange={changeParts} /> : null}
          <div className="v2-play-stage">
            <ScoreCanvas
              score={viewScore}
              dark={dark}
              unit={EDITOR_UNIT}
              fontSize={effFont}
              letterSpacing={effGap}
              selectedIds={EMPTY_SELECTED}
              cursor={0}
              timeline={displayTimeline}
              playStyle={playStyle}
              playing={playing}
              clock={clockRef.current}
              getPlayTick={getPlayTick}
              onPick={() => {
                /* 只放不编：谱面不可点 */
              }}
              onEnded={onPlayEnded}
              showCaret={false}
              focusId={null}
              onLayout={rememberLayout}
            />
          </div>
        </div>
      ) : null}

      {/*
        导出弹窗：导出的是 `viewScore`——播放界面开着「展开反复」时，
        PDF 与视频拿到的就是拉平后的线性谱，所见即所得。
      */}
      {/* 曲库位置未配置时的引导窗：进演奏首页 / 曲库管理页时触发（见 setupOpen） */}
      {setupOpen ? (
        <LibrarySetupDialog
          isExe={isTauri()}
          defaultPath={defaultLibraryPath()}
          onDone={() => {
            setSetupOpen(false);
            setMsg('曲库位置已配置，你选的文件夹就是曲库——迁移时拷贝它即可');
          }}
          onSkip={() => setSetupOpen(false)}
        />
      ) : null}

      {exportOpen ? (
        <ExportDialog
          songName={score.meta.title || active}
          score={mode === 'play' ? fullViewScore : documentScore}
          visibleLayout={mode === 'play' || view === 'score' ? visibleLayout.current?.layout : undefined}
          visibleOptions={visibleLayout.current?.options}
          initialPartId={!totalView && documentScore.part ? activePartId : ''}
          // 视频导出所有入口都有：配好伴奏录伴奏音，没配就录 MIDI 合成音（导出弹窗自动分流）
          allowVideo
          dark={dark}
          onClose={() => setExportOpen(false)}
          onBegin={() => {
            // 录视频时播放器由录制器接管，先把界面这套停掉，免得两套时钟同时跑
            if (playing) stopPlay();
          }}
          video={{
            displayTimeline,
            // 视频录制暂不支持光球特效：回退为色块+竖线
            playStyle: playStyle === 'ball' ? 'head' : playStyle,
            timeline,
            fromTick: 0,
            bpm: score.meta.bpm,
            tempo: audioTempo,
            stems: stems.map((s) => ({ buffer: s.buffer, gain: s.on ? 1 : 0 })),
            measureTicks,
          }}
        />
      ) : null}

      {helpOpen ? <HelpDialog dark={dark} initialTopic={mode === 'score' ? view === 'source' ? 'jps' : 'editing' : mode === 'align' ? 'alignment' : mode === 'library' ? 'library' : 'playback'} onClose={() => setHelpOpen(false)} /> : null}

      {/*
        编辑器主体只在「记谱 / 对轨」两屏渲染。
        gate 必须逐个排除新 mode：discover 是后来加的，漏在这里的结果是
        play.html 首页和整套编辑器（谱面 + 右侧属性栏）同时渲染——
        用户看到的就是「播放界面 + 音符编辑区 + 动态谱搜索条」混在一屏。
      */}
      {mode === 'score' || mode === 'align' ? (
      <div className="v2-body" data-view={view}>
        <main className="v2-stage" data-mode={mode}>
          <div className="v2-bar" data-mode={mode}>
            <div className="v2-library v2-hide-align">
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
              {/* 对轨时一眼看清正在对哪首（歌多的时候波形都长得像）；样式同播放页标题 */}
              {mode === 'align' ? (
                <span className="v2-play-title" title={score.meta.title || active}>
                  {score.meta.title || active}
                </span>
              ) : null}
              <button
                className={`v2-btn ${playing ? 'is-on' : ''}`}
                onClick={playing ? stopPlay : startPlay}
                disabled={timeline.length === 0}
                title={playing ? '停止' : '播放'}
              >
                {playing ? '⏹ 停止' : '▶ 播放'}
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
                <button
                  className={playStyle === 'ball' ? 'v2-seg is-on' : 'v2-seg'}
                  onClick={() => setPlayStyle('ball')}
                  title="发光小球拖着渐变尾巴，按抛物线轨迹逐音跳跃（深色发光照亮、浅色彩色点+阴影）"
                >
                  光球
                </button>
              </div>
            </div>

            {/* 简谱 / 源码整体切换：源码不是属性栏里的一个小格子，而是另一套视图 */}
            <div className="v2-view-switch v2-hide-align">
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

          {/* 音轨分离入口已移到顶部工具条（对轨组），波形上方腾出一行竖向空间 */}

          {view === 'score' ? (
            <>
              <PartsPanel score={documentScore} activeId={activePartId} total={totalView} lyricVerse={lyricVerse} onSelectLyrics={selectLyrics} onSelect={selectPart} onTotal={setTotalView} onChange={changeParts} />
              {lyricVerse !== null ? <div className="v2-lyric-tools">
                <strong>{lyricTrackNames(score)[lyricVerse]} · {score.part?.name ?? '声部 1'}</strong>
                <span>{notes ? '中文词句自动分格 · 空格确认 / 补空位 · ← → 移动' : '当前声部没有音符，请结束歌词输入后先写旋律'}</span>
                <button className="v2-btn" onClick={() => setLyricSelection(null)}>结束歌词输入</button>
              </div> : null}
              {/*
                对轨状态条：整个对轨流程的「下一步」永远只在这一行里说。
                四种状态（打拍 / 等待谱面点击 / 边听边校 / 空闲）各一句话，替代旧面板的全部说明文字。
              */}
              {mode === 'align' && stems.length > 0 ? (
                <div
                  className={`v2-align-status${tapping ? ' is-busy' : wavePos !== null ? ' is-active' : ''}`}
                >
                  <span className="v2-align-dot" aria-hidden />
                  <span className="v2-align-text">
                    {tapping
                      ? `听到重音就按空格（不用从第一拍开始）· 已打 ${taps.length} 拍${tapBpm ? ` · ≈${(Math.round(tapBpm * 10) / 10).toFixed(1)} 拍/分` : '，再打几拍波形上就出预测线'}，照粉色虚线继续按，停 2 秒自动结算`
                      : wavePos !== null
                        ? alignTab === 'edit'
                          ? `试听中 ${fmtClock(wavePos)}——要绑成对齐点，切到右侧「伴奏对轨」页签再点谱面小节线`
                          : `已选 ${fmtClock(wavePos)}${waveBeat !== null ? `（第 ${Math.round(waveBeat * 10) / 10} 拍）` : ''} → 点击谱面小节线完成绑定`
                        : playing && playSource === 'audio' && audioReady
                          ? '边听边校：指示条跟伴奏错位？按 N 在此刻加对齐点'
                          : audioReady
                            ? `${Math.round(tempoDraft.bpm)} 拍/分 · 已对齐 ${anchors.length} 处 · 点节奏线对齐，拖节奏线整组平移`
                            : '载入伴奏后自动测速 · 点节奏线 → 点谱面小节线完成对齐'}
                  </span>
                  {tapping ? (
                    <>
                      <button className="v2-btn" onClick={() => setTaps([])}>
                        重打
                      </button>
                      <button
                        className="v2-btn"
                        onClick={() => {
                          setTapping(false);
                          setPlaying(false);
                          playerRef.current.stop();
                        }}
                      >
                        取消
                      </button>
                    </>
                  ) : null}
                  {wavePos !== null ? (
                    <button
                      className="v2-btn"
                      onClick={() => {
                        setWavePos(null);
                        setWaveBeat(null);
                        previewRef.current.stop();
                        setPreviewing(false);
                      }}
                    >
                      Esc 取消
                    </button>
                  ) : null}
                  {playing && playSource === 'audio' && audioReady ? (
                    <button className="v2-btn" onClick={markMisalign}>
                      不对，在这对齐 (N)
                    </button>
                  ) : null}
                </div>
              ) : null}
              {mode === 'align' && stems.length > 0 && audioTempo ? (
                <div className="v2-wave-wrap v2-wave-wrap--big">
                  <span className="v2-wave-hover">
                    {waveHover
                      ? `第 ${waveHover.beat} 拍 · 小节 ${waveHover.bar} · ${waveHover.sec.toFixed(2)}s`
                      : '滚轮缩放 · 拖空白平移 · 拖节奏线整组平移'}
                  </span>
                  <AudioWaveform
                    stems={stems}
                    tempo={audioTempo}
                    dark={dark}
                    gridBpm={tempoDraft.bpm}
                    gridPhase={tempoDraft.phaseSec}
                    beatsPerMeasure={beatsPerMeasure(meterAt(score, snap.cursor))}
                    markerSec={wavePos}
                    markerBeat={waveBeat}
                    snap={waveSnap}
                    originSec={audioTempo ? tickToSec(audioTempo, 0) : null}
                    vocalSec={vocalSec}
                    anchors={anchors}
                    getPlaySec={() =>
                      previewRef.current.currentSec ?? playerRef.current.currentSec
                    }
                    previewing={previewing}
                    duration={Math.max(...stems.map((s) => s.buffer.duration))}
                    onSeek={seekWave}
                    onStop={stopPreview}
                    onBind={() => bindAnchor(false)}
                    canBind={wavePos !== null && (focusTimed || !!barlineFocus)}
                    bindLabel={barlineFocus ? '绑定选中线' : focusTimed ? '绑定选中音符' : '绑定'}
                    onHover={setWaveHover}
                    // 拖网格开始前停掉一切发声：试听放着时拖线，
                    // 播放头推进会让视图自动跟随滚动，线的视觉位移
                    // 和实际平移量对不上（用户实测「拖一半」的根源）
                    onGridShiftStart={() => {
                      stopPreview();
                      playerRef.current.stop();
                      clockRef.current.pause();
                      setPlaying(false);
                    }}
                    onGridShift={nudgePhase}
                    onGridShiftEnd={() => {}}
                    markerTitle={
                      wavePos !== null
                        ? `${waveBeat !== null ? `第 ${Math.round(waveBeat * 10) / 10} 拍 · ` : ''}${fmtClock(wavePos)}`
                        : undefined
                    }
                    markerIsAnchor={
                      waveBeat !== null && anchors.some((a) => Math.abs(a.audioBeat - waveBeat) < 0.5)
                    }
                    onDeleteAnchor={() => {
                      if (waveBeat !== null) deleteAnchorAt(waveBeat);
                      setWavePos(null);
                      setWaveBeat(null);
                    }}
                    onNudge={nudgePhase}
                    // 打拍定速进行中：波形上画出已打拍点 + 外推的预测网格，
                    // 用户照着粉色虚线继续按，不用靠耳朵硬抓拍点在哪
                    tapMarks={tapping ? taps : undefined}
                    tapGrid={
                      tapping && taps.length >= 2
                        ? { phase: taps[0]!, interval: tapBpm ? 60 / tapBpm : taps[1]! - taps[0]! }
                        : null
                    }
                  />
                  {/* 吸附：网格本身还没标准时（BPM / 相位都还是猜的）关掉它，
                      回到「人耳点的位置就是准绳」，不然会被按在错的拍上 */}
                  <label className="v2-wave-snap" title="点波形时吸到最近的节奏线（画面上真画出来的那条）">
                    <input
                      type="checkbox"
                      checked={waveSnap}
                      onChange={(e) => setWaveSnap(e.target.checked)}
                    />
                    吸附节奏线
                  </label>
                </div>
              ) : null}
              <ScoreCanvas
                score={totalView ? documentScore : score}
                activePartId={activePartId}
                dark={dark}
                unit={EDITOR_UNIT}
                selectedIds={selectedIds}
                cursor={snap.cursor}
                /* 记谱页永远画原谱 → 用原谱口径的时间线（展开视图是播放页的事） */
                timeline={timeline}
                playing={playing}
                clock={clockRef.current}
                getPlayTick={getPlayTick}
                onEnded={onPlayEnded}
                onPick={handlePick}
                onLayout={rememberLayout}
                showBreaks={mode === 'score'}
                focusId={overEvent?.id ?? null}
                showCaret={lyricVerse === null && snap.mode === 'insert'}
                playStyle={playStyle}
                onEditTitle={() => setSongInfoOpen((v) => !v)}
                onBlankClick={() => setSongInfoOpen(false)}
                lyricEdit={lyricVerse !== null && !playing ? {
                  partId: activePartId, verse: lyricVerse, startId: overId, session: lyricSelection!.session,
                  onCommit: (id, word) => {
                    const result = writeLyricInput(score, id, lyricVerse, word);
                    if (result.error) { setMsg(result.error); return false; }
                    setMsg(''); setScore(result.score); return true;
                  },
                  onInsertGap: (id) => {
                    const result = insertLyricGap(score, id, lyricVerse);
                    if (result.error) { setMsg(result.error); return false; }
                    setMsg(''); setScore(result.score); return true;
                  },
                  onDelete: (id, offset) => { setMsg(''); setScore(deleteLyricPosition(score, id, lyricVerse, offset)); return true; },
                  onExit: () => setLyricSelection(null),
                } : undefined}
                /* 波形上点过节奏线 = 配对中：光标变绑定样式 + 小节线画靶标，
                   点了小节线（绑定完成）就自动退出，光标恢复。
                   侧栏切到「简谱编辑」时不进入配对：那时点谱面是编辑 */
                pairing={lyricVerse === null && mode === 'align' && alignTab === 'align' && wavePos !== null}
                onPickStart={() => {
                  bindScoreStart();
                }}
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

        <aside className="v2-side" data-mode={mode}>
          {/*
            对轨屏的两个页签：伴奏对轨 / 简谱编辑。
            两块内容完全沿用记谱屏的那一套，只是按任务分开摆——
            对着伴奏补前奏 / 间奏不用再回记谱屏。记谱屏不出现页签。
          */}
          {mode === 'align' ? (
            <div className="v2-view-switch v2-side-tabs">
              <button
                className={alignTab === 'align' ? 'v2-seg is-on' : 'v2-seg'}
                onClick={() => switchAlignTab('align')}
              >
                伴奏对轨
              </button>
              <button
                className={alignTab === 'edit' ? 'v2-seg is-on' : 'v2-seg'}
                onClick={() => switchAlignTab('edit')}
                title="改谱面：补前奏、间奏，或修正音符（与记谱屏同一套面板）"
              >
                简谱编辑
              </button>
            </div>
          ) : null}
          {showEditBlocks ? (lyricVerse !== null ? <div className="v2-side-block">
            <div className="v2-side-title">歌词输入</div>
            <p className="v2-hint">当前行：{lyricTrackNames(score)[lyricVerse]}<br />关联声部：{score.part?.name ?? '声部 1'}</p>
            <p className="v2-hint">点击任一歌词格或对应音符即可从那里开始，前奏与间奏无需逐个跳过。</p>
            <p className="v2-hint">一次输入中文词句会逐字分到连续音符；新输入单字后按空格确认。回到已有歌词格按空格，会在该字前补一个空位，后续歌词顺延；空白格按空格跳过一音。</p>
            <p className="v2-hint">Tab / Enter / → 前进，Shift+Tab / ← 后退。音符位置不足时会提示，不会截断后续歌词。</p>
            <p className="v2-hint">退格删除选中的字；空白格或字前的光标按退格，删除前一位置（包括空位），后续歌词向前补齐。可以连续退格，也可撤销恢复。</p>
            <p className="v2-hint">输入法选字期间不会跳音。离开输入格写入歌词，点击「结束歌词输入」或按 Esc 回到写谱。</p>
          </div> : <>
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
              {/* 谱头说明：居中一行 + 右侧最多 4 行（@sub / @note），打印排版与图示简谱一致 */}
              <MetaInput
                label="说明行"
                value={score.meta.sub ?? ''}
                placeholder="标题下的一行说明，如：锣钹C20 管弦乐三重奏技法谱"
                onCommit={(v) => setScore(setMeta(score, { sub: v }))}
              />
              <MetaTextarea
                label="右侧说明"
                rows={4}
                value={(score.meta.notes ?? []).join('\n')}
                placeholder={'每行一条，最多 4 行\n如：流行小号(*和声常开)\n程序员老许制谱'}
                onCommit={(v) =>
                  setScore(
                    setMeta(score, {
                      notes: v
                        .split(/\r?\n/)
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .slice(0, 4),
                    }),
                  )
                }
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
              {/* 小节号：写在小节线下方的小字，随文件保存（@measureNo off 关掉） */}
              <label className="v2-grace-check" title="在小节线下方用小字标出小节号">
                <input
                  type="checkbox"
                  checked={score.meta.showMeasureNumbers !== false}
                  onChange={(e) => setScore(setMeta(score, { showMeasureNumbers: e.target.checked }))}
                />
                显示小节号
              </label>
            </div>
            <p className="v2-hint">
              调号支持升降号：1=bB、1=#F（♭B / ♯F 也认）。速度单位是 BPM，音色是 MIDI 音色号
              0–127。字号 / 字间距 / 小节号随文件保存。改完按回车或点别处生效。
            </p>
          </div>

          {/*
            小节线属性：点谱面里那条竖线选中它，在这里把它改成 |: / :| 或挂上房子。
            反复是**这条线的状态**——不会再插出第二条线。
            反复本身不参与排版的「逐音」流程——播放时由 expand.ts 展开成线性谱，
            编辑始终作用在这份带反复记号的原谱上。
          */}
          <div className={songInfoOpen ? 'v2-side-block is-hidden' : 'v2-side-block'}>
            <div className="v2-side-title v2-inspector-title">
              <span>小节线</span>
              {expansion.repeatedSections > 0 && expansion.score ? (
                <span className="v2-title-token" title="反复展开成顺序演奏后的事件数">
                  展开后 {expansion.score.events.filter((e) => e.kind === 'note').length} 音
                </span>
              ) : null}
            </div>
            {barlineFocus && canEditConductor ? (
              <>
                <div className="v2-field">
                  <span className="v2-field-label">此线之后的拍号</span>
                  <select className="v2-meta-input" aria-label="此线之后的拍号" value={barlineFocus.beatAfter ?? ''} onChange={(e) => setScore(setBarNotation(score, barlineFocus.id, { beatAfter: e.target.value || undefined }))}>
                    <option value="">沿用之前的拍号</option>
                    {['2/4', '3/4', '4/4', '5/4', '6/4', '2/2', '3/8', '6/8', '9/8', '12/8'].map((beat) => <option key={beat} value={beat}>{beat}</option>)}
                    {barlineFocus.beatAfter && !['2/4', '3/4', '4/4', '5/4', '6/4', '2/2', '3/8', '6/8', '9/8', '12/8'].includes(barlineFocus.beatAfter) ? <option value={barlineFocus.beatAfter}>{barlineFocus.beatAfter}</option> : null}
                  </select>
                </div>
                <div className="v2-field">
                  <span className="v2-field-label">此线之后的排版</span>
                  <div className="v2-grid">
                    <button className={`v2-btn ${!barlineFocus.breakAfter ? 'is-on' : ''}`} onClick={() => setScore(setBarNotation(score, barlineFocus.id, { breakAfter: undefined }))}>自动</button>
                    <button className={`v2-btn ${barlineFocus.breakAfter === 'line' ? 'is-on' : ''}`} onClick={() => setScore(setBarNotation(score, barlineFocus.id, { breakAfter: 'line' }))}>换行</button>
                    <button className={`v2-btn ${barlineFocus.breakAfter === 'page' ? 'is-on' : ''}`} onClick={() => setScore(setBarNotation(score, barlineFocus.id, { breakAfter: 'page' }))}>分页</button>
                  </div>
                </div>
                <div className="v2-grid v2-grid-4">
                  <button
                    className={`v2-btn ${barlineFocus.repeat === 'start' ? 'is-on' : ''}`}
                    onClick={() => setRepeat('start')}
                    title="把这条线改成反复开始 |:（再点一次取消）"
                  >
                    |:
                  </button>
                  <button
                    className={`v2-btn ${barlineFocus.repeat === 'end' ? 'is-on' : ''}`}
                    onClick={() => setRepeat('end')}
                    title="把这条线改成反复结束 :|（再点一次取消）"
                  >
                    :|
                  </button>
                  <span className="v2-field-label v2-inline-label">遍数</span>
                  <select
                    className="v2-grace-pick"
                    value={barlineFocus.repeat === 'end' ? (barlineFocus.times ?? 2) : 2}
                    disabled={barlineFocus.repeat !== 'end'}
                    onChange={(e) =>
                      setScore(setRepeatTimes(score, barlineFocus.id, Number(e.target.value)))
                    }
                  >
                    {[2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="v2-grace-bar">
                  <span className="v2-field-label v2-inline-label">房子</span>
                  {[1, 2, 3].map((n) => (
                    <button
                      key={n}
                      className={`v2-btn ${(barlineFocus.volta ?? []).includes(n) ? 'is-on' : ''}`}
                      onClick={() => setVolta(n)}
                      title={`房子 [${n}] 的左墙设在这根线，向右自动延伸到 :| 或下一间房。要罩住反复号前几个小节，就点那几小节的第 1 根小节线再来点这里`}
                    >
                      [{n}]
                    </button>
                  ))}
                  <button
                    className="v2-btn"
                    onClick={() => setScore(setBarlineStyle(score, barlineFocus.id, barlineFocus.style === 'final' ? 'single' : 'final'))}
                    title="终止线 ||（再点一次变回普通小节线）"
                  >
                    ||
                  </button>
                  {barlineFocus.volta ? (
                    <button
                      className={`v2-btn ${barlineFocus.voltaOpen ? 'is-on' : ''}`}
                      title="手动强制右端开放。通常自动判断：横线只盖连着标了同号的线，下一根线是 :| 就封闭，否则开放；这里点一下可覆盖自动判断"
                      onClick={() => setScore(setBarlineVoltaOpen(score, barlineFocus.id, !barlineFocus.voltaOpen))}
                    >
                      右端开放
                    </button>
                  ) : null}
                </div>
                {/*
                  跳转记号（L2）：挂在选中线**后面**（与 DSL 的 `$s` 写在线后一致）。
                  点亮 = 已挂；再点 = 摘掉；点另一颗 = 原地换。展开器负责跳转执行
                */}
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
                      <button
                        key={mark}
                        className={`v2-btn ${jumpAfterFocus === mark ? 'is-on' : ''}`}
                        title={tip}
                        onClick={() => setScore(toggleJumpAfterBarline(score, barlineFocus.id, jumpAfterFocus === mark ? null : mark))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {playOrder ? (
                  <p className="v2-hint">
                    演奏顺序：<b>第 {playOrder.join(' → ')} 小节</b>
                  </p>
                ) : null}
                <p className="v2-hint">
                  反复记号是这条线的属性：<b>|:</b> 开始、<b>:|</b> 结束，两点就画在这条线两侧。
                  播放会自动展开成顺序演奏。
                </p>
              </>
            ) : !canEditConductor ? (
              <p className="v2-hint">全谱的反复、跳房子与跳转由首声部控制。切换到「{documentScore.part?.name}」编辑，对应记号会同步到各声部。</p>
            ) : (
              <p className="v2-hint">
                点谱面里那条<b>竖线</b>选中它，就能把它改成 <b>|:</b> / <b>:|</b>，或给它挂上跳房子{' '}
                <b>[1]</b> / <b>[2]</b>。房子挂在它的<b>左墙</b>那根线上，向右自动延伸到 <b>:|</b>{' '}
                或下一间房——想罩住反复号前面的几个小节，点那几小节的<b>第 1 根</b>小节线再挂。
              </p>
            )}
          </div>

          {/* 属性检查器：点选什么就改什么，不需要记语法。打开曲目信息时让位 */}
          {/* 属性检查器：点选什么就改什么，不需要记语法。打开曲目信息时让位 */}
          <div className={songInfoOpen ? 'v2-side-block is-hidden' : 'v2-side-block'}>
            <div className="v2-side-title v2-inspector-title">
              <span>
                {range
                  ? `已选 ${range[1] - range[0]} 个事件`
                  : focus
                    ? `选中 ${eventLabel(focus)}${focusMeasure ? ` · 第 ${focusMeasure} 小节` : ''}`
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
                {/*
                  划分候选紧跟在总时值按钮下面：点「1 拍」弹出多个方案时，
                  视线不用跳到面板底部去找（旧版渲染在整个检查器之后，隔了一整屏）。
                */}
                {pending ? (
                  <div className="v2-field">
                    <span className="v2-field-label">选择划分（{pending.ids.length} 个音）</span>
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
                                const next = applyTierOp(score, pending.ids, pending.ticks, c.ticks, c.tuplet, c.dots);
                                if (next) commit({ ...snap, score: next });
                                setPending(null);
                              }}
                            >
                              <GroupGlyph
                                degrees={degrees}
                                beams={c.ticks.map((t, i) =>
                                  c.tuplet
                                    ? tupletBeamCount(pending.ticks, c.tuplet)
                                    : beamCount(undotTicks(t, c.dots?.[i] ?? 0)),
                                )}
                                tuplet={c.tuplet}
                                dots={c.dots}
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
                <div className="v2-field">
                  <span className="v2-field-label">跨音力度范围（首音至末音）</span>
                  <div className="v2-grid">
                    <button className="v2-btn" disabled={selectedTimedIds.filter((id) => score.events.find((e) => e.id === id)?.kind === 'note').length < 2} onClick={() => setScore(setHairpinRange(score, selectedTimedIds, 'cresc'))}>渐强</button>
                    <button className="v2-btn" disabled={selectedTimedIds.filter((id) => score.events.find((e) => e.id === id)?.kind === 'note').length < 2} onClick={() => setScore(setHairpinRange(score, selectedTimedIds, 'dim'))}>渐弱</button>
                    <button className="v2-btn" onClick={() => setScore(setHairpinRange(score, selectedTimedIds))}>清除范围</button>
                  </div>
                </div>
                {/*
                  跳房子走选区：选中一整个（或几个）小节直接设为第 n 房——
                  比逐根点小节线、脑补「房子从哪根线开始」直观得多。
                  条件与效果见 setVoltaFromSelection：选区头前是墙、尾后那根自动变 :|。
                */}
                <div className="v2-field">
                  <span className="v2-field-label">跳房子（选中完整小节）</span>
                  <div className="v2-grid">
                    {[1, 2, 3].map((nv) => (
                      <button
                        key={nv}
                        className="v2-btn"
                        disabled={!selectionVolta.score || !canEditConductor}
                        title="选区头前那根线挂上房子（左墙），选区尾的小节线自动变成 :|"
                        onClick={() => doSelectionVolta(nv)}
                      >
                        [{nv}]
                      </button>
                    ))}
                  </div>
                  <p className="v2-hint">
                    {selectionVolta.error ??
                      '整段小节一次跨进房子；再加第二间房时选中它的完整小节点 [2]，旧 :| 会自动并进同一段。'}
                  </p>
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
                  <span className="v2-field-label">
                    八度
                    {/* 快捷键写进标签：v 这个键位用户猜不到（大写 V 还是换气记号） */}
                    <span className="v2-tiers-label">（键盘 ^ 升八度 / v 降八度，可叠加，上限 3 颗点）</span>
                  </span>
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
                              className={`v2-btn v2-grace-key${key.accidental ? ' is-acc' : ''}`}
                              title={key.accidental ? `${key.accidental}${key.degree}（变音键）` : undefined}
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
                <div className="v2-field">
                  <span className="v2-field-label">标注（段落文字）</span>
                  {/*
                    草稿式输入（回车 / 点别处才提交），不能每敲一个字就写谱：
                    写谱会在音符前插入一个 directive，而「当前选中的音」是按下标取的
                    （events[cursor-1]）——下标一挪，焦点就落到新插入的标注上，
                    输入框当场卸载，中文输入法直接被打断（第一个字之后再也打不进去）。
                  */}
                  <input
                    className="v2-meta-input"
                    value={annotDraft ?? annotationTextOf(score, focus.id)}
                    placeholder="如：前奏；只打 ( 或 ) = 在音符左 / 右侧加括号"
                    title="段落文字标注（谱面显示为 (文字)）；只输入 ( 或 ) 则是在音符左侧 / 右侧加括号。回车或点别处提交"
                    onChange={(e) => setAnnotDraft(e.target.value)}
                    onBlur={() => {
                      if (annotDraft === null) return;
                      commitAnnotation(annotDraft);
                      setAnnotDraft(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return;
                      commitAnnotation(annotDraft ?? '');
                      setAnnotDraft(null);
                      (e.target as HTMLInputElement).blur();
                    }}
                  />
                </div>
                {/*
                  括号：两个独立记号——头一个音前放左括号、末一个音后放右括号，
                  中间隔几行都行（所以不做「选中区间加括号」那种成对操作）
                */}
                <div className="v2-field">
                  <span className="v2-field-label">括号（画在音符左右两侧，可跨行）</span>
                  <div className="v2-grace-bar">
                    <button
                      className={parenFlags.open ? 'v2-btn is-on' : 'v2-btn'}
                      title="在这个音左边加左括号（再点一次去掉）"
                      onClick={() => setScore(toggleParen(score, focus.id, 'open'))}
                    >
                      ( 左括号
                    </button>
                    <button
                      className={parenFlags.close ? 'v2-btn is-on' : 'v2-btn'}
                      title="在这个音右边加右括号（再点一次去掉）"
                      onClick={() => setScore(toggleParen(score, focus.id, 'close'))}
                    >
                      右括号 )
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
              <>
                <p className="v2-hint">
                  {focus
                    ? `当前是${eventLabel(focus)}，可以用 Delete 删除。`
                    : '点谱面上的音符来修改，或直接按 1-7 输入。'}
                </p>
              </>
            )}
          </div>

          </>) : null}

          {/*
            音频对齐（M9/M11）：载入 stem + 标定 TempoMap，播放时指示条跟着真实音频走。
            标定优先走「重新自动对齐」（浏览器端，beat.ts），锚点与手工微调做兜底。
            **常驻可见**（用户要求）：此前是 details 折叠块，收起嵌套的「高级参数」时
            toggle 会冒泡到父级，把整块一起收掉（实测踩到），而且对轨时还要先找到它。
            放在侧栏末尾：它属于「播放」而不属于「记谱」，不该跟音符属性混在一屏。
          */}
          {showAlignBlock ? (
          <div className={`v2-side-block v2-audio-block ${songInfoOpen ? 'is-hidden' : ''}`}>
            <div className="v2-side-title v2-inspector-title">
              <span>对轨</span>
              {audioReady ? <span className="v2-title-token">{Math.round(tempoDraft.bpm)} 拍/分</span> : null}
            </div>
            {/* 对轨页直接进来时可能还没有谱面（没有上次会话）：先给一句去哪拿谱 */}
            {score.events.length === 0 ? (
              <p className="v2-hint">
                还没有谱面。点左上角<b>「打开」</b>选一首 .jps，或回首页进入「曲库管理」，点击曲目的「对轨」。
              </p>
            ) : null}
            <div className="v2-field">
              <div className="v2-grace-bar">
                <button className="v2-btn" onClick={() => audioFileRef.current?.click()}>
                  {stems.length ? '更换音频' : '载入音频'}
                </button>
                {/* 有伴奏或锚点才给清除：没有东西可清时按钮只会制造困惑 */}
                {stems.length > 0 || anchors.length > 0 ? (
                  <button
                    className="v2-btn"
                    title="去掉本谱已载入的伴奏与全部标定（对齐点 / 速度 / 播放源）；音频文件保留，重载同一文件秒回。伴奏与标定都会随曲库自动保存"
                    onClick={clearAudioAlign}
                  >
                    清除
                  </button>
                ) : null}
              </div>
              {stems.length > 0 ? (
                <div className="v2-grace-bar">
                  {stems.map((s, i) => (
                    <label key={s.name + i} className="v2-grace-check" title={s.on ? '点击静音这条' : '点击打开这条'}>
                      <input type="checkbox" checked={s.on} onChange={() => toggleStem(i)} />
                      {s.name.replace(/\.(wav|mp3|ogg|flac)$/i, '')}
                    </label>
                  ))}
                </div>
              ) : null}
              <input
                ref={audioFileRef}
                type="file"
                accept=".wav,.mp3,.ogg,.flac,audio/*"
                multiple
                hidden
                onChange={(e) => {
                  void onAudioPicked(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="v2-field">
              <div className="v2-grace-bar">
                {/* 打拍定速：自动测速锁错倍频（谱 8 拍对上音频 17 拍）时的人工补救——
                    人耳不会数错倍频。进行中的提示与按钮全在对轨状态条里 */}
                <button
                  className="v2-btn"
                  disabled={stems.length === 0 || tapping}
                  title="自动测速不准（网格线压不住鼓点）时用它：跟着音乐按空格打 4-8 拍，速度与起点一次定准；停 2 秒自动结算"
                  onClick={startTapping}
                >
                  {tapping ? '打拍中…' : '打拍定速'}
                </button>
                {/* 网格微调：间距对但整条差一点；也可以直接在波形上拖任意一条节奏线 */}
                {stems.length > 0 ? (
                  <span className="v2-title-token" title="网格起点在音频里的位置；拖波形上的节奏线也能整组平移">
                    {fmtClock(tempoDraft.phaseSec)}
                  </span>
                ) : null}
                {stems.length > 0 ? (
                  <>
                    <button className="v2-btn" title="整条网格往左挪 100 毫秒" onClick={() => nudgePhase(-0.1)}>
                      «
                    </button>
                    <button className="v2-btn" title="整条网格往左挪 10 毫秒" onClick={() => nudgePhase(-0.01)}>
                      ‹
                    </button>
                    <button className="v2-btn" title="整条网格往右挪 10 毫秒" onClick={() => nudgePhase(0.01)}>
                      ›
                    </button>
                    <button className="v2-btn" title="整条网格往右挪 100 毫秒" onClick={() => nudgePhase(0.1)}>
                      »
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="v2-field">
              <div className="v2-grace-bar">
                <button
                  className={`v2-btn ${playSource === 'audio' ? 'is-on' : ''}`}
                  disabled={!audioReady}
                  title="跟着伴奏对齐就用这个"
                  onClick={() => setPlaySource('audio')}
                >
                  伴奏音频
                </button>
                {playSource === 'audio' ? (
                  <label className="v2-grace-check" title="谱面只从进唱记起时，伴奏前面的前奏照常放完再进谱面；进唱前 4 拍会在第一个音上闪烁倒数">
                    <input
                      type="checkbox"
                      checked={playIntro}
                      onChange={() => setPlayIntro((v) => !v)}
                    />
                    播放前奏
                  </label>
                ) : null}
                <button
                  className={`v2-btn ${playSource === 'synth' ? 'is-on' : ''}`}
                  title="只听谱面合成音"
                  onClick={() => setPlaySource('synth')}
                >
                  合成音
                </button>
              </div>
            </div>
            <details className="v2-adv">
              <summary>手动输入与诊断（锚点 / BPM / 微调）</summary>
            <div className="v2-field">
              <div className="v2-grace-bar">
                {/* 单点对准：某个字总是差半拍时的精修——波形点的时刻 = 选中那颗音 */}
                <button
                  className="v2-btn"
                  disabled={wavePos === null || !stems.length}
                  title="让选中的音符正好落在波形上点的时刻。没绑变速曲线时：单点对准，整谱反推；已绑变速曲线时：在此处加锚点微调，已有对齐点保留"
                  onClick={alignHere}
                >
                  {focusTimed ? '把选中的音对到这里' : '对准这里'}
                </button>
                {spanAudit && (spanAudit.ratio < 0.7 || spanAudit.ratio > 1.4) ? (
                  <span className="v2-title-token">⚠ 谱面长度和音频差 {(spanAudit.ratio * 100).toFixed(0)}%，多半是倍速估错（试 ÷2 / ×2 或打拍）</span>
                ) : null}
              </div>
            </div>
            <div className="v2-field">
              <span className="v2-field-label">快速锚定（谱面拍 ↔ 音频拍）</span>
              <div className="v2-grace-bar">
                谱面第
                <input
                  className="v2-num"
                  type="number"
                  step={0.5}
                  value={quickAnchor.score}
                  onChange={(e) => setQuickAnchor((q) => ({ ...q, score: Number(e.target.value) }))}
                />
                拍 ↔ 音频第
                <input
                  className="v2-num"
                  type="number"
                  step={1}
                  title="可为负数：网格第 0 拍之前的拍位（打拍起点之前的前奏）同样有效"
                  value={quickAnchor.audio}
                  onChange={(e) => setQuickAnchor((q) => ({ ...q, audio: Number(e.target.value) }))}
                />
                拍
                <button
                  className="v2-btn"
                  onClick={() => {
                    if (!Number.isFinite(quickAnchor.score) || !Number.isFinite(quickAnchor.audio)) return;
                    const a = { scoreBeat: quickAnchor.score, audioBeat: quickAnchor.audio };
                    setAnchors((list) => [...list.filter((x) => x.scoreBeat !== a.scoreBeat), a]);
                    // 单锚点也要立即生效：恒定 BPM 的原点 = 音频拍 − 谱面拍。
                    // 之后再钉第二个锚点，audioTempo 会自动换成拉伸曲线。
                    setTempoOverride(null);
                    setPivotBeat(a.scoreBeat);
                    setTempoDraft((d) => ({
                      ...d,
                      originBeat: Math.round((a.audioBeat - a.scoreBeat) * 100) / 100,
                    }));
                    setAudioMsg(
                      `已锚定：谱面第 ${a.scoreBeat} 拍 ↔ 音频第 ${a.audioBeat} 拍。` +
                        (anchors.length + 1 >= 2
                          ? '已有 2 个以上锚点，段间按变速曲线拉伸。'
                          : '再钉一个锚点即可让前奏按实际长度拉伸对齐。'),
                    );
                  }}
                >
                  绑定
                </button>
              </div>
            </div>
            <div className="v2-field">
              <span className="v2-field-label">对齐点</span>
              {focusTimed ? (
                <p className="v2-hint">
                  已选中音符（谱面第 {focusScoreBeat} 拍）——波形定点后点「绑定选中音符」即可。
                </p>
              ) : null}
              {anchors.length > 0 ? (
                <div className="v2-grace-bar">
                  {anchors.map((a, i) => (
                    <span key={i} className="v2-title-token" title={`谱面第 ${a.scoreBeat} 拍 ↔ 音频第 ${a.audioBeat} 拍`}>
                      谱{a.scoreBeat}↔音{a.audioBeat}
                    </span>
                  ))}
                  <button
                    className="v2-btn"
                    onClick={() => {
                      setAnchors([]);
                      setAudioMsg('锚点已清空（对齐参数恢复为自动对齐 / 手工值）');
                    }}
                  >
                    清除锚点
                  </button>
                </div>
              ) : null}
              {impliedBpm !== null ? (
                <p className="v2-hint">
                  两点实测 <b>{impliedBpm} BPM</b>（当前填 {tempoDraft.bpm}，跨度 {anchorSpan} 拍
                  {anchorSpan < 40 ? '，偏近、仅供参考' : ''}）
                  <button className="v2-btn" onClick={applyImpliedBpm} title="把音频 BPM 改成两点实测值（对齐点位置不变）">
                    用实测改 BPM
                  </button>
                </p>
              ) : null}
            </div>
            <div className="v2-field">
              <span className="v2-field-label">估测 BPM（导入伴奏时算的）</span>
              {tempoEst ? (
                <div className="v2-grace-bar">
                  {/* 一句话 + 可信度分级；相位 / 残差 / 置信数值收进悬停 */}
                  <span
                    className="v2-title-token"
                    title={`技术细节：网格起点 ${tempoEst.phaseSec}s · 置信 ${tempoEst.confidence} · 残差 ${tempoEst.residualMs}ms`}
                  >
                    自动测速 ≈{Math.round(tempoEst.bpm)} 拍/分 ·{' '}
                    {tempoEst.confidence >= 0.5
                      ? '比较可信'
                      : tempoEst.confidence >= 0.25
                        ? '不太有把握'
                        : '很不可靠'}
                  </span>
                  <button
                    className="v2-btn"
                    title={`把谱面速度（@bpm）改成 ${Math.round(tempoEst.bpm)}`}
                    onClick={() => {
                      const v = Math.round(tempoEst.bpm);
                      setScore(setMeta(score, { bpm: v }));
                      setAudioMsg(`谱面速度已改成 ${v}（原 ${Math.round(score.meta.bpm)}）`);
                    }}
                  >
                    写进谱面速度（现 {Math.round(score.meta.bpm)}
                    {Math.abs(Math.round(tempoEst.bpm) - Math.round(score.meta.bpm)) >= 1
                      ? ` → ${Math.round(tempoEst.bpm)}`
                      : ''}
                    ）
                  </button>
                  <button
                    className="v2-btn"
                    title="用当前谱面的音符起拍重新搜 BPM / 相位 / 原点（换过谱或上次没对上时点它）"
                    onClick={() => void runAutoAlign()}
                  >
                    重新自动对齐
                  </button>
                  <button
                    className="v2-btn"
                    title={`不搜速度，直接按谱面 @bpm ${Math.round(score.meta.bpm)} 定相位与原点（BPM 明明是对的、却被估成倍速时用它）`}
                    onClick={() => void runAutoAlign('', undefined, score.meta.bpm)}
                  >
                    按谱面速度（{Math.round(score.meta.bpm)}）
                  </button>
                </div>
              ) : (
                <p className="v2-hint">导入伴奏后自动估测；也可以手工在下面填。</p>
              )}
              {spanAudit ? (
                <p className="v2-hint" title={`谱面 ${Math.round(scoreBeats)} 拍 ≈ ${spanAudit.span.toFixed(1)}s；音频从谱面起点算还剩 ${spanAudit.remaining.toFixed(1)}s`}>
                  体检：谱面长度与音频{spanAudit.ratio < 0.7 || spanAudit.ratio > 1.4 ? <b>对不上（速度多半测错了）</b> : '基本吻合'}
                </p>
              ) : null}
            </div>
            <div className="v2-field">
              <span className="v2-field-label">手工微调（一般用「打拍子」代替）</span>
              <div className="v2-grace-bar">
                <label className="v2-grace-check">
                  拍/分
                  <input
                    className="v2-num"
                    type="number"
                    step={0.01}
                    min={20}
                    max={300}
                    value={tempoDraft.bpm}
                    disabled={tempoOverride !== null}
                    onChange={(e) => setTempoDraft((d) => ({ ...d, bpm: Number(e.target.value) }))}
                  />
                </label>
                <label className="v2-grace-check" title="节奏网格的第 0 拍在音频里的位置（秒）。打拍子会自动算好，一般不用手填">
                  起点(秒)
                  <input
                    className="v2-num"
                    type="number"
                    step={0.01}
                    value={tempoDraft.phaseSec}
                    disabled={tempoOverride !== null}
                    onChange={(e) => setTempoDraft((d) => ({ ...d, phaseSec: Number(e.target.value) }))}
                  />
                </label>
                <label className="v2-grace-check" title="谱面第 0 拍对应音频的第几拍（负数 = 谱面比音频晚开始）。「对准这里」会自动算好">
                  开头对位
                  <input
                    className="v2-num"
                    type="number"
                    step={0.5}
                    value={tempoDraft.originBeat}
                    disabled={tempoOverride !== null}
                    onChange={(e) => setTempoDraft((d) => ({ ...d, originBeat: Number(e.target.value) }))}
                  />
                </label>
                <button
                  className="v2-btn"
                  onClick={() => scaleTempo(0.5)}
                  title="谱面跑得太快？多半是估成了倍速（细网格是粗网格的超集，聚拢度天然偏快）。点这个减半，绑定点保持不变"
                >
                  ÷2
                </button>
                <button
                  className="v2-btn"
                  onClick={() => scaleTempo(2)}
                  title="谱面跑得太慢就翻倍，绑定点保持不变"
                >
                  ×2
                </button>
              </div>
            </div>
            </details>
            {audioMsg ? <p className="v2-hint">{audioMsg}</p> : null}
          </div>
          ) : null}
        </aside>
      </div>
      ) : null}

      {/* 动态谱首页（play.html 首屏）：看最新的、收藏的、搜过的、全部的，点歌进播放 */}
      {mode === 'discover' ? (
        <DiscoverScreen
          onOpen={playLibraryItem}
          homeHref="./index.html"
          onHelp={() => setHelpOpen(true)}
          msg={msg}
        />
      ) : null}

      {/* 曲库是顶层界面（不是弹窗）：它管的是一批谱，动作铺得开才好用 */}
      {mode === 'library' ? (
        <LibraryScreen
          onOpen={playLibraryItem}
          onEdit={editLibraryItem}
          onNotify={setMsg}
          msg={msg}
          readOnly={entry === 'play'}
          {...(entry === 'play' ? { onBackHome: () => setMode('discover') } : {})}
        />
      ) : null}

      {/*
        音轨分离工具说明：点了工具按钮才弹，遮罩点击 / 关闭按钮都能收。
        网址同时给成可点的链接和纯文本——桌面版里外链不一定打得开浏览器，
        纯文本还能手动复制。
      */}
      {tramaOpen ? (
        <div
          className="v2-exp-mask"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setTramaOpen(false);
          }}
        >
          <div className="v2-exp" role="dialog" aria-label="音轨分离工具">
            <div className="v2-exp-head">
              <span className="v2-exp-song">音轨分离工具</span>
              <button className="v2-btn" onClick={() => setTramaOpen(false)}>
                关闭
              </button>
            </div>
            <div className="v2-exp-body">
              <p className="v2-exp-hint">
                Ohlhorst Digital Trama（简称 OD Trama）是一款完全免费的音频音轨分离图形界面软件，
                由知名音频工程师 Jan Ohlhorst 以个人母带处理需求为起点开发，后免费向公众开放。
              </p>
              <p className="v2-exp-hint">
                下载地址：{' '}
                <a
                  className="v2-exp-link"
                  href="https://ohlhorstdigital.com/trama/"
                  target="_blank"
                  rel="noreferrer"
                >
                  https://ohlhorstdigital.com/trama/
                </a>
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/*
        绑定成功的确认弹窗：浮在顶部正中，几秒后自己收起，点一下也能关。
        不做成带确定按钮的模态框——绑定锚点是连续动作（绑一个再看下一个），
        每次都要点「确定」会把节奏打断；但「成没成」必须一眼可见
      */}
      {bindToast ? (
        <div className="v2-toast" key={bindToast.key} role="status" onClick={() => setBindToast(null)}>
          <span className="v2-toast-icon" aria-hidden>
            ✓
          </span>
          <span className="v2-toast-text">
            <b>{bindToast.title}</b>
            <span>{bindToast.body}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 谱面总拍数（含休止符）。判「这份谱是不是整曲转录」用：
 * 谱面总时长 ÷ 音频时长 ≈ 1 就说明速度档对了，≈ 0.5 / 2 就是倍速错了。
 */
function totalScoreBeats(score: Score): number {
  let t = 0;
  for (const e of score.events) if (e.kind === 'note' || e.kind === 'rest') t += e.ticks;
  return t / TICKS_PER_BEAT;
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

/**
 * 多行版的曲目信息项（右侧说明，每行一条）。
 * 提交时机同 MetaInput：输入即提交，失焦把草稿对齐回外部值。
 */
function MetaTextarea({
  label,
  value,
  onCommit,
  rows = 3,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const external = String(value);
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(external);
  return (
    <label className="v2-meta-row">
      <span className="v2-meta-label">{label}</span>
      <textarea
        className="v2-meta-input"
        rows={rows}
        placeholder={placeholder}
        value={focused ? draft : external}
        onFocus={() => {
          setFocused(true);
          setDraft(external);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          onCommit(e.target.value);
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
  dots,
}: {
  degrees: number[];
  /** 每个音的减时线条数 */
  beams: number[];
  tuplet?: number;
  /** 每个音的附点数（附点切分候选用，缺省无点） */
  dots?: (0 | 1 | 2)[];
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
            {dots?.[j] ? <span className="v2-dotglyph-dot">{'.'.repeat(dots[j])}</span> : null}
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
    case 'barline': {
      // 反复 / 房子都是这条线的属性，标签里一并说清
      if (e.repeat === 'start') return '反复开始 |:';
      if (e.repeat === 'end') return `反复结束 :|${e.times && e.times > 2 ? e.times : ''}`;
      if (e.volta) return `跳房子 [${e.volta.join(',')}]`;
      return e.style === 'final' ? '终止线 ||' : e.partial ? '弱起小节线' : '小节线';
    }
    case 'jump':
      return '跳转记号';
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
    format: 3,
    meta: { title: '未命名曲谱', key: '1=C', beat: '4/4', bpm: 90, patch: 73 },
    events: [],
    groups: [],
  };
}
