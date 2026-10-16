import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { RecipeDatabase, hash } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';

const root = resolve('dist'), output = resolve('artifacts'), base = 'http://localhost:4185';
await mkdir(output, { recursive: true });
const database = new RecipeDatabase(new FileStore(resolve(output, `image-test-data-${randomUUID()}`)));
const password = 'image-isolated-browser-password', api = createApi({ database, password });
const png = await readFile(resolve(root, 'icons/icon-192.png'));
const image = n => `data:image/png;base64,${Buffer.concat([png, Buffer.from([n])]).toString('base64')}`;
const dish = index => ({ id: `image-dish-${index}`, title: `图片测试菜谱 ${index}`, category: '家常菜', description: '', notes: '', minutes: 10, servings: 2, photo: image(index + 1), favorite: false, ingredients: [], steps: ['完成'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const old = await database.commit({ id: dish(0).id, recipe: { ...dish(0), photo: image(0) }, baseRevision: null, mutationId: randomUUID() });
for (let i = 0; i < 5; i++) await database.commit({ id: dish(i).id, recipe: dish(i), baseRevision: i === 0 ? old.revision : null, mutationId: randomUUID() });
await database.photos.save(image(6));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base);
    if (url.pathname.startsWith('/api/')) {
      const response = await api(new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const path = resolve(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1));
    if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    const bytes = await readFile(path); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(4185, '127.0.0.1', resolve));
const playwright = await import(process.env.RECIPE_PLAYWRIGHT ? pathToFileURL(process.env.RECIPE_PLAYWRIGHT).href : 'playwright');
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.RECIPE_BROWSER ? { executablePath: process.env.RECIPE_BROWSER } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(12000);
try {
  await page.goto(base);
  await page.getByLabel('账号', { exact: true }).fill('wupanfeng'); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '打开菜谱本', exact: true }).click();
  await page.getByRole('button', { name: '查看 图片测试菜谱 0', exact: true }).waitFor();
  await page.getByRole('navigation', { name: '底部导航' }).getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: /图片空间/ }).click();
  await page.getByRole('button', { name: '清理 1 张无引用图片', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.image-metrics .panel').first().locator('strong').textContent(), '7');
  const usage = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '图片引用明细' }) });
  assert.match(await usage.textContent(), /当前使用 5 张 · 历史保留 1 张 · 完全无引用 1 张/);
  await page.getByRole('button', { name: '清理 1 张无引用图片', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '开始清理', exact: true }).click();
  await page.getByRole('button', { name: '清理 0 张无引用图片', exact: true }).waitFor();
  assert.equal(await page.locator('.image-metrics .panel').first().locator('strong').textContent(), '6');
  assert.equal(await page.getByRole('button', { name: '清理 0 张无引用图片', exact: true }).isDisabled(), true);
  assert.equal(await database.photo(hash(image(0))), image(0)); assert.equal(await database.photo(hash(image(6))), null);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, 'images-mobile-cleaned.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Mobile image inventory and orphan cleanup passed; five current photos and one recoverable historical photo remain.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
