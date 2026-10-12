import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHmac } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { createAuth, testAccount, SESSION_SECONDS } from '../server/auth.mjs';
import { RecipeDatabase, hash } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';
import { AuditLog } from '../server/audit.mjs';
import { makeAuditExport } from '../server/audit-export.mjs';

const oldPassword = 'credential-feature-test-old-password';
const newPassword = 'credential-feature-test-new-password';
const nextPassword = 'credential-feature-test-next-password';
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-password-export-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root), database = new RecipeDatabase(store);
  let api = createApi({ database, password: oldPassword });
  const call = (path, method = 'GET', data, cookie) => api(new Request(`https://recipes.test/api/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json', Origin: 'https://recipes.test' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }));
  const profile = async response => ({ status: response.status, cookie: cookieOf(response), user: (await response.json()).user });
  const login = (username = 'wupanfeng', password = oldPassword) => call('login', 'POST', { username, password });
  const owner = await profile(await login());
  const registrationId = randomUUID();
  const viewer = await profile(await call('register', 'POST', { displayName: '密码验收用户', password: oldPassword, registrationId })); assert.equal(viewer.status, 201);
  const change = (cookie = owner.cookie, data = {}) => call('account/password', 'POST', { currentPassword: oldPassword, newPassword, confirmPassword: newPassword, mutationId: randomUUID(), ...data }, cookie);
  return { root, store, database, call, profile, login, owner, viewer, change, replace(storage = new FileStore(root)) { api = createApi({ database: new RecipeDatabase(storage), password: oldPassword }); } };
}

test('admin can change password, keep the current session, revoke old and legacy sessions, and retain admin identity after restart', async t => {
  const f = await fixture(t), other = await f.login();
  const credentials = testAccount(oldPassword), auth = createAuth(f.store, credentials);
  const token = await auth.issue();
  const issued = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  const key = await f.store.get(`private/auth/${hash(JSON.stringify(credentials))}/${issued.keyId}`, { type: 'json' });
  const payload = Buffer.from(JSON.stringify({ version: 2, username: 'wupanfeng', keyId: issued.keyId, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })).toString('base64url');
  const legacy = `fengwei_session=${payload}.${createHmac('sha256', key.key).update(`fengwei-session-v2:${payload}`).digest('base64url')}`;
  assert.equal((await f.call('me', 'GET', undefined, legacy)).status, 200);
  const response = await f.change(); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.user.id, f.owner.user.id); assert.equal(data.user.role, 'admin'); assert.ok(data.user.passwordChangedAt);
  const cookie = cookieOf(response); assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict;.*Secure/);
  assert.equal((await f.call('me', 'GET', undefined, cookie)).status, 200);
  for (const invalid of [f.owner.cookie, cookieOf(other), legacy]) assert.equal((await f.call('me', 'GET', undefined, invalid)).status, 401);
  f.replace(); assert.equal((await f.login()).status, 401);
  const updated = await f.profile(await f.login('wupanfeng', newPassword)); assert.equal(updated.status, 200); assert.equal(updated.user.role, 'admin');
  assert.equal((await f.login(f.owner.user.id, newPassword)).status, 200);
});

test('viewers change only their own password and retain independent favorites and read-only rights', async t => {
  const f = await fixture(t);
  const recipe = { id: 'favorite-password-test', title: '番茄炒蛋', description: '', category: '家常菜', minutes: 15, servings: 2, favorite: false, photo: '', notes: '', ingredients: [], steps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await f.database.commit({ id: recipe.id, recipe, baseRevision: null, mutationId: randomUUID() });
  await f.call(`favorite/${recipe.id}`, 'PUT', { favorite: true, mutationId: randomUUID() }, f.viewer.cookie);
  const response = await f.change(f.viewer.cookie, { userId: f.owner.user.id, username: 'wupanfeng', role: 'admin', canEdit: true }); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.user.id, f.viewer.user.id); assert.equal(data.user.role, 'viewer'); assert.equal(data.user.canEdit, false);
  const cookie = cookieOf(response);
  const items = await (await f.call('recipes', 'GET', undefined, cookie)).json(); assert.equal(items.items[0].recipe.favorite, true);
  assert.equal((await f.call('audit/export', 'GET', undefined, cookie)).status, 403);
  assert.equal((await f.login()).status, 200, 'administrator password is unaffected');
  assert.equal((await f.login(f.viewer.user.displayName, oldPassword)).status, 401);
  assert.equal((await f.login(f.viewer.user.displayName, newPassword)).status, 200);
  assert.equal((await f.login(f.viewer.user.id, newPassword)).status, 200);
});

test('password validation preserves sessions, rejects anonymous and cross-origin mutations, and never records plaintext', async t => {
  const f = await fixture(t);
  const cases = [
    [{ currentPassword: 'wrong-current-password' }, 'CURRENT_PASSWORD_INCORRECT'],
    [{ newPassword: 'short', confirmPassword: 'short' }, 'INVALID_PASSWORD'],
    [{ confirmPassword: nextPassword }, 'PASSWORD_MISMATCH'],
    [{ newPassword: oldPassword, confirmPassword: oldPassword }, 'PASSWORD_UNCHANGED'],
  ];
  for (const [input, code] of cases) { const response = await f.change(f.owner.cookie, input); assert.equal(response.status, 400); assert.equal((await response.json()).code, code); }
  assert.equal((await f.call('account/password', 'POST', { currentPassword: oldPassword, newPassword })).status, 401);
  const api = createApi({ database: f.database, password: oldPassword });
  assert.equal((await api(new Request('https://recipes.test/api/account/password', { method: 'POST', headers: { Cookie: f.owner.cookie, Origin: 'https://other.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: oldPassword, newPassword, confirmPassword: newPassword, mutationId: randomUUID() }) }))).status, 403);
  assert.equal((await f.call('me', 'GET', undefined, f.owner.cookie)).status, 200);
  assert.equal((await f.store.list({ prefix: 'private/password-changes/' })).blobs.length, 0);
  const logs = JSON.stringify(await (await f.call('audit', 'GET', undefined, f.owner.cookie)).json());
  for (const value of [oldPassword, newPassword, 'wrong-current-password', 'passwordHash', 'salt', 'currentPassword', 'newPassword']) assert.ok(!logs.includes(value));
});

test('concurrent password changes have one winner and the loser cannot overwrite the winning credential', async t => {
  const f = await fixture(t); let writers = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const storage = { get: f.store.get.bind(f.store), list: f.store.list.bind(f.store), set: f.store.set.bind(f.store), async setJSON(key, value, options) {
    if (key === `private/password-changes/${f.owner.user.id}/initial.json`) { if (++writers === 2) release(); await gate; }
    return f.store.setJSON(key, value, options);
  } };
  f.replace(storage);
  const changes = await Promise.all([f.change(), f.change(f.owner.cookie, { newPassword: nextPassword, confirmPassword: nextPassword })]);
  assert.deepEqual(changes.map(response => response.status).sort(), [200, 409]);
  const password = changes[0].status === 200 ? newPassword : nextPassword;
  const wrong = changes[0].status === 200 ? nextPassword : newPassword;
  assert.equal((await f.login('wupanfeng', password)).status, 200); assert.equal((await f.login('wupanfeng', wrong)).status, 401);
  assert.equal((await f.store.list({ prefix: 'private/password-changes/' })).blobs.length, 1);
});

test('password retries are idempotent and stale head caches and reused old mutation IDs cannot restore old passwords', async t => {
  const f = await fixture(t);
  const storage = { get: f.store.get.bind(f.store), list: f.store.list.bind(f.store), set: f.store.set.bind(f.store), async setJSON(key, value, options) {
    if (key.startsWith('private/password-heads/')) throw Object.assign(new Error('Test cache failure'), { code: 'TEST_HEAD_CACHE_FAILURE' });
    return f.store.setJSON(key, value, options);
  } }; f.replace(storage);
  const mutationId = randomUUID(); const first = await f.change(f.owner.cookie, { mutationId }); assert.equal(first.status, 200);
  const cookie = cookieOf(first);
  assert.equal((await f.change(cookie, { mutationId })).status, 200);
  assert.equal((await f.change(cookie, { mutationId, currentPassword: 'wrong-current-password-on-retry' })).status, 409, 'a retry cannot bypass proof of the original current password');
  assert.equal((await f.change(cookie, { mutationId, newPassword: nextPassword, confirmPassword: nextPassword })).status, 409);
  const second = await f.change(cookie, { currentPassword: newPassword, newPassword: nextPassword, confirmPassword: nextPassword }); assert.equal(second.status, 200);
  const secondCookie = cookieOf(second);
  assert.equal((await f.change(secondCookie, { currentPassword: nextPassword, newPassword, confirmPassword: newPassword, mutationId })).status, 409);
  f.replace(); assert.equal((await f.login()).status, 401); assert.equal((await f.login('wupanfeng', newPassword)).status, 401); assert.equal((await f.login('wupanfeng', nextPassword)).status, 200);
  assert.equal((await f.call('me', 'GET', undefined, cookie)).status, 401);
  const logs = await (await f.call('audit', 'GET', undefined, secondCookie)).json(); assert.equal(logs.items.filter(item => item.action === 'account.password' && item.result === 'success').length, 2);
});

test('wrong current-password attempts are rate limited without changing the account', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.change(f.owner.cookie, { currentPassword: 'wrong-for-rate-test' })).status, 400);
  const response = await f.change(); assert.equal(response.status, 429); assert.equal((await response.json()).code, 'PASSWORD_TRY_LATER');
  assert.equal((await f.login()).status, 200);
});

test('admin exports all matching audit records beyond page 50 in CSV and JSON; viewer and anonymous exports are blocked', async t => {
  const f = await fixture(t), audit = new AuditLog(f.store);
  for (let i = 0; i < 61; i++) await audit.record({ ...f.viewer.user, displayName: '=2+2' }, 'recipe.view', { target: `导出验收 ${i},包含"引号"\n和换行` });
  const query = 'q=' + encodeURIComponent('导出验收') + '&result=success';
  const listed = await (await f.call('audit?' + query, 'GET', undefined, f.owner.cookie)).json(); assert.equal(listed.items.length, 50); assert.ok(listed.cursor);
  const csvResponse = await f.call('audit/export?format=csv&' + query, 'GET', undefined, f.owner.cookie); assert.equal(csvResponse.status, 200); assert.match(csvResponse.headers.get('content-type'), /text\/csv/); assert.equal(csvResponse.headers.get('x-audit-count'), '61');
  assert.match(csvResponse.headers.get('content-disposition'), /filename\*=UTF-8''/); assert.match(csvResponse.headers.get('cache-control'), /no-store/);
  const bytes = Buffer.from(await csvResponse.arrayBuffer()); assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
  const csv = bytes.toString('utf8'); assert.ok(csv.includes('"\'=2+2"')); assert.ok(csv.includes('包含""引号""\n和换行')); assert.equal((csv.match(/导出验收 /g) || []).length, 61);
  const exported = await (await f.call('audit/export?format=json&' + query, 'GET', undefined, f.owner.cookie)).json(); assert.equal(exported.total, 61); assert.equal(exported.items.length, 61); assert.equal(exported.timeZone, 'Asia/Shanghai'); assert.equal(exported.filters.query, '导出验收');
  for (const value of [oldPassword, 'passwordHash', 'salt', 'fengwei_session']) assert.ok(!JSON.stringify(exported).includes(value));
  assert.equal((await f.call('audit/export?format=csv', 'GET', undefined, f.viewer.cookie)).status, 403);
  assert.equal((await f.call('audit/export?format=json')).status, 401);
  assert.equal((await f.call('audit/export?format=xlsx', 'GET', undefined, f.owner.cookie)).status, 400);
  const empty = await (await f.call('audit/export?format=json&q=does-not-match-anything', 'GET', undefined, f.owner.cookie)).json(); assert.equal(empty.total, 0);
  const logs = await (await f.call('audit?q=' + encodeURIComponent('导出操作日志'), 'GET', undefined, f.owner.cookie)).json(); assert.ok(logs.items.some(item => item.action === 'audit.export'));
});

test('CSV neutralizes formula prefixes, uses Beijing dates, and JSON exports only documented fields', () => {
  const targets = ['=HYPERLINK("x")', '+SUM(1,2)', '-1+2', '@SUM(1)', '  =1+1', '\t=1+1'];
  const items = targets.map((target, index) => ({ id: String(index), createdAt: '2026-10-12T17:00:00Z', userId: 'test-user', displayName: '测试用户', action: 'recipe.view', target, result: 'success', passwordHash: 'never-export-secret' }));
  const file = makeAuditExport(items, { format: 'csv' }, new Date('2026-10-12T17:00:00Z'));
  assert.equal(file.filename, '峰味-操作日志-2026-10-13.csv'); assert.ok(file.content.includes('2026-10-13 01:00:00'));
  for (const target of targets) assert.ok(file.content.includes(`"'${target.replaceAll('"', '""')}"`));
  const json = makeAuditExport(items, { format: 'json' }); assert.ok(!json.content.includes('never-export-secret')); assert.ok(!json.content.includes('passwordHash'));
});
