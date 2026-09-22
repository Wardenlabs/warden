import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  sanitizeUTMs, analyticsMode, classifyLink, isUserClick, mergePlayed, createVideoTracker,
  commonProperties, makeBeforeSend, posthogOptions, createEventQueue, initAnalytics,
} from '../landing/analytics.js';

const base = 'https://warden-theta.vercel.app/';
const token = 'phc_fixture_public_token_only';
const config = { enabled: true, projectToken: token, apiHost: 'https://us.i.posthog.com', productionHosts: ['warden-theta.vercel.app'] };
const github = 'https://github.com/Wardenlabs/warden';

test('campaign fields permit only four bounded, normalized labels', () => {
  assert.deepEqual(sanitizeUTMs('?utm_source=X&utm_medium=Social&utm_campaign=launch-v1&utm_content=clip_1&utm_term=private&email=ana@example.com'),
    { utm_source: 'x', utm_medium: 'social', utm_campaign: 'launch-v1', utm_content: 'clip_1' });
  assert.deepEqual(sanitizeUTMs(`?utm_source=ana%40example.com&utm_campaign=${'a'.repeat(61)}&utm_content=two%20words`), {});
});

test('only actual supported release assets count as downloads', () => {
  assert.deepEqual(classifyLink(`${github}/releases/latest/download/Warden-arm64.dmg`, base, 'hero'),
    { name: 'download_clicked', props: { placement: 'hero', platform: 'macos' } });
  assert.equal(classifyLink(`${github}/releases/latest/download/Warden-Setup.exe?source=private`, base, 'download').props.platform, 'windows');
  assert.equal(classifyLink('#download', base, 'header').name, 'download_options_opened');
  assert.equal(classifyLink(`${github}/releases/latest`, base).name, 'release_page_opened');
  assert.equal(classifyLink(`${github}/releases/latest/download/unknown.dmg`, base), null);
  assert.equal(classifyLink('https://github.com.evil.test/Wardenlabs/warden/releases/latest/download/Warden-arm64.dmg', base), null);
  assert.equal(classifyLink('javascript:alert(1)', base), null);
  assert.equal(classifyLink(`${github}/blob/main/REPORT.md`, base).props.destination, 'report');
  assert.equal(classifyLink(`${github}/blob/main/BENCHMARKS.md`, base).props.destination, 'benchmarks');
});

test('production allowlist, explicit local test, DNT and debug boundaries', () => {
  const mode = (url, override = {}, dnt) => analyticsMode({ ...config, ...override }, new URL(url), dnt);
  assert.equal(mode(base).network, true);
  assert.equal(mode('http://localhost:8773/').active, false);
  assert.equal(mode('http://localhost:8773/?analytics_test=1').isTest, true);
  assert.equal(mode('http://localhost:8773/?analytics_test=1').network, true);
  assert.equal(mode('https://warden-preview.vercel.app/?analytics_test=1').active, false);
  assert.equal(mode('http://localhost:8773/?analytics_test=1', { enabled: false }).network, false);
  assert.equal(mode('http://localhost:8773/', { projectToken: '', debug: true }).network, false);
  assert.equal(mode('http://localhost:8773/', { projectToken: '', debug: true }).active, true);
  assert.equal(mode(base, {}, '1').active, false);
});

test('before_send drops unknown events and all SDK-added sensitive properties', () => {
  const location = new URL(`${base}?utm_source=X&email=private#secret`);
  const referrer = 'https://search.example/path?query=private';
  const common = commonProperties(location, referrer, true);
  const before = makeBeforeSend(common, location, referrer, token);
  const result = before({ event: 'download_clicked', raw_url: 'secret', properties: {
    platform: 'macos', placement: 'hero', email: 'private@example.com', text: 'Ana salary',
    $current_url: location.href, $referrer: referrer, $initial_current_url: location.href,
    distinct_id: 'personal-id', $device_id: 'personal-device', utm_term: 'salary', $set: { email: 'private' },
  } });
  assert.equal(result.properties.$current_url, 'https://warden-theta.vercel.app');
  assert.equal(result.properties.$referrer, 'https://search.example');
  assert.equal(result.properties.distinct_id, '$posthog_cookieless');
  assert.equal(result.properties.$cookieless_mode, true);
  assert.equal(result.properties.is_test, true);
  assert.equal(result.properties.utm_source, 'x');
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(result.raw_url, undefined);
  assert.equal(before({ event: '$autocapture', properties: {} }), null);
  assert.equal(before({ event: '$pageleave', properties: {} }), null);
  const options = posthogOptions(config, before, () => {});
  for (const key of ['capture_pageview', 'capture_pageleave', 'autocapture', 'capture_performance', 'capture_heatmaps', 'capture_exceptions']) assert.equal(options[key], false);
  for (const key of ['disable_persistence', 'disable_session_recording', 'disable_surveys', 'advanced_disable_flags', 'respect_dnt']) assert.equal(options[key], true);
});

