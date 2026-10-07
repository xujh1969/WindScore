/**
 * 动态谱首页的数据整形（纯计算，不碰 React 与 localStorage，所以能进 node 单测）。
 *
 * 页面要的五块都从这里出：最新动态、我的收藏、搜索结果、全部曲目（按拼音首字母分组），
 * 右侧 A/B/C… 索引就是分组键。
 */

import { searchLibrary, type LibraryItem } from './libraryStore';
import { initialOfName } from './pinyinInitial';

export interface InitialGroup {
  initial: string;
  items: LibraryItem[];
}

/** 中文按拼音排序（`zh-Hans-CN-u-co-pinyin`：iOS  Safari 不认这个 collation，会退到默认顺序） */
const collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });

/** 曲名（曲库名优先，其次谱面标题）——搜索与展示都用它 */
export function displayNameOf(item: LibraryItem): string {
  return item.name || item.meta.title || '未命名';
}

const byName = (a: LibraryItem, b: LibraryItem): number =>
  collator.compare(displayNameOf(a), displayNameOf(b));

/** 最新动态：最近更新的在前（updatedAt 已由 sortLibrary 排好序） */
export function recentItems(items: readonly LibraryItem[], n = 6): LibraryItem[] {
  return items.slice(0, Math.max(0, n));
}

/** 我的收藏 */
export function favoriteItems(items: readonly LibraryItem[]): LibraryItem[] {
  return items.filter((it) => it.favorite);
}

/** 搜索结果（复用曲库自己的搜索：名字或标题命中） */
export function searchItems(items: readonly LibraryItem[], query: string): LibraryItem[] {
  return searchLibrary([...items], query).sort(byName);
}

/**
 * 按拼音首字母分组，组内按曲名排序，组间按字母序。
 * `#`（数字开头 / 表外汉字）永远排最后。
 */
export function groupByInitial(items: readonly LibraryItem[]): InitialGroup[] {
  const map = new Map<string, LibraryItem[]>();
  for (const it of items) {
    const key = initialOfName(displayNameOf(it));
    const list = map.get(key);
    if (list) list.push(it);
    else map.set(key, [it]);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] === '#' ? 1 : b[0] === '#' ? -1 : a[0].localeCompare(b[0])))
    .map(([initial, list]) => ({ initial, items: [...list].sort(byName) }));
}

/** 右侧索引：有哪些组就列哪些（不硬凑 26 个字母，空的没有意义） */
export function initialsOf(groups: readonly InitialGroup[]): string[] {
  return groups.map((g) => g.initial);
}