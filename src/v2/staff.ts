/**
 * 五线谱排版（实验功能，默认关闭——开关见 experimental.ts）。
 *
 * 走最小改动路线：不新建断行逻辑，直接复用简谱排版已经算好的行（line.y）
 * 和每个音的横向位置，只把「数字」换成「符头 + 符干 / 符杠 / 休止符」重画一遍。
 * 于是行号 / 小节 / 断行与简谱视图一一对应，切过去不会错位。
 *
 * 音高不用重新推导：timeline.toMidi 已把「音级 + 八度 + 调号 + 变音记号」
 * 解成绝对音高；这里只负责 音高 → 音名 → 谱表第几格。
 */

import type { LayoutResult, PlacedVolta } from './layout';
import { buildStaffCurves, type StaffCurve } from './staffCurves';
import { spaceStaffLines } from './staffSpacing';
import { staffAccWidth, staffGraceInk } from './staffInk';
import { positionStaffTuplets } from './staffTuplets';
import { placeStaffGrace, type StaffGraceGroup } from './staffGrace';
import { buildStaffMarks, type StaffMark } from './staffMarks';
import { accidentalGlyph, instrumentOf, keyAlter, keyFifths, keyTonic, legacyPitch, writtenKey, writtenPitch, type SpelledPitch, type StaffPitchMode, type StaffClef } from './pitch';
import { scoreParts } from './parts';
import { resolveStaffClef } from './staffClef';
import { lyricTextWidth, projectLyricLines, type LyricLine } from './lyricLines';
import { staffContentRight } from './staffBounds';
import { TICKS_PER_BEAT } from './ticks';
import type { Accidental, BeatGroup, JumpMark, Score } from './types';

/** 符干长度：一个八度 = 7 个半格 */
export const STEM_OCT = 7;
/** 符头半宽（×线间距）：符干贴在它右侧（上）或左侧（下） */
export const HEAD_RX = 0.52;
/** 谱表上一格：符头或休止符 */
export interface StaffGlyph {
  kind: 'note' | 'rest';
  eventId: string;
  /** 符头 / 记号中心（画布坐标） */
  x: number;
  y: number;
  /** 谱表格：0 = 底线 E4，2 = 第二线 G4，8 = 顶线 F5（加线判定用） */
  step: number;
  /** 临时升降号字形（♯ / ♭ / ♮），无记号时为空串 */
  accMark: string;
  dots: number;
  ticks: number;
  /** Undotted written duration; ticks remains the sounding duration. */
  baseTicks?: number;
  hidden?: boolean;
  playWidth?: number;
  playXs?: { fraction: number; x: number }[];
  /** 符尾条数（0 = 四分或更长） */
  beams: number;
  /** 符干朝上（音在中线以下） */
  up: boolean;
  /** 符杠在此音 x 处的 y：符干画到这儿（有符杠的音才有） */
  beamEnd?: number;
  gray?: boolean;
}

export interface StaffBarGlyph {
  kind: 'barline';
  x: number;
  final?: boolean;
  /** 双细线（乐段结束）：画两根细线 */
  double?: boolean;
  repeat?: 'start' | 'end' | 'both';
  repeatTimes?: number;
  volta?: number[];
  voltaOpen?: boolean;
  jump?: boolean;
  measure?: number;
}

export type StaffSymbol = StaffGlyph | StaffBarGlyph | { kind: 'meter'; x: number; beat: string } | { kind: 'key'; x: number; key: string; previousKey: string };

export interface StaffBeam {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 1 = 八分、2 = 十六分 */
  level: number;
  gray?: boolean;
}

export interface StaffTuplet {
  groupId: string;
  x0: number;
  x1: number;
  y: number;
  text: string;
  bracket: boolean;
}

export interface StaffLyric {
  x: number;
  text: string;
  verse: number;
}

export interface StaffJump {
  x: number;
  /** Top of the reserved jump-symbol lane. */
  y: number;
  mark: JumpMark;
}

