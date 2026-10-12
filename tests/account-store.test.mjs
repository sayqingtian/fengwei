import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createAccountStore } from '../server/account-store.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { createApi } from '../server/api.mjs';

const pg = new PGlite();
await pg.exec('create role anon; create role authenticated; create role service_role bypassrls;');
const schema = await readFile(new URL('../scripts/setup-supabase.sql', import.meta.url), 'utf8');
await pg.exec(schema);
after(() => pg.close());
const fixturePassword = 'account-database-fixture-password';
const secretKey = 'sb_secret_fixture_key_only';

function blobStore() {
  const records = new Map();
  let atomic = false;
  return {
    records, atomic(value) { atomic = value; },
    async get(key, options = {}) { const value = records.get(key); return value === undefined ? null : options.type === 'json' ? JSON.parse(value) : value; },
    async list({ prefix = '' } = {}) { return { blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
    async set(key, value, options = {}) {
      if (atomic && options.onlyIfNew && records.has(key)) throw Object.assign(new Error('Exists'), { code: 'PRECONDITION_FAILED' });
      records.set(key, value);
    },
    setJSON(key, value, options) { return this.set(key, JSON.stringify(value), options); },
  };
}
function fixture() {
  const source = blobStore(), namespace = `fixture-${randomUUID()}`, requests = [];
  const send = async (url, options) => {
    const target = new URL(url), headers = new Headers(options.headers);
    assert.equal(target.origin, 'https://fixture.supabase.co');
    assert.equal(target.pathname, '/rest/v1/fengwei_account_records');
    assert.ok(headers.get('apikey'));
    requests.push({ method: options.method, url: target, headers });
    if (options.method === 'POST') {
      assert.equal(target.searchParams.get('on_conflict'), 'namespace,key');
      assert.ok(headers.get('prefer').includes('return=representation'));
      const row = JSON.parse(options.body), ignore = headers.get('prefer').includes('ignore-duplicates');
      const result = await pg.query(`insert into fengwei_account_records (namespace, key, value) values ($1, $2, $3::jsonb) on conflict (namespace, key) ${ignore ? 'do nothing' : 'do update set value = excluded.value'} returning namespace, key, value`, [row.namespace, row.key, JSON.stringify(row.value)]);
      return Response.json(result.rows, { status: 201 });
    }
    assert.equal(options.method, 'GET');
    const args = [target.searchParams.get('namespace').slice(3)], conditions = ['namespace = $1'];
    for (const filter of target.searchParams.getAll('key')) {
      const operator = filter.slice(0, filter.indexOf('.')), value = filter.slice(filter.indexOf('.') + 1);
      const symbols = { eq: '=', gte: '>=', lt: '<' }; assert.ok(symbols[operator]);
      args.push(value); conditions.push(`key ${symbols[operator]} $${args.length}`);
    }
    args.push(Number(target.searchParams.get('limit') || 1000), Number(target.searchParams.get('offset') || 0));
    const result = await pg.query(`select namespace, key, value from fengwei_account_records where ${conditions.join(' and ')} order by key limit $${args.length - 1} offset $${args.length}`, args);
    return Response.json(result.rows);
  };
  const settings = { url: 'https://fixture.supabase.co', secretKey, namespace, fetch: send };
  const store = extra => createAccountStore(source, { ...settings, ...extra });
  const api = customStore => createApi({ database: new RecipeDatabase(customStore || store()), password: fixturePassword });
  const call = (handler, path, method = 'GET', data, cookie) => handler(new Request(`https://recipes.test/api/${path}`, {
    method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: 'https://recipes.test' } : {}), 'X-Real-IP': namespace, ...(cookie ? { Cookie: cookie } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  }));
  return { source, namespace, requests, settings, store, api, call };
}
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];

