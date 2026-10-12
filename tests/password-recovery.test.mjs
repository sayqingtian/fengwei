import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';

const oldPassword = 'recovery-test-old-password', newPassword = 'recovery-test-new-password', otherPassword = 'recovery-test-another-password';
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-recovery-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  const handler = storage => createApi({ database: new RecipeDatabase(storage || store), password: oldPassword });
  let api = handler();
  const call = (path, method = 'GET', data, cookie, headers = {}) => api(new Request(`https://recipes.test/api/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json', Origin: 'https://recipes.test' } : {}), ...headers }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }));
  const login = (username, password = oldPassword) => call('login', 'POST', { username, password });
  const owner = await login('wupanfeng'), ownerCookie = cookieOf(owner), admin = (await owner.json()).user;
  const registration = await call('register', 'POST', { displayName: '找回测试用户', password: oldPassword, registrationId: randomUUID() });
  const viewerCookie = cookieOf(registration), viewer = (await registration.json()).user;
  const requestId = randomUUID(), request = { requestId, username: viewer.displayName, contact: '线下联系测试，非真实号码', reason: '忘记密码，需要线下核实' };
  const decision = { userId: viewer.id, requestId, action: 'reset', mutationId: randomUUID(), newPassword, confirmPassword: newPassword, identityVerified: true, note: '已通过原有联系渠道核实' };
  const submit = (data = request) => call('account/recovery', 'POST', data);
  const decide = (data = decision, cookie = ownerCookie) => call('admin/password-recovery/decision', 'POST', data, cookie);
  const inbox = () => call('admin/password-recovery', 'GET', undefined, ownerCookie);
  return { root, store, handler, call, login, ownerCookie, admin, viewerCookie, viewer, request, decision, submit, decide, inbox, replace(storage) { api = handler(storage); } };
}

test('anonymous recovery has a generic response and only administrators can see contact details or act', async t => {
  const f = await fixture(t), response = await f.submit();
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  const generic = await response.json(); assert.deepEqual(await (await f.submit({ ...f.request, username: '不存在的账号', requestId: randomUUID() })).json(), generic);
  const duplicate = await f.submit({ ...f.request, requestId: randomUUID(), contact: '试图替换联系方式' }); assert.equal(duplicate.status, 200);
  const data = await (await f.inbox()).json(); assert.equal(data.requests.length, 1); assert.equal(data.requests[0].contact, f.request.contact); assert.equal(data.requests[0].status, 'pending');
  assert.ok(!JSON.stringify(data).includes('passwordHash')); assert.ok(!JSON.stringify(data).includes('passwordVersion'));
  for (const cookie of [undefined, f.viewerCookie]) {
    assert.equal((await f.call('admin/password-recovery', 'GET', undefined, cookie)).status, cookie ? 403 : 401);
    assert.equal((await f.decide(f.decision, cookie || '')).status, cookie ? 403 : 401);
  }
  assert.equal((await f.call('me', 'GET', undefined, f.viewerCookie)).status, 200);
  assert.equal((await f.login(f.viewer.id)).status, 200);
});

test('administrator reset keeps account identity and favorites, invalidates all old sessions, and survives restart and retries', async t => {
  const f = await fixture(t), extraCookie = cookieOf(await f.login(f.viewer.id));
  await f.store.setJSON(`private/favorites/${f.viewer.id}/fixture.json`, { favorite: true });
  await f.submit();
  const response = await f.decide(); assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await response.json()).item.status, 'reset');
  assert.equal((await f.decide()).status, 200, 'same mutation may confirm a lost reply');
  assert.equal((await f.decide({ ...f.decision, newPassword: otherPassword, confirmPassword: otherPassword })).status, 409);
  assert.equal((await f.decide({ ...f.decision, action: 'reject', mutationId: randomUUID() })).status, 409);
  f.replace(new FileStore(f.root));
  for (const cookie of [f.viewerCookie, extraCookie]) assert.equal((await f.call('me', 'GET', undefined, cookie)).status, 401);
  assert.equal((await f.login(f.viewer.id)).status, 401);
  const loggedIn = await f.login(f.viewer.displayName, newPassword); assert.equal(loggedIn.status, 200);
  const user = (await loggedIn.json()).user; assert.equal(user.id, f.viewer.id); assert.equal(user.role, 'viewer');
  assert.deepEqual(await f.store.get(`private/favorites/${f.viewer.id}/fixture.json`, { type: 'json' }), { favorite: true });
  assert.equal((await f.call('me', 'GET', undefined, f.ownerCookie)).status, 200);
  const logs = JSON.stringify(await (await f.call('audit', 'GET', undefined, f.ownerCookie)).json());
  assert.ok(logs.includes('account.recovery.reset'));
  const inbox = JSON.stringify(await (await f.inbox()).json());
  for (const value of [oldPassword, newPassword, 'passwordHash', 'requestHash', 'salt']) { assert.ok(!logs.includes(value)); assert.ok(!inbox.includes(value)); }
  const { blobs } = await f.store.list({ prefix: 'private/password-recovery-decisions/' });
  assert.ok(!(await f.store.get(blobs[0].key)).includes(newPassword), 'reset commands never store plaintext');
});

test('rejection does not alter passwords and reset requires verified identity, matching passwords, and the same origin', async t => {
  const f = await fixture(t); await f.submit();
  for (const [data, code] of [
    [{ identityVerified: false }, 'IDENTITY_CHECK_REQUIRED'],
    [{ confirmPassword: 'different' }, 'PASSWORD_MISMATCH'],
    [{ newPassword: oldPassword, confirmPassword: oldPassword }, 'PASSWORD_UNCHANGED'],
  ]) { const response = await f.decide({ ...f.decision, ...data }); assert.equal(response.status, 400); assert.equal((await response.json()).code, code); }
  assert.equal((await f.call('admin/password-recovery/decision', 'POST', f.decision, f.ownerCookie, { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.call('account/recovery', 'POST', f.request, undefined, { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.decide({ ...f.decision, userId: f.admin.id })).status, 404);
  const rejection = { ...f.decision, action: 'reject', mutationId: randomUUID(), note: '身份尚未核实' };
  assert.equal((await f.decide(rejection)).status, 200); assert.equal((await f.decide(rejection)).status, 200);
  assert.equal((await f.inbox()).status, 200); assert.equal((await (await f.inbox()).json()).requests[0].status, 'rejected');
  assert.equal((await f.call('me', 'GET', undefined, f.viewerCookie)).status, 200); assert.equal((await f.login(f.viewer.id)).status, 200);
});

test('concurrent resets and rejection have one durable winner across server instances', async t => {
  const f = await fixture(t); await f.submit();
  const other = f.handler();
  const competing = { ...f.decision, action: 'reject', mutationId: randomUUID(), note: '另一页面拒绝' };
  const responses = await Promise.all([f.decide(), other(new Request('https://recipes.test/api/admin/password-recovery/decision', { method: 'POST', headers: { Cookie: f.ownerCookie, Origin: 'https://recipes.test', 'Content-Type': 'application/json' }, body: JSON.stringify(competing) }))]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const reset = responses[0].status === 200;
  assert.equal((await f.login(f.viewer.id, reset ? newPassword : oldPassword)).status, 200);
  assert.equal((await (await f.inbox()).json()).requests[0].status, reset ? 'reset' : 'rejected');
});

test('a pending request cannot override a newer password and expired requests cannot reset accounts', async t => {
  const f = await fixture(t); await f.submit();
  const change = await f.call('account/password', 'POST', { currentPassword: oldPassword, newPassword: otherPassword, confirmPassword: otherPassword, mutationId: randomUUID() }, f.viewerCookie);
  assert.equal(change.status, 200); assert.equal((await f.decide()).status, 409);
  assert.equal((await (await f.inbox()).json()).requests[0].status, 'stale');
  assert.equal((await f.login(f.viewer.id, otherPassword)).status, 200);
  const fresh = await fixture(t); await fresh.submit();
  const key = `private/password-recovery-requests/${fresh.viewer.id}/${fresh.request.requestId}.json`;
  const record = await fresh.store.get(key, { type: 'json' }); record.createdAt = new Date(Date.now() - 8 * 86400000).toISOString(); await fresh.store.setJSON(key, record);
  assert.equal((await fresh.decide()).status, 409); assert.equal((await (await fresh.inbox()).json()).requests[0].status, 'expired');
});

test('durable reset commands finish after a transient failure without storing or needing the plaintext password', async t => {
  const f = await fixture(t); await f.submit(); let failed = false;
  const broken = { get: f.store.get.bind(f.store), list: f.store.list.bind(f.store), set: f.store.set.bind(f.store), async setJSON(key, value, options) {
    if (!failed && key === `private/password-changes/${f.viewer.id}/initial.json`) { failed = true; throw new Error('Synthetic failed password write'); }
    return f.store.setJSON(key, value, options);
  } };
  f.replace(broken); assert.equal((await f.decide()).status, 503);
  f.replace(new FileStore(f.root));
  const data = await (await f.inbox()).json(); assert.equal(data.requests[0].status, 'reset');
  assert.equal((await f.login(f.viewer.id, newPassword)).status, 200); assert.equal((await f.decide()).status, 200);
  assert.equal((await f.login(f.viewer.id)).status, 401);
});

test('request validation and limits prevent anonymous spam without revealing account existence', async t => {
  const f = await fixture(t);
  assert.equal((await f.submit({ ...f.request, requestId: 'invalid' })).status, 400);
  assert.equal((await f.submit({ ...f.request, contact: '' })).status, 400);
  await f.submit();
  assert.equal((await f.submit({ ...f.request, requestId: randomUUID() })).status, 200);
  assert.equal((await f.submit({ ...f.request, requestId: randomUUID() })).status, 200);
  assert.equal((await f.submit({ ...f.request, requestId: randomUUID() })).status, 429);
  assert.equal((await (await f.inbox()).json()).requests.length, 1);
});

test('reusing an old reset version cannot create a password cycle or restore a superseded credential', async t => {
  const f = await fixture(t); await f.submit(); assert.equal((await f.decide()).status, 200);
  const loggedIn = await f.login(f.viewer.id, newPassword), currentVersion = randomUUID();
  assert.equal((await f.call('account/password', 'POST', { currentPassword: newPassword, newPassword: otherPassword, confirmPassword: otherPassword, mutationId: currentVersion }, cookieOf(loggedIn))).status, 200);
  const requestId = randomUUID();
  // A later request after the submission cooldown uses the current revision.
  await f.store.setJSON(`private/password-recovery-requests/${f.viewer.id}/${requestId}.json`, { id: requestId, userId: f.viewer.id, displayName: f.viewer.displayName, contact: '测试线下渠道', reason: '', passwordVersion: currentVersion, createdAt: new Date().toISOString() });
  assert.equal((await f.decide({ ...f.decision, requestId })).status, 409);
  assert.equal((await f.login(f.viewer.id, otherPassword)).status, 200);
  assert.equal((await f.login(f.viewer.id, newPassword)).status, 401);
});

test('an administrator may recover their own password from an existing session and receives an updated session', async t => {
  const f = await fixture(t);
  await f.submit({ ...f.request, username: 'wupanfeng' });
  const response = await f.decide({ ...f.decision, userId: f.admin.id }); assert.equal(response.status, 200);
  const newCookie = cookieOf(response); assert.ok(newCookie); assert.equal((await response.json()).user.role, 'admin');
  assert.equal((await f.call('me', 'GET', undefined, f.ownerCookie)).status, 401);
  assert.equal((await f.call('me', 'GET', undefined, newCookie)).status, 200);
  assert.equal((await f.login('wupanfeng', newPassword)).status, 200);
});
