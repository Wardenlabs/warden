import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initKoolDownloads } from '../landing/kool-download.js';
import { clearAttribution } from '../landing/vendor/kool/browser.mjs';

const BASE = 'https://warden-theta.vercel.app/';
const RELEASES = 'https://github.com/Wardenlabs/warden/releases/latest';
const MAC = `${RELEASES}/download/Warden-arm64.dmg`;
const WINDOWS = `${RELEASES}/download/Warden-Setup.exe`;
const STORAGE_KEY = 'kool.attribution.v1';
const MAX_AGE = 90 * 24 * 60 * 60 * 1000;
const EVENT_ID = 'b4d957ae-f9ba-4f12-a601-f4c9411a304b';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    values,
  };
}

class Element {
  constructor(tag = 'div', attributes = {}, parent = null) {
    this.tag = tag; this.attributes = attributes; this.parentElement = parent;
    this.children = []; this.listeners = [];
  }
  closest(selector) {
    return selector === 'a[href]' && this.tag === 'a' && this.href
      ? this : this.parentElement?.closest(selector) || null;
  }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(child) { child.parentElement = this; this.children.push(child); }
  remove() { this.removed = true; }
  addEventListener(type, fn, capture = false) { this.listeners.push({ type, fn, capture }); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter(item => item.type !== type || item.fn !== fn); }
  emit(event) {
    for (const capture of [true, false]) {
      for (const listener of this.listeners.filter(item => item.type === event.type && item.capture === capture)) listener.fn(event);
    }
  }
}

function fixture({ url = BASE, storage = memoryStorage(), dnt, now = 1_800_000_000_000 } = {}) {
  const doc = new Element('document');
  doc.body = new Element('body');
  doc.createElement = tag => new Element(tag);
  const submissions = [], timers = [];
  const win = {
    document: doc, location: new URL(url), localStorage: storage,
    navigator: { doNotTrack: dnt }, crypto: { randomUUID: () => EVENT_ID },
    HTMLFormElement: { prototype: { submit() {
      submissions.push({ action: this.action, method: this.method, enctype: this.enctype,
        target: this.target, rel: this.rel, fields: Object.fromEntries(this.children.map(field => [field.name, field.value])) });
    } } },
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    fetch: () => { throw new Error('No API calls are expected in the browser'); },
  };
  let currentTime = now;
  const mount = () => initKoolDownloads({ window: win, now: () => currentTime });
  const link = (href = MAC, attributes) => Object.assign(new Element('a', attributes), { href });
  const fire = (target = link(), extra = {}) => {
    const event = { target, type: 'click', button: 0, isTrusted: true, cancelable: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...extra };
    doc.emit(event);
    return event;
  };
  return { doc, win, storage, submissions, timers, mount, link, fire, now: time => { currentTime = time; } };
}

test('arrival saves only Kool attribution and emits no download before trusted activation', () => {
  const f = fixture({ url: `${BASE}?kool_cid=opaque_click_123&utm_source=social&email=private%40example.com#private` });
  f.mount();
  assert.equal(f.submissions.length, 0);
  assert.deepEqual([...f.storage.values.keys()], [STORAGE_KEY]);
  assert.deepEqual(JSON.parse(f.storage.getItem(STORAGE_KEY)), { clickId: 'opaque_click_123', savedAt: 1_800_000_000_000 });
  for (const type of ['pointerover', 'mouseover', 'focus', 'load', 'pageview']) f.fire(f.link(), { type });
  f.fire(f.link(), { isTrusted: false });
  assert.equal(f.submissions.length, 0);
});

test('trusted nested and keyboard activations POST only the fixed contract with current attribution', () => {
  const f = fixture({ url: `${BASE}?kool_cid=opaque_click_123&email=private%40example.com` });
  f.mount();
  const link = f.link(), child = new Element('span', {}, link);
  const event = f.fire(child);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(f.submissions, [{
    action: `${BASE}api/download`, method: 'POST', enctype: 'application/x-www-form-urlencoded',
    target: '_self', rel: 'noopener',
    fields: { platform: 'macos', eventId: EVENT_ID, clickId: 'opaque_click_123' },
  }]);
  assert.equal(link.href, MAC);
  f.fire(f.link(WINDOWS), { detail: 0 });
  assert.equal(f.submissions[1].fields.platform, 'windows');
  assert.equal(JSON.stringify(f.submissions).includes('private'), false);
});

