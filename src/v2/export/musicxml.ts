/**
 * MusicXML 导出（Score → MusicXML 4.0 partwise）。
 *
 * 与 musicxml.ts 的导入对称，目标是「导出→导入」往返尽量无损：
 *  - 主体是**标准 MusicXML**：音高 / 时值 / 附点 / 连音 / 力度 / 常见装饰音 /
 *    换气 / 颤音 / 波音 / 回音 / 震音 / 琶音 / 歌词 / 调号拍号速度 / 反复跳房子。
 *  - 电吹管特有技法（花舌 / 打音 / 上下滑音 / 弯音 / 吐音 / 自定义记号等）无标准
 *    对应，降级成 `<direction><words>[WS:标签]</words>`：这是**合法 MusicXML**，
 *    其它软件能打开（当文字提示），WindScore 导回时按约定还原，信息不丢。
 *
 * 纯函数不碰 DOM（保存走 io.saveTextAsFile）。
 */
import type {
  BarlineEvent,
  Event,
  NoteEvent,
  Score,
  ScorePart,
  TimedEvent,
} from '../types';
import { isTimed } from '../types';
import { keyFifths, legacyPitch } from '../pitch';
import { TICKS_PER_BEAT } from '../ticks';
import { parseMeter } from '../meter';
import { saveBytesAsFile, type SaveResult } from '../io';
import { safeFileName } from './tasks';

const DIVISIONS = TICKS_PER_BEAT; // duration 直接用 tick，无损
const STEP_LETTER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function ind(n: number): string { return '  '.repeat(n); }
function block(...ls: (string | null | undefined | false)[]): string {
  return ls.filter((x): x is string => !!x).join('\n');
}

/** tick → note type + 附点数（先化成以四分音符为单位的份数） */
function durationType(ticks: number): { type: string; dots: number } {
  const table: [number, string][] = [
    [8, 'whole'], [4, 'half'], [2, 'quarter'], [1, 'quarter'],
    [0.5, 'eighth'], [0.25, '16th'], [0.125, '32nd'], [0.0625, '64th'],
  ];
  for (const [base, type] of table) {
    for (let dots = 0; dots <= 3; dots += 1) {
      const want = base * (2 - Math.pow(2, -dots)) * TICKS_PER_BEAT;
      if (Math.abs(want - ticks) <= 0.5) return { type, dots };
    }
  }
  // 连音成员 / 跨拍连音：找不到常规写法按最接近的 type 输出，
  // 真实时值仍写在 <duration>（MusicXML 以 duration 为准，type 是显示提示）
  const q = ticks / TICKS_PER_BEAT;
  const nearest = table.reduce((best, cur) => Math.abs(cur[0] - q) < Math.abs(best[0] - q) ? cur : best);
  return { type: nearest[1], dots: 0 };
}

/** 简谱音 → MusicXML 的 step/alter/octave（绝对音高，含临时变音） */
function spelled(e: NoteEvent, key: string) {
  return legacyPitch(e.degree, e.octave, key, e.accidental);
}

/** 电吹管特有技法 → 中文标签（降级为 [WS:…] 文字），与导入侧约定对应 */
const WS_TECHNIQUE_LABEL: Record<string, string> = {
  flutter: '花舌', da: '打音', slideUp: '上滑音', slideDown: '下滑音', slideH: 'h滑音',
  bendUp: '上弯音', bendDown: '下弯音', turn: '回音',
};

export interface MusicXmlResult {
  xml: string;
  /** 被降级为 [WS:…] 文字的技法标签（给用户看的提示） */
  downgraded: string[];
}

/** 连线/范围段的全局配对信息：每个事件 id 上要发出的 start / stop */
interface EdgeInfo {
  tieStart: number; tieStop: number;
  slurStart: number[]; slurStop: number[];
  wedge: 'crescendo' | 'diminuendo' | 'stop' | null;
  octaveShift: { type: 'up' | 'down' | 'stop'; size: number } | null;
}
const emptyEdge = (): EdgeInfo => ({ tieStart: 0, tieStop: 0, slurStart: [], slurStop: [], wedge: null, octaveShift: null });

