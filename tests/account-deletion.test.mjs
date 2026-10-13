import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';
import { myPages } from '../dist/my.js';

const password = 'account-deletion-tests-only';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-account-deletion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root), database = new RecipeDatabase(store);
  let api = createApi({ database, password });
  const call = (path, { method = 'GET', data, cookie, origin = 'https://recipes.test' } = {}) => api(new Request(`https://recipes.test/api/${path}`, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }));
  const profile = async response => ({ status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], user: (await response.json()).user });
  const login = username => call('login', { method: 'POST', data: { username, password } });
  const owner = await profile(await login('wupanfeng'));
  const register = (displayName, registrationId = randomUUID()) => call('register', { method: 'POST', data: { displayName, registrationId, password } });
  const one = await profile(await register('legacy-one')), two = await profile(await register('legacy-two'));
  const other = await profile(await register('untouched-account'));
  for (const account of [one, two]) {
    const key = `private/users/${account.user.id}.json`, record = await store.get(key, { type: 'json' });
    record.displayName = 'wangxiaoyun'; await store.setJSON(key, record); account.user.displayName = record.displayName;
  }
  const data = { accounts: [one, two].map(item => ({ id: item.user.id, displayName: item.user.displayName })), mutationId: randomUUID() };
  const remove = (input = data, cookie = owner.cookie) => call('accounts/delete', { method: 'POST', cookie, data: input });
  return { store, database, call, profile, login, owner, one, two, other, data, register, remove, replace(storage = new FileStore(root)) { api = createApi({ database: new RecipeDatabase(storage), password }); } };
}

test('administrator removes both legacy duplicate accounts and invalidates their sessions while retaining shared recipes and unrelated users', async t => {
  const f = await fixture(t);
  const ambiguous = await f.login('wangxiaoyun');
  assert.equal(ambiguous.status, 400); assert.equal((await ambiguous.json()).code, 'USERNAME_AMBIGUOUS');
  const recipe = { id: 'retained-recipe', title: '保留菜谱', description: '', category: '家常菜', minutes: 5, servings: 2, favorite: false, photo: '', notes: '', ingredients: [], steps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const original = await f.database.commit({ id: recipe.id, recipe, baseRevision: null, mutationId: randomUUID() });
  await f.store.setJSON(`private/favorites/${f.one.user.id}/retained.json`, { preserved: true });
  const response = await f.remove(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).deletedIds, f.data.accounts.map(item => item.id));
  for (const account of [f.one, f.two]) {
    assert.equal((await f.call('me', { cookie: account.cookie })).status, 401);
    assert.equal((await f.login(account.user.id)).status, 401);
  }
  assert.equal((await f.call('me', { cookie: f.other.cookie })).status, 200);
  assert.equal((await f.call('me', { cookie: f.owner.cookie })).status, 200);
  assert.equal((await f.database.latest(recipe.id)).revision, original.revision);
  assert.deepEqual(await f.store.get(`private/favorites/${f.one.user.id}/retained.json`, { type: 'json' }), { preserved: true });
  const accounts = (await (await f.call('permissions', { cookie: f.owner.cookie })).json()).accounts;
  assert.equal(accounts.filter(item => item.displayName === 'wangxiaoyun').length, 0);
  const logs = await (await f.call('audit?q=' + encodeURIComponent('删除账号 wangxiaoyun'), { cookie: f.owner.cookie })).json();
  assert.equal(logs.items.filter(item => item.result === 'success').length, 2);
  for (const account of f.data.accounts) assert(logs.items.some(item => item.target.includes(account.id)));
  assert.equal((await f.remove()).status, 200, 'same request can be retried');
  f.replace(); assert.equal((await f.call('me', { cookie: f.one.cookie })).status, 401);
});

test('deletion validates every target first and protects administrator, non-admin and cross-origin access', async t => {
  const f = await fixture(t);
  assert.equal((await f.remove(f.data, '')).status, 401);
  assert.equal((await f.remove(f.data, f.other.cookie)).status, 403);
  assert.equal((await f.call('accounts/delete', { method: 'POST', cookie: f.owner.cookie, data: f.data, origin: 'https://other.test' })).status, 403);
  const cases = [
    [{ ...f.data, accounts: [...f.data.accounts, { id: f.owner.user.id, displayName: 'wupanfeng' }] }, 403],
    [{ ...f.data, accounts: [f.data.accounts[0], { id: f.other.user.id, displayName: 'wangxiaoyun' }] }, 409],
    [{ ...f.data, accounts: [f.data.accounts[0], { id: 'usr_' + '0'.repeat(32), displayName: 'missing' }] }, 404],
    [{ ...f.data, accounts: [f.data.accounts[0], f.data.accounts[0]] }, 400],
    [{ ...f.data, mutationId: 'invalid' }, 400],
  ];
  for (const [input, status] of cases) assert.equal((await f.remove(input)).status, status);
  assert.equal((await f.store.list({ prefix: 'private/deleted-users/' })).blobs.length, 0);
  assert.equal((await f.call('me', { cookie: f.one.cookie })).status, 200);
});

