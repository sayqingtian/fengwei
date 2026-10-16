import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileStore } from '../server/file-store.mjs';
import { RecipeDatabase, hash } from '../server/database.mjs';
import { photoAccess, photoLeaseState } from '../server/photo-access.mjs';
import { requestStore } from '../server/request-store.mjs';
import { joinPhoto } from '../dist/photo-wire.js';
import { createApi } from '../server/api.mjs';
const picture = n => joinPhoto({ type: 'image/avif', bytes: new Uint8Array(n).fill(71) });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root), db = new RecipeDatabase(store);
  const save = async (id, photo = '', extra = {}) => db.commit({ id, recipe: { id, title: id, photo, ...extra }, baseRevision: (await db.latest(id))?.revision || null, mutationId: randomUUID() });
  const remove = async id => db.commit({ id, baseRevision: (await db.latest(id)).revision, mutationId: randomUUID() });
  const purge = async (id, revision) => { let result, count = 0; do { result = await db.purge(id, revision); assert.ok(count++ < 30); } while (!result.complete); return result; };
  return { store, db, save, remove, purge };
}
test('permanent deletion removes every unreferenced historical photo, duplicate legacy bytes and metadata', async t => {
  const f = await fixture(t), a = picture(30), b = picture(40);
  await f.save('gone', a); await f.save('gone', b);
  await f.store.set(`photos/${hash(a)}.txt`, a);
  await f.store.setJSON(`private/photo-optimized/${hash(a)}.json`, { version: 1 });
  const deleted = await f.remove('gone'); await f.purge('gone', deleted.revision);
  assert.equal((await f.store.list({ prefix: 'photos/' })).blobs.length, 0);
  assert.equal(await f.store.get(`private/photo-optimized/${hash(a)}.json`), null);
  assert.equal((await f.store.get(`private/purged-recipes/${hash('gone')}.json`, { type: 'json' })).complete, true);
  await f.purge('gone', deleted.revision);
});
test('photos referenced only by old history or another trashed recipe survive until the last recipe is purged', async t => {
  const f = await fixture(t), shared = picture(50);
  await f.save('gone', shared); await f.save('keep', shared);
  for (let i = 0; i < 12; i++) await f.save('keep');
  const a = await f.remove('gone'), b = await f.remove('keep');
  await f.purge('gone', a.revision); assert.equal(await f.db.photo(hash(shared)), shared);
  await f.purge('keep', b.revision); assert.equal(await f.db.photo(hash(shared)), null);
});
test('alias chains protect shared targets and clean orphan ancestors without breaking later reuploads', async t => {
  const f = await fixture(t), large = picture(1000), medium = picture(200), small = picture(50);
  await f.save('gone', large); await f.db.photos.optimize(hash(large), medium); await f.db.photos.optimize(hash(medium), small);
  await f.save('keep', medium);
  const gone = await f.remove('gone'); await f.purge('gone', gone.revision);
  assert.equal(await f.store.get(`private/photo-optimizations/${hash(large)}.json`), null);
  assert.equal(await f.db.photo(hash(medium)), small);
  const keep = await f.remove('keep'); await f.purge('keep', keep.revision);
  assert.equal((await f.store.list({ prefix: 'photos/' })).blobs.length, 0);
  assert.equal((await f.store.list({ prefix: 'private/photo-optimizations/' })).blobs.length, 0);
  await f.save('new', large); assert.equal(await f.db.photo(hash(large)), large);
});
test('cleanup failure retains candidates and resumes after immutable recipe versions have gone', async t => {
  const f = await fixture(t), p = picture(80); await f.save('gone', p); const deleted = await f.remove('gone');
  const remove = f.store.delete.bind(f.store); let fail = true;
  f.store.delete = async key => { if (fail && key.endsWith('.bin')) throw new Error('Injected delete failure'); return remove(key); };
  await assert.rejects(f.db.purge('gone', deleted.revision), /Injected/);
  const marker = await f.store.get(`private/purged-recipes/${hash('gone')}.json`, { type: 'json' });
  assert.equal(marker.complete, false); assert.deepEqual(marker.photoCandidates, [hash(p)]);
  assert.equal((await f.store.list({ prefix: `recipes/${hash('gone')}/` })).blobs.length, 0);
  fail = false; await f.purge('gone', deleted.revision); assert.equal(await f.db.photo(hash(p)), null);
});
test('failed reference scans stop image deletion and recover safely', async t => {
  const f = await fixture(t), p = picture(90); await f.save('gone', p); await f.save('keep', p); const deleted = await f.remove('gone');
  const get = f.store.get.bind(f.store); let fail = true;
  f.store.get = async (key, options) => fail && key.startsWith(`recipes/${hash('keep')}/`) ? null : get(key, options);
  await assert.rejects(f.db.purge('gone', deleted.revision), /References changed/);
  assert.ok(await f.db.photos.raw(hash(p)));
  fail = false; await f.purge('gone', deleted.revision); assert.equal(await f.db.photo(hash(p)), p);
});
test('bounded reference scans resume, but intervening saves invalidate their checkpoint and protect new references', async t => {
  const f = await fixture(t), p = picture(110); await f.save('gone', p);
  for (let i = 0; i < 135; i++) await f.save('history', '', { notes: String(i) });
  const deleted = await f.remove('gone'); assert.equal((await f.db.purge('gone', deleted.revision)).complete, false);
  const key = `private/purged-recipes/${hash('gone')}.json`, before = await f.store.get(key, { type: 'json' }); assert.ok(before.photoScan.cursor);
  await f.save('history', p); await f.purge('gone', deleted.revision);
  assert.equal(await f.db.photo(hash(p)), p);
});
test('collector excludes overlapping saves and never relies on an immutable photo existence cache', async t => {
  const f = await fixture(t), p = picture(120), memo = requestStore(f.store), db = new RecipeDatabase(memo);
  await f.save('gone', p); await memo.run(() => db.photo(hash(p)));
  await photoAccess(f.store, 'write', async () => {
    await assert.rejects(f.save('another', p), { code: 'PHOTO_STORAGE_BUSY' });
  });
  const deleted = await f.remove('gone'); await f.purge('gone', deleted.revision);
  await memo.run(() => db.commit({ id: 'new', recipe: { id: 'new', title: 'new', photo: p }, baseRevision: null, mutationId: randomUUID() }));
  assert.equal(await f.db.photo(hash(p)), p);
});
test('expired leases cannot renew or release a replacement owner; writers require coordination', async () => {
  const read = photoLeaseState(null, { action: 'acquire', mode: 'read', token: 'a', now: 0 });
  assert.throws(() => photoLeaseState(read, { action: 'acquire', mode: 'write', token: 'b', now: 100 }), { code: 'PHOTO_STORAGE_BUSY' });
  const write = photoLeaseState(read, { action: 'acquire', mode: 'write', token: 'b', now: 120001 });
  assert.throws(() => photoLeaseState(write, { action: 'check', mode: 'read', token: 'a', now: 120002 }), { code: 'PHOTO_STORAGE_BUSY' });
  assert.equal(photoLeaseState(write, { action: 'release', mode: 'read', token: 'a', now: 120002 }).writer.token, 'b');
  await assert.rejects(photoAccess({}, 'write', () => assert.fail()), { code: 'PHOTO_STORAGE_BUSY' });
});