/**
 * 把一份 Score 序列化成 MusicXML 4.0 字符串。纯函数，无 DOM。
 */
export function scoreToMusicXml(score: Score): MusicXmlResult {
  const downgraded = new Set<string>();
  const parts: ScorePart[] = [
    { id: score.part?.id ?? 'P1', name: score.part?.name ?? '旋律', gain: score.part?.gain ?? 1,
      events: score.events, groups: score.groups },
    ...(score.parts ?? []),
  ];

  // 每个声部各自扫描连线/范围段，构造 id → EdgeInfo（tie/slur/wedge/octave-shift 的 start/stop）
  const edgesByPart = parts.map((p) => buildEdges(p.events));

  const partXml = parts.map((p, pi) => partToXml(p, pi, score, downgraded, edgesByPart[pi]!)).join('\n');
  const title = score.meta.title || '未命名';
  const partList = parts.map((p, pi) => block(
    `${ind(2)}<score-part id="${esc(p.id)}">`,
    `${ind(3)}<part-name>${esc(p.name || '旋律')}</part-name>`,
    `${ind(3)}<part-abbreviation>${esc((p.name || '旋律').slice(0, 4))}</part-abbreviation>`,
    `${ind(3)}<score-instrument id="I${esc(p.id)}"><instrument-name>${esc(p.name || 'WindScore')}</instrument-name></score-instrument>`,
    `${ind(3)}<midi-instrument id="I${esc(p.id)}"><midi-channel>${pi + 1}</midi-channel><midi-program>${Math.max(1, (p.patch ?? score.meta.patch) + 1)}</midi-program></midi-instrument>`,
    `${ind(2)}</score-part>`,
  )).join('\n');

  const xml = block(
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    `${ind(1)}<work><work-title>${esc(title)}</work-title></work>`,
    `${ind(1)}<movement-title>${esc(title)}</movement-title>`,
    `${ind(1)}<identification><creator type="composer">WindScore</creator></identification>`,
    `${ind(1)}<defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling></defaults>`,
    `${ind(1)}<part-list>`,
    partList,
    `${ind(1)}</part-list>`,
    partXml,
    '</score-partwise>',
    '',
  );
  return { xml, downgraded: [...downgraded] };
}

/** 扫描事件流：把每条 tie/slur/hairpin/octava 拆成起点和终点上的 start/stop */
function buildEdges(events: Event[]): Map<string, EdgeInfo> {
  const map = new Map<string, EdgeInfo>();
  const at = (id: string) => {
    let e = map.get(id);
    if (!e) { e = emptyEdge(); map.set(id, e); }
    return e;
  };
  let slurNo = 0;
  for (const ev of events) {
    if (ev.kind !== 'note') continue;
    for (const t of ev.ties ?? []) {
      if (t.kind === 'tie') { at(ev.id).tieStart += 1; at(t.to).tieStop += 1; }
      else {
        slurNo += 1;
        at(ev.id).slurStart.push(slurNo);
        at(t.to).slurStop.push(slurNo);
      }
    }
    if (ev.hairpin) {
      at(ev.id).wedge = ev.hairpin === 'cresc' ? 'crescendo' : 'diminuendo';
      if (ev.hairpinTo) at(ev.hairpinTo).wedge = 'stop';
    }
    if (ev.octava && !ev.octava.startsWith('con')) {
      at(ev.id).octaveShift = { type: ev.octava === 'vb' ? 'down' : 'up', size: 8 };
      if (ev.octavaTo) at(ev.octavaTo).octaveShift = { type: 'stop', size: 8 };
    }
  }
  return map;
}

