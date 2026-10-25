/**
 * 导出的绘制层：把谱面画到「一张画布」上。
 *
 * PDF 与视频共用同一套排版与绘制（layoutScore / paintLayout），
 * 差别只在**怎么把行摆进画布**：
 *   - PDF：把行切成若干页，每页把首行平移到页边（见 pdf.ts 的 planPages）
 *   - 视频：整份版面不动，按播放位置上下滚动
 *
 * 这一层需要 canvas，所以只在浏览器里跑；纯计算在 pdf.ts / video.ts 里。
 */

import { layoutScore, type LayoutResult } from '../layout';
import { DARK_THEME, LIGHT_THEME, paintLayout, type PaintTheme } from '../paint';
import { DEFAULT_FONT_SIZE, type Score } from '../types';
import type { BallDraw } from '../ball';
import { buildStaffLayout, type StaffLayout } from '../staff';
import { paintStaffLayout } from '../staffPaint';
import { withStaffRows } from '../staffSpacing';
import type { StaffPitchMode } from '../pitch';
import { planPages, type PageBand, type PagePlan } from './pdf';

/** 导出的字体栈：跟界面一致，导出的谱面才像「同一款软件印出来的」 */
export const EXPORT_FONT =
  "'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif";

export interface ExportNotation {
  notation?: 'jianpu' | 'staff';
  staffPitchMode?: StaffPitchMode;
}

export interface ExportLayoutResult extends LayoutResult {
  staff?: StaffLayout;
}

/** 只在准备导出时投影一次；分页和逐帧绘制复用最终坐标。 */
export function prepareExportLayout(score: Score, base: LayoutResult, opts: ExportNotation = {}): ExportLayoutResult {
  if (opts.notation !== 'staff') return base;
  const staff = buildStaffLayout(score, base, opts.staffPitchMode ?? 'concert');
  const layout = withStaffRows(base, staff);
  const groups = base.systems ?? base.lines.map((_, i) => ({ from: i, to: i + 1, bracketX: 0 }));
  return { ...layout, staff, systems: groups.map(group => ({ ...group,
    top: (staff.lines[group.from].labelY ?? staff.lines[group.from].y - 4 * staff.sp) - staff.sp,
    bottom: group.to < staff.lines.length
      ? (staff.lines[group.to].labelY ?? staff.lines[group.to].y - 4 * staff.sp) - 3 * staff.sp
      : staff.height - 3 * staff.sp,
  })) };
}

/** 页面几何（全部单位是**像素**；scale 用来把谱面字号放大到纸面/视频的观感） */
export interface PageGeometry {
  pageW: number;
  pageH: number;
  /** 版面缩放：谱面 21px 字号在成品上变成 21 × scale */
  scale: number;
  marginX: number;
  marginTop: number;
  /** 底部留白要放页脚，所以比顶部大 */
  marginBottom: number;
}

export function exportTheme(dark: boolean): PaintTheme {
  return dark ? DARK_THEME : LIGHT_THEME;
}

/**
 * 排版一次，供所有页 / 所有帧复用。
 * 宽度用「排版坐标」给（成品宽 ÷ scale），画的时候再放大——
 * 这样字间距、房子括线这些细节都按谱面本来的比例走。
 */
export function exportLayout(
  score: Score,
  opts: { contentWidth: number; unit?: number; showTitle?: boolean } & ExportNotation,
): ExportLayoutResult {
  const k = (score.meta.fontSize ?? DEFAULT_FONT_SIZE) / 21;
  const base = layoutScore(score, {
    contentWidth: opts.contentWidth,
    ...(opts.unit !== undefined ? { unit: opts.unit } : {}),
    showTitle: opts.showTitle ?? true,
    ...(opts.notation === 'staff' ? { padding: 96 * k, staffKeySpace: 104 * k, staffPitchMode: opts.staffPitchMode ?? 'concert' } : {}),
  });
  return prepareExportLayout(score, base, opts);
}

