/**
 * The render loop: carry the fields across the swap, draw the shell, let the view draw itself, then bind.
 */
import { $, esc, post, state, val } from './core.js';
import { compilerSetupNudge } from './compiler.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { bindGetModels } from './engine.js';
import { captureFieldValues, restoreFieldValues } from './form-state.js';
import { renderNav } from './nav.js';
import { go } from './router.js';
import { disclosureRow } from './ui.js';
import { firstRunBanner, mockBanner } from './rules.js';
import { VIEWS } from './views.js';

// ── render ───────────────────────────────────────────────────────────────────

/**
 * Everything is re-rendered from strings, and a decision arriving on the live
 * stream re-renders whatever you happen to be in the middle of typing. So the
 * value and the caret of every field are carried across the swap, keyed by id.
 */
/** How close to the bottom still counts as "following the conversation". */
const STICK_PX = 140;
const SMOOTH = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
let renderedRoute = '';
let hadDetail = false;
let returnRow = null;
const listScroll = new Map();

/** The list remains a visual reference; only the foreground record is active.
 * Prefix its IDs so background forms cannot steal detail bindings or values. */
export function detailShell(background, content, label) {
  const context = background.replace(/\sid="([^"]+)"/g, ' id="context-$1"');
  return `<div class="detail-context" inert aria-hidden="true">${context}</div>
    <dialog id="detailPanel" class="detail-panel" aria-label="${esc(label)} details">
      <div class="detail-toolbar"><span>${esc(label)}</span><button type="button" id="closeDetail" class="detail-close" aria-label="Close details">×</button></div>
      <div id="detailScroll" class="detail-scroll">${content}</div>
    </dialog>`;
}

function bindDetail(open, changed, fields) {
  const panel = $('detailPanel');
  if (open && panel) {
    const close = () => go(state.view, null, state.query);
    $('closeDetail').onclick = close;
    panel.oncancel = (event) => {
      event.preventDefault();
      // Escape belongs to an inner confirmation/menu before it belongs to
      // this record. Closing the editor still uses its unsaved-work guard.
      if (!panel.querySelector('.dialog-scrim, details.menu[open]')) close();
    };
    panel.onclick = (event) => {
      if (event.target !== panel || panel.querySelector('.dialog-scrim')) return;
      const r = panel.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
    };
    panel.onkeydown = (event) => {
      const menu = panel.querySelector('details.menu[open]');
      if (event.key === 'Escape' && menu) {
        event.preventDefault();
        event.stopPropagation();
        menu.removeAttribute('open');
        menu.querySelector('summary')?.focus();
      }
    };
    panel.showModal?.();
    panel.classList.toggle('detail-enter', changed && !hadDetail);
    $('detailScroll').scrollTop = changed ? 0 : fields.detailScroll;
    const confirmation = panel.querySelector('.dialog-scrim');
    if (confirmation) {
      // An inner confirmation owns focus until it is answered. Inert every
      // sibling along its ancestry so Tab cannot reach the editor behind it.
      let child = confirmation;
      while (child.parentElement && child.parentElement !== panel) {
        for (const sibling of child.parentElement.children) if (sibling !== child) sibling.inert = true;
        child = child.parentElement;
      }
      panel.querySelector('.detail-toolbar').inert = true;
      const previous = fields.focus && $(fields.focus);
      const target = previous && confirmation.contains(previous) ? previous
        : confirmation.querySelector('#keepEditing, input:not([disabled]), textarea:not([disabled])')
          ?? confirmation.querySelector('button:not([disabled])');
      target?.focus({ preventScroll: true });
      panel.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        const controls = [...confirmation.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex="0"]')].filter((el) => el.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      });
    } else if (!changed && fields.focus && $(fields.focus)) $(fields.focus).focus({ preventScroll: true });
    else $('closeDetail').focus({ preventScroll: true });
  } else if (hadDetail && returnRow?.view === state.view) {
    const row = [...$('pane').querySelectorAll('.trow[data-sel]')].find((el) => el.dataset.sel === returnRow.sel);
    (row ?? $('pane')).focus({ preventScroll: true });
    returnRow = null;
  }
}

