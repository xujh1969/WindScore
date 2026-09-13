/**
 * 绘制（§7.1 paint 层）：只吃 LayoutResult 的坐标，不认识 Score。
 * 将来换 SVG 后端时新增 paintSvg.ts，layout.ts 与交互逻辑一行不改。
 *
 * 竖向度量统一收在这里，改版式只动这一组常量。
 */

import {
  clusterSpan,
  type GlyphMetrics,
  type LayoutLine,
  type LayoutResult,
  type LayoutTitle,
  type PlacedItem,
} from './layout';
import type { Accidental, GraceNote } from './types';

/** 数据值 → 谱面字形（属性面板的按钮也用这一份，避免两处各写一套） */
export const ACCIDENTAL_GLYPH: Record<Accidental, string> = { '#': '♯', b: '♭', '♮': '♮' };

/**
 * 电吹管技法记号：数据值 → 谱面字形。
 * DSL 后缀字母见 dsl.ts 的 TECHNIQUE_LETTER，两处通过数据值（键）对应。
 * flip = 上下翻转（下波音就是上波音倒过来）。
 */
export const TECHNIQUE_GLYPH: Record<
  string,
  { mark: string; label: string; flip?: boolean }
> = {
  breath: { mark: 'V', label: '换气' },
  trill: { mark: 'tr', label: '颤音' },
  flutter: { mark: '*', label: '花舌' },
  da: { mark: '扌', label: '打音' },
  mordentUp: { mark: '≈', label: '上波音' },
  mordentDown: { mark: '≈', label: '下波音', flip: true },
  slideUp: { mark: '↑', label: '上滑音' },
  slideDown: { mark: '↓', label: '下滑音' },
  bendUp: { mark: '↗', label: '前弯音' },
  bendDown: { mark: '↘', label: '后弯音' },
};

export interface PaintTheme {
  bg: string;
  ink: string;
  muted: string;
  accent: string;
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
}

export const LIGHT_THEME: PaintTheme = {
  bg: '#ffffff',
  ink: '#27272a',
  muted: '#a1a1aa',
  accent: '#a8811a',
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
  bg: '#18181b',
  ink: '#e4e4e7',
  muted: '#71717a',
  accent: '#d9b23c',
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
  octaveClear: 7,
  beamLine: 1.6,
  beamTop: 15,
  beamStep: 5.5,
  barHalf: 21,
  arcBase: 24,
  arcTieBase: 19,
  selPad: 3,
  selHalfH: 14,
  caretHalf: 16,
  caretSerif: 4,
  dashW: 10,
  dashGap: 15,
  markTop: 44,
  tupletDrop: 27,
  markBottom: 34,
  /** 谱面上的字母标记（吐音 T） */
  markFont: '700 12px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
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
  /** 标题下的调号 / 拍号 / 速度，数字走等宽 */
  titleSubFont: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
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
  M.graceFont = `600 ${12 * M.k}px ${fam}`;
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
  const glyph = it.kind === 'rest' ? '0' : String(it.degree ?? 0);
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
  /** 属性检查器正在编辑的事件，整块点亮（含附点 / 增时线 / 八度点） */
  focusId?: string | null;
  /** 播放指示方式，默认 head（跳动的色块 + 竖线）；band = 行进度条 */
  playStyle?: 'head' | 'band';
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

  if (layout.title) paintTitle(ctx, layout.title, theme);

  for (const line of layout.lines) {
    paintLine(ctx, line, theme, {
      selectedIds: opts.selectedIds,
      caret: opts.caret ?? null,
      playhead: opts.playhead ?? null,
      focusId: opts.focusId ?? null,
      playStyle: opts.playStyle ?? 'head',
    });
  }
}

