/**
 * `.wspack` 打包：**一首歌 = 一个文件**（谱面 + 对轨标定 + 伴奏分轨）。
 *
 * 为什么要有它：.jps 只是谱面文本，伴奏音频与标定（BPM / 相位 / 原点 / 锚点）
 * 都留在本机浏览器里——把 .jps 发给别人，对方拿到的是一份没伴奏、没对过轨的谱。
 * 打包成一个文件后：
 *   - 曲库**导入打包**即可把谱面、伴奏、标定一起收进来（别人发过来的也能用）；
 *   - 曲库里每首都能**打包导出**，便于备份与分享。
 *
 * 容器是标准 zip（见 pack.ts，store 方式不压缩），任何解压软件都能打开看内容：
 *   manifest.json   清单（版本 / 曲名 / 标定 / 分轨列表）
 *   score.jps       谱面
 *   audio/…         伴奏分轨（可多条）
 */

import { unzip, zipStore, type ZipEntry } from '../pack';
import { ensureMp3 } from '../mp3';
import type { AlignPersist } from './alignStore';

export const PACK_FORMAT = 'windscore-pack';
export const PACK_VERSION = 1;
export const PACK_EXT = '.wspack';

interface PackManifest {
  format: string;
  version: number;
  /** 曲库里的名字（导入后就是它，可被重命名） */
  name: string;
  savedAt: number;
  /** 谱面在包内的路径 */
  score: string;
  /** 对轨标定（整份存档原样带过来）；没标定过就是 null */
  align: AlignPersist | null;
  stems: { name: string; path: string }[];
}

export interface PackStem {
  name: string;
  file: File;
}

export interface PackBundle {
  name: string;
  text: string;
  align: AlignPersist | null;
  stems: PackStem[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 曲名里的路径分隔符等不该进文件名 */
export function packFileName(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]+/g, '_').trim() || '未命名'}${PACK_EXT}`;
}

/** 包内音频路径：去掉目录，撞名加序号 */
function stemPath(name: string, used: Set<string>): string {
  const base = name.split(/[\\/]/).pop() || 'audio';
  let path = `audio/${base}`;
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let n = 2; n < 100; n += 1) {
    path = `audio/${stem} (${n})${ext}`;
    if (!used.has(path)) {
      used.add(path);
      return path;
    }
  }
  return path;
}

function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'm4a' || ext === 'aac') return 'audio/mp4';
  return ext === 'wav' ? 'audio/wav' : 'application/octet-stream';
}

export async function buildPack(b: PackBundle): Promise<Uint8Array> {
  const used = new Set<string>(['manifest.json', 'score.jps']);
  // wav 进包前压成 mp3：包的体积从「一条分轨几十 MB」降到约 1/10，
  // 分享传输与导入存储都轻一个量级。mp3 本来就不大，原样进包。
  const converted = await Promise.all(
    b.stems.map(async (s) => {
      const file = await ensureMp3(s.file);
      return { name: file.name, file };
    }),
  );
  const stems = converted.map((s) => ({ name: s.name, path: stemPath(s.name, used), file: s.file }));
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    name: b.name,
    savedAt: Date.now(),
    score: 'score.jps',
    align: b.align,
    stems: stems.map((s) => ({ name: s.name, path: s.path })),
  };

  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) },
    { name: 'score.jps', data: enc.encode(b.text) },
  ];
  for (const s of stems) {
    entries.push({ name: s.path, data: new Uint8Array(await s.file.arrayBuffer()) });
  }
  return zipStore(entries);
}

export async function readPack(bytes: Uint8Array): Promise<PackBundle> {
  const entries = unzip(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const mf = byName.get('manifest.json');
  if (!mf) throw new Error('包里没有 manifest.json，不是 WindScore 打包文件');
  const m = JSON.parse(dec.decode(mf.data)) as PackManifest;
  if (m?.format !== PACK_FORMAT) throw new Error('不是 WindScore 打包文件（格式标记对不上）');
  if (m.version !== PACK_VERSION) throw new Error(`打包版本 ${m.version} 不支持（本应用认 v${PACK_VERSION}）`);
  const score = byName.get(m.score);
  if (!score) throw new Error(`包里没有谱面文件（${m.score}）`);
  const stems: PackStem[] = [];
  for (const s of m.stems ?? []) {
    const e = byName.get(s.path);
    if (!e) continue; // 缺一轨不致命：谱面与标定照样能进曲库
    stems.push({
      name: s.name,
      file: new File([new Uint8Array(e.data)], s.name, { type: mimeOf(s.name) }),
    });
  }
  return {
    name: m.name || '未命名',
    text: dec.decode(score.data),
    align: m.align && m.align.version === 1 ? m.align : null,
    stems,
  };
}