function captureFields() {
  const saved = captureFieldValues($('pane'));
  const chat = $('pane').querySelector('.chat');
  return {
    saved,
    focus: document.activeElement?.id ?? null,
    scroll: $('pane').scrollTop,
    detailScroll: $('detailScroll')?.scrollTop ?? 0,
    // A conversation follows along on its own while you are at the bottom of
    // it, and stays put if you have scrolled up to read something. Yanking
    // someone back down mid-sentence is worse than not scrolling at all.
    chat: chat && { top: chat.scrollTop, stick: chat.scrollHeight - chat.scrollTop - chat.clientHeight < STICK_PX }
  };
}

function restoreFields({ saved, focus, scroll, chat }) {
  restoreFieldValues($('pane'), saved);
  if (focus && $(focus)) $(focus).focus();
  if (scroll) $('pane').scrollTop = scroll;
}

/**
 * Keep the conversation at the bottom.
 *
 * Runs after bind, not with the other restores: bind is where the audience
 * editor writes its chips, and measuring the height before that leaves the
 * last card cut off by exactly the height of those two rows.
 *
 * "Stick" is meant for a new turn arriving — that is worth following down to.
 * Opening the severity or audience picker on the current card is not a new
 * turn, it is the same card getting taller, and re-running the same smooth
 * scroll-to-bottom for it read as the whole conversation lurching for a click
 * that added nothing to it. `state.keepScroll`, set by those two toggles
 * right before `render()`, asks for the plain "hold where you were" branch
 * even though the scroll position still counts as sticky.
 */
function restoreChat(chat) {
  const el = $('pane').querySelector('.chat');
  if (!el) return;
  if (!chat) { el.scrollTop = el.scrollHeight; return; }   // just opened
  // Sending is the one moment the reader always wants the bottom, wherever
  // they had scrolled to: the thing they just sent is down there.
  if (state.followChat) { state.followChat = false; state.keepScroll = false; requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: SMOOTH() })); return; }
  if (!chat.stick || state.keepScroll) { el.scrollTop = chat.top; state.keepScroll = false; return; }
  requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: SMOOTH() }));
}

