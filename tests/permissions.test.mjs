import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';
import { AuditLog } from '../server/audit.mjs';

const password = 'permission-tests-only-password';
const recipe = { id: 'permission-recipe', title: '授权测试菜谱', description: '', category: '家常菜', minutes: 10, servings: 2, favorite: false, photo: '', notes: '', ingredients: [], steps: ['测试步骤'], createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-permissions-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root), database = new RecipeDatabase(store);
  let api = createApi({ database, password });
  const call = (path, method = 'GET', data, cookie) => api(new Request(`https://recipes.test/api/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json', Origin: 'https://recipes.test' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }));
  const account = async response => ({ status: response.status, user: (await response.json()).user, cookie: response.headers.get('set-cookie')?.split(';')[0] });
  const owner = await account(await call('login', 'POST', { username: 'wupanfeng', password }));
  const register = (displayName, registrationId = randomUUID(), extra = {}) => call('register', 'POST', { displayName, registrationId, password, ...extra });
  const viewer = await account(await register('普通用户'));
  const request = async (user = viewer, reason = '需要整理家庭菜谱并补充做法') => {
    const requestId = randomUUID(); const response = await call('permissions/request', 'POST', { requestId, reason }, user.cookie);
    assert.equal(response.status, 201); return requestId;
  };
  const decide = (requestId, action = 'approve', user = viewer, cookie = owner.cookie, extra = {}) => call('permissions/decision', 'POST', { requestId, action, userId: user.user.id, mutationId: randomUUID(), ...extra }, cookie);
  const save = (user = viewer, values = {}) => call(`recipe/${recipe.id}`, 'PUT', { recipe, baseRevision: null, mutationId: randomUUID(), ...values }, user.cookie);
  return { store, database, call, account, owner, viewer, register, request, decide, save, restart() { api = createApi({ database: new RecipeDatabase(new FileStore(root)), password }); } };
}

test('only original wupanfeng is admin; viewers cannot bypass shared writes or access other users and logs', async t => {
  const f = await fixture(t);
  assert.equal(f.owner.user.role, 'admin'); assert.equal(f.viewer.user.role, 'viewer');
  const forged = await f.account(await f.register('伪造角色', undefined, { role: 'admin', canEdit: true, legacy: true }));
  assert.equal(forged.user.role, 'viewer');
  assert.equal((await f.save(f.viewer, { role: 'admin', canEdit: true, operation: 'import' })).status, 403);
  assert.equal((await f.call(`recipe/${recipe.id}`, 'DELETE', { baseRevision: null, mutationId: randomUUID() }, f.viewer.cookie)).status, 403);
  assert.equal((await f.call('audit', 'GET', undefined, f.viewer.cookie)).status, 403);
  assert.equal((await f.decide(randomUUID(), 'approve', f.viewer, f.viewer.cookie)).status, 403);
  const listing = await (await f.call('permissions', 'GET', undefined, f.viewer.cookie)).json();
  assert.equal(listing.accounts, undefined); assert.deepEqual(listing.requests, []);
  assert.equal(await f.database.latest(recipe.id), null);
});

test('requests require reasons; approval and revoke update existing cookies immediately and persist after restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('permissions/request', 'POST', { requestId: randomUUID(), reason: '短' }, f.viewer.cookie)).status, 400);
  const id = await f.request();
  assert.equal((await f.call('permissions/request', 'POST', { requestId: randomUUID(), reason: '再次提交一份重复申请' }, f.viewer.cookie)).status, 409);
  const third = await f.account(await f.register('另一个用户'));
  assert.equal((await (await f.call('permissions', 'GET', undefined, third.cookie)).json()).requests.length, 0);
  const mutationId = randomUUID();
  assert.equal((await f.decide(id, 'approve', f.viewer, f.owner.cookie, { mutationId })).status, 200);
  assert.equal((await f.decide(id, 'approve', f.viewer, f.owner.cookie, { mutationId })).status, 200);
  assert.equal((await f.decide(id, 'reject')).status, 409);
  assert.equal((await (await f.call('me', 'GET', undefined, f.viewer.cookie)).json()).user.role, 'editor');
  const saved = await f.save(); assert.equal(saved.status, 200); const item = (await saved.json()).item;
  f.restart(); assert.equal((await (await f.call('me', 'GET', undefined, f.viewer.cookie)).json()).user.canEdit, true);
  assert.equal((await f.decide(id, 'revoke')).status, 200);
  assert.equal((await f.save(f.viewer, { baseRevision: item.revision })).status, 403);
  assert.equal((await f.call(`recipe/${recipe.id}`, 'DELETE', { baseRevision: item.revision, mutationId: randomUUID() }, f.viewer.cookie)).status, 403);
  f.restart(); assert.equal((await (await f.call('me', 'GET', undefined, f.viewer.cookie)).json()).user.role, 'viewer');
  assert.equal((await (await f.call('permissions', 'GET', undefined, f.viewer.cookie)).json()).requests[0].status, 'revoked');
  assert.equal((await f.call('recipes', 'GET', undefined, f.viewer.cookie)).status, 200);
  assert.equal((await f.decide(null, 'revoke', f.owner)).status, 400, 'admin cannot revoke own role');
});

test('rejected applications can be resubmitted and private favorites remain available to viewers', async t => {
  const f = await fixture(t);
  const id = await f.request(); assert.equal((await f.decide(id, 'reject', f.viewer, f.owner.cookie, { note: '请补充具体编辑范围' })).status, 200);
  const listing = await (await f.call('permissions', 'GET', undefined, f.viewer.cookie)).json();
  assert.equal(listing.requests[0].note, '请补充具体编辑范围'); assert.equal(listing.requests[0].status, 'rejected');
  assert.notEqual(await f.request(), id);
  assert.equal((await f.save(f.owner)).status, 200);
  assert.equal((await f.call(`favorite/${recipe.id}`, 'PUT', { favorite: true, expectedUserId: f.viewer.user.id, mutationId: randomUUID() }, f.viewer.cookie)).status, 200);
  assert.equal((await f.database.history(recipe.id)).length, 1);
});

test('unique names are atomically reserved across concurrent handlers with normalization and stable retries', async t => {
  const f = await fixture(t);
  const other = createApi({ database: new RecipeDatabase(new FileStore(f.store.root)), password });
  const responses = await Promise.all([f.register(' Alice '), other(new Request('https://recipes.test/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://recipes.test' }, body: JSON.stringify({ displayName: 'ＡＬＩＣＥ', password, registrationId: randomUUID() }) }))]);
  assert.deepEqual(responses.map(item => item.status).sort(), [201, 409]);
  assert.equal((await f.register('alice')).status, 409);
  assert.equal((await f.register(' WUPANFENG ')).status, 409);
  const login = await f.call('login', 'POST', { username: 'aLiCe', password }); assert.equal(login.status, 200);
  const registrationId = randomUUID();
  const first = await f.account(await f.register('幂等注册', registrationId));
  const repeated = await f.account(await f.register('幂等注册', registrationId)); assert.equal(first.user.id, repeated.user.id);
  assert.equal((await f.register('不同用户名', registrationId)).status, 409);
  f.restart(); assert.equal((await f.register('alice')).status, 409);
  assert.equal((await f.call('login', 'POST', { username: first.user.id, password })).status, 200);
});

test('registration fails closed if a provider silently ignores atomic create-only writes', async t => {
  const f = await fixture(t);
  const storage = { get: f.store.get.bind(f.store), list: f.store.list.bind(f.store), set: f.store.set.bind(f.store), setJSON: (key, value, options) => f.store.setJSON(key, value, { ...options, onlyIfNew: false }) };
  const api = createApi({ database: new RecipeDatabase(storage), password });
  const response = await api(new Request('https://recipes.test/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://recipes.test' }, body: JSON.stringify({ displayName: '不可被不安全存储注册', password, registrationId: randomUUID() }) }));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'UNIQUE_STORAGE_UNAVAILABLE');
  const { blobs } = await f.store.list({ prefix: 'private/registrations/' }); assert.equal(blobs.length, 1, 'only the original fixture registration exists');
});

test('audit-index failure cannot turn a saved recipe into a reported failure; durable receipts remain visible', async t => {
  const f = await fixture(t);
  const storage = { get: f.store.get.bind(f.store), list: f.store.list.bind(f.store), set: f.store.set.bind(f.store), async setJSON(key, value, options) {
    if (key.startsWith('private/audit/')) throw Object.assign(new Error('Injected audit failure'), { code: 'TEST_AUDIT_UNAVAILABLE' });
    return f.store.setJSON(key, value, options);
  } };
  const api = createApi({ database: new RecipeDatabase(storage), password });
  const response = await api(new Request(`https://recipes.test/api/recipe/${recipe.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://recipes.test', Cookie: f.owner.cookie }, body: JSON.stringify({ recipe, baseRevision: null, mutationId: randomUUID() }) }));
  assert.equal(response.status, 200); assert.equal((await response.json()).item.recipe.title, recipe.title);
  const logged = await (await f.call('audit', 'GET', undefined, f.owner.cookie)).json();
  assert.ok(logged.items.some(item => item.action === 'recipe.create' && item.target === recipe.title));
  const visible = await (await f.call('recipes', 'GET', undefined, f.viewer.cookie)).json();
  assert.equal(visible.items[0].auditEntry, undefined, 'ordinary recipe responses must not expose audit metadata');
});

