/**
 * 音色包（.wsbank）：与程序本体分离的**可选**音色资源，
 * 用户从曲库页导入（网页 / 安卓走同一个上传入口），导入后音色下拉里多出这些音色。
 *
 * 格式：与 .wspack 同款的 zip（store 不压缩，pack.ts 的 unzip / zipStore）：
 *   manifest.json   { kind: 'windscore-soundbank', version: 1, name, license, instruments: [{ patch, label, mp3, json }] }
 *   <mp3> / <json>  每件乐器一份，json 与内置 instrument-samples 的清单同结构
 *
 * 关键设计：**音色包按 GM 音色号覆盖**（比如包里给了 21 号，就用包里的手风琴
 * 替换内置的）。好处是：
 *   ① 谱面 / DSL 不用改——@patch 一直是数字；
 *   ② 包丢了也不出错——自动回落到内置音色（再没有就钢琴合成），老谱照响；
 *   ③ 许可隔离——CC BY-SA 这类有传染性的采样可以放在**包**里分发，
 *      不并进主程序（主程序内置只放 CC BY 的 FluidR3）。
 *
 * 存储：主程序不存音色数据，只存**用户导入的包文件本身**——
 * 文件后端（桌面 / 选了曲库文件夹）写磁盘，local（安卓 WebView / 浏览器）
 * 走 IndexedDB（复用 alignStore 的 putAudio / getAudio）。
 */

import { unzip, zipStore, type ZipEntry } from '../pack';
import { currentBackend, readJson, writeJson } from './storeBackend';
import { getAudio, putAudio, removeAudio } from './alignStore';
import {
  registerBankInstrument,
  unregisterBank,
  type InstrumentManifest,
} from '../instrumentSamples';

/** 音色包索引（哪些包已导入） */
const INDEX = 'banks.json';
/** 单包大小上限（字节）：200MB，够装一整套高保真管弦乐 */
const MAX_BANK = 200 * 1024 * 1024;

export interface BankInstrument {
  /** 这件音色占用的 GM 音色号（0-127）：同号覆盖内置的 */
  patch: number;
  label: string;
  mp3: string;
  json: string;
}

export interface BankManifest {
  kind: 'windscore-soundbank';
  version: 1;
  name: string;
  license?: string;
  instruments: BankInstrument[];
}

export interface BankInfo {
  name: string;
  size: number;
  license?: string;
  patches: number[];
}

/** 音色包的文件扩展名 */
export const BANK_EXT = '.wsbank';

export function isBankFile(name: string): boolean {
  return name.toLowerCase().endsWith(BANK_EXT);
}

/**
 * 解析音色包字节 → 清单 + 条目。格式 / 校验不通过就抛（错误信息直接给用户看）。
 */
export function parseBank(bytes: Uint8Array): { manifest: BankManifest; entries: Map<string, ZipEntry> } {
  if (bytes.byteLength > MAX_BANK) throw new Error(`音色包太大（超过 ${Math.round(MAX_BANK / 1024 / 1024)}MB）`);
  const list = unzip(bytes, true);
  const entries = new Map(list.map((e) => [e.name, e]));
  const mf = entries.get('manifest.json');
  if (!mf) throw new Error('音色包里没有 manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(mf.data));
  } catch {
    throw new Error('音色包的 manifest.json 不是合法 JSON');
  }
  const manifest = parsed as Partial<BankManifest>;
  if (manifest?.kind !== 'windscore-soundbank') throw new Error('这不是 WindScore 音色包（manifest 的 kind 不对）');
  if (!Array.isArray(manifest.instruments) || manifest.instruments.length === 0) throw new Error('音色包里没有音色');
  if (manifest.instruments.length > 128) throw new Error('音色包里的音色超过 128 件');
  for (const inst of manifest.instruments) {
    if (typeof inst?.patch !== 'number' || inst.patch < 0 || inst.patch > 127) throw new Error('音色包里有非法的音色号（应为 0-127）');
    if (!entries.has(inst.mp3) || !entries.has(inst.json)) throw new Error(`音色包里缺 ${inst.mp3} 或 ${inst.json}`);
  }
  return { manifest: manifest as BankManifest, entries };
}

/**
 * 把包里的音色登记进运行时（按 GM 号覆盖内置）。
 * 只登记字节，解码等真正用到再做——包里可能有几十件。
 */
