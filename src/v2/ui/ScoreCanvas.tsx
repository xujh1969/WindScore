import { buildBallTrack, sampleBallTrail, type BallDraw } from '../ball';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BeatClock } from '../clock';
import {
  SCORE_START_ID,
  caretAt,
  hitScoreStart,
  hitTitleEdit,
  layoutScore,
  pickAt,
  pickCueAt,
  type LayoutPick,
  type LayoutResult,
  type LayoutOptions,
} from '../layout';
import { DARK_THEME, LIGHT_THEME, drawPlayBall, paintLayout, type PlayStyle } from '../paint';
import { buildStaffLayout, type StaffLayout } from '../staff';
import { paintStaffLayout } from '../staffPaint';
import { withStaffRows } from '../staffSpacing';
import type { StaffPitchMode, StaffClef } from '../pitch';
import { TICKS_PER_BEAT, PX_PER_BEAT_DEFAULT } from '../ticks';
import { activeHeadsAt, activeMainAt, playheadIdCandidates, timelineTicks, type TimelineEntry } from '../timeline';
import { DEFAULT_FONT_SIZE, measureNumberMode, type MeasureNumberMode, type Score, type LyricLink } from '../types';
import { partScore } from '../parts';
import { LyricCell } from './LyricCell';
import { lyricTrackNames } from '../lyrics';
import { noteDigitCenter } from '../layout';
import { NOTATION_TEXT_FAMILY, notationLyricFontSize, notationDigitInkHeight } from '../notationFont';
import { hitStaffClef } from '../staffSystems';
import { edgeScrollTop, eventScrollTop, type ScrollRequest } from './scoreScroll';
import { CARET_BLINK_MS, caretBlinkActive } from './caretBlink';

/** 一次命中的结果，判定逻辑在 layout.pickAt（纯几何，可单测） */
export type ScorePick = LayoutPick;

interface Props {
  score: Score;
  activePartId?: string;
  dark: boolean;
  /** 每 tick 像素宽，即字间距倍率 */
  unit?: number;
  /** 字号覆盖（px）：播放页的观看偏好，不给 = 跟随谱面 */
  fontSize?: number;
  /** 字间距覆盖（px）：同上 */
  letterSpacing?: number;
  /** 行间距覆盖（px，行高增量）：同上 */
  lineGap?: number;
  /** 小节号显示模式覆盖（播放页观看偏好），不给 = 跟随谱面 */
  measureNumbers?: MeasureNumberMode;
  /** 安卓阅读按屏宽重排，窄屏简化谱头并保留谱号空间。 */
  responsive?: boolean;
  /** 行宽撑满（justify）：尊重「换行」标记为行界，行内两端对齐铺满画布宽（OCR 对照页用）。
   *  默认 false = 自动折行模式（fitWidth:true，忽略换行标记）。 */
  fitRows?: boolean;
  /** 不画谱头（小字谱录入预览）：调号 / 拍号跟随主谱，不重复显示 */
  headerless?: boolean;
  selectedIds: ReadonlySet<string>;
  /** 光标：插入位置（0 .. events.length） */
  cursor: number;
  timeline: TimelineEntry[];
  /** 方块光标：整块点亮这个音（替换态）。与 I 形插入符互斥 */
  focusId?: string | null;
  /** 是否画 I 形插入符。over 模式下只画方块，不画竖线 */
  showCaret?: boolean;
  showBreaks?: boolean;
  /**
   * 键盘定位（跳小节 / 跳首尾）时把视口一起带过去。seq 变化才算一次新请求
   * （连按同一个快捷键也必须重新滚，不能只靠目标去重）。
   */
  scrollRequest?: ScrollRequest | null;
  onLayout?: (layout: LayoutResult, options: LayoutOptions) => void;
  /** 播放指示方式：head = 色块+竖线；band = 高亮条；ball = 跳跃光球 */
  playStyle?: PlayStyle;
  /**
   * 记谱法：jianpu = 简谱（缺省，原有行为）；
   * staff = 五线谱（实验功能，由 experimental.ts 的开关打开才传进来）。
   */
  notation?: 'jianpu' | 'staff';
  staffPitchMode?: StaffPitchMode;
  playing: boolean;
  clock: BeatClock;
  /** 对轨配对中：波形上点一下就是「把这根小节线绑到这一刻」 */
  pairing?: boolean;
  /** 对轨里点中谱面元素时回调（用来切到绑定模式） */
  onPickStart?: () => void;
  /** 音频模式：按 tempo 标定反查当前 tick（没有 clock 时靠它） */
  getPlayTick?: () => number | null;
  /**
   * 鼠标选中。a 是按下的位置，b 是拖到的位置（null = 还没拖动）。
   * 两端同一个事件 = 单击，只放光标；不同事件 = 拖拉建选区。
   */
  onPick: (a: ScorePick, b: ScorePick | null) => void;
  onEnded: () => void;
  /** 点击标题旁的小铅笔：打开曲目信息编辑 */
  onEditTitle?: () => void;
  onClefClick?: (partId: string, current: StaffClef) => void;
  /**点在谱面空白处（没命中任何音符 / 小节线）：用来退出曲目信息编辑 */
  onBlankClick?: () => void;
  /** 双击小字谱：把该条小字谱的 id 交给上层打开编辑弹窗（OCR 产物是文本锚，也能编辑） */
  onCueDoubleClick?: (cueId: string) => void;
  lyricEdit?: { partId: string; verse: number; startId?: string | null; session: number; onActivate: (id: string) => void; onLink: (id: string, link: LyricLink | null, word?: string) => boolean; onCommit: (id: string, word: string) => boolean; onInsertGap: (id: string) => boolean; onDelete: (id: string, offset: number) => boolean; onExit: () => void };
}

type Playhead = { eventId: string; frac: number } | null;

/**
 * Canvas 视图。
 * - 命中测试与拖选都走 layout 的 hitIndex 反查（§7.1）
 * - 播放时的重绘走 rAF 直接画，不经过 React state，避免每帧渲染整棵树
 */
