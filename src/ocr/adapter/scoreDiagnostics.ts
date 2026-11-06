/**
 * 识别产物的「谱面校验」快照（纯函数，不开画布、不依赖 DOM）。
 * issues 与右栏编辑器顶栏「谱面校验 N 处问题」同口径：
 *   源码解析错误 + validateGroups(拍内组/结构) + expandScore(反复/多声部小节对齐)。
 * badges 是排版层的小节拍数徽标（⚠/✗），不进顶栏计数，只用于两轮打平时挑更好的一版。
 */
import { parseDsl } from '../../v2/dsl'
import { validateGroups } from '../../v2/validate'
import { expandScore } from '../../v2/expand'
import { layoutScore } from '../../v2/layout'

export interface ScoreDiagnostic {
  /** 顶栏口径的问题数 */
  issues: number
  /** 排版层小节拍数徽标数（含 ⚠ 与 ✗） */
  badges: number
  badgeErrors: number
  parseErrors: number
  groups: number
  repeats: number
  /** parseDsl 连谱面对象都没产出来（歌词/记号语法错误）——这种结果再「干净」也不能要 */
  parseFailed: boolean
  /** 前若干条原文，供进度条/备注展示 */
  messages: string[]
}

export function diagnoseJps(text: string): ScoreDiagnostic {
  const parsed = parseDsl(text)
  const score = parsed.score
  const parseFailed = !score
  const messages: string[] = [...parsed.errors]
  if (parseFailed) messages.unshift('谱面无法解析（歌词或记号语法错误）')
  let groups = 0, repeats = 0, badges = 0, badgeErrors = 0
  if (score) {
    const violations = validateGroups(score)
    groups = violations.length
    messages.push(...violations.map((v) => v.message))
    const expansion = expandScore(score)
    repeats = expansion.errors.length + expansion.warnings.length
    messages.push(...expansion.errors, ...expansion.warnings)
    try {
      const lines = layoutScore(score, { contentWidth: 1200, justifyMax: 1 }).lines
      const bs = lines.flatMap((l) => l.badges)
      badges = bs.length
      badgeErrors = bs.filter((b) => b.level === 'error').length
    } catch {
      // 极端产物排版失败不阻断识别结果，只是这一版不参与徽标比较
    }
  }
  return {
    // 解析失败只报 1 条语法错，若按「问题少」选优会被误当成最佳版；给一个压倒性惩罚
    issues: parsed.errors.length + groups + repeats + (parseFailed ? 1000 : 0),
    parseFailed,
    badges,
    badgeErrors,
    parseErrors: parsed.errors.length,
    groups,
    repeats,
    messages: messages.slice(0, 20),
  }
}
