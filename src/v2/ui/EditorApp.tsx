import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import molihua from '../../scores/molihua.jps?raw';
import molihuaRepeat from '../../scores/molihua-repeat.jps?raw';
import songbie from '../../scores/songbie.jps?raw';
import huanlesong from '../../scores/huanlesong.jps?raw';
import qinghuaci from '../../scores/qinghuaci.jps?raw';
import xiaoxingxing from '../../scores/xiaoxingxing.jps?raw';
import shengrikuaile from '../../scores/shengrikuaile.jps?raw';
import ensembleDemo from '../../scores/ensemble-demo.jps?raw';
import notationPhase2Demo from '../../scores/notation-phase2-demo.jps?raw';
import lyricsDemo from '../../scores/lyrics-demo.jps?raw';
import lyricConnectionsDemo from '../../scores/lyric-connections-demo.jps?raw';
import quartetDemo from '../../scores/quartet-demo.jps?raw';
import { meterAt } from '../meter';
import type { LayoutOptions, LayoutResult } from '../layout';
import { deleteLyricPosition, insertLyricGap, lyricTrackNames, writeLyricInput, setLyricLink } from '../lyrics';
import type { LyricLink } from '../types';
import { toggleParen } from '../edit';
import { HelpDialog } from './HelpCenter';
import { AndroidPlayer } from './AndroidPlayer';
import type { PackBundle } from './packBundle';
import {
  applyTier as applyTierOp,
  autoGroupBeats,
  cycleDot,
  pasteEvents,
  setBarNotation,
  extendPrev,
  insertBarline,
  insertNote,
  insertRest,
  setBarlineRepeat,
  setBarlineStyle,
  setBarlineVolta,
  setBarlineVoltaOpen,
  setVoltaFromSelection,
  toggleJumpAfterBarline,
  groupCandidates,
  groupTierOptions,
  resplitOversizedGroups,
  extendSlurRight,
  nextTimed,
  prevTimed,
  removeEvent,
  pressBarline,
  setAccidental,
  setDegree,
  setMeta,
  setRepeatTimes,
  setOctave,
  setTicks,
  cycleOctave,
  shiftOctave,
  shiftOctaveMany,
  toggleSlur,
  toggleTongue,
  type TierCandidate,
} from '../edit';
import type { BeatClock } from '../clock';
import { BeatClock as Clock } from '../clock';
import { Player } from '../audio';
import { DEFAULT_META, parseDsl, serializeDsl } from '../dsl';
import {
  canWriteInPlace,
  fromText,
  nameOf,
  openScoreViaDialog,
  openScoreViaFsAccess,
  saveBytesAsFile,
  saveScore,
  type FsFileHandle,
  type OpenResult,
} from '../io';
import { loadSession, saveSession } from '../session';
import { durationTiers, TICKS_PER_BEAT, undotTicks } from '../ticks';
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
  toMidi,
} from '../timeline';
import { previewNote, disposePreview } from '../notePreview';
import type { Accidental, BarlineEvent, BeatGroup, Degree, Event, JumpMark, Score } from '../types';
import { beatToSec, secToBeat, constantTempo, curveFromAnchors, scaleTempo as scaleTempoMap, secToTick, tempoCurveFromScore, tempoFromAlign, tickToSec, type Anchor, type TempoMap } from '../tempo';
import { detectVocalEntry, scoreNoteOnsets, type TempoEstimate } from '../beat';
import { analyzeBeats, rhythmSource } from '../beatClient';
import { AudioPreview } from '../audio';
import AudioWaveform from './AudioWaveform';
import { DEFAULT_FONT_SIZE, DEFAULT_LETTER_SPACING, isTimed } from '../types';
import { useExp } from '../experimental';
import { STAFF_INSTRUMENTS, type StaffPitchMode, type StaffInstrument, type StaffClefSetting, type StaffClef } from '../pitch';
import { resolveStaffClef, suggestStaffClef } from '../staffClef';
import { validateGroups } from '../validate';
import { ScoreCanvas, type ScorePick } from './ScoreCanvas';
import { LibraryScreen } from './LibraryScreen';
import { ToastView, useToast } from './toast';
import { LibrarySetupDialog } from './LibrarySetupDialog';
import { initStore } from './storeInit';
import { defaultLibraryPath, isLibraryConfigured, onStoreBackendChange } from './storeBackend';
import { IS_ANDROID_APP } from '../platform';
import { isTauri } from '../io';
import { DiscoverScreen } from './DiscoverScreen';
import { ExportDialog } from './ExportDialog';
import { ExpClose } from './ExpClose';
import { ThemeToggle } from './ThemeToggle';
import { loadPianoSamples } from '../pianoSamples';
import { buildPack, PACK_EXT, packFileName, readPack } from './packBundle';
import { importLibrary, updateLibraryItem, type LibraryItem } from './libraryStore';
import { assembleParts, partScore, replacePart, scoreParts } from '../parts';
import { PartsPanel } from './PartsPanel';
import { pitchShiftStems } from '../pitchClient';
import {
  Metronome,
  metronomeAvailable as metronomeAvailableIn,
  meterSegmentsOf,
  patternFor,
} from '../metronome';
import { MetronomePanel } from './MetronomePanel';
import { PlayTimbreDialog } from './PlayTimbreDialog';
import { AndroidTimbreDialog } from './AndroidTimbreDialog';
import { applyTimbre, readTimbreMap, writeTimbre, type PlayTimbre } from './playTimbre';
import { CustomGroupDialog } from './CustomGroupDialog';
import { PadBody } from './PadBody';
import {
  instrumentLabel,
  instrumentPatches,
  instrumentSource,
  onInstrumentBanksChange,
  preloadInstrumentSamples,
} from '../instrumentSamples';
import { loadSavedBanks } from './instrumentBank';
import { ACCIDENTAL_CHOICES } from './NoteFields';
import type { PadActions } from './PadBody';

/** 变调锁死区间（半音）：±3 内无明显失真，放宽到 ±5 大调性移动也够用，再远「橡皮音」明显 */
const MAX_SEMITONES = 5;
/** 变速锁死区间（倍）：±25% 内听感最佳，0.60–1.40 覆盖慢练 / 快跟的实用范围 */
const MIN_SPEED = 0.6;
const MAX_SPEED = 1.4;
const SPEED_STEP = 0.05;

/** 播放界面的空选区：引用必须稳定，内联 new Set() 每次渲染都会触发整谱重排 */
const EMPTY_SELECTED: ReadonlySet<string> = new Set();
/** 安卓由播放器轮询收尾；引用保持稳定，避免进度刷新重启光球动画并清空拖尾。 */
const onAndroidScoreEnded = () => {};

/**
 * 恒定 BPM 三参数的默认值。换谱 / 新建时一律回到它——
 * 不重置的话，上一首的 BPM / 相位 / 原点会残留到新谱上：
 * 新音频估测不自信时（设计上不写入）界面显示的就是上一首的旧值
 */
const DEFAULT_TEMPO_DRAFT: { bpm: number; phaseSec: number; originBeat: number; beatTimes?: number[] } = { bpm: 108, phaseSec: 0.31, originBeat: 36 };

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
 * 时值的人话标签（拍数）：2 拍 / 1 拍 / 1/2 拍 / 1/4 拍 / 1/8 拍 …
 * 标题行用它，而不是把音符也写进去的谱面写法——
 * 「5/2」会被读成五分之二，其实那是音级 5 加 1/2 拍。
 */
