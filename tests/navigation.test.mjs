import test from 'node:test';
import assert from 'node:assert/strict';
import { installBackNavigation } from '../dist/navigation.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const listeners = new Map(), addEventListener = (type, listener) => listeners.set(type, listener);
  const states = [null]; let index = 0, depth = 2, time = 0, calls = 0, onBack;
  const node = { closest: () => null, clientWidth: 300, scrollWidth: 300, parentElement: null };
  const target = { addEventListener, location: { href: 'https://recipes.test/' }, visualViewport: { scale: 1 }, getComputedStyle: () => ({ overflowX: 'auto' }),
    document: { addEventListener, body: {} }, history: {
      get state() { return states[index]; },
      pushState(value) { states.splice(++index, Infinity, value); },
      back() { if (index > 0) { index--; queueMicrotask(() => listeners.get('popstate')({ state: states[index] })); } },
    } };
  const nav = installBackNavigation({ target, canBack: () => depth > 0, back: async () => { calls++; if (onBack) await onBack(); else depth--; }, now: () => time });
  const point = (x, y) => ({ clientX: x, clientY: y });
  const send = (type, x, y, options = {}) => listeners.get(type)({ target: node, touches: type === 'touchend' ? [] : [point(x, y)], changedTouches: [point(x, y)], cancelable: true, preventDefault() {}, ...options });
  nav.sync();
  return { nav, target, send, node, listeners, get calls() { return calls; }, get depth() { return depth; }, get index() { return index; }, setBack(fn) { onBack = fn; }, advance(ms) { time += ms; } };
}
test('right swipe returns one layer and suppresses accidental click; root no longer intercepts browser back', async () => {
  const f = fixture();
  f.send('touchstart', 40, 200); f.send('touchmove', 140, 205); f.send('touchend', 180, 210); await tick();
  assert.equal(f.depth, 1); assert.equal(f.calls, 1);
  let prevented = 0; f.listeners.get('click')({ preventDefault() { prevented++; }, stopImmediatePropagation() { prevented++; } }); assert.equal(prevented, 2);
  await f.nav.back(); await tick(); assert.equal(f.depth, 0); assert.equal(f.index, 0);
  f.send('touchstart', 40, 200); f.send('touchmove', 180, 200); f.send('touchend', 180, 200); await tick(); assert.equal(f.calls, 2);
});
test('vertical, left, short, slow, multi-touch, zoom, native-edge and editable gestures do not navigate', async () => {
  for (const kind of ['vertical', 'left', 'short', 'slow', 'multi', 'zoom', 'edge', 'input', 'scroll']) {
    const f = fixture();
    if (kind === 'zoom') f.target.visualViewport.scale = 2;
    if (kind === 'input') f.node.closest = () => ({});
    if (kind === 'scroll') f.node.scrollWidth = 600;
    f.send('touchstart', kind === 'edge' ? 5 : 40, 100);
    if (kind === 'vertical') f.send('touchmove', 42, 130);
    if (kind === 'left') f.send('touchmove', 20, 100);
    if (kind === 'multi') f.send('touchmove', 50, 100, { touches: [{}, {}] });
    f.send('touchmove', kind === 'short' ? 80 : 160, 102);
    if (kind === 'slow') f.advance(1000);
    f.send('touchend', kind === 'short' ? 80 : 180, 105); await tick(); assert.equal(f.calls, 0, kind);
  }
});
test('native back traverses one app layer at a time, and cancelled draft close reinstates the guard', async () => {
  const f = fixture();
  f.setBack(async () => {}); f.target.history.back(); await tick();
  assert.equal(f.depth, 2); assert.equal(f.calls, 1); assert.equal(f.index, 1);
  f.setBack(null); f.target.history.back(); await tick(); assert.equal(f.depth, 1); assert.equal(f.index, 1);
  f.target.history.back(); await tick(); assert.equal(f.depth, 0); assert.equal(f.index, 0);
});
test('repeated gestures cannot skip layers while a draft confirmation is pending', async () => {
  const f = fixture(); let release; f.setBack(() => new Promise(resolve => { release = resolve; }));
  const first = f.nav.back(); await f.nav.back(); assert.equal(f.calls, 1);
  release(); await first; assert.equal(f.depth, 2);
});