test('cookieless transport preserves required UA/host while discarding client identities and unsafe metadata', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36';
  const common = commonProperties(new URL(base), '', true, 'warden_story_v2');
  const before = makeBeforeSend(common, new URL(base), '', token, ua);
  const result = before({ event: '$pageview', properties: {
    $raw_user_agent: 'untrusted override', $browser: 'Chrome', $os: 'Mac OS X', $device_type: 'Desktop',
    $session_id: 'client-session', $device_id: 'client-device', $window_id: 'client-window',
    $browser_version: 151, $timezone: 'private', $cookieless_extra: 'identity', $ip: 'private',
  } }).properties;
  assert.equal(result.$raw_user_agent, ua);
  assert.equal(result.$host, 'warden-theta.vercel.app');
  assert.equal(result.$cookieless_mode, true);
  assert.equal(result.distinct_id, '$posthog_cookieless');
  assert.equal(result.site_version, 'warden_story_v2');
  for (const key of ['$session_id', '$device_id', '$window_id', '$browser_version', '$timezone', '$cookieless_extra', '$ip']) assert.equal(result[key], undefined);
  assert.equal(result.$browser, 'Chrome'); assert.equal(result.$os, 'Mac OS X'); assert.equal(result.$device_type, 'Desktop');
  const withoutNavigatorUA = makeBeforeSend(common, new URL(base), '', token);
  assert.equal(withoutNavigatorUA({ event: '$pageview', properties: { $raw_user_agent: ua } }).properties.$raw_user_agent, ua);
  for (const invalid of ['a'.repeat(513), 'Mozilla\nInjected: value', '\u0000Mozilla']) {
    const props = withoutNavigatorUA({ event: '$pageview', properties: { $raw_user_agent: invalid, $browser: 'email@example.com', $os: 'secret' } }).properties;
    assert.equal(props.$raw_user_agent, undefined); assert.equal(props.$browser, undefined); assert.equal(props.$os, undefined);
  }
  assert.equal(commonProperties(new URL(base), '', false, 'https://private').site_version, 'warden_story_v1');
});

test('played coverage uses a union; seeks and replayed overlaps do not inflate it', () => {
  assert.deepEqual(mergePlayed([[0, 20], [15, 30], [45, 60], [50, 55], [NaN, 5], [-10, 1]], 100), [[0, 30], [45, 60]]);
  const events = [], tracker = createVideoTracker((name, props) => events.push([name, props]));
  tracker.playing({ isTrusted: true }); // An autoplay is not a user-opened film.
  tracker.progress([[0, 100]], 100, true);
  assert.equal(events.length, 0);
  tracker.open(); tracker.playing({ isTrusted: false });
  assert.equal(events.length, 0);
  tracker.playing({ isTrusted: true }); tracker.playing({ isTrusted: true });
  tracker.progress([[0, 3], [99, 100]], 100, true); // Seek to the end.
  assert.deepEqual(events.map(x => x[0]), ['video_started']);
  tracker.progress([[0, 50]], 100);
  tracker.progress([[0, 50]], 100);
  tracker.progress([[0, 91]], 100, true);
  tracker.progress([[0, 100]], 100, true);
  assert.deepEqual(events.filter(x => x[0] === 'video_progress').map(x => x[1].percent), [25, 50, 75, 90]);
  assert.equal(events.filter(x => x[0] === 'video_completed').length, 1);
});

