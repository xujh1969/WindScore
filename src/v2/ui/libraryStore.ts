/**
 * 本地曲库（P2 「曲库 + 入库」）：把谱面收进本机的一份清单，
 * 改完直接入库，下次从列表点开，不用每次去文件对话框里翻。
 *
 * 存储选型：**清单（含谱面文本）走一个 JSON 文档**——
 *   文件后端（exe / Web 文件夹模式）→ `library.json`，曲库 = 一个可拷贝的文件夹；
 *   浏览器兜底 → localStorage（键 `ws-library`，同一份文档格式）。
 * localStorage 不可用（隐私模式 / 配额满）时一律静默降级：
 * 曲库功能失效，但编辑与播放照常。
 *
 * 全部副作用集中在 read/write 两个函数上，其余都是纯函数，可在 Node 里直接测。
 */

import { useEffect, useState } from 'react';
import { pinyin } from 'pinyin-pro';
import { DEFAULT_META, parseDsl } from '../dsl';
import { currentBackend, readJson, writeJson } from './storeBackend';

/** 列表展示用的摘要，入库时算一次存下来，翻列表不用重新解析 */
export interface LibraryMeta {
  title: string;
  /** 调号，如 1=G */
  key: string;
  /** 拍号，如 4/4 */
  beat: string;
  bpm: number | null;
  measures: number;
  notes: number;
  /** 文本解析不了（导入了坏文件）：列表标红，但不拦着删 / 导出 */
  broken: boolean;
}

export interface LibraryItem {
  id: string;
  /** 曲库里的名字（可重命名），也是入库的键 */
  name: string;
  /** .jps 全文 */
  text: string;
  updatedAt: number;
  meta: LibraryMeta;
  /** 动态谱首页的「我的收藏」标记；旧数据没有这个字段，按未收藏处理 */
  favorite?: boolean;
}

const KEY = 'ws-library';
const VERSION = 1;
/** 文件后端里的清单文件名（文档结构与 localStorage 里的完全一致） */
const LIB_FILE = 'library.json';
interface LibraryDoc { version: number; items: LibraryItem[]; deletedIds?: string[] }
let deletedIds = new Set<string>();
const docOf = (items: LibraryItem[]): LibraryDoc => ({
  version: VERSION,
  items,
  deletedIds: [...deletedIds],
});

const EMPTY_META: LibraryMeta = {
  title: '',
  key: '',
  beat: '',
  bpm: null,
  measures: 0,
  notes: 0,
  broken: false,
};

// ── 纯逻辑 ────────────────────────────────────────────────

