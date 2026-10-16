import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { RecipeDatabase, hash } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';
import { createRemoteStore } from '../dist/sync.js';
import { createOutbox } from '../dist/outbox.js';
import { backupKey, FullBackup } from '../server/full-backup.mjs';
import { createAccountStore } from '../server/account-store.mjs';
import { Favorites } from '../server/favorites.mjs';

const password = 'optimistic-isolated-test-password';
const recipe = (id = 'async-recipe') => ({ id, title: '本机立即保存', category: '家常菜', description: '', notes: '', minutes: 10, servings: 2, favorite: false, photo: 'data:image/png;base64,YQ==', ingredients: [{ name: '鸡蛋', amount: '2 个' }], steps: ['炒熟'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
function localStore() {
  const data = new Map();
  return { data, async setting(key) { return structuredClone(data.get(key)); }, async setSetting(key, value) { data.set(key, structuredClone(value)); }, async updateSetting(key, work) { const next = work(structuredClone(data.get(key))); data.set(key, structuredClone(next)); return next; } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-optimistic-')); t.after(() => rm(root, { recursive: true, force: true }));
  const raw = new FileStore(root), store = createAccountStore(raw), database = new RecipeDatabase(store), api = createApi({ database: new RecipeDatabase(raw), password });
  const call = (path, method = 'GET', value, cookie) => api(new Request(`https://recipes.test/api/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(value ? { 'Content-Type': 'application/json', Origin: 'https://recipes.test' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) }));
  const login = await call('login', 'POST', { username: 'wupanfeng', password });
  const cookie = cookieOf(login), user = (await login.json()).user;
  const original = globalThis.fetch, state = { before: null, after: null, offline: false };
  let activeCookie = cookie;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url), path = target.pathname.split('/api/')[1] + target.search;
    if (state.offline) throw new Error('Disconnected');
    const mocked = await state.before?.(path, options); if (mocked) return mocked;
    const response = await api(new Request(`https://recipes.test/api/${path}`, { ...options, headers: { ...options.headers, Cookie: activeCookie, Origin: 'https://recipes.test' } }));
    activeCookie = cookieOf(response) || activeCookie;
    await state.after?.(path, options, response); return response;
  };
  t.after(() => { globalThis.fetch = original; });
  const clients = [];
  t.after(async () => { for (const client of clients) await client.forget(false); });
  async function client(local = localStore()) { const result = await createRemoteStore(local); clients.push(result); await result.all(); return result; }
  return { raw, store, database, call, cookie, user, state, client };
}
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function fast(work) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local action waited for server')), 500); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(check()); }

test('three meals sync concurrently while local interactions continue and deletion follows its own create', async t => {
  const f = await fixture(t), client = await f.client(); await client.put(recipe());
  const hold = gate(), started = new Set(); t.after(() => hold.release());
  f.state.before = async (path, options) => {
    if (path === 'checkins' && options.method === 'POST') { started.add(JSON.parse(options.body).mutationId); await hold.promise; }
  };
  const values = Array.from({ length: 3 }, (_, index) => ({ recipeId: recipe().id, note: `并发 ${index}`, mutationId: randomUUID(), expectedUserId: f.user.id }));
  for (const value of values) await fast(client.queueCheckin(value, recipe().title));
  await eventually(() => started.size === 3);
  await fast(client.queueFavorite(recipe().id, true)); assert.equal(client.current()[0].favorite, true);
  await fast(client.queueDeleteCheckin({ id: values[0].mutationId, title: recipe().title }));
  assert.equal(client.syncJobs.length, 5);
  hold.release(); await client.resumeSync(); assert.equal(client.syncJobs.length, 0);
  const list = await client.checkins(); assert.equal(list.total, 2);
  assert.ok(list.items.every(item => item.id !== values[0].mutationId));
});

test('queued meals survive reload and lost replies with one server record per mutation', async t => {
  const f = await fixture(t), local = localStore(), client = await f.client(local); await client.put(recipe());
  let failures = 3;
  f.state.after = (path, options, response) => { if (path === 'checkins' && options.method === 'POST' && response.ok && failures-- > 0) throw new Error('Reply lost'); };
  const value = { recipeId: recipe().id, note: '心得保留', mutationId: randomUUID(), expectedUserId: f.user.id };
  await fast(client.queueCheckin(value, recipe().title)); await client.resumeSync();
  assert.equal(client.syncJobs.length, 1); assert.equal((await client.checkins()).total, 1);
  await client.forget(false);
  f.state.after = null;
  const restored = await f.client(local); await restored.resumeSync();
  assert.equal(restored.syncJobs.length, 0);
  assert.deepEqual((await restored.checkins()).items.map(item => [item.id, item.note]), [[value.mutationId, value.note]]);
});

test('new recipe returns after durable local save while upload is held; backup cannot silently omit it', async t => {
  const f = await fixture(t), client = await f.client(), hold = gate();
  f.state.before = async path => { if (path.startsWith('recipe/')) await hold.promise; };
  await fast(client.queuePut(recipe(), { baseRevision: null }));
  assert.equal(client.current()[0].title, recipe().title); assert.equal(client.syncJobs.length, 1);
  assert.match(client.revision(recipe().id), /^local:/);
  await assert.rejects(client.backupSnapshot(), { code: 'PENDING_SYNC' });
  hold.release(); await client.resumeSync();
  assert.equal(client.syncJobs.length, 0); assert.equal((await f.database.history(recipe().id)).length, 1);
  assert.equal(client.current()[0].photo, recipe().photo);
});

test('favorite/unfavorite taps remain immediate and last intent wins behind a blocked upload', async t => {
  const f = await fixture(t), client = await f.client(); await client.put(recipe());
  const hold = gate(), sent = [];
  f.state.before = async (path, options) => { if (path.startsWith('favorite/')) { sent.push(JSON.parse(options.body).favorite); await hold.promise; } };
  for (const value of [true, false, true, false]) {
    await fast(client.queueFavorite(recipe().id, value)); assert.equal(client.current()[0].favorite, value);
  }
  hold.release(); await client.resumeSync();
  assert.equal(sent.at(-1), false); assert.ok(sent.length <= 2); assert.equal(client.syncJobs.length, 0);
  await client.all(); assert.equal(client.current()[0].favorite, false);
});

test('lost replies survive reload with original mutation and no duplicate recipe versions', async t => {
  const f = await fixture(t), local = localStore(), client = await f.client(local); let failures = 3;
  f.state.after = (path, options, response) => { if (path.startsWith('recipe/') && response.ok && failures-- > 0) throw new Error('Reply lost'); };
  await client.queuePut(recipe()); await client.resumeSync();
  const token = client.syncJobs[0].token; assert.equal(client.syncJobs[0].status, 'pending');
  await client.forget(false); f.state.after = null;
  const reopened = await f.client(local); assert.equal(reopened.syncJobs[0].token, token);
  await reopened.retrySync(); assert.equal(reopened.syncJobs.length, 0);
  assert.equal((await f.database.history(recipe().id)).length, 1);
});

test('dependent local saves use confirmed predecessor but still reject remote conflicts', async t => {
  const f = await fixture(t), client = await f.client(), hold = gate(); let injected = false;
  f.state.after = async (path, options, response) => {
    if (path.startsWith('recipe/') && response.ok && !injected) {
      injected = true; await hold.promise;
      const current = await f.database.latest(recipe().id);
      await f.database.commit({ id: recipe().id, recipe: { ...recipe(), title: '另一台设备的内容' }, baseRevision: current.revision, mutationId: randomUUID() });
    }
  };
  await client.queuePut(recipe()); const baseRevision = client.revision(recipe().id);
  await client.queuePut({ ...recipe(), title: '第二次本机修改' }, { baseRevision });
  hold.release(); await client.resumeSync();
  assert.equal(client.syncJobs.length, 1); assert.equal(client.syncJobs[0].code, 'CONFLICT');
  assert.equal(client.current()[0].title, '第二次本机修改');
  assert.equal((await f.database.latest(recipe().id)).recipe.title, '另一台设备的内容');
  await client.discardSync(client.syncJobs[0].token); await client.all();
  assert.equal(client.current()[0].title, '另一台设备的内容');
});

test('an editor opened before local confirmation can save later using the receipt', async t => {
  const f = await fixture(t), client = await f.client();
  await client.queuePut(recipe()); const baseRevision = client.revision(recipe().id);
  await client.resumeSync(); await client.queuePut({ ...recipe(), title: '确认后继续编辑' }, { baseRevision }); await client.resumeSync();
  assert.equal(client.syncJobs.length, 0); assert.equal((await f.database.history(recipe().id)).length, 2);
});

test('quota failure does not show a false local success or send a network mutation', async t => {
  const f = await fixture(t), local = localStore(), client = await f.client(local); let writes = 0;
  local.updateSetting = async () => { throw new Error('Quota exceeded'); };
  f.state.before = path => { if (path.startsWith('recipe/')) writes++; };
  await assert.rejects(client.queuePut(recipe()), /Quota exceeded/);
  assert.equal(client.current().length, 0); assert.equal(client.syncJobs.length, 0); assert.equal(writes, 0);
});

test('queue stays with original account after session loss and resumes after relogin', async t => {
  const f = await fixture(t), local = localStore(), client = await f.client(local);
  f.state.before = path => path.startsWith('recipe/') ? Response.json({ error: '登录已失效', code: 'LOGIN_REQUIRED' }, { status: 401 }) : null;
  await client.queuePut(recipe()); await client.resumeSync(); assert.equal(client.user, null);
  assert.equal(local.data.get(`fengwei-user:${f.user.id}:outbox-v1`).jobs.length, 1);
  f.state.before = null;
  await client.login('wupanfeng', password); await client.all(); await client.retrySync();
  assert.equal(client.syncJobs.length, 0); assert.equal((await f.database.history(recipe().id)).length, 1);
});

test('one failed recipe does not stall unrelated jobs and separate account queues never mix', async () => {
  const local = localStore(); let enabled = false;
  const sent = [], a = createOutbox({ local, owner: 'a', ready: () => enabled, send: async job => { if (job.id === 'bad') throw Object.assign(new Error('Permission denied'), { status: 403 }); sent.push(job.id); } });
  const b = createOutbox({ local, owner: 'b', ready: () => false, send: async () => assert.fail('Other account must not send') });
  await a.enqueue({ token: '1', id: 'bad', value: {} }); await a.enqueue({ token: '2', id: 'good', value: {} }); await b.enqueue({ token: '3', id: 'other', value: {} });
  enabled = true; await a.drain(); assert.deepEqual(sent, ['good']); assert.equal(a.jobs[0].status, 'failed');
  await a.discard('1'); await b.reload(); assert.equal(b.jobs.length, 1); a.close(); b.close();
});

test('atomic queue updates from two tabs preserve both intents', async () => {
  const local = localStore(), a = createOutbox({ local, owner: 'same', ready: () => false, send() {} }), b = createOutbox({ local, owner: 'same', ready: () => false, send() {} });
  await Promise.all([a.enqueue({ token: 'a', id: 'x', value: {} }), b.enqueue({ token: 'b', id: 'y', value: {} })]);
  await a.reload(); assert.deepEqual(new Set(a.jobs.map(job => job.token)), new Set(['a', 'b'])); a.close(); b.close();
});

test('trash purge enforces permission and revision, removes all versions/favorites and preserves shared photos', async t => {
  const f = await fixture(t), client = await f.client(), input = recipe();
  await client.put(input); await client.put({ ...recipe('shared-photo'), title: '共用图片的菜' }); await client.setFavorite(input.id, true);
  const activeRevision = client.revision(input.id), value = { expectedUserId: f.user.id, mutationId: randomUUID(), baseRevision: activeRevision };
  assert.equal((await f.call(`trash/${input.id}`, 'DELETE', value)).status, 401);
  assert.equal((await f.call(`trash/${input.id}`, 'DELETE', value, f.cookie)).status, 409);
  const registered = await f.call('register', 'POST', { displayName: 'viewer', password: 'viewer-password', registrationId: randomUUID() });
  assert.equal((await f.call(`trash/${input.id}`, 'DELETE', value, cookieOf(registered))).status, 403);
  await client.remove(input.id); const revision = client.revision(input.id);
  assert.equal((await f.call(`trash/${input.id}`, 'DELETE', value, f.cookie)).status, 409);
  const result = await client.purgeRecipe(input.id, revision, randomUUID()); assert.equal(result.complete, true);
  assert.equal((await f.database.history(input.id)).length, 0); assert.equal(await f.database.version(input.id, activeRevision), null);
  assert.equal((await f.raw.list({ prefix: `recipes/${hash(input.id)}/` })).blobs.length, 0);
  assert.equal((await new Favorites(f.store, f.user.id).states(f.user.id)).has(input.id), false);
  assert.equal(await f.database.photo(hash(input.photo)), input.photo);
  assert.ok((await f.database.latest('shared-photo')).recipe);
  assert.equal((await client.purgeRecipe(input.id, revision, randomUUID())).complete, true);
  await assert.rejects(f.database.commit({ id: input.id, recipe: input, baseRevision: null, mutationId: randomUUID() }), { code: 'RECIPE_PURGED' });
  assert.ok((await f.call('audit?q=彻底删除', 'GET', undefined, f.cookie)).ok);
});

test('interrupted purge stays retryable in trash; marker is included in migration backup', async t => {
  const f = await fixture(t), client = await f.client(); await client.put(recipe()); await client.remove(recipe().id);
  const baseRevision = client.revision(recipe().id), remove = f.raw.delete.bind(f.raw); let fail = true;
  f.raw.delete = async key => { if (fail && key.startsWith('recipes/')) throw new Error('Storage unavailable'); return remove(key); };
  await assert.rejects(client.purgeRecipe(recipe().id, baseRevision, randomUUID()), { code: 'PURGE_INCOMPLETE' });
  assert.equal((await f.database.trash()).items[0].purging, true);
  assert.equal((await f.database.list()).items.length, 0);
  fail = false; await client.purgeRecipe(recipe().id, baseRevision, randomUUID()); assert.equal((await f.database.trash()).items.length, 0);
  const key = `private/purged-recipes/${hash(recipe().id)}.json`;
  assert.equal(backupKey(key), true); assert.ok((await new FullBackup(f.store).catalog()).keys.includes(key));
  assert.equal((await f.raw.get(key, { type: 'json' })).complete, true);
});

test('purge bounds batches and coordinates with an in-flight restore before deleting content', async t => {
  const f = await fixture(t), input = recipe(), create = await f.database.commit({ id: input.id, recipe: input, baseRevision: null, mutationId: randomUUID() });
  const deleted = await f.database.commit({ id: input.id, baseRevision: create.revision, mutationId: randomUUID() });
  const originalSet = f.raw.setJSON.bind(f.raw), hold = gate(), entered = gate(); let pause = true;
  f.raw.setJSON = async (key, value, options) => { if (pause && key.startsWith('recipes/') && value.recipe) { entered.release(); await hold.promise; } return originalSet(key, value, options); };
  const restoring = f.database.commit({ id: input.id, recipe: input, baseRevision: deleted.revision, mutationId: randomUUID() });
  await entered.promise;
  try { await assert.rejects(f.database.purge(input.id, deleted.revision), { code: 'PHOTO_STORAGE_BUSY' }); }
  finally { pause = false; hold.release(); }
  const restored = await restoring;
  await assert.rejects(f.database.purge(input.id, deleted.revision), { code: 'CONFLICT' });
  const removed = await f.database.commit({ id: input.id, baseRevision: restored.revision, mutationId: randomUUID() });
  await f.database.purge(input.id, removed.revision); assert.equal(await f.database.latest(input.id), null);
  assert.equal((await f.raw.list({ prefix: `recipes/${hash(input.id)}/` })).blobs.length, 0);
  const second = recipe('many-versions'); let event;
  for (let i = 0; i < 67; i++) event = await f.database.commit({ id: second.id, recipe: i ? null : second, baseRevision: event?.revision || null, mutationId: randomUUID() });
  assert.equal((await f.database.purge(second.id, event.revision)).complete, false);
  assert.equal((await f.database.purge(second.id, event.revision)).complete, true);
});

test('logout remains immediate during an upload and preserves the job privately for the original account', async t => {
  const f = await fixture(t), local = localStore(), client = await f.client(local), hold = gate();
  f.state.before = async path => { if (path.startsWith('recipe/')) await hold.promise; };
  await client.queuePut(recipe()); const uploading = client.resumeSync();
  await fast(client.logout()); assert.equal(client.user, null); assert.deepEqual(client.current(), []);
  hold.release(); await uploading; await client.completeLogout();
  assert.equal(local.data.get(`fengwei-user:${f.user.id}:outbox-v1`).jobs.length, 1);
  await client.login('wupanfeng', password); await client.all(); await client.retrySync();
  assert.equal(client.syncJobs.length, 0); assert.equal((await f.database.history(recipe().id)).length, 1);
});

test('a lost favorite confirmation is replayed unchanged before the later unfavorite intent', async t => {
  const f = await fixture(t), local = localStore(), client = await f.client(local); await client.put(recipe()); let failures = 3;
  f.state.after = (path, options, response) => { if (path.startsWith('favorite/') && response.ok && failures-- > 0) throw new Error('Favorite reply lost'); };
  await client.queueFavorite(recipe().id, true); await client.resumeSync();
  const token = client.syncJobs[0].token;
  await client.queueFavorite(recipe().id, false); assert.equal(client.syncJobs.length, 2); assert.equal(client.syncJobs[0].token, token);
  await client.forget(false); f.state.after = null;
  const reopened = await f.client(local); await reopened.retrySync();
  assert.equal(reopened.current()[0].favorite, false); assert.equal(reopened.syncJobs.length, 0);
  assert.equal((await f.raw.list({ prefix: `private/favorites/${f.user.id}/${hash(recipe().id)}/` })).blobs.length, 2);
});