test('inventory separates current, recoverable history, trash and orphans; cleanup revalidates stale selections', async t => {
  const f = await fixture(t), old = picture(41), current = picture(42), trashed = picture(43), orphan = picture(44);
  await f.save('keep', old); await f.save('keep', current); await f.save('trash', trashed); await f.remove('trash');
  await f.db.photos.save(orphan);
  const inventory = await f.db.photos.inventory(), usage = new Map(inventory.items.map(item => [item.hash, item.usage]));
  assert.equal(inventory.total, 4);
  assert.equal(usage.get(hash(current)), 'current'); assert.equal(usage.get(hash(old)), 'history');
  assert.equal(usage.get(hash(trashed)), 'history'); assert.equal(usage.get(hash(orphan)), 'orphan');
  const request = { hashes: inventory.items.map(item => item.hash), mutationId: randomUUID() };
  const cleaned = await f.db.photos.cleanup('test-owner', request); assert.equal(cleaned.complete, true);
  assert.equal(await f.db.photo(hash(orphan)), null);
  for (const image of [old, current, trashed]) assert.equal(await f.db.photo(hash(image)), image);
  assert.deepEqual(await f.db.photos.cleanup('test-owner', request), { complete: true });
  const fresh = picture(45); await f.db.photos.save(fresh);
  await f.save('new', fresh); // The inventory is stale by the time cleanup runs.
  await f.db.photos.cleanup('test-owner', { hashes: [hash(fresh)], mutationId: randomUUID() });
  assert.equal(await f.db.photo(hash(fresh)), fresh);
});

