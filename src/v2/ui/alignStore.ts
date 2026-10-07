/**
 * 音频对齐参数的本地持久化（用户选定的功能）：
 *
 *   - **对齐参数**（BPM / 相位 / 原点 / 锚点 / 曲线 / 播放源）
 *       文件后端 → `align.json`（一张「谱面名 → 参数」总表，标定跟着曲库文件夹走）
 *       浏览器兜底 → localStorage（`ws-align:<谱面名>`）
 *   - **伴奏音频文件本体**
 *       文件后端 → `audio/<编码后的键>`（键含 `:` 与中文，encodeURIComponent 后各平台都合法）
 *       浏览器兜底 → IndexedDB
 *
 * 键仍是「文件名:字节数」：同名同大小的文件视为同一份，多首谱引用只存一份。
 * 刷新 / 关掉重开 / 换谱回来自动恢复；存储不可用时静默降级，
 * 内存里的对齐照常工作，只是刷新后要重来。
 */

import { currentBackend, readBytes, readJson, writeBytes, writeJson } from './storeBackend';

export interface AudioRef {
  /** IndexedDB 里的键：`文件名:字节数` */
  key: string;
  /** 展示用文件名 */
  name: string;
}

export interface AlignPersist {
  version: 1;
  audio: AudioRef[];
  tempoDraft: { bpm: number; phaseSec: number; originBeat: number };
  anchors: { scoreBeat: number; audioBeat: number }[];
  /** TempoMap 的 JSON 形态（constant / curve），恢复时经 tempoFromAlign 校验 */
  override: unknown | null;
  playSource: 'synth' | 'audio';
  /**
   * 每次播放放哪几条（与 stems 同序）。缺省 / 缺项 = 全放。
   * 打包时一起带走：别人导入后默认就是同一套混音。
   */
  stemOn?: boolean[];
}

/** 伴奏文件的存储键：同名同大小的文件视为同一份 */
export const audioKey = (f: { name: string; size: number }): string => `${f.name}:${f.size}`;

const alignKey = (scoreName: string): string => `ws-align:${scoreName}`;

/** align.json 的文档形态：谱面名 → 参数（文件后端只有这一个文件） */
const ALIGN_FILE = 'align.json';

function isPersist(x: unknown): x is AlignPersist {
  const d = x as AlignPersist | null;
  return !!d && d.version === 1 && Array.isArray(d.audio);
}

/** 纯函数：把读出来的 align.json 校验成 Map（坏条目跳过），Node 里可直接测 */
export function alignMapFrom(doc: unknown): Map<string, AlignPersist> {
  const out = new Map<string, AlignPersist>();
  if (doc && typeof doc === 'object') {
    for (const [name, v] of Object.entries(doc as Record<string, unknown>)) {
      if (isPersist(v)) out.set(name, v);
    }
  }
  return out;
}

/** 内存缓存：文件后端的写入是异步的，而 loadAlign 的调用点全是同步 */
const alignMem = new Map<string, AlignPersist>();
let hydrated = false;

/** 启动水合：把 align.json 读进内存（兜底后端无事可做） */
export async function hydrateAlign(): Promise<void> {
  if (currentBackend() === 'local') {
    hydrated = true;
    return;
  }
  alignMem.clear();
  for (const [name, data] of alignMapFrom(await readJson(ALIGN_FILE))) alignMem.set(name, data);
  hydrated = true;
}

function writeThrough(): void {
  void writeJson(ALIGN_FILE, Object.fromEntries(alignMem)).catch(() => undefined);
}

export function saveAlign(scoreName: string, data: AlignPersist): void {
  if (currentBackend() === 'local') {
    try {
      localStorage.setItem(alignKey(scoreName), JSON.stringify(data));
    } catch {
      /* 配额满 / 隐私模式：存不了就算了 */
    }
    return;
  }
  alignMem.set(scoreName, data);
  writeThrough();
}

export function loadAlign(scoreName: string): AlignPersist | null {
  if (currentBackend() === 'local') {
    try {
      const raw = localStorage.getItem(alignKey(scoreName));
      if (!raw) return null;
      const data = JSON.parse(raw) as AlignPersist;
      return data && data.version === 1 ? data : null;
    } catch {
      return null;
    }
  }
  // 水合没跑完的窗口期（启动后几十毫秒）先看 localStorage：
  // Web 文件夹模式之前兜底攒下的标定不能在这一瞬间「丢」
  return alignMem.get(scoreName) ?? (hydrated ? null : readLocalAlign(scoreName));
}

function readLocalAlign(scoreName: string): AlignPersist | null {
  try {
    const raw = localStorage.getItem(alignKey(scoreName));
    if (!raw) return null;
    const data = JSON.parse(raw) as AlignPersist;
    return data && data.version === 1 ? data : null;
  } catch {
    return null;
  }
}

export function clearAlign(scoreName: string): void {
  if (currentBackend() === 'local') {
    try {
      localStorage.removeItem(alignKey(scoreName));
    } catch {
      /* 忽略 */
    }
    return;
  }
  alignMem.delete(scoreName);
  writeThrough();
}

// ── 伴奏文件本体 ────────────────────────────────────────────
// 键 = 「文件名:字节数」。做文件名时把键整体 encodeURIComponent：
// `:`、中文、空格全变成 %XX，Windows / macOS / Linux 的文件系统都合法且可逆

/** 纯函数：存储键 → 文件后端里的相对路径（Node 里可直接测） */
export function audioFileOf(key: string): string {
  return `audio/${encodeURIComponent(key)}`;
}

/** 纯函数：从键取展示用文件名（`名字:字节数` → `名字`） */
export function audioNameOf(key: string): string {
  const i = key.lastIndexOf(':');
  return i > 0 ? key.slice(0, i) : key;
}

export async function putAudio(key: string, file: File): Promise<void> {
  if (currentBackend() !== 'local') {
    try {
      await writeBytes(audioFileOf(key), new Uint8Array(await file.arrayBuffer()));
      return;
    } catch {
      return; // 写不进就不写（曲库清单里的引用还在，音频缺失时提示重新载入）
    }
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(file, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* 存不了就不存 */
  }
}

export async function getAudio(key: string): Promise<File | null> {
  if (currentBackend() !== 'local') {
    const bytes = await readBytes(audioFileOf(key));
    // 复制一份再交给 Blob：Uint8Array<ArrayBufferLike> 不是 BlobPart（io.ts 同款处理）
    return bytes ? new File([new Uint8Array(bytes)], audioNameOf(key)) : null;
  }
  try {
    const db = await openDb();
    const file = await new Promise<File | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as File | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return file;
  } catch {
    return null;
  }
}

// ── 浏览器兜底的 IndexedDB（音频文件本体）────────────────────

const DB_NAME = 'windscore-align';
const STORE = 'audio';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
