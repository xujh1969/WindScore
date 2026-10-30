/**
 * 绘制（§7.1 paint 层）：只吃 LayoutResult 的坐标，不认识 Score。
 * 将来换 SVG 后端时新增 paintSvg.ts，layout.ts 与交互逻辑一行不改。
 *
 * 竖向度量统一收在这里，改版式只动这一组常量。
 */

import { playbackX } from './spacing';
import { paintLyricLines } from './lyricLines';
import { SEGNO_SYMBOL, MUSIC_SYMBOL_FONT } from './musicSymbols';
import { shortInstrumentLabel } from './instrumentSamples';
import {
  clusterSpan,
  SCORE_START_ID,
  type GlyphMetrics,
  type LayoutLine,
  type LayoutResult,
  type LayoutTitle,
  type PlacedItem,
} from './layout';
import type { Accidental, GraceNote } from './types';

/** 数据值 → 谱面字形（属性面板的按钮也用这一份，避免两处各写一套）。
 *  重升用 ×（GB/T 46845—2025 §6.2.5.1 形态；canvas 上由 drawDoubleSharp 手绘粗 ×），
 *  重降 ♭♭（canvas 上两个 ♭ 贴近排手绘，避免字体 𝄫 的宽间距压到数字） */
export const ACCIDENTAL_GLYPH: Record<Accidental, string> = {
  '#': '♯',
  x: '×',
  b: '♭',
  bb: '♭♭',
  '♮': '♮',
};

/** 用户提供的波音 SVG：等比缩至 14px 宽并居中，保留填充曲线的粗细变化。 */
// 加宽两段粗笔画，再用同色描边增强细线和末端的小字号可见性。
const mordentPath = 'M -6.7348 1.3655 C -6.0189 0.2254 -5.0114 -2.108 -4.0038 -2.4792 C -3.2083 -2.9564 -2.572 -2.6383 -2.2008 -1.7898 C -1.7235 -0.6761 -1.75 1.1799 -0.6894 1.7898 C -0.053 2.161 0.4242 1.286 0.9545 0.0928 C 1.75 -1.7102 2.0947 -2.6383 2.9697 -2.5852 C 4.0833 -2.6383 4.1364 -0.8087 4.5076 0.1723 C 4.9318 1.4716 5.4886 2.108 6.2045 1.233 C 6.4697 0.8617 6.6023 0.2254 6.7348 -0.7292 C 6.5227 0.7557 6.0455 2.2405 5.3295 2.3996 C 4.0038 2.6648 3.6061 0.9413 3.2614 -0.1989 C 2.8636 -1.4451 2.9962 -2.0814 2.3864 -1.7898 C 1.7235 -1.392 1.1402 0.411 0.3712 1.4981 C -0.3712 2.7178 -1.7765 2.7443 -2.3598 1.3125 C -2.9697 0.0133 -3.0758 -1.8693 -3.3144 -2.0284 C -4.4015 -2.4792 -5.5152 0.3049 -6.7348 1.3655 Z';
const bendDownPath = 'M -7 0 L -2 -5 L 7 6 M 2 4 L 7 6 L 6 1';
/** 回音（GB/T 46845—2025 §7.4）：横置的 S 形曲线，描边绘制（字形字体覆盖不稳） */
const turnPath = 'M -6.5 1.8 C -6.5 -3.6 -2 -4 0 0 C 2 4 6.5 3.6 6.5 -1.8';
/** Canvas 与属性按钮共用路径；上下版本只做垂直镜像。 */
export const TECHNIQUE_PATHS: Record<'mordentUp' | 'mordentDown' | 'bendUp' | 'bendDown' | 'turn', { d: string; fill: boolean; flip: boolean; strokeWidth: number }> = {
  mordentUp: { d: mordentPath, fill: true, flip: false, strokeWidth: 0.85 },
  mordentDown: { d: mordentPath, fill: true, flip: true, strokeWidth: 0.85 },
  bendUp: { d: bendDownPath, fill: false, flip: true, strokeWidth: 1.5 },
  bendDown: { d: bendDownPath, fill: false, flip: false, strokeWidth: 1.5 },
  turn: { d: turnPath, fill: false, flip: false, strokeWidth: 1.5 },
};
type TechniquePath = keyof typeof TECHNIQUE_PATHS;
export const TECHNIQUE_PATH_SCALE: Record<TechniquePath, number> = {
  mordentUp: 0.99,
  mordentDown: 0.99,
  bendUp: 0.64,
  bendDown: 0.64,
  turn: 1,
};
const techniquePathCache = new Map<TechniquePath, Path2D>();

/** Keep the original vector data available to the SVG export canvas. */
export function paintTechniqueGeometry(ctx: CanvasRenderingContext2D, path: TechniquePath): void {
  const shape = TECHNIQUE_PATHS[path];
  const vector = ctx as CanvasRenderingContext2D & { drawSvgPath?: (d: string, fill: boolean, stroke: boolean) => void };
  if (vector.drawSvgPath) {
    vector.drawSvgPath(shape.d, shape.fill, shape.strokeWidth > 0);
    return;
  }
  let geometry = techniquePathCache.get(path);
  if (!geometry) {
    geometry = new Path2D(shape.d);
    techniquePathCache.set(path, geometry);
  }
  if (shape.fill) ctx.fill(geometry);
  if (shape.strokeWidth > 0) ctx.stroke(geometry);
}

/**
 * 电吹管技法记号：数据值 → 谱面字形。
 * DSL 后缀字母见 dsl.ts 的 TECHNIQUE_LETTER，两处通过数据值（键）对应。
 * flip = 上下翻转；path = 不用字符、改走专用折线路径绘制。
 */
export const TECHNIQUE_GLYPH: Record<
  string,
  { mark: string; label: string; flip?: boolean; path?: TechniquePath }
> = {
  breath: { mark: 'V', label: '换气' },
  trill: { mark: 'tr', label: '颤音' },
  flutter: { mark: '*', label: '花舌' },
  da: { mark: '扌', label: '打音' },
  // 波音按用户提供的 SVG 填充曲线绘制，不带中间竖线。
  mordentUp: { mark: '≈', label: '上波音', path: 'mordentUp' },
  mordentDown: { mark: '≈', label: '下波音', path: 'mordentDown' },
  slideUp: { mark: '↑', label: '上滑音' },
  slideDown: { mark: '↓', label: '下滑音' },
  bendUp: { mark: '↗', label: '上弯音', path: 'bendUp' },
  bendDown: { mark: '↘', label: '下弯音', path: 'bendDown' },
  // 回音：横置 S 曲线（turnPath），不用字体字形——回音码位覆盖不稳
  turn: { mark: '∞', label: '回音', path: 'turn' },
};

/** 颜色随调用方，尺寸随谱面字号，避免导出大字时记号仍停留在 13px。 */
function drawTechniquePath(ctx: CanvasRenderingContext2D, cx: number, cy: number, path: TechniquePath, scale: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale * TECHNIQUE_PATH_SCALE[path], scale * TECHNIQUE_PATH_SCALE[path]);
  const shape = TECHNIQUE_PATHS[path];
  if (shape.flip) ctx.scale(1, -1);
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = shape.strokeWidth;
  ctx.lineJoin = shape.fill ? 'round' : 'miter';
  ctx.lineCap = shape.fill ? 'round' : 'butt';
  paintTechniqueGeometry(ctx, path);
  ctx.restore();
}

/** 播放指示方式：head = 色块+竖线；band = 高亮条；ball = 跳跃光球（带渐变拖尾） */
export type PlayStyle = 'head' | 'band' | 'ball';

export interface PaintTheme {
  /** 深浅主题标记：光球特效用它切换「发光照亮」与「彩色点 + 阴影」两种画法 */
  dark: boolean;
  bg: string;
  ink: string;
  muted: string;
  accent: string;
  /** 所有连音弧线；浅色用赭金，深色用金黄。 */
  curve: string;
  warn: string;
  error: string;
  /** 电吹管技法记号（花舌 / 波音 / 滑音 / 弯音），惯例用红色与普通记号区分 */
  tech: string;
  /** 换气 V 与吐音 T / K：淡黄色，与红色技法区分开 */
  tongue: string;
  bar: string;
  barFinal: string;
  selected: string;
  playhead: string;
  playheadBg: string;
  /** 播放指示自定义色（withPlayColor 塞入）：光标块 / 光条 / 竖线 / 光球统一用它 */
  playColor?: string;
}

export const LIGHT_THEME: PaintTheme = {
  dark: false,
  bg: '#ffffff',
  ink: '#27272a',
  muted: '#a1a1aa',
  accent: '#a8811a',
  curve: '#8a6a12',
  warn: '#b45309',
  error: '#b91c1c',
  tech: '#c22525',
  tongue: '#a8860b',
  /* 小节线原本 #d4d4d8，在白底上只有 1.5:1，等于看不见；
     提到约 3.5:1 才看得出「这里开始新小节了」 */
  bar: '#8b8b93',
  barFinal: '#5c5c66',
  selected: '#f6e7bd',
  playhead: '#8a6a12',
  playheadBg: '#ffe9a8',
};

export const DARK_THEME: PaintTheme = {
  dark: true,
  bg: '#18181b',
  ink: '#e4e4e7',
  muted: '#71717a',
  accent: '#d9b23c',
  curve: '#d9b23c',
  warn: '#fbbf24',
  error: '#f87171',
  tech: '#f87171',
  tongue: '#e6cd5c',
  bar: '#6b6b75',
  barFinal: '#c4c4cc',
  selected: '#4a3c12',
  playhead: '#d9b23c',
  playheadBg: '#5a4715',
};

/**
 * 播放指示自定义色：把用户挑的颜色**只**注入光标块 / 高亮条 / 竖线 / 光球的用色，
 * 谱面其他强调色（弧线 / 括号 / 焦点框 / 小节线高亮）仍用主题 accent——
 * 改的是「跟唱笔」的颜色，不是整张谱的配色。
 *
 * **深浅背景各存一档**（0.4.27 用户定）：同一颜色在白底和黑底上的观感差很多
 * （浅色上要偏深才压得住，深色上要偏亮才显眼），所以颜色按主题分开挑、
 * 随当前主题自动取用。color 传空 = 沿用主题默认。
 */
export function withPlayColor(theme: PaintTheme, color?: string | null): PaintTheme {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return theme;
  return {
    ...theme,
    playColor: color,
    playhead: color,
    // 光标块 / 高亮条的底色 = 自定义色的半透明版：浅底上浅淡不盖字，深底上透出亮度
    playheadBg: hexA(color, theme.dark ? 0.42 : 0.3),
  };
}

/**
 * 版式度量：由 `applyMetrics(layout.glyph)` 按谱面字号刷新。
 * 模块级可变对象是有意的——绘制在单次 paintLayout 调用里同步完成，
 * 所有函数都读同一份 M，不必把度量参数一路穿透到每个绘制函数。
 */
const M = {
  /** 谱面数字的字体（随 meta.fontSize 变） */
  font: '600 21px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
  badgeFont: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
  glyphPad: 5,
  dotR: 2.2,
  dotGap: 7,
  octaveStep: 7,
  octaveBase: 17,
  octaveClear: 5,
  beamLine: 1.1,
  beamTop: 10,
  beamStep: 3,
  barHalf: 21,
  arcBase: 24,
  arcTieBase: 19,
  selPad: 3,
  selHalfH: 12,
  caretHalf: 16,
  caretSerif: 4,
  dashW: 10,
  dashGap: 15,
  markTop: 44,
  tupletDrop: 27,
  markBottom: 34,
  /** 谱面上的字母标记（吐音 T） */
  markFont: '700 12px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
  /** 括号字符字体：与数字同字号但按墨迹等高缩小（首次绘制时测量得出） */
  parenFont: '',
  /** parenFont 对应的数字字体串，用于失效判断 */
  parenFontFor: '',
  /** 每颗倚音占的横向宽度（随字号缩放） */
  graceW: 13,
  /** 相对 21px 基准的缩放系数，绘制层做少量比例换算用 */
  k: 1,
  /** 倚音：明显小一号的数字（约主音的 0.57 倍），才读得出是装饰音 */
  graceFont: '600 12px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
  /** 变音记号 ♯ ♭ ♮：比数字小一号，才像标记而不像主体 */
  accFont: '600 13px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
  /** 谱面标题：比谱面字号大一档，层级靠字重而非花活 */
  titleFont: '700 28px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
  /** 标题下的居中说明行（@sub） */
  titleSubFont: '15px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
  /** 谱头左列：调号（1=C），加粗像印刷谱 */
  titleKeyFont: '700 17px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
  /** 谱头左列：拍号叠写的分子 / 分母 */
  titleBeatFont: '700 15px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
  /** 谱头左列速度与右列说明行 */
  titleInfoFont: '13px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
};

