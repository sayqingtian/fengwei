import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { stampVersion } from '../scripts/app-version.mjs';

const sw = await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8');
function worker({ legacy = false, failAsset = false } = {}) {
  const handlers = {}, cached = new Map(), fetched = [], removed = []; let skips = 0;
  const self = { location: new URL('https://example.test/cook/sw.js'), addEventListener: (name, handle) => { handlers[name] = handle; }, skipWaiting: async () => { skips++; }, clients: { claim: async () => {} } };
  const caches = { keys: async () => legacy ? ['fengwei-shell-v12'] : ['fengwei-shell-previous'], open: async () => ({ put: async (url, res) => cached.set(url, await res.text()), match: async () => undefined }), delete: async key => { removed.push(key); } };
  vm.runInNewContext(sw, { self, caches, URL, Response, AbortController, setTimeout, clearTimeout, fetch: async (url, options) => { fetched.push({ url: new URL(url), options }); return new Response('shell', { status: failAsset && String(url).includes('styles.css') ? 503 : 200 }); } });
  const run = (name, data = {}) => { let promise; handlers[name]({ ...data, waitUntil: value => { promise = value; } }); return promise; };
  return { run, cached, fetched, removed, get skips() { return skips; } };
}

test('updates download a complete fresh shell and wait for explicit activation while bridging old installations', async () => {
  const w = worker(); await w.run('install');
  assert.equal(w.skips, 0); assert.ok(w.cached.has('https://example.test/cook/checkins.js')); assert.ok(w.cached.has('https://example.test/cook/update.js'));
  assert.ok(w.fetched.every(item => item.options.cache === 'reload' && item.url.searchParams.get('__fw_shell')));
  await w.run('message', { data: { type: 'SKIP_WAITING' } }); assert.equal(w.skips, 1);
  const old = worker({ legacy: true }); await old.run('install'); assert.equal(old.skips, 1);
  const fail = worker({ failAsset: true }); await assert.rejects(fail.run('install'), /Incomplete/); assert.equal(fail.cached.size, 0); assert.equal(fail.skips, 0);
});

test('version metadata always bypasses service worker caching and API responses remain private', () => {
  const w = worker();
  for (const path of ['version.json?check=123', 'api/checkins', 'api/recipes']) {
    let intercepted = false;
    w.run('fetch', { request: { method: 'GET', url: `https://example.test/cook/${path}`, mode: 'cors' }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});

test('builds automatically stamp matching versions and changed source assets produce a new shell version', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fengwei-version-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'), output = join(directory, 'output'); await mkdir(output); await cp(resolve('dist'), source, { recursive: true });
  const first = await stampVersion(source, output), same = await stampVersion(source, output); assert.equal(first, same);
  assert.ok((await readFile(join(output, 'sw.js'), 'utf8')).includes(`fengwei-shell-${first}`));
  assert.ok((await readFile(join(output, 'version.js'), 'utf8')).includes(`'${first}'`));
  assert.equal(JSON.parse(await readFile(join(output, 'version.json'), 'utf8')).version, first);
  await writeFile(join(source, 'styles.css'), 'body{color:green}'); assert.notEqual(await stampVersion(source, output), first);
});
