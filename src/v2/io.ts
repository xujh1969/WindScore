/**
 * 文件读写（§12.1）：.jps 为 DSL 文本，可直接落盘。
 * Tauri 下走对话框 + fs；浏览器预览下退化为下载 / 文件选择框。
 */

import { parseDsl, serializeDsl } from './dsl';
import type { Score } from './types';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_IPC__' in window;
}

/**
 * File System Access API 的文件句柄（Chrome / Edge 桌面版）。
 * TS 的 lib.dom 里没有这套类型，这里只声明用得到的最小面——
 * 有了它，浏览器里也能**原地写回**打开的那个文件，不必每次都下载新副本。
 */
export interface FsFileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  queryPermission?(desc: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(desc: { mode: 'readwrite' }): Promise<PermissionState>;
}

type FsWindow = Window & {
  showOpenFilePicker?: (opts?: {
    multiple?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FsFileHandle[]>;
  showSaveFilePicker?: (opts?: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FsFileHandle>;
};

export interface OpenResult {
  name: string;
  /** 解析失败时仍保留原文，供编辑器打开源码修复，不能用部分解析结果覆盖它。 */
  text?: string;
  score: Score | null;
  errors: string[];
  /** 真实文件路径；浏览器下用文件选择框，拿不到路径 */
  path: string | null;
  /** 浏览器下用 File System Access API 打开时拿到的句柄（之后可原地写回） */
  handle?: FsFileHandle | null;
}

export interface SaveResult {
  ok: boolean;
  /** 真实落盘路径。浏览器只能触发下载，拿不到路径，为 null */
  path: string | null;
  /** 是不是**原地写回了原文件**（区别于下载一个新副本） */
  inPlace?: boolean;
  /** 浏览器端「另存为」拿到的新句柄：调用方记住它，下次就能静默覆盖 */
  handle?: FsFileHandle | null;
  /**
   * 分段耗时（ms）：定位「保存慢」到底慢在哪。
   * pick = 等系统「另存为」对话框的时间（属用户操作时间，不是计算慢）。
   */
  ms?: { serialize: number; write: number; pick?: number };
  /** 这次是不是**弹了另存为对话框**才拿到落点 */
  viaDialog?: boolean;
}

/** 浏览器是否支持「打开时拿到句柄、之后原地写回」（Chrome / Edge 桌面版） */
export function canWriteInPlace(): boolean {
  return typeof window !== 'undefined' && typeof (window as FsWindow).showOpenFilePicker === 'function';
}

/**
 * 保存。
 * Tauri 下弹保存对话框并拿到真实路径；浏览器下**有句柄就原地写回**打开的那个
 * 文件（File System Access API），没有句柄才退化成下载。
 * 调用方不要假设浏览器返回的那个名字是路径——它只是建议文件名 / 句柄名。
 */
export async function saveScore(
  score: Score | string,
  suggested: string,
  handle: FsFileHandle | null = null,
): Promise<SaveResult> {
  if (typeof score !== 'string' && score.events.length === 0 && !score.parts?.some((p) => p.events.length)) return { ok: false, path: null };
  // 计时只为定位「保存慢」到底慢在哪一步（浏览器里用户等对话框的时间也算在内）
  const t0 = performance.now();
  const text = typeof score === 'string' ? score : serializeDsl(score);
  const tSer = performance.now() - t0;
  // ① 有句柄（用「打开」进来的，或上次另存过）→ 直接改原文件，全程无对话框
  if (handle) {
    const t1 = performance.now();
    const ok = await writeToHandle(handle, text);
    const write = performance.now() - t1;
    console.debug(`[io] 序列化 ${tSer.toFixed(0)}ms；原地写回 ${ok ? '成功' : '失败'} ${write.toFixed(0)}ms`, handle.name);
    if (ok) return { ok: true, path: handle.name, inPlace: true, ms: { serialize: tSer, write } };
  }
  // ② 没句柄但浏览器支持 → 弹一次「存到哪」，拿到句柄后这次就写进去，
  //    调用方记住它，之后按保存都是静默覆盖（不用每次都下载新副本）
  const t2 = performance.now();
  const picked = await pickSaveHandle(suggested);
  const pick = performance.now() - t2;
  console.debug(`[io] 另存为对话框 ${pick.toFixed(0)}ms，拿到句柄=${!!picked}`);
  if (picked) {
    const t3 = performance.now();
    if (await writeToHandle(picked, text)) {
      return { ok: true, path: picked.name, inPlace: true, handle: picked, viaDialog: true, ms: { serialize: tSer, write: performance.now() - t3, pick } };
    }
  }
  const t4 = performance.now();
  const r = await saveTextAsFile(text, suggested);
  console.debug(`[io] 下载落盘 ${(performance.now() - t4).toFixed(0)}ms`);
  return { ...r, ms: { serialize: tSer, write: performance.now() - t4 } };
}

/** 浏览器「另存为」：拿一个可写句柄；不支持 / 用户取消 → null */
async function pickSaveHandle(suggested: string): Promise<FsFileHandle | null> {
  const win = window as FsWindow;
  if (typeof win.showSaveFilePicker !== 'function') return null;
  try {
    return await win.showSaveFilePicker({
      suggestedName: suggested,
      types: [{ description: 'WindScore 谱面', accept: { 'text/plain': ['.jps'] } }],
    });
  } catch {
    return null; // 用户在系统对话框里取消
  }
}

/**
 * 已经写成功过的句柄：下次不用再走 queryPermission / requestPermission 那一问一答，
 * 直接开写（浏览器这趟往返在部分机器上要几十到几百毫秒，且每次保存都要走）。
 * 写失败就把缓存撤掉，退回完整的权限流程。
 */
const grantedHandles = new WeakSet<FsFileHandle>();

/** 原地写回：权限没给或被拒就返回 false（调用方退回下载 / 另存为，不静默失败） */
async function writeToHandle(handle: FsFileHandle, text: string): Promise<boolean> {
  const t0 = performance.now();
  let label = '权限';
  try {
    if (!grantedHandles.has(handle)) {
      const perm = handle.queryPermission ? await handle.queryPermission({ mode: 'readwrite' }) : 'granted';
      if (perm === 'prompt' && handle.requestPermission) {
        if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
      } else if (perm !== 'granted') {
        return false;
      }
    }
    const t1 = performance.now();
    label = '打开写入流';
    const w = await handle.createWritable();
    const t2 = performance.now();
    label = '写入 + 关闭';
    await w.write(text);
    await w.close();
    const t3 = performance.now();
    // 分段打出来才能定位「保存 7 秒」卡在哪一环：
    //   权限慢 = 浏览器的一问一答；打开/写入慢 = 磁盘慢或杀软 / 同步工具在拖
    console.debug(
      `[io] 写回分段 ${handle.name}：权限 ${(t1 - t0).toFixed(0)}ms / 打开写入流 ${(t2 - t1).toFixed(0)}ms / 写入+关闭 ${(t3 - t2).toFixed(0)}ms`,
    );
    grantedHandles.add(handle);
    return true;
  } catch (e) {
    console.debug(`[io] 写回失败（${label} 阶段）`, e);
    grantedHandles.delete(handle);
    return false;
  }
}

/** 二进制落盘的默认参数（曲库打包 = .wspack） */
export interface BytesFileOptions {
  /** 扩展名（不含点），默认 wspack */
  ext?: string;
  /**
   * 写盘进度（Tauri 分块写时按字节报；浏览器下载没有进度，不回调）。
   * 视频几十上百 MB，没有这条进度用户会以为卡死。
   */
  onWriteProgress?: (done: number, total: number) => void;
  /** MIME，默认按 zip */
  mime?: string;
  /** 保存对话框里的过滤器名 */
  label?: string;
}

/** 把二进制存成文件（曲库打包 .wspack、导出 PDF / 视频都走这里） */
export async function saveBytesAsFile(
  bytes: Uint8Array,
  suggested: string,
  opts: BytesFileOptions = {},
): Promise<SaveResult> {
  const ext = opts.ext ?? 'wspack';
  const mime = opts.mime ?? 'application/zip';
  if (isTauri()) {
    const dialog = await import('@tauri-apps/api/dialog');
    const { invoke } = await import('@tauri-apps/api/tauri');
    const pickAt = performance.now();
    const path = await dialog.save({
      defaultPath: suggested,
      filters: [{ name: opts.label ?? 'WindScore 打包', extensions: [ext] }],
    });
    if (!path) return { ok: false, path: null };
    const pickMs = performance.now() - pickAt;
    const writeAt = performance.now();
    let base64Ms = 0;
    let ipcMs = 0;
    // 不用 fs.writeBinaryFile：它把整个字节按 **JSON 数字数组** 走 IPC，
    // 视频几百 MB 的 JSON 会把 WebView 主线程冻住几分钟（用户实测：选完
    // 保存位置就卡死）。改为分块 base64 → Rust 命令解码写盘，界面保持响应。
    const CHUNK = 3 * 1024 * 1024; // 3MB 原始字节 ≈ 4MB base64，一趟能扛住
    const writeChunk = async (data: Uint8Array, create: boolean, append: boolean): Promise<void> => {
      const encodeAt = performance.now();
      const dataBase64 = await toBase64(data);
      base64Ms += performance.now() - encodeAt;
      const ipcAt = performance.now();
      await invoke('write_file_chunk', { path, dataBase64, create, append });
      ipcMs += performance.now() - ipcAt;
    };
    if (bytes.length === 0) {
      await writeChunk(new Uint8Array(0), true, false);
      return { ok: true, path };
    }
    let first = true;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, bytes.length);
      await writeChunk(bytes.subarray(off, end), first, !first);
      first = false;
      opts.onWriteProgress?.(end, bytes.length);
    }
    const writeMs = performance.now() - writeAt;
    console.info('[io] binary write timing ms', { bytes: bytes.length, base64: Math.round(base64Ms), ipcAndDisk: Math.round(ipcMs), write: Math.round(writeMs), pick: Math.round(pickMs) });
    return { ok: true, path, ms: { serialize: base64Ms, write: writeMs, pick: pickMs } };
  }

  // 复制一份再交给 Blob：Uint8Array<ArrayBufferLike> 不是 BlobPart
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggested;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return { ok: true, path: null };
}

/** Native asynchronous conversion avoids spreading millions of bytes into JS strings on the UI thread. */
function toBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('文件编码失败'));
    reader.readAsDataURL(new Blob([new Uint8Array(bytes)]));
  });
}