function durLabel(ticks: number): string {
  const beats = ticks / TICKS_PER_BEAT;
  if (Number.isInteger(beats)) return `${beats} 拍`;
  for (const den of [2, 3, 4, 5, 6, 7, 8, 12, 16]) {
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

const BUILTIN: { name: string; text: string }[] = [
  { name: '茉莉花', text: molihua },
  { name: '茉莉花（反复）', text: molihuaRepeat },
  { name: '送别', text: songbie },
  { name: '欢乐颂', text: huanlesong },
  { name: '小星星', text: xiaoxingxing },
  { name: '生日快乐（3/4 拍）', text: shengrikuaile },
  { name: '青花瓷', text: qinghuaci },
  { name: '欢乐颂（二重奏示例）', text: ensembleDemo },
  { name: '拍号与力度范围（重奏示例）', text: notationPhase2Demo },
  { name: '多段歌词（重奏示例）', text: lyricsDemo },
  { name: '歌词延唱与英文连字', text: lyricConnectionsDemo },
  { name: '小星星（四声部示例）', text: quartetDemo },
];

/** 播放页观看偏好的本地存取（字号 / 字距 / 行距；null = 跟随谱面） */
function readPlayViewPref(): { font: number | null; gap: number | null; lineGap: number | null } {
  try {
    const v = JSON.parse(localStorage.getItem('ws-playview') ?? 'null') as {
      font?: number | null;
      gap?: number | null;
      lineGap?: number | null;
    } | null;
    if (!v) return { font: null, gap: null, lineGap: null };
    return {
      font: typeof v.font === 'number' ? v.font : null,
      gap: typeof v.gap === 'number' ? v.gap : null,
      lineGap: typeof v.lineGap === 'number' ? v.lineGap : null,
    };
  } catch {
    return { font: null, gap: null, lineGap: null };
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
export type Entry = 'app' | 'editor' | 'align' | 'library' | 'play' | 'android-player';

export function EditorApp({ entry = 'app', androidItem, androidDark, androidPreview = false, androidPack, onAndroidBack }: {
  entry?: Entry; androidItem?: LibraryItem; androidDark?: boolean; androidPreview?: boolean;
  androidPack?: PackBundle; onAndroidBack?: () => void;
}) {
  const androidPlayer = entry === 'android-player';
  const androidResumeTick = useRef<number | null>(null);
  const androidAlive = useRef(true);
  const [androidNarrow, setAndroidNarrow] = useState(() => window.innerWidth < 760);
  const [androidPartPick, setAndroidPartPick] = useState<string | null>(null);
  /** 安卓播放设置里的「合成音音色」弹窗（数据与 PC 版共用 playTimbre） */
  const [anTimbreOpen, setAnTimbreOpen] = useState(false);
  useEffect(() => {
    if (!androidPlayer) return;
    const media = matchMedia('(max-width: 759px)');
    const update = () => setAndroidNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [androidPlayer]);
  /**
   * 深浅主题。初始值：安卓由原生壳给定 → 上次手动选的（ws-theme）→ 系统偏好。
   * 各页面是独立 HTML，主题必须落 localStorage 才能跨页一致；月亮开关（ThemeToggle）负责改它。
   */
  const [dark, setDark] = useState(
    () =>
      androidDark ??
      (localStorage.getItem('ws-theme') === 'dark'
        ? true
        : localStorage.getItem('ws-theme') === 'light'
          ? false
          : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)),
  );
  useEffect(() => {
    if (!androidPlayer) localStorage.setItem('ws-theme', dark ? 'dark' : 'light');
  }, [dark, androidPlayer]);
  // 真实钢琴起音采样：进页面就后台拉取（440KB，CC-BY Salamander），
  // 失败静默——renderNote 检测不到采样时自动回退纯合成音色
  useEffect(() => {
    void loadPianoSamples();
  }, []);
  // 音色包登记变化（导入 / 移除 / 启动恢复）时刷新整棵树：
  // 曲目信息 / 声部配置的音色下拉都是渲染时现取 instrumentPatches()，
  // 不刷新的话刚导入的音色要等下一次无关的重渲染才会冒出来
  const [, bumpBanks] = useState(0);
  useEffect(() => onInstrumentBanksChange(() => bumpBanks((v) => v + 1)), []);
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
  /**
   * 浏览器端用 File System Access API 打开时拿到的文件句柄。
   * 有它时「保存」= 原地写回打开的那个文件（不下载新副本）；
   * 没有（<input> 选的、新建的、Safari / Firefox）就退回下载。
   */
  const [fileHandle, setFileHandle] = useState<FsFileHandle | null>(null);
  /**
   * 当前这份谱是**曲库里哪一条**（从曲库打开时才记下 id）。
   * 保存只回写这一条：从磁盘打开 / 新建的谱不碰曲库——
   * 按歌名同步会默默塞进曲库，还会盖掉同名却是另一首的曲子。
   */
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [past, setPast] = useState<Snap[]>([]);
  const [future, setFuture] = useState<Snap[]>([]);
  const [pending, setPending] = useState<{ ids: string[]; ticks: number; cands: TierCandidate[] } | null>(
    null,
  );
  /** 节拍器：跟随谱面播放 */
  const [metronomeFollow, setMetronomeFollow] = useState(false);
  /** 自定义音值组合弹窗（依附于 pending 的选区与目标时值） */
  const [customGroupOpen, setCustomGroupOpen] = useState(false);
  /** 节拍器面板开关 */
  const [metronomeOpen, setMetronomeOpen] = useState(false);
  const [timbreOpen, setTimbreOpen] = useState(false);
  /** 节拍器节奏型（拍内细分） */
  const [metronomePatternId, setMetronomePatternId] = useState('quarter');
  const [metronomeVolume, setMetronomeVolume] = useState(0.6);
  const metronomeRef = useRef<Metronome | null>(null);
  const [draft, setDraft] = useState('');
  /** 整体视图：要么看简谱，要么看源码。源码不再塞在属性栏里。 */
  const [view, setView] = useState<'score' | 'source'>('score');
  const [helpOpen, setHelpOpen] = useState(false);
  const [lyricSelection, setLyricSelection] = useState<{ partId: string; verse: number; session: number; startId?: string } | null>(null);
  const [lyricCellId, setLyricCellId] = useState<string | null>(null);
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
    if (androidPlayer) return 'play';
    if (entry === 'play') return 'discover'; // 独立入口：首屏是动态谱首页，点歌才进播放
    if (entry !== 'app') {
      return entry === 'library' ? 'library' : entry === 'align' ? 'align' : 'score';
    }
    const saved = localStorage.getItem('ws-mode');
    return saved === 'align' || saved === 'library' || saved === 'play' ? saved : 'score';
  });
  /**
   * 播放页左上角「返回」该回哪：从曲库点歌进来 → 回曲库；从动态谱首页进来 → 回动态谱
   * （play.html 独立入口还会额外给一个回落地页的「返回首页」）。
   * 与对轨页那个 backFrom 分开记：两屏的来路互不相干。
   */
  const [playFrom, setPlayFrom] = useState<'library' | 'discover'>(
    localStorage.getItem('ws-mode') === 'library' ? 'library' : 'discover',
  );

  /**
   * 单功能页左上角「返回」该回哪：从曲库点「对轨」进来 → 回曲库；从首页进来 → 回首页。
   * 以**真实来路**为准：跳转进来的话 referrer 就是上一页（从曲库来 = library.html）。
   * 刷新 / 直接输网址时 referrer 会变成自己或为空，这时才用上次记住的来路
   * （sessionStorage，同标签页有效）——刷新前后按钮不会变。
   * 早先拿会话里的 libraryId 兜底是错的：那份草稿可能来自上一天的曲库操作，
   * 于是从首页进也被判成「来自曲库」（用户实测）。
   */
  const [backFrom] = useState<'library' | 'home'>(() => {
    try {
      const here = location.pathname;
      const ref = document.referrer;
      const navigated = !!ref && !ref.includes(here); // 真·跳转，不是刷新 / 直接输网址
      const from: 'library' | 'home' = navigated
        ? ref.includes('library.html')
          ? 'library'
          : 'home'
        : sessionStorage.getItem('ws-back-from') === 'library'
          ? 'library'
          : 'home';
      sessionStorage.setItem('ws-back-from', from);
      return from;
    } catch {
      /* 隐私模式读不到存储：按首页算，宁可回落地页也不会走错 */
      return 'home';
    }
  });
  useEffect(() => {
    if (!androidPlayer) localStorage.setItem('ws-mode', mode);
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
   * 安卓端每首曲子的观看偏好（字号/字距/行距/光标/记谱方式/实音移调）：
   * 按曲目名单独存（ws-an-view:<曲名>），打开哪首恢复哪首的配置。
   * EditorApp 以 key=曲目 id 重挂载，所以在初始化里同步读一次即可，无跨曲竞态。
   * 注意：必须定义在所有引用它的 useState 初始化器（playStyle 等）之前。
   */
  const anViewKey = androidPlayer && androidItem ? `ws-an-view:${androidItem.name}` : null;
  const anView: {
    font?: number | null; gap?: number | null; lineGap?: number | null;
    style?: 'head' | 'band' | 'ball'; notation?: 'staff' | 'jianpu'; pitch?: StaffPitchMode;
  } = (() => {
    if (!anViewKey) return {};
    try { return JSON.parse(localStorage.getItem(anViewKey) ?? 'null') ?? {}; } catch { return {}; }
  })();
  /**
   * 播放指示方式：
   *   head = 跟着当前音跳的色块 + 平滑横移的竖线（旧方式）
   *   band = 从当前行行首开始、随音乐不断变宽的高亮条（更好跟）
   *   ball = 发光小球拖着渐变尾巴、按抛物线轨迹逐音跳跃（深色发光、浅色彩色点+阴影）
   * 存 localStorage：播放页（动态谱演奏 / 曲库播放）的观众设一次就长期有效
   */
  const [playStyle, setPlayStyle] = useState<'head' | 'band' | 'ball'>(() => {
    if (androidPlayer) return anView.style === 'band' || anView.style === 'ball' || anView.style === 'head' ? anView.style : 'head';
    try {
      const v = localStorage.getItem('ws-playstyle');
      return v === 'band' || v === 'ball' ? v : 'head';
    } catch {
      return 'head';
    }
  });
  useEffect(() => {
    try {
      if (!androidPlayer) localStorage.setItem('ws-playstyle', playStyle);
    } catch {
      /* 隐私模式等存不了就算了 */
    }
  }, [playStyle]);
  /** 保留已有的记谱法偏好存储，顶部按钮切换简谱／五线谱。 */
  const [storedStaffViewOn, setStoredStaffViewOn] = useExp('staffView');
  const [androidStaffViewOn, setAndroidStaffViewOn] = useState(() => androidPlayer && anView.notation === 'staff');
  const staffViewOn = androidPlayer ? androidStaffViewOn : storedStaffViewOn;
  const setStaffViewOn = androidPlayer ? setAndroidStaffViewOn : setStoredStaffViewOn;
  /** 记谱页 / 播放页共用的记谱法 */
  const notation: 'jianpu' | 'staff' = staffViewOn ? 'staff' : 'jianpu';
  const [staffPitchMode, setStaffPitchMode] = useState<StaffPitchMode>(() => {
    if (androidPlayer && anView.pitch) return anView.pitch; // 按曲恢复；没记过则沿用全局偏好
    return localStorage.getItem('ws-staff-pitch-mode') === 'transposed' ? 'transposed' : 'concert';
  });
  const [staffSettingsOpen, setStaffSettingsOpen] = useState(false);
  useEffect(() => { localStorage.setItem('ws-staff-pitch-mode', staffPitchMode); }, [staffPitchMode]);
  /** 对轨页「音轨分离工具下载」的说明弹窗 */
  const [tramaOpen, setTramaOpen] = useState(false);
  /**
   * 播放页的观看偏好：字号 / 字距（覆盖谱面自带设置；null = 跟随谱面）。
   * PC 播放页存全局 ws-playview；安卓端按**曲目单独记**（定义见上 anView）。
   */
  const [playFont, setPlayFont] = useState<number | null>(() => androidPlayer ? (typeof anView.font === 'number' ? anView.font : null) : playViewPref.font);
  const [playGap, setPlayGap] = useState<number | null>(() => androidPlayer ? (typeof anView.gap === 'number' ? anView.gap : null) : playViewPref.gap);
  const [playLineGap, setPlayLineGap] = useState<number | null>(() => androidPlayer ? (typeof anView.lineGap === 'number' ? anView.lineGap : null) : playViewPref.lineGap);
  useEffect(() => {
    if (!androidPlayer) localStorage.setItem('ws-playview', JSON.stringify({ font: playFont, gap: playGap, lineGap: playLineGap }));
  }, [playFont, playGap, playLineGap]);
  // 安卓：每首曲子的观看偏好单独落盘，下次打开同一首自动重现
  useEffect(() => {
    if (!anViewKey) return;
    try {
      localStorage.setItem(anViewKey, JSON.stringify({
        font: playFont, gap: playGap, lineGap: playLineGap,
        style: playStyle, notation: staffViewOn ? 'staff' : 'jianpu', pitch: staffPitchMode,
      }));
    } catch { /* 隐私模式等存不了就算了 */ }
  }, [anViewKey, playFont, playGap, playLineGap, playStyle, staffViewOn, staffPitchMode]);
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
    if (androidPreview) { setStoreReady(true); return; }
    void initStore().then(() => {
      storeReadyRef.current = true;
      setStoreReady(true);
      // 已导入的音色包（.wsbank）：**必须等 initStore 探测完存储后端**再恢复登记。
      // 挂载时就恢复曾踩过坑：后端还是 local 兜底，索引读的是空 localStorage，
      // 桌面端重开程序后音色下拉里就少了已导入的音色（0.3.2 修）。
      // 失败静默：包丢了自动回落内置，别挡着程序启动。
      void loadSavedBanks().catch(() => undefined);
      // 安卓 App 没有文件夹模式，曲库固定走本机存储，不算「未配置」
      setSetupOpen(!androidPlayer && !IS_ANDROID_APP && !isLibraryConfigured());
    });
    const recheck = (): void => {
      if (storeReadyRef.current) setSetupOpen(!androidPlayer && !IS_ANDROID_APP && !isLibraryConfigured());
    };
    return onStoreBackendChange(recheck);
  }, []);
  useEffect(() => {
    // 进曲库管理 / 演奏首页时再查一次（配置好之前每次进入都提醒）
    if ((mode === 'discover' || mode === 'library') && storeReadyRef.current) {
      setSetupOpen(!IS_ANDROID_APP && !isLibraryConfigured());
    }
  }, [mode, storeReady]);
  /**
   * 倚音录入：`graceSide` = 前 / 后（互斥，null = 都不勾），
   * `graceSlot` = 正在输入的那一格（null = 输入框收起）。
   * 三格共用一套状态，切音时由下面的 effect 复位。
   */
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
  const EDITOR_UNIT = 33.6 / TICKS_PER_BEAT;
  /** 源码面板默认只读。主编辑路径是点选 + 键盘 + 属性面板。 */

  const [msg, setMsg] = useState('');
  const dslRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** .wspack 导入（对轨页「导入打包」）：与 fileRef 同款的选择框兜底 */
  const packRef = useRef<HTMLInputElement>(null);
  const clockRef = useRef<BeatClock>(new Clock(90));
  const playerRef = useRef<Player>(new Player());
  const [playing, setPlaying] = useState(false);

  // ─────────── 音频对齐（M9/M11）：真实音频 + TempoMap 驱动指示条 ───────────
  const [stems, setStems] = useState<{ name: string; buffer: AudioBuffer; on: boolean }[]>([]);
  /** 整体升降调（半音）：伴奏离线 WSOLA 变调 + 合成声部同步移调，播放页练习用 */
  const [transpose, setTranspose] = useState(0);
  /** 倍速（变速不变调）：伴奏 WSOLA 拉伸 + TempoMap 整体缩放，合成声部走 bpm × speed */
  const [speed, setSpeed] = useState(1);
  /** 变调离线处理进行中（首次换调要算几秒，结果进会话缓存后秒开） */
  const [shifting, setShifting] = useState(false);
  /** 变调/变速弹层文案：当前正在处理什么（给等待遮罩用） */
  const [shiftLabel, setShiftLabel] = useState('');
  /** 无伴奏播放的「调与速度」弹窗（齿轮入口） */
  const [paramOpen, setParamOpen] = useState(false);
  /** 弹窗内的草稿值：点「确认」才应用到播放，× 关闭即放弃 */
  const [draftTranspose, setDraftTranspose] = useState(0);
  const [draftSpeed, setDraftSpeed] = useState(1);
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
   * 节拍器只在**合成音**的播放场景出现（规则见 metronome.ts 的纯函数）。
   * 记谱页一直放合成音 → 一直有；播放页 / 动态谱生成页选「伴奏」时收起来。
   */
  const metronomeAvailable = metronomeAvailableIn(mode, playSource);
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
  /**
   * 通用提示浮层（src/v2/ui/toast.tsx）：绑定成功、保存进度、打包、导出、
   * 节拍分析、出错提示全都走它，样式与淡出时序只有一处实现。
   */
  const { toast, progress: toastProgress, ok: toastOk, fail: toastFail, info: toastInfo, hide: toastHide } = useToast();
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
   * 一直放会盖住后面的操作。波形上方工具栏可改，记忆到 localStorage。
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
  const [appliedTempoEst, setAppliedTempoEst] = useState<TempoEstimate | null>(null);
  const analysisRef = useRef<AbortController | null>(null);
  const autoApplyRef = useRef<(est: TempoEstimate) => void>(() => {});
  const autoScoreRef = useRef<Score | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  useEffect(() => {
    if (autoScoreRef.current?.meta !== snap.score.meta) {
      analysisRef.current?.abort();
      setTempoEst(null);
    }
    autoScoreRef.current = null;
  }, [snap.score]);
  useEffect(() => () => analysisRef.current?.abort(), []);
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
  useEffect(() => {
    androidAlive.current = true;
    if (!androidPlayer) return;
    return () => { androidAlive.current = false; stopPlay(); };
  }, [androidPlayer, stopPlay]);
  useEffect(() => {
    if (!androidPlayer || !playing) return;
    const id = window.setInterval(() => {
      if (!playerRef.current.isPlaying && !shifting) {
        androidResumeTick.current = null;
        clockRef.current.pause(); clockRef.current.seek(0); setPlaying(false);
      }
    }, 100);
    return () => clearInterval(id);
  }, [androidPlayer, playing, shifting]);

  /**
   * 音频逐拍跟踪后自动应用并同步谱面 BPM；谱面原点单独匹配。
   *
   * 拆成独立函数是因为它得能**重跑**——换了一段谱、或上次没对上改了谱之后，
   * 不该逼用户重新导入一遍音频。grid 参数给导入时用（此刻 stems 状态还没更新）。
   */
  const runAutoAlign = useCallback(
    async (prefix = '', grid?: AudioBuffer, fixedBpm = 0): Promise<TempoEstimate | null> => {
      const source = rhythmSource(stems);
      const src = grid ?? source?.buffer;
      if (!src) { setAudioMsg(`${prefix}先载入伴奏音频。`); return null; }
      analysisRef.current?.abort();
      const controller = new AbortController();
      analysisRef.current = controller;
      setAnalyzing(true);
      setTempoEst(null);
      setAudioMsg(`${prefix}正在分析全曲节拍…`);
      // 分析是几秒级的长活儿，且结果直接改速度：成没成要弹出来
      toastProgress('正在分析节拍…', fixedBpm ? `按 ${fixedBpm.toFixed(1)} BPM 重算` : '全曲节拍估计');
      const t0 = performance.now();
      try {
        const est = await analyzeBeats(src, {
          noteOnsets: scoreNoteOnsets(snap.score),
          scoreBeats: totalScoreBeats(snap.score),
          ...(fixedBpm ? { fixedBpm } : {}),
        }, controller.signal);
        if (controller.signal.aborted) return null;
        setTempoEst(est);
        if (est) autoApplyRef.current(est);
        const vocal = stems.find((s) => /vocal|人声|voice/i.test(s.name));
        setVocalSec(vocal ? detectVocalEntry(vocal.buffer) : null);
        setAudioMsg(est ? '' : `${prefix}没有足够的节奏证据，请使用打拍定速。`);
        if (controller.signal.aborted) {
          toastHide();
        } else if (est) {
          toastOk(
            '对齐已应用',
            `BPM ${est.bpm.toFixed(1)} · 相位 ${est.phaseSec.toFixed(2)}s` +
              (est.originBeat === null ? '' : ` · 开头对位 ${est.originBeat.toFixed(2)} 拍`) +
              `（${((performance.now() - t0) / 1000).toFixed(1)}s）`,
          );
        } else {
          toastFail('没估出速度', '节奏证据不足，请用打拍定速');
        }
        return est;
      } catch (error) {
        if (!controller.signal.aborted) {
          setAudioMsg(`节拍分析失败：${error instanceof Error ? error.message : String(error)}`);
          toastFail('节拍分析失败', error instanceof Error ? error.message : String(error));
        } else {
          toastHide();
        }
        return null;
      } finally {
        if (analysisRef.current === controller) setAnalyzing(false);
      }
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
        // 优先鼓轨，其次伴奏/其他、贝斯；不让等长分轨的上传顺序决定分析输入。
        const grid = rhythmSource(decoded)!;
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
      if (!androidPreview) await initStore();
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
      const saved = androidPreview ? androidPack?.align : loadAlign(active);
      if (!saved) return;
      if (saved.audio.length > 0) setRestoring(true);
      setTempoDraft(saved.tempoDraft);
      setAnchors(saved.anchors);
      setPlaySource(androidPlayer && saved.audio.length ? 'audio' : saved.playSource);
      if (saved.override) {
        try {
          setTempoOverride(tempoFromAlign(saved.override as never));
        } catch {
          /* 存档里的曲线坏了就当没有 */
        }
      }
      try {
        const host = new OfflineAudioContext(2, 1, 44100);
        const files = androidPreview ? (androidPack?.stems.map(s => s.file) ?? []) : await Promise.all(saved.audio.map((ref) => getAudio(ref.key)));
        const decoded = (
          await Promise.all(
            files.map(async (f, i) => {
              if (!f) return null;
              try {
                return {
                  name: androidPreview ? androidPack!.stems[i].name : saved.audio[i]!.name,
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
          if (androidPlayer) setPlaySource('synth');
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
    // 浏览器预览（内存曲库）不落盘；安卓 App 与 PC 一样记住放哪几条分轨
    if (androidPreview || restoredRef.current !== active || stems.length === 0) return;
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
    analysisRef.current?.abort();
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
    (name: string, text: string, file: string | null = null, fromLibraryId: string | null = null) => {
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
      setFileHandle(null); // 会话恢复没有句柄：这一轮保存仍走下载
      setLibraryId(fromLibraryId);
      setSavedRev(0);
      stopPlay();
    },
    [stopPlay],
  );

  // 启动：优先接着上次改；没有草稿才载入内置曲
  useEffect(() => {
    if (androidItem) { load(androidItem.name, androidItem.text, null, androidItem.id); return; }
    const s = loadSession();
    if (s) {
      const res = parseDsl(s.text);
      if (res.score) {
        load(s.name, s.text, s.path, s.libraryId ?? null);
        setMsg('已恢复上次编辑的内容');
        // 进来就看到一份谱面会让人发懵，说明一下它是上次没存完的草稿
        toastInfo('已恢复上次编辑的内容', s.name);
        return;
      }
    }
    load(BUILTIN[0].name, BUILTIN[0].text);
  }, [load, androidItem]);

  // 曲库存储的启动探测放在**恢复流程内部**（见 restore effect 里的 await initStore()），
  // 不再在这里「水合完再补一拍恢复」——那一拍会落在用户操作之后：
  // 把刚载入的伴奏 / 刚对好的标定与锚点又冲掉一次（exe 读盘慢，必踩），
  // 还会把分轨重复解码一遍（表现为载入音频后长时间卡住才见波形）。

  const adopt = useCallback(
    (res: OpenResult, fromLibraryId: string | null = null) => {
      if (!res.score) {
        setMsg(res.errors.length ? `打开失败：${res.errors[0]}` : '解析失败');
        toastFail('打开失败', res.errors[0] ?? '这份内容解析不了');
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
      setFileHandle(res.handle ?? null);
      setLibraryId(fromLibraryId);
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
    setFileHandle(null);
    setLibraryId(null);
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
    if (res) { adopt(res); return; }
    // 浏览器预览：优先 File System Access API（拿到句柄，之后能原地写回）；
    // 不支持（Safari / Firefox）或出别的错时才退回 <input> 选择框。
    // 用户在系统对话框里取消会抛 AbortError——那就什么都不做，别再弹一次选择框。
    try {
      const via = await openScoreViaFsAccess();
      if (via) { adopt(via); return; }
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
    }
    // 走到这里说明拿不到文件句柄（Safari / Firefox，或地址不是 https / localhost）：
    // 先说清楚，免得用户以为保存会改原文件
    if (!canWriteInPlace()) setMsg('此浏览器不支持直接写回原文件，保存会下载一个新副本（用 Chrome / Edge 桌面版或装桌面版可原地保存）');
    fileRef.current?.click();
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
    const t0 = performance.now();
    const cur = snap.score;
    const name = cur.meta.title || active || '未命名';
    /**
     * 从**曲库**打开的谱（对轨页点进来的）：保存 = 直接写回曲库那一条，
     * **不再落一份 .jps**——曲库本身就是它的存放处，再存一份文件是多余动作
     * （还要弹「另存为」）。要文件用「导出 / 打包」。
     */
    if (libraryId) {
      setMsg('保存中…');
      toastProgress('正在保存…', '正在写入曲库');
      const okLib = updateLibraryItem(libraryId, serializeDsl(cur));
      const tLib = performance.now() - t0;
      console.debug(`[save] 只写曲库 ${tLib.toFixed(0)}ms`, { libraryId, okLib });
      if (!okLib) {
        // 曲库里这一条已被删除（编辑期间在曲库把歌删了就会出现）：别把用户锁死——
        // 解除曲库绑定，退回「存为文件」，并给一个一键重新收录的后悔药
        const text = serializeDsl(cur);
        setLibraryId(null);
        setMsg('保存中…');
        toastProgress('正在保存…', '曲库里已没有这一条，改为写入文件');
        const r = await saveScore(cur, `${name}.jps`, fileHandle);
        if (!r.ok) {
          setMsg('保存取消');
          toastInfo('保存已取消');
          return;
        }
        if (r.handle) setFileHandle(r.handle);
        if (r.path && !r.inPlace) setPath(r.path);
        setSavedRev(snap.rev);
        setMsg('已保存到文件（曲库里已没有这一条）');
        toastOk('已保存到文件', '曲库里已没有这一条', {
          label: '重新收录进曲库',
          onClick: () => {
            const item = importLibrary(name, text);
            if (item) {
              setLibraryId(item.id);
              setMsg(`已重新收录进曲库「${name}」，之后再保存直接写回曲库`);
              toastOk('已收录', `曲库「${name}」`);
            } else {
              toastFail('收录失败', '曲库写不进去，请检查存储位置');
            }
          },
        });
        return;
      }
      setSavedRev(snap.rev);
      setMsg(`已更新曲库「${name}」（未生成文件）`);
      toastOk('保存成功', `曲库「${name}」（${(tLib / 1000).toFixed(1)}s）`);
      return;
    }
    setMsg('保存中…');
    toastProgress('正在保存…', '正在写入文件');
    // 有句柄 = 浏览器里也能直接改原文件；没有就下载一份（网页端拿不到路径）
    const r = await saveScore(cur, `${cur.meta.title || '未命名'}.jps`, fileHandle);
    if (!r.ok) {
      setMsg('保存取消');
      toastInfo('保存已取消');
      return;
    }
    const wrote = performance.now() - t0;
    console.debug(`[save] 写文件 ${wrote.toFixed(0)}ms`, { inPlace: r.inPlace, path: r.path, handle: !!r.handle });
    // 浏览器端「另存为」拿到的句柄要记住：下次按保存就是静默覆盖这一个文件
    if (r.handle) setFileHandle(r.handle);
    if (r.path && !r.inPlace) setPath(r.path);
    setSavedRev(snap.rev);
    // 写文件的分段：序列化 / 等另存为对话框 / 真正写入（写入慢或对话框慢一眼看得出）
    const ms = r.ms;
    const seg = ms
      ? `序列化 ${(ms.serialize / 1000).toFixed(1)}s` +
        (ms.pick !== undefined ? ` / 等对话框 ${(ms.pick / 1000).toFixed(1)}s` : '') +
        ` / 写入 ${(ms.write / 1000).toFixed(1)}s`
      : `写文件 ${(wrote / 1000).toFixed(1)}s`;
    // 分段也写进状态栏：浮层一秒多就淡出，慢的时候来不及看，状态栏会一直留着
    setMsg(
      (r.inPlace && r.path
        ? `已写回原文件 ${nameOf(r.path)}（下次保存仍改这一个文件）`
        : r.path
          ? `已保存到 ${nameOf(r.path)}`
          : '已导出到浏览器下载目录（此浏览器不支持原地写回：需 Chrome / Edge 桌面版，且地址是 https 或 localhost）') +
        `（${seg}；未改动曲库）`,
    );
    // 走到这里说明这份谱不是从曲库来的：只写文件，曲库不动
    toastOk('保存成功', `${nameOf(r.path ?? '') || name}（${seg}）`);
  }, [snap, active, fileHandle, libraryId, toastProgress, toastOk, toastFail, toastInfo]);

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
    const t0 = performance.now();
    // 打包要压缩整首伴奏，慢操作：先把「正在打包」摆出来，别让人以为点空了
    toastProgress('正在打包…', '读取伴奏分轨');
    const audio = stemKeysRef.current.map((key, i) => ({ key, name: stems[i]?.name ?? key }));
    const files: { name: string; file: File }[] = [];
    for (const ref of audio) {
      const f = await getAudio(ref.key);
      if (f) files.push({ name: ref.name, file: f });
    }
    toastProgress('正在打包…', `压缩谱面 + ${files.length} 条伴奏`);
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
    const secs = (performance.now() - t0) / 1000;
    const detail = `谱面 + ${files.length} 条伴奏 + 标定` + (files.length ? '' : '（当前没有伴奏，只有谱面与标定）');
    setMsg(!r.ok ? '打包取消' : `已打包 ${packFileName(name)}：${detail}`);
    if (!r.ok) {
      toastInfo('打包已取消');
      return;
    }
    toastOk('打包成功', `${packFileName(name)} · ${detail}（${secs.toFixed(1)}s / ${(bytes.byteLength / 1048576).toFixed(1)}MB）`);
  }, [snap.score, active, stems, tempoDraft, anchors, tempoOverride, playSource, toastProgress, toastOk, toastInfo]);

  /**
   * 对轨界面的「导入打包」：打开机器上的 .wspack（谱面 + 伴奏 + 对轨标定），
   * 原样装回对轨页继续编辑——「打包」的逆操作。与曲库的「导入打包」不同：
   * 不进曲库，只作为当前编辑对象打开（保存仍按原有路径走）。
   *
   * 装载顺序有讲究：伴奏与标定**先**落存储（putAudio / saveAlign），**再**
   * adopt 换谱——adopt 会 bump 恢复令牌，随后的恢复流程按 active 读到的
   * 正是刚落存的这份。反过来先 adopt 的话，恢复会读到空档，
   * 表现为导入后没有伴奏、没有标定。
   */
  const importPackFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(PACK_EXT)) {
        toastFail('导入失败', '请选择 .wspack 乐谱包（谱面 + 伴奏 + 对轨标定）');
        return;
      }
      toastProgress('正在导入打包…', '解压谱面与伴奏');
      let pack: PackBundle;
      try {
        pack = await readPack(new Uint8Array(await file.arrayBuffer()));
      } catch (e) {
        toastFail('导入失败', e instanceof Error ? e.message : String(e));
        return;
      }
      const res = fromText(pack.text, pack.name);
      if (!res.score) {
        toastFail('导入失败', '包里的谱面无法解析');
        return;
      }
      toastProgress('正在导入打包…', pack.stems.length ? `写入 ${pack.stems.length} 条伴奏与标定` : '写入标定');
      try {
        // 伴奏分轨落存储：键 = 文件名:字节数（打包 / 恢复 / 保存三方同口径）。
        // 老包里若还有 wav，ensureMp3 原地转掉
        const audio: AlignPersist['audio'] = [];
        for (const stem of pack.stems) {
          const f = await ensureMp3(stem.file);
          const key = audioKey(f);
          await putAudio(key, f);
          audio.push({ key, name: f.name });
        }
        const align: AlignPersist = pack.align
          ? { ...pack.align, audio }
          : {
              version: 1,
              audio,
              tempoDraft: { bpm: res.score.meta.bpm || 120, phaseSec: 0, originBeat: 0 },
              anchors: [],
              override: null,
              playSource: audio.length ? 'audio' : 'synth',
            };
        saveAlign(pack.name, align);
      } catch (e) {
        toastFail('导入失败', e instanceof Error ? e.message : String(e));
        return;
      }
      adopt(res); // 换谱 + bump 恢复令牌：伴奏与标定由恢复流程装回对轨页
      const detail = `${pack.stems.length} 条伴奏` + (pack.align ? ' · 含对轨标定' : ' · 无标定');
      setMsg(`已导入 ${pack.name}（${detail}），可继续对轨编辑`);
      toastOk('导入成功', `${pack.name}（${detail}）`);
    },
    [adopt, toastProgress, toastOk, toastFail],
  );

  const onPackPicked = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (f) void importPackFile(f);
    },
    [importPackFile],
  );

  /**
   * 从曲库点开一首：与 adopt 同口径（换谱即换歌，旧伴奏 / 标定作废）。
   * 点行 = 进播放界面；行里的「对轨」按钮才进编辑。
   */
  const loadLibraryItem = useCallback(
    (item: LibraryItem, target: 'play' | 'align'): boolean => {
      const res = fromText(item.text, item.name);
      if (!res.score) {
        setMsg(`${item.name} 解析失败——曲库里这份内容有问题，建议删除后重新导入`);
        // 状态栏那行小字太容易漏：打开失败必须拦在眼前
        toastFail(`${item.name} 打不开`, '曲库里这份内容有问题，建议删除后重新导入');
        return false;
      }
      adopt(res, item.id); // 记下来自曲库哪一条：保存时按 id 回写这一条
      setMode(target);
      return true;
    },
    [adopt],
  );
  const playLibraryItem = useCallback(
    (item: LibraryItem) => {
      // 记下是从哪一屏点进播放的：播放页左上角就按它显示「返回曲库」还是「返回动态谱 / 首页」
      setPlayFrom(mode === 'library' ? 'library' : 'discover');
      loadLibraryItem(item, 'play');
    },
    [loadLibraryItem, mode],
  );
  const editLibraryItem = useCallback(
    (item: LibraryItem) => {
      if (entry === 'app') { loadLibraryItem(item, 'align'); return; }
      const res = fromText(item.text, item.name);
      if (!res.score) { setMsg(`${item.name} 解析失败，请先修正谱面`); return; }
      // 带上 libraryId：align.html 那边靠会话恢复内容，认得出来自曲库才不会去另存文件
      saveSession({ text: item.text, name: res.name, path: null, libraryId: item.id });
      // 一次性标记：告诉 align.html 左上角「返回」该回曲库（不是首页）
      try {
        sessionStorage.setItem('ws-back-from', 'library');
      } catch {
        /* 写不进去也不要拦着跳转 */
      }
      window.location.href = './align.html';
    },
    [entry, loadLibraryItem],
  );

  const documentScore = snap.score;
  const activePartId = scoreParts(documentScore).find((p) => p.id === snap.partId)?.id ?? scoreParts(documentScore)[0].id;
  const score = useMemo(() => partScore(documentScore, activePartId), [documentScore, activePartId]);
  const lyricVerse = lyricSelection?.partId === activePartId && lyricSelection.verse < lyricTrackNames(score).length ? lyricSelection.verse : null;
  const canEditConductor = !documentScore.part || activePartId === documentScore.part.id;
  /** 播放页生效的字号 / 字距：观看偏好优先，没设过就跟随谱面自带设置（缺省 24 / -10） */
  const effFont = playFont ?? (score.meta.fontSize ?? DEFAULT_FONT_SIZE);
  const effGap = playGap ?? (score.meta.letterSpacing ?? DEFAULT_LETTER_SPACING);
  const effLineGap = playLineGap ?? (score.meta.lineGap ?? 0);
  /** 有未保存的改动 */
  const dirty = snap.rev !== savedRev;
  const serialized = useMemo(() => (documentScore.format === 3 || scoreParts(documentScore).some((p) => p.events.length) || documentScore.part ? serializeDsl(documentScore) : ''), [documentScore]);
  const violations = useMemo(() => validateGroups(documentScore), [documentScore]);

  const audioGrid = useMemo<TempoMap>(() => tempoDraft.beatTimes
    ? { kind: 'curve', beatTimes: tempoDraft.beatTimes, scoreOriginBeat: 0 }
    : { kind: 'constant', bpm: tempoDraft.bpm, phaseSec: tempoDraft.phaseSec, scoreOriginBeat: 0 }, [tempoDraft]);
  const anchorChecks = useMemo(() => checkAnchorSpans(anchors, audioGrid), [anchors, audioGrid]);
  const applyAutoEstimate = (est: TempoEstimate) => {
    stopPlay();
    const nextGrid: TempoMap = est.isConstant
      ? constantTempo(est.bpm, est.phaseSec, 0)
      : { kind: 'curve', beatTimes: est.beatTimes, scoreOriginBeat: 0 };
    const convert = (b: number) => secToBeat(nextGrid, beatToSec(audioGrid, b));
    const hasManual = anchors.length > 0 || tempoOverride !== null;
    const originSec = audioTempo ? tickToSec(audioTempo, 0) : beatToSec(audioGrid, tempoDraft.originBeat);
    setAnchors((list) => list.map((a) => ({ ...a, audioBeat: convert(a.audioBeat) })));
    // 外部/手工曲线仍负责谱面映射；自动候选只替换音频节拍网格。
    const origin = hasManual ? secToBeat(nextGrid, originSec) : est.originBeat ?? 0;
    setTempoDraft({ bpm: est.bpm, phaseSec: est.phaseSec, originBeat: origin,
      ...(est.isConstant ? {} : { beatTimes: est.beatTimes }) });
    setAppliedTempoEst(est);
    setWaveBeat(null);
    if (documentScore.meta.bpm !== est.bpm) {
      const next = setMeta(documentScore, { bpm: est.bpm });
      autoScoreRef.current = next;
      setScore(next);
    }
  };
  autoApplyRef.current = applyAutoEstimate;

  const audioTempo = useMemo<TempoMap | null>(() => {
    // ≥2 个锚点 → 分段线性变速曲线（前奏长度不一致就靠它拉伸对齐）
    if (anchors.length >= 2) {
      try {
        let ticks = 0;
        for (const e of score.events) if (isTimed(e)) ticks += e.ticks;
        return curveFromAnchors(anchors, {
          bpm: tempoDraft.bpm,
          phaseSec: tempoDraft.phaseSec,
          beatTimes: tempoDraft.beatTimes,
          totalBeats: ticks / TICKS_PER_BEAT,
        });
      } catch {
        // 锚点钉反了等：退回下面的常量路线，错误信息已在绑定时报过
      }
    }
    if (tempoOverride) return tempoOverride;
    try {
      return tempoDraft.beatTimes ? { kind: 'curve', beatTimes: tempoDraft.beatTimes, scoreOriginBeat: tempoDraft.originBeat } : constantTempo(tempoDraft.bpm, tempoDraft.phaseSec, tempoDraft.originBeat);
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
    const dt = beatToSec(audioGrid, b.audioBeat) - beatToSec(audioGrid, a.audioBeat);
    const db = b.scoreBeat - a.scoreBeat;
    if (dt <= 0 || db <= 0) return null;
    return Math.round(((db * 60) / dt) * 10) / 10;
  }, [anchors, audioGrid]);

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
        ...(d.beatTimes ? { beatTimes: Array.from({ length: Math.floor((d.beatTimes.length - 1) * k) + 1 }, (_, i) => beatToSec(audioGrid, i / k)) } : {}),
        bpm: Math.round(d.bpm * k * 100) / 100,
        originBeat: Math.round((k * d.originBeat + (k - 1) * pivot) * 100) / 100,
      }));
      // 锚点存的是「当前网格的拍号」，单位随 BPM 变，必须同步乘 k
      setAnchors((list) => list.map((a) => ({ ...a, audioBeat: a.audioBeat * k })));
      setTempoOverride(null); // 有曲线就按新锚点重建（曲线里的时刻是从旧锚点算出来的）
      setAudioMsg(note);
    },
    [anchors, pivotBeat, audioGrid],
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
      Math.round(secToBeat(audioGrid, wavePos) * 100) / 100;
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
   * 播放音色覆盖（播放工具条「音色」按钮，仅合成音场景）：不改谱面文件，
   * 只在喂给 expandScore / buildTimeline 前把 meta.patch / 声部 patch 换掉；
   * 按曲名记在 localStorage，下次播同一首还是这套（编辑模式不受影响）。
   */
  const [timbreMap, setTimbreMap] = useState(readTimbreMap);
  const playTimbre = timbreMap[active];
  const setPlayTimbre = useCallback(
    (t: PlayTimbre | null) => {
      setTimbreMap((m) => {
        const next = { ...m };
        if (t) next[active] = t;
        else delete next[active];
        writeTimbre(active, t);
        return next;
      });
    },
    [active],
  );
  const timbreScore = useMemo(
    // **只在播放模式生效**：覆盖是按曲名持久化的播放偏好，曾经泄漏进编辑界面的
    // 播放链（编辑与播放共用 timeline）——症状是编辑里选钢琴 / 手风琴，播出来
    // 全是上一次在播放页选的排箫（0.3.6 修）。编辑永远按谱面发声。
    () => applyTimbre(documentScore, mode === 'play' ? playTimbre : undefined),
    [documentScore, playTimbre, mode],
  );
  /**
   * 反复展开：**播放只吃线性谱**（这是整套反复功能里最省事的一条约定）。
   * 编辑永远作用在带反复记号的原谱上；展开产物是派生的、只读的。
   * 结构有错（配对不上 / 房子越界）或谱面本来没有反复记号时，退回原谱。
   */
  const expansion = useMemo(() => expandScore(timbreScore), [timbreScore]);
  const playScore = expansion.score ?? timbreScore;
  const timeline = useMemo(() => buildTimeline(playScore), [playScore]);
  /**
   * 谱中变速曲线（小节线「速96」）：合成音播放 / 导出 / 节拍器的 tick ↔ 秒 都走它。
   * **伴奏不受影响**——伴奏的换算走 audioTempo（对轨标定），两条链完全独立。
   * 以**展开谱**为准：反复段里标的速同样生效。没有变速段 = null，一切照旧。
   */
  const synthTempo = useMemo(
    () => tempoCurveFromScore(playScore.events, score.meta.bpm, timelineTicks(timeline) / TICKS_PER_BEAT),
    [playScore, score.meta.bpm, timeline],
  );
  /**
   * 节拍器的强弱按**谱面拍号段**走：曲头拍号定基调，小节线上标了新拍号
   * （DSL「拍3/4」）就从那根线起换——2/4、3/4、4/4 各按各的小节响重音。
   * 从展开谱取：反复段里的换拍同样生效。
   */
  const metronomeMeter = useMemo(
    () => meterSegmentsOf(playScore.events, playScore.meta.beat),
    [playScore],
  );
  const notationTimeline = useMemo(() => buildTimeline(playScore, { mergeTies: false }), [playScore]);

  /**
   * 播放界面的「展开反复」开关：把带反复 / 跳转记号的原谱换成**拉平后的线性谱**。
   *
   * null = 跟着谱面走：带反复的谱**默认展开**，因为只有展开谱的时间轴才和播放
   * 对得上（指示条落点才准）；用户手动选过之后就一直按用户选的来。
   */
  const [expandViewPick, setExpandViewPick] = useState<boolean | null>(null);
  const [playPick, setPlayPick] = useState<{ id: string; tick: number; score: Score; viewChoice: boolean | null } | null>(null);
  const activePlayPick = mode === 'play' && playPick?.score === playScore && playPick.viewChoice === expandViewPick ? playPick : null;
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
    if (activePlayPick) return activePlayPick.tick;
    const total = timelineTicks(timeline);
    const at = snap.mode === 'over' ? Math.max(0, snap.cursor - 1) : snap.cursor;
    let src = Math.max(0, Math.min(at, score.events.length));
    while (src < score.events.length && !isTimed(score.events[src])) src += 1;
    const srcId = score.events[src]?.id;
    const from = tickAtEvent(partScore(playScore, activePartId), srcId ? (expansion.firstIndex.get(srcId) ?? src) : 0);
    return from >= total ? 0 : from;
  }, [timeline, playScore, score, expansion, snap.mode, snap.cursor, activePartId, activePlayPick]);

  /**
   * 节拍器跟随播放起动。
   *
   * 只跟**变速**（倍速播放时节拍也要变快），不跟移调——移调不改变节拍。
   * 速度**只认谱面 BPM**：节拍器只在合成音场景出现（metronomeAvailable），
   * 而合成音播放走的就是谱面速度——曾在这里误用伴奏的 tempo 标定，
   * 那个标定的「一拍」来自音频节拍检测，有半速歧义（124.42 的曲子被按 62.21 数），
   * 结果一小节只响两下、还跟音乐漂移。
   * 强弱跟谱面的拍号段走：2/4、3/4 各按各的小节，小节线上换拍（DSL「拍3/4」）
   * 也跟着换——拍号段从**展开谱**取，反复段里的换拍同样生效。
   */
  const startMetronomeFollow = useCallback(
    (fromTick: number, delaySec = 0): void => {
      const m = metronomeRef.current;
      if (!m || !metronomeFollow) return;
      const pattern = patternFor(metronomePatternId);
      const fromBeat = fromTick / TICKS_PER_BEAT;
      const bpmEff = score.meta.bpm * speed;
      // 谱中变速：拍点秒走同一条曲线（倍速已缩放），起播拍之前的秒差做锚。
      // 伴奏模式绝不使用（它的秒走对轨标定）——节拍器本来只在合成音场景出现，双保险。
      const map = playSource !== 'audio' && synthTempo ? (speed === 1 ? synthTempo : scaleTempoMap(synthTempo, speed)) : null;
      const anchorSec = map ? tickToSec(map, fromTick) : 0;
      m.start(
        {
          beatToSec: (b) => (map ? tickToSec(map, b * TICKS_PER_BEAT) - anchorSec : (b - fromBeat) * (60 / bpmEff)),
          meterAt: metronomeMeter,
          pattern,
          volume: metronomeVolume,
        },
        fromBeat,
        delaySec,
      );
    },
    [metronomeFollow, metronomeMeter, metronomePatternId, metronomeVolume, score.meta.bpm, speed, synthTempo, playSource],
  );

  /** 与音乐起播对齐用的 lead（秒）：startPlayNow 存进来，effect 起播时用掉 */
  const metronomeLeadRef = useRef(0);

  const startPlayNow = useCallback(async (fromOverride?: number) => {
    if (androidPlayer && !androidAlive.current) return;
    if (documentScore.parts?.length && expansion.errors.length) { setMsg(`重奏暂不能播放：${expansion.errors[0]}`); return; }
    if (timeline.length === 0) return;
    // 趁还有用户手势先把节拍器的音频上下文建好：下面可能有几秒的
    // 变调/变速处理，等处理完再新建上下文会被浏览器的自动播放策略挂起 → 不出声
    if (metronomeFollow) metronomeRef.current?.unlock();
    previewRef.current.stop(); // 试听与谱面播放互斥
    setPreviewing(false);
    // 真采样音色：起播前把时间线里用到的音色拉齐（本地文件，通常 <100ms）。
    // 没拉齐的音色渲染时静默回落钢琴合成——不阻塞、不报错、不破坏手势窗口
    await preloadInstrumentSamples(timeline.map((e) => e.patch));
    const bpm = score.meta.bpm;
    const from = fromOverride ?? playFromTick;
    // 音频模式：stem + TempoMap 齐备且用户选了「伴奏音频」。
    // **记谱页除外**：那里只放合成 MIDI——编辑时听的是「谱面写对了没有」，
    // 伴奏是对轨后的成品，混进来只会干扰；想跟伴奏去播放页，那边有开关。
    // 对轨页仍放伴奏（对齐本来就要听着伴奏调）。
    // 谱尾行为（指导书 §9.3）：音频比谱长时，指示条到尾就停，音频继续放完。
    if (playSource === 'audio' && audioReady && mode !== 'score') {
      // 升降调 + 倍速：伴奏走离线 WSOLA（组合结果进会话缓存，命中即秒开）；
      // 处理失败降级按原调原速放，不拦播放
      let useStems = stems;
      if (transpose !== 0 || speed !== 1) {
        setShifting(true);
        const tShift = performance.now();
        const what = [
          transpose !== 0 ? `变调 ${transpose > 0 ? '+' : ''}${transpose} 半音` : '',
          speed !== 1 ? `变速 ${speed.toFixed(2)}×` : '',
        ].filter(Boolean).join('、');
        setAudioMsg(`正在${what}，首次处理需要几秒…`);
        setShiftLabel(`正在${what}`);
        try {
          const buffers = await pitchShiftStems(stems, transpose, speed);
          useStems = buffers.map((buffer, i) => ({ ...stems[i]!, buffer }));
          setAudioMsg('');
          // 首次处理要几秒，处理完得说一声：不说的话用户以为还是原调原速
          toastOk('已应用伴奏处理', `${what}（${((performance.now() - tShift) / 1000).toFixed(1)}s）`);
        } catch (err) {
          setAudioMsg(`变调/变速处理失败，按原样播放：${err instanceof Error ? err.message : String(err)}`);
          toastFail('变调 / 变速失败', '按原调原速播放');
        } finally {
          setShifting(false);
          setShiftLabel('');
        }
      }
      if (androidPlayer && !androidAlive.current) return;
      // 倍速下 tick↔秒 换算整体缩放，指示条与合成声部才跟得上变快的伴奏
      const playTempo = speed === 1 ? audioTempo! : scaleTempoMap(audioTempo!, speed);
      // 前奏：谱面记的是从进唱开始，伴奏前面还整段前奏。
      // 从头播时把起播点推到音频 0 秒（secToTick 反查，通常为负 tick = 谱面起点之前），
      // 前奏就会照常放完再进谱面；关掉则老样子——从谱面起点直接开始
      // 仅未点选音符、从谱面零拍起播时带前奏；选中首拍内的音也必须尊重其起点。
      const introTick =
        playIntro && !activePlayPick && snap.mode !== 'over' && from === 0
          ? Math.min(0, secToTick(playTempo, 0))
          : from;
      const audioLead = playerRef.current.startAudio({
        timeline,
        tempo: playTempo,
        fromTick: introTick,
        stems: useStems.map((s) => ({ buffer: s.buffer, gain: s.on ? 1 : 0 })),
        synth: false,
        semitones: transpose,
        onEnded: () => { if (androidPlayer) { androidResumeTick.current = null; clockRef.current.pause(); clockRef.current.seek(0); } setPlaying(false); },
      });
      setPlaying(true);
      // 起播对齐走 effect（那里读 lead）；这里只把 lead 带过去
      metronomeLeadRef.current = audioLead;
      return;
    }
    // 先起音频、拿到它真正发声的时刻，再让时钟对齐到那个时刻起跑。
    // 顺序不能反：AudioContext 初始化有耗时，时钟先跑就会跑到声音前面。
    // 谱中变速（小节线「速96」）→ 合成音按曲线算秒（倍速整体缩放，与伴奏同款）；
    // 指示条读 player.currentTick（tempo 驱动），时钟仅在停止后兜底显示。
    const playSynthTempo = synthTempo ? (speed === 1 ? synthTempo : scaleTempoMap(synthTempo, speed)) : null;
    const lead = playSynthTempo
      ? playerRef.current.start(timeline, playSynthTempo, from, transpose)
      : playerRef.current.start(timeline, bpm * speed, from, transpose);
    clockRef.current.setBpm(bpm * speed);
    clockRef.current.seek(from / TICKS_PER_BEAT);
    clockRef.current.playAfter(lead);
    setPlaying(true);
    // 起播对齐走 effect（那里读 lead）；这里只把 lead 带过去
    metronomeLeadRef.current = lead;
  }, [timeline, score, playFromTick, playSource, audioReady, audioTempo, stems, mode, documentScore, expansion.errors, playIntro, activePlayPick, snap.mode, transpose, speed, synthTempo]);

  // 播放停止 → 节拍器跟着停
  useEffect(() => {
    if (!playing) metronomeRef.current?.stop();
  }, [playing]);

  /**
   * 切到伴奏场景（节拍器不出现）→ 把它停掉。
   * 按钮都没了还在响 = 用户没法关它，只能重开页面；必须跟着场景一起消失。
   */
  useEffect(() => {
    if (metronomeAvailable) return;
    metronomeRef.current?.stop();
    if (metronomeFollow) setMetronomeFollow(false);
  }, [metronomeAvailable]); // eslint-disable-line react-hooks/exhaustive-deps

  // 节拍器引擎随组件创建 / 销毁
  useEffect(() => {
    metronomeRef.current = new Metronome();
    return () => {
      metronomeRef.current?.dispose();
      metronomeRef.current = null;
      disposePreview();
    };
  }, []);

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
      ...(d.beatTimes ? { beatTimes: d.beatTimes.map((t) => t + deltaSec) } : {}),
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
    const toNewBeat = (oldBeat: number): number =>
      Math.round(((beatToSec(audioGrid, oldBeat) - newPhase) / (60 / tapBpm)) * 100) / 100;
    setTempoDraft((d) => ({
      ...d,
      beatTimes: undefined,
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
  const startPlay = useCallback((fromOverride?: number) => {
    if (!shouldWaitForAudio(playSource, restoring)) {
      void startPlayRef.current(fromOverride);
      return;
    }
    setAudioMsg('伴奏正在从本地恢复，稍等一下就按伴奏放…');
    void waitRestore().then(() => startPlayRef.current(fromOverride));
  }, [playSource, restoring, waitRestore]);

  /**
   * 播放中改调：记下当前 tick，停掉，再从原位置带新调起播（听感上是「无缝换调」，
   * 实际是重启——WSOLA 变调只能整段离线做，热改不可能）。缓存命中时只有一瞬。
   */
  const changeTranspose = useCallback(
    (v: number) => {
      const nv = Math.max(-MAX_SEMITONES, Math.min(MAX_SEMITONES, v));
      if (nv === transpose) return;
      setTranspose(nv);
      if (playerRef.current.isPlaying) {
        const at = getPlayTick() ?? 0;
        stopPlay();
        requestAnimationFrame(() => { void startPlayRef.current(at); });
      }
    },
    // getPlayTick 声明在后面（TDZ），不能进依赖数组；它依赖为空、身份恒定，引用不会过期
    [transpose, stopPlay],
  );

  /** 播放中改倍速：同换调——记 tick、停、从原位置带新速重启（伴奏要重新 WSOLA，缓存命中即秒回） */
  const changeSpeed = useCallback(
    (v: number) => {
      const nv = Math.round(Math.max(MIN_SPEED, Math.min(MAX_SPEED, v)) * 100) / 100;
      if (nv === speed) return;
      setSpeed(nv);
      if (playerRef.current.isPlaying) {
        const at = getPlayTick() ?? 0;
        stopPlay();
        requestAnimationFrame(() => { void startPlayRef.current(at); });
      }
    },
    [speed, stopPlay],
  );

  // 调 / 速是播放页的练习参数，离开播放页就还原——别让它悄悄带进编辑/对轨
  useEffect(() => {
    if (mode !== 'play') {
      setTranspose(0);
      setSpeed(1);
    }
  }, [mode]);

  /**
   * 播放 tick 的唯一出口：音频模式反查 secToTick（变速下唯一正确的做法），
   * 合成音同样使用 Player 的 AudioContext 时钟；未播放时才回退 BeatClock。
   */
  const getPlayTick = useCallback((): number | null => {
    const t = playerRef.current.currentTick;
    if (t !== null) return t;
    return clockRef.current.currentBeat * TICKS_PER_BEAT;
  }, []);

  /**
   * 跟随模式的开关与改动 → 立刻按**当前播放位置**重新起。
   * 重新起而不是中途换拍：节拍器的拍格必须始终锁在音乐的小节线上，
   * 半路换型最容易听出「错位一拍」。
   * 播放本身由 startPlayNow 起（那里知道真正的起播 tick）。
   *
   * 首播时 startPlayNow 会把 lead 存进 metronomeLeadRef：第一拍要等
   * lead 秒才响（音频还在起跑），不读它的话 click 会抢在音符前面，
   * 听起来像被拍子追着跑（用户实测的「紧迫感」就是这个）。用掉即清零，
   * 之后中途改配置的重起 delay = 0——此刻音乐正响着 fromBeat 这一拍。
   */
  useEffect(() => {
    if (!playing) return;
    if (!metronomeFollow) {
      metronomeRef.current?.stop();
      return;
    }
    const lead = metronomeLeadRef.current;
    metronomeLeadRef.current = 0;
    startMetronomeFollow(getPlayTick() ?? 0, lead);
  }, [playing, metronomeFollow, metronomePatternId, metronomeVolume]); // eslint-disable-line react-hooks/exhaustive-deps

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
   * 换选区就没收划分候选：候选是按「当时的选区 + 档位」算出来的
   *（ids 与总时值都绑在上一个选区上）。改选哪怕成员数一样（再选 3 个
   * 别的音），旧候选指向的 ids 已经不对了，继续显示会误操作（用户实测）。
   * 用 id 串当键：点档位本身不改选区，不会被自己清掉。
   */
  const selectionKey = selectedTimedIds.join(',');
  useEffect(() => {
    setPending(null);
  }, [selectionKey]);



  /** 输入板的音值组合档位：全部档位 + 按当前选中音数算好的可用性 */
  const groupTargets = useMemo(() => {
    const beat = meterAt(score, snap.cursor);
    const n = selectedTimedIds.length;
    return groupTierOptions(beat).map((t) => ({
      ...t,
      ok: n >= 2 && groupCandidates(n, t.ticks, beat).length > 0,
    }));
  }, [score, snap.cursor, selectedTimedIds.length]);

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

  /**
   * 波形上定好的那个点 = 音频第几拍。
   * 吸附开着时就是整拍（点在节奏线上）；关掉时按精确时刻换算，允许小数。
   */
  const audioBeatOfWave = useMemo(() => {
    if (waveBeat !== null) return waveBeat;
    if (wavePos === null) return null;
    return secToBeat(audioGrid, wavePos);
  }, [waveBeat, wavePos, tempoDraft]);

  /**
   * 落一个锚点：谱面某处（小节线 / 音符的拍位）↔ 音频那个节奏点。
   * 恒定 BPM 下一个锚点定死原点；≥2 个锚点自动合成变速曲线（段间线性拉伸）。
   */
  const commitAnchor = useCallback(
    (scoreBeat: number, audioBeat: number, what: string, extra = '') => {
      setPivotBeat(scoreBeat);
      const nextAnchors = [...anchors.filter((x) => x.scoreBeat !== scoreBeat), { scoreBeat, audioBeat }];
      setAnchors(nextAnchors);
      setTempoOverride(null);
      if (nextAnchors.length < 2) {
        setTempoDraft((d) => ({ ...d, originBeat: Math.round((audioBeat - scoreBeat) * 100) / 100 }));
      }
      const detail =
        `${what} ↔ 音频第 ${Math.round(audioBeat * 10) / 10} 拍` +
        (nextAnchors.length >= 2
          ? ' · 两点之间按变速曲线拉伸（前奏比谱面长也能跟住）'
          : ' · 再绑一个更靠后的位置，前奏即可自动拉伸');
      const checks = checkAnchorSpans(nextAnchors, audioGrid);
      const check = checks.find((c) => c.to === scoreBeat) ?? checks.find((c) => c.from === scoreBeat);
      const inspection = check ? `。自检查：${check.text}` : '';
      setAudioMsg(`已绑定：${detail}${inspection}。${extra}`);
      // 绑定是低频而关键的一步，成没成必须**弹出来**说——
      // 光靠侧栏底部那行小字，眼睛还在谱面上根本注意不到
      if (check?.warning) {
        toastFail('已绑定 · 拍数需要核对', `${detail}${inspection}${extra ? `。${extra}` : ''}`);
      } else {
        toastOk('绑定成功', `${detail}${inspection}${extra ? `。${extra}` : ''}`);
      }
      previewRef.current.stop();
      setPreviewing(false);
    },
    [anchors, audioGrid, setAudioMsg, setAnchors, setTempoDraft, setTempoOverride, setPivotBeat, setPreviewing],
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
    setWaveBeat(Math.round(secToBeat(audioGrid, sec) * 100) / 100);
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
   * 输入 / 点音试听用的音色：**该位置生效的音色**——声部（或曲目）设置打底，
   * 小节线「音N」从那根线之后覆盖（与 buildTimeline 的 patchChangesOf 同口径：
   * 只数该声部事件流里排在目标位置之前的 barline，点音 N = 第 index 个音，
   * 输入试听 = 光标处）。
   * **必须走 scoreParts()**：第一声部存在 `score.part` 而不是 `parts` 数组里——
   * 之前只查 parts，给第一声部（含单声部谱）配置的音色在点音试听时根本读不到，
   * 永远回落曲目音色（0.3.8 修，用户实测「点音符还是别的音色」）。
   * 真采样没解码时 notePreview 会先拉懒加载再用真音色补声，无需 await。
   */
  const effectivePatchAt = useCallback((index: number): number => {
    const p = scoreParts(documentScore).find((x) => x.id === activePartId);
    let patch = p?.patch ?? documentScore.meta.patch;
    const n = Math.min(Math.max(index, 0), score.events.length);
    for (let i = 0; i < n; i++) {
      const e = score.events[i]!;
      if (e.kind === 'barline' && typeof e.patchAfter === 'number') patch = e.patchAfter;
    }
    return patch;
  }, [documentScore, activePartId, score]);

  /** 输入试听用的音色八度（与音色同源：声部未设置则跟曲目） */
  const previewOctave = useMemo(() => {
    const p = scoreParts(documentScore).find((x) => x.id === activePartId);
    if (p?.patchOctave !== undefined) return p.patchOctave;
    return documentScore.meta.patchOctave ?? 0;
  }, [documentScore, activePartId]);

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
      // 点到音符就奏一声它的音高（拖选建区间不算——那是在框选，不是在点听）
      if ((!b || b.index === a.index) && a.index >= 0 && a.index < score.events.length) {
        const ev = score.events[a.index]!;
        if (ev.kind === 'note') {
          // 有效调号：转调后的音按新调算（转调记号含它自己那颗）
          let key = score.meta.key;
          for (let i = 0; i <= a.index; i++) {
            const e = score.events[i]!;
            if (e.kind === 'note' && e.keyChange) key = e.keyChange;
          }
          previewNote(toMidi(ev.degree, ev.octave, key, ev.accidental), 0.28, effectivePatchAt(a.index), previewOctave);
        }
      }
      // 拖选（框选一段）**不发声**：0.2.182 试过「新选中的音依次响」，
      // 但鼠标每动一下就触发一次 handlePick，一次拖动下来几十个音各响 0.45 秒
      // 层层叠在一起，听着就是一团噪音（用户实测太乱，已下线）。
      // 点单个音的试听保留在下面 setSnap 之前的那个分支里。
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
    [bindPick, wavePos, activePartId, score, effectivePatchAt, previewOctave],
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
      const cands = groupCandidates(ids.length, ticks, meterAt(score, snap.cursor));
      // 一律弹面板（哪怕只有均分一档）：用户要的是「看到候选 + 能点自定义」，
      // 静默画默认值会让人以为点错了（用户实测 4/6/7/8 音选 1 拍直接被画成均分）
      setPending({ ids, ticks, cands });
    },
    [selectedTimedIds, score, snap, commit],
  );

  // 连音不走独立按钮：选区选 1 拍时候选面板里就有「n 连音」，
  // 单选下面板也没有它的位置（见属性检查器里那段注释）。

  const doSlur = useCallback(() => {
    if (selectedTimedIds.length < 2) return;
    commit({ ...snap, score: toggleSlur(score, selectedTimedIds) });
  }, [selectedTimedIds, score, snap, commit]);

  /**
   * 输入板的动作：与键盘输入**等价**，一律作用在光标处 / 光标左侧的音上。
   * 「左侧的音」走 prevTimed（over 模式下就是 overId），与键盘 2876-2949 同一套。
   */
  const padLeftId = useCallback((): string | null => {
    const k = prevTimed(score, snap.cursor);
    if (k < 0) return null;
    const e = score.events[k];
    if (!e) return null;
    return e.kind === 'note' || e.kind === 'rest' ? e.id : null;
  }, [score, snap.cursor]);

  /**
   * 输入试听：每输入 / 替换一个音符，立刻响一声它的音高（用户 0.2.161 定）。
   * 音高按记谱调 + 变音记号换算 MIDI，与播放同一份音色代码。
   * 在手势处理函数里同步调用——AudioContext 必须在手势窗口内建好并 resume。
   */
  const previewInput = useCallback(
    (degree: number, octave = 0, accidental?: Accidental) => {
      previewNote(toMidi(degree, octave, score.meta.key, accidental), 0.28, effectivePatchAt(snap.cursor), previewOctave);
    },
    [score.meta.key, snap.cursor, effectivePatchAt, previewOctave],
  );
  /** 替换左侧音的音级时沿用它的八度 / 变音（octaveOverride 给八度按钮覆盖） */
  const previewReplace = useCallback(
    (id: string, degree: number, octaveOverride?: number) => {
      const e = score.events.find((x) => x.id === id);
      if (e && e.kind === 'note') {
        const idx = score.events.findIndex((x) => x.id === id);
        previewNote(toMidi(degree, octaveOverride ?? e.octave, score.meta.key, e.accidental), 0.28, effectivePatchAt(idx), previewOctave);
      }
    },
    [score, effectivePatchAt, previewOctave],
  );

  /**
   * 浮动板字段组件的目标音：**仅限真正选中的音**（over 模式焦点）。
   * 插入光标状态下不出现技法 / 倚音 / 力度分区——那些是「改选中音」的功能，
   * 对着左侧音改会让用户以为在改刚输入的下一个音。
   * 插入模式的音级 / 八度 / 变音等仍走 padActions 的左侧音路径，不受影响。
   */
  const padTarget = useMemo(
    // 休止符也算「目标」：选中 0 时时值 / 附点按钮同样要亮（0 按钮本身点亮）
    () => (focus && (focus.kind === 'note' || focus.kind === 'rest') ? focus : null),
    [focus],
  );

  /**
   * 浮动板的段落标注提交：与右侧检查器同一条守则——插入 / 删除 directive
   * 会挪动后续所有事件的下标，光标必须跟着位移，否则焦点落到标注自己身上。
   */
  const padAnnotate = useCallback(
    (next: Score, shift: number) => {
      commit({ ...snap, score: next, cursor: snap.cursor + shift });
    },
    [commit, snap],
  );

  const padActions = useMemo<PadActions>(
    () => ({
      note: (d, oct) => {
        if (d === 0) {
          if (overId) setScore(setDegree(score, overId, 0));
          else commit({ score: insertRest(score, snap.cursor), cursor: snap.cursor + 1, anchor: null, mode: 'insert' });
          return;
        }
        if (overId) {
          const s1 = setDegree(score, overId, d);
          setScore(oct !== 0 ? setOctave(s1, overId, oct) : s1);
          previewReplace(overId, d, oct !== 0 ? oct : undefined);
          return;
        }
        const next = insertNote(score, snap.cursor, d as Degree, oct);
        commit({ score: next, cursor: snap.cursor + 1, anchor: null, mode: 'insert' });
        previewInput(d, oct);
      },
      rest: () => {
        if (overId) setScore(setDegree(score, overId, 0));
        else commit({ score: insertRest(score, snap.cursor), cursor: snap.cursor + 1, anchor: null, mode: 'insert' });
      },
      x: () => {
        commit({ score: insertRest(score, snap.cursor, true), cursor: snap.cursor + 1, anchor: null, mode: 'insert' });
      },
      barline: () => {
        const r = pressBarline(score, snap.cursor);
        commit({ score: r.score, cursor: r.cursor, anchor: null, mode: 'insert' });
      },
      barlineAs: (kind) => {
        // 反复 / 终止 / 双细线都是**这一根线**的属性：光标左边（或被选中）的那根线就地改，
        // 左边没有线才插一根新的。绝不新增第二条线（见 setBarlineRepeat 的说明）。
        const focused = focus && focus.kind === 'barline' ? (focus as BarlineEvent) : null;
        const left = snap.cursor > 0 ? score.events[snap.cursor - 1] : undefined;
        const target = focused ?? (left && left.kind === 'barline' ? (left as BarlineEvent) : null);
        const apply = (s: Score, id: string): Score => {
          const styled = setBarlineStyle(s, id, kind === 'final' ? 'final' : kind === 'double' ? 'double' : 'single');
          // 终止线不能同时挂着反复，反过来改成反复时也清掉终止属性
          return setBarlineRepeat(
            styled,
            id,
            kind === 'repeat-start' ? 'start' : kind === 'repeat-end' ? 'end' : kind === 'repeat-both' ? 'both' : undefined,
            2,
          );
        };
        if (target) {
          setScore(apply(score, target.id));
          return;
        }
        const s = insertBarline(score, snap.cursor);
        const fresh = s.events[snap.cursor];
        if (!fresh || fresh.kind !== 'barline') return;
        commit({ score: apply(s, fresh.id), cursor: snap.cursor + 1, anchor: null, mode: 'insert' });
      },
      accidental: () => {
        // 与属性面板那排按钮同一顺序：升 → 降 → 还原 → 无（跟随调号）
        const id = padLeftId();
        if (!id) return;
        const ev = score.events.find((e) => e.id === id);
        if (!ev || ev.kind !== 'note') return;
        const i = ACCIDENTAL_CHOICES.indexOf(ev.accidental);
        setScore(setAccidental(score, id, ACCIDENTAL_CHOICES[(i + 1) % ACCIDENTAL_CHOICES.length]));
      },
      dot: () => {
        const id = padLeftId();
        if (id) setScore(cycleDot(score, id));
      },
      breakLine: () => {
        // 换行是小节线的属性：光标要落在某根竖线上（barlineFocus 声明在后面，这里就地判断）。
        // 再按一次取消——不然想撤掉换行只能去属性面板改
        if (focus && focus.kind === 'barline') {
          const bar = focus as BarlineEvent;
          setScore(setBarNotation(score, bar.id, { breakAfter: bar.breakAfter === 'line' ? undefined : 'line' }));
        }
      },
      octave: (delta) => {
        // 升 / 降 8 度对选区同样有意义：所有选中音一起移动（封顶规则与单音一致）
        if (selectedTimedIds.length >= 2) {
          setScore(shiftOctaveMany(score, selectedTimedIds, delta));
          return;
        }
        const id = padLeftId();
        if (id) setScore(shiftOctave(score, id, delta));
      },
      paren: (side) => {
        const id = focus && (focus.kind === 'note' || focus.kind === 'rest') ? focus.id : padLeftId();
        if (id) setScore(toggleParen(score, id, side));
      },
      slur: () => {
        if (selectedTimedIds.length >= 2) {
          commit({ ...snap, score: toggleSlur(score, selectedTimedIds) });
          return;
        }
        const id = padLeftId();
        if (id) setScore(extendSlurRight(score, id));
      },
      duration: (ticks) => {
        if (selectedTimedIds.length >= 2) {
          useTier(ticks);
          return;
        }
        const id = padLeftId();
        if (id) setScore(setTicks(score, id, ticks));
      },
      group: (ticks) => {
        // 音值组合：选好几个音 → 先定「合起来凑多少」→ 弹出常用组合候选
        //（候选就地渲染在输入板里）
        if (selectedTimedIds.length < 2) {
          setMsg('音值组合：先选中至少两个音符（拖选或 Shift+方向键）');
          return;
        }
        setPending({ ids: selectedTimedIds, ticks, cands: groupCandidates(selectedTimedIds.length, ticks, meterAt(score, snap.cursor)) });
      },
      applyGroup: (cand) => {
        if (!pending) return;
        const next = applyTierOp(score, pending.ids, pending.ticks, cand.ticks, cand.tuplet, cand.dots);
        if (next) commit({ ...snap, score: next });
        setPending(null);
      },
      openCustomGroup: () => setCustomGroupOpen(true),
      cancelGroup: () => setPending(null),
      del: () => {
        // 批量选中（拖选区间）→ 一次删光整个选区（与右侧「删除所选」同路径）；
        // 否则与键盘 Backspace 同一条路径：替换模式删当前音，插入模式删光标左边的音
        if (range) {
          deleteSelection();
          return;
        }
        if (overId) {
          commit({
            score: removeEvent(score, overId),
            cursor: Math.max(0, snap.cursor - 1),
            anchor: null,
            mode: 'insert',
          });
        } else if (snap.cursor > 0) {
          commit({
            score: removeEvent(score, score.events[snap.cursor - 1].id),
            cursor: snap.cursor - 1,
            anchor: null,
          });
        }
      },
    }),
    [overId, score, snap, commit, setScore, setMsg, padLeftId, focus, selectedTimedIds, useTier, pending, range, deleteSelection],
  );

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
  const androidParts = scoreParts(fullViewScore);
  const androidViewPart = androidNarrow
    ? (androidPartPick && androidPartPick !== 'total' ? androidPartPick : androidParts[0].id)
    : androidPartPick ?? 'total';
  const viewScore = androidPlayer
    ? androidViewPart === 'total' ? fullViewScore : partScore(fullViewScore, androidViewPart)
    : totalView ? fullViewScore : partScore(fullViewScore, activePartId);

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
    () => (expandView ? buildTimeline(playScore, { ids: 'own', mergeTies: false }) : notationTimeline),
    [playScore, notationTimeline, expandView],
  );
  const handlePlayPick = (pick: ScorePick): void => {
    if (pick.mode !== 'over') return;
    const partId = pick.partId ?? activePartId;
    const shown = partScore(fullViewScore, partId);
    const event = shown.events[pick.index];
    if (!event || !isTimed(event)) return;
    const expanded = partScore(playScore, partId);
    const index = expandView ? pick.index : expansion.firstIndex.get(event.id) ?? expanded.events.findIndex(e => e.id === event.id);
    if (index < 0) return;
    const sourceIndex = partScore(documentScore, partId).events.findIndex(e => e.id === (event.originId ?? event.id));
    stopPlay();
    setPlayPick({ id: event.id, tick: tickAtEvent(expanded, index), score: playScore, viewChoice: expandViewPick });
    setSnap(s => ({ ...s, partId, cursor: Math.max(0, sourceIndex + 1), anchor: null, mode: 'over' }));
  };
  const selectPart = (id: string) => {
    setPlayPick(null);
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
  const staffPart = scoreParts(documentScore).find(p => p.id === activePartId)!;
  const toggleStaffClef = (id: string, current: StaffClef) => {
    const parts = scoreParts(documentScore);
    const part = parts.find(p => p.id === id);
    if (!part) return;
    const clef = current === 'bass' ? 'treble' : 'bass';
    changeParts(assembleParts(documentScore, parts.map(p => p.id === id ? { ...p, staffClef: clef } : p)));
  };
  const suggestBass = resolveStaffClef(staffPart, documentScore.meta.key, staffPitchMode) !== 'bass' && suggestStaffClef(staffPart, documentScore.meta.key, staffPitchMode) === 'bass';
  const staffSettings = <div className="v2-meta" aria-label="五线谱记谱设置">
    <div className="v2-exp-hint">当前声部：{staffPart.name}</div>
    <label className="v2-meta-row"><span className="v2-meta-label">记谱乐器</span>
      <select className="v2-meta-input" value={staffPart.staffInstrument ?? 'concert'} onChange={e => changeParts(assembleParts(documentScore, scoreParts(documentScore).map(p => p.id === activePartId ? { ...p, staffInstrument: e.target.value as StaffInstrument } : p)))}>
        {STAFF_INSTRUMENTS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
    </label>
    <label className="v2-meta-row"><span className="v2-meta-label">谱号</span>
      <select className="v2-meta-input" value={staffPart.staffClef ?? 'auto'} onChange={e => changeParts(assembleParts(documentScore, scoreParts(documentScore).map(p => p.id === activePartId ? { ...p, staffClef: e.target.value as StaffClefSetting } : p)))}>
        <option value="auto">默认（当前：{resolveStaffClef({ ...staffPart, staffClef: 'auto' }, documentScore.meta.key, staffPitchMode) === 'bass' ? '低音谱号' : '高音谱号'}）</option>
        <option value="treble">高音谱号</option><option value="bass">低音谱号</option>
      </select>
    </label>
    <p className="v2-exp-hint">乐器移调谱按所选乐器显示；实音谱保持实际音高。设置不改变播放音高，可撤销。</p>
    <p className="v2-exp-hint">默认以高音为基准，只有持续处于明显低音区且加线大幅减少时采用低音。手动指定的谱号保持。</p>
    {suggestBass ? <div className="v2-exp-hint">当前声部持续处于低音区，建议使用低音谱号。<button className="v2-btn" onClick={() => changeParts(assembleParts(documentScore, scoreParts(documentScore).map(p => p.id === activePartId ? { ...p, staffClef: 'bass' } : p)))}>应用低音谱号</button></div> : null}
  </div>;
  const selectLyrics = (partId: string, verse: number | null) => {
    setLyricCellId(null);
    stopPlay();
    setPending(null);
    setSnap((s) => ({ ...s, partId, anchor: null, ...(partId !== activePartId ? { cursor: 0, mode: 'insert' as const } : {}) }));
    setLyricSelection((previous) => verse === null ? null : { partId, verse, session: (previous?.session ?? 0) + 1 });
  };
  const changeLyricLink = (id: string, link: LyricLink | null, word?: string): boolean => {
    if (lyricVerse === null) return false;
    const current = score.events.find(e => e.id === id);
    const unchanged = current?.kind === 'note' && word === (current.lyrics?.[lyricVerse] ?? '');
    const written = word === undefined || unchanged ? { score } : writeLyricInput(score, id, lyricVerse, word);
    if ('error' in written && written.error) { setMsg(written.error); return false; }
    const result = setLyricLink(written.score, id, lyricVerse, link);
    if (result.error) { setMsg(result.error); return false; }
    setMsg(''); setScore(result.score);
    setLyricSelection(previous => previous ? { ...previous, startId: id, session: previous.session + 1 } : previous);
    return true;
  };
  const lyricCell = score.events.find(e => e.kind === 'note' && e.id === lyricCellId);
  const lyricConnection = lyricVerse !== null && lyricCell?.kind === 'note' ? lyricCell.lyricLinks?.[lyricVerse] : null;

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
    (repeat?: 'start' | 'end' | 'both') => {
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

  /**
   * 浮动板的小节线动作集：与右侧检查器同一条写谱路径（点线时整个面板切换）。
   */
  const padBarlineActions = useMemo(
    () => ({
      setBeatAfter: (v?: string) => {
        if (!barlineFocus) return;
        setScore(resplitOversizedGroups(setBarNotation(score, barlineFocus.id, { beatAfter: v })));
      },
      setBreakAfter: (v?: 'line' | 'page') => {
        if (!barlineFocus) return;
        setScore(setBarNotation(score, barlineFocus.id, { breakAfter: v }));
      },
      setBpmAfter: (v?: number) => {
        if (!barlineFocus) return;
        setScore(setBarNotation(score, barlineFocus.id, { bpmAfter: v }));
      },
      setPatchAfter: (v?: number) => {
        if (!barlineFocus) return;
        setScore(setBarNotation(score, barlineFocus.id, { patchAfter: v }));
      },
      setRepeat,
      setRepeatTimes: (n: number) => {
        if (!barlineFocus) return;
        setScore(setRepeatTimes(score, barlineFocus.id, n));
      },
      setVolta,
      toggleFinal: () => {
        if (!barlineFocus) return;
        setScore(setBarlineStyle(score, barlineFocus.id, barlineFocus.style === 'final' ? 'single' : 'final'));
      },
      toggleDouble: () => {
        if (!barlineFocus) return;
        setScore(setBarlineStyle(score, barlineFocus.id, barlineFocus.style === 'double' ? 'single' : 'double'));
      },
      toggleVoltaOpen: () => {
        if (!barlineFocus) return;
        setScore(setBarlineVoltaOpen(score, barlineFocus.id, !barlineFocus.voltaOpen));
      },
      toggleJump: (mark: JumpMark | null) => {
        if (!barlineFocus) return;
        setScore(toggleJumpAfterBarline(score, barlineFocus.id, mark));
      },
    }),
    [barlineFocus, score, setScore, setRepeat, setVolta],
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
          previewReplace(overId, d);
        } else {
          commit({ score: insertNote(score, cur, d), cursor: cur + 1, anchor: null, mode: 'insert' });
          previewInput(d);
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
        case 'x':
        case 'X':
          e.preventDefault();
          // X 无音高音符：总是插入新的（没有音级可替换）
          commit({ score: insertRest(score, cur, true), cursor: cur + 1, anchor: null, mode: 'insert' });
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
          commit({ score: setTicks(score, prev.id, base > TICKS_PER_BEAT / 8 ? base / 2 : TICKS_PER_BEAT) });
          return;
        }
        case '.': {
          e.preventDefault();
          // 附点对音符与休止符（含 X）都有效：一律作用于光标左边最近的那个音
          const k = prevTimed(score, cur);
          if (k < 0) return;
          const prev = score.events[k];
          if (prev.kind !== 'note' && prev.kind !== 'rest') return;
          commit({ score: cycleDot(score, prev.id) });
          return;
        }
        case '^':
        case 'v':
        case 't': {
          e.preventDefault();
          // 一律作用于光标左边最近的那个音：over 模式下就是被选中的音，
          // insert 模式下遇到小节线也能正确落到前一个音上。
          const k = prevTimed(score, cur);
          if (k < 0) return;
          const prev = score.events[k];
          if (prev.kind !== 'note') return;
          const next =
            e.key === 't'
              ? toggleTongue(score, prev.id)
              : shiftOctave(score, prev.id, e.key === '^' ? 1 : -1);
          commit({ score: next });
          return;
        }
        // 八度：· 降 8、~ 升 8（中文标点下同一颗键的上下档，手不用挪）。
        // 英文布局下这颗键是 `（无 Shift）/ ~（Shift），所以 ` 一并认作降 8。
        // 与 ^ / v 并存：那两个是英文写法（封顶移动），这一对是 JP-Word 同款
        // **循环**——连按 1 个点 → 2 个点 → 3 个点 → 无点，再按重新开始。
        case '·':
        case '`':
        case '~': {
          e.preventDefault();
          // 与 ^ / v 同一套：作用于光标左边最近的那个音（选中时就是被选中的那个）
          const k = prevTimed(score, cur);
          if (k < 0) return;
          const prev = score.events[k];
          if (prev.kind !== 'note') return;
          commit({ score: cycleOctave(score, prev.id, e.key === '~' ? 1 : -1) });
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
    if (androidPlayer) return;
    const t = window.setTimeout(() => {
      saveSession({ text: serialized, name: active, path, libraryId });
    }, 600);
    return () => window.clearTimeout(t);
  }, [serialized, active, path, libraryId]);

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
          return false;
        }
      }
      setView(next);
      return true;
    },
    [view, draft, serialized, stopPlay, commit],
  );

  const chooseNotation = (staff: boolean, settings = false): void => {
    if (!switchView('score')) return;
    setStaffViewOn(staff);
    if (settings) setStaffSettingsOpen(true);
  };

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
  const audioLost = !androidPreview && !restoring && stems.length === 0 && !!loadAlign(active)?.audio?.length;

  /*
   * 模式开关。抽出来是为了在下面的条件渲染之外求值——
   * 「编辑器只在非曲库模式渲染」那支里 mode 会被收窄成 'score' | 'align'，
   * 在里面写 mode === 'library' 会被当成永远不成立（也就点不回曲库）。
   * 单功能页不显示它：这一屏只干一件事，跳去别的屏反而是干扰。
   */
  if (androidPlayer) {
    const totalTicks = timelineTicks(timeline);
    // 合成音的秒换算：谱中变速走曲线（倍速缩放），恒定速度照旧线性
    const synthTempoEff = synthTempo ? (speed === 1 ? synthTempo : scaleTempoMap(synthTempo, speed)) : null;
    const secondsAt = (tick: number) =>
      playSource === 'audio' && audioTempo ? tickToSec(audioTempo, tick) / speed
      : synthTempoEff ? tickToSec(synthTempoEff, tick) / speed
      : tick / TICKS_PER_BEAT * 60 / (score.meta.bpm * speed);
    const duration = playSource === 'audio' && stems.length ? Math.max(...stems.map(s => s.buffer.duration)) / speed : secondsAt(totalTicks);
    const seekAndroid = (seconds: number) => {
      const tick = playSource === 'audio' && audioTempo ? secToTick(audioTempo, seconds * speed)
        : synthTempoEff ? secToTick(synthTempoEff, seconds * speed)
        : seconds * score.meta.bpm * speed / 60 * TICKS_PER_BEAT;
      const resume = playing;
      stopPlay(); androidResumeTick.current = tick; clockRef.current.seek(tick / TICKS_PER_BEAT);
      if (resume) startPlay(tick);
    };
    return <div className="v2-app" data-theme={dark ? 'dark' : 'light'} data-entry={entry}><AndroidPlayer
      title={androidItem?.name ?? active} playing={playing} busy={shifting} restoring={restoring || !active || restoredRef.current !== active}
      audioReady={audioReady} duration={duration}
      getSeconds={() => playing ? Math.max(0, playSource === 'audio' ? (playerRef.current.currentSec ?? 0) : secondsAt(getPlayTick() ?? 0)) : androidResumeTick.current === null ? 0 : Math.max(0, secondsAt(androidResumeTick.current))}
      onSeek={seekAndroid}
      onToggle={() => {
        if (playing) { const at = getPlayTick() ?? 0; stopPlay(); androidResumeTick.current = at; clockRef.current.seek(at / TICKS_PER_BEAT); }
        else startPlay(androidResumeTick.current ?? undefined);
      }}
      onReplay={() => { stopPlay(); androidResumeTick.current = null; setPlayPick(null); setSnap(s => ({ ...s, cursor: 0, mode: 'insert', anchor: null })); requestAnimationFrame(() => startPlay(0)); }}
      onBack={() => { androidAlive.current = false; stopPlay(); onAndroidBack?.(); }}
      notation={notation} onNotation={setStaffViewOn} pitch={staffPitchMode} onPitch={setStaffPitchMode} source={playSource}
      parts={androidParts.map(part => ({ id: part.id, name: part.name }))} selectedPart={androidViewPart} allowTotal={!androidNarrow}
      onPart={id => { setAndroidPartPick(id); if (id !== 'total') selectPart(id); }}
      onSource={source => { const at = getPlayTick() ?? 0; stopPlay(); androidResumeTick.current = at; clockRef.current.seek(at / TICKS_PER_BEAT); setPlaySource(source); }}
      font={effFont} onFont={setPlayFont} onResetFont={() => setPlayFont(null)} gap={effGap} onGap={setPlayGap}
      lineGap={effLineGap} onLineGap={setPlayLineGap}
      style={playStyle} onStyle={setPlayStyle} expanded={expandView} canExpand={canExpandView} onExpand={setExpandView}
      stems={stems.map(s => ({ name: s.name, on: s.on, vocal: isVocalName(s.name) }))}
      onStem={toggleStem} onStemsAll={() => setStemsOn(() => true)} onStemsNoVocal={() => setStemsOn((name: string) => !isVocalName(name))}
      transpose={transpose} onTranspose={changeTranspose} speed={speed} onSpeed={changeSpeed}
      metronomeFollow={metronomeFollow} onMetronomeFollow={setMetronomeFollow}
      metronomePattern={metronomePatternId} onMetronomePattern={setMetronomePatternId}
      metronomeVolume={metronomeVolume} onMetronomeVolume={setMetronomeVolume}
      onMetronomeTest={() => metronomeRef.current?.clickOnce(true)}
      scoreBeat={score.meta.beat}
      metronomeBpm={Math.round(score.meta.bpm * speed * 100) / 100}
      timbreLabel={playTimbre ? `已设 ${Object.keys(playTimbre.parts ?? {}).length} 个声部` : '跟随谱面'}
      onOpenTimbre={() => setAnTimbreOpen(true)}
      message={msg.includes('失败') ? msg : undefined}
      renderScore={() => <ScoreCanvas score={viewScore} dark={dark} activePartId={androidViewPart === 'total' ? activePartId : androidViewPart}
        unit={EDITOR_UNIT} fontSize={effFont} letterSpacing={effGap} lineGap={effLineGap} responsive
        selectedIds={EMPTY_SELECTED} cursor={0} timeline={displayTimeline} playStyle={playStyle}
        notation={notation} staffPitchMode={staffPitchMode} playing={playing} clock={clockRef.current}
        getPlayTick={getPlayTick} showCaret={false} focusId={activePlayPick?.id ?? null}
        onPick={pick => {
          if (pick.mode !== 'over') return;
          const partId = pick.partId ?? (androidViewPart === 'total' ? activePartId : androidViewPart);
          const shown = partScore(fullViewScore, partId); const event = shown.events[pick.index];
          if (!event || !isTimed(event)) return;
          const expanded = partScore(playScore, partId);
          const index = expandView ? pick.index : expansion.firstIndex.get(event.id) ?? expanded.events.findIndex(e => e.id === event.id);
          if (index < 0) return;
          const tick = tickAtEvent(expanded, index); const resume = playing;
          handlePlayPick(pick); androidResumeTick.current = tick; clockRef.current.seek(tick / TICKS_PER_BEAT);
          if (resume) startPlay(tick);
        }}
        onEnded={onAndroidScoreEnded}
      />}
    />
    {/* 安卓播放设置 → 合成音音色：数据与 PC 版共用（按曲名记），播放中改动先停再生效 */}
      {anTimbreOpen ? <AndroidTimbreDialog
        score={timbreScore}
        timbre={playTimbre}
        onChange={(t) => { if (playing) stopPlay(); setPlayTimbre(t); }}
        onClose={() => setAnTimbreOpen(false)} /> : null}
    </div>;
  }
  return (
    <div className="v2-app" data-theme={dark ? 'dark' : 'light'} data-entry={entry}>
      {/* play.html 是独立入口：整行顶栏（含返回首页、品牌、文件状态、校验）不显示，播放页有自己的工具条（含月亮主题开关）。 */}
      <header className="v2-head">
        <div className="v2-brand">
          {/*
            返回首页：编辑页与曲库管理页都有——它们是从落地页点进来的，
            任何时候都能一步回去。
            play.html 的顶栏整行不显示（独立入口，播放页自带工具条），
            它的返回入口做在播放界面里，见 DiscoverScreen.homeHref 与播放工具条。
          */}
          {/*
            返回按钮**整屏只能有一个**：播放屏（播放工具条）与动态谱首页（DiscoverScreen）
            各自带了自己的返回，这一层再显示就两个「返回」并排，不知该点哪个。
            所以这两个模式下顶栏的返回让位给屏内那一个。
          */}
          {mode !== 'play' && mode !== 'discover' && (entry === 'editor' || entry === 'align' || entry === 'library') ? (
            entry === 'align' && backFrom === 'library' ? (
              // 从曲库点「对轨」进来的：一步回曲库，别把人甩到首页再点一次
              <a className="v2-home-btn" href="./library.html" title="回到曲库">
                ← 返回曲库
              </a>
            ) : (
              <a className="v2-home-btn" href="./index.html" title="回到首页">
                ← 返回首页
              </a>
            )
          ) : null}
          <span className="v2-brand-name">
            WindScore <span className="v2-brand-tag">{entry === 'align' ? '动态谱生成' : entry === 'editor' ? '简谱编辑' : '写谱器'}</span>
          </span>
        </div>
        {/* 曲目信息只在谱面标题块 + 曲目信息面板出现，工具栏不再重复一遍 */}
        <div className="v2-file" title={path ?? fileHandle?.name ?? '当前内容还没落到文件里'}>
          <span className={dirty ? 'v2-file-badge is-dirty' : 'v2-file-badge'}>
            {dirty ? '● 有未保存的改动' : '已保存'}
          </span>
          <span className="v2-file-name">{(path ?? fileHandle?.name) ? nameOf(path ?? fileHandle!.name!) : '未保存到文件'}</span>
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
                导出
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
                title={
                  libraryId
                    ? `把修改写回曲库「${active}」（这份谱是从曲库打开的，不再另存 .jps）${dirty ? '；有未保存的改动' : ''}`
                    : `把当前谱面存成 .jps（含在「简谱编辑」页签里的修改）${dirty ? '；有未保存的改动' : ''}`
                }
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
                title="打开机器上的 .wspack（谱面 + 伴奏 + 对轨标定），装回这里继续对轨编辑——「打包」的逆操作"
                onClick={() => packRef.current?.click()}
              >
                导入打包
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
            </>
          ) : null}
          {mode !== 'play' && mode !== 'discover' ? <button className="v2-btn" aria-haspopup="dialog" onClick={() => setHelpOpen(true)}>帮助</button> : null}
          {/* 文件选择框两种模式共用（浏览器预览时没有 Tauri 对话框，靠它兜底） */}
          <input ref={fileRef} type="file" accept=".jps,.txt" hidden onChange={onFilePicked} />
          <input ref={packRef} type="file" accept=".wspack" hidden onChange={onPackPicked} />
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
            {/*
              返回哪一屏看**来路**：从曲库点歌进来就回曲库（别把人甩回首页），
              从动态谱首页进来就回那里；play.html 是独立入口，再补一个回落地页的「返回首页」。
            */}
            {playFrom === 'library' ? (
                <button
                  className="v2-btn"
                  onClick={() => setMode('library')}
                  title="回到曲库"
                >
                  ← 返回曲库
                </button>
            ) : (
                <button
                  className="v2-btn"
                  onClick={() => setMode('discover')}
                  title="回到动态谱首页"
                >
                  {/* 文案只写**来路那一屏的名字**：「首页」这个称呼留给落地页
                      （index.html，动态谱首页上有它的入口），两处同名会指到不同地方 */}
                  ← 返回动态谱
                </button>
            )}
            <span className="v2-play-title" title={score.meta.title || active}>
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
            {/* 合成音音色：整谱 + 各声部覆盖（不改谱面，按曲子记住）；伴奏场景不出现 */}
            {playSource === 'synth' ? (
              <button
                className={`v2-btn ${playTimbre ? 'is-on' : ''}`}
                onClick={() => setTimbreOpen(true)}
                title="合成音音色：整谱与各声部（不改谱面，按曲子记住）"
              >
                音色{playTimbre ? ' •' : ''}
              </button>
            ) : null}
            {/* 节拍器：只跟着谱面（伴奏场景不出现，见 metronomeAvailable） */}
            {metronomeAvailable ? (
              <MetronomeButton
                on={metronomeFollow}
                onToggle={() => {
                  const next = !metronomeFollow;
                  if (next) metronomeRef.current?.unlock(); // 用户手势窗口内建好音频上下文
                  else metronomeRef.current?.stop();
                  setMetronomeFollow(next);
                }}
                onOpen={() => {
                  metronomeRef.current?.unlock(); // 这次点击顺手把音频上下文建好
                  setMetronomeOpen(true);
                }}
              />
            ) : null}
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
                min={-20}
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
            <div className="v2-view-switch" aria-label="播放谱式">
              <button className={!staffViewOn ? 'v2-seg is-on' : 'v2-seg'} aria-pressed={!staffViewOn} onClick={() => setStaffViewOn(false)}>简谱</button>
              <StaffViewButton active={staffViewOn} onSelect={() => setStaffViewOn(true)} onSettings={() => { setStaffViewOn(true); setStaffSettingsOpen(true); }} />
            </div>
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
                title={staffViewOn ? '贯穿谱表的窄竖高亮带，按节拍连续移动' : '从当前行行首开始、随音乐变宽的高亮条'}
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
            {restoringAudio || !audioReady || playSource !== 'audio' ? <span className="v2-play-note">
              {restoringAudio
                ? '正在从本地恢复伴奏…'
                : audioReady
                  ? playSource === 'audio'
                    ? ''
                    : '合成音：想跟伴奏就切回「伴奏」'
                  : audioLost
                    ? entry === 'play'
                      ? '伴奏文件不在本机缓存里了——到主程序的对轨界面重新载入'
                      : '伴奏文件不在本机缓存里了——到对轨界面重新载入，或重新导入那个 .wspack'
                    : entry === 'play'
                      ? '这首还没有伴奏——在主程序对轨界面载入伴奏并打包即可'
                      : '这首还没有伴奏——去曲库导入打包，或在对轨界面载入伴奏'}
              {expandView && canExpandView ? '（显示的是拉平后的线性谱）' : ''}
            </span> : null}
            {/* 导出放在工具条最右：这一排里只有它会离开当前界面 */}
            <button
              className="v2-btn v2-play-export"
              onClick={() => setExportOpen(true)}
              title="导出 PDF / 视频"
            >
              导出
            </button>
            <button className="v2-btn" aria-haspopup="dialog" onClick={() => setHelpOpen(true)}>帮助</button>
            <ThemeToggle dark={dark} onChange={setDark} />
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

          {scoreParts(documentScore).length > 1 ? <PartsPanel score={documentScore} activeId={activePartId} total={totalView} readOnly onSelect={selectPart} onTotal={setTotalView} onChange={changeParts} /> : null}
          {/* 变调/变速离线处理的等待遮罩：首次换参要算几秒，给个明确的「正在干活」反馈 */}
          {shifting ? (
            <div className="v2-shift-mask" role="alert" aria-live="polite">
              <div className="v2-shift-card">
                <span className="v2-shift-spin" aria-hidden="true" />
                <div>
                  <div>{shiftLabel || '正在处理音频'}</div>
                  <div className="v2-shift-note">首次处理需要几秒，相同参数之后秒开</div>
                </div>
              </div>
            </div>
          ) : null}
          {/* 无伴奏播放的调/速弹窗：改完即时生效（播放中会从当前位置带新参数重启） */}
          {paramOpen ? (
            <div
              className="v2-exp-mask"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) setParamOpen(false);
              }}
            >
              <div className="v2-param" role="dialog" aria-label="调与速度">
                <div className="v2-param-head">
                  <span className="v2-param-title">调与速度</span>
                  <button className="v2-param-close" onClick={() => setParamOpen(false)} aria-label="关闭（不应用修改）">
                    ×
                  </button>
                </div>
                <div className="v2-param-row">
                  <span className="v2-param-label">调</span>
                  <button
                    className="v2-tr-btn"
                    onClick={() => setDraftTranspose(Math.max(-MAX_SEMITONES, draftTranspose - 1))}
                    disabled={draftTranspose <= -MAX_SEMITONES || shifting}
                    title="降半音"
                  >
                    −
                  </button>
                  <output className="v2-param-out">
                    {draftTranspose === 0 ? '原调' : `${draftTranspose > 0 ? '+' : ''}${draftTranspose} 半音`}
                  </output>
                  <button
                    className="v2-tr-btn"
                    onClick={() => setDraftTranspose(Math.min(MAX_SEMITONES, draftTranspose + 1))}
                    disabled={draftTranspose >= MAX_SEMITONES || shifting}
                    title="升半音"
                  >
                    ＋
                  </button>
                </div>
                <div className="v2-param-row">
                  <span className="v2-param-label">速</span>
                  <button
                    className="v2-tr-btn"
                    onClick={() => setDraftSpeed(Math.max(MIN_SPEED, +(draftSpeed - SPEED_STEP).toFixed(2)))}
                    disabled={draftSpeed <= MIN_SPEED || shifting}
                    title={`减速 ${SPEED_STEP}`}
                  >
                    −
                  </button>
                  <output className="v2-param-out">{draftSpeed === 1 ? '原速' : `${draftSpeed.toFixed(2)}×`}</output>
                  <button
                    className="v2-tr-btn"
                    onClick={() => setDraftSpeed(Math.min(MAX_SPEED, +(draftSpeed + SPEED_STEP).toFixed(2)))}
                    disabled={draftSpeed >= MAX_SPEED || shifting}
                    title={`加速 ${SPEED_STEP}`}
                  >
                    ＋
                  </button>
                </div>
                <p className="v2-param-note">
                  点「确认」后作用于当前播放：伴奏离线处理（首次需几秒，之后秒开），合成音即时生效；关闭弹窗不应用。
                </p>
                <div className="v2-param-foot">
                  <button
                    className="v2-param-reset"
                    onClick={() => {
                      setDraftTranspose(0);
                      setDraftSpeed(1);
                    }}
                    disabled={draftTranspose === 0 && draftSpeed === 1}
                  >
                    恢复默认
                  </button>
                  <button
                    className="v2-param-apply"
                    onClick={() => {
                      changeTranspose(draftTranspose);
                      changeSpeed(draftSpeed);
                      setParamOpen(false);
                    }}
                    disabled={shifting || (draftTranspose === transpose && draftSpeed === speed)}
                  >
                    确认
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          <div className="v2-play-stage">
            <ScoreCanvas
              score={viewScore}
              onClefClick={toggleStaffClef}
              activePartId={activePartId}
              dark={dark}
              unit={EDITOR_UNIT}
              fontSize={effFont}
              letterSpacing={effGap}
              selectedIds={EMPTY_SELECTED}
              cursor={0}
              timeline={displayTimeline}
              playStyle={playStyle}
              notation={notation}
              staffPitchMode={staffPitchMode}
              playing={playing}
              clock={clockRef.current}
              getPlayTick={getPlayTick}
              onPick={handlePlayPick}
              onEnded={onPlayEnded}
              showCaret={false}
              focusId={activePlayPick?.id ?? null}
              onLayout={rememberLayout}
              // 谱面标题右侧的齿轮 = 调与速度的统一入口（此前播放页没接这个回调，齿轮是死的）
              onEditTitle={() => {
                setDraftTranspose(transpose);
                setDraftSpeed(speed);
                setParamOpen(true);
              }}
            />
          </div>
        </div>
      ) : null}

      {(mode === 'play' || mode === 'score' || mode === 'align') && staffViewOn && staffSettingsOpen ? <StaffSettingsDialog onClose={() => setStaffSettingsOpen(false)}>
        <div className="v2-view-switch" aria-label="五线谱音高显示">
          <button className={staffPitchMode === 'concert' ? 'v2-seg is-on' : 'v2-seg'} aria-pressed={staffPitchMode === 'concert'} onClick={() => setStaffPitchMode('concert')}>实音谱</button>
          <button className={staffPitchMode === 'transposed' ? 'v2-seg is-on' : 'v2-seg'} aria-pressed={staffPitchMode === 'transposed'} onClick={() => setStaffPitchMode('transposed')}>乐器移调谱</button>
        </div>
        {staffSettings}
      </StaffSettingsDialog> : null}

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
          notation={notation}
          staffPitchMode={staffPitchMode}
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
          // 导出（尤其视频）动辄几十秒：结果在外面也弹一层，关掉弹窗后仍看得见
          onDone={(note, ok) => {
            if (ok) toastOk('导出完成', note);
            else toastFail('导出失败', note);
          }}
          video={{
            displayTimeline: mode === 'play' ? displayTimeline : notationTimeline,
            playStyle,
            activePartId,
            timeline,
            fromTick: 0,
            bpm: score.meta.bpm,
            tempo: audioTempo,
            synthTempo,
            stems: stems.map((s) => ({ buffer: s.buffer, gain: s.on ? 1 : 0 })),
            measureTicks,
          }}
        />
      ) : null}

      {helpOpen ? <HelpDialog dark={dark} initialTopic={mode === 'score' ? view === 'source' ? 'jps' : 'editing' : mode === 'align' ? 'alignment' : mode === 'library' ? 'library' : 'playback'} onClose={() => setHelpOpen(false)} /> : null}

      {/*
        节拍器面板：播放页 / 记谱页 / 动态谱生成页共用一份（挂在最外层，
        切屏不重开）。伴奏场景下按钮不出现，面板也会跟着关掉。
        开关已挪到播放条上（节拍器|⌄），面板只管配置。
      */}
      {metronomeOpen && metronomeAvailable ? (
        <MetronomePanel
          follow={metronomeFollow}
          bpm={Math.round(score.meta.bpm * speed * 100) / 100}
          scoreMeter={score.meta.beat}
          patternId={metronomePatternId}
          onPattern={setMetronomePatternId}
          volume={metronomeVolume}
          onVolume={setMetronomeVolume}
          playing={playing}
          onClose={() => setMetronomeOpen(false)}
        />
      ) : null}
      {/* 播放页的合成音音色（整谱 + 各声部覆盖，不改谱面）：仅合成音场景 */}
      {timbreOpen ? (
        <PlayTimbreDialog
          score={timbreScore}
          timbre={playTimbre}
          onChange={(t) => {
            // 播放中改音色：已经排程出去的音换不了了，停掉让下一次播放整曲用新音色
            if (playing) stopPlay();
            setPlayTimbre(t);
          }}
          onClose={() => setTimbreOpen(false)}
        />
      ) : null}

      {/*
        自定义音值组合：依附于「选择划分」的选区（pending）——点候选面板的
        「自定义组合…」打开，写回走 applyTier 同一条路（组 / 连音 / 附点
        全部由它处理，绘制层的拍组减时线自动连起来）。
      */}
      {customGroupOpen && pending ? (
        <CustomGroupDialog
          totalTicks={pending.ticks}
          beat={meterAt(score, snap.cursor)}
          members={pending.ids.map((id) => {
            const e = score.events.find((x) => x.id === id);
            return {
              id,
              kind: e && (e.kind === 'note' || e.kind === 'rest') ? e.kind : 'note',
              degree: e && e.kind === 'note' ? e.degree : 0,
            };
          })}
          initialTicks={pending.ids.map((id) => {
            const e = score.events.find((x) => x.id === id);
            return e && (e.kind === 'note' || e.kind === 'rest') ? e.ticks : 0;
          })}
          initialTuplet={
            score.groups.find(
              (g) => g.totalTicks === pending.ticks && pending.ids.every((id) => g.memberIds.includes(id)),
            )?.tuplet
          }
          onApply={(ticks, tuplet, dots) => {
            const next = applyTierOp(score, pending.ids, pending.ticks, ticks, tuplet, dots);
            if (next) commit({ ...snap, score: next });
            setCustomGroupOpen(false);
            setPending(null);
          }}
          onClose={() => setCustomGroupOpen(false)}
        />
      ) : null}

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
                onClick={() => (playing ? stopPlay() : startPlay())}
                disabled={timeline.length === 0}
                title={playing ? '停止' : '播放'}
              >
                {playing ? '⏹ 停止' : '▶ 播放'}
              </button>
              {/* 节拍器：记谱页与动态谱生成页也放得下（只在合成音场景出现） */}
              {metronomeAvailable ? (
                <MetronomeButton
                  on={metronomeFollow}
                  onToggle={() => {
                    const next = !metronomeFollow;
                    if (next) metronomeRef.current?.unlock();
                    else metronomeRef.current?.stop();
                    setMetronomeFollow(next);
                  }}
                  onOpen={() => {
                    metronomeRef.current?.unlock();
                    setMetronomeOpen(true);
                  }}
                />
              ) : null}
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
                  title={staffViewOn ? '贯穿谱表的窄竖高亮带，按节拍连续移动' : '从当前行行首开始、随音乐变宽的高亮条'}
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

            {/* 记谱法与源码在同一处切换；动态谱生成页不显示源码入口。 */}
            <div className="v2-view-switch" aria-label="曲谱视图">
              <button
                className={view === 'score' && !staffViewOn ? 'v2-seg is-on' : 'v2-seg'}
                aria-pressed={view === 'score' && !staffViewOn}
                onClick={() => chooseNotation(false)}
              >
                简谱
              </button>
              <StaffViewButton active={view === 'score' && staffViewOn} onSelect={() => chooseNotation(true)} onSettings={() => chooseNotation(true, true)} />
              <button
                className={view === 'source' ? 'v2-seg v2-hide-align is-on' : 'v2-seg v2-hide-align'}
                aria-pressed={view === 'source'}
                onClick={() => switchView('source')}
              >
                源码
              </button>
            </div>

            {/* 深浅主题：月亮一枚，实心 = 深色，线条 = 浅色；CSS 变量与画布配色一起切 */}
            <ThemeToggle dark={dark} onChange={setDark} />
          </div>

          {/* 音轨分离入口已移到顶部工具条（对轨组），波形上方腾出一行竖向空间 */}

          {view === 'score' ? (
            <>
              <PartsPanel score={documentScore} activeId={activePartId} total={totalView} lyricVerse={lyricVerse} onSelectLyrics={selectLyrics} onSelect={selectPart} onTotal={setTotalView} onChange={changeParts} />
              {lyricVerse !== null ? <div className="v2-lyric-tools">
                <strong>{lyricTrackNames(score)[lyricVerse]} · {score.part?.name ?? '声部 1'}</strong>
                <span>{notes ? '中文词句自动分格 · 空格确认 / 补空位 · ← → 移动' : '当前声部没有音符，请结束歌词输入后先写旋律'}</span>
                <button className={`v2-btn${lyricConnection === 'extend' ? ' is-on' : ''}`} aria-pressed={lyricConnection === 'extend'} disabled={!lyricCell} title="选中后续空歌词格，再点延唱（Ctrl+E）" onClick={() => lyricCellId && changeLyricLink(lyricCellId, 'extend')}>延唱</button>
                <button className={`v2-btn${lyricConnection === 'hyphen' ? ' is-on' : ''}`} aria-pressed={lyricConnection === 'hyphen'} disabled={!lyricCell} title="选中前一个音节，再点连字（Ctrl+H）" onClick={() => lyricCellId && changeLyricLink(lyricCellId, 'hyphen')}>连字</button>
                <button className="v2-btn" disabled={!lyricCell} title="只取消本格的连线标记（Ctrl+Shift+E）" onClick={() => lyricCellId && changeLyricLink(lyricCellId, null)}>取消连线</button>
                <button className="v2-btn" onClick={() => setLyricSelection(null)}>结束歌词输入</button>
              </div> : null}
              {mode === 'align' && stems.length > 0 && analyzing ? (
                <div className="v2-align-candidate" role="status" aria-live="polite">
                  <div className="v2-align-candidate-text">
                    <strong>正在识别全曲节拍…</strong>
                    <span>完成后自动更新音频网格与谱面速度。</span>
                  </div>
                </div>
              ) : null}
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
                            ? `${tempoEst && appliedTempoEst === tempoEst ? '已自动识别 · ' : ''}当前网格 ${Math.round(tempoDraft.bpm)} 拍/分 · 已绑定 ${anchors.length} 处 · 点节奏线对齐，拖节奏线整组平移`
                            : '载入伴奏后自动测速 · 点节奏线 → 点谱面小节线完成对齐'}
                  </span>
                  <label className="v2-grace-check v2-align-preview" title="点击波形试听时放几拍就自动停；拍长按当前网格速度计算">
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
                    paused={exportOpen}
                    stems={stems}
                    tempo={audioTempo}
                    dark={dark}
                    gridBpm={tempoDraft.bpm}
                    gridPhase={tempoDraft.phaseSec}
                    gridTimes={tempoDraft.beatTimes}
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
                onClefClick={toggleStaffClef}
                activePartId={activePartId}
                dark={dark}
                unit={EDITOR_UNIT}
                selectedIds={selectedIds}
                cursor={snap.cursor}
                /* 记谱页永远画原谱 → 用原谱口径的时间线（展开视图是播放页的事） */
                timeline={notationTimeline}
                notation={notation}
                staffPitchMode={staffPitchMode}
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
                onEditTitle={() => {
                  if (mode === 'align') switchAlignTab('edit');
                  setLyricSelection(null);
                  setSongInfoOpen(true);
                }}
                onBlankClick={() => setSongInfoOpen(false)}
                lyricEdit={lyricVerse !== null && !playing ? {
                  partId: activePartId, verse: lyricVerse, startId: lyricSelection!.startId ?? overId, session: lyricSelection!.session,
                  onActivate: setLyricCellId, onLink: changeLyricLink,
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
              <button className={`v2-btn${songInfoOpen ? ' is-on' : ''}`} onClick={() => {
                switchAlignTab('edit');
                setLyricSelection(null);
                setSongInfoOpen(true);
              }}>简谱属性</button>
            </div>
          ) : null}
          {showEditBlocks ? (lyricVerse !== null ? <div className="v2-side-block">
            <div className="v2-side-title">歌词输入</div>
            <p className="v2-hint">当前行：{lyricTrackNames(score)[lyricVerse]}<br />关联声部：{score.part?.name ?? '声部 1'}</p>
            <p className="v2-hint">点击任一歌词格或对应音符即可从那里开始，前奏与间奏无需逐个跳过。</p>
            <p className="v2-hint">一次输入中文词句会逐字分到连续音符；新输入单字后按空格确认。回到已有歌词格按空格，会在该字前补一个空位，后续歌词顺延；空白格按空格跳过一音。</p>
            <p className="v2-hint">Tab / Enter / → 前进，Shift+Tab / ← 后退。音符位置不足时会提示，不会截断后续歌词。</p>
            <p className="v2-hint">退格删除选中的字；空白格或字前的光标按退格，删除前一位置（包括空位），后续歌词向前补齐。可以连续退格，也可撤销恢复。</p>
            <p className="v2-hint">一字跨多音：选后续空格点「延唱」（Ctrl+E）；英文音节连接：选前一音节点「连字」（Ctrl+H）。「取消连线」（Ctrl+Shift+E）只清除当前标记。延唱格显示「延」，退格会删除该格；休止会打断连接。</p>
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
                onCommit={(v) => setScore(resplitOversizedGroups(setMeta(score, { beat: v })))}
              />
              <MetaInput
                label="速度"
                type="number"
                value={score.meta.bpm}
                min={20}
                max={300}
                onCommit={(v) => setScore(setMeta(score, { bpm: Number(v) }))}
              />
              <MetaSelect
                label="音色"
                value={String(score.meta.patch)}
                options={[
                  // 0 号被包覆盖（如 GM 包的三角钢琴）时跟包走，不重复列「钢琴（合成）」
                  ...(instrumentPatches().includes(0) ? [] : ['钢琴（合成）']),
                  ...instrumentPatches().map(
                    (p) => `${instrumentLabel(p) ?? p}（真采样 · ${instrumentSource(p)}）`,
                  ),
                ]}
                values={[...(instrumentPatches().includes(0) ? [] : ['0']), ...instrumentPatches().map(String)]}
                onCommit={(v) => setScore(setMeta(score, { patch: Number(v) }))}
              />
              <MetaSelect
                label="音色八度"
                value={String(score.meta.patchOctave ?? 0)}
                options={['不移动', '升高一个八度 ↑8', '降低一个八度 ↓8']}
                values={['0', '1', '-1']}
                onCommit={(v) => setScore(setMeta(score, { patchOctave: Number(v) }))}
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
                value={score.meta.fontSize ?? DEFAULT_FONT_SIZE}
                min={12}
                max={56}
                onCommit={(v) => setScore(setMeta(score, { fontSize: Number(v) }))}
              />
              <MetaInput
                label="字间距"
                type="number"
                value={score.meta.letterSpacing ?? DEFAULT_LETTER_SPACING}
                min={-20}
                max={20}
                onCommit={(v) => setScore(setMeta(score, { letterSpacing: Number(v) }))}
              />
              <MetaInput
                label="行间距"
                type="number"
                value={score.meta.lineGap ?? 0}
                min={0}
                max={48}
                onCommit={(v) => setScore(setMeta(score, { lineGap: Number(v) }))}
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
              调号支持升降号：1=bB、1=#F（♭B / ♯F 也认）。速度单位是 BPM；音色下拉里是
              FluidR3 真采样音色，其余 MIDI 音色号（0–127）暂以钢琴合成音播放。
              字号 / 字间距 / 行间距 / 小节号随文件保存。改完按回车或点别处生效。
            </p>
          </div>

          {/*
            输入板（原浮动输入板并入右栏）：音符录入 / 小节线 / 音符属性一个面板全包。
            点谱面竖线选中它时，整块切换成小节线编辑（与音符编辑互斥）；
            打开曲目信息时让位（is-hidden）。
          */}
          <div className={songInfoOpen ? 'v2-side-block is-hidden' : 'v2-side-block'}>
            <div className="v2-side-title v2-inspector-title">
              <span>
                {barlineFocus
                  ? '输入板 · 小节线'
                  : focus
                    ? `输入板 · 选中 ${eventLabel(focus)}${focusMeasure ? ` · 第 ${focusMeasure} 小节` : ''}`
                    : '输入板'}
              </span>
              {expansion.repeatedSections > 0 && expansion.score ? (
                <span className="v2-title-token" title="反复展开成顺序演奏后的事件数">
                  展开后 {expansion.score.events.filter((e) => e.kind === 'note').length} 音
                </span>
              ) : focus && (focus.kind === 'note' || focus.kind === 'rest') ? (
                <span className="v2-title-token">
                  时值 {durLabel(undotTicks(focus.ticks, focus.dot ?? 0))}
                </span>
              ) : null}
            </div>
            <PadBody
              actions={padActions}
              score={score}
              target={padTarget}
              batchIds={selectedTimedIds}
              onSetScore={setScore}
              onAnnotate={padAnnotate}
              barline={barlineFocus}
              barlineActions={padBarlineActions}
              jumpAfter={jumpAfterFocus}
              playOrder={playOrder}
              canEditConductor={canEditConductor}
              volta={{ ok: canEditConductor && !!selectionVolta.score, error: selectionVolta.error ?? null }}
              doSelectionVolta={doSelectionVolta}
              tiers={tiers}
              groupTargets={groupTargets}
              selectedCount={selectedTimedIds.length}
              pending={
                pending
                  ? {
                      count: pending.ids.length,
                      ticks: pending.ticks,
                      degrees: pending.ids.map((id) => {
                        const e = score.events.find((x) => x.id === id);
                        return e && e.kind === 'note' ? e.degree : 0;
                      }),
                      cands: pending.cands,
                    }
                  : null
              }
            />
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
            {anchors.length > 0 ? (
              <div className="v2-field">
                <span className="v2-field-label">两点节拍自检查</span>
                {anchorChecks.length ? anchorChecks.map((c) => (
                  <p className="v2-hint" key={`${c.from}:${c.to}`}>
                    <span>谱面第 {c.from} → {c.to} 拍：</span><br />
                    <strong>{c.warning ? '⚠ ' : ''}{c.text}</strong>
                  </p>
                )) : <p className="v2-hint">请再绑定一个位置，建议相隔至少 8 拍。</p>}
                {anchorChecks.length ? <p className="v2-hint">检查的是未经锚点拉伸的网格。拍数吻合不代表中间每拍都准确；跨反复或间奏时请分段绑定。</p> : null}
              </div>
            ) : null}
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
                  <span className="v2-title-token">⚠ 谱面长度和音频差 {(spanAudit.ratio * 100).toFixed(0)}%，可能是不完整谱、反复或间奏差异，请试听核对速度</span>
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
                    commitAnchor(quickAnchor.score, quickAnchor.audio, `谱面第 ${quickAnchor.score} 拍`);
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
                  {anchorSpan < 8 ? '，偏近、仅供参考' : ''}）
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
                    title={`候选：${tempoEst.candidates.map((c) => c.bpm.toFixed(1)).join(" / ")} BPM · 拍链支持率 ${(tempoEst.support * 100).toFixed(0)}% · 全部起音峰到恒速网格的 RMS ${tempoEst.residualMs}ms（不是准确率）`}
                  >
                    自动识别 {tempoEst.bpm} 拍/分 ·{' '}
                    {tempoEst.confidence >= 0.5
                      ? '证据较强'
                      : tempoEst.confidence >= 0.25
                        ? '证据一般'
                        : '证据较弱'}
                  </span>
                  {tempoEst.candidates.slice(0, 3).map((c) => <button key={c.bpm} className="v2-btn" disabled={analyzing} onClick={() => void runAutoAlign('', undefined, c.bpm)} title="按这个速度档重新分析并自动应用">试 {c.bpm.toFixed(1)} BPM</button>)}
                  <button
                    className="v2-btn"
                    title="用当前谱面的音符起拍重新搜 BPM / 相位 / 原点（换过谱或上次没对上时点它）"
                    disabled={analyzing}
                    onClick={() => void runAutoAlign()}
                  >
                    重新自动对齐
                  </button>
                </div>
              ) : (
                <p className="v2-hint">{analyzing ? '正在分析全曲节拍…' : '导入伴奏后自动识别并更新速度；也可以打拍定速。'}</p>
              )}
              {spanAudit ? (
                <p className="v2-hint" title={`谱面 ${Math.round(scoreBeats)} 拍 ≈ ${spanAudit.span.toFixed(1)}s；音频从谱面起点算还剩 ${spanAudit.remaining.toFixed(1)}s`}>
                  体检：谱面长度与音频{spanAudit.ratio < 0.7 || spanAudit.ratio > 1.4 ? <b>不一致（可能是不完整谱、反复或间奏差异）</b> : '基本吻合'}
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
                    onChange={(e) => { const bpm = Number(e.target.value); if (bpm > 0) rescaleTempo(bpm / tempoDraft.bpm, '已调整节拍网格速度'); }}
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
                    onChange={(e) => nudgePhase(Number(e.target.value) - tempoDraft.phaseSec)}
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
          dark={dark}
          onDark={setDark}
        />
      ) : null}

      {/* 曲库是顶层界面（不是弹窗）：它管的是一批谱，动作铺得开才好用 */}
      {mode === 'library' ? (
        <LibraryScreen
          onOpen={playLibraryItem}
          onEdit={editLibraryItem}
          // 曲库的通知（导入 / 删除 / 建库）以前只进状态栏，眼睛在列表上时根本看不见；
          // 这些是低频而重要的动作，同时弹一层。成败语义 LibraryScreen 没区分，统一按中性提示
          onNotify={(m) => {
            setMsg(m);
            toastInfo(m);
          }}
          onToast={(kind, text, body, action) => {
            setMsg(text);
            if (kind === 'error') toastFail(text, body, action);
            else if (kind === 'success') toastOk(text, body, action);
            else toastInfo(text, body, action);
          }}
          msg={msg}
          readOnly={entry === 'play'}
          dark={dark}
          onDark={setDark}
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
              <ExpClose onClose={() => setTramaOpen(false)} />
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
        通用提示浮层：绑定成功、保存进度、打包 / 导出、节拍分析、出错提示都走它。
        浮在顶部正中、几秒后自己淡出，点一下也能关。
        不做成带确定按钮的模态框——这些多是连续动作，每次点「确定」会把节奏打断；
        但「成没成 / 正在干什么」必须一眼可见。
      */}
      <ToastView toast={toast} onDismiss={toastHide} />

    </div>
  );
}

