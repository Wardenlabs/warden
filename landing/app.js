/*
 * Everything on this page that needs JavaScript: the light in the hero, the
 * prompt that types itself under it, reveal-on-scroll, the scene engine that
 * plays the four chapters, and naming the visitor's platform on the download
 * button.
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
const hasIO = 'IntersectionObserver' in window;

const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

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
 * The timings have been cut twice. They started at 900ms before the first
 * character and 38-78ms between them, which took about three and a half
 * seconds to say anything and landed the verdict after the scroll had
 * already started. Halving that got it under two seconds, and it still read
 * as slow, because the light easing under it was slower again: the coral
 * took most of a second to reach the ends of the line, so the whole gesture
 * finished around three. It is now a shade over one second, typing included,
 * and the line turns in about a third of what it took.
 */

const judge = document.getElementById('judge');

if (judge && !reduced) {
  const typed = judge.querySelector('.typed');
  const text = typed.textContent;
  const verdict = (isOn) => {
    judge.classList.toggle('judged', isOn);
    zone?.classList.toggle('judged', isOn);
    light?.set(isOn);
  };

  verdict(false);
  typed.textContent = '';
  let i = 0;
  const step = () => {
    if (i < text.length) {
      typed.textContent = text.slice(0, ++i);
      setTimeout(step, 12 + Math.random() * 16);
    } else {
      setTimeout(() => verdict(true), 200);
    }
  };
  setTimeout(step, 180);
}

/* ── reveal on scroll ──────────────────────────────────────────────────── */

const revealables = $$('[data-reveal]');

if (reduced || !hasIO) {
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
  revealables.forEach((el) => io.observe(el));
}

/* ── the scene engine ──────────────────────────────────────────────────── */
/*
 * Four scenes below the hero, each built like the hero: a centred statement,
 * a gate line, and the panel under it. Every chapter is a short, self-running
 * sequence. It starts once when enough of the chapter enters the viewport;
 * scrolling only moves the page and never scrubs, pins, reverses, or speeds
 * up the sequence.
 *
 * The engine only ever reveals markup that is already on the page. It
 * types over text that is in the document and flips [data-step]; CSS does
 * the rest — which is why reduced motion and a missing IntersectionObserver
 * get the same treatment: final state, immediately, statements stacked,
 * and the page is simply complete.
 */

/* A typer over text that ships in the markup. It never invents a string:
   it clears what is there and puts the same thing back, so with the engine
   off the words are simply present. `finish` is the escape hatch for
   reduced motion and layout changes mid-scroll. */
const typer = (els, min = 9, spread = 14) => {
  const targets = els.filter(Boolean);
  if (!targets.length) return null;
  const isBox = targets[0].value !== undefined;
  const full = isBox ? targets[0].value : targets[0].textContent;
  const set = (v) => targets.forEach((el) => { if (isBox) el.value = v; else el.textContent = v; });
  let started = false;
  let done = false;
  return {
    async run() {
      if (started) return;
      started = true;
      set('');
      for (let i = 1; i <= full.length; i++) {
        if (done) return;
        set(full.slice(0, i));
        await wait(min + Math.random() * spread);
      }
      done = true;
    },
    finish() { done = true; set(full); },
  };
};

const chapters = $$('.chapter');
const byName = {};
chapters.forEach((ch) => { byName[ch.dataset.chapter] = ch; });

const ruleBox = document.getElementById('ruleMsg');
const ruleTyper = ruleBox && typer([ruleBox]);
const sendBtn = document.querySelector('[data-chapter="write"] .send');
const hitTyper = byName.hit && typer($$('.pt', byName.hit), 14, 20);
const spendTyper = byName.spend && typer($$('.pt', byName.spend), 14, 20);

/* The panel is a state machine keyed to the narration step. CSS owns the
   states — every reveal, collapse, spotlight and border is a [data-step]
   selector. This file advances those steps on a short timeline and only does
   the things CSS cannot: type, press the button once, and flip the tool tabs. */

const typed = {};
const typers = { write: ruleTyper, hit: hitTyper, spend: spendTyper };
const typeOnce = (name) => { if (!typed[name]) { typed[name] = true; typers[name]?.run(); } };

/* Scene 02, last beat: the same refusal shown in each tool by actually
   switching the real tabs — the radios a person can also grab themselves. */
