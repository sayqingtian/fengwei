import test from 'node:test';
import assert from 'node:assert/strict';
import { readJsonBody } from '../server/json-body.mjs';

const headers = new Headers({ 'Content-Type': 'application/json' });
const request = value => new Request('https://recipes.test/api/login', { method: 'POST', headers, body: value });
const errorCode = (code, status) => error => error.code === code && error.status === status;

test('JSON reader handles native chunked UTF-8 and cancels requests past byte limit', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ name: '番茄炒蛋' }));
  let cursor = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (cursor === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(cursor, ++cursor));
  } });
  const incoming = new Request('https://recipes.test/api/recipe/test', { method: 'PUT', headers, body: stream, duplex: 'half' });
  assert.deepEqual(await readJsonBody(incoming), { name: '番茄炒蛋' });
  let cancelled = false;
  const large = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } });
  await assert.rejects(readJsonBody(new Request('https://recipes.test/api/login', { method: 'POST', headers, body: large, duplex: 'half' }), 50), errorCode('TOO_LARGE', 413));
  assert.equal(cancelled, true);
});

test('enhanced Request uses original raw readers without accessing its parsed-body getter', async () => {
  const incoming = request('{"name":"番茄炒蛋"}');
  Object.defineProperty(incoming, 'body', { get() { throw new Error('Parsed-body getter must not be accessed'); } });
  assert.deepEqual(await readJsonBody(incoming), { name: '番茄炒蛋' });
  const broken = request('{');
  Object.defineProperty(broken, 'body', { get() { throw new SyntaxError('Preloaded invalid JSON'); } });
  await assert.rejects(readJsonBody(broken), errorCode('INVALID_JSON', 400));
});

test('fallback raw readers enforce byte limits and keep empty/unreadable/malformed errors distinct', async () => {
  assert.deepEqual(await readJsonBody({ headers, text: async () => '{"name":"蛋"}' }), { name: '蛋' });
  await assert.rejects(readJsonBody({ headers, text: async () => '{"name":"蛋"}' }, 12), errorCode('TOO_LARGE', 413));
  await assert.rejects(readJsonBody(request('')), errorCode('EMPTY_BODY', 400));
  await assert.rejects(readJsonBody(request('[object Object]')), errorCode('INVALID_JSON', 400));
  await assert.rejects(readJsonBody({ headers, text: async () => { throw new Error('Consumed'); } }), errorCode('BODY_UNREADABLE', 400));
  const consumed = request('{}'); await consumed.text();
  await assert.rejects(readJsonBody(consumed), errorCode('BODY_UNREADABLE', 400));
  const declaredLarge = { headers: new Headers({ 'Content-Type': 'application/json', 'Content-Length': '100' }), arrayBuffer: async () => { assert.fail('must reject before reading'); } };
  await assert.rejects(readJsonBody(declaredLarge, 50), errorCode('TOO_LARGE', 413));
  await assert.rejects(readJsonBody({ headers: new Headers({ 'Content-Type': 'text/plain' }) }), errorCode('JSON_REQUIRED', 415));
  await assert.rejects(readJsonBody(request(new Uint8Array([123, 34, 97, 34, 58, 34, 255, 34, 125]))), errorCode('INVALID_JSON', 400));
});
