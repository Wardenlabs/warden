import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('idle motion pauses offscreen, respects reduced motion and releases its frame on teardown', async () => {
  const source = (await readFile(new URL('../landing/shield.js', import.meta.url), 'utf8'))
    .replace('export function mountShield', 'function mountShield')
    .replace("import('./assets/3d/three.module.js')", 'Promise.resolve({})')
    .replace("import('./assets/3d/official-shield.js?v=idle-1')", 'Promise.resolve({createShield: () => sceneStub})');
  const events = new Map(), frames = new Map(), draws = [];
  let nextFrame = 0, observerCallback, preferenceCallback;
  const preference = { matches: false, addEventListener(_, callback) { preferenceCallback = callback; }, removeEventListener() {} };
  const canvas = { style: {}, setAttribute() {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ width: 300, height: 300 }) };
  const fallback = { style: {} };
  const container = { dataset: {}, closest: () => null, querySelector: selector => selector === 'canvas' ? canvas : fallback, addEventListener() {}, removeEventListener() {} };
  const document = { hidden: false, addEventListener: (key, cb) => events.set(key, cb), removeEventListener: key => events.delete(key) };
  const sceneStub = { resize() {}, renderAt: (time, pose) => draws.push({ time, ...pose }), dispose() {}, projectedBounds() {} };
  class Observer { constructor(cb) { observerCallback = cb; } observe() {} disconnect() {} }
  const window = { devicePixelRatio: 1, IntersectionObserver: Observer, matchMedia: query => query.includes('reduced') ? preference : { matches: false, addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window, document, IntersectionObserver: Observer, sceneStub,
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id) });
  vm.runInContext(source + '\nthis.mountShield = mountShield;', context);
  const shield = context.mountShield(container);
  observerCallback([{ isIntersecting: true }]);
  assert.equal(await shield.ready, true);
  for (let time = 34; time < 6500; time += 34) {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(time));
  }
  assert.ok(draws.at(-1).idleSeconds > 1, 'idle motion continues after the entrance');
  assert.equal(frames.size, 1);
  observerCallback([{ isIntersecting: false }]);
  assert.equal(frames.size, 0, 'offscreen work stops');
  observerCallback([{ isIntersecting: true }]);
  assert.equal(frames.size, 1);
  document.hidden = true; events.get('visibilitychange')();
  assert.equal(frames.size, 0, 'hidden tabs stop');
  document.hidden = false; events.get('visibilitychange')();
  preference.matches = true; preferenceCallback();
  assert.equal(frames.size, 0, 'reduced motion has no loop');
  assert.equal(draws.at(-1).idleSeconds, 0);
  preference.matches = false; preferenceCallback();
  assert.equal(frames.size, 1);
  shield.destroy();
  assert.equal(frames.size, 0);
  assert.equal(events.size, 0);
});
