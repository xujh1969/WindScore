// 带进度与自动校验反馈的识别装配（适配层，不改动 dolce 代码）：
// ① 把长图识别的重计算逐步让出主线程，浏览器才有机会画进度条、也不会弹「页面无响应」；
// ② 每轮识别完立刻跑一次与右栏同口径的谱面校验，问题多就换一档二值化参数重识别，最多三轮取最优。
import { decodeToBinary } from '../dolce/omrkit/decode'
import { installBrowserOmr } from '../dolce/omrkit/browser'
import { paddleOcrBackend, setOcrYieldHook } from '../dolce/omrkit/paddleocr'
import { recognizeJianpu, type JianpuStage } from '../dolce/omr/jianpu'
import type { Binary, RecognizedScore } from '../dolce/omrkit/types'
import { correctParenSlurs } from './parenSlurs'
import { recognizedToJps } from '../convert/recognizedToJps'
import { diagnoseJps, type ScoreDiagnostic } from './scoreDiagnostics'

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

/** 最多重识别几轮（用户定：三轮仍不行就把结果交回人工修改）。 */
export const FEEDBACK_ROUNDS = 3
/** 问题数不超过这个就认为可以直接交付，不额外重识别（绝大多数谱一轮即结束）。 */
export const GOOD_ENOUGH_ISSUES = 12

/** 三档识别参数：只换 Sauvola 的 k（局部二值化对淡墨/底纹的敏感度），其余口径完全一致。 */
const ATTEMPTS = [
  { name: '标准', k: 0.2 },
  { name: '淡墨增强', k: 0.12 },
  { name: '去底纹', k: 0.32 },
] as const

export interface RecognizeProgress {
  label: string
  pct: number
  round: number
  rounds: number
  attempt: string
  issues?: number
  note?: string
}

export interface RecognizeResult {
  bin: Binary
  score: RecognizedScore
  text: string
  comments: string[]
  parenPairs: number
  diagnostic: ScoreDiagnostic
  /** 归入声部的谱行数：防止「校验错少但合奏谱被退回单声部」的假优化被选中 */
  voiced: number
  rounds: number
  attempt: string
}

/** 让出一个宏任务：setTimeout(0) 才会把控制权交回浏览器去绘制/响应输入，
 *  Promise.resolve() 这种微任务仍算同一个任务，压不住「页面无响应」弹窗。 */
const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * 全链路识别 + 自动校验反馈。
 * - 每个重计算步骤前回调一次 yieldNow（见 jianpu.ts），步骤之间让出主线程；
 * - 每轮结束用 diagnoseJps 统计问题数，超过 GOOD_ENOUGH_ISSUES 且还有轮次就换参数重来；
 * - 取「问题数最少、平手时拍数徽标更少」的一版返回，三轮都不达标也如实返回最优版。
 * - PDF 传入 preparedBin 时沿用已解码的逐页像素（尺寸/坐标口径固定），只跑一轮。
 */
