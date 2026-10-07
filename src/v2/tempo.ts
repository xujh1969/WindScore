/**
 * TempoMap（M8）：谱面 tick ↔ 音频绝对秒 的唯一换算层。
 *
 * 指导书 §5：恒定 BPM 的歌，整条节奏轴只有 3 个自由度——
 *   BPM / 音频网格相位 phaseSec / 谱面原点 scoreOriginBeat。
 * 拿到它们之后，每个音符的绝对时刻都是纯数学推算（不是逐音检测）：
 *
 *   音符时间 = phaseSec + (scoreOriginBeat + 音符所在拍) × 60 / BPM
 *
 * scoreOriginBeat 解决「谱面与音频错开 N 小节」这类普遍情况
 * （前奏、间奏、谱面只记副歌）；它允许小数，弱起谱面也能表达。
 *
 * 两种形式：
 *   constant —— 存储特例，4 个数；换算走闭式解，O(1)。
 *   curve    —— 通用形式，beatTimes[i] = 音频第 i 拍的绝对秒；拍内线性插值。
 * 恒定 BPM 是 curve 的等差退化特例，所以变速（M13）不需要改任何换算代码，
 * 只需要检测端产出非等差的 beatTimes。
 *
 * tick 抽象的红利：buildTimeline / layout / paint / DSL 都只认 tick，
 * 本文件是 tick ↔ 秒 的唯一出入口，换掉它就完成了整个变速改造。
 */
import { TICKS_PER_BEAT } from './ticks';

/** 恒定 BPM 的紧凑形式 */
export interface ConstantTempo {
  kind: 'constant';
  /** 如 108.0 */
  bpm: number;
  /** 音频网格相位：第 0 个音乐拍点在音频里的位置（秒），如 0.31 */
  phaseSec: number;
  /** 谱面第 0 拍对应音频的第几拍（可带小数），如 36.0 = 差 9 小节 */
  scoreOriginBeat: number;
}

/** 通用形式：beatTimes 必须严格递增 */
export interface TempoCurve {
  kind: 'curve';
  beatTimes: number[];
  scoreOriginBeat: number;
}

export type TempoMap = ConstantTempo | TempoCurve;

/** 构造恒定 TempoMap（参数非法直接抛错——脏参数会让整条时间轴算出 NaN） */
export function constantTempo(bpm: number, phaseSec: number, scoreOriginBeat: number): ConstantTempo {
  if (!Number.isFinite(bpm) || bpm <= 0) throw new Error(`BPM 非法：${bpm}`);
  if (!Number.isFinite(phaseSec)) throw new Error(`相位非法：${phaseSec}`);
  if (!Number.isFinite(scoreOriginBeat)) throw new Error(`谱面原点非法：${scoreOriginBeat}`);
  return { kind: 'constant', bpm, phaseSec, scoreOriginBeat };
}

/**
 * 展开成 curve 形式：beatTimes[i] = 音频第 i 拍的绝对秒。
 * constant 的拍数要指定（或用缺省视界）；curve 原样返回（不拷贝，读侧不得改写）。
 */
export function expandBeatTimes(map: TempoMap, beatCount?: number): number[] {
  if (map.kind === 'curve') return map.beatTimes;
  const step = 60 / map.bpm;
  const n =
    beatCount ??
    Math.max(64, Math.ceil((600 - map.phaseSec) / step)); // 缺省视界 600s，超出部分靠外推，恒定下外推是精确的
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) out[i] = map.phaseSec + i * step;
  return out;
}

/**
 * **音频拍**（可小数）→ 音频绝对秒。拍内线性插值，越界按端点节距外推。
 *
 * 注意入参是音频拍不是谱面拍——scoreOriginBeat 的换算只发生在 tick 层
 * （tickToSec / secToTick），两种 TempoMap 形式才能共用同一套插值代码。
 */
export function beatToSec(map: TempoMap, beat: number): number {
  if (map.kind === 'constant') {
    return map.phaseSec + beat * (60 / map.bpm);
  }
  const t = map.beatTimes;
  if (t.length === 0) return 0;
  if (t.length === 1) return t[0];
  const i = Math.floor(beat);
  if (i < 0) return t[0] + beat * (t[1] - t[0]);
  if (i >= t.length - 1) {
    const j = t.length - 1;
    return t[j] + (beat - j) * (t[j] - t[j - 1]);
  }
  return t[i] + (beat - i) * (t[i + 1] - t[i]);
}

/** 音频绝对秒 → **音频拍**（可小数、可为负 = 音频第 0 拍之前） */
export function secToBeat(map: TempoMap, sec: number): number {
  if (map.kind === 'constant') {
    return (sec - map.phaseSec) * (map.bpm / 60);
  }
  const t = map.beatTimes;
  if (t.length === 0) return 0;
  if (sec <= t[0]) {
    const step = t.length > 1 ? t[1] - t[0] : 1;
    return (sec - t[0]) / step;
  }
  if (sec >= t[t.length - 1]) {
    const j = t.length - 1;
    const step = j > 0 ? t[j] - t[j - 1] : 1;
    return j + (sec - t[j]) / step;
  }
  // 二分找最后一个 t[i] <= sec
  let lo = 0;
  let hi = t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= sec) lo = mid;
    else hi = mid;
  }
  return lo + (sec - t[lo]) / (t[lo + 1] - t[lo]);
}

