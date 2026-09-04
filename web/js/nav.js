/**
 * The navigation across the top, and the delegated click and key handlers every screen relies on.
 */
import { pendingEscalations } from './activity.js';
import { $, esc, state } from './core.js';
import { copyText } from './format.js';
import { go, toggleSel } from './router.js';
import { composing } from './rules.js';
import { VIEWS } from './views.js';

/**
 * The navigation: four destinations across the top, one divider.
 *
 * Along the top rather than down the side, so the column underneath is the
 * full width of the window and the composer can be the size it deserves.
 *
 * Only one count survives. A number next to Activity told you how much log
 * there is, which is not a thing anyone acts on; a number next to Inbox says
 * somebody is waiting, which is.
 *
 * The simulator and the red team suite are not here at all — they are things
 * you run against your policy, not places you go, so they live on Rules.
 */
// Rules leads with the composer rather than the list: `sel: 'new'` makes the
// nav item land on the tab you are most likely to have come for.
const TEAM_NAV = [
  { view: 'activity', label: 'Activity' },
  { view: 'inbox', label: 'Inbox', count: () => pendingEscalations().length + state.appeals.length },
  { sep: true },
  { view: 'policy', label: 'Rules', sel: 'new' },
  { view: 'people', label: 'Team' },
  // Its own item rather than a tab inside Rules. What lives here is the answer
  // to "is the guard working at all", and it used to sit two clicks deep
  // behind a page about who WRITES the rules — an unrelated question that a
  // reader has to get past before reaching the one they came with.
  { view: 'engine', label: 'Engine' }
];

const SOLO_NAV_ITEM = { view: 'soloRules', label: 'This device' };
const SOLO_SETTINGS_NAV_ITEM = { view: 'soloSettings', label: 'Settings' };

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
    ? [SOLO_NAV_ITEM, SOLO_SETTINGS_NAV_ITEM]
    : [...TEAM_NAV, { sep: true }, SOLO_NAV_ITEM];
}

export function renderNav() {
  const here = VIEWS[state.view].railParent ?? state.view;
  $('nav').innerHTML = navItems().map((it) => {
    if (it.sep) return '<span class="nav-sep"></span>';
    const n = it.count ? it.count() : 0;
    return `<button type="button" class="nav-item${here === it.view ? ' on' : ''}" data-go="${it.view}"${it.sel ? ` data-sel="${it.sel}"` : ''}>
      <span>${esc(it.label)}</span>
      ${n > 0 ? `<span class="nav-count">${n}</span>` : ''}
    </button>`;
  }).join('');
  // A demo directory has a company name, and it is not the user's. Showing it
  // in the title bar is the product asserting something false about whoever
  // installed it, so the seeded name stays out of the chrome until someone
  // claims it on Team.
  // While it is the sample, the chrome says so and offers the one click that
  // fixes it — the console opens on Activity, so nobody finds the Company block
  // on Team by accident.
  if (state.company.demo) {
    $('orgName').innerHTML = '<button type="button" class="linkish" data-go="people">· sample data</button>';
  } else {
    $('orgName').textContent = state.company.name ? `· ${state.company.name}` : '';
  }
}

// One delegated listener for the whole document: every navigation is a
// `data-go` (+ optional `data-sel` / `data-q`), so nothing has to re-bind after
// a re-render. `data-toggle` is the in-place open/close.
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle]');
  if (t) { toggleSel(t.dataset.toggle, t.dataset.sel || null); return; }

  const nav = e.target.closest('[data-go]');
  if (nav) {
    const q = nav.dataset.q ? Object.fromEntries(new URLSearchParams(nav.dataset.q)) : undefined;
    go(nav.dataset.go, nav.dataset.sel || null, q);
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) void copyText(decodeURIComponent(copy.dataset.copy), copy);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sel && !composing()) go(state.view);
});
