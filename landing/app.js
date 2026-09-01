/*
 * Everything on this page that needs JavaScript: the light in the hero, the
 * prompt that types itself under it, reveal-on-scroll, the relay through
 * §how, and naming the visitor's platform on the download button.
 *
 * No build step and no dependencies — see README.md. These are ES modules
 * served from the same origin, which is the same property the console has:
 * a page about not sending things over the network should not be fetching a
 * framework to render a headline.
 */

import { mountLight } from './light.js';

/* Tell the watchdog in <head> that the module got here, so it leaves the
   reveal-on-scroll hiding in place. If this line is never reached the page
   un-hides itself rather than staying blank. */
window.__wardenReady = true;

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── the light ─────────────────────────────────────────────────────────── */

const zone = document.querySelector('.hero-zone');
let light = null;
try {
  light = mountLight(zone);
} catch (err) {
  zone?.classList.add('nogl');
  console.warn(err.message);
}

/* ── the prompt being judged ───────────────────────────────────────────── */
/*
 * The markup already holds the finished state — prompt typed, verdict shown —
 * so the hero reads without this. With it, the line types itself once, is
 * judged, and stays: the gate turns and holds. A verdict that kept resetting
 * read as a screensaver. Under reduced motion the finished state simply stays.
 *
 * The timings were halved. At 900ms before the first character and 38-78ms
 * between them the hero took about three and a half seconds to say anything,
 * which is longer than a visitor gives a page they have not decided about yet
 * — the whole sequence was landing after the scroll had already started. It
 * now reaches the verdict in under two, which is still slower than a person
 * types and no longer slower than a person waits.
 */

const judge = document.getElementById('judge');

if (judge && !reduced) {
  const typed = judge.querySelector('.typed');
  const text = typed.textContent;
  const verdict = (on) => {
    judge.classList.toggle('judged', on);
    zone?.classList.toggle('judged', on);
    light?.set(on);
  };

  verdict(false);
  typed.textContent = '';
  let i = 0;
  const step = () => {
    if (i < text.length) {
      typed.textContent = text.slice(0, ++i);
      setTimeout(step, 20 + Math.random() * 26);
    } else {
      setTimeout(() => verdict(true), 380);
    }
  };
  setTimeout(step, 320);
}

/* ── the policy being written ──────────────────────────────────────────── */
/*
 * One sentence, the way somebody would actually say it, and the specific rules
 * it turns out to have meant landing under it one at a time.
 *
 * This is `compilePolicy` in src/policy/compile.ts and not a liberty the page
 * is taking: a splitting pass turns a worry into separate concrete
 * prohibitions, `compileRule` compiles each of them, and the administrator
 * ratifies them one at a time in the console. The animation is allowed to be
 * quick; it is not allowed to be a different product, and the earlier version
 * of this stage typed three sentences precisely because at that point the
 * compiler could only take one at a time.
 *
 * Fast on purpose — a mechanism being shown, not a person being watched. With
 * no JavaScript the box holds the sentence and all three rules are already
 * there, which is the contract the hero has too.
 */

const ruleBox = document.getElementById('ruleMsg');
const ruleSet = document.getElementById('ruleSet');
const sendBtn = document.querySelector('#how .composer .send');
const rules = ruleSet ? [...ruleSet.children] : [];

/* Reduced motion, or no IntersectionObserver: the finished state, immediately.
   The rules are hidden by CSS as soon as `.js` is on, so something has to say
   otherwise or they never arrive at all. */
if (reduced || !('IntersectionObserver' in window)) rules.forEach((r) => r.classList.add('on'));

