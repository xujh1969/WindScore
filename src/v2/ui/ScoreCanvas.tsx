import { useCallback, useEffect, useRef, useState } from 'react';
import type { BeatClock } from '../clock';
import {
  caretAt,
  hitTitleEdit,
  layoutScore,
  pickAt,
  type LayoutPick,
  type LayoutResult,
} from '../layout';
import { DARK_THEME, LIGHT_THEME, paintLayout } from '../paint';
import { TICKS_PER_BEAT } from '../ticks';
import { activeAt, tickAtEvent, timelineTicks, type TimelineEntry } from '../timeline';
import type { Score } from '../types';

/** 一次命中的结果，判定逻辑在 layout.pickAt（纯几何，可单测） */
export type ScorePick = LayoutPick;

interface Props {
  score: Score;
  dark: boolean;
  /** 每 tick 像素宽，即字间距倍率 */
  unit?: number;
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
  selectedIds,
  cursor,
  timeline,
  focusId,
  showCaret,
  playStyle = 'head',
  playing,
  clock,
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
        height: h,
      });
    };

    const relayout = () => {
      layoutRef.current = layoutScore(score, { contentWidth: boxWidth(), unit });
      paint(null);
    };

    paintRef.current = paint;
    relayout();

    const ro = new ResizeObserver(relayout);
    ro.observe(wrap);
    return () => ro.disconnect();
    // showCaret 也必须进依赖：否则光标在方块态切到插入态时，
    // 若其余输入没变（cursor / focusId 恰好相同），画布不会重绘
  }, [score, dark, unit, selectedIds, cursor, focusId, showCaret, playStyle]);

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
    // 每行的 tick 区间：把播放位置换算成 y 上的**连续**插值——
    // 行内从上一行中线滑向本行中线，跨行时 y 是连续的，滚动才不会跳
    const ranges =
      layoutRef.current?.lines.map((ln) => {
        const first = ln.items[0]?.eventIndex ?? 0;
        const last = ln.items[ln.items.length - 1]?.eventIndex ?? first;
        return { start: tickAtEvent(score, first), end: tickAtEvent(score, last + 1) };
      }) ?? [];
    let snapped = false;
    const loop = () => {
      const tick = clock.currentBeat * TICKS_PER_BEAT;
      if (tick >= total) {
        onEnded();
        return;
      }
      const act = activeAt(timeline, tick);
      paintRef.current(act ? { eventId: act.entry.eventId, frac: act.progress } : null);

      // 平滑滚动：目标 = 播放位置保持在视口中部；
      // 每帧只向目标缓动 8%，换行时是滑过去而不是跳过去
      const layout = layoutRef.current;
      const wrap = wrapRef.current;
      if (act && layout && wrap && ranges.length > 0) {
        const li = layout.lines.findIndex((ln) =>
          ln.items.some((it) => it.eventId === act.entry.eventId),
        );
        if (li >= 0) {
          const r = ranges[li];
          const span = Math.max(1, r.end - r.start);
          const p = Math.min(1, Math.max(0, (tick - r.start) / span));
          const lh = layout.lineHeight;
          const y = layout.lines[li].y + (p - 0.5) * lh;
          const target = Math.max(0, y - wrap.clientHeight / 2);
          // 起播第一帧直接到位（从文档顶端滑过去太远），之后每帧缓动
          wrap.scrollTop = snapped
            ? wrap.scrollTop + (target - wrap.scrollTop) * 0.08
            : target;
          snapped = true;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline, clock, onEnded, score]);

  return (
    <div className="v2-scroll" ref={wrapRef} tabIndex={-1}>
      <canvas
        ref={canvasRef}
        onMouseMove={(e) => {
          // 小铅笔只有 18px，得给个手型才看得出能点
          const canvas = canvasRef.current;
          if (canvas) canvas.style.cursor = overPencil(e.clientX, e.clientY) ? 'pointer' : 'default';
        }}
        onMouseDown={(e) => {
          if (overPencil(e.clientX, e.clientY)) {
            e.preventDefault();
            onEditTitle?.();
            return; // 铅笔优先，别再去选音符
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
