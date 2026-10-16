import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { FileStore } from '../server/file-store.mjs';
import { RecipeDatabase, hash } from '../server/database.mjs';
import { createApi } from '../server/api.mjs';
import { prepareFullBackup, sealBackup, openBackupPart, base64 } from '../dist/full-backup.js';
import { FullBackup, sha256 } from '../server/full-backup.mjs';
import { readFullBackup, restoreFullBackup } from '../server/full-restore.mjs';
import { AuditRetention, auditCutoff } from '../server/audit-retention.mjs';
import { AuditLog } from '../server/audit.mjs';
import { indexAudit, AUDIT_PREFIX, auditCursor } from '../server/audit-index.mjs';

const password = 'fixture-login-password', phrase = 'fixture-backup-encryption-password';
const recipe = (id, photo = '') => ({ id, title: '迁移菜谱', category: '家常菜', description: '', minutes: 15, servings: 2, favorite: false, photo, notes: '', ingredients: [], steps: ['煮熟'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fengwei-full-backup-')); t.after(() => rm(dir, { force: true, recursive: true }));
  const store = new FileStore(join(dir, 'source')), db = new RecipeDatabase(store), api = createApi({ database: db, password });
  const call = (path, data, cookie, method = 'POST') => api(new Request(`https://recipes.test/api/${path}`, { method, headers: { Origin: 'https://recipes.test', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(data || {}) }) }));
  const response = await call('login', { username: 'wupanfeng', password }), cookie = response.headers.get('set-cookie').split(';')[0], user = (await response.json()).user;
  const client = { user, async fullBackupRequest(action, value) { const result = await call(`admin/backup/${action}`, { ...value, expectedUserId: this.user.id }, cookie); const data = await result.json(); if (!result.ok) throw Object.assign(new Error(data.error), data); return data; } };
  return { dir, store, db, api, call, cookie, user, client, target: () => new FileStore(join(dir, randomUUID())) };
}
test('full migration preserves current passwords, permissions, all recipe versions, photos and every user favorite; expired logs and sessions are absent', async t => {
  const f = await fixture(t);
  const registered = await f.call('register', { displayName: '迁移成员', password, registrationId: randomUUID() });
  const viewerCookie = registered.headers.get('set-cookie').split(';')[0], viewer = (await registered.json()).user;
  const requestId = randomUUID();
  assert.equal((await f.call('permissions/request', { requestId, reason: '需要维护全部菜谱' }, viewerCookie)).status, 201);
  assert.equal((await f.call('permissions/decision', { requestId, userId: viewer.id, action: 'approve', mutationId: randomUUID() }, f.cookie)).status, 200);
  const newPassword = 'fixture-new-current-password';
  assert.equal((await f.call('account/password', { currentPassword: password, newPassword, confirmPassword: newPassword, mutationId: randomUUID() }, viewerCookie)).status, 200);
  const viewerLogin = await f.call('login', { username: viewer.id, password: newPassword });
  const changedCookie = viewerLogin.headers.get('set-cookie').split(';')[0];
  const photo = 'data:image/png;base64,' + (await readFile(new URL('../dist/icons/icon-192.png', import.meta.url))).toString('base64');
  let event = await f.db.commit({ id: 'shared', recipe: recipe('shared', photo), baseRevision: null, mutationId: randomUUID() });
  for (let i = 0; i < 12; i++) event = await f.db.commit({ id: 'shared', recipe: { ...recipe('shared', photo), notes: `历史 ${i}` }, baseRevision: event.revision, mutationId: randomUUID() });
  assert.equal((await f.call('favorite/shared', { favorite: true, mutationId: randomUUID() }, changedCookie, 'PUT')).status, 200);
  const doomedResponse = await f.call('register', { displayName: '迁移已删除账号', password, registrationId: randomUUID() });
  const doomed = (await doomedResponse.json()).user;
  assert.equal((await f.call('accounts/delete', { accounts: [{ id: doomed.id, displayName: doomed.displayName }], mutationId: randomUUID() }, f.cookie)).status, 200);
  const replacementResponse = await f.call('register', { displayName: doomed.displayName, password, registrationId: randomUUID() });
  const replacement = (await replacementResponse.json()).user;
  const old = { id: hash('expired'), createdAt: new Date(Date.now() - 8 * 86400000).toISOString(), userId: viewer.id, displayName: '过期用户行为', action: 'recipe.view', result: 'success', target: '旧日志' };
  await f.store.setJSON(`private/audit/${old.id}.json`, old);
  const sealed = await prepareFullBackup(f.client, phrase), texts = await Promise.all(sealed.files.map(part => part.file.text()));
  assert.ok(texts.every(text => !text.includes('passwordHash') && !text.includes('迁移成员')));
  const archive = await readFullBackup(texts, phrase);
  assert.equal([...archive.values.keys()].filter(key => key.startsWith('recipes/')).length, 13);
  assert.equal([...archive.values.keys()].filter(key => key.startsWith('photos/')).length, 1);
  assert.ok(![...archive.values.keys()].some(key => key.startsWith('private/auth/') || key.includes(old.id)));
  const target = f.target(); await restoreFullBackup(target, archive);
  const migratedApi = createApi({ database: new RecipeDatabase(target), password });
  const invoke = (path, data, cookie, method = 'POST') => migratedApi(new Request(`https://recipes.test/api/${path}`, { method, headers: { Origin: 'https://recipes.test', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(data) }) }));
  assert.equal((await invoke('me', null, changedCookie, 'GET')).status, 401);
  assert.equal((await invoke('login', { username: viewer.id, password })).status, 401);
  assert.equal((await invoke('login', { username: doomed.id, password })).status, 401);
  assert.equal((await invoke('login', { username: doomed.displayName, password })).status, 200);
  assert.notEqual(replacement.id, doomed.id);
  const restoredLogin = await invoke('login', { username: viewer.id, password: newPassword });
  const restoredCookie = restoredLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await restoredLogin.json()).user.role, 'editor');
  const listing = await (await invoke('recipes', null, restoredCookie, 'GET')).json(); assert.equal(listing.items[0].recipe.favorite, true);
  assert.equal(await new RecipeDatabase(target).photo(event.photoHash), photo);
  assert.equal((await target.list({ prefix: 'recipes/' })).blobs.length, 13);
  const administrator = await invoke('login', { username: 'wupanfeng', password });
  const adminCookie = administrator.headers.get('set-cookie').split(';')[0];
  const logs = await (await invoke('audit', null, adminCookie, 'GET')).json(); assert.ok(logs.items.length > 0); assert.ok(logs.items.every(item => item.createdAt >= auditCutoff()));
  await assert.rejects(() => restoreFullBackup(target, archive), /其他数据|修改/);
});
test('full backup API rejects viewers, account switches, path traversal, secrets and missing records', async t => {
  const f = await fixture(t), response = await f.call('register', { displayName: '普通备份用户', password, registrationId: randomUUID() });
  const cookie = response.headers.get('set-cookie').split(';')[0], viewer = (await response.json()).user;
  assert.equal((await f.call('admin/backup/start', { expectedUserId: viewer.id }, cookie)).status, 403);
  assert.equal((await f.call('admin/backup/start', { expectedUserId: viewer.id }, f.cookie)).status, 409);
  for (const key of ['private/auth/a/key.json', 'private/account-database-binding.json', 'private/users/../../auth/key.json']) assert.equal((await f.call('admin/backup/read', { expectedUserId: f.user.id, snapshotAt: new Date().toISOString(), key }, f.cookie)).status, 409);
  await assert.rejects(() => new FullBackup(f.store).chunk('private/users/missing.json', new Date().toISOString()), { code: 'BACKUP_CHANGED' });
});
test('snapshot validation detects concurrent mutations and logout, without creating a partial encrypted backup', async t => {
  const f = await fixture(t); await f.db.commit({ id: 'one', recipe: recipe('one'), baseRevision: null, mutationId: randomUUID() });
  const send = f.client.fullBackupRequest.bind(f.client); let changed = false;
  f.client.fullBackupRequest = async (action, value) => {
    if (action === 'verify' && !changed) { changed = true; await f.store.setJSON(f.user.id ? `private/users/${f.user.id}.json` : '', { changed: true }); }
    return send(action, value);
  };
  await assert.rejects(() => prepareFullBackup(f.client, phrase));
  const another = await fixture(t), original = another.client.fullBackupRequest.bind(another.client);
  another.client.fullBackupRequest = async (action, value) => { const result = await original(action, value); if (action === 'catalog') another.client.user = null; return result; };
  await assert.rejects(() => prepareFullBackup(another.client, phrase), /账号已切换/);
});
test('encrypted multipart archives reject wrong passwords, tampering, missing/duplicate/mixed parts and inconsistent manifests', async t => {
  const f = await fixture(t), generated = await prepareFullBackup(f.client, phrase);
  const original = await readFullBackup(await Promise.all(generated.files.map(part => part.file.text())), phrase);
  const records = [...original.values].map(([key, bytes]) => ({ key, data: base64(bytes), sha256: sha256(bytes), bytes: bytes.length }));
  const parts = await sealBackup(records, { ...original.manifest, backupId: randomUUID() }, phrase, { partBytes: 2500 });
  assert.ok(parts.files.length > 1); const texts = await Promise.all(parts.files.map(part => part.file.text()));
  assert.equal((await readFullBackup(texts, phrase)).manifest.recordCount, records.length);
  await assert.rejects(() => readFullBackup(texts.slice(1), phrase), /分卷/);
  await assert.rejects(() => readFullBackup([...texts, texts[0]], phrase), /分卷/);
  await assert.rejects(() => openBackupPart(texts[0], 'wrong-password-long'), /口令不正确/);
  const envelope = JSON.parse(texts[0]); envelope.part = envelope.parts;
  await assert.rejects(() => openBackupPart(JSON.stringify(envelope), phrase), /口令不正确/);
  envelope.part = 1; envelope.data = (envelope.data[0] === 'A' ? 'B' : 'A') + envelope.data.slice(1);
  await assert.rejects(() => openBackupPart(JSON.stringify(envelope), phrase), /口令不正确/);
});
test('restore refuses occupied targets and can resume a failed write with the same verified backup', async t => {
  const f = await fixture(t), result = await prepareFullBackup(f.client, phrase), archive = await readFullBackup(await Promise.all(result.files.map(part => part.file.text())), phrase);
  const occupied = f.target(); await occupied.setJSON('private/users/existing.json', { saved: true });
  await assert.rejects(() => restoreFullBackup(occupied, archive), /不是空站点/);
  assert.deepEqual(await occupied.get('private/users/existing.json', { type: 'json' }), { saved: true });
  const target = f.target(), original = target.setJSON.bind(target); let writes = 0;
  target.setJSON = async (...args) => { if (++writes === 3) throw new Error('simulated outage'); return original(...args); };
  await assert.rejects(() => restoreFullBackup(target, archive), /simulated/);
  const blockedApi = createApi({ database: new RecipeDatabase(target), password });
  assert.equal((await blockedApi(new Request('https://recipes.test/api/health'))).status, 503);
  target.setJSON = original; await restoreFullBackup(target, archive);
  assert.equal((await target.get('private/full-restore.json', { type: 'json' })).complete, true);
});
test('seven-day cleanup physically deletes standalone logs and receipts, preserves business data, and will not reindex old receipts', async t => {
  const f = await fixture(t), now = Date.now(), cutoff = auditCutoff(now);
  const old = { id: hash('old'), createdAt: new Date(now - 7 * 86400000 - 1).toISOString(), action: 'recipe.view', displayName: '过去', result: 'success' };
  const boundary = { ...old, id: hash('boundary'), createdAt: cutoff };
  const recent = { ...old, id: hash('recent'), createdAt: new Date(now - 1000).toISOString() };
  for (const entry of [old, boundary, recent]) {
    for (const prefix of ['private/audit/', 'private/audit-canonical/', 'private/audit-pending/']) await f.store.setJSON(`${prefix}${entry.id}.json`, entry);
    await f.store.setJSON(`${AUDIT_PREFIX}${auditCursor(entry)}.json`, { ...entry, searchText: entry.displayName });
  }
  const revision = `recipes/${hash('history')}/000000000001-1234567890123-${randomUUID()}.json`;
  await f.store.setJSON(revision, { retained: '菜谱历史仍保留', auditEntry: old });
  const retention = new AuditRetention(f.store); let progress;
  do { progress = await retention.run({ maxRecords: 3, budgetMs: 5000, now }); } while (!progress.complete);
  const keys = (await f.store.list()).blobs.map(item => item.key);
  assert.ok(keys.every(key => !key.includes(old.id)));
  assert.ok(keys.some(key => key.includes(boundary.id))); assert.ok(keys.some(key => key.includes(recent.id)));
  assert.deepEqual(await f.store.get(revision, { type: 'json' }), { retained: '菜谱历史仍保留' });
  await indexAudit(f.store, old); assert.equal(await f.store.get(`private/audit-canonical/${old.id}.json`), null);
  assert.ok((await new AuditLog(f.store).list()).items.every(item => item.createdAt >= auditCutoff()));
});


test('binary photo backup uses bounded transport chunks and encrypted large files remain readable', async t => {
  const f = await fixture(t), bytes = randomBytes(1400000), key = `photos/${hash('large-fixture-photo')}.bin`;
  await f.store.set(key, bytes); const backup = new FullBackup(f.store), at = new Date().toISOString();
  let offset = 0, blocks = [], calls = 0;
  do { const part = await backup.chunk(key, at, offset); assert.ok(part.data.length < 360000); blocks.push(Buffer.from(part.data, 'base64')); offset = part.next; calls++; } while (offset !== null);
  assert.ok(calls > 1); assert.equal(sha256(Buffer.concat(blocks)), sha256(bytes));
  const result = await prepareFullBackup(f.client, phrase);
  const archive = await readFullBackup(await Promise.all(result.files.map(part => part.file.text())), phrase);
  assert.equal(sha256(archive.values.get(key)), sha256(bytes));
});
