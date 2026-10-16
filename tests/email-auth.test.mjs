import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApi } from '../server/api.mjs';
import { createAuth, testAccount } from '../server/auth.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';
import { createResendMailer, normalizeEmail } from '../server/email-auth.mjs';
import { backupKey } from '../server/full-backup.mjs';

const password = 'email-tests-original-password', nextPassword = 'email-tests-next-password';
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
async function fixture(t, configured = true) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-email-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root), messages = [];
  const mailer = { configured, async sendCode(value) { messages.push(value); } };
  const handler = () => createApi({ database: new RecipeDatabase(store), password, mailer });
  let api = handler();
  const call = (path, data, cookie, address = randomUUID(), method = data === undefined ? 'GET' : 'POST', extraHeaders = {}) => api(new Request(`https://recipes.test/api/${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { Origin: 'https://recipes.test', 'Content-Type': 'application/json' }), ...extraHeaders }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), { clientIp: address });
  const send = async (data, cookie, address) => {
    const response = await call('email/code', { requestId: randomUUID(), ...data }, cookie, address);
    const body = await response.json(); assert.equal(response.status, 200, body.error);
    return { ...body, email: data.email, code: messages.find(item => item.id === body.challengeId)?.code };
  };
  const signup = async (email = 'cook@example.test', displayName = '邮箱厨房') => {
    const verification = await send({ purpose: 'register', email });
    const data = { displayName, password, registrationId: randomUUID(), ...verification };
    const response = await call('register', data), body = await response.json();
    assert.equal(response.status, 201, body.error);
    return { user: body.user, cookie: cookieOf(response), data };
  };
  const legacy = async (name = 'wupanfeng') => {
    if (name !== 'wupanfeng') await createAuth(store, testAccount(password)).accounts.register({ displayName: name, password, registrationId: randomUUID() });
    const response = await call('login', { username: name, password }); assert.equal(response.status, 200);
    return { user: (await response.json()).user, cookie: cookieOf(response) };
  };
  const bind = async (account, email = 'owner@example.test') => {
    const verification = await send({ purpose: 'bind', email, currentPassword: password, expectedUserId: account.user.id }, account.cookie);
    const data = { ...verification, currentPassword: password, expectedUserId: account.user.id, mutationId: randomUUID() };
    const response = await call('account/email', data, account.cookie); assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    return { data, user: (await response.json()).user };
  };
  return { store, messages, mailer, handler, call, send, signup, legacy, bind, replace() { api = handler(); } };
}

test('production registration fails closed without mail configuration and old accounts can still log in', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.call('email/code', { requestId: randomUUID(), purpose: 'register', email: 'test@example.test' })).status, 503);
  assert.equal((await f.call('register', { displayName: '缺验证码', password, registrationId: randomUUID() })).status, 400);
  assert.equal((await f.legacy()).user.role, 'admin');
  assert.equal(f.messages.length, 0);
});

test('verified registration is durable, private, and a single code authorizes only one registration intent', async t => {
  const f = await fixture(t), account = await f.signup(' Cook@Example.Test ');
  assert.equal(account.user.email, 'cook@example.test'); assert.ok(account.user.emailVerifiedAt);
  assert.equal((await f.call('register', account.data)).status, 201, 'identical lost-response retry');
  const replay = await f.call('register', { ...account.data, registrationId: randomUUID(), displayName: '重复使用验证码' });
  assert.equal(replay.status, 400);
  assert.equal((await f.call('register', { ...account.data, email: 'other@example.test' })).status, 400);
  f.replace();
  const login = await f.call('login', { username: account.user.id, password });
  assert.equal(login.status, 200); assert.equal((await login.json()).user.email, 'cook@example.test');
  assert.equal((await (await f.call('me', undefined, account.cookie)).json()).user.id, account.user.id);
  const { blobs } = await f.store.list({ prefix: 'private/' });
  for (const { key } of blobs.filter(item => /email-|audit\//.test(item.key))) {
    const value = await f.store.get(key, { type: 'json' });
    if (!key.startsWith('private/audit/')) assert.equal(value.code, undefined);
    assert.equal(value.password, undefined);
    if (key.startsWith('private/audit/')) { assert.ok(!JSON.stringify(value).includes('cook@example.test')); assert.ok(!JSON.stringify(value).includes(password)); }
  }
});

test('legacy administrator can bind email then recover without an active login; reset revokes every old session', async t => {
  const f = await fixture(t), admin = await f.legacy();
  assert.equal(admin.user.email, undefined);
  assert.equal((await f.call('email/code', { purpose: 'bind', requestId: randomUUID(), email: 'owner@example.test', currentPassword: 'wrong', expectedUserId: admin.user.id }, admin.cookie)).status, 400);
  const binding = await f.bind(admin);
  assert.equal(binding.user.id, admin.user.id); assert.equal(binding.user.role, 'admin');
  assert.equal((await f.call('account/email', binding.data, admin.cookie)).status, 200);
  assert.equal((await (await f.call('me', undefined, admin.cookie)).json()).user.email, 'owner@example.test');
  f.replace();
  const now = Date.now() + 61000; t.mock.method(Date, 'now', () => now);
  const verification = await f.send({ purpose: 'recover', username: 'wupanfeng', email: 'owner@example.test' });
  const data = { ...verification, username: 'wupanfeng', newPassword: nextPassword, confirmPassword: nextPassword, mutationId: randomUUID() };
  const response = await f.call('account/email-recovery', data);
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null, 'reset never automatically logs in');
  assert.equal((await f.call('account/email-recovery', data)).status, 200, 'lost reply can confirm the same reset');
  assert.equal((await f.call('me', undefined, admin.cookie)).status, 401);
  assert.equal((await f.call('login', { username: 'wupanfeng', password })).status, 401);
  const login = await f.call('login', { username: 'wupanfeng', password: nextPassword });
  assert.equal(login.status, 200); const user = (await login.json()).user;
  assert.equal(user.id, admin.user.id); assert.equal(user.role, 'admin'); assert.equal(user.email, 'owner@example.test');
  assert.equal((await f.call('account/email-recovery', { ...data, mutationId: randomUUID() })).status, 400);
  assert.ok(backupKey(`private/account-emails/${admin.user.id}.json`));
  for (const key of ['private/email-secrets/v1.json', `private/email-challenges/${verification.challengeId}.json`, `private/email-code-uses/${verification.challengeId}.json`]) assert.equal(backupKey(key), false);
});

test('recovery hides unknown users, wrong mailboxes, deleted accounts and accounts without a bound email', async t => {
  const f = await fixture(t), user = await f.signup();
  await f.legacy('未绑定用户');
  const before = f.messages.length;
  const requests = [
    { username: '不存在', email: 'unknown@example.test' },
    { username: user.user.displayName, email: 'wrong@example.test' },
    { username: '未绑定用户', email: 'unbound@example.test' },
  ];
  const responses = [];
  for (const data of requests) responses.push(await f.send({ purpose: 'recover', ...data }));
  assert.equal(f.messages.length, before);
  const now = Date.now() + 61000; t.mock.method(Date, 'now', () => now);
  const valid = await f.send({ purpose: 'recover', username: user.user.displayName, email: 'cook@example.test' });
  for (const item of responses) assert.equal(item.message, valid.message);
  await f.store.setJSON(`private/deleted-users/${user.user.id}.json`, { id: user.user.id, displayName: user.user.displayName });
  const response = await f.call('account/email-recovery', { ...valid, username: user.user.displayName, mutationId: randomUUID(), newPassword: nextPassword, confirmPassword: nextPassword });
  assert.equal(response.status, 400);
});

test('expired, superseded and wrong-purpose codes cannot register an account', async t => {
  const f = await fixture(t); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const first = await f.send({ purpose: 'register', email: 'codes@example.test' });
  now += 61000;
  const second = await f.send({ purpose: 'register', email: 'codes@example.test' });
  const registration = { displayName: '失效验证', password, registrationId: randomUUID() };
  assert.equal((await f.call('register', { ...registration, ...first })).status, 400);
  const record = await f.store.get(`private/email-challenges/${second.challengeId}.json`, { type: 'json' });
  record.purpose = 'recover'; await f.store.setJSON(`private/email-challenges/${second.challengeId}.json`, record);
  assert.equal((await f.call('register', { ...registration, ...second })).status, 400);
  record.purpose = 'register'; record.expiresAt = now - 1; await f.store.setJSON(`private/email-challenges/${second.challengeId}.json`, record);
  assert.equal((await f.call('register', { ...registration, ...second })).status, 400);
});

test('wrong-code attempts exhaust a shared budget and code sending enforces cooldown and source limits', async t => {
  const f = await fixture(t), code = await f.send({ purpose: 'register', email: 'limits@example.test' });
  const registration = { displayName: '次数限制', password, registrationId: randomUUID(), ...code };
  for (let i = 0; i < 5; i++) { f.replace(); assert.equal((await f.call('register', { ...registration, code: code.code === '000000' ? '000001' : '000000' })).status, 400); }
  assert.equal((await f.call('register', registration)).status, 429);
  assert.equal((await f.call('email/code', { requestId: randomUUID(), purpose: 'register', email: code.email })).status, 429);
  for (let i = 0; i < 5; i++) assert.equal((await f.call('email/code', { requestId: randomUUID(), purpose: 'register', email: `source-${i}@example.test` }, undefined, 'fixed-source')).status, 200);
  assert.equal((await f.call('email/code', { requestId: randomUUID(), purpose: 'register', email: 'source-extra@example.test' }, undefined, 'fixed-source')).status, 429);
});

test('parallel consumers have one winner; password changes invalidate already-issued recovery codes', async t => {
  const f = await fixture(t), verification = await f.send({ purpose: 'register', email: 'race@example.test' });
  const data = { ...verification, displayName: '并发赢家', password, registrationId: randomUUID() };
  const otherApi = f.handler();
  const other = new Request('https://recipes.test/api/register', { method: 'POST', headers: { Origin: 'https://recipes.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, displayName: '并发另一个', registrationId: randomUUID() }) });
  const responses = await Promise.all([f.call('register', data), otherApi(other, { clientIp: 'parallel-other' })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 400]);
  const winner = responses.find(response => response.status === 201), account = (await winner.clone().json()).user, cookie = cookieOf(winner);
  const now = Date.now() + 61000; t.mock.method(Date, 'now', () => now);
  const reset = await f.send({ purpose: 'recover', username: account.id, email: 'race@example.test' });
  const changed = await f.call('account/password', { currentPassword: password, newPassword: nextPassword, confirmPassword: nextPassword, mutationId: randomUUID() }, cookie);
  assert.equal(changed.status, 200);
  const recovery = await f.call('account/email-recovery', { ...reset, username: account.id, newPassword: 'another-new-password', confirmPassword: 'another-new-password', mutationId: randomUUID() });
  assert.equal(recovery.status, 409);
});

test('mail delivery failures never activate a code, and identical retries keep the same provider idempotency key and code', async t => {
  const f = await fixture(t), attempts = []; let fail = true;
  f.mailer.sendCode = async value => { attempts.push(value); if (fail) throw Object.assign(new Error('delivery unavailable'), { status: 503 }); };
  const data = { purpose: 'register', email: 'delivery@example.test', requestId: randomUUID() };
  assert.equal((await f.call('email/code', data)).status, 503);
  assert.equal((await f.call('register', { displayName: '邮件重试', password, registrationId: randomUUID(), email: data.email, code: attempts[0].code, challengeId: data.requestId })).status, 400);
  fail = false; assert.equal((await f.call('email/code', data)).status, 200);
  assert.equal((await f.call('email/code', data)).status, 200);
  assert.equal(attempts.length, 2); assert.equal(attempts[0].id, attempts[1].id); assert.equal(attempts[0].code, attempts[1].code);
});

test('email binding requires current credentials, is account-scoped, and cannot replace an existing verified mailbox', async t => {
  const f = await fixture(t), a = await f.legacy('旧账号一'), b = await f.legacy('旧账号二');
  const code = await f.send({ purpose: 'bind', email: 'bind@example.test', currentPassword: password, expectedUserId: a.user.id }, a.cookie);
  const data = { ...code, mutationId: randomUUID(), expectedUserId: b.user.id, currentPassword: password };
  assert.equal((await f.call('account/email', data, b.cookie)).status, 400);
  data.expectedUserId = a.user.id;
  assert.equal((await f.call('account/email', data, a.cookie)).status, 200, 'a mismatched target cannot consume the real owner’s code');
  // A separate legacy account can still bind its own mailbox.
  let now = Date.now(); t.mock.method(Date, 'now', () => now); now += 61000;
  await f.bind(b, 'bound@example.test');
  assert.equal((await f.call('email/code', { requestId: randomUUID(), purpose: 'bind', email: 'replacement@example.test', expectedUserId: a.user.id, currentPassword: password }, a.cookie)).status, 409);
  assert.equal((await f.call('email/code', { requestId: randomUUID(), purpose: 'bind', email: 'cross@example.test', expectedUserId: a.user.id, currentPassword: password }, a.cookie, undefined, 'POST', { Origin: 'https://attacker.test' })).status, 403);
});

test('Resend integration sends plain text with idempotency, suppresses provider diagnostics, and validates email syntax', async () => {
  const requests = [], secret = 're_synthetic_test_only';
  const mailer = createResendMailer({ apiKey: secret, from: '峰味 <noreply@example.test>', fetch: async (url, options) => { requests.push({ url, options }); return Response.json({ id: 'provider-fixture-id' }); } });
  await mailer.sendCode({ email: 'cook@example.test', code: '123456', purpose: 'register', id: 'fixture-id' });
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].options.headers['Idempotency-Key'], 'fengwei-email-fixture-id');
  const body = JSON.parse(requests[0].options.body); assert.match(body.text, /123456/); assert.equal(body.html, undefined); assert.deepEqual(body.to, ['cook@example.test']);
  const broken = createResendMailer({ apiKey: secret, from: 'noreply@example.test', fetch: async () => Response.json({ message: `private ${secret}` }, { status: 403 }) });
  await assert.rejects(() => broken.sendCode({ email: 'cook@example.test', code: '123456', purpose: 'recover', id: 'failed-id' }), error => error.code === 'EMAIL_SEND_UNAVAILABLE' && !error.message.includes(secret));
  assert.equal(normalizeEmail(' Cook@Example.TEST '), 'cook@example.test');
  for (const value of ['', 'a@b', '.a@example.test', 'a..b@example.test', 'a@example.test\nBcc:evil@example.test', 'a@example.test,b@example.test']) assert.throws(() => normalizeEmail(value));
});
