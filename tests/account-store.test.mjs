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
    async delete(key) { records.delete(key); },
  };
}
function fixture() {
  const source = blobStore(), namespace = `fixture-${randomUUID()}`, requests = [];
  const send = async (url, options) => {
    const target = new URL(url), headers = new Headers(options.headers);
    assert.equal(target.origin, 'https://fixture.supabase.co');
    assert.equal(target.pathname, '/rest/v1/fengwei_account_records');
    assert.ok(headers.get('apikey'));
    requests.push({ method: options.method, url: target, headers, key: options.body ? JSON.parse(options.body).key : undefined });
    if (options.method === 'DELETE') {
      const result = await pg.query('delete from fengwei_account_records where namespace=$1 and key=$2 returning namespace,key,value', [target.searchParams.get('namespace').slice(3), target.searchParams.get('key').slice(3)]);
      return Response.json(result.rows);
    }
    if (options.method === 'PATCH') {
      const value = JSON.parse(options.body).value;
      const result = await pg.query("update fengwei_account_records set value=$1::jsonb where namespace=$2 and key=$3 and value->>'version'=$4 returning namespace,key,value", [JSON.stringify(value), target.searchParams.get('namespace').slice(3), target.searchParams.get('key').slice(3), target.searchParams.get('value->>version').slice(3)]);
      return Response.json(result.rows);
    }
    if (options.method === 'POST') {
      assert.equal(target.searchParams.get('on_conflict'), 'namespace,key');
      assert.ok(headers.get('prefer').includes('return=representation'));
      const row = JSON.parse(options.body), ignore = headers.get('prefer').includes('ignore-duplicates');
      const result = await pg.query(`insert into fengwei_account_records (namespace, key, value) values ($1, $2, $3::jsonb) on conflict (namespace, key) ${ignore ? 'do nothing' : 'do update set value = excluded.value'} returning namespace, key, value`, [row.namespace, row.key, JSON.stringify(row.value)]);
      return Response.json(result.rows, { status: 201 });
    }
    assert.equal(options.method, 'GET');
    const args = [target.searchParams.get('namespace').slice(3)], conditions = ['namespace = $1'];
    const compound = target.searchParams.get('or');
    if (compound) {
      const branches = [];
      for (const match of compound.matchAll(/key\.eq\.([^,()]+)/g)) { args.push(match[1]); branches.push(`key = $${args.length}`); }
      const range = /and\(key\.gte\.([^,()]+),key\.lt\.([^,()]+)\)/.exec(compound);
      assert.ok(range); args.push(range[1], range[2]); branches.push(`(key >= $${args.length - 1} and key < $${args.length})`);
      conditions.push(`(${branches.join(' or ')})`);
    }
    for (const filter of target.searchParams.getAll('key')) {
      const operator = filter.slice(0, filter.indexOf('.')), value = filter.slice(filter.indexOf('.') + 1);
      const symbols = { eq: '=', gte: '>=', lt: '<' }; assert.ok(symbols[operator]);
      args.push(value); conditions.push(`key ${symbols[operator]} $${args.length}`);
    }
    for (const field of ['result', 'searchText']) for (const filter of target.searchParams.getAll(`value->>${field}`)) {
      const operator = filter.slice(0, filter.indexOf('.')), value = filter.slice(filter.indexOf('.') + 1);
      assert.ok(['eq', 'match'].includes(operator)); args.push(value); conditions.push(`value->>'${field}' ${operator === 'eq' ? '=' : '~'} $${args.length}`);
    }
    args.push(Number(target.searchParams.get('limit') || 1000), Number(target.searchParams.get('offset') || 0));
    const result = await pg.query(`select namespace, key, value from fengwei_account_records where ${conditions.join(' and ')} order by key ${target.searchParams.get('order') === 'key.desc' ? 'desc' : 'asc'} limit $${args.length - 1} offset $${args.length}`, args);
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

test('cooking check-ins use the existing SQL table and reserve one record across independent cloud handlers', async () => {
  const f = fixture(), first = f.store(), second = f.store();
  const { CookingCheckins } = await import('../server/checkins.mjs');
  const a = new CookingCheckins(first), b = new CookingCheckins(second), userId = `usr_${'c'.repeat(32)}`;
  const value = { id: randomUUID(), recipeId: 'meal-1', note: '恰好熟了' };
  const result = await Promise.all([a.add(userId, value, '一道菜'), b.add(userId, value, '一道菜')]);
  assert.deepEqual(result[0], result[1]);
  assert.equal((await a.list(userId)).total, 1);
  assert.equal((await b.list(`usr_${'d'.repeat(32)}`)).total, 0);
  assert.ok(![...f.source.records.keys()].some(key => key.startsWith('private/cooking-checkins/')));
  assert.equal((await pg.query('select count(*)::int as count from fengwei_account_records where namespace = $1 and key like $2', [f.namespace, 'private/cooking-checkins/%'])).rows[0].count, 1);
  await Promise.all([a.remove(userId, value.id), b.remove(userId, value.id)]);
  assert.equal((await a.list(userId)).total, 0);
  assert.equal((await pg.query('select count(*)::int as count from fengwei_account_records where namespace = $1 and key like $2', [f.namespace, 'private/cooking-checkins/%'])).rows[0].count, 0);
  const restarted = new CookingCheckins(f.store());
  await assert.rejects(restarted.previous(userId, value), { code: 'CHECKIN_DELETED' });
  assert.equal((await pg.query('select count(*)::int as count from fengwei_account_records where namespace = $1 and key like $2', [f.namespace, 'private/cooking-checkin-deletions/%'])).rows[0].count, 1);
});

test('warm authentication reads one fresh SQL credential snapshot per request and never caches password changes across handlers', async () => {
  const f = fixture(), first = f.api();
  const login = await f.call(first, 'login', 'POST', { username: 'wupanfeng', password: fixturePassword }), cookie = cookieOf(login);
  f.requests.length = 0;
  for (let i = 0; i < 3; i++) assert.equal((await f.call(first, 'me', 'GET', undefined, cookie)).status, 200);
  assert.equal(f.requests.length, 3); assert.ok(f.requests.every(request => request.method === 'GET' && request.url.searchParams.has('or')));
  const changed = await f.call(f.api(), 'account/password', 'POST', { currentPassword: fixturePassword, newPassword: 'fresh-snapshot-new-password', confirmPassword: 'fresh-snapshot-new-password', mutationId: randomUUID() }, cookie);
  assert.equal(changed.status, 200); f.requests.length = 0;
  assert.equal((await f.call(first, 'me', 'GET', undefined, cookie)).status, 401); assert.equal(f.requests.length, 1);
  assert.equal((await f.call(first, 'login', 'POST', { username: 'wupanfeng', password: 'fresh-snapshot-new-password' })).status, 200);
  f.requests.length = 0;
  assert.equal((await f.call(first, 'login', 'POST', { username: `usr_${'e'.repeat(32)}`, password: fixturePassword })).status, 401);
  assert.ok(f.requests.every(request => !/^private\/(users|registrations|account-migrations)\//.test(request.key || '')), 'unknown IDs never create account or migration rows');
});

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

test('SQL login limits reserve attempts before authentication, survive parallel instances and restarts, and ignore forged IP headers with platform context', async () => {
  const f = fixture(), handlers = [f.api(), f.api()];
  const invoke = (handler, i, password = 'wrong-password') => handler(new Request('https://recipes.test/api/login', { method: 'POST', headers: { Origin: 'https://recipes.test', 'Content-Type': 'application/json', 'X-Real-IP': `forged-${i}`, 'CF-Connecting-IP': `also-forged-${i}` }, body: JSON.stringify({ username: 'wupanfeng', password }) }), { clientIp: 'trusted-platform-client' });
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => invoke(handlers[i % 2], i)));
  assert.equal(responses.filter(r => r.status === 401).length, 10);
  assert.equal(responses.filter(r => r.status === 429).length, 10);
  const restarted = await invoke(f.api(), 21, fixturePassword);
  assert.equal(restarted.status, 429); assert.ok(Number(restarted.headers.get('retry-after')) > 0);
  const count = await pg.query("select value->>'count' as count from fengwei_account_records where namespace=$1 and key like 'private/rate-limits/login/%'", [f.namespace]);
  assert.equal(count.rows.length, 1); assert.equal(Number(count.rows[0].count), 10);
  await pg.query("update fengwei_account_records set value=jsonb_set(value, '{expires}', '0') where namespace=$1 and key like 'private/rate-limits/login/%'", [f.namespace]);
  assert.equal((await invoke(f.api(), 22, fixturePassword)).status, 200);
});

test('SQL account deletion revokes existing sessions and recovery, protects admin and reserves a fresh identity on re-registration', async () => {
  const f = fixture(), api = f.api();
  const owner = await f.call(api, 'login', 'POST', { username: 'wupanfeng', password: fixturePassword }), ownerCookie = cookieOf(owner);
  const registered = await f.call(api, 'register', 'POST', { displayName: 'delete-fixture-user', password: fixturePassword, registrationId: randomUUID() });
  const userCookie = cookieOf(registered), user = (await registered.json()).user;
  const data = { accounts: [{ id: user.id, displayName: user.displayName }], mutationId: randomUUID() };
  assert.equal((await f.call(api, 'accounts/delete', 'POST', data, userCookie)).status, 403);
  assert.equal((await f.call(api, 'accounts/delete', 'POST', data, ownerCookie)).status, 200);
  const restarted = f.api();
  assert.equal((await f.call(restarted, 'me', 'GET', undefined, userCookie)).status, 401);
  assert.equal((await f.call(restarted, 'login', 'POST', { username: user.id, password: fixturePassword })).status, 401);
  const again = await f.call(restarted, 'register', 'POST', { displayName: user.displayName, password: fixturePassword, registrationId: randomUUID() });
  assert.equal(again.status, 201); const replacement = (await again.json()).user; assert.notEqual(replacement.id, user.id); assert.equal(replacement.role, 'viewer');
  const rows = (await f.call(restarted, 'permissions', 'GET', undefined, ownerCookie));
  assert.ok(!(await rows.json()).accounts.some(item => item.id === user.id));
  const ownerUser = (await owner.json()).user;
  assert.equal((await f.call(restarted, 'accounts/delete', 'POST', { accounts: [{ id: ownerUser.id, displayName: ownerUser.displayName }], mutationId: randomUUID() }, ownerCookie)).status, 403);
});

test('SQL audit migration resumes in bounded batches, pages without legacy reads, filters literal text and dates, and repairs a failed index write', async () => {
  const { AuditLog } = await import('../server/audit.mjs');
  const f = fixture(), legacy = new AuditLog(f.source);
  for (let i = 0; i < 230; i++) {
    const entry = legacy.entry({ id: 'review', displayName: '测试用户' }, 'recipe.view', { target: i === 100 ? '100%_*.[literal]' : `历史日志 ${i}` });
    entry.createdAt = new Date(Date.UTC(2026, 9, 10 + Math.floor(i / 100), 0, 0, i % 100)).toISOString();
    await f.source.setJSON(`private/audit/${entry.id}.json`, entry);
  }
  const store = f.store(), originalSet = store.setJSON.bind(store); let breakIndex = false;
  store.setJSON = async (key, value, options) => { if (breakIndex && key.startsWith('private/audit-index/')) { breakIndex = false; throw new Error('test transient index failure'); } return originalSet(key, value, options); };
  const api = f.api(store), login = await f.call(api, 'login', 'POST', { username: 'wupanfeng', password: fixturePassword }), cookie = cookieOf(login);
  let page, rounds = 0;
  do { page = await (await f.call(api, 'audit', 'GET', undefined, cookie)).json(); rounds++; } while (page.indexing && rounds < 10);
  assert.ok(rounds >= 3); assert.equal(page.items.length, 50); assert.ok(page.cursor);
  let legacyReads = 0; const sourceGet = f.source.get.bind(f.source);
  f.source.get = (key, options) => { if (key.startsWith('private/audit/') || key.startsWith('recipes/')) legacyReads++; return sourceGet(key, options); };
  f.requests.length = 0;
  const next = await (await f.call(api, `audit?cursor=${encodeURIComponent(page.cursor)}`, 'GET', undefined, cookie)).json();
  assert.equal(next.items.length, 50); assert.equal(legacyReads, 0);
  assert.equal(new Set([...page.items, ...next.items].map(item => item.id)).size, 100);
  const pageQueries = f.requests.filter(item => item.url.searchParams.get('order') === 'key.desc');
  assert.equal(pageQueries.length, 1); assert.equal(pageQueries[0].url.searchParams.get('limit'), '51');
  const filtered = await (await f.call(api, `audit?q=${encodeURIComponent('100%_*.[literal]')}&from=2026-10-11&to=2026-10-11`, 'GET', undefined, cookie)).json();
  assert.equal(filtered.items.length, 1); assert.equal(filtered.items[0].target, '100%_*.[literal]'); assert.equal(filtered.items[0].searchText, undefined);
  const exported = await f.call(api, 'audit/export?format=json&from=2026-10-10&to=2026-10-10', 'GET', undefined, cookie);
  assert.equal(exported.status, 200); assert.equal((await exported.json()).total, 100);
  assert.equal((await f.call(api, 'audit?from=2026-02-31', 'GET', undefined, cookie)).status, 400);
  breakIndex = true;
  assert.equal((await f.call(api, 'activity', 'POST', { action: 'backup.export' }, cookie)).status, 200);
  assert.ok([...f.source.records.keys()].some(key => key.startsWith('private/audit-pending/')));
  const repaired = await (await f.call(api, 'audit?q=' + encodeURIComponent('导出备份'), 'GET', undefined, cookie)).json();
  assert.equal(repaired.items.length, 1); assert.ok(![...f.source.records.keys()].some(key => key.startsWith('private/audit-pending/')));
});

test('migrating an already deleted Blob account never revives its login or old cookie', async () => {
  const f = fixture(); f.source.atomic(true);
  const legacy = f.api(f.source);
  const signup = await f.call(legacy, 'register', 'POST', { displayName: 'legacy-deleted-fixture', password: fixturePassword, registrationId: randomUUID() });
  const cookie = cookieOf(signup), user = (await signup.json()).user;
  await f.source.setJSON(`private/deleted-users/${user.id}.json`, { id: user.id, displayName: user.displayName, deletedAt: new Date().toISOString() });
  f.source.atomic(false);
  const migrated = f.api();
  assert.equal((await f.call(migrated, 'me', 'GET', undefined, cookie)).status, 401);
  assert.equal((await f.call(migrated, 'login', 'POST', { username: user.id, password: fixturePassword })).status, 401);
  assert.equal((await f.store().accountSnapshot(user.id)).get(`private/deleted-users/${user.id}.json`).id, user.id);
});


test('SQL audit retention deletes only expired logs, cleans legacy Blob copies, and preserves account credential revisions', async () => {
  const { AuditRetention } = await import('../server/audit-retention.mjs');
  const f = fixture(), store = f.store(), now = Date.now();
  const old = { id: 'a'.repeat(64), createdAt: new Date(now - 8 * 86400000).toISOString(), action: 'account.password', result: 'success' };
  const recent = { ...old, id: 'b'.repeat(64), createdAt: new Date(now).toISOString() };
  for (const entry of [old, recent]) for (const prefix of ['private/audit-canonical/', 'private/audit-index/', 'private/audit/', 'private/audit-pending/']) {
    const key = `${prefix}${entry.id}.json`; await store.setJSON(key, entry); await f.source.setJSON(key, entry);
  }
  const key = 'private/password-changes/usr_' + 'c'.repeat(32) + '/initial.json';
  const value = { passwordHash: 'protected-password-hash', salt: 'protected-salt', auditEntry: old };
  await store.setJSON(key, value); await f.source.setJSON(key, value);
  const retention = new AuditRetention(store); let progress;
  do { progress = await retention.run({ now, budgetMs: 5000 }); } while (!progress.complete);
  const rows = await pg.query('select key,value from fengwei_account_records where namespace=$1', [f.namespace]);
  assert.ok(rows.rows.every(row => !row.key.includes(old.id)));
  assert.ok([...f.source.records.keys()].every(key => !key.includes(old.id)));
  assert.deepEqual(await store.get(key, { type: 'json' }), { passwordHash: value.passwordHash, salt: value.salt });
  assert.deepEqual(await f.source.get(key, { type: 'json' }), { passwordHash: value.passwordHash, salt: value.salt });
  assert.ok(rows.rows.some(row => row.key.includes(recent.id)));
  await assert.rejects(() => store.delete(key), { code: 'ACCOUNT_DATABASE_UNSUPPORTED_KEY' });
});


test('complete backup moves SQL accounts and Blob data into an independent empty cloud namespace', async () => {
  const { prepareFullBackup } = await import('../dist/full-backup.js');
  const { readFullBackup, restoreFullBackup } = await import('../server/full-restore.mjs');
  const source = fixture(), target = fixture(), api = source.api();
  const response = await source.call(api, 'login', 'POST', { username: 'wupanfeng', password: fixturePassword });
  const cookie = cookieOf(response), user = (await response.json()).user;
  const member = await source.call(api, 'register', 'POST', { displayName: '跨数据库迁移', password: fixturePassword, registrationId: randomUUID() });
  const memberUser = (await member.json()).user;
  const client = { user, async fullBackupRequest(action, data) {
    const response = await source.call(api, `admin/backup/${action}`, 'POST', { ...data, expectedUserId: user.id }, cookie);
    assert.equal(response.status, 200); return response.json();
  } };
  const result = await prepareFullBackup(client, 'cross-cloud-backup-fixture');
  const archive = await readFullBackup(await Promise.all(result.files.map(part => part.file.text())), 'cross-cloud-backup-fixture');
  await restoreFullBackup(target.store(), archive);
  const restored = target.api();
  assert.equal((await target.call(restored, 'login', 'POST', { username: memberUser.id, password: fixturePassword })).status, 200);
  assert.equal((await target.call(restored, 'login', 'POST', { username: 'wupanfeng', password: fixturePassword })).status, 200);
  assert.equal((await target.call(restored, 'me', 'GET', undefined, cookie)).status, 401);
  const binding = await target.source.get('private/account-database-binding.json', { type: 'json' });
  assert.equal(binding.namespace, target.namespace);
  assert.ok(![...target.source.records.keys()].some(key => key.startsWith('private/users/')));
});

test('SQL compare-and-swap coordinates photo leases across independent cloud instances', async () => {
  const f = fixture(), a = f.store(), b = f.store();
  const attempts = await Promise.allSettled([a, b].map((store, i) => store.photoLease({ action: 'acquire', mode: 'write', token: String(i) })));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const winner = String(attempts.findIndex(item => item.status === 'fulfilled'));
  await assert.rejects(b.photoLease({ action: 'acquire', mode: 'read', token: 'reader' }), { code: 'PHOTO_STORAGE_BUSY' });
  await a.photoLease({ action: 'release', mode: 'write', token: winner });
  const readers = await Promise.all([a, b].map((store, i) => store.photoLease({ action: 'acquire', mode: 'read', token: `r${i}` })));
  assert.notEqual(readers[0].generation, readers[1].generation);
  await assert.rejects(a.photoLease({ action: 'acquire', mode: 'write', token: 'collect' }), { code: 'PHOTO_STORAGE_BUSY' });
  await Promise.all([a, b].map((store, i) => store.photoLease({ action: 'release', mode: 'read', token: `r${i}` })));
  assert.ok((await b.photoLease({ action: 'acquire', mode: 'write', token: 'collect' })).writer);
  assert.ok(![...f.source.records.keys()].some(key => key.includes('photo-leases')));
});
