import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../landing/surface-motion.js', import.meta.url), 'utf8');
function setup({ reduced = false, supportsObserver = true } = {}) {
  const classes = new Set();
  const surface = { classList: {
    remove: name => classes.delete(name),
    toggle: (name, active) => active ? classes.add(name) : classes.delete(name),
  } };
  const listeners = {};
  const preference = { matches: reduced, addEventListener: (_, callback) => { listeners.preference = callback; } };
  const document = { hidden: false, querySelectorAll: () => [surface], addEventListener: (name, callback) => { listeners[name] = callback; } };
  const observers = [];
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  runInNewContext(source, { document, matchMedia: () => preference, IntersectionObserver,
    window: supportsObserver ? { IntersectionObserver } : {} });
  return { classes, surface, preference, document, listeners, observers,
    intersect(active) { observers.at(-1).callback([{ target: surface, isIntersecting: active }]); } };
}
test('illustration runs only when visible and cancels when the tab is hidden', () => {
  const state = setup();
  state.intersect(true);
  assert.ok(state.classes.has('motion-visible'));
  state.intersect(false);
  assert.equal(state.classes.size, 0);
  state.intersect(true);
  state.document.hidden = true;
  state.listeners.visibilitychange();
  assert.equal(state.classes.size, 0);
  state.intersect(true);
  assert.equal(state.classes.size, 0);
});
test('reduced motion cancels current effects and ignores delayed observer events', () => {
  const state = setup();
  state.intersect(true);
  state.preference.matches = true;
  state.listeners.preference();
  state.intersect(true);
  assert.equal(state.classes.size, 0);
  assert.ok(state.observers[0].disconnected);
  state.preference.matches = false;
  state.listeners.preference();
  state.intersect(true);
  assert.ok(state.classes.has('motion-visible'));
});
test('static fallback does not depend on observation or motion permission', () => {
  for (const options of [{ reduced: true }, { supportsObserver: false }]) {
    const state = setup(options);
    assert.equal(state.observers.length, 0);
    assert.equal(state.classes.size, 0);
  }
});