test('official attribution persists to another page without a query and expires at 90 days', () => {
  const first = fixture({ url: `${BASE}?kool_cid=referral_123` });
  const mounted = first.mount();
  mounted.destroy();
  const next = fixture({ url: `${BASE}index.html`, storage: first.storage, now: 1_800_000_000_001 });
  next.mount(); next.fire();
  assert.equal(next.submissions[0].fields.clickId, 'referral_123');
  next.now(1_800_000_000_000 + MAX_AGE - 1); next.fire();
  assert.equal(next.submissions[1].fields.clickId, 'referral_123');
  next.now(1_800_000_000_000 + MAX_AGE); next.fire();
  assert.equal(next.submissions[2].fields.clickId, undefined);
  assert.equal(first.storage.getItem(STORAGE_KEY), null);
});

test('invalid query identifiers never enter storage or request fields', () => {
  for (const invalid of ['private@example.com', 'two words', 'a'.repeat(129), 'https://private.test', '../private', '']) {
    const f = fixture({ url: `${BASE}?kool_cid=${encodeURIComponent(invalid)}` });
    f.mount(); f.fire();
    assert.equal(f.storage.getItem(STORAGE_KEY), null);
    assert.deepEqual(f.submissions[0].fields, { platform: 'macos', eventId: EVENT_ID });
  }
});

test('malformed, expired, future, and invalid stored attribution never enters a request', () => {
  for (const saved of ['not json', JSON.stringify({ clickId: 'bad@example.com', savedAt: 1_800_000_000_000 }),
    JSON.stringify({ clickId: 'valid_123', savedAt: 1_800_000_000_001 }),
    JSON.stringify({ clickId: 'valid_123', savedAt: 1_800_000_000_000 - MAX_AGE })]) {
    const f = fixture();
    f.storage.setItem(STORAGE_KEY, saved); f.mount(); f.fire();
    assert.equal(f.submissions[0].fields.clickId, undefined);
  }
});

test('an invalid later URL does not overwrite a valid saved referral', () => {
  const first = fixture({ url: `${BASE}?kool_cid=valid_referral` }); first.mount();
  const next = fixture({ url: `${BASE}?kool_cid=private%40example.com`, storage: first.storage });
  next.mount(); next.fire();
  assert.equal(next.submissions[0].fields.clickId, 'valid_referral');
});

test('blocked storage retains valid current-page attribution without throwing', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  const f = fixture({ url: `${BASE}?kool_cid=current_page_only`, storage: blocked });
  f.mount(); f.fire();
  assert.equal(f.submissions[0].fields.clickId, 'current_page_only');
  f.now(1_800_000_000_000 + MAX_AGE); f.fire();
  assert.equal(f.submissions[1].fields.clickId, undefined);
});

test('unavailable localStorage property falls back to current-page memory', () => {
  clearAttribution({ storage: null });
  const f = fixture({ url: `${BASE}?kool_cid=memory_referral` });
  Object.defineProperty(f.win, 'localStorage', { get() { throw new Error('blocked'); } });
  f.mount(); f.fire();
  assert.equal(f.submissions[0].fields.clickId, 'memory_referral');
  clearAttribution({ storage: null });
});

test('read-only storage prefers the newer current-page referral over stale persistence', () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ clickId: 'old_referral', savedAt: 1_799_999_999_000 }));
  storage.setItem = () => { throw new Error('read only'); };
  const f = fixture({ url: `${BASE}?kool_cid=new_referral`, storage });
  f.mount(); f.fire();
  assert.equal(f.submissions[0].fields.clickId, 'new_referral');
});

test('each submission snapshots attribution and generates a separate result identifier', () => {
  const f = fixture({ url: `${BASE}?kool_cid=first_referral` });
  f.mount(); f.fire();
  f.storage.setItem(STORAGE_KEY, JSON.stringify({ clickId: 'second_referral', savedAt: 1_800_000_000_001 }));
  f.now(1_800_000_000_001);
  f.win.crypto.randomUUID = () => '9ee12f70-1a53-49d1-8b08-a0d65b7cbe8b';
  f.fire();
  assert.deepEqual(f.submissions.map(item => item.fields.clickId), ['first_referral', 'second_referral']);
  assert.notEqual(f.submissions[0].fields.eventId, f.submissions[1].fields.eventId);
});

test('only the exact macOS and Windows installer URLs can trigger a submission', () => {
  const f = fixture(); f.mount();
  for (const href of [RELEASES, '#download', 'https://github.com/Wardenlabs/warden', `${MAC}?email=private`, `${MAC}#extra`,
    `${RELEASES}/download/unknown.exe`, MAC.replace('github.com/', 'github.com.evil.test/'),
    MAC.replace('https:', 'http:'), 'javascript:void(0)', `${RELEASES}/download/Warden.AppImage`]) {
    assert.equal(f.fire(f.link(href)).defaultPrevented, false);
  }
  f.fire(new Element('button'));
  assert.equal(f.submissions.length, 0);
});

