/**
 * 曲库存储后端：同一份数据格式（library.json + align.json + audio/），
 * 三个后端按运行环境选择——
 *
 *   tauri   exe 版：写应用数据目录（Windows 是 %APPDATA%），随程序走
 *   folder  Web 开发模式：File System Access API，用户选一个真实文件夹，
 *           Web 下读写的就是磁盘文件，与 exe 版**数据格式完全一致**
 *   local   浏览器兜底：localStorage + IndexedDB（老浏览器 / 没选文件夹）
 *
 * 后端只提供文件原语（readJson / writeJson / readBytes / writeBytes）；
 * 数据的水合与缓存在 libraryStore / alignStore 里。
 * 「迁移整个曲库」= 拷贝这个文件夹，Web 与 exe 通用。
 */

import { isTauri } from '../io';

// ── FS Access 的最小类型（不依赖 lib.dom 版本，够用即可）────────
interface WritableLike {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
}
interface FileHandleLike {
  getFile(): Promise<File>;
  createWritable(): Promise<WritableLike>;
}
interface DirHandleLike {
  kind: 'directory';
  name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike>;
  removeEntry?(name: string, opts?: { recursive?: boolean }): Promise<void>;
  queryPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>;
}

export type StoreBackend = 'tauri' | 'folder' | 'local';

let backend: StoreBackend = 'local';
let rootDir: DirHandleLike | null = null; // folder 模式的根句柄
let tauriRoot = ''; // tauri 模式的数据目录
/** 存过文件夹但这次会话还没拿到授权：点一下「重新连接」就能续上 */
let pendingPerm = false;
/** 已连接的文件夹名（界面展示用） */
export let folderName = '';

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

/** 界面订阅后端状态变化（连接 / 断开 / 待授权） */
export function onStoreBackendChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentBackend(): StoreBackend {
  return backend;
}

/** 存过文件夹但这次会话还没授权（浏览器重启后）：给「重新连接」按钮用 */
export function isPending(): boolean {
  return pendingPerm;
}

/** 文件夹句柄的持久化（IndexedDB 存 handle，刷新后还能续） */
const HANDLE_DB = 'windscore-store';
const HANDLE_STORE = 'handles';
function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveHandle(dir: DirHandleLike): Promise<void> {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(dir, 'root');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function loadHandle(): Promise<DirHandleLike | null> {
  const db = await openHandleDb();
  const dir = await new Promise<DirHandleLike | null>((resolve, reject) => {
    const req = db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).get('root');
    req.onsuccess = () => resolve((req.result as DirHandleLike | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return dir;
}

/** Web：让用户挑一个文件夹当曲库（Chrome / Edge） */
export async function pickLibraryFolder(): Promise<void> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (o?: { mode?: 'readwrite' }) => Promise<DirHandleLike>;
    }
  ).showDirectoryPicker;
  if (!picker) throw new Error('这个浏览器不支持文件夹模式——请用 Chrome 或 Edge');
  const dir = await picker({ mode: 'readwrite' });
  await saveHandle(dir);
  rootDir = dir;
  folderName = dir.name;
  pendingPerm = false;
  backend = 'folder';
  notify();
}

/** 待授权的文件夹：必须由用户手势触发 requestPermission */
export async function reconnectFolder(): Promise<boolean> {
  if (!rootDir) return false;
  const p = await rootDir.requestPermission?.({ mode: 'readwrite' });
  if (p === 'granted') {
    pendingPerm = false;
    backend = 'folder';
    folderName = rootDir.name;
    notify();
    return true;
  }
  return false;
}

/**
 * 浏览器重启后文件夹授权会变回「待确认」——曲库静默退回 localStorage，
 * 用户以为还在往文件夹里写，其实数据分了家（实测的坑）。
 * 这里挂**一次性**的交互监听：用户点一下 / 按任意键就静默续权并重连，
 * 大多数时候无感；被拒绝就保持兜底，曲库页仍有「重新连接」按钮。
 */
export function armAutoReconnect(onConnected: () => void): void {
  if (!pendingPerm || !rootDir) return;
  const tryGrant = (): void => {
    document.removeEventListener('pointerdown', tryGrant);
    document.removeEventListener('keydown', tryGrant);
    if (!pendingPerm || !rootDir) return;
    void (async () => {
      try {
        const p = await rootDir.requestPermission?.({ mode: 'readwrite' });
        if (p === 'granted') {
          pendingPerm = false;
          backend = 'folder';
          folderName = rootDir.name;
          notify();
          onConnected();
        }
      } catch {
        /* 用户拒绝 / 浏览器不支持：留在兜底模式 */
      }
    })();
  };
  document.addEventListener('pointerdown', tryGrant);
  document.addEventListener('keydown', tryGrant);
}

/** 启动探测：能接上文件夹 / Tauri 目录就接上（数据水合在 storeInit 里做） */
export async function detectBackend(): Promise<void> {
  if (isTauri()) {
    try {
      const path = await import('@tauri-apps/api/path');
      tauriRoot = await path.dataDir();
      backend = 'tauri';
    } catch {
      backend = 'local';
    }
    return;
  }
  try {
    const dir = await loadHandle();
    if (dir?.queryPermission) {
      if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') {
        rootDir = dir;
        folderName = dir.name;
        backend = 'folder';
      } else {
        pendingPerm = true;
      }
    }
  } catch {
    /* 没存过 handle 或 IDB 不可用：local */
  }
}

