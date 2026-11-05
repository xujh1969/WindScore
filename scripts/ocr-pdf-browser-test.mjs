// Run against npm run dev (or WS_TEST_URL). PLAYWRIGHT_MODULE may point to an external installation.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = process.env.WS_CDP_URL
  ? await chromium.connectOverCDP(process.env.WS_CDP_URL)
  : await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const page = process.env.WS_CDP_URL ? browser.contexts()[0].pages()[0]
  : await browser.newPage({ viewport: { width: 1180, height: 760 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log(m.type(), m.text().slice(0, 450)); });
try {
  // Reproduce the browser/WebView missing modern built-ins in both main thread and worker.
  await page.addInitScript(() => { delete Map.prototype.getOrInsertComputed; });
  const origin = process.env.WS_TEST_URL || (process.env.WS_CDP_URL ? new URL(page.url()).origin : 'http://127.0.0.1:5173');
  await page.goto(`${origin}/ocr.html`);
  await page.locator('input[type=file]').setInputFiles(process.argv[2] || 'C:/Users/AYOU/Desktop/北国之春.pdf');
  await page.waitForFunction(() => /已载入|载入失败/.test(document.querySelector('.ocr-start-status')?.textContent || ''), null, { timeout: 90000 });
  const status = await page.locator('.ocr-start-status').innerText();
  console.log(status);
  assert.match(status, /已载入/);
  const ink = await page.locator('[data-testid=bin-preview]').evaluate(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++;
    return { width: c.width, height: c.height, ink: n };
  });
  console.log('preview', ink);
  assert.ok(ink.ink > 100, 'PDF preview must contain ink');
  await page.getByRole('button', { name: '简谱识别', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.ocr-page') || /识别失败/.test(document.querySelector('.ocr-start-status')?.textContent || ''), null, { timeout: 240000 });
  assert.equal(await page.locator('.ocr-page').count(), 1, await page.locator('body').innerText());
  assert.ok(await page.locator('.ocr-overlay rect').count() > 10, 'OCR must locate notes');
  const left = await page.locator('.ocr-left canvas').boundingBox();
  assert.ok(left?.height > 50, 'Source preview must remain visible');
  await page.waitForFunction(() => [...document.querySelectorAll('.ocr-right canvas')].some(c => c.width > 100 && c.height > 100));
  const editorInk = await page.locator('.ocr-right canvas').first().evaluate(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 128) n++;
    return n;
  });
  assert.ok(editorInk > 100, 'Editor must render recognized notation');
  assert.equal(errors.length, 0, errors.join('\n'));
  mkdirSync('artifacts/ocr-pdf-fix', { recursive: true });
  await page.screenshot({ path: `artifacts/ocr-pdf-fix/${process.env.WS_CDP_URL ? 'exe' : 'browser'}-compare.png` });
  console.log('PASS PDF load -> nonblank preview -> real OCR -> comparison', left);
  if (!process.env.WS_CDP_URL) {
    // A blank PDF is valid to preview, but must never produce a successful empty editor.
    await page.goto(`${origin}/ocr.html`);
    const blank = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF';
    const vector = blank.replace('/Kids [3 0 R] /Count 1', '/Kids [3 0 R 5 0 R] /Count 2')
      .replace('/Length 0', '/Length 18').replace('stream\n\nendstream', 'stream\n10 10 60 60 re f\nendstream')
      .replace('trailer', '5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] /Rotate 90 /Resources << >> /Contents 4 0 R >>\nendobj\ntrailer');
    await page.locator('input[type=file]').setInputFiles({ name: 'vector-rotated.pdf', mimeType: 'application/pdf', buffer: Buffer.from(vector) });
    await page.waitForFunction(() => /共 2 页/.test(document.querySelector('.ocr-start-status')?.textContent || ''), null, { timeout: 90000 });
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.waitForFunction(() => {
      const c = document.querySelector('[data-testid=bin-preview]');
      return c && c.width === 2000 && c.height === 1000;
    });
    const rotatedInk = await page.locator('[data-testid=bin-preview]').evaluate(c => c.getContext('2d').getImageData(500, 500, 1, 1).data[0]);
    assert.equal(rotatedInk, 0, 'Vector marks and page rotation must survive rasterization');
    console.log('PASS vector PDF, two pages, rotated page and page navigation');
    await page.locator('input[type=file]').setInputFiles({ name: 'blank.pdf', mimeType: 'application/pdf', buffer: Buffer.from(blank) });
    await page.waitForFunction(() => /已载入/.test(document.querySelector('.ocr-start-status')?.textContent || ''), null, { timeout: 90000 });
    await page.getByRole('button', { name: '简谱识别', exact: true }).click();
    await page.waitForFunction(() => /识别失败.*没有可识别/.test(document.querySelector('.ocr-start-status')?.textContent || ''));
    assert.equal(await page.locator('.ocr-page').count(), 0);
    console.log('PASS blank PDF stays on preview with actionable error');
  }
} finally { await browser.close(); }
