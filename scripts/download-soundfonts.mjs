// 下载 gleitz/midi-js-soundfonts 的 MusyngKite 逐音采样（预渲染 MP3 的 JS 容器）。
//
// 落到 .tmp-sf2/mk-<文件名>（mk- 前缀 = MusyngKite，与 build-instrument-samples.mjs 约定一致，
// 同名文件在 FluidR3_GM 目录下也有，前缀用来防串源）。
// 乐器清单**从 build-instrument-samples.mjs 的 INSTRUMENTS 表里解析**，保证两边永远一致——
// 那边加了乐器，这边就知道要下什么。
//
// 用法：node scripts/download-soundfonts.mjs [--force]
//   --force  本地已有也重新下载（默认跳过已存在的非空文件，断点续传友好）
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '.tmp-sf2');
const BASE = 'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/master/MusyngKite';
const FORCE = process.argv.includes('--force');

// 从构建脚本解析 INSTRUMENTS 表的 file 字段
const build = readFileSync(join(HERE, 'build-instrument-samples.mjs'), 'utf8');
const files = [...build.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
if (files.length < 100) {
  console.error(`从 build-instrument-samples.mjs 只解析出 ${files.length} 件乐器，表可能被改坏，先检查脚本`);
  process.exit(1);
}

mkdirSync(DIR, { recursive: true });

async function fetchWithRetry(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === tries) throw e;
      console.warn(`  重试 ${i}/${tries - 1}：${url}（${e.message}）`);
      await new Promise((res) => setTimeout(res, 1500 * i));
    }
  }
}

const queue = files.filter((f) => {
  if (FORCE) return false;
  const dest = join(DIR, `mk-${f}`);
  return !(existsSync(dest) && statSync(dest).size > 10000);
});
console.log(`共 ${files.length} 件乐器，需下载 ${queue.length} 个文件（并发 4）`);

let done = 0;
let totalMB = 0;
const started = Date.now();
async function worker() {
  while (queue.length) {
    const file = queue.shift();
    if (!file) return;
    try {
      const buf = await fetchWithRetry(`${BASE}/${file}`);
      writeFileSync(join(DIR, `mk-${file}`), buf);
      totalMB += buf.length / 1048576;
      console.log(`[${done + 1}/${queue.length + done + 1}] ${file}（${(buf.length / 1048576).toFixed(1)}MB）`);
    } catch (e) {
      console.error(`下载失败（跳过）：${file}（${e.message}）`);
    }
    done += 1;
  }
}
await Promise.all(Array.from({ length: 4 }, () => worker()));
console.log(
  `\n完成：${files.length} 个文件，共 ${totalMB.toFixed(0)}MB，耗时 ${Math.round((Date.now() - started) / 1000)}s，目录 ${DIR}`,
);
