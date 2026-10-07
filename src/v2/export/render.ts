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
import type { Score } from '../types';
import { planPages, type PageBand, type PagePlan } from './pdf';

/** 导出的字体栈：跟界面一致，导出的谱面才像「同一款软件印出来的」 */
export const EXPORT_FONT =
  "'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif";

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
  opts: { contentWidth: number; unit?: number; showTitle?: boolean },
): LayoutResult {
  return layoutScore(score, {
    contentWidth: opts.contentWidth,
    ...(opts.unit !== undefined ? { unit: opts.unit } : {}),
    showTitle: opts.showTitle ?? true,
  });
}

/** 每页的可用纵向区间（排版坐标） */
export function pageBands(geo: PageGeometry): { first: PageBand; rest: PageBand } {
  const top = geo.marginTop / geo.scale;
  const bottom = (geo.pageH - geo.marginBottom) / geo.scale;
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
  return planPages(lineY, layout.lineHeight, bands.first, bands.rest, firstOffset);
}

/** 页脚文字：`歌名-页号/总页数`（用户要的格式） */
export function footerText(songName: string, page: number, total: number): string {
  return `${songName || '未命名'}-${page}/${total}`;
}

export interface PagePaintOptions {
  /** 页脚文字；不给就不画（导出视频时不要页脚） */
  footer?: string;
  showMeasureNumbers?: boolean;
}

/**
 * 画一页 PDF：整页底色 + 该页的几行 + 页脚。
 * 版面用 setTransform 缩放平移，不改动 LayoutResult——同一份排版能反复画。
 */
export function paintExportPage(
  ctx: CanvasRenderingContext2D,
  layout: LayoutResult,
  theme: PaintTheme,
  plan: PagePlan,
  geo: PageGeometry,
  opts: PagePaintOptions = {},
): void {
  const { pageW, pageH, scale, marginX, marginTop, marginBottom } = geo;

  // 底色按整页铺（paintLayout 内部那次填充只盖版面范围，右边留白会露白）
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, pageW, pageH);

  ctx.setTransform(scale, 0, 0, scale, marginX, marginTop - plan.offset * scale);
  paintLayout(
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
    },
  );

  if (opts.footer) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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

/** 视频一帧：整块画布底色 + 整份版面（纵向滚动 scrollY 像素）+ 播放头 + 进度条 */
export function paintVideoFrame(
  ctx: CanvasRenderingContext2D,
  layout: LayoutResult,
  theme: PaintTheme,
  opts: {
    canvasW: number;
    canvasH: number;
    scale: number;
    /** 版面纵向滚动量（像素，正数向下） */
    scrollY: number;
    /** 版面横向偏移；不给就横向居中 */
    offsetX?: number;
    playhead?: { eventId: string; frac: number } | null;
    /** 播放指示样式，与界面上「光标 / 高亮条」的设置一致 */
    playStyle?: 'head' | 'band';
    showMeasureNumbers?: boolean;
    progress?: number;
  },
): void {
  const { canvasW, canvasH, scale, scrollY } = opts;
  const xOff = opts.offsetX ?? Math.max(0, (canvasW - layout.width * scale) / 2);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  ctx.setTransform(scale, 0, 0, scale, xOff, -scrollY);
  paintLayout(ctx, layout, theme, {
    // 底色填充要盖满整屏：paintLayout 只填 layout.width 宽
    height: (canvasH + scrollY) / scale,
    playhead: opts.playhead ?? null,
    playStyle: opts.playStyle ?? 'head',
    showMeasureNumbers: opts.showMeasureNumbers ?? true,
  });

  if (opts.progress !== undefined) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(0, canvasH - 4, canvasW * Math.max(0, Math.min(1, opts.progress)), 4);
  }
}
