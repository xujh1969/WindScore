// 前奏括号校正（识别管线误把音符行内的大括弧读成 0/1 的几何改写）。
// 印刷简谱的前奏/过门旋律两端印一对大括弧 ( … )：与数字同高、极窄、细弧——
// 纯几何分类撞上 `)` 像 0、`(` 像 1（样张「好汉歌」实测：括号 w8×h25 vs 数字 25×26）。
// 校正：把成对的括弧从音符里删掉，在相邻音符上打 parenBefore/parenAfter 标记，
// 转换时发**独立的全角括号 token**（`（` / `）`）——WindScore 的 paren 指令，
// 渲染为字面括号记号，**不画连线弧**（半角 ( ) 才是连线；全角（ ）是括号，两者意义不同）。
// 判据不碰 dolce 主管线，全部在识别结果上做；拿不准的（没配成对）原样保留。
import type { Binary, Rect, RecognizedScore } from '../dolce/omrkit/types'

export type ParenSide = 'open' | 'close'

/**
 * 窄高块是不是前奏括弧。方向判据（弧的列结构，样张实测 + 合成字形验证）：
 * ① 窄：w ≤ 0.45×medH（真 0/2~8 的宽在 0.5~1.1 字号，过不来）；
 * ② 弧的列结构：一条 '(' 的**每一列墨都是上下两支**（弧的上支+下支），唯独凸侧切线列
 *    是**单段短墨、纵向居中**（弧的最左/最右点），两支的间隙从切线侧向开口侧张开
 *    （开口侧最大间隙 ≥0.3 块高）。
 *    —— `1` 的竖笔每列只有一段墨，②必败；`0` 是完整椭圆，**两侧**都有切线列
 *    （左右各一个中点短墨列），「切线列只在一侧」这条把它挡住；粗细弧线靠①的宽度门。
 */
export function parenSideOf(bin: Binary, b: Rect, medH: number): ParenSide | null {
  // 宽门 0.52 字号：真 0 的宽在 0.6+ 字号且会被「切线列只在一侧」挡住；
  // chorus_04 实测开括号 w/med=0.45、好汉歌 0.36——0.45 的旧门在 medH 偏小的行会误拒
  if (medH <= 0 || b.w < 2 || b.w > medH * 0.52) return null;
  if (b.h < medH * 0.8 || b.h > medH * 1.9) return null;
  const midY0 = b.y + b.h * 0.25;
  const midY1 = b.y + b.h * 0.75;
  let ink = 0;
  let tangentLeft = 0, tangentRight = 0;
  let twoRuns = 0, maxGapLeft = 0, maxGapRight = 0;
  for (let x = b.x; x < b.x + b.w; x++) {
    const rs: Array<[number, number]> = [];
    let s = -1;
    for (let y = b.y; y < b.y + b.h; y++) {
      if (bin.data[y * bin.w + x]) {
        ink++;
        if (s < 0) s = y;
      } else if (s >= 0) {
        rs.push([s, y - 1]);
        s = -1;
      }
    }
    if (s >= 0) rs.push([s, b.y + b.h - 1]);
    const left = x - b.x < b.w / 2;
    if (rs.length === 1) {
      const c = (rs[0]![0] + rs[0]![1]) / 2;
      if (c >= midY0 && c <= midY1) {
        if (left) tangentLeft++;
        else tangentRight++;
      }
    } else if (rs.length === 2) {
      twoRuns++;
      const gap = rs[1]![0] - rs[0]![1] - 1;
      if (left) maxGapLeft = Math.max(maxGapLeft, gap);
      else maxGapRight = Math.max(maxGapRight, gap);
    }
  }
  if (twoRuns < 3) return null; // 弧的主体得是「上下两支」的列
  if (ink / (b.w * b.h) > 0.5) return null; // 弧线是细的；实心笔画进不来
  // 切线列只在一侧 + 开口侧间隙张开
  if (tangentLeft > 0 && tangentRight === 0 && maxGapRight >= b.h * 0.3) return 'open'; // (
  if (tangentRight > 0 && tangentLeft === 0 && maxGapLeft >= b.h * 0.3) return 'close'; // )
  return null;
}

/**
 * 扫全谱：行内被读成 0/1 的窄弧块配成对 → 删块、在相邻音符上打括号标记
 * （转换器见标记即在音符 token 前/后发独立的全角 `（`/`）` token）。
 * 返回校正的括号对数（0 = 没动）。
 */