if (ruleBox && rules.length && !reduced && 'IntersectionObserver' in window) {
  const sentence = ruleBox.value;
  ruleBox.value = '';

  const wait = (ms) => new Promise((done) => setTimeout(done, ms));

  const type = () =>
    new Promise((done) => {
      let i = 0;
      const step = () => {
        if (i >= sentence.length) return done();
        ruleBox.value = sentence.slice(0, ++i);
        setTimeout(step, 9 + Math.random() * 14);
      };
      step();
    });

  const run = async () => {
    await type();
    await wait(200);
    /* 130ms of the button's own pressed state and nothing else. A spinner
       would be a claim about how long compiling takes, and on the machine this
       runs on that number is 46 seconds. */
    sendBtn?.classList.add('pressed');
    await wait(130);
    sendBtn?.classList.remove('pressed');
    for (const rule of rules) {
      await wait(380);
      rule.classList.add('on');
    }
  };

  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      setTimeout(run, 240);
    },
    { threshold: 0.4 }
  );
  io.observe(ruleBox);
}

/* ── reveal on scroll ──────────────────────────────────────────────────── */

const revealables = document.querySelectorAll('[data-reveal]');

if (reduced || !('IntersectionObserver' in window)) {
  revealables.forEach((el) => el.classList.add('is-in'));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.05 }
  );
  // The stages in §how are lit by the relay below, in order — not here.
  revealables.forEach((el) => { if (!el.closest('#how .stages')) io.observe(el); });
}

/* ── the relay through §how ────────────────────────────────────────────── */
/*
 * What used to be a line of light drawn down the middle is now order in
 * time. Each stage lights when it arrives, and stages arriving together are
 * spaced a beat apart, so a fast scroll still reads as one event passing
 * through three places rather than three panels appearing at once. When the
 * refusal lands in 02, the rule written in 01 takes the hit for a moment —
 * the claim the drawn line was making, told by the content instead.
 *
 * Under reduced motion, or with no IntersectionObserver, the generic reveal
 * path above has already shown everything and none of this runs.
 */

const stages = document.querySelector('#how .stages');
const steps = stages ? [...stages.querySelectorAll(':scope > .stage')] : [];

if (steps.length && !reduced && 'IntersectionObserver' in window) {
  const rule = document.getElementById('ruleMsg');
  const BEAT = 620;
  let lastLit = 0;

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        io.unobserve(entry.target);
        const at = Math.max(performance.now(), lastLit + BEAT);
        lastLit = at;
        setTimeout(() => {
          entry.target.classList.add('is-in');
          entry.target.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-in'));
          if (entry.target.classList.contains('stops') && rule) {
            setTimeout(() => rule.classList.add('hit'), 360);
            setTimeout(() => rule.classList.remove('hit'), 1600);
          }
        }, at - performance.now());
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.12 }
  );
  steps.forEach((s) => io.observe(s));
}

/* ── name the platform on the hero button ──────────────────────────────── */
/*
 * The button names the visitor's platform and the quiet link beside it names
 * the other one. Windows is the only case worth branching for; everything
 * else keeps the macOS default. The sizes are carried over from v0.1.3 and are
 * approximate until the v0.1.4 build lands — nothing in this repo reads them
 * off the release, so they are a number a person has to come back and correct.
 * That is the honest cost of a static page with no build step, and it is worth
 * knowing which numbers on it have that property.
 */

const RELEASE = 'https://github.com/Wardenlabs/warden/releases/download/v0.1.4/';
const MAC = { label: 'Download for macOS', size: '217 MB', file: 'Warden-0.1.4-arm64.dmg', other: 'Also on macOS' };
const WIN = { label: 'Download for Windows', size: '287 MB', file: 'Warden-Setup.exe', other: 'Also on Windows' };

const primary = document.querySelector('.hero .btn-primary');
const alt = document.querySelector('.hero .cta .alt');
const onWindows = /Windows|Win64|Win32/i.test(navigator.userAgent || '');

if (primary && alt && onWindows) {
  primary.classList.add('on-windows');
  primary.querySelector('.txt').textContent = WIN.label;
  primary.querySelector('.sz').textContent = WIN.size;
  primary.setAttribute('href', RELEASE + WIN.file);
  alt.textContent = MAC.other;
  alt.setAttribute('href', RELEASE + MAC.file);
}

/* And in the footer, where both installers are shown: the visitor's platform
   goes first. Order, not emphasis — they are the same download either way. */
const foot = document.querySelector('.foot .dl');
if (foot && onWindows) foot.prepend(foot.lastElementChild);
