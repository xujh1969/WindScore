import type { LayoutLine, LayoutOptions, LayoutResult, PlacedItem } from './layout';
import { METER_LEAD } from './layout';
import { partMeasures, partScore, scoreParts } from './parts';
import type { BarlineEvent, Score } from './types';
import { TICKS_PER_BEAT } from './ticks';

type Position = { x: number; w: number; line: number; dashXs?: number[] };
type Entry = { item: PlacedItem; tick: number; measure: number; lead: number };

/** 每个小节建立共享时间格，再由现有单声部算法绘制各自的记号。 */
export function layoutEnsemble(score: Score, opts: LayoutOptions, layoutSingle: (score: Score, opts: LayoutOptions) => LayoutResult): LayoutResult {
  const parts = scoreParts(score);
  const singles = parts.map((p) => partScore(score, p.id));
  const measured = singles.map((s) => layoutSingle(s, { ...opts, contentWidth: 1e9, showTitle: false }));
  const k = measured[0].glyph.fontSize / 21;
  const rowH = opts.lineHeight ?? Math.max(...measured.map((s) => s.lineHeight));
  const left = (opts.padding ?? 40) + Math.min(112, Math.max(52, ...parts.map((p) => [...p.name].length * 12))) * k;
  const right = opts.contentWidth - (opts.padding ?? 40);
  const available = Math.max(160, right - left);
  const tables = singles.map((s) => partMeasures(s.events));
  const count = Math.max(1, ...tables.map((ms) => ms.length));
  const entries: Entry[][] = measured.map((layout, pi) => {
    const byId = new Map(layout.lines.flatMap((line) => line.items).map((it) => [it.eventId, it]));
    return tables[pi].flatMap((m, mi) => {
      let tick = 0;
      return singles[pi].events.slice(m.from, m.to).flatMap((e) => {
        const item = byId.get(e.id);
        const at = tick;
        if ('ticks' in e) tick += e.ticks;
        return item ? [{ item, tick: at, measure: mi, lead: (item.accW ?? 0) + (item.graceInk ?? 0) }] : [];
      });
    });
  });
  const local = new Map<string, { x: number; w: number; dashXs?: number[] }>();
  const widths: number[] = [];
  for (let mi = 0; mi < count; mi++) {
    const current = entries.flat().filter((e) => e.measure === mi);
    const end = Math.max(0, ...tables.map((ms) => ms[mi]?.ticks ?? 0));
    const dashTicks = current.flatMap((e) => Array.from({ length: e.item.dashes ?? 0 }, (_, i) => e.tick + (i + 1) * TICKS_PER_BEAT));
    const ticks = [...new Set([0, end, ...dashTicks, ...current.filter((e) => e.item.kind !== 'barline').map((e) => e.tick)])].sort((a, b) => a - b);
    const onsets = new Map<number, number>();
    const leads = new Map<number, number>();
    let x = 0;
    for (let ti = 0; ti < ticks.length; ti++) {
      const tick = ticks[ti];
      const here = current.filter((e) => e.tick === tick && e.item.kind !== 'barline');
      const pre = Math.max(0, ...parts.map((p, pi) => entries[pi].filter((e) => e.measure === mi && e.tick === tick && e.item.kind !== 'note' && e.item.kind !== 'rest' && e.item.kind !== 'barline').reduce((sum, e) => sum + e.item.w, 0)));
      const opening = tick === 0 ? Math.max(0, ...current.filter((e) => e.tick === 0 && e.item.kind === 'barline').map((e) => e.item.w)) : 0;
      const lead = Math.max(0, ...here.map((e) => e.lead));
      onsets.set(tick, x + pre + opening + lead);
      leads.set(tick, lead);
      const step = ticks[ti + 1] === undefined ? 0 : ticks[ti + 1] - tick;
      const ink = Math.max(0, ...here.filter((e) => e.item.kind === 'note' || e.item.kind === 'rest').map((e) => 26 * k + e.lead + (e.item.graceAfter?.length ?? 0) * measured[0].glyph.graceW));
      x += pre + opening + Math.max(ink, step * (opts.unit ?? 1.3) + (step > 0 ? 8 * k : 0));
    }
    const barW = Math.max(20 * k, ...current.filter((e) => e.item.kind === 'barline' && e.tick > 0).map((e) => e.item.w));
    const close = x;
    const preUsed = new Map<string, number>();
    for (const e of current) {
      const it = e.item;
      if (it.kind === 'barline') local.set(it.eventId, { x: e.tick === 0 ? 0 : close, w: barW });
      else if (it.kind === 'note' || it.kind === 'rest') {
        const start = onsets.get(e.tick)! - e.lead;
        const until = e.tick + (it.ticks ?? 0);
        const endX = onsets.get(until) ?? close;
        const dashXs = Array.from({ length: it.dashes ?? 0 }, (_, i) => onsets.get(e.tick + (i + 1) * TICKS_PER_BEAT)! + measured[0].glyph.pad + measured[0].glyph.nominalWidth / 2);
        local.set(it.eventId, { x: start, w: Math.max(26 * k + e.lead, endX - start - 3 * k), ...(dashXs.length ? { dashXs } : {}) });
      } else {
        const pi = entries.findIndex((list) => list.includes(e));
        const key = `${pi}:${e.tick}`;
        const used = preUsed.get(key) ?? 0;
        const preWidth = entries[pi].filter((a) => a.measure === mi && a.tick === e.tick && a.item.kind !== 'note' && a.item.kind !== 'rest' && a.item.kind !== 'barline').reduce((sum, a) => sum + a.item.w, 0);
        local.set(it.eventId, { x: onsets.get(e.tick)! - (leads.get(e.tick) ?? 0) - preWidth + used, w: it.w });
        preUsed.set(key, used + it.w);
      }
    }
    widths.push(Math.max(60 * k, close + barW));
  }
  const systemOf: number[] = [];
  const offsetOf: number[] = [];
  /**
   * 每个系统的行首让位（拍号）：上一小节以「带拍号的小节线」结尾时，
   * 拍号挪到新一行的行首（画在第一个声部那一行），整个系统的内容一起右移——
   * 各声部共用一套绝对坐标，只挪一个声部会导致上下对不齐。
   */
  const systemLead: number[] = [0];
  const systemMeter: string[] = [];
  let system = 0;
  let used = 0;
  for (let mi = 0; mi < count; mi++) {
    const previous = mi > 0 ? singles[0].events[tables[0][mi - 1]?.to - 1] : undefined;
    if (used > 0 && (used + widths[mi] > available - (systemLead[system] ?? 0) || (previous?.kind === 'barline' && previous.breakAfter))) {
      system++;
      used = 0;
      const bar = previous && previous.kind === 'barline' ? (previous as BarlineEvent) : undefined;
      const lead = bar?.beatAfter ? METER_LEAD * k : 0;
      systemLead[system] = lead;
      systemMeter[system] = bar?.beatAfter ?? '';
    }
    systemOf.push(system);
    offsetOf.push(used);
    // 让位宽度占掉可用宽度，否则行末会被挤出右缘
    used += widths[mi];
  }
  const positions = new Map<string, Position>();
  for (const list of entries) for (const e of list) {
    const p = local.get(e.item.eventId)!;
    // 行首拍号让位：整个系统一起右移，各声部保持对齐
    const offset = left + (systemLead[systemOf[e.measure]] ?? 0) + offsetOf[e.measure];
    positions.set(e.item.eventId, { x: offset + p.x, w: p.w, line: systemOf[e.measure], ...(p.dashXs ? { dashXs: p.dashXs.map((x) => offset + x) } : {}) });
  }
  const placed = singles.map((s, pi) => layoutSingle(s, { ...opts, lineHeight: rowH, positions, showTitle: pi === 0 && opts.showTitle !== false }));
  const title = placed[0].title;
  const startY = 20 + (title?.height ?? 0);
  const systemH = parts.length * rowH + 24 * k;
  const lines: LayoutLine[] = [];
  const hitIndex: LayoutResult['hitIndex'] = [];
  const systems: NonNullable<LayoutResult['systems']> = [];
  for (let si = 0; si <= system; si++) {
    const from = lines.length;
    for (let pi = 0; pi < parts.length; pi++) {
      const source = placed[pi].lines.find((line) => line.items.some((it) => positions.get(it.eventId)?.line === si));
      const y = startY + si * systemH + pi * rowH + rowH / 2;
      // 行首拍号：每个声部的行首都画（与五线谱换拍号惯例一致——
      // 每一行谱都要能独立读出当前拍号）。x 相同，竖着对齐成一列
      const lead = systemLead[si] ?? 0;
      const leadingMeter = lead > 0 ? { meter: systemMeter[si] ?? '', x: left + lead * 0.45 } : undefined;
      // 本系统行末小节线的拍号是否挪给了下一系统（下一系统行首带拍号）
      const meterMoved = !!systemMeter[si + 1];
      const line: LayoutLine = source ? { ...source, index: lines.length, y, partId: parts[pi].id, partName: parts[pi].name, system: si, leadingMeter, meterMoved } : {
        index: lines.length, y, items: [], beams: [], arcs: [], badges: [], tuplets: [], voltas: [], partId: parts[pi].id, partName: parts[pi].name, system: si, leadingMeter, meterMoved,
      };
      lines.push(line);
      if (source) {
        const ids = new Set(source.items.map((it) => it.eventId));
        hitIndex.push(...placed[pi].hitIndex.filter((b) => ids.has(b.eventId)).map((b) => ({ ...b, y: b.y + y - source.y })));
      }
    }
    systems.push({ from, to: lines.length, top: lines[from].y - rowH / 2, bottom: lines[lines.length - 1].y + rowH / 2, bracketX: left - 14 * k });
  }
  return { ...placed[0], lines, hitIndex, systems, width: Math.max(opts.contentWidth, left + Math.max(...widths) + (opts.padding ?? 40)), height: startY + (system + 1) * systemH + 24 };
}
