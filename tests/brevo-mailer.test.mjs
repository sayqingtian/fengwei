import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmailMailer, createBrevoMailer } from '../server/email-auth.mjs';
import { createApi } from '../server/api.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';

const secret = 'xkeysib_synthetic_fixture_only', from = '峰味 <sender@gmail.com>';
const value = () => ({ email: 'receiver@example.test', code: '635982', purpose: 'register', id: randomUUID() });

test('Brevo sends through HTTPS using a verified personal mailbox, API v3 key and stable idempotency UUID', async () => {
  const requests = [];
  const mailer = createBrevoMailer({ apiKey: ` ${secret}\n`, from, fetch: async (url, options) => { requests.push({ url, options }); return Response.json({ messageId: '<fixture@brevo.test>' }, { status: 201 }); } });
  const data = value(); await mailer.sendCode(data); await mailer.sendCode(data);
  assert.equal(mailer.configured, true); assert.equal(mailer.provider, 'brevo');
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.equal(url, 'https://api.brevo.com/v3/smtp/email'); assert.equal(options.headers['api-key'], secret);
    assert.equal(options.headers.Authorization, undefined); assert.equal(options.method, 'POST'); assert.ok(options.signal);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.sender, { name: '峰味', email: 'sender@gmail.com' });
    assert.deepEqual(body.to, [{ email: data.email }]); assert.equal(body.headers.idempotencyKey, data.id);
    assert.match(body.textContent, /635982/); assert.match(body.subject, /注册账号/); assert.match(body.htmlContent, /635982/);
    assert.ok(!options.body.includes(secret));
  }
  assert.equal(requests[0].options.body, requests[1].options.body);
});

test('provider selection honors explicit settings, supports existing Resend configuration and never falls back after a Brevo failure', async t => {
  t.mock.method(console, 'error', () => {});
  const settings = { provider: undefined, brevoApiKey: '', resendApiKey: 're_synthetic', from, fetch: async () => { assert.fail('Selection must not send any email'); } };
  assert.equal(createEmailMailer(settings).provider, 'resend');
  assert.equal(createEmailMailer({ ...settings, brevoApiKey: secret }).provider, 'brevo');
  assert.equal(createEmailMailer({ ...settings, brevoApiKey: secret, provider: ' RESEND ' }).provider, 'resend');
  const explicit = createEmailMailer({ ...settings, provider: 'brevo' });
  assert.equal(explicit.provider, 'brevo'); assert.equal(explicit.configured, false);
  const invalid = createEmailMailer({ ...settings, provider: 'unknown-secret-provider' });
  assert.equal(invalid.configured, false); assert.equal(invalid.configurationError.code, 'EMAIL_PROVIDER_INVALID');
  assert.ok(!invalid.configurationError.message.includes('unknown-secret-provider'));
  const requests = [], failing = createEmailMailer({ ...settings, brevoApiKey: secret, provider: 'brevo', fetch: async url => { requests.push(url); return Response.json({ code: 'unauthorized', message: 'Key not found' }, { status: 401 }); } });
  await assert.rejects(() => failing.sendCode(value()), { code: 'EMAIL_KEY_INVALID' });
  assert.deepEqual(requests, ['https://api.brevo.com/v3/smtp/email']);
});

test('Brevo sender verification, account activation and quota failures have safe actionable messages', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const cases = [
    [400, 'invalid_parameter', 'Your sender is not valid. Use a verified sender.', 'EMAIL_SENDER_UNVERIFIED'],
    [403, 'account_under_validation', 'Account under review', 'EMAIL_ACCOUNT_PENDING'],
    [400, 'invalid_parameter', 'Your SMTP account is not yet activated.', 'EMAIL_ACCOUNT_PENDING'],
    [400, 'not_enough_credits', 'Quota depleted', 'EMAIL_PROVIDER_QUOTA'],
    [401, 'unauthorized', 'Key not found', 'EMAIL_KEY_INVALID'],
    [403, 'permission_denied', 'Permission denied', 'EMAIL_KEY_PERMISSION'],
    [429, 'too_many_requests', 'Too many requests', 'EMAIL_SEND_BUSY'],
    [400, 'duplicate_parameter', 'Sender already exists', 'EMAIL_SEND_UNAVAILABLE'],
    [503, 'unknown', 'Service failed', 'EMAIL_PROVIDER_UNAVAILABLE'],
  ];
  for (const [status, code, message, expected] of cases) {
    const mailer = createBrevoMailer({ apiKey: secret, from, fetch: async () => Response.json({ code, message: `${message} ${secret} sender@gmail.com` }, { status }) });
    await assert.rejects(() => mailer.sendCode(value()), error => error.status === 503 && error.code === expected && !error.message.includes(secret) && !error.message.includes('sender@gmail.com'));
  }
  const logs = JSON.stringify(log.mock.calls.map(call => call.arguments));
  assert.match(logs, /brevo/); assert.ok(!logs.includes(secret)); assert.ok(!logs.includes('sender@gmail.com'));
  const malformed = createBrevoMailer({ apiKey: secret, from, fetch: async () => Response.json({ messageIds: [] }) });
  await assert.rejects(() => malformed.sendCode(value()), { code: 'EMAIL_PROVIDER_RESPONSE_INVALID' });
});

