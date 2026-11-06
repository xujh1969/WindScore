// RecognizedScore → WindScore jps DSL 转换器（B3）。
//
// 输入：dolce 识别管线产物（src/dolce/omrkit/types.ts 的 RecognizedScore）。
// 输出：jps 文本 + 注释清单（DSL 装不下的识别信息）+ 定位映射（图↔文双向联动用）。
//
// 时值写法与 WindScore dsl.ts 的 modern 形式一致：八度点(^/v) → 变音(#/b) → 音级 →
// 附点(.) → 减时线(/，modern 每道一条) → 增时线(-)。休止 0 / 节奏音符 X(digit 9)。
import { RHYTHM_DIGIT } from '../dolce/omrkit/types'
import type { JpNum, RecognizedScore, Rect, StaffRow } from '../dolce/omrkit/types'

export interface LocatorEntry {
  row: number // 原识别结果谱行下标
  note: number // 该行 nums 下标
  bbox: Rect // 源图框
  start: number // jps 文本中 token 起始偏移
  end: number
  /** dolce 复核标记（doubt/lyricDoubt 非空）→ 校对视图标黄 */
  suspect?: boolean
}

export interface ConvertResult {
  text: string
  comments: string[]
  locator: LocatorEntry[]
}

export interface ConvertOptions {
  title?: string
}

// fifths → 大调调名（0=C, 1=G, …；负数走降号）
const FIFTHS_MAJOR: Record<number, string> = {
  0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#',
  [-1]: 'F', [-2]: 'Bb', [-3]: 'Eb', [-4]: 'Ab', [-5]: 'Db', [-6]: 'Gb', [-7]: 'Cb',
}

const ACC_MARK: Record<string, string> = { sharp: '#', flat: 'b', natural: '♮' }
const ORNAMENT_MARK: Record<string, string> = { 'upper-mordent': 'm', 'lower-mordent': 'w' }
const ARTIC_MARK: Record<string, string> = { staccato: '!', accent: '>' }
// dolce 跳转文字 → jps 跳转记号（$s/$x/$t/$f/$ds/$dc）
const JUMP_MARK: Array<{ re: RegExp; tok: string }> = [
  { re: /D\.?C\.?/i, tok: '$dc' },
  { re: /D\.?S\.?/i, tok: '$ds' },
  { re: /Fine/i, tok: '$f' },
  { re: /To\s*Coda/i, tok: '$t' },
  { re: /Coda/i, tok: '$x' },
]
// 复纵线（‖）并排两根的判定容差（px）
const BARLINE_PROXIMITY_PX = 4

function octaveMarks(octave: number): string {
  return octave > 0 ? '^'.repeat(octave) : 'v'.repeat(-octave)
}

/** 从 token 里剥掉一个括号：'(' 取第一个、')' 取最后一个（右结合闭合）。 */
function dropParen(tok: string, ch: string): string {
  const idx = ch === '(' ? tok.indexOf(ch) : tok.lastIndexOf(ch)
  return idx < 0 ? tok : tok.slice(0, idx) + tok.slice(idx + 1)
}

/** 转换一个音符（含 slur 括号与 tuplet 收尾；tuplet 开括号由行组装层贴在 token 前）。 */
function noteToken(n: JpNum, inTupletBare: boolean, closeTuplet = false): string {
  const parts: string[] = []
  // 单音连线抵消：同一音同时是连线的起点和终点（识别噪声），抵消后为零则整个丢弃
  let slurStartN = n.slurStart ?? 0
  let slurStopN = n.slurStop ?? 0
  if (slurStartN && slurStopN) {
    const cancel = Math.min(slurStartN, slurStopN)
    slurStartN -= cancel
    slurStopN -= cancel
  }
  // 嵌套连线（双重弧线）WindScore 已支持：空外层闭合时镜像内层边链（dsl.ts closeSlur）。
  // 这里按识别结果原样输出 (( / ))，由预检器按同口径校验剥噪。
  if (slurStartN) parts.push('('.repeat(slurStartN))
  if (n.grace?.length) {
    // 倚音：jps 语法 {65}，只有 变音+音级+八度点（无时值）
    parts.push(`{${n.grace.map((g) => `${g.digit}${octaveMarks(g.octave)}`).join('')}}`)
  }
  const body =
    (n.accidental ? ACC_MARK[n.accidental] ?? '' : '') +
    (n.digit === RHYTHM_DIGIT ? 'X' : n.digit === 0 ? '0' : String(n.digit)) +
    octaveMarks(n.octave)
  let dur = ''
  if (!inTupletBare) {
    // jps 语法上限：附点最多 2（RE .{0,2}）、减时线最多 3 道（normalizeModern /8）。
    // dolce 偶尔给出三附点，截断 + 注释提醒。
    dur = '.'.repeat(Math.min(n.dot, 2)) + '/'.repeat(Math.min(n.div, 3))
  }
  const aug = '-'.repeat(n.augment)
  const tie = n.tieStart ? '~' : ''
  const arts = (n.articulation ? ARTIC_MARK[n.articulation] ?? '' : '') +
    (n.fermata ? '@' : '') +
    (n.fall ? 'x' : '') +
    (n.ornament ? ORNAMENT_MARK[n.ornament] ?? '' : '')
  parts.push(`${body}${dur}${aug}${tie}${arts}`)
  if (closeTuplet) parts.push('>')
  if (slurStopN) parts.push(')'.repeat(slurStopN))
  return parts.join('')
}