test('event queue is bounded, replays early events once and tolerates adapter failure', () => {
  const queue = createEventQueue(3), events = [];
  for (const name of ['first', 'second', 'third', 'excess']) queue.push(name, {});
  assert.equal(queue.pending().length, 3);
  queue.attach(() => { throw new Error('blocked'); });
  assert.equal(queue.pending().length, 3);
  queue.attach(name => events.push(name)); queue.attach(name => events.push(name));
  queue.push('later', {});
  assert.deepEqual(events, ['first', 'second', 'third', 'later']);
});

// Minimal event/clock fixtures exercise the public initializer without a browser,
// SDK, cookies, real downloads or instrumentation of the story implementation.
class Element {
  constructor(selectors = [], attributes = {}, parent = null) {
    this.selectors = selectors; this.attributes = attributes; this.parentElement = parent;
    this.dataset = {}; this.listeners = new Map(); this.style = {}; this.children = [];
  }
  addEventListener(type, fn) { const all = this.listeners.get(type) || []; all.push(fn); this.listeners.set(type, all); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x !== fn)); }
  emit(type, event) { event.type = type; for (const fn of this.listeners.get(type) || []) fn(event); }
  matches(selector) { return selector.split(',').some(part => this.selectors.includes(part.trim())); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(element) { this.children.push(element); }
  remove() { this.removed = true; }
}

function fixture(url = 'http://localhost:8773/', extra = {}) {
  let now = 0, next = 0;
  const timers = new Map(), nodes = new Map(), events = [], observers = [];
  const doc = new Element(), win = new Element();
  doc.hidden = false; doc.referrer = 'https://x.com/private?search=secret';
  doc.body = new Element(); doc.head = new Element();
  doc.createElement = () => new Element(); doc.querySelector = selector => nodes.get(selector) || null;
  doc.getElementById = id => nodes.get(`#${id}`) || null;
  win.document = doc; win.location = new URL(url); win.navigator = {};
  win.setTimeout = (fn, delay) => { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; };
  win.clearTimeout = id => timers.delete(id);
  win.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    unobserve(target) { this.targets = this.targets.filter(x => x !== target); }
    disconnect() { this.targets = []; }
  };
  const advance = milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const due = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = end;
  };
  return { win, doc, nodes, events, observers, advance, start: () => initAnalytics({ debug: true, ...extra },
    { window: win, document: doc, capture: (name, props) => events.push({ name, props }) }) };
}

test('native click delegation counts once, ignores synthetic/automatic changes, and keeps navigation untouched', () => {
  const f = fixture(), controller = f.start(); f.start();
  const hero = new Element(['.hero-zone']);
  const link = new Element(['a[href]'], {}, hero); link.href = `${github}/releases/latest/download/Warden-Setup.exe`;
  const icon = new Element([], {}, link);
  const event = { isTrusted: true, button: 0, target: icon, preventDefault() { assert.fail('native link intercepted'); } };
  f.doc.emit('click', event); f.doc.emit('click', event);
  f.doc.emit('click', { ...event, isTrusted: false });
  f.doc.emit('click', { ...event, button: 1 });
  f.doc.emit('auxclick', { ...event, button: 1 });
  f.doc.emit('pointerdown', { ...event });
  assert.equal(f.events.filter(x => x.name === '$pageview').length, 1);
  assert.equal(f.events.filter(x => x.name === 'download_clicked').length, 2);
  const radio = new Element(['input[type="radio"][name="tool"]']); radio.id = 'tool-cx'; radio.checked = true;
  f.doc.emit('change', { target: radio, isTrusted: false });
  f.doc.emit('change', { target: radio, isTrusted: true });
  assert.deepEqual(f.events.filter(x => x.name === 'tool_selected').map(x => x.props.tool), ['codex']);
  const chapter = new Element(['[data-chapter]']); chapter.dataset.chapter = 'write';
  const button = new Element(['[data-story-step]'], {}, chapter); button.dataset.storyStep = '2';
  f.doc.emit('click', { isTrusted: false, button: 0, target: button });
  f.doc.emit('click', { isTrusted: true, button: 0, target: button });
  assert.equal(f.events.filter(x => x.name === 'story_step_selected').length, 1);
  assert.equal(f.doc.head.children.length, 0); // Local debug never loads the SDK.
  controller.destroy(); f.doc.emit('click', { ...event });
  assert.equal(f.events.filter(x => x.name === 'download_clicked').length, 2);
});

