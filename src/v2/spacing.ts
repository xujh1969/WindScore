import type { GlyphMetrics, LayoutLine, PlacedItem } from './layout';
import { TICKS_PER_BEAT } from './ticks';

/**
 * 字间距档位（@space）→ 相邻音符数字之间的目标净空隙（px）。
 *
 * 用户 2026-11-06 重新标定：0 → 10px、-20 → 3px、20 → 20px。
 * @space 不再是「加在格宽上的 px 增量」，旧文件里写的数值一律按新语义
 * 解释（不做迁移、不做兼容换算）。负半轴与正半轴斜率不同，故分段线性。
 * 净空隙是绝对 px、不随字号缩放：数字宽随字号变，空隙保持用户设定的值。
 */
export function letterGapOf(space: number): number {
  const s = Math.max(-20, Math.min(20, Number.isFinite(space) ? space : 0));
  return s < 0 ? 10 + 0.35 * s : 10 + 0.5 * s;
}

/** 净空隙标定所基于的一拍宽度（编辑页 EDITOR_UNIT = 33.6px/拍） */
export const GAP_REFERENCE_BEAT_PX = 33.6;
/**
 * 每拍像素偏离标定基准时，净空隙等比缩放：
 * 导出 / 播放页拍宽更大 → 空隙一起放大；OCR 对照页收紧 unit 时 → 空隙
 * 一起收窄（它的「原谱一行 = 预览一行」紧凑算法正是靠收缩 unit 收敛的）。
 * 钳制上下限防止安卓超大 unit 或极端缩图把版面撑爆 / 挤没。
 */
export function gapScaleOf(beatPx: number): number {
  return Math.max(0.1, Math.min(3, beatPx / GAP_REFERENCE_BEAT_PX));
}

/** 一小节（或不能分开的记号段）的自然宽度和伸缩能力。 */
export interface SpacingUnit {
  ideal: number;
  min: number;
  weight: number;
  lead?: number;
  forced?: boolean;
  penalty?: number;
}

/** 同时比较后续行，避免贪心断行留下过松的一行或很短的谱尾。 */
export function balancedBreaks(units: SpacingUnit[], available: number, compressionPenalty = 45): number[] {
  const cost = new Array<number>(units.length + 1).fill(Infinity);
  const next = new Array<number>(units.length).fill(0);
  cost[units.length] = 0;
  for (let from = units.length - 1; from >= 0; from--) {
    const budget = Math.max(1, available - (units[from].lead ?? 0));
    let ideal = 0;
    let min = 0;
    for (let to = from; to < units.length; to++) {
      ideal += units[to].ideal;
      min += units[to].min;
      if (min > budget && to > from) break;
      const last = to === units.length - 1;
      const ratio = ideal / budget;
      const ragged = (last || units[to].forced) && ratio < 0.6;
      const stretch = Math.max(0, 1 / ratio - 1);
      const rowCost = 1 + (ragged ? 3 * Math.pow(1 - ratio, 2) : 12 * stretch * stretch)
        + compressionPenalty * Math.pow(Math.max(0, ratio - 1), 2)
        + (last ? 0 : units[to].penalty ?? 0);
      if (rowCost + cost[to + 1] < cost[from]) {
        cost[from] = rowCost + cost[to + 1];
        next[from] = to + 1;
      }
      if (units[to].forced || min > budget) break;
    }
  }
  const starts: number[] = [];
  for (let at = 0; at < units.length; at = Math.max(at + 1, next[at])) starts.push(at);
  return starts;
}

/**
 * 按内容密度分配剩余空间；收紧时不越过安全宽度。
 *
 * justify 拉伸带**平衡上限** maxScale（行宽 / 自然宽的最大比值，默认 1.3）：
 * 短行（比如只写了一小节就换行）也尽量拉伸对齐，但音符间距超过上限就
 * 不再撑满，只保留最大允许间距——比「短行完全不拉」的参差观感好得多。
 */