test('deletion works when Blob ignores conditional writes; it does not claim to fix registration', async t => {
  const f = await fixture(t);
  f.replace({ get: f.store.get.bind(f.store), list: f.store.list.bind(f.store), setJSON: (key, value, options) => f.store.setJSON(key, value, { ...options, onlyIfNew: false }) });
  assert.equal((await f.remove()).status, 200);
  assert.equal((await f.call('me', { cookie: f.one.cookie })).status, 401);
  const registration = await f.register('wangxiaoyun');
  assert.equal(registration.status, 503); assert.equal((await registration.json()).code, 'UNIQUE_STORAGE_UNAVAILABLE');
});

test('deleted usernames can be claimed once with compatible storage; old registration retries and sessions cannot revive deleted accounts', async t => {
  const f = await fixture(t), nonce = randomUUID();
  const previous = await f.profile(await f.register('reusable-name', nonce));
  assert.equal((await f.remove({ accounts: [{ id: previous.user.id, displayName: 'reusable-name' }], mutationId: randomUUID() })).status, 200);
  const retry = await f.register('reusable-name', nonce);
  assert.equal(retry.status, 409); assert.equal((await retry.json()).code, 'ACCOUNT_DELETED');
  const outcomes = await Promise.all([f.register('REUSABLE-NAME'), f.register(' reusable-name ')]);
  assert.deepEqual(outcomes.map(item => item.status).sort(), [201, 409]);
  const replacement = await f.profile(outcomes.find(item => item.status === 201));
  assert.notEqual(replacement.user.id, previous.user.id); assert.equal(replacement.user.role, 'viewer');
  assert.equal((await f.call('me', { cookie: previous.cookie })).status, 401);
  assert.equal((await f.call('me', { cookie: replacement.cookie })).status, 200);
  f.replace(); assert.equal((await f.login('reusable-name')).status, 200);
});

test('partial storage failure is reported and retries complete deletion; durable receipts survive audit index failure', async t => {
  const f = await fixture(t); let blockSecond = true;
  f.replace({ get: f.store.get.bind(f.store), list: f.store.list.bind(f.store), async setJSON(key, value, options) {
    if (key.startsWith('private/audit/') || (blockSecond && key === `private/deleted-users/${f.two.user.id}.json`)) throw Object.assign(new Error('Injected failure'), { code: 'TEST_FAILURE' });
    return f.store.setJSON(key, value, options);
  } });
  const failed = await f.remove(); assert.equal(failed.status, 503);
  const error = await failed.json(); assert.equal(error.code, 'ACCOUNT_DELETE_PARTIAL'); assert.match(error.error, /已确认删除 1 个/);
  assert.equal((await f.call('me', { cookie: f.one.cookie })).status, 401);
  assert.equal((await f.call('me', { cookie: f.two.cookie })).status, 200);
  blockSecond = false;
  assert.equal((await f.remove()).status, 200);
  const logs = await (await f.call('audit?q=' + encodeURIComponent('删除账号 wangxiaoyun'), { cookie: f.owner.cookie })).json();
  assert.equal(logs.items.filter(item => item.result === 'success').length, 2);
});

test('administrator page identifies duplicate IDs, dates and group deletion; ordinary users get no deletion controls', () => {
  const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const pages = myPages({ icon: () => '', esc: escape });
  const accounts = [{ id: 'usr_' + '1'.repeat(32), displayName: 'wangxiaoyun', createdAt: '2026-10-12T01:00:00Z', role: 'viewer' }, { id: 'usr_' + '2'.repeat(32), displayName: 'WANGXIAOYUN', createdAt: '2026-10-12T02:00:00Z', role: 'viewer' }];
  const html = pages.permissions({ role: 'admin' }, { accounts, requests: [] });
  assert.match(html, /删除这 2 个同名账号/); assert.match(html, /注册时间/);
  for (const item of accounts) assert(html.includes(item.id));
  assert.equal((html.match(/data-scope="duplicates"/g) || []).length, 1);
  assert(!pages.permissions({ role: 'viewer' }, { requests: [] }).includes('data-action="account-delete"'));
});
