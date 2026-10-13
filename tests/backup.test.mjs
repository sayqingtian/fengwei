import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { makeBackup, makeBackupParts, parseBackup, BACKUP_MAX_BYTES, BACKUP_MAX_RECIPES } from '../dist/store.js';
import { prepareBackup } from '../dist/backup.js';
import { createRemoteStore } from '../dist/sync.js';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';
import { createApi } from '../server/api.mjs';

const recipe = (id = 'one', extra = {}) => ({ id, title: '番茄炒蛋', category: '家常菜', description: '', notes: '小火 🍳\n"盐" 与 \\ 调味', minutes: 15, servings: 2, favorite: true, photo: '', ingredients: [{ name: '鸡蛋', amount: '3 个' }], steps: ['炒熟'], createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z', ...extra });
test('backup partitions count UTF-8 bytes, JSON escapes and separators, preserving every recipe exactly once', () => {
  const original = Array.from({ length: 11 }, (_, i) => recipe(`dish-${i}`, { photo: 'data:image/avif;base64,YWJj' }));
  const maxBytes = 1350, parts = makeBackupParts(original, { maxBytes, maxRecipes: 3 });
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.equal(Buffer.byteLength(part.text), part.bytes);
    assert.ok(part.bytes <= maxBytes);
    assert.ok(part.count > 0 && part.count <= 3);
    assert.equal(parseBackup(part.text).length, part.count);
  }
  assert.deepEqual(parts.flatMap(part => parseBackup(part.text)), original);
  assert.equal(new Set(parts.map(part => JSON.parse(part.text).exportedAt)).size, 1);
});
test('partition byte boundary is inclusive and an oversized single recipe cannot create an unrestorable part', () => {
  const original = [recipe()], exportedAt = '2026-10-13T00:00:00Z';
  const [part] = makeBackupParts(original, { exportedAt });
  assert.equal(makeBackupParts(original, { exportedAt, maxBytes: part.bytes })[0].bytes, part.bytes);
  assert.throws(() => makeBackupParts(original, { exportedAt, maxBytes: part.bytes - 1 }), /超过/);
  assert.throws(() => makeBackupParts([recipe(), recipe()]), /重复编号/);
  assert.deepEqual(parseBackup(makeBackup([])), []);
});
test('10000-recipe import ceiling is shared by export; larger collections split without truncation', () => {
  const original = Array.from({ length: BACKUP_MAX_RECIPES + 1 }, (_, i) => recipe(`dish-${i}`));
  const parts = makeBackupParts(original);
  assert.deepEqual(parts.map(part => part.count), [10000, 1]);
  assert.equal(parts.flatMap(part => parseBackup(part.text)).length, 10001);
  assert.throws(() => makeBackup(original), /分卷/);
  assert.throws(() => parseBackup(JSON.stringify({ format: 'fengwei-recipes', version: 1, recipes: original })), /10000/);
});
test('real 50 MiB limit splits photo-heavy exports and rejects oversize imports before parsing', () => {
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(7900000);
  const original = Array.from({ length: 7 }, (_, i) => recipe(`photo-${i}`, { photo }));
  const parts = makeBackupParts(original);
  assert.equal(parts.length, 2);
  assert.equal(parts.reduce((sum, part) => sum + part.count, 0), original.length);
  for (const part of parts) { assert.ok(part.bytes <= BACKUP_MAX_BYTES); assert.equal(parseBackup(part.text).length, part.count); }
  const empty = makeBackup([]);
  assert.deepEqual(parseBackup(empty + ' '.repeat(BACKUP_MAX_BYTES - Buffer.byteLength(empty))), []);
  assert.throws(() => parseBackup(empty + ' '.repeat(BACKUP_MAX_BYTES - Buffer.byteLength(empty) + 1)), /50 MiB/);
});
test('prepared files carry the synchronized timestamp and remain independently importable', async () => {
  const original = [recipe()], syncedAt = '2026-10-13T05:06:07.000Z';
  const backup = await prepareBackup({ async backupSnapshot() { return { recipes: original, syncedAt, userId: 'owner' }; } });
  assert.equal(backup.userId, 'owner'); assert.equal(backup.syncedAt, syncedAt);
  assert.deepEqual(parseBackup(await backup.files[0].file.text()), original);
  assert.equal(JSON.parse(await backup.files[0].file.text()).exportedAt, syncedAt);
  assert.equal(backup.files[0].downloaded, false);
  await assert.rejects(() => prepareBackup({ async backupSnapshot() { throw new Error('sync failed'); } }), /sync failed/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-backup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const database = new RecipeDatabase(new FileStore(root)), password = 'backup-test-fixture-only';
  const api = createApi({ database, password });
  const response = await api(new Request('https://recipes.test/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'wupanfeng', password }) }));
  let cookie = response.headers.get('set-cookie').split(';')[0], online = true, intercept = async (_, send) => send();
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options = {}) => {
    if (!online) throw new Error('fixture offline');
    const target = new URL(url), path = target.pathname.split('/api/')[1] + target.search;
    return intercept(path, async () => api(new Request(`https://recipes.test/api/${path}`, { ...options, headers: { ...options.headers, Cookie: cookie, Origin: 'https://recipes.test' } })));
  };
  const settings = new Map();
  const client = await createRemoteStore({ async setting(key) { return settings.get(key); }, async setSetting(key, value) { settings.set(key, structuredClone(value)); } });
  const save = async (item, baseRevision = null) => database.commit({ id: item.id, recipe: item, baseRevision, mutationId: randomUUID() });
  await save(recipe()); await client.all();
  return { database, client, save, api, password, settings, intercept(value) { intercept = value; }, online(value) { online = value; }, cookie(value) { cookie = value; } };
}
test('backup refreshes other-device edits and additions, while offline and storage failures cannot export stale cache', async t => {
  const f = await fixture(t);
  const current = await f.database.latest('one');
  await f.save(recipe('one', { notes: '另一台设备的最新内容' }), current.revision);
  await f.save(recipe('new-device-recipe'));
  const snapshot = await f.client.backupSnapshot();
  assert.equal(snapshot.recipes.length, 2);
  assert.equal(snapshot.recipes.find(item => item.id === 'one').notes, '另一台设备的最新内容');
  snapshot.recipes[0].notes = '修改备份副本';
  assert.ok(f.client.current().every(item => item.notes !== '修改备份副本'));
  f.online(false);
  assert.equal((await f.client.all()).length, 2, 'ordinary offline browsing is retained');
  await assert.rejects(() => prepareBackup(f.client), error => error.code === 'NETWORK');
  f.online(true);
  f.intercept(async () => Response.json({ code: 'STORAGE_UNAVAILABLE', error: '存储暂不可用' }, { status: 503 }));
  await assert.rejects(() => prepareBackup(f.client), error => error.code === 'STORAGE_UNAVAILABLE');
  f.intercept(async (_, send) => send());
  assert.equal((await prepareBackup(f.client)).total, 2, 'reconnection can generate a fresh backup even after offline preview');
});
test('backup waits for an older in-flight sync, then performs a new fetch after the export request', async t => {
  const f = await fixture(t);
  let release, reached; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
  let reads = 0;
  f.intercept(async (path, send) => {
    const response = await send();
    if (path === 'recipes' && ++reads === 1) { reached(); await held; }
    return response;
  });
  const old = f.client.all(); await started;
  const current = await f.database.latest('one');
  await f.save(recipe('one', { notes: '点击导出前已保存的新内容' }), current.revision);
  const backup = f.client.backupSnapshot(); release(); await old;
  assert.equal((await backup).recipes[0].notes, '点击导出前已保存的新内容');
  assert.equal(reads, 2);
});
test('backup rejects a failed later page or missing photo instead of returning partial data', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 101; i++) await f.save(recipe(`page-${i}`));
  f.intercept(async (path, send) => path.startsWith('recipes?') ? Response.json({ code: 'STORAGE_UNAVAILABLE', error: '分页失败' }, { status: 503 }) : send());
  await assert.rejects(() => prepareBackup(f.client), error => error.code === 'STORAGE_UNAVAILABLE');
  assert.equal(f.client.current().length, 1);
  f.intercept(async (_, send) => send());
  const current = await f.database.latest('one');
  await f.save(recipe('one', { photo: 'data:image/avif;base64,YWJj' }), current.revision);
  f.intercept(async (path, send) => path === 'photos' || path.startsWith('photo/') ? Response.json({ code: 'PHOTO_NOT_FOUND', error: '照片缺失' }, { status: 404 }) : send());
  await assert.rejects(() => prepareBackup(f.client), error => error.code === 'PHOTO_NOT_FOUND');
});
test('backup cannot silently switch users when the server cookie belongs to another account', async t => {
  const f = await fixture(t);
  const response = await f.api(new Request('https://recipes.test/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: '备份测试用户', password: f.password, registrationId: randomUUID() }) }));
  f.cookie(response.headers.get('set-cookie').split(';')[0]);
  await assert.rejects(() => prepareBackup(f.client), error => error.code === 'ACCOUNT_CHANGED');
});
test('logout during backup cancels the pending export and clears private cached data', async t => {
  const f = await fixture(t);
  let release, reached; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
  f.intercept(async (path, send) => { const response = await send(); if (path === 'recipes') { reached(); await held; } return response; });
  const backup = f.client.backupSnapshot(); await started;
  await f.client.logout(); release();
  await assert.rejects(backup, error => error.code === 'ACCOUNT_CHANGED');
  assert.deepEqual(f.client.current(), []);
});
test('all backup parts restore through the real server with images and private favorites intact', async t => {
  const f = await fixture(t);
  const photo = 'data:image/png;base64,' + (await readFile(new URL('../dist/icons/icon-192.png', import.meta.url))).toString('base64');
  const original = Array.from({ length: 3 }, (_, i) => recipe(`restored-${i}`, { photo, favorite: i !== 1 }));
  const parts = makeBackupParts(original, { maxRecipes: 2 });
  assert.equal(parts.length, 2);
  for (const part of parts) await f.client.import(parseBackup(part.text));
  const restored = (await f.client.all()).filter(item => item.id.startsWith('restored-')).sort((a, b) => a.id.localeCompare(b.id));
  const contents = ({ updatedAt, photo, ...item }) => ({ ...item, photoHash: createHash('sha256').update(photo).digest('hex') });
  assert.deepEqual(restored.map(contents), original.map(contents));
  for (const item of restored) assert.ok(Date.parse(item.updatedAt) >= Date.parse(original[0].updatedAt), 'import creates a new saved version');
});