export function applyBank(bytes: Uint8Array, bankName: string): number[] {
  const { manifest, entries } = parseBank(bytes);
  const applied: number[] = [];
  for (const inst of manifest.instruments) {
    const jsonEntry = entries.get(inst.json)!;
    let manifestJson: InstrumentManifest;
    try {
      manifestJson = JSON.parse(new TextDecoder().decode(jsonEntry.data)) as InstrumentManifest;
    } catch {
      continue; // 这一件坏了就跳过，别连累整包
    }
    if (!manifestJson?.points?.length) continue;
    registerBankInstrument(
      { ...manifestJson, patch: inst.patch, label: inst.label || manifestJson.label },
      entries.get(inst.mp3)!.data,
      bankName,
    );
    applied.push(inst.patch);
  }
  if (!applied.length) throw new Error('音色包里没有一件能用（清单损坏）');
  return applied;
}

/** 包文件名安全化（与 packFileName 同思路：非法字符换掉） */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * 音色包索引的读写。local 兜底（安卓 / 没配文件夹的浏览器）下 readJson/writeJson
 * 是空操作，必须自己走 localStorage——否则导入的包重启后「消失」（字节还躺在
 * IndexedDB 里，索引却空了）。文件后端照旧走 banks.json。
 */
const INDEX_KEY = 'ws-banks';

async function readIndex(): Promise<BankInfo[]> {
  if (currentBackend() === 'local') {
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      return raw ? (JSON.parse(raw) as BankInfo[]) : [];
    } catch {
      return [];
    }
  }
  const raw = await readJson(INDEX);
  return Array.isArray(raw) ? (raw as BankInfo[]) : [];
}

async function writeIndex(index: BankInfo[]): Promise<void> {
  if (currentBackend() === 'local') {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(index));
    } catch {
      /* 配额满 / 隐私模式：本次会话内仍有效（内存里已登记） */
    }
    return;
  }
  await writeJson(INDEX, index);
}

export async function listBanks(): Promise<BankInfo[]> {
  return await readIndex();
}

/** 存包：包文件本身存下来（文件后端写盘 / local 进 IndexedDB），索引记一份 */
export async function saveBank(file: File): Promise<BankInfo> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { manifest } = parseBank(bytes); // 先校验，坏了就不入库
  const name = safeName(manifest.name || file.name.replace(/\.wsbank$/i, ''));
  const key = `bank:${name}:${bytes.byteLength}`;
  await putAudio(key, new File([bytes], `${name}.wsbank`), true);
  const info: BankInfo = {
    name,
    size: bytes.byteLength,
    license: manifest.license,
    patches: manifest.instruments.map((i) => i.patch),
  };
  const index = (await readIndex()).filter((b) => b.name !== name);
  index.push(info);
  await writeIndex(index);
  // 存完立刻生效，不用等下次启动
  applyBank(bytes, name);
  return info;
}

/** 启动时把已导入的包全部登记回来 */
export async function loadSavedBanks(): Promise<BankInfo[]> {
  const index = await readIndex();
  const ok: BankInfo[] = [];
  for (const info of index) {
    try {
      const file = await getAudio(`bank:${info.name}:${info.size}`);
      if (!file) continue;
      applyBank(new Uint8Array(await file.arrayBuffer()), info.name);
      ok.push(info);
    } catch {
      /* 包坏了 / 丢了就跳过，音色自动回落内置 */
    }
  }
  return ok;
}

export async function removeBank(name: string): Promise<void> {
  const index = await readIndex();
  const info = index.find((b) => b.name === name);
  await writeIndex(index.filter((b) => b.name !== name));
  // 立刻注销内存里的登记：点移除当下就回落内置 / 钢琴，不用等重开页面
  unregisterBank(name);
  // 包文件本体也要删（文件后端删磁盘文件 / local 删 IndexedDB 记录）——
  // 不然「移除」只是看不见了，几 MB 的包还躺在存储里占地方
  if (info) await removeAudio(`bank:${info.name}:${info.size}`);
}

/**
 * 打包（给 scripts 用 / 将来做「导出音色包」也能用）：
 * 把若干件乐器（mp3 + json）打成 .wsbank 字节。
 */
export function buildBank(
  manifest: BankManifest,
  files: { name: string; data: Uint8Array }[],
): Uint8Array {
  const mf = new TextEncoder().encode(JSON.stringify(manifest));
  return zipStore([{ name: 'manifest.json', data: mf }, ...files]);
}