test('Brevo IP restrictions take precedence over unauthorized status without exposing provider diagnostics', async t => {
  const log = t.mock.method(console, 'error', () => {}), address = '198.51.100.27';
  const cases = [
    [401, 'unauthorized', `Unrecognised IP address ${address}. Authorize it in your security settings.`, 'EMAIL_IP_UNAUTHORIZED'],
    [401, 'unauthorized', `IP address ${address} not authorized`, 'EMAIL_IP_UNAUTHORIZED'],
    [403, 'permission_denied', `IP address ${address} is blocked`, 'EMAIL_IP_UNAUTHORIZED'],
    [401, 'unauthorized', 'not verified', 'EMAIL_AUTH_FAILED'],
    [401, 'unauthorized', 'Unknown authentication failure', 'EMAIL_AUTH_FAILED'],
    [401, 'unauthorized', 'Key not found', 'EMAIL_KEY_INVALID'],
  ];
  for (const [status, code, message, expected] of cases) {
    const mailer = createBrevoMailer({ apiKey: secret, from, fetch: async () => Response.json({ code, message: `${message} ${secret}` }, { status }) });
    await assert.rejects(() => mailer.sendCode(value()), error => error.code === expected && !error.message.includes(secret) && !error.message.includes(address));
  }
  const logs = JSON.stringify(log.mock.calls.map(call => call.arguments));
  assert.ok(!logs.includes(secret)); assert.ok(!logs.includes(address));
  assert.match(logs, /EMAIL_IP_UNAUTHORIZED/);
  const unreadable = createBrevoMailer({ apiKey: secret, from, fetch: async () => new Response('Unknown authentication failure', { status: 401 }) });
  await assert.rejects(() => unreadable.sendCode(value()), { code: 'EMAIL_AUTH_FAILED' });
});

test('Brevo accepts only an explicit idempotency acknowledgement as a successful retry', async t => {
  t.mock.method(console, 'error', () => {});
  const send = message => createBrevoMailer({ apiKey: secret, from, fetch: async () => Response.json({ code: 'duplicate_parameter', message }, { status: 400 }) }).sendCode(value());
  await send('Email for the idempotency key has already been processed');
  await assert.rejects(() => send('Sender already exists'), { code: 'EMAIL_SEND_UNAVAILABLE' });
  await assert.rejects(() => send('Invalid idempotency key'), { code: 'EMAIL_SEND_UNAVAILABLE' });
});

test('registration and password recovery work through Brevo; a lost accepted reply retries without another send', async t => {
  t.mock.method(console, 'error', () => {});
  const root = await mkdtemp(join(tmpdir(), 'fengwei-brevo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = new Map(), requests = [], password = 'brevo-initial-fixture-password', nextPassword = 'brevo-reset-fixture-password';
  const mailer = createEmailMailer({ provider: 'brevo', brevoApiKey: secret, from, fetch: async (url, options) => {
    requests.push(url); const data = JSON.parse(options.body), id = data.headers.idempotencyKey;
    if (sent.has(id)) return Response.json({ code: 'duplicate_parameter', message: 'Email for the idempotency key has already been processed' }, { status: 400 });
    sent.set(id, data);
    if (sent.size === 1) throw new Error('Simulated lost accepted response');
    return Response.json({ messageId: `<${id}@brevo.test>` }, { status: 201 });
  } });
  const handler = createApi({ database: new RecipeDatabase(new FileStore(root)), password, mailer });
  const call = (route, data, cookie) => handler(new Request(`https://recipes.test/api/${route}`, { method: data ? 'POST' : 'GET', headers: { ...(data ? { Origin: 'https://recipes.test', 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), { clientIp: randomUUID() });
  const request = { requestId: randomUUID(), purpose: 'register', email: 'new-cook@example.test' };
  assert.equal((await call('email/code', request)).status, 503);
  const code = sent.get(request.requestId).textContent.match(/验证码：(\d{6})/)[1];
  const data = { email: request.email, code, challengeId: request.requestId, displayName: 'Brevo新账号', password, registrationId: randomUUID() };
  assert.equal((await call('register', data)).status, 400, 'an unacknowledged send never activates a code');
  assert.equal((await call('email/code', request)).status, 200);
  assert.equal((await call('email/code', request)).status, 200);
  assert.equal(requests.length, 2, 'the accepted marker prevents another provider call');
  const registered = await call('register', data); assert.equal(registered.status, 201);
  const user = (await registered.json()).user, cookie = registered.headers.get('set-cookie').split(';')[0];
  assert.equal(user.email, request.email); assert.equal(user.role, 'viewer');
  const now = Date.now() + 61000; t.mock.method(Date, 'now', () => now);
  const recovery = { requestId: randomUUID(), purpose: 'recover', username: user.id, email: user.email };
  assert.equal((await call('email/code', recovery)).status, 200);
  const resetCode = sent.get(recovery.requestId).textContent.match(/验证码：(\d{6})/)[1];
  const reset = await call('account/email-recovery', { username: user.id, email: user.email, code: resetCode, challengeId: recovery.requestId, mutationId: randomUUID(), newPassword: nextPassword, confirmPassword: nextPassword });
  assert.equal(reset.status, 200); assert.equal(reset.headers.get('set-cookie'), null);
  assert.equal((await call('me', undefined, cookie)).status, 401);
  assert.equal((await call('login', { username: user.id, password: nextPassword })).status, 200);
  assert.equal((await call('login', { username: user.id, password })).status, 401);
});
