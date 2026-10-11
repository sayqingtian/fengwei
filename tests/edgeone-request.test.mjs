import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecipeDatabase } from '../server/database.mjs';
import { FileStore } from '../server/file-store.mjs';
import { createApi } from '../server/api.mjs';
import { publicEdgeOneRequest, DEFAULT_PUBLIC_ORIGIN } from '../server/edgeone-request.mjs';

const fixturePassword = 'edgeone-proxy-test-password';
const root = await mkdtemp(join(tmpdir(), 'fengwei-edgeone-proxy-test-'));
const api = createApi({ database: new RecipeDatabase(new FileStore(root)), password: fixturePassword });
const internalUrl = 'http://internal-function.edgeone.invalid/api/';
function proxyRequest(path, { method = 'GET', value, cookie, origin = DEFAULT_PUBLIC_ORIGIN, enhancedBody } = {}) {
  const request = new Request(internalUrl + path, {
    method, headers: {
      // The internal Node hop can overwrite the forwarded protocol/host too.
      Host: 'internal-function.edgeone.invalid', 'X-Forwarded-Proto': 'http',
      ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(value ? { 'Content-Type': 'application/json' } : {}),
    }, ...(value ? { body: JSON.stringify(value) } : {}),
  });
  if (enhancedBody) {
    // EdgeOne CLI 1.6.41 createEdgeoneCompatibleRequest shadows the native
    // stream with parsed JSON or a promise, while .arrayBuffer/.text survive.
    // The real body remains inside this Request's native internal slots.
    Object.defineProperty(request, 'body', { get() {
      return enhancedBody === 'pending' ? Promise.resolve(value) : value;
    }, configurable: true });
  }
  return publicEdgeOneRequest(request);
}
test('EdgeOne internal HTTP URL is interpreted as the configured HTTPS site', async () => {
  const request = proxyRequest('recipes?cursor=abc', { origin: null });
  assert.equal(request.url, `${DEFAULT_PUBLIC_ORIGIN}/api/recipes?cursor=abc`);
  const response = await api(proxyRequest('recipes', { origin: null }));
  assert.equal(response.status, 401, 'no false HTTPS rejection; still requires login');
  assert.equal((await response.json()).code, 'LOGIN_REQUIRED');
});
test('proxy login accepts the actual public origin and issues a Secure persistent cookie', async () => {
  const response = await api(proxyRequest('login', { method: 'POST', value: { username: 'wupanfeng', password: fixturePassword } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict;.*Secure/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await api(proxyRequest('recipes', { cookie, origin: null }))).status, 200);
  assert.equal((await api(proxyRequest('logout', { method: 'POST', value: {}, cookie, origin: 'https://other.invalid' }))).status, 403);
});
test('public origin cannot be selected by a client header; direct HTTP remains rejected', async () => {
  const request = proxyRequest('recipes', { origin: 'https://attacker.invalid' });
  assert.equal(new URL(request.url).origin, DEFAULT_PUBLIC_ORIGIN);
  assert.equal(new URL(publicEdgeOneRequest(new Request('http://internal.invalid//attacker.invalid/api/recipes')).url).origin, DEFAULT_PUBLIC_ORIGIN);
  const direct = new Request('http://www.wupanfeng.dpdns.org/api/recipes');
  assert.equal((await api(direct)).status, 400);
  assert.throws(() => publicEdgeOneRequest(direct, 'http://www.wupanfeng.dpdns.org'));
  assert.throws(() => publicEdgeOneRequest(direct, 'https://www.wupanfeng.dpdns.org/another-path'));
});

test('EdgeOne parsed-object and pending-promise bodies preserve login bytes and Secure cookie', async () => {
  for (const enhancedBody of ['parsed', 'pending']) {
    const value = { username: 'wupanfeng', password: fixturePassword };
    const request = proxyRequest('login', { method: 'POST', value, enhancedBody });
    assert.equal(request.bodyUsed, false, 'normalizing URL does not consume the body');
    const response = await api(request);
    assert.equal(response.status, 200, `${enhancedBody} body must not become [object Object/Promise]`);
    assert.equal(request.bodyUsed, true);
    assert.match(response.headers.get('set-cookie'), /; Secure/);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await api(proxyRequest('recipes', { cookie, origin: null }))).status, 200);
  }
});

test('EdgeOne enhanced request preserves recipe, photo and deletion mutation bodies', async () => {
  const login = await api(proxyRequest('login', { method: 'POST', value: { username: 'wupanfeng', password: fixturePassword }, enhancedBody: 'pending' }));
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const recipe = { id: 'edgeone-json', title: '番茄炒蛋', category: '家常菜', description: '中文正文', notes: '', minutes: 15, servings: 2, favorite: false, photo: 'data:image/png;base64,aGVsbG8=', ingredients: [{ name: '鸡蛋', amount: '3 个' }], steps: ['炒熟'], createdAt: '2026-10-11T01:00:00Z', updatedAt: '2026-10-11T01:00:00Z' };
  const saved = await api(proxyRequest('recipe/edgeone-json', { method: 'PUT', cookie, enhancedBody: 'parsed', value: { recipe, baseRevision: null, mutationId: 'edgeone-json-save-001' } }));
  assert.equal(saved.status, 200);
  const item = (await saved.json()).item;
  assert.equal(item.recipe.description, '中文正文');
  const photo = await api(proxyRequest(`photo/${item.photoHash}`, { cookie }));
  assert.equal((await photo.json()).photo, recipe.photo);
  const deleted = await api(proxyRequest('recipe/edgeone-json', { method: 'DELETE', cookie, enhancedBody: 'pending', value: { baseRevision: item.revision, mutationId: 'edgeone-json-delete-001' } }));
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).item.deleted, true);
});
