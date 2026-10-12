import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getStore } from '@edgeone/pages-blob';
import { withAtomicWrites } from '../server/edgeone-store.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { createApi } from '../server/api.mjs';

const password = 'edgeone-store-fixture-password';
const credential = { secretId: 'fixture-secret-id', secretKey: 'fixture-secret-key', sessionToken: 'fixture-session-token' };
const prefix = '1250000000/fixture-project/fengwei-recipes/';
function fixture({ enforceCondition = true, beforeWrite } = {}) {
  const objects = new Map();
  let ordinaryWrites = 0;
  const sdk = () => ({
    storeName: 'fengwei-recipes',
    cosClient: {
      bucket: 'fixture-bucket-1250000000', region: 'ap-singapore',
      async ensureInitialized() {}, async resolveCredential() { return credential; },
      buildCosKey(name, key) { return `1250000000/fixture-project/${name}/${key}`; },
    },
    async get(key, options = {}) { const value = objects.get(key); return value === undefined ? null : options.type === 'json' ? JSON.parse(value) : value; },
    async list({ prefix = '' } = {}) { return { blobs: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
    // The gateway deliberately ignores onlyIfNew, reproducing Blob 0.0.18.
    async set(key, value) { ordinaryWrites++; objects.set(key, value); },
    async setJSON(key, value) { ordinaryWrites++; objects.set(key, JSON.stringify(value)); },
  });
  const nativeFetch = async (url, options) => {
    const target = new URL(url), headers = new Headers(options.headers);
    assert.equal(target.host, 'fixture-bucket-1250000000.cos.ap-singapore.myqcloud.com');
    assert.equal(options.method, 'PUT');
    assert.equal(headers.get('x-cos-forbid-overwrite'), 'true');
    assert.equal(headers.get('x-cos-security-token'), credential.sessionToken);
    assert.match(headers.get('authorization'), /q-header-list=[^&]*x-cos-forbid-overwrite/);
    const fullKey = decodeURIComponent(target.pathname.slice(1)); assert.ok(fullKey.startsWith(prefix));
    const key = fullKey.slice(prefix.length);
    await beforeWrite?.(key);
    if (enforceCondition && objects.has(key)) return new Response('<Error><Code>FileAlreadyExists</Code></Error>', { status: 409 });
    objects.set(key, options.body);
    return new Response('', { status: 200 });
  };
  const store = () => withAtomicWrites(sdk(), { fetch: nativeFetch });
  const api = () => createApi({ database: new RecipeDatabase(store()), password });
  const call = (handler, path, method = 'GET', data, cookie) => handler(new Request(`https://recipes.test/api/${path}`, {
    method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: 'https://recipes.test' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }));
  return { objects, store, api, call, ordinaryWrites: () => ordinaryWrites };
}
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];

test('direct COS signing matches the actual pinned Blob SDK using temporary credentials and UTF-8 keys', async t => {
  const now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  let gatewayRequest;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://blob-sts.edgeone.site/') return Response.json({
      tmpSecretId: credential.secretId, tmpSecretKey: credential.secretKey,
      sessionToken: credential.sessionToken, expiredTime: now / 1000 + 3600,
      appId: '1250000000', projectId: 'fixture-project', resourcePrefix: '1250000000/fixture-project/*',
      cosOverseas: { bucket: 'fixture-bucket-1250000000', region: 'ap-singapore' },
    });
    gatewayRequest = { url, options };
    return new Response('', { status: 200 });
  });
  const sdk = getStore({ name: 'fengwei-recipes', projectId: 'fixture-project', token: 'fixture-api-token', consistency: 'strong' });
  const key = 'private/测试(厨房)/claim.json', value = { marker: 'protected' }, options = { onlyIfNew: true, cacheControl: 'no-store' };
  await sdk.setJSON(key, value, options);
  let directRequest;
  const atomic = withAtomicWrites(sdk, { fetch: async (url, request) => {
    directRequest = { url, request };
    return new Response('', { status: 200 });
  } });
  await atomic.setJSON(key, value, options);
  assert.equal(new URL(directRequest.url).hostname, 'fixture-bucket-1250000000.cos.ap-singapore.myqcloud.com');
  assert.equal(new Headers(directRequest.request.headers).get('authorization'), new Headers(gatewayRequest.options.headers).get('authorization'));
  assert.equal(new Headers(directRequest.request.headers).get('x-cos-security-token'), credential.sessionToken);
  assert.equal(directRequest.request.body, gatewayRequest.options.body);
  assert.equal(new URL(directRequest.url).pathname, new URL(gatewayRequest.url).pathname);
});

test('conditional writes bypass the overwrite-prone gateway, preserve existing records, and keep normal Blob writes', async () => {
  const f = fixture(), store = f.store();
  await store.setJSON('private/claim.json', { id: 'winner' }, { onlyIfNew: true });
  await assert.rejects(store.setJSON('private/claim.json', { id: 'loser' }, { onlyIfNew: true }), { code: 'PRECONDITION_FAILED' });
  assert.deepEqual(await store.get('private/claim.json', { type: 'json' }), { id: 'winner' });
  assert.equal(f.ordinaryWrites(), 0);
  await store.setJSON('recipes/example.json', { title: '菜谱' });
  assert.deepEqual(await store.get('recipes/example.json', { type: 'json' }), { title: '菜谱' });
  assert.equal(f.ordinaryWrites(), 1);
  await assert.rejects(store.setJSON('../escape.json', {}, { onlyIfNew: true }), { code: 'INVALID_KEY' });
});