function partToXml(
  part: ScorePart,
  partIndex: number,
  score: Score,
  downgraded: Set<string>,
  edges: Map<string, EdgeInfo>,
): string {
  const measures: { events: Event[]; bar?: BarlineEvent }[] = [];
  let cur: Event[] = [];
  for (const e of part.events) {
    if (e.kind === 'barline') { measures.push({ events: cur, bar: e }); cur = []; }
    else cur.push(e);
  }
  if (cur.length || !measures.length) measures.push({ events: cur });

  let key = score.meta.key;
  let beat = score.meta.beat;
  let bpm = score.meta.bpm;

  const body = measures.map((m, mi) => {
    const n = mi + 1;
    const inner: string[] = [];
    // 每个小节重写完整 attributes（divisions/key/time/clef）——简单可靠，导入器逐小节读
    inner.push(
      `${ind(3)}<attributes>`,
      `${ind(4)}<divisions>${DIVISIONS}</divisions>`,
      keyElement(key),
      timeElements(beat),
      `${ind(4)}<clef><sign>G</sign><line>2</line></clef>`,
      `${ind(3)}</attributes>`,
    );
    // 速度
    inner.push(`${ind(3)}<direction placement="above"><direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>${Math.round(bpm)}</per-minute></metronome></direction-type><sound tempo="${Math.round(bpm)}"/></direction>`);

    for (const e of m.events) {
      if (isTimed(e)) inner.push(timedXml(e, key, n, partIndex, edges, downgraded));
      else if (e.kind === 'jump') inner.push(`${ind(3)}<direction placement="above"><direction-type><words>${esc(jumpLabel(e.mark))}</words></direction-type></direction>`);
      else if (e.kind === 'directive' && e.type === 'text') inner.push(`${ind(3)}<direction placement="above"><direction-type><words>${esc(e.value)}</words></direction-type></direction>`);
    }
    if (m.bar) {
      const bl = barlineXml(m.bar);
      if (bl) inner.push(bl);
      if (m.bar.beatAfter) beat = m.bar.beatAfter;
      if (m.bar.bpmAfter) bpm = m.bar.bpmAfter;
    }
    const firstNote = m.events.find(isTimed);
    if (firstNote && firstNote.kind === 'note' && firstNote.keyChange) key = firstNote.keyChange;

    return block(`${ind(2)}<measure number="${n}">`, ...inner, `${ind(2)}</measure>`);
  }).join('\n');

  return block(`${ind(1)}<part id="${esc(part.id)}">`, body, `${ind(1)}</part>`);
}

function keyElement(key: string): string {
  const f = keyFifths(key);
  return `${ind(4)}<key><fifths>${f}</fifths><mode>major</mode></key>`;
}

function timeElements(beat: string): string {
  const segs = parseMeter(beat);
  if (!segs || !segs.length) return `${ind(4)}<time><beats>4</beats><beat-type>4</beat-type></time>`;
  const s = segs[0]!;
  const time = `${ind(4)}<time><beats>${s.num}</beats><beat-type>${s.den}</beat-type></time>`;
  if (segs.length === 1) return time;
  // 备选/交替拍子：MusicXML 单 <time> 写不下，首段入 <time>，其余以文字标注
  return time + '\n' + `${ind(4)}<direction placement="above"><direction-type><words>${esc('拍号（备选）：' + segs.map((x) => `${x.num}/${x.den}`).join(' | '))}</words></direction-type></direction>`;
}

function jumpLabel(mark: string): string {
  return ({ segno: 'Segno', coda: 'Coda', fine: 'Fine', dc: 'D.C.', ds: 'D.S.', tocoda: 'D.C. al Coda' } as Record<string, string>)[mark] ?? mark;
}

function barlineXml(b: BarlineEvent): string | null {
  const parts: string[] = [];
  if (b.repeat === 'start' || b.repeat === 'both') parts.push('<repeat direction="forward"/>');
  if (b.repeat === 'end' || b.repeat === 'both') parts.push(`<repeat direction="backward"${b.times && b.times !== 2 ? ` times="${b.times}"` : ''}/>`);
  if (b.volta?.length) parts.push(`<ending number="${b.volta.join(',')}" type="${b.voltaOpen ? 'start' : 'stop'}">${b.volta.join(',')}</ending>`);
  if (b.style === 'final') parts.push('<bar-style>light-heavy</bar-style>');
  else if (b.style === 'double') parts.push('<bar-style>light-light</bar-style>');
  if (!parts.length) return null;
  return block(`${ind(3)}<barline location="right">`, ...parts.map((p) => `${ind(4)}${p}`), `${ind(3)}</barline>`);
}

