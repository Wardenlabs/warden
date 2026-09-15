/**
 * The design system's components, as template functions.
 *
 * One function per Figma component ("Warden · Sistema"), each returning a
 * string, because every screen here is rendered from strings and a component
 * that needed a different mechanism would be a second way of drawing the same
 * thing. Views compose these; they do not re-type the markup, so a change to
 * how a disclosure or a status plate looks is a change in one place.
 *
 * Nothing here decides anything or fetches anything. Copy is the caller's: a
 * component that supplied its own words would put the same sentence on screens
 * that mean different things.
 */
import { $, esc } from './core.js';
import { ICONS } from './icons.js';

// ── page anatomy ─────────────────────────────────────────────────────────────

/**
 * The 64px bar above every page: where you are, and nothing else.
 *
 * `crumbs` is a list of `{ label, go?, sel?, q?, back? }`. A crumb with `back`
 * gets the arrow and is the way out; the last crumb is where you are and is
 * never a link.
 *
 * It used to carry a dot and a line of status on the right — "12 active
 * rules", "Loading the log…", "Gateway running · demo mode". Every one of them
 * repeated something the page already said louder: the count is in the table,
 * the loading state is the plate in the middle of the screen, and the demo
 * banner says demo. A status that is never the reason you looked at the corner
 * is furniture, and it was on every screen.
 */
export function contextBar(crumbs = []) {
  const parts = crumbs.map((c, i) => {
    const last = i === crumbs.length - 1;
    const label = `${c.back ? '← ' : ''}${esc(c.label)}`;
    if ((last && !c.back) || !c.go) return `<span class="crumb${last ? ' --here' : ''}">${label}</span>`;
    return `<button type="button" class="crumb" data-go="${esc(c.go)}"${c.sel ? ` data-sel="${esc(c.sel)}"` : ''}${c.q ? ` data-q="${esc(c.q)}"` : ''}>${label}</button>`;
  });
  return `<div class="context-bar">
    <nav class="crumbs" aria-label="Breadcrumb">${parts.join('<span class="crumb-sep" aria-hidden="true">/</span>')}</nav>
  </div>`;
}

/** Header / Page: the title, one line of context, and zero to two actions. */
export function pageHead({ title, sub = '', subMuted = false, actions = '' }) {
  return `<header class="page-head">
    <div class="page-head-text">
      <h1 class="page-title">${esc(title)}</h1>
      ${sub ? `<p class="page-sub${subMuted ? ' --muted' : ''}">${sub}</p>` : ''}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </header>`;
}

/** Tabs / Team, Tabs / Models: sub-sections of one page, never navigation. */
export function tabs(view, items, current, label) {
  return `<nav class="tabs" aria-label="${esc(label)}">${items.map(([sel, text, mark]) => `<button type="button" class="tab${sel === current ? ' --on' : ''}"${sel === current ? ' aria-current="page"' : ''} data-go="${esc(view)}"${sel ? ` data-sel="${esc(sel)}"` : ''}>${esc(text)}${mark ? ' •' : ''}</button>`).join('')}</nav>`;
}

// ── controls ─────────────────────────────────────────────────────────────────

/**
 * Button. `kind` is primary (graphite fill), quiet (outlined, the default) or
 * danger (outlined, the refusal red for the label, never a red fill); `link`
 * is the borderless one a header uses for a secondary word like "View
 * instruction".
 */
export function button(label, { kind = 'quiet', compact = false, id = '', attrs = '', disabled = false, busy = false } = {}) {
  const cls = ['btn', kind !== 'quiet' ? `--${kind}` : '', compact ? '--compact' : '', busy ? '--busy' : ''].filter(Boolean).join(' ');
  return `<button type="button" class="${cls}"${id ? ` id="${esc(id)}"` : ''}${attrs ? ` ${attrs}` : ''}${disabled || busy ? ' disabled' : ''}${busy ? ' aria-busy="true"' : ''}>${esc(label)}</button>`;
}

/**
 * Menu, on a native `<details>` so it opens and closes without a listener per
 * render. `items` are `{ label, act?, id?, attrs?, destructive?, disabled?,
 * check?, dot?, note? }`; destructive goes last by the caller's order, which
 * is the component's rule. `trigger` is the summary's content, "···" by
 * default; `align` is "right" for a row menu (right edges meet) or "left" for
 * a menu hanging from a value.
 */