/** 谱面 tick → 音频绝对秒：谱面第 0 拍对应音频第 scoreOriginBeat 拍 */
export function tickToSec(map: TempoMap, tick: number): number {
  return beatToSec(map, map.scoreOriginBeat + tick / TICKS_PER_BEAT);
}

/** 音频绝对秒 → 谱面 tick（指示条反向查表；可为负 = 音频还在谱面起点之前） */
export function secToTick(map: TempoMap, sec: number): number {
  return (secToBeat(map, sec) - map.scoreOriginBeat) * TICKS_PER_BEAT;
}

// ── 锚点 → 变速曲线（M13 的数据通路，手工锚点校正的落点） ──────────

export interface Anchor {
  /** 谱面拍 */
  scoreBeat: number;
  /** 音频拍（标定格上的第几拍） */
  audioBeat: number;
}

/**
 * 由 ≥2 个锚点合成变速曲线：锚点之间谱面时间**分段线性**。
 *
 * 典型场景：前奏在音频里的长度和谱面记的不一样（简谱只记了主题一遍、
 * 音频里演奏了两遍）——单一原点不可能两段都对，两个锚点各钉一头，
 * 中间线性拉伸，段外的拍按所在段的节距外推。
 *
 * 曲线以**谱面拍**为索引（beatTimes[i] = 谱面第 i 拍的时刻，
 * scoreOriginBeat = 0），第 0 段的节距取两个锚点间实测节距，段外同样外推。
 * 音频拍 → 时刻用标定网格（phaseSec + 拍 × 60/bpm）。
 */
export function curveFromAnchors(
  anchors: Anchor[],
  opts: { bpm: number; phaseSec: number; totalBeats: number },
): TempoCurve {
  if (anchors.length < 2) throw new Error('变速曲线至少要 2 个锚点');
  const step = 60 / opts.bpm;
  const pts = [...anchors]
    .sort((a, b) => a.scoreBeat - b.scoreBeat)
    .map((a) => ({ b: a.scoreBeat, t: opts.phaseSec + a.audioBeat * step }));
  // 去重：同谱面拍的两个锚点保留后者（后钉的修正先钉的）
  const pts2 = pts.filter((p, i) => i === 0 || p.b !== pts[i - 1].b);
  if (pts2.length < 2) throw new Error('锚点谱面拍重合，无法成曲线');

  const timeAt = (b: number): number => {
    if (b <= pts2[0].b) {
      // 首锚之前：用首段节距外推
      const seg = pts2[1];
      const rate = (seg.t - pts2[0].t) / (seg.b - pts2[0].b);
      return pts2[0].t + (b - pts2[0].b) * rate;
    }
    if (b >= pts2[pts2.length - 1].b) {
      const j = pts2.length - 1;
      const rate = (pts2[j].t - pts2[j - 1].t) / (pts2[j].b - pts2[j - 1].b);
      return pts2[j].t + (b - pts2[j].b) * rate;
    }
    for (let i = 0; i < pts2.length - 1; i += 1) {
      if (b >= pts2[i].b && b <= pts2[i + 1].b) {
        return (
          pts2[i].t +
          ((b - pts2[i].b) * (pts2[i + 1].t - pts2[i].t)) / (pts2[i + 1].b - pts2[i].b)
        );
      }
    }
    return pts2[pts2.length - 1].t;
  };

  const n = Math.max(Math.ceil(opts.totalBeats), Math.ceil(pts2[pts2.length - 1].b)) + 1;
  const beatTimes: number[] = [];
  for (let i = 0; i <= n; i += 1) beatTimes.push(timeAt(i));
  for (let i = 1; i < beatTimes.length; i += 1) {
    if (!(beatTimes[i] > beatTimes[i - 1])) {
      throw new Error('锚点组合出非递增的时间轴（两个锚点钉反了？）');
    }
  }
  return { kind: 'curve', beatTimes, scoreOriginBeat: 0 };
}

// ── align.json（sidecar）读取 ────────────────────────────────

export interface AlignFile {
  version: number;
  audio: { file: string; durationSec: number; sampleRate?: number };
  tempo: { kind: string; bpm?: number; phaseSec?: number; scoreOriginBeat?: number; beatTimes?: number[] };
  anchors?: { scoreBeat: number; audioBeat: number; source: string }[];
  confidence?: { bpm?: number; gridResidualMs?: number; scoreOrigin?: number };
}

/**
 * 从 align.json 的 tempo 块构造 TempoMap。
 * 字段缺失 / 数值非法 → 抛错（带原因），调用方给用户看的提示从这里来。
 */
export function tempoFromAlign(align: AlignFile): TempoMap {
  const t = align.tempo;
  if (!t) throw new Error('align.json 缺少 tempo 块');
  if (t.kind === 'curve') {
    const bt = t.beatTimes;
    if (!Array.isArray(bt) || bt.length < 2) throw new Error('curve 形式的 beatTimes 至少要 2 个点');
    for (let i = 1; i < bt.length; i += 1) {
      if (!(bt[i] > bt[i - 1])) throw new Error(`beatTimes 不是严格递增（下标 ${i}）`);
    }
    return { kind: 'curve', beatTimes: bt, scoreOriginBeat: t.scoreOriginBeat ?? 0 };
  }
  return constantTempo(t.bpm ?? NaN, t.phaseSec ?? NaN, t.scoreOriginBeat ?? 0);
}
