import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';
import { createApi } from '../server/api.mjs';
import { createAuth, testAccount, SESSION_SECONDS } from '../server/auth.mjs';

const PASSWORD = 'test-only-private-passphrase';
const recipe = (overrides = {}) => ({ id: 'one', title: '番茄炒蛋', category: '家常菜', description: '', notes: '', minutes: 15, servings: 2, favorite: false, photo: '', ingredients: [{ name: '鸡蛋', amount: '3 个' }], steps: ['炒熟'], createdAt: '2026-10-11T01:00:00Z', updatedAt: '2026-10-11T01:00:00Z', ...overrides });
const root = await mkdtemp(join(tmpdir(), 'fengwei-api-test-'));
const store = new FileStore(root), database = new RecipeDatabase(store);
const handler = createApi({ database, password: PASSWORD });
let auth;
async function call(path, method = 'GET', value, cookie = auth, headers = {}) {
  return handler(new Request(`https://recipes.test/api/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(value ? { 'Content-Type': 'application/json', Origin: 'https://recipes.test' } : {}), ...headers }, ...(value ? { body: JSON.stringify(value) } : {}) }));
}
test('server refuses unconfigured or unauthenticated access and sets a private signed cookie', async () => {
  const unconfigured = createApi({ database, password: '' });
  assert.equal((await unconfigured(new Request('https://recipes.test/api/recipes'))).status, 503);
  assert.equal((await call('recipes')).status, 401);
  assert.equal((await call('login', 'POST', { username: 'wupanfeng', password: 'wrong' })).status, 401);
  assert.equal((await call('login', 'POST', { username: 'other-user', password: PASSWORD })).status, 401);
  const response = await call('login', 'POST', { username: 'wupanfeng', password: PASSWORD });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict;.*Secure/);
  assert.match(response.headers.get('set-cookie'), new RegExp(`Max-Age=${SESSION_SECONDS}`));
  assert.match(response.headers.get('cache-control'), /no-store/);
  auth = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('recipes', 'GET', undefined, auth + 'forged')).status, 401);
  assert.equal((await call('logout', 'POST', {}, auth, { Origin: 'https://other.test' })).status, 403);
});
test('persistent session resumes after restart, expires correctly and renews close to expiry', async () => {
  const credentials = testAccount(PASSWORD);
  const original = createAuth(store, credentials);
  const restored = createAuth(new FileStore(root), credentials);
  const token = await original.issue();
  const request = new Request('https://recipes.test/api/recipes', { headers: { Cookie: `fengwei_session=${token}` } });
  const session = await restored.verify(request);
  assert.equal(session.renew, false);
  assert.equal(session.user.displayName, 'wupanfeng');
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(payload.version, 3);
  assert.equal(payload.userId, session.user.id);
  assert.equal(Object.hasOwn(payload, 'password'), false);
  assert.ok(!JSON.stringify(payload).includes(PASSWORD));
  const expiring = await original.issue(Date.now() - (SESSION_SECONDS - 3600) * 1000);
  const response = await call('recipes', 'GET', undefined, `fengwei_session=${expiring}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), new RegExp(`Max-Age=${SESSION_SECONDS}`));
  const expired = await original.issue(Date.now() - (SESSION_SECONDS + 3600) * 1000);
  assert.equal((await call('recipes', 'GET', undefined, `fengwei_session=${expired}`)).status, 401);
});
test('recipes and private photos persist across new server/database instances; stale writes fail', async () => {
  const photo = 'data:image/png;base64,' + (await readFile(new URL('../dist/icons/icon-192.png', import.meta.url))).toString('base64');
  const input = { recipe: recipe({ photo }), baseRevision: null, mutationId: 'save-operation-0001' };
  const response = await call('recipe/one', 'PUT', input);
  assert.equal(response.status, 200);
  const first = (await response.json()).item;
  assert.equal((await call('recipe/one', 'PUT', input)).status, 200, 'retries are idempotent');
  assert.equal((await database.history('one')).length, 1);
  assert.equal((await call(`photo/${first.photoHash}`, 'GET', undefined, null)).status, 401);
  assert.equal((await (await call(`photo/${first.photoHash}`)).json()).photo, photo);
  const fresh = new RecipeDatabase(new FileStore(root));
  assert.equal((await fresh.latest('one')).recipe.title, '番茄炒蛋');
  assert.equal(await fresh.photo(first.photoHash), photo);
  const update = await call('recipe/one', 'PUT', { recipe: recipe({ title: '改良炒蛋', photo }), baseRevision: first.revision, mutationId: 'save-operation-0002' });
  assert.equal(update.status, 200);
  const second = (await update.json()).item;
  assert.equal((await call('recipe/one', 'PUT', { recipe: recipe({ title: '过期编辑' }), baseRevision: first.revision, mutationId: 'save-operation-0003' })).status, 409);
  assert.equal((await fresh.latest('one')).recipe.title, '改良炒蛋');
  assert.equal((await call('recipe/one', 'DELETE', { baseRevision: second.revision, mutationId: 'delete-operation-0001' })).status, 200);
  assert.equal((await call('recipe/one', 'PUT', { recipe: recipe(), baseRevision: second.revision, mutationId: 'save-operation-0004' })).status, 409);
  assert.equal((await (await call('recipes')).json()).items[0].deleted, true);
  assert.equal((await (await call('history/one')).json()).items.length, 3);
});
test('invalid records, oversized bodies and cross-origin writes cannot mutate data', async () => {
  const mutation = { recipe: recipe({ id: 'bad', title: '' }), baseRevision: null, mutationId: 'validation-check-0001' };
  assert.equal((await call('recipe/bad', 'PUT', mutation)).status, 400);
  assert.equal((await call('recipe/bad', 'PUT', { ...mutation, recipe: recipe({ id: 'bad' }) }, auth, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await call('recipe/bad', 'PUT', mutation, auth, { 'Content-Length': String(5 * 1024 * 1024) })).status, 413);
  assert.equal(await database.latest('bad'), null);
});
test('simultaneous edits retain both versions and expose conflict instead of overwriting a snapshot', async () => {
  const memory = new Map(); let readers = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const storage = {
    async list({ prefix }) {
      const list = { blobs: [...memory.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) };
      // Both writers finish their preflight latest-version read together.
      if (++readers === 4) release();
      if (readers === 3 || readers === 4) await gate;
      return list;
    },
    async get(key, { type } = {}) { const value = memory.get(key); return value === undefined ? null : type === 'json' ? JSON.parse(value) : value; },
    async set(key, value) { memory.set(key, value); },
    async setJSON(key, value) { memory.set(key, JSON.stringify(value)); },
  };
  const db = new RecipeDatabase(storage);
  await Promise.all([
    db.commit({ id: 'race', recipe: recipe({ id: 'race', title: '设备一的版本' }), baseRevision: null, mutationId: 'race-device-one' }),
    db.commit({ id: 'race', recipe: recipe({ id: 'race', title: '设备二的版本' }), baseRevision: null, mutationId: 'race-device-two' }),
  ]);
  const history = await db.history('race');
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(item => item.recipe.title).sort(), ['设备一的版本', '设备二的版本'].sort());
  assert.equal((await db.latest('race')).conflictCount, 2);
});
