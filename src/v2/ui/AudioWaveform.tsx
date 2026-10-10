/**
 * 波形 + 节拍网格（音频对齐的手工标定视图）。
 *
 * 用法（指导书 §7.2 锚点校正）：波形上点一条**节奏线**（自动吸附，见下）→
 * 回谱面点一根**小节线** → 两者绑成锚点，原点自动重算（≥2 个锚点合成变速曲线）。
 * 小节线是拍位明确的界点，比拿单颗音去对更稳——音可能带弱起 / 倚音 / 附点，
 * 小节线的拍位是干净的。
 *
 * 交互：
 *   滚轮     缩放（以光标为中心，最小 8s）
 *   拖动     平移
 *   单击     选中最近的节奏线（**吸附**：吸到画面上真画出来的那条）
 *   悬停     虚线预览要吸到哪一条，并报出拍号 / 小节 / 时间
 *
 * 网格线画的是**音频标定格**（gridPhase + 拍 × 60/gridBpm），两种 TempoMap
 * 形式下语义一致——锚点引用的永远是「音频第几拍」。
 */
import { useEffect, useMemo, useRef } from 'react';
import type { TempoMap } from '../tempo';

export interface WaveStem {
  name: string;
  buffer: AudioBuffer;
  on: boolean;
}

interface Props {
  stems: WaveStem[];
  tempo: TempoMap;
  /** 标定网格的 BPM / 相位（音频拍 k 的时刻 = gridPhase + k × 60/gridBpm） */
  gridBpm: number;
  gridPhase: number;
  beatsPerMeasure: number;
  /** 波形上被选为绑定起始点的位置（秒）；null = 还没点过 */
  markerSec: number | null;
  /** 起始点吸附到的音频拍（整数）；显示用——标的永远是「第几拍」不是秒 */
  markerBeat: number | null;
  /** 单击是否吸附到最近的节奏线（默认开；网格本身还没标准时可关掉自由定点） */
  snap: boolean;
  /** 谱面开头（原点）在音频里的位置（秒）：拖放对齐的参照物 */
  originSec: number | null;
  /** 检测到的人声进入时刻（秒）：仅载入人声分轨时有值 */
  vocalSec: number | null;
  anchors: { scoreBeat: number; audioBeat: number }[];
  /** 播放位置（秒）：试听播放优先，其次谱面播放；null = 静止 */
  getPlaySec: () => number | null;
  /** 正在试听播放 */
  previewing: boolean;
  /** 深浅主题：波形配色要跟着主题走（浅色底上不能用白线 / 淡青） */
  dark: boolean;
  duration: number;
  /** 点波形：设定起始点并从那里试听（beat = 吸附后的音频拍） */
  onSeek: (sec: number, beat: number) => void;
  /** 停止试听 */
  onStop: () => void;
  /** 把起始点绑到当前选中的谱面音符 */
  onBind: () => void;
  /** 绑定按钮可用（谱面选中了音符 / 小节线，且波形上已有起始点） */
  canBind: boolean;
  /** 绑定按钮的文案（选中线 / 选中音符由调用方说了算） */
  bindLabel?: string;
  onHover?: (info: { beat: number; bar: number; sec: number } | null) => void;
  /**
   * 网格整组平移：**拖任意一条（非锚点）节奏线 = 整张网格平移**。
   * Shift 按住时位移 ×0.1 细调（组件内部处理）；deltaSec 是相对拖动起点的累计偏移。
   * 三个回调缺一不可，缺了就不启用拖拽。
   */
  onGridShiftStart?: () => void;
  onGridShift?: (deltaSec: number) => void;
  onGridShiftEnd?: () => void;
  /** 被选中的起点是否已经是对齐点（锚点）：浮层里据此显示「删除」 */
  markerIsAnchor?: boolean;
  /** 删除被选中起点上的对齐点 */
  onDeleteAnchor?: () => void;
  /** 浮层里的网格微调（‹›«»，毫秒级） */
  onNudge?: (deltaSec: number) => void;
  /** 浮层标题（如「第 24 拍 · 0:42.50」） */
  markerTitle?: string;
}

const BINS = 2048;

/**
 * 吸附：把光标所在的拍吸到**画面上真画出来的**那条网格线。
 * 缩得太密时网格只画强线（每 beatsPerMeasure 条），那就只能吸到强线——
 * 否则会吸到一条看不见的线上，点哪儿和看到哪儿对不上。
 * 抽成纯函数是为了能单测（组件里的拍号换算牵着 canvas）。
 */