let seq = 0;
export function newId(): string {
  seq += 1;
  return `lib-${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 名字归一：去空白、去掉 .jps / .txt 后缀——「灰姑娘.jps」和「灰姑娘」是同一首 */
export function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/\.(jps|txt)$/i, '')
    .replace(/\s+/g, ' ');
}

/**
 * 重名回避：列表里已有「灰姑娘」就给「灰姑娘 (2)」。
 * 批量导入同名文件时靠它，不静默覆盖用户已有的谱。
 */
export function uniqueName(base: string, taken: string[]): string {
  const name = normalizeName(base) || '未命名';
  if (!taken.includes(name)) return name;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${name} (${n})`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${name} (${Date.now()})`;
}

/** 从 .jps 文本提取摘要；解析失败标记为 broken（导入校验用） */
export function metaOfText(text: string, fallbackName = ''): LibraryMeta {
  const fallback = normalizeName(fallbackName);
  const res = parseDsl(text);
  if (!res.score) return { ...EMPTY_META, title: fallback, broken: true };
  const meta = res.score.meta;
  const bars = res.score.events.filter((e) => e.kind === 'barline').length;
  const notes = res.score.events.filter((e) => e.kind === 'note').length;
  // 谱面开头那根线是第 1 小节的左边界，不计小节数（与 layout 的编号口径一致）
  const leading = res.score.events[0]?.kind === 'barline' ? 1 : 0;
  // 谱里没写 @title 时 title 是占位默认值，列表里应该显示文件名（更有用）
  const titled = !meta.title || meta.title === DEFAULT_META.title ? fallback : meta.title;
  return {
    title: titled || fallback || meta.title,
    key: meta.key ?? '',
    beat: meta.beat ?? '',
    bpm: typeof meta.bpm === 'number' && meta.bpm > 0 ? meta.bpm : null,
    measures: Math.max(0, bars - leading),
    notes,
    broken: false,
  };
}

/** 最近的排前面；同一毫秒入库的按名字兜底，保证顺序稳定 */
export function sortLibrary(items: LibraryItem[]): LibraryItem[] {
  return [...items].sort((a, b) =>
    b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, 'zh-Hans-CN'),
  );
}

const normalizeSearch = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f\s]/g, '');
/** 弱引用随曲库条目回收，不将索引写入存储；改名或改标题时重新生成。 */
const searchIndex = new WeakMap<LibraryItem, { name: string; title: string; terms: string[] }>();

/** 名字或标题支持汉字、全拼和首字母检索，不分大小写与声调。 */
export function searchLibrary(items: LibraryItem[], query: string): LibraryItem[] {
  const q = normalizeSearch(query);
  if (!q) return items;
  return items.filter(it => {
    const title = it.meta.title ?? '';
    let cached = searchIndex.get(it);
    if (!cached || cached.name !== it.name || cached.title !== title) {
      const terms = [...new Set([it.name, title])].flatMap(text => [normalizeSearch(text),
        normalizeSearch(pinyin(text, { toneType: 'none' })),
        normalizeSearch(pinyin(text, { pattern: 'first', toneType: 'none' }))]);
      cached = { name: it.name, title, terms };
      searchIndex.set(it, cached);
    }
    return cached.terms.some(text => text.includes(q));
  });
}

export function describeMeta(meta: LibraryMeta): string {
  const bits: string[] = [];
  if (meta.beat) bits.push(meta.beat);
  if (meta.key) bits.push(meta.key);
  if (meta.bpm) bits.push(`${meta.bpm} BPM`);
  if (meta.measures) bits.push(`${meta.measures} 小节`);
  if (meta.notes) bits.push(`${meta.notes} 音`);
  return bits.join(' · ');
}

// ── 存取 ──────────────────────────────────────────────────

/** 条目校验（读 localStorage / library.json 共用同一口径，Node 里可测） */
export function isItem(x: unknown): x is LibraryItem {
  const it = x as LibraryItem | null;
  return (
    !!it &&
    typeof it.id === 'string' &&
    typeof it.name === 'string' &&
    typeof it.text === 'string' &&
    typeof it.updatedAt === 'number' &&
    !!it.meta &&
    typeof it.meta === 'object'
  );
}

/** localStorage 里的原始文档（兜底后端用；也用于文件夹模式的首次迁移源） */
function readLocalDoc(): LibraryDoc {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { version: VERSION, items: [] };
    const doc = JSON.parse(raw) as LibraryDoc;
    if (!doc || doc.version !== VERSION || !Array.isArray(doc.items)) return { version: VERSION, items: [] };
    const deleted = validDeletedIds(doc);
    return { version: VERSION, items: sortLibrary(doc.items.filter(isItem).filter(it => !deleted.includes(it.id))), deletedIds: deleted };
  } catch {
    return { version: VERSION, items: [] };
  }
}

function validDeletedIds(doc: LibraryDoc | null): string[] {
  return Array.isArray(doc?.deletedIds) ? doc.deletedIds.filter((id): id is string => typeof id === 'string') : [];
}

function readLocal(): LibraryItem[] {
  return readLocalDoc().items;
}

/**
 * 内存缓存 + 写透：文件后端是异步的，而曲库的读取接口是同步的
 * （界面到处在用），所以启动时把 library.json 水合进内存，
 * 之后每次写 = 先改内存（同步生效）+ 异步落盘。
 * localStorage 兜底后端仍是直接读写，不经过缓存。
 */
let mem: LibraryItem[] = [];
let hydrated = false;
let pendingWrite: Promise<void> = Promise.resolve();
function persistFile(doc: LibraryDoc): Promise<void> {
  pendingWrite = writeJson(LIB_FILE, doc);
  void pendingWrite.catch(() => undefined);
  return pendingWrite;
}
export function flushLibraryWrites(): Promise<void> {
  return currentBackend() === 'local' ? Promise.resolve() : pendingWrite;
}

const listeners = new Set<() => void>();
/** 曲库内容变化（水合完成 / 任何写入成功）后通知订阅者 */
export function onLibraryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * 纯函数：把「断连期间写进 localStorage」的条目合并进文件夹的清单。
 * 按 id 对齐：文件夹里没有的补上；两边都有取 updatedAt 新的那个。
 * 这是文件夹授权失效又重连之后数据不分家的关键（Node 里可直接测）。
 */
export function mergeLibrary(
  folder: LibraryItem[],
  local: LibraryItem[],
): { merged: LibraryItem[]; added: number } {
  const byId = new Map(folder.map((it) => [it.id, it]));
  let added = 0;
  for (const it of local) {
    const hit = byId.get(it.id);
    if (!hit || it.updatedAt > hit.updatedAt) {
      if (!hit) added += 1;
      byId.set(it.id, it);
    }
  }
  return { merged: sortLibrary([...byId.values()]), added };
}

/**
 * 启动水合：文件后端读 library.json 进内存。
 *   - 文件夹还没有库 → 把 localStorage 里的曲库整份迁过去（首次升级不丢歌）
 *   - 文件夹有库但本地有它缺的条目 → 合并（授权失效那段时间写进本地的歌救回来）
 */
export async function hydrateLibrary(): Promise<void> {
  let local = readLocalDoc();
  if (currentBackend() === 'local') {
    deletedIds = new Set(validDeletedIds(local));
    hydrated = true;
    notify();
    return;
  }
  await pendingWrite.catch(() => undefined);
  const doc = (await readJson(LIB_FILE)) as LibraryDoc | null;
  local = readLocalDoc();
  deletedIds = new Set([...validDeletedIds(local), ...validDeletedIds(doc)]);
  const folder = doc?.version === VERSION && Array.isArray(doc.items) ? doc.items.filter(isItem) : [];
  mem = mergeLibrary(folder, local.items).merged.filter(it => !deletedIds.has(it.id));
  const mergedDoc = docOf(mem);
  try {
    localStorage.setItem(KEY, JSON.stringify(mergedDoc));
  } catch {
    /* 文件后端仍可独立保存 */
  }
  if (JSON.stringify(doc) !== JSON.stringify(mergedDoc)) {
    await persistFile(mergedDoc).catch(() => undefined);
  }
  hydrated = true;
  notify();
}

export function readLibrary(): LibraryItem[] {
  if (currentBackend() === 'local') return readLocal();
  if (!hydrated) return []; // 还没水合完：先当空库，水合完会 notify
  return mem;
}

function writeLibrary(items: LibraryItem[]): boolean {
  const sorted = sortLibrary(items);
  // 断连期间的删除记录也要带回文件夹，旧备份不能再次补回已删除条目。
  for (const id of validDeletedIds(readLocalDoc())) deletedIds.add(id);
  const doc = docOf(sorted);
  if (currentBackend() === 'local') {
    try {
      localStorage.setItem(KEY, JSON.stringify(doc));
    } catch {
      return false;
    }
  } else {
    mem = sorted;
    try {
      localStorage.setItem(KEY, JSON.stringify(doc));
    } catch {
      /* 文件后端仍可独立保存 */
    }
    void persistFile(doc);
  }
  notify();
  return true;
}

/**
 * 入库：**同名（归一后）覆盖内容**，否则新增。
 * 这是曲库和「另存为」最大的区别——反复保存同一首不会攒出一堆副本。
 */
export function upsertLibrary(name: string, text: string, now = Date.now()): LibraryItem | null {
  const nm = normalizeName(name) || '未命名';
  const items = readLibrary();
  const hit = items.find((it) => it.name === nm);
  const item: LibraryItem = {
    id: hit?.id ?? newId(),
    name: nm,
    text,
    updatedAt: now,
    meta: metaOfText(text, nm),
    // 重新保存同一首**不能把收藏弄丢**：内容变了不代表用户不想它了
    ...(hit?.favorite ? { favorite: true } : {}),
  };
  const next = hit ? items.map((it) => (it.id === hit.id ? item : it)) : [...items, item];
  return writeLibrary(next) ? item : null;
}

/** 导入外部文件用：不覆盖同名项，自动取「 xxx (2)」 */
export function importLibrary(rawName: string, text: string, now = Date.now()): LibraryItem | null {
  const items = readLibrary();
  const nm = uniqueName(rawName, items.map((it) => it.name));
  const item: LibraryItem = {
    id: newId(),
    name: nm,
    text,
    updatedAt: now,
    meta: metaOfText(text, nm),
  };
  return writeLibrary([...items, item]) ? item : null;
}

export function removeLibraryItem(id: string): boolean {
  const items = readLibrary();
  const next = items.filter((it) => it.id !== id);
  if (next.length === items.length) return false;
  deletedIds.add(id);
  if (writeLibrary(next)) return true;
  deletedIds.delete(id);
  return false;
}

/**
 * 撤销删除：把刚删掉的那条原样放回去（id、名字、收藏、时间戳都不动）。
 * 删除是低频但不可逆的操作，撤销窗口就那几秒，所以直接用内存里留存的 item。
 */
export function restoreLibraryItem(item: LibraryItem): boolean {
  deletedIds.delete(item.id); // 撤销 = 这条不再算「被删」，否则导入 / 同步时又被当成已删剔除
  const items = readLibrary();
  if (items.some((it) => it.id === item.id)) return true; // 已经在了（重复点撤销）
  const next = [...items, item].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return writeLibrary(next);
}

/** 收藏 / 取消收藏（动态谱首页的「我的收藏」） */
export function setFavorite(id: string, on: boolean): boolean {
  const items = readLibrary();
  const target = items.find((it) => it.id === id);
  if (!target) return false;
  if (!!target.favorite === on) return true;
  return writeLibrary(
    items.map((it) => (it.id === id ? { ...it, favorite: on } : it)),
  );
}

/**
 * 按**条目 id**回写内容（保存时用）。
 * 与 upsertLibrary 的区别：它只改「这一条」，不会按歌名新建 / 覆盖——
 * 保存一份从磁盘打开的谱时，不该悄悄塞进曲库，更不该盖掉同名但另一首的曲子。
 */
export function updateLibraryItem(id: string, text: string, now = Date.now()): boolean {
  const items = readLibrary();
  const target = items.find((it) => it.id === id);
  if (!target) return false;
  return writeLibrary(
    items.map((it) => (it.id === id ? { ...it, text, updatedAt: now, meta: metaOfText(text, it.name) } : it)),
  );
}

/** 重命名；目标名已被别人占用时不动，返回 false 让界面提示 */
export function renameLibraryItem(id: string, name: string, now = Date.now()): boolean {
  const nm = normalizeName(name);
  if (!nm) return false;
  const items = readLibrary();
  const target = items.find((it) => it.id === id);
  if (!target) return false;
  if (items.some((it) => it.id !== id && it.name === nm)) return false;
  return writeLibrary(
    items.map((it) => (it.id === id ? { ...it, name: nm, updatedAt: now } : it)),
  );
}

// ── React 侧 ────────────────────────────────────────────────

/**
 * 订阅式曲库列表：后端水合完成 / 任何写入都会让组件重读。
 * 文件后端的水合是异步的——不订阅的话首屏会一直显示空库。
 */
export function useLibraryItems(): LibraryItem[] {
  const [items, setItems] = useState<LibraryItem[]>(() => readLibrary());
  useEffect(() => onLibraryChange(() => setItems(readLibrary())), []);
  return items;
}
