/**
 * The hash router. Every screen is `#/view/selection?query`, and `route()` is the one place that reads it.
 */
import { $, state } from './core.js';
import { soloIsPureInstall } from './nav.js';
import { render } from './render.js';
import { VIEWS } from './views.js';

// ── routing ──────────────────────────────────────────────────────────────────

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const [view, ...rest] = path.split('/');
  const query = {};
  for (const [k, v] of new URLSearchParams(qs ?? '')) query[k] = v;
  return {
    // A pure solo install (see `soloIsPureInstall` below) has nothing at
    // `#/activity` worth landing on — every other tab opens onto a directory
    // with nobody in it — so an empty or unrecognised hash opens "This
    // device" instead. A directly-typed hash to a team view still works;
    // this only decides where "nothing said yet" goes.
    view: VIEWS[view] ? view : (soloIsPureInstall() ? 'soloRules' : 'activity'),
    sel: rest.length ? decodeURIComponent(rest.join('/')) : null,
    query
  };
}

export function go(view, sel, query) {
  const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
  const next = `#/${view}${sel ? `/${encodeURIComponent(sel)}` : ''}${qs}`;
  if (location.hash === next) route(); else location.hash = next;
}

/** Selecting the open row again closes it. Nothing else on the page moves. */
export function toggleSel(view, id) { return go(view, state.sel === id ? null : id); }

/**
 * A view with unsaved work can hold a navigation back. `holdLeave(next)` gets
 * where the person was going, keeps it, and returns true to stay; the view
 * then asks, and resumes with `go` or drops it. The hash is put back so the
 * address bar keeps saying where the person actually is.
 */
let shownHash = '';

export function route() {
  const next = parseHash();
  const moving = next.view !== state.view || next.sel !== state.sel;
  if (moving && shownHash && VIEWS[state.view]?.holdLeave?.(next)) {
    history.replaceState(null, '', shownHash);
    render();
    return;
  }
  shownHash = location.hash;
  if (next.view !== state.view) VIEWS[state.view]?.onLeave?.();
  Object.assign(state, next);
  render();
  if (VIEWS[state.view].onEnter) VIEWS[state.view].onEnter();
}