/** 每页的可用纵向区间（排版坐标） */
export function pageBands(geo: PageGeometry): { first: PageBand; rest: PageBand } {
  // 绘制时已平移 marginTop；分页区间只包含版心，避免再算一次上边距。
  const top = 0;
  const bottom = (geo.pageH - geo.marginTop - geo.marginBottom) / geo.scale;
  return { first: { top, bottom }, rest: { top, bottom } };
}

/** 标题块顶边（排版坐标）。没有标题时返回 null */
function titleTop(layout: LayoutResult): number | null {
  return layout.title ? layout.title.y - 22 : null;
}

/**
 * 把谱面切成若干页。
 * 首页要额外下移一点，保证标题不会顶到页边（标题比首行高，不下移会爬出页外）。
 */
export function planScorePages(
  layout: LayoutResult,
  geo: PageGeometry,
  showTitle: boolean,
): PagePlan[] {
  const bands = pageBands(geo);
  const lineY = layout.lines.map((l) => l.y);
  const tTop = showTitle ? titleTop(layout) : null;
  const firstOffset = tTop === null ? 0 : Math.max(0, tTop - bands.first.top);
  if (layout.systems?.length) {
    if (layout.width > (geo.pageW - geo.marginX * 2) / geo.scale + 1) throw new Error('某个小节超出纸张宽度，请在谱面中减小字号或字间距');
    const pages: PagePlan[] = [];
    let from = 0;
    let offset = firstOffset;
    let band = bands.first;
    for (const system of layout.systems) {
      if (system.from > from && (system.bottom - offset > band.bottom || layout.lines[system.from].pageBreakBefore)) {
        pages.push({ from, to: system.from, offset });
        from = system.from;
        band = bands.rest;
        offset = system.top - band.top;
      }
      if (system.from === from && system.bottom - system.top > band.bottom - band.top) {
        throw new Error('整组声部超出纸张高度，请在谱面中减小字号、增加每行小节数，或导出分谱');
      }
      if (system.from === from && system.bottom - offset > band.bottom) {
        throw new Error('谱头和首组谱表超出页面高度，请关闭“包含标题”、导出分谱或调整谱面排版');
      }
    }
    pages.push({ from, to: layout.lines.length, offset });
    return pages;
  }
  if (!layout.lines.some((line) => line.pageBreakBefore)) return planPages(lineY, layout.lineHeight, bands.first, bands.rest, firstOffset);
  const pages: PagePlan[] = [];
  let from = 0;
  let offset = firstOffset;
  let band = bands.first;
  for (let i = 0; i < layout.lines.length; i++) {
    const top = lineY[i] - layout.lineHeight / 2;
    const bottom = lineY[i] + layout.lineHeight / 2;
    if (i > from && (bottom - offset > band.bottom || layout.lines[i].pageBreakBefore)) {
      pages.push({ from, to: i, offset });
      from = i;
      band = bands.rest;
      offset = top - band.top;
    }
  }
  pages.push({ from, to: layout.lines.length, offset });
  return pages;
}

/** 页脚文字：`歌名-页号/总页数`（用户要的格式） */
export function footerText(songName: string, page: number, total: number): string {
  return `${songName || '未命名'}-${page}/${total}`;
}

export interface PagePaintOptions {
  /** 页脚文字；不给就不画（导出视频时不要页脚） */
  footer?: string;
  showMeasureNumbers?: boolean;
  /**
   * 页面原点的纵向位移（像素）：多页拼接成一张图时，第 n 页偏移 n ×（页高 + 间隔）。
   * 必须在这里实现而不能靠调用方 translate——本函数内部的 setTransform 是绝对矩阵，
   * 会把外面的位移抹掉
   */
  originY?: number;
}

/**
 * 画一页 PDF：整页底色 + 该页的几行 + 页脚。
 * 版面用 setTransform 缩放平移，不改动 LayoutResult——同一份排版能反复画。
 */
