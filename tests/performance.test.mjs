import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { requestStore } from '../server/request-store.mjs';
import { RecipeDatabase, hash } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';
import { createApi } from '../server/api.mjs';
import { createRemoteStore } from '../dist/sync.js';

const password = 'performance-regression-fixture-password';
const recipe = (id, photo = '', notes = '') => ({ id, title: id, category: '家常菜', description: '', minutes: 15, servings: 2, favorite: false, photo, notes, ingredients: [], steps: ['测试步骤'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-performance-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = new FileStore(root), database = new RecipeDatabase(source), api = createApi({ database, password });
  const call = (path, method = 'GET', data, cookie, origin = 'https://recipes.test') => api(new Request(`https://recipes.test/api/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json', Origin: origin } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }));
  const login = await call('login', 'POST', { username: 'wupanfeng', password }), cookie = login.headers.get('set-cookie').split(';')[0];
  return { source, database, api, call, cookie };
}

test('request reuse is isolated, mutation invalidates it, and only immutable positive records survive the request', async () => {
  const values = new Map(), counts = new Map();
  const source = { async get(key) { counts.set(key, (counts.get(key) || 0) + 1); return structuredClone(values.get(key) ?? null); }, async list() { return { blobs: [] }; }, async setJSON(key, value) { values.set(key, structuredClone(value)); }, async set(key, value) { values.set(key, value); } };
  const store = requestStore(source), user = `private/users/usr_${'a'.repeat(32)}.json`, event = `recipes/${'b'.repeat(64)}/000000000001-1234567890123-fixture-record.json`, missing = `photos/${'c'.repeat(64)}.txt`;
  values.set(user, { passwordVersion: 'initial' }); values.set(event, { recipe: { title: '原内容' } });
  await store.run(async () => {
    const [one, two] = await Promise.all([store.get(user), store.get(user)]); one.passwordVersion = 'local-mutation'; assert.equal(two.passwordVersion, 'initial');
    assert.equal(counts.get(user), 1);
    await store.setJSON(user, { passwordVersion: 'changed' }); assert.equal((await store.get(user)).passwordVersion, 'changed');
    const saved = await store.get(event); saved.recipe.title = '不能污染缓存';
    assert.equal(await store.get(missing), null);
  });
  values.set(user, { passwordVersion: 'another-device' });
  await store.run(async () => {
    assert.equal((await store.get(user)).passwordVersion, 'another-device');
    assert.equal((await store.get(event)).recipe.title, '原内容');
    assert.equal(await store.get(missing), null);
  });
  assert.equal(counts.get(user), 3); assert.equal(counts.get(event), 1); assert.equal(counts.get(missing), 2);
});

test('recipe pagination increases throughput while respecting response size, deletion markers, and cursors', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 110; i++) await f.database.commit({ id: `paged-${i}`, recipe: recipe(`paged-${i}`), baseRevision: null, mutationId: randomUUID() });
  const first = await f.database.list(); assert.equal(first.items.length, 100); assert.ok(first.cursor);
  const second = await f.database.list(first.cursor); assert.equal(second.items.length, 10); assert.equal(second.cursor, null);
  const ids = new Set([...first.items, ...second.items].map(item => item.id)); assert.equal(ids.size, 110);
  for (let i = 0; i < 8; i++) await f.database.commit({ id: `large-${i}`, recipe: { ...recipe(`large-${i}`), ingredients: Array.from({ length: 20 }, () => ({ name: '大'.repeat(100), amount: '份量'.repeat(100) })), steps: Array.from({ length: 20 }, () => '步骤'.repeat(700)) }, baseRevision: null, mutationId: randomUUID() });
  let cursor = '', largeFound = 0;
  do { const page = await f.database.list(cursor); assert.ok(Buffer.byteLength(JSON.stringify(page.items)) < 400 * 1024); largeFound += page.items.filter(item => item.id.startsWith('large-')).length; cursor = page.cursor; } while (cursor);
  assert.equal(largeFound, 8);
});

test('photo batching stays private, validates hashes, and splits large responses without losing photos', async t => {
  const f = await fixture(t), photos = Array.from({ length: 4 }, (_, i) => `data:image/png;base64,${String.fromCharCode(65 + i).repeat(1200000)}`), hashes = photos.map(hash);
  await Promise.all(photos.map((photo, i) => f.source.set(`photos/${hashes[i]}.txt`, photo)));
  assert.equal((await f.call('photos', 'POST', { hashes })).status, 401);
  assert.equal((await f.call('photos', 'POST', { hashes }, f.cookie, 'https://other.test')).status, 403);
  assert.equal((await f.call('photos', 'POST', { hashes: ['not-a-hash'] }, f.cookie)).status, 400);
  assert.equal((await f.call('photos', 'POST', { hashes: Array(9).fill(hashes[0]) }, f.cookie)).status, 400);
  const absent = await f.call('photos', 'POST', { hashes: ['e'.repeat(64)] }, f.cookie); assert.equal(absent.status, 404); assert.equal((await absent.json()).code, 'PHOTO_NOT_FOUND');
  const response = await f.call('photos', 'POST', { hashes }, f.cookie); assert.equal(response.status, 200); assert.match(response.headers.get('server-timing'), /^app;dur=/);
  const batch = await response.json(); assert.equal(Object.keys(batch.photos).length, 2); assert.equal(batch.pending.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) < 3 * 1024 * 1024);
  const rest = await (await f.call('photos', 'POST', { hashes: batch.pending }, f.cookie)).json();
  assert.deepEqual({ ...batch.photos, ...rest.photos }, Object.fromEntries(hashes.map((key, i) => [key, photos[i]])));
});

test('parallel sync coalesces requests, batches photos, reuses unchanged photo uploads and retains offline backups', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 70; i++) await f.database.commit({ id: `client-${i}`, recipe: recipe(`client-${i}`, i < 25 ? `data:image/png;base64,${Buffer.from(`photo-${i}`).toString('base64')}` : ''), baseRevision: null, mutationId: randomUUID() });
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const routes = [], writes = []; let cookie = f.cookie, network = true, active = 0, peak = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (!network) throw new Error('offline');
    const target = new URL(url), path = target.pathname.split('/api/')[1] + target.search;
    routes.push(path); const photo = path === 'photos'; if (photo) { active++; peak = Math.max(peak, active); }
    if (path.startsWith('recipe/')) writes.push(JSON.parse(options.body));
    try {
      const response = await f.api(new Request(`https://recipes.test/api/${path}`, { ...options, headers: { ...options.headers, Cookie: cookie, Origin: 'https://recipes.test' } }));
      const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0]; return response;
    } finally { if (photo) active--; }
  };
  const saved = new Map(), client = await createRemoteStore({ async setting(key) { return saved.get(key); }, async setSetting(key, value) { saved.set(key, structuredClone(value)); } });
  const [first, second] = await Promise.all([client.all(), client.all()]);
  assert.equal(first.length, 70); assert.equal(second.length, 70); assert.equal(first.filter(item => item.photo).length, 25);
  assert.equal(routes.filter(path => path === 'recipes').length, 1); assert.equal(routes.filter(path => path === 'photos').length, 4);
  assert.equal(routes.filter(path => path === 'me' || path.startsWith('photo/')).length, 0); assert.ok(peak > 1 && peak <= 3);
  routes.length = 0;
  const illustrated = first.find(item => item.photo); await client.put({ ...illustrated, notes: '只修改文字' });
  assert.equal(routes.length, 1); assert.equal(writes[0].recipe.photo, ''); assert.equal(writes[0].photoHash, hash(illustrated.photo));
  assert.equal(client.current().find(item => item.id === illustrated.id).photo, illustrated.photo);
  const row = await f.database.latest(illustrated.id); assert.equal(row.photoHash, hash(illustrated.photo));
  assert.equal((await f.call(`recipe/${illustrated.id}`, 'PUT', { recipe: { ...illustrated, photo: '' }, photoHash: 'f'.repeat(64), baseRevision: row.revision, mutationId: randomUUID() }, cookie)).status, 409);
  routes.length = 0; await client.all(); assert.deepEqual(routes, ['recipes']);
  network = false; const cached = await client.all(); assert.equal(cached.length, 70); assert.equal(client.readOnly, true);
  await assert.rejects(client.put(cached[0]), error => error.code === 'OFFLINE');
  assert.equal(client.current().find(item => item.id === illustrated.id).photo, illustrated.photo);
});