/**
 * 按排版层的度量刷新 M。字号变 → 数字字体、倚音 / 变音字号、
 * 八度点 / 减时线 / 标记行的位置全部等比跟进；
 * 标注文字（吐音 T、连音标号、标题）字号不缩，只有位置缩。
 * 必须在每次 paintLayout 开头调用。
 */
function applyMetrics(g: GlyphMetrics): void {
  const fam = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
  M.k = g.fontSize / 21;
  M.font = `600 ${g.fontSize}px ${fam}`;
  M.graceFont = `600 ${13 * M.k}px ${fam}`;
  M.accFont = `600 ${13 * M.k}px ${fam}`;
  M.graceW = g.graceW;
  M.glyphPad = g.pad;
  M.dotR = g.dotR;
  M.dotGap = g.dotGap;
  M.octaveStep = g.octaveStep;
  M.octaveBase = g.octaveBase;
  M.octaveClear = g.octaveClear;
  M.beamLine = g.beamLine;
  M.beamTop = g.beamTop;
  M.beamStep = g.beamStep;
  M.barHalf = g.barHalf;
  M.arcBase = g.arcBase;
  M.arcTieBase = g.arcTieBase;
  M.selHalfH = g.selHalfH;
  M.caretHalf = g.caretHalf;
  M.dashW = g.dashW;
  M.dashGap = g.dashGap;
  M.markTop = g.markTop;
  M.tupletDrop = g.tupletDrop;
  M.markBottom = g.markBottom;
}

interface XY {
  x: number;
  y: number;
}
interface CurveSeg {
  p0: XY;
  c: XY;
  p1: XY;
}

/**
 * 变宽度曲线：中心线沿给定贝塞尔段（与 quadraticCurveTo 完全同一形状），
 * 宽度从两端向中点渐增、两端尖灭（w = peak·(4s(1-s))^0.65，s 为弧长参数）
 * ——乐谱连线两端收细的标准画法。canvas 没有变宽描边，
 * 用「沿曲线采样 → 法线偏移出上下轮廓 → 闭合填充」实现。
 * 中段宽度 = peak，与原来的固定 lineWidth 视觉厚度一致。
 */
function fillTaperedCurve(ctx: CanvasRenderingContext2D, segs: CurveSeg[], peakW: number): void {
  if (!segs.length) return;
  // 1. 逐段采样中心点（每段 24 点，跨段共享端点）
  const PER = 24;
  const pts: XY[] = [];
  for (const s of segs) {
    for (let i = pts.length ? 1 : 0; i <= PER; i++) {
      const t = i / PER;
      const u = 1 - t;
      pts.push({
        x: u * u * s.p0.x + 2 * u * t * s.c.x + t * t * s.p1.x,
        y: u * u * s.p0.y + 2 * u * t * s.c.y + t * t * s.p1.y,
      });
    }
  }
  // 2. 累计弧长 → 宽度函数
  const n = pts.length;
  const cum = new Array<number>(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const total = cum[n - 1] || 1;
  // 3. 法线偏移出上下轮廓（端点宽度 0，自然尖灭）
  const left: XY[] = [];
  const right: XY[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const s = cum[i] / total;
    const h = (peakW * Math.pow(4 * s * (1 - s), 0.65)) / 2;
    const nx = (-dy / len) * h;
    const ny = (dx / len) * h;
    left.push({ x: pts[i].x + nx, y: pts[i].y + ny });
    right.push({ x: pts[i].x - nx, y: pts[i].y - ny });
  }
  ctx.beginPath();
  ctx.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(left[i].x, left[i].y);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
  ctx.closePath();
  ctx.fill();
}

/**
 * 括号字符字体：与数字**同锚点、同排**绘制，但括号字形天然比数字高
 * （上下都伸出），按墨迹测量把字号缩到括号墨迹高度与数字一致——
 * 字形仍是正常的 ( ) 字符，只是等高。每种数字字体只测一次。
 * 环境不支持墨迹测量时退回经验缩放。
 */
function parenFont(ctx: CanvasRenderingContext2D): string {
  if (M.parenFontFor === M.font) return M.parenFont;
  const prev = ctx.font;
  ctx.font = M.font;
  const p = ctx.measureText('(');
  const d = ctx.measureText('0');
  ctx.font = prev;
  let scale = 0.78;
  if (p.actualBoundingBoxAscent !== undefined) {
    const ph = p.actualBoundingBoxAscent + p.actualBoundingBoxDescent;
    const dh = d.actualBoundingBoxAscent + d.actualBoundingBoxDescent;
    if (ph > 0 && dh > 0) scale = dh / ph;
  }
  // 注意不能用 parseFloat(M.font)：字体串以字重开头（"600 21px …"），
  // 会把 600 当成字号。必须取 px 前的数值
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(M.font)?.[1] ?? 21);
  M.parenFont = `600 ${(size * scale).toFixed(2)}px ${M.font.replace(/^.*?px\s+/, '')}`;
  M.parenFontFor = M.font;
  return M.parenFont;
}

/** 基准（21px 字号）的点半径 / 底色块半高，仅供测试与外部参考 */
export const DOT_R = M.dotR;
/** 底色块半高。减时线在 beamOffset(1) 处，两者不能重叠 */
export const SEL_HALF_H = M.selHalfH;

/** 「字形簇」的横向宽度与左缘统一由 layout.clusterSpan 提供（含变音 / 倚音位移） */

/**
 * 音符「被选中 / 点亮 / 播放到」时那个框的位置与宽度。
 *
 * 必须和命中感知区（layout.nominalInk）覆盖同一段范围：
 * 框画得比可点区域宽的话，用户照着框去点它的右半边会被判成「点在空隙里」，
 * 于是就有「明明点的是一整个音，却进了插入模式」这种对不上的感觉。
 *
 * 基准是**字形**而不是格子左缘：变音记号与前倚音都把字形整体推右了，
 * 不减掉这段位移，框就画在倚音小音符上（实测踩到过）。
 */
function noteBox(
  ctx: CanvasRenderingContext2D,
  it: PlacedItem,
): { x: number; w: number } {
  // 噪音符（无音高音符）：国标 §6.3.6 的字形是 ×（乘号形），不是字母 X；
  // DSL 输入仍写 X/x，谱面画 ×（noteBox 量宽与 drawGlyph 画字两处同口径）
  const glyph = it.kind === 'rest' ? (it.xnote ? '×' : '0') : String(it.degree ?? 0);
  // 口径统一走 layout.clusterSpan（含变音 / 倚音位移），左右各留 3px 不切附点
  const span = clusterSpan(it, ctx.measureText(glyph).width);
  return { x: span.x - 3, w: span.w + 6 };
}

/** 第 level 级减时线相对中线的下移量 */
export function beamOffset(level: number): number {
  return M.beamTop + (level - 1) * M.beamStep;
}

/**
 * 低八度点相对中线的下移量：落在最下面一条减时线之下。
 * 没有减时线时回到常规位置，避免无谓地下坠。
 */
export function lowDotOffset(beams: number): number {
  return beams > 0 ? beamOffset(beams) + M.octaveClear : M.octaveBase;
}

export interface PaintOptions {
  selectedIds?: ReadonlySet<string>;
  /** 光标位置（已由调用方换算成画布坐标） */
  caret?: { x: number; y: number } | null;
  /** 播放头：当前发声的事件 + 其内部进度 0..1 */
  playhead?: { eventId: string; frac: number } | null;
  playheads?: { eventId: string; frac: number }[];
  /** 属性检查器正在编辑的事件，整块点亮（含附点 / 增时线 / 八度点） */
  focusId?: string | null;
  /**
   * KTV 式**入拍提醒**：前奏期间（播放头还在谱面第 0 拍之前）在即将进入的
   * 第一个音上闪烁 + 倒数拍数，回答「什么时候进」。
   * pulse 由调用方按帧给出 0..1（正弦即可，画布每帧重绘）。
   */
  cue?: { eventId: string; beatsLeft: number; pulse: number } | null;
  /** 播放指示方式，默认 head（跳动的色块 + 竖线）；band = 行进度条 */
  playStyle?: PlayStyle;
  /**
   * 播放光球（playStyle = 'ball' 时由 ScoreCanvas 逐帧计算传入）：
   * x/y = 球心（抛物线轨迹上），r = 半径，hot = 落地照亮强度 0..1，
   * alpha = 透明度 0..1（曲末余跳渐隐用，缺省 1），
   * trail = 最近若干帧的位置（渐变拖尾）。
   */
  ball?:
    | { x: number; y: number; r: number; hot: number; alpha?: number; trail: { x: number; y: number }[] }
    | null;
  /** 小节线下方是否画小节号（曲目信息面板的开关，缺省显示） */
  showMeasureNumbers?: boolean;
  /** 编辑时显示强制换行/分页标记。 */
  showBreaks?: boolean;
  /** 导出时隐藏曲目信息设置按钮。 */
  showTitleEdit?: boolean;
  /**
   * **对轨配对中**：波形上已点好节奏线，等你点一根小节线。
   * 此时每根小节线都画上金色的绑定靶标（顶端圆钮 + 加粗的一小截），
   * 悬停的那根再整条点亮并加光环——一眼看出「点这里就绑上了」。
   */
  pairing?: boolean;
  /** 配对中鼠标正压着的那根线（eventId，或 SCORE_START_ID） */
  pairingHoverId?: string | null;
  /**
   * 配对中且谱面开头**没有**小节线 → 在最左端画一个「开头」靶标。
   * 简谱开头不画竖线（小节线是分隔不是边界），但要给「谱面第 0 拍」一个
   * 可点的目标，否则点了音频最前面的节奏点却没处点。
   */
  pairingStart?: boolean;
  /** 画布实际高度，用于底色填充 */
  height?: number;
}

