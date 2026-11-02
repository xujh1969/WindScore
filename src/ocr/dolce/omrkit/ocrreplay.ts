// OCR 录放：给回归/测试用，让识别管线在**不加载模型**的情况下逐次重放，结果确定、秒级。
//
// 包在任何 `OcrBackend` 外面：录制模式把每次调用的结果按键记进表，回放模式先查表、查不到才转给内层后端
// （内层可以是 `nullOcr` 一类的占位——那样未命中就当失败计数，见 `misses`）。
//
// ## 键
// 一份表只对应**一张二值图**（同一首歌、同一套解码/二值化），所以按 bbox 取格的调用（数字、页眉区、整片检测）
// 只拿**矩形本身**作键：图不变，同一矩形送进去的像素就不变。按表面送的调用（歌词条、候选字）表面是管线拼出来的，
// 用 `contentKey` 对表面像素取指纹（与位图五线谱离线缓存同一套指纹）。
// 一个调用里的多个矩形/表面**逐个**记键：几何改了只让变了的那几格失配，不连坐整批。
// 数字格送模型时各格自带零填充、互不相干，逐格重放与成批现跑一致（批大小不同只有浮点末位的差别）。
import { contentKey } from "./contentkey";
import type { OcrBackend } from "./ocr";
import type { Binary, Rect } from "./types";
import type { Surface } from "./surface";

/** 录放表：键 → 该格/该条的结果（JSON 可序列化）。 */
export type OcrTape = Record<string, unknown>;

export interface OcrReplay {
  backend: OcrBackend;
  /** 录下的（录制模式）或用到的（回放模式）全部条目。回放模式下拿它剪掉过期的条目。 */
  tape: OcrTape;
  /** 回放未命中的键（落到内层后端现跑）。 */
  misses: string[];
}

const rk = (r: Rect) => `${r.x},${r.y},${r.w},${r.h}`;
const sk = (p: string, s: Surface) => contentKey(p, s.width, s.height, s.data);

/**
 * `mode`：`record` 全部现跑并记表；`replay` 先查 `tape`，未命中的现跑（记进 `misses`，结果也补进表）。
 * `inner` 未实现的可选方法，包出来的后端也不实现（管线据此跳过对应步骤，与直接用内层一致）。
 */
export function ocrReplay(inner: OcrBackend, mode: "record" | "replay", tape: OcrTape = {}): OcrReplay {
  const used: OcrTape = {};
  const misses: string[] = [];
  const hit = (k: string): boolean => mode === "replay" && k in tape;

  /** 逐项查表、把没查到的一次转给内层（保持内层的成批调用），再按原序拼回。 */
  async function each<I, R>(items: I[], keyOf: (it: I) => string, run: (todo: I[]) => Promise<R[]>): Promise<R[]> {
    const keys = items.map(keyOf);
    const todo: number[] = [];
    keys.forEach((k, i) => { if (!hit(k)) todo.push(i); });
    const fresh = todo.length ? await run(todo.map((i) => items[i]!)) : [];
    const out: R[] = [];
    let j = 0;
    // 表里存、往外给的都是拷贝：管线会就地改 OCR 结果（页眉框的 text 改成简体之类），共用一个对象的话，
    // 录进表的是改过的值，回放时拿到改过的值就少走一步，与现跑分叉
    keys.forEach((k, i) => {
      if (todo[j] === i) {
        const v = fresh[j++] as R;
        if (mode === "replay") misses.push(k);
        used[k] = structuredClone(v);
        out.push(v);
      } else {
        used[k] = tape[k];
        out.push(structuredClone(tape[k]) as R);
      }
    });
    return out;
  }

  const b: OcrBackend = {
    recognizeDigits: (bin: Binary, rects: Rect[], opts?: { rhythm?: boolean }) =>
      each(rects, (r) => `D${opts?.rhythm ? "r" : ""}:${rk(r)}`, (t) => inner.recognizeDigits(bin, t, opts)),
  };
  if (inner.recognizeNumerals) {
    const f = inner.recognizeNumerals.bind(inner);
    // JSON 存不了 undefined：记成 null，取回时还原
    b.recognizeNumerals = async (bin, rects) =>
      (await each(rects, (r) => `N:${rk(r)}`, async (t) => (await f(bin, t)).map((v) => v ?? null))).map((v) => v ?? undefined);
  }
  if (inner.rankDigits) {
    const f = inner.rankDigits.bind(inner);
    b.rankDigits = (bin, rects) => each(rects, (r) => `R:${rk(r)}`, (t) => f(bin, t));
  }
  if (inner.recognizeTexts) {
    const f = inner.recognizeTexts.bind(inner);
    b.recognizeTexts = (strips) => each(strips, (s) => sk("T", s), f);
  }
  if (inner.recognizeTextsPos) {
    const f = inner.recognizeTextsPos.bind(inner);
    b.recognizeTextsPos = (strips) => each(strips, (s) => sk("P", s), f);
  }
  if (inner.rankTextChars) {
    const f = inner.rankTextChars.bind(inner);
    b.rankTextChars = (strips, k = 5) => each(strips, (s) => sk(`C${k}`, s), (t) => f(t, k));
  }
  if (inner.detectTexts) {
    const f = inner.detectTexts.bind(inner);
    b.detectTexts = async (bin, region, opts) =>
      (await each([region], (r) => `E${opts?.scale ?? 1}:${rk(r)}`, async ([r]) => [await f(bin, r!, opts)]))[0]!;
  }
  if (inner.recognizeRegion) {
    const f = inner.recognizeRegion.bind(inner);
    b.recognizeRegion = async (bin, region) =>
      (await each([region], (r) => `G:${rk(r)}`, async ([r]) => [await f(bin, r!)]))[0]!;
  }
  return { backend: b, tape: used, misses };
}
