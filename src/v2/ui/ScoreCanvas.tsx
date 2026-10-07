import { useCallback, useEffect, useRef, useState } from 'react';
import type { BeatClock } from '../clock';
import {
  SCORE_START_ID,
  caretAt,
  hitScoreStart,
  hitTitleEdit,
  layoutScore,
  pickAt,
  type LayoutPick,
  type LayoutResult,
} from '../layout';
import { DARK_THEME, LIGHT_THEME, paintLayout } from '../paint';
import { TICKS_PER_BEAT } from '../ticks';
import { activeMainAt, timelineTicks, type TimelineEntry } from '../timeline';
import type { Score } from '../types';

/** 一次命中的结果，判定逻辑在 layout.pickAt（纯几何，可单测） */
export type ScorePick = LayoutPick;

interface Props {
  score: Score;
  dark: boolean;
  /** 每 tick 像素宽，即字间距倍率 */
  unit?: number;
  /** 字号覆盖（px）：播放页的观看偏好，不给 = 跟随谱面 */
  fontSize?: number;
  /** 字间距覆盖（px）：同上 */
  letterSpacing?: number;
  selectedIds: ReadonlySet<string>;
  /** 光标：插入位置（0 .. events.length） */
  cursor: number;
  timeline: TimelineEntry[];
  /** 方块光标：整块点亮这个音（替换态）。与 I 形插入符互斥 */
  focusId?: string | null;
  /** 是否画 I 形插入符。over 模式下只画方块，不画竖线 */
  showCaret?: boolean;
  /** 播放指示方式：head = 跳动的色块 + 竖线；band = 从行首生长的高亮条 */
  playStyle?: 'head' | 'band';
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
  /**点在谱面空白处（没命中任何音符 / 小节线）：用来退出曲目信息编辑 */
  onBlankClick?: () => void;
}

type Playhead = { eventId: string; frac: number } | null;

/**
 * Canvas 视图。
 * - 命中测试与拖选都走 layout 的 hitIndex 反查（§7.1）
 * - 播放时的重绘走 rAF 直接画，不经过 React state，避免每帧渲染整棵树
 */