export function ScoreCanvas({
  score,
  activePartId,
  dark,
  unit,
  fontSize,
  letterSpacing,
  lineGap,
  measureNumbers,
  responsive = false,
  fitRows = false,
  headerless = false,
  selectedIds,
  cursor,
  timeline,
  focusId,
  showCaret,
  showBreaks = false,
  scrollRequest = null,
  onLayout,
  pairing = false,
  onPickStart,
  playStyle = 'head',
  notation = 'jianpu',
  staffPitchMode = 'concert',
  playing,
  clock,
  getPlayTick,
  onPick,
  onEnded,
  onEditTitle,
  onClefClick,
  onBlankClick,
  onCueDoubleClick,
  lyricEdit,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const ballCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasOrigin = useRef(0);
  const layoutRef = useRef<LayoutResult | null>(null);
  /** 五线谱排版（实验功能）：只在 notation === 'staff' 时才建、才用 */
  const staffRef = useRef<StaffLayout | null>(null);
  const staffBallPositionsRef = useRef<Map<string, { x: number; y: number }> | undefined>(undefined);
  const staffErrorRef = useRef('');
  const [lyricLayout, setLyricLayout] = useState<LayoutResult | null>(null);
  const lyricInputs = useRef(new Map<string, HTMLInputElement>());
  const lyricFocusKey = useRef('');
  const paintRef = useRef<(head: Playhead) => void>(() => {});
  const headsRef = useRef<{ eventId: string; frac: number }[]>([]);
  /** 播放光球（playStyle='ball' 时）：当前帧位置 + 拖尾；停止 / 非该模式时为 null */
  const ballRef = useRef<BallDraw | null>(null);
  const trailRef = useRef<{ x: number; y: number }[]>([]);
  const lastBallTickRef = useRef<number | null>(null);
  /** 尾音余跳续跑的代次：effect 重跑（重新起播 / 换谱）时作废旧的续跑循环 */
  const ballFadeGen = useRef(0);
  const playStyleRef = useRef(playStyle);
  playStyleRef.current = playStyle;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const [dragFrom, setDragFrom] = useState<ScorePick | null>(null);
  /** Shift 扩选的锚点：记住上一次普通点击的位置，Shift+点击选中两者之间 */
  const anchorRef = useRef<ScorePick | null>(null);

  /** 屏幕坐标 → 画布内坐标 */
  const toLocal = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top + canvasOrigin.current };
  }, []);

  /** 屏幕坐标 → 命中结果（判定逻辑在 layout.pickAt） */
  const pickPointer = useCallback(
    (clientX: number, clientY: number): ScorePick | null => {
      const layout = layoutRef.current;
      const p = toLocal(clientX, clientY);
      if (!layout || !p) return null;
      const staff = staffRef.current;
      if (staff) {
        let nearest: { index: number; partId?: string; distance: number } | undefined;
        for (const [li, line] of staff.lines.entries()) for (const s of line.symbols) {
          if ((s.kind !== 'note' && s.kind !== 'rest') || s.hidden) continue;
          const dx = Math.abs(p.x - s.x), dy = Math.abs(p.y - s.y);
          if (dx > Math.max(8, staff.sp) || dy > Math.max(8, staff.sp)) continue;
          const item = layout.lines[li].items.find(it => it.eventId === s.eventId);
          if (!item) continue;
          const distance = dx * dx + dy * dy;
          if (!nearest || distance < nearest.distance) nearest = { index: item.eventIndex, partId: line.partId, distance };
        }
        if (nearest) return { index: nearest.index, cursor: nearest.index + 1, mode: 'over', partId: nearest.partId };
        for (const [li, line] of staff.lines.entries()) for (const group of line.graces) {
          if (!group.notes.some(n => Math.abs(p.x - n.x) <= Math.max(6, staff.sp * .7) && Math.abs(p.y - n.y) <= Math.max(6, staff.sp * .7))) continue;
          const host = layout.lines[li].items.find(it => it.eventId === group.hostId);
          if (host) return { index: host.eventIndex, cursor: host.eventIndex + 1, mode: 'over', partId: line.partId };
        }
      }
      return pickAt(layout, p.x, p.y);
    },
    [toLocal],
  );

  /** 鼠标是否压在标题旁的小铅笔上（判定在 layout.hitTitleEdit） */
  const overPencil = useCallback(
    (clientX: number, clientY: number): boolean => {
      const layout = layoutRef.current;
      const p = toLocal(clientX, clientY);
      return !!onEditTitle && !!layout && !!p && hitTitleEdit(layout, p.x, p.y);
    },
    [toLocal, onEditTitle],
  );
  const clefAtPointer = (clientX: number, clientY: number) => {
    const point = toLocal(clientX, clientY);
    return onClefClick && !lyricEdit && !pairing && staffRef.current && point ? hitStaffClef(staffRef.current, point.x, point.y) : null;
  };

  // 谱面 / 选区 / 尺寸变化 → 重排并重绘
  /** 最近一帧的播放头：悬停重绘时照原样传回去，别把指示条画没了 */
  const headRef = useRef<Playhead>(null);
  /** 插入点闪烁的当前相位：true = 画 I 形光标。闪烁只切这一位，不重排。 */
  const caretBlinkRef = useRef(true);
