import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8');
function worker(cached, fetch, open = async () => ({ match: async () => cached })) {
  const handlers = {};
  const context = {
    self: { location: new URL('https://example.test/recipes/sw.js'), addEventListener: (type, handler) => { handlers[type] = handler; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open }, fetch, URL, Response, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, context);
  return request => { let response; handlers.fetch({ request, respondWith: value => { response = Promise.resolve(value); } }); return response; };
}
const navigation = { url: 'https://example.test/recipes/', method: 'GET', mode: 'navigate' };

test('installed app opens from its cache without waiting for an unreachable host', async () => {
  const cached = new Response('<title>峰味</title>');
  let serverRequests = 0;
  const request = worker(cached, () => { serverRequests++; return new Promise(() => {}); });
  let timeout;
  const response = await Promise.race([request(navigation), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Cached startup waited for the host')), 500); })]).finally(() => clearTimeout(timeout));
  assert.equal(await response.text(), '<title>峰味</title>');
  assert.equal(serverRequests, 0);
});

test('private server API requests bypass the offline cache, including direct navigation', () => {
  const request = worker(new Response('cached interface'), async () => new Response('network'));
  assert.equal(request({ url: 'https://example.test/recipes/api/recipes', method: 'GET', mode: 'navigate' }), undefined);
  assert.equal(request({ url: 'https://example.test/recipes/api/photo/abc', method: 'GET', mode: 'cors' }), undefined);
});

test('an uncached navigation still retrieves the initial application from the host', async () => {
  let serverRequests = 0;
  const request = worker(undefined, async () => { serverRequests++; return new Response('initial shell'); });
  assert.equal(await (await request(navigation)).text(), 'initial shell');
  assert.equal(serverRequests, 1);
});

test('an unavailable or stalled mobile cache falls back to the network for navigation and modules', async () => {
  for (const open of [async () => { throw new Error('Storage unavailable'); }, () => new Promise(() => {})]) {
    let requests = 0;
    const request = worker(undefined, async () => { requests++; return new Response('fresh shell'); }, open);
    const responses = await Promise.all([request(navigation), request({ url: 'https://example.test/recipes/app.js', method: 'GET', mode: 'cors' })]);
    assert.deepEqual(await Promise.all(responses.map(response => response.text())), ['fresh shell', 'fresh shell']);
    assert.equal(requests, 2);
  }
});