/** dolce 房号原文（"1,2,3,5"）→ jps 房号 token（[1,2,3,5]）。 */
function voltaToken(text: string): string | null {
  const nums = text.split(/[,，\s]+/).map((s) => parseInt(s, 10)).filter((v) => Number.isInteger(v))
  return nums.length ? `[${nums.join(',')}]` : null
}

interface Segment {
  notes: JpNum[]
  leadX: number // 本段左边界 x（小字谱按 x 锚定主谱小节时用）
  tailX: number // 本段右边界 x（下一根小节线）；末段 tailX = 行末线
  isLast: boolean
}

/** 中位数（无样本返回 0）。 */
function medOf(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)]! : 0
}

/**
 * 一行 → 小节段。dolce 的 barlineXs 是**检测到的真实竖线**，行首/行末不一定有——
 * 音符落在第一道线左侧时补虚拟左边界，落在最后一道线右侧时补虚拟右边界（不丢数据）。
 *
 * 复纵线（终止线 ‖、双细线 ||、反复 :|/|: 的两根竖线）在 barlineXs 里是**两根各占
 * 一个 x**（dolce 把右根另记入 doubleBarXs/endBarXs，两源同值）。不合并就会在两根
 * 线之间切出一个空小节（`| |`、行尾 `||` 后再补虚拟边界成 `| | |`）。复纵线双线
 * 间距实测 ≤0.36×谱高（真机 22 图 57 对），真实小节宽 ≥3×谱高——按「间距 < 半个
 * 谱高」合并成一根，保留右 x（与 doubleBarXs/endBarXs 的取法一致）。
 */
function segmentsOf(row: StaffRow, comments: string[], rowLabel: string): Segment[] {
  const xs = [...row.barlineXs].sort((a, b) => a - b)
  const mergeDist = Math.max(10, (row.bottomY - row.topY) * 0.5)
  const merged: number[] = []
  for (const x of xs) {
    const last = merged[merged.length - 1]
    if (last !== undefined && x - last < mergeDist) merged[merged.length - 1] = x
    else merged.push(x)
  }
  const notes = [...row.nums].sort((a, b) => a.bbox.x - b.bbox.x)
  if (notes.length && merged.length) {
    if (notes[0]!.bbox.x < merged[0]!) merged.unshift(notes[0]!.bbox.x - 0.5)
    if (notes[notes.length - 1]!.bbox.x > merged[merged.length - 1]!) {
      merged.push(notes[notes.length - 1]!.bbox.x + 0.5)
      comments.push(`[识别] ${rowLabel}：有音符落在最后一道小节线右侧，按末小节收编`)
    }
  }
  const out: Segment[] = []
  for (let i = 0; i < merged.length - 1; i++) {
    const lead = merged[i]!
    const tail = merged[i + 1]!
    const notesIn = notes.filter((n) => n.bbox.x > lead && n.bbox.x < tail)
    if (!notesIn.length) {
      // 空段＝复纵线/反复线的其余几根线（或行尾杂线）：不是真小节。
      // 丢弃并把右边界外扩给前一段（tailTok 的样式判定用最外侧线的 x，
      // 与 doubleBarXs/endBarXs「取右根」的口径一致）；行首空段直接跳过。
      if (out.length) out[out.length - 1]!.tailX = tail
      continue
    }
    out.push({ notes: notesIn, leadX: lead, tailX: tail, isLast: false })
  }
  if (out.length) out[out.length - 1]!.isLast = true
  return out
}

interface RowWithIdx {
  row: StaffRow
  idx: number // rec.rows 的原始下标（locator 与注释里的「谱行 N」都用它）
}

/** 谱行集合 → 正文行数组（不含歌词与注释）。同时产出 locator 与注释。
 *  marks：缺席谱行的补齐——restBefore 按行序号在本行**之前**插入补齐行（每行一根
 *  `0*N` 多小节休止，独占一行、不跨行：总谱排版里多小节休止横线跨系统会画成
 *  贯穿长条）；restTail 在全部行之后追加（曲尾缺席段）。 */
