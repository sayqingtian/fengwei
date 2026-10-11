// Add the requested presets through the same private API used by the app.
// Credentials are read from hidden stdin, never command arguments or files.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseBackup } from '../dist/store.js';

const origin = 'https://www.wupanfeng.dpdns.org';
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `Missing ${name} value`);
  return args[index + 1];
}
const input = option('--input', resolve('artifacts', '峰味-40道家常菜.json'));
const reportPath = resolve(option('--report', resolve('artifacts', 'preset-import-verification.json')));
const checkOnly = args.includes('--check-only');
const recipes = parseBackup(await readFile(resolve(input), 'utf8'));
assert.ok(recipes.length > 0);
assert.equal(new Set(recipes.map(recipe => recipe.id)).size, recipes.length);
assert.ok(recipes.every(recipe => /^fengwei-(home|extra)-v1-\d{3}$/.test(recipe.id)));
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Verified HTTPS is required');

async function credentials() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write('Ready for credentials JSON on stdin (input is hidden).\n');
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    const onData = chunk => {
      input += chunk;
      if (input.length > 4096 || input.includes('\u0003')) { cleanup(); reject(new Error('Input cancelled')); return; }
      if (!/[\r\n]/.test(input)) return;
      cleanup();
      try {
        const value = JSON.parse(input.trim()); input = '';
        assert.equal(value.username, 'wupanfeng');
        assert.ok(typeof value.password === 'string' && value.password);
        resolve(value);
      } catch { reject(new Error('Invalid credential input')); }
    };
    function cleanup() { process.stdin.off('data', onData); process.stdin.pause(); if (process.stdin.isTTY) process.stdin.setRawMode(false); }
    process.stdin.on('data', onData);
    process.stdin.once('end', () => { cleanup(); reject(new Error('Credential input ended')); });
  });
}
let cookie = '';
async function request(path, { method = 'GET', value, attempts = 3 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetch(`${origin}/api/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(45000), headers: {
        Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}),
        ...(value === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }),
      }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    } catch {
      if (attempt < attempts) continue;
      throw new Error('Verified HTTPS request could not complete');
    }
    const nextCookie = response.headers.getSetCookie().find(item => item.startsWith('fengwei_session='));
    if (nextCookie) cookie = nextCookie.split(';')[0];
    if (response.status === 503 && attempt < attempts) { await response.arrayBuffer(); continue; }
    let data; try { data = await response.json(); } catch { throw new Error('API did not return JSON'); }
    // The platform can occasionally fail to expose its original body stream.
    // These codes occur before any recipe mutation. Reuse the exact same
    // immutable mutation ID for retries, including uncertain network results.
    if (response.status === 400 && ['BODY_UNREADABLE', 'EMPTY_BODY'].includes(data.code) && attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, 300 * attempt)); continue;
    }
    if (!response.ok) { const error = new Error(`API ${response.status}: ${data.code || 'REQUEST_FAILED'}`); error.status = response.status; throw error; }
    return data;
  }
}
async function all() {
  const result = []; const cursors = new Set(); let cursor = '';
  do {
    const data = await request(`recipes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.ok(Array.isArray(data.items)); result.push(...data.items);
    cursor = data.cursor || '';
    if (cursor) { assert.ok(!cursors.has(cursor)); cursors.add(cursor); }
  } while (cursor);
  return result;
}
const normalizeTitle = title => title.normalize('NFKC').trim().replace(/\s+/g, '');
const addedIds = [];
try {
  const account = await credentials();
  await request('login', { method: 'POST', value: account, attempts: 1 });
  account.password = '';
  assert.ok(cookie, 'Login must issue a session cookie');
  const initial = await all();
  const ids = new Set(initial.map(item => item.id));
  const titles = new Set(initial.filter(item => !item.deleted).map(item => normalizeTitle(item.recipe.title)));
  let skipped = 0;
  console.log(JSON.stringify({ stage: 'start', incoming: recipes.length, existing: initial.filter(item => !item.deleted).length }));
  if (checkOnly) {
    const matching = recipes.filter(recipe => ids.has(recipe.id) || titles.has(normalizeTitle(recipe.title))).map(recipe => recipe.title);
    console.log(JSON.stringify({ stage: 'checked', matching, missing: recipes.filter(recipe => !ids.has(recipe.id) && !titles.has(normalizeTitle(recipe.title))).map(recipe => recipe.title) }));
    process.exit(0);
  }
  for (const recipe of recipes) {
    if (ids.has(recipe.id) || titles.has(normalizeTitle(recipe.title))) { skipped++; continue; }
    try {
      await request(`recipe/${encodeURIComponent(recipe.id)}`, { method: 'PUT', value: { recipe, baseRevision: null, mutationId: `preset-import-${recipe.id}` } });
      addedIds.push(recipe.id);
    } catch (error) {
      if (error.status !== 409) throw error;
      skipped++; // Concurrently existing ID must never be overwritten.
    }
    if (addedIds.length && addedIds.length % 5 === 0) console.log(JSON.stringify({ stage: 'progress', saved: addedIds.length, skipped }));
  }
  const saved = await all();
  for (const id of addedIds) {
    const expected = recipes.find(recipe => recipe.id === id);
    const actual = saved.find(item => item.id === id && !item.deleted)?.recipe;
    assert.ok(actual, 'Every new recipe must be readable from server storage');
    for (const field of ['title', 'category', 'description', 'minutes', 'servings', 'ingredients', 'steps', 'notes']) assert.deepEqual(actual[field], expected[field]);
  }
  const active = saved.filter(item => !item.deleted);
  const availableIds = new Set(active.map(item => item.id));
  const availableTitles = new Set(active.map(item => normalizeTitle(item.recipe.title)));
  const availablePresets = recipes.filter(recipe => availableIds.has(recipe.id) || availableTitles.has(normalizeTitle(recipe.title))).length;
  const report = { verified: true, origin, requested: recipes.length, added: addedIds.length, skipped, availablePresets, activeRecipes: active.length, verifiedAt: new Date().toISOString() };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stage: 'complete', ...report }));
} catch (error) {
  console.error(JSON.stringify({ stage: 'incomplete', confirmedAdded: addedIds.length, error: error.message }));
  process.exitCode = 1;
} finally { cookie = ''; }
