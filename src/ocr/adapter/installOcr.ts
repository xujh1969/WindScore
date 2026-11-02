// [ScoreOCR] dolce 识别管线的浏览器装配入口。
// vendored 的 src/dolce/omr/index.ts import 时自带 installBrowserOmr() 副作用
// （onnxruntime-web wasm + 图片/PDF 解码器），这里统一收口并补充资源说明。
// 模型：public/redist/ocr/（det 4.6MB + rec 20.7MB + 字典）
// pdf.js wasm：public/redist/pdfjs/（jbig2/openjpeg 等）
// 进度版识别见 ./recognizeProgress.ts（D 阶段起的正式入口）。
export {
  recognizeMusicppDetailed,
  type MusicppDetail,
  type RecognizedScore,
} from '../dolce/omr'
export type { Binary } from '../dolce/omrkit/types'
