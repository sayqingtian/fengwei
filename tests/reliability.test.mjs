import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';
import { createAuth, testAccount, SESSION_SECONDS } from '../server/auth.mjs';
import { createRemoteStore } from '../dist/sync.js';
import { createDraftStore } from '../dist/drafts.js';
import { AuditRetention } from '../server/audit-retention.mjs';
import { cleanAudit } from '../scripts/clean-audit.mjs';
import { watchUpdates } from '../dist/updates.js';

const password = 'reliability-isolated-test-password';
const recipe = (id = 'reliable') => ({ id, title: '弱网也能保存的菜', category: '家常菜', description: '', notes: '', minutes: 10, servings: 2, favorite: false, photo: 'data:image/png;base64,YQ==', ingredients: [{ name: '鸡蛋', amount: '2 个' }], steps: ['炒熟'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-reliability-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root), database = new RecipeDatabase(store), api = createApi({ database, password });
  const call = (path, method = 'GET', value, cookie) => api(new Request(`https://recipes.test/api/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(value ? { 'Content-Type': 'application/json', Origin: 'https://recipes.test' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) }));
  const login = () => call('login', 'POST', { username: 'wupanfeng', password });
  const response = await login(), cookie = cookieOf(response), user = (await response.json()).user;
  return { store, database, api, call, login, cookie, user };
}
function localStore() {
  const data = new Map();
  return { data, async setting(key) { return structuredClone(data.get(key)); }, async setSetting(key, value) { data.set(key, structuredClone(value)); } };
}
function connect(t, f) {
  const original = globalThis.fetch; let cookie = f.cookie;
  const state = { failures: 0, offline: false, writes: [], afterCommit: null };
  globalThis.fetch = async (url, options = {}) => {
    if (state.offline) throw new Error('Network disconnected');
    const target = new URL(url), path = target.pathname.split('/api/')[1] + target.search;
    const response = await f.api(new Request(`https://recipes.test/api/${path}`, { ...options, headers: { ...options.headers, Cookie: cookie, Origin: 'https://recipes.test' } }));
    if (path.startsWith('recipe/') && options.method === 'PUT') {
      state.writes.push(options.body);
      if (response.ok && state.failures-- > 0) { if (state.afterCommit) await state.afterCommit(); throw new Error('Successful response lost'); }
    }
    cookie = cookieOf(response) || cookie; return response;
  };
  t.after(() => { globalThis.fetch = original; }); return state;
}

test('a lost successful reply retries the identical photo packet once without duplicate history', async t => {
  const f = await fixture(t), network = connect(t, f), client = await createRemoteStore(localStore()); await client.all();
  network.failures = 1;
  await client.put(recipe());
  assert.equal(network.writes.length, 2); assert.deepEqual(network.writes[0], network.writes[1]);
  assert.equal((await f.database.history('reliable')).length, 1);
  assert.equal(client.current()[0].photo, recipe().photo);
});

test('uncertain save survives reload and confirms the old mutation despite a new updatedAt', async t => {
  const f = await fixture(t), network = connect(t, f), local = localStore(), first = await createRemoteStore(local); await first.all();
  const input = recipe(); network.failures = 3;
  await assert.rejects(first.put(input, { baseRevision: null }), error => error.code === 'NETWORK');
  assert.equal((await f.database.history(input.id)).length, 1);
  const restored = await createRemoteStore(local); await restored.all();
  await restored.put({ ...input, updatedAt: new Date(Date.now() + 1000).toISOString() }, { baseRevision: null });
  assert.equal((await f.database.history(input.id)).length, 1);
  assert.deepEqual(local.data.get(`fengwei-user:${restored.user.id}:pendingWrites`), {});
});

test('changed text after an uncertain save is based on its confirmed revision and never overwrites another writer', async t => {
  const f = await fixture(t), network = connect(t, f), client = await createRemoteStore(localStore()); await client.all();
  const input = recipe(); network.failures = 3;
  await assert.rejects(client.put(input, { baseRevision: null }));
  await client.put({ ...input, title: '追加修改' }, { baseRevision: null });
  assert.equal((await f.database.latest(input.id)).recipe.title, '追加修改');
  assert.equal((await f.database.history(input.id)).length, 2);
  const base = client.revision(input.id); network.failures = 3;
  await assert.rejects(client.put({ ...input, title: '手机修改' }, { baseRevision: base }));
  const saved = await f.database.latest(input.id);
  await f.database.commit({ id: input.id, recipe: { ...input, title: '其他设备的新版本' }, baseRevision: saved.revision, mutationId: randomUUID() });
  await assert.rejects(client.put({ ...input, title: '继续输入' }, { baseRevision: base }), error => error.code === 'CONFLICT');
  assert.equal((await f.database.latest(input.id)).recipe.title, '其他设备的新版本');
});

test('logout revokes only this session, is repeatable, and logout-all invalidates all previous devices', async t => {
  const f = await fixture(t), second = cookieOf(await f.login());
  assert.equal((await f.call('logout', 'POST', {}, f.cookie)).status, 200);
  assert.equal((await f.call('me', 'GET', undefined, f.cookie)).status, 401);
  assert.equal((await f.call('me', 'GET', undefined, second)).status, 200);
  assert.equal((await f.call('logout', 'POST', {}, f.cookie)).status, 200);
  const third = cookieOf(await f.login());
  assert.equal((await f.call('logout', 'POST', { all: true, expectedUserId: f.user.id }, second)).status, 200);
  assert.equal((await f.call('logout', 'POST', { all: true, expectedUserId: f.user.id }, second)).status, 200, 'a lost logout-all response is repeatable');
  assert.equal((await f.call('logout', 'POST', { all: true })).status, 401, 'anonymous logout cannot claim all devices were revoked');
  for (const cookie of [f.cookie, second, third]) assert.equal((await f.call('me', 'GET', undefined, cookie)).status, 401);
  assert.equal((await f.call('me', 'GET', undefined, cookieOf(await f.login()))).status, 200);
});

test('renewed cookies share revocation and an in-flight renewal cannot undo logout-all', async t => {
  const f = await fixture(t), auth = createAuth(f.store, testAccount(password));
  const token = await auth.issue(Date.now() - (SESSION_SECONDS - 1000) * 1000);
  const old = `fengwei_session=${token}`;
  const response = await f.call('me', 'GET', undefined, old), renewed = cookieOf(response);
  assert.ok(renewed);
  await f.call('logout', 'POST', {}, renewed);
  assert.equal((await f.call('me', 'GET', undefined, old)).status, 401);
  const fresh = cookieOf(await f.login());
  const session = await auth.verify(new Request('https://recipes.test/api/me', { headers: { Cookie: fresh } }));
  await auth.revoke(session, true);
  const raced = await auth.issue(session.account, undefined, session);
  assert.equal((await f.call('me', 'GET', undefined, `fengwei_session=${raced}`)).status, 401);
});

test('offline logout clears cache immediately, blocks cookie re-entry after reload and completes on reconnect', async t => {
  const f = await fixture(t), network = connect(t, f), local = localStore(), client = await createRemoteStore(local); await client.all();
  const previousCookie = f.cookie; network.offline = true;
  assert.equal(await client.logout(), true); assert.equal(client.user, null); assert.deepEqual(client.current(), []);
  assert.equal(local.data.get('fengwei-server-cache-v2'), null); assert.equal(client.pendingLogout, true);
  const reopened = await createRemoteStore(local);
  await assert.rejects(reopened.all(), error => error.status === 401); assert.equal(reopened.user, null);
  network.offline = false; await reopened.completeLogout();
  assert.equal(reopened.pendingLogout, false);
  assert.equal((await f.call('me', 'GET', undefined, previousCookie)).status, 401);
  await reopened.login('wupanfeng', password); await reopened.all(); assert.equal(reopened.user.id, f.user.id);
});

test('trash recovers a photo and ingredients even after more than ten tombstones, and rejects viewer writes', async t => {
  const f = await fixture(t), input = recipe('deleted-dish');
  let latest = await f.database.commit({ id: input.id, recipe: input, baseRevision: null, mutationId: randomUUID() });
  const version = latest.revision;
  for (let i = 0; i < 11; i++) latest = await f.database.commit({ id: input.id, baseRevision: latest.revision, mutationId: randomUUID() });
  const trash = await (await f.call('trash', 'GET', undefined, f.cookie)).json();
  assert.equal(trash.items[0].version, version); assert.equal(trash.items[0].title, input.title);
  const viewer = await f.call('register', 'POST', { displayName: '回收站只读账号', password, registrationId: randomUUID() });
  assert.equal((await f.call('trash', 'GET', undefined, cookieOf(viewer))).status, 403);
  const client = await createRemoteStore(); connect(t, f); await client.all();
  const [saved] = await client.history(input.id, version); assert.equal(saved.recipe.photo, input.photo);
  await client.put(saved.recipe, { baseRevision: latest.revision, operation: 'restore' });
  assert.deepEqual(client.current()[0].ingredients, input.ingredients);
  assert.equal((await f.database.trash()).items.length, 0);
  assert.equal((await f.database.latest(input.id)).auditEntry.action, 'recipe.restore');
});

function memoryStorage() {
  const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
test('draft reload preserves raw incomplete form, photo and original base, with account isolation and explicit cleanup', () => {
  const storage = memoryStorage(), a = 'usr_' + 'a'.repeat(32), b = 'usr_' + 'b'.repeat(32), drafts = createDraftStore(storage);
  const draft = { recipe: { ...recipe(), title: '', minutes: '', ingredients: [{ name: '', amount: '半碗' }], steps: ['', '先备料'] }, baseRevision: 'original-revision', isNew: false };
  drafts.save(a, draft); drafts.save(b, { ...draft, recipe: recipe('other') });
  const restored = createDraftStore(storage).list(a)[0];
  assert.deepEqual(restored.recipe, draft.recipe); assert.equal(restored.baseRevision, 'original-revision');
  drafts.remove(a, draft.recipe.id); assert.equal(drafts.list(a).length, 0); assert.equal(drafts.list(b).length, 1);
  drafts.save(a, draft); drafts.clear(a); assert.equal(drafts.list(a).length, 0); assert.equal(drafts.list(b).length, 1);
});
test('draft quota failure is surfaced without deleting the previous saved draft', () => {
  const storage = memoryStorage(), id = 'usr_' + 'c'.repeat(32), drafts = createDraftStore(storage);
  drafts.save(id, { recipe: recipe(), isNew: true, baseRevision: null });
  storage.setItem = () => { throw Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' }); };
  assert.throws(() => drafts.save(id, { recipe: recipe('unsaved') }), { name: 'QuotaExceededError' });
  assert.equal(drafts.list(id)[0].recipe.id, 'reliable');
});

test('cleanup persists failure and resumes, reports completion, and lists each prefix once per batch', async t => {
  const f = await fixture(t), old = new Date(Date.now() - 9 * 86400000).toISOString();
  for (let i = 0; i < 22; i++) await f.store.setJSON(`private/audit/old-${String(i).padStart(2, '0')}.json`, { createdAt: old });
  const originalDelete = f.store.delete.bind(f.store), originalList = f.store.list.bind(f.store); let broken = true, lists = 0;
  f.store.delete = async key => { if (broken && key.endsWith('old-12.json')) throw new Error('Temporary storage outage'); return originalDelete(key); };
  f.store.list = options => { lists++; return originalList(options); };
  const cleanup = new AuditRetention(f.store);
  await assert.rejects(cleanup.run({ maxRecords: 50, budgetMs: 5000 }));
  assert.equal((await cleanup.status()).complete, false); assert.ok((await cleanup.status()).failedAt);
  broken = false; lists = 0;
  let status; do { status = await cleanup.run({ maxRecords: 3, budgetMs: 5000 }); } while (!status.complete);
  assert.equal((await cleanup.status()).error, null); assert.ok((await cleanup.status()).lastCompletedAt);
  assert.equal((await f.store.list({ prefix: 'private/audit/old-' })).blobs.length, 0);
  assert.ok(lists < 22, 'bounded batches do not repeatedly list after every object');
  assert.equal((await f.call('admin/audit-retention', 'GET', undefined, f.cookie)).status, 200);
  assert.equal((await f.call('admin/audit-retention')).status, 401);
});
test('scheduled runner follows partial batches and rate limits, and reports repeated failures', async () => {
  const responses = [new Response('', { status: 429 }), Response.json({ ok: true, complete: false }), Response.json({ ok: true, complete: true })], delays = [];
  await cleanAudit({ send: async () => responses.shift(), pause: async ms => delays.push(ms), log() {} });
  assert.equal(responses.length, 0); assert.ok(delays.every(ms => ms >= 65000));
  let attempts = 0;
  await assert.rejects(cleanAudit({ send: async () => { attempts++; throw new Error('Unavailable'); }, pause: async () => {}, log() {} }), /Unavailable/);
  assert.equal(attempts, 3);
});
test('update watcher detects an already waiting or newly installed worker without automatic activation', () => {
  const registration = new EventTarget(), container = new EventTarget(), worker = new EventTarget(); let notices = 0, changes = 0, activations = 0;
  worker.postMessage = () => activations++; worker.state = 'installing'; registration.installing = worker; container.controller = {};
  const stop = watchUpdates(registration, container, { ready: () => notices++, changed: () => changes++ });
  assert.equal(notices, 0); worker.state = 'installed'; registration.waiting = worker; worker.dispatchEvent(new Event('statechange'));
  assert.equal(notices, 1); assert.equal(activations, 0);
  container.dispatchEvent(new Event('controllerchange')); assert.equal(changes, 1); stop();
  watchUpdates(registration, container, { ready: () => notices++, changed() {} }); assert.equal(notices, 2);
});

test('first service-worker installation does not show an update banner', () => {
  const registration = new EventTarget(), container = new EventTarget(), worker = new EventTarget(); let notices = 0;
  registration.installing = worker; container.controller = null;
  watchUpdates(registration, container, { ready: () => notices++, changed: () => notices++ });
  worker.state = 'installed'; worker.dispatchEvent(new Event('statechange'));
  container.controller = worker; container.dispatchEvent(new Event('controllerchange'));
  assert.equal(notices, 0);
});

test('an unreachable logout returns immediately and reconnect plus login share a single pending revocation', async t => {
  const f = await fixture(t), original = globalThis.fetch, local = localStore();
  t.after(() => { globalThis.fetch = original; });
  let cookie = f.cookie, release, logoutCalls = 0, loginCalls = 0;
  const hold = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url), path = target.pathname.split('/api/')[1];
    if (path === 'logout') { logoutCalls++; await hold; }
    if (path === 'login') loginCalls++;
    const response = await f.api(new Request(`https://recipes.test/api/${path}`, { ...options, headers: { ...options.headers, Cookie: cookie, Origin: 'https://recipes.test' } }));
    cookie = cookieOf(response) || cookie; return response;
  };
  const client = await createRemoteStore(local); await client.all();
  let timeout;
  await Promise.race([client.logout(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Local logout waited for server')), 500); })]).finally(() => clearTimeout(timeout));
  assert.equal(client.user, null); assert.equal(local.data.get('fengwei-server-cache-v2'), null);
  const reconnect = client.completeLogout(), login = client.login('wupanfeng', password);
  assert.equal(logoutCalls, 1); assert.equal(loginCalls, 0);
  release(); await reconnect; await login;
  assert.equal(logoutCalls, 1); assert.equal(loginCalls, 1);
  await client.all(); assert.equal(client.user.id, f.user.id);
});