export function ScoreCanvas({
  score,
  dark,
  unit,
  fontSize,
  letterSpacing,
  selectedIds,
  cursor,
  timeline,
  focusId,
  showCaret,
  pairing = false,
  onPickStart,
  playStyle = 'head',
  playing,
  clock,
  getPlayTick,
  onPick,
  onEnded,
  onEditTitle,
  onBlankClick,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<LayoutResult | null>(null);
  const paintRef = useRef<(head: Playhead) => void>(() => {});
  const [dragFrom, setDragFrom] = useState<ScorePick | null>(null);
  /** Shift 扩选的锚点：记住上一次普通点击的位置，Shift+点击选中两者之间 */
  const anchorRef = useRef<ScorePick | null>(null);

  /** 屏幕坐标 → 画布内坐标 */
  const toLocal = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  /** 屏幕坐标 → 命中结果（判定逻辑在 layout.pickAt） */
  const pickPointer = useCallback(
    (clientX: number, clientY: number): ScorePick | null => {
      const layout = layoutRef.current;
      const p = toLocal(clientX, clientY);
      if (!layout || !p) return null;
      return pickAt(layout, p.x, p.y);
    },
    [toLocal],
  );

  /** 鼠标是否压在标题旁的小铅笔上（判定在 layout.hitTitleEdit） */
  const overPencil = useCallback(
    (clientX: number, clientY: number): boolean => {
      const layout = layoutRef.current;
      const p = toLocal(clientX, clientY);
      return !!layout && !!p && hitTitleEdit(layout, p.x, p.y);
    },
    [toLocal],
  );

  // 谱面 / 选区 / 尺寸变化 → 重排并重绘
  /** 最近一帧的播放头：悬停重绘时照原样传回去，别把指示条画没了 */
  const headRef = useRef<Playhead>(null);
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
  const markManualScroll = (): void => {
    followRef.current = false;
  };
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const theme = dark ? DARK_THEME : LIGHT_THEME;

    // 画布尺寸基准：**边框盒**（getBoundingClientRect），不能用 clientWidth /
    // clientHeight——那两个值会被滚动条改变，而滚动条是否出现又取决于画布高度
    // （layout.height + 32 常常恰好卡在临界点上）。两侧互相喂就形成
    // ResizeObserver 重排循环：出现滚动条 → 变窄 → 重新换行 → 高度变化 →
    // 滚动条消失 → 变宽 → …… 画面在两种排版之间来回跳（茉莉花实测踩中）。
    // 边框盒不受滚动条影响，是稳定锚点；-2 = 上下 / 左右各 1px 边框。
    const boxWidth = () => Math.max(1, wrap.getBoundingClientRect().width - 2);
    const boxHeight = () => Math.max(1, wrap.getBoundingClientRect().height - 2);

    const paint = (head: Playhead) => {
      const layout = layoutRef.current;
      if (!layout) return;
      headRef.current = head;
      const dpr = window.devicePixelRatio || 1;
      // 宽度钳到 clientWidth：竖滚动条出现时别让画布伸到它底下（否则横滚动条也来）
      const w = Math.min(boxWidth(), Math.max(1, wrap.clientWidth));
      const h = Math.max(boxHeight(), layout.height + 32);
      const cw = Math.max(1, Math.floor(w * dpr));
      const ch = Math.max(1, Math.floor(h * dpr));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      paintLayout(ctx, layout, theme, {
        selectedIds,
        caret: showCaret === false ? null : caretAt(layout, cursor),
        playhead: head,
        focusId,
        playStyle,
        showMeasureNumbers: score.meta.showMeasureNumbers !== false,
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
      layoutRef.current = layoutScore(score, { contentWidth: boxWidth(), unit, fontSize, letterSpacing });
      paint(null);
    };

    paintRef.current = paint;
    relayout();

    const ro = new ResizeObserver(relayout);
    ro.observe(wrap);
    return () => ro.disconnect();
    // showCaret 也必须进依赖：否则光标在方块态切到插入态时，
    // 若其余输入没变（cursor / focusId 恰好相同），画布不会重绘
  }, [score, dark, unit, fontSize, letterSpacing, selectedIds, cursor, focusId, showCaret, playStyle]);

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
    let raf = 0;
    const total = timelineTicks(timeline);
    let snapped = false;
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
      paintRef.current(act ? { eventId: act.entry.eventId, frac: act.progress } : null);

      // 平滑滚动：目标 = 正在播的那一行保持在视口中部；
      // 每帧只向目标缓动 8%，换行时是滑过去而不是跳过去。
      // 行是按**事件 id** 找的（展开谱的时间线条目带的是源谱 id），
      // 所以反复回到前一段时，滚动也会跟着回到前面那一行
      const layout = layoutRef.current;
      const wrap = wrapRef.current;
      if (act && layout && wrap) {
        const li = layout.lines.findIndex((ln) =>
          ln.items.some((it) => it.eventId === act.entry.eventId),
        );
        if (li >= 0) {
          const target = Math.max(0, layout.lines[li].y - wrap.clientHeight / 2);
          if (followRef.current) {
            // 起播第一帧直接到位（从文档顶端滑过去太远），之后每帧缓动
            wrap.scrollTop = snapped
              ? wrap.scrollTop + (target - wrap.scrollTop) * 0.08
              : target;
          }
          snapped = true;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline, clock, getPlayTick, onEnded, score]);

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
      <canvas
        ref={canvasRef}
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
              const ev = p ? score.events[p.index] : undefined;
              id = ev && ev.kind === 'barline' ? ev.id : null;
            }
            if (id !== hoverBarRef.current) {
              hoverBarRef.current = id;
              paintRef.current(headRef.current);
            }
            return;
          }
          // 小铅笔只有 18px，得给个手型才看得出能点
          if (canvas) canvas.style.cursor = overPencil(e.clientX, e.clientY) ? 'pointer' : 'default';
        }}
        onMouseDown={(e) => {
          if (overPencil(e.clientX, e.clientY)) {
            e.preventDefault();
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
          const p = pickPointer(e.clientX, e.clientY);
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
    </div>
  );
}