test('audit logs persist, exclude credentials, deduplicate mutations, and only admin can filter and paginate', async t => {
  const f = await fixture(t);
  const id = await f.request(); assert.equal((await f.decide(id)).status, 200);
  const mutationId = randomUUID(); assert.equal((await f.save(f.viewer, { mutationId })).status, 200); assert.equal((await f.save(f.viewer, { mutationId })).status, 200);
  await f.call('activity', 'POST', { action: 'recipe.view', recipeId: recipe.id }, f.viewer.cookie);
  await f.call('activity', 'POST', { action: 'backup.export' }, f.viewer.cookie);
  await f.decide(id, 'revoke'); await f.save(); f.restart();
  const result = await (await f.call('audit', 'GET', undefined, f.owner.cookie)).json();
  assert.equal(result.items.filter(item => item.action === 'recipe.create').length, 1);
  for (const action of ['account.register', 'account.login', 'permission.request', 'permission.approve', 'permission.revoke', 'recipe.view', 'backup.export']) assert.ok(result.items.some(item => item.action === action), action);
  assert.ok(result.items.some(item => item.result === 'denied'));
  for (const secret of [password, 'passwordHash', 'salt', 'fengwei_session']) assert.ok(!JSON.stringify(result).includes(secret));
  const filtered = await (await f.call('audit?q=' + encodeURIComponent('普通用户 新增菜谱'), 'GET', undefined, f.owner.cookie)).json(); assert.equal(filtered.items.length, 1);
  const audit = new AuditLog(f.store);
  for (let i = 0; i < 55; i++) await audit.record(f.owner.user, 'recipe.view', { target: `分页测试 ${i}` });
  const first = await audit.list({ query: '分页测试' }); assert.equal(first.items.length, 50); assert.ok(first.cursor);
  const second = await audit.list({ query: '分页测试', cursor: first.cursor }); assert.equal(second.items.length, 5); assert.equal(second.cursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 55);
});
