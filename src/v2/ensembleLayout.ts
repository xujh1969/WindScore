import type { LayoutLine, LayoutOptions, LayoutResult, PlacedItem } from './layout';
import { METER_LEAD, placeCueStaves } from './layout';
import { partMeasures, partScore, scoreParts } from './parts';
import type { Score } from './types';
import { PX_PER_BEAT_DEFAULT, TICKS_PER_BEAT } from './ticks';
import { addPlaybackAnchors, balancedBreaks, fitSpacing } from './spacing';

type Position = { x: number; w: number; line: number; dashXs?: number[] };
type Entry = { item: PlacedItem; tick: number; measure: number; lead: number };

/** 每个小节建立共享时间格，再由现有单声部算法绘制各自的记号。 */
export function layoutEnsemble(score: Score, opts: LayoutOptions, layoutSingle: (score: Score, opts: LayoutOptions) => LayoutResult): LayoutResult {
  // 隐藏声部不在总谱显示（仍会播放）——display 层唯一的过滤点：
  // timeline/expand 的 scoreParts 保持全量，不要动。全部被隐藏时按未隐藏处理，
  // 避免总谱区出现空板。
  const all = scoreParts(score);
  const visible = all.filter((p) => !p.hidden);
  const parts = visible.length ? visible : all;
  // 子谱**显式剥掉 cues**：partScore 的 ...base 会把主谱的 cues 原样带进每个
  // 声部，单声部排版就会各自按自己的行算一份坐标错误的小字谱（spread 回结果时
  // 还会顶掉正确值）。小字谱只在总谱层放一次，行高也由本函数显式负责。
  const singles = parts.map((p) => ({ ...partScore(score, p.id), cues: undefined }));
  const measured = singles.map((s) => layoutSingle(s, { ...opts, contentWidth: 1e9, showTitle: false }));
  const k = measured[0].glyph.fontSize / 21;
  // 小字谱要占锚行行带上方的高度：拿一份「带 cue 的单声部探测排版」的 lineHeight
  // 作准（与 layoutScore 的 upNeed 口径同源），不在这里复刻公式、也不依赖隐式继承。
  // opts.lineHeight 是播放页的显式覆盖，与单声部一样不涨。
  const hasCue = !opts.lineHeight && (score.cues ?? []).some((c) => c.events?.length);
  const cueRowH = hasCue
    ? layoutSingle({ ...singles[0], cues: score.cues }, { ...opts, contentWidth: 1e9, showTitle: false }).lineHeight
    : 0;
  const rowH = opts.lineHeight ?? Math.max(...measured.map((s) => s.lineHeight), cueRowH);
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
  const densities: number[] = [];
  const closingWidths: number[] = [];
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
      const ink = Math.max(0, ...here.filter((e) => e.item.kind === 'note' || e.item.kind === 'rest').map((e) => {
        const item = e.item;
        const lyric = Math.max(0, ...(item.lyrics ?? []).map(word => Array.from(word).length * 16 * k));
        return Math.max(measured[0].glyph.nominalWidth + 3 * k + (item.dot ? 7 * k : 0), lyric + 3 * k)
          + (opts.staffPitchMode ? lead : e.lead) + (item.staffAfterInk ?? (item.graceAfter?.length ?? 0) * measured[0].glyph.graceW);
      }));
      x += pre + opening + Math.max(ink, TICKS_PER_BEAT * (opts.unit ?? PX_PER_BEAT_DEFAULT / TICKS_PER_BEAT) * Math.sqrt(step / TICKS_PER_BEAT) + (step > 0 ? 8 * k : 0));
    }
    const barW = Math.max(20 * k, ...current.filter((e) => e.item.kind === 'barline' && e.tick > 0).map((e) => e.item.w));
    const close = Math.max(x, 60 * k - barW);
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
    closingWidths.push(barW);
    densities.push(Math.pow(Math.max(1, ...entries.map(list => list.filter(e => e.measure === mi && (e.item.kind === 'note' || e.item.kind === 'rest')).length)), 1.5));
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
  const units = widths.map((ideal, mi) => {
    const previous = mi > 0 ? singles[0].events[tables[0][mi - 1]?.to - 1] : undefined;
    const tail = singles[0].events[tables[0][mi]?.to - 1];
    return { ideal, min: ideal, weight: densities[mi],
      lead: previous?.kind === 'barline' && previous.beatAfter ? METER_LEAD * k : 0,
      forced: tail?.kind === 'barline' && !!tail.breakAfter };
  });
  // 各「源码行」（forced 组）按自然宽排时的最大内容宽：左栏（含左 padding）+
  // 行首让位 + 组内小节自然宽 + 右 padding。多声部排版自己断系统/缩放，
  // 这个值供调用方（OCR 预览二次排版）把 contentWidth 收到刚好不缩放
  let naturalMax = 0;
  {
    let acc = 0;
    let leadAcc = 0;
    for (let mi = 0; mi < units.length; mi++) {
      acc += widths[mi];
      leadAcc += units[mi].lead ?? 0;
      if (units[mi].forced || mi === units.length - 1) {
        naturalMax = Math.max(naturalMax, left + leadAcc + acc + (opts.padding ?? 40));
        acc = 0;
        leadAcc = 0;
      }
    }
  }
  const starts = balancedBreaks(units, available);
  const scales: number[] = [];
  for (let si = 0; si < starts.length; si++) {
    const from = starts[si];
    const to = starts[si + 1] ?? count;
    const previous = from > 0 ? singles[0].events[tables[0][from - 1]?.to - 1] : undefined;
    systemLead[si] = units[from].lead;
    systemMeter[si] = previous?.kind === 'barline' ? previous.beatAfter ?? '' : '';
    const budget = available - systemLead[si] + (closingWidths[to - 1] - 20 * k) / 2;
    // 与单声部口径一致（0.4.40）：短行豁免改为 fitSpacing 内的平衡上限，
    // 短行也尽量拉伸对齐，间距超过 1.3× 就不再撑满
    const fitted = fitSpacing(units.slice(from, to), budget, true, opts.justifyMax);
    let offset = 0;
    for (let mi = from; mi < to; mi++) {
      systemOf[mi] = si;
      offsetOf[mi] = offset;
      scales[mi] = (fitted[mi - from] - closingWidths[mi]) / Math.max(1, widths[mi] - closingWidths[mi]);
      offset += fitted[mi - from];
    }
  }
  const system = starts.length - 1;
  const positions = new Map<string, Position>();
  for (const list of entries) for (const e of list) {
    const p = local.get(e.item.eventId)!;
    // 行首拍号让位：整个系统一起右移，各声部保持对齐
    const offset = left + (systemLead[systemOf[e.measure]] ?? 0) + offsetOf[e.measure];
    const scale = scales[e.measure];
    // 同一拍所有声部共同伸缩，字形不缩放；前置倚音和变音保持固定墨迹宽。
    const lead = e.item.kind === 'note' || e.item.kind === 'rest' ? e.lead : 0;
    positions.set(e.item.eventId, { x: offset + (p.x + lead) * scale - lead, w: e.item.kind === 'barline' && e.tick > 0 ? p.w : p.w * scale, line: systemOf[e.measure], ...(p.dashXs ? { dashXs: p.dashXs.map((x) => offset + x * scale) } : {}) });
  }
  const placed = singles.map((s, pi) => layoutSingle(
    // 首声部排版还负责整谱的标题块：标题高度里有一条「上方留白」分支
    // （upNeed>30 时多 12px），带小字谱的单声部版式会走它。这里显式把 cues
    // 传回去只为标题同高；它自己算的 cue 坐标仍在下面重算并显式覆盖。
    pi === 0 && score.cues?.length ? { ...s, cues: score.cues } : s,
    { ...opts, lineHeight: rowH, positions, showTitle: pi === 0 && opts.showTitle !== false },
  ));
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
      const line: LayoutLine = source ? {
        ...source,
        index: lines.length, y, partId: parts[pi].id, partName: parts[pi].name, system: si, leadingMeter, meterMoved,
        // 跳房子括线只画在**每个系统的第一行**（总谱记谱惯例）：withConductor 把
        // volta 属性抄给了每个声部，各声部的单声部排版都会算出一份，不剥的话
        // 每行头上都悬一个「2」（用户 2026-11-06 实测）
        ...(pi === 0 ? {} : { voltas: [] as LayoutLine['voltas'] }),
      } : {
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
  addPlaybackAnchors(lines, measured[0].glyph);
  // 小字谱挂到多声部的总谱行上（锚声部的行带顶）。placed[0] 是 partScore 的
  // 单声部排版，partScore 会把 cues 原样带进子谱——那里的 cue 坐标是对着
  // 单声部行算的，必须用总谱行重排并**显式覆盖**，不能用 spread 继承的旧值。
  const cues = placeCueStaves(score, { lines, lineHeight: rowH, unit: opts.unit ?? PX_PER_BEAT_DEFAULT / TICKS_PER_BEAT, fontSize: measured[0].glyph.fontSize });
  return { ...placed[0], lines, hitIndex, systems, width: Math.max(opts.contentWidth, left + Math.max(...widths) + (opts.padding ?? 40)), height: startY + (system + 1) * systemH + 24, naturalWidth: naturalMax, cues: cues.length ? cues : undefined };
}