export function paintExportPage(
  ctx: CanvasRenderingContext2D,
  layout: ExportLayoutResult,
  theme: PaintTheme,
  plan: PagePlan,
  geo: PageGeometry,
  opts: PagePaintOptions = {},
): void {
  const { pageW, pageH, scale, marginX, marginTop, marginBottom } = geo;
  const originY = opts.originY ?? 0;

  // 底色按整页铺（paintLayout 内部那次填充只盖版面范围，右边留白会露白）
  ctx.setTransform(1, 0, 0, 1, 0, originY);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, pageW, pageH);

  ctx.setTransform(scale, 0, 0, scale, marginX, originY + marginTop - plan.offset * scale);
  if (layout.staff) {
    const staff = layout.staff;
    paintStaffLayout(ctx, { ...staff,
      title: plan.from === 0 ? layout.title : null,
    }, theme, { background: false, lineRange: plan, showMeasureNumbers: opts.showMeasureNumbers ?? true, showTitleEdit: false });
  } else paintLayout(
    ctx,
    {
      ...layout,
      // 标题只在第一页：往后每页都印一遍标题不像样，而页脚已经有歌名与页号了
      title: plan.from === 0 ? layout.title : null,
      lines: layout.lines.slice(plan.from, plan.to),
    },
    theme,
    {
      height: (pageH - marginTop - marginBottom) / scale + lineSlack(layout),
      showMeasureNumbers: opts.showMeasureNumbers ?? true,
      showTitleEdit: false,
    },
  );

  if (opts.footer) {
    ctx.setTransform(1, 0, 0, 1, 0, originY);
    ctx.font = `13px ${EXPORT_FONT}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(opts.footer, pageW / 2, pageH - Math.max(24, marginBottom * 0.42));
  }
}

/** 行与行之间那点空隙（房子括线跨行时会探出行高，所以多留一点） */
function lineSlack(layout: LayoutResult): number {
  return layout.lineHeight * 0.5;
}

const videoBounds = new WeakMap<ExportLayoutResult, { left: number; right: number; top: number; bottom: number }[]>();
function frameLineBounds(layout: ExportLayoutResult) {
  let bounds = videoBounds.get(layout);
  if (bounds) return bounds;
  const pad = layout.lineHeight * 2;
  bounds = layout.lines.map((line, index) => {
    const staff = layout.staff?.lines[index];
    const xs = line.items.flatMap(item => [item.x, item.x + item.w]);
    const ys = [staff?.y ?? line.y];
    if (staff) {
      for (const symbol of staff.symbols) {
        xs.push(symbol.x);
        if ('y' in symbol) ys.push(symbol.y);
        if ('beamEnd' in symbol && symbol.beamEnd !== undefined) ys.push(symbol.beamEnd);
      }
      for (const curve of layout.staff!.curves) if (curve.line === index) {
        ys.push(curve.y0, curve.y1, curve.controlY0, curve.controlY1);
        xs.push(curve.x0, curve.x1);
      }
      for (const mark of layout.staff!.marks) if (mark.line === index) ys.push(mark.y, mark.y + mark.height);
    }
    return { left: Math.min(...xs) - pad, right: Math.max(...xs) + pad, top: Math.min(...ys) - pad, bottom: Math.max(...ys) + pad };
  });
  for (const system of layout.systems ?? []) {
    for (let index = system.from; index < system.to; index++) {
      bounds[index].top = Math.min(bounds[index].top, system.top - pad);
      bounds[index].bottom = Math.max(bounds[index].bottom, system.bottom + pad);
    }
  }
  const groups = new Map<number, number[]>();
  layout.lines.forEach((line, index) => {
    const system = layout.staff?.lines[index]?.system ?? line.system;
    if (system !== undefined) {
      const indices = groups.get(system) ?? [];
      indices.push(index);
      groups.set(system, indices);
    }
  });
  // Strip layouts retain staff system IDs but have no page-level systems array.
  for (const indices of groups.values()) {
    const all = indices.map(index => bounds![index]);
    const group = { left: Math.min(...all.map(b => b.left)), right: Math.max(...all.map(b => b.right)),
      top: Math.min(...all.map(b => b.top)), bottom: Math.max(...all.map(b => b.bottom)) };
    for (const index of indices) bounds[index] = group;
  }
  videoBounds.set(layout, bounds);
  return bounds;
}

/** 视频一帧：仅向绘制器提交与视口相交的行，保留额外行距容纳歌词和跨行记号。 */
export function paintVideoFrame(
  ctx: CanvasRenderingContext2D,
  layout: ExportLayoutResult,
  theme: PaintTheme,
  opts: {
    canvasW: number;
    canvasH: number;
    scale: number;
    /** 版面纵向滚动量（像素，正数向下）。给了 scrollX 就忽略它 */
    scrollY?: number;
    /** 版面横向滚动量（像素，正数向左看）：横向长条模式用，给了就忽略 scrollY */
    scrollX?: number;
    /** 底色覆盖（横向长条的绿幕底色等）；不给用 theme.bg */
    bg?: string;
    /** 版面横向偏移；不给就横向居中 */
    offsetX?: number;
    playhead?: { eventId: string; frac: number } | null;
    playheads?: { eventId: string; frac: number }[];
    /** 播放指示样式，与界面上「光标 / 高亮条 / 光球」的设置一致 */
    playStyle?: 'head' | 'band' | 'ball';
    ball?: BallDraw | null;
    showMeasureNumbers?: boolean;
    progress?: number;
    /** Cached-frame repair rectangle, in score coordinates. */
    redraw?: { left: number; right: number; top: number; bottom: number };
  },
): void {
  const { canvasW, canvasH, scale } = opts;
  ctx.save();
  const scrollY = opts.scrollY ?? 0;
  const xOff = opts.offsetX ?? Math.max(0, (canvasW - layout.width * scale) / 2);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = opts.bg ?? theme.bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  const horizontal = opts.scrollX !== undefined;
  ctx.setTransform(scale, 0, 0, scale, horizontal ? -opts.scrollX! : xOff, horizontal ? 0 : -scrollY);
  const paintOptions = {
    height: (canvasH + (horizontal ? 0 : scrollY)) / scale,
    playhead: opts.playhead ?? null,
    playheads: opts.playheads,
    playStyle: opts.playStyle ?? 'head',
    ball: opts.ball,
    showMeasureNumbers: opts.showMeasureNumbers ?? true,
    showTitleEdit: false,
  };
  const left = Math.max((opts.scrollX ?? 0) / scale, opts.redraw?.left ?? -Infinity);
  const right = Math.min((opts.scrollX ?? 0) / scale + canvasW / scale, opts.redraw?.right ?? Infinity);
  const top = Math.max(scrollY / scale, opts.redraw?.top ?? -Infinity);
  const bottom = Math.min(scrollY / scale + canvasH / scale, opts.redraw?.bottom ?? Infinity);
  let from = layout.lines.length;
  let to = 0;
  frameLineBounds(layout).forEach((bounds, index) => {
    const visible = horizontal ? bounds.right >= left && bounds.left <= right : bounds.bottom >= top && bounds.top <= bottom;
    if (visible) { from = Math.min(from, index); to = Math.max(to, index + 1); }
  });
  // A system's bracket and band span all parts, including rows without notes.
  for (const system of layout.systems ?? []) if (system.from < to && system.to > from) {
    from = Math.min(from, system.from); to = Math.max(to, system.to);
  }
  if (layout.staff) paintStaffLayout(ctx, layout.staff, opts.bg ? { ...theme, bg: opts.bg } : theme,
    { ...paintOptions, lineRange: { from, to } });
  else paintLayout(ctx, { ...layout, lines: layout.lines.slice(from, to) }, theme, paintOptions);

  if (opts.progress !== undefined) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(0, canvasH - 4, canvasW * Math.max(0, Math.min(1, opts.progress)), 4);
  }
  ctx.restore();
}
