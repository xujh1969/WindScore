/**
 * 长曲排版／播放的性能测量（不是断言测试）。
 *
 * Roadmap「体验、性能与输出」要求**先测量再优化**：这里给出大谱面在
 * 解析、序列化、简谱排版、五线谱排版、时刻表、反复展开上的耗时，
 * 作为「要不要按行缓存」这类优化的判断依据。数字只用于比较，不作通过标准。
 *
 *   npm run perf
 */
import { parseDsl, serializeDsl } from '../src/v2/dsl';
import { layoutScore } from '../src/v2/layout';
import { buildStaffLayout } from '../src/v2/staff';
import { buildTimeline } from '../src/v2/timeline';
import { expandScore } from '../src/v2/expand';
import type { Score } from '../src/v2/types';

/** 造一份规整的大谱：measures 小节 × 每小节 4 个四分音符 */
function makeDsl(measures: number): string {
  const bars: string[] = [];
  for (let m = 0; m < measures; m += 1) {
    const notes = ['5', '6', '3', '2'].map((d) => (m % 3 === 0 ? `${d}/2` : d)).join(' ');
    bars.push(notes);
  }
  return `@beat 4/4\n@bpm 96\n\n${bars.join(' | ')} ||\n`;
}

/** 毫秒：跑 rounds 次取最快的一次（避开 JIT 预热与偶发调度） */
function time(label: string, rounds: number, fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < rounds; i += 1) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  console.log(`  ${label.padEnd(28)} ${best.toFixed(1).padStart(8)} ms`);
  return best;
}

function report(title: string, score: Score, withLyrics: boolean): void {
  const notes = score.events.filter((e) => e.kind === 'note').length;
  console.log(`\n${title}（${notes} 个音${withLyrics ? '，带歌词' : ''}）`);
  const layout = layoutScore(score, { contentWidth: 800 });
  console.log(`  排版行数 ${layout.lines.length}`);
  time('parseDsl', 3, () => void parseDsl(serializeDsl(score)));
  time('serializeDsl', 3, () => void serializeDsl(score));
  time('layoutScore（简谱）', 5, () => void layoutScore(score, { contentWidth: 800 }));
  time('buildStaffLayout（五线谱）', 5, () =>
    void buildStaffLayout(score, layoutScore(score, { contentWidth: 800 }), 'concert'),
  );
  time('buildTimeline', 5, () => void buildTimeline(score));
  time('expandScore（反复展开）', 3, () => void expandScore(score));
}

console.log('[性能测量] 取各轮最快值，仅作比较用');

{
  const base = parseDsl(makeDsl(500)).score!;
  report('500 小节（≈2000 音）', base, false);
  const lyric = parseDsl(makeDsl(500)).score!;
  for (const e of lyric.events) if (e.kind === 'note') e.lyrics = ['啦'];
  report('500 小节', lyric, true);
}

{
  const big = parseDsl(makeDsl(2000)).score!;
  report('2000 小节（≈8000 音）', big, false);
}

console.log('\n说明：绘制（paint）与导出需要 Canvas，浏览器/桌面端才可测，这里只覆盖纯计算部分。');