test('an older server keeps receiving full photos until it explicitly supports photo references', async t => {
  const f = await fixture(t), photo = 'data:image/png;base64,bGVnYWN5LXBob3Rv';
  await f.database.commit({ id: 'rolling-deployment', recipe: recipe('rolling-deployment', photo), baseRevision: null, mutationId: randomUUID() });
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; }); let submitted;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url), path = target.pathname.split('/api/')[1] + target.search;
    if (path === 'photos') return Response.json({ code: 'NOT_FOUND', error: '旧接口不支持批量照片' }, { status: 404 });
    if (path.startsWith('recipe/')) submitted = JSON.parse(options.body);
    const response = await f.api(new Request(`https://recipes.test/api/${path}`, { ...options, headers: { ...options.headers, Cookie: f.cookie, Origin: 'https://recipes.test' } }));
    if (path === 'recipes') { const data = await response.json(); delete data.capabilities; delete data.user; return Response.json(data); }
    return response;
  };
  const client = await createRemoteStore(), items = await client.all(); assert.equal(items[0].photo, photo);
  await client.put({ ...items[0], notes: '旧服务器也能安全保存文字和照片' });
  assert.equal(submitted.recipe.photo, photo); assert.equal(submitted.photoHash, undefined);
  assert.equal(client.current()[0].photo, photo);
});

test('an old sync response cannot replace the account or favorites after logout and login', async t => {
  const f = await fixture(t), registration = await f.call('register', 'POST', { displayName: '另一账号', password, registrationId: randomUUID() }), other = (await registration.json()).user;
  await f.database.commit({ id: 'shared', recipe: recipe('shared'), baseRevision: null, mutationId: randomUUID() });
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let cookie = f.cookie, pause = false, release, observed;
  const held = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { observed = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url), path = target.pathname.split('/api/')[1] + target.search;
    const response = await f.api(new Request(`https://recipes.test/api/${path}`, { ...options, headers: { ...options.headers, Cookie: cookie, Origin: 'https://recipes.test' } }));
    if (pause && path === 'recipes') { observed(); await held; }
    const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0]; return response;
  };
  const client = await createRemoteStore(); await client.all(); pause = true;
  const old = client.all(); await reached;
  await client.logout(); await client.login(other.displayName, password); release();
  await assert.rejects(old, error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(client.user.id, other.id); assert.deepEqual(client.current(), []);
  pause = false; await client.all(); assert.equal(client.current().length, 1); assert.equal(client.user.id, other.id);
});