test('section dwell requires 800 continuous visible milliseconds and cancels when hidden or out of view', () => {
  const f = fixture(), panel = new Element(); f.nodes.set('[data-chapter="write"] .panel', panel); f.start();
  const enter = visible => f.observers[0].callback([{ target: panel, isIntersecting: visible, intersectionRatio: visible ? .6 : 0 }]);
  enter(true); f.advance(500); enter(false); f.advance(600);
  assert.equal(f.events.filter(x => x.name === 'section_viewed').length, 0);
  enter(true); f.advance(500); f.doc.hidden = true; f.doc.emit('visibilitychange', {}); f.advance(1000);
  assert.equal(f.events.filter(x => x.name === 'section_viewed').length, 0);
  f.doc.hidden = false; f.doc.emit('visibilitychange', {}); f.advance(799);
  assert.equal(f.events.filter(x => x.name === 'section_viewed').length, 0);
  f.advance(1); enter(true); f.advance(1000);
  assert.deepEqual(f.events.filter(x => x.name === 'section_viewed').map(x => x.props.section), ['story_write']);
});

test('queued SDK pageview reaches the sanitizer with the browser transport input and test flag', () => {
  const f = fixture('http://localhost:8773/?analytics_test=1&utm_source=x'), sent = [];
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/151.0.0.0 Safari/537.36';
  f.win.navigator.userAgent = ua;
  let options;
  f.win.posthog = { init(receivedToken, receivedOptions) {
    assert.equal(receivedToken, token); options = receivedOptions;
    options.loaded({ capture(name, props) { sent.push(options.before_send({ event: name, properties: props })); } });
  } };
  const controller = initAnalytics(config, { window: f.win, document: f.doc });
  assert.equal(f.doc.head.children.length, 1);
  assert.equal(f.doc.head.children[0].src, 'https://us-assets.i.posthog.com/static/array.js');
  f.doc.head.children[0].onload();
  assert.equal(sent.length, 1); assert.equal(sent[0].event, '$pageview');
  assert.equal(sent[0].properties.$raw_user_agent, ua);
  assert.equal(sent[0].properties.$host, 'localhost');
  assert.equal(sent[0].properties.is_test, true);
  assert.equal(options.capture_pageview, false); assert.equal(options.capture_pageleave, false);
  controller.destroy();
});

test('current HTML still exposes the instrumented native controls and known assets', async () => {
  const html = await readFile(new URL('../landing/index.html', import.meta.url), 'utf8');
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  const downloads = hrefs.map(href => classifyLink(href, base)).filter(x => x?.name === 'download_clicked');
  assert.equal(downloads.length, 3);
  assert.match(html, /href="#download" class="nav-download"/);
  assert.ok(html.includes(`"softwareVersion": "${version}"`));
  assert.ok(html.includes(`"releaseNotes": "https://github.com/Wardenlabs/warden/releases/tag/v${version}"`));
  // The release version remains in the download section; the hero keeps only the free/open-source line.
  assert.equal(html.split(`v${version} · Free and open source.`).length - 1, 1);
  const guide = await readFile(new URL('../landing/how-it-works.html', import.meta.url), 'utf8');
  assert.ok(html.includes('href="/how-it-works"'));
  for (const chapter of ['write', 'hit', 'log', 'spend']) assert.ok(guide.includes(`data-chapter="${chapter}"`));
  for (const id of ['tool-cc', 'tool-cx', 'tool-oc']) assert.ok(guide.includes(`id="${id}"`));
  for (const id of ['launch-video', 'example-private', 'example-public']) assert.ok(html.includes(`id="${id}"`));
  assert.ok(html.includes('data-open-film')); assert.ok(guide.includes('data-story-replay'));
  assert.equal(isUserClick({ isTrusted: true, type: 'auxclick', button: 2 }), false);
});