export function menu(items, { label = 'More actions', trigger = '···', align = 'right', cls = '', triggerCls = '' } = {}) {
  return `<details class="menu --${align}${cls ? ` ${cls}` : ''}">
    <summary class="menu-trigger${trigger === '···' ? ' --dots' : ''}${triggerCls ? ` ${triggerCls}` : ''}" aria-label="${esc(label)}">${trigger}</summary>
    <div class="menu-list" role="menu">${items.map(menuItem).join('')}</div>
  </details>`;
}

export function menuItem(it) {
  if (it.note) return `<div class="menu-note">${esc(it.note)}</div>`;
  const cls = `menu-item${it.destructive ? ' --destructive' : ''}${it.cls ? ` ${it.cls}` : ''}`;
  return `<button type="button" role="menuitem" class="${cls}"${it.id ? ` id="${esc(it.id)}"` : ''}${it.act ? ` data-act="${esc(it.act)}"` : ''}${it.attrs ? ` ${it.attrs}` : ''}${it.disabled ? ' disabled' : ''}>
    ${it.dot ? `<i class="menu-dot --${esc(it.dot)}"></i>` : ''}<span>${esc(it.label)}</span>${it.check ? '<b class="menu-check" aria-label="current">✓</b>' : ''}
  </button>`;
}

// A menu closes when you click anywhere else, or press Escape. Once for the
// document, not per render: menus are rebuilt with every render and this is not.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    for (const m of document.querySelectorAll('details.menu[open]')) if (!m.contains(e.target)) m.removeAttribute('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const m of document.querySelectorAll('details.menu[open]')) { m.removeAttribute('open'); m.querySelector('summary')?.focus(); }
  });
  // Only one menu open at a time: opening a second closes the first.
  document.addEventListener('toggle', (e) => {
    if (!(e.target instanceof HTMLDetailsElement) || !e.target.classList.contains('menu') || !e.target.open) return;
    for (const m of document.querySelectorAll('details.menu[open]')) if (m !== e.target) m.removeAttribute('open');
  }, true);
}

/** Search: the field with its magnifier inside the box. */
export function search(id, value, placeholder) {
  return `<label class="search">${ICONS.search}<input type="text" id="${esc(id)}" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" autocomplete="off"></label>`;
}

/** Segmented filters: counts you switch between, the lit one filled. */
export function filters(items, current, dataName) {
  return `<div class="filter-set" role="group">${items.map(([value, text]) => `<button type="button" class="filter${value === current ? ' --on' : ''}" data-${dataName}="${esc(value)}" aria-pressed="${value === current}">${esc(text)}</button>`).join('')}</div>`;
}

// ── content ──────────────────────────────────────────────────────────────────

/**
 * Feedback: a plate across the width for state that is not a row — empty,
 * loading, a failure, a warning. `tone` is info (grey), attention, success or
 * error. The title says what happened, the body what was kept and what to do.
 */
export function feedback({ tone = 'info', title, body = '', icon = false, id = '' }) {
  return `<div class="feedback --${tone}"${id ? ` id="${esc(id)}"` : ''} role="${tone === 'error' || tone === 'attention' ? 'alert' : 'status'}">
    <b class="feedback-title">${icon ? '<i class="feedback-icon" aria-hidden="true">⚠</i>' : ''}${esc(title)}</b>
    ${body ? `<div class="feedback-body">${body}</div>` : ''}
  </div>`;
}

/**
 * The list-state mould (spec §6.0): the header stays, the table and filters go
 * (except for "no results", where the filters stay with their value), one
 * plate, and a button only when there is a real action.
 */
export function listState({ tone = 'info', title, body, action = '', icon = false }) {
  return `<div class="list-state">${feedback({ tone, title, body: esc(body), icon })}${action ? `<div class="list-state-action">${action}</div>` : ''}</div>`;
}

/** Group band: the day in Activity, the group in Inbox. */
export function groupBand(label, n) {
  return `<div class="group-band">${esc(label)}${n != null ? ` · ${n}` : ''}</div>`;
}

