/**
 * 排版（§7.1）：纯坐标数据，不碰 Canvas / DOM，可单测、可命令行跑。
 *
 * 流水线（§7.3 三层，此处集中在同一文件，M7 加分页时原样拆开）：
 *   measure  →  breakFlow  →  place  →  paint
 *
 * 断行约束（§7.3）：
 *   1. 优先在小节线之后断行
 *   2. 不在 BeatGroup 中间断行（共用减时线的一组必须同行）
 */

import { beamCount, TICKS_PER_BEAT, tupletBeamCount, undotTicks } from './ticks';
import type {
  Accidental,
  BarlineEvent,
  Event,
  GraceNote,
  JumpMark,
  NoteEvent,
  Score,
} from './types';

export interface HitBox {
  eventId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedItem {
  eventId: string;
  kind: 'note' | 'rest' | 'barline' | 'directive' | 'jump';
  /** directive 的文本，如力度 mf */
  value?: string;
  /** jump 的记号类型（𝄋 / ⊕ / To ⊕ / D.S. / D.C. / Fine） */
  mark?: JumpMark;
  /** 在 score.events 中的下标，供光标定位 */
  eventIndex: number;
  x: number;
  w: number;
  ticks?: number;
  degree?: number;
  octave?: number;
  /** 变音记号，画在数字左边 */
  accidental?: Accidental;
  /** 变音记号占掉的额外宽度：数字要右移这么多才不会压住它 */
  accW?: number;
  beams?: number;
  dot?: 0 | 1 | 2;
  dashes?: number;
  /** 吐音标记，在音符上方画 T / K */
  tongue?: 'T' | 'K';
  /** 电吹管技法记号，可多选，在音符上方横向排列 */
  techniques?: string[];
  /** 延长音（弧线加点的 ⌒），画在音符上方 */
  fermata?: boolean;
  /** 转调记号（如 "1=G"），画在音符上方更高一行 */
  keyChange?: string;
  /** 前倚音 / 后倚音（小音符，不占时值），绘制层按它画 */
  graceBefore?: GraceNote[];
  graceAfter?: GraceNote[];
  /** 前倚音占掉的横向墨迹宽度：主音字形整体右移这么多，不被倚音压住 */
  graceInk?: number;
  /** 断音 / 顿音（小圆点），画在音符上方 */
  staccato?: boolean;
  /** 反复记号：这一格是小节线 + 反复点（start = 右侧两点，end = 左侧两点） */
  repeat?: 'start' | 'end';
  /** `:|3` 的遍数，画在反复点上方 */
  repeatTimes?: number;
  /** 房子号（`[1]` → [1]），画在括线里 */
  volta?: number[];
  /** 房子右端开放（不画右钩） */
  voltaOpen?: boolean;
  /** 小节号（画在小节线下方的小字，便于定位）：这条线结束的是第几小节 */
  measure?: number;
  /** 力度，画在音符下方 */
  dynamic?: string;
  /** 渐强 / 渐弱，画在音符下方力度记号旁边 */
  hairpin?: 'cresc' | 'dim';
  final?: boolean;
  partial?: boolean;
}

export interface PlacedBeam {
  x0: number;
  x1: number;
  level: number;
}

export interface PlacedArc {
  x0: number;
  x1: number;
  lift: number;
  kind: 'slur' | 'tie';
  /** 弧线要让开的高八度点数（取两端最大值） */
  octaveUp: number;
}

export interface PlacedBadge {
  x: number;
  text: string;
  level: 'error' | 'warn';
}

/** 连音标号：组上方向下弯的弧线 + 弧线中间的数字 */
export interface PlacedTuplet {
  /** 弧线的横向范围（组首到组尾） */
  x0: number;
  x1: number;
  text: string;
}

/** 跳房子的括线：从 `[1]` 那根小节线拉到房子的收尾处，里面写遍数 */
export interface PlacedVolta {
  x0: number;
  x1: number;
  numbers: number[];
  /** 右端开放（不画右钩）：长房 / 跨行房的简谱惯例 */
  open?: boolean;
  /** 跨行延续段（不画左钩，从行首画起） */
  cont?: boolean;
  /** 这一遍唱完要跳回反复起点（非末遍的房子），段尾画「↩跳回」提示 */
  jump?: boolean;
}

export interface LayoutLine {
  index: number;
  y: number;
  items: PlacedItem[];
  beams: PlacedBeam[];
  arcs: PlacedArc[];
  badges: PlacedBadge[];
  tuplets: PlacedTuplet[];
  voltas: PlacedVolta[];
}

/**
 * 谱面开头的谱头块（简谱惯例的「左中右」三区）：
 *   中 = 标题（大字）+ 说明行；左 = 调号、拍号（叠写）、速度；右 = 说明行（最多 4 行，右对齐）
 */
export interface LayoutTitle {
  title: string;
  /** 标题下的居中说明行（meta.sub），空串则不画 */
  sub: string;
  /** 左列：调号（1=G）、拍号（4/4，绘制时叠成分数）、速度（♩=76） */
  key: string;
  beat: string;
  tempo: string;
  /** 右列说明行（meta.notes，最多 4 行，右对齐） */
  rightLines: string[];
  /** 标题基线 / 说明行基线 */
  y: number;
  subY: number;
  /** 左右两列第一行的基线与行距（右列各行 = colY + 4 + i * rowH） */
  colY: number;
  rowH: number;
  /**
   * 左列第二行（速度）的基线。与右列行距解耦：拍号叠写占高比一行字高，
   * 速度行要额外让开，否则紧贴分母
   */
  tempoY: number;
  /** 左列左缘 / 右列右缘（右对齐） */
  leftX: number;
  rightX: number;
  centerX: number;
  /**
   * 标题右侧的小铅笔按钮（打开曲目信息编辑）。
   * 尺寸与位置都在 layout 里定，paint 只照着画、命中测试只照着比。
   */
  edit: { cx: number; cy: number; size: number };
  /** 谱头块总高（排版用它把第一行谱行往下推） */
  height: number;
}

/** 铅笔按钮的边长 */
const PENCIL_SIZE = 18;

/**
 * 粗估一行文本的像素宽，只用来给标题旁边的小按钮定位。
 * CJK / 全角按整字号算，其余按 0.55 字号——不追求精确，
 * 排版层不该为了一个按钮去量字（那需要 Canvas）。
 */
function estimateWidth(text: string, fontPx: number): number {
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? fontPx : fontPx * 0.55;
  return w;
}

/** 点击是否落在标题旁的铅笔按钮上 */
export function hitTitleEdit(layout: LayoutResult, x: number, y: number): boolean {
  const e = layout.title?.edit;
  if (!e) return false;
  const pad = 4; // 目标比图形略大一点，18px 的图标才点得准
  return (
    Math.abs(x - e.cx) <= e.size / 2 + pad && Math.abs(y - e.cy) <= e.size / 2 + pad
  );
}

export interface LayoutResult {
  lines: LayoutLine[];
  /** 每 tick 的像素宽度 */
  unit: number;
  lineHeight: number;
  /** 本次排版用的字形度量（随谱面字号缩放）；绘制与命中测试必须用它 */
  glyph: GlyphMetrics;
  hitIndex: HitBox[];
  title: LayoutTitle | null;
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** 可用内容宽度（容器宽 - 左右内边距） */
  contentWidth: number;
  /** 每 tick 像素宽，默认 1.3 → 1 拍约 62px（简谱惯用紧凑比例）。调大即放宽字间距 */
  unit?: number;
  /** 字号覆盖（px）：播放页的观看偏好用，不给 = 跟随谱面 meta.fontSize */
  fontSize?: number;
  /** 字间距覆盖（px）：同上，不给 = 跟随谱面 meta.letterSpacing */
  letterSpacing?: number;
  lineHeight?: number;
  padding?: number;
  /** 是否在谱面开头画标题块，默认 true */
  showTitle?: boolean;
}

/**
 * 字形度量。**绘制（paint）与命中测试（pickAt）必须共用同一套**：
 * 两边各写一份的话，会出现「看着点在空隙里、实际被判成点在音上」这类问题。
 */
/**
 * 版式度量（随谱面字号整体缩放）。**排版 / 绘制 / 命中测试三处共用同一套**：
 * 各写一份的话，会出现「看着点在空隙里、实际被判成点在音上」这类问题。
 * 基准值对应 21px 字号；`deriveGlyph` 按实际字号等比派生。
 */
export interface GlyphMetrics {
  /** 数字距格子左边界 */
  pad: number;
  /** 数字右侧再接这么多才开始画附点 / 增时线 */
  after: number;
  /** 标称数字宽度：21px 字号的 0-7 约 13px，命中测试用 */
  nominalWidth: number;
  dotR: number;
  dotGap: number;
  dashW: number;
  dashGap: number;
  /** 每颗倚音占的横向宽度（小音符窄一些） */
  graceW: number;
  /** 倚音与主音之间的净空：那条 1/4 弧线要画在这里（越小弧的半径越小） */
  graceGap: number;
  /** 数字字形右侧预留宽度，减时线 / 弧线按它收口 */
  glyphRight: number;
  /** 变音记号的额外宽度：数字要给它让位 */
  accW: number;
  octaveStep: number;
  octaveBase: number;
  octaveClear: number;
  beamLine: number;
  beamTop: number;
  beamStep: number;
  barHalf: number;
  arcBase: number;
  arcTieBase: number;
  selHalfH: number;
  caretHalf: number;
  /** 换气 / 吐音标记行的位置（字号变大后标记行也要跟着上移） */
  markTop: number;
  tupletDrop: number;
  markBottom: number;
  /** 谱行行高 */
  lineHeight: number;
  /** 插入符尾部与最后一个记号的净空 */
  caretTail: number;
  /** 派生自的谱面字号（px） */
  fontSize: number;
}

/** 基准度量：21px 字号下的全部尺寸 */
export const GLYPH: GlyphMetrics = {
  pad: 5,
  after: 5,
  nominalWidth: 13,
  dotR: 2.2,
  dotGap: 7,
  dashW: 10,
  dashGap: 15,
  graceW: 13,
  graceGap: 3,
  glyphRight: 22,
  accW: 9,
  octaveStep: 7,
  octaveBase: 17,
  octaveClear: 7,
  beamLine: 1.6,
  beamTop: 15,
  beamStep: 5.5,
  barHalf: 21,
  arcBase: 24,
  arcTieBase: 19,
  selHalfH: 14,
  caretHalf: 16,
  markTop: 44,
  tupletDrop: 27,
  markBottom: 34,
  lineHeight: 86,
  caretTail: 14,
  fontSize: 21,
};

/**
 * 按谱面字号派生一套度量：全部尺寸按 21px 基准等比缩放。
 * 缩放范围钳在 0.5–2.7 倍（12–56px），极端值下排版也不会崩。
 */
export function deriveGlyph(fontSize: number): GlyphMetrics {
  const k = Math.min(56, Math.max(12, fontSize)) / 21;
  const s = (v: number) => v * k;
  return {
    pad: s(GLYPH.pad),
    after: s(GLYPH.after),
    nominalWidth: s(GLYPH.nominalWidth),
    dotR: s(GLYPH.dotR),
    dotGap: s(GLYPH.dotGap),
    dashW: s(GLYPH.dashW),
    dashGap: s(GLYPH.dashGap),
    graceW: s(GLYPH.graceW),
    graceGap: s(GLYPH.graceGap),
    glyphRight: s(GLYPH.glyphRight),
    accW: s(GLYPH.accW),
    octaveStep: s(GLYPH.octaveStep),
    octaveBase: s(GLYPH.octaveBase),
    octaveClear: s(GLYPH.octaveClear),
    beamLine: s(GLYPH.beamLine),
    beamTop: s(GLYPH.beamTop),
    beamStep: s(GLYPH.beamStep),
    barHalf: s(GLYPH.barHalf),
    arcBase: s(GLYPH.arcBase),
    arcTieBase: s(GLYPH.arcTieBase),
    selHalfH: s(GLYPH.selHalfH),
    caretHalf: s(GLYPH.caretHalf),
    markTop: s(GLYPH.markTop),
    tupletDrop: s(GLYPH.tupletDrop),
    markBottom: s(GLYPH.markBottom),
    lineHeight: s(GLYPH.lineHeight),
    caretTail: s(GLYPH.caretTail),
    fontSize,
  };
}

/**
 * 字形墨迹的横向范围（相对 it.x）：数字 + 附点 + 增时线真正画到的地方。
 *
 * 命中测试必须用它，不能按时值格宽：十六分音符的格宽只有 26px，
 * 按格宽算出来的感知区会盖到下一个音的字形上，音符之间的缝就被吃光了。
 */
export function inkExtent(
  glyphWidth: number,
  dot: number,
  dashes: number,
  g: GlyphMetrics = GLYPH,
): { from: number; to: number } {
  const dots = dot > 0 ? (dot - 1) * g.dotGap + g.dotR : 0;
  const dash = dashes > 0 ? (dashes - 1) * g.dashGap + g.dashW : 0;
  return {
    from: g.pad,
    to: g.pad + glyphWidth + g.after + Math.max(dots, dash),
  };
}

/** 命中测试用：数字宽度按标称值估，其余与绘制一致 */
export function nominalInk(
  dot: number,
  dashes: number,
  g: GlyphMetrics = GLYPH,
): { from: number; to: number } {
  return inkExtent(g.nominalWidth, dot, dashes, g);
}

/**
 * 「字形簇」的横向宽度：数字 + 附点 + 增时线，左右各留 3px 净空。
 * 点亮当前音符时必须整块覆盖——只盖数字的话，附点会被切在框外，
 * 看不出这个附点属不属于当前音。
 */
export function clusterWidth(
  glyphWidth: number,
  dot: number,
  dashes: number,
  g: GlyphMetrics = GLYPH,
): number {
  const ink = inkExtent(glyphWidth, dot, dashes, g);
  return ink.to - ink.from + 6;
}

/**
 * 一个音符**整个字形簇**在画布上的墨迹范围：变音记号 + 前倚音 + 数字 +
 * 附点 / 增时线。
 *
 * 选中框、焦点方块、播放头都按它画，命中测试也按它判——三处必须同口径，
 * 否则会出现「框画在倚音上、点数字却选中别的」这类对不上的感觉。
 */
export function clusterSpan(
  it: PlacedItem,
  glyphWidth: number = GLYPH.nominalWidth,
  g: GlyphMetrics = GLYPH,
): { x: number; w: number } {
  const ink = inkExtent(glyphWidth, it.dot ?? 0, it.dashes ?? 0, g);
  const shift = (it.accW ?? 0) + (it.graceInk ?? 0);
  return { x: it.x + ink.from + shift, w: ink.to - ink.from };
}

/**
 * 「小节线类」记号：都画在格子线上，都要断小节（拍数校验）、都当断行锚点、
 * 两端对齐时都不参与拉伸。反复记号与房子是小节线的**属性**，
 * 所以这里只有小节线一种——谱面上不会因此多出一条线。
 */
export function isBarrier(ev: Event): boolean {
  return ev.kind === 'barline';
}

function beatsPerMeasureOf(beat: string): number {
  const [n, d] = beat.split('/').map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 4;
  return n * (4 / d);
}

/** 还原写法中的增时线条数：ticks 去掉附点后按整拍切分 */
function dashCountOf(ticks: number, dot: 0 | 1 | 2): number {
  const factor = dot === 0 ? 1 : dot === 1 ? 1.5 : 1.75;
  let base = ticks / factor;
  if (!Number.isInteger(base)) return 0;
  let dashes = 0;
  while (base > TICKS_PER_BEAT) {
    base -= TICKS_PER_BEAT;
    dashes += 1;
  }
  return dashes;
}

export function layoutScore(score: Score, opts: LayoutOptions): LayoutResult {
  const unit = opts.unit ?? 1.3;
  // 版式度量随谱面字号派生（缺省 21px = 基准值，尺寸与老文件完全一致）；
  // opts.fontSize / opts.letterSpacing 是播放页的观看偏好覆盖，谱面本身不变
  const fontSize = opts.fontSize ?? score.meta.fontSize ?? 21;
  const glyph = deriveGlyph(fontSize);
  const k = glyph.fontSize / 21;
  /** 字间距（px）：加在每个记号的占位宽度上，正数拉开、负数收紧 */
  const spacing = opts.letterSpacing ?? score.meta.letterSpacing ?? 0;
  // 行高要容得下自下而上的四层：减时线 → 音符 → 连音线 → 换气 / 吐音标记。
  // 房子括线贴着小节线顶端画（y − barHalf − 5，遍数数字最高到基线上方约 39px），
  // 行高 86 的上半行（43px）装得下，不用为它加高
  const lineHeight = opts.lineHeight ?? glyph.lineHeight;
  // 上下留白：标记层向上到 44px、力度层向下到 34px，
  // 不留白的话第一行的弧线会被画布顶边裁掉
  const padTop = 20;
  const padBottom = 24;
  const padding = opts.padding ?? 40;
  const maxX = Math.max(240, opts.contentWidth - padding * 2);

  const meta = score.meta;
  const title: LayoutTitle | null =
    opts.showTitle === false
      ? null
      : (() => {
          // 谱头三区的纵向节奏：标题基线 → 说明行 → 左右两列。
          // rowH 是右列的行距；左列速度行不跟它走——拍号叠写比一行字高，
          // 速度行由 tempoY 单独给出（见下）
          const y = padTop + 16;
          const subY = y + 28;
          const colY = subY + 10;
          const rowH = 18;
          const tempoY = colY + 32;
          const rightLines = (meta.notes ?? []).slice(0, 4);
          return {
            title: meta.title,
            sub: meta.sub ?? '',
            key: meta.key,
            beat: meta.beat,
            tempo: `♩=${meta.bpm}`,
            rightLines,
            y,
            subY,
            colY,
            rowH,
            tempoY,
            // 左右两列对齐谱面音符的实际边缘：谱行从 padding 起画、
            // 行尾锚点在 contentWidth - padding（见下方 maxX / barX 的算法），
            // 谱头贴 0 / contentWidth 就会悬在音符外面
            leftX: padding,
            rightX: opts.contentWidth - padding,
            centerX: opts.contentWidth / 2,
            edit: {
              // 28 = 标题字号；+20 给图标留出与歌名的间距，别贴着字
              cx: opts.contentWidth / 2 + estimateWidth(meta.title, 28) / 2 + 20,
              cy: y,
              size: PENCIL_SIZE,
            },
            // 谱头总高：两列谁伸得更低取谁，底边再留 20px 净空
            //（首行标记最高到中线上方 50px，别压住）
            height:
              Math.max(
                tempoY + 6,
                rightLines.length > 0 ? colY + 4 + (rightLines.length - 1) * rowH + 6 : 0,
              ) + 20,
          };
        })();
  const titleHeight = title ? title.height : 0;

  const byId = new Map<string, Event>(score.events.map((e) => [e.id, e]));
  const groupById = new Map(score.groups.map((g) => [g.id, g]));
  const groupOfEvent = new Map<string, string>();
  for (const g of score.groups) {
    for (const id of g.memberIds) groupOfEvent.set(id, g.id);
  }

  // ── 连线的全局视图：与断行无关，断行之后才能知道每段落在哪一行 ──
  // slur 在数据里是链式存储（A→B→C），必须先合成整条链，
  // 否则 3 个音的连音会画出 2 条互相重叠的弧。
  const slurNext = new Map<string, string>();
  /** 被连线跨越的小节线：断在这些位置会把连线切断 */
  const slurCrossedBars = new Set<number>();
  {
    const idxOf = new Map(score.events.map((e, i) => [e.id, i]));
    for (const ev of score.events) {
      if (ev.kind !== 'note') continue;
      for (const t of ev.ties ?? []) {
        if (t.kind !== 'slur') continue;
        slurNext.set(ev.id, t.to);
        const a = idxOf.get(ev.id);
        const b = idxOf.get(t.to);
        if (a === undefined || b === undefined) continue;
        for (let i = a + 1; i < b; i += 1) {
          if (score.events[i].kind === 'barline') slurCrossedBars.add(i);
        }
      }
    }
  }

  const slurChains: string[][] = [];
  {
    const isTarget = new Set(slurNext.values());
    for (const head of slurNext.keys()) {
      if (isTarget.has(head)) continue; // 只从链首开始
      const chain: string[] = [];
      const seen = new Set<string>();
      let cur: string | undefined = head;
      while (cur !== undefined && !seen.has(cur)) {
        chain.push(cur);
        seen.add(cur);
        cur = slurNext.get(cur);
      }
      if (chain.length >= 2) slurChains.push(chain);
    }
  }

  // ── measure：逐个事件算固有宽度 ──
  /** 变音记号占的额外宽度，命中和插入点都要算进去 */
  const accWidthOf = (ev: Event): number =>
    ev.kind === 'note' && ev.accidental ? glyph.accW : 0;

  const widths: { ev: Event; w: number }[] = score.events.map((ev) => {
    let w = 0;
    if (ev.kind === 'note' || ev.kind === 'rest') {
      // 倚音不占时值，但要占横向空间（小音符画在主音左右）
      const graceCount =
        ev.kind === 'note' ? (ev.graceBefore?.length ?? 0) + (ev.graceAfter?.length ?? 0) : 0;
      w =
        Math.max(26 * k, ev.ticks * unit + 10 * k) +
        accWidthOf(ev) +
        graceCount * glyph.graceW +
        spacing;
    }
    // 小节线留出较宽的占位：竖线画在格子正中，两侧自然形成空隙，
    // 插入点才有地方可站，不会和竖线糊在一起。
    // 带反复记号的那根线还要多留一点：两点画在竖线旁边，不然会压到相邻的音。
    else if (isBarrier(ev)) {
      const bar = ev as BarlineEvent;
      const base = bar.style === 'final' ? 26 : bar.repeat ? 24 : 20;
      w = base * k + spacing;
    } else if (ev.kind === 'directive' || ev.kind === 'jump') w = 26 * k + spacing;
    return { ev, w };
  });

  // ── breakFlow：只在安全点断行（§7.3）──
  // 主断点 = 小节线之后；次断点 = 拍内组结束。
  // 两者必须分开记：若让组结束点覆盖小节线断点，断行会落到小节中间，
  // 把小节劈成两半，小节拍数校验还会误报。
  const starts: number[] = [0];
  let x = 0;
  let lastBar = -1;
  let lastBarAny = -1;
  let lastGroupEnd = -1;
  let start = 0;
  for (let i = 0; i < widths.length; i += 1) {
    x += widths[i].w;
    if (x > maxX) {
      // 依次退让：不切断连线的小节线 → 任意小节线 → 拍内组边界 → 硬断
      const cut = [lastBar, lastBarAny, lastGroupEnd].find((c) => c > start) ?? i + 1;
      starts.push(cut);
      start = cut;
      x = 0;
      for (let j = start; j <= i; j += 1) x += widths[j].w;
      lastBar = -1;
      lastBarAny = -1;
      lastGroupEnd = -1;
    }
    const ev = widths[i].ev;
    if (isBarrier(ev)) {
      const bar = ev as BarlineEvent;
      // 房子开头那条线**不把断点留在它后面**：房子必须和它的内容在同一行，
      // 否则括线只剩行尾一小截（甚至画不出来），看着像这个房没标上
      if (!bar.volta) {
        // 反复起点把断行留在它**前面**：`|:` 该领着自己那段一起起行，
        // 孤零零挂在行尾不好看，也容易让人以为反复从下一行开始时才算
        const isRepeatStart = bar.repeat === 'start';
        lastBarAny = isRepeatStart ? i : i + 1;
        if (!slurCrossedBars.has(i)) lastBar = isRepeatStart ? i : i + 1;
      }
    }
    if (ev.kind === 'note' || ev.kind === 'rest') {
      const gid = groupOfEvent.get(ev.id);
      const g = gid ? groupById.get(gid) : undefined;
      if (g && g.memberIds[g.memberIds.length - 1] === ev.id) lastGroupEnd = i + 1;
    }
  }

  // ── place：落位 ──
  const expected = Math.round(beatsPerMeasureOf(score.meta.beat) * TICKS_PER_BEAT);
  const lines: LayoutLine[] = [];
  const hitIndex: HitBox[] = [];

  // 房子的横线延伸：沿小节线找「连着标了同号」的连续段（选旁边的线再点一次
  // [n] 就是在延长横线；第一个不带同号标记的线 = 画到这里为止）。
  // voltaRunLast: 房起点（连续段的墙）→ 段尾那根标记线的下标
  const voltaRunLast = new Map<number, number>();
  {
    let wall = -1;
    let nums = '';
    let last = -1;
    for (let i = 0; i < score.events.length; i += 1) {
      const ev = score.events[i];
      if (ev.kind !== 'barline') continue;
      const n = (ev as BarlineEvent).volta?.join(',') ?? '';
      if (n && n === nums) {
        last = i;
      } else {
        if (wall >= 0) voltaRunLast.set(wall, last);
        wall = n ? i : -1;
        nums = n;
        last = n ? i : -1;
      }
    }
    if (wall >= 0) voltaRunLast.set(wall, last);
  }
  /** 某根小节线之后的下一根小节线（事件下标），没有则 -1 */
  const nextBarIdxOf = (i: number): number => {
    for (let j = i + 1; j < score.events.length; j += 1) {
      if (score.events[j].kind === 'barline') return j;
    }
    return -1;
  };

  // 反复配对（与 expand 同口径）：给房子算「唱完这一遍要不要跳回」。
  // 规则：房子遍数 < 所在段的总遍数 → 非末遍，唱完必跳回；
  // 末遍房子不标（它自己有真正的 :|，或直接走出段外）
  const repeatPair = new Map<number, number>();
  {
    const stack: number[] = [];
    for (let i = 0; i < score.events.length; i += 1) {
      const ev = score.events[i];
      if (ev.kind !== 'barline') continue;
      const r = (ev as BarlineEvent).repeat;
      if (r === 'start') stack.push(i);
      else if (r === 'end') {
        const s = stack.pop();
        if (s !== undefined) repeatPair.set(s, i);
      }
    }
  }
  const houseJumps = (wallIdx: number, numbers: number[]): boolean => {
    let seg: [number, number] | undefined;
    for (const [s, e] of repeatPair) {
      if (s <= wallIdx && wallIdx < e && (!seg || s > seg[0])) seg = [s, e];
    }
    if (!seg) return false;
    const times = (score.events[seg[1]] as BarlineEvent).times ?? 2;
    return Math.min(...numbers) < times;
  };

  /** 已经放过音符 / 休止符了吗——谱面开头的小节线不编号（与 measureAt 同口径） */
  let anyTimed = false;

  for (let li = 0; li < starts.length; li += 1) {
    const from = starts[li];
    const to = li + 1 < starts.length ? starts[li + 1] : widths.length;
    const y = padTop + titleHeight + li * lineHeight + lineHeight / 2;

    const items: PlacedItem[] = [];
    let cx = padding;
    /** 本行起始的小节号：跨行连续，不从 1 重来。口径与 measureAt 完全一致
     *  （前面还没有音符的小节线是开头边界，不计入） */
    let measureNo = 1;
    let seenTimed = false;
    for (let k = 0; k < from; k += 1) {
      const e = score.events[k];
      if (e.kind === 'note' || e.kind === 'rest') {
        seenTimed = true;
        continue;
      }
      if (e.kind === 'barline' && seenTimed) measureNo += 1;
    }

    // ── 两端对齐（§7.3 美观约束）──
    // 断行只看「装不装得下」，装不下才折行，于是每行右边留白参差不齐。
    //
    // 对齐方案：**小节线格子不拉伸**（它们是行尾锚点，宽度固定），
    // 其余内容（音符 / 休止 / 换气 / 力度）的步进按本行比例 k 拉伸，
    // 使「内容 + 小节线」正好填满可用宽度。这样：
    //   - 每行右缘精确对齐，行与行的终止线也上下对齐（距右缘恒为半格宽）
    //   - 拉伸落在音符间距上，字形不变；减时线 / 连线 / 连音弧挂在
    //     事件坐标上一起拉伸，谱面不变形
    //   - 各小节各自吸收自己的那份间距，不受行内其它小节影响
    const line = widths.slice(from, to);
    const usedBars = line.reduce((a, x) => a + (x.ev.kind === 'barline' ? x.w : 0), 0);
    const usedRest = line.reduce((a, x) => a + x.w, 0) - usedBars;
    // 末行不对齐：内容少时硬拉会把音符间距拉得离谱，允许右边自然留白
    const isLast = li === starts.length - 1;
    const stretch =
      isLast || usedRest <= 0 ? 1 : Math.max(1, (maxX - usedBars) / usedRest);

    for (let i = from; i < to; i += 1) {
      const { ev, w } = widths[i];

      if (ev.kind === 'note' || ev.kind === 'rest') {
        const item: PlacedItem = {
          eventId: ev.id,
          kind: ev.kind,
          eventIndex: i,
          x: cx,
          w,
          ticks: ev.ticks,
        };
        if (ev.kind === 'note') {
          const n = ev as NoteEvent;
          item.degree = n.degree;
          item.octave = n.octave;
          if (n.accidental) {
            item.accidental = n.accidental;
            item.accW = glyph.accW;
          }
          // 连音的减时线不按每个音自己的 ticks 算（连音音值不是 2 的幂，会是 0 条），
          // 按「这组连音顶替的常规音符级别」算：3 连音占 1 拍 → 1 条线，占半拍 → 2 条线
          // 带附点的按**去点后的基准**算线数：附点八分（36 tick）该有 1 条线 + 点，
          // 直接拿 36 算是 0 条，会画成「数字 + 点」缺线的错样
          const gid = groupOfEvent.get(n.id);
          const g = gid ? groupById.get(gid) : undefined;
          item.beams = g?.tuplet
            ? tupletBeamCount(g.totalTicks, g.tuplet)
            : beamCount(undotTicks(n.ticks, n.dot ?? 0));
          item.dot = n.dot ?? 0;
          item.dashes = dashCountOf(n.ticks, item.dot);
          if (n.tongue) item.tongue = n.tongue;
          if (n.fermata) item.fermata = true;
          if (n.keyChange) item.keyChange = n.keyChange;
          if (n.graceBefore?.length) {
            item.graceBefore = n.graceBefore;
            item.graceInk = n.graceBefore.length * glyph.graceW + glyph.graceGap;
          }
          if (n.graceAfter?.length) item.graceAfter = n.graceAfter;
          if (n.articulations?.includes('staccato')) item.staccato = true;
          if (n.techniques?.length) item.techniques = n.techniques;
          if (n.dynamic) item.dynamic = n.dynamic;
          if (n.hairpin) item.hairpin = n.hairpin;
        } else {
          // 休止符与音符一样带时值记号：减时线 / 增时线 / 附点（线数同音符按去点基准算）
          const gid = groupOfEvent.get(ev.id);
          const g = gid ? groupById.get(gid) : undefined;
          item.beams = g?.tuplet
            ? tupletBeamCount(g.totalTicks, g.tuplet)
            : beamCount(undotTicks(ev.ticks, ev.dot ?? 0));
          item.dot = ev.dot ?? 0;
          item.dashes = dashCountOf(ev.ticks, item.dot);
        }
        items.push(item);
        anyTimed = true;
      } else if (isBarrier(ev)) {
        // 反复记号 / 房子是这条线的**属性**：还是一根小节线，
        // 只是多挂几个绘制标记（反复点、房子的 1 / 2）
        const bar = ev as BarlineEvent;
        items.push({
          eventId: ev.id,
          kind: 'barline',
          eventIndex: i,
          x: cx,
          w,
          final: bar.style === 'final',
          // 小节号：这条线**结束**的是第几小节（与报错「第 N 小节」同口径）。
          // 谱面开头那根线是第 1 小节的左边界，不编号也不推进计数——否则所有
          // 小节号会偏一位（|: 开头的谱实测踩到）
          measure: anyTimed ? measureNo : undefined,
          ...(bar.partial ? { partial: true } : {}),
          ...(bar.repeat ? { repeat: bar.repeat } : {}),
          ...(bar.repeat === 'end' && bar.times ? { repeatTimes: bar.times } : {}),
          ...(bar.volta ? { volta: bar.volta, ...(bar.voltaOpen ? { voltaOpen: true } : {}) } : {}),
        });
        // 这条线结束的是第 measureNo 小节，下一根线就是下一小节（开头那根不算）
        if (anyTimed) measureNo += 1;
      } else if (ev.kind === 'directive') {
        // 文字装饰记号（(前奏) 之类）把括号画出来，和力度记号区分开
        const value = ev.type === 'text' ? `(${ev.value})` : ev.value;
        items.push({ eventId: ev.id, kind: 'directive', eventIndex: i, x: cx, w, value });
      } else if (ev.kind === 'jump') {
        items.push({ eventId: ev.id, kind: 'jump', eventIndex: i, x: cx, w, mark: ev.mark });
      }

      // 对齐拉伸只加在步进上：小节线格子固定，作为行尾锚点
      cx += isBarrier(ev) ? w : w * stretch;
    }

    // 小节拍数校验徽标（§7.2）：挂在每条小节线上。
    // 只校验完整落在本行的小节：万一某个小节比整行还宽被迫劈开，
    // 前半段不能当成“少拍”来报假警告。
    // 未满与超出都报（未满 ⚠ 超出 ✗）——但两种情况例外：
    //   弱起小节本身就不满；弱起曲的最后一个小节与弱起互补，也允许不满。
    const badges: PlacedBadge[] = [];
    {
      let acc = 0;
      let open = false;
      let barX = padding;
      const startsNewMeasure = from === 0 || isBarrier(widths[from - 1].ev);
      let complete = startsNewMeasure;
      /** 本小节是否以弱起线开头 */
      let measurePartial = false;
      /** 全曲第一小节是否弱起：弱起曲的结尾小节允许不满 */
      let firstPartial = false;
      let seenFirst = false;
      for (const it of items) {
        if (it.kind === 'note' || it.kind === 'rest') {
          acc += it.ticks ?? 0;
          open = true;
        } else if (it.kind === 'barline') {
          if (open && complete && !measurePartial) {
            const beats = acc / TICKS_PER_BEAT;
            const exp = expected / TICKS_PER_BEAT;
            if (acc > expected) {
              badges.push({
                x: barX,
                text: `${trimNum(beats)}/${trimNum(exp)} ✗`,
                level: 'error',
              });
            } else if (acc < expected && !(it.final && firstPartial)) {
              badges.push({
                x: barX,
                text: `${trimNum(beats)}/${trimNum(exp)} ⚠`,
                level: 'warn',
              });
            }
          }
          acc = 0;
          open = false;
          complete = true;
          measurePartial = !!it.partial;
          if (!seenFirst) {
            seenFirst = true;
            firstPartial = !!it.partial;
          }
          barX = it.x;
        }
      }
    }

    // 减时线：由 BeatGroup 驱动（§6.5），组外单音按自身 ticks 画
    const beams: PlacedBeam[] = [];
    const tuplets: PlacedTuplet[] = [];
    const itemById = new Map(items.map((it) => [it.eventId, it]));
    const seenGroups = new Set<string>();
    for (const it of items) {
      if (it.kind !== 'note' && it.kind !== 'rest') continue;
      const gid = groupOfEvent.get(it.eventId);
      const g = gid ? groupById.get(gid) : undefined;

      if (!g) {
        // 休止符与音符一样画减时线（简谱惯例：0 下加一条线 = 八分休止）——
        // 上面 item.beams 已给 rest 算好，这里漏了 kind 判断之外没别的差别
        if ((it.beams ?? 0) >= 1) {
          const x1 = it.x + Math.min(it.w - 4 * k, glyph.glyphRight);
          beams.push({ x0: it.x + 2, x1, level: 1 });
          if ((it.beams ?? 0) >= 2) beams.push({ x0: it.x + 2, x1, level: 2 });
        }
        continue;
      }
      if (seenGroups.has(g.id)) continue;
      seenGroups.add(g.id);

      const members = g.memberIds
        .map((id) => itemById.get(id))
        .filter((m): m is PlacedItem => !!m);
      if (members.length === 0) continue;

      const first = members[0];
      const last = members[members.length - 1];
      const rightOf = (m: PlacedItem) => m.x + Math.min(m.w - 4 * k, glyph.glyphRight);
      const x0 = first.x + 2;
      const x1 = rightOf(last);

      // 连音组（三连音 / 六连音）：一定画一条线 + 一个标号。
      // 连音成员的 beamCount 都是 0，不能靠它判断要不要画线。
      if (g.tuplet) {
        beams.push({ x0, x1, level: 1 });
        tuplets.push({ x0, x1, text: String(g.tuplet) });
        continue;
      }
      // 组内没人被细分（全 ≥ 1 拍）就不画减时线
      if (members.every((m) => (m.beams ?? 0) < 1)) continue;
      beams.push({ x0, x1, level: 1 });

      // 第二级：连续的 beamCount ≥ 2 成员
      let s = 0;
      while (s < members.length) {
        if ((members[s].beams ?? 0) < 2) {
          s += 1;
          continue;
        }
        let e2 = s;
        while (e2 < members.length && (members[e2].beams ?? 0) >= 2) e2 += 1;
        const seg = members.slice(s, e2);
        beams.push({ x0: seg[0].x + 2, x1: rightOf(seg[seg.length - 1]), level: 2 });
        s = e2;
      }
    }

    const arcs: PlacedArc[] = [];
    const rightEdge = items.length
      ? items[items.length - 1].x + items[items.length - 1].w
      : padding;

    /**
     * 连线被断行切断、且这一行只剩一个成员时，朝延续方向补一段短弧。
     * 少了这段，跨小节 / 跨行的连线会整条凭空消失——
     * (3 | 3) 这种跨小节连线正好会掉进这个情况。
     */
    const pushStub = (it: PlacedItem, cutBefore: boolean, cutAfter: boolean): void => {
      const cx = it.x + Math.min(it.w - 4 * k, glyph.glyphRight) / 2 + 2 * k;
      let x0: number;
      let x1: number;
      if (cutBefore && cutAfter) {
        x0 = cx - 26 * k;
        x1 = cx + 26 * k;
      } else if (cutAfter) {
        x0 = cx;
        x1 = Math.min(rightEdge, cx + 48 * k);
      } else if (cutBefore) {
        x0 = Math.max(padding, cx - 48 * k);
        x1 = cx;
      } else {
        return;
      }
      if (x1 - x0 < 10) return;
      arcs.push({ x0, x1, lift: 11, kind: 'slur', octaveUp: it.octave ?? 0 });
    };

    const pushArc = (
      a: PlacedItem,
      b: PlacedItem,
      chain: PlacedItem[],
      kind: 'slur' | 'tie',
    ): void => {
      const x0 = a.x + 5;
      const x1 = b.x + Math.min(b.w - 4 * k, glyph.glyphRight);
      const span = x1 - x0;
      if (span < 10) return;
      arcs.push({
        x0,
        x1,
        // 跨度越大弧越明显，但上限 16px，给上方的换气 / 吐音标记留位置
        lift: kind === 'slur' ? Math.min(16, 10 + span * 0.05) : 11,
        kind,
        octaveUp: chain.reduce((m, i) => Math.max(m, i.octave ?? 0), 0),
      });
    };

    // 整条链按段处理：同一条连线被断行切成几段时，每段各画一条弧，
    // 落在本行只有一个音的那段用 pushStub 补短弧，保证两端都看得到。
    for (const chain of slurChains) {
      const onLine = chain
        .map((id) => itemById.get(id))
        .filter((m): m is PlacedItem => !!m);
      if (onLine.length === 0) continue;
      const cutBefore = chain.indexOf(onLine[0].eventId) > 0;
      const cutAfter =
        chain.lastIndexOf(onLine[onLine.length - 1].eventId) < chain.length - 1;
      if (onLine.length >= 2) {
        pushArc(onLine[0], onLine[onLine.length - 1], onLine, 'slur');
      } else {
        pushStub(onLine[0], cutBefore, cutAfter);
      }
    }

    for (const it of items) {
      const ev = byId.get(it.eventId);
      if (!ev || ev.kind !== 'note') continue;
      for (const t of ev.ties ?? []) {
        if (t.kind !== 'tie') continue;
        const target = itemById.get(t.to);
        if (!target) continue; // 跨行连线由 §7.3 约束 3 处理（M7）
        pushArc(it, target, [it, target], 'tie');
      }
    }

    // 命中框：按字形锚点做 Voronoi 划分，每个音符的可点区域以字形为中心。
    // 直接用音符的时值宽度当命中框会有问题：长音（比如 1· 占 103px）的框会
    // 吞掉后面紧邻音符字形左侧的一小段，导致那个音很难被单独选中。
    const chain: PlacedItem[] = [];
    const anchors: number[] = [];
    for (const it of items) {
      if (it.kind === 'directive') continue; // 力度画在谱行下方，单独给框
      chain.push(it);
      // 锚点要落在**字形**上：前倚音把主音字形整体推右了 graceInk，
      // 不加上它锚点会停在倚音那一侧——点在主音数字上反而落进下一格
      anchors.push(
        it.kind === 'barline' ? it.x + it.w / 2 : it.x + 10 + (it.graceInk ?? 0),
      );
    }
    for (let k = 0; k < chain.length; k += 1) {
      const left = k === 0 ? -1e4 : (anchors[k - 1] + anchors[k]) / 2;
      const right = k === chain.length - 1 ? 1e4 : (anchors[k] + anchors[k + 1]) / 2;
      hitIndex.push({
        eventId: chain[k].eventId,
        x: left,
        y: y - lineHeight / 2,
        w: right - left,
        h: lineHeight,
      });
    }
    for (const it of items) {
      if (it.kind !== 'directive') continue;
      hitIndex.push({ eventId: it.eventId, x: it.x, y: y + 14, w: it.w, h: 30 });
    }

    lines.push({ index: li, y, items, beams, arcs, badges, tuplets, voltas: [] });
  }

  /*
   * 房子的括线——放在行循环**之后**统一算：房子经常跨行，收口那根 `:|`
   * 落在下一行时，逐行算只能画到行尾、尾巴就丢了（实测：宽 900 时第二间房
   * 只剩墙所在行一段，收口段整个没画出来）。
   *
   * 画法（用户提案 + 跨行）：
   *   - 一段 = 一个「同号连续标记」的房；横线画到段尾标记线**后面的第一根线**
   *     （标记线是它所罩小节的开头，罩到下一根线正好盖满这个小节）。
   *     未标记的后续小节不画线，但演奏仍隐式延续到 :| / 下一间房
   *   - 右端开合自动判断：那根线是 :| → 拉过去封闭右钩；否则开放
   *   - 跨行：墙所在行画到行尾（无右钩），中间行 / 收口行画延续段
   *     （从行首起、无左钩），收口行按开合决定要不要右钩
   *   - voltaOpen 手动强制开放
   */
  {
    /** 事件下标 → 它落在哪一行、什么位置 */
    const barPos = new Map<number, { li: number; x: number; w: number }>();
    lines.forEach((ln, li) => {
      for (const it of ln.items) {
        if (it.kind === 'barline') barPos.set(it.eventIndex, { li, x: it.x, w: it.w });
      }
    });
    /** 某行内容的右边界（房子跨行时横线画到这里为止） */
    const rightEdge = (li: number): number => {
      let r = padding;
      for (const it of lines[li].items) r = Math.max(r, it.x + it.w);
      return r;
    };

    for (const [wall, last] of voltaRunLast) {
      const wallBar = score.events[wall] as BarlineEvent;
      const numbers = wallBar.volta ?? [];
      const manualOpen = wallBar.voltaOpen ?? false;
      // 横线画到段尾标记线**后面的第一根线**（标记线是它所罩小节的开头，
      // 罩到下一根线正好盖满这个小节）。那根线是 :| 就拉过去封闭右钩，否则开放
      const nb = nextBarIdxOf(last);
      const closes =
        nb >= 0 && (score.events[nb] as BarlineEvent).repeat === 'end' && !manualOpen;
      const endIdx = nb >= 0 ? nb : last;
      const wp = barPos.get(wall);
      if (!wp) continue;
      const ep = barPos.get(endIdx);
      const to = ep ? ep.li : wp.li;
      for (let li = wp.li; li <= to; li += 1) {
        const isWallSeg = li === wp.li;
        const isEndSeg = li === to;
        // 只有收口行（且真的封闭在 :| 上）才画右钩；其余一律开放
        const open = !(closes && isEndSeg);
        const x0 = isWallSeg ? wp.x + wp.w / 2 : padding;
        const x1 = isEndSeg && ep ? ep.x + ep.w / 2 : rightEdge(li);
        if (x1 - x0 <= 10) continue;
        lines[li].voltas.push({
          x0,
          x1,
          numbers,
          ...(open ? { open: true } : {}),
          ...(isWallSeg ? {} : { cont: true }),
          // 开放段尾若是「非末遍房子」的跳回点（如 [1] 后面跟 [2]），标「↩跳回」；
          // 封闭在真正 :| 上的房子不用标——那根线本身就是跳回记号
          ...(isEndSeg && open && houseJumps(wall, numbers) ? { jump: true } : {}),
        });
      }
    }
  }

  return {
    lines,
    unit,
    lineHeight,
    glyph,
    hitIndex,
    title,
    width: opts.contentWidth,
    height: padTop + titleHeight + lines.length * lineHeight + padBottom,
  };
}

/**
 * 插入点坐标（坐标属于 layout 层，paint 只负责画）。
 *
 * 取缝隙两侧「已经画出来的记号」的中点，而不是按下一项的左缘减几个像素：
 * 小节线的竖线画在自己格子的正中，按下一项左缘算偏移的话，
 * 插入点会正好压在那条竖线上（实测只差 1px），两者糊成一团，
 * 看不出光标到底在哪。
 */
export function caretAt(
  layout: LayoutResult,
  cursor: number,
): { x: number; y: number } | null {
  const g = layout.glyph;
  for (const line of layout.lines) {
    const k = line.items.findIndex((it) => it.eventIndex === cursor);
    if (k < 0) continue;

    // 力度记号的墨迹在谱行下方，不占插入点所在的高度带，算边界时要跳过——
    // 否则 `5 mf |` 里那个力度记号会把插入点挤到贴着竖线
    const prev = neighborInBand(line.items, k - 1, -1);
    const next = neighborInBand(line.items, k, 1);

    const prevEdge = prev
      ? prev.kind === 'barline'
        ? prev.x + prev.w / 2
        : clusterRight(prev, g)
      : null;
    const nextEdge = next
      ? next.kind === 'barline'
        ? next.x + next.w / 2
        : clusterLeft(next, g)
      : null;

    if (prevEdge === null && nextEdge === null) {
      return { x: line.items[0]?.x ?? 40, y: line.y };
    }
    if (prevEdge === null) return { x: nextEdge! - g.caretTail, y: line.y };
    if (nextEdge === null) return { x: prevEdge + g.caretTail, y: line.y };
    return { x: (prevEdge + nextEdge) / 2, y: line.y };
  }

  // 光标在谱末：贴在最后一个记号之后
  const last = layout.lines[layout.lines.length - 1];
  if (!last) return null;
  const lastItem = last.items[last.items.length - 1];
  if (!lastItem) return { x: 40, y: last.y };
  const edge =
    lastItem.kind === 'barline' ? lastItem.x + lastItem.w / 2 : clusterRight(lastItem, g);
  return { x: edge + g.caretTail, y: last.y };
}

/**
 * 一个音符**整个字形簇**在格子里的左右缘：变音记号 + 前倚音 + 数字 + 附点 /
 * 增时线 + 后倚音。
 *
 * 插入点必须按簇算，不能按数字算：前倚音画在数字左边，插入点若按数字左缘
 * 算就会落到倚音小音符上（实测踩到过）；后倚音画在数字右边，簇的右缘也要跟着它。
 */
function clusterLeft(it: PlacedItem, g: GlyphMetrics): number {
  return it.x + g.pad;
}

function clusterRight(it: PlacedItem, g: GlyphMetrics): number {
  // 后倚音右对齐到格内（与绘制层的 5px 内缩一致，随字号缩放）
  if (it.graceAfter?.length) return it.x + it.w - 5 * (g.fontSize / 21);
  const shift = (it.accW ?? 0) + (it.graceInk ?? 0);
  return it.x + shift + Math.min(it.w - shift, g.glyphRight);
}

/** 从 from 起按 dir 找最近的、墨迹落在谱行高度带里的记号 */
function neighborInBand(
  items: PlacedItem[],
  from: number,
  dir: 1 | -1,
): PlacedItem | null {
  for (let i = from; i >= 0 && i < items.length; i += dir) {
    const it = items[i];
    if (it.kind !== 'directive') return it;
  }
  return null;
}

/** 一次命中的结果 */
export interface LayoutPick {
  index: number;
  /** over = 点在字形上（方块，输入替换）；insert = 点在空隙里（I 形，输入插入） */
  mode: 'over' | 'insert';
  /** 缝隙下标；over 模式下 events[cursor-1] 就是被选中的音 */
  cursor: number;
}

/** 配对用的「谱面开头」虚拟靶标 id——不是真实事件 id */
export const SCORE_START_ID = '__scoreStart__';

/**
 * 谱面开头那根**虚拟线**的位置，只在**对轨配对**时存在。
 *
 * 简谱开头不画小节线（小节线是分隔记号、不是边界记号），但绑定需要一个
 * 跟「谱面第 0 拍」对应的靶标：否则点了音频最前面的节奏点，谱面上却没有
 * 可以点的东西——总不能为它单开一个按钮，那跟点线绑就是两套交互了。
 * 所以画一个和小节线同款的靶标，点它 = 绑定第 0 拍；它不写进谱面、不参与排版。
 */
export function scoreStartTarget(
  layout: LayoutResult,
): { x: number; y: number; half: number } | null {
  const ln = layout.lines[0];
  if (!ln) return null;
  const first = ln.items[0];
  return { x: (first?.x ?? 0) - 6, y: ln.y, half: layout.glyph.barHalf };
}

/** 点是否落在开头靶标上（它在谱面最左边缘、没有宽度，容差给得比小节线宽） */
export function hitScoreStart(layout: LayoutResult, x: number, y: number): boolean {
  const t = scoreStartTarget(layout);
  if (!t) return false;
  return Math.abs(x - t.x) <= 9 && Math.abs(y - t.y) <= t.half + 8;
}

/**
 * 命中测试：点在音符字形上 → over；点在字形之外的空隙 → insert。
 * 感知区只覆盖字形墨迹，剩下的空白全部让给插入，音符之间的缝才点得进去。
 */
export function pickAt(layout: LayoutResult, x: number, y: number): LayoutPick | null {
  const id = hitTest(layout, x, y);
  if (!id) return null;

  for (const line of layout.lines) {
    const it = line.items.find((i) => i.eventId === id);
    if (!it) continue;

    if (it.kind === 'barline') {
      // 点竖线 = **选中这条线**（反复 / 终止线 / 房子都是它的属性，点它才能改）。
      // 线的两侧留作插入点：只有正中那一小条是「选线」，免得想插音却选中了线。
      const mid = it.x + it.w / 2;
      if (x >= mid - 5 && x <= mid + 5) {
        return { index: it.eventIndex, mode: 'over', cursor: it.eventIndex + 1 };
      }
      return {
        index: it.eventIndex,
        mode: 'insert',
        cursor: x < mid ? it.eventIndex : it.eventIndex + 1,
      };
    }

    if (it.kind !== 'note' && it.kind !== 'rest') {
      // 力度等没有字形的记号：按左右半边决定插在它前面还是后面
      return {
        index: it.eventIndex,
        mode: 'insert',
        cursor: x < it.x + it.w / 2 ? it.eventIndex : it.eventIndex + 1,
      };
    }

    // 墨迹范围同样要加上变音记号与前倚音的位移（绘制层就是这么摆的）
    const shift = (it.accW ?? 0) + (it.graceInk ?? 0);
    const ink = nominalInk(it.dot ?? 0, it.dashes ?? 0, layout.glyph);
    const x0 = it.x + ink.from + shift;
    const x1 = it.x + ink.to + shift;
    if (x >= x0 && x <= x1) {
      return { index: it.eventIndex, mode: 'over', cursor: it.eventIndex + 1 };
    }
    return {
      index: it.eventIndex,
      mode: 'insert',
      cursor: x < x0 ? it.eventIndex : it.eventIndex + 1,
    };
  }
  return null;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * 命中测试：用 layout 坐标反向查表，不依赖 DOM 事件（§7.1）。
 * 先做包含判断；落在行间空隙（比如拖拽时）再退回最近邻，
 * 保证拖拽过程中不会因为没有命中而卡住。
 */
export function hitTest(layout: LayoutResult, x: number, y: number): string | null {
  for (const b of layout.hitIndex) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.eventId;
  }

  let best: HitBox | null = null;
  let bestScore = Infinity;
  for (const b of layout.hitIndex) {
    const dy = y < b.y ? b.y - y : y > b.y + b.h ? y - (b.y + b.h) : 0;
    const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
    const score = dy * 1000 + dx; // 先按行收敛，再按列
    if (score < bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best ? best.eventId : null;
}
