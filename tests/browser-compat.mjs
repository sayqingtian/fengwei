import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';

const root = resolve('dist'), output = resolve('artifacts');
await mkdir(output, { recursive: true });
const playwright = await import(process.env.RECIPE_PLAYWRIGHT ? pathToFileURL(process.env.RECIPE_PLAYWRIGHT).href : 'playwright');
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.RECIPE_BROWSER ? { executablePath: process.env.RECIPE_BROWSER } : {}) });
const database = new RecipeDatabase(new FileStore(resolve(output, `compat-test-data-${randomUUID()}`)));
const password = 'compat-isolated-browser-password', api = createApi({ database, password });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const response = await api(new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const path = resolve(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1));
    if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    const content = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
function withoutNewSizing(css) {
  // Emulate ignored declarations instead of changing the user agent: a recent
  // Chromium rendering engine still supports these features with an old UA.
  return css.replace(/(?<=[{;])\s*(?:inset|aspect-ratio)\s*:[^;}]*;?/g, '').replace(/(?<=[{;])\s*[-\w]+\s*:[^;{}]*dvh[^;{}]*;?/g, '');
}
async function inViewport(page, locator, label) {
  const box = await locator.boundingBox(), viewport = page.viewportSize();
  assert.ok(box && box.height > 0 && box.y >= -1 && box.y + box.height <= viewport.height + 1, `${label} must stay inside the visible screen: ${JSON.stringify(box)}`);
}
async function scrollThrough(page, distance) {
  const box = await page.locator('.modal-scroll').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, distance);
}
try {
  const canvasPage = await browser.newPage();
  const photo = await canvasPage.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 1800;
    const context = canvas.getContext('2d'); context.fillStyle = '#987352'; context.fillRect(0, 0, 300, 1800);
    context.fillStyle = '#ecd07e'; context.fillRect(40, 600, 220, 600);
    return canvas.toDataURL('image/png');
  });
  await canvasPage.close();
  const now = new Date().toISOString();
  const recipe = { id: 'compat-long-dish', title: '安卓长菜谱', category: '家常菜', description: '长照片和长菜谱的滚动检查', minutes: 20, servings: 2, favorite: false, photo, notes: '最后的下厨心得', ingredients: [{ name: '黄鳝', amount: '500 克' }], steps: Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 步：准备好食材，小火翻炒，等汤汁慢慢收浓。`), createdAt: now, updatedAt: now };
  await database.commit({ id: recipe.id, recipe, baseRevision: null, mutationId: randomUUID() });
  await database.commit({ id: 'compat-empty-photo', recipe: { ...recipe, id: 'compat-empty-photo', title: '无照片的菜谱', photo: '' }, baseRevision: null, mutationId: randomUUID() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const scenario of [
    { name: 'android-legacy-360', width: 360, height: 740, legacy: true },
    { name: 'android-legacy-412', width: 412, height: 915, legacy: true },
    { name: 'mobile-current', width: 390, height: 844, legacy: false },
    { name: 'desktop-current', width: 1100, height: 800, legacy: false },
  ]) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, isMobile: scenario.width < 520, hasTouch: true, serviceWorkers: 'block' });
    if (scenario.legacy) await context.route('**/styles.css*', async route => {
      const response = await route.fetch(); await route.fulfill({ response, body: withoutNewSizing(await response.text()) });
    });
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(base);
      await page.getByLabel('账号', { exact: true }).fill('wupanfeng'); await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '打开菜谱本', exact: true }).click();
      const card = page.getByRole('button', { name: `查看 ${recipe.title}`, exact: true }); await card.waitFor();
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.card-photo img')).every(image => image.complete && image.naturalWidth > 0));
      const ratios = await page.locator('.card-photo').evaluateAll(frames => frames.map(frame => frame.clientWidth / frame.clientHeight));
      for (const ratio of ratios) assert.ok(ratio > 1.1 && ratio < 1.55, `portrait photos and placeholders must stay bounded: ${ratio}`);
      await card.click();
      await page.getByRole('dialog').getByRole('heading', { name: recipe.title }).waitFor();
      await inViewport(page, page.locator('.modal-header'), 'dialog header');
      await inViewport(page, page.locator('.modal-footer'), 'dialog footer');
      await page.waitForFunction(() => { const image = document.querySelector('.detail-cover img'); return image.complete && image.naturalWidth > 0; });
      await inViewport(page, page.locator('.detail-cover'), 'recipe photo');
      await scrollThrough(page, 6000);
      await page.waitForFunction(() => { const scroll = document.querySelector('.modal-scroll'); return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 3; });
      await inViewport(page, page.getByText(recipe.notes, { exact: true }), 'last recipe section');
      await scrollThrough(page, -6000);
      await page.waitForFunction(() => document.querySelector('.modal-scroll').scrollTop <= 1);
      await inViewport(page, page.locator('.detail-cover'), 'photo after scrolling back');
      if (scenario.width === 360) {
        await page.setViewportSize({ width: 740, height: 360 });
        await inViewport(page, page.locator('.modal-header'), 'landscape header');
        await inViewport(page, page.locator('.modal-footer'), 'landscape footer');
        await scrollThrough(page, 6000);
        await page.waitForFunction(() => { const scroll = document.querySelector('.modal-scroll'); return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 3; });
        await page.setViewportSize({ width: 360, height: 520 });
        await inViewport(page, page.locator('.modal-footer'), 'footer with reduced visible height');
        await page.setViewportSize({ width: scenario.width, height: scenario.height });
        await scrollThrough(page, -6000);
      }
      await page.screenshot({ path: resolve(output, `${scenario.name}-detail.png`) });
      await page.getByRole('button', { name: '关闭菜谱', exact: true }).click();
      assert.equal(await page.evaluate(() => document.body.classList.contains('locked')), false, 'closing the dialog must restore page scrolling');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      console.log(`${scenario.name}: portrait photos, scrolling to both ends, visible dialog controls and closing passed.`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