/** 比较原始音频网格；不能用已被锚点拉伸的 audioTempo 自证正确。 */
function checkAnchorSpans(anchors: Anchor[], grid: TempoMap) {
  const sorted = [...anchors].sort((a, b) => a.scoreBeat - b.scoreBeat);
  return sorted.slice(1).map((b, i) => {
    const a = sorted[i];
    const scoreSpan = b.scoreBeat - a.scoreBeat;
    const audioSpan = b.audioBeat - a.audioBeat;
    const seconds = beatToSec(grid, b.audioBeat) - beatToSec(grid, a.audioBeat);
    const valid = scoreSpan > 0 && audioSpan > 0 && seconds > 0
      && [scoreSpan, audioSpan, seconds].every(Number.isFinite);
    const ratio = audioSpan / scoreSpan;
    const delta = audioSpan - scoreSpan;
    const close = valid && Math.abs(delta) <= Math.max(0.25, scoreSpan * 0.05);
    const verdict = !valid ? '点位顺序或数值异常，请重新绑定'
      : scoreSpan < 4 ? '跨度太短，请再绑一个更远的点'
      : close ? '这段拍数基本吻合'
      : Math.abs(ratio - 2) < 0.15 ? '疑似网格速度翻倍'
      : Math.abs(ratio - 0.5) < 0.075 ? '疑似网格速度减半'
      : '拍数不一致，请核对网格、点位及间奏/反复';
    const text = valid
      ? `谱面 ${Number(scoreSpan.toFixed(2))} 拍 / 网格 ${Number(audioSpan.toFixed(2))} 拍 · 差 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} 拍 · 耗时 ${seconds.toFixed(2)} 秒 · 实测 ${(scoreSpan * 60 / seconds).toFixed(2)} BPM · ${verdict}`
      : verdict;
    return { from: a.scoreBeat, to: b.scoreBeat, warning: !valid || !close || scoreSpan < 4, text };
  });
}