export interface StaffVolta extends PlacedVolta {
  y: number;
}

export interface StaffLineData {
  lyricLines?: LyricLine[];
  y: number;
  /** 空声部沿用同一系统的内容起点；横幅展开时也随行平移。 */
  contentX?: number;
  system?: number;
  partId?: string;
  partName?: string;
  /** 这一行行首生效的调号（跟着转调走） */
  key: string;
  clef: StaffClef;
  beat?: string;
  tuplets?: StaffTuplet[];
  label: string;
  symbols: StaffSymbol[];
  beams: StaffBeam[];
  lyrics: StaffLyric[];
  lyricY?: number;
  labelY?: number;
  /** 小节号基线的墨迹中心（在谱表上方让出的一条专属带）；关闭小节号时没有 */
  measureY?: number;
  graces: StaffGraceGroup[];
  jumps?: StaffJump[];
  voltas?: StaffVolta[];
}

export interface StaffLayout {
  lines: StaffLineData[];
  curves: StaffCurve[];
  marks: StaffMark[];
  /** 五线间距（px） */
  sp: number;
  width: number;
  height: number;
  glyph: LayoutResult['glyph'];
  title: LayoutResult['title'];
  /** 拍号（如 "4/4"），画在第一行行首 */
  beat: string;
  /**
   * 是否画小节号（取自 `meta.showMeasureNumbers`，默认开）。
   * 排版层就要知道——它决定要不要给小节号那条带留行距，绘制层再按此画。
   */
  showMeasureNumbers: boolean;
}

/** 谱表第 step 格的 y：整体以**行中线**为谱表中心线对称 */
export function staffBottom(lineY: number, sp: number): number {
  return lineY + 2 * sp;
}

/** 谱表纵向格：0 = 高音谱表底线（E4），每 +1 = 升半格 */
export function staffStep(letter: number, oct: number): number {
  return letter + 7 * oct - 30;
}

/** 记谱调字符串里的字母索引（"1=bB" → B = 6） */
function tonicLetter(key: string): number {
  return keyTonic(key).step;
}

/** 该调七个音级分别用哪个字母——大调＝七个字母各出现一次 */
export function scaleLetters(key: string): number[] {
  const t = tonicLetter(key);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => (t + i) % 7);
}

/**
 * 调号：升降号个数（负数 = 降号）与它们在谱表上的位置。
 * 保留原调号拼写；F♯ 与 G♭ 分别使用六升和六降。
 */
export function keySignature(key: string): { count: number; sharp: boolean; steps: number[]; alters: number[] } {
  const fifths = keyFifths(key);
  const sharp = fifths >= 0;
  // 理论调号（如 A♯ 大调）使用重升/重降，仍只占七个音名字位。
  const count = Math.min(7, Math.abs(fifths));
  const steps = (sharp ? [8, 5, 9, 6, 3, 7, 4] : [4, 7, 3, 6, 2, 5, 1]).slice(0, count);
  const letters = (sharp ? [3, 0, 4, 1, 5, 2, 6] : [6, 2, 5, 1, 4, 0, 3]).slice(0, count);
  return { count, sharp, steps, alters: letters.map(step => keyAlter(key, step)) };
}

/** 音级 + 八度 + 调号 + 变音记号 → 谱表位置（含临时记号字形） */
export function staffPosOf(
  degree: number,
  octave: number,
  key: string,
  accidental?: Accidental,
): { step: number; accMark: string } {
  const p = legacyPitch(degree, octave, key, accidental);
  return {
    step: staffStep(p.step, p.octave),
    accMark: p.alter === keyAlter(key, p.step) ? '' : accidentalGlyph(p.alter),
  };
}

/** 符尾条数（与简谱减时线同一口径：1/2 拍=1 条、1/4 拍=2 条、1/8 拍=3 条） */
export function beamCountOf(ticks: number, dots: number): number {
  const base = dots === 1 ? ticks / 1.5 : dots === 2 ? ticks / 1.75 : ticks;
  if (base <= TICKS_PER_BEAT / 8) return 3;
  if (base <= TICKS_PER_BEAT / 4) return 2;
  if (base <= TICKS_PER_BEAT / 2) return 1;
  return 0;
}

