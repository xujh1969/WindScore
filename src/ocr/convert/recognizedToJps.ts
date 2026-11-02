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
  tailX: number // 本段右边界 x（下一根小节线）；末段 tailX = 行末线
  isLast: boolean
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
    out.push({ notes: notesIn, tailX: tail, isLast: false })
  }
  if (out.length) out[out.length - 1]!.isLast = true
  return out
}

interface RowWithIdx {
  row: StaffRow
  idx: number // rec.rows 的原始下标（locator 与注释里的「谱行 N」都用它）
}

/** 谱行集合 → 正文行数组（不含歌词与注释）。同时产出 locator 与注释。 */
function renderRows(
  rows: RowWithIdx[],
  beats: number,
  emit: { text: string[]; comments: string[]; locator: LocatorEntry[]; offset: () => number },
): void {
  const lastRowIdx = rows.length - 1
  for (let ri = 0; ri < rows.length; ri++) {
    const { row, idx: rowIdx } = rows[ri]!
    const rowLabel = `谱行 ${rowIdx + 1}`
    if (row.lyricLabels?.length) {
      emit.comments.push(`[识别] 歌词段号 ${row.lyricLabels.join('/')}（${rowLabel}，jps 未承载）`)
    }
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
  if (beats <= 0) emit.comments.push('[识别] 拍号缺失，按 4/4 处理') // 保守兜底提示
}

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
        toks.push(n.lyrics?.[v] || '_')
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

  // ── 正文：单声部 vs 多声部（声部行在 rec.rows 里按视觉交错，按 voice 归组）──
  const hasVoice = rows.some((r) => r.voice !== undefined)
  if (!hasVoice) {
    renderRows(rows.map((row, idx) => ({ row, idx })), meter.beats, emit)
    for (const l of lyricLines(rows)) textLines.push(l)
  } else {
    const voiceOf = (r: StaffRow): number => r.voice ?? 0
    const voices = [...new Set(rows.map(voiceOf))].sort((a, b) => a - b)
    rows.forEach((r, i) => {
      if (r.voice === undefined) comments.push(`[识别] 谱行 ${i + 1} 无声部标记，按声部 1 处理`)
    })
    voices.forEach((v, vi) => {
      const vRows = rows
        .map((row, idx) => ({ row, idx }))
        .filter(({ row }) => voiceOf(row) === v)
      textLines.push(`@part ${vi + 1} "声部${vi + 1}"`)
      textLines.push('@mix 1 on all')
      renderRows(vRows, meter.beats, emit)
      for (const l of lyricLines(vRows.map(({ row }) => row))) textLines.push(l)
    })
  }

  const text = textLines.join('\n') + '\n'
  return {
    text,
    comments: comments.length ? ['// ── 识别备注（DSL 未承载的信息）', ...comments] : [],
    locator,
  }
}
