/**
 * DSL 文本语法（M0-4 / spec §10）：无损 round-trip 的主界面。
 *
 *   parse(serialize(score)) 必须与 score 深度相等。
 *
 * 本文件实现 M0 需要的子集，结构与 §10.2 完全对齐，
 * 反复 / 跳房子 / 跳转 / 装饰音留到 M3-M4 按同样方式追加：
 *
 *   元信息   @title @key @beat @bpm @patch @patchName
 *   音符     5 | 5/2 5/4 5/8 | 5. 5.. | 5- 5-- | 5^ 5^^ | 5v 5vv | 0（休止）
 *   拍内组   <5/2 3/4 2/4>      一拍组
 *            <3: 5/3 3/3 2/3>   三连音组（显式标号）
 *   连线     5~5（tie，同音高）   (5 6 5)（slur，区间 → 链式 ties）
 *   记号     5! 跳音  5= 保持音  5> 重音  5@ 延长号  5V 换气（音符技法，非独立事件）
 *   小节     |   ||   |{partial}
 *
 * ( ) 与 < > 是两条互不相关的记号，各自独立开闭，**允许交叉**：
 *   - ( ) 画上方弧线，跨度随意，可跨小节线
 *   - < > 画下方减时线，限定 1 拍内、不能跨小节线
 *   例：5 4 (3 <4/2) 2/2> —— 连线覆盖 3、4/2，减时线覆盖 4/2、2/2
 */

import {
  DIVISION_TICKS,
  TICK_DIVISIONS,
  TICKS_PER_BEAT,
  withDots,
} from './ticks';
import { normalizeKey } from './timeline';
import { autoGroupBeats } from './edit';
import { groupTicks, validMeter } from './meter';
import { applyLyrics, lyricRows } from './lyrics';
import { assembleParts, namespacePart, partScore, scoreParts } from './parts';
import type {
  Accidental,
  Articulation,
  BarlineEvent,
  BeatGroup,
  Degree,
  GraceNote,
  Event,
  NoteEvent,
  RestEvent,
  Score,
  ScoreMeta,
  TimedEvent,
} from './types';

/**
 * 记号式：变音/八度 音级 八度 附点 /除法 增时线 ~延音线 演奏法（! = > @ t）
 *
 * 变音记号与八度点共用前导位，所以 `#5`、`^5`、`#^5` 都合法——
 * 简谱里升降号写在音级左边（`#5` `b3`），和八度点谁先谁后没有硬规矩。
 * ♯ ♭ ♮ 字形与 # b 等同。
 */