/** 谱面总拍数（含休止符），用于长度诊断，不能单独据此裁定速度档。 */
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
  values,
  onCommit,
}: {
  label: string;
  value: string;
  options: string[];
  /** 与 options 一一对应的提交值；缺省 = 值与标签相同（调号这类文本选项） */
  values?: string[];
  onCommit: (v: string) => void;
}) {
  const external = String(value);
  const valList = values ?? options;
  const has = valList.includes(external);
  const opts = has ? options : [external, ...options];
  const vals = has ? valList : [external, ...valList];
  return (
    <label className="v2-meta-row">
      <span className="v2-meta-label">{label}</span>
      <select
        className="v2-meta-input"
        value={external}
        onChange={(e) => onCommit(e.target.value)}
      >
        {opts.map((o, i) => (
          <option key={vals[i] ?? o} value={vals[i] ?? o}>
            {o}
          </option>
        ))}
      </select>
    </label>
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
      if (e.repeat === 'both') return '双向反复 :||:';
      if (e.repeat === 'end') return `反复结束 :|${e.times && e.times > 2 ? e.times : ''}`;
      if (e.volta) return `跳房子 [${e.volta.join(',')}]`;
      return e.style === 'final' ? '终止线 ||' : e.style === 'double' ? '双细线 ‖' : e.partial ? '弱起小节线' : '小节线';
    }
    case 'jump':
      return '跳转记号';
    case 'directive':
      return `指示 ${e.value}`;
    default:
      return '记号';
  }
}

