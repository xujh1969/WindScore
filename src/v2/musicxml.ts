/**
 * MusicXML → JPS 转译（实验性测试功能，2026-10-31）。
 *
 * 范围与策略：
 *  - 自带**迷你 XML 解析器**（记谱软件导出的 MusicXML 都是良构 XML），
 *    不依赖 DOMParser——纯 TS 可在 Node 里跑回归。
 *  - `.mxl` 是 zip 容器：中央目录解出条目，压缩条目（method 8）用
 *    DecompressionStream('deflate-raw') 解压（Chrome/WebView2/Node 20+ 都有）；
 *    优先读 META-INF/container.xml 指定的 rootfile。
 *  - 每声部只取**第一个出现的人声**（多声部谱跳过其余，计数告警）；
 *    和弦只留最高音（电吹管单旋律用途）。
 *  - 时值 = duration/divisions（以四分音符为一拍），分数精确匹配 DSL 写法：
 *    整拍增时线 / 常规减时线 / 附点；一拍内连音按 <n: …> 组包裹（成员 /3 /5 /6 /7）；
 *    跨拍连音与无法表达时值**就近近似并告警**，不静默。
 *  - 调号 fifths → @key；谱中换调 → `转1=X`；拍号变化 → 线后 `拍N/M`；
 *    速度 → @bpm 与线后 `速n`；反复 → `|:` / `:|`（times>2 写 `:|n`）；终止线 `||`；
 *    房子 <ending> → `[n]`；弱起首小节 → `|{partial}`；
 *    连线 slur → ( )；延音线 tie → `~`；吐音类 Articulations → ! = >；力度 → p f mf ff…；
 *    倚音 → `{56}3`；歌词、指法等暂不支持（计数告警）。
 */

import { parseDsl } from './dsl';
import { layoutScore } from './layout';

/* ─────────────────────────── 迷你 XML 解析器 ─────────────────────────── */

export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 良构 XML → 节点树。只解析记谱软件会产出的常规结构；异常一律记 errors 不抛 */
export function parseXml(src: string): { root: XNode | null; errors: string[] } {
  const errors: string[] = [];
  const stack: XNode[] = [];
  let root: XNode | null = null;
  let i = 0;
  let textBuf = '';
  const flushText = (): void => {
    const top = stack.length ? stack[stack.length - 1] : null;
    const t = textBuf.trim();
    if (top && t) top.text = t;
    textBuf = '';
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      textBuf += src.slice(i);
      break;
    }
    textBuf += src.slice(i, lt);
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      // 处理指令 / DOCTYPE：跳到本段结束（引号里的 > 不算）
      let j = lt + 1;
      let quote: string | null = null;
      while (j < src.length) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    flushText();
    const gt = src.indexOf('>', lt);
    if (gt < 0) {
      errors.push('XML 标签没有结束 >');
      break;
    }
    const inner = src.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const node = stack.pop();
      if (!node) {
        errors.push(`多余的闭标签 </${name}>`);
        continue;
      }
      if (node.tag !== name) errors.push(`标签不匹配：<${node.tag}> 对 </${name}>`);
      if (!stack.length && !root) root = node;
      continue;
    }
    const selfClose = inner.endsWith('/');
    const body = selfClose ? inner.slice(0, -1) : inner;
    const sp = body.search(/\s/);
    const tag = (sp < 0 ? body : body.slice(0, sp)).trim();
    const attrs: Record<string, string> = {};
    const attrSrc = sp < 0 ? '' : body.slice(sp + 1);
    const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrSrc))) attrs[am[1]] = decodeEntities(am[3] ?? am[4] ?? '');
    const node: XNode = { tag, attrs, children: [], text: '' };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (!root) root = node;
    if (!selfClose) stack.push(node);
  }
  flushText();
  if (stack.length) errors.push(`XML 结束时还有未闭合的标签：${stack.map((n) => n.tag).join('、')}`);
  if (!root && !errors.length) errors.push('XML 里没有找到根节点');
  return { root, errors };
}

const kids = (n: XNode | null | undefined, tag: string): XNode[] =>
  n ? n.children.filter((c) => c.tag === tag) : [];
const kid = (n: XNode | null | undefined, tag: string): XNode | undefined => kids(n, tag)[0];
const textOf = (n: XNode | null | undefined): string => (n ? n.text.trim() : '');
const numOf = (s: string | undefined | null): number | null => {
  if (s === undefined || s === null || s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/* ─────────────────────────── .mxl（zip 容器） ─────────────────────────── */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前环境不支持解压 .mxl（需要 DecompressionStream）；请改用未压缩的 .musicxml / .xml 文件');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** 解开 .mxl（zip），返回主 XML 文本。压缩 / 未压缩条目都认。 */
export async function unzipMusicXml(bytes: Uint8Array): Promise<string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 找 EOCD（0x06054b50），容忍结尾注释
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 .mxl / zip 文件（找不到 zip 结尾标记）');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries: { name: string; method: number; data: Uint8Array }[] = [];
  for (let n = 0; n < count; n += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) break; // 中央目录文件头
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // 本地文件头里的名字 / 扩展字段长度可能与中央目录不同——按本地头算数据起点
    if (dv.getUint32(localOff, true) === 0x04034b50) {
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      entries.push({ name, method, data: bytes.subarray(start, start + size) });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  // 主文件：container.xml 指定的 rootfile 优先，否则取 META-INF 外第一个 xml
  let picked: { name: string; method: number; data: Uint8Array } | undefined;
  const container = entries.find((e) => e.name.toUpperCase() === 'META-INF/CONTAINER.XML');
  if (container) {
    try {
      const containerText =
        container.method === 0
          ? new TextDecoder().decode(container.data)
          : new TextDecoder().decode(await inflateRaw(container.data));
      const { root } = parseXml(containerText);
      const path = root?.children
        .flatMap((c) => kids(c, 'rootfile').map((r) => r.attrs['full-path'] ?? ''))
        .find(Boolean);
      if (path) picked = entries.find((e) => e.name === path);
    } catch {
      /* container 解析失败就按默认规则挑 */
    }
  }
  if (!picked) {
    picked = entries.find(
      (e) => !e.name.toUpperCase().startsWith('META-INF/') && /\.(xml|musicxml)$/i.test(e.name),
    );
  }
  if (!picked) throw new Error('.mxl 里没有找到 MusicXML 主文件');
  if (picked.method === 0) return new TextDecoder().decode(picked.data);
  if (picked.method === 8) return new TextDecoder().decode(await inflateRaw(picked.data));
  throw new Error(`不支持的 zip 压缩方式（method ${picked.method}）`);
}

/* ─────────────────────────── MusicXML 模型 ─────────────────────────── */

export interface MusicXmlPartInfo {
  id: string;
  name: string;
}

export interface MusicXmlSummary {
  title: string;
  parts: MusicXmlPartInfo[];
}

interface XNote {
  rest: boolean;
  grace: boolean;
  chord: boolean;
  /** 打击乐（unpitched）→ X 无音高音符（出声，时值/附点同音符） */
  unpitched: boolean;
  /** divisions 单位（grace 为 0） */
  dur: number;
  step: string;
  alter: number | null;
  octave: number;
  tieStart: boolean;
  tieStop: boolean;
  actual: number;
  normal: number;
  voice: string;
  arts: string[];
  slurStart: string[];
  slurStop: string[];
  /**
   * 显式符干方向（<stem>up/down）：只有导出软件明确写出才有值。
   * 两声部钢琴谱惯例主旋律声部符干朝上、伴奏朝下——这是主旋律提取的辅助信号；
   * 但单声部谱的符干是按音高几何位置自动算的（中线以上朝下、以下朝上），
   * 与主旋律无关，所以只在多声部层且某层「符干朝上明显占优」时才采信。
   */
  stemUp?: boolean;
  /** 延长号（fermata → @） */
  fermata?: boolean;
  /** 换气（breath-mark → V） */
  breath?: boolean;
  /** 颤音（trill-mark / wavy-line start → r） */
  trill?: boolean;
  /** 颤音波线终点（wavy-line stop → R） */
  trillEnd?: boolean;
  /** 回音（turn → u） */
  turn?: boolean;
  mordentUp?: boolean; // 上波音（inverted-mordent → m）
  mordentDown?: boolean; // 下波音（mordent → w）
  /** 单音震音斜线数（tremolo 1-3 → zz…） */
  tremolo?: number;
  /** 琶音（arpeggiate → a） */
  arpeggio?: boolean;
  /** 附着在音符前的独立 token（力度 p/f、cresc[、8va[ …），转换期注入 */
  pre?: string[];
  /** 附着在音符后的独立 token（]hairpin、]8），转换期注入 */
  post?: string[];
}

type MeasureItem =
  | { kind: 'attributes'; divisions?: number; fifths?: number; beats?: number; beatType?: number }
  | {
      kind: 'direction';
      tempo?: number;
      dynamic?: string;
      /** 渐强渐弱楔形（wedge → cresc[ / dim[ / ]hairpin） */
      wedge?: 'cresc' | 'dim' | 'stop';
      /** 八度演奏段（octave-shift → 8va[ / 8vb[ / ]8） */
      octShift?: 'up' | 'down' | 'stop';
    }
  | { kind: 'note'; note: XNote }
  | { kind: 'barline'; location: string; repeat?: 'forward' | 'backward'; times: number; barStyle?: string; ending?: string };

interface MeasureBox {
  items: MeasureItem[];
  implicit: boolean;
  /** 多小节休止（0*N）在解析期展开成 N 个相同小节，这里记总数供告警 */
  expandedRests: boolean;
  /** <print new-system / new-page> → 换行 / 分页 */
  breakAfter?: 'line' | 'page';
}

interface PartModel {
  id: string;
  name: string;
  measures: MeasureBox[];
  multiVoice: boolean;
  /** 第一声部层（主声部）的 voice 标识 */
  mainVoice: string;
  /** <midi-instrument><midi-program> − 1（0 基 GM 音色号）；源文件没写则 null */
  midiProgram: number | null;
  /** 若按符干方向识别出了主旋律声部层（多声部谱显式 <stem> 启发），记下它供告警 */
  mainVoiceByStem: string | null;
  /** 该声部共出现几个声部层 */
  voiceCount: number;
  skippedByVoice: number;
  skippedChord: number;
  skippedLyric: number;
  expandedRestMeasures: number;
  /** 遇到但 jps 不支持的记号 → 出现次数（转成「未支持：…×N」告警） */
  skippedMarks: Record<string, number>;
  /** 解析期的结构性告警（复拍子拍号求和等） */
  metaWarnings: string[];
}

const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const KEY_NAMES = ['1=C', '1=G', '1=D', '1=A', '1=E', '1=B', '1=F#', '1=C#'];
const KEY_NAMES_FLAT = ['1=C', '1=F', '1=Bb', '1=Eb', '1=Ab', '1=Db', '1=Gb', '1=Cb'];
/** 音名的字母序（C=0..B=6）与自然音高（C=0, D=2, … B=11） */
const LETTER_IDX: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** 大调音阶各音级离主音的半音数（1..7 → 0,2,4,5,7,9,11） */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11] as const;

/**
 * fifths → 主音的字母序号。升号调沿五度圈 C G D A E B F# C#，
 * 降号调沿 F Bb Eb Ab Db Gb Cb——字母序列永远是从主音起的连续七个音名。
 */
function tonicLetterIdx(f: number): number {
  const seq = f >= 0 ? [0, 4, 1, 5, 2, 6, 3, 0] : [0, 3, 6, 2, 5, 1, 4, 0];
  return seq[Math.abs(f)]!;
}

/** 首调唱名（1..7）：音名字母相对主音字母的位置（主音本身 → 1）。 */
function keyDegree(step: string, fifths: number): number {
  return ((LETTER_IDX[step]! - tonicLetterIdx(fifths) + 7) % 7) + 1;
}

/** 主音锚点的 midi（= pitch.ts toMidi 里 60+keyOffset：唱名 1、八度点 0 的实际音高）。 */
function tonicAnchor(fifths: number): number {
  const pc = (((fifths * 7) % 12) + 12) % 12;
  return 60 + (pc > 6 ? pc - 12 : pc);
}

/** 音符的绝对 midi（step + octave + alter）。 */
function noteMidi(step: string, octave: number, alter: number | null): number {
  return 12 * (octave + 1) + (LETTER_PC[step] ?? 0) + (alter ?? 0);
}

/** beat-unit → 以四分音符为 1 的倍数（metronome 换算速度用） */
const BEAT_UNIT_MULT: Record<string, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  breve: 8,
  long: 16,
  maxima: 32,
};

