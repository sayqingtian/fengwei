import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-checkins-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = new FileStore(root), database = new RecipeDatabase(source), password = 'checkin-fixture-password';
  let api = createApi({ database, password });
  const call = (path, method = 'GET', data, cookie, origin = 'https://recipes.test') => api(new Request(`https://recipes.test/api/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json', Origin: origin } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }));
  const owner = await call('login', 'POST', { username: 'wupanfeng', password });
  const ownerCookie = owner.headers.get('set-cookie').split(';')[0];
  async function register(name) { const res = await call('register', 'POST', { displayName: name, password, registrationId: randomUUID() }); return { user: (await res.json()).user, cookie: res.headers.get('set-cookie').split(';')[0] }; }
  const first = await register('打卡测试甲'), second = await register('打卡测试乙');
  const recipe = { id: 'checkin-dish', title: '番茄炒蛋', category: '家常菜', description: '', notes: '', minutes: 15, servings: 2, photo: '', favorite: false, ingredients: [], steps: ['做好'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const saved = await database.commit({ id: recipe.id, recipe, baseRevision: null, mutationId: randomUUID() });
  return { call, first, second, ownerCookie, source, recipe, saved, database, restart() { api = createApi({ database: new RecipeDatabase(new FileStore(root)), password }); } };
}

test('viewers privately record repeated meals, retries have one durable winner, and deleted dishes retain their history', async t => {
  const f = await fixture(t), data = { recipeId: f.recipe.id, note: ' 今天做得不错 ', mutationId: randomUUID(), expectedUserId: f.first.user.id };
  const res = await f.call('checkins', 'POST', data, f.first.cookie); assert.equal(res.status, 201);
  const item = (await res.json()).item; assert.equal(item.note, '今天做得不错'); assert.equal(item.title, '番茄炒蛋'); assert.ok(Date.parse(item.cookedAt)); assert.equal(item.auditEntry, undefined);
  const [one, two] = await Promise.all([f.call('checkins', 'POST', data, f.first.cookie), f.call('checkins', 'POST', data, f.first.cookie)]);
  assert.deepEqual((await one.json()).item, item); assert.deepEqual((await two.json()).item, item);
  assert.equal((await f.call('checkins', 'POST', { ...data, note: '更改内容' }, f.first.cookie)).status, 409);
  const concurrent = { ...data, mutationId: randomUUID() };
  await Promise.all([f.call('checkins', 'POST', concurrent, f.first.cookie), f.call('checkins', 'POST', concurrent, f.first.cookie)]);
  const list = await (await f.call('checkins', 'GET', undefined, f.first.cookie)).json(); assert.equal(list.total, 2); assert.equal(list.dishes, 1);
  assert.equal((await (await f.call('checkins', 'GET', undefined, f.second.cookie)).json()).total, 0);
  assert.equal((await (await f.call(`checkins?userId=${f.first.user.id}`, 'GET', undefined, f.second.cookie)).json()).total, 0);
  await f.database.commit({ id: f.recipe.id, recipe: null, baseRevision: f.saved.revision, mutationId: randomUUID() }); f.restart();
  assert.equal((await (await f.call('checkins', 'GET', undefined, f.first.cookie)).json()).total, 2);
  assert.deepEqual((await (await f.call('checkins', 'POST', data, f.first.cookie)).json()).item, item, 'lost reply remains recoverable after dish deletion');
  assert.equal((await f.call('checkins', 'POST', { ...data, mutationId: randomUUID() }, f.first.cookie)).status, 404);
  const audit = await (await f.call('audit?q=制作完成打卡', 'GET', undefined, f.ownerCookie)).json();
  assert.equal(audit.items.filter(item => item.result === 'success').length, 2); assert.ok(!JSON.stringify(audit).includes('今天做得不错'));
});

test('check-ins validate input and block anonymous, cross-origin, and switched-account submissions', async t => {
  const f = await fixture(t), data = { recipeId: f.recipe.id, note: '', mutationId: randomUUID(), expectedUserId: f.first.user.id };
  assert.equal((await f.call('checkins')).status, 401); assert.equal((await f.call('checkins', 'POST', data)).status, 401);
  assert.equal((await f.call('checkins', 'POST', data, f.first.cookie, 'https://other.test')).status, 403);
  assert.equal((await f.call('checkins', 'POST', data, f.second.cookie)).status, 409);
  for (const invalid of [{ recipeId: '../bad' }, { mutationId: '../../bad' }, { note: '中'.repeat(1001) }, { note: {} }]) assert.equal((await f.call('checkins', 'POST', { ...data, ...invalid }, f.first.cookie)).status, 400);
  assert.equal((await f.call('checkins?cursor=broken', 'GET', undefined, f.first.cookie)).status, 400);
});

test('check-in pagination keeps equal-timestamp meals without omission or duplication', async t => {
  const f = await fixture(t), items = Array.from({ length: 56 }, () => ({ id: randomUUID(), recipeId: f.recipe.id, title: f.recipe.title, note: '', cookedAt: '2026-10-16T05:00:00.000Z' }));
  const { CookingCheckins } = await import('../server/checkins.mjs'), { hash } = await import('../server/database.mjs');
  const checkins = new CookingCheckins(f.source);
  await Promise.all(items.map(item => f.source.setJSON(`${checkins.prefix(f.first.user.id)}${hash(item.id)}.json`, item)));
  const first = await checkins.list(f.first.user.id); assert.equal(first.items.length, 50); assert.equal(first.total, 56); assert.ok(first.cursor);
  const second = await checkins.list(f.first.user.id, first.cursor); assert.equal(second.items.length, 6); assert.equal(second.cursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 56);
});
