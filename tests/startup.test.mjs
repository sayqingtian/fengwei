import test from 'node:test';
import assert from 'node:assert/strict';
import { openLocalStore } from '../dist/store.js';
import { createRemoteStore } from '../dist/sync.js';

function replace(t, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
}

test('a stalled database open times out and closes a late connection without deleting data', async t => {
  const request = {}; let closed = 0;
  replace(t, 'indexedDB', { open: () => request });
  await assert.rejects(openLocalStore({ timeout: 20 }), { name: 'TimeoutError' });
  request.result = { close() { closed++; } }; request.onsuccess();
  assert.equal(closed, 1);
});

test('a blocked upgrade closes a later connection and a stalled local write aborts', async t => {
  const request = {}; let aborted = 0, closed = 0;
  replace(t, 'indexedDB', { open: () => request });
  const pending = openLocalStore({ timeout: 50 });
  request.onblocked(); await assert.rejects(pending, /关闭其他/);
  request.result = { close() { closed++; } }; request.onsuccess(); assert.equal(closed, 1);
  const open = openLocalStore({ timeout: 20 });
  request.result = { close() {}, transaction() { return { objectStore: () => ({ put() {} }), abort() { aborted++; } }; } };
  request.onsuccess(); const store = await open;
  await assert.rejects(store.setSetting('unsent', { note: 'keep original queue' }), { name: 'TimeoutError' });
  assert.equal(aborted, 1);
});

test('a stalled response body falls back to the original snapshot and pending queue without late writes', async t => {
  const user = { id: 'cached-user', displayName: '本机账号', canEdit: true };
  const recipe = { id: 'cached-dish', title: '本机菜谱', ingredients: [], steps: [], photo: '' };
  const snapshot = { user, recipes: [recipe], authenticatedAt: Date.now() };
  const queue = { jobs: [{ token: 'unsent', kind: 'favorite', id: recipe.id, value: { favorite: true }, status: 'pending' }], receipts: {} };
  const data = new Map([['fengwei-server-cache-v2', snapshot], [`fengwei-user:${user.id}:outbox-v1`, queue]]);
  let writes = 0, finish, signal;
  const local = { async setting(key) { return structuredClone(data.get(key)); }, async setSetting() { writes++; } };
  replace(t, 'fetch', async (_url, options) => { signal = options.signal; return { ok: true, status: 200, headers: new Headers(), json: () => new Promise(resolve => { finish = resolve; }) }; });
  const store = await createRemoteStore(local, { requestTimeout: 25 });
  const result = await store.all();
  assert.equal(result[0].id, recipe.id); assert.equal(result[0].favorite, true);
  assert.equal(store.readOnly, true); assert.equal(store.authenticated, true); assert.equal(signal.aborted, true);
  finish({ items: [], user }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(writes, 0); assert.equal(store.current()[0].id, recipe.id);
  assert.deepEqual(data.get(`fengwei-user:${user.id}:outbox-v1`), queue);
});

test('an expired snapshot does not appear during login recovery', async t => {
  replace(t, 'fetch', async () => { throw new Error('offline'); });
  const store = await createRemoteStore({ async setting(key) { return key === 'fengwei-server-cache-v2' ? { user: { id: 'old' }, recipes: [{ id: 'old-dish' }], authenticatedAt: 0 } : null; } });
  assert.deepEqual(store.current(), []); assert.equal(store.user, null);
  await assert.rejects(store.all(), { code: 'NETWORK' });
});