/** MusicXML 力度记号 → jps 力度 token（jps 只有 p pp mp mf f ff 六档，超出就近近似） */
const DYNAMIC_MAP: Record<string, string> = {
  p: 'p', pp: 'pp', ppp: 'pp', pppp: 'pp', ppppp: 'pp', pppppp: 'pp',
  mp: 'mp', mf: 'mf',
  f: 'f', ff: 'ff', fff: 'ff', ffff: 'ff',
  sf: 'f', sfz: 'f', sffz: 'ff', sfp: 'f', fp: 'f', fz: 'f', rf: 'f', rfz: 'f',
};

function parseNote(node: XNode, skipped: Record<string, number>): XNote {
  const pitch = kid(node, 'pitch');
  const step = textOf(kid(pitch, 'step')).toUpperCase();
  const timeMod = kid(node, 'time-modification');
  const slurStart: string[] = [];
  const slurStop: string[] = [];
  const arts: string[] = [];
  const note: XNote = {
    rest: !!kid(node, 'rest'),
    grace: !!kid(node, 'grace'),
    chord: !!kid(node, 'chord'),
    unpitched: !!kid(node, 'unpitched'),
    dur: numOf(textOf(kid(node, 'duration'))) ?? 0,
    step,
    alter: numOf(textOf(kid(pitch, 'alter'))),
    octave: numOf(textOf(kid(pitch, 'octave'))) ?? 4,
    tieStart: kids(node, 'tie').some((t) => t.attrs.type === 'start'),
    tieStop: kids(node, 'tie').some((t) => t.attrs.type === 'stop'),
    actual: numOf(textOf(kid(timeMod, 'actual-notes'))) ?? 1,
    normal: numOf(textOf(kid(timeMod, 'normal-notes'))) ?? 1,
    voice: textOf(kid(node, 'voice')) || '1',
    arts,
    slurStart,
    slurStop,
  };
  const stem = textOf(kid(node, 'stem'));
  if (stem === 'up') note.stemUp = true;
  else if (stem === 'down') note.stemUp = false;
  const bump = (label: string): void => {
    skipped[label] = (skipped[label] ?? 0) + 1;
  };
  for (const nt of kids(node, 'notations')) {
    for (const s of kids(nt, 'slur')) {
      if (s.attrs.type === 'start') slurStart.push(s.attrs.number ?? '1');
      else if (s.attrs.type === 'stop') slurStop.push(s.attrs.number ?? '1');
    }
    if (kids(nt, 'arpeggiate').length) note.arpeggio = true;
    if (kids(nt, 'fermata').length) note.fermata = true;
    if (kid(nt, 'glissando') || kid(nt, 'slide')) bump('滑音线（glissando / slide）');
    const orn = kid(nt, 'ornaments');
    for (const o of orn?.children ?? []) {
      if (o.tag === 'trill-mark') note.trill = true;
      else if (o.tag === 'wavy-line') {
        // 有的导出只写 wavy-line 不写 trill-mark，两者都当作颤音起点
        if (o.attrs.type === 'stop') note.trillEnd = true;
        else note.trill = true;
      } else if (o.tag === 'turn' || o.tag === 'inverted-turn') note.turn = true;
      else if (o.tag === 'mordent') note.mordentDown = true;
      else if (o.tag === 'inverted-mordent') note.mordentUp = true;
      else if (o.tag === 'tremolo') {
        const slashes = numOf(textOf(o)) ?? 0;
        if (!o.attrs.type && slashes >= 1) note.tremolo = Math.min(3, Math.round(slashes));
        else bump('多音震音（音符间的震音记号）');
      }
    }
    for (const a of kid(nt, 'articulations')?.children ?? []) {
      if (['staccato', 'accent', 'tenuto', 'strong-accent'].includes(a.tag)) arts.push(a.tag);
      else if (a.tag === 'breath-mark') note.breath = true;
    }
  }
  return note;
}