export function snapBeatToGrid(beat: number, skip: number): number {
  const s = Math.max(1, Math.floor(skip));
  return Math.round(beat / s) * s;
}

/** 网格太密时只画强线（这条判据必须和绘图保持一致，否则吸附会吸到没画的线） */
export function gridSkipOf(pxPerBeat: number, beatsPerMeasure: number): number {
  return pxPerBeat < 8 ? Math.max(1, Math.floor(beatsPerMeasure)) : 1;
}

/**
 * 波形配色：随主题切换。
 * 深色用亮青 + 白（在黑底上跳出来），浅色一律换成**深一档的同色系**
 * （sky-700 / green-700 / violet-600 / pink-600），
 * 否则浅底上白线看不见、淡青对比度不足（用户实测）。
 */
const WAVE_THEME = {
  dark: {
    wave: 'rgba(74,209,255,0.75)',
    axis: 'rgba(255,255,255,0.12)',
    grid: 'rgba(74,209,255,0.55)',
    gridWeak: 'rgba(255,255,255,0.14)',
    beatText: 'rgba(74,209,255,0.9)',
    playhead: '#ffffff',
    anchor: 'rgba(126,231,135,0.9)',
    vocal: 'rgba(186,104,255,0.9)',
    origin: 'rgba(126,231,135,0.9)',
    marker: 'rgba(255,107,157,0.95)',
  },
  light: {
    wave: 'rgba(2,132,199,0.85)',
    axis: 'rgba(0,0,0,0.18)',
    grid: 'rgba(2,132,199,0.6)',
    gridWeak: 'rgba(0,0,0,0.12)',
    beatText: 'rgba(3,105,161,0.95)',
    playhead: '#111827',
    anchor: 'rgba(21,128,61,0.95)',
    vocal: 'rgba(124,58,237,0.95)',
    origin: 'rgba(21,128,61,0.95)',
    marker: 'rgba(219,39,119,0.95)',
  },
} as const;

