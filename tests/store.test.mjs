import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipe, makeBackup, parseBackup, planImport, filterRecipes } from '../dist/store.js';

const recipe = (overrides = {}) => ({ id: 'one', title: '番茄炒蛋', category: '家常菜', description: '', notes: '小火', minutes: 15, servings: 2, favorite: false, photo: '', ingredients: [{ name: '鸡蛋', amount: '3 个' }], steps: ['炒熟'], createdAt: '2026-10-11T01:00:00Z', updatedAt: '2026-10-11T01:00:00Z', ...overrides });
test('backup round trip retains photos, ingredient amounts, notes and favorites', () => {
  const original = recipe({ photo: 'data:image/png;base64,aGVsbG8=', favorite: true, notes: '手写心得\n下次少放盐' });
  assert.deepEqual(parseBackup(makeBackup([original])), [original]);
});
test('invalid or unsupported backups are rejected as a whole', () => {
  for (const data of ['not json', '{"format":"shiwei-recipes","version":2,"recipes":[]}', '{"format":"shiwei-recipes","version":1,"recipes":[{}]}']) assert.throws(() => parseBackup(data));
  assert.throws(() => parseBackup(JSON.stringify({ format: 'shiwei-recipes', version: 1, recipes: [recipe(), recipe()] })), /重复编号/);
  assert.throws(() => validateRecipe(recipe({ photo: 'https://untrusted.example/a.jpg' })), /照片/);
  assert.throws(() => validateRecipe(recipe({ servings: 0 })), /份量/);
  assert.throws(() => validateRecipe(recipe({ minutes: 2.5 })), /用时/);
  assert.throws(() => validateRecipe(recipe({ createdAt: 'yesterday' })), /日期/);
});
test('merge preserves newer local versions and all unrelated local recipes', () => {
  const local = [recipe({ updatedAt: '2026-10-11T04:00:00Z' }), recipe({ id: 'unrelated' })];
  const incoming = [recipe(), recipe({ id: 'two' })];
  const plan = planImport(local, incoming);
  assert.deepEqual({ added: plan.added, updated: plan.updated, skipped: plan.skipped }, { added: 1, updated: 0, skipped: 1 });
  assert.deepEqual(plan.writes.map(item => item.id), ['two']);
  const newer = planImport(local, [recipe({ updatedAt: '2026-10-11T05:00:00Z' })]);
  assert.equal(newer.updated, 1);
});
test('search matches ingredients and notes and combines filters', () => {
  const records = [recipe(), recipe({ id: 'two', title: '蛋炒饭', category: '早餐', favorite: true, updatedAt: '2026-10-11T03:00:00Z' })];
  assert.equal(filterRecipes(records, { query: '鸡蛋 小火' }).length, 2);
  assert.deepEqual(filterRecipes(records, { query: '鸡蛋', favorites: true, category: '早餐' }).map(item => item.id), ['two']);
  assert.equal(filterRecipes(records, { query: '不存在' }).length, 0);
  assert.equal(filterRecipes(records)[0].id, 'two');
});