/**
 * Disclosure / Row. One line: the title on the left, the datum and the chevron
 * on the right. The datum is only there when it reports state; one that merely
 * previews the content is not a datum. Open state lives in `state.open` via
 * `data-key`, so it survives a re-render (see `bindDisclosures`).
 */
export function disclosureRow(key, title, datum, body, { open = false, big = false, id = '' } = {}) {
  return `<details class="disclosure${big ? ' --section' : ''}" data-key="${esc(key)}"${open ? ' open' : ''}${id ? ` id="${esc(id)}"` : ''}>
    <summary><span class="disclosure-title">${esc(title)}</span><span class="disclosure-datum">${datum ? `<span>${datum}</span>` : ''}<i class="chev" aria-hidden="true"></i></span></summary>
    <div class="disclosure-body">${body}</div>
  </details>`;
}

// ── identity and verdicts ────────────────────────────────────────────────────

const ROLE_TONES = new Set(['admin', 'employee', 'sales', 'solo']);
/** A role has an identity colour only if the system names one; the rest share "everyone". */
export const roleTone = (role) => (ROLE_TONES.has(role) ? role : 'everyone');

/** Label / Role: an outlined chip in the role's colour. Identity, not severity. */
export function roleLabel(role, text = role) {
  return `<span class="role-label --${roleTone(role)}">${esc(text)}</span>`;
}

/** An audience as role labels: Everyone, a role, or a person by name. */
export function audienceLabels(appliesTo, personName, max = Infinity) {
  if (!appliesTo?.length || appliesTo.includes('*')) return roleLabel('everyone', 'Everyone');
  const label = (t) => (t.startsWith('@') ? roleLabel('everyone', personName(t.slice(1))) : roleLabel(t));
  // A table cell has room for one label; the rest are counted, not clipped.
  if (appliesTo.length > max) return appliesTo.slice(0, max).map(label).join('') + `<span class="labels-more" title="${esc(appliesTo.slice(max).map((t) => (t.startsWith('@') ? personName(t.slice(1)) : t)).join(', '))}">+${appliesTo.length - max}</span>`;
  return appliesTo.map(label).join('');
}

const EFFECT = {
  block: { word: 'Block', glyph: '⊘' },
  escalate: { word: 'Escalate', glyph: '↗' },
  warn: { word: 'Warn', glyph: '!' }
};
const EFFECT_TONE = { block: 'block', escalate: 'attention', warn: 'attention' };

/** Badge / Effect: tinted, for cards and detail pages only. */
export function badgeEffect(severity) {
  const e = EFFECT[severity] ?? { word: severity, glyph: '' };
  return `<span class="badge-effect --${EFFECT_TONE[severity] ?? 'muted'}">${e.glyph ? `${e.glyph} ` : ''}${esc(e.word)}</span>`;
}

/** The effect inside a table row: plain coloured text and a dot, no box. */
export function effectText(severity) {
  const e = EFFECT[severity] ?? { word: severity, glyph: '' };
  const prefix = severity === 'block' ? '' : `${e.glyph} `;
  return `<span class="effect-text --${EFFECT_TONE[severity] ?? 'muted'}"><i class="dot"></i>${prefix}${esc(e.word)}</span>`;
}

/**
 * The three verdicts, in words rather than in the enum.
 *
 * `ESCALATE` is what the code calls it and it is the right name there — it is
 * a position in a lattice. On a screen it is jargon: nobody outside this repo
 * knows whether an escalated request was refused, and the whole point of that
 * verdict is that it was not. What happened is that it is waiting for a
 * person, so that is what it says.
 */
export const VERDICT_WORD = { BLOCK: 'Blocked', ESCALATE: 'Held', ALLOW: 'Allowed' };
export const VERDICT_TONE = { BLOCK: 'block', ESCALATE: 'attention', ALLOW: 'allow' };

export function verdictText(verdict) {
  return `<span class="verdict-text --${VERDICT_TONE[verdict] ?? 'muted'}">${esc(VERDICT_WORD[verdict] ?? verdict)}</span>`;
}