/** 把一段文本直接存成文件（曲库导出用：手上只有文本，不一定有 Score 对象） */
export async function saveTextAsFile(text: string, suggested: string): Promise<SaveResult> {
  if (isTauri()) {
    const dialog = await import('@tauri-apps/api/dialog');
    const fs = await import('@tauri-apps/api/fs');
    const path = await dialog.save({
      defaultPath: suggested,
      filters: [{ name: 'WindScore 谱面', extensions: ['jps'] }],
    });
    if (!path) return { ok: false, path: null };
    await fs.writeTextFile(path, text);
    return { ok: true, path };
  }

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggested;
  a.click();
  // 立即 revoke 会让部分浏览器取消下载，等一拍再释放
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return { ok: true, path: null };
}

/**
 * 浏览器下打开（File System Access API）：除了内容还拿到**文件句柄**，
 * 之后按保存就是改原文件本身，不再每次下载一个新副本。
 * 用户取消会抛 AbortError——调用方据此决定要不要回退到 <input>。
 */
export async function openScoreViaFsAccess(): Promise<OpenResult | null> {
  if (!canWriteInPlace()) return null;
  const win = window as FsWindow;
  const picked = await win.showOpenFilePicker!({
    multiple: false,
    types: [{ description: 'WindScore 谱面', accept: { 'text/plain': ['.jps', '.txt'] } }],
  });
  const handle = picked?.[0];
  if (!handle) return null;
  const text = await (await handle.getFile()).text();
  return { ...fromText(text, handle.name.replace(/\.(jps|txt)$/i, '')), handle };
}

/** 打开（仅 Tauri；浏览器用 <input type="file">） */
export async function openScoreViaDialog(): Promise<OpenResult | null> {
  if (!isTauri()) return null;
  const dialog = await import('@tauri-apps/api/dialog');
  const fs = await import('@tauri-apps/api/fs');
  const picked = await dialog.open({
    multiple: false,
    filters: [{ name: 'WindScore 谱面', extensions: ['jps', 'txt'] }],
  });
  if (!picked || Array.isArray(picked)) return null;
  const text = await fs.readTextFile(picked);
  return fromText(text, nameOf(picked), picked);
}

export function nameOf(path: string): string {
  return path.split(/[\\/]/).pop()?.replace(/\.(jps|txt)$/i, '') ?? '本地谱';
}

export function fromText(text: string, name: string, path: string | null = null): OpenResult {
  const res = parseDsl(text);
  return { name, text, score: res.errors.length ? null : res.score, errors: res.errors, path };
}