function timedXml(
  e: TimedEvent,
  key: string,
  measureNo: number,
  partIndex: number,
  edges: Map<string, EdgeInfo>,
  downgraded: Set<string>,
): string {
  void measureNo;
  const edge = edges.get(e.id) ?? emptyEdge();
  const pre: string[] = []; // 音符前的 <direction>（力度/文字/渐强等）
  const note: string[] = [];
  const { type, dots } = durationType(e.ticks);

  // 标准方向记号：力度 / 渐强渐弱 / 八度演奏段（写在音符前）
  if (e.kind === 'note') {
    if (e.dynamic) pre.push(`${ind(3)}<direction placement="below"><direction-type><dynamics><${esc(e.dynamic)}/></dynamics></direction-type></direction>`);
    if (edge.wedge) pre.push(`${ind(3)}<direction placement="below"><direction-type><wedge type="${edge.wedge}"/></direction-type></direction>`);
    if (edge.octaveShift) pre.push(`${ind(3)}<direction placement="above"><direction-type><octave-shift type="${edge.octaveShift.type}" size="${edge.octaveShift.size}"/></direction-type></direction>`);
    // 电吹管特有技法 → [WS:…] 文字
    const words: string[] = [];
    for (const t of e.techniques ?? []) {
      const label = WS_TECHNIQUE_LABEL[t];
      if (label) { words.push(`[WS:${label}]`); downgraded.add(label); }
    }
    if (e.tongue) {
      const label = e.tongue === 'T' ? '单吐' : '双吐';
      words.push(`[WS:${label}]`); downgraded.add(label);
    }
    if (e.mark) { words.push(`[WS:${e.mark}]`); downgraded.add(e.mark); }
    if (e.fingering) words.push(`[指法:${e.fingering}]`);
    if (words.length) pre.push(`${ind(3)}<direction placement="above"><direction-type><words>${esc(words.join(' '))}</words></direction-type></direction>`);
  }

  // 倚音（不占时值）：作为独立的 <grace> note 写在主音前面
  if (e.kind === 'note') {
    for (const g of [...(e.graceBefore ?? []), ...(e.graceAfter ?? [])]) {
      const sp = legacyPitch(g.degree, g.octave, key, g.accidental);
      note.push(block(
        `${ind(3)}<note>`,
        `${ind(4)}<grace/>`,
        `${ind(4)}<pitch><step>${STEP_LETTER[sp.step]}</step>${sp.alter ? `<alter>${sp.alter}</alter>` : ''}<octave>${sp.octave}</octave></pitch>`,
        `${ind(4)}<type>eighth</type>`,
        `${ind(3)}</note>`,
      ));
    }
  }

  note.push(`${ind(3)}<note>`);
  if (e.kind === 'rest') {
    // X 无音高音符（打击/拍手）：用标准 unpitched 记谱；普通休止用 <rest/>
    if (e.x) note.push(`${ind(4)}<unpitched><display-step>C</display-step><display-octave>4</display-octave></unpitched>`);
    else note.push(`${ind(4)}<rest/>`);
  } else {
    const sp = spelled(e, key);
    note.push(`${ind(4)}<pitch><step>${STEP_LETTER[sp.step]}</step>${sp.alter ? `<alter>${sp.alter}</alter>` : ''}<octave>${sp.octave}</octave></pitch>`);
  }
  note.push(`${ind(4)}<duration>${e.ticks}</duration>`);
  note.push(`${ind(4)}<voice>${partIndex + 1}</voice>`);
  note.push(`${ind(4)}<type>${type}</type>`);
  for (let i = 0; i < dots; i += 1) note.push(`${ind(4)}<dot/>`);
  // <tie> 必须是 <note> 的直接子元素（导入器按 kids(note,'tie') 读）
  for (let i = 0; i < edge.tieStart; i += 1) note.push(`${ind(4)}<tie type="start"/>`);
  for (let i = 0; i < edge.tieStop; i += 1) note.push(`${ind(4)}<tie type="stop"/>`);

  if (e.kind === 'note') {
    const notations: string[] = [];
    // <tied> 放在 notations 里（标准 MusicXML 写法，导入器不读也无害）
    for (let i = 0; i < edge.tieStart; i += 1) notations.push(`${ind(5)}<tied type="start"/>`);
    for (let i = 0; i < edge.tieStop; i += 1) notations.push(`${ind(5)}<tied type="stop"/>`);
    for (const no of edge.slurStart) notations.push(`${ind(5)}<slur type="start" number="${no}"/>`);
    for (const no of edge.slurStop) notations.push(`${ind(5)}<slur type="stop" number="${no}"/>`);
    // ornaments
    const orn: string[] = [];
    if (e.techniques?.includes('trill') || e.ornaments?.some((o) => o.kind === 'trill')) orn.push(`${ind(6)}<trill-mark/>`);
    if (e.ornaments?.some((o) => o.kind === 'turn')) orn.push(`${ind(6)}<turn/>`);
    if (e.ornaments?.some((o) => o.kind === 'mordent') || e.techniques?.includes('mordentDown')) orn.push(`${ind(6)}<mordent/>`);
    if (e.techniques?.includes('mordentUp')) orn.push(`${ind(6)}<inverted-mordent/>`);
    if (e.tremolo) orn.push(`${ind(6)}<tremolo type="single">${e.tremolo}</tremolo>`);
    if (e.arpeggio) orn.push(`${ind(6)}<arpeggiate/>`);
    if (e.fermata) orn.push(`${ind(6)}<fermata type="upright"/>`);
    if (orn.length) notations.push(`${ind(5)}<ornaments>`, ...orn, `${ind(5)}</ornaments>`);
    // articulations
    const arts: string[] = [];
    if (e.articulations?.includes('staccato')) arts.push(`${ind(6)}<staccato/>`);
    if (e.articulations?.includes('tenuto')) arts.push(`${ind(6)}<tenuto/>`);
    if (e.articulations?.includes('accent')) arts.push(`${ind(6)}<accent/>`);
    if (e.articulations?.includes('marcato')) arts.push(`${ind(6)}<strong-accent/>`);
    if (e.techniques?.includes('breath')) arts.push(`${ind(6)}<breath-mark/>`);
    if (arts.length) notations.push(`${ind(5)}<articulations>`, ...arts, `${ind(5)}</articulations>`);

    if (notations.length) {
      note.push(`${ind(4)}<notations>`, ...notations, `${ind(4)}</notations>`);
    }
    // 歌词
    for (let li = 0; li < (e.lyrics?.length ?? 0); li += 1) {
      const text = e.lyrics?.[li] ?? '';
      if (!text) continue;
      note.push(`${ind(4)}<lyric number="${li + 1}"><syllabic>single</syllabic><text>${esc(text)}</text></lyric>`);
    }
  }
  note.push(`${ind(3)}</note>`);
  return block(...pre, ...note);
}

export interface ExportMusicXmlOptions {
  score: Score;
  name: string;
}

/** 导出到文件（Tauri 原生保存 / 浏览器下载），复用统一的落盘 helper */
export async function exportScoreMusicXmlToFile(opts: ExportMusicXmlOptions): Promise<SaveResult> {
  const { xml } = scoreToMusicXml(opts.score);
  return saveBytesAsFile(new TextEncoder().encode(xml), `${safeFileName(opts.name)}.musicxml`, {
    ext: 'musicxml',
    mime: 'application/vnd.recordare.musicxml+xml',
    label: 'MusicXML 乐谱',
  });
}