test('separate cloud handlers permit only one normalized username and keep registration retries and login durable', async () => {
  const f = fixture(), firstApi = f.api(), secondApi = f.api();
  const attempts = [
    { displayName: ' Alice ', password: 'first-fixture-password', registrationId: randomUUID() },
    { displayName: 'ＡＬＩＣＥ', password: 'second-fixture-password', registrationId: randomUUID() },
  ];
  const responses = await Promise.all(attempts.map((data, index) => f.call(index ? secondApi : firstApi, 'register', 'POST', data)));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const winner = responses.findIndex(response => response.status === 201), account = (await responses[winner].json()).user;
  assert.equal(account.role, 'viewer'); assert.equal(account.canEdit, false);
  const restarted = f.api();
  const repeat = await f.call(restarted, 'register', 'POST', attempts[winner]);
  assert.equal(repeat.status, 201); assert.equal((await repeat.json()).user.id, account.id);
  const login = await f.call(restarted, 'login', 'POST', { username: 'aLiCe', password: attempts[winner].password });
  assert.equal(login.status, 200); assert.equal((await login.json()).user.id, account.id);
  assert.equal((await f.call(restarted, 'me', 'GET', undefined, cookieOf(login))).status, 200);
  assert.equal((await f.call(restarted, 'login', 'POST', { username: account.id, password: attempts[1 - winner].password })).status, 401);
});

test('direct conditional storage preserves a single password-change winner across cloud handlers', async () => {
  let writers = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ beforeWrite: async key => { if (key.startsWith('private/password-changes/')) { if (++writers === 2) release(); await gate; } } });
  const firstApi = f.api(), secondApi = f.api();
  const login = await f.call(firstApi, 'login', 'POST', { username: 'wupanfeng', password });
  assert.equal(login.status, 200); const oldCookie = cookieOf(login);
  const passwords = ['first-new-fixture-password', 'second-new-fixture-password'];
  const responses = await Promise.all(passwords.map((newPassword, index) => f.call(index ? secondApi : firstApi, 'account/password', 'POST', {
    currentPassword: password, newPassword, confirmPassword: newPassword, mutationId: randomUUID(),
  }, oldCookie)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const winner = responses.findIndex(response => response.status === 200), restarted = f.api();
  assert.equal((await f.call(restarted, 'login', 'POST', { username: 'wupanfeng', password: passwords[winner] })).status, 200);
  assert.equal((await f.call(restarted, 'login', 'POST', { username: 'wupanfeng', password: passwords[1 - winner] })).status, 401);
  assert.equal((await f.call(restarted, 'me', 'GET', undefined, oldCookie)).status, 401);
});

test('health verifies registration storage without creating an account and rejects a COS provider that still overwrites', async () => {
  const f = fixture(), response = await f.call(f.api(), 'health');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, registration: true });
  assert.equal([...f.objects.keys()].filter(key => key.startsWith('private/users/')).length, 0);
  const unsafe = fixture({ enforceCondition: false });
  const unsafeHealth = await unsafe.call(unsafe.api(), 'health');
  assert.equal(unsafeHealth.status, 503);
  assert.deepEqual(await unsafeHealth.json(), { ok: false, registration: false, code: 'UNIQUE_STORAGE_UNAVAILABLE' });
  const denied = await unsafe.call(unsafe.api(), 'register', 'POST', { displayName: 'unsafe-fixture', password, registrationId: randomUUID() });
  assert.equal(denied.status, 503); assert.equal((await denied.json()).code, 'UNIQUE_STORAGE_UNAVAILABLE');
  assert.equal([...unsafe.objects.keys()].filter(key => key.startsWith('private/registrations/')).length, 0);
});

test('failed native writes never fall back to unsafe gateway writes or expose temporary credentials', async () => {
  const f = fixture();
  const sdk = { get: async () => null, list: async () => ({ blobs: [] }), set: async () => { throw new Error('unsafe fallback'); }, setJSON: async () => { throw new Error('unsafe fallback'); } };
  await assert.rejects(withAtomicWrites(sdk).setJSON('private/claim.json', {}, { onlyIfNew: true }), { code: 'ATOMIC_STORAGE_UNAVAILABLE' });
  const base = f.store();
  assert.equal(await base.get('private/claim.json'), null);
  // Unexpected 409 errors must not be mistaken for a successful reservation.
  const fakeSdk = {
    ...sdk, storeName: 'fengwei-recipes', cosClient: {
      bucket: 'fixture-bucket-1250000000', region: 'ap-singapore', async ensureInitialized() {},
      async resolveCredential() { return credential; }, buildCosKey(name, key) { return `${name}/${key}`; },
    },
  };
  const failed = withAtomicWrites(fakeSdk, { fetch: async () => new Response(`<Error><Code>OtherConflict</Code><Message>${credential.secretKey}</Message></Error>`, { status: 409 }) });
  await assert.rejects(failed.setJSON('private/claim.json', {}, { onlyIfNew: true }), error => {
    assert.equal(error.code, 'ATOMIC_STORAGE_HTTP_409'); assert.ok(!error.message.includes(credential.secretKey)); return true;
  });
});