let cycling = false;
const cycleTools = async () => {
  if (cycling) return;
  cycling = true;
  const pick = (id) => { const r = document.getElementById(id); if (r) r.checked = true; };
  await wait(420); pick('tool-cx');
  await wait(780); pick('tool-oc');
  await wait(780); pick('tool-cc');
  cycling = false;
};

const fx = {
  write: (i) => {
    typeOnce('write');
    if (i >= 1 && sendBtn && !sendBtn.dataset.done) {
      /* 130ms of the button's own pressed state and nothing else. A spinner
         would be a claim about how long compiling takes, and on the machine
         this runs on that number is 46 seconds. */
      sendBtn.dataset.done = '1';
      sendBtn.classList.add('pressed');
      setTimeout(() => sendBtn.classList.remove('pressed'), 140);
    }
  },
  hit: (i) => {
    typeOnce('hit');
    if (i === 1) {
      /* The handoff: when the refusal lands, the sentence written in scene 01
         takes the hit for a beat. The connective tissue is the event itself,
         not a line drawn beside it. */
      ruleBox?.classList.add('hit');
      setTimeout(() => ruleBox?.classList.remove('hit'), 1400);
    }
    if (i === 2) cycleTools();
  },
  log: () => {},
  spend: () => { typeOnce('spend'); },
};

const setStep = (ch, i) => {
  if (ch.dataset.step === String(i)) return;
  ch.dataset.step = String(i);
  fx[ch.dataset.chapter]?.(i);
};

const finishChapter = (ch) => {
  const name = ch.dataset.chapter;
  typed[name] = true;
  typers[name]?.finish();
  setStep(ch, 2);
};

const finishAll = () => chapters.forEach(finishChapter);

if (reduced || !hasIO) {
  finishAll();
} else {
  /* The chapters behave like short videos: entry presses play, and the
     timeline owns the three beats from there. The observer is only a start
     signal; there is deliberately no scroll listener and no geometry read
     on scroll. Unobserving also makes a chapter a one-shot, so revisiting it
     shows the completed story instead of resetting under the reader. */
  const STEP_MS = 1500;
  const play = async (ch) => {
    setStep(ch, 0);
    await wait(STEP_MS);
    setStep(ch, 1);
    await wait(STEP_MS);
    setStep(ch, 2);
  };

  const autoplay = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        autoplay.unobserve(entry.target);
        play(entry.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.22 }
  );
  chapters.forEach((ch) => autoplay.observe(ch));
}

/* ── name the platform on the hero button ──────────────────────────────── */
/*
 * The button names the visitor's platform and the quiet link beside it names
 * the other one. Windows is the only case worth branching for; everything
 * else keeps the macOS default.
 *
 * Both links go to `releases/latest`, so a new tag reaches the page without
 * anybody remembering to edit it. This page shipped pointing at v0.1.5 while
 * v0.1.6 was out, which is the whole argument. Windows can be a direct
 * download because Squirrel's installer has a fixed name, set in
 * forge.config.cjs; the dmg still carries its version in the filename, so
 * macOS lands on the release itself. When a tag ships with the version-free
 * dmg name that config now asks for, this becomes
 * `${LATEST}/download/Warden-arm64.dmg` and the last click goes away.
 *
 * No size is quoted anywhere. Nothing in this repo reads one off the release,
 * so every number was a promise to come back and correct it, and the two that
 * were on the page were both wrong by the time anybody noticed.
 */

const LATEST = 'https://github.com/Wardenlabs/warden/releases/latest';
const MAC = { label: 'Download for macOS', href: LATEST, other: 'Also on macOS' };
const WIN = { label: 'Download for Windows', href: `${LATEST}/download/Warden-Setup.exe`, other: 'Also on Windows' };

const primary = document.querySelector('.hero .btn-primary');
const alt = document.querySelector('.hero .cta .alt');
const onWindows = /Windows|Win64|Win32/i.test(navigator.userAgent || '');

if (primary && alt && onWindows) {
  primary.classList.add('on-windows');
  primary.querySelector('.txt').textContent = WIN.label;
  primary.setAttribute('href', WIN.href);
  alt.textContent = MAC.other;
  alt.setAttribute('href', MAC.href);
}

/* And in the footer, where both installers are shown: the visitor's platform
   goes first. Order, not emphasis — they are the same download either way. */
const foot = document.querySelector('.foot .dl');
if (foot && onWindows) foot.prepend(foot.lastElementChild);