test('password recovery uses the existing PostgreSQL table and concurrent admin decisions cannot overwrite credentials', async () => {
  const f = fixture(), first = f.api(), second = f.api();
  const admin = await f.call(first, 'login', 'POST', { username: 'wupanfeng', password: fixturePassword });
  const adminCookie = cookieOf(admin);
  const registered = await f.call(first, 'register', 'POST', { displayName: 'SQL密码找回', password: fixturePassword, registrationId: randomUUID() });
  const oldCookie = cookieOf(registered), user = (await registered.json()).user, requestId = randomUUID();
  assert.equal((await f.call(first, 'account/recovery', 'POST', { username: user.id, contact: '测试线下渠道', requestId })).status, 200);
  const data = await (await f.call(second, 'admin/password-recovery', 'GET', undefined, adminCookie)).json();
  assert.equal(data.requests[0].userId, user.id); assert.equal(data.requests[0].status, 'pending');
  const passwords = ['sql-recovery-first-password', 'sql-recovery-second-password'];
  const responses = await Promise.all([first, second].map((api, i) => f.call(api, 'admin/password-recovery/decision', 'POST', { userId: user.id, requestId, action: 'reset', identityVerified: true, newPassword: passwords[i], confirmPassword: passwords[i], mutationId: randomUUID() }, adminCookie)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const winner = responses.findIndex(response => response.status === 200);
  const restarted = f.api();
  assert.equal((await f.call(restarted, 'login', 'POST', { username: user.id, password: passwords[winner] })).status, 200);
  assert.equal((await f.call(restarted, 'login', 'POST', { username: user.id, password: fixturePassword })).status, 401);
  assert.equal((await f.call(restarted, 'me', 'GET', undefined, oldCookie)).status, 401);
  assert.ok([...f.source.records.keys()].every(key => !key.startsWith('private/password-recovery-')));
  const { rows } = await pg.query('select key, value from fengwei_account_records where namespace=$1 and key like $2', [f.namespace, 'private/password-recovery-%']);
  assert.equal(rows.length, 3); assert.ok(!JSON.stringify(rows).includes(passwords[winner]));
});

test('PostgreSQL primary keys select one reservation winner while Blob stores recipes unchanged', async () => {
  const f = fixture(), first = f.store(), second = f.store(), key = 'private/usernames/claim.json';
  const writes = await Promise.allSettled([first.setJSON(key, { id: 'first' }, { onlyIfNew: true }), second.setJSON(key, { id: 'second' }, { onlyIfNew: true })]);
  assert.equal(writes.filter(write => write.status === 'fulfilled').length, 1);
  assert.equal(writes.find(write => write.status === 'rejected').reason.code, 'PRECONDITION_FAILED');
  const { rows } = await pg.query('select value from fengwei_account_records where namespace=$1 and key=$2', [f.namespace, key]);
  assert.equal(rows.length, 1); assert.deepEqual(await first.get(key, { type: 'json' }), rows[0].value);
  assert.equal(f.source.records.has(key), false);
  await first.setJSON('recipes/example.json', { title: '保留菜谱', nested: { z: 1, a: 2 } });
  assert.deepEqual(await first.get('recipes/example.json', { type: 'json' }), { title: '保留菜谱', nested: { z: 1, a: 2 } });
  await first.setJSON('private/users/json-order.json', { z: 1, a: 2, nested: { z: '末尾', a: '开头' } });
  assert.deepEqual(await first.get('private/users/json-order.json', { type: 'json' }), { z: 1, a: 2, nested: { z: '末尾', a: '开头' } });
  for (const request of f.requests) { assert.equal(request.headers.get('apikey'), secretKey); assert.equal(request.headers.has('authorization'), false); }
});

test('registration stays unique across cloud handlers, preserves retries, and produces durable viewer sessions', async () => {
  const f = fixture(), handlers = [f.api(), f.api()];
  const attempts = [
    { displayName: ' Alice ', password: 'first-database-password', registrationId: randomUUID(), role: 'admin' },
    { displayName: 'ＡＬＩＣＥ', password: 'second-database-password', registrationId: randomUUID(), canEdit: true },
  ];
  const responses = await Promise.all(attempts.map((data, index) => f.call(handlers[index], 'register', 'POST', data)));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const winner = responses.findIndex(response => response.status === 201), profile = await responses[winner].json();
  assert.equal(profile.user.role, 'viewer'); assert.equal(profile.user.canEdit, false);
  assert.ok(!JSON.stringify(profile).includes('passwordHash')); assert.ok(!JSON.stringify(profile).includes('salt'));
  const restarted = f.api();
  const retry = await f.call(restarted, 'register', 'POST', attempts[winner]);
  assert.equal(retry.status, 201); assert.equal((await retry.json()).user.id, profile.user.id);
  const login = await f.call(restarted, 'login', 'POST', { username: 'alice', password: attempts[winner].password });
  assert.equal(login.status, 200); assert.equal((await login.json()).user.id, profile.user.id);
  assert.equal((await f.call(restarted, 'me', 'GET', undefined, cookieOf(login))).status, 200);
  assert.equal((await f.call(restarted, 'login', 'POST', { username: profile.user.id, password: attempts[1 - winner].password })).status, 401);
  const health = await f.call(restarted, 'health'); assert.equal(health.status, 200);
});

test('SQL password changes keep one winner, revoke old cookies, and survive handler restarts', async () => {
  const f = fixture(), first = f.api(), second = f.api();
  const login = await f.call(first, 'login', 'POST', { username: 'wupanfeng', password: fixturePassword });
  assert.equal(login.status, 200); const oldCookie = cookieOf(login);
  const passwords = ['first-updated-sql-password', 'second-updated-sql-password'];
  const responses = await Promise.all(passwords.map((newPassword, index) => f.call(index ? second : first, 'account/password', 'POST', {
    currentPassword: fixturePassword, newPassword, confirmPassword: newPassword, mutationId: randomUUID(),
  }, oldCookie)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const winner = responses.findIndex(response => response.status === 200), restarted = f.api();
  assert.equal((await f.call(restarted, 'login', 'POST', { username: 'wupanfeng', password: passwords[winner] })).status, 200);
  assert.equal((await f.call(restarted, 'login', 'POST', { username: 'wupanfeng', password: passwords[1 - winner] })).status, 401);
  assert.equal((await f.call(restarted, 'me', 'GET', undefined, oldCookie)).status, 401);
  const result = await pg.query("select count(*)::integer as count from fengwei_account_records where namespace=$1 and key like 'private/password-changes/%'", [f.namespace]);
  assert.equal(result.rows[0].count, 1);
});

test('legacy Blob credentials, password versions, username claims and shared recipes migrate without overwrites', async () => {
  const f = fixture(); f.source.atomic(true);
  const legacy = f.api(f.source);
  const owner = await f.call(legacy, 'login', 'POST', { username: 'wupanfeng', password: fixturePassword });
  const oldCookie = cookieOf(owner), registrationId = randomUUID();
  const oldUser = await f.call(legacy, 'register', 'POST', { displayName: '旧用户', password: fixturePassword, registrationId });
  assert.equal(oldUser.status, 201); const oldProfile = (await oldUser.json()).user;
  const password = 'migrated-account-current-password';
  const changed = await f.call(legacy, 'account/password', 'POST', { currentPassword: fixturePassword, newPassword: password, confirmPassword: password, mutationId: randomUUID() }, cookieOf(oldUser));
  assert.equal(changed.status, 200);
  await f.source.setJSON('recipes/legacy.json', { title: '原有共享菜谱', photoHash: 'existing-photo' });
  // Recover the old account from its registration and name reservation even
  // if the original final users write was interrupted.
  f.source.records.delete(`private/users/${oldProfile.id}.json`);
  f.source.atomic(false);
  const migrated = f.api();
  const login = await f.call(migrated, 'login', 'POST', { username: '旧用户', password });
  assert.equal(login.status, 200); assert.equal((await login.json()).user.id, oldProfile.id);
  assert.equal((await f.call(migrated, 'login', 'POST', { username: '旧用户', password: fixturePassword })).status, 401);
  assert.equal((await f.call(migrated, 'me', 'GET', undefined, oldCookie)).status, 200);
  const duplicate = await f.call(migrated, 'register', 'POST', { displayName: '旧用户', password, registrationId: randomUUID() });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'USERNAME_TAKEN');
  const store = f.store();
  await assert.rejects(store.setJSON(`private/registrations/${oldProfile.id}.json`, { id: 'overwrite' }, { onlyIfNew: true }), { code: 'PRECONDITION_FAILED' });
  assert.equal((await store.get(`private/registrations/${oldProfile.id}.json`, { type: 'json' })).id, oldProfile.id);
  assert.deepEqual(await store.get('recipes/legacy.json', { type: 'json' }), { title: '原有共享菜谱', photoHash: 'existing-photo' });
});

test('missing setup allows original login but blocks signup; after migration missing or changed database config cannot revive old credentials', async () => {
  const f = fixture(), missing = f.api(createAccountStore(f.source));
  const login = await f.call(missing, 'login', 'POST', { username: 'wupanfeng', password: fixturePassword }); assert.equal(login.status, 200);
  const blocked = await f.call(missing, 'register', 'POST', { displayName: '未配置', password: fixturePassword, registrationId: randomUUID() });
  assert.equal(blocked.status, 503); assert.equal((await blocked.json()).code, 'ACCOUNT_DATABASE_NOT_CONFIGURED');
  const sqlApi = f.api(); assert.equal((await f.call(sqlApi, 'health')).status, 200);
  const unavailable = f.api(createAccountStore(f.source));
  const refused = await f.call(unavailable, 'login', 'POST', { username: 'wupanfeng', password: fixturePassword });
  assert.equal(refused.status, 503); assert.equal((await refused.json()).code, 'ACCOUNT_DATABASE_NOT_CONFIGURED');
  await assert.rejects(f.store({ namespace: 'wrong-project' }).get('private/users/example.json'), { code: 'ACCOUNT_DATABASE_CHANGED' });
  assert.throws(() => f.store({ url: 'http://unsafe.example' }), { code: 'ACCOUNT_DATABASE_INVALID_CONFIG' });
});

test('table permissions and RLS deny browser roles and setup can be rerun without losing records', async () => {
  const f = fixture(); await f.store().setJSON('private/users/schema-check.json', { id: 'preserved' });
  await pg.exec(schema);
  assert.deepEqual(await f.store().get('private/users/schema-check.json', { type: 'json' }), { id: 'preserved' });
  for (const role of ['anon', 'authenticated']) {
    await pg.exec(`set role ${role}`);
    try { await assert.rejects(pg.query('select * from fengwei_account_records'), { code: '42501' }); }
    finally { await pg.exec('reset role'); }
  }
});

test('listing paginates SQL rows, isolates namespaces, treats underscores literally and merges existing Blob keys', async () => {
  const f = fixture(), store = f.store();
  await pg.query("insert into fengwei_account_records(namespace,key,value) select $1,'private/users/usr_'||lpad(n::text,5,'0'),jsonb_build_object('id',n) from generate_series(0,1004) as n", [f.namespace]);
  await f.source.setJSON('private/users/legacy-only.json', { id: 'legacy' });
  await f.source.setJSON('private/users/usr_00002', { id: 'stale-source' });
  const list = await store.list({ prefix: 'private/users/' }); assert.equal(list.blobs.length, 1006);
  assert.equal(list.blobs.filter(item => item.key === 'private/users/usr_00002').length, 1);
  assert.deepEqual(await store.get('private/users/usr_00002', { type: 'json' }), { id: 2 });
  assert.ok(f.requests.some(request => request.url.searchParams.get('offset') === '1000'));
  await store.setJSON('private/password-changes/usr_a/initial.json', { version: 'literal' });
  await store.setJSON('private/password-changes/usrXa/initial.json', { version: 'different' });
  assert.deepEqual((await store.list({ prefix: 'private/password-changes/usr_a/' })).blobs, [{ key: 'private/password-changes/usr_a/initial.json' }]);
});

test('legacy JWT keys use Bearer authorization while failures remain closed and never expose secret keys or SQL errors', async () => {
  const f = fixture();
  await f.store({ secretKey: 'eyJ.fixture-service-role' }).setJSON('private/users/jwt-key.json', { id: 'jwt' });
  const request = f.requests.find(entry => entry.method === 'POST'); assert.equal(request.headers.get('authorization'), 'Bearer eyJ.fixture-service-role');
  for (const [status, code] of [[403, 'ACCOUNT_DATABASE_AUTH_FAILED'], [404, 'ACCOUNT_DATABASE_SCHEMA_REQUIRED'], [500, 'ACCOUNT_DATABASE_UNAVAILABLE']]) {
    const failed = f.store({ fetch: async () => Response.json({ error: `private SQL detail ${secretKey}` }, { status }) });
    await assert.rejects(failed.setJSON('private/users/failure.json', {}, { onlyIfNew: true }), error => {
      assert.equal(error.code, code); assert.ok(!error.message.includes(secretKey)); assert.ok(!error.message.includes('SQL')); return true;
    });
  }
  const disconnected = f.store({ fetch: async () => { throw new Error(`private network detail ${secretKey}`); } });
  await assert.rejects(disconnected.get('private/users/failure.json'), { code: 'ACCOUNT_DATABASE_CONNECTION_FAILED' });
  const malformed = f.store({ fetch: async () => Response.json({ value: 'wrong-response' }) });
  await assert.rejects(malformed.setJSON('private/users/failure.json', {}), { code: 'ACCOUNT_DATABASE_UNAVAILABLE' });
  const invisible = f.store({ fetch: async () => Response.json([]) });
  const health = await f.call(f.api(invisible), 'health'); assert.equal(health.status, 503);
  assert.equal((await health.json()).code, 'UNIQUE_STORAGE_UNAVAILABLE');
});
