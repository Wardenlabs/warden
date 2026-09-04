/**
 * The render loop: carry the fields across the swap, draw the shell, let the view draw itself, then bind.
 */
import { $, api, esc, state, val } from './core.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { bindGetModels } from './engine.js';
import { renderNav } from './nav.js';
import { go } from './router.js';
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

function captureFields() {
  const saved = {};
  for (const f of $('pane').querySelectorAll('input, textarea, select')) {
    if (!f.id) continue;
    saved[f.id] = { value: f.value, start: f.selectionStart, end: f.selectionEnd };
  }
  const chat = $('pane').querySelector('.chat');
  return {
    saved,
    focus: document.activeElement?.id ?? null,
    scroll: $('pane').scrollTop,
    // A conversation follows along on its own while you are at the bottom of
    // it, and stays put if you have scrolled up to read something. Yanking
    // someone back down mid-sentence is worse than not scrolling at all.
    chat: chat && { top: chat.scrollTop, stick: chat.scrollHeight - chat.scrollTop - chat.clientHeight < STICK_PX }
  };
}

function restoreFields({ saved, focus, scroll, chat }) {
  for (const [id, s] of Object.entries(saved)) {
    const f = $(id);
    if (!f || f.value === s.value) continue;
    // A <select> whose option list was rebuilt may no longer hold the value.
    if (f.tagName === 'SELECT' && ![...f.options].some((o) => o.value === s.value)) continue;
    f.value = s.value;
    if (s.start != null && f.setSelectionRange) {
      try { f.setSelectionRange(s.start, s.end); } catch { /* not a text field */ }
    }
  }
  if (focus && $(focus)) $(focus).focus();
  if (scroll) $('pane').scrollTop = scroll;
}

/**
 * Keep the conversation at the bottom.
 *
 * Runs after bind, not with the other restores: bind is where the audience
 * editor writes its chips, and measuring the height before that leaves the
 * last card cut off by exactly the height of those two rows.
 */
function restoreChat(chat) {
  const el = $('pane').querySelector('.chat');
  if (!el) return;
  if (!chat) { el.scrollTop = el.scrollHeight; return; }   // just opened
  if (!chat.stick) { el.scrollTop = chat.top; return; }
  requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: SMOOTH() }));
}

export function render() {
  const view = VIEWS[state.view];
  const fields = captureFields();

  renderNav();
  $('pane').className = `pane${val(view.flush) ? ' flush' : ''}`;
  // Demo mode goes above every screen, not inside one. It used to live in the
  // today card, which does not render until something has happened — so the
  // person it is written for, somebody who has just installed the app and is
  // wondering why nothing works, was the one person who never saw it.
  // "This device" is its own onboarding, not a company's — the team's
  // first-run nudge ("write a rule", "put your team in") would be talking
  // about a directory this view never shows. The mock banner still applies:
  // someone in demo mode needs to know nothing here is real no matter which
  // product surface they are looking at.
  const isSoloView = state.view === 'soloRules' || state.view === 'soloSettings';
  $('pane').innerHTML = (state.mock ? mockBanner() : '') + (isSoloView ? '' : firstRunBanner()) + view.body();

  restoreFields(fields);
  bindDisclosures();
  if (view.bind) view.bind();

  // The first-run banner is drawn by the shell on every screen, so its one
  // button is bound here rather than in any view's own bind — it would
  // otherwise be dead on the screen the console actually opens on.
  const sample = $('loadSample');
  if (sample) sample.onclick = async () => {
    sample.disabled = true;
    sample.textContent = 'Loading…';
    await api('/api/company/sample', { method: 'POST' });
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
}

/** Disclosures report their own open state back into `state.open` so the next
 *  render can reinstate it. */
export function bindDisclosures() {
  for (const d of document.querySelectorAll('details[data-key]')) {
    d.ontoggle = () => {
      if (d.open) state.open.add(d.dataset.key); else state.open.delete(d.dataset.key);
    };
  }
}

export function disclosure(key, label, body) {
  return `<details class="fold" data-key="${esc(key)}"${state.open.has(key) ? ' open' : ''}>
    <summary>${esc(label)}</summary>
    <div class="fold-body">${body}</div>
  </details>`;
}
