/**
 * The sidebar, and the delegated click and key handlers every screen relies on.
 */
import { pendingEscalations } from './activity.js';
import { $, esc, state } from './core.js';
import { copyText } from './format.js';
import { ICONS } from './icons.js';
import { go, toggleSel } from './router.js';
import { composing } from './rules.js';
import { menu } from './ui.js';
import { VIEWS } from './views.js';

/**
 * The theme, owned by "Your account": three states, and the default is the
 * operating system's, so someone who never opens this menu keeps the
 * behaviour the CSS ships with. An explicit choice is `data-theme` on <html>
 * — the stylesheet's [data-theme] blocks beat the media query — and it is
 * per browser, not per company: which colours hurt whose eyes is not
 * administrative state, so it stays out of the directory and in localStorage.
 * Applied at module load, before the first render, so a dark choice does not
 * flash the light page first. Everything is guarded: the console tests run
 * these modules under a document stub with no documentElement and no storage.
 */
const THEME_KEY = 'warden-theme';

function storedTheme() {
  try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'system'; }
  catch { return 'system'; }
}

function applyTheme(t) {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root?.dataset) return;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
}

function setTheme(t) {
  try { t === 'system' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, t); } catch { /* private mode: the choice lasts the tab */ }
  applyTheme(t);
  renderNav();   // the ✓ moves, and rebuilding the sidebar closes the menu
}

applyTheme(storedTheme());

/**
 * The navigation: a dark sidebar, three groups, one count.
 *
 * It used to run along the top, on the argument that the composer deserved the
 * full width of the window. The redesign answers that with a 760px reading
 * column instead, which is the width a sentence wants anyway, and gives the
 * navigation a place that does not move when a page grows a toolbar.
 *
 * Only one count survives. A number next to Activity told you how much log
 * there is, which is not a thing anyone acts on; a number next to Inbox says
 * somebody is waiting, which is.
 *
 * The tester and the red team suite are not here — they are things you run
 * against your policy, not places you go, so they are reached from Rules.
 */
const TEAM_NAV = [
  { group: 'Overview' },
  { view: 'activity', label: 'Activity', icon: 'activity' },
  { view: 'inbox', label: 'Inbox', icon: 'inbox', count: () => pendingEscalations().length + state.appeals.length },
  { group: 'Manage' },
  { view: 'policy', label: 'Rules', icon: 'rules' },
  { view: 'people', label: 'Team', icon: 'team' },
  // Its own item rather than a tab inside Rules. What lives here is the answer
  // to "is the guard working at all", and it used to sit two clicks deep
  // behind a page about who WRITES the rules — an unrelated question that a
  // reader has to get past before reaching the one they came with.
  { view: 'models', label: 'Models', icon: 'models' }
];

const SOLO_NAV_ITEM = { view: 'soloRules', label: 'This device', icon: 'device' };
/**
 * The server, under the machine, on both sides of the solo line.
 *
 * It answers a different question from the one above it — "This device" is
 * about the computer somebody is sitting at, "Gateway" is about the process
 * that holds the rules, the keys and the log — and a solo install has one of
 * each just as much as a company does. What it took from This device is the
 * public address and what is kept on disk: both are properties of the server.
 */
const GATEWAY_NAV_ITEM = { view: 'gateway', label: 'Gateway', icon: 'gateway' };
const SOLO_SETTINGS_NAV_ITEM = { view: 'soloSettings', label: 'Settings', icon: 'settings' };

/**
 * A directory nobody has put a second person into yet, or one where the only
 * entries are the "protect this device" identity itself, is a pure solo
 * install (docs/specs/solo-mode.md §7) — every other tab would open onto an
 * empty team console, so it does not show. `employees.length === 0` covers
 * the instant before anyone has pressed anything here: nobody has called
 * `/api/solo/setup` yet either, and this still counts as pure rather than as
 * "wait and find out", because the view itself triggers that setup on entry.
 *
 * The moment a second, non-`solo` role shows up, this machine also has a
 * directory worth administering — coexistence (PRD §4) — and "This device"
 * becomes one tab among the rest rather than the only one. In practice that
 * second role is always an exempt admin (only an admin can add people at
 * all), which is the framing spec §7 uses; the two describe the same
 * boundary and this is the one `state.company` can answer without an extra
 * round trip to learn which employee `/api/solo/*` resolved as the identity.
 */
export function soloIsPureInstall() {
  const emps = state.company.employees;
  return emps.length === 0 || emps.every((e) => e.role === 'solo');
}

