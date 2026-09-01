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

/* ── the rule being written, and the rule that comes back ─────────────── */
/*
 * Same contract as the hero: the markup holds the finished state, so with no
 * JavaScript the box shows the sentence already written and the compiled rule
 * under it is already open. With it, the stage plays once when it arrives —
 * not on load, because it is three screens down and would be over before
 * anyone got there.
 *
 * It types the rule the way a person would say it out loud, presses the
 * button, and a beat later the card opens. That beat is the only claim this
 * stage makes and it is worth spending a timer on: a card that were simply
 * present would read as a second screenshot placed under the first, and what
 * the reader has to see is that one produced the other.
 *
 * The card is `r-payroll` out of data/seed, field for field. Nothing here is
 * generated in the browser — the page has no model in it, and a fake compiler
 * on a page arguing that inference happens on the employee's machine would be
 * the wrong kind of demo.
 */

const ruleBox = document.getElementById('ruleMsg');
const ruleOut = document.getElementById('ruleOut');
const sendBtn = document.querySelector('#how .composer .send');

/* Reduced motion, or a browser with no IntersectionObserver, gets the finished
   state immediately — including the card, which is hidden by CSS the moment
   `.js` is on and would otherwise never be told to open. */
if (ruleOut && (reduced || !('IntersectionObserver' in window))) ruleOut.classList.add('on');

if (ruleBox && !reduced && 'IntersectionObserver' in window) {
  const text = ruleBox.value;
  ruleBox.value = '';

  const typeIt = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      typeIt.disconnect();
      let i = 0;
      const step = () => {
        if (i < text.length) {
          ruleBox.value = text.slice(0, ++i);
          setTimeout(step, 22 + Math.random() * 30);
        } else {
          /* The press is 140ms of the button's own pressed state and nothing
             else. A spinner would be a claim about how long compiling takes,
             and on the machine this runs on that number is 46 seconds, not a
             quarter of a second. */
          setTimeout(() => sendBtn?.classList.add('pressed'), 260);
          setTimeout(() => sendBtn?.classList.remove('pressed'), 400);
          setTimeout(() => ruleOut?.classList.add('on'), 520);
        }
      };
      setTimeout(step, 320);
    },
    { threshold: 0.5 }
  );
  typeIt.observe(ruleBox);
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
 * else keeps the macOS default. Sizes are the v0.1.3 release assets: the
 * arm64 .dmg and the Squirrel .exe.
 */

const RELEASE = 'https://github.com/Wardenlabs/warden/releases/download/v0.1.3/';
const MAC = { label: 'Download for macOS', size: '217 MB', file: 'Warden-0.1.3-arm64.dmg', other: 'Also on macOS' };
const WIN = { label: 'Download for Windows', size: '287 MB', file: 'Warden-Setup.exe', other: 'Also on Windows' };

const primary = document.querySelector('.hero .btn-primary');
const alt = document.querySelector('.hero .cta .alt');
const onWindows = /Windows|Win64|Win32/i.test(navigator.userAgent || '');

if (primary && alt && onWindows) {
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
