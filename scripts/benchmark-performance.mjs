import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FileStore } from '../server/file-store.mjs';
import { RecipeDatabase } from '../server/database.mjs';
import { createApi } from '../server/api.mjs';
import { Accounts } from '../server/accounts.mjs';
import { testAccount } from '../server/auth.mjs';
import { createRemoteStore } from '../dist/sync.js';

const directory = await mkdtemp(join(tmpdir(), 'fengwei-performance-'));
const fixturePassword = 'performance-fixture-password';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const raw = new FileStore(directory), database = new RecipeDatabase(raw);
const counts = { get: 0, list: 0, set: 0, http: 0 }, routes = [];
const store = Object.fromEntries(['get', 'list', 'set', 'setJSON'].map(method => [method, async (...args) => {
  counts[method === 'setJSON' ? 'set' : method]++;
  await delay(15); return raw[method](...args);
}]));
const originalFetch = globalThis.fetch;
try {
  const accounts = new Accounts(raw, testAccount(fixturePassword));
  let viewer;
  for (let i = 0; i < 20; i++) {
    const user = await accounts.register({ displayName: `性能用户${i}`, password: fixturePassword, registrationId: randomUUID() });
    if (!i) viewer = user;
  }
  await raw.setJSON(`private/permissions/${viewer.id}/000000000001-fixture.json`, { generation: 1, role: 'editor' });
  for (let i = 0; i < 70; i++) {
    const recipe = { id: `performance-recipe-${i}`, title: `性能测试菜谱${i}`, category: '家常菜', description: '', minutes: 15, servings: 2, favorite: false, photo: i < 12 ? `data:image/png;base64,${Buffer.from(`fixture-photo-${i}`).toString('base64')}` : '', notes: '', ingredients: [], steps: ['测试步骤'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await database.commit({ id: recipe.id, recipe, baseRevision: null, mutationId: randomUUID() });
  }
  const api = createApi({ database: new RecipeDatabase(store), password: fixturePassword });
  let cookie;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(url), path = target.pathname.split('/api/')[1] + target.search;
    counts.http++; routes.push(`${options.method || 'GET'} ${path}`); await delay(20);
    const response = await api(new Request(`https://recipes.test/api/${path}`, { ...options, headers: { ...options.headers, Origin: 'https://recipes.test', ...(cookie ? { Cookie: cookie } : {}) } }));
    const issued = response.headers.get('set-cookie'); if (issued) cookie = issued.split(';')[0]; return response;
  };
  const settings = new Map(), client = await createRemoteStore({ async setting(key) { return settings.get(key); }, async setSetting(key, value) { settings.set(key, structuredClone(value)); } });
  const report = { fixture: { recipes: 70, photos: 12, accounts: 20, storageLatencyMs: 15, httpLatencyMs: 20 }, operations: {} };
  async function measure(name, work) {
    for (const key of Object.keys(counts)) counts[key] = 0; routes.length = 0;
    const start = performance.now(); await work();
    report.operations[name] = { milliseconds: Math.round(performance.now() - start), ...counts, routes: [...routes] };
  }
  await measure('login', () => client.login(viewer.displayName, fixturePassword));
  let recipes;
  await measure('initialSync', async () => { recipes = await client.all(); });
  await measure('repeatSync', () => client.all());
  await measure('saveAndRender', async () => {
    await client.put({ ...recipes[0], notes: '性能测试保存' });
    if (client.current) client.current(); else await client.all();
  });
  await measure('favoriteAndRender', async () => {
    await client.setFavorite(recipes[0].id, true);
    if (client.current) client.current(); else await client.all();
  });
  await mkdir(resolve('artifacts'), { recursive: true });
  const output = resolve('artifacts', `performance-${process.argv[2] || 'latest'}.json`);
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: output, operations: Object.fromEntries(Object.entries(report.operations).map(([key, { routes, ...value }]) => [key, value])) }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  const target = resolve(directory), parent = resolve(tmpdir());
  if (!target.startsWith(parent + sep) || !target.slice(parent.length + 1).startsWith('fengwei-performance-')) throw new Error('Unexpected benchmark temporary directory');
  await rm(target, { recursive: true, force: true });
}
