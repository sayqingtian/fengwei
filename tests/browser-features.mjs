import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createApi } from '../server/api.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';

const output = resolve('artifacts'), root = resolve('dist'), base = 'http://localhost:4183';
await mkdir(output, { recursive: true });
const database = new RecipeDatabase(new FileStore(resolve(output, `feature-test-data-${randomUUID()}`)));
const password = 'feature-browser-test-only-password', handler = createApi({ database, password });
const viewer = await handler(new Request(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ displayName: '打卡体验账号', password, registrationId: randomUUID() }) }));
assert.equal(viewer.status, 201);
const dish = { id: 'feature-dish', title: '家常番茄炒蛋', description: '每次下厨都值得记录', category: '家常菜', notes: '', minutes: 15, servings: 2, photo: `data:image/png;base64,${(await readFile(resolve(root, 'icons/icon-192.png'))).toString('base64')}`, favorite: false, ingredients: [{ name: '番茄', amount: '2 个' }], steps: ['切好番茄，打散鸡蛋。', '炒熟后调味，盛盘。'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
await database.commit({ id: dish.id, recipe: dish, baseRevision: null, mutationId: randomUUID() });
let legacy = true, release = '3.1.4', failAsset = false, slow = false, failRecipes = false;
const oldFiles = new Map();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, base);
    if (url.pathname.startsWith('/api/')) {
      if (failRecipes && url.pathname === '/api/recipes') { if (slow) await new Promise(resolve => setTimeout(resolve, 1600)); res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '测试模拟菜谱服务暂时不可用', code: 'STORAGE_UNAVAILABLE' })); return; }
      const request = new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
      const response = await handler(request);
      if (slow && ['/api/login', '/api/recipes'].includes(url.pathname)) await new Promise(resolve => setTimeout(resolve, url.pathname === '/api/login' ? 900 : 1600));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1), path = resolve(root, relative);
    if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    if (failAsset && relative === 'styles.css') { res.writeHead(503); res.end(); return; }
    let data;
    if (legacy) {
      if (!oldFiles.has(relative)) oldFiles.set(relative, execFileSync('git', ['show', `cd043e6:dist/${relative}`], { stdio: ['ignore', 'pipe', 'ignore'] }));
      data = oldFiles.get(relative);
    } else {
      data = await readFile(path);
      if (relative === 'version.json') data = Buffer.from(JSON.stringify({ version: release }));
      if (['sw.js', 'version.js'].includes(relative)) data = Buffer.from(data.toString().replaceAll("'3.1.4'", `'${release}'`).replace("'fengwei-shell-v27'", `'fengwei-shell-test-${release}'`));
    }
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(4183, '127.0.0.1', resolve));
const playwright = await import(process.env.RECIPE_PLAYWRIGHT ? pathToFileURL(process.env.RECIPE_PLAYWRIGHT).href : 'playwright');
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.RECIPE_BROWSER ? { executablePath: process.env.RECIPE_BROWSER } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(12000);
const mobileMy = () => page.getByRole('navigation', { name: '底部导航' }).getByRole('button', { name: '我的', exact: true });
async function login(target) {
  await target.getByLabel('账号', { exact: true }).fill('打卡体验账号');
  await target.getByLabel('密码', { exact: true }).fill(password);
  await target.getByRole('button', { name: '打开菜谱本', exact: true }).click();
}
try {
  // Begin with an actually installed v12 cache, then ship the new app.
  await page.goto(base); await page.getByLabel('账号', { exact: true }).waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  console.log('Legacy installation ready.');
  assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).count(), 0);
  legacy = false;
  console.log('Beginning upgrade.');
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration('./');
    await reg.update();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`Legacy update timed out: ${reg.installing?.state}, ${reg.waiting?.state}, ${reg.active?.state}, ${navigator.serviceWorker.controller?.state}`)); }, 15000);
      const poll = setInterval(() => {
        const active = reg.active; if (!active) return;
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); clearInterval(poll); clearTimeout(timer); resolve(); };
        active.postMessage({ type: 'VERSION' }, [channel.port2]);
        setTimeout(() => channel.port1.close(), 500);
      }, 150);
    });
  });
  console.log('Legacy update activated.');
  await page.reload(); await page.getByRole('button', { name: '检查更新', exact: true }).waitFor();
  assert.equal(await page.getByLabel('账号', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByText('当前已是最新版本。', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'features-mobile-login.png'), fullPage: true });

  await page.getByLabel('账号', { exact: true }).fill('打卡体验账号');
  await page.getByLabel('密码', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '打开菜谱本', exact: true }).click();
  await page.getByText('账号或密码不正确。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '打开菜谱本', exact: true }).isEnabled(), true);
  assert.equal(await page.getByLabel('账号', { exact: true }).inputValue(), '打卡体验账号');

  slow = true; failRecipes = true; await login(page);
  await page.getByRole('heading', { name: '正在打开菜谱本', exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'features-mobile-login-progress.png'), fullPage: true });
  await page.getByRole('heading', { name: '已登录，正在加载菜谱…' }).waitFor();
  assert.equal(await page.locator('#auth-root').textContent(), '');
  await page.getByRole('heading', { name: '菜谱暂时没有加载完成' }).waitFor();
  failRecipes = false; await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await page.getByRole('button', { name: `查看 ${dish.title}`, exact: true }).waitFor(); slow = false;
  // A later sync outage must not return the user to the login form.
  failRecipes = true;
  await page.getByRole('button', { name: '同步菜谱', exact: true }).click();
  await page.getByText('离线预览 · 修改需要联网', { exact: true }).waitFor();
  assert.equal(await page.locator('#auth-root').textContent(), ''); failRecipes = false;
  await page.getByRole('button', { name: '同步菜谱', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.sync-loading'));
  console.log('Delayed login finished.');
  const favorite = page.locator('.recipe-card>.favorite-button');
  assert.equal(await favorite.evaluate(element => getComputedStyle(element, '::before').inset), '8px');
  assert.equal(await favorite.locator('svg').evaluate(element => getComputedStyle(element).width), '15px');
  await page.screenshot({ path: resolve(output, 'features-mobile-cards.png'), fullPage: true });
  await page.getByRole('button', { name: `查看 ${dish.title}`, exact: true }).click();
  await page.getByRole('button', { name: '跟着做', exact: true }).click();
  await page.getByRole('button', { name: '下一步' }).click(); await page.getByRole('button', { name: '做好了' }).click();
  await page.getByRole('textbox', { name: '这次下厨的心得' }).fill('番茄多炒一会儿，酸甜刚好。');
  await page.screenshot({ path: resolve(output, 'features-mobile-checkin.png'), fullPage: true });
  // Simulate losing the reply after a successful server write, then retry.
  await page.route('**/api/checkins', async route => { if (route.request().method() === 'POST') { await route.fetch(); await route.abort('failed'); } else await route.continue(); });
  await page.getByRole('button', { name: '提交打卡', exact: true }).click();
  await page.locator('#checkin-error').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('textbox', { name: '这次下厨的心得' }).inputValue(), '番茄多炒一会儿，酸甜刚好。');
  await page.unroute('**/api/checkins'); await page.getByRole('button', { name: '提交打卡', exact: true }).click();
  await page.getByRole('button', { name: '关闭菜谱' }).click();
  await mobileMy().click(); await page.getByRole('button', { name: '我的打卡', exact: false }).click();
  await page.getByText('番茄多炒一会儿，酸甜刚好。', { exact: true }).waitFor();
  assert.equal(await page.locator('.checkin-entry').count(), 1);
  await page.screenshot({ path: resolve(output, 'features-mobile-checkin-history.png'), fullPage: true });
  console.log('Check-in retry and history passed.');

  const another = await browser.newContext(), other = await another.newPage();
  await other.goto(base); await login(other); await other.getByRole('button', { name: `查看 ${dish.title}`, exact: true }).waitFor();
  await other.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click();
  await other.getByRole('button', { name: '我的打卡', exact: false }).click();
  await other.getByText('番茄多炒一会儿，酸甜刚好。', { exact: true }).waitFor(); await another.close();

  await mobileMy().click(); release = '3.1.5';
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '更新并重新打开', exact: true }).waitFor();
  await page.getByRole('button', { name: '更新并重新打开', exact: true }).click();
  await page.waitForEvent('load'); await page.getByRole('button', { name: `查看 ${dish.title}`, exact: true }).waitFor();
  await mobileMy().click(); await page.getByText('当前版本 3.1.5', { exact: true }).waitFor();
  await page.getByRole('button', { name: '我的打卡', exact: false }).click();
  await page.getByText('番茄多炒一会儿，酸甜刚好。', { exact: true }).waitFor();
  // A partial download cannot replace the working offline shell.
  await mobileMy().click(); release = '3.1.6'; failAsset = true;
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '更新并重新打开', exact: true }).click();
  await page.locator('.version-status').filter({ hasText: /仍在发布|未完成/ }).waitFor();
  assert.equal(await page.getByText('当前版本 3.1.5', { exact: true }).count(), 1);
  await context.setOffline(true); await page.reload();
  await page.getByRole('button', { name: `查看 ${dish.title}`, exact: true }).waitFor();
  await page.getByRole('button', { name: `查看 ${dish.title}`, exact: true }).click();
  await page.getByRole('button', { name: '制作完成，打卡', exact: true }).click();
  await page.getByText('打卡需要联网，请联网同步后再提交。', { exact: true }).waitFor();
  assert.equal(await page.locator('#checkin-form').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []); console.log('Mobile updates, legacy cache migration, delayed login, check-ins, lost replies, cross-device history, and offline safety passed.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
