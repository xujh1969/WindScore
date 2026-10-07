/**
 * 反复展开（unroll）的回归测试。
 *
 * 断言分三层：
 *   ① 结构：展开后事件序列长什么样（用记号文本比对，读得懂）
 *   ② 不变量：**原谱合法 ⇒ 展开谱必须合法**（这条能自动抓出展开器绝大多数 bug）
 *   ③ 计数：总 tick / 反复遍数 / 血缘映射
 */
import { parseDsl, serializeDsl } from '../src/v2/dsl';
import { expandScore } from '../src/v2/expand';
import { buildTimeline } from '../src/v2/timeline';
import { layoutScore } from '../src/v2/layout';
import { validateGroups } from '../src/v2/validate';
import type { NoteEvent } from '../src/v2/types';

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'ok  ' : 'XX  '}${name}${detail ? `  → ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/** 只留音级 / 小节线 / 反复记号，便于人读（去掉 id 与其它细节） */
const skeleton = (text: string): string =>
  text
    .split('\n')
    .filter((l) => l && !l.startsWith('@'))
    .join(' ')
    .trim();

/** 展开后的“骨架”：音符写成度数，小节线写成 |，便于比对 */
const expandedShape = (src: string): string => {
  const r = parseDsl(src);
  if (!r.score) return `解析失败：${r.errors.join(';')}`;
  const e = expandScore(r.score);
  if (!e.score) return `展开失败：${e.errors.join(';')}`;
  return e.score.events
    .map((ev) => {
      if (ev.kind === 'note') return String((ev as NoteEvent).degree);
      if (ev.kind === 'rest') return '0';
      if (ev.kind === 'barline') return ev.style === 'final' ? '‖' : '|';
      return '';
    })
    .filter(Boolean)
    .join(' ');
};

const totalTicks = (src: string): number => {
  const s = expandScore(parseDsl(src).score!).score!;
  return s.events.reduce((a, e) => a + ('ticks' in e ? (e.ticks as number) : 0), 0);
};

console.log('\n[反复展开 · 播放指示的 id 对得上]');
{
  // 回归：播放指示按 eventId 在排版结果里找音符，**对不上就一个都不画**。
  // 排版的 item.eventId 取自谱面事件的 ev.id，而时间线默认用 originId（原谱 id）——
  // 展开谱里的反复克隆（n12~2）正好撞上这个坑：副歌第二遍完全没有指示。
  // 不变量：**显示用的时间线，每个 id 都必须能在所显示谱面的排版结果里找到。**
  const orphan = (view: 'source' | 'own', shown: Parameters<typeof layoutScore>[0], play: Parameters<typeof layoutScore>[0]): number => {
    const items = new Set(
      layoutScore(shown, { contentWidth: 900 }).lines.flatMap((l) =>
        l.items.map((it) => it.eventId),
      ),
    );
    return buildTimeline(play, { ids: view }).filter((e) => !items.has(e.eventId)).length;
  };

  for (const [title, code] of [
    ['普通反复', '@beat 4/4\n\n1 2 3 4 |: 5 6 5 6 :| 1 2 3 4 ||\n'],
    ['房子（第一遍房子）', '@beat 4/4\n\n|: 1 2 | [1] 3 4 :| 5 6 ||\n'],
    ['D.S. al Coda', '@beat 4/4\n\n$s 1 2 3 4 $t 5 6 $x 7 7 $ds ||\n'],
  ] as const) {
    const score = parseDsl(code).score!;
    const play = expandScore(score).score!;
    check(`${title}：显示原谱时用 source 口径`, orphan('source', score, play) === 0);
    check(`${title}：显示展开谱时用 own 口径`, orphan('own', play, play) === 0);

    // 关键差异不在「找得到」，而在**指不指得准**：source 口径下第二遍的条目
    // 会撞上第一遍同名的音符（指示跳回第一遍），own 口径才是每遍各自一个 id。
    const dup = (tl: ReturnType<typeof buildTimeline>): number =>
      tl.length - new Set(tl.map((e) => e.eventId)).size;
    const own = buildTimeline(play, { ids: 'own' });
    const source = buildTimeline(play, { ids: 'source' });
    check(`${title}：own 口径 id 全唯一（每遍各指各的）`, dup(own) === 0, `${dup(own)} 个重复`);
    check(`${title}：source 口径在展开谱上会撞名（反证）`, dup(source) > 0, `${dup(source)} 个重复`);

    // 两种口径的 tick 必须完全一致（伴奏对齐、滚动都靠它）
    check(
      `${title}：两种口径 tick 完全一致`,
      source.length === own.length &&
        source.every(
          (e, i) => e.startTick === own[i]!.startTick && e.endTick === own[i]!.endTick,
        ),
    );
  }
}

console.log('\n[反复展开 · 基本反复]');
{
  // |: 5 5 :| → 5 5 5 5
  check(
    '简单反复走两遍',
    expandedShape('@beat 4/4\n\n|: 5 5 5 5 :| ||\n') === '5 5 5 5 | 5 5 5 5 ‖',
    expandedShape('@beat 4/4\n\n|: 5 5 5 5 :| ||\n'),
  );
  check(
    ':|3 走三遍',
    expandedShape('@beat 4/4\n\n|: 5 5 5 5 :|3 ||\n') === '5 5 5 5 | 5 5 5 5 | 5 5 5 5 ‖',
    expandedShape('@beat 4/4\n\n|: 5 5 5 5 :|3 ||\n'),
  );
  check(
    '反复段前面 / 后面的音只走一遍',
    expandedShape('@beat 4/4\n\n1 1 1 1 | |: 5 5 5 5 :| 2 2 2 2 ||\n') ===
      '1 1 1 1 | 5 5 5 5 | 5 5 5 5 | 2 2 2 2 ‖',
    expandedShape('@beat 4/4\n\n1 1 1 1 | |: 5 5 5 5 :| 2 2 2 2 ||\n'),
  );
  check('两遍总时值 = 单遍 × 2', totalTicks('@beat 4/4\n\n|: 5 5 5 5 :| ||\n') === 384);
}

console.log('\n[反复展开 · 跳房子]');
{
  // 第一遍进 1 房、第二遍进 2 房。房子挂在**小节线**上：`| [1] …`
  check(
    '两房各走一遍',
    expandedShape('@beat 4/4\n\n|: 5 5 5 5 | [1] 3 3 3 3 | [2] 2 2 2 2 :| ||\n') ===
      '5 5 5 5 | 3 3 3 3 | 5 5 5 5 | 2 2 2 2 ‖',
    expandedShape('@beat 4/4\n\n|: 5 5 5 5 | [1] 3 3 3 3 | [2] 2 2 2 2 :| ||\n'),
  );
  // [1,2] 共用：前两遍进这个房，第三遍没有可进的房 → 只有 5 5 5 5
  check(
    '房子可共用（[1,2]）',
    expandedShape('@beat 4/4\n\n|: 5 5 5 5 | [1,2] 3 3 3 3 :|3 ||\n') ===
      '5 5 5 5 | 3 3 3 3 | 5 5 5 5 | 3 3 3 3 | 5 5 5 5 ‖',
    expandedShape('@beat 4/4\n\n|: 5 5 5 5 | [1,2] 3 3 3 3 :|3 ||\n'),
  );
  {
    // 房号**断档**（[1] [3] 缺第 2 遍）要提示（不拦展开）。
    // 反过来，「最后一遍没有房」是合法写法——`|: A [1] B :|` 第 2 遍、
    // `|: A [1,2] B :|3` 第 3 遍都只奏公共部分，不该报
    const gap = expandScore(
      parseDsl('@beat 4/4\n\n|: 5 5 5 5 | [1] 3 3 3 3 | [3] 2 2 2 2 :|3 ||\n').score!,
    );
    check(
      '房号断档给出提示（不拦展开）',
      !!gap.score && gap.warnings.some((m) => m.includes('第 2 遍没有对应的房子')),
      gap.warnings.join('; ') || '（没提示）',
    );
    const lastOnly = expandScore(
      parseDsl('@beat 4/4\n\n|: 5 5 5 5 | [1,2] 3 3 3 3 :|3 ||\n').score!,
    );
    check('末遍无房（标准写法）不提示', lastOnly.warnings.length === 0, lastOnly.warnings.join(';'));
  }
  // 三遍 + 三房（「不限两房」）
  check(
    '三房各走一遍',
    expandedShape(
      '@beat 4/4\n\n|: 5 5 5 5 | [1] 3 3 3 3 | [2] 2 2 2 2 | [3] 1 1 1 1 :|3 ||\n',
    ) === '5 5 5 5 | 3 3 3 3 | 5 5 5 5 | 2 2 2 2 | 5 5 5 5 | 1 1 1 1 ‖',
    expandedShape('@beat 4/4\n\n|: 5 5 5 5 | [1] 3 3 3 3 | [2] 2 2 2 2 | [3] 1 1 1 1 :|3 ||\n'),
  );
  check(
    '房子最后一小节接终止线',
    expandedShape('@beat 4/4\n\n|: 5 5 5 5 :| ||\n').endsWith('‖'),
  );
}

console.log('\n[反复展开 · 嵌套与拍内组]');
{
  // 外层 2 遍 × 内层 2 遍 = 4 遍内层
  check(
    '嵌套两层：内层走外层 × 内层遍数',
    expandedShape('@beat 4/4\n\n|: |: 5 5 5 5 :| 3 3 3 3 :| ||\n') ===
      '5 5 5 5 | 5 5 5 5 | 3 3 3 3 | 5 5 5 5 | 5 5 5 5 | 3 3 3 3 ‖',
    expandedShape('@beat 4/4\n\n|: |: 5 5 5 5 :| 3 3 3 3 :| ||\n'),
  );
  // 拍内组跟着复制：两遍各有一个独立的组
  const s = expandScore(parseDsl('@beat 4/4\n\n|: <5/2 3/2> 5 5 :| ||\n').score!).score!;
  check('拍内组按遍复制成两个独立组', s.groups.length === 2, String(s.groups.length));
  check(
    '组 id 第二遍加后缀且成员齐全',
    s.groups[0].id === 'g1' && s.groups[1].id === 'g1~2' && s.groups[1].memberIds.length === 2,
    s.groups.map((g) => `${g.id}(${g.memberIds.length})`).join(' '),
  );
  check('组总时值重算正确', s.groups.every((g) => g.totalTicks === 48), s.groups.map((g) => g.totalTicks).join(','));
  check(
    '组内成员 id 与展开事件一致',
    s.groups[0].memberIds.every((id) => s.events.some((e) => e.id === id)),
  );
}

console.log('\n[反复展开 · 完整一段曲子]');
{
  // 段落 + 反复 + 房子 + 收尾：真实写法
  const src =
    '@beat 4/4\n\n5 5 5 5 | |: 1 2 3 4 | 3 2 1 2 | [1] 5 5 5 5 | [2] 6 6 6 6 :| 1 1 1 1 ||\n';
  check(
    '段首 / 反复段（两房）/ 收尾各自就位',
    expandedShape(src) ===
      '5 5 5 5 | 1 2 3 4 | 3 2 1 2 | 5 5 5 5 | 1 2 3 4 | 3 2 1 2 | 6 6 6 6 | 1 1 1 1 ‖',
    expandedShape(src),
  );
  check('展开后共 8 小节 × 4 拍', totalTicks(src) === 8 * 4 * 48, String(totalTicks(src)));
}

console.log('\n[反复展开 · 黄金不变量]');
{
  const FILES = [
    '@beat 4/4\n\n|: 5 5 5 5 :| ||\n',
    '@beat 4/4\n\n1 1 1 1 | |: 5 5 5 5 :| 2 2 2 2 ||\n',
    '@beat 4/4\n\n|: <5/2 3/2> 5 5 | [1] 3 3 3 3 | [2] 2 2 2 2 :| ||\n',
    '@beat 3/4\n\n|: 5 5 5 :|3 1 1 1 ||\n',
    '@beat 4/4\n\n|: <{2}3/2 3/2> 3 3 5/2 5/2 :| 1 1 1 1 ||\n',
    '@beat 4/4\n\n|: 5 5 5 5 | 转1=G 6 6 6 6 :| ||\n',
  ];
  for (const src of FILES) {
    const r = parseDsl(src);
    check(`原谱可解析：${skeleton(src).slice(0, 40)}`, !!r.score, r.errors.join('; '));
    if (!r.score) continue;
    const e = expandScore(r.score);
    check('展开无错', !!e.score && e.errors.length === 0, (e.errors ?? []).join('; '));
    if (!e.score) continue;
    check('原谱合法 ⇒ 展开谱合法', validateGroups(e.score).length === 0, validateGroups(e.score).map((v) => v.code).join(','));
    // 展开谱能排版、小节拍数不出错（徽标逻辑会因为反复记号而崩的话，这里会先炸）
    const L = layoutScore(e.score, { contentWidth: 1000 });
    const bad = L.lines.flatMap((l) => l.badges).filter((b) => b.level === 'error');
    check('展开谱小节拍数无错', bad.length === 0, bad.map((b) => b.text).join(' '));
  }
}

console.log('\n[反复展开 · 血缘与定位]');
{
  const src = parseDsl('@beat 4/4\n\n|: 5 5 5 5 :| ||\n').score!;
  const e = expandScore(src).score!;
  const notes = e.events.filter((x) => x.kind === 'note');
  check('每个展开事件都带 originId', e.events.every((x) => !!x.originId));
  check(
    '两遍的音符指回同一批源事件',
    notes[0].originId === notes[4].originId && notes[1].originId === notes[5].originId,
    `${notes.slice(0, 8).map((n) => n.originId).join(',')}`,
  );
  const firstIndex = expandScore(src).firstIndex;
  check('firstIndex 指向首次出现的位置', firstIndex.get(notes[0].originId!) === 0);
  check('重复出现的事件用 ~n 后缀区分', notes[4].id === `${notes[0].originId}~2`, notes[4].id);
}

console.log('\n[反复展开 · 结构错误必须报错]');
{
  const cases: [string, string, string][] = [
    ['缺少 :|', '@beat 4/4\n\n|: 5 5 5 5 ||\n', '没有配对的 :|'],
    ['缺少 |:', '@beat 4/4\n\n5 5 5 5 :| ||\n', '没有配对的 |:'],
    ['嵌套三层', '@beat 4/4\n\n|: |: |: 5 5 5 5 :| :| :| ||\n', '嵌套超过'],
    ['房子不在反复段内', '@beat 4/4\n\n| [1] 5 5 5 5 | [2] 3 3 3 3 ||\n', '不在反复段内'],
    ['房子号数超出遍数', '@beat 4/4\n\n|: 5 5 5 5 | [3] 3 3 3 3 :| ||\n', '超出反复遍数'],
    // 两个房子挤在同一根线上：括线无处可画，必须报错
    [
      '两个房子之间必须有小节线',
      '@beat 4/4\n\n|: 5 5 5 5 | [1] 3 3 [2] 2 2 :| ||\n',
      '缺少小节线',
    ],
    ['D.S. 没有 𝄋（现在支持跳转，但配对缺失仍要拦）', '@beat 4/4\n\n$ds 5 5 5 5 ||\n', '𝄋'],
    [':|1 遍数非法', '@beat 4/4\n\n|: 5 5 5 5 :|1 ||\n', '重复遍数应为 2 以上'],
  ];
  for (const [name, src, expect] of cases) {
    const r = parseDsl(src);
    const e = r.score ? expandScore(r.score) : null;
    const msg = [...(r.errors ?? []), ...(e?.errors ?? [])].join('; ');
    // 解析阶段拦下（如 $ds）或展开阶段拦下都算拦住了：要点是别静默放过
    const blocked = r.errors.length > 0 || (!!e && !e.score);
    check(`${name} → 报错`, blocked && msg.includes(expect), msg || '（没报错）');
  }
}

console.log('\n[反复展开 · 幂等与 round-trip]');
{
  const src = '@beat 4/4\n\n|: 5 5 5 5 | [1] 3 3 3 3 | [2] 2 2 2 2 :| ||\n';
  const once = expandScore(parseDsl(src).score!).score!;
  const twice = expandScore(once).score!;
  check(
    '展开产物再展开 = 原样（已无反复记号）',
    serializeDsl(once) === serializeDsl(twice),
    serializeDsl(twice).split('\n').pop()?.trim().slice(0, 60),
  );
  check('展开产物可 round-trip', parseDsl(serializeDsl(once)).errors.length === 0);
}

console.log(failed === 0 ? '\nEXPAND PASS' : `\nEXPAND FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