function paintTitle(ctx: CanvasRenderingContext2D, t: LayoutTitle, theme: PaintTheme): void {
  ctx.textAlign = 'center';
  ctx.font = M.titleFont;
  ctx.fillStyle = theme.ink;
  ctx.fillText(t.title, t.centerX, t.y);
  ctx.font = M.titleSubFont;
  ctx.fillStyle = theme.muted;
  ctx.fillText(t.subtitle, t.centerX, t.subY);
  // 齿轮用强调色而不是灰：它是个可点的按钮（打开曲目信息，字号 / 字间距在里面），
  // 灰色看起来像装饰，用户找不到谱面字号在哪改
  paintGear(ctx, t.edit.cx, t.edit.cy, t.edit.size, theme.accent);
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

interface LinePaint {
  selectedIds: ReadonlySet<string> | undefined;
  caret: { x: number; y: number } | null;
  playhead: { eventId: string; frac: number } | null;
  focusId: string | null;
  /** 播放指示方式：head = 跟着音符跳的色块 + 竖线；band = 从行首生长的高亮条 */
  playStyle: 'head' | 'band';
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
    const b = noteBox(ctx, headItem);
    const px = b.x + b.w * (playhead?.frac ?? 0);
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

  // ── 记号层 ──
  // 小节线
  for (const it of line.items) {
    if (it.kind !== 'barline') continue;
    const bx = it.x + it.w / 2;
    ctx.strokeStyle = it.final ? theme.barFinal : theme.bar;
    ctx.lineWidth = it.final ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(bx, y - M.barHalf);
    ctx.lineTo(bx, y + M.barHalf);
    ctx.stroke();
    if (it.final) {
      // 终止线：细线在左、粗线在右（简谱/五线谱惯例）
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx - 4, y - M.barHalf);
      ctx.lineTo(bx - 4, y + M.barHalf);
      ctx.stroke();
    }
  }

  // 减时线（下方连线）
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = M.beamLine;
  for (const b of line.beams) {
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
  for (const it of line.items) {
    if (it.kind !== 'note' && it.kind !== 'rest') continue;
    drawGlyph(ctx, it, y, theme);
  }

  // 播放头竖线：走完高亮框的宽度（进度条模式不需要——条的右缘就是位置）
  if (headItem && playhead && o.playStyle === 'head') {
    const b = noteBox(ctx, headItem);
    const px = b.x + b.w * playhead.frac;
    ctx.fillStyle = theme.playhead;
    ctx.fillRect(Math.round(px), y - M.barHalf, 2, M.barHalf * 2);
  }

  // 吐音 T/K、换气 V（淡黄）与技法记号（红色）同行排列，互不重叠：
  // 整串在音符上方居中，逐个按自身宽度推进。
  ctx.font = M.markFont;
  ctx.textAlign = 'center';
  for (const it of line.items) {
    // 转调记号：紧贴数字顶部（写法带「转」字，如 转1=#A），
    // 技法记号行在更高处，不会打架——演奏者要一眼看出它属于哪个音
    if (it.keyChange) {
      ctx.font = M.badgeFont;
      ctx.fillStyle = theme.muted;
      ctx.fillText(`转${it.keyChange}`, it.x + 11 + (it.graceInk ?? 0), y - 20);
      ctx.font = M.markFont;
    }
    const run: { mark: string; color: string; flip?: boolean; dot?: boolean }[] = [];
    if (it.tongue) run.push({ mark: it.tongue, color: theme.tongue });
    if (it.staccato) run.push({ mark: '·', color: theme.ink }); // 断音 / 顿音：小圆点
    for (const v of it.techniques ?? []) {
      const g = TECHNIQUE_GLYPH[v];
      if (g) run.push({ mark: g.mark, color: theme.tech, flip: g.flip });
    }
    // 延长音：弧线加弧线正下方的小圆点（对应 DSL 的 @）
    if (it.fermata) run.push({ mark: '⌒', color: theme.tech, dot: true });
    if (run.length === 0) continue;
    const widths = run.map((r) => ctx.measureText(r.mark).width);
    const total = widths.reduce((a, b) => a + b, 0) + 3 * (run.length - 1);
    let mx = it.x + 11 + (it.graceInk ?? 0) - total / 2;
    run.forEach((r, i) => {
      const tx = mx + widths[i] / 2;
      mx += widths[i] + 3;
      ctx.fillStyle = r.color;
      // 弧线字形压在基线以上，抬高一点才给正下方的圆点留出位置
      const my = y - M.markTop - (r.dot ? 3 : 0);
      if (r.flip) {
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
        ctx.arc(tx, y - M.markTop + 2, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.muted;

  // 力度记号：谱行下方。绑定在音符上的画在音符正下方，独立事件画在自己的格子里
  ctx.font = M.markFont;
  for (const it of line.items) {
    if (it.kind === 'directive' && it.value) {
      ctx.fillText(it.value, it.x + 2, y + M.markBottom);
      continue;
    }
    if (it.kind !== 'note') continue;
    if (it.dynamic) ctx.fillText(it.dynamic, it.x + 11 + (it.graceInk ?? 0), y + M.markBottom);
    // 渐强 / 渐弱：扁平楔形（几何绘制，字符 〈〉 太细高），画在力度记号右边。
    // 渐强从细到粗向右张开（尖在左），渐弱相反
    if (it.hairpin) {
      const cx = (it.dynamic ? it.x + 11 + 22 : it.x + 11) + 9;
      const cy = y + M.markBottom;
      ctx.strokeStyle = theme.muted;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      if (it.hairpin === 'cresc') {
        ctx.moveTo(cx - 9, cy);
        ctx.lineTo(cx + 9, cy - 3);
        ctx.lineTo(cx + 9, cy + 3);
      } else {
        ctx.moveTo(cx + 9, cy);
        ctx.lineTo(cx - 9, cy - 3);
        ctx.lineTo(cx - 9, cy + 3);
      }
      ctx.stroke();
    }
  }
  ctx.font = M.font;

  // 连线（上方弧线）
  ctx.lineWidth = 1.5;
  for (const a of line.arcs) {
    ctx.strokeStyle = a.kind === 'tie' ? theme.accent : theme.ink;
    const base = a.kind === 'tie' ? M.arcTieBase : M.arcBase;
    const ay = y - base - a.octaveUp * M.octaveStep;
    ctx.beginPath();
    ctx.moveTo(a.x0, ay);
    ctx.quadraticCurveTo((a.x0 + a.x1) / 2, ay - a.lift * 2, a.x1, ay);
    ctx.stroke();
  }

  // 连音标号：组上方一条向下弯的弧线，**中间断开**、断口里写数字（3 / 6 …）——
  // 这才是简谱/五线谱的标准画法，数字悬在整条弧外面的画法没人这么记
  ctx.font = M.badgeFont;
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 1.2;
  ctx.textAlign = 'center';
  for (const t of line.tuplets) {
    const ends = y - M.markTop;
    const apex = ends - 9;
    const cx = (t.x0 + t.x1) / 2;
    const gap = Math.min(ctx.measureText(t.text).width / 2 + 5, (t.x1 - t.x0) * 0.3);
    ctx.fillStyle = theme.ink;
    // 左右两段弧线，中间给数字让位
    ctx.beginPath();
    ctx.moveTo(t.x0, ends);
    ctx.quadraticCurveTo((t.x0 + cx) / 2, apex, cx - gap, ends - 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(t.x1, ends);
    ctx.quadraticCurveTo((t.x1 + cx) / 2, apex, cx + gap, ends - 4);
    ctx.stroke();
    // 数字坐在断口正中，与弧线同高
    ctx.fillText(t.text, cx, apex + 3);
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

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  it: PlacedItem,
  y: number,
  theme: PaintTheme,
): void {
  // 字号由字形渲染自己负责，不依赖上一个绘制块留下的 ctx.font
  ctx.font = M.font;
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.ink;

  // 变音记号占住数字左边那一格。宽度由 layout 给（it.accW）——
  // 这里不自带常量，两处各写一个数字迟早漂移，数字就压到记号上了。
  const accW = it.accW ?? 0;
  // 前倚音占掉的横向宽度：整个字形簇（数字 / 附点 / 增时线）都要右移
  const ink = it.graceInk ?? 0;
  if (it.accidental && accW > 0) {
    ctx.font = M.accFont;
    ctx.fillText(ACCIDENTAL_GLYPH[it.accidental], it.x + M.glyphPad + ink, y + 1);
    ctx.font = M.font;
  }

  const gx = it.x + M.glyphPad + accW + ink;
  const glyph = it.kind === 'rest' ? '0' : String(it.degree ?? 0);
  ctx.fillText(glyph, gx, y);
  const gw = ctx.measureText(glyph).width;
  const cx = gx + gw / 2;

  // 附点（挂在数字右侧，含变音记号与前倚音的实际位置）
  if (it.dot) {
    for (let i = 0; i < it.dot; i += 1) {
      ctx.beginPath();
      ctx.arc(gx + gw + 5 + i * M.dotGap, y + 1.5, M.dotR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 八度点。低音点必须让开下方的减时线：
  // 减时线一级在中线下 15px，低音点原本也在 17px，两者会叠在一起。
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

  // 增时线
  if (it.dashes) {
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = M.beamLine;
    for (let i = 0; i < it.dashes; i += 1) {
      const x0 = gx + gw + 5 + i * M.dashGap;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + M.dashW, y);
      ctx.stroke();
    }
  }

  // 倚音：前在左上、后在右上；弧线收到主音数字的侧边（前用左缘、后用右缘）。
  // 起点往主音方向靠一点，弧的半径才不会拉得太开
  if (it.graceBefore?.length) drawGraces(ctx, it.graceBefore, it.x + 5, y, theme, false, gx - 1);
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
): void {
  if (list.length === 0) return;
  ctx.font = M.graceFont;
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.ink;
  const w = M.graceW;
  /** 数字基线：抬到主音左上角（高位，给下面的减时线与弧线留出层次） */
  const gy = y - 24;
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
  });

  // 两条减时线：贴在数字下方、与数字之间留净空（数字底约 gy+1，横线从 gy+5 起）
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 1.3;
  const span = list.length * w - 3;
  const bx = x0 + 1.5;
  const by = gy + 5;
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
  const sy = y - 12; // 起笔高度：减时线（y-19 / y-16）下方留出 4px 净空，不与横线叠
  const ey = y - 3; // 收笔高度：主音左下 / 右下（抬得比数字底高一点，弧更紧凑）
  const rx = Math.abs(mainEdgeX - sx);
  const ry = ey - sy;
  if (rx > 1.5 && ry > 0) {
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