/** Badge / Verdict: tinted, in words. */
export function badgeVerdict(verdict) {
  const glyph = { BLOCK: '⊘ ', ESCALATE: '↗ ', ALLOW: '● ' }[verdict] ?? '';
  return `<span class="badge-verdict --${VERDICT_TONE[verdict] ?? 'muted'}">${glyph}${esc(VERDICT_WORD[verdict] ?? verdict)}</span>`;
}

/** A status said as coloured text with a dot beside it, never a button. */
export function statusText(text, tone = '') {
  return `<span class="status-text${tone ? ` --${tone}` : ''}">${tone ? '<i class="dot"></i>' : ''}${esc(text)}</span>`;
}

/** Chip / File. */
export function fileChip(name, size) {
  return `<span class="file-chip">${esc(name)}${size ? ` · ${esc(size)}` : ''}</span>`;
}

// ── turns, confirmations and toasts ──────────────────────────────────────────

/** Card / Turn. Person is grey and borderless; Warden is raised with a hairline. */
export function turn(voice, { who = '', body, end = false, cls = '' }) {
  return `<div class="turn --${voice}${end ? ' --end' : ''}${cls ? ` ${cls}` : ''}">${who ? `<div class="turn-who">${who}</div>` : ''}${body}</div>`;
}

/** Confirmation / Result: the persistent card a finished operation leaves. */
export function confirmResult({ tone = 'success', title, body, action = '' }) {
  return `<div class="confirm-result --${tone}" role="status">
    <i class="confirm-mark" aria-hidden="true">${tone === 'success' ? '✓' : '!'}</i>
    <div class="confirm-text"><b>${esc(title)}</b><div>${body}</div></div>
    ${action ? `<div class="confirm-action">${action}</div>` : ''}
  </div>`;
}

/**
 * A dialog over a scrim. Rendered by the view as part of its body, so it
 * follows the same re-render as everything else; `position: fixed` puts it
 * over the sidebar too, which is what the frames show.
 */
export function dialog({ id = 'dialog', title, body, actions, close = true }) {
  return `<div class="dialog-scrim" data-dialog-scrim="${esc(id)}">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="${esc(id)}Title">
      ${title || close ? `<div class="dialog-head"><h2 id="${esc(id)}Title">${esc(title)}</h2>${close ? `<button type="button" class="dialog-close" data-dialog-close="${esc(id)}" aria-label="Close">×</button>` : ''}</div>` : ''}
      <div class="dialog-body">${body}</div>
      <div class="dialog-actions">${actions}</div>
    </div>
  </div>`;
}

/**
 * Toast: "saved" and nothing else. It lives outside the pane so a re-render
 * does not take it away; six seconds, paused while the pointer or focus is on
 * it, and a close button, because a notice that vanishes while being read is
 * not a notice.
 */
let toastTimer = null;
export function showToast(title, body = '') {
  if (typeof document === 'undefined') return;
  $('toast')?.remove();
  const el = document.createElement('div');
  el.id = 'toast';
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<i class="toast-mark" aria-hidden="true">✓</i><div class="toast-text"><b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}</div><button type="button" class="toast-close" aria-label="Dismiss">×</button>`;
  document.body.append(el);
  const hide = () => { clearTimeout(toastTimer); el.remove(); };
  const arm = () => { clearTimeout(toastTimer); toastTimer = setTimeout(hide, 6000); };
  el.querySelector('.toast-close').onclick = hide;
  el.onmouseenter = el.onfocusin = () => clearTimeout(toastTimer);
  el.onmouseleave = el.onfocusout = arm;
  arm();
}

/** Composer: the box a request or an instruction is written in. */
export function composer({ id, sendId, placeholder, sendLabel, busy = false, disabled = false, attach = '', value = '', rows = 1, cls = '' }) {
  return `<div class="composer${cls ? ` ${cls}` : ''}">
    <textarea id="${esc(id)}" rows="${rows}" aria-label="${esc(placeholder)}" placeholder="${esc(placeholder)}"${busy ? ' disabled' : ''}>${esc(value)}</textarea>
    <div class="composer-row">
      ${attach}
      <span class="composer-fill"></span>
      <button type="button" class="btn --primary" id="${esc(sendId)}"${disabled || busy ? ' disabled' : ''}>${esc(sendLabel)}</button>
    </div>
  </div>`;
}

