// 带进度回调的识别装配（适配层，不改动 dolce 代码）：
// 用 dolce 公开的 decodeToBinary + recognizeJianpu + trace 阶段回调包装出人机友好的进度。
import { decodeToBinary } from '../dolce/omrkit/decode'
import { installBrowserOmr } from '../dolce/omrkit/browser'
import { paddleOcrBackend } from '../dolce/omrkit/paddleocr'
import { recognizeJianpu, type JianpuStage } from '../dolce/omr/jianpu'
import type { Binary, RecognizedScore } from '../dolce/omrkit/types'

/** 识别阶段 → 用户可读文案（按管线实际顺序）。 */
export const STAGE_LABEL: Record<JianpuStage | 'decode' | 'convert', string> = {
  decode: '解码图片 / 二值化',
  comps: '分析图像连通块',
  classified: '识别符号形状',
  cores: '定位音符',
  rows: '划分谱行',
  repeats: '分析反复与跳房子',
  slurs: '识别连线',
  header: '识别页眉（调 / 拍 / 速）',
  lyrics: '识别歌词并对位',
  convert: '组装 jps',
}

export const STAGE_ORDER: Array<JianpuStage | 'decode' | 'convert'> = [
  'decode', 'comps', 'classified', 'cores', 'rows', 'repeats', 'slurs', 'header', 'lyrics', 'convert',
]

export interface ProgressDetail {
  bin: Binary
  score: RecognizedScore
}

/**
 * 全链路识别（带进度）：decode → 管线 8 阶段（trace 回调）。
 * 管线各阶段间有 OCR 异步等待，onStage 的更新能及时绘制到界面。
 */
export async function recognizeWithProgress(
  bytes: Uint8Array,
  mime: string | undefined,
  onStage: (stage: JianpuStage | 'decode' | 'convert') => void,
): Promise<ProgressDetail> {
  installBrowserOmr() // 懒装配浏览器运行时（ort wasm + 解码器），幂等
  onStage('decode')
  const bin = await decodeToBinary(bytes, mime)
  // 让浏览器有机会把「解码中」画出来再进入重计算
  await new Promise((r) => setTimeout(r, 30))
  const score = await recognizeJianpu(bin, paddleOcrBackend(), {
    trace: (stage) => onStage(stage),
  })
  onStage('convert')
  return { bin, score }
}
