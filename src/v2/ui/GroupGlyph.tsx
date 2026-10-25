/**
 * 组划分候选的预览：按**谱面的实际画法**渲染——
 * 减时线在组内连成横线（第 lv 层线从第一个带 lv+1 条线的音连到最后一个），
 * 连音在上方画断弧、断口里坐标号。与 canvas 的 BeatGroup / tuplet 绘制同构。
 */
export function GroupGlyph({
  degrees,
  beams,
  tuplet,
  dots,
  dashes,
}: {
  degrees: number[];
  /** 每个音的减时线条数 */
  beams: number[];
  tuplet?: number;
  /** 每个音的附点数（附点切分候选用，缺省无点） */
  dots?: (0 | 1 | 2)[];
  /** 每个音的增时线数（超过一拍的成员，如 6/4 的附点二分 = `1-.`） */
  dashes?: number[];
}) {
  const max = Math.max(0, ...beams);
  const n = degrees.length || 1;
  return (
    <span className="v2-ggroup">
      {tuplet ? (
        <span className="v2-ggroup-arc">
          <i className="v2-ggroup-tuplet">{tuplet}</i>
        </span>
      ) : null}
      <span
        className="v2-ggroup-row"
        // 底距随层数走：保证「最外层线到数字」的距离恒为 1px，
        // 单层线与多层线的外层线贴得一样近（更深线每层低 3px 由 bottom 公式负责，
        // 与谱面 canvas 的 beamStep 一致）
        style={{ paddingBottom: max > 0 ? (max - 1) * 3 + 2 : 2 }}
      >
        {degrees.map((d, j) => (
          <span key={j} className="v2-ggroup-note">
            {d}
            {dashes?.[j] ? <span>{'-'.repeat(dashes[j])}</span> : null}
            {dots?.[j] ? <span className="v2-dotglyph-dot">{'.'.repeat(dots[j])}</span> : null}
          </span>
        ))}
        {Array.from({ length: max }, (_, lv) => {
          // 同一层级的线按「连续段」分段画：1/4+1/2+1/4 的二级线是
          // 两侧各一段短线，中间的八分音只有一级——不能一条线穿过去
          const idx = beams.map((b, j) => (b > lv ? j : -1)).filter((j) => j >= 0);
          const runs: number[][] = [];
          for (const j of idx) {
            const last = runs[runs.length - 1];
            if (last && j === last[last.length - 1] + 1) last.push(j);
            else runs.push([j]);
          }
          // 与 canvas 一致：一级线贴着音符，级别越大越往下（短线在长线下方）
          return runs.map((run, k) => {
            const from = run[0];
            const to = run[run.length - 1];
            const left = (from + 0.18) / n;
            const width = ((to - from + 0.64) / n) * 100;
            return (
              <i
                key={`${lv}-${k}`}
                className="v2-ggroup-beam"
                style={{ left: `${left * 100}%`, width: `${width}%`, bottom: (max - 1 - lv) * 3 + 1 }}
              />
            );
          });
        })}
      </span>
    </span>
  );
}
