import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const password = 'fengwei-browser-test-only-password';
const dataDirectory = resolve('artifacts', `browser-test-data-${randomUUID()}`);
function startServer() {
  const child = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, NODE_ENV: 'test', FENGWEI_TEST_PASSWORD: password, RECIPE_DATA_DIR: dataDirectory, RECIPE_PORT: '4182' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Local server did not start')); }, 10000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('Local:')) { clearTimeout(timer); resolve(child); } });
    child.stderr.on('data', chunk => { clearTimeout(timer); reject(new Error(String(chunk))); });
    child.on('error', reject);
  });
}
let server = await startServer();

const playwright = await import(process.env.RECIPE_PLAYWRIGHT ? pathToFileURL(process.env.RECIPE_PLAYWRIGHT).href : 'playwright');
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.RECIPE_BROWSER ? { executablePath: process.env.RECIPE_BROWSER } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const externalRequests = []; page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://localhost:4182')) externalRequests.push(request.url()); });
const output = resolve('artifacts'); await mkdir(output, { recursive: true });
let exported;
try {
  await page.goto('http://localhost:4182');
  assert.equal(await page.getByLabel('账号', { exact: true }).inputValue(), '');
  await page.getByLabel('账号', { exact: true }).fill('wupanfeng');
  await page.screenshot({ path: resolve(output, 'mobile-login.png'), fullPage: true });
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '打开菜谱本' }).click();
  await page.getByRole('heading', { name: '第一道菜，想记点什么？' }).waitFor();
  assert.match(await page.title(), /峰味/);
  await page.evaluate(() => navigator.serviceWorker.ready);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile layout must fit viewport');
  await page.screenshot({ path: resolve(output, 'mobile-empty.png'), fullPage: true });

  await page.getByRole('button', { name: '记录我的第一道菜' }).click();
  await page.getByRole('textbox', { name: '菜名' }).fill('奶奶的番茄炒蛋');
  await page.getByRole('textbox', { name: '一句话介绍' }).fill('少放糖，多一点家的味道');
  await page.getByRole('combobox', { name: '分类', exact: true }).fill('家常菜');
  await page.getByRole('spinbutton', { name: '用时 / 分钟' }).fill('15');
  await page.getByRole('textbox', { name: '食材 1 名称' }).fill('番茄');
  await page.getByRole('textbox', { name: '食材 1 用量' }).fill('2 个');
  await page.getByRole('button', { name: '再加一种食材' }).click();
  await page.getByRole('textbox', { name: '食材 2 名称' }).fill('鸡蛋');
  await page.getByRole('textbox', { name: '食材 2 用量' }).fill('3 个');
  await page.getByRole('textbox', { name: '步骤 1', exact: true }).fill('番茄切块，鸡蛋打散。');
  await page.getByRole('button', { name: '再加一个步骤' }).click();
  await page.getByRole('textbox', { name: '步骤 2', exact: true }).fill('先炒鸡蛋，盛出。番茄炒出汁，加入鸡蛋炒匀。');
  await page.getByRole('textbox', { name: '我的小心得' }).fill('最后加盐，记得小火。');
  await page.getByRole('button', { name: '保存这道菜' }).click();
  await page.getByRole('dialog').getByRole('heading', { name: '奶奶的番茄炒蛋' }).waitFor();
  assert.equal(await page.getByText('最后加盐，记得小火。', { exact: true }).count(), 1);

  await page.getByRole('button', { name: '收藏', exact: true }).click();
  await page.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
  await page.getByRole('button', { name: '跟着做' }).click();
  await page.getByText('番茄切块，鸡蛋打散。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByText('先炒鸡蛋，盛出。番茄炒出汁，加入鸡蛋炒匀。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '做好了' }).click();
  await page.getByRole('textbox', { name: '这次下厨的心得' }).fill('火候刚好，下次继续。');
  await page.getByRole('button', { name: '提交打卡' }).click();
  await page.getByRole('button', { name: '关闭菜谱' }).waitFor();
  await page.getByRole('button', { name: '关闭菜谱' }).click();
  await page.reload();
  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋' }).waitFor();
  await page.getByRole('searchbox', { name: '搜索菜谱' }).fill('鸡蛋 小火');
  assert.equal(await page.locator('.recipe-card').count(), 1);
  await page.getByRole('searchbox', { name: '搜索菜谱' }).fill('无此食材');
  await page.getByRole('heading', { name: '还没找到这道菜' }).waitFor();
  await page.getByRole('button', { name: '查看全部菜谱' }).click();

  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋' }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#photo-input').setInputFiles(resolve('dist/icons/icon-192.png'));
  await page.getByAltText('菜谱封面预览').waitFor();
  await page.getByRole('textbox', { name: '菜名' }).fill('奶奶的番茄炒蛋（改良版）');
  await page.getByRole('button', { name: '保存这道菜' }).click();
  await page.getByRole('dialog').getByRole('heading', { name: '奶奶的番茄炒蛋（改良版）' }).waitFor();
  await page.getByRole('button', { name: '关闭菜谱' }).click();

  await page.getByRole('navigation', { name: '底部导航' }).getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '菜谱备份' }).click();
  await page.getByRole('heading', { name: '离线页面已准备好' }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载备份' }).click();
  const download = await downloadPromise; const exportPath = resolve(output, 'roundtrip.json'); await download.saveAs(exportPath);
  exported = (await import('node:fs/promises')).readFile(exportPath, 'utf8');
  const backup = JSON.parse(await exported);
  assert.equal(backup.recipes.length, 1);
  assert.match(backup.recipes[0].photo, /^data:image\/jpeg;base64,/);
  assert.equal(backup.recipes[0].favorite, true);

  await page.locator('#import-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{bad json') });
  await page.getByRole('status').filter({ hasText: '文件无法读取' }).waitFor();
  assert.equal(await page.locator('.import-summary').count(), 0);

  await page.getByRole('navigation', { name: '底部导航' }).getByRole('button', { name: '菜谱本' }).click();
  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: '菜名' }).fill('尚未保存的更改');
  await page.getByRole('button', { name: '关闭编辑' }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '菜名' }).inputValue(), '尚未保存的更改');
  await page.getByRole('button', { name: '关闭编辑' }).click();
  await page.getByRole('button', { name: '放弃修改' }).click();
  assert.equal(await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).count(), 1);

  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除菜谱' }).click();
  await page.getByRole('heading', { name: '第一道菜，想记点什么？' }).waitFor();
  await page.getByRole('navigation', { name: '底部导航' }).getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '菜谱备份' }).click();
  await page.locator('#import-file').setInputFiles(exportPath);
  await page.getByRole('heading', { name: '已读到 1 道菜谱' }).waitFor();
  await page.getByRole('button', { name: '确认导入' }).click();
  await page.getByRole('status').filter({ hasText: '导入完成' }).waitFor();
  await page.getByRole('navigation', { name: '底部导航' }).getByRole('button', { name: '菜谱本' }).click();
  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).waitFor();

  // A separate device has no IndexedDB cache, but reads the server's data.
  const second = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const other = await second.newPage();
  await other.goto('http://localhost:4182');
  await other.getByLabel('账号', { exact: true }).fill('wupanfeng');
  await other.getByLabel('密码', { exact: true }).fill(password);
  await other.getByRole('button', { name: '打开菜谱本' }).click();
  await other.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).waitFor();
  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: '我的小心得' }).fill('这份过期的修改不能覆盖另一台设备');
  const remote = (await (await other.request.get('http://localhost:4182/api/recipes')).json()).items.find(item => !item.deleted);
  const photo = (await (await other.request.get(`http://localhost:4182/api/photo/${remote.photoHash}`)).json()).photo;
  const saved = await other.request.put(`http://localhost:4182/api/recipe/${remote.id}`, { data: { recipe: { ...remote.recipe, photo, notes: '另一台设备保存的小心得' }, baseRevision: remote.revision, mutationId: 'browser-other-device-save' } });
  assert.equal(saved.status(), 200);
  await page.getByRole('button', { name: '保存这道菜' }).click();
  await page.getByRole('alert').filter({ hasText: '另一台设备更新' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '我的小心得' }).inputValue(), '这份过期的修改不能覆盖另一台设备');
  await page.getByRole('button', { name: '关闭编辑' }).click();
  await page.getByRole('button', { name: '放弃修改' }).click();
  await page.getByRole('button', { name: '同步菜谱', exact: true }).click();
  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).click();
  await page.getByText('另一台设备保存的小心得', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看历史版本', exact: true }).click();
  await page.getByRole('heading', { name: '最近的历史版本' }).waitFor();
  assert.ok(await page.getByRole('button', { name: '恢复这个版本' }).count() >= 2);
  await page.locator('[data-action="restore-version"]:not(:disabled)').first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: '确认恢复' }).click();
  await page.getByRole('button', { name: '关闭菜谱' }).waitFor();
  await page.getByRole('dialog').getByRole('heading', { name: '奶奶的番茄炒蛋（改良版）' }).waitFor();
  await page.getByRole('button', { name: '关闭菜谱' }).click();

  await page.getByRole('button', { name: '记一道新菜' }).click();
  await page.getByRole('textbox', { name: '菜名' }).fill('离线记录的清汤面');
  await context.setOffline(true);
  await page.getByRole('button', { name: '保存这道菜' }).click();
  await page.getByRole('alert').filter({ hasText: '离线预览' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '菜名' }).inputValue(), '离线记录的清汤面');
  await page.getByRole('button', { name: '关闭编辑' }).click();
  await page.getByRole('button', { name: '放弃修改' }).click();
  await page.reload();
  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '记一道新菜' }).count(), 0, 'offline preview cannot open a new editor');
  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).waitFor();
  assert.equal(await page.locator('.recipe-card').count(), 1);
  await page.screenshot({ path: resolve(output, 'mobile-recipes.png'), fullPage: true });

  await context.setOffline(false);
  await page.getByRole('button', { name: '同步菜谱', exact: true }).click();
  await page.getByRole('button', { name: '记一道新菜' }).click();
  await page.getByRole('textbox', { name: '菜名' }).fill('服务器记录的清汤面');
  await page.getByRole('button', { name: '保存这道菜' }).click();
  await page.getByRole('dialog').getByRole('heading', { name: '服务器记录的清汤面' }).waitFor();
  await page.getByRole('button', { name: '关闭菜谱' }).click();
  const startupFetches = [];
  const observeStartup = request => {
    if (request.serviceWorker() && new URL(request.url()).pathname === '/') startupFetches.push(request.url());
  };
  context.on('request', observeStartup);
  await page.reload({ timeout: 5000 });
  await page.getByRole('button', { name: '查看 服务器记录的清汤面' }).waitFor();
  context.off('request', observeStartup);
  assert.deepEqual(startupFetches, [], 'installed app startup must not fetch its page from the host');
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.screenshot({ path: resolve(output, 'desktop-recipes.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop layout must fit viewport');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  assert.deepEqual(externalRequests, [], 'browser data goes only to the same-origin private API');
  // Simulate closing/reopening a browser: restore only persisted browser state,
  // with no IndexedDB recipe cache and without entering credentials again.
  const cookieState = await context.storageState();
  const sessionCookie = cookieState.cookies.find(cookie => cookie.name === 'fengwei_session');
  assert.equal(sessionCookie.httpOnly, true);
  assert.ok(sessionCookie.expires > Date.now() / 1000 + 89 * 24 * 3600);
  assert.ok(!sessionCookie.value.includes(password));
  const resumed = await browser.newContext({ storageState: cookieState });
  const reopened = await resumed.newPage();
  await reopened.goto('http://localhost:4182');
  await reopened.getByRole('button', { name: '查看 服务器记录的清汤面' }).waitFor();
  assert.equal(await reopened.locator('#login-form').count(), 0);
  await resumed.close();
  // Restart the HTTP server without retaining its process memory.
  await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  server = await startServer();
  const afterRestart = await other.request.get('http://localhost:4182/api/recipes');
  assert.equal(afterRestart.status(), 200);
  assert.equal((await afterRestart.json()).items.filter(item => !item.deleted).length, 2);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByRole('button', { name: '打开菜谱本' }).waitFor();
  await context.setOffline(true); await page.reload();
  await page.getByRole('heading', { name: '菜谱本暂时打不开' }).waitFor();
  assert.equal(await page.locator('.recipe-card').count(), 0, 'logout clears cached private server recipes');
  await second.close();
  await writeFile(resolve(output, 'verification.json'), JSON.stringify({ passed: true, viewport: '390x844 and 1280x950', checks: ['account/password login', 'persistent cookie resumes without login', 'authenticated server CRUD', 'photo compression and persistence', 'favorite and search', 'cook steps', 'backup export and import with photos', 'history restoration', 'two independent devices', 'stale editor rejection retains draft', 'offline read-only cache', 'offline write rejection', 'server restart persistence', 'cached shell startup', 'logout clears private cache', 'no external browser requests', 'no runtime errors'], limitation: 'Local persistence adapter verified; real EdgeOne deployment/storage requires upload to the owner project.' }, null, 2));
  console.log('Browser smoke checks passed. Screenshots and verification are in artifacts/.');
} finally { await browser.close(); server.kill(); }
