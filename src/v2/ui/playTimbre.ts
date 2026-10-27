/**
 * 播放界面的合成音音色覆盖（只影响播放，不改谱面文件）。
 *
 * **按声部覆盖**（0.3.5 起，整谱音色取消——它和第一声部语义重叠，容易造成
 * 「到底谁说了算」的困惑）：每个声部可选音色（GM 号）与音色八度（±1）。
 * 「跟随谱面」= 不覆盖，按声部在谱面里的设置（@patch / @patchOct，缺省跟曲目）。
 *
 * 持久化：按曲名记在 localStorage（ws-play-timbre），下次播同一首还是这套；
 * 曲名在曲库里本来就唯一。清缓存会丢——可接受，这是播放偏好不是作品数据。
 * 0.3.4 的旧格式（meta + 数字 parts）读入时自动归一成新格式。
 */
import { assembleParts, scoreParts } from '../parts';
import type { Score } from '../types';

export interface PlayTimbrePart {
  /** 音色覆盖（GM 号）：不写 = 跟随谱面 */
  patch?: number;
  /** 音色八度覆盖：1 = 升 8，-1 = 降 8（只挪发声不动记谱） */
  octave?: number;
}

export interface PlayTimbre {
  /** 声部覆盖：partId → 音色 / 八度 */
  parts?: Record<string, PlayTimbrePart>;
}

const KEY = 'ws-play-timbre';

/** 归一一条覆盖：丢弃非法字段，兼容 0.3.4 的数字音色写法 */
function normalizePart(x: unknown): PlayTimbrePart | null {
  if (typeof x === 'number') return x >= 0 && x <= 127 ? { patch: x } : null;
  if (!x || typeof x !== 'object') return null;
  const o = x as PlayTimbrePart;
  const out: PlayTimbrePart = {};
  if (typeof o.patch === 'number' && o.patch >= 0 && o.patch <= 255) out.patch = o.patch;
  if (o.octave === 1 || o.octave === -1) out.octave = o.octave;
  return out.patch !== undefined || out.octave !== undefined ? out : null;
}

export function readTimbreMap(): Record<string, PlayTimbre> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, PlayTimbre> = {};
    for (const [name, value] of Object.entries(raw)) {
      const t = value as { parts?: Record<string, unknown> };
      const parts: Record<string, PlayTimbrePart> = {};
      for (const [id, v] of Object.entries(t?.parts ?? {})) {
        const p = normalizePart(v);
        if (p) parts[id] = p;
      }
      if (Object.keys(parts).length) out[name] = { parts };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeTimbre(name: string, timbre: PlayTimbre | null): void {
  const map = readTimbreMap();
  if (timbre) map[name] = timbre;
  else delete map[name];
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* 配额满 / 隐私模式：本次会话内仍生效 */
  }
}

/** 把覆盖应用到谱面上（喂给 buildTimeline 的那一份）；没有覆盖就原样返回。
 *  覆盖值统一过 normalizePart：0.3.4 旧格式（数字音色）在内存里也能直接用。 */
export function applyTimbre(score: Score, timbre?: PlayTimbre): Score {
  const overrides = timbre?.parts ?? {};
  const parts = scoreParts(score);
  if (!parts.some((p) => overrides[p.id] !== undefined)) return score;
  return assembleParts(
    score,
    parts.map((p) => {
      const o = normalizePart(overrides[p.id]);
      if (!o) return p;
      const next = { ...p };
      if (o.patch !== undefined) next.patch = o.patch;
      if (o.octave !== undefined) next.patchOctave = o.octave;
      return next;
    }),
  );
}
