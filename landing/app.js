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
 * Four scenes below the hero, each built like the hero: a pinned full
 * screen with a centred statement, a gate line, and the panel under it.
 * On a wide screen the scroll drives the scene directly — the pin's travel
 * picks the step, in both directions. On a phone nothing pins and the
 * panel walks its states once, paced, as it arrives.
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
   selector, so walking backwards undoes what walking forward did and the
   panel answers the scroll in both directions. This file only does the
   things CSS cannot: type, press the button once, and flip the tool tabs. */

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
  const desktop = window.matchMedia('(min-width: 900px)');

  if (!desktop.matches) {
    /* No pinning on a phone: the statements stack and the panel walks its
       states once, paced, when the stage arrives. */
    chapters.forEach((ch) => {
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io.disconnect();
          (async () => {
            for (let i = 0; i < 3; i++) { setStep(ch, i); await wait(1300); }
          })();
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
      );
      io.observe(ch.querySelector('.stage') || ch);
    });
  }

  /* Crossing the breakpoint mid-read re-wires nothing; the day simply
     finishes. Rare enough that correct beats clever. */
  desktop.addEventListener?.('change', finishAll, { once: true });

  /* On a wide screen the pinned stage is driven straight off the scroll:
     one rAF computes how far each chapter's pin has travelled and picks the
     step from thirds of it — both directions, no observers, no drift
     between what the finger did and what the stage shows. */
  const HEADER = 56;
  let ticking = false;
  const track = () => {
    ticking = false;
    if (!desktop.matches) return;
    const vh = window.innerHeight;
    for (const ch of chapters) {
      const r = ch.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) continue;
      const travel = r.height - (vh - HEADER);
      if (travel <= 0) { setStep(ch, 0); continue; }
      const sp = Math.min(1, Math.max(0, (HEADER - r.top) / travel));
      setStep(ch, sp < 0.34 ? 0 : sp < 0.67 ? 1 : 2);
    }
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(track); }
  }, { passive: true });
  track();
}

/* ── name the platform on the hero button ──────────────────────────────── */
/*
 * The button names the visitor's platform and the quiet link beside it names
 * the other one. Windows is the only case worth branching for; everything
 * else keeps the macOS default. The sizes are read off the v0.1.7 release and
 * checked against it: 217,301,057 and 287,090,688 bytes. Nothing in this repo
 * reads them off the release, so they are a number a person has to come back
 * and correct on every version bump. That is the honest cost of a static page
 * with no build step, and it is worth knowing which numbers have that property.
 */

const RELEASE = 'https://github.com/Wardenlabs/warden/releases/download/v0.1.7/';
const MAC = { label: 'Download for macOS', size: '217 MB', file: 'Warden-0.1.7-arm64.dmg', other: 'Also on macOS' };
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
