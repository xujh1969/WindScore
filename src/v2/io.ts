/**
 * 文件读写（§12.1）：.jps 为 DSL 文本，可直接落盘。
 * Tauri 下走对话框 + fs；浏览器预览下退化为下载 / 文件选择框。
 */

import { parseDsl, serializeDsl } from './dsl';
import type { Score } from './types';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_IPC__' in window;
}

export interface OpenResult {
  name: string;
  score: Score | null;
  errors: string[];
  /** 真实文件路径；浏览器下用文件选择框，拿不到路径 */
  path: string | null;
}

export interface SaveResult {
  ok: boolean;
  /** 真实落盘路径。浏览器只能触发下载，拿不到路径，为 null */
  path: string | null;
}

/**
 * 保存。
 * Tauri 下弹保存对话框并拿到真实路径；浏览器下退化为下载。
 * 调用方不要假设浏览器返回的那个名字是路径——它只是建议文件名。
 */
export async function saveScore(score: Score, suggested: string): Promise<SaveResult> {
  if (score.events.length === 0 && !score.parts?.some((p) => p.events.length)) return { ok: false, path: null };
  return saveTextAsFile(serializeDsl(score), suggested);
}

/** 二进制落盘的默认参数（曲库打包 = .wspack） */
export interface BytesFileOptions {
  /** 扩展名（不含点），默认 wspack */
  ext?: string;
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
    const fs = await import('@tauri-apps/api/fs');
    const path = await dialog.save({
      defaultPath: suggested,
      filters: [{ name: opts.label ?? 'WindScore 打包', extensions: [ext] }],
    });
    if (!path) return { ok: false, path: null };
    await fs.writeBinaryFile(path, bytes);
    return { ok: true, path };
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
  return { name, score: res.score, errors: res.errors, path };
}