test('orphan cleanup resumes interrupted deletion and restarts a bounded scan after new photo references', async t => {
  const f = await fixture(t), orphan = picture(46), protectedPhoto = picture(47);
  await f.db.photos.save(orphan); await f.db.photos.save(protectedPhoto);
  for (let i = 0; i < 135; i++) await f.save('history', '', { notes: String(i) });
  const request = { hashes: [hash(orphan), hash(protectedPhoto)], mutationId: randomUUID() };
  assert.equal((await f.db.photos.cleanup('test-owner', request)).complete, false);
  await f.save('history', protectedPhoto);
  const remove = f.store.delete.bind(f.store); let fail = true;
  f.store.delete = async key => { if (fail && key === `photos/${hash(orphan)}.bin`) throw new Error('Interrupted'); return remove(key); };
  let complete = false, interrupted = false;
  for (let i = 0; i < 8 && !complete; i++) {
    try { complete = (await f.db.photos.cleanup('test-owner', request)).complete; }
    catch (error) { assert.match(error.message, /Interrupted/); interrupted = true; fail = false; }
  }
  assert.ok(interrupted); assert.ok(complete);
  assert.equal(await f.db.photo(hash(orphan)), null); assert.equal(await f.db.photo(hash(protectedPhoto)), protectedPhoto);
});

test('only the signed-in administrator can clean photos with a same-origin, account-bound request', async t => {
  const f = await fixture(t), password = 'photo-cleanup-test-password', api = createApi({ database: f.db, password });
  const call = (path, data, cookie, origin = 'https://photos.test') => api(new Request(`https://photos.test/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) }));
  const admin = await call('login', { username: 'wupanfeng', password }), cookie = admin.headers.get('set-cookie').split(';')[0], user = (await admin.json()).user;
  const viewer = await call('register', { displayName: '图片清理测试', password, registrationId: randomUUID() }), viewerCookie = viewer.headers.get('set-cookie').split(';')[0], viewerUser = (await viewer.json()).user;
  const photo = picture(48); await f.db.photos.save(photo);
  const data = { hashes: [hash(photo)], mutationId: randomUUID(), expectedUserId: user.id };
  assert.equal((await call('admin/photos/cleanup', data)).status, 401);
  assert.equal((await call('admin/photos/cleanup', { ...data, expectedUserId: viewerUser.id }, viewerCookie)).status, 403);
  assert.equal((await call('admin/photos/cleanup', data, cookie, 'https://other.test')).status, 403);
  assert.equal((await call('admin/photos/cleanup', { ...data, expectedUserId: viewerUser.id }, cookie)).status, 409);
  assert.equal((await call('admin/photos/cleanup', { ...data, hashes: ['../bad'] }, cookie)).status, 400);
  assert.ok(await f.db.photo(hash(photo)));
  assert.equal((await call('admin/photos/cleanup', data, cookie)).status, 200);
  assert.equal(await f.db.photo(hash(photo)), null);
});
