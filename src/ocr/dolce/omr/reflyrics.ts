// [ScoreOCR] dolce 原版 reflyrics.ts 的 no-op 桩。
// 原文件依赖 omr/todoc.ts → dolce model/jianpu/layout 大链条（词谱互证要按演唱顺序展开
// ScoreDoc），本实验场不需要「--lyrics 参照歌词互证」功能，故用空实现保住 jianpu.ts
// 原文不被修改。若将来要启用词谱互证，需恢复原版及其依赖链（见 docs/omr-dependency-inventory.md §3）。
import type { LyricCheck, RecognizedScore } from "../omrkit/types";
import type { LyricHooks } from "./lyrics";

export async function applyRefLyrics(
  _score: RecognizedScore,
  _refText: string,
  _hooks: LyricHooks,
): Promise<LyricCheck> {
  return { order: "printed", refChars: 0, ocrChars: 0, matched: 0, items: [], unmatchedRef: [] };
}
