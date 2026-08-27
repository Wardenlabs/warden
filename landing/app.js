/*
 * Everything on this page that needs JavaScript, which is five things:
 * the light, the prompt that types itself in the hero, reveal-on-scroll,
 * the count-up on the two headline numbers, and naming the visitor's
 * platform on the download button.
 *
 * No build step and no dependencies — see README.md. These are ES modules
 * served from the same origin, which is the same property the console has:
 * a page about not sending things over the network should not be fetching a
 * framework to render a headline.
 */

import { mountLight } from './light.js';

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
      setTimeout(step, 38 + Math.random() * 40);
    } else {
      setTimeout(() => verdict(true), 650);
    }
  };
  setTimeout(step, 900);
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
  revealables.forEach((el) => io.observe(el));
}

/* ── count-up ──────────────────────────────────────────────────────────── */
/*
 * Only the two numbers in the argument. A page that animates every figure on
 * it is asking to be watched rather than read, and the honest section below
 * would then be competing with its own decoration.
 */

function countUp(el) {
  const target = Number(el.dataset.count);
  const suffix = el.dataset.suffix || '';
  if (!Number.isFinite(target)) return;

  if (reduced || target === 0) {
    el.textContent = target + suffix;
    return;
  }

  const DURATION = 1100;
  let start;

  const step = (now) => {
    if (start === undefined) start = now;
    const t = Math.min((now - start) / DURATION, 1);
    // easeOutExpo — fast off the line, settles rather than stops.
    const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    el.textContent = Math.round(target * eased) + suffix;
    if (t < 1) requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}

const counters = document.querySelectorAll('[data-count]');

if (!('IntersectionObserver' in window)) {
  counters.forEach(countUp);
} else {
  const co = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        countUp(entry.target);
        co.unobserve(entry.target);
      }
    },
    { threshold: 0.6 }
  );
  counters.forEach((el) => {
    el.textContent = '0' + (el.dataset.suffix || '');
    co.observe(el);
  });
}

/* ── name the platform on the hero button ──────────────────────────────── */
/*
 * The button names the visitor's platform and the quiet link beside it names
 * the other one. Windows is the only case worth branching for; everything
 * else keeps the macOS default. Sizes are the v0.1.2 release assets: the
 * arm64 .dmg and the Squirrel .exe. There is no Intel Mac build in v0.1.2.
 */

const RELEASE = 'https://github.com/Wardenlabs/warden/releases/download/v0.1.2/';
const MAC = { label: 'Download for macOS', size: '185 MB', file: 'Warden-0.1.0-arm64.dmg', other: 'Also on macOS' };
const WIN = { label: 'Download for Windows', size: '273 MB', file: 'Warden-Setup.exe', other: 'Also on Windows' };

const primary = document.querySelector('.hero .btn-primary');
const alt = document.querySelector('.hero .cta .alt');

if (primary && alt && /Windows|Win64|Win32/i.test(navigator.userAgent || '')) {
  primary.querySelector('.txt').textContent = WIN.label;
  primary.querySelector('.sz').textContent = WIN.size;
  primary.setAttribute('href', RELEASE + WIN.file);
  alt.textContent = MAC.other;
  alt.setAttribute('href', RELEASE + MAC.file);
}
