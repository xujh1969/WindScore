// [ScoreOCR] dolce omr 公共入口的裁剪版。
// 副作用：装配浏览器运行时（ort-web）与解码器（`omrkit/browser.ts`）。Node 不走这个入口，自己 setOmrRuntime(nodeRuntime)。
// 原版对 todoc/meta/emit/overlay/fanqie 的 re-export 已裁剪（这些模块不搬，见 docs/omr-dependency-inventory.md §3）。
import { installBrowserOmr } from "../omrkit/browser";
installBrowserOmr();

export * from "../omrkit/types";
export { rgbaToBinary, toGray } from "../omrkit/preprocess";
export { connectedComponents } from "../omrkit/ccl";
export { recognizeJianpu } from "./jianpu";
export type { OcrBackend } from "../omrkit/ocr";
export { nullOcr } from "../omrkit/ocr";
export { decodeToBinary } from "../omrkit/decode";
export { paddleOcrBackend } from "../omrkit/paddleocr";
export { recognizeMusicppDetailed } from "./recognize";
export type { MusicppDetail } from "./recognize";
export { buildStrip } from "./lyrics";
export { createSurface, surfaceFromBinary, blit } from "../omrkit/surface";
export type { Surface } from "../omrkit/surface";

export { setOmrRuntime } from "../omrkit/runtime";
export type { OmrRuntime } from "../omrkit/runtime";