/** 休止符形态：按总时值归入全 / 二分 / 四分 / 八分 / 十六分 */
export type RestKind = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth' | 'thirtySecond';

export function restKindOf(ticks: number): RestKind {
  if (ticks >= TICKS_PER_BEAT * 4) return 'whole';
  if (ticks >= TICKS_PER_BEAT * 2) return 'half';
  if (ticks >= TICKS_PER_BEAT) return 'quarter';
  if (ticks >= TICKS_PER_BEAT / 2) return 'eighth';
  if (ticks >= TICKS_PER_BEAT / 4) return 'sixteenth';
  return 'thirtySecond';
}

/**
 * 简谱排版 → 五线谱排版。
 *
 * - 符头中心 = 简谱数字的墨迹中心（与光球击中点同一公式），两个视图里
 *   「这个音在哪」是同一个位置；
 * - 临时升降号只在**该音偏离调号**时才画，跟着调号与转调走；
 * - 符杠按「同小节且连续」连成组，二级符杠只连实际带二级的那几个音。
 */
export function buildStaffLayout(score: Score, layout: LayoutResult, mode: StaffPitchMode = 'concert'): StaffLayout {
  const g = layout.glyph;
  const sp = Math.max(6, g.fontSize / 2.8); // 线间距 ≈ 7.5px @21px 字号
  const lines: StaffLineData[] = [];
  const parts = scoreParts(score);
  const clefs = new Map(parts.map(part => [part.id, resolveStaffClef(part, score.meta.key, mode)]));
  /**
   * 每个声部只需算一次的派生数据：**必须放在行循环外**。
   * 原来 `sourceEvents` / `pitches` / `tiedInto` 是每行重算一遍全声部事件，
   * 行数 × 事件数 就是平方级——实测 2000 小节的谱光排版要 2.9 秒。
   * 这些数据只跟声部与移调模式有关，与行无关，按声部缓存即可。
   */
  const partData = new Map<string, {
    sourceEvents: Map<string, (typeof parts)[number]['events'][number]>;
    pitches: Map<string, SpelledPitch>;
    tiedInto: Set<string>;
  }>();
  for (const part of parts) {
    const sourceEvents = new Map(part.events.map(e => [e.id, e]));
    // Resolve ties against each event's own key, including changes across lines.
    // Explicit ♮ retains legacyPitch's old source-sound semantics; this layer
    // only decides which written accidental to show and never changes playback.
    const pitches = new Map<string, SpelledPitch>();
    let eventKey = score.meta.key;
    for (const event of part.events) {
      if (event.kind !== 'note') continue;
      eventKey = event.keyChange ?? eventKey;
      pitches.set(event.id, writtenPitch(legacyPitch(event.degree, event.octave, eventKey, event.accidental), mode, part.staffInstrument));
    }
    const tiedInto = new Set<string>();
    for (const event of part.events) {
      if (event.kind !== 'note') continue;
      const from = pitches.get(event.id)!;
      for (const tie of event.ties ?? []) {
        const to = pitches.get(tie.to);
        if (tie.kind === 'tie' && to && from.step === to.step && from.octave === to.octave && from.alter === to.alter) tiedInto.add(tie.to);
      }
    }
    partData.set(part.id, { sourceEvents, pitches, tiedInto });
  }
  const partById = new Map(parts.map(part => [part.id, part]));
  const keys = new Map<string, string>();
  const meters = new Map<string, string>();
  const accidentals = new Map<string, Map<string, number>>();

  for (const line of layout.lines) {
    const part = (line.partId ? partById.get(line.partId) : undefined) ?? parts[0];
    let curKey = keys.get(part.id) ?? score.meta.key;
    let curBeat = meters.get(part.id) ?? score.meta.beat;
    const lineBeat = curBeat;
    const clef = clefs.get(part.id)!;
    const clefOffset = clef === 'bass' ? 12 : 0;
    const lineKey = writtenKey(curKey, mode, part.staffInstrument);
    const state = accidentals.get(part.id) ?? new Map<string, number>();
    accidentals.set(part.id, state);
    const { sourceEvents, tiedInto } = partData.get(part.id)!;
    const symbols: StaffSymbol[] = [];
    const lyrics: StaffLyric[] = [];
    const beams: StaffBeam[] = [];
    const graces: StaffGraceGroup[] = [];
    const bottom = staffBottom(line.y, sp);
    const u = sp / 2;
    const yAt = (step: number): number => bottom - step * u;
    /** 待出符杠的连续音符（跨小节线 / 遇休止符就断组） */
    let run: StaffGlyph[] = [];
    /**
     * 符杠按**拍**断组：简谱的拍内组（BeatGroup）就是「同一拍」的音，
     * 五线谱的符杠惯例也是一拍一连——不按拍断的话整小节的音连成
     * 一条长杠，斜得像滑梯（用户截图实测）。
     */
    /**
     * 音 → 所属拍内组。两个索引一次建好：原来每颗音都 `(part.groups).find(...)`，
     * 长谱上是 O(音×组)——实测 2000 小节光排版就要 7 秒。
     */
    const groupOf = new Map<string, string>();
    const groupById = new Map<string, BeatGroup>();
    for (const grp of part.groups ?? []) {
      groupById.set(grp.id, grp);
      for (const id of grp.memberIds) groupOf.set(id, grp.id);
    }

    const flush = (): void => {
      if (run.length >= 2) {
        const up = run.reduce((a, m) => a + m.step, 0) / run.length < 4;
        for (const m of run) m.up = up; // 一组共用一个符干方向
        const endY = (m: StaffGlyph): number => yAt(m.step) + (up ? -STEM_OCT * u : STEM_OCT * u);
        const gap = 2.2 * u;
        /**
         * 符干的横坐标（绘制层用同一个公式算，两边必须一致）：
         * 上 = 符头右缘外，下 = 符头左缘外。符杠的左右端点与每根符干的
         * 末端都按这个 x 算——按符头中心算会让斜杠上的符干尖偏出杠面，
         * 杠的两端也包不住外侧的符干（用户截图实测「横竖线没对齐」）。
         */
        const stemX = (m: StaffGlyph): number =>
          m.x + (up ? 1 : -1) * (sp * HEAD_RX - 0.4);
        // 一级符杠的斜度钳到 1.6sp：音程跳得再大，符杠也不该斜成滑梯
        let y0 = endY(run[0]!);
        let y1 = endY(run[run.length - 1]!);
        const maxSlant = 1.6 * sp;
        if (y1 - y0 > maxSlant) y1 = y0 + maxSlant;
        if (y0 - y1 > maxSlant) y1 = y0 - maxSlant;
        // 符杠收在首尾符干上，不向两侧悬伸。
        const x0 = stemX(run[0]!);
        const x1 = stemX(run[run.length - 1]!);
        // 中间音可能比首尾更高／低；整体移动符杠，保证所有符干方向和长度。
        const clearance = (2.5 + (Math.max(...run.map(m => m.beams)) - 1) * 1.1) * sp;
        const shift = Math.max(0, ...run.map(m => {
          const by = x1 === x0 ? y0 : y0 + (y1 - y0) * (stemX(m) - x0) / (x1 - x0);
          return up ? by - (m.y - clearance) : m.y + clearance - by;
        }));
        y0 += up ? -shift : shift;
        y1 += up ? -shift : shift;
        const yAtX = (x: number): number =>
          x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
        beams.push({ x0, y0, x1, y1, level: 1, gray: run.every((m) => m.gray) });
        // 符干画到符杠上（而不是固定长度），中间的音才不会和符杠脱节
        for (const m of run) m.beamEnd = yAtX(stemX(m));
        for (let level = 2; level <= 3; level += 1) {
          let start = 0;
          while (start < run.length) {
            if (run[start]!.beams < level) { start += 1; continue; }
            let end = start + 1;
            while (end < run.length && run[end]!.beams >= level) end += 1;
            const b0 = stemX(run[start]!);
            // Isolated secondary beams get a short hook toward a neighbour.
            const neighbour = start === run.length - 1 ? start - 1 : start + 1;
            const b1 = end - start > 1 ? stemX(run[end - 1]!)
              : b0 + Math.sign(stemX(run[neighbour]!) - b0) * Math.min(sp * 1.1, Math.abs(stemX(run[neighbour]!) - b0) / 2);
            const offset = (up ? gap : -gap) * (level - 1);
            beams.push({ x0: b0, y0: yAtX(b0) + offset, x1: b1, y1: yAtX(b1) + offset, level, gray: run.slice(start, end).every(m => m.gray) });
            start = end;
          }
        }
      }
      run = [];
    };

    for (let ii = 0; ii < line.items.length; ii += 1) {
      const it = line.items[ii]!;
      if (it.kind === 'barline') {
        flush();
        state.clear();
        if (!it.hidden) symbols.push({
          kind: 'barline',
          x: it.x + it.w / 2,
          ...(it.final ? { final: true } : {}),
          ...(it.double ? { double: true } : {}),
          ...(it.repeat ? { repeat: it.repeat } : {}),
          ...(it.repeatTimes ? { repeatTimes: it.repeatTimes } : {}),
          ...(it.measure !== undefined ? { measure: it.measure } : {}),
        });
        if (it.beatAfter) {
          curBeat = it.beatAfter;
          // 只看剩下的项里还有没有音符——原来用 indexOf + slice 拷一遍数组，
          // 每根小节线一次，长谱上是平方级开销
          let hasNext = false;
          for (let j = ii + 1; j < line.items.length; j += 1) {
            const nxt = line.items[j]!;
            if (nxt.kind === 'note' || nxt.kind === 'rest') { hasNext = true; break; }
          }
          if (hasNext) symbols.push({ kind: 'meter', x: it.x + it.w / 2 + sp * 0.4, beat: curBeat });
        }
        continue;
      }
      if (it.kind !== 'note' && it.kind !== 'rest') continue;
      if (it.keyChange) {
        const previousKey = writtenKey(curKey, mode, part.staffInstrument);
        curKey = it.keyChange;
        const key = writtenKey(curKey, mode, part.staffInstrument);
        symbols.push({ kind: 'key', x: it.x, key, previousKey });
        state.clear();
      }
      const x = it.x + g.pad + (it.accW ?? 0) + (it.graceInk ?? 0) + g.nominalWidth / 2;
      const ticks = it.ticks ?? TICKS_PER_BEAT;
      const dots = it.dot ?? 0;
      const gid0 = groupOf.get(it.eventId);
      const group = gid0 === undefined ? undefined : groupById.get(gid0);
      const duration = ticks / (dots === 1 ? 1.5 : dots === 2 ? 1.75 : 1);
      const baseTicks = group?.tuplet ? duration * group.tuplet / 2 ** Math.floor(Math.log2(group.tuplet)) : duration;

      if (it.kind === 'rest') {
        flush();
        symbols.push({
          kind: 'rest',
          eventId: it.eventId,
          x,
          y: yAt(4),
          step: 4,
          accMark: '',
          dots,
          ticks,
          playWidth: it.w,
          playXs: it.playXs?.map(p => ({ ...p, x: p.x + g.pad + g.nominalWidth / 2 })),
          baseTicks,
          hidden: it.hidden,
          beams: 0,
          up: false,
          ...(it.gray ? { gray: true } : {}),
        });
        continue;
      }

      const pitch = writtenPitch(legacyPitch(it.degree ?? 1, it.octave ?? 0, curKey, it.accidental), mode, part.staffInstrument);
      const step = staffStep(pitch.step, pitch.octave) + clefOffset;
      const source = sourceEvents.get(it.eventId);
      const graceState = new Map(state);
      if (source?.kind === 'note' && source.graceBefore?.length) staffGraceInk(source.graceBefore, g, curKey, mode, part.staffInstrument, state);
      const pitchKey = writtenKey(curKey, mode, part.staffInstrument);
      const identity = `${pitch.step}:${pitch.octave}`;
      const previous = state.get(identity) ?? keyAlter(pitchKey, pitch.step);
      const accMark = tiedInto.has(it.eventId) || previous === pitch.alter && !(source?.kind === 'note' && source.accidental === '♮') ? '' : accidentalGlyph(pitch.alter);
      if (source?.kind === 'note' && source.graceBefore?.length) graces.push(placeStaffGrace(
        source.graceBefore, 'before', it.eventId, x, yAt(step), line.y, sp, g,
        curKey, mode, part.staffInstrument, clef, graceState, source.gray, staffAccWidth(accMark, sp)));
      // 跨小节延音不重新起音，也不把上一小节的临时记号带给本小节后续起音。
      if (!tiedInto.has(it.eventId)) state.set(identity, pitch.alter);
      const beams = beamCountOf(baseTicks, 0);
      const glyph: StaffGlyph = {
        kind: 'note',
        eventId: it.eventId,
        x,
        y: yAt(step),
        step,
        accMark,
        dots,
        ticks,
        playWidth: it.w,
        playXs: it.playXs?.map(p => ({ ...p, x: p.x + g.pad + g.nominalWidth / 2 })),
        baseTicks,
        beams,
        up: step < 4,
        ...(it.gray ? { gray: true } : {}),
      };
      if (beams >= 1) {
        // 换了拍内组就先断杠（组外的长音各自为政，本来就不进杠）
        const gid = groupOf.get(it.eventId);
        if (run.length >= 1 && (gid === undefined || groupOf.get(run[0]!.eventId) !== gid)) flush();
        run.push(glyph);
      } else flush();
      symbols.push(glyph);
      if (source?.kind === 'note' && source.graceAfter?.length) graces.push(placeStaffGrace(
        source.graceAfter, 'after', it.eventId, x, yAt(step), line.y, sp, g,
        curKey, mode, part.staffInstrument, clef, state, source.gray));
    }
    flush();

    const tuplets: StaffTuplet[] = [];
    for (const group of part.groups ?? []) {
      if (!group.tuplet) continue;
      const members = symbols.filter((s): s is StaffGlyph => (s.kind === 'note' || s.kind === 'rest') && group.memberIds.includes(s.eventId));
      if (!members.length) continue;
      const bracket = members.length !== group.memberIds.length || members.some(m => m.kind === 'rest' || m.beamEnd === undefined);
      tuplets.push({ groupId: group.id, x0: members[0]!.x - sp * 0.6, x1: members[members.length - 1]!.x + sp * 0.6,
        y: Math.min(yAt(8), ...members.map(m => Math.min(m.y, m.beamEnd ?? m.y - STEM_OCT * u))) - sp * 1.2,
        text: String(group.tuplet), bracket });
    }

    // 歌词放在谱表下方（沿用简谱的行内字位）
    for (const it of line.items) {
      if (it.kind !== 'note' || !it.lyrics?.length) continue;
      const lx = it.x + g.pad + (it.accW ?? 0) + (it.graceInk ?? 0) + g.nominalWidth / 2;
      it.lyrics.forEach((text, verse) => {
        if (text) lyrics.push({ x: lx, text, verse });
      });
    }

    const peerHeads = symbols.some(s => s.kind === 'note' || s.kind === 'rest') ? [] : layout.lines.filter(peer => line.system !== undefined && peer.system === line.system)
      .flatMap(peer => peer.items.filter(it => it.kind === 'note' || it.kind === 'rest')
        .map(it => it.x + g.pad + (it.accW ?? 0) + (it.graceInk ?? 0) + g.nominalWidth / 2));
    lines.push({
      y: line.y,
      contentX: peerHeads.length ? Math.min(...peerHeads) : line.items[0]?.x ?? layout.title?.leftX ?? 96 * g.fontSize / 21,
      system: line.system,
      ...(line.partId ? { partId: line.partId } : {}),
      ...(line.partName ? { partName: line.partName } : {}),
      key: lineKey,
      beat: lineBeat,
      tuplets,
      clef,
      label: `${part.name} · ${mode === 'concert' ? '实音谱' : instrumentOf(part.staffInstrument).label + '移调谱'}`,
      symbols,
      beams,
      lyrics,
      graces,
      // Conductor structures belong to the uppermost staff of an ensemble system.
      ...((line.system === undefined || !lines.some(l => l.system === line.system)) ? {
        jumps: line.items.flatMap(it => it.kind === 'jump' && it.mark
          ? [{ x: Math.max(sp, Math.min(it.x + it.w / 2, layout.width - 7 * sp)), y: line.y, mark: it.mark }] : []),
        voltas: line.voltas.map(v => ({ ...v, y: line.y })),
      } : {}),
    });
    keys.set(part.id, curKey);
    meters.set(part.id, curBeat);
  }

  // A barline carried to the next row can leave a tiny house segment with no
  // music under it. Normalize staff copies only; the source layout stays intact.
  const voltaChains: Array<Array<{ line: StaffLineData; volta: StaffVolta }>> = [];
  const activeVoltas = new Map<string, Array<{ line: StaffLineData; volta: StaffVolta }>>();
  for (const line of lines) for (const volta of line.voltas ?? []) {
    const key = volta.numbers.join(',');
    let chain = activeVoltas.get(key);
    if (!volta.cont || !chain) {
      chain = [];
      voltaChains.push(chain);
      activeVoltas.set(key, chain);
    }
    chain.push({ line, volta });
  }
  for (const chain of voltaChains) {
    const covered = chain.filter(({ line, volta }) => line.symbols.some(s =>
      (s.kind === 'note' || s.kind === 'rest') &&
      s.x + HEAD_RX * sp > volta.x0 && s.x - HEAD_RX * sp < volta.x1));
    const keep = new Set(covered.map(segment => segment.volta));
    for (const { line, volta } of chain) if (!keep.has(volta)) {
      line.voltas = line.voltas?.filter(v => v !== volta);
    }
    if (!covered.length) continue;
    covered[0].volta.cont = false;
    const last = covered[covered.length - 1].volta;
    const ending = chain[chain.length - 1].volta;
    last.open = ending.open;
    last.jump = ending.jump;
  }

  const staff: StaffLayout = {
    lines,
    curves: [],
    marks: [],
    sp,
    width: layout.width,
    height: layout.height,
    glyph: layout.glyph,
    title: layout.title,
    beat: score.meta.beat,
    showMeasureNumbers: score.meta.showMeasureNumbers !== false,
  };
  for (const part of parts) {
    const rows = lines.filter(line => (line.partId ?? parts[0].id) === part.id);
    const source = new Map(part.events.map(e => [e.id, e]));
    const projected = projectLyricLines(part.events, rows.map(line => ({
      left: Math.min(...line.symbols.map(s => s.x), line.contentX ?? Infinity),
      right: staffContentRight(line, sp),
      notes: line.symbols.flatMap(s => {
        if (s.kind !== 'note') return [];
        const event = source.get(s.eventId);
        return [{ id: s.eventId, x: s.x, widths: event?.kind === 'note' ? (event.lyrics ?? []).map(word => lyricTextWidth(word, sp * 2)) : [] }];
      }),
    })), sp * 2);
    rows.forEach((line, i) => { if (projected[i].length) line.lyricLines = projected[i]; });
  }
  staff.curves = buildStaffCurves(score, staff);
  positionStaffTuplets(staff);
  staff.marks = buildStaffMarks(score, staff);
  spaceStaffLines(staff);
  return staff;
}

