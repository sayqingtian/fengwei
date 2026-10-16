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

const root = resolve('dist'), output = resolve('artifacts'), base = 'http://localhost:4184';
await mkdir(output, { recursive: true });
const database = new RecipeDatabase(new FileStore(resolve(output, `startup-test-data-${randomUUID()}`)));
const password = 'startup-isolated-browser-password', api = createApi({ database, password });
const dish = { id: 'startup-dish', title: '冷启动保留的菜谱', category: '家常菜', description: '', notes: '', minutes: 10, servings: 2, photo: '', favorite: false, ingredients: [], steps: ['炒熟'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
await database.commit({ id: dish.id, recipe: dish, baseRevision: null, mutationId: randomUUID() });
const currentVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const nextVersion = currentVersion.replace(/\d+$/, value => String(Number(value) + 1));
let failModule = false, failStyles = false, holdStyles = false, holdRecipes = false, release = currentVersion;
const styleWaiters = [];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base);
    if (url.pathname.startsWith('/api/')) {
      if (holdRecipes && url.pathname === '/api/recipes') return;
      const response = await api(new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const path = resolve(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1));
    if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    if (failModule && path === resolve(root, 'app.js')) { res.writeHead(503); res.end(); return; }
    if (path === resolve(root, 'styles.css')) {
      if (holdStyles) await new Promise(resolve => styleWaiters.push(resolve));
      if (failStyles) { res.writeHead(503); res.end(); return; }
    }
    let content = await readFile(path);
    if (path === resolve(root, 'version.json')) content = Buffer.from(JSON.stringify({ version: release }));
    if (['sw.js', 'version.js'].some(name => path === resolve(root, name))) content = Buffer.from(content.toString().replaceAll(`'${currentVersion}'`, `'${release}'`).replace(/'fengwei-shell-v\d+'/, `'fengwei-shell-startup-${release}'`));
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(4184, '127.0.0.1', resolve));
const playwright = await import(process.env.RECIPE_PLAYWRIGHT ? pathToFileURL(process.env.RECIPE_PLAYWRIGHT).href : 'playwright');
const engine = process.env.RECIPE_ENGINE || 'chromium';
const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && process.env.RECIPE_BROWSER ? { executablePath: process.env.RECIPE_BROWSER } : {}) });
const errors = [];
async function mobile() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  return { context, page };
}
try {
  holdStyles = true;
  const styled = await mobile();
  await styled.page.goto(base, { waitUntil: 'domcontentloaded' });
  await styled.page.waitForTimeout(250);
  assert.equal(await styled.page.locator('#startup').count(), 1);
  assert.equal(await styled.page.locator('#app .shell').count(), 0);
  assert.equal(await styled.page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(250, 248, 242)');
  holdStyles = false; styleWaiters.splice(0).forEach(resolve => resolve());
  await styled.page.getByLabel('账号', { exact: true }).waitFor();
  assert.equal(await styled.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fengwei-styles-ready').trim()), 'yes');
  await styled.page.evaluate(() => { document.getElementById('app-styles').media = 'print'; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  assert.equal(await styled.page.locator('#app-styles').getAttribute('media'), 'all');
  await styled.page.reload(); await styled.page.getByLabel('账号', { exact: true }).waitFor();
  await styled.context.close();
  console.log(`${engine}: delayed and cached styles stay applied, including a page restored from the background.`);

  failStyles = true;
  const noStyles = await mobile();
  await noStyles.page.goto(base);
  await noStyles.page.getByText('页面样式未加载完成，请联网后重试或更新应用。', { exact: true }).waitFor();
  assert.equal(await noStyles.page.locator('#app .shell').count(), 0);
  failStyles = false; await noStyles.page.getByRole('button', { name: '重新打开', exact: true }).click();
  await noStyles.page.getByLabel('账号', { exact: true }).waitFor(); await noStyles.context.close();
  console.log(`${engine}: failed CSS shows recovery controls instead of an unstyled application.`);

  // A failed entry module must leave working recovery controls in the HTML.
  failModule = true;
  const broken = await mobile();
  await broken.page.goto(base);
  await broken.page.getByText('应用文件加载未完成，请联网后点击“更新并重新打开”。', { exact: true }).waitFor();
  assert.equal(await broken.page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(250, 248, 242)');
  await broken.page.evaluate(() => localStorage.setItem('startup-kept-draft', '这份草稿不能被清除'));
  failModule = false;
  await broken.page.getByRole('button', { name: '更新并重新打开', exact: true }).click();
  await broken.page.getByLabel('账号', { exact: true }).waitFor();
  assert.equal(await broken.page.evaluate(() => localStorage.getItem('startup-kept-draft')), '这份草稿不能被清除');
  await broken.context.close();
  console.log(`${engine}: module failure recovers without clearing local content.`);

  const blocked = await mobile();
  await blocked.context.addInitScript(() => { indexedDB.open = () => ({}); });
  await blocked.page.goto(base);
  await blocked.page.getByLabel('账号', { exact: true }).waitFor({ timeout: 8500 });
  assert.equal(await blocked.page.locator('#startup').count(), 0);
  await blocked.context.close();
  console.log(`${engine}: a stalled IndexedDB open does not trap the welcome screen.`);

  const cached = await mobile();
  await cached.page.goto(base);
  await cached.page.getByLabel('账号', { exact: true }).fill('wupanfeng');
  await cached.page.getByLabel('密码', { exact: true }).fill(password);
  await cached.page.getByRole('button', { name: '打开菜谱本', exact: true }).click();
  await cached.page.getByRole('button', { name: `查看 ${dish.title}`, exact: true }).waitFor();
  await cached.page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  // Hold both the save acknowledgement and the startup sync; preserve the
  // actual account's queue, rather than merely a generic storage sentinel.
  await cached.page.route('**/api/favorite/**', route => route.abort());
  await cached.page.getByRole('button', { name: `收藏 ${dish.title}`, exact: true }).click();
  await cached.page.getByText(/1 项修改已保存在本机/).waitFor();
  holdRecipes = true;
  await cached.page.reload({ waitUntil: 'domcontentloaded' });
  await cached.page.getByRole('button', { name: `查看 ${dish.title}`, exact: true }).waitFor({ timeout: 2000 });
  assert.equal(await cached.page.locator('#startup').count(), 0);
  await cached.page.getByText(/1 项修改已保存在本机/).waitFor();
  await cached.page.screenshot({ path: resolve(output, `startup-${engine}-cached.png`), fullPage: true });
  // The recovery update must remain available even while a read is pending.
  release = nextVersion;
  await cached.page.getByRole('navigation', { name: '底部导航' }).getByRole('button', { name: '我的', exact: true }).click();
  await cached.page.getByRole('button', { name: '检查更新', exact: true }).click();
  await cached.page.getByRole('button', { name: '更新并重新打开', exact: true }).click();
  await cached.page.locator('.footer').filter({ hasText: `v${nextVersion}` }).waitFor();
  await cached.page.getByText(/1 项修改已保存在本机/).waitFor();
  holdRecipes = false;
  await cached.page.unroute('**/api/favorite/**');
  await cached.page.reload();
  await cached.page.getByRole('button', { name: `取消收藏 ${dish.title}`, exact: true }).waitFor();
  await cached.page.getByText(/1 项修改已保存在本机/).waitFor({ state: 'hidden' });
  await cached.context.close();
  console.log(`${engine}: cached cold start paints before a stalled API, permits updates, and resumes the original queue.`);
  assert.deepEqual(errors, []);
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