function renderRows(
  rows: RowWithIdx[],
  beats: number,
  emit: { text: string[]; comments: string[]; locator: LocatorEntry[]; offset: () => number },
  marks?: { restBefore?: Map<number, string[]>; restTail?: string[] },
): void {
  const lastRowIdx = rows.length - 1
  for (let ri = 0; ri < rows.length; ri++) {
    const { row, idx: rowIdx } = rows[ri]!
    const rowLabel = `谱行 ${rowIdx + 1}`
    if (row.lyricLabels?.length) {
      emit.comments.push(`[识别] 歌词段号 ${row.lyricLabels.join('/')}（${rowLabel}，jps 未承载）`)
    }
    // 本行之前的缺席补齐行（该声部在这几条谱行缺席）
    for (const t of marks?.restBefore?.get(ri) ?? []) emit.text.push(t)
    const segs = segmentsOf(row, emit.comments, rowLabel)
    const lineParts: string[] = []
    let lineOffset = 0 // 相对 jps 全文的偏移基（由 emit.offset() 提供）

    // 连线预检器（与 WindScore 解析同口径：只有音符计成员、只喂栈顶）。
    // 行组装完成后统一模拟：多余的 ")"、成员 <2 的连线自动剥除；
    // 行末未闭合：≥2 补 ")"，<2 接到下一行（贴到下一个音符 token 前）。
    // 修正后统一重算 locator 偏移（剥括号会改变 token 长度）。
    const noteFlags: boolean[] = [] // 与 lineParts 对齐：是否音符 token（WindScore 计数口径）
    const locQueue: Array<{ n: JpNum; ni: number }> = [] // 音符 token 对应的 locator 数据
    let pendingCarry = 0 // 上一行接续下来的悬空连线数（贴到本行第一个音符 token 前）
    const push = (tok: string, loc?: { n: JpNum; ni: number }): void => {
      if (lineParts.length) lineOffset += 1
      lineParts.push(tok)
      lineOffset += tok.length
      noteFlags.push(!!loc && loc.n.digit !== 0 && loc.n.digit !== RHYTHM_DIGIT)
      if (loc) locQueue.push(loc)
      if (loc && pendingCarry > 0) {
        lineParts[lineParts.length - 1] = '('.repeat(pendingCarry) + lineParts[lineParts.length - 1]!
        lineOffset += pendingCarry
        pendingCarry = 0
      }
    }

    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si]!
      // ── 左边界小节线（每段只在这里画一道；上一段末音的 repeatBackward
      //    决定这道线是不是 :| / :||:；末段的右线在音符后单独处理）──
      //    行首段（si=0）：边界是**上一行行末的那根线**（非末行行尾已发线+换行），
      //    本行不再发；全曲第一行才在这里发起始线。
      const first = seg.notes[0]
      const prevLast = si > 0 ? segs[si - 1]!.notes[segs[si - 1]!.notes.length - 1] : undefined
      const barTok =
        si > 0 ? (prevLast?.repeatBackward && first?.repeatForward ? ':||:'
          : prevLast?.repeatBackward ? ':|'
          : first?.repeatForward ? '|:'
          : '|')
        : ri === 0 ? (first?.repeatForward ? '|:' : '|')
        : null // 跨行边界由上一行行尾承担
      if (barTok !== null) push(barTok)
      if (first?.endingStart) {
        const v = voltaToken(first.endingStart)
        if (v) push(v)
      }
      if (first?.timeChange) push(`拍${first.timeChange.beats}/${first.timeChange.beatType}`)

      // ── 音符 ──
      // 本段连音成员总数：括线标号要求成员数恰等 actual，跨小节截断的连音
      // （段内成员 < actual）没法出括线，改用各自减时线近似 + 注释提醒
      const tupletActual = seg.notes.find((n) => n.tuplet)?.tuplet?.actual
      const tupletMemberCount = tupletActual
        ? seg.notes.filter((n) => n.tuplet).length
        : 0
      const tupletTruncated = tupletActual !== undefined && tupletMemberCount < tupletActual
      let openTuplet = false
      for (let ni = 0; ni < seg.notes.length; ni++) {
        const n = seg.notes[ni]!
        // 前奏/过门括号（parenSlurs 校正标记）：独立的全角括号 token——
        // WindScore 里（ ）是字面括号记号（paren 指令），与半角 ( ) 连线意义不同
        if (n.parenBefore) push('（')
        if (!openTuplet && n.timeChange && ni > 0) {
          emit.comments.push(`[识别] 曲中转拍 ${n.timeChange.beats}/${n.timeChange.beatType}（${rowLabel}，锚在小节中间，未承载）`)
        }
        // tuplet 组：成员一律省写时值（括线标号定义成员时值，印刷减时线是视觉重复；
        // dolce 置 tuplet 时不清 div，带时值写回会爆「拍组时值超过 1 拍」）
        if (n.tuplet && tupletTruncated) {
          if (n.tuplet.start && !openTuplet) {
            emit.comments.push(`[识别] 连音 ${n.tuplet.actual} 连 ${tupletMemberCount} 音跨小节被截断，各音按印刷减时线近似记写，请人工核对时值（${rowLabel}）`)
          }
          push(noteToken({ ...n, tuplet: undefined }, false), { n, ni })
        } else if (n.tuplet) {
          if (n.tuplet.start && !openTuplet) {
            push(`<${n.tuplet.actual}:`)
            openTuplet = true
            push(noteToken({ ...n, tuplet: undefined }, true, !!n.tuplet.stop), { n, ni })
            if (n.tuplet.stop) openTuplet = false
          } else {
            const close = openTuplet && (n.tuplet.stop || ni === seg.notes.length - 1)
            push(noteToken({ ...n, tuplet: undefined }, true, close), { n, ni })
            if (close) {
              openTuplet = false
              if (!n.tuplet.stop) emit.comments.push(`[识别] 连音组跨小节被截断，按段末自动收口（${rowLabel}）`)
            }
          }
        } else {
          if (openTuplet) {
            push('>')
            openTuplet = false
            emit.comments.push(`[识别] 连音组内出现无连音标记的音符，按段末自动收口（${rowLabel}）`)
          }
          push(noteToken(n, false), { n, ni })
        }
        // 前奏括号收口：贴在本音 token 之后（「7v-- ）」形态）
        if (n.parenAfter) push('）')
        // 跳转记号（独立 token，跟在音符后）
        if (n.segno) push('$s')
        for (const jm of n.jumpMarks ?? []) {
          const tok = JUMP_MARK.find(({ re }) => re.test(jm))?.tok
          if (tok) push(tok)
          else emit.comments.push(`[识别] 跳转记号「${jm}」未映射（${rowLabel}）`)
        }
        // jps 装不下的识别信息
        const extras: string[] = []
        if (n.chord) extras.push(`和弦 ${n.chord}${n.chordOffset ? `（拍位 ${n.chordOffset}）` : ''}`)
        for (const c of n.extraChords ?? []) extras.push(`后续和弦 ${c.tok}（拍位 ${c.offset}）`)
        for (const d of n.dynamics ?? []) extras.push(`力度 ${d}`)
        if (n.sectionMark) extras.push(`段落标记 ${n.sectionMark}`)
        for (const e of extras) emit.comments.push(`[识别] ${e}（${rowLabel}）`)
      }
      if (openTuplet) {
        push('>')
        openTuplet = false
        emit.comments.push(`[识别] 连音组缺收尾，按段末自动收口（${rowLabel}）`)
      }

      // ── 右边界小节线（仅末段在此画；中间段的右线由下一段的左线承担）──
      //    每行行末都发：这根线同时是跨行边界。非末行在线后补 `换行`——
      //    WindScore 排版按宽度折行、不看源码行，换行记号强制按原谱行断行，
      //    预览的每行小节数才与原图一致。下一行不再发行首线（双线会挨着）。
      if (seg.isLast) {
        const last = seg.notes[seg.notes.length - 1]
        // 与下一行首音的反复记号合并（本行 :| + 下行 |: → 同一根线 :||:）
        const nextRowFirst = ri < lastRowIdx
          ? [...(rows[ri + 1]!.row.nums)].sort((a, b) => a.bbox.x - b.bbox.x)[0]
          : undefined
        const tailTok =
          last?.repeatBackward && nextRowFirst?.repeatForward ? ':||:'
          : last?.repeatBackward ? ':|'
          : row.finalBarline ? '||' // 终止线（细+粗）→ WindScore final
          : (row.doubleBarXs?.some((x) => Math.abs(x - seg.tailX) < BARLINE_PROXIMITY_PX) || row.endBarXs?.some((x) => Math.abs(x - seg.tailX) < BARLINE_PROXIMITY_PX)) ? '‖' // 双细线（乐段结束）
          : '|'
        push(tailTok)
        if (ri < lastRowIdx) push('换行')
        if (last?.endingStop && tailTok === '|') {
          emit.comments.push(`[识别] 房号「${last.endingStop}」的收口未落在反复线上（${rowLabel}）`)
        }
      }
    }

    // ── 连线预检（WindScore 同口径模拟 + 自动修正）──
    const simStack: Array<{ openTok: number; notes: number }> = []
    let fixed = false
    for (let i = 0; i < lineParts.length; i++) {
      const tok = lineParts[i]!
      const opens = (tok.match(/\(/g) ?? []).length
      const closes = (tok.match(/\)/g) ?? []).length
      for (let o = 0; o < opens; o++) simStack.push({ openTok: i, notes: 0 })
      if (noteFlags[i] && simStack.length) simStack[simStack.length - 1]!.notes++
      for (let c = 0; c < closes; c++) {
        const s = simStack.pop()
        if (!s) {
          lineParts[i] = dropParen(lineParts[i]!, ')')
          fixed = true
        } else if (s.notes < 2) {
          lineParts[i] = dropParen(lineParts[i]!, ')')
          lineParts[s.openTok] = dropParen(lineParts[s.openTok]!, '(')
          fixed = true
        } else {
          const outer = simStack[simStack.length - 1]
          // 嵌套镜像（WindScore dsl.ts closeSlur 同口径）：直接包住内层、
          // 一条音都没吃到的外层，闭合时镜像内层成员数（双重弧线合法）
          if (outer && outer.notes === 0) outer.notes = s.notes
        }
      }
    }
    const lastRow = ri === lastRowIdx
    // 行末未闭合：从最内层往外处理，嵌套外层（一条音没吃到）按 closeSlur 同口径镜像
    for (let k = simStack.length - 1; k >= 0; k--) {
      const s = simStack[k]!
      const outer = simStack[k - 1]
      if (s.notes >= 2) {
        if (outer && outer.notes === 0) outer.notes = s.notes // 镜像（WindScore closeSlur 同口径）
        lineParts.push(')')
        fixed = true
      } else if (lastRow) {
        lineParts[s.openTok] = dropParen(lineParts[s.openTok]!, '(')
        fixed = true
      } else {
        // 接到下一行：上一行的 "(" 必须剥掉（jps 全文括号要平衡），下一行重贴
        lineParts[s.openTok] = dropParen(lineParts[s.openTok]!, '(')
        pendingCarry++
        fixed = true
      }
    }
    // 延音线预检：~ 必须由同行下一个发声事件（音符）承接；行尾或下一发声事件是休止/X → 剥掉
    for (let i = 0; i < lineParts.length; i++) {
      const tok = lineParts[i]!
      if (!noteFlags[i] || !tok.includes('~')) continue
      let ok = false
      for (let j = i + 1; j < lineParts.length; j++) {
        if (noteFlags[j]) { ok = true; break }
        if (/^[0X8]/.test(lineParts[j]!)) break // 下一发声事件是休止/X：tie 无法成立
      }
      if (!ok) {
        lineParts[i] = dropParen(lineParts[i]!, '~')
        fixed = true
        emit.comments.push(`[识别] ${rowLabel}：延音线后无承接音符，已剥除，请人工核对`)
      }
    }
    if (fixed) emit.comments.push(`[识别] ${rowLabel}：连线/延音线有识别噪声，已自动校正，请人工核对`)

    // ── locator 偏移统一重算（修正可能改变 token 长度）──
    {
      let off = 0
      let qi = 0
      for (let i = 0; i < lineParts.length; i++) {
        const tok = lineParts[i]!
        if (noteFlags[i]) {
          const loc = locQueue[qi++]!
          const start = emit.offset() + off
          const suspect = (loc.n.doubt?.length ?? 0) > 0 || (loc.n.lyricDoubt?.length ?? 0) > 0
          emit.locator.push({ row: rowIdx, note: loc.ni, bbox: loc.n.bbox, start, end: start + tok.length, suspect })
        }
        off += tok.length + 1
      }
    }
    emit.text.push(lineParts.join(' '))
  }
  for (const t of marks?.restTail ?? []) emit.text.push(t)
  if (beats <= 0) emit.comments.push('[识别] 拍号缺失，按 4/4 处理') // 保守兜底提示
}