export function paintLayout(
  ctx: CanvasRenderingContext2D,
  layout: LayoutResult,
  theme: PaintTheme,
  opts: PaintOptions = {},
): void {
  // 度量随排版结果走：谱面字号变了，绘制层的所有比例都跟着 layout 的那套来
  applyMetrics(layout.glyph);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, layout.width, opts.height ?? layout.height);

  ctx.font = M.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  if (layout.title) paintTitle(ctx, layout.title, theme, opts.showTitleEdit !== false);

  for (const system of layout.systems ?? []) {
    if (!layout.lines.some((line) => line.index >= system.from && line.index < system.to)) continue;
    const top = system.top + layout.lineHeight / 2 - M.barHalf;
    const bottom = system.bottom - layout.lineHeight / 2 + M.barHalf;
    const x = system.bracketX;
    const k = M.k;
    // 连谱号高亮：焦点小节线 = 本系统行前那根线（点连谱号选中的就是它）。
    // 焦点色把粗竖线与细竖线一起点亮，和选中小节线的反馈同一套语言
    const bracketHot =
      !!opts.focusId &&
      layout.lines
        .slice(system.from, system.to)
        .some((ln) => ln.leadingBarlineId === opts.focusId);
    ctx.fillStyle = bracketHot ? theme.accent : theme.ink;
    // 重奏连谱号：粗竖线的两端向右弯出尖钩，右侧另配一条细竖线。
    ctx.beginPath();
    ctx.moveTo(x + 8 * k, top - 5 * k);
    ctx.bezierCurveTo(x + 5 * k, top, x - 1.5 * k, top, x - 1.5 * k, top + 5 * k);
    ctx.lineTo(x - 1.5 * k, bottom - 5 * k);
    ctx.bezierCurveTo(x - 1.5 * k, bottom, x + 5 * k, bottom, x + 8 * k, bottom + 5 * k);
    ctx.bezierCurveTo(x + 6 * k, bottom - 1 * k, x + 1.5 * k, bottom - 2 * k, x + 1.5 * k, bottom - 6 * k);
    ctx.lineTo(x + 1.5 * k, top + 6 * k);
    ctx.bezierCurveTo(x + 1.5 * k, top + 2 * k, x + 6 * k, top + 1 * k, x + 8 * k, top - 5 * k);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = bracketHot ? theme.accent : theme.ink;
    ctx.lineWidth = bracketHot ? 1.6 * Math.max(1, k) : k;
    ctx.beginPath();
    ctx.moveTo(x + 4 * k, top);
    ctx.lineTo(x + 4 * k, bottom);
    ctx.stroke();
  }

  /**
   * 焦点是小节线时记下它的中心 x 与所在系统：多声部里同一小节边界的
   * 小节线 x 相同（重奏共用绝对坐标），各声部的这根线要一起点亮——
   * 只亮第一声部会让用户以为点错了（用户实测反馈）。
   */
  let focusBarX: number | null = null;
  let focusBarSystem: number | null = null;
  if (opts.focusId) {
    for (const line of layout.lines) {
      for (const it of line.items) {
        if (it.eventId === opts.focusId && it.kind === 'barline') {
          focusBarX = it.x + it.w / 2;
          focusBarSystem = line.system ?? null;
        }
      }
    }
  }

  for (const line of layout.lines) {
    if (line.partName) {
      ctx.font = M.titleInfoFont;
      ctx.fillStyle = theme.ink;
      ctx.textAlign = 'right';
      const bracket = layout.systems?.find((s) => line.index >= s.from && line.index < s.to)?.bracketX;
      ctx.fillText(line.partName, (bracket ?? line.items[0]?.x ?? 70) - 10 * M.k, line.y, 108 * M.k);
      ctx.textAlign = 'left';
    }
    const head = opts.playheads?.find((h) => line.items.some((it) => it.eventId === h.eventId));
    ctx.font = M.font;
    paintLine(ctx, line, theme, {
      selectedIds: opts.selectedIds,
      caret: opts.caret ?? null,
      playhead: head ?? opts.playhead ?? null,
      focusId: opts.focusId ?? null,
      cue: opts.cue ?? null,
      playStyle: opts.playStyle ?? 'head',
      showMeasureNumbers: opts.showMeasureNumbers ?? true,
      showBreaks: opts.showBreaks ?? false,
      pairing: opts.pairing ?? false,
      pairingHoverId: opts.pairingHoverId ?? null,
      pairingStart: opts.pairingStart ?? false,
      focusBarX,
      focusBarSystem,
    });
  }

  // 播放光球：最高层。深色 = 发光 + 照亮附近；浅色 = 彩色点 + 阴影拖尾
  if (opts.ball) drawPlayBall(ctx, opts.ball, theme);
}