export async function recognizeWithFeedback(
  bytes: Uint8Array,
  mime: string | undefined,
  onProgress: (p: RecognizeProgress) => void,
  preparedBin?: Binary,
  opts?: { instrumental?: boolean },
): Promise<RecognizeResult> {
  installBrowserOmr() // 懒装配浏览器运行时（ort wasm + 解码器），幂等
  const backend = paddleOcrBackend()
  const rounds = preparedBin ? 1 : FEEDBACK_ROUNDS
  const stepsPerRound = 60
  const totalSteps = stepsPerRound * rounds
  let step = 0
  let best: RecognizeResult | null = null
  let fallback: RecognizeResult | null = null
  let baselineVoiced = 0
  let usedRounds = 0
  // wasm 推理后的让出钩子：推理本身是同步长任务，只有宏任务才能切开（见 paddleocr.ts）。
  // 顺带每 8 批刷新一次进度文案，让耗时最长的文字识别环节也有可见反馈。
  let currentAdvance: ((label: string, extra?: Partial<RecognizeProgress>, stepped?: boolean) => void) | null = null
  let inferCalls = 0
  setOcrYieldHook(async () => {
    inferCalls++
    if (inferCalls % 8 === 0) currentAdvance?.(`正在识别文字（第 ${inferCalls} 批）`, {}, false)
    await yieldToBrowser()
  })

  for (let i = 0; i < rounds; i++) {
    const attempt = ATTEMPTS[i]!
    const round = i + 1
    usedRounds = round
    const lo = i * stepsPerRound, hi = (i + 1) * stepsPerRound - 1
    const advance = (label: string, extra: Partial<RecognizeProgress> = {}, stepped = true) => {
      if (stepped) step = Math.min(hi, Math.max(lo, step + 1))
      onProgress({
        label,
        pct: Math.min(99, Math.round((step / totalSteps) * 100)),
        round, rounds, attempt: attempt.name, ...extra,
      })
    }
    currentAdvance = advance

    advance(`解码图片 / 二值化（${attempt.name}）`)
    await yieldToBrowser()
    const bin = preparedBin && round === 1
      ? preparedBin
      : await decodeToBinary(bytes, mime, { binarizeK: attempt.k })
    if (!bin.data.some((v) => v !== 0)) throw new Error('图片中没有可识别的内容，请检查 PDF 预览或上传清晰的简谱图片')
    await yieldToBrowser()

    const score = await recognizeJianpu(bin, backend, {
      instrumental: opts?.instrumental,
      trace: (stage) => advance(STAGE_LABEL[stage] ?? stage),
      yieldNow: async (label) => {
        advance(label)
        await yieldToBrowser()
      },
    })
    if (!score.rows.some((row) => row.nums.length > 0)) throw new Error('未识别到简谱音符，请确认原图为清晰的数字简谱')

    advance('组装 jps 文本')
    await yieldToBrowser()
    const parenPairs = correctParenSlurs(score, bin)
    const conv = recognizedToJps(score)
    advance('校验谱面（每小节拍数 / 拍内组 / 反复）')
    await yieldToBrowser()
    const diagnostic = diagnoseJps(conv.text)
    const voiced = score.rows.filter((r) => r.voice !== undefined).length
    if (round === 1) baselineVoiced = voiced
    const result: RecognizeResult = {
      bin, score, text: conv.text, comments: conv.comments, parenPairs,
      diagnostic, voiced, rounds, attempt: attempt.name,
    }
    // 实测教训：二值化偏淡墨的一档能把校验错从 24 压到 1，代价是合奏谱被退回单声部
    // （连谱号检测失效）。校验错少不等于谱面更好，首轮确实识别出合奏结构（≥4 行归声部）
    // 时，后续轮次丢掉八成以上声部行的一律弃用。阈值 4：连谱号残迹偶尔误归出 1~2 行
    // 「假声部」，那种小误差不该反过来把真单声部结果挡在门外（单声部谱的对称盲区）。
    const lostVoices = baselineVoiced >= 4 && voiced < baselineVoiced * 0.8
    if (round === 1) fallback = result
    // 解析失败（歌词/记号语法错）只报 1 条问题，绝不能因为「数字小」被当成最佳版
    const viable = !diagnostic.parseFailed && !lostVoices
    const better = viable && (
      !best || best.diagnostic.parseFailed || diagnostic.issues < best.diagnostic.issues
      || (diagnostic.issues === best.diagnostic.issues && diagnostic.badges < best.diagnostic.badges)
    )
    if (better) best = result
    advance(`校验完成：${diagnostic.issues} 处问题`, {
      issues: diagnostic.issues,
      note: diagnostic.parseFailed ? '谱面解析失败，弃用本轮'
        : lostVoices ? '声部结构丢失，弃用本轮'
        : better ? '目前最优' : '保留上一轮结果',
    })
    await yieldToBrowser()
    if (diagnostic.issues <= GOOD_ENOUGH_ISSUES) break
    if (round < rounds) {
      advance(`准备第 ${round + 1}/${rounds} 轮：按校验反馈调整二值化`)
      await yieldToBrowser()
    }
  }

  // 三轮都解析失败也如实交回首轮产物，让用户自己改（不假装成功）
  if (!best) best = fallback
  if (!best) throw new Error('识别没有产出结果')
  best.rounds = usedRounds
  setOcrYieldHook(null)
  currentAdvance = null
  onProgress({
    label: '识别完成', pct: 100, round: usedRounds, rounds,
    attempt: best.attempt, issues: best.diagnostic.issues,
  })
  return best
}
