import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const playwright = await import(process.env.RECIPE_PLAYWRIGHT ? pathToFileURL(process.env.RECIPE_PLAYWRIGHT).href : 'playwright');
const browser = await playwright.chromium.launch({ headless: true, ...(process.env.RECIPE_BROWSER ? { executablePath: process.env.RECIPE_BROWSER } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const externalRequests = []; page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://localhost:4173')) externalRequests.push(request.url()); });
const output = resolve('artifacts'); await mkdir(output, { recursive: true });
let exported;
try {
  await page.goto('http://localhost:4173');
  await page.getByRole('heading', { name: '第一道菜，想记点什么？' }).waitFor();
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

  await page.getByRole('navigation', { name: '底部导航' }).getByRole('button', { name: '备份', exact: true }).click();
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
  await page.getByRole('navigation', { name: '底部导航' }).getByRole('button', { name: '备份', exact: true }).click();
  await page.locator('#import-file').setInputFiles(exportPath);
  await page.getByRole('heading', { name: '已读到 1 道菜谱' }).waitFor();
  await page.getByRole('button', { name: '确认导入' }).click();
  await page.getByRole('status').filter({ hasText: '导入完成' }).waitFor();
  await page.getByRole('navigation', { name: '底部导航' }).getByRole('button', { name: '菜谱本' }).click();
  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).waitFor();

  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: '查看 奶奶的番茄炒蛋（改良版）' }).waitFor();
  await page.getByRole('button', { name: '记一道新菜' }).click();
  await page.getByRole('textbox', { name: '菜名' }).fill('离线记录的清汤面');
  await page.getByRole('button', { name: '保存这道菜' }).click();
  await page.getByRole('dialog').getByRole('heading', { name: '离线记录的清汤面' }).waitFor();
  await page.getByRole('button', { name: '关闭菜谱' }).click();
  await page.reload();
  await page.getByRole('button', { name: '查看 离线记录的清汤面' }).waitFor();
  assert.equal(await page.locator('.recipe-card').count(), 2);
  await page.screenshot({ path: resolve(output, 'mobile-recipes.png'), fullPage: true });

  await context.setOffline(false);
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.screenshot({ path: resolve(output, 'desktop-recipes.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'desktop layout must fit viewport');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  assert.deepEqual(externalRequests, [], 'the application does not upload recipes or load remote resources');
  await writeFile(resolve(output, 'verification.json'), JSON.stringify({ passed: true, viewport: '390x844 and 1280x950', checks: ['create', 'photo compression', 'edit', 'favorite', 'ingredient and notes search', 'cook steps', 'reload persistence', 'unsaved-change protection', 'delete confirmation', 'backup with photos', 'invalid backup rejection', 'restore backup', 'offline reload', 'offline create and persistence', 'no external app requests', 'no runtime errors'] }, null, 2));
  console.log('Browser smoke checks passed. Screenshots and verification are in artifacts/.');
} finally { await browser.close(); }