/** KTV 式入拍提醒：前奏期间（播放 tick 为负）在第一个音上闪烁 + 倒数 */
const cueRef = useRef<{ eventId: string; beatsLeft: number; pulse: number } | null>(null);
  /** 配对态悬停的小节线 id：拖到别的线上要立刻换靶标 */
  const hoverBarRef = useRef<string | null>(null);
  /** pairing 的最新值：画布事件回调里要用，又不能把它塞进依赖 */
  const pairingRef = useRef(pairing);
  pairingRef.current = pairing;
  /**
   * 播放时是否自动把谱面滚到当前行。**用户手动滚过就交还控制权**，
   * 本次播放期间不再自动跟随（再按一次播放才恢复）。
   */
  const followRef = useRef(true);
  /**
   * 用户滚动意图：**用输入事件判定，不用 scroll 事件**。
   * scroll 事件没法区分「程序写的」和「用户写的」——跟随循环每帧都写
   * scrollTop，浏览器补发的那次永远落在时间窗内，于是向上滚一直被拽回去
   * （曲库页与播放页都滚不动）。输入事件没有歧义：滚轮 / 触摸 / 方向键 /
   * 拖滚动条（点在画布右侧那一列）都算「用户要自己看」。
   */
  /** 编辑态光标跟随的平滑滚动 rAF：用户自己滚 / 键盘导航 / 起播时都要撤掉 */
  const caretScrollRaf = useRef<number | null>(null);
  const cancelCaretScroll = useCallback((): void => {
    if (caretScrollRaf.current != null) {
      cancelAnimationFrame(caretScrollRaf.current);
      caretScrollRaf.current = null;
    }
  }, []);
  const markManualScroll = (): void => {
    followRef.current = false;
    cancelCaretScroll();
  };
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const theme = dark ? DARK_THEME : LIGHT_THEME;
    // 播放页的小节号观看偏好优先于谱面设置；五线谱排版留带也按同一模式算
    const mnMode = measureNumbers ?? measureNumberMode(score.meta);

    // .v2-scroll 用 scrollbar-gutter: stable 预留滚动条槽，clientWidth 不再随
    // 纵向滚动条显隐改变。排版与绘制共用实际可见宽度，保留完整的右侧页边距。
    const boxWidth = () => Math.max(1, wrap.clientWidth);
    const boxHeight = () => Math.max(1, wrap.getBoundingClientRect().height - 2);
    let staticBallReady = false;
    let staticOrigin = -1;

    const paint = (head: Playhead) => {
      const layout = layoutRef.current;
      if (!layout) return;
      headRef.current = head;
      const currentStyle = playStyleRef.current;
      const w = boxWidth();
      const h = Math.max(boxHeight(), layout.height + 32);
      // 安卓只分配一个视口加缓冲区的位图；长谱/大字号不再生成数万像素高的纹理。
      const viewHeight = responsive ? Math.min(h, boxHeight() + 256) : h;
      const dpr = responsive ? Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(w, viewHeight)) : window.devicePixelRatio || 1;
      const paddingTop = responsive ? parseFloat(getComputedStyle(wrap).paddingTop) || 0 : 0;
      const origin = responsive ? Math.max(0, Math.min(h - viewHeight, Math.floor((wrap.scrollTop - paddingTop - 64) / 128) * 128)) : 0;
      canvasOrigin.current = origin;
      if (responsive && surfaceRef.current) {
        surfaceRef.current.style.height = `${h}px`;
        canvas.style.position = 'absolute'; canvas.style.top = `${origin}px`;
      }
      const cw = Math.max(1, Math.floor(w * dpr));
      const ch = Math.max(1, Math.floor(viewHeight * dpr));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${viewHeight}px`;
        staticBallReady = false;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, -origin * dpr);
      const overlay = ballCanvasRef.current;
      const ballCtx = overlay?.getContext('2d');
      const cachedBall = responsive && currentStyle === 'ball' && !staffErrorRef.current && !cueRef.current && !!ballCtx;
      if (overlay && ballCtx) {
        if (overlay.width !== cw || overlay.height !== ch) { overlay.width = cw; overlay.height = ch; }
        overlay.style.top = `${origin}px`; overlay.style.width = `${w}px`; overlay.style.height = `${viewHeight}px`;
        ballCtx.setTransform(1, 0, 0, 1, 0, 0); ballCtx.clearRect(0, 0, cw, ch);
        if (cachedBall && ballRef.current) {
          ballCtx.setTransform(dpr, 0, 0, dpr, 0, -origin * dpr);
          drawPlayBall(ballCtx, ballRef.current, theme);
        }
      }
      if (cachedBall && staticBallReady && staticOrigin === origin) return;
      staticBallReady = cachedBall; staticOrigin = origin;
      const displayHead = cachedBall ? null : head;
      // 五线谱（实验功能）：独立的一条绘制路径；开关关着时这里永远不成立，
      // 走的就是原来那份 paintLayout，现有行为不受影响
      const staff = staffRef.current;
      if (staffErrorRef.current) {
        ctx.fillStyle = theme.bg;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = theme.ink;
        ctx.font = '16px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(staffErrorRef.current, 24, 40);
        return;
      }
      if (staff) {
        paintStaffLayout(ctx, staff, theme, {
          playhead: displayHead,
          playheads: displayHead ? headsRef.current : [],
          focusId,
          selectedIds,
          height: h,
          playStyle: currentStyle,
          ball: currentStyle === 'ball' && !cachedBall ? ballRef.current : null,
          showTitleEdit: !!onEditTitle,
          showMeasureNumbers: mnMode,
        });
        return;
      }
      paintLayout(ctx, layout, theme, {
        showTitleEdit: !!onEditTitle,
        // 交互页常驻画小字谱锚点三角；导出（export/render.ts）不传这个开关，不带辅助记号
        showCueAnchors: true,
        selectedIds,
        // 闪烁相位只决定插入符画不画；停用时常亮，定位点不会消失
        caret: showCaret === false || !caretBlinkRef.current ? null : caretAt(activePartId && layout.systems ? { ...layout, lines: layout.lines.filter((line) => line.partId === activePartId) } : layout, cursor),
        playhead: displayHead,
        playheads: displayHead ? headsRef.current : [],
        cue: cueRef.current,
        focusId,
        playStyle: currentStyle,
        ball: currentStyle === 'ball' && !cachedBall ? ballRef.current : null,
        showMeasureNumbers: mnMode,
        showBreaks,
        height: h,
        ...(pairingRef.current
          ? {
              pairing: true,
              pairingHoverId: hoverBarRef.current ?? null,
              // 开头本来就有小节线时不画虚拟靶标（那根线已经在第 0 拍上）
              pairingStart: score.events[0]?.kind !== 'barline',
            }
          : {}),
      });
    };

    const relayout = () => {
      staticBallReady = false;
      const options = { contentWidth: boxWidth(), unit, fontSize, letterSpacing, lineGap,
        // headerless（小字谱录入预览）：不画谱头——调号/拍号跟随主谱，重复写没意义
        ...(headerless ? { showTitle: false } : {}),
        // fitRows（OCR 对照页）独立于 responsive 生效：尊重「换行」为行界；
        // justify **弹性展开**铺满栏宽（上限放宽到 6，仅防病态短行拉成天价间距）
        // ——左右两缘与原谱逐行对齐，方便核对（用户 2026-11-06：不足的行要
        // 弹性展开、不能死守最小间距；最小密度由下面的两段收缩负责）
        ...(fitRows ? { fitWidth: false, rightPadding: 20, justify: true, justifyMax: 6 }
          : responsive ? { fitWidth: true, rightPadding: 20 } : {}),
        ...(notation === 'staff' ? {
          staffPitchMode,
          padding: 96 * (fontSize ?? score.meta.fontSize ?? DEFAULT_FONT_SIZE) / 21,
          staffKeySpace: 104 * (fontSize ?? score.meta.fontSize ?? DEFAULT_FONT_SIZE) / 21,
        } : {}) };
      const displayScore = responsive && boxWidth() < 560 ? { ...score, meta: { ...score.meta, sub: '', notes: [] } } : score;
      // 五线谱排版按小节号模式决定要不要留那条带，所以观看偏好要灌进排版输入
      // （只改这份临时副本，原谱 / 谱面文件不变）
      const layoutInput = { ...displayScore, meta: { ...displayScore.meta, measureNumbers: mnMode } };
      // OCR 对照页紧凑排版：原谱一行 = 预览一个系统块。先按超宽画布探测每个
      // 「换行」组的自然宽度，最宽一行放不进栏宽就**先收紧拍距**（字号不动，
      // 间距变小——用户 2026-11-06：间距尽可能小、字体尽量别太小）；拍距触底
      // （0.25×）后仍放不下的超密行再缩显示字号（下限 10px）——此时格子宽度
      // 的主体是字形最小格宽，只有缩字号才有效。都触底还放不下才照旧折行。
      let effOptions = options;
      if (fitRows) {
        const box = boxWidth();
        const baseFont = fontSize ?? score.meta.fontSize ?? DEFAULT_FONT_SIZE;
        const baseUnit = unit ?? PX_PER_BEAT_DEFAULT / TICKS_PER_BEAT;
        const probe = { ...options, contentWidth: 100000, justify: false };
        let effUnit = baseUnit;
        let effFont = baseFont;
        // 净空隙口径下自然宽有字形下限：unit 再收也压不动时，继续收 unit 只是
        // 白耗轮次，必须立刻转去缩字号，否则窄栏会多折出一个系统。
        let prevNatural = Infinity;
        for (let i = 0; i < 20; i += 1) {
          const natural = layoutScore(displayScore, { ...probe, unit: effUnit, fontSize: effFont }).naturalWidth;
          if (natural <= box) break;
          const improved = natural < prevNatural * 0.995;
          prevNatural = natural;
          const nextUnit = Math.max(baseUnit * 0.12, effUnit * (box / natural));
          if (improved && nextUnit < effUnit * 0.999) { effUnit = nextUnit; continue; }
          if (effFont > 10) { effFont = Math.max(10, effFont - 1); prevNatural = Infinity; continue; }
          break;
        }
        if (effUnit !== baseUnit || effFont !== baseFont) effOptions = { ...options, unit: effUnit, fontSize: effFont };
      }
      let layout = layoutScore(layoutInput, effOptions);
      if (responsive && layout.title) layout = { ...layout, title: { ...layout.title, leftX: 20, rightX: boxWidth() - 20 } };
      staffErrorRef.current = '';
      staffRef.current = null;
      staffBallPositionsRef.current = undefined;
      if (notation === 'staff') {
        try {
          staffRef.current = buildStaffLayout(layoutInput, layout, staffPitchMode);
          layout = withStaffRows(layout, staffRef.current);
          const staff = staffRef.current;
          const k = staff.glyph.fontSize / 21;
          const positions = new Map<string, { x: number; y: number }>();
          for (const line of staff.lines) {
            if (activePartId && line.partId && line.partId !== activePartId) continue;
            for (const s of line.symbols) if ((s.kind === 'note' || s.kind === 'rest') && !s.hidden) {
              positions.set(s.eventId, { x: s.x, y: s.y - staff.sp * 0.36 - (3.7 + 3) * k });
            }
          }
          staffBallPositionsRef.current = positions;
        }
        catch (e) { staffErrorRef.current = e instanceof Error ? e.message : String(e); }
      }
      layoutRef.current = layout;
      onLayout?.(layout, options);
      setLyricLayout(layout);
      paint(playingRef.current ? headRef.current : null);
    };

    paintRef.current = paint;
    relayout();

    // RO 回调里**同步** relayout 会在同一帧内又改变布局（React 状态提交、
    // surface 高度写入都会跟着变），浏览器检测到尺寸通知投递不完就抛
    // 「ResizeObserver loop completed with undelivered notifications」。
    // 挪进 rAF 去重调度：回调只排帧、不写布局，写入发生在渲染帧开头，
    // 新的尺寸变化下一帧正常投递，不再构成回调栈内的循环
    // ——与曲库页虚拟列表（AndroidSongList）同一模式，那边从不抛这个错
    let roFrame = 0;
    const ro = new ResizeObserver(() => {
      if (roFrame) return;
      roFrame = requestAnimationFrame(() => { roFrame = 0; relayout(); });
    });
    ro.observe(wrap);
    const repaintScroll = () => { if (responsive) paint(playingRef.current ? headRef.current : null); };
    wrap.addEventListener('scroll', repaintScroll, { passive: true });
    return () => {
      if (roFrame) cancelAnimationFrame(roFrame);
      ro.disconnect();
      wrap.removeEventListener('scroll', repaintScroll);
    };
    // showCaret 也必须进依赖：否则光标在方块态切到插入态时，
    // 若其余输入没变（cursor / focusId 恰好相同），画布不会重绘
  }, [score, dark, unit, fontSize, letterSpacing, lineGap, measureNumbers, responsive, fitRows, headerless, selectedIds, cursor, focusId, showCaret, showBreaks, notation, staffPitchMode, activePartId, onLayout]);

  /**
   * 插入点闪烁：只切「画不画那根 I 形竖线」，不重排。每次光标移动 / 主题切换
   * 都重启计时，保证刚打完字光标立刻是亮的；停用时恢复常亮，别让定位标记消失。
   * 五线谱路径本来就不画插入符，那里不起定时器。
   */
  useEffect(() => {
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const blink = notation !== 'staff' && caretBlinkActive(showCaret, playing, !!lyricEdit, reduced, document.hidden);
    if (!blink) {
      if (!caretBlinkRef.current) {
        caretBlinkRef.current = true;
        paintRef.current(headRef.current);
      }
      return;
    }
    caretBlinkRef.current = true;
    let on = true;
    const id = window.setInterval(() => {
      if (document.hidden) return; // 后台标签页不空转重绘
      on = !on;
      caretBlinkRef.current = on;
      paintRef.current(headRef.current);
    }, CARET_BLINK_MS);
    return () => {
      window.clearInterval(id);
      if (!caretBlinkRef.current) {
        caretBlinkRef.current = true;
        paintRef.current(headRef.current);
      }
    };
  }, [showCaret, playing, lyricEdit, cursor, focusId, score, dark, notation]);

  // 切换动效只重绘，不重排整首谱，也不重启播放循环或触发尾音余跳。
  useEffect(() => {
    ++ballFadeGen.current;
    ballRef.current = null;
    trailRef.current.length = 0;
    lastBallTickRef.current = null;
    paintRef.current(headRef.current);
  }, [playStyle]);

  const lastEditPosition = useRef('');
  /** 已消费的点击时间戳：同一位置点第二次也要重播，不能只按谱面状态去重 */
  const lastHandledPointerAt = useRef(0);
  /** 上一次插入点的滚动内容坐标：自动换行 / 跨连谱系统时画「光标移动」引导 */
  const lastCaretPoint = useRef<{ x: number; y: number } | null>(null);
  /** 最近一次按下的屏幕坐标 + 时刻：点击导致的光标跳跃，动画从点击处起步 */
  const lastPointer = useRef<{ cx: number; cy: number; at: number } | null>(null);
  const caretGhostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => cancelCaretScroll(), [cancelCaretScroll]);

  /** 编辑态滚动跟随：与「移动光标」动画同节奏（约 0.7s ease-out）平滑过去 */
  const animateCaretScroll = useCallback((wrap: HTMLElement, top: number, left: number, smooth: boolean) => {
    cancelCaretScroll();
    if (!smooth) { wrap.scrollTop = top; wrap.scrollLeft = left; return; }
    const fromTop = wrap.scrollTop, fromLeft = wrap.scrollLeft, t0 = performance.now();
    const step = () => {
      // 不读 rAF 回调的时间戳：某些宿主（混合 WebView / 测试环境）它的时间源
      // 与 performance.now() 不一致，相减会得负数 → 滚动量反而飞到负几十万。
      // 统一时钟 + 钳到 [0,1]，任何宿主都只往前滚
      const p = Math.max(0, Math.min(1, (performance.now() - t0) / 700));
      const e = 1 - (1 - p) ** 3;
      wrap.scrollTop = fromTop + (top - fromTop) * e;
      wrap.scrollLeft = fromLeft + (left - fromLeft) * e;
      caretScrollRaf.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    caretScrollRaf.current = requestAnimationFrame(step);
  }, [cancelCaretScroll]);

  useEffect(() => {
    // 离开编辑态（播放 / 歌词编辑 / 切页）时清掉旧位置，回来别误播动画
    if ((!showBreaks && !showCaret) || playing || lyricEdit) {
      lastCaretPoint.current = null;
      lastEditPosition.current = '';
      cancelCaretScroll();
      return;
    }
    // 拖拽框选这一帧先让过去，但**绝不清旧插入点、也不落地 key**：
    // 每次点击都会先 setDragFrom，mouseup 才清；若在这里清掉旧位置，
    // mouseup 后就判不出「跨行跳跃」，动画永远不会出现（用户实测）
    if (dragFrom) return;
    // 不再要求焦点在画布上：整小节粘贴 / 点过工具栏后照样要跟住光标
    // key 只对「同一份谱面状态」去重；**新点击必须能穿透它**：
    // 点同一位置第二次时 cursor / focusId / events 全不变，旧实现整段 return，
    // 用户把视口滚回去再点同一处就再没有动画与跟随（实测反馈）。
    // 注意：点击与上层回灌 cursor 可能分两帧到达，所以点击只在动画真正
    // 播出去之后才算「已消费」，中间那一帧不能把它吃掉。
    const ptr = lastPointer.current;
    const freshClick = !!ptr && ptr.at !== lastHandledPointerAt.current && performance.now() - ptr.at < 2500;
    const key = `${activePartId}:${cursor}:${focusId ?? ''}:${score.events.length}`;
    if (lastEditPosition.current === key && !freshClick) return;
    lastEditPosition.current = key;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!wrap || !canvas || !layout) return;
    const editable = activePartId && layout.systems ? { ...layout, lines: layout.lines.filter((line) => line.partId === activePartId) } : layout;
    const focusedLine = focusId ? editable.lines.find((line) => line.items.some((it) => it.eventId === focusId)) : undefined;
    const focused = focusedLine?.items.find((it) => it.eventId === focusId);
    const point = focused && focusedLine ? { x: focused.x + focused.w / 2, y: focusedLine.y } : caretAt(editable, cursor);
    if (!point) return;
    const canvasBox = canvas.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    // x / y 是「滚动内容坐标」
    const x = point.x + canvasBox.left - wrapBox.left + wrap.scrollLeft;
    const y = point.y - canvasOrigin.current + canvasBox.top - wrapBox.top + wrap.scrollTop;
    const prev = lastCaretPoint.current;
    lastCaretPoint.current = { x, y };
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 跨行 / 跨连谱系统（Δy 超过半行）才算「跳」；方块态选中也算，不再限定插入态
    const jumped = !!prev && Math.abs(y - prev.y) > 40;
    // 起点（本次点击处 / 旧插入点）与当前光标在**此刻视口**的屏幕位置
    const nowX = x - wrap.scrollLeft + wrapBox.left;
    const nowY = y - wrap.scrollTop + wrapBox.top;
    const fromX = freshClick ? ptr!.cx : (prev ? prev.x - wrap.scrollLeft + wrapBox.left : nowX);
    const fromY = freshClick ? ptr!.cy : (prev ? prev.y - wrap.scrollTop + wrapBox.top : nowY);
    // 键盘换行看「光标自身跨行」；点击看「点击处→光标」是否明显分开。
    // 后者让同一位置再点一次也能重播，不依赖光标本身有没有移动。
    const guide = jumped || (freshClick && Math.hypot(nowX - fromX, nowY - fromY) > 40);
    const pad = 48;
    let top = wrap.scrollTop, left = wrap.scrollLeft;
    // 用户把视口滚回去后光标已被推出视口，再次明确点击也要居中跟随
    const offscreen = y - pad < top || y + pad > top + wrap.clientHeight
      || x - pad < left || x + pad > left + wrap.clientWidth;
    const centerFollow = jumped || (freshClick && guide && offscreen);
    if (centerFollow) {
      // 多声部按整个系统块居中，别把同一系统里其它声部切出视口
      const lineIdx = layout.lines.findIndex((ln) => Math.abs(ln.y - point.y) < 2);
      const sys = lineIdx >= 0 ? layout.systems?.find((s) => lineIdx >= s.from && lineIdx < s.to) : undefined;
      const centerY = sys ? (sys.top + sys.bottom) / 2 : y;
      top = eventScrollTop(centerY, wrap.scrollHeight, wrap.clientHeight);
      left = Math.max(0, Math.min(Math.max(0, wrap.scrollWidth - wrap.clientWidth), x - wrap.clientWidth / 2));
    } else {
      if (y - pad < top) top = Math.max(0, y - pad);
      else if (y + pad > top + wrap.clientHeight) top = Math.min(wrap.scrollHeight - wrap.clientHeight, y + pad - wrap.clientHeight);
      if (x - pad < left) left = Math.max(0, x - pad);
      else if (x + pad > left + wrap.clientWidth) left = Math.min(wrap.scrollWidth - wrap.clientWidth, x + pad - wrap.clientWidth);
    }
    if (Math.abs(top - wrap.scrollTop) > 1 || Math.abs(left - wrap.scrollLeft) > 1) {
      animateCaretScroll(wrap, top, left, !reduced);
    }
    const ghost = caretGhostRef.current;
    // 「移动光标」补间只在**插入光标真的出现**时播：showCaret=false 是方块态
    // （选中音符、Ctrl+←/→ 跳小节），五线谱视图也不画 I 形插入符——
    // 这些操作只让视口跟随，不做光标动画（用户明确要求）。
    const caretVisible = showCaret !== false && notation !== 'staff';
    if (guide && caretVisible && ghost && typeof ghost.animate === 'function') {
      if (typeof ghost.getAnimations === 'function') for (const a of ghost.getAnimations()) a.cancel();
      // 浮层是 position:fixed，全程用屏幕坐标，不受滚动容器裁剪 / 层叠影响。
      // 终点 = 滚动结束后新光标在屏幕上的位置
      const toX = x - left + wrapBox.left;
      const toY = y - top + wrapBox.top;
      const dx = reduced ? 0 : toX - fromX, dy = reduced ? 0 : toY - fromY;
      const at0 = 'translate(0px, 0px)';
      const at1 = `translate(${dx}px, ${dy}px)`;
      const half = `translate(${dx * 0.6}px, ${dy * 0.6}px)`;
      ghost.style.left = `${reduced ? toX : fromX}px`;
      ghost.style.top = `${(reduced ? toY : fromY) - 16}px`;
      // 四段节奏（总 1s）：① 在**起点先生成**一枚 I 形光标（0–170ms，带一下轻弹）
      // ② 原地停住看清它（170–320ms）③ 平移到新光标（320–820ms）
      // ④ 落点轻点一下再淡出（820–1000ms）。keyframe 自带 easing 才能逐段控速
      ghost.animate(reduced
        // 减少动态效果：不移动，只在新光标处淡入淡出，照样能指引视线
        ? [{ opacity: 0, offset: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0, offset: 1 }]
        : [
          { transform: `${at0} scale(.55)`, opacity: 0, offset: 0, easing: 'ease-out' },
          { transform: `${at0} scale(1.18)`, opacity: 1, offset: 0.1, easing: 'ease-out' },
          { transform: `${at0} scale(1)`, opacity: 1, offset: 0.17, easing: 'linear' },
          { transform: `${at0} scale(1)`, opacity: 1, offset: 0.32, easing: 'cubic-bezier(.35,.05,.2,1)' },
          { transform: `${half} scale(1.08)`, opacity: 1, offset: 0.6, easing: 'linear' },
          { transform: `${at1} scale(1)`, opacity: 1, offset: 0.82, easing: 'ease-out' },
          { transform: `${at1} scale(1.12)`, opacity: 1, offset: 0.9, easing: 'ease-out' },
          { transform: `${at1} scale(1)`, opacity: 0, offset: 1 },
        ], { duration: reduced ? 700 : 1000, easing: 'linear' });
      // 动画真的播了才消费这次点击：点击与 cursor 回灌分帧时，
      // 中间那一帧 guide=false，不能把意图提前吃掉，否则动画从此不播。
      if (freshClick && ptr) lastHandledPointerAt.current = ptr.at;
      lastPointer.current = null;
    } else if (ptr && (guide || !freshClick)) {
      // 这次点击不会（也不该）产生动画：方块态 / 五线谱 / 已过期，清掉别残留；
      // guide=false 的中间帧（cursor 还没回灌）仍保留，等下一帧再播。
      lastPointer.current = null;
    }
  }, [cursor, focusId, activePartId, score, showBreaks, showCaret, playing, lyricEdit, dragFrom, notation, animateCaretScroll, cancelCaretScroll]);

  /**
   * 键盘定位（跳小节 / 跳首尾）：光标与起播点到位还不够，谱面视口必须跟着走。
   * 放在「保证光标可见」那个 effect 之后，同一次提交里由它最后定位；
   * 它不依赖焦点是否在画布上，所以播放页 / 对轨页签也能生效。
   */
  const lastScrollSeq = useRef(-1);
  useEffect(() => {
    const req = scrollRequest;
    if (!req || req.seq === lastScrollSeq.current) return;
    lastScrollSeq.current = req.seq;
    const wrap = wrapRef.current;
    if (!wrap) return;
    // 明确的导航意图 = 交还滚动控制权，别让播放跟随的 rAF 每帧把视口拽回去；
    // 也撤掉编辑态光标跟随的平滑滚动，免得两个动画抢同一个 scrollTop
    followRef.current = false;
    cancelCaretScroll();
    if (req.edge) {
      wrap.scrollTop = edgeScrollTop(req.edge, wrap.scrollHeight, wrap.clientHeight);
      if (req.edge === 'start') wrap.scrollLeft = 0;
      return;
    }
    if (!req.eventId) return;
    const layout = layoutRef.current;
    if (!layout) return;
    // 展开反复的谱里事件 id 带副本后缀，用播放头同款候选去匹配
    const cands = playheadIdCandidates(req.eventId);
    const li = layout.lines.findIndex((ln) => ln.items.some((it) => cands.includes(it.eventId)));
    if (li < 0) return;
    const system = layout.systems?.find((s) => li >= s.from && li < s.to);
    const y = system ? (system.top + system.bottom) / 2 : layout.lines[li].y;
    const top = wrap.scrollTop;
    if (y >= top + 48 && y <= top + wrap.clientHeight - 48) return; // 已经看得见就别抖
    wrap.scrollTop = eventScrollTop(y, wrap.scrollHeight, wrap.clientHeight);
  }, [scrollRequest, cancelCaretScroll]);

  useEffect(() => {
    if (!lyricEdit) { lyricFocusKey.current = ''; return; }
    const key = `${lyricEdit.partId}:${lyricEdit.verse}:${lyricEdit.startId ?? ''}:${lyricEdit.session}`;
    if (lyricFocusKey.current === key) return;
    const input = (lyricEdit.startId ? lyricInputs.current.get(lyricEdit.startId) : undefined) ?? lyricInputs.current.values().next().value;
    if (!input) return;
    lyricFocusKey.current = key;
    input.focus(); input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [lyricEdit, lyricLayout]);

  // 配对态切换 → 只重绘（靶标要立刻出现 / 消失），不重排。
  // 退出配对时把悬停线一并清掉，免得下次进来还亮着上一根
  useEffect(() => {
    if (!pairing) hoverBarRef.current = null;
    paintRef.current(headRef.current);
  }, [pairing]);

  // 拖拉选区：监听 window，拖到画布外也能正确结束。
  // 指针贴近滚动容器上下边缘时自动滚动——不滚就选不到视口外的内容；
  // 滚动后指针下的命中变了，选区要跟着延长，所以滚动时每帧重取一次 pick
  useEffect(() => {
    if (dragFrom === null) return;
    let raf = 0;
    const last = { x: 0, y: 0 };
    const onMove = (e: MouseEvent) => {
      last.x = e.clientX;
      last.y = e.clientY;
      const p = pickPointer(e.clientX, e.clientY);
      if (p) onPick(dragFrom, p);
    };
    const onUp = (e: MouseEvent) => {
      const p = pickPointer(e.clientX, e.clientY);
      onPick(dragFrom, p);
      setDragFrom(null);
    };
    const autoScroll = () => {
      const wrap = wrapRef.current;
      if (wrap && last.y > 0) {
        const rect = wrap.getBoundingClientRect();
        const dTop = last.y - rect.top;
        const dBot = rect.bottom - last.y;
        let scrolled = false;
        if (dTop < 40) {
          wrap.scrollTop -= (40 - dTop) / 3;
          scrolled = true;
        } else if (dBot < 40 && dBot > 0) {
          wrap.scrollTop += (40 - dBot) / 3;
          scrolled = true;
        }
        if (scrolled) {
          const p = pickPointer(last.x, last.y);
          if (p) onPick(dragFrom, p);
        }
      }
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragFrom, pickPointer, onPick]);

  // 播放循环：只重绘，不触发 React 渲染
  useEffect(() => {
    if (!playing) return;
    ++ballFadeGen.current; // 新一轮播放接管：作废可能还在跑的尾音余跳续跑循环
    let raf = 0;
    const total = timelineTicks(timeline);
    let snapped = false;
    let trailStartTick: number | null = null;
    let lastStyle = playStyleRef.current;
    let trackLayout: LayoutResult | null = null;
    let cachedTrack: ReturnType<typeof buildBallTrack> = null;
    // 起播即恢复自动跟随：用户手动滚过之后，本次播放期间不再抢控制权
    followRef.current = true;

    const loop = () => {
      const tick = getPlayTick ? getPlayTick() : clock.currentBeat * TICKS_PER_BEAT;
      if (tick === null) {
        // 音频模式还没走到可反查的位置（如解码/起播间隙）：跳过本帧
        raf = requestAnimationFrame(loop);
        return;
      }
      if (tick >= total) {
        onEnded();
        return;
      }
      // 用 activeMainAt 而非 activeAt：倚音是独立时间线条目且 eventId 与主音相同，
      // 直接取会让指示条在每个倚音上从 0 重新扫一次（闪烁来回抖）
      const act = activeMainAt(timeline, tick);
      headsRef.current = activeHeadsAt(timeline, tick);
      if (lastStyle !== playStyleRef.current) {
        lastStyle = playStyleRef.current;
        trailRef.current.length = 0;
        lastBallTickRef.current = null;
        ballRef.current = null;
        trailStartTick = tick;
      }

      // 播放光球：每帧按当前 tick 重算抛物线位置；拖尾跟随，跳转 / 起播时清空
      if (playStyleRef.current === 'ball') {
        const layout = layoutRef.current;
        if (layout) {
          if (layout !== trackLayout) {
            trackLayout = layout;
            cachedTrack = buildBallTrack(layout, timeline, activePartId, staffBallPositionsRef.current);
          }
          const track = cachedTrack;
          const trail = trailRef.current;
          const lastT = lastBallTickRef.current;
          if (!track || trailStartTick === null || lastT === null || tick < lastT || tick - lastT > TICKS_PER_BEAT * 4) {
            trail.length = 0;
            trailStartTick = tick;
          }
          lastBallTickRef.current = tick;
          const b = track ? sampleBallTrail(track, tick, trailStartTick ?? tick, trail) : null;
          ballRef.current = b;
        }
      } else {
        ballRef.current = null;
      }

      // 入拍提醒：播放头为负 = 伴奏还在放前奏（谱面第 0 拍之前）。
      // 最后 4 拍开始在第一个音上闪烁并倒数——前奏一结束音符就到，
      // 没有提示的话眼睛来不及落上去（KTV 字幕那一套）
      const firstId = timeline[0]?.eventId ?? null;
      if (firstId && tick < 0 && tick > -4 * TICKS_PER_BEAT) {
        cueRef.current = {
          eventId: firstId,
          beatsLeft: -tick / TICKS_PER_BEAT,
          pulse: 0.5 + 0.5 * Math.sin((performance.now() / 1000) * Math.PI * 4), // 2Hz 脉动
        };
      } else {
        cueRef.current = null;
      }
      paintRef.current(act ? { eventId: act.entry.eventId, frac: act.progress } : null);

      // 平滑滚动：目标 = 正在播的那一行保持在视口中部；
      // 每帧只向目标缓动 8%，换行时是滑过去而不是跳过去。
      // 行是按**事件 id** 找的（展开谱的时间线条目带的是源谱 id），
      // 所以反复回到前一段时，滚动也会跟着回到前面那一行
      const layout = layoutRef.current;
      const wrap = wrapRef.current;
      if (layout && wrap) {
        // 前奏期间没有 act（还没进谱面），这时的跟随目标就是入拍提醒那个音——
        // 否则提醒闪在屏幕外，等于没提醒
        const followId = act
          ? headsRef.current.find((h) => layout.lines.some((line) => line.items.some((it) => it.eventId === h.eventId)))?.eventId ?? act.entry.eventId
          : cueRef.current?.eventId ?? null;
        if (followId) {
          const cands = playheadIdCandidates(followId);
          const li = layout.lines.findIndex((ln) =>
            ln.items.some((it) => cands.includes(it.eventId)),
          );
          if (li >= 0) {
            const system = layout.systems?.find((s) => li >= s.from && li < s.to);
            const target = Math.max(0, system ? (system.top + system.bottom) / 2 - wrap.clientHeight / 2 : layout.lines[li].y - wrap.clientHeight / 2);
            if (followRef.current) {
              // 起播第一帧直接到位（从文档顶端滑过去太远），之后每帧缓动
              wrap.scrollTop = snapped
                ? wrap.scrollTop + (target - wrap.scrollTop) * 0.08
                : target;
            }
            snapped = true;
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      // 停止 / 依赖变化：擦掉光球再重绘一帧，别让最后一帧的球停在画面上——
      // **除非**球正处于尾音区（最后一颗音之后）：伴奏 / 合成音恰好在谱面结束时
      // 停下来的歌，tick 不会再前进，余跳还没开始就被掐了。此时用真实时间
      // 把 tick 继续外推，让余跳完整跑完并消隐（有尾奏的歌不受影响——那边
      // 播放中 tick 就已经走完余跳了）
      const fadeLayout = layoutRef.current;
      const fadeTick = lastBallTickRef.current;
      const clear = (): void => {
        ballRef.current = null;
        trailRef.current = [];
        lastBallTickRef.current = null;
        paintRef.current(headRef.current);
      };
      if (playingRef.current || playStyleRef.current !== 'ball' || !fadeLayout || fadeTick === null) {
        clear();
        return;
      }
      let lastOnset = -Infinity;
      for (let i = timeline.length - 1; i >= 0; i -= 1) {
        const e = timeline[i]!;
        if (!e.grace) {
          lastOnset = e.startTick;
          break;
        }
      }
      if (fadeTick < lastOnset) {
        clear();
        return;
      }
      const gen = ++ballFadeGen.current;
      const fadeTrack = buildBallTrack(fadeLayout, timeline, activePartId, staffBallPositionsRef.current);
      if (!fadeTrack) {
        clear();
        return;
      }
      const rate = clock.beatsPerSec * TICKS_PER_BEAT; // tick / 秒
      let prev = performance.now();
      let t = fadeTick;
      const step = (now: number): void => {
        if (gen !== ballFadeGen.current) return; // 已有新的播放接管
        const dt = (now - prev) / 1000;
        prev = now;
        t += dt * rate;
        const b = sampleBallTrail(fadeTrack, t, trailStartTick ?? fadeTick, trailRef.current);
        ballRef.current = b;
        paintRef.current(headRef.current);
        if (b) requestAnimationFrame(step);
        else clear(); // 余跳跑完：彻底擦掉
      };
      requestAnimationFrame(step);
    };
  }, [playing, timeline, clock, getPlayTick, onEnded, score, activePartId]);

  return (
    <div
      className={`v2-scroll ${pairing ? 'is-pairing' : ''}`}
      ref={wrapRef}
      tabIndex={-1}
      onWheel={markManualScroll}
      onTouchMove={markManualScroll}
      onKeyDown={markManualScroll}
      onPointerDown={(e) => {
        // 画布右侧那一列才是滚动条：点在画布上是选音符/配对，不算滚动意图
        const canvas = canvasRef.current;
        if (canvas && e.clientX > canvas.getBoundingClientRect().right) {
          markManualScroll();
        }
      }}
    >
      <div ref={surfaceRef} style={responsive ? { position: 'relative' } : { display: 'contents' }}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label={notation === 'staff' ? (onClefClick ? '五线谱谱面，点击谱号可切换高低音谱号' : '五线谱谱面') : '简谱谱面'}
        onMouseMove={(e) => {
          const canvas = canvasRef.current;
          if (pairing) {
            // 配对中：光标交给 CSS 的绑定样式（清掉内联的 default / pointer，
            // 内联样式会盖过类），并让鼠标下的那根线亮成靶心
            if (canvas) canvas.style.cursor = '';
            const loc = toLocal(e.clientX, e.clientY);
            const layout = layoutRef.current;
            let id: string | null = null;
            if (loc && layout && hitScoreStart(layout, loc.x, loc.y)) id = SCORE_START_ID;
            else {
              const p = pickPointer(e.clientX, e.clientY);
              const ev = p ? (p.partId ? partScore(score, p.partId) : score).events[p.index] : undefined;
              id = ev && ev.kind === 'barline' ? ev.id : null;
            }
            if (id !== hoverBarRef.current) {
              hoverBarRef.current = id;
              paintRef.current(headRef.current);
            }
            return;
          }
          // 小铅笔只有 18px，得给个手型才看得出能点；小字谱也给手型 + 双击提示
          const clef = clefAtPointer(e.clientX, e.clientY);
          const loc = toLocal(e.clientX, e.clientY);
          const overCue = !!(onCueDoubleClick && loc && layoutRef.current && pickCueAt(layoutRef.current, loc.x, loc.y));
          if (canvas) {
            canvas.style.cursor = clef || overCue || overPencil(e.clientX, e.clientY) ? 'pointer' : 'default';
            canvas.title = clef ? `点击切换为${clef.clef === 'bass' ? '高音' : '低音'}谱号（整个声部）`
              : overCue ? '双击编辑这条小字谱（黄色三角标出它关联的音符）' : '';
          }
        }}
        onDoubleClick={(e) => {
          if (!onCueDoubleClick) return;
          const layout = layoutRef.current;
          const p = toLocal(e.clientX, e.clientY);
          if (!layout || !p) return;
          const cue = pickCueAt(layout, p.x, p.y);
          if (!cue?.cueId) return;
          e.preventDefault();
          e.stopPropagation();
          onCueDoubleClick(cue.cueId);
        }}
        onMouseDown={(e) => {
          // 记下点击的内容坐标：若这次点击让光标跨行 / 跨系统跳走，
          // 「光标移动」引导动画从这里起步（用户眼睛本来就在点击处）
          if (e.button === 0) {
            lastPointer.current = { cx: e.clientX, cy: e.clientY, at: performance.now() };
          }
          const clef = e.button === 0 ? clefAtPointer(e.clientX, e.clientY) : null;
          if (clef) {
            e.preventDefault();
            onClefClick?.(clef.partId ?? activePartId ?? score.part?.id ?? '1', clef.clef);
            return;
          }
          if (overPencil(e.clientX, e.clientY)) {
            e.preventDefault();
            if (lyricEdit) {
              if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
              lyricEdit.onExit();
            }
            onEditTitle?.();
            return; // 铅笔优先，别再去选音符
          }
          // 配对中：谱面开头那个靶标（第 0 拍）优先——它不在 hitIndex 里，
          // 是纯几何的虚拟线，点它和点小节线是同一套交互
          if (pairing && onPickStart) {
            const loc = toLocal(e.clientX, e.clientY);
            const layout = layoutRef.current;
            if (loc && layout && hitScoreStart(layout, loc.x, loc.y)) {
              e.preventDefault();
              onPickStart();
              return;
            }
          }
          // 小字谱优先：它画在主谱行带上半部，走 pickAt 会按最近邻命中主谱音符、
          // 把选区挪走。单击小字谱不改动选区，双击由 onDoubleClick 打开编辑弹窗。
          if (onCueDoubleClick) {
            const loc = toLocal(e.clientX, e.clientY);
            const layout = layoutRef.current;
            if (loc && layout && pickCueAt(layout, loc.x, loc.y)) {
              e.preventDefault();
              e.currentTarget.focus({ preventScroll: true });
              return;
            }
          }
          const p = pickPointer(e.clientX, e.clientY);
          if (lyricEdit) {
            e.preventDefault();
            const pickedScore = p?.partId ? partScore(score, p.partId) : score;
            const ev = p ? pickedScore.events[p.index] : undefined;
            const input = ev ? lyricInputs.current.get(ev.id) : undefined;
            if (input) { input.focus(); input.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
            return;
          }
          // 点击谱面后把键盘焦点从滑杆或属性输入框交回画布。
          e.currentTarget.focus({ preventScroll: true });
          if (!p) {
            // 空白处也是一次有意义的点击：退出曲目信息编辑
            onBlankClick?.();
            return;
          }
          e.preventDefault(); // 避免拖动时选中页面文字
          // Shift+点击：从上一次普通点击的位置一直选到这里——
          // 中途滚动窗口找目标也行，不必把首尾都留在视口里
          if (e.shiftKey && anchorRef.current) {
            onPick(anchorRef.current, p);
            return;
          }
          anchorRef.current = p;
          setDragFrom(p);
          onPick(p, null);
        }}
      />
      {responsive && <canvas ref={ballCanvasRef} aria-hidden="true" style={{ position: 'absolute', left: 0, pointerEvents: 'none' }}/>}
      </div>
      {lyricEdit && lyricLayout ? <div className="v2-lyric-overlay" aria-label="谱面歌词输入" key={`${lyricEdit.partId}:${lyricEdit.verse}`}>
        {(() => {
          const current = partScore(score, lyricEdit.partId);
          const notes = current.events.filter((e) => e.kind === 'note');
          const indices = new Map(notes.map((e, i) => [e.id, i]));
          const name = lyricTrackNames(current)[lyricEdit.verse];
          const k = lyricLayout.glyph.fontSize / 21;
          const lyricSize = notationLyricFontSize(lyricLayout.glyph.fontSize);
          const verseStep = notationDigitInkHeight(lyricLayout.glyph.fontSize) * 1.68;
          return lyricLayout.lines.filter((line) => !line.partId || line.partId === lyricEdit.partId).flatMap((line) => line.items.filter((it) => it.kind === 'note').map((it) => {
            const index = indices.get(it.eventId) ?? -1;
            const note = notes[index];
            if (!note) return null;
            const shift = (it.graceInk ?? 0) + (it.accW ?? 0);
            const staffRow = notation === 'staff' ? staffRef.current?.lines.find(row => row.symbols.some(s => s.kind === 'note' && s.eventId === it.eventId)) : undefined;
            const staffNote = staffRow?.symbols.find(s => s.kind === 'note' && s.eventId === it.eventId);
            const y = staffRow ? (staffRow.lyricY ?? staffRow.y + 5.4 * staffRef.current!.sp) + lyricEdit.verse * 3 * staffRef.current!.sp
              : line.y + (line.lyricYOff ?? 34 * k) + lyricEdit.verse * verseStep;
            return <LyricCell key={it.eventId} value={note.lyrics?.[lyricEdit.verse] ?? ''} label={`${name} · 第 ${index + 1} 个音`} style={{ left: staffNote ? staffNote.x - 8 * k : noteDigitCenter(it, lyricLayout.glyph) - lyricSize / 2, top: y - 15 * k, width: Math.max(22 * k, it.w - shift - 8 * k), height: 30 * k, fontSize: staffNote ? 16 * k : lyricSize, fontFamily: NOTATION_TEXT_FAMILY, fontWeight: 400 }}
              connection={note.lyricLinks?.[lyricEdit.verse]} onActivate={() => lyricEdit.onActivate(it.eventId)} onLink={(link, word) => lyricEdit.onLink(it.eventId, link, word)}
              register={(input) => { if (input) lyricInputs.current.set(it.eventId, input); else lyricInputs.current.delete(it.eventId); }}
              onCommit={(word) => lyricEdit.onCommit(it.eventId, word)} onInsertGap={() => lyricEdit.onInsertGap(it.eventId)} onDelete={(offset) => index + offset >= 0 && lyricEdit.onDelete(it.eventId, offset)} onExit={lyricEdit.onExit}
              onMove={(offset, atStart) => {
                const next = notes[Math.max(0, Math.min(notes.length - 1, index + offset))];
                const input = next ? lyricInputs.current.get(next.id) : undefined;
                if (input) { input.focus(); if (atStart) input.setSelectionRange(0, 0); input.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
              }} />;
          }));
        })()}
      </div> : null}
      <div ref={caretGhostRef} className="v2-caret-ghost" aria-hidden="true" />
    </div>
  );
}