export function fitSpacing(units: SpacingUnit[], available: number, justify: boolean, maxScale = 1.3): number[] {
  const ideal = units.reduce((sum, u) => sum + u.ideal, 0);
  const min = units.reduce((sum, u) => sum + u.min, 0);
  if (ideal > available) {
    const shrink = Math.min(1, (ideal - available) / Math.max(1, ideal - min));
    return units.map(u => u.ideal - (u.ideal - u.min) * shrink);
  }
  if (!justify) return units.map(u => u.ideal);
  // maxScale = Infinity 表示「无平衡上限，严格铺满」：自动换行的非末行用它
  // 保证各行右锚线一致。不能写 ideal * Infinity（ideal=0 会得到 NaN）。
  const target = Number.isFinite(maxScale) ? Math.min(available, ideal * Math.max(1, maxScale)) : available;
  const weight = units.reduce((sum, u) => sum + u.weight, 0);
  return units.map(u => u.ideal + (target - ideal) * u.weight / Math.max(1, weight));
}

/** 先确定增时线位置，命中范围和播放定位随后复用。 */
export function positionDashes(items: PlacedItem[], glyph: GlyphMetrics): void {
  for (const item of items) {
    if (item.dashXs || !item.dashes) continue;
    const start = item.x + (item.accW ?? 0) + (item.graceInk ?? 0) + glyph.pad + glyph.nominalWidth + 5;
    const cell = Math.max((item.x + item.w - 6 * glyph.fontSize / 21 - start) / item.dashes, glyph.dashW + 2);
    item.dashXs = Array.from({ length: item.dashes }, (_, d) => start + cell * (d + 0.5));
  }
}

/** 每个系统共用节拍锚点，音符格之间、长音内部都连续前进。 */
export function addPlaybackAnchors(lines: LayoutLine[], glyph: GlyphMetrics): void {
  const systems = new Map<number, LayoutLine[]>();
  for (const line of lines) {
    const key = line.system ?? line.index;
    const group = systems.get(key) ?? [];
    group.push(line);
    systems.set(key, group);
  }
  for (const group of systems.values()) {
    const anchors = new Map<number, { x: number; priority: number }>();
    const spans: { item: PlacedItem; tick: number }[] = [];
    const put = (tick: number, x: number, priority: number): void => {
      const old = anchors.get(tick);
      if (!old || priority > old.priority) anchors.set(tick, { x, priority });
    };
    for (const line of group) {
      positionDashes(line.items, glyph);
      let tick = 0;
      for (const item of line.items) {
        if (item.kind === 'barline') { put(tick, item.x + item.w / 2, 0); continue; }
        if (item.kind !== 'note' && item.kind !== 'rest') continue;
        const x = item.x + (item.accW ?? 0) + (item.graceInk ?? 0);
        put(tick, x, 2);
        spans.push({ item, tick });
        for (let d = 0; d < (item.dashXs?.length ?? 0); d++) {
          put(tick + (d + 1) * TICKS_PER_BEAT, item.dashXs![d] - glyph.pad - glyph.nominalWidth / 2, 1);
        }
        tick += item.ticks ?? 0;
        put(tick, item.x + item.w, -1);
      }
    }
    const ordered = [...anchors].sort((a, b) => a[0] - b[0]);
    for (const { item, tick } of spans) {
      const end = tick + (item.ticks ?? 0);
      item.playXs = ordered.filter(([t]) => t >= tick && t <= end)
        .map(([t, p]) => ({ fraction: (t - tick) / Math.max(1, end - tick), x: p.x }));
    }
  }
}

export function playbackX(item: Pick<PlacedItem, 'x' | 'w' | 'playXs'>, fraction: number): number {
  const points = item.playXs;
  const f = Math.max(0, Math.min(1, fraction));
  if (!points?.length) return item.x + item.w * f;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (b.fraction < f) continue;
    const a = points[i - 1];
    const u = (f - a.fraction) / Math.max(1e-9, b.fraction - a.fraction);
    return a.x + (b.x - a.x) * u;
  }
  return points[points.length - 1].x;
}
