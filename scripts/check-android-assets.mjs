import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Match WebViewAssetLoader's /assets/ prefix, including root-relative URLs.
const root = resolve(process.argv[2] ?? 'dist-android');
let failed = 0;
for (const file of readdirSync(root).filter(name => name.endsWith('.html'))) {
  const html = readFileSync(resolve(root, file), 'utf8');
  for (const [, reference] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const url = new URL(reference, `https://appassets.androidplatform.net/assets/${file}`);
    // Scripts and styles are required for startup; the optional favicon is not bundled by this project.
    if (url.hostname !== 'appassets.androidplatform.net' || url.hash || !/\.(js|css)$/.test(url.pathname)) continue;
    if (!url.pathname.startsWith('/assets/') || !existsSync(resolve(root, decodeURIComponent(url.pathname.slice(8))))) {
      console.error(`${file}: ${reference} cannot be loaded by WebViewAssetLoader`);
      failed++;
    }
  }
}
if (failed) process.exit(1);
console.log('Android HTML resource paths resolve correctly.');