// ── 文件原语 ────────────────────────────────────────────────
// rel 用 / 分隔（'library.json'、'audio/<key>'），各后端自己换算

function folderBackend(): DirHandleLike {
  if (backend !== 'folder' || !rootDir) throw new Error('曲库文件夹未连接');
  return rootDir;
}

async function fileIn(rel: string, create: boolean): Promise<FileHandleLike> {
  const parts = rel.split('/');
  let dir = folderBackend();
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return dir.getFileHandle(parts[parts.length - 1]!, { create });
}

function tauriPath(rel: string): Promise<string> {
  return import('@tauri-apps/api/path').then((p) => p.join(tauriRoot, ...rel.split('/')));
}

/** 写文件前确保子目录存在（Tauri 的 createDir 递归建） */
async function ensureTauriDir(rel: string): Promise<void> {
  const parts = rel.split('/');
  if (parts.length < 2) return;
  const fs = await import('@tauri-apps/api/fs');
  const path = await import('@tauri-apps/api/path');
  await fs.createDir(await path.join(tauriRoot, ...parts.slice(0, -1)), { recursive: true });
}

export async function writeJson(rel: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data);
  if (backend === 'folder') {
    const fh = await fileIn(rel, true);
    const w = await fh.createWritable();
    await w.write(new TextEncoder().encode(text));
    await w.close();
    return;
  }
  if (backend === 'tauri') {
    const fs = await import('@tauri-apps/api/fs');
    await ensureTauriDir(rel);
    await fs.writeTextFile(await tauriPath(rel), text);
  }
}

export async function readJson(rel: string): Promise<unknown | null> {
  try {
    if (backend === 'folder') {
      const fh = await fileIn(rel, false);
      const text = await (await fh.getFile()).text();
      return text ? (JSON.parse(text) as unknown) : null;
    }
    if (backend === 'tauri') {
      const fs = await import('@tauri-apps/api/fs');
      const p = await tauriPath(rel);
      if (!(await fs.exists(p))) return null;
      return JSON.parse(await fs.readTextFile(p)) as unknown;
    }
  } catch {
    return null; // 文件不存在 / 坏了：当没有
  }
  return null;
}

export async function writeBytes(rel: string, bytes: Uint8Array): Promise<void> {
  if (backend === 'folder') {
    const fh = await fileIn(rel, true);
    const w = await fh.createWritable();
    await w.write(new Uint8Array(bytes)); // 复制一份：bytes 可能来自共享缓冲
    await w.close();
    return;
  }
  if (backend === 'tauri') {
    const fs = await import('@tauri-apps/api/fs');
    await ensureTauriDir(rel);
    await fs.writeBinaryFile(await tauriPath(rel), bytes);
  }
}

export async function readBytes(rel: string): Promise<Uint8Array | null> {
  try {
    if (backend === 'folder') {
      const fh = await fileIn(rel, false);
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    }
    if (backend === 'tauri') {
      const fs = await import('@tauri-apps/api/fs');
      return new Uint8Array(await fs.readBinaryFile(await tauriPath(rel)));
    }
  } catch {
    return null;
  }
  return null;
}