/** 每列采 ~40 个样本算 min/max，整个文件一次算完缓存住 */
function computePeaks(buffer: AudioBuffer, bins: number): { mins: Float32Array; maxs: Float32Array } {
  const data0 = buffer.getChannelData(0);
  const data1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const n = buffer.length;
  const per = n / bins;
  const mins = new Float32Array(bins);
  const maxs = new Float32Array(bins);
  for (let b = 0; b < bins; b += 1) {
    let lo = 1;
    let hi = -1;
    const s0 = Math.floor(b * per);
    const s1 = Math.min(n, Math.floor((b + 1) * per));
    const stride = Math.max(1, Math.floor((s1 - s0) / 40));
    for (let i = s0; i < s1; i += stride) {
      const v = data1 ? (data0[i] + data1[i]) / 2 : data0[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi < lo) {
      lo = 0;
      hi = 0;
    }
    mins[b] = lo;
    maxs[b] = hi;
  }
  return { mins, maxs };
}

export function AudioWaveform({
  stems,
  gridBpm,
  gridPhase,
  beatsPerMeasure,
  markerSec,
  markerBeat,
  snap,
  originSec,
  vocalSec,
  anchors,
  getPlaySec,
  previewing,
  dark,
  duration,
  onSeek,
  onStop,
  onBind,
  canBind,
  bindLabel,
  onHover,
  onGridShiftStart,
  onGridShift,
  onGridShiftEnd,
  markerIsAnchor,
  onDeleteAnchor,
  onNudge,
  markerTitle,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ start: 0, span: duration });
  const drag = useRef<{ x: number; start: number } | null>(null);
  /**
   * 网格拖拽态：按在节奏线附近（±6px）时，拖动 = 整组平移而不是平移视图。
   * lastApplied 记上次已上报的偏移，本次只上报增量（细调中途切换 Shift 也不跳变）。
   */
  const gridDrag = useRef<{
    x: number;
    beat: number;
    lastApplied: number;
    /** 当前有效偏移（秒），画 ghost 线用 */
    eff: number;
  } | null>(null);
  /** 悬停预览：会吸到哪条线（null = 鼠标不在波形上 / 关了吸附） */
  const hoverSnap = useRef<{ beat: number; sec: number } | null>(null);
  /** 浮层 DOM：位置每帧跟着 markerSec / 视图走（视图在 ref 里，React 不知道） */
  const popRef = useRef<HTMLDivElement>(null);

  // 混合所有**开启的** stem 的峰值包络
  const peaks = useMemo(() => {
    const active = stems.filter((s) => s.on);
    if (active.length === 0) return null;
    const acc = active.map((s) => computePeaks(s.buffer, BINS));
    const mins = new Float32Array(BINS);
    const maxs = new Float32Array(BINS);
    for (let b = 0; b < BINS; b += 1) {
      mins[b] = Math.min(...acc.map((a) => a.mins[b]));
      maxs[b] = Math.max(...acc.map((a) => a.maxs[b]));
    }
    return { mins, maxs };
  }, [stems]);

  useEffect(() => {
    view.current = { start: 0, span: duration };
  }, [duration]);

  const wt = dark ? WAVE_THEME.dark : WAVE_THEME.light;
  const step = 60 / gridBpm;
  const beatTime = (a: number): number => gridPhase + a * step;
  const secToBeat = (sec: number): number => (sec - gridPhase) / step;

  /**
   * 把光标秒数换算成「要吸到哪一条线」。skip 与绘图共用同一个判据，
   * 保证点下去拿到的就是眼睛看到的那条。
   */
  const snapAt = (sec: number): { beat: number; sec: number } => {
    const raw = secToBeat(sec);
    if (!snap) return { beat: raw, sec };
    const w = wrapRef.current?.clientWidth ?? 1;
    const pxPerBeat = step / (view.current.span / Math.max(1, w));
    const skip = gridSkipOf(pxPerBeat, beatsPerMeasure);
    // 不再夹到 ≥0：网格第 0 拍之前（打拍起点之前的前奏）同样是有效拍位，
    // 夹 0 会让「点前面那段」全部塌陷到第 0 拍，那段就永远绑不上
    const beat = snapBeatToGrid(raw, skip);
    return { beat, sec: beatTime(beat) };
  };

  /** 光标是否压在一条（画面上真画出来的）网格线上：返回那条线的拍号，没压上 = null */
  const lineAt = (sec: number): number | null => {
    const w = wrapRef.current?.clientWidth ?? 1;
    if (w <= 0) return null;
    const pxPerBeat = step / (view.current.span / w);
    const b = snapBeatToGrid(secToBeat(sec), gridSkipOf(pxPerBeat, beatsPerMeasure));
    const xOfBeat = ((beatTime(b) - view.current.start) / view.current.span) * w;
    const cx = ((sec - view.current.start) / view.current.span) * w;
    return Math.abs(xOfBeat - cx) <= LINE_HIT_PX ? b : null;
  };

  /** 这条线上是否钉着对齐点（锚点线不参与整组平移——它是对齐的依据） */
  const anchoredAt = (beat: number): boolean =>
    anchors.some((a) => Math.abs(a.audioBeat - beat) < 0.5);

  /**
   * 画面上相邻（画出来的）网格线的间距（px）。间距不够宽时线太密，
   * 「按在线上」和「按在空白」没法区分——间距小于 GRID_DRAG_MIN 时
   * 拖拽一律当**平移视图**，想拖线整组平移就放大再拖
   * （缩得越小 1px 误差越大，拖线微调本来就不该在这个尺度做）。
   * 40px 是实测值：14px 时线区占屏幕比例太高，随手一按就误触拖线。
   */
  const GRID_DRAG_MIN = 40;
  /** 按在线上的命中半径（px）：比吸附预览窄，正对着线按下去才算拖线 */
  const LINE_HIT_PX = 4;
  const gridDraggable = (): boolean => {
    const w = wrapRef.current?.clientWidth ?? 1;
    const pxPerBeat = step / (view.current.span / Math.max(1, w));
    return pxPerBeat * gridSkipOf(pxPerBeat, beatsPerMeasure) >= GRID_DRAG_MIN;
  };

  // 绘制循环：播放头要动，索性每帧重画（画布很小，代价可忽略）
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  const draw = () => {
    const c = canvasRef.current;
    const wrap = wrapRef.current;
    if (!c || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 播放头自动跟随（分页式）：走到窗口右侧就整窗左移，让指示线重新出现在
    // 左侧约 8% 处——以前放大后播放头走到右边缘就消失，只能手动拖回来。
    // 正在拖动（平移视图 / 拖网格线）时不抢镜：拖拽期间视图一动，
    // 线的视觉位移就和施加的平移量对不上（用户实测「拖一半」的根源之一）
    const playSec = getPlaySec();
    if (playSec !== null && !drag.current && !gridDrag.current) {
      const v = view.current;
      if (playSec > v.start + v.span * 0.92 || playSec < v.start) {
        v.start = Math.max(0, Math.min(Math.max(0, duration - v.span), playSec - v.span * 0.08));
      }
    }

    const { start, span } = view.current;
    const secPerPx = span / w;
    const xOf = (sec: number) => ((sec - start) / span) * w;
    const pxPerBeat = step / secPerPx;

    // 波形
    if (peaks) {
      const mid = h / 2;
      const amp = h / 2 - 6;
      ctx.strokeStyle = wt.wave;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x += 1) {
        const b0 = Math.floor(((start + x * secPerPx) / duration) * BINS);
        const b1 = Math.max(b0 + 1, Math.floor(((start + (x + 1) * secPerPx) / duration) * BINS));
        let lo = 1;
        let hi = -1;
        for (let b = b0; b < b1 && b < BINS; b += 1) {
          if (peaks.mins[b] < lo) lo = peaks.mins[b];
          if (peaks.maxs[b] > hi) hi = peaks.maxs[b];
        }
        if (hi < lo) continue;
        ctx.moveTo(x + 0.5, mid - hi * amp);
        ctx.lineTo(x + 0.5, mid - lo * amp);
      }
      ctx.stroke();
      ctx.strokeStyle = wt.axis;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
    }

    // 节拍网格（音频标定格）。太密时只画「强线」（每 beatsPerMeasure 条）
    // 起点不夹 0、负拍照画：网格第 0 拍之前（打拍起点之前 / 长前奏）也有节拍，
    // 不画出来那段就成了「无节奏区」，既看不出拍也吸不上、绑不了
    const a0 = Math.floor(secToBeat(start)) - 1;
    const a1 = Math.ceil(secToBeat(start + span)) + 1;
    // 与吸附共用同一个判据：看不见的线不能吸
    const skip = gridSkipOf(pxPerBeat, beatsPerMeasure);
    for (let a = a0; a <= a1; a += 1) {
      if (a % skip !== 0) continue;
      const x = xOf(beatTime(a));
      const strong = a % beatsPerMeasure === 0;
      ctx.strokeStyle = strong ? wt.grid : wt.gridWeak;
      ctx.lineWidth = strong ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (strong && pxPerBeat > 14) {
        ctx.fillStyle = wt.beatText;
        ctx.font = '10px sans-serif';
        ctx.fillText(String(a), x + 3, 11);
      }
    }

    // 锚点（已绑定）
    for (const a of anchors) {
      const x = xOf(beatTime(a.audioBeat));
      ctx.fillStyle = wt.anchor;
      ctx.fillRect(x - 1, h - 8, 3, 8);
    }

    // 网格拖拽中的 ghost：原位置画虚线，当前位置画实线，标出平移量
    if (gridDrag.current && Math.abs(gridDrag.current.eff) > 0.001) {
      const g = gridDrag.current;
      const x0 = xOf(beatTime(g.beat));
      const x1 = xOf(beatTime(g.beat + g.eff / step));
      ctx.strokeStyle = wt.marker;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0, h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = wt.marker;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1, h);
      ctx.stroke();
      const ms = Math.round(g.eff * 1000);
      ctx.fillStyle = wt.marker;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`${ms > 0 ? '+' : ''}${ms} ms`, x1 + 4, 26);
    }

    // 人声进入（自动检测，需人声分轨）
    if (vocalSec !== null) {
      const x = xOf(vocalSec);
      if (x >= -4 && x <= w + 4) {
        ctx.strokeStyle = wt.vocal;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = wt.vocal;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('人声', x + 4, 26);
      }
    }

    // 谱面开头（原点）：拖放对齐的参照物，挪它 = 整谱平移
    if (originSec !== null) {
      const x = xOf(originSec);
      if (x >= -4 && x <= w + 4) {
        ctx.strokeStyle = wt.origin;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = wt.origin;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('谱面开头', x + 4, 12);
      }
    }

    // 吸附预览：悬停时先告诉你「会吸到哪一条」，点下去才不会跑偏
    if (hoverSnap.current && markerSec === null) {
      const hs = hoverSnap.current;
      const x = xOf(hs.sec);
      if (x >= -4 && x <= w + 4) {
        ctx.strokeStyle = wt.marker;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = wt.marker;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(`吸附 第 ${hs.beat} 拍`, x + 4, 26);
      }
    }

    // 绑定起始点（波形上点出来的位置；吸附后必落在某条节奏线上）
    if (markerSec !== null) {
      const x = xOf(markerSec);
      if (x >= -4 && x <= w + 4) {
        ctx.strokeStyle = wt.marker;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillStyle = wt.marker;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(
          markerBeat !== null
            ? `起点 第 ${markerBeat} 拍 · ${markerSec.toFixed(2)}s`
            : `起点 ${markerSec.toFixed(2)}s`,
          x + 4,
          h - 6,
        );
      }
    }

    // 播放头（playSec 已在开头取过，并用于窗口跟随）
    if (playSec !== null) {
      const x = xOf(playSec);
      if (x >= 0 && x <= w) {
        ctx.strokeStyle = wt.playhead; // 深色白、浅色近黑——别在浅底上画白线
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // 浮层跟随：视图平移 / 缩放时 React 不知道（都在 ref 里），位置每帧在这里贴。
    // 贴在波形**正下方**：挡在波形中间就看不见波形了，没法边看边微调
    if (popRef.current && markerSec !== null) {
      const x = Math.max(8, Math.min(w - 200, xOf(markerSec) + 8));
      popRef.current.style.left = `${x}px`;
      popRef.current.style.top = `${h + 4}px`;
    }
  };

  // 滚轮缩放（以光标为中心）
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const { start, span } = view.current;
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      const nextSpan = Math.max(8, Math.min(duration, span * factor));
      const anchorSec = start + frac * span;
      view.current = {
        start: Math.max(0, Math.min(duration - nextSpan, anchorSec - frac * nextSpan)),
        span: nextSpan,
      };
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [duration]);

  return (
    <>
      <div
        ref={wrapRef}
        className={`v2-wave ${previewing ? 'is-previewing' : ''}`}
      title={
        (snap ? '点节奏线 = 选中并试听（吸附）' : '点波形 = 从这里试听（未吸附）') +
        ' · 放大到线距够宽时拖节奏线 = 整组平移（Shift 细调）；缩得小时拖拽 = 平移视图 · 滚轮缩放'
      }
      onPointerDown={(e) => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (rect) {
          const sec = view.current.start + ((e.clientX - rect.left) / rect.width) * view.current.span;
          const line = lineAt(sec);
          // 按在节奏线上（线距够稀、且线上没钉对齐点）→ 拖动 = 整组平移网格；
          // 线距太密（缩得很小）时一律当平移视图，否则满屏都是线，根本没法平移
          if (
            line !== null &&
            !anchoredAt(line) &&
            gridDraggable() &&
            onGridShiftStart &&
            onGridShift &&
            onGridShiftEnd
          ) {
            onGridShiftStart();
            gridDrag.current = { x: e.clientX, beat: line, lastApplied: 0, eff: 0 };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            return;
          }
        }
        drag.current = { x: e.clientX, start: view.current.start };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const rect = wrapRef.current?.getBoundingClientRect();
        const sec =
          rect !== undefined
            ? view.current.start + ((e.clientX - rect.left) / rect.width) * view.current.span
            : null;
        if (rect && onHover && sec !== null) {
          const beat = Math.round(secToBeat(sec));
          onHover({ beat, bar: Math.floor(beat / beatsPerMeasure) + 1, sec });
          hoverSnap.current = snapAt(sec);
        }
        // 悬停在线上（可拖时）光标变左右箭头，提示「这条线可以拖」
        if (wrapRef.current && sec !== null) {
          const line = lineAt(sec);
          wrapRef.current.style.cursor =
            line !== null && !anchoredAt(line) && gridDraggable()
              ? 'ew-resize'
              : drag.current
                ? 'grabbing'
                : 'grab';
        }
        // 网格拖拽：横向位移 → 秒数，Shift 按住 ×0.1 细调；只上报增量
        if (gridDrag.current) {
          const w = rect?.width ?? 1;
          const raw = ((e.clientX - gridDrag.current.x) / w) * view.current.span;
          const eff = raw * (e.shiftKey ? 0.1 : 1);
          onGridShift?.(eff - gridDrag.current.lastApplied);
          gridDrag.current.lastApplied = eff;
          gridDrag.current.eff = eff;
          return;
        }
        if (!drag.current || sec === null) return;
        const dx = e.clientX - drag.current.x;
        if (Math.abs(dx) < 4) return;
        const w = rect?.width ?? 1;
        view.current.start = Math.max(
          0,
          Math.min(duration - view.current.span, drag.current.start - (dx / w) * view.current.span),
        );
      }}
      onPointerLeave={() => {
        hoverSnap.current = null;
        onHover?.(null);
        if (wrapRef.current && !drag.current && !gridDrag.current) wrapRef.current.style.cursor = '';
      }}
      onPointerUp={(e) => {
        if (gridDrag.current) {
          // 线上按下但没拖动（≤4px）= 单击选线，照常定点；
          // 真拖动了 = 平移，不上报定点
          const clicked = Math.abs(e.clientX - gridDrag.current.x) <= 4;
          gridDrag.current = null;
          onGridShiftEnd?.();
          if (!clicked) return;
        } else {
          if (e.target !== canvasRef.current) return; // 控制钮上的松开不算定点
          const moved = drag.current ? Math.abs(e.clientX - drag.current.x) : 99;
          drag.current = null;
          if (moved > 4) return; // 拖动 = 平移，不是定点
        }
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect) return;
        const raw = Math.max(
          0,
          view.current.start + ((e.clientX - rect.left) / rect.width) * view.current.span,
        );
        const s = snapAt(raw);
        onSeek(s.sec, s.beat);
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {/*
        控制条只剩「绑定 + 起点读数」：播放不再需要按钮——
        点波形就自动从那儿试听（点一下听一下，正是找位置该有的手感）。
      */}
      <div
        className="v2-wave-ctrl"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <button
          className="v2-btn"
          disabled={!canBind}
          title="把当前节奏点绑到谱面里选中的小节线（或音符）"
          onClick={onBind}
        >
          {bindLabel ?? '绑定'}
        </button>
        <span className="v2-wave-time">
          {markerSec !== null
            ? markerBeat !== null
              ? `起点 第 ${markerBeat} 拍 · ${markerSec.toFixed(2)}s`
              : `起点 ${markerSec.toFixed(2)}s`
            : '未定点'}
        </span>
      </div>

        {/*
          试听中：波形正中一个半透明圆形停止键。
          放在正中而不是角上，是因为「正在放、我要停」时眼睛就在波形中间；
          绑定了小节线也会自动停（EditorApp 的 commitAnchor 里做），这时它自然消失。
        */}
        {previewing ? (
          <button
            className="v2-wave-stop"
            title="停止试听"
            aria-label="停止试听"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={onStop}
          >
            <span className="v2-wave-stop-icon" aria-hidden />
          </button>
        ) : null}
      </div>
      {/*
        节奏线浮层：选中一条线后就地给出的操作——
        整组平移（微调对齐）、删除对齐点（绑错了撤销）。
        **渲染在 .v2-wave 之外**：它有 overflow:hidden，浮层贴到波形下方会被裁掉。
        挂到外层相对定位的 wrap 上，位置由 draw 循环每帧贴在波形正下方。
      */}
      {markerSec !== null && (markerTitle || onNudge || onDeleteAnchor) ? (
        <div
          ref={popRef}
          className="v2-wave-pop"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          {markerTitle ? <span className="v2-wave-pop-title">{markerTitle}</span> : null}
          {onNudge ? (
            <span className="v2-wave-pop-row" title="整条网格一起挪（毫秒级），对齐跟着走；拖动网格线更快，Shift 细调">
              <button onClick={() => onNudge(-0.1)}>«</button>
              <button onClick={() => onNudge(-0.01)}>‹</button>
              <button onClick={() => onNudge(0.01)}>›</button>
              <button onClick={() => onNudge(0.1)}>»</button>
              <em>平移网格</em>
            </span>
          ) : null}
          {markerIsAnchor && onDeleteAnchor ? (
            <button className="v2-wave-pop-del" title="这个对齐点不要了（对齐回退到其余对齐点 / 自动标定）" onClick={onDeleteAnchor}>
              删除此对齐点
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export default AudioWaveform;
