import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../server/file-store.mjs';

test('local audit keys round-trip through Windows-safe filenames without collisions or path traversal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fengwei-portable-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root), key = 'private/audit-index/2026-10-16T08:00:00.000Z|sample.json', literal = 'private/audit-index/literal%3Aname.json';
  await store.setJSON(key, { id: 'one' }, { onlyIfNew: true }); await store.setJSON(literal, { id: 'two' });
  assert.deepEqual(await store.get(key, { type: 'json' }), { id: 'one' });
  assert.deepEqual(await store.get(literal, { type: 'json' }), { id: 'two' });
  assert.deepEqual((await store.list({ prefix: 'private/audit-index/' })).blobs.map(item => item.key).sort(), [key, literal].sort());
  await assert.rejects(store.setJSON(key, { id: 'changed' }, { onlyIfNew: true }), error => error.code === 'PRECONDITION_FAILED');
  await store.delete(key); assert.equal(await store.get(key), null);
  for (const invalid of ['../outside', 'private/../../outside', 'C:\\outside', '/outside']) assert.throws(() => store.path(invalid), /Invalid storage key/);
});
