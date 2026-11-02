// 定位映射工具（D2）：源图坐标 ↔ jps 文本偏移 双向查找。
// 数据来自 recognizedToJps 输出的 locator（每音符一条：bbox + jps token 区间）。
import type { LocatorEntry } from './recognizedToJps'
import type { Rect } from '../dolce/omrkit/types'

/** 图上点 (x,y) → 命中的音符条目（含点则直接命中；否则取中心最近且在容差内）。 */
export function boxAtPoint(list: LocatorEntry[], x: number, y: number): LocatorEntry | null {
  if (!list.length) return null
  let best: LocatorEntry | null = null
  let bestD = Infinity
  for (const e of list) {
    const b = e.bbox
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return e
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    const d = (cx - x) ** 2 + (cy - y) ** 2
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  // 容差：中心距离不超过最大框对角线的 1.2 倍（点在音符附近的空白也定位到最近音）
  const maxDiag = Math.max(...list.map((e) => Math.hypot(e.bbox.w, e.bbox.h)))
  return bestD <= (maxDiag * 1.2) ** 2 ? best : null
}

/** jps 偏移 → 音符条目（token 区间内直接命中；否则取 start 最近）。 */
export function boxAtOffset(list: LocatorEntry[], offset: number): LocatorEntry | null {
  if (!list.length) return null
  let best: LocatorEntry | null = null
  let bestD = Infinity
  for (const e of list) {
    if (offset >= e.start && offset < e.end) return e
    const d = Math.abs(e.start - offset)
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  // 光标离任何音符 token 都远（谱头/注释区）→ 不定位
  return bestD <= 2 ? best : null
}

export type { Rect }