/** #rrggbb → rgba(r,g,b,a) */
function hexA(hex: string, a: number): string {
  const n = hex.replace('#', '');
  const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  const v = parseInt(full, 16);
  const al = Math.max(0, Math.min(1, a)).toFixed(3);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${al})`;
}

/**
 * 播放光球：跟随抛物线轨迹的小球，停在 / 落在音符字形顶上。
 * 深色主题 = 光晕（globalCompositeOperation 'lighter' 叠加出「照亮附近」的感觉）；
 * 浅色主题 = 彩色点 + 阴影，**没有光晕**——白底下发光只会是一片白，
 * 光圈也会糊掉音符，阴影才既看得见又不吵。
 */
export function drawPlayBall(
  ctx: CanvasRenderingContext2D,
  b: { x: number; y: number; r: number; hot: number; alpha?: number; trail: { x: number; y: number }[] },
  theme: PaintTheme,
): void {
  // 自定义播放色优先（withPlayColor 塞进 theme.playColor），没设沿用主题默认
  const accent = theme.playColor ?? theme.accent;
  const alpha = b.alpha ?? 1; // 曲末余跳渐隐：整球（含拖尾）按 alpha 淡出
  // 拖尾：整条轨迹 polyline **分三遍**描（尾淡头浓）。不能逐段描——
  // 相邻线段的圆头在接缝处叠加，深色的 'lighter' 加法混色会把接缝
  // 亮成一串珠点（看着就是离散的点）；整条一笔内部没有任何接缝
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const n = b.trail.length;
  if (n >= 2) {
    if (theme.dark) ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = theme.dark ? accent : theme.playColor ?? '#3f3f46';
    const dy = theme.dark ? 0 : b.r * 0.7; // 浅色拖尾画在球的下前方，像落地影子
    const pass = (from: number, width: number, a: number): void => {
      if (n - from < 2) return;
      ctx.globalAlpha = a * alpha;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(b.trail[from]!.x, b.trail[from]!.y + dy);
      for (let i = from + 1; i < n; i += 1) ctx.lineTo(b.trail[i]!.x, b.trail[i]!.y + dy);
      ctx.stroke();
    };
    pass(0, b.r * 0.9, theme.dark ? 0.1 : 0.05); // 整条淡尾
    pass(Math.floor(n * 0.55), b.r * 1.15, theme.dark ? 0.18 : 0.09); // 近球半段
    pass(Math.max(0, n - 5), b.r * 1.35, theme.dark ? 0.3 : 0.14); // 球边一小截
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'source-over';
  }

  if (theme.dark) {
    // 光晕：落地段（hot→1）照亮范围更大
    const glowR = b.r * (2.0 + b.hot * 1.6);
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, glowR);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.3, hexA(accent, 0.5 + b.hot * 0.4));
    g.addColorStop(1, hexA(accent, 0));
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, glowR, 0, Math.PI * 2);
    ctx.fill();
    // 核心：白热核心
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // 浅色：不发光，只画一个带柔和阴影的蓝色实心点（白底下发光只会一片白）
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = theme.playColor ?? '#2563eb';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1; // 渐隐后还原，别污染后续绘制
}

/** 简谱与五线谱共用谱头，字号跟随同一套版式度量。 */
export function paintScoreTitle(ctx: CanvasRenderingContext2D, t: LayoutTitle, glyph: GlyphMetrics, theme: PaintTheme, showEdit: boolean): void {
  applyMetrics(glyph);
  ctx.save();
  ctx.textBaseline = 'middle';
  paintTitle(ctx, t, theme, showEdit);
  ctx.restore();
}

/**
 * 调号文字里的升降号用**乐理记号**画：`1=bB` 的 b 画成小一号的 ♭、抬到字母左上，
 * 与谱面音符的变音记号同款式——直接印 ASCII 的 b / # 与谱面记号视觉割裂，
 * 用户实测「不专业」。返回合成后的总宽度（拍号的起点依赖它）。
 */
function paintTitleKey(ctx: CanvasRenderingContext2D, key: string, x: number, y: number): number {
  const m = /^(1\s*=\s*)([#b♯♭]?)([A-G])([#b♯♭]?)$/.exec(key);
  if (!m) {
    ctx.fillText(key, x, y);
    return ctx.measureText(key).width;
  }
  const fam = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
  ctx.fillText(m[1], x, y);
  let cx = x + ctx.measureText(m[1]).width;
  let w = ctx.measureText(m[1]).width;
  const acc = m[2] || m[4];
  if (acc) {
    ctx.save();
    ctx.font = `700 12px ${fam}`;
    const glyph = acc === '#' || acc === '♯' ? '♯' : '♭';
    ctx.fillText(glyph, cx, y - 5);
    w += ctx.measureText(glyph).width;
    cx += ctx.measureText(glyph).width;
    ctx.restore();
  }
  ctx.fillText(m[3], cx, y);
  return w + ctx.measureText(m[3]).width;
}

function paintTitle(ctx: CanvasRenderingContext2D, t: LayoutTitle, theme: PaintTheme, showEdit: boolean): void {
  ctx.fillStyle = theme.ink;
  // 中：标题（大字居中）+ 说明行
  ctx.textAlign = 'center';
  ctx.font = M.titleFont;
  ctx.fillText(t.title, t.centerX, t.y);
  if (t.sub) {
    ctx.font = M.titleSubFont;
    ctx.fillText(t.sub, t.centerX, t.subY);
  }
  // 左：调号 + 拍号（叠成分数）+ 速度，两行
  ctx.textAlign = 'left';
  ctx.font = M.titleKeyFont;
  const keyW = paintTitleKey(ctx, t.key, t.leftX, t.colY + 6);
  const [num, den] = t.beat.split('/');
  if (num && den) {
    // 拍号叠写：分子在上、分母在下（简谱惯例，如图示 4/4）。
    // 分数线显式画并与数字同色（靠两数字自然贴近会出字体伪影）；
    // 位置按实测字形边界取正中——不同字体的数字上伸/下延不一样，
    // 拿基线硬算会贴住其中一个数字
    const bx = t.leftX + keyW + 10;
    ctx.font = M.titleBeatFont;
    const nm = ctx.measureText(num);
    const dm = ctx.measureText(den);
    const numY = t.colY - 4;
    const denY = t.colY + 16;
    ctx.fillText(num, bx, numY);
    // 分子字形底边（= 其基线）到分母字形顶边的中点
    const barY = (numY + denY - dm.actualBoundingBoxAscent) / 2;
    ctx.fillRect(bx, barY - 0.75, Math.max(nm.width, dm.width), 1.5);
    ctx.fillText(den, bx, denY);
  }
  ctx.font = M.titleInfoFont;
  ctx.fillText(t.tempo, t.leftX, t.tempoY);
  // 右：说明行，右对齐（最多 4 行）
  ctx.textAlign = 'right';
  t.rightLines.forEach((line, i) => {
    ctx.fillText(line, t.rightX, t.colY + 4 + i * t.rowH);
  });
  // 齿轮用强调色而不是灰：它是个可点的按钮（打开曲目信息，字号 / 字间距在里面），
  // 灰色看起来像装饰，用户找不到谱面字号在哪改
  if (showEdit) paintGear(ctx, t.edit.cx, t.edit.cy, t.edit.size, theme.accent);
  // 复位：ctx 是本行共享的，别把居中对齐泄漏给谱面
  ctx.font = M.font;
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.ink;
}

/**
 * 标题旁的齿轮（打开曲目信息设置）。
 * 用几何图形画而不是写 emoji——齿轮字符不是每个系统字体都有。
 */
function paintGear(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  const r = size / 2 - 1;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  // 8 根短辐条当齿
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r * 0.68, cy + Math.sin(a) * r * 0.68);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }
  // 齿圈 + 中心轴孔
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.68, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.26, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = 'butt';
}

/**
 * 绑定靶标：顶端金色圆钮 + 线头加粗的一小截；hot = 鼠标压着的那根，
 * 整条点亮并加一圈光环——点下去绑的就是它。
 * 小节线与「谱面开头」共用这一个画法：交互一致才不用记两套操作。
 */
function paintBindTarget(
  ctx: CanvasRenderingContext2D,
  bx: number,
  y: number,
  theme: PaintTheme,
  hot: boolean,
): void {
  ctx.save();
  ctx.strokeStyle = theme.accent;
  ctx.fillStyle = theme.accent;
  ctx.lineCap = 'round';
  ctx.lineWidth = hot ? 3.5 : 2.5;
  ctx.beginPath();
  ctx.moveTo(bx, y - M.barHalf);
  ctx.lineTo(bx, y - M.barHalf + 11 * M.k);
  ctx.stroke();
  const knobY = y - M.barHalf - 7 * M.k;
  ctx.beginPath();
  ctx.arc(bx, knobY, (hot ? 4.6 : 3.2) * M.k, 0, Math.PI * 2);
  ctx.fill();
  if (hot) {
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(bx, knobY, 8 * M.k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(bx, y - M.barHalf);
    ctx.lineTo(bx, y + M.barHalf);
    ctx.stroke();
  }
  ctx.restore();
}

interface LinePaint {
  selectedIds: ReadonlySet<string> | undefined;
  caret: { x: number; y: number } | null;
  playhead: { eventId: string; frac: number } | null;
  focusId: string | null;
  /** KTV 式入拍提醒（前奏期间闪烁 + 倒数） */
  cue: { eventId: string; beatsLeft: number; pulse: number } | null;
  /** 播放指示方式：head = 跟着音符跳的色块 + 竖线；band = 从行首生长的高亮条；ball = 跳跃光球 */
  playStyle: PlayStyle;
  /** 小节号开关（缺省显示） */
  showMeasureNumbers: boolean;
  showBreaks: boolean;
  /** 对轨配对中：小节线画成绑定靶标 */
  pairing: boolean;
  /** 配对中鼠标压着的那根线 */
  pairingHoverId: string | null;
  /** 配对中且**谱面开头没有小节线**：在最左端补一个「开头」靶标（第 0 拍） */
  pairingStart: boolean;
  /**
   * 焦点小节线的时间点（中心 x + 所在系统）：多声部里各声部同一小节边界的
   * 小节线 x 相同，用它们点亮全部声部的这根线（见 paintLayout 的注释）。
   */
  focusBarX: number | null;
  focusBarSystem: number | null;
}

/**
 * 拍号记号（叠写的分子 / 分母 + 中间横线），居中画在 x 上。
 * 两处共用：小节线右侧（常规）、小节第一颗音左侧（该小节线在行末时）。
 */
function drawMeterMark(
  ctx: CanvasRenderingContext2D,
  meter: string,
  x: number,
  y: number,
  theme: PaintTheme,
): void {
  const [num, den] = meter.split('/');
  ctx.font = M.markFont;
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.ink;
  ctx.fillText(num, x, y - 8 * M.k);
  ctx.fillText(den, x, y + 8 * M.k);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = Math.max(1, M.k);
  const half = Math.max(ctx.measureText(num).width, ctx.measureText(den).width) / 2 + 2 * M.k;
  ctx.beginPath();
  ctx.moveTo(x - half, y);
  ctx.lineTo(x + half, y);
  ctx.stroke();
  ctx.textAlign = 'left';
}

function paintLine(
  ctx: CanvasRenderingContext2D,
  line: LayoutLine,
  theme: PaintTheme,
  o: LinePaint,
): void {
  const { selectedIds, caret, playhead, focusId } = o;
  const y = line.y;
  const headItem = playhead ? line.items.find((it) => it.eventId === playhead.eventId) : undefined;

  // ── 底色层 ──
  // 选中 / 焦点 / 播放头都是「底色」，必须画在减时线与字形之前。
  // 否则底色会盖住减时线：两个八分音符被选中时，那根本该连着的横线
  // 只在色块缝隙里剩一小截，看起来像根本没画。
  if (selectedIds && selectedIds.size > 0) {
    ctx.fillStyle = theme.selected;
    for (const it of line.items) {
      if (!selectedIds.has(it.eventId)) continue;
      if (it.kind === 'barline') continue;
      const b = noteBox(ctx, it);
      roundRect(ctx, b.x, y - M.selHalfH, b.w, M.selHalfH * 2, 6);
      ctx.fill();
    }
  }

  // 焦点音符：把整个字形簇点亮，回答「正在编辑谁」。
  // 光靠一条竖线分不清是在编辑前一个音还是后一个音。
  if (focusId) {
    for (const it of line.items) {
      if (it.eventId !== focusId) continue;
      if (it.kind !== 'note' && it.kind !== 'rest') continue;
      const b = glyphBox(ctx, it, y);
      ctx.fillStyle = theme.selected;
      roundRect(ctx, b.x, b.top, b.w, b.bottom - b.top, 6);
      ctx.fill();
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // 播放指示
  if (headItem) {
    // 播放头框用**时值格宽**（it.x / it.w）而不是字形宽：长音（四拍的 0）的块
    // 与其时长相称，多声部同一时刻各声部的块覆盖同一段时间、齐头并进——
    // 用字形宽的话块长短只跟字形走，声部之间参差不齐。选中 / 焦点框仍用
    // noteBox（那里必须与命中感知区一致，见 noteBox 的注释）
    const b = { x: headItem.x, w: headItem.w };
    const px = playbackX(headItem, playhead?.frac ?? 0);
    if (o.playStyle === 'band') {
      // 行进度条：从行首生长到播放位置，宽度随节奏变化。
      // 比跳动的色块更好跟——一块连续变宽的区域，余光就能看见进度
      const x0 = (line.items[0]?.x ?? b.x) - 8;
      if (px > x0) {
        ctx.fillStyle = theme.playheadBg;
        roundRect(ctx, x0, y - M.selHalfH, px - x0, M.selHalfH * 2, 6);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = theme.playheadBg;
      roundRect(ctx, b.x, y - M.selHalfH, b.w, M.selHalfH * 2, 6);
      ctx.fill();
    }
  }

  // KTV 式入拍提醒：前奏还在放、谱面第一个音马上要进——在它身上闪烁并倒数。
  // 没有这个提示时，前奏一结束音符就「凭空开始」，眼睛根本来不及落上去
  if (o.cue) {
    for (const it of line.items) {
      if (it.eventId !== o.cue.eventId) continue;
      if (it.kind !== 'note' && it.kind !== 'rest') continue;
      const b = glyphBox(ctx, it, y);
      const p = Math.max(0, Math.min(1, o.cue.pulse));
      ctx.save();
      ctx.globalAlpha = 0.18 + 0.5 * p;
      ctx.fillStyle = theme.accent;
      roundRect(ctx, b.x - 5, b.top - 5, b.w + 10, b.bottom - b.top + 10, 8);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      // 还差几拍：整拍倒数（4 / 3 / 2 / 1），比纯闪烁更能回答「何时进」
      ctx.fillStyle = theme.accent;
      ctx.font = '700 12px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.max(1, Math.ceil(o.cue.beatsLeft))), b.x + b.w / 2, b.top - 12);
      ctx.restore();
    }
  }

  // 配对时谱面开头的「第 0 拍」靶标：画在第一行最左端，与小节线同一套画法
  if (o.pairing && o.pairingStart && line.index === 0) {
    const first = line.items[0];
    paintBindTarget(ctx, (first?.x ?? 0) - 6, y, theme, o.pairingHoverId === SCORE_START_ID);
    ctx.save();
    ctx.font = M.badgeFont;
    ctx.fillStyle = theme.accent;
    ctx.textAlign = 'center';
    ctx.fillText('开头', (first?.x ?? 0) - 6, y - M.barHalf - 18 * M.k);
    ctx.restore();
  }

  // ── 记号层 ──
  // 小节线
  for (let bi = 0; bi < line.items.length; bi += 1) {
    const it = line.items[bi];
    // 隐藏小节线（|*）：占位宽度照算、小节号计数照常，线与小节号都不画
    if (it.kind !== 'barline' || it.hidden) continue;
    const bx = it.x + it.w / 2;
    // 选中的小节线要看得出来选的是哪一根：整条线换成强调色并加粗，
    // 再在线外圈一层淡色底（属性面板此刻改的就是它）。
    // 多声部：同一时间点（同 x）的各声部小节线一起点亮
    const sameTimePoint =
      o.focusBarX !== null &&
      o.focusBarSystem === line.system &&
      Math.abs(it.x + it.w / 2 - o.focusBarX) < 2;
    const picked =
      o.focusId === it.eventId ||
      (selectedIds?.has(it.eventId) ?? false) ||
      sameTimePoint;
    if (picked) {
      ctx.save();
      ctx.fillStyle = theme.selected;
      roundRect(ctx, bx - 5 * M.k, y - M.barHalf, 10 * M.k, M.barHalf * 2, 4);
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = picked ? theme.accent : it.final ? theme.barFinal : theme.bar;
    ctx.lineWidth = picked ? 3 : it.final ? 2.5 : 1.5;
    // 虚小节线（GB/T 46845—2025 §5.2.2）：混合拍子里不拦拍感的细分线画成虚线
    ctx.setLineDash(it.dashed ? [4 * M.k, 3 * M.k] : []);
    ctx.beginPath();
    ctx.moveTo(bx, y - M.barHalf);
    ctx.lineTo(bx, y + M.barHalf);
    ctx.stroke();
    ctx.setLineDash([]);
    // 双小节反复记号（GB/T 46845—2025 §5.8.4）：左右两小节都是 % 时，
    // 记号画在这根**中间小节线**上——两条左下→右上的斜线，左右各一点；
    // 两格 % 的字形由 repeatPairAt 压掉，只画这一份
    if (repeatPairAt(line.items, bi) === 'mid') {
      ctx.strokeStyle = ctx.fillStyle = theme.ink;
      ctx.lineWidth = 1.3;
      for (const dx of [-3.5, 3.5]) {
        ctx.beginPath();
        ctx.moveTo(bx + dx - 4, y + 10);
        ctx.lineTo(bx + dx + 4, y - 10);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(bx - 11, y, 1.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx + 11, y, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    if (it.final) {
      // 终止线：细线在左、粗线在右（简谱/五线谱惯例）
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx - 4, y - M.barHalf);
      ctx.lineTo(bx - 4, y + M.barHalf);
      ctx.stroke();
    } else if (it.double) {
      // 双细线（乐段结束）：主线已是细线，左边再补一根等粗的
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx - 4, y - M.barHalf);
      ctx.lineTo(bx - 4, y + M.barHalf);
      ctx.stroke();
    }

    // 焦点小节线（**精确选中的那根**）：左侧一枚小箭头指向这条线。
    // 多声部里同一边界整列点亮（见上），箭头标出「正在编辑的值落在哪个声部」——
    // 谱中换音色是声部私有的，用户需要一眼分清改的是哪一行的音色（0.4.23）
    if (o.focusId === it.eventId) {
      ctx.save();
      ctx.fillStyle = theme.accent;
      const ax = bx - 11 * M.k;
      const r = 4.5 * M.k;
      ctx.beginPath();
      ctx.moveTo(ax + r, y);
      ctx.lineTo(ax - r * 0.7, y - r);
      ctx.lineTo(ax - r * 0.7, y + r);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 对轨配对：小节线变成「绑定靶标」
    if (o.pairing) {
      paintBindTarget(ctx, bx, y, theme, o.pairingHoverId === it.eventId);
    }

    // 小节号：小字画在小节线下方。口径与报错「第 N 小节」一致——
    // 这条线结束的是第几小节。纵向落在小节线底端与力度层之间，
    // 横向贴着线走，不会压到音符的力度记号。
    // 每 5 的倍数小节按 GB/T 46845—2025 §5.9.1 画**方框**强调（印刷谱的
    // 翻谱定位点），其余小节保持朴素小字——每颗都画框会太吵
    if (it.measure && o.showMeasureNumbers) {
      ctx.save();
      ctx.font = M.badgeFont;
      ctx.textAlign = 'center';
      const label = String(it.measure);
      const ny = y + M.barHalf + 9;
      if (it.measure % 5 === 0) {
        ctx.fillStyle = theme.muted;
        const tw = ctx.measureText(label).width;
        ctx.strokeStyle = theme.muted;
        ctx.lineWidth = 0.8;
        ctx.strokeRect(bx - tw / 2 - 4, ny - 10, tw + 8, 13);
      }
      ctx.fillStyle = theme.muted;
      ctx.fillText(label, bx, ny);
      ctx.restore();
    }

    // 反复记号：粗线 + 细线 + 两点，粗线总在**外侧**（远离反复的音乐）——
    // |: 是粗、细、点（点在右）；:| 是点、细、粗（点在左）；
    // :||: 双向反复 = 点、细、粗、细、点（粗线居中，两边都是「点在外」）
    if (it.repeat === 'both') {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(bx, y - M.barHalf);
      ctx.lineTo(bx, y + M.barHalf);
      ctx.stroke();
      ctx.lineWidth = 1;
      for (const dx of [-4, 4]) {
        ctx.beginPath();
        ctx.moveTo(bx + dx * M.k, y - M.barHalf);
        ctx.lineTo(bx + dx * M.k, y + M.barHalf);
        ctx.stroke();
      }
      ctx.fillStyle = theme.bar;
      for (const dx of [-9, 9]) {
        for (const dy of [-6, 6]) {
          ctx.beginPath();
          ctx.arc(bx + dx * M.k, y + dy * M.k, 2.2 * M.k, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (it.repeat) {
      const dir = it.repeat === 'start' ? 1 : -1;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(bx - dir * 4 * M.k, y - M.barHalf);
      ctx.lineTo(bx - dir * 4 * M.k, y + M.barHalf);
      ctx.stroke();
      ctx.fillStyle = it.final ? theme.barFinal : theme.bar;
      for (const dy of [-6, 6]) {
        ctx.beginPath();
        ctx.arc(bx + dir * 5 * M.k, y + dy * M.k, 2.2 * M.k, 0, Math.PI * 2);
        ctx.fill();
      }
      // `:|3`：遍数写在点的上方，写成 ×3
      if (it.repeat === 'end' && it.repeatTimes && it.repeatTimes > 2) {
        ctx.save();
        ctx.font = M.badgeFont;
        ctx.fillStyle = theme.muted;
        ctx.textAlign = 'center';
        ctx.fillText(`×${it.repeatTimes}`, bx - 9 * M.k, y - M.barHalf - 4);
        ctx.restore();
      }
    }
  }

  // 跳房子的括线：画在标记层之上（惯例里它是最高的那一层）
  if (line.voltas.length > 0) {
    ctx.save();
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 1.2;
    ctx.font = M.badgeFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const v of line.voltas) {
      // 括线悬在小节线上方：横线抬高到 barHalf 上方 16px，两壁下探到
      // 细线顶端上方 3px 为止——原来两壁沿小节线一路画进谱内（y+10），
      // 正好压在小节线上。遍数数字吊在横线正下方，随横线一起抬高。
      const vy = y - M.barHalf - 16;
      const wallBottom = y - M.barHalf - 3;
      ctx.beginPath();
      // 跨行延续段没有左墙，不画左钩
      if (!v.cont) {
        ctx.moveTo(v.x0, wallBottom);
        ctx.lineTo(v.x0, vy);
      } else {
        ctx.moveTo(v.x0, vy);
      }
      ctx.lineTo(v.x1, vy);
      // 右端开放（简谱惯例：长房 / 跨行房）不画右钩——横线拉到收口处为止，
      // 表示「一直演奏到 :|」；短房才两头都带钩
      if (!v.open) ctx.lineTo(v.x1, wallBottom);
      ctx.stroke();
      ctx.fillStyle = theme.ink;
      // 号码标在**第一小节靠近小节线**的地方（印刷谱惯例），
      // 居中会飘到房子中段找不到归属——单小节短房也一样靠左。
      // 斜体数字加下角点是 GB/T 46845—2025 §5.8.3.2 规定的段次序号形态
      ctx.textAlign = 'left';
      // 印刷谱的段次序号是斜体——等宽字体没有真斜体面，canvas 会合成倾斜
      ctx.font = 'italic 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`${v.numbers.join(', ')}.`, v.x0 + 6 * M.k, vy + 11);
      ctx.textAlign = 'center';
      // 非末遍房子的段尾：明确提示「唱完这里跳回反复起点」——
      // 印刷谱靠 [1] 房末尾的 :| 传达这个信息，本应用的反复段里没有它
      if (v.jump) {
        ctx.save();
        ctx.font = M.badgeFont;
        ctx.fillStyle = theme.muted;
        ctx.fillText('↩跳回', v.x1 + 3, vy + 11);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // 多小节休止（GB/T 46845—2025 §6.3.7.3）：粗横线贯穿整段小节格，
  // 两端有向下的短竖钩，段上方居中写小节数。字形在 drawGlyph 里被跳过，
  // 段里各格（multibar / 隐藏小节线 / multibarCont）在这里串成一条线
  {
    let run: { x0: number; x1: number; n: number } | null = null;
    const flush = () => {
      if (!run) return;
      ctx.save();
      ctx.strokeStyle = theme.ink;
      ctx.fillStyle = theme.ink;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(run.x0, y);
      ctx.lineTo(run.x1, y);
      // 两端下钩
      ctx.moveTo(run.x0, y);
      ctx.lineTo(run.x0, y + 5 * M.k);
      ctx.moveTo(run.x1, y);
      ctx.lineTo(run.x1, y + 5 * M.k);
      ctx.stroke();
      ctx.font = M.badgeFont;
      ctx.textAlign = 'center';
      ctx.fillText(String(run.n), (run.x0 + run.x1) / 2, y - 7 * M.k);
      ctx.restore();
      run = null;
    };
    for (const it of line.items) {
      if (it.kind === 'rest' && it.multibar) {
        flush();
        run = { x0: it.x + 3, x1: it.x + it.w - 3, n: it.multibar };
        continue;
      }
      if (!run) continue;
      // 隐藏小节线与延续小节的休止格都属于同一段；遇到别的内容收口
      if ((it.kind === 'barline' && it.hidden) || (it.kind === 'rest' && it.multibarCont)) {
        run.x1 = it.x + it.w - 3;
        continue;
      }
      flush();
    }
    flush();
  }

  // 高 / 低八度演奏记号（GB/T 46845—2025 §6.2.6）：斜体小字「8」（或 con 8）+ 虚线，
  // 高八度记号在音符上方、末端短钩朝下；低八度在下方、短钩朝上。
  // con 8（八度重复）标斜体「con 8」，虚线从文字右侧接过去；字高与普通段一致。
  // **跨行段**：结束音不在本行时虚线拉到本行末但**不画短钩**（不折角）；
  // 续行（octavaCont 标记，layout 打在每行第一个段内音上）在虚线前再记一次
  // 括号括住的「(8)」/「(con 8)」，虚线从续标记重新起步
  if (line.items.some((it) => it.octava || it.octavaCont)) {
    ctx.save();
    ctx.strokeStyle = theme.ink;
    ctx.fillStyle = theme.ink;
    ctx.textAlign = 'center';
    ctx.lineWidth = 1;
    for (const it of line.items) {
      if (it.kind !== 'note') continue;
      const kind = it.octava ?? it.octavaCont;
      if (!kind) continue;
      const con = kind === 'con-va' || kind === 'con-vb';
      const up = kind === 'va' || kind === 'con-va';
      const ly = up ? y - 48 * M.k : y + 40 * M.k;
      // 终点：作用域结束音（octavaTo / 续行的 octavaContTo）；结束音在下一行 /
      // 没写收尾时虚线拉到本行末——且不画末端短钩（段还没走完，不许折角）
      const endId = it.octava ? it.octavaTo : it.octavaContTo;
      const end = endId
        ? line.items.find((q) => q.kind === 'note' && q.eventId === endId)
        : undefined;
      const last = line.items[line.items.length - 1];
      const x0 = it.x + it.w / 2;
      const x1 = end ? end.x + end.w / 2 : last.x + last.w;
      ctx.font = `italic ${M.badgeFont}`;
      const label = it.octava ? (con ? 'con 8' : '8') : con ? '(con 8)' : '(8)';
      let dashX0 = x0;
      if (con || it.octavaCont) {
        // 文字占位比单个 8 宽（con 8 / 括号续标记）：左对齐起笔，
        // 虚线从文字右侧再起步，避免压住文字
        ctx.textAlign = 'left';
        const lx = x0 - 10 * M.k;
        ctx.fillText(label, lx, ly + 3 * M.k);
        dashX0 = lx + ctx.measureText(label).width + 4 * M.k;
        ctx.textAlign = 'center';
      } else {
        ctx.fillText(label, x0 - 9 * M.k, ly + 3 * M.k);
      }
      if (x1 > dashX0 + 2) {
        ctx.setLineDash([4 * M.k, 3 * M.k]);
        ctx.beginPath();
        ctx.moveTo(dashX0, ly);
        ctx.lineTo(x1, ly);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 短钩只画在段的真正结束音上：结束音在下一行时本行末端不折角
      if (end) {
        ctx.beginPath();
        ctx.moveTo(x1, ly);
        ctx.lineTo(x1, ly + (up ? 6 : -6) * M.k);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // 减时线（下方连线）
  ctx.lineWidth = M.beamLine;
  for (const b of line.beams) {
    ctx.strokeStyle = b.gray ? theme.muted : theme.ink;
    const by = y + M.beamTop + (b.level - 1) * M.beamStep;
    ctx.beginPath();
    ctx.moveTo(b.x0, by);
    ctx.lineTo(b.x1, by);
    ctx.stroke();
  }

  // 插入点：I 形光标（竖线 + 上下横衬线），回答「新音符落在哪儿」。
  // 竖线故意比小节线矮一截并带衬线，不会和灰色的小节线混淆。
  if (caret && Math.abs(caret.y - y) < 1) {
    const cx = Math.round(caret.x) + 0.5;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, y - M.caretHalf);
    ctx.lineTo(cx, y + M.caretHalf);
    ctx.moveTo(cx - M.caretSerif, y - M.caretHalf);
    ctx.lineTo(cx + M.caretSerif, y - M.caretHalf);
    ctx.moveTo(cx - M.caretSerif, y + M.caretHalf);
    ctx.lineTo(cx + M.caretSerif, y + M.caretHalf);
    ctx.stroke();
  }

  // 音符
  for (let mi = 0; mi < line.items.length; mi += 1) {
    const it = line.items[mi];
    if (it.kind !== 'note' && it.kind !== 'rest') continue;
    // 双小节反复的两格 %：记号已画在中间小节线上，格子本身不再画
    if (repeatPairAt(line.items, mi) !== null) continue;
    drawGlyph(ctx, it, y, theme);
  }

  // 跳转记号（L2）：𝄋 / ⊕ / To ⊕ / D.S. / D.C. / Fine —— 画在谱行上方。
  // 与换气 / 吐音同层但横向落在小节线附近，实际很少打架
  ctx.font = M.markFont;
  ctx.textAlign = 'center';
  for (const it of line.items) {
    if (it.kind !== 'jump') continue;
    const label =
      it.mark === 'segno'
        ? SEGNO_SYMBOL
        : it.mark === 'coda'
          ? '⊕'
          : it.mark === 'tocoda'
            ? 'To ⊕'
            : it.mark === 'ds'
              ? 'D.S.'
              : it.mark === 'dc'
                ? 'D.C.'
                : 'Fine';
    ctx.fillStyle = theme.ink;
    ctx.font = it.mark === 'segno' ? `${Math.round(17 * M.k)}px ${MUSIC_SYMBOL_FONT}` : M.markFont;
    ctx.fillText(label, it.x + it.w / 2, y - M.markTop);
  }
  ctx.font = M.markFont;

  // 谱中变速 / 换音色（0.4.10）：小节线上方「♩=96 · 小提琴」。
  // 用 muted 灰（与小节号同层级的辅助信息）——用户 0.4.12 实测墨色太重会抢音符的注意力；
  // 音色只写简略名（没有名字的裸号兜底「音色 N」），括号备注只留在下拉列表里
  ctx.textAlign = 'center';
  for (const it of line.items) {
    if (it.kind !== 'barline') continue;
    const parts: string[] = [];
    if (it.bpmAfter !== undefined) parts.push(`♩=${it.bpmAfter}`);
    if (it.patchAfter !== undefined) parts.push(shortInstrumentLabel(it.patchAfter) ?? `音色 ${it.patchAfter}`);
    if (!parts.length) continue;
    ctx.fillStyle = theme.muted;
    ctx.fillText(parts.join(' · '), it.x + it.w / 2, y - M.markTop);
  }
  ctx.textAlign = 'left';

  // 播放头按节奏锚点连续前进，长音内部经过增时线，最后接到下一音的拍位。
  if (headItem && playhead && o.playStyle === 'head') {
    const px = playbackX(headItem, playhead.frac);
    ctx.fillStyle = theme.playhead;
    ctx.fillRect(Math.round(px), y - M.barHalf, 2, M.barHalf * 2);
  }

  // 吐音 T/K、换气 V（淡黄）与技法记号（红色）同行排列，互不重叠：
  // 整串在音符上方居中，逐个按自身宽度推进。
  ctx.font = M.markFont;
  ctx.textAlign = 'center';
  for (let mi = 0; mi < line.items.length; mi++) {
    const it = line.items[mi]!;
    const prevItem = mi > 0 ? line.items[mi - 1] : undefined;
    const prevRight = prevItem ? prevItem.x + prevItem.w : -Infinity;
    // 转调记号：紧贴数字顶部（写法带「转」字，如 转1=#A）。
    // 技法记号行贴在音符上方 10px（墨顶 ≈ y−26），转调文字抬到 y−32k，
    // 两者各占一层不打架——演奏者要一眼看出它属于哪个音
    if (it.keyChange) {
      ctx.font = M.badgeFont;
      ctx.fillStyle = theme.muted;
      // 升降号换成乐理字符，与谱头调号、谱面变音记号同一套写法
      ctx.fillText(`转${it.keyChange.replace('#', '♯').replace('b', '♭')}`, it.x + 11 + (it.graceInk ?? 0), y - 32 * M.k);
      ctx.font = M.markFont;
    }
    const run: {
      mark: string;
      color: string;
      flip?: boolean;
      dot?: boolean;
      path?: TechniquePath;
    }[] = [];
    if (it.tongue) run.push({ mark: it.tongue, color: theme.tongue });
    if (it.staccato) run.push({ mark: '·', color: theme.ink }); // 断音 / 顿音：小圆点
    // 换气 V 不进居中的记号串：单独画在音符**左上方**——先换气，后吹奏
    const breath = (it.techniques ?? []).includes('breath');
    for (const v of it.techniques ?? []) {
      if (v === 'breath') continue;
      const g = TECHNIQUE_GLYPH[v];
      if (g) run.push({ mark: g.mark, color: theme.tech, flip: g.flip, path: g.path });
    }
    // 自定义记号：面板里打的 ≤3 个汉字 / 符号，原样写在技法后面
    if (it.custom) run.push({ mark: it.custom, color: theme.tech });
    // 延长音：弧线加弧线正下方的小圆点（对应 DSL 的 @）
    if (it.fermata) run.push({ mark: '⌒', color: theme.tech, dot: true });
    if (run.length === 0 && !breath) continue;
    // 记号行的纵向位置：**贴在音符上方、只留 5px 间距**（用户要求）。
    // 记号与数字都以 middle 基线画：数字墨顶 ≈ y − 0.35em，
    // 记号墨底 ≈ my + 0.35×12px——按这两个反推 my，间距就是 10px
    // （用户实测：贴 5px 太挤、抬 15px 又顶到连音线，取中间）。
    // 有高八度点的音，整行再上移到点之上；有转调记号的音同理
    // （转调文字已相应抬高，见上）
    const markHalf = Math.max(...run.map(r => r.path
      ? (r.path === 'bendUp' || r.path === 'bendDown' ? 6.8 : 3.6) * TECHNIQUE_PATH_SCALE[r.path]
      : 4.2), breath ? 4.2 : -Infinity) * M.k;
    const markGap = 10 * M.k; // 记号墨底与数字墨顶的净距
    let baseY = y - 0.35 * 21 * M.k - markGap - markHalf;
    if ((it.octave ?? 0) > 0) {
      const dotTop = y - M.octaveBase - ((it.octave ?? 1) - 1) * M.octaveStep - M.dotR;
      baseY = Math.min(baseY, dotTop - markGap - markHalf);
    }
    const widths = run.map((r) =>
      r.path ? 16 * M.k * TECHNIQUE_PATH_SCALE[r.path] : ctx.measureText(r.mark).width,
    );
    const total = widths.reduce((a, b) => a + b, 0) + 3 * (run.length - 1);
    let mx = it.x + 11 + (it.graceInk ?? 0) - total / 2;
    // 颤音波线（GB/T 46845—2025 §7.5.3）的终点：
    //   选区套用的颤音（后面有 trillEnd 音）→ 波浪拉到那个音的尾部；
    //   单音带增时线 → 波浪与延音线等长（数字右侧到格尾的增时线区段长）；
    //   单音无增时线 → 只标 tr，不画波浪
    let trWaveTo: number | null = null;
    let trWaveLen = 0;
    if (run.some((r) => r.mark === 'tr')) {
      const endItem = line.items.slice(mi + 1).find((q) => q.kind === 'note' && q.trillEnd);
      if (endItem) {
        trWaveTo = endItem.x + endItem.w - 6 * M.k;
      } else if ((it.techniques ?? []).includes('trill') && (it.dashes ?? 0) > 0) {
        // 延音线区段长：数字右缘（半宽 ≈7px + 5px 间距）到格尾留白 6px
        trWaveLen = Math.max(0, it.x + it.w - 6 * M.k - (it.x + 11 + (it.graceInk ?? 0) + 12 * M.k));
      }
    }
    if (breath) {
      // 换气 V：**完全在音符数字的左侧**（先换气，后吹奏）——V 的右缘贴着数字墨迹左缘外
      // 2px，同一行高不另抬高。右不压居中记号串；左边：前一个内容是音 / 休止符时要躲开，
      // 是小节线 / 跳转记号（细竖线）则允许压在线上——那样空隙太小，宁可碰线也不能盖住数字
      const vw = ctx.measureText('V').width;
      const digitLeft = it.x + 11 + (it.graceInk ?? 0) - 7 * M.k; // 数字墨迹左缘（数字半宽 ≈ 7px）
      const target = digitLeft - 2 * M.k - vw / 2;                // V 右缘 = 数字左缘 − 2px
      const runEdge = mx - vw / 2 - 4 * M.k;                      // 不压居中记号串
      const avoidNote = prevItem && prevItem.kind !== 'barline' && prevItem.kind !== 'jump';
      const floorX = avoidNote ? prevRight + 2 + vw / 2 : -Infinity;
      const vx = Math.max(Math.min(target, runEdge), floorX);
      ctx.fillStyle = theme.tongue;
      ctx.fillText('V', vx, baseY);
    }
    run.forEach((r, i) => {
      const tx = mx + widths[i] / 2;
      mx += widths[i] + 3;
      ctx.fillStyle = r.color;
      // 弧线字形压在基线以上，抬高一点才给正下方的圆点留出位置
      const my = baseY - (r.dot ? 3 : 0);
      if (r.path) {
        drawTechniquePath(ctx, tx, my, r.path, M.k);
      } else if (r.flip) {
        ctx.save();
        ctx.translate(tx, my);
        ctx.scale(1, -1);
        ctx.fillText(r.mark, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(r.mark, tx, my);
      }
      if (r.dot) {
        ctx.beginPath();
        ctx.arc(tx, baseY + 2, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      // 颤音波线（GB/T 46845—2025 §7.5.3）：tr 是记号串最后一员时，
      // 右侧接波浪延展线——选区颤音拉到 trillEnd 音的尾部，
      // 单音颤音与延音线等长；没有延音线 / 终点就不画（只标 tr）
      if (r.mark === 'tr' && i === run.length - 1) {
        const wx0 = tx + widths[i] / 2 + 2 * M.k;
        const wy = my + 1.5 * M.k;
        const waveEnd = trWaveTo ?? (trWaveLen > 0 ? wx0 + trWaveLen : null);
        if (waveEnd !== null && waveEnd > wx0 + 4) {
          const periods = Math.max(1, Math.round((waveEnd - wx0) / (7 * M.k)));
          ctx.save();
          ctx.strokeStyle = r.color;
          ctx.lineWidth = 1;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(wx0, wy);
          for (let p = 0; p < periods; p += 1) {
            const px = wx0 + p * 7 * M.k;
            ctx.quadraticCurveTo(px + 1.8 * M.k, wy - 4.5 * M.k, px + 3.5 * M.k, wy);
            ctx.quadraticCurveTo(px + 5.2 * M.k, wy + 4.5 * M.k, px + 7 * M.k, wy);
          }
          ctx.stroke();
          ctx.restore();
        }
      }
    });
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.muted;

  // 拍号记号：画在带拍号的小节线右侧。
  // 例外：本行行末那根线的拍号已挪给下一行行首（line.meterMoved），这里不画，
  // 否则同一个拍号会出现两份（行末一份 + 下一行行首一份）
  for (const it of line.items) {
    if (it.kind !== 'barline' || !it.beatAfter) continue;
    if (line.meterMoved && it === line.items[line.items.length - 1]) continue;
    drawMeterMark(ctx, it.beatAfter, it.x + it.w / 2 + 14 * M.k, y, theme);
  }
  // 散板（GB/T 46845—2025 §6.3.11.7）：拍号位置记「散」（与拍号同一槽位）。
  // 同一根线既写「散」又写「拍N/M」时以新拍号为准（拍号已占槽位），不重复画
  ctx.font = M.markFont;
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.ink;
  for (const it of line.items) {
    if (it.kind !== 'barline' || !it.freeAfter || it.beatAfter) continue;
    ctx.fillText('散', it.x + it.w / 2 + 14 * M.k, y + 1 * M.k);
  }
  if (line.leadingMeter) {
    drawMeterMark(ctx, line.leadingMeter.meter, line.leadingMeter.x, y, theme);
  }
  if (o.showBreaks) for (const it of line.items) {
    if (it.kind !== 'barline' || !it.breakAfter) continue;
    ctx.font = M.markFont.replace('12px', `${16 * M.k}px`);
    ctx.fillStyle = theme.accent;
    ctx.textAlign = 'center';
    const moved = line.meterMoved && it === line.items[line.items.length - 1];
    ctx.fillText(it.breakAfter === 'page' ? '↵页' : '↵', it.x + it.w / 2 + (it.beatAfter && !moved ? 14 * M.k : 0), y - 34 * M.k);
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = theme.muted;
  ctx.font = M.markFont;
  for (const it of line.items) {
    if (it.kind === 'directive' && it.value) {
      // 左右括号：**字符括号**画在音符左右两侧同一行，与数字同锚点、同排，
      // 不像力度 / 段落标注那样画在谱行下方——用户要的是 (6 2 2) 这种夹住音符的效果。
      // 括号字形天然比数字高，用 parenFont 测量出的等高字号绘制
      if (it.value === '(' || it.value === ')') {
        const cx = it.x + it.w / 2;
        ctx.save();
        ctx.font = parenFont(ctx);
        ctx.textAlign = 'center';
        ctx.fillStyle = theme.ink;
        ctx.fillText(it.value, cx, y);
        ctx.restore();
        continue;
      }
      ctx.fillText(it.value, it.x + 2, y + M.markBottom);
      continue;
    }
    if (it.kind !== 'note') continue;
    if (it.dynamic) ctx.fillText(it.dynamic, it.x + 11 + (it.graceInk ?? 0), y + M.markBottom);
    // 渐强 / 渐弱：扁平楔形（几何绘制，字符 〈〉 太细高），画在力度记号右边。
    // 渐强从细到粗向右张开（尖在左），渐弱相反。偏移与尺寸全按字号比例，
    // 并让开前倚音的位移——小字号下写死的像素会把楔形漂到数字外面。
    // 尺寸不能太小：实测 18k×6k 在小字号下像一根断线，认不出是渐弱符号
    if (it.hairpin) {
      const cx = it.x + (it.dynamic ? 33 : 11) * M.k + (it.graceInk ?? 0) + 13 * M.k;
      const cy = y + M.markBottom;
      ctx.strokeStyle = theme.muted;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      if (it.hairpin === 'cresc') {
        ctx.moveTo(cx - 13 * M.k, cy);
        ctx.lineTo(cx + 13 * M.k, cy - 5 * M.k);
        ctx.lineTo(cx + 13 * M.k, cy + 5 * M.k);
      } else {
        ctx.moveTo(cx + 13 * M.k, cy);
        ctx.lineTo(cx - 13 * M.k, cy - 5 * M.k);
        ctx.lineTo(cx - 13 * M.k, cy + 5 * M.k);
      }
      ctx.stroke();
    }
  }
  ctx.font = M.font;

  // 范围楔形放在力度文字下方，跨行时保留连续的开口大小。
  for (const span of line.hairpins ?? []) {
    const cy = y + M.markBottom + 14 * M.k;
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = Math.max(1.4, 1.2 * M.k);
    ctx.beginPath();
    ctx.moveTo(span.x0, cy - span.startOpen);
    ctx.lineTo(span.x1, cy - span.endOpen);
    ctx.moveTo(span.x0, cy + span.startOpen);
    ctx.lineTo(span.x1, cy + span.endOpen);
    ctx.stroke();
  }

  // 歌词在每个主音正下方，休止符和倚音不占歌词位置。
  ctx.font = M.markFont.replace('12px', `${16 * M.k}px`);
  ctx.fillStyle = theme.ink;
  const lyricY = y + (line.hairpins?.length ? 64 : 44) * M.k;
  for (const it of line.items) if (it.kind === 'note' && it.lyrics) {
    const shift = (it.graceInk ?? 0) + (it.accW ?? 0);
    // 单字中心对齐数字；词组从同一字位展开，在本音的格宽内压缩，避免覆盖下一音。
    it.lyrics.forEach((word, verse) => { if (word) ctx.fillText(word, it.x + 4 * M.k + shift, lyricY + (verse + 1) * 24 * M.k, Math.max(16 * M.k, it.w - shift - 8 * M.k)); });
  }
  ctx.font = M.font;

  ctx.strokeStyle = theme.ink;
  paintLyricLines(ctx, line.lyricLines, verse => lyricY + (verse + 1) * 24 * M.k, 16 * M.k);

  // 连线（上方弧线）。带技法记号：抬高 5px 给记号行让位；
  // 没带（layout 标记 tight）：反过来下压 5px，弧线贴着音符画——
  // 位置不再一刀切（用户实测要求）。
  // 线宽不再是常数：中段 1.5px 与原线宽一致，两端逐渐变细到尖灭
  //（弧形不变，只是描边换成了变宽度填充——乐谱连线的标准画法）
  ctx.fillStyle = theme.curve;
  for (const a of line.arcs) {
    const base = a.kind === 'tie' ? M.arcTieBase : M.arcBase;
    const ay = y - base + (a.tight ? 5 * M.k : -5 * M.k) - a.octaveUp * M.octaveStep;
    let segs: CurveSeg[];
    if (a.flat) {
      // 长连线：两端小弧 + 中间平线（冂 形）——大弧在长跨度上拱得太高，
      // 既压上方标记又笨拙。端弧的控制点取在与直线**同一高度**，
      // 弧线在接缝处的切线才是水平的，衔接才平滑（控制点偏低会有折角）。
      // 断行延续段只有**断口那一端**是平的（openStart / openEnd），
      // 另一端照常画端弧：前一段左端弧、后一段右端弧都要保留（用户实测要求）。
      const endW = Math.min(12 * M.k, (a.x1 - a.x0) / 4);
      const top = ay - a.lift;
      segs = [];
      if (!a.openStart)
        segs.push({ p0: { x: a.x0, y: ay }, c: { x: a.x0 + endW * 0.35, y: top }, p1: { x: a.x0 + endW, y: top } });
      const xs = a.openStart ? a.x0 : a.x0 + endW;
      const xe = a.openEnd ? a.x1 : a.x1 - endW;
      if (xe > xs) segs.push({ p0: { x: xs, y: top }, c: { x: (xs + xe) / 2, y: top }, p1: { x: xe, y: top } });
      if (!a.openEnd)
        segs.push({ p0: { x: a.x1 - endW, y: top }, c: { x: a.x1 - endW * 0.35, y: top }, p1: { x: a.x1, y: ay } });
    } else {
      segs = [{ p0: { x: a.x0, y: ay }, c: { x: (a.x0 + a.x1) / 2, y: ay - a.lift * 2 }, p1: { x: a.x1, y: ay } }];
    }
    fillTaperedCurve(ctx, segs, 1.5);
  }

  // 连音标号：组上方一条向下弯的弧线，**中间断开**、断口里写数字（3 / 6 …）——
  // 这才是简谱/五线谱的标准画法，数字悬在整条弧外面的画法没人这么记。
  // 两段是**同一条抛物线**在数字两侧的部分（不是两条独立的小弧）：
  // 切点处切线方向连续，延长线在弧顶相交——看起来就是一条被数字断开的弧。
  ctx.font = M.badgeFont;
  ctx.strokeStyle = theme.curve;
  ctx.lineWidth = 1.2;
  ctx.textAlign = 'center';
  for (const t of line.tuplets) {
    // low：组内没有气息 / 技法记号、也没有连线经过 → 与连线端点同高，
    // 紧挨音符（tight 连线的端点 = y − arcBase + 5k）；否则停在标记行给记号让位
    const ends = t.low ? y - M.arcBase + 5 * M.k : y - M.markTop;
    // 弧顶抬高一点（用户要求）：数字与弧线一起离开下一层的标记行，
    // 断口才对准数字的竖向中点，而不是压在数字的下半截
    const apex = ends - 12;
    const cx = (t.x0 + t.x1) / 2;
    const gap = Math.min(ctx.measureText(t.text).width / 2 + 5, (t.x1 - t.x0) * 0.3);
    ctx.fillStyle = theme.ink;
    // 抛物线 y(x)：两端 ends、顶点 apex（x 二次曲线的贝塞尔表示里 x 与参数线性，
    // 所以任意子区间都能用「中点控制点」精确重建同一条曲线）
    const half = (t.x1 - t.x0) / 2;
    const yAt = (x: number) => ends - (ends - apex) * (1 - ((x - cx) / half) ** 2);
    const seg = (xa: number, xb: number): void => {
      const ya = yAt(xa);
      const yb = yAt(xb);
      const mx = (xa + xb) / 2;
      ctx.moveTo(xa, ya);
      ctx.quadraticCurveTo(mx, 2 * yAt(mx) - (ya + yb) / 2, xb, yb);
    };
    ctx.beginPath();
    seg(t.x0, cx - gap);
    seg(cx + gap, t.x1);
    ctx.stroke();
    // 数字坐在断口正中：基线按**字形实际墨高**下推半格，
    // 弧线断口正好穿过数字竖向中点（不随字体字号漂移）
    const ascent = ctx.measureText(t.text).actualBoundingBoxAscent || 8;
    ctx.fillText(t.text, cx, apex + ascent / 2);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.muted;

  // 小节拍数校验徽标
  for (const b of line.badges) {
    ctx.fillStyle = b.level === 'error' ? theme.error : theme.warn;
    ctx.fillText(b.text, b.x + 2, y - 33);
  }

  // 复位：画布上下文是共享的，别把字号/对齐泄漏给下一行
  ctx.font = M.font;
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.ink;
  ctx.strokeStyle = theme.ink;
}

/**
 * 一个音符实际占据的矩形：横向含数字 + 附点 + 增时线，
 * 纵向把八度点也包进来。焦点框用它，保证点亮的是完整的音。
 */
function glyphBox(
  ctx: CanvasRenderingContext2D,
  it: PlacedItem,
  y: number,
): { x: number; w: number; top: number; bottom: number } {
  const { x, w } = noteBox(ctx, it);

  let top = y - M.selHalfH;
  let bottom = y + M.selHalfH;
  const oct = it.octave ?? 0;
  if (oct !== 0) {
    const dy =
      (oct > 0 ? M.octaveBase : lowDotOffset(it.beams ?? 0)) + (Math.abs(oct) - 1) * M.octaveStep;
    if (oct > 0) top = Math.min(top, y - dy - DOT_R - 3);
    else bottom = Math.max(bottom, y + dy + DOT_R + 3);
  }
  return { x, w, top, bottom };
}

/**
 * 双小节反复配对判定（GB/T 46845—2025 §5.8.4）。
 * items 里小节格与小节线交替排布：[B0][格1][B中][格2][B1]。
 *   'mid'  —— bi 是配对的**中间小节线**（左右两格都是 %、且各自外侧都不是 %），
 *             在这根线上画双小节反复记号（两条斜线）；
 *   'cell' —— mi 是配对里的 % 格，格子本身不再画单小节记号；
 *   null   —— 不在配对里（孤立 % 照常画单斜线记号）。
 * 三个以上连续 % 不配对（各格照常画单小节记号；国标双小节反复号只管两小节）。
 */
function repeatPairAt(items: PlacedItem[], i: number): 'mid' | 'cell' | null {
  const isR = (q?: PlacedItem) => !!q && q.kind === 'rest' && !!q.repeatBar;
  const isB = (q?: PlacedItem) => !!q && q.kind === 'barline';
  const it = items[i];
  if (isB(it)) {
    return isR(items[i - 1]) && isR(items[i + 1]) && !isR(items[i - 3]) && !isR(items[i + 3])
      ? 'mid'
      : null;
  }
  if (!isR(it)) return null;
  // 右配对：[本格][线][%格]，再往外（隔一根线）不是 %
  if (isB(items[i + 1]) && isR(items[i + 2]) && !isR(items[i + 4])) return 'cell';
  if (isB(items[i - 1]) && isR(items[i - 2]) && !isR(items[i - 4])) return 'cell';
  return null;
}

/**
 * 重升记号（GB/T 46845—2025 §6.2.5.1）：粗壮的 × 形交叉线。
 * 字体的 𝄪 码位在小字号下细得看不清（用户实测），这里手绘：
 * ax 是记号格左缘，y 是数字基线；大小与 13px 变音字形对齐。
 */
function drawDoubleSharp(ctx: CanvasRenderingContext2D, ax: number, y: number, k: number): void {
  const cx = ax + 4.6 * k;
  const cy = y - 8.5 * k;
  const r = 4.6 * k;
  ctx.save();
  ctx.lineWidth = 2 * k;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r);
  ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r);
  ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
  ctx.restore();
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  it: PlacedItem,
  y: number,
  theme: PaintTheme,
): void {
  // 字号由字形渲染自己负责，不依赖上一个绘制块留下的 ctx.font
  ctx.font = M.font;
  ctx.textAlign = 'left';
  // 灰显（前奏 / 间奏提示）：数字与随附的点 / 变音记号全部画成灰色
  ctx.fillStyle = it.gray ? theme.muted : theme.ink;

  // 隐藏休止（8）：占位宽度照算，一切字形（数字 / 附点 / 八度点 / 减时线）都不画
  if (it.hidden) return;
  // 多小节休止（GB/T 46845—2025 §6.3.7.3）：不画休止符字形——
  // 粗横线与数字由行级绘制（把 N 个小节的格串成一条线）
  if (it.multibar || it.multibarCont) return;
  // 小节反复号（GB/T 46845—2025 §5.8.4）：**一条**左下→右上的斜线，
  // 左右各一点，占整个小节格居中画（双小节反复记号画在中间小节线上，
  // 相邻两格 % 不再重复画——见 repeatPairAt 的行级配对）
  if (it.repeatBar) {
    const sx = it.x + it.w / 2;
    ctx.strokeStyle = ctx.fillStyle = theme.ink;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(sx - 4.5, y + 9);
    ctx.lineTo(sx + 4.5, y - 9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx - 9, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx + 9, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // 变音记号占住数字左边那一格。宽度由 layout 给（it.accW）——
  // 这里不自带常量，两处各写一个数字迟早漂移，数字就压到记号上了。
  const accW = it.accW ?? 0;
  // 琶音波状竖线占住数字**右边**那一格（宽度由 layout 给，it.arpW）——
  // 数字与附点 / 增时线之间夹一条竖向波线（用户 0.4.30 定的摆放）
  const arpW = it.arpW ?? 0;
  // 前倚音占掉的横向宽度：整个字形簇（数字 / 附点 / 增时线）都要右移
  const ink = it.graceInk ?? 0;
  if (it.accidental && accW > 0) {
    const ax = it.x + M.glyphPad + ink;
    // 变音记号画在数字**左上角**：基线比数字抬高 5px（13px 的小字
    // 正好落在数字上半格），与数字同基线会画成平行的两个主体
    if (it.accidental === 'x') {
      // 重升（GB/T 46845—2025 §6.2.5.1）：粗壮的 × 形——字体 𝄪 码位在
      // 小字号下细得看不清，手绘两条交叉粗线（端点圆头加粗）
      drawDoubleSharp(ctx, ax, y, M.k);
    } else if (it.accidental === 'bb') {
      // 重降：两个 ♭ **贴近**排——字体 𝄫 的两个 b 间距太宽，右侧那个压到数字
      ctx.font = M.accFont;
      ctx.fillText('♭', ax, y - 5 * M.k);
      ctx.fillText('♭', ax + 5 * M.k, y - 5 * M.k);
    } else {
      ctx.font = M.accFont;
      ctx.fillText(ACCIDENTAL_GLYPH[it.accidental], ax, y - 5 * M.k);
    }
    ctx.font = M.font;
  }

  const gx = it.x + M.glyphPad + accW + ink;
  // 噪音符：同 noteBox 用 ×（国标 §6.3.6 字形，DSL 仍写 X/x）
  const glyph = it.kind === 'rest' ? (it.xnote ? '×' : '0') : String(it.degree ?? 0);
  ctx.fillText(glyph, gx, y);
  const gw = ctx.measureText(glyph).width;
  const cx = gx + gw / 2;
  // 琶音（GB/T 46845—2025 §7.7）：竖向波浪线画在音符右侧、贯穿音符上下，
  // 附点 / 震音 / 增时线全部再往右让一格（arpW）
  if (it.arpeggio && arpW > 0) {
    const ax = gx + gw + arpW / 2;
    ctx.save();
    ctx.strokeStyle = it.gray ? theme.muted : theme.ink;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(ax, y - 15 * M.k);
    const periods = 3;
    const seg = (30 * M.k) / (periods * 2);
    let py = y - 15 * M.k;
    for (let i = 0; i < periods * 2; i += 1) {
      const dir = i % 2 === 0 ? 1 : -1;
      py += seg;
      ctx.quadraticCurveTo(ax + dir * 2.4 * M.k, py - seg / 2, ax, py);
    }
    ctx.stroke();
    ctx.restore();
  }
  // 震音（GB/T 46845—2025 §7.8）：数字右上角的 1–3 条斜线（左低右高），
  // 占的是数字上方右侧的空档，与附点（数字右侧中部）上下错开
  if (it.tremolo) {
    ctx.save();
    ctx.strokeStyle = it.gray ? theme.muted : theme.ink;
    ctx.lineWidth = 1.3;
    for (let i = 0; i < it.tremolo; i += 1) {
      const ty = y - 7 * M.k - i * 3.4 * M.k;
      ctx.beginPath();
      ctx.moveTo(gx + gw + arpW + 1, ty + 2.6 * M.k);
      ctx.lineTo(gx + gw + arpW + 7.5 * M.k, ty - 2.6 * M.k);
      ctx.stroke();
    }
    ctx.restore();
  }
  // 指法（GB/T 46845—2025 §7.11.5）：音符正下方的小字数字（'0'=空弦）
  if (it.fingering) {
    ctx.save();
    ctx.fillStyle = theme.muted;
    ctx.font = M.badgeFont;
    ctx.fillText(it.fingering, cx, y + 24 * M.k);
    ctx.restore();
  }

  // 附点（挂在数字右侧，含变音记号与前倚音的实际位置；有琶音时让过波线）
  if (it.dot) {
    for (let i = 0; i < it.dot; i += 1) {
      ctx.beginPath();
      ctx.arc(gx + gw + arpW + 5 + i * M.dotGap, y + 1.5, M.dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 八度点。低音点必须让开下方的减时线：
  // 减时线一级在中线下 10px（beamTop），低音点挂在最下面一条线之下 5px（lowDotOffset）。
  if (it.octave) {
    const up = it.octave > 0;
    const dy0 = up ? M.octaveBase : lowDotOffset(it.beams ?? 0);
    for (let i = 0; i < Math.abs(it.octave); i += 1) {
      const dy = dy0 + i * M.octaveStep;
      ctx.beginPath();
      ctx.arc(cx, y + (up ? -dy : dy), M.dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 增时线（5-- 的 --）：跟随所在音的灰显。
  // 位置**在音符格宽内等分铺开**：数字之后的区域均分成 dashes 格，
  // 每条线在各自的格内居中——数字→第一条线、线与线之间的间距全部均匀
  // （5--- 占一整小节时摊成 5 · - · - · -）；重奏共享拍位的 dashXs 优先
  if (it.dashes) {
    ctx.strokeStyle = it.gray ? theme.muted : theme.ink;
    ctx.lineWidth = M.beamLine;
    // 有琶音时增时线从波线右侧起步（波线占掉数字后的一格）
    const extStart = gx + gw + arpW + 5;
    const extEnd = it.x + it.w - 6 * M.k;
    // 格子太窄放不下一根线时回落到固定间距（极端密集的谱面）
    const cell = Math.max((extEnd - extStart) / it.dashes, M.dashW + 2);
    for (let i = 0; i < it.dashes; i += 1) {
      const x0 =
        it.dashXs?.[i] !== undefined
          ? it.dashXs[i] - M.dashW / 2
          : extStart + cell * i + (cell - M.dashW) / 2;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + M.dashW, y);
      ctx.stroke();
    }
  }

  // 倚音：前在左上、后在右上；弧线收到主音数字的侧边（前用左缘、后用右缘）。
  // 起点往主音方向靠一点，弧的半径才不会拉得太开。主音灰显则倚音跟着灰
  if (it.graceBefore?.length) drawGraces(ctx, it.graceBefore, it.x + 5, y, theme, false, gx - 1, it.gray);
  if (it.graceAfter?.length) {
    const n = it.graceAfter.length;
    drawGraces(
      ctx,
      it.graceAfter,
      it.x + it.w - 5 * M.k - n * M.graceW,
      y,
      theme,
      true,
      gx + gw + 1,
      it.gray,
    );
  }
}

/**
 * 倚音：主音**左上角**的小号数字 + 紧贴数字下方的两条减时线（十六分），
 * 减时线下方再一段**向上的 1/4 弧线**连到主音——不是圆滑线那种向下拱的弧。
 * 复倚音多颗并排、共享两条横线。
 */
function drawGraces(
  ctx: CanvasRenderingContext2D,
  list: GraceNote[],
  x0: number,
  y: number,
  theme: PaintTheme,
  flip: boolean,
  mainEdgeX: number,
  gray?: boolean,
): void {
  if (list.length === 0) return;
  const ink = gray ? theme.muted : theme.ink;
  ctx.font = M.graceFont;
  ctx.textAlign = 'center';
  ctx.fillStyle = ink;
  const w = M.graceW;
  /**
   * 数字中心：挂在主音左上角（全局 textBaseline='middle' 被继承，gy 是**墨迹中心**）。
   * 高度卡在两个约束之间：**向下避开连音线弧**（弧端从音符边缘 y−29 起向上拱
   * ——arcBase 24 又整体抬了 5px，数字墨顶必须低于它）又**向上不压主音字形**
   * （主音墨顶 ≈ y−7.4）。
   * 13 号字（墨半高 ≈ 4.55k）：普通倚音 y−15（用户实测整体下移 3px），
   * 墨顶 y−19.6，与弧线净空 ≈9.4px，墨底距主音字形顶 ≈3.1px；
   * **低音倚音**（带 v 点）下方还要容纳低音点 + 弧线两层，
   * 整体比普通倚音再抬高 4px（y−19）给它们让位。
   * 减时线挂在**数字墨底之下至少 1px**：墨底 ≈ gy + 0.38×字号，
   * 偏移量随字号算出来（不能写死 gy+5——字号一大数字就压线）。
   */
  const hasLow = list.some((g) => g.octave < 0);
  const gy = y - (hasLow ? 19 : 15);
  const beamDy = 13 * M.k * 0.38 + 1;
  list.forEach((g, i) => {
    const cx = x0 + i * w + w / 2;
    const acc = g.accidental ? ACCIDENTAL_GLYPH[g.accidental] : '';
    ctx.fillText(`${acc}${g.degree}`, cx, gy);
    if (g.octave > 0) {
      // 高八度点跟在倚音自己的上方
      for (let k = 0; k < g.octave; k += 1) {
        ctx.beginPath();
        ctx.arc(cx, gy - 11 - k * 6, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (g.octave < 0) {
      // 低八度点画在减时线下方 3px（贴紧第二条线，给下面的弧线让位），
      // 间距与高音点一致（6px）。
      // 此前漏了这一支——低音倚音（如低音 6）的下加点从来没画出来过
      for (let k = 0; k < -g.octave; k += 1) {
        ctx.beginPath();
        ctx.arc(cx, gy + beamDy + 7 + k * 6, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });

  // 两条减时线：第一条在数字墨底下 1px，第二条再往下 3px（线宽与主谱减时线一致）
  ctx.strokeStyle = ink;
  ctx.lineWidth = M.beamLine;
  const span = list.length * w - 3;
  const bx = x0 + 1.5;
  const by = gy + beamDy;
  for (let k = 0; k < 2; k += 1) {
    ctx.beginPath();
    ctx.moveTo(bx, by + k * 3);
    ctx.lineTo(bx + span, by + k * 3);
    ctx.stroke();
  }

  // 连接主音的那段弧，画的是**圆的四分之一**：
  //   前倚音 = 圆的左下角（从倚音下方起笔下行，再向右收平，接到主音左下角）
  //   后倚音 = 圆的右下角（镜像）
  // 弧的顶端（切向竖直那一端）对准**倚音组的横向中心**，减时线紧贴它——
  // 数字、减时线、弧三者一条线，看着才是一体的装饰音。
  const sx = x0 + (list.length * w) / 2;
  // 起笔高度：普通倚音 = 减时线下方 2px；低音倚音 = 低音点（gy+beamDy+7 起，
  // 点径 1.6）下方 0.4px——点与弧线各占一条通道，不再叠在一起
  const sy = gy + beamDy + (hasLow ? 9 : 5);
  const ey = y - 3; // 收笔高度：主音左下 / 右下（抬得比数字底高一点，弧更紧凑）
  const rx = Math.abs(mainEdgeX - sx);
  // 低音倚音（v 点占掉弧线起点下方的空间）时 sy 会贴到甚至越过 ey，
  // ry ≤ 0 弧线就整个消失（实测：低音音符的倚音画不出下面的弧线）——
  // 弧高钳到最小 2.5px，保证任何情况下都画得出来
  const ry = Math.max(2.5, ey - sy);
  if (rx > 1.5) {
    ctx.strokeStyle = theme.curve;
    ctx.beginPath();
    if (flip) {
      // 圆的右下角：从下面的点（水平切向）转到右边的点（竖直切向）
      ctx.ellipse(mainEdgeX, sy, rx, ry, 0, Math.PI / 2, 0, true);
    } else {
      // 圆的左下角：从左边的点（竖直切向）转到下面的点（水平切向）
      ctx.ellipse(mainEdgeX, sy, rx, ry, 0, Math.PI, Math.PI / 2, true);
    }
    ctx.stroke();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