test('modifier and middle-button activations preserve a separate browsing context', () => {
  const f = fixture(); f.mount();
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { type: 'auxclick', button: 1 }]) {
    assert.equal(f.fire(f.link(), extra).defaultPrevented, true);
  }
  f.fire(f.link(MAC, { target: '_blank' }));
  assert.deepEqual(f.submissions.map(item => item.target), Array(5).fill('_blank'));
  assert.ok(f.submissions.every(item => item.rel === 'noopener'));
});

test('alternative native actions and canceled events retain their original navigation', () => {
  const f = fixture(); f.mount();
  for (const extra of [{ altKey: true }, { button: 2 }, { type: 'auxclick', button: 2 }, { button: 1 },
    { cancelable: false }, { defaultPrevented: true }]) f.fire(f.link(), extra);
  f.fire(f.link(MAC, { target: 'named_window' }));
  f.fire(f.link(MAC, { download: '' }));
  assert.equal(f.submissions.length, 0);
});

test('DNT prevents attribution capture and submissions while preserving downloads', () => {
  for (const dnt of ['1', 'yes', 'YES']) {
    const f = fixture({ url: `${BASE}?kool_cid=valid_referral`, dnt });
    f.mount();
    assert.equal(f.storage.getItem(STORAGE_KEY), null);
    assert.equal(f.fire().defaultPrevented, false);
    assert.equal(f.submissions.length, 0);
  }
  const f = fixture({ url: `${BASE}?kool_cid=valid_referral` }); f.mount();
  f.win.navigator.doNotTrack = '1';
  assert.equal(f.fire().defaultPrevented, false);
  assert.equal(f.submissions.length, 0);
});

test('window and legacy navigator DNT preferences are honored', () => {
  for (const source of ['window', 'navigator']) {
    const f = fixture({ url: `${BASE}?kool_cid=valid_referral` });
    if (source === 'window') f.win.doNotTrack = 'yes';
    else f.win.navigator.msDoNotTrack = '1';
    f.mount(); f.fire();
    assert.equal(f.storage.getItem(STORAGE_KEY), null);
    assert.equal(f.submissions.length, 0);
  }
});

test('synchronous enhancement failures leave the original anchor action intact', () => {
  for (const breakEnhancement of [
    f => { delete f.win.crypto; },
    f => { f.win.crypto.randomUUID = () => { throw new Error('unavailable'); }; },
    f => { f.doc.createElement = () => { throw new Error('unavailable'); }; },
    f => { f.doc.body.append = () => { throw new Error('unavailable'); }; },
    f => { f.win.HTMLFormElement.prototype.submit = () => { throw new Error('unavailable'); }; },
  ]) {
    const f = fixture(); f.mount(); breakEnhancement(f);
    const anchor = f.link();
    assert.equal(f.fire(anchor).defaultPrevented, false);
    assert.equal(anchor.href, MAC);
    assert.equal(f.submissions.length, 0);
  }
});

test('capture-phase analytics continues seeing the unchanged link and is not stopped', () => {
  const f = fixture(), observed = [];
  f.doc.addEventListener('click', event => observed.push({ href: event.target.href, prevented: event.defaultPrevented }), true);
  f.mount();
  f.doc.addEventListener('click', () => observed.push('later listener'));
  f.fire();
  assert.deepEqual(observed, [{ href: MAC, prevented: false }, 'later listener']);
});

test('mounting is idempotent, repeated handling deduplicates an event, and teardown restores fallback', () => {
  const f = fixture(), controller = f.mount();
  assert.equal(f.mount(), controller);
  const event = f.fire(); f.doc.emit(event);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.doc.body.children[0].removed, undefined);
  assert.equal(f.timers[0].delay, 60_000);
  f.timers[0].fn();
  assert.equal(f.doc.body.children[0].removed, true);
  controller.destroy();
  assert.equal(f.fire().defaultPrevented, false);
  assert.equal(f.submissions.length, 1);
});

test('landing loads Kool independently while keeping static installer links and platform rewriting', async () => {
  const [html, app, entry] = await Promise.all(['../landing/index.html', '../landing/app.js', '../landing/kool-entry.js']
    .map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  assert.match(html, /<script type="module" src="kool-entry\.js\?v=download-1"><\/script>/);
  assert.ok(html.includes(`href="${MAC}"`)); assert.ok(html.includes(`href="${WINDOWS}"`));
  assert.match(app, /data-platform-download/);
  assert.match(entry, /initKoolDownloads/);
  assert.doesNotMatch(entry, /app\.js|analytics\.js|fetch\(/);
});