function parseScoreXml(xml: string): { title: string; parts: PartModel[]; errors: string[] } {
  const { root, errors } = parseXml(xml);
  const out: PartModel[] = [];
  if (!root) return { title: '', parts: out, errors };
  const title = textOf(kid(kid(root, 'work'), 'work-title')) || textOf(kid(root, 'movement-title'));
  const partList = kid(root, 'part-list');
  for (const partNode of kids(root, 'part')) {
    const partId = partNode.attrs.id ?? `P${out.length + 1}`;
    const measures: MeasureBox[] = [];
    let skippedByVoice = 0;
    let skippedChord = 0;
    let skippedLyric = 0;
    let expandedRestMeasures = 0;
    let mainVoice: string | null = null;
    const voiceSet = new Set<string>();
    const skippedMarks: Record<string, number> = {};
    const metaWarnings: string[] = [];
    const bump = (label: string): void => {
      skippedMarks[label] = (skippedMarks[label] ?? 0) + 1;
    };
    for (const measure of kids(partNode, 'measure')) {
      const items: MeasureItem[] = [];
      let printBreak: 'line' | 'page' | undefined;
      let afterBackup = false; // 本小节是否刚发生过 backup（用于鉴别 forward 的归属）
      for (const child of measure.children) {
        if (child.tag === 'attributes') {
          const divisions = numOf(textOf(kid(child, 'divisions')));
          const fifths = numOf(textOf(kid(kid(child, 'key'), 'fifths')));
          const timeNode = kid(child, 'time');
          let beats = numOf(textOf(kid(timeNode, 'beats')));
          const beatType = numOf(textOf(kid(timeNode, 'beat-type')));
          // 复合拍子（"3+2"/8 等）：求和近似（3+2 → 5），拍格与播放才能对上
          const beatsText = textOf(kid(timeNode, 'beats'));
          if (beats === null && beatsText && /\d+\s*\+/.test(beatsText)) {
            const sum = beatsText.split('+').map((s) => Number(s.trim())).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
            if (sum > 0) {
              beats = sum;
              metaWarnings.push(`复合拍子 ${beatsText}/${beatType ?? 8} 已按 ${sum}/${beatType ?? 8} 近似`);
            }
          }
          items.push({
            kind: 'attributes',
            ...(divisions !== null ? { divisions } : {}),
            ...(fifths !== null ? { fifths: Math.round(fifths) } : {}),
            ...(timeNode
              ? {
                  beats: beats ?? 4,
                  beatType: beatType ?? 4,
                }
              : {}),
          });
        } else if (child.tag === 'direction') {
          const sound = child.children.find((c) => c.tag === 'sound');
          let tempo = numOf(sound?.attrs.tempo ?? null);
          let dynamic: string | undefined;
          let wedge: 'cresc' | 'dim' | 'stop' | undefined;
          let octShift: 'up' | 'down' | 'stop' | undefined;
          for (const dt of kids(child, 'direction-type')) {
            for (const d of dt.children) {
              if (d.tag === 'wedge') {
                if (d.attrs.type === 'crescendo') wedge = 'cresc';
                else if (d.attrs.type === 'diminuendo') wedge = 'dim';
                else if (d.attrs.type === 'stop') wedge = wedge ?? 'stop';
              } else if (d.tag === 'octave-shift') {
                if (d.attrs.type === 'stop') octShift = octShift ?? 'stop';
                else if (d.attrs.type === 'up' || d.attrs.type === 'down') {
                  const size = Math.round(numOf(d.attrs.size ?? null) ?? 8);
                  if (size === 8) octShift = d.attrs.type as 'up' | 'down';
                  else bump('双八度演奏段（15ma / 15mb / 22…）');
                }
              } else if (d.tag === 'dynamics') {
                dynamic = dynamic ?? d.children[0]?.tag;
              } else if (d.tag === 'metronome' && tempo === null) {
                // 没有 sound tempo 时从 metronome 换算：<beat-unit>quarter×2点 → ×4
                const pm = numOf(textOf(kid(d, 'per-minute')));
                if (pm !== null && pm > 0) {
                  const mult = (BEAT_UNIT_MULT[textOf(kid(d, 'beat-unit'))] ?? 1) * (kid(d, 'beat-unit-dot') ? 1.5 : 1);
                  tempo = pm * mult;
                }
              } else if (d.tag === 'segno' || d.tag === 'coda') {
                bump('跳转记号（Segno / Coda）');
              } else if (d.tag === 'words') {
                bump('文字记号（速度 / 表情术语，如 rit. / accel.）');
              }
            }
          }
          for (const jump of ['dacapo', 'dalsegno', 'coda', 'segno', 'fine', 'tocoda']) {
            if (sound?.attrs[jump] !== undefined) {
              bump('跳转记号（D.C. / D.S. / Fine / Coda）');
              break;
            }
          }
          items.push({
            kind: 'direction',
            ...(tempo !== null ? { tempo } : {}),
            ...(dynamic ? { dynamic } : {}),
            ...(wedge ? { wedge } : {}),
            ...(octShift ? { octShift } : {}),
          });
        } else if (child.tag === 'forward') {
          // <forward> = 时间推进（鼓谱常拿它代替休止）→ 转成休止 0，
          // 否则后面的音符整体前移、小节拍数全错。
          // 但 backup 之后的 forward 多半是第二声部的光标重定位（常不带 voice 标记），
          // 不是第一声部的休止——转了就会超拍。
          const fdur = numOf(textOf(kid(child, 'duration'))) ?? 0;
          const fv = textOf(kid(child, 'voice'));
          if (
            fdur > 0 &&
            (mainVoice === null || !fv || fv === mainVoice) &&
            !(afterBackup && !fv)
          ) {
            items.push({
              kind: 'note',
              note: {
                rest: true, grace: false, chord: false, unpitched: false, dur: fdur,
                step: '', alter: null, octave: 4, tieStart: false, tieStop: false,
                actual: 1, normal: 1, voice: fv || mainVoice || '1',
                arts: [], slurStart: [], slurStop: [],
              },
            });
          }
        } else if (child.tag === 'backup') {
          // 光标回退（切换声部层用）：之后的 forward 在查明归属前先按第二声部处理
          afterBackup = true;
        } else if (child.tag === 'print') {
          if (child.attrs['new-page'] === 'yes') printBreak = 'page';
          else if (child.attrs['new-system'] === 'yes') printBreak = 'line';
        } else if (child.tag === 'note') {
          const note = parseNote(child, skippedMarks);
          if (kid(child, 'lyric')) skippedLyric += 1;
          if (mainVoice === null && !note.grace) mainVoice = note.voice;
          // 全部声部层都保留：转换期按策略取「第一层」或「天空线（最高音）」
          if (!note.grace) {
            afterBackup = false; // 主声部音符重新出现，之后的 forward 恢复为主声部休止
            voiceSet.add(note.voice);
          }
          items.push({ kind: 'note', note });
        } else if (child.tag === 'barline') {
          const repeat = kid(child, 'repeat');
          const ending = kid(child, 'ending');
          items.push({
            kind: 'barline',
            location: child.attrs.location ?? 'right',
            ...(repeat ? { repeat: (repeat.attrs.direction as 'forward' | 'backward') ?? 'forward' } : {}),
            times: numOf(repeat?.attrs.times ?? null) ?? 2,
            ...(child.attrs['bar-style'] ? { barStyle: child.attrs['bar-style'] } : {}),
            ...(ending && ending.attrs.number ? { ending: ending.attrs.number } : {}),
          });
        } else if (child.tag === 'harmony') {
          bump('和弦符号（Harmony，吉他谱等）');
        }
        // backup / forward 等忽略：只取主声部的顺序音符流
      }
      const box: MeasureBox = {
        items,
        implicit: measure.attrs.implicit === 'yes',
        expandedRests: false,
        ...(printBreak ? { breakAfter: printBreak } : {}),
      };
      measures.push(box);
      // 多小节休止：<measure-style><multiple-rest>N</multiple-rest> 整段折叠成 1 个小节，
      // 这里展开成 N 个相同小节（整小节休止 + 小节线），小节数与原谱对齐
      const mr = numOf(textOf(kid(kid(measure, 'measure-style'), 'multiple-rest')));
      if (mr && mr >= 2) {
        for (let k = 1; k < Math.round(mr); k += 1) {
          measures.push({ ...box, expandedRests: true });
          expandedRestMeasures += 1;
        }
        box.expandedRests = true;
      }
    }
    let name = partId;
    let midiProgram: number | null = null;
    if (partList) {
      for (const sp of kids(partList, 'score-part')) {
        if (sp.attrs.id === partId) {
          name = textOf(kid(sp, 'part-name')) || partId;
          // <midi-instrument> 可能多个（多音色声部），取第一个带 midi-program 的；
          // MusicXML 的 midi-program 是 1 基（钢琴=1），WindScore 音色号 0 基
          for (const mi of kids(sp, 'midi-instrument')) {
            const prog = numOf(textOf(kid(mi, 'midi-program')));
            if (prog !== null && prog >= 1 && prog <= 128) {
              midiProgram = prog - 1;
              break;
            }
          }
          break;
        }
      }
    }
    // ── 符干启发（主旋律识别）──
    // 两声部钢琴谱惯例：主旋律声部符干朝上（voice 1）、伴奏符干朝下。
    // 只有「多声部层 + 显式写了 <stem> + 某层朝上明显占优」才采信：
    // 单声部谱的符干方向按音高几何自动算，与主旋律无关；
    // 伴奏偶尔也有朝上的音（超过旋律线的低音等），所以要「明显占优」而非简单多数。
    let stemMainVoice: string | null = null;
    if (voiceSet.size > 1) {
      const tally = new Map<string, { up: number; down: number }>();
      for (const m of measures) {
        for (const it of m.items) {
          if (it.kind !== 'note') continue;
          const n = it.note;
          if (n.grace || n.rest || n.stemUp === undefined) continue;
          const t = tally.get(n.voice) ?? { up: 0, down: 0 };
          if (n.stemUp) t.up += 1;
          else t.down += 1;
          tally.set(n.voice, t);
        }
      }
      let bestUp = 0;
      for (const [v, t] of tally) {
        if (t.up >= 4 && t.up > t.down * 2 && t.up > bestUp) {
          stemMainVoice = v;
          bestUp = t.up;
        }
      }
    }
    // ── 调号推断（2026-11-01）──
    // 先信 XML 的 <key><fifths>；但转录工具（Muscriptor 等）常把调号留成 C（fifths=0）
    // 而把调内变音逐音标在音符上（F#、C#…），首调转换后就会满篇 #1 #4。
    // 这里按音高内容（时长加权的音级集合）检验各候选调的吻合度，
    // 「明显更优」才改判：分数 ≥0.85 且比声明调高出 ≥0.15，四个以上不同音级。
    // 小调内容会命中关系大调（同一套音级）——首调记谱这正是正确结果。
    let declaredFifths = 0;
    outer: for (const m of measures) {
      for (const it of m.items) {
        if (it.kind === 'attributes' && it.fifths !== undefined) {
          declaredFifths = it.fifths;
          break outer;
        }
      }
    }
    const pcWeight = new Array<number>(12).fill(0);
    let pcTotal = 0;
    for (const m of measures) {
      for (const it of m.items) {
        if (it.kind !== 'note') continue;
        const n = it.note;
        if (n.rest || !n.step || LETTER_PC[n.step] === undefined) continue;
        const pc = (((LETTER_PC[n.step] + (n.alter ?? 0)) % 12) + 12) % 12;
        pcWeight[pc] += Math.max(0, n.dur);
        pcTotal += Math.max(0, n.dur);
      }
    }
    let distinctPcs = 0;
    for (const w of pcWeight) if (w > 0) distinctPcs += 1;
    if (pcTotal > 0 && distinctPcs >= 4) {
      const scaleScore = (f: number): number => {
        const tonic = (((f * 7) % 12) + 12) % 12;
        let inScale = 0;
        for (const off of MAJOR_STEPS) inScale += pcWeight[(tonic + off) % 12]!;
        return inScale / pcTotal;
      };
      const scores = new Map<number, number>();
      let bestScore = -1;
      for (let f = -7; f <= 7; f += 1) {
        const s = scaleScore(f);
        scores.set(f, s);
        if (s > bestScore) bestScore = s;
      }
      const candidates = [...scores.entries()].filter(([, s]) => s >= bestScore - 1e-9).map(([f]) => f);
      // 并列时优先声部声明的调，其次绝对值小（更接近 C）
      const bestF = candidates.includes(declaredFifths)
        ? declaredFifths
        : candidates.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
      if (
        bestF !== declaredFifths &&
        scores.get(bestF)! >= 0.85 &&
        scores.get(bestF)! - scores.get(declaredFifths)! >= 0.15
      ) {
        for (const m of measures) {
          for (const it of m.items) {
            if (it.kind === 'attributes' && it.fifths !== undefined) it.fifths = bestF;
          }
        }
        metaWarnings.push(
          `源文件调号为 ${keyName(declaredFifths)}，但音高内容明显属于 ${keyName(bestF)}，已按 ${keyName(bestF)} 首调转换`,
        );
      }
    }
    out.push({
      id: partId,
      name,
      midiProgram,
      measures,
      multiVoice: voiceSet.size > 1,
      mainVoice: stemMainVoice ?? mainVoice ?? voiceSet.values().next().value ?? '1',
      mainVoiceByStem: stemMainVoice,
      voiceCount: voiceSet.size,
      skippedByVoice,
      skippedChord,
      skippedLyric,
      expandedRestMeasures,
      skippedMarks,
      metaWarnings,
    });
  }
  return { title, parts: out, errors };
}

