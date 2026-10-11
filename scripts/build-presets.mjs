import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { homeRecipes } from '../presets/home-cooking-40.mjs';
import { extraRecipes } from '../presets/extra-cooking-30.mjs';
import { CATEGORIES, makeBackup, parseBackup, planImport } from '../dist/store.js';

const text = makeBackup(homeRecipes);
const valid = parseBackup(text);
assert.equal(valid.length, 40);
assert.equal(new Set(valid.map(item => item.title)).size, 40);
for (const item of valid) {
  assert.ok(CATEGORIES.includes(item.category));
  assert.equal(item.servings, 2);
  assert.ok(item.ingredients.length >= 4 && item.ingredients.every(ingredient => ingredient.amount));
  assert.ok(item.steps.length >= 4 && item.steps.every(step => step.length > 10));
  assert.ok(item.notes && item.description);
}
assert.equal(planImport(valid, valid).writes.length, 0, 'reimport does not duplicate');
const edited = { ...valid[0], notes: '我的口味调整', updatedAt: '2026-10-12T00:00:00.000Z' };
assert.equal(planImport([edited], [valid[0]]).writes.length, 0, 'preset does not overwrite later edits');
await mkdir(resolve('artifacts'), { recursive: true });
await writeFile(resolve('artifacts', '峰味-40道家常菜.json'), text, 'utf8');
const counts = valid.reduce((result, item) => { result[item.category] = (result[item.category] || 0) + 1; return result; }, {});
console.log(JSON.stringify({ recipes: valid.length, categories: counts, file: resolve('artifacts', '峰味-40道家常菜.json'), bytes: Buffer.byteLength(text) }));

const extraText = makeBackup(extraRecipes);
const extraValid = parseBackup(extraText);
assert.equal(extraValid.length, 30);
const combined = [...valid, ...extraValid];
assert.equal(new Set(combined.map(item => item.id)).size, 70);
assert.equal(new Set(combined.map(item => item.title)).size, 70);
for (const item of extraValid) {
  assert.ok(CATEGORIES.includes(item.category));
  assert.ok(item.servings >= 2 && item.servings <= 4);
  assert.ok(item.ingredients.length >= 4 && item.ingredients.every(ingredient => ingredient.name && ingredient.amount));
  assert.ok(item.steps.length >= 4 && item.steps.every(step => step.length > 10));
  assert.ok(item.notes && item.description && item.minutes > 0);
  assert.equal(item.favorite, false, 'presets do not create account favorites');
}
for (const title of ['糖醋排骨', '剁椒鱼头', '清蒸波龙（波士顿龙虾）']) assert.ok(extraValid.some(item => item.title === title));
assert.equal(planImport(extraValid, extraValid).writes.length, 0);
const editedExtra = { ...extraValid[0], notes: '我的改进版', updatedAt: '2026-10-12T00:00:00.000Z' };
assert.equal(planImport([editedExtra], [extraValid[0]]).writes.length, 0);
await writeFile(resolve('artifacts', '峰味-新增30道菜谱.json'), extraText, 'utf8');
await writeFile(resolve('artifacts', '峰味-70道菜谱合集.json'), makeBackup(combined), 'utf8');
console.log(JSON.stringify({ extraRecipes: extraValid.length, combinedRecipes: combined.length, file: resolve('artifacts', '峰味-新增30道菜谱.json'), bytes: Buffer.byteLength(extraText) }));
