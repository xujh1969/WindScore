/**
 * 打包 skill 的独立校验器：`skills/windscore-jps/validate.mjs`。
 *
 * 关键点：**内嵌本程序自己的解析器与不变量**（不是另写一套规则），
 * 所以「校验通过」≈「程序能无损打开」。改了 dsl / validate / layout 之后
 * 必须重新打包，否则 skill 里的校验器会与程序行为悄悄漂移：
 *
 *   npm run build:skill
 *
 * 校验五类问题（输出 `PASS` / `FAIL` + 退出码，Agent 据此闭环）：
 *   1. 解析错误（语法写错 → 程序打不开）
 *   2. 每小节拍数 vs 拍号（复用排版层徽标，含弱起豁免）
 *   3. I1–I5 拍内组 / 连线不变量
 *   4. round-trip（序列化回读一致，防保存后变形）
 *   5. 汇总行：小节线数、音符数、倚音数、拍内组数
 */
import { readFileSync } from 'node:fs';
import { parseDsl, serializeDsl } from '../src/v2/dsl';
import { layoutScore } from '../src/v2/layout';
import { validateGroups } from '../src/v2/validate';
import { ensembleIssues, scoreParts } from '../src/v2/parts';
import type { Score } from '../src/v2/types';

const file = process.argv[2];
if (!file) {
  console.error('用法: node validate.mjs <谱面.jps>');
  process.exit(2);
}

let text: string;
try {
  text = readFileSync(file, 'utf-8');
} catch {
  console.error(`无法读取文件：${file}`);
  process.exit(2);
}

let failed = false;

const r = parseDsl(text);
for (const e of r.errors) {
  failed = true;
  console.log(`[解析错误] ${e}`);
}
if (!r.score) {
  console.log('FAIL');
  process.exit(1);
}
const score = r.score;

// 小节拍数：用排版层同一套徽标（宽画布 = 不折行，徽标与行无关）
const L = layoutScore(score, { contentWidth: 100000 });
let warns = 0;
for (const line of L.lines) {
  for (const b of line.badges) {
    if (b.level === 'error') failed = true;
    else warns += 1;
    console.log(`[小节拍数${b.level === 'error' ? '错误' : '警告'}] ${b.text}`);
  }
}

for (const v of validateGroups(score)) {
  failed = true;
  console.log(`[${v.code}] ${v.message}`);
}
for (const issue of ensembleIssues(score)) {
  failed = true;
  console.log(`[声部对齐] ${issue}`);
}

// 新版读写会重新分配声部内 ID；比较实际事件和连线、分组关系。
function musicalContent(s: Score): unknown {
  return { meta: s.meta, parts: scoreParts(s).map((p) => {
    const eventIndex = new Map(p.events.map((e, i) => [e.id, i]));
    const groups = [...p.groups].sort((a, b) =>
      (eventIndex.get(a.memberIds[0]) ?? 0) - (eventIndex.get(b.memberIds[0]) ?? 0));
    const groupIndex = new Map(groups.map((g, i) => [g.id, i]));
    return { id: p.id, name: p.name, gain: p.gain, muted: !!p.muted, solo: !!p.solo,
      events: p.events.map((e) => {
        const { id: _id, originId: _origin, ...rest } = e;
        return { ...rest,
          ...('groupId' in e ? { groupId: e.groupId ? groupIndex.get(e.groupId) : undefined } : {}),
          ...(e.kind === 'note' && e.ties ? { ties: e.ties.map((t) => ({ ...t, to: eventIndex.get(t.to) })) } : {}),
          ...(e.kind === 'note' && e.hairpinTo ? { hairpinTo: eventIndex.get(e.hairpinTo) } : {}),
        };
      }),
      groups: groups.map(({ id: _id, auto: _auto, memberIds, ...g }) =>
        ({ ...g, memberIds: memberIds.map((id) => eventIndex.get(id)) })),
    };
  }) };
}

// round-trip：程序保存时会序列化成这个文本，回读必须完全一致
const rt = parseDsl(serializeDsl(score));
const original = score.format === 3 ? musicalContent(score) : score;
const reopened = score.format === 3 && rt.score ? musicalContent(rt.score) : rt.score;
if (JSON.stringify(reopened) !== JSON.stringify(original) || rt.errors.length > 0) {
  failed = true;
  console.log('[round-trip] 序列化回读不一致，文件保存后再打开会变形');
}

const measures = score.events.filter((e) => e.kind === 'barline').length;
const graces = score.events.reduce(
  (a, e) => a + (e.kind === 'note' ? (e.graceBefore?.length ?? 0) + (e.graceAfter?.length ?? 0) : 0),
  0,
);
console.log(
  `—— ${score.meta.title}：${measures} 条小节线，${score.events.filter((e) => e.kind === 'note').length} 音${
    graces ? `（含 ${graces} 颗倚音）` : ''
  }，${score.groups.length} 个拍内组${warns ? `，${warns} 处拍数警告` : ''}`,
);
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