/**
 * 节拍器按钮：播放页 / 记谱页 / 动态谱生成页共用一个。
 *
 * 「什么时候出现」由 metronomeAvailable 决定（只在合成音场景）。
 * 左半是**开关**：按下开、再按关，开着时点亮；右半的 ⌄ 只负责
 * 弹出配置窗（节奏型 / 音量）——「开不开」与「怎么配」分开。
 */
function MetronomeButton({ on, onToggle, onOpen }: { on: boolean; onToggle: () => void; onOpen: () => void }) {
  return (
    <div className="v2-split-choice">
      <button
        className={on ? 'v2-seg is-on' : 'v2-seg'}
        aria-pressed={on}
        onClick={onToggle}
        title={on ? '节拍器：开着，点一下关闭' : '节拍器：点一下开始跟着谱面打拍'}
      >
        节拍器
      </button>
      <button
        className="v2-seg v2-split-caret"
        aria-haspopup="dialog"
        aria-label="节拍器设置"
        onClick={onOpen}
        title="节拍器设置：节奏型 / 音量"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </div>
  );
}

function StaffViewButton({ active, onSelect, onSettings }: { active: boolean; onSelect: () => void; onSettings: () => void }) {  return <div className={active ? 'v2-staff-choice is-on' : 'v2-staff-choice'}>
    <button className="v2-seg" aria-pressed={active} onClick={onSelect}>五线谱</button>
    <button className="v2-seg v2-staff-gear" aria-label="五线谱设置" aria-haspopup="dialog" onClick={onSettings} title="五线谱设置：实音／移调、记谱乐器、谱号">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9.5 2h5l.6 2.5 1.8 1 2.5-.7 2.5 4.4-1.9 1.8v2l1.9 1.8-2.5 4.4-2.5-.7-1.8 1-.6 2.5h-5l-.6-2.5-1.8-1-2.5.7-2.5-4.4L4 13v-2L2.1 9.2l2.5-4.4 2.5.7 1.8-1z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  </div>;
}

function StaffSettingsDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => {
      el.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="v2-exp v2-part-dialog v2-staff-dialog" aria-label="五线谱设置"
    onKeyDown={e => e.stopPropagation()}
    onCancel={e => { e.preventDefault(); onClose(); }}
    onClick={e => {
      if (e.target !== e.currentTarget) return;
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) onClose();
    }}>
    <div className="v2-exp-head"><strong>五线谱设置</strong><ExpClose onClose={onClose} title="完成并关闭" /></div>
    {children}
  </dialog>;
}

function trimTick(tick: number): string {
  const beats = tick / TICKS_PER_BEAT;
  return Number.isInteger(beats) ? String(beats) : beats.toFixed(1);
}

function emptyScore(): Score {
  return {
    version: 2,
    format: 3,
    // 新谱默认字号 24、字间距 -10（用户 2026-10-23 定）。可调范围见 setMeta 校验。
    meta: {
      title: '未命名曲谱',
      key: '1=C',
      beat: '4/4',
      bpm: 90,
      // 与 DEFAULT_META 一致：没指定音色就是钢琴
      patch: 0,
      fontSize: DEFAULT_FONT_SIZE,
      letterSpacing: DEFAULT_LETTER_SPACING,
    },
    events: [],
    groups: [],
  };
}