const NOTE_RE = /^([v^#b♯♭♮]*)([0-7])([v^]*)(\.{0,2})(?:\/([1-8]))?(-*)(~?)([!=>@tkVfdmwsxqh]*)$/;

/**
 * 技法记号的后缀字母 → 数据值。
 * k 是双吐的 K，归 tongue；其余进 technique，字形见 paint.ts 的 TECHNIQUE_GLYPH。
 */
const TECHNIQUE_LETTER: Record<string, string> = {
  V: 'breath', // 换气 V（大写，避开低八度点 v）
  r: 'trill', // 颤音 tr
  f: 'flutter', // 花舌 *
  d: 'da', // 打音 ♮
  m: 'mordentUp', // 上波音 ≈
  w: 'mordentDown', // 下波音 ≈（上下翻转）
  s: 'slideUp', // 上滑音 ↑
  x: 'slideDown', // 下滑音 ↓
  q: 'bendUp', // 前弯音 ↗
  h: 'bendDown', // 后弯音 ↘
};

/** 技法数据值 → 后缀字母（序列化用） */
const TECHNIQUE_OF: Record<string, string> = Object.fromEntries(
  Object.entries(TECHNIQUE_LETTER).map(([letter, value]) => [value, letter]),
);

/** 变音记号字形 → 数据值 */
const ACCIDENTALS: Record<string, Accidental> = {
  '#': '#',
  '♯': '#',
  b: 'b',
  '♭': 'b',
  '♮': '♮',
};

/** 力度记号：独立 token，渲染在谱行下方 */
/** 力度 token：常规档位 + 渐强渐弱（写在音符前面，绑到那个音上） */
const DYNAMIC_RE = /^(pp|mp|mf|ff|p|f|cresc|dim)$/;

export const DEFAULT_META: ScoreMeta = {
  title: '未命名曲谱',
  key: '1=C',
  beat: '4/4',
  bpm: 90,
  patch: 73,
};

export interface ParseResult {
  score: Score | null;
  errors: string[];
}

/**
 * 解析倚音串：`5`、`65`、`#6`、`6^`、`#6v5` —— 每个倚音 = [变音]音级[八度点]。
 * 返回 null 表示写法不合法（空串、休止符 0、夹着别的字符都会落到这里）。
 */
export function parseGraceNotes(text: string): GraceNote[] | null {
  if (!text) return null;
  const parts = text.match(/[#b♯♭♮]*[1-7][v^]*/g);
  if (!parts || parts.join('') !== text) return null;
  return parts.map((p) => {
    const m = /^([#b♯♭♮]*)([1-7])([v^]*)$/.exec(p)!;
    let octave = 0;
    for (const c of m[3]) octave += c === '^' ? 1 : -1;
    const g: GraceNote = { degree: Number(m[2]) as Degree, octave };
    const acc = [...m[1]].find((c) => c in ACCIDENTALS);
    if (acc) g.accidental = ACCIDENTALS[acc];
    return g;
  });
}

/** 倚音的书写形式：`#6`、`6^`；序列化与面板显示共用 */
export function renderGraceNote(g: GraceNote): string {
  const oct = g.octave > 0 ? '^'.repeat(g.octave) : 'v'.repeat(-g.octave);
  return `${g.accidental ?? ''}${g.degree}${oct}`;
}

export function parseDsl(text: string): ParseResult {
  const version = /^@format\s+(\S+)\s*$/mi.exec(text)?.[1];
  if (version && version !== '3') return { score: null, errors: [`不支持的 JPS 语法版本：${version}`] };
  const modern = version === '3';
  if (!modern && /^@part\b/mi.test(text)) return { score: null, errors: ['多声部文件需要在谱头写 @format 3'] };
  if (!modern) return parseSingle(text);
  const header: string[] = [];
  const blocks: { id: string; name: string; gain: number; muted?: boolean; solo?: boolean; lyricNames?: string[]; lines: string[] }[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^@part\b/i.test(line)) {
      const match = /^@part\s+([1-9]\d*)\s+("(?:[^"\\]|\\.)*")\s*$/i.exec(line);
      if (!match) { errors.push('声部声明应为 @part 1 "主旋律"'); continue; }
      if (blocks.some((b) => b.id === match[1])) { errors.push(`声部编号 ${match[1]} 重复`); continue; }
      try { blocks.push({ id: match[1], name: JSON.parse(match[2]) as string, gain: 1, lines: [] }); }
      catch { errors.push(`声部 ${match[1]} 的名称引号或转义不正确`); }
    } else if (/^@mix\b/i.test(line)) {
      const m = /^@mix\s+(0(?:\.\d+)?|1(?:\.0+)?)\s+(on|off)\s+(solo|all)\s*$/i.exec(line);
      const block = blocks[blocks.length - 1];
      if (!block || !m) errors.push('声部试听设置应为 @mix 0.8 on all，并放在声部声明之后');
      else { block.gain = Number(m[1]); block.muted = m[2].toLowerCase() === 'off'; block.solo = m[3].toLowerCase() === 'solo'; }
    } else if (/^@lyricnames\b/i.test(line)) {
      const block = blocks[blocks.length - 1];
      try {
        const names: unknown = JSON.parse(line.replace(/^@lyricnames\s*/i, ''));
        if (!block || !Array.isArray(names) || names.length > 6 || names.some((n) => typeof n !== 'string' || !n.trim())) throw new Error();
        block.lyricNames = names;
      } catch { errors.push('歌词行名称应为 @lyricNames ["第一段", "第二段"]，放在关联声部声明之后，最多六条'); }
    } else if (line.startsWith('@')) header.push(raw);
    else if (blocks.length) blocks[blocks.length - 1].lines.push(raw);
    else if (line && !line.startsWith('//') && line !== '---') header.push(raw);
  }
  if (errors.length) return { score: null, errors };
  if (!blocks.length) {
    const result = parseSingle(normalizeModern(text), true);
    return { ...result, score: result.score && !result.errors.length ? autoGroupBeats(result.score) : null };
  }
  if (header.some((l) => l.trim() && !l.trim().startsWith('@') && !l.trim().startsWith('//'))) return { score: null, errors: ['多声部文件的音符必须写在 @part 声部声明之后'] };
  const parsed = blocks.map((b) => ({ block: b, result: parseSingle(normalizeModern([...header, ...b.lines].join('\n')), true) }));
  for (const { block, result } of parsed) errors.push(...result.errors.map((e) => `${block.name}：${e}`));
  if (errors.length || parsed.some((p) => !p.result.score)) return { score: null, errors };
  return { score: assembleParts(parsed[0].result.score!, parsed.map(({ block, result }) => {
    const { lines: _lines, ...info } = block;
    // 序列化器对每个声部都写 @mix（on/solo 等），手写文件却常省略这一行——
    // 在解析端补齐默认值，保证「解析产物结构完整」，round-trip 才能稳定
    return namespacePart(autoGroupBeats(result.score!), {
      ...info,
      muted: info.muted ?? false,
      solo: info.solo ?? false,
    });
  })), errors };
}

function normalizeModern(text: string): string {
  return text.split(/(^\s*@[^\n]*$|^\s*\/\/[^\n]*$|^\s*歌词[1-6]:[^\n]*$)/m).map((segment) => {
    if (segment.trim().startsWith('@') || segment.trim().startsWith('//') || /^歌词[1-6]:/.test(segment.trim())) return segment;
    return segment.replace(/(^|\s|[<(}])([#b♯♭♮]?[v^]*[0-7][v^]*\.{0,2})(\/{1,3})(?![\d/])/g, (_, before: string, note: string, slashes: string) => `${before}${note}/${2 ** slashes.length}`)
      .replace(/<3:\s*([^<>]+)>/g, (full, body: string) => {
        const tokens = body.trim().split(/\s+/);
        if (tokens.length !== 3 || !tokens.every((t) => /^[#b♯♭♮]?[0-7][v^]*[!=>@tkVrfdmwsxqh]*$/.test(t))) return full;
        return `<3: ${tokens.map((t) => t.replace(/^([#b♯♭♮]?[0-7][v^]*)/, '$1/3')).join(' ')}>`;
      });
  }).join('');
}

function parseSingle(text: string, modern = false): ParseResult {
  const errors: string[] = [];
  const meta: ScoreMeta = { ...DEFAULT_META };
  const body: string[] = [];
  const lyrics: string[] = [];
  const lyricNumbers = new Set<number>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === '---') continue;
    if (line.startsWith('//')) continue;
    const lyric = /^歌词([1-6]):\s*(.*)$/.exec(line);
    if (lyric) {
      if (!modern) errors.push('歌词需要 @format 3');
      const verse = Number(lyric[1]) - 1;
      if (lyricNumbers.has(verse)) errors.push(`歌词 ${verse + 1} 重复`);
      lyricNumbers.add(verse);
      lyrics[verse] = lyric[2];
      continue;
    }

    if (line.startsWith('@')) {
      const sp = line.indexOf(' ');
      const k = (sp > 0 ? line.slice(1, sp) : line.slice(1)).toLowerCase();
      const v = sp > 0 ? line.slice(sp + 1).trim() : '';
      switch (k) {
        case 'title':
          meta.title = v;
          break;
        case 'key':
          meta.key = v;
          break;
        case 'beat':
          meta.beat = v;
          break;
        case 'bpm': {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) meta.bpm = n;
          else errors.push(`BPM 解析失败：${v}`);
          break;
        }
        case 'patch': {
          const n = Number(v);
          if (Number.isInteger(n) && n >= 0 && n <= 127) meta.patch = n;
          else errors.push(`patch 解析失败：${v}`);
          break;
        }
        case 'patchname':
          meta.patchName = v;
          break;
        case 'sub':
          // 标题下的居中说明行
          meta.sub = v;
          break;
        case 'note':
          // 谱头右侧说明行，最多 4 行（写多了截断，不静默吞掉整条指令）
          meta.notes = [...(meta.notes ?? []), v].slice(0, 4);
          break;
        case 'size': {
          // 谱面字号（px）。合法范围 12–56，越界报错而不是吞掉
          const n = Number(v);
          if (Number.isFinite(n) && n >= 12 && n <= 56) meta.fontSize = n;
          else errors.push(`字号解析失败（应为 12–56 的数字）：${v}`);
          break;
        }
        case 'space': {
          // 字间距（px）。可以为负（收紧），范围 -4–24
          const n = Number(v);
          if (Number.isFinite(n) && n >= -4 && n <= 24) meta.letterSpacing = n;
          else errors.push(`字间距解析失败（应为 -4–24 的数字）：${v}`);
          break;
        }
        case 'measureno': {
          // 小节号：只有 off 会写进文件（缺省是显示）
          if (/^(off|0|false|no)$/i.test(v)) meta.showMeasureNumbers = false;
          else if (/^(on|1|true|yes)$/i.test(v)) meta.showMeasureNumbers = true;
          else errors.push(`小节号开关解析失败（应为 on / off）：${v}`);
          break;
        }
        default:
          break;
      }
      continue;
    }
    body.push(line);
  }

  const events: Event[] = [];
  const groups: BeatGroup[] = [];
  const byId = new Map<string, Event>();
  let seq = 0;
  let groupSeq = 0;
  const nextId = () => `e${++seq}`;

  let lastNoteId: string | null = null;
  let pendingTie = false;
  /** 待生效的转调记号（`转1=G`）：绑到它后面的第一个音符上 */
  let pendingKey: string | undefined;
  let currentBeat = meta.beat;
  let hairpinStart: { kind: 'cresc' | 'dim'; from: number } | null = null;

  /**
   * ( ) 连音线与 < > 拍内组是**两条互不相关的记号**：
   *   - ( ) 画上方的弧线，跨度随意，可跨小节线
   *   - < > 画下方的减时线，限定在 1 拍内
   *
   * 因此它们各自独立开闭，**允许交叉**。真实谱面里连线止于组内某个音是常态：
   *   5 4 (3 <4/2) 2/2>      连线覆盖 3 和 4/2，减时线覆盖 4/2 和 2/2
   * 强行要求两层括号互相嵌套会把这种合法谱面判成错误。
   *
   * 各自内部的限制仍然保留：
   *   - 拍内组：不能嵌套、不能跨小节线、不能为空
   *   - 连音线：不能漏闭合 / 多余闭合，至少要括住两个音
   *
   * 已知歧义：> 既是组闭合也是重音记号。约定「有未闭合的组、或整个 token 就是一个 >」
   * 时才算组闭合，否则按重音处理（重音总是贴着音符写，如 5>）。
   */
  interface SlurScope {
    last: string | null;
    notes: number;
  }
  const slurStack: SlurScope[] = [];
  let currentGroup: BeatGroup | null = null;
  /** 经函数取值，避免 TS 把 currentGroup 收窄成 null（赋值发生在闭包里） */
  const topGroup = (): BeatGroup | null => currentGroup;

  const addTie = (fromId: string, toId: string, kind: 'tie' | 'slur') => {
    const from = byId.get(fromId);
    if (!from || from.kind !== 'note') return;
    from.ties = [...(from.ties ?? []), { to: toId, kind }];
  };

  const pushTimed = (core: string, gBefore?: GraceNote[], gAfter?: GraceNote[], hiddenRest = false) => {
    const m = NOTE_RE.exec(core);
    if (!m) {
      errors.push(`无法解析的记号：${core}`);
      return;
    }
    const [, pre, digit, post, dots, div, dashes, tieMark, artic] = m;

    let octave = 0;
    for (const c of pre + post) {
      if (c === '^') octave += 1;
      else if (c === 'v') octave -= 1; // 变音字形不参与八度计数
    }
    const accChar = [...pre].find((c) => c in ACCIDENTALS);
    const accidental = accChar ? ACCIDENTALS[accChar] : undefined;

    const divN = div ? Number(div) : 1;
    const base = DIVISION_TICKS[divN];
    if (base === undefined) {
      errors.push(`不支持的除法记号 /${divN}`);
      return;
    }
    const dotCount = dots.length as 0 | 1 | 2;
    const ticks = withDots(base, dotCount) + dashes.length * TICKS_PER_BEAT;
    const degree = Number(digit);
    const id = nextId();

    let ev: TimedEvent;
    if (degree === 0) {
      if (gBefore || gAfter) errors.push('倚音只能加在音符上，不能加在休止符上');
      const rest: RestEvent = { id, kind: 'rest', ticks };
      // 休止符与音符一样可带附点（0. = 1.5 拍）
      if (dotCount) rest.dot = dotCount;
      ev = rest;
      // 隐藏休止（番茄写法 8）：走 0 的完整时值语法，只是不画字形
      if (hiddenRest) rest.hidden = true;
    } else {
      const note: NoteEvent = {
        id,
        kind: 'note',
        degree: degree as Degree,
        octave,
        ticks,
        dot: dotCount,
      };
      if (accidental) note.accidental = accidental;
      // 转调记号（转1=G）绑到它后面的第一个音符上：演奏到此音起改用新调
      if (pendingKey) {
        note.keyChange = pendingKey;
        pendingKey = undefined;
      }
      const arts: Articulation[] = [];
      let fermata = false;
      let tongue: 'T' | 'K' | undefined;
      const techniques: string[] = [];
      for (const c of artic) {
        if (c === '!') arts.push('staccato');
        else if (c === '=') arts.push('tenuto');
        else if (c === '>') arts.push('accent');
        else if (c === '@') fermata = true;
        else if (c === 't') tongue = 'T';
        else if (c === 'k') tongue = 'K';
        else if (c in TECHNIQUE_LETTER) techniques.push(TECHNIQUE_LETTER[c]);
      }
      if (arts.length) note.articulations = arts;
      if (fermata) note.fermata = true;
      if (tongue) note.tongue = tongue;
      if (techniques.length) note.techniques = techniques;
      // 倚音（不占时值）：挂在这个主音上
      if (gBefore?.length) note.graceBefore = gBefore;
      if (gAfter?.length) note.graceAfter = gAfter;
      ev = note;
    }

    if (currentGroup) {
      ev.groupId = currentGroup.id;
      currentGroup.memberIds.push(id);
    }

    if (pendingTie) {
      if (lastNoteId && ev.kind === 'note') addTie(lastNoteId, id, 'tie');
      else errors.push(`延音线必须连接两个音符：${core}`);
    }
    pendingTie = tieMark === '~';

    events.push(ev);
    byId.set(id, ev);
    if (ev.kind === 'note') {
      lastNoteId = id;
      // 只喂给最内层未闭合的连线：嵌套时内层的音不该串到外层链上
      const s = slurStack[slurStack.length - 1];
      if (s) {
        if (s.last && s.last !== id) addTie(s.last, id, 'slur');
        s.last = id;
        s.notes += 1;
      }
    } else {
      // 休止符不接延音线，但仍落在连线的跨度里
      lastNoteId = null;
    }
  };

  const openSlur = (): void => {
    slurStack.push({ last: null, notes: 0 });
  };

  const closeSlur = (): void => {
    const s = slurStack.pop();
    if (!s) {
      errors.push('多余的 )，没有对应的 (');
      return;
    }
    if (s.notes < 2) errors.push('连音线至少要括住两个音');
  };

  const openGroup = (): void => {
    if (currentGroup) errors.push('拍内组不能嵌套');
    const id = `g${++groupSeq}`;
    const g: BeatGroup = { id, totalTicks: 0, memberIds: [] };
    groups.push(g);
    currentGroup = g;
  };

  const closeGroup = (): void => {
    if (!currentGroup) {
      errors.push('多余的 >，没有对应的 <');
      return;
    }
    if (currentGroup.memberIds.length === 0) {
      errors.push('拍内组为空，< > 之间至少要有一个音');
    }
    let sum = 0;
    for (const id of currentGroup.memberIds) {
      const m = byId.get(id);
      if (m && (m.kind === 'note' || m.kind === 'rest')) sum += m.ticks;
    }
    currentGroup.totalTicks = sum;
    if (modern) {
      const maxTicks = !currentGroup.tuplet ? groupTicks(currentBeat) : TICKS_PER_BEAT;
      if (sum > maxTicks) errors.push(`拍组时值超过 ${maxTicks / TICKS_PER_BEAT} 拍；三连音省写必须是 <3: 1 2 3>，其他情况请明确每音时值`);
      if (currentGroup.tuplet && currentGroup.memberIds.length !== currentGroup.tuplet) errors.push(`${currentGroup.tuplet} 连音需要 ${currentGroup.tuplet} 个成员`);
    }
    currentGroup = null;
  };

  const pushBarline = (style: 'single' | 'final', partial = false, hidden = false) => {
    if (currentGroup) {
      errors.push('拍内组不得跨小节，请先用 > 收尾');
      currentGroup = null;
    }
    const id = nextId();
    const ev: Event = partial
      ? { id, kind: 'barline', style, partial: true }
      : { id, kind: 'barline', style };
    if (hidden) (ev as BarlineEvent).hidden = true;
    events.push(ev);
    byId.set(id, ev);
    if (!pendingTie || style === 'final') lastNoteId = null;
  };

  /** 反复记号也是小节线：拍内组不得跨过它，延音线也不接续 */
  const barrier = () => {
    if (currentGroup) {
      errors.push('拍内组不得跨反复记号，请先用 > 收尾');
      currentGroup = null;
    }
    lastNoteId = null;
  };

  const pushSimple = (ev: Event): void => {
    events.push(ev);
    byId.set(ev.id, ev);
  };

  /**
   * 反复记号本身就是一根小节线，只是多了属性：
   * `|:` = 这条线开始反复，`:|` = 这条线结束反复。
   * 所以这里**建的是小节线事件**，不会在谱面上多出一条线。
   */
  const pushRepeatBarline = (repeat: 'start' | 'end', times?: number) => {
    barrier();
    const ev: BarlineEvent = { id: nextId(), kind: 'barline', style: 'single', repeat };
    if (repeat === 'end') ev.times = times ?? 2;
    pushSimple(ev);
  };

  /** 最近一条小节线（房子 `[n]` 要挂在它身上） */
  const lastBarline = (): BarlineEvent | undefined => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.kind === 'barline') return e;
    }
    return undefined;
  };

  /**
   * 跳房子 `[n]`：写在小节线**后面**，表示从这条线起进入第 n 遍的结尾。
   * 房的范围到「下一条带房子的线」或「所在反复段的那根 `:|`」为止，
   * 因此不需要收尾记号——用户只写开头。
   * `[n`（不闭合右括号）= **右端开放**：括线只画左钩，演奏一直延续到 :|。
   */
  const markVolta = (numbers: number[], open: boolean) => {
    const bar = lastBarline();
    if (!bar) {
      errors.push(`房子 [${numbers.join(',')}] 前面没有小节线（房子要写在小节线后面，如 | [1] …）`);
      return;
    }
    if (bar.volta) {
      errors.push(
        `第 ${bar.volta.join(',')} 房与 [${numbers.join(',')}] 房之间缺少小节线（两个房子必须各自起在一根小节线上）`,
      );
      return;
    }
    bar.volta = numbers;
    if (open) bar.voltaOpen = true;
  };


  for (const line of body) {
    // 延音线写作连写的 5~5（§10.2），这里把 ~ 变成左附着的分词边界：5~ 5
    const tokens = line.replace(/~/g, '~ ').split(/\s+/).filter(Boolean);
    for (let raw of tokens) {
      /*
       * (文字) 装饰记号：括号里是**非音符内容**（中文 / 字母，如 (前奏)）时，
       * 整块按文字显示——不占时值、演奏忽略，只用来标注段落（前奏 / 间奏 / 尾奏）。
       * 括号必须成对写在同一个记号里；括号里是音符语法（数字开头，如 (5 6 5)）
       * 时仍走连音线解析，两者互不影响。
       */
      const deco = /^\(([^()]+)\)$/.exec(raw);
      if (deco && /[^\d\s/^~.vVtT<>|#\-]/.test(deco[1])) {
        const id = nextId();
        const ev: Event = { id, kind: 'directive', type: 'text', value: deco[1] };
        events.push(ev);
        byId.set(id, ev);
        continue;
      }
      // 前缀只可能是 ( 或 <，按文本顺序入栈（外层在前）
      const opens: ('slur' | 'group')[] = [];
      while (raw.startsWith('(') || raw.startsWith('<')) {
        opens.push(raw[0] === '(' ? 'slur' : 'group');
        raw = raw.slice(1);
      }
      // 先开括号：后缀判断依赖「当前有没有未闭合的组」
      for (const t of opens) {
        if (t === 'slur') openSlur();
        else openGroup();
      }

      // 后缀只可能是 ) 或 >，从右往左读再反转成文本顺序。
      // > 歧义消解：有未闭合的组、或整个 token 就是一个 > 时算组闭合，
      // 否则它是重音记号（重音总是贴着音符写，如 5>）。
      const closes: ('slur' | 'group')[] = [];
      while (
        raw.endsWith(')') ||
        (raw.endsWith('>') && (topGroup() !== null || raw.length === 1))
      ) {
        closes.push(raw[raw.length - 1] === ')' ? 'slur' : 'group');
        raw = raw.slice(0, -1);
      }
      closes.reverse();

      // 三连音标号紧跟在 < 之后：<3: 5/3 3/3 2/3>
      if (raw !== '' && /^\d+:$/.test(raw)) {
        const g = topGroup();
        if (g && g.memberIds.length === 0) {
          g.tuplet = Number(raw.slice(0, -1));
          raw = '';
        }
      }

      // 倚音：`{5}3`（前倚音）/ `3{65}`（后倚音）。`|{partial}` 是弱起小节线，
      // 名字里也带花括号，必须先排除掉。
      let graceBefore: GraceNote[] | undefined;
      let graceAfter: GraceNote[] | undefined;
      if (raw !== '|{partial}' && raw !== '') {
        if (raw.startsWith('{')) {
          const end = raw.indexOf('}');
          if (end < 0) {
            errors.push(`倚音缺少右花括号：${raw}`);
          } else {
            graceBefore = parseGraceNotes(raw.slice(1, end)) ?? undefined;
            if (!graceBefore) errors.push(`倚音写法无法识别（应为 {5} 或 {65}）：${raw}`);
            raw = raw.slice(end + 1);
          }
        }
        if (raw.endsWith('}') && !raw.startsWith('|')) {
          const start = raw.lastIndexOf('{');
          if (start < 0) {
            errors.push(`倚音缺少左花括号：${raw}`);
          } else {
            graceAfter = parseGraceNotes(raw.slice(start + 1, -1)) ?? undefined;
            if (!graceAfter) errors.push(`倚音写法无法识别（应为 {5} 或 {65}）：${raw}`);
            raw = raw.slice(0, start);
          }
        }
      }

      if (raw !== '') {
        if (/^拍/.test(raw) || raw === '换行' || raw === '分页') {
          const bar = events[events.length - 1];
          if (!modern || bar?.kind !== 'barline') errors.push(`${raw} 需要 @format 3，并紧接小节线书写`);
          else if (raw.startsWith('拍')) {
            const beat = raw.slice(1);
            if (!validMeter(beat)) errors.push(`拍号不合法：${beat}`);
            else { bar.beatAfter = beat; currentBeat = beat; }
          } else bar.breakAfter = raw === '分页' ? 'page' : 'line';
        } else if (raw === 'cresc[' || raw === 'dim[') {
          if (!modern) errors.push('跨音力度范围需要 @format 3');
          else if (hairpinStart) errors.push('渐强/渐弱范围不能嵌套');
          else hairpinStart = { kind: raw === 'cresc[' ? 'cresc' : 'dim', from: events.length };
        } else if (raw === ']hairpin') {
          if (!hairpinStart) errors.push('力度范围缺少 cresc[ 或 dim[');
          else {
            const notes = events.slice(hairpinStart.from).filter((e): e is NoteEvent => e.kind === 'note');
            if (notes.length < 2) errors.push('跨音力度范围至少需要两个音符');
            else { notes[0].hairpin = hairpinStart.kind; notes[0].hairpinTo = notes[notes.length - 1].id; }
            hairpinStart = null;
          }
        } else if (raw === '|*') pushBarline('single', false, true);
        else if (raw === '|') pushBarline('single');
        else if (raw === '||') pushBarline('final');
        else if (raw === '|{partial}') pushBarline('single', true);
        else if (raw === "'") {
          // 换气记号（早期设计）已从规范中取消：换气是音符技法，写作后缀 V（如 5V）。
          // 这里明确报错而不是悄悄丢掉，老谱面才不会无声变形。
          errors.push("不再支持换气记号 '（请改用音符后缀 V，如 5V）");
        } else if (/^转\s*(\S+)$/.test(raw)) {
          const mKey = /^转\s*(\S+)$/.exec(raw)!;
          const norm = normalizeKey(mKey[1]);
          if (norm) pendingKey = norm;
          else errors.push(`转调记号无法识别（应为 1=C 形式）：${raw}`);
        } else if (DYNAMIC_RE.test(raw)) {
          const id = nextId();
          const ev: Event = { id, kind: 'directive', type: 'dynamic', value: raw };
          events.push(ev);
          byId.set(id, ev);
        } else if (raw === '|:') {
          pushRepeatBarline('start');
        } else if (/^:\|\d*$/.test(raw)) {
          // `:|` 两遍，`:|3` 三遍
          pushRepeatBarline('end', raw.length > 2 ? Number(raw.slice(2)) : 2);
        } else if (/^\[\d+(,\d+)*\]$/.test(raw)) {
          // 跳房子 `[1]` `[2]` `[1,2]`：挂在前面的那根小节线上
          markVolta(raw.slice(1, -1).split(',').map(Number), false);
        } else if (/^\[\d+(,\d+)*$/.test(raw)) {
          // `[1` 不闭合 = 右端开放的房子（长房 / 跨行房的简谱惯例）
          markVolta(raw.slice(1).split(',').map(Number), true);
        } else if (/^\$(s|x|t|f|ds|dc)$/i.test(raw)) {
          // 跳转记号（L2）：$s=𝄋 segno · $x=⊕ coda · $t=To ⊕ · $f=Fine · $ds=D.S. · $dc=D.C.
          const mark = ({ s: 'segno', x: 'coda', t: 'tocoda', f: 'fine', ds: 'ds', dc: 'dc' } as const)[
            raw.slice(1).toLowerCase()
          ]!;
          const id = nextId();
          const ev: Event = { id, kind: 'jump', mark };
          events.push(ev);
          byId.set(id, ev);
        } else if (raw.startsWith('$')) {
          errors.push(
            `跳转记号无法识别：${raw}（可用 $s=𝄋 · $x=⊕ · $t=To⊕ · $f=Fine · $ds=D.S. · $dc=D.C.）`,
          );
        } else if (/[()\u4e00-\u9fff]/.test(raw)) {
          // token 里有括号或中文但没走任何已知分支：多半是装饰文字没写成对，
          // 或括号里混了音符和文字。给出「成对」指引，别只丢一句无法识别。
          errors.push(
            `( ) 需要成对写在同一个记号里：标注段落用 (前奏) 这种纯文字；` +
              `连音线要包住音符，如 (5 6 5)。收到的是：${raw}`,
          );
        } else if (/^8(?:[.\-/]|$)/.test(raw)) {
          // 隐藏休止（番茄写法 8）：时值 / 附点 / 增时线语法与 0 完全一致，
          // 只是占位不画字形——行中混排时给还没进来的声部留空拍
          const at = events.length;
          pushTimed(`0${raw.slice(1)}`, graceBefore, graceAfter, true);
          const last = events[at];
          if (last?.kind !== 'rest') errors.push(`隐藏休止写法无法识别：${raw}`);
        } else {
          pushTimed(raw, graceBefore, graceAfter);
        }
      }

      for (const t of closes) {
        if (t === 'slur') closeSlur();
        else closeGroup();
      }
    }
  }

  // 未闭合的记号：从内到外逐个报错
  for (let i = slurStack.length - 1; i >= 0; i -= 1) {
    errors.push('谱面结束时 ( 未闭合');
    slurStack.pop();
  }
  if (currentGroup) {
    errors.push('谱面结束时 < 未闭合');
    closeGroup();
  }
  if (hairpinStart) errors.push('渐强/渐弱范围缺少 ]hairpin 收尾');
  // 房子没有收尾记号：范围由「下一条带房子的线 / 所在反复段的 :|」决定，
  // 展开器会据此判断它是否在反复段内、属于第几遍。
  if (events.length === 0) errors.push('谱面为空');

  // 转调记号没有落到任何音符上（写在行尾 / 终止线前 / 全曲最后一个记号）：
  // 原来这种写法是**静默丢弃**的，谱面上什么都没变、也不报错，
  // 看起来就像「转调有时有效有时无效」。现在明确报错。
  if (pendingKey) {
    errors.push(`转调记号 转${pendingKey} 后面没有音符，无法生效（转调必须写在它生效的第一个音前面）`);
    pendingKey = undefined;
  }

  // 力度 token 紧跟音符 → 绑到那个音上（画在音符下方），不再是独立事件。
  // 站在别处的力度（休止符前、乐句间）仍是独立事件。
  {
    const kept: Event[] = [];
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      const next = events[i + 1];
      if (
        e.kind === 'directive' &&
        e.type === 'dynamic' &&
        next &&
        next.kind === 'note'
      ) {
        if (e.value === 'cresc' || e.value === 'dim') {
          next.hairpin = e.value;
          continue;
        }
        if (!next.dynamic) {
          next.dynamic = e.value;
          continue;
        }
      }
      kept.push(e);
    }
    events.length = 0;
    events.push(...kept);
  }

  let score: Score | null = events.length || modern ? { version: 2, meta, events, groups, ...(modern ? { format: 3 as const } : {}) } : null;
  if (score && lyricNumbers.size) {
    const applied = applyLyrics(score, Array.from({ length: lyrics.length }, (_, i) => lyrics[i] ?? ''));
    score = applied.score;
    errors.push(...applied.errors);
  }
  return {
    score,
    errors,
  };
}

/** 时长还原：tick + 附点数 → 附点/除法/增时线写法 */
function renderDuration(ticks: number, dot: 0 | 1 | 2): string {
  const dots = dot ?? 0;
  const factor = dots === 0 ? 1 : dots === 1 ? 1.5 : 1.75;
  const undotted = ticks / factor;
  if (!Number.isInteger(undotted)) {
    throw new Error(`tick ${ticks} 与附点数 ${dots} 不自洽，无法还原写法`);
  }
  let base = undotted;
  let dashes = 0;
  while (base > TICKS_PER_BEAT) {
    base -= TICKS_PER_BEAT;
    dashes += 1;
  }
  const div = TICK_DIVISIONS[base];
  if (div === undefined) {
    throw new Error(`tick ${ticks}（去附点后 ${base}）没有对应的除法记号，无法无损还原`);
  }
  let s = dots === 1 ? '.' : dots === 2 ? '..' : '';
  if (div !== 1) s += `/${div}`;
  return s + '-'.repeat(dashes);
}

/**
 * 给定音级与目标时值，渲染出谱面上的实际写法：3---、3-、3/2…
 * 属性面板的时值按钮直接拿它当文字——按钮长什么样，
 * 写进源码就是什么样，用户不必在脑内把「3 拍」换算成「3--」。
 * 八度按钮传 octave 即得 3^ / 3vv 这类实际写法。
 */
export function renderNoteToken(
  degree: number,
  ticks: number,
  dot: 0 | 1 | 2 = 0,
  octave = 0,
): string {
  const marks = octave > 0 ? '^'.repeat(octave) : 'v'.repeat(-octave);
  try {
    return `${degree}${marks}${renderDuration(ticks, dot)}`;
  } catch {
    // 时值不在合法粒度上时退回音级本身：按钮总得有字，不能抛错炸掉面板
    return `${degree}${marks}`;
  }
}

function renderTimed(ev: TimedEvent, tieOut: boolean, modern = false, explicitDuration = false): string {
  // 升级旧谱时避免三个整拍音被新版 <3: 1 2 3> 短写重新解释成一拍。
  const duration = renderDuration(ev.ticks, ev.dot ?? 0) || (explicitDuration ? '/1' : '');
  const short = modern ? duration.replace(/\/(2|4|8)(?!\d)/g, (_, n: string) => '/'.repeat(Math.log2(Number(n)))) : duration;
  if (ev.kind === 'rest') return `${ev.hidden ? '8' : '0'}${short}`;
  const n = ev;
  const marks = n.octave > 0 ? '^'.repeat(n.octave) : 'v'.repeat(-n.octave);
  // 变音记号写在音级左边，与简谱的 `#5` / `b3` 一致
  const acc = n.accidental ?? '';
  const body = `${acc}${n.degree}${marks}${short}`;
  const arts = (n.articulations ?? [])
    .map((a) =>
      a === 'staccato' ? '!' : a === 'tenuto' ? '=' : a === 'accent' ? '>' : '',
    )
    .join('');
  const ferm = n.fermata ? '@' : '';
  const tong = n.tongue === 'K' ? 'k' : n.tongue === 'T' ? 't' : '';
  const tech = (n.techniques ?? []).map((v) => TECHNIQUE_OF[v] ?? '').join('');
  // 倚音：前倚音写主音前、后倚音写主音后；复倚音连写 {65}
  const gb = n.graceBefore?.length ? `{${n.graceBefore.map(renderGraceNote).join('')}}` : '';
  const ga = n.graceAfter?.length ? `{${n.graceAfter.map(renderGraceNote).join('')}}` : '';
  return `${gb}${body}${tieOut ? '~' : ''}${arts}${ferm}${tong}${tech}${ga}`;
}

export function serializeDsl(score: Score): string {
  if (score.part || score.parts?.length) {
    const parts = scoreParts(score);
    const header = serializeSingle(partScore(score, parts[0].id)).split('\n\n')[0];
    return `${header}\n\n${parts.map((part) => {
      const body = serializeSingle(partScore(score, part.id)).split('\n\n').slice(1).join('\n\n');
      const names = part.lyricNames?.length ? `\n@lyricNames ${JSON.stringify(part.lyricNames)}` : '';
      return `@part ${part.id} ${JSON.stringify(part.name)}\n@mix ${part.gain} ${part.muted ? 'off' : 'on'} ${part.solo ? 'solo' : 'all'}${names}\n${body}`;
    }).join('\n\n')}`;
  }
  return serializeSingle(score);
}

function serializeSingle(score: Score): string {
  const head = [
    `@title ${score.meta.title}`,
    `@key ${score.meta.key}`,
    `@beat ${score.meta.beat}`,
    `@bpm ${score.meta.bpm}`,
    `@patch ${score.meta.patch}`,
  ];
  if (score.format === 3) head.unshift('@format 3');
  if (score.meta.patchName) head.push(`@patchName ${score.meta.patchName}`);
  // 谱头说明：居中说明行 + 右侧说明（最多 4 行）。没写过的不写，老文件字节不变
  if (score.meta.sub) head.push(`@sub ${score.meta.sub}`);
  for (const line of score.meta.notes ?? []) {
    if (line) head.push(`@note ${line}`);
  }
  // 版式参数只在用户改过时写出（缺省值不写，老文件保持原样）
  if (score.meta.fontSize !== undefined) head.push(`@size ${score.meta.fontSize}`);
  if (score.meta.letterSpacing !== undefined) head.push(`@space ${score.meta.letterSpacing}`);
  if (score.meta.showMeasureNumbers === false) head.push('@measureNo off');

  const byId = new Map<string, Event>(score.events.map((e) => [e.id, e]));
  const nextOf = new Map<string, Event>();
  score.events.forEach((e, i) => {
    let j = i + 1;
    while (score.events[j]?.kind === 'barline') {
      const bar = score.events[j] as BarlineEvent;
      if (bar.style === 'final' || bar.repeat || bar.volta) break;
      j += 1;
    }
    if (j < score.events.length) nextOf.set(e.id, score.events[j]);
  });

  /**
   * 延音线连接相邻音符，允许中间有小节线（跨小节长音）。
   * 圆滑线可以跨小节线、跨换气记号，因此只看连线本身是否存在，不看是否紧邻。
   */
  const tieOut = (from: Event): boolean => {
    if (from.kind !== 'note') return false;
    const next = nextOf.get(from.id);
    if (!next) return false;
    return (from.ties ?? []).some((t) => t.to === next.id && t.kind === 'tie');
  };

  // 连音线是链式存储的，先还原成每条链的起止音序，才能决定括号放内还是放外
  const idxOf = new Map<string, number>(score.events.map((e, i) => [e.id, i]));
  const slurNext = new Map<string, string>();
  for (const e of score.events) {
    if (e.kind !== 'note') continue;
    for (const t of e.ties ?? []) if (t.kind === 'slur') slurNext.set(e.id, t.to);
  }
  /** 链首音序 → 链尾音序 */
  const slurSpan = new Map<number, number>();
  {
    const isTarget = new Set(slurNext.values());
    for (const e of score.events) {
      if (e.kind !== 'note' || !slurNext.has(e.id) || isTarget.has(e.id)) continue;
      const seen = new Set<string>();
      let cur: string | undefined = e.id;
      let hi = idxOf.get(e.id)!;
      while (cur !== undefined && !seen.has(cur)) {
        seen.add(cur);
        hi = Math.max(hi, idxOf.get(cur) ?? hi);
        cur = slurNext.get(cur);
      }
      slurSpan.set(idxOf.get(e.id)!, hi);
    }
  }
  /** 链尾音序 → 链首音序集合 */
  const slurEndsAt = new Map<number, number[]>();
  for (const [lo, hi] of slurSpan) {
    const arr = slurEndsAt.get(hi);
    if (arr) arr.push(lo);
    else slurEndsAt.set(hi, [lo]);
  }

  const out: string[] = [];
  const emitted = new Set<string>();
  const hairpinEnds = new Map<string, number>();
  for (const e of score.events) if (e.kind === 'note' && e.hairpinTo) hairpinEnds.set(e.hairpinTo, (hairpinEnds.get(e.hairpinTo) ?? 0) + 1);
  const rangeStart = (e: TimedEvent) => e.kind === 'note' && e.hairpin && e.hairpinTo ? `${e.hairpin}[ ` : '';
  const rangeEnd = (e: TimedEvent) => ' ]hairpin'.repeat(hairpinEnds.get(e.id) ?? 0);

  for (const ev of score.events) {
    if (emitted.has(ev.id)) continue;

    if ((ev.kind === 'note' || ev.kind === 'rest') && ev.groupId) {
      const g = score.groups.find((x) => x.id === ev.groupId && !x.auto);
      if (g && g.memberIds[0] === ev.id) {
        const members = g.memberIds
          .map((id) => byId.get(id))
          .filter((m): m is TimedEvent => !!m && (m.kind === 'note' || m.kind === 'rest'));
        // 两层记号互不相关，括号直接按事件位置排即可：
        // 连线在组内起止就写进 < > 里面，如 (3 <4/2) 2/2>
        const inner = members
          .map((m) => {
            const mi = idxOf.get(m.id)!;
            const pre = slurSpan.has(mi) ? '(' : '';
            const post = (slurEndsAt.get(mi) ?? []).length > 0 ? ')' : '';
            // 组内成员的力度 / 渐变 / 转调写在成员前面，解析时会绑回那个音
            const dyn =
              m.kind === 'note'
                ? [m.dynamic, m.hairpinTo ? undefined : m.hairpin].filter(Boolean).join(' ')
                : '';
            const kc = m.kind === 'note' && m.keyChange ? `转${m.keyChange} ` : '';
            return `${rangeStart(m)}${kc}${dyn ? `${dyn} ` : ''}${pre}${renderTimed(m, tieOut(m), score.format === 3, score.format === 3 && g.tuplet === 3)}${post}${rangeEnd(m)}`;
          })
          .join(' ');

        out.push(`<${g.tuplet ? `${g.tuplet}: ` : ''}${inner}>`);
        members.forEach((m) => emitted.add(m.id));
        continue;
      }
      if (g) continue; // 显式组的非首成员已随组输出；自动组仍逐音回写。
    }

    switch (ev.kind) {
      case 'note':
      case 'rest': {
        const i = idxOf.get(ev.id)!;
        const pre = slurSpan.get(i) !== undefined ? '(' : '';
        const post = (slurEndsAt.get(i) ?? []).length > 0 ? ')' : '';
        // 跟音符绑定的力度 / 渐变 / 转调写在音符前面，解析时绑回那个音
        const dyn =
          ev.kind === 'note'
            ? [ev.dynamic, ev.hairpinTo ? undefined : ev.hairpin].filter(Boolean).join(' ')
            : '';
        const kc = ev.kind === 'note' && ev.keyChange ? `转${ev.keyChange} ` : '';
        out.push(`${rangeStart(ev)}${kc}${dyn ? `${dyn} ` : ''}${pre}${renderTimed(ev, tieOut(ev), score.format === 3)}${post}${rangeEnd(ev)}`);
        emitted.add(ev.id);
        break;
      }
      case 'barline': {
        // 反复记号是这条线的属性，不是另一个记号——所以只有**一个** token
        let tok: string;
        if (ev.hidden && ev.style === 'single' && !ev.repeat) tok = '|*';
        else if (ev.repeat === 'start') tok = '|:';
        else if (ev.repeat === 'end') tok = ev.times && ev.times > 2 ? `:|${ev.times}` : ':|';
        else if (ev.style === 'final') tok = '||';
        else if (ev.partial) tok = '|{partial}';
        else tok = '|';
        out.push(tok);
        if (ev.beatAfter) out.push(`拍${ev.beatAfter}`);
        if (ev.breakAfter) out.push(ev.breakAfter === 'page' ? '分页' : '换行');
        // 房子写在这条线后面：`| [1] 3 3 | [2] 4 4 :|`；开放右端写不闭合的 `[1`
        if (ev.volta) out.push(ev.voltaOpen ? `[${ev.volta.join(',')}` : `[${ev.volta.join(',')}]`);
        emitted.add(ev.id);
        break;
      }
      case 'jump': {
        const tok = { segno: '$s', coda: '$x', tocoda: '$t', fine: '$f', ds: '$ds', dc: '$dc' }[
          ev.mark
        ];
        out.push(tok);
        emitted.add(ev.id);
        break;
      }
      case 'directive':
        // 文字装饰记号（(前奏) 之类）回写时把括号带上，round-trip 无损
        out.push(ev.type === 'text' ? `(${ev.value})` : ev.value);
        emitted.add(ev.id);
        break;
      default:
        break;
    }
  }

  const rows = lyricRows(score).map((row, i) => `歌词${i + 1}: ${row}`);
  return `${head.join('\n')}\n\n${out.join(' ')}\n${rows.length ? `${rows.join('\n')}\n` : ''}`;
}