/**
 * "Settings" exists only on the solo side of this line, on purpose. A
 * coexisting install already has a full admin console — nothing there needs
 * an escape hatch to itself. A pure solo install has exactly one door out:
 * this tab, and `#people` behind it (still a real view, just not in this
 * list — `parseHash` routes to any known view whether or not it is in the
 * nav, so linking there costs nothing new). Without it, "you can add a full
 * team roster from the console later" (the first-run screen's own words) was
 * a promise nothing in the console could keep.
 */
function navItems() {
  return soloIsPureInstall()
    ? [{ group: 'Manage' }, { view: 'models', label: 'Models', icon: 'models' }, { group: 'Local' }, SOLO_NAV_ITEM, GATEWAY_NAV_ITEM, SOLO_SETTINGS_NAV_ITEM]
    : [...TEAM_NAV, { group: 'Local' }, SOLO_NAV_ITEM, GATEWAY_NAV_ITEM];
}

/**
 * The workspace line under the wordmark.
 *
 * A demo directory has a company name, and it is not the user's. Showing it in
 * the chrome is the product asserting something false about whoever installed
 * it, so the seeded name stays out until someone claims it on Team — and while
 * it is the sample, the line says so and is the one click that fixes it.
 */
function workspaceLine() {
  if (state.company.demo) return '<button type="button" data-go="people" data-sel="company">Sample data</button>';
  return `<b>${esc(state.company.name || 'Your workspace')}</b>`;
}

export function renderNav() {
  const here = VIEWS[state.view]?.railParent ?? state.view;
  $('sidebar').innerHTML = `<div class="sb-brand">${ICONS.brand}<b>warden</b></div>
    <div class="sb-workspace"><span>Workspace</span>${workspaceLine()}</div>
    ${navItems().map((it) => {
      if (it.group) return `<div class="sb-group">${esc(it.group)}</div>`;
      const n = it.count ? it.count() : 0;
      const on = here === it.view;
      return `<button type="button" class="sb-item${on ? ' on' : ''}"${on ? ' aria-current="page"' : ''} data-go="${it.view}">
        ${ICONS[it.icon] ?? ''}<span>${esc(it.label)}</span>${n > 0 ? `<span class="sb-count">${n}</span>` : ''}
      </button>`;
    }).join('')}
    <div class="sb-fill"></div>
    ${menu([
      { note: 'Theme' },
      { label: 'System', attrs: 'data-set-theme="system"', check: storedTheme() === 'system' },
      { label: 'Light', attrs: 'data-set-theme="light"', check: storedTheme() === 'light' },
      { label: 'Dark', attrs: 'data-set-theme="dark"', check: storedTheme() === 'dark' }
    ], {
      label: 'Your account',
      trigger: '<span class="sb-avatar" aria-hidden="true">Y</span><div><b>You</b><span>Your account</span></div>',
      align: 'left', cls: '--up sb-account', triggerCls: 'sb-profile'
    })}`;
}

// One delegated listener for the whole document: every navigation is a
// `data-go` (+ optional `data-sel` / `data-q`), so nothing has to re-bind after
// a re-render. `data-toggle` is the in-place open/close.
//
// Rows open a page, and a row also holds its own ··· menu. A click inside that
// menu belongs to the menu: without this the row underneath caught it and the
// page opened behind the menu the person was using.
document.addEventListener('click', (e) => {
  const th = e.target.closest('[data-set-theme]');
  if (th) { setTheme(th.dataset.setTheme); return; }

  const t = e.target.closest('[data-toggle]');
  if (t) { toggleSel(t.dataset.toggle, t.dataset.sel || null); return; }

  const nav = e.target.closest('[data-go]');
  const inMenu = e.target.closest('details.menu');
  if (nav && !(inMenu && !inMenu.contains(nav))) {
    inMenu?.removeAttribute('open');
    const q = nav.dataset.q ? Object.fromEntries(new URLSearchParams(nav.dataset.q)) : undefined;
    go(nav.dataset.go, nav.dataset.sel || null, q);
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) void copyText(decodeURIComponent(copy.dataset.copy), copy);
});

document.addEventListener('keydown', (e) => {
  // A row that opens a page is a link to the keyboard too.
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.trow[data-go]')) {
    e.preventDefault();
    e.target.click();
    return;
  }
  if (e.key === 'Escape' && document.querySelector('details.menu[open], .dialog-scrim')) return;
  if (e.key === 'Escape' && state.sel && !composing() && !VIEWS[state.view]?.keepOnEscape?.()) go(state.view);
});