export function correctParenSlurs(score: RecognizedScore, bin: Binary): number {
  let pairs = 0;
  (score.rows ?? []).forEach((row) => {
    const hs = row.nums.map((n) => n.bbox.h).sort((a, b) => a - b);
    const medH = hs[Math.floor(hs.length / 2)] ?? 0;
    if (!medH) return;
    // 本行的括弧候选（位置序）。digit 门：0/1 是实测主要误读；其余数字只有当块明显
    // 高于数字中位高（≥1.25×，印刷括号常比数字高出一截，chorus_04 实测 1.30×）才收——
    // 防 2/3/5 这类正常数字被弧结构误伤；配对仍是最后的安全网。
    const cands = row.nums
      .map((n, i) => {
        if (n.digit !== 0 && n.digit !== 1 && n.bbox.h < medH * 1.25) return null;
        return { n, i, side: parenSideOf(bin, n.bbox, medH) };
      })
      .filter((c): c is { n: typeof row.nums[number]; i: number; side: ParenSide } => c !== null && c.side !== null);
    if (!cands.length) return;
    // 栈配对：'( ' 之后最近的 ')' 为一对
    const stack: Array<{ n: typeof row.nums[number]; i: number }> = [];
    const matched: Array<{ open: { n: typeof row.nums[number]; i: number }; close: { n: typeof row.nums[number]; i: number } }> = [];
    for (const c of cands) {
      if (c.side === 'open') stack.push(c);
      else {
        const open = stack.pop();
        if (open) matched.push({ open, close: c });
      }
    }
    const rowIdx = score.rows.indexOf(row);
    // 被删的括号块上可能锚着小节结构标记（反复/跳房子/跳转记号都挂音符上）——
    // 删块必须把标记搬到目标音，否则 `|:` 会跟着假 1 一起丢（chorus_03 实测）。
    const carryMarks = (src: typeof row.nums[number], t: typeof row.nums[number]) => {
      if (src.repeatForward) t.repeatForward = true;
      if (src.repeatBackward) t.repeatBackward = true;
      if (src.segno) t.segno = true;
      if (src.endingStart) t.endingStart = src.endingStart;
      if (src.endingStop) t.endingStop = src.endingStop;
      if (src.timeChange && !t.timeChange) t.timeChange = src.timeChange;
      if (src.jumpMarks?.length) t.jumpMarks = [...(t.jumpMarks ?? []), ...src.jumpMarks];
    };
    const attach = (drop: Set<typeof row.nums[number]>, srcs: readonly (typeof row.nums[number])[], parenIdx: number, dir: 1 | -1, key: 'parenBefore' | 'parenAfter') => {
      const dropped: typeof row.nums[number][] = [...srcs];
      for (let i = parenIdx + dir; i >= 0 && i < row.nums.length; i += dir) {
        const t = row.nums[i]!;
        if (drop.has(t)) { dropped.push(t); continue; }
        t[key] = true;
        for (const d of dropped) carryMarks(d, t);
        return;
      }
      // 行内没有可标记的邻音：标到邻行靠得最近的一颗（跨行括弧兜底）
      const rows2 = score.rows ?? [];
      const other = rows2[rowIdx + dir];
      if (other?.nums.length) {
        const t = dir === 1 ? other.nums[0]! : other.nums[other.nums.length - 1]!;
        t[key] = true;
        for (const d of dropped) carryMarks(d, t);
      }
    };
    if (matched.length) {
      const drop = new Set(matched.flatMap((m) => [m.open.n, m.close.n]));
      for (const m of matched) {
        attach(drop, [m.open.n], m.open.i, 1, 'parenBefore');
        attach(drop, [m.close.n], m.close.i, -1, 'parenAfter');
        pairs++;
      }
      // 配对成功后残留的**孤立 open** 同样要删：`(` 读成 0/1 留在行里就是一颗假音符
      //（下雨的时候 小字谱行实测：`(0 45 0532 43` 的 `(` 与后面配不上对，残留成 `0^`）。
      // parenSideOf 的结构判据数字过不来，孤立的 open 可放心删（与下面 matched.length===0 的兜底同一口径）。
      const matchedOpens = new Set(matched.map((m) => m.open.n));
      const leftoverOpens = cands.filter((c) => c.side === 'open' && !matchedOpens.has(c.n) && !drop.has(c.n));
      for (const c of leftoverOpens) { drop.add(c.n); attach(drop, [c.n], c.i, 1, 'parenBefore'); pairs++; }
      row.nums = row.nums.filter((n) => !drop.has(n));
    } else {
      // 单边开括号兜底：闭弧 ) 常与邻块粘连进不了 nums（chorus_03 引子 `(5 … 5 i)` 的
      // `(` 读成 1、`)` 压根没被读出），配不上对就被「原样保留」成一颗假 1。
      // parenSideOf 的结构判据（每列上下两支 + 单侧切线列 + 细）数字过不来，孤立的
      // open 可放心删。close 侧不动：) 与 0 形态近得多，单边删它的误伤风险高。
      const opens = cands.filter((c) => c.side === 'open');
      if (!opens.length) return;
      const drop = new Set(opens.map((c) => c.n));
      for (const c of opens) attach(drop, [c.n], c.i, 1, 'parenBefore');
      row.nums = row.nums.filter((n) => !drop.has(n));
      pairs += opens.length;
    }
  });
  return pairs;
}
