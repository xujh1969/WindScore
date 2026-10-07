/**
 * 历史搜索（动态谱首页的「最近搜索」）。
 *
 * 只存词，不存结果：结果每次按曲库实时算——曲库变了，旧结果就没意义了。
 */

export const RECENT_LIMIT = 12;
const KEY = 'ws-recent-search';

export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 40);
}

/** 最近的在前；同词只留一条，重复搜索把它提到最前 */
export function pushRecent(list: readonly string[], raw: string): string[] {
  const q = normalizeQuery(raw);
  if (!q) return [...list];
  return [q, ...list.filter((x) => x !== q)].slice(0, RECENT_LIMIT);
}

export function removeRecent(list: readonly string[], q: string): string[] {
  return list.filter((x) => x !== q);
}

export function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === 'string').slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function writeRecent(list: readonly string[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, RECENT_LIMIT)));
    return true;
  } catch {
    return false;
  }
}