/*
 * Everything on this page that needs JavaScript: the light in the hero, the
 * prompt that types itself under it, reveal-on-scroll, the scene engine that
 * walks the four chapters, and naming the visitor's platform on the download
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
const on = (el) => el && el.classList.add('on');

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
      setTimeout(step, 20 + Math.random() * 26);
    } else {
      setTimeout(() => verdict(true), 380);
    }
  };
  setTimeout(step, 320);
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
 * Four chapters below the hero, one scroll-driven day. On a wide screen each
 * chapter pins its product panel with position:sticky while the narration
 * walks past it, and the panel assembles at the step that explains it — one
 * IntersectionObserver per chapter, watching the steps. On a phone there is
 * no pinning: the panel sits between the narration and assembles once, when
 * it scrolls into view.
 *
 * The engine only ever reveals markup that is already on the page. It types
 * over text that is in the document, adds `on` to rows and line groups that
 * are merely translucent, and decides nothing — which is why reduced motion
 * and a missing IntersectionObserver get the same treatment: everything on,
 * immediately, and the page is simply complete.
 *
 * Actions are monotonic. Scrolling back up does not disassemble a panel:
 * what the day produced stays produced, the same claim the audit log makes.
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
const rules = $$('#ruleSet .ru');
const sendBtn = document.querySelector('[data-chapter="write"] .send');

const hitCh = byName.hit;
const hitTyper = hitCh && typer($$('.pt', hitCh), 14, 20);

const logCh = byName.log;
const logRows = logCh ? $$('.console .row', logCh) : [];

const spendCh = byName.spend;
const spendTyper = spendCh && typer($$('.pt', spendCh), 14, 20);

/* One list of actions per chapter, indexed by narration step. `runTo` fires
   them once each, in order, even when a fast scroll lands on step three
   directly. */
const acts = {
  write: [
    async () => { await wait(180); await ruleTyper?.run(); },
    async () => {
      /* 130ms of the button's own pressed state and nothing else. A spinner
         would be a claim about how long compiling takes, and on the machine
         this runs on that number is 46 seconds. */
      sendBtn?.classList.add('pressed');
      await wait(130);
      sendBtn?.classList.remove('pressed');
      for (const r of rules) { await wait(340); on(r); }
    },
    async () => {},
  ],
  hit: [
    async () => { $$('.tg-a', hitCh).forEach(on); await wait(140); await hitTyper?.run(); },
    async () => {
      $$('.tg-b', hitCh).forEach(on);
      /* The handoff: when the refusal lands, the sentence written in scene 01
         takes the hit for a beat. The connective tissue is the event itself,
         not a line drawn beside it. */
      ruleBox?.classList.add('hit');
      setTimeout(() => ruleBox?.classList.remove('hit'), 1400);
      await wait(320);
      $$('.tg-c', hitCh).forEach(on);
    },
    async () => { $$('.tg-d', hitCh).forEach(on); await wait(220); $$('.tg-e', hitCh).forEach(on); },
  ],
  log: [
    async () => { on(logCh?.querySelector('.day')); await wait(220); on(logRows[0]); },
    async () => { on(logRows[1]); },
    async () => {
      on(logRows[2]);
      await wait(240);
      on(logRows[3]);
      await wait(420);
      on(logCh?.querySelector('.tally'));
    },
  ],
  spend: [
    async () => { $$('.tg-a', spendCh).forEach(on); await wait(140); await spendTyper?.run(); },
    async () => { $$('.tg-b', spendCh).forEach(on); },
    async () => {
      $$('.tg-c', spendCh).forEach(on);
      await wait(220);
      $$('.tg-d', spendCh).forEach(on);
      await wait(320);
      on(spendCh?.querySelector('.ceilings'));
    },
  ],
};

const ran = {}; /* chapter name -> highest step already fired */

const runTo = (name, i) => {
  const from = ran[name] ?? -1;
  if (i <= from) return;
  ran[name] = i;
  (async () => {
    for (let k = from + 1; k <= i; k++) {
      acts[name]?.[k]?.();
      await wait(150);
    }
  })();
};

const finishChapter = (ch) => {
  const name = ch.dataset.chapter;
  ran[name] = 99;
  if (name === 'write') ruleTyper?.finish();
  if (name === 'hit') hitTyper?.finish();
  if (name === 'spend') spendTyper?.finish();
  $$('.tg, .ru, .console .row, .day, .tally, .ceilings', ch).forEach(on);
  $$(':scope > .step', ch).forEach((s) => s.classList.add('on'));
};

const finishAll = () => chapters.forEach(finishChapter);

if (reduced || !hasIO) {
  finishAll();
} else {
  const desktop = window.matchMedia('(min-width: 900px)');

  chapters.forEach((ch) => {
    const name = ch.dataset.chapter;
    const steps = $$(':scope > .step', ch);

    if (desktop.matches) {
      /* The active step is whichever one crosses the band around the middle
         of the screen. `on` moves with it; the panel only ever moves forward. */
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const i = steps.indexOf(entry.target);
            steps.forEach((s, k) => s.classList.toggle('on', k === i));
            runTo(name, i);
          }
        },
        { rootMargin: '-32% 0px -46% 0px', threshold: 0 }
      );
      steps.forEach((s) => io.observe(s));
    } else {
      /* No pinning on a phone: the whole sequence plays once, paced, when
         the panel arrives. The narration around it is plain text. */
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io.disconnect();
          steps.forEach((s) => s.classList.add('on'));
          (async () => {
            const list = acts[name] || [];
            ran[name] = list.length;
            /* Tighter beats than the pinned version: on a phone the reserved
               space under the last revealed line is visible until the next
               group lands, so the pauses are for rhythm, not suspense. */
            for (const act of list) { await act(); await wait(180); }
          })();
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
      );
      io.observe(ch.querySelector('.pstick') || ch);
    }
  });

  /* Crossing the breakpoint mid-read re-wires nothing; the day simply
     finishes. Rare enough that correct beats clever. */
  desktop.addEventListener?.('change', finishAll, { once: true });
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