export function render() {
  const view = VIEWS[state.view];
  const fields = captureFields();
  const detail = Boolean(val(view.detail));
  const routeKey = `${state.view}/${state.sel ?? ''}`;
  const changed = renderedRoute !== routeKey;
  if (detail && (!hadDetail || returnRow?.view !== state.view)) {
    if (!hadDetail) listScroll.set(state.view, fields.scroll);
    returnRow = { view: state.view, sel: state.sel?.replace(/^edit:/, '') };
  }

  /**
   * A `bare` view owns the window: no sidebar, no banners, no breadcrumb.
   *
   * Only the first run is one, and it is one because the design gives that
   * screen the full width and a single thing to do. It is still an ordinary
   * view of this router — `go()` and the hash reach it like any other — so
   * nothing here is a second way to navigate. The sidebar is emptied rather
   * than left stale behind `display: none`, or its buttons stay in the tab
   * order of a screen that does not show them.
   *
   * Guarded like `applyTheme` in nav.js, and for the same reason: the console
   * tests run these modules against a document stub that has no body.
   */
  const bare = val(view.bare);
  const body = typeof document !== 'undefined' ? document.body : null;
  if (bare) {
    if (body?.dataset) body.dataset.bare = 'true';
    $('sidebar').innerHTML = '';
  } else {
    if (body?.dataset) delete body.dataset.bare;
    renderNav();
  }
  $('pane').className = `pane${val(view.flush) ? ' flush' : ''}${detail ? ' has-detail' : ''}`;
  // Demo mode goes above every screen, not inside one. It used to live in the
  // today card, which does not render until something has happened — so the
  // person it is written for, somebody who has just installed the app and is
  // wondering why nothing works, was the one person who never saw it.
  // "This device" is its own onboarding, not a company's — the team's
  // first-run nudge ("write a rule", "put your team in") would be talking
  // about a directory this view never shows. The mock banner still applies:
  // someone in demo mode needs to know nothing here is real no matter which
  // product surface they are looking at.
  // A bare view takes none of them. The team's nudge is about a directory it
  // never shows, the demo banner cannot apply — the first run does not open in
  // demo mode at all — and a compiler notice has no room on a screen with two
  // cards and one button.
  const isSoloView = state.view === 'soloRules' || state.view === 'soloSettings';
  const banners = bare ? '' : compilerSetupNudge() + (state.mock ? mockBanner() : '') + (isSoloView ? '' : firstRunBanner());
  const content = view.body();
  $('pane').innerHTML = detail ? detailShell(view.background(), content, view.detailLabel) : content;
  // The shell's notices sit under the page's own header, where the reader has
  // already learnt which page this is; above it they pushed the title down on
  // every screen. A page with no header gets them at the top.
  if (banners) {
    const anchor = (detail ? $('detailScroll') : $('pane')).querySelector('.page-head');
    if (anchor) anchor.insertAdjacentHTML('afterend', `<div class="shell-notices">${banners}</div>`);
    else $('pane').insertAdjacentHTML('afterbegin', `<div class="shell-notices">${banners}</div>`);
  }

  // A live refresh preserves typing; opening another record must not carry
  // the previous person's note into a same-named field on the next record.
  restoreFields(changed ? { ...fields, saved: {}, focus: null } : fields);
  bindDisclosures();
  if (view.bind) view.bind();

  // The first-run banner is drawn by the shell on every screen, so its one
  // button is bound here rather than in any view's own bind — it would
  // otherwise be dead on the screen the console actually opens on.
  const sample = $('loadSample');
  if (sample) sample.onclick = async () => {
    sample.disabled = true;
    sample.textContent = 'Loading…';
    await post('/api/company/sample');
    await Promise.all([refreshPolicy(), refreshPeople()]);
    go('policy');
  };

  // Same reason as the button above it: the demo banner is drawn by the shell
  // on every screen, so binding this inside any one view would make it dead on
  // the screen the console actually opens on.
  // Every one of them, not the first. The id appears on the demo banner and on
  // the model list, and both are on screen together whenever somebody in demo
  // mode opens the compiler page; `$()` returns one, so the other was a button
  // that looked identical and did nothing.
  bindGetModels();

  restoreChat(fields.chat);
  bindDetail(detail, changed, fields);
  if (hadDetail && !detail && listScroll.has(state.view)) $('pane').scrollTop = listScroll.get(state.view);
  else if (changed && !detail) $('pane').scrollTop = 0;
  renderedRoute = routeKey;
  hadDetail = detail;
}

/** Disclosures report their own open state back into `state.open` so the next
 *  render can reinstate it. */
export function bindDisclosures() {
  for (const d of document.querySelectorAll('details[data-key]')) {
    d.ontoggle = () => {
      if (d.open) state.open.add(d.dataset.key); else state.open.delete(d.dataset.key);
    };
  }

  /*
   * The same contract for a fold that is a button rather than a <details>.
   *
   * `conditionBlock` needs its control to sit inside a headline row beside an
   * action button, and a <summary> only works as the first child of its
   * <details> — nested, the browser ignores it and hides the row it is in.
   * So that block is a button with `aria-expanded` and a body it names, and
   * this is the one place that knows how to work it.
   *
   * It moves the body rather than re-rendering: nothing else on the page
   * changes when somebody opens five rows of evidence, and a re-render here
   * would rebuild the tab content underneath for no reason.
   */
  for (const b of document.querySelectorAll('[data-fold]')) {
    b.onclick = () => {
      const key = b.dataset.fold;
      const open = !state.open.has(key);
      if (open) state.open.add(key); else state.open.delete(key);
      b.setAttribute('aria-expanded', String(open));
      const body = document.getElementById(b.getAttribute('aria-controls'));
      if (body) body.hidden = !open;
    };
  }
}

/** Disclosure / Row, with its open state carried in `state.open`. `datum` is
 *  the short state on the right, and only when it reports state. */
export function disclosure(key, label, body, datum = '') {
  return disclosureRow(key, label, datum, body, { open: state.open.has(key) });
}
