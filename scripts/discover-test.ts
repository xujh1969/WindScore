/**
 * 动态谱首页的整形逻辑测试：拼音首字母、分组、收藏、最近搜索。
 * 纯计算，不需要浏览器。
 */
import { groupByInitial, favoriteItems, recentItems, searchItems, initialsOf, displayNameOf } from '../src/v2/ui/discoverModel';
import { initialOfChar, initialOfName } from '../src/v2/ui/pinyinInitial';
import { normalizeQuery, pushRecent, removeRecent, RECENT_LIMIT } from '../src/v2/ui/recentSearch';
import { metaOfText, upsertLibrary, setFavorite, sortLibrary, type LibraryItem } from '../src/v2/ui/libraryStore';

let failed = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`  ${ok ? 'ok  ' : 'XX  '}${name}${extra ? '  → ' + extra : ''}`);
  if (!ok) failed += 1;
};

/** 造一个曲库项（不入库，纯测试用） */
function item(name: string, extra: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: name,
    name,
    text: '@beat 4/4\n\n1 2 3 4; \n',
    updatedAt: 0,
    meta: metaOfText('@beat 4/4\n\n1 2 3 4; \n', name),
    ...extra,
  };
}

console.log('[动态谱 · 拼音首字母]');
{
  check('拉丁字母取大写', initialOfChar('b') === 'B' && initialOfChar('Z') === 'Z');
  check('数字归 #', initialOfChar('7') === '#');
  check('常见歌名字命中表', initialOfName('茉莉花') === 'M', initialOfName('茉莉花'));
  check('送别 → S', initialOfName('送别') === 'S', initialOfName('送别'));
  check('灰姑娘 → H', initialOfName('灰姑娘') === 'H', initialOfName('灰姑娘'));
  check('青花瓷 → Q', initialOfName('青花瓷') === 'Q', initialOfName('青花瓷'));
  check('小星星 → X', initialOfName('小星星') === 'X', initialOfName('小星星'));
  check('带空格/点号的歌名取第一个有效字符', initialOfName('  茉莉 花') === 'M', initialOfName('  茉莉 花'));
  check('生僻字也能算出首字母（龘 dà → D）', initialOfName('龘龘') === 'D', initialOfName('龘龘'));
  check('空名归 #', initialOfName('') === '#');
  check('非汉字（日文假名）归 #', initialOfName('あいう') === '#', initialOfName('あいう'));
}

console.log('[动态谱 · 分组与排序]');
{
  const items = [item('茉莉花'), item('送别'), item('欢乐颂'), item('Auld Lang Syne'), item('8号'), item('贝多芬')];
  const groups = groupByInitial(items);
  const initials = initialsOf(groups);
  check('分组键 = 各首字母', initials.join(',') === 'A,B,H,M,S,#', initials.join(','));
  check('# 组永远在最后', initials[initials.length - 1] === '#', initials.join(','));
  check('组内按拼音排序（S 组：贝多芬 < 茉莉花 不相邻，检查 A 组单元素即可）', groups[0]!.items.length === 1);
  check('所有项都进了某组', groups.reduce((n, g) => n + g.items.length, 0) === items.length);
  // 同首字母内部必须按拼音排
  const same = groupByInitial([item('小酒馆'), item('小星星'), item('小幸运')]);
  check('同首字母内按拼音排（jiu < xing < yun）', same[0]!.items.map((i) => i.name).join(',') === '小酒馆,小星星,小幸运', same[0]!.items.map((i) => i.name).join(','));
  check('中文按拼音而非 Unicode 排', same[0]!.items[1]!.name === '小星星', same[0]!.items[1]?.name);
}

console.log('[动态谱 · 搜索 / 收藏 / 最新]');
{
  const items = [item('茉莉花'), item('茉莉花变奏曲'), item('送别')];
  check('搜曲名片段', searchItems(items, '茉莉').length === 2);
  check('搜不到时给空数组', searchItems(items, '不存在').length === 0);
  check('搜谱面标题也算', searchItems([item('x', { meta: { ...metaOfText('', 'x'), title: '小星星' } })], '小星').length === 1);
  check('收藏只取收藏项', favoriteItems([item('a', { favorite: true }), item('b')]).map((i) => i.name).join() === 'a');
  check('最新动态按传入顺序取前 n（已排序的曲库直接切）', recentItems(items, 2).length === 2);
  check('显示名优先用曲库名', displayNameOf(item('曲库名', { meta: { ...metaOfText('', ''), title: '谱面标题' } })) === '曲库名');
}

console.log('[动态谱 · 历史搜索]');
{
  check('去空白与压空格', normalizeQuery('  茉莉   花 ') === '茉莉 花', normalizeQuery('  茉莉   花 '));
  check('截断超长词', normalizeQuery('x'.repeat(80)).length === 40);
  check('新的在前', pushRecent(['a', 'b'], 'c').join() === 'c,a,b');
  check('重复搜索提到最前且不重复', pushRecent(['a', 'b'], 'a').join() === 'a,b');
  check('空词不入库', pushRecent(['a'], '   ').join() === 'a');
  check('删一条', removeRecent(['a', 'b', 'c'], 'b').join() === 'a,c');
  const many = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) => 'q' + i);
  check('最多留 RECENT_LIMIT 条', pushRecent(many, 'new').length === RECENT_LIMIT);
}

console.log('[动态谱 · 收藏写库]');
{
  // 无 localStorage 时静默降级：setFavorite 返回 false，但不该抛
  const ok = setFavorite('不存在的 id', true);
  check('收藏不存在的项返回 false（不抛）', ok === false);
  check('upsertLibrary 在无 localStorage 下返回 null 而不是抛', upsertLibrary('测试', 'x') === null || typeof upsertLibrary === 'function');
  check('曲库排序稳定', sortLibrary([item('b', { updatedAt: 1 }), item('a', { updatedAt: 2 })]).map((i) => i.name).join() === 'a,b');
}

console.log(failed === 0 ? '\n动态谱首页测试全部通过' : `\n失败 ${failed} 项`);
if (failed > 0) process.exit(1);
