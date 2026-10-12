import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac, randomUUID } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { createAuth, testAccount, SESSION_SECONDS } from '../server/auth.mjs';
import { RecipeDatabase, hash } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';

const password = 'account-test-password-only';
const registrationPassword = 'registered-user-test-password';
const root = await mkdtemp(join(tmpdir(), 'fengwei-accounts-test-'));
const store = new FileStore(root), database = new RecipeDatabase(store);
let api = createApi({ database, password });
const value = (id, favorite = false) => ({ id, title: '共享番茄炒蛋', category: '家常菜', description: '', notes: '', minutes: 15, servings: 2, photo: '', favorite, ingredients: [{ name: '番茄', amount: '2 个' }], steps: ['炒熟'], createdAt: '2026-10-11T01:00:00Z', updatedAt: '2026-10-11T01:00:00Z' });
async function call(path, method = 'GET', data, cookie, headers = {}) {
  return api(new Request(`https://recipes.test/api/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'https://recipes.test' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }));
}
const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
async function register(displayName = '厨房小伙伴', registrationId = randomUUID()) {
  const response = await call('register', 'POST', { displayName, password: registrationPassword, registrationId });
  assert.equal(response.status, 201);
  return { user: (await response.json()).user, cookie: cookieOf(response), registrationId };
}
let owner, first, second;
test('registration generates unique durable IDs, keeps passwords private and survives repeated requests', async () => {
  const response = await call('login', 'POST', { username: 'wupanfeng', password });
  owner = { user: (await response.json()).user, cookie: cookieOf(response) };
  [first, second] = await Promise.all([register('厨房小伙伴一'), register('厨房小伙伴二')]);
  assert.notEqual(first.user.id, second.user.id, 'different usernames have distinct accounts');
  assert.match(first.user.id, /^usr_[a-f0-9]{32}$/);
  assert.notEqual(first.user.displayName, second.user.displayName);
  assert.equal(first.user.role, 'viewer'); assert.equal(first.user.canEdit, false);
  assert.equal(owner.user.role, 'admin');
  const repeated = await register(first.user.displayName, first.registrationId);
  assert.equal(repeated.user.id, first.user.id);
  const altered = await call('register', 'POST', { displayName: '不同昵称', password: registrationPassword, registrationId: first.registrationId });
  assert.equal(altered.status, 409);
  const me = await call('me', 'GET', undefined, first.cookie);
  const publicProfile = await me.json();
  assert.equal(publicProfile.user.id, first.user.id);
  assert.ok(!JSON.stringify(publicProfile).includes('salt'));
  assert.ok(!JSON.stringify(publicProfile).includes('passwordHash'));
  const stored = await store.get(`private/users/${first.user.id}.json`, { type: 'json' });
  assert.notEqual(stored.passwordHash, registrationPassword);
  assert.ok(!JSON.stringify(stored).includes(registrationPassword));
  api = createApi({ database: new RecipeDatabase(new FileStore(root)), password });
  assert.equal((await call('me', 'GET', undefined, first.cookie)).status, 200);
  const login = await call('login', 'POST', { username: first.user.id, password: registrationPassword });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.id, first.user.id);
  assert.equal((await call('login', 'POST', { username: first.user.id, password: 'wrong' })).status, 401);
  assert.equal((await call('login', 'POST', { username: first.user.displayName, password: registrationPassword })).status, 200, 'unique usernames can be used to log in');
});

test('all accounts see recipes; approved accounts can write and favorites remain independent', async () => {
  for (const account of [first, second]) {
    const requestId = randomUUID();
    assert.equal((await call('permissions/request', 'POST', { reason: '测试编辑共享菜谱的授权流程', requestId }, account.cookie)).status, 201);
    assert.equal((await call('permissions/decision', 'POST', { userId: account.user.id, requestId, action: 'approve', mutationId: randomUUID() }, owner.cookie)).status, 200);
  }
  const created = await call('recipe/shared', 'PUT', { recipe: value('shared', true), baseRevision: null, mutationId: 'account-shared-create' }, owner.cookie);
  assert.equal(created.status, 200);
  const before = (await created.json()).item;
  assert.equal(before.recipe.favorite, false, 'recipe content cannot set a global favorite');
  const list = async cookie => (await (await call('recipes', 'GET', undefined, cookie)).json()).items.find(item => item.id === 'shared');
  assert.equal((await list(first.cookie)).recipe.title, before.recipe.title);
  const toggle = { favorite: true, mutationId: 'first-private-favorite', expectedUserId: first.user.id, userId: second.user.id };
  const selected = await call('favorite/shared', 'PUT', toggle, first.cookie);
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).userId, first.user.id, 'body userId cannot select another account');
  assert.equal((await call('favorite/shared', 'PUT', toggle, first.cookie)).status, 200);
  assert.equal((await list(first.cookie)).recipe.favorite, true);
  assert.equal((await list(second.cookie)).recipe.favorite, false);
  assert.equal((await list(owner.cookie)).recipe.favorite, false);
  assert.equal((await list(first.cookie)).revision, before.revision);
  assert.equal((await list(first.cookie)).recipe.updatedAt, before.recipe.updatedAt);
  assert.equal((await database.history('shared')).length, 1);
  const staleAccount = await call('favorite/shared', 'PUT', { favorite: false, expectedUserId: first.user.id, mutationId: 'wrong-account-request' }, second.cookie);
  assert.equal(staleAccount.status, 409);
  assert.equal((await call('favorite/shared', 'PUT', { favorite: true, mutationId: 'anonymous-favorite' })).status, 401);
  const photo = 'data:image/png;base64,' + (await readFile(new URL('../dist/icons/icon-192.png', import.meta.url))).toString('base64');
  const edited = await call('recipe/shared', 'PUT', { recipe: { ...value('shared', true), notes: '另一个账号可以编辑', photo }, baseRevision: before.revision, mutationId: 'second-shared-edit' }, second.cookie);
  assert.equal(edited.status, 200);
  const after = (await edited.json()).item;
  assert.equal(after.recipe.favorite, false);
  assert.equal((await list(first.cookie)).recipe.favorite, true);
  assert.equal((await list(owner.cookie)).recipe.notes, '另一个账号可以编辑');
  assert.equal((await call(`photo/${after.photoHash}`, 'GET', undefined, first.cookie)).status, 200);
  assert.equal((await call(`photo/${after.photoHash}`)).status, 401);
  const removed = await call('favorite/shared', 'PUT', { favorite: false, mutationId: 'first-remove-favorite' }, first.cookie);
  assert.equal(removed.status, 200);
  assert.equal((await list(first.cookie)).recipe.favorite, false);
  assert.equal((await call('recipe/shared', 'DELETE', { baseRevision: after.revision, mutationId: 'first-shared-delete' }, first.cookie)).status, 200);
  assert.equal((await list(second.cookie)).deleted, true);
});

test('legacy global favorites belong only to the original account and survive another account editing', async () => {
  const old = await database.commit({ id: 'legacy', recipe: value('legacy', true), baseRevision: null, mutationId: 'old-single-account-save' });
  const list = async cookie => (await (await call('recipes', 'GET', undefined, cookie)).json()).items.find(item => item.id === 'legacy');
  assert.equal((await list(owner.cookie)).recipe.favorite, true);
  assert.equal((await list(first.cookie)).recipe.favorite, false);
  assert.equal((await call('recipe/legacy', 'PUT', { recipe: { ...value('legacy'), notes: '共享内容已修改' }, baseRevision: old.revision, mutationId: 'edit-legacy-by-new-user' }, first.cookie)).status, 200);
  assert.equal((await database.latest('legacy')).recipe.favorite, false);
  assert.equal((await list(owner.cookie)).recipe.favorite, true);
  assert.equal((await list(first.cookie)).recipe.favorite, false);
  assert.equal((await call('favorite/legacy', 'PUT', { favorite: false, mutationId: 'owner-unfavorite-legacy' }, owner.cookie)).status, 200);
  api = createApi({ database: new RecipeDatabase(new FileStore(root)), password });
  assert.equal((await list(owner.cookie)).recipe.favorite, false);
});

test('old signed Cookie upgrades to a stable original user without requiring login again', async () => {
  const account = testAccount(password), auth = createAuth(store, account);
  const newToken = await auth.issue();
  const current = JSON.parse(Buffer.from(newToken.split('.')[0], 'base64url').toString('utf8'));
  const key = await store.get(`private/auth/${hash(JSON.stringify(account))}/${current.keyId}`, { type: 'json' });
  const payload = Buffer.from(JSON.stringify({ version: 2, username: 'wupanfeng', keyId: current.keyId, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, nonce: 'legacy' })).toString('base64url');
  const signature = createHmac('sha256', key.key).update(`fengwei-session-v2:${payload}`).digest('base64url');
  const response = await call('me', 'GET', undefined, `fengwei_session=${payload}.${signature}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.id, owner.user.id);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict;.*Secure/);
  const upgraded = response.headers.get('set-cookie').split(';')[0].split('=')[1];
  assert.equal(JSON.parse(Buffer.from(upgraded.split('.')[0], 'base64url').toString()).version, 3);
  const parts = first.cookie.split('=')[1].split('.');
  const forgedPayload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); forgedPayload.userId = second.user.id;
  const forged = Buffer.from(JSON.stringify(forgedPayload)).toString('base64url');
  assert.equal((await call('me', 'GET', undefined, `fengwei_session=${forged}.${parts[1]}`)).status, 401);
});

test('registration validates input and cross-origin requests', async () => {
  assert.equal((await call('register', 'POST', null)).status, 400);
  const data = { displayName: '昵称', password: 'short', registrationId: randomUUID() };
  assert.equal((await call('register', 'POST', data)).status, 400);
  assert.equal((await call('register', 'POST', { ...data, password: registrationPassword }, undefined, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await call('register', 'POST', { ...data, password: registrationPassword, displayName: ' ' })).status, 400);
});