/** 歌词 token 与 v2/lyrics.ts 的 lyricRows 同口径转义：
 *  OCR 偶尔把杂符认成 `"` 或 `\`，裸写进歌词行会让 lyricTokens 的 JSON 双引号解析
 *  抛错，进而整份谱 parseDsl 失败（实测梁祝长图换二值化档后触发）。 */
const lyricToken = (t: string): string =>
  !t || t === '_' ? '_' : /[\s"\\]/.test(t) || t === '|' ? JSON.stringify(t) : t;

/** 歌词行：逐音符对位，无字补 _（延音占位）。休止与节奏音符 X 不占歌词位
 *  （WindScore 里 X 是 rest-kind，applyLyrics 只对 note 事件对位）。 */
function lyricLines(rows: StaffRow[]): string[] {
  let maxVerse = -1
  for (const r of rows) for (const n of r.nums) {
    for (let v = 0; v < (n.lyrics?.length ?? 0); v++) if (n.lyrics![v]) maxVerse = Math.max(maxVerse, v)
  }
  const out: string[] = []
  for (let v = 0; v <= maxVerse; v++) {
    const toks: string[] = []
    for (const r of rows) {
      for (const n of [...r.nums].sort((a, b) => a.bbox.x - b.bbox.x)) {
        if (n.digit === 0 || n.digit === RHYTHM_DIGIT) continue
        toks.push(lyricToken(n.lyrics?.[v] || '_'))
      }
    }
    if (toks.some((t) => t !== '_')) out.push(`歌词${v + 1}: ${toks.join(' ')}`)
  }
  return out
}

export function recognizedToJps(rec: RecognizedScore, opts: ConvertOptions = {}): ConvertResult {
  const comments: string[] = []
  const locator: LocatorEntry[] = []
  const textLines: string[] = []

  // ── 谱头 ──
  textLines.push('@format 3')
  textLines.push(`@title ${(opts.title ?? rec.title ?? '未命名').replace(/[\r\n]+/g, ' ')}`)
  if (rec.subtitle) textLines.push(`@sub ${rec.subtitle}`)
  const keyName = FIFTHS_MAJOR[rec.fifths] ?? 'C'
  if (FIFTHS_MAJOR[rec.fifths] === undefined) comments.push(`[识别] 调号 fifths=${rec.fifths} 超出范围，按 C 处理`)
  if (rec.minor) comments.push(`[识别] 原谱为小调，jps 按 ${keyName} 大调记写（音高不变）`)
  textLines.push(`@key 1=${keyName}`)
  // 备选拍号（交替拍子）：dolce 的 meters 数组（如 [{6,8},{9,8}]) join 竖线 → @beat 6/8|9/8
  // 语义=小节可以是任一段的拍数（不是相加）
  const meterStr = rec.meters?.length
    ? rec.meters.map((m) => `${m.beats}/${m.beatType}`).join('|')
    : `${rec.beats || 4}/${rec.beatType || 4}`
  textLines.push(`@beat ${meterStr}`)
  // 拍数守恒比较基准也换成混合拍总拍数（recognizedToJps 内部 beats 参数只用于缺失提示）
  const meter = { beats: rec.meters?.[0]?.beats ?? rec.beats ?? 4, beatType: rec.meters?.[0]?.beatType ?? rec.beatType ?? 4 }
  textLines.push(`@bpm ${rec.tempo ?? 96}`)

  // 页眉杂项 → 注释
  if (rec.number) comments.push(`[识别] 曲号 ${rec.number}`)
  for (const c of rec.credits ?? []) comments.push(`[识别] ${c}`)
  for (const c of rec.creditsTopLeft ?? []) comments.push(`[识别] 角标 ${c}`)
  for (const n of rec.headerNotes ?? []) comments.push(`[识别] 说明 ${n}`)
  for (const f of rec.footnotes ?? []) comments.push(`[识别] 谱后注 ${f}`)
  for (const m of rec.subtitlesMore ?? []) comments.push(`[识别] ${m}`)
  for (const s of rec.stanzaRegions ?? []) comments.push(`[识别] 附段歌词：${s.text}`)

  const emit = {
    text: textLines,
    comments,
    locator,
    offset: () => textLines.join('\n').length + 1, // 将写入行的起始偏移（行间以 \n 连接）
  }

  // ── 幻影行过滤 ──
  // 页眉的调号/拍号/速度行（如 "1=C 6/8+9/8 ♩=90"）里的数字与拍号斜线可能被当成
  // 一个谱行（实测《我和我的祖国》头部冒出 `| 1 | 1 1 | 4 |`）。特征：真谱行的
  // 数字都压在同一基线上（bbox.y 完全一致），杂行的音符基线参差（调号/拍号/速度
  // 字号不同、基线不同）且音符很少。整行丢弃并注释。
  const rowsAll = rec.rows
  const rows = rowsAll.filter((row) => {
    if (row.nums.length === 0 || row.nums.length > 8) return true
    const hs = row.nums.map((n) => n.bbox.h).sort((a, b) => a - b)
    const h = hs[Math.floor(hs.length / 2)] || 1
    const ys = row.nums.map((n) => n.bbox.y)
    const spread = Math.max(...ys) - Math.min(...ys)
    if (spread > h * 0.3) {
      comments.push(`[识别] 谱行 y≈${row.topY.toFixed(0)}：音符基线参差（跨 ${spread.toFixed(0)}px），判定为页眉杂行（调号/拍号/速度行），已丢弃`)
      return false
    }
    return true
  })

  // ── 小字谱行拆分 ──
  // 印在主谱行上方/下方的伴唱/伴奏小号谱行（jianpu.ts 按核高 0.5~0.82×主谱行认出、打 cue 标）。
  // 不拆会把它们当主声部的一行混进简谱。拆出来转成 jps 的 `@小谱 起止小节 "名称"` 块。
  // 小字谱是印在两行之间的「下一行上方」ossia，语义上属于它**下面**那行主谱
  // （用户实测：锚到上一行时小字谱整体跑到上一行上方，黄色三角也指到上面的音符）。
  // 锚定小节按下方主谱行按 x 对齐推算。
  const cueRows = rows.filter((r) => r.cue)
  const mainRows = rows.filter((r) => !r.cue)
  if (cueRows.length) {
    comments.push(`[识别] 检出 ${cueRows.length} 行小字谱，按行内空当分段后各自转成 @小谱 块（锚定小节按 x 对齐下方主谱行推算，请核对）`)
  }
  // 每条主谱行覆盖的小节号区间。多声部并行行（同一 system）覆盖相同小节段：按系统块累计，
  // 与下方 blocks 口径一致；单声部每行自成一块。
  const mainAnchors: { row: StaffRow; start: number; end: number }[] = []
  {
    let mi = 0
    let blockMeasures = 0
    let prev: StaffRow | undefined
    for (const r of mainRows) {
      const n = segmentsOf(r, [], '').length
      const sameBlock = prev !== undefined && r.system !== undefined && prev.system === r.system
      if (!sameBlock && prev !== undefined) { mi += blockMeasures; blockMeasures = 0 }
      blockMeasures = Math.max(blockMeasures, n)
      mainAnchors.push({ row: r, start: mi + 1, end: mi + n })
      prev = r
    }
  }
  /** 一条小字谱行按 x 上的**大空当**切成几段：原谱的小字谱常是主谱行上方零散的
   *  几小段（前奏括号续句、伴唱提示…），不是一整行。整行合成一个 @小谱 会把它们
   *  全拉到同一组小节上，位置全错（用户实测《下雨的时候》红框三段）。
   *  阈值=行内相邻间距中位数的 4 倍且不小于 2.5 个字高：段内音符挨着，段间常隔一个大空当。 */
  const splitCueRow = (cr: StaffRow): { row: StaffRow; x0: number; x1: number }[] => {
    const sorted = [...cr.nums].sort((a, b) => a.bbox.x - b.bbox.x)
    if (!sorted.length) return []
    const numH = medOf(sorted.map((n) => n.bbox.h)) || 1
    const gaps = sorted.slice(1).map((n, i) => n.bbox.x - (sorted[i]!.bbox.x + sorted[i]!.bbox.w))
    const medGap = medOf(gaps.filter((g) => g > 0))
    const breakGap = Math.max(numH * 2.5, medGap * 4, 24)
    const clusters: JpNum[][] = []
    let cur: JpNum[] = [sorted[0]!]
    for (let i = 1; i < sorted.length; i++) {
      const n = sorted[i]!, prev = sorted[i - 1]!
      if (n.bbox.x - (prev.bbox.x + prev.bbox.w) > breakGap) { clusters.push(cur); cur = [n] }
      else cur.push(n)
    }
    clusters.push(cur)
    return clusters.map((cl) => {
      const x0 = cl[0]!.bbox.x
      const x1 = Math.max(...cl.map((n) => n.bbox.x + n.bbox.w))
      // 段内真实小节线保留（如 `(5 6 7 1 |3---)` 中间那根）；两端补虚拟边界，
      // 保证每个 @小谱 块体至少有一个完整小节段（segmentsOf 不会输出空行）。
      // 虚拟边界要离末音一个字高以上：segmentsOf 的复纵线合并门是 max(10, 行高/2)，
      // 贴 0.5px 会把段内最后一根真线与虚拟边界合并、小节线凭空消失。
      const inner = cr.barlineXs.filter((x) => x > x0 + numH * 0.3 && x < x1 - numH * 0.3)
      return {
        x0, x1,
        row: {
          ...cr,
          nums: cl,
          barlineXs: [x0 - numH, ...inner, x1 + numH],
          // 段尾样式（终止线 / 复纵线）是整行的属性，不该带到每一段上
          finalBarline: undefined, finalBarlineThin: undefined,
          doubleBarXs: undefined, endBarXs: undefined, lyricLabels: undefined,
        },
      }
    })
  }
  /** 小字谱段的 x 范围 → 主谱行的小节号：用主谱行的段边界（leadX/tailX）按 x 对齐，
   *  不再整行笼统地套 [start,end]。同一页的主谱行与小字谱行共用一套 x 栅格。 */
  const anchorByX = (a: (typeof mainAnchors)[number], x0: number, x1: number): { start: number; end: number } => {
    const segs = segmentsOf(a.row, [], '')
    if (!segs.length) return { start: a.start, end: a.end }
    const segAt = (x: number): number => {
      let best = 0, bestD = Infinity
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]!
        const d = x < s.leadX ? s.leadX - x : x > s.tailX ? x - s.tailX : 0
        if (d < bestD) { bestD = d; best = i }
      }
      return best
    }
    const s = segAt(x0), e = Math.max(s, segAt(x1))
    return { start: a.start + s, end: a.start + e }
  }
  // 全谱所有小字谱段统一编号：同名的一堆「小字谱」在编辑界面里根本分不清哪条是哪条
  const totalCueParts = cueRows.reduce((n, r) => n + splitCueRow(r).length, 0)
  let cuePartNo = 0
  const emitCueRows = (): void => {
    for (const cr of cueRows) {
      const rowIdx = rows.indexOf(cr)
      const parts = splitCueRow(cr)
      if (!parts.length) { comments.push(`[识别] 谱行 ${rowIdx + 1}：小字谱行未解析出音符，已丢弃`); continue }
      // 只认小字谱**下方**的主谱行：小字谱在版面里是下一行上方的 ossia。
      // 旧版取 |topY - cueTopY| 最近的行，而小字谱常紧贴上一行下沿（《下雨的时候》
      // 上一行差 28px、下一行差 44px），于是三段全锚到上一行——小字谱被画到
      // 上一行上方、三角也指到小字谱上面的主谱音符。以小字谱行中线为界判定下方行，
      // 可容忍小字谱与下一行轻微重叠（实测《姑苏行》重叠 3px）。
      const cueMid = (cr.topY + cr.bottomY) / 2
      const below = mainAnchors.filter((a) => a.end >= a.start && a.row.topY > cueMid)
      // 页尾小字谱下方没有主谱行时才退回纵向最近行，别整行丢弃
      const pool = below.length ? below : mainAnchors.filter((a) => a.end >= a.start)
      let best: (typeof mainAnchors)[number] | undefined
      let bestDist = Infinity
      for (const a of pool) {
        const d = below.length ? a.row.topY - cueMid : Math.abs(a.row.topY - cr.topY)
        if (d < bestDist) { bestDist = d; best = a }
      }
      if (!best) { comments.push(`[识别] 谱行 ${rowIdx + 1}：小字谱未找到可锚定的主谱行，已丢弃`); continue }
      comments.push(`[识别] 谱行 ${rowIdx + 1}：小字谱按空当分成 ${parts.length} 段，绑定到下方主谱行 y≈${best.row.topY.toFixed(0)}，各自按 x 对齐锚定小节，请核对`)
      parts.forEach((part, pi) => {
        const { start, end } = anchorByX(best!, part.x0, part.x1)
        cuePartNo += 1
        const name = totalCueParts > 1 ? `小字谱${cuePartNo}` : '小字谱'
        comments.push(`[识别] 谱行 ${rowIdx + 1} 第 ${pi + 1} 段：x=${part.x0.toFixed(0)}~${part.x1.toFixed(0)} → 锚定第 ${start}-${end} 小节`)
        textLines.push('')
        textLines.push(`@小谱 ${start}-${end} "${name}"`)
        renderRows([{ row: part.row, idx: rowIdx }], meter.beats, emit)
      })
    }
  }

  // ── 正文：单声部 vs 多声部（声部行在 rec.rows 里按视觉交错，按 voice 归组）──
  const isUnison = (r: StaffRow): boolean => r.voice === undefined
  const voicedIds = [...new Set(mainRows.filter((r) => !isUnison(r)).map((r) => r.voice!))].sort((a, b) => a - b)
  if (!voicedIds.length) {
    renderRows(mainRows.map((row, idx) => ({ row, idx })), meter.beats, emit)
    for (const l of lyricLines(mainRows)) textLines.push(l)
  } else {
    // 齐唱谱的落盘形态：无 voice 标记的行 = 齐唱段（原谱单行记写、全体都唱）——
    // **把齐唱段旋律原样写进每一个声部**（不用「同N-M/分」标记 + 休止补齐）：
    // ①显示层与原谱一致（每个声部都在唱，而不是画一片休止）；②各声部小节表
    // 完全一致，多声部总谱排版（ensembleLayout 按小节号对齐断行）不会错位；
    // ③播放各声部照常发声。此前试过「同/分标记 + 0*N 多小节休止补齐」：
    // 多小节休止横线在总谱里跨系统画成一根贯穿长条，且显示一片休止与原谱相悖。
    // 声部在某谱行（系统）缺席（其他声部独唱段）才用 `0*N` 逐行补齐——每行一根、
    // 不跨行。歌词随齐唱行一并写进各声部（各声部歌词 token 数与自身音符数对齐）。
    // **例外：不带歌词的 unison 行是器乐段（前奏/间奏，没有人唱）**，只写进声部 1，
    // 其余声部按块 `0*N` 休止补齐。此前一律复制进每个声部：合唱谱的钢琴前奏会让
    // 四个声部齐奏同一段旋律（播放音量×4），jps 里同一段谱重复 N 遍、每份歌词前面
    // 还多出一串 `_` 占位——肉眼简单的谱，文本翻倍还难读（用户反馈）。
    const unisonSings = (r: StaffRow): boolean =>
      isUnison(r) && r.nums.some((n) => (n.lyrics ?? []).some((t) => !!t))
    const isInstrumental = (r: StaffRow): boolean => isUnison(r) && !unisonSings(r)
    const partCount = voicedIds.length
    const rowMeasures = (r: StaffRow): number => segmentsOf(r, [], '').length
    const unisonRows = mainRows.filter(isUnison)
    if (unisonRows.length) {
      const label = (rs: StaffRow[]): string => {
        const a = mainRows.indexOf(rs[0]!) + 1
        const b = mainRows.indexOf(rs[rs.length - 1]!) + 1
        return a === b ? String(a) : `${a}–${b}`
      }
      const sung = unisonRows.filter((r) => !isInstrumental(r))
      const inst = unisonRows.filter(isInstrumental)
      if (sung.length) comments.push(`[识别] 谱行 ${label(sung)} 无声部标记 → 齐唱段，该段旋律已原样写进全部 ${partCount} 个声部`)
      if (inst.length) comments.push(`[识别] 谱行 ${label(inst)} 无声部标记且无歌词 → 前奏/间奏段，仅写入声部 1，其余声部休止补齐`)
    }
    /** 系统块：同一 system 的行（多声部并行、覆盖相同小节段）归一块，齐唱行各自成块；
     *  块的小节数取块内各行检测结果的最大值。缺席补齐按块计（每块一次 0*N），
     *  不能按行——并行行的小节段是同一份，按行补会把小节数翻几倍。 */
    const blocks: { rows: number[]; measures: number }[] = []
    mainRows.forEach((r, gi) => {
      const last = blocks[blocks.length - 1]
      const lastRow = last ? mainRows[last.rows[last.rows.length - 1]!] : undefined
      if (last && r.system !== undefined && lastRow?.system === r.system) {
        last.rows.push(gi)
        last.measures = Math.max(last.measures, rowMeasures(r))
      } else {
        blocks.push({ rows: [gi], measures: rowMeasures(r) })
      }
    })
    /** 本声部缺席的系统块 → 每块一根 0*N 补齐行（键 = 渲染数组中下一行的位置；曲尾缺席段走 restTail） */
    const gapRestsFor = (isOwn: (r: StaffRow) => boolean): { restBefore: Map<number, string[]>; restTail: string[] } => {
      const restBefore = new Map<number, string[]>()
      const restTail: string[] = []
      let pending: string[] = []
      let ownIdx = 0
      blocks.forEach((b) => {
        const ownInBlock = b.rows.filter((gi) => isOwn(mainRows[gi]!))
        if (ownInBlock.length) {
          if (pending.length) restBefore.set(ownIdx, pending)
          pending = []
          ownIdx += ownInBlock.length
        } else if (b.measures > 0) {
          pending.push(`0*${b.measures}`)
        }
      })
      restTail.push(...pending)
      return { restBefore, restTail }
    }
    for (let vi = 0; vi < partCount; vi += 1) {
      // 本声部自己的行：有声部号的行 + 有词齐唱行；器乐段（无词 unison）只归声部 1。
      const own = (r: StaffRow): boolean =>
        r.voice === voicedIds[vi] || (vi === 0 ? isUnison(r) : unisonSings(r))
      const bodyRows = mainRows
        .map((row, idx) => ({ row, idx }))
        .filter(({ row }) => own(row))
      const gaps = gapRestsFor(own)
      textLines.push(`@part ${vi + 1} "声部${vi + 1}"`)
      textLines.push('@mix 1 on all')
      renderRows(bodyRows, meter.beats, emit, gaps)
      for (const l of lyricLines(bodyRows.map(({ row }) => row))) textLines.push(l)
    }
  }

  // ── 小字谱块：主谱行写完后统一追加（@小谱 块体独立解析，位置在文末不影响主谱）──
  emitCueRows()

  const text = textLines.join('\n') + '\n'
  return {
    text,
    comments: comments.length ? ['// ── 识别备注（DSL 未承载的信息）', ...comments] : [],
    locator,
  }
}
