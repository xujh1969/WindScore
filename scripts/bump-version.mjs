/**
 * 版本号递增：以 package.json 为唯一来源，同步 tauri.conf.json 与 Cargo.toml。
 *
 * 用法：
 *   node scripts/bump-version.mjs          # 递增修订号 0.1.0 → 0.1.1
 *   node scripts/bump-version.mjs minor    # 0.1.1 → 0.2.0
 *   node scripts/bump-version.mjs major    # 0.2.0 → 1.0.0
 *
 * 改完记得重新打包（npx tauri build），安装包文件名里的版本来自这三处。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bump = (process.argv[2] ?? 'patch').toLowerCase();
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('用法：node scripts/bump-version.mjs [patch|minor|major]');
  process.exit(1);
}

const pkgPath = join(root, 'package.json');
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [maj, min, pat] = String(pkg.version).split('.').map((n) => Number(n) || 0);
const next =
  bump === 'major' ? [maj + 1, 0, 0] : bump === 'minor' ? [maj, min + 1, 0] : [maj, min, pat + 1];
const version = next.join('.');

// package.json：整份重写会打乱格式，只替换 version 那一行
writeFileSync(
  pkgPath,
  readFileSync(pkgPath, 'utf8').replace(
    /("version"\s*:\s*")[^"]+(")/,
    `$1${version}$2`,
  ),
);

// tauri.conf.json：同理，只动 package.version
writeFileSync(
  confPath,
  readFileSync(confPath, 'utf8').replace(
    /("version"\s*:\s*")[^"]+(")/,
    `$1${version}$2`,
  ),
);

// Cargo.toml：version = "…"（只改第一个，即 [package] 段）
const cargo = readFileSync(cargoPath, 'utf8');
writeFileSync(cargoPath, cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`));

console.log(`版本 ${pkg.version} → ${version}（package.json / tauri.conf.json / Cargo.toml 已同步）`);