/* ─────────────────────────── 时值 → DSL ─────────────────────────── */

interface Frac {
  n: number;
  d: number;
}

function gcd(a: number, b: number): number {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function reduce(n: number, d: number): Frac {
  const g = gcd(Math.abs(n), Math.abs(d)) || 1;
  return { n: n / g, d: d / g };
}

const fracVal = (f: Frac): number => f.n / f.d;
const fracEq = (a: Frac, b: Frac): boolean => a.n * b.d === b.n * a.d;

/**
 * 一拍为单位的时值 → DSL 后缀（不含音级）。
 * 精确匹配：与 dsl.ts renderDuration 同构——增时线（整拍）+ 减时线×附点 组合，
 * 即 时值 = d 整拍 + (1/2^b) × 附点系数。增时线从少到多试（最短写法优先），
 * 覆盖 2.5 拍（附点二分 `.-`）这类「增时线 + 附点」混合值——
 * 只搜纯整拍或纯细分会把 2.5 拍休止向上近似成 3 拍（`0--`），小节直接超拍。
 */
export function durationSuffix(beats: Frac): string | null {
  if (beats.n <= 0 || beats.d <= 0) return null;
  const maxDashes = Math.floor(fracVal(beats));
  for (let d = 0; d <= maxDashes; d += 1) {
    // 剩余部分必须是 (1/2^b) × (2 − 1/2^dot)：dot=0 → 1×，1 → 1.5×，2 → 1.75×
    const restN = beats.n - d * beats.d; // 扣掉 d 个整拍（增时线）后剩余的分子
    for (let b = 0; b <= 3; b += 1) {
      for (let dot = 0; dot <= 2; dot += 1) {
        const den = 2 ** (b + dot);
        if (restN * den === beats.d * (2 ** (dot + 1) - 1)) {
          // 写法顺序与 dsl.ts renderDuration / NOTE_RE 一致：点 → 除法 → 增时线
          return '.'.repeat(dot) + (b > 0 ? `/${2 ** b}` : '') + '-'.repeat(d);
        }
      }
    }
    if (restN <= 0) break;
  }
  return null;
}

/** 连音成员：1/3、1/5、1/6、1/7 → /3 /5 /6 /7（num===1 才能直接写） */
function tupletMemberSuffix(beats: Frac): string | null {
  if (beats.n === 1 && [3, 5, 6, 7].includes(beats.d)) return `/${beats.d}`;
  return null;
}

/** 就近近似：从常用时值里挑最接近的（跨拍连音等无法无损表达时用，必带告警） */
function nearestSuffix(beats: Frac): string {
  const cands: Frac[] = [4, 3, 2, 1.75, 1.5, 1, 0.75, 0.5, 0.375, 0.25, 0.1875, 0.125, 0.0625].map((v) =>
    reduce(Math.round(v * 64), 64),
  );
  let best = cands[0];
  let bestDiff = Math.abs(fracVal(beats) - fracVal(best));
  for (const c of cands) {
    const diff = Math.abs(fracVal(beats) - fracVal(c));
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return durationSuffix(best) ?? '';
}

/* ─────────────────────────── 声部 → DSL ─────────────────────────── */

function keyName(fifths: number): string {
  const f = Math.max(-7, Math.min(7, fifths));
  return f >= 0 ? KEY_NAMES[f] : KEY_NAMES_FLAT[-f];
}

/* ─── 乐器名 → 音色号（转换时自动配好，免手工再选） ───
   先用 XML 的 <midi-instrument><midi-program>（最可靠）；
   没写再按声部名模糊匹配——允许「Grand Piano / 原声钢琴 / 钢琴右手」这类叫法差异，
   只要是钢琴就配钢琴。规则按「更具体的在前」排序：
   bassoon / clarinet / drum 必须排在兜底的 bass 之前，否则 'bass' 会子串误配。 */
const PATCH_RULES: ReadonlyArray<readonly [string[], number]> = [
  [['电吹管', 'ewi'], 65],
  [['bassoon', '巴松', '大管'], 70],
  [['clarinet', '单簧管', '黑管'], 71],
  [['oboe', '双簧管'], 68],
  [['sax', '萨克斯'], 65],
  [['drum', '鼓', 'percussion', '打击'], 0],
  [['double bass', 'contrabass', '低音提琴'], 43],
  [['acoustic bass', '原声贝斯', 'string bass'], 32],
  [['电贝斯', '贝斯', 'electric bass', 'bass guitar'], 33],
  [['bass'], 33],
  [['electric piano', '电钢琴', 'rhodes'], 4],
  [['piano', '钢琴', 'pianoforte'], 0],
  [['violin', '小提琴'], 40],
  [['viola', '中提琴'], 41],
  [['cello', 'violoncello', '大提琴'], 42],
  [['nylon', '古典吉他', 'classical guitar'], 24],
  [['electric guitar', '电吉他'], 27],
  [['acoustic guitar', 'steel guitar', '民谣吉他', '木吉他'], 25],
  [['guitar', '吉他'], 25],
  [['piccolo', '短笛'], 72],
  [['flute', '长笛'], 73],
  [['trumpet', '小号'], 56],
  [['french horn', '圆号'], 60],
  [['trombone', '长号'], 57],
  [['tuba', '大号'], 58],
  [['harp', '竖琴'], 46],
  [['timpani', '定音鼓'], 47],
  [['marimba', '马林巴'], 12],
  [['vibraphone', '电颤琴', '颤音琴'], 11],
  [['xylophone', '木琴'], 13],
  [['organ', '管风琴', '风琴'], 19],
  [['accordion', '手风琴'], 21],
  [['harmonica', '口琴'], 22],
  [['strings', '弦乐', 'string ensemble'], 48],
  [['synth', '合成'], 80],
];

/** 声部音色：midi-program 优先，其次乐器名模糊匹配，都不行退回长笛（旋律中性默认）。 */
function resolvePatch(name: string, midiProgram: number | null): number {
  if (midiProgram !== null) return Math.max(0, Math.min(127, midiProgram));
  const n = name.toLowerCase();
  for (const [kws, patch] of PATCH_RULES) {
    if (kws.some((k) => n.includes(k))) return patch;
  }
  return 73;
}

/** 调号里该音级自带的升降（相对自然音级） */
function impliedAlter(step: string, fifths: number): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

function accidentalDsl(step: string, alter: number | null, fifths: number): string {
  if (alter === null) return '';
  const diff = alter - impliedAlter(step, fifths);
  if (diff === 0) return '';
  if (diff === 1) return '#';
  if (diff === 2) return '##';
  if (diff === -1) return 'b';
  if (diff === -2) return 'bb';
  return diff < 0 ? 'bb' : '##'; // ±3 以上超纲，钳到重升重降
}

/** 八度点：+n → n 个 ^，−n → n 个 v（0 = 中音组）。 */
function octaveDots(off: number): string {
  const c = Math.max(-3, Math.min(3, off));
  return c > 0 ? '^'.repeat(c) : 'v'.repeat(-c);
}

interface TokenParts {
  prefix: string;
  /** 不含时值后缀的音高主体（连音成员要换成 /3 这类成员写法） */
  bare: string;
  token: string;
  suffix: string;
}

function cmpPitch(a: XNote, b: XNote): number {
  const val = (n: XNote): number =>
    (n.octave + 1) * 12 + { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[n.step]! + (n.alter ?? 0);
  return val(a) - val(b);
}

interface PartConvertResult {
  lines: string[];
  warnings: string[];
  /** 首小节的调号（谱头 @key 用它，别用中性默认） */
  headerKey: string;
  /** 转换出的有音高音符数（0 = 该声部实质没内容，多为纯打击乐） */
  noteCount: number;
}

/**
 * 主旋律提取策略：
 * - 'first'：只取第一声部层（原行为，适合单旋律谱）
 * - 'top'：天空线——所有声部层放到同一时间轴，每个时间片取正在响的最高音；
 *   被更高音打断的长音用延音线接回，无声片段补休止。适合钢琴/吉他等多旋律谱。
 */
type MelodyStrategy = 'first' | 'top';

function convertPartModel(model: PartModel, warnings: string[], melody: MelodyStrategy): PartConvertResult {
  const warnOnce = (msg: string): void => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };
  if (model.mainVoiceByStem) {
    warnOnce('按符干方向（朝上）识别出主旋律声部层' + (melody === 'first' ? '，已只转该层' : '，同音时优先取该层'));
  }

  let divisions = 4;
  let fifths = 0;
  let headerFifths: number | null = null;
  let emittedFifths = 0;
  let time: Frac | null = null;
  let emittedTime: Frac | null = null;
  let tempo: number | null = null;
  let first = true;
  const openSlurs = new Set<string>();
  const lines: string[] = [];
  let cur: string[] = [];

  /** 一个音符 / 休止 → token 三段（连线括号前缀 / 主体 / 括号 + 延音 + 技法后缀） */
  const noteTokens = (note: XNote): TokenParts | null => {
    if (note.rest) {
      if (note.grace) return null;
      const suf = durationSuffix(reduce(note.dur, divisions)) ?? nearestSuffix(reduce(note.dur, divisions));
      return { prefix: '', bare: '0', token: `0${suf}`, suffix: note.fermata ? '@' : '' };
    }
    // 打击乐（unpitched）→ X 无音高音符：出声（打击采样）、无固定音高，
    // 时值 / 附点 / 连音与普通音符一致，拍数校验照常计入
    const isUnpitched = !note.step || LETTER_PC[note.step] === undefined;
    if (isUnpitched && !note.unpitched) {
      warnOnce('MusicXML 里有缺少音高的音符，已跳过');
      return null;
    }
    if (isUnpitched && note.grace) {
      warnOnce('打击乐倚音（unpitched grace）暂不支持，已跳过');
      return null;
    }
    const acc = isUnpitched ? '' : accidentalDsl(note.step, note.alter, fifths);
    // 首调唱名：音名字母相对调主音的位置（1=D 时 D→1、F#→3），变音记号
    // 由 accidentalDsl 按「相对调号」给出——调内音不写任何 #/b
    const degNum = isUnpitched ? 0 : keyDegree(note.step, fifths);
    const deg = isUnpitched ? 'X' : String(degNum);
    // 八度点从绝对音高反解：写出来的 token 按当前调播放必须还是原音高
    // （oct = (noteMidi − 主音锚点 − 唱名音程 − 记谱变音) / 12，纯数学恒等）
    const octOff = isUnpitched
      ? 0
      : Math.round(
          (noteMidi(note.step, note.octave, note.alter) -
            tonicAnchor(fifths) -
            MAJOR_STEPS[degNum - 1]! -
            ((note.alter ?? 0) - impliedAlter(note.step, fifths))) /
            12,
        );
    if (note.grace) {
      // 倚音不带时值后缀（jps 倚音 {5}3 的花括号内只有音高）
      return { prefix: '', bare: `${acc}${deg}${octaveDots(octOff)}`, token: `${acc}${deg}${octaveDots(octOff)}`, suffix: '' };
    }
    const beats = reduce(note.dur, divisions);
    let suf = durationSuffix(beats);
    if (suf === null) {
      const member = tupletMemberSuffix(beats);
      if (member && note.actual > 1) suf = member;
      else {
        suf = nearestSuffix(beats);
        warnOnce('谱里有无法精确表达的时值（多为跨拍连音），已按最近的常规时值近似');
      }
    }
    let prefix = '';
    let suffix = '';
    for (const sn of note.slurStart) {
      if (!openSlurs.has(sn)) {
        openSlurs.add(sn);
        prefix += '(';
      }
    }
    const stops = note.slurStop.filter((sn) => openSlurs.has(sn));
    for (const sn of stops) openSlurs.delete(sn);
    suffix += ')'.repeat(stops.length);
    if (note.tieStart) suffix += '~';
    for (const a of note.arts) {
      if (a === 'staccato') suffix += '!';
      else if (a === 'accent' || a === 'strong-accent') suffix += '>';
      else if (a === 'tenuto') suffix += '=';
    }
    // 装饰记号（jps 技法后缀，NOTE_RE 字母类）：@ 延长号 / V 换气 / r 颤音 /
    // R 波线终点 / u 回音 / m 上波音 / w 下波音 / z 震音 / a 琶音
    if (note.fermata) suffix += '@';
    if (note.breath) suffix += 'V';
    if (note.trill) suffix += 'r';
    if (note.trillEnd) suffix += 'R';
    if (note.turn) suffix += 'u';
    if (note.mordentUp) suffix += 'm';
    if (note.mordentDown) suffix += 'w';
    if (note.tremolo) suffix += 'z'.repeat(note.tremolo);
    if (note.arpeggio) suffix += 'a';
    return { prefix, bare: `${acc}${deg}${octaveDots(octOff)}`, token: `${acc}${deg}${octaveDots(octOff)}${suf}`, suffix };
  };

  const flushGraces = (graces: XNote[]): string =>
    graces.length ? `{${graces.map((g) => noteTokens(g)?.token ?? '').join('')}}` : '';

  let noteCount = 0;

  /** 附着 token 的拼装：pre 在 token 前（各带空格），post 在 token 后 */
  const around = (note: XNote, inner: string): string =>
    `${(note.pre ?? []).map((t) => `${t} `).join('')}${inner}${(note.post ?? []).map((t) => ` ${t}`).join('')}`;

  /** 把顺序音符流写进 cur：一拍内连音包 <n: …>，其余逐个输出 */
  const emitNotes = (notes: XNote[]): void => {
    let i = 0;
    let pendingGraces: XNote[] = [];
    while (i < notes.length) {
      const note = notes[i];
      if (note.grace) {
        if (!note.rest) pendingGraces.push(note);
        i += 1;
        continue;
      }
      const tupletKey = note.actual > 1 && note.actual > note.normal ? `${note.actual}:${note.normal}` : null;
      if (tupletKey) {
        let j = i;
        const run: XNote[] = [];
        while (j < notes.length) {
          const n2 = notes[j];
          const k2 = n2.actual > 1 && n2.actual > n2.normal ? `${n2.actual}:${n2.normal}` : null;
          if (k2 !== tupletKey) break;
          run.push(n2);
          j += 1;
        }
        const total = run.reduce((s, n) => s + fracVal(reduce(n.dur, divisions)), 0);
        const members = run.map((n) => {
          const r = noteTokens(n);
          const member = tupletMemberSuffix(reduce(n.dur, divisions));
          return r && member ? { r, member } : null;
        });
        if (run.length >= 2 && total <= 1 + 1e-9 && members.every(Boolean)) {
          const ok = members as { r: TokenParts; member: string }[];
          const inner = ok
            .map(({ r, member }) => `${r.prefix}${r.bare}${member}${r.suffix}`)
            .join(' ');
          // 附着 token 挂在组外：pre 用首成员、post 用末成员
          const pre = (run[0].pre ?? []).map((t) => `${t} `).join('');
          const post = (run[run.length - 1].post ?? []).map((t) => ` ${t}`).join('');
          cur.push(`${pre}${flushGraces(pendingGraces)}<${note.actual}: ${inner}>${post}`);
          pendingGraces = [];
          i = j;
          continue;
        }
        // 包不成组（跨拍连音 / 成员写不出）：逐个就近近似
        warnOnce('谱里有跨拍连音或非常规连音，无法用拍内组表达，已按最近的常规时值近似');
        for (const n of run) {
          const r = noteTokens(n);
          if (r) {
            noteCount += 1;
            cur.push(`${flushGraces(pendingGraces)}${around(n, `${r.prefix}${r.token}${r.suffix}`)}`);
          }
          pendingGraces = [];
        }
        i = j;
        continue;
      }
      const r = noteTokens(note);
      if (r) {
        noteCount += 1;
        cur.push(`${flushGraces(pendingGraces)}${around(note, `${r.prefix}${r.token}${r.suffix}`)}`);
      }
      pendingGraces = [];
      i += 1;
    }
    if (pendingGraces.length) warnOnce('谱尾的倚音后面没有主音，已跳过');
  };

  const pushLine = (): void => {
    if (cur.length) {
      lines.push(cur.join(' '));
      cur = [];
    }
  };

  // 预扫每小节的反复开始（供相邻小节合并 :||: / 抑制终止线）。
  // 展开器规定「两根小节线不能连着站」（中间会凭空多出 0 拍空小节，
  // 拍数校验立刻报错），所以小节线一律归**行首**，行尾只写 :|N / || / |{partial}，
  // 且这类行尾会抑制下一行的行首线。
  const measureRepeatStart = model.measures.map(
    (m) => m.items.some((it) => it.kind === 'barline' && it.location === 'left' && it.repeat === 'forward'),
  );
  let pendingBoundary = false; // 上一行末已写过边界线（:|N / || / |{partial}），本行行首不再补 |
  let prevRepeatEnd = 0; // 上一小节 :|N 的遍数（交给本行行首合并成 :||:）

  // ── 附着 token 状态机（力度 / 渐强渐弱 / 八度段）──
  // 方向记号先攒进 pendingPre，附着到下一个被推入的音符上；
  // 范围记号（cresc[ / 8va[）的收尾 token 挂到段内最后一个音符的 post 上。
  // 段内音符数不足时解析器会报错，所以收尾前数一遍，不足就摘掉开头 token。
  let pendingPre: string[] = [];
  let lastPushed: XNote | null = null;
  let hairpin: { kind: 'cresc' | 'dim'; count: number } | null = null;
  let octava: { count: number } | null = null;
  const dropPending = (tok: string): void => {
    const i = pendingPre.lastIndexOf(tok);
    if (i >= 0) {
      pendingPre.splice(i, 1);
      return;
    }
    const j = lastPushed?.pre?.lastIndexOf(tok) ?? -1;
    if (lastPushed?.pre && j >= 0) lastPushed.pre.splice(j, 1);
  };
  const closeHairpin = (): void => {
    if (!hairpin) return;
    if (hairpin.count >= 2 && lastPushed) (lastPushed.post ??= []).push(']hairpin');
    else dropPending(hairpin.kind === 'cresc' ? 'cresc[' : 'dim['); // 段内不足两个音符
    hairpin = null;
  };
  const closeOctava = (): void => {
    if (!octava) return;
    if (octava.count >= 1 && lastPushed) (lastPushed.post ??= []).push(']8');
    else {
      // 段内没有任何音符：摘掉开头 token（段未开过，两个起点都不可能同时挂起）
      dropPending('8va[');
      dropPending('8vb[');
    }
    octava = null;
  };
  const clampTempo = (t: number): number => {
    if (t < 20 || t > 300) {
      warnOnce('速度超出 20-300 范围，已收进边界值');
      return Math.max(20, Math.min(300, Math.round(t)));
    }
    return Math.round(t);
  };
  const DYNAMIC_ALL = new Set(['p', 'pp', 'mp', 'mf', 'f', 'ff']);

  /**
   * 天空线（主旋律提取）：所有声部层的音符放到同一条时间轴上（拍为单位，
   * 各声部独立推进，和弦成员同起点），把时间轴切成小片，每片取「正在响的最高音」；
   * 被更高音打断的长音切成片段、用延音线 ~ 接回；完全无声的片段补休止 0。
   * 力度 / 渐变等附着记号只落在首片段，收尾记号（]hairpin / ]8）落在末片段。
   */
  const buildSkyline = (raw: XNote[], measureBeats: number | null): XNote[] => {
    const EPS = 1e-9;
    // 按拍号截断：个别导出的声部层会超出小节拍数（如 4.5/4），超出部分是源数据垃圾，
    // 不截断就会把整小节撑超拍。弱起等短小节比拍号短，不受影响。
    const clamp = (t: number): number => (measureBeats !== null ? Math.min(t, measureBeats) : t);
    type Ev = { start: number; end: number; note: XNote; graces: XNote[] };
    const pos = new Map<string, number>();
    const baseStart = new Map<string, number>(); // 各声部最近一个非和弦音的起点（和弦成员与它同起点）
    const graces = new Map<string, XNote[]>();
    const evs: Ev[] = [];
    for (const n of raw) {
      const v = n.voice || '1';
      if (n.grace) {
        if (!n.rest) {
          const g = graces.get(v) ?? [];
          g.push(n);
          graces.set(v, g);
        }
        continue;
      }
      // 和弦成员跟在主音后面，但起点是主音的起点（pos 已推进到主音之后）
      const start = n.chord ? (baseStart.get(v) ?? pos.get(v) ?? 0) : (pos.get(v) ?? 0);
      const end = clamp(start + n.dur / divisions);
      if (!n.rest) evs.push({ start, end, note: n, graces: graces.get(v) ?? [] });
      graces.set(v, []);
      if (!n.chord) {
        pos.set(v, end);
        baseStart.set(v, start);
      }
    }
    // 小节总时长：休止不进 evs，但静默时间片必须一直切到小节末尾，
    // 否则小节尾的休止会整个丢掉（拍数不满）；全休止小节也靠它补出整小节休止
    let maxPos = 0;
    for (const e of evs) maxPos = Math.max(maxPos, e.end);
    for (const p of pos.values()) maxPos = clamp(Math.max(maxPos, p));
    if (maxPos <= EPS) return [];
    const pitchOf = (n: XNote): number => {
      // 打击乐（X）没有音高，视作最低——有音高旋律永远优先
      if (!n.step || LETTER_PC[n.step] === undefined) return -1;
      return noteMidi(n.step, n.octave, n.alter);
    };
    const points = Array.from(new Set([...evs.flatMap((e) => [e.start, e.end]), 0, maxPos])).sort((a, b) => a - b);
    type Seg = { start: number; end: number; ev: Ev; pieceStart: boolean; pieceEnd: boolean };
    const rawSegs: Seg[] = [];
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      let pick: Ev | null = null;
      for (const e of evs) {
        if (e.start > a + EPS || e.end < b - EPS) continue;
        if (!pick) {
          pick = e;
          continue;
        }
        const pd = pitchOf(e.note) - pitchOf(pick.note);
        if (pd > EPS) {
          pick = e;
          continue;
        }
        if (Math.abs(pd) <= EPS) {
          // 同音（八度叠奏等）：选持续更久的（长音不被同音重击切碎），
          // 再比显式符干方向（朝上=主旋律信号），再比主声部
          if (e.end > pick.end + EPS) {
            pick = e;
            continue;
          }
          if (Math.abs(e.end - pick.end) <= EPS) {
            // 未写 <stem> 的（undefined）视作中性，不压过也不输给「无信号」；
            // 只让「明确朝上」赢过「明确朝下」和「没写」
            const sv = (x: Ev): number => (x.note.stemUp === true ? 0 : x.note.stemUp === false ? 1 : 0);
            if (sv(e) !== sv(pick)) {
              if (sv(e) < sv(pick)) pick = e;
              continue;
            }
            const mv = (x: Ev): number => (x.note.voice === model.mainVoice ? 0 : 1);
            if (mv(e) !== mv(pick)) {
              if (mv(e) < mv(pick)) pick = e;
              continue;
            }
          }
        }
      }
      if (!pick) {
        rawSegs.push({
          start: a,
          end: b,
          pieceStart: true,
          pieceEnd: true,
          ev: {
            start: a,
            end: b,
            graces: [],
            note: {
              rest: true, grace: false, chord: false, unpitched: false,
              dur: Math.round((b - a) * divisions), step: '', alter: null, octave: 4,
              tieStart: false, tieStop: false, actual: 1, normal: 1, voice: model.mainVoice,
              arts: [], slurStart: [], slurStop: [],
            },
          },
        });
        continue;
      }
      rawSegs.push({
        start: a,
        end: b,
        ev: pick,
        pieceStart: Math.abs(pick.start - a) <= EPS,
        pieceEnd: Math.abs(pick.end - b) <= EPS,
      });
    }
    // 相邻同音符的片段拼回去（连续 = 长音没被打断）；静默休止片段也拼
    const merged: Seg[] = [];
    for (const s of rawSegs) {
      const prev = merged[merged.length - 1];
      const contiguous = prev && Math.abs(prev.end - s.start) <= EPS;
      if (contiguous && ((prev!.ev.note === s.ev.note && !s.pieceStart) || (prev!.ev.note.rest && s.ev.note.rest))) {
        prev!.end = s.end;
        prev!.pieceEnd = s.pieceEnd;
      } else {
        merged.push({ ...s });
      }
    }
    // 合成输出：片段化长音加延音线；记号只在首/末片段出现一次。
    // 延音线只能连**同音高**的音符（解析器规定），X / 休止不写延音线；
    // 带 ~ 的 token 会被解析器在 ~ 处切开分词，技法/装饰后缀必须省掉（保音准节奏优先）。
    const out: XNote[] = [];
    for (let i = 0; i < merged.length; i += 1) {
      const s = merged[i]!;
      const n = s.ev.note;
      const dur = Math.round((s.end - s.start) * divisions);
      if (n.rest) {
        out.push({ ...n, dur });
        continue;
      }
      const next = merged[i + 1]?.ev.note;
      const tie =
        !n.unpitched && !!next && !next.rest && !next.unpitched && pitchOf(next) === pitchOf(n);
      if (s.pieceStart) for (const g of s.ev.graces) out.push(g);
      out.push({
        ...n,
        dur,
        tieStart: tie,
        slurStart: s.pieceStart ? n.slurStart : [],
        slurStop: s.pieceEnd ? n.slurStop : [],
        arts: !tie && s.pieceStart ? n.arts : [],
        fermata: !tie && s.pieceStart ? n.fermata : undefined,
        breath: !tie && s.pieceStart ? n.breath : undefined,
        trill: !tie && s.pieceStart ? n.trill : undefined,
        trillEnd: !tie && s.pieceEnd ? n.trillEnd : undefined,
        turn: !tie && s.pieceStart ? n.turn : undefined,
        mordentUp: !tie && s.pieceStart ? n.mordentUp : undefined,
        mordentDown: !tie && s.pieceStart ? n.mordentDown : undefined,
        tremolo: !tie && s.pieceStart ? n.tremolo : undefined,
        arpeggio: !tie && s.pieceStart ? n.arpeggio : undefined,
        pre: s.pieceStart ? n.pre : undefined,
        post: s.pieceEnd ? n.post : undefined,
      });
    }
    return out;
  };

  for (let mIdx = 0; mIdx < model.measures.length; mIdx += 1) {
    const measure = model.measures[mIdx];
    // ── 和弦归并：只留最高音；方向记号在这条流上附着到下一个音 ──
    const notes: XNote[] = [];
    const rawNotes: XNote[] = []; // top 策略：全部声部层的原始音符（保持顺序，附着 pre）
    const pushNote = (n: XNote): void => {
      if (pendingPre.length) {
        n.pre = pendingPre;
        pendingPre = [];
      }
      notes.push(n);
      lastPushed = n;
      if (!n.rest && !n.grace) {
        if (hairpin) hairpin.count += 1;
        if (octava) octava.count += 1;
      }
    };
    for (const item of measure.items) {
      if (item.kind === 'direction') {
        if (item.wedge === 'cresc' || item.wedge === 'dim') {
          if (hairpin) closeHairpin(); // 未收先开：当作在此收掉上一段
          hairpin = { kind: item.wedge, count: 0 };
          pendingPre.push(item.wedge === 'cresc' ? 'cresc[' : 'dim[');
        } else if (item.wedge === 'stop') {
          closeHairpin();
        } else if (item.octShift === 'up' || item.octShift === 'down') {
          if (octava) closeOctava();
          octava = { count: 0 };
          pendingPre.push(item.octShift === 'up' ? '8va[' : '8vb[');
        } else if (item.octShift === 'stop') {
          closeOctava();
        } else if (item.dynamic) {
          const mapped = DYNAMIC_MAP[item.dynamic];
          if (mapped) {
            if (mapped !== item.dynamic) {
              warnOnce('超出力度的力度记号（ppp / sfz 等）已按最近档位近似');
            }
            // 连续力度记号取最后一个（同一个音上后一个覆盖前一个）
            const idx = pendingPre.findIndex((t) => DYNAMIC_ALL.has(t));
            if (idx >= 0) pendingPre[idx] = mapped;
            else pendingPre.push(mapped);
          } else {
            model.skippedMarks[`力度记号 ${item.dynamic}`] = (model.skippedMarks[`力度记号 ${item.dynamic}`] ?? 0) + 1;
          }
        }
        continue;
      }
      if (item.kind !== 'note') continue;
      const n = item.note;
      if (melody === 'first' && n.voice !== model.mainVoice) {
        // 第一层策略：其他声部层整层跳过
        if (!n.grace) model.skippedByVoice += 1;
        continue;
      }
      if (melody === 'top') {
        // 天空线策略：保留全部声部层（和弦成员同起点，交给时间片比较），
        // 力度/渐变等附着记号照旧挂到紧随其后的音符上
        if (pendingPre.length) {
          n.pre = pendingPre;
          pendingPre = [];
        }
        rawNotes.push(n);
        lastPushed = n;
        if (!n.rest && !n.grace) {
          if (hairpin) hairpin.count += 1;
          if (octava) octava.count += 1;
        }
        continue;
      }
      if (n.chord && notes.length) {
        const prev = notes[notes.length - 1];
        const bothPitched = !!prev.step && !!n.step;
        const bothUnpitched = !!prev.unpitched && !!n.unpitched;
        if (!prev.rest && !n.rest && (bothPitched || bothUnpitched)) {
          if (bothPitched && cmpPitch(n, prev) > 0) {
            notes[notes.length - 1] = {
              ...prev,
              step: n.step,
              alter: n.alter,
              octave: n.octave,
              tieStart: prev.tieStart || n.tieStart,
            };
            lastPushed = notes[notes.length - 1];
          }
          // 打击乐和弦（同拍多面鼓）保留第一个：小节时间推进按第一个音的时值算，
          // 换成后面的（军鼓半拍 + 底鼓两拍之类）会把拍数弄错
          model.skippedChord += 1;
          continue;
        }
      }
      pushNote(n);
    }

    // ── 本小节的属性 / 反复 / 房子 ──
    let repeatStart = false;
    let repeatEndTimes = 0;
    let finalLine = false;
    let endingAtStart: string | null = null;
    let measureTempo: number | null = null;
    let newTime: Frac | null = null;
    for (const item of measure.items) {
      if (item.kind === 'attributes') {
        if (item.divisions !== undefined) divisions = item.divisions;
        if (item.fifths !== undefined) fifths = item.fifths;
        if (item.beats !== undefined && item.beatType !== undefined) newTime = reduce(item.beats, item.beatType);
      } else if (item.kind === 'direction') {
        if (item.tempo !== undefined && item.tempo > 0) measureTempo = clampTempo(item.tempo);
      } else if (item.kind === 'barline') {
        if (item.location === 'left') {
          if (item.repeat === 'forward') repeatStart = true;
          if (item.ending) endingAtStart = item.ending;
        } else {
          if (item.repeat === 'backward') repeatEndTimes = Math.max(2, item.times);
          if (item.barStyle === 'light-heavy') finalLine = true;
        }
      }
    }
    // 天空线：在 divisions 确定后把全部声部层压成一条主旋律
    if (melody === 'top') {
      // time 是约分后的 拍数/拍型（4/4 → {1,1}），小节拍数（以四分拍计）= n × 4 / d
      const mb = time ? (time.n * 4) / time.d : null;
      for (const s of buildSkyline(rawNotes, mb)) notes.push(s);
    }

    // ── 小节起始 token ──
    if (!first) pushLine(); // 每小节一行段（DSL 里换行只是空白，小节线才是结构）
    if (newTime) time = newTime;
    const nextRepeatStart = mIdx + 1 < measureRepeatStart.length ? measureRepeatStart[mIdx + 1] : false;
    let pickupLeading = false; // 弱起线 |{partial} 已写在行首（行尾就不用再写）
    if (first) {
      // 弱起小节：若下一小节开新反复，弱起线 |{partial} 写在**行首**
      // （写在行尾会跟下一行的 |: 两线相邻），右边界由下一行的 |: 承担
      if (measure.implicit && !repeatStart && nextRepeatStart) {
        cur.push('|{partial}');
        pickupLeading = true;
      } else if (repeatStart) {
        cur.push('|:');
      }
      // 谱头调号取首小节的 fifths；速度取首小节的 direction（只登记，不写线后记号）
      headerFifths = fifths;
      emittedFifths = fifths;
      emittedTime = time;
      if (measureTempo !== null) tempo = measureTempo;
    } else {
      // 行首小节线：上一行末已写过边界线就不再补（防两线相邻）；
      // 上一行末是 :|N 且本段开新反复 → 合并成 :||:
      if (prevRepeatEnd && repeatStart) {
        cur.push(prevRepeatEnd > 2 ? `:|${prevRepeatEnd}|:` : ':||:');
      } else if (!pendingBoundary) {
        cur.push(repeatStart ? '|:' : '|');
      }
      pendingBoundary = false;
      prevRepeatEnd = 0;
      // 换行 / 分页（MusicXML <print new-system / new-page>）：必须紧跟小节线书写
      if (measure.breakAfter) cur.push(measure.breakAfter === 'page' ? '分页' : '换行');
      // 拍号变化：线后 拍N/M（行首线被抑制时，上一行末的 :| / || / |{partial}
      // 仍是最近的小节线事件，「紧接小节线书写」依然成立）
      if (time && (!emittedTime || !fracEq(time, emittedTime))) {
        emittedTime = time;
        cur.push(`拍${time.n}/${time.d}`);
      }
      // 谱中换调：转1=X 写在调号变化后的第一个音前面（DSL 语义：绑到下一个音）
      if (fifths !== emittedFifths) {
        emittedFifths = fifths;
        cur.push(`转${keyName(fifths)}`);
      }
      if (measureTempo !== null && measureTempo !== tempo) {
        tempo = measureTempo;
        cur.push(`速${tempo}`);
      }
    }
    if (endingAtStart) cur.push(`[${endingAtStart}]`);
    emitNotes(notes);
    // 小节收尾：只在反复结束 / 终止 / 弱起时写线；
    // 普通小节的边界由**下一行的行首线**承担（这是双线 bug 的修法核心）
    const isLast = mIdx === model.measures.length - 1;
    if (repeatEndTimes) {
      if (!isLast && nextRepeatStart) {
        // 下一段立即开新反复：不在此写 :|N，留给下一行行首合并成 :||:
        prevRepeatEnd = repeatEndTimes;
      } else {
        cur.push(repeatEndTimes > 2 ? `:|${repeatEndTimes}` : ':|');
        pendingBoundary = true;
      }
    } else if (isLast) {
      cur.push('||');
    } else if (finalLine && !nextRepeatStart) {
      // 段落终止线；下一小节若开新反复就让 |: 顶掉这根 ||（同样防相邻）
      cur.push('||');
      pendingBoundary = true;
    } else if (first && measure.implicit && !pickupLeading && !nextRepeatStart) {
      // 弱起小节的行尾弱起线；下一小节开新反复时交给 |: 当边界（防相邻）
      cur.push('|{partial}');
      pendingBoundary = true;
    }
    first = false;
  }
  // 谱尾还开着的范围段：收掉（音符数不足会摘掉开头 token，不留悬空记号）
  closeHairpin();
  closeOctava();
  pushLine();
  if (!lines.length) lines.push('||');
  for (const w of model.metaWarnings) warnOnce(w);
  if (melody === 'top') {
    if (model.voiceCount > 1)
      warnings.push(
        `该声部有 ${model.voiceCount} 个声部层，已按「最高音」提取主旋律（天空线）：每个时间片取正在响的最高音，被顶替的长音用延音线接回`,
      );
  } else if (model.multiVoice) {
    warnings.push(
      `该声部有多个声部层，只转换了第一层（跳过 ${model.skippedByVoice} 个音符）；旋律不在第一层时可改用「合并声部取最高音」`,
    );
  }
  if (melody === 'first' && model.skippedChord > 0)
    warnings.push(`和弦只保留了一个音（跳过 ${model.skippedChord} 个其余音；打击乐即同拍多面鼓只留一个）`);
  if (model.skippedLyric > 0) warnings.push('歌词暂不支持转换，已忽略');
  if (model.expandedRestMeasures > 0)
    warnings.push(`多小节休止已展开成 ${model.expandedRestMeasures + 1} 个整小节休止（含首格）`);
  if (noteCount === 0)
    warnings.push(`声部「${model.name}」没有可转换的音符（内容全被跳过），结果里只有休止`);
  const marks = Object.entries(model.skippedMarks);
  if (marks.length)
    warnings.push(`未支持（已忽略，不影响音准与节奏）：${marks.map(([k, v]) => `${k}×${v}`).join('、')}`);
  return { lines, warnings, headerKey: keyName(headerFifths ?? 0), noteCount };
}

interface PartConvertResult {
  lines: string[];
  warnings: string[];
}

/* ─────────────────────────── 对外入口 ─────────────────────────── */

/** 列出谱里的声部（供选择界面用） */
export function musicXmlSummary(xml: string): { summary: MusicXmlSummary; errors: string[] } {
  const { title, parts, errors } = parseScoreXml(xml);
  return { summary: { title, parts: parts.map((p) => ({ id: p.id, name: p.name })) }, errors };
}

/**
 * 把选中的声部转成 .jps 文本。partIds 至少一个（UI 已保证，这里再守一遍）。
 * 多声部走 @format 3 的 @part 结构；单声部直接谱头 + 正文。
 * opts.fallbackTitle：MusicXML 没写标题时用（一般是文件名去扩展名）。
 */
export function musicXmlToJps(
  xml: string,
  partIds: string[],
  opts?: { fallbackTitle?: string; melody?: 'first' | 'top' },
): { dsl: string; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const { title, parts, errors } = parseScoreXml(xml);
  if (!partIds.length) {
    return { dsl: '', warnings, errors: [...errors, '至少要选择一个声部'] };
  }
  const chosen = partIds
    .map((id) => parts.find((p) => p.id === id))
    .filter((p): p is PartModel => !!p);
  if (!chosen.length) {
    return { dsl: '', warnings, errors: [...errors, '选择的声部在这份 MusicXML 里不存在'] };
  }
  const bodies = chosen.map((p) => convertPartModel(p, warnings, opts?.melody ?? 'top'));
  const head: string[] = [];
  // 谱中拍号变化（拍N/M）与多声部 @part 都要求 format 3；新谱默认就是 3，统一带上
  head.push('@format 3');
  head.push(`@title ${(title || opts?.fallbackTitle || 'MusicXML 导入').replace(/[\r\n]+/g, ' ')}`);
  head.push(`@key ${bodies[0].headerKey}`); // 首声部首小节的调号
  const firstAttr = chosen[0].measures.flatMap((m) => m.items).find((it) => it.kind === 'attributes') as
    | { kind: 'attributes'; beats?: number; beatType?: number }
    | undefined;
  head.push(`@beat ${firstAttr?.beats ?? 4}/${firstAttr?.beatType ?? 4}`);
  const firstTempo = chosen[0].measures
    .flatMap((m) => m.items)
    .find((it) => it.kind === 'direction' && it.tempo !== undefined) as { kind: 'direction'; tempo: number } | undefined;
  head.push(`@bpm ${firstTempo ? Math.max(20, Math.min(300, Math.round(firstTempo.tempo))) : 90}`);
  head.push(`@patch ${resolvePatch(chosen[0].name, chosen[0].midiProgram)}`);
  const body = chosen.length > 1
    ? chosen
        .map((p, i) => {
          const nm = p.name.replace(/["\r\n]+/g, ' ');
          // 声部级 @patch：多声部时每条声部各配各的音色（谱头那条只是首声部兜底）
          return `\n@part ${i + 1} "${nm}"\n@patch ${resolvePatch(p.name, p.midiProgram)}\n${bodies[i].lines.join('\n')}`;
        })
        .join('\n')
    : `\n${bodies[0].lines.join('\n')}`;
  const dsl = `${head.join('\n')}\n${body}\n`;
  // 转换产物自校验（用户 0.4.37 定）：DSL 必须能被自家解析器干净解析，
  // 解析错误原样进 errors——这是转换 bug 的最后一道闸，不许静默吞掉
  try {
    const parsed = parseDsl(dsl);
    if (parsed.errors.length) {
      errors.push(...parsed.errors.slice(0, 5).map((e) => `转换产物自校验失败：${e}`));
      if (parsed.errors.length > 5) errors.push(`（另有 ${parsed.errors.length - 5} 条同类错误）`);
    } else if (parsed.score) {
      // 质量信号：转完跑一遍排版，把拍数不满 / 超满的小节数告诉用户
      //（多声部谱只取第一层时常见），编辑器里行首有同样的 ⚠ 徽标
      const badges = layoutScore(parsed.score, { contentWidth: 1400 }).lines.flatMap((l) => l.badges);
      if (badges.length) {
        warnings.push(
          `有 ${badges.length} 个小节拍数不满或超满（多声部谱只取第一层时常见），编辑器里行首有 ⚠ 标记可逐个核对`,
        );
      }
    }
  } catch {
    errors.push('转换产物自校验失败：内部异常（DSL 排版检查崩溃）');
  }
  return { dsl, warnings: [...new Set(bodies.flatMap((b) => b.warnings))], errors };
}

/**
 * 磁盘文件 → XML 文本（.musicxml / .xml 直读，.mxl 解 zip）。
 */
export async function readMusicXmlFile(file: File): Promise<string> {
  if (/\.mxl$/i.test(file.name)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return unzipMusicXml(bytes);
  }
  return file.text();
}
