// Real editor controls and rendered barline strokes, in a browser or a CDP-enabled EXE.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = process.env.WS_CDP_URL ? await chromium.connectOverCDP(process.env.WS_CDP_URL)
  : await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const page = process.env.WS_CDP_URL ? browser.contexts()[0].pages()[0]
  : await browser.newPage({ viewport: { width: Number(process.env.WS_TEST_WIDTH || 1280), height: 900 } });
const text = '@title Barline test\n@beat 4/4\n\n1 2 3 4 || 5 6 7 1 |\n';
try {
  const origin = process.env.WS_TEST_URL || (process.env.WS_CDP_URL ? new URL(page.url()).origin : 'http://127.0.0.1:5173');
  await page.goto(`${origin}/editor.html`);
  await page.getByRole('button', { name: '源码', exact: true }).waitFor();
  const setup = page.locator('button[title="暂不配置"]');
  if (!process.env.WS_CDP_URL || await setup.count()) await setup.click();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await page.getByRole('textbox', { name: '乐谱源码' }).fill(text);
  await page.getByRole('button', { name: '简谱', exact: true }).click();
  // The canvas has an aria-label but no explicit role.
  const scoreCanvas = page.locator('canvas[aria-label="简谱谱面"]');
  await scoreCanvas.waitFor();
  // Find a visible vertical stroke taller than a note, then click that actual ink.
  const point = await scoreCanvas.evaluate(c => {
    const scale = c.width / c.clientWidth;
    const ctx = c.getContext('2d');
    for (let x = Math.round(120 * scale); x < c.width; x++) {
      const d = ctx.getImageData(x, 0, 1, c.height).data;
      let run = 0;
      for (let y = Math.round(110 * scale); y < Math.min(c.height, 400 * scale); y++) {
        run = d[y * 4] < 160 && d[y * 4 + 3] > 200 ? run + 1 : 0;
        if (run > 32 * scale) return { x: x / scale, y: (y - run / 2) / scale };
      }
    }
    throw new Error('No visible barline stroke');
  });
  await scoreCanvas.click({ position: point });
  await page.getByText('此线之后的拍号', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '删除小节线', exact: true }).count(), 1);
  await page.screenshot({ path: `artifacts/ocr-pdf-fix/${process.env.WS_CDP_URL ? 'exe' : 'browser'}-barline-controls.png` });
  await page.getByRole('button', { name: '普通小节线', exact: true }).click();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  assert.match(await page.getByRole('textbox', { name: '乐谱源码' }).inputValue(), /1 2 3 4 \| 5 6 7 1/);
  console.log('PASS selected final bar exposes delete and converts directly to single');
  const change = async (button, token) => {
    await page.getByRole('button', { name: '简谱', exact: true }).click();
    await button.click();
    await page.getByRole('button', { name: '源码', exact: true }).click();
    const source = await page.getByRole('textbox', { name: '乐谱源码' }).inputValue();
    assert.ok(source.includes(`1 2 3 4 ${token} 5 6 7 1`), source);
  };
  const pad = page.locator('.v2-pad-body');
  await change(pad.locator('button[title^="终止线"]'), '||');
  await change(pad.locator('button[title^="把这条线改成反复结束"]'), ':|');
  await change(pad.locator('button[title^="双向反复"]'), ':||:');
  await change(pad.locator('button[title^="把这条线改成反复开始"]'), '|:');
  await change(pad.locator('button[title^="双细线"]'), '‖');
  await change(pad.locator('button[title^="虚小节线"]'), '|~');
  await change(page.getByRole('button', { name: '普通小节线', exact: true }), '|');
  console.log('PASS final -> repeat -> double -> single clears incompatible flags');
  await page.getByRole('button', { name: '简谱', exact: true }).click();
  await page.getByRole('button', { name: '删除小节线', exact: true }).click();
  assert.equal(await page.getByText('此线之后的拍号', { exact: true }).count(), 0);
  await scoreCanvas.focus();
  await page.keyboard.press('2');
  await page.getByRole('button', { name: '源码', exact: true }).click();
  assert.ok((await page.getByRole('textbox', { name: '乐谱源码' }).inputValue()).includes('1 2 3 4 2 5 6 7 1'));
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.ok((await page.getByRole('textbox', { name: '乐谱源码' }).inputValue()).includes('1 2 3 4 5 6 7 1'));
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.ok((await page.getByRole('textbox', { name: '乐谱源码' }).inputValue()).includes('1 2 3 4 | 5 6 7 1'));
  await page.getByRole('button', { name: '重做', exact: true }).click();
  assert.ok((await page.getByRole('textbox', { name: '乐谱源码' }).inputValue()).includes('1 2 3 4 5 6 7 1'));
  console.log('PASS barline deletion, undo and redo preserve neighboring notes');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await change(pad.locator('button[title^="把这条线改成反复结束"]'), ':|');
  await page.getByRole('button', { name: '简谱', exact: true }).click();
  await scoreCanvas.focus();
  await page.keyboard.press('Escape');
  await pad.locator('button[title^="虚小节线"]').click();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const dashedSource = await page.getByRole('textbox', { name: '乐谱源码' }).inputValue();
  assert.ok(dashedSource.includes('1 2 3 4 |~ 5 6 7 1'), dashedSource);
  console.log('PASS cursor toolbar converts repeat bar to dashed without hidden repeat');
} finally { await browser.close(); }
