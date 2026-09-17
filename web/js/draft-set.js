/**
 * A proposal: the rules one instruction became, their checks, and activating them.
 *
 * `draft.js` owns the conversation — what is sent to the compiler and what
 * comes back. This module owns what the administrator decides on: one card
 * per drafted rule, the check that runs down them one by one, excluding a card
 * or putting it back, the dialog that is the reading before anything binds
 * anyone, and the activation that reports rule by rule what actually went live.
 *
 * Every rule is a card in a set, even when the instruction was one rule. There
 * used to be two shapes — a single draft card with its own Activate, and a
 * list of set cards with another — and the same decision was taken through two
 * different screens depending on which compiler happened to be configured.
 */
import { $, REGRESSION_SAMPLE, esc, post, state } from './core.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { audienceLabel, plural, ruleName } from './format.js';
import { render } from './render.js';
import { go } from './router.js';
import { limitsPlan, readable } from './answers.js';
import { audience } from './rules.js';
import { badgeEffect, button, confirmResult, dialog, feedback, menu, pageHead, turn } from './ui.js';

const EFFECT_WORD = { block: 'Block', escalate: 'Escalate', warn: 'Warn' };
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

/** The rules that would be activated: not excluded, not already live. */
export const included = (set) => set.items.filter((it) => it.status !== 'excluded' && it.status !== 'active');
const excluded = (set) => set.items.filter((it) => it.status === 'excluded');
const active = (set) => set.items.filter((it) => it.status === 'active');
const checking = (set) => set.items.some((it) => it.status === 'pending' || it.status === 'checking');

/** What the check found, as numbers a sentence can be made of. */
function findings(preview) {
  const rows = preview?.rows ?? [];
  const wrong = rows.filter((r) => r.isFalsePositive);
  const misses = rows.filter((r) => r.isMiss);
  return {
    total: rows.length,
    fine: rows.length - wrong.length - misses.length,
    held: wrong.filter((r) => r.verdict === 'ESCALATE').length,
    blocked: wrong.filter((r) => r.verdict === 'BLOCK').length,
    misses: misses.length,
    rows: [...wrong, ...misses]
  };
}

const flagged = (it) => !state.mock && it.preview && (it.preview.falsePositives > 0 || it.preview.misses > 0);

function findingWords(f) {
  const parts = [];
  if (f.held) parts.push(`${f.held} compliant ${f.held === 1 ? 'example was' : 'examples were'} held`);
  if (f.blocked) parts.push(`${f.blocked} compliant ${f.blocked === 1 ? 'example was' : 'examples were'} blocked`);
  if (f.misses) parts.push(`${f.misses} violating ${f.misses === 1 ? 'example' : 'examples'} slipped through`);
  return parts;
}

/**
 * The check under a card, in the card's words.
 *
 * In demo mode the check ran on the stand-in, which judges nothing, so the
 * counts are not findings about this rule and must not be dressed as them. A
 * person evaluating Warden with no models downloaded was being told their rule
 * missed two of its own examples — a criticism produced by a test double, of a
 * rule a test double wrote.
 */
function checkLine(it, { revised = false, result = false } = {}) {
  if (it.status === 'active') return '<span class="proposal-check --allow">● Active · this rule is enforcing now</span>';
  if (it.status === 'activating') return '<span class="proposal-check">Activating… · waiting for confirmation</span>';
  if (it.status === 'failed' && result) return `<span class="proposal-check --attention">! Not activated · your draft was kept</span>${it.error ? `<span class="proposal-why">${esc(it.error)}</span>` : ''}`;
  if (it.status === 'excluded') return '<span class="proposal-check --muted">Excluded · this draft will not be activated</span>';
  if (revised) return '<span class="proposal-check">Checks pending · revised draft</span>';
  if (state.mock) return '<span class="proposal-check --muted">Not checked · no model is installed, so nothing on this card was judged</span>';
  if (it.status === 'pending' || it.status === 'checking') return '<span class="proposal-check --muted">Checking it against its examples…</span>';
  if (it.status === 'error' || !it.preview) return '<span class="proposal-check --attention">! The check did not finish · read the draft before activating it</span>';
  const f = findings(it.preview);
  if (!f.rows.length) return `<span class="proposal-check --allow">✓ ${f.total} of ${f.total} examples judged as intended</span>`;
  return `<span class="proposal-check --attention">! ${f.fine} of ${f.total} as intended · ${findingWords(f).join(' · ')}</span>
    <ul class="proposal-examples">${f.rows.map((r) => `<li>“${esc(r.prompt)}”</li>`).join('')}</ul>`;
}

function card(it, i, { revised = false, result = false } = {}) {
  const d = it.rule;
  const live = it.status === 'active' || it.status === 'activating';
  const canAct = !live && !revised && !result && it.status !== 'excluded' && !state.set?.activating;
  return `<article class="proposal${it.status === 'excluded' ? ' --excluded' : ''}" aria-label="${esc(ruleName(d))}">
    <div class="proposal-head">
      <b>${esc(ruleName(d))}</b>
      ${badgeEffect(d.severity)}
      ${canAct ? menu([
        { label: 'Edit draft', act: 'set-edit', attrs: `data-set-i="${i}"` },
        { label: 'Exclude from activation', act: 'set-exclude', attrs: `data-set-i="${i}"` }
      ], { label: `Actions for ${ruleName(d)}` }) : ''}
    </div>
    <p class="proposal-text">${esc(d.text)}</p>
    ${(d.appliesTo ?? []).includes('*') ? '' : `<div class="proposal-applies"><span>Applies to</span><span class="labels">${audience(d.appliesTo)}</span></div>`}
    ${checkLine(it, { revised, result })}
    ${it.status === 'excluded' && !result ? `<div>${button('Restore draft', { compact: true, attrs: `data-act="set-restore" data-set-i="${i}"` })}</div>` : ''}
  </article>`;
}

/** The part of a sentence that was a spending target, answered beside the rules. */
function limitsNote(set) {
  if (typeof set.factor !== 'number') return '';
  return `<div class="proposal-limits">${limitsPlan(set)}</div>`;
}

function summary(set) {
  const inc = included(set).length;
  const exc = excluded(set).length;
  const act = active(set).length;
  if (set.activating) return `${act} active · ${plural(inc, 'draft')} pending`;
  if (set.failed) return `${act} activated · ${plural(inc, 'draft')} kept`;
  const parts = [`${plural(inc, 'rule')} included`];
  if (exc) parts.push(`${exc} excluded`);
  if (act) parts.push(`${act} active`);
  else if (!exc) parts.push('nothing active yet');
  return parts.join(' · ');
}

function leadLine(set) {
  const inc = included(set);
  if (set.activating) {
    const done = active(set).length;
    return `${done} of ${done + inc.length} rules activated. ${inc.length === 1 ? 'Activating the remaining rule…' : `Activating the remaining ${inc.length}…`}`;
  }
  if (set.failed) {
    return inc.length === 1 ? 'Activation failed. The rule was not activated. The draft is still here.'
      : inc.length === 2 ? 'Activation failed. Neither rule was activated. Both drafts are still here.'
        : `Activation failed. None of the ${inc.length} rules was activated. Every draft is still here.`;
  }
  if (set.revision?.error) return 'Current drafts · unchanged';
  return set.remote
    ? 'Your instruction was sent to the compiler. Review each draft before activation.'
    : 'Drafted on this machine. Review each draft before activation.';
}

/** The proposal in the conversation: label, lead, cards, limits, and the one action. */
export function proposalsBlock() {
  const set = state.set;
  if (!set || set.revision?.set) return '';
  const drafted = set.draftedBy ? ` · Drafted with ${esc(set.draftedBy)}` : '';
  const inc = included(set);
  const busy = state.ruleBusy || checking(set) || set.activating;
  const action = set.failed
    ? button('Retry activation', { kind: 'primary', id: 'retryActivation', disabled: state.ruleBusy })
    : set.activating
      ? button('Activating…', { kind: 'primary', busy: true })
      : inc.length ? button(checking(set) ? 'Checking each draft…' : 'Review activation', { kind: 'primary', id: 'reviewActivation', disabled: busy }) : '';
  return `<section class="proposals" aria-label="Proposed rules">
    <div class="warden-label">Warden${drafted}</div>
    <p class="warden-lead">${esc(leadLine(set))}</p>
    ${set.items.map((it, i) => card(it, i)).join('')}
    ${limitsNote(set)}
    ${set.revision?.error
      ? `${feedback({ tone: 'error', title: 'Could not revise the drafts', body: `Your current drafts, edits and exclusions are unchanged.<br>Your refinement is still in the box below.${set.revision.why ? `<br>${esc(set.revision.why)}` : ''}`, icon: true })}
        <div>${button('Keep current drafts', { id: 'keepDrafts' })}</div>`
      : `<div class="proposal-foot">${action}<span>${esc(summary(set))}</span></div>`}
    ${state.reviewOpen ? reviewDialog(set) : ''}
  </section>`;
}

/** The revised set, held beside the current one until the administrator picks. */
export function revisionBlock() {
  const set = state.set;
  const rev = set?.revision?.set;
  if (!rev) return '';
  return `<section class="proposals" aria-label="Revised proposal">
    <div class="warden-label">Warden · Revised proposal</div>
    <p class="warden-lead">${esc(set.revision.text)}</p>
    ${rev.items.map((it, i) => card(it, i, { revised: true })).join('')}
    ${feedback({ tone: 'attention', title: 'Replacing drafts needs a fresh review', body: 'This replaces pending drafts, including manual edits.<br>Review exclusions again; active rules will not change.' })}
    <div class="btn-row">${button('Use revised drafts', { kind: 'primary', id: 'useRevision' })}${button('Keep current drafts', { id: 'keepDrafts' })}</div>
  </section>`;
}

/**
 * The reading before anything binds anyone.
 *
 * What each rule is, what it does, who it reaches, and what its check found,
 * in a dialog that has to be answered. This is where the audience is
 * confirmed: the server falls back to Everyone if a draft reaches ratify with
 * no audience, and a rule going live on Everyone because nobody looked is the
 * failure the old per-card confirm step existed to prevent.
 */
function reviewDialog(set) {
  const inc = included(set);
  const n = inc.length;
  const audiences = [...new Set(inc.map((it) => audienceLabel(it.rule.appliesTo)))];
  const shared = audiences.length === 1 ? audiences[0].replace(/^everyone$/, 'Everyone') : null;
  const lead = n === 1
    ? `It applies to ${esc(shared)} and starts enforcing when activation succeeds.`
    : shared ? `They apply to ${esc(shared)} and start enforcing as each activation succeeds.` : 'They start enforcing as each activation succeeds.';
  const worrying = inc.map((it, i) => ({ it, i })).filter(({ it }) => flagged(it));
  const findingsText = worrying.map(({ it, i }) => {
    const f = findings(it.preview);
    const who = n === 1 ? 'The rule' : `The ${ORDINAL[i] ?? `#${i + 1}`} rule`;
    const bits = [];
    if (f.held) bits.push(`held ${plural(f.held, 'compliant example')}`);
    if (f.blocked) bits.push(`blocked ${plural(f.blocked, 'compliant example')}`);
    if (f.misses) bits.push(`let ${plural(f.misses, 'violating example')} through`);
    return `${who} ${bits.join(' and ')}.`;
  });
  return dialog({
    id: 'reviewActivation',
    title: n === 1 ? 'Activate this rule?' : `Activate these ${n} rules?`,
    body: `<p>${lead}</p>
      <ol class="review-list">${inc.map((it) => `<li>${esc(ruleName(it.rule))} · ${EFFECT_WORD[it.rule.severity] ?? esc(it.rule.severity)}${shared ? '' : ` · applies to ${esc(audienceLabel(it.rule.appliesTo))}`}</li>`).join('')}</ol>
      ${state.mock ? feedback({ tone: 'attention', title: '! Nothing was checked', body: 'No model is installed, so these drafts were never judged against their examples.' }) : ''}
      ${worrying.length ? feedback({ tone: 'attention', title: worrying.length === 1 ? '! One test needs review' : `! ${worrying.length} tests need review`, body: `${findingsText.join('<br>')} Edit the draft if that is not intended.` }) : ''}
      ${typeof set.factor === 'number' ? '<p>The spending target is not included — its limits are applied separately.</p>' : ''}`,
    actions: button('Back to drafts', { id: 'closeReview' }) + button(n === 1 ? 'Activate 1 rule' : `Activate ${n} rules`, { kind: 'primary', id: 'confirmActivation' })
  });
}

/**
 * Activation result: what went live, what did not, and the one next step.
 * A partial success is said as one, and retry only touches what failed.
 */
export function resultPage() {
  const set = state.set;
  const partial = set.result === 'partial';
  const shown = set.items.filter((it) => it.status !== 'excluded');
  const live = active(set);
  const failedItems = set.items.filter((it) => it.status === 'failed');
  const firstSaid = state.ruleChat.find((t) => t.from === 'you')?.text;
  const who = (items) => {
    const a = [...new Set(items.map((it) => audienceLabel(it.rule.appliesTo)))];
    return a.length === 1 ? a[0].replace(/^everyone$/, 'Everyone') : 'the people each one names';
  };
  const body = partial
    ? `${live.length === 1 ? 'One rule now applies' : `${live.length} rules now apply`} to ${esc(who(live))}. ${failedItems.length === 1 ? 'The other is still a draft.' : `${failedItems.length} are still drafts.`}<br>Retry only attempts to activate the pending ${failedItems.length === 1 ? 'rule' : 'rules'}.`
    : `${live.length === 1 ? 'The rule now applies' : live.length === 2 ? 'Both rules now apply' : `All ${live.length} rules now apply`} to ${esc(who(live))}.`;
  return `<div class="sheet thread-page">
    ${pageHead({
      title: 'Activation result',
      crumbs: [{ label: state.draftFor ? 'Back to person' : 'Back to rules', go: state.draftFor ? 'people' : 'policy', sel: state.draftFor ?? '' }]
    })}
    <div class="thread">
      ${firstSaid ? turn('person', { body: esc(firstSaid), end: true }) : ''}
      <!-- "Review the activated rules" was the header's second line. The
           confirmation card at the foot of this thread already says what
           activated and what did not, with the button that retries; an
           instruction to read the page you are reading is not a second fact. -->
      <div class="warden-label">${partial ? 'Activation details' : 'Activated rules'}</div>
      ${shown.map((it) => card(it, set.items.indexOf(it), { result: true })).join('')}
      ${limitsNote(set)}
      ${confirmResult({
        tone: partial ? 'attention' : 'success',
        title: partial ? `${live.length} of ${live.length + failedItems.length} rules activated` : `${plural(live.length, 'rule')} activated`,
        body,
        action: partial
          ? button(failedItems.length === 1 ? 'Retry failed rule' : 'Retry failed rules', { kind: 'primary', id: 'retryFailed' })
          : button(state.draftFor ? 'Back to person' : 'Back to rules', { kind: 'primary', id: 'leaveResult' })
      })}
    </div>
  </div>`;
}

/**
 * Check every card in the set, one after the other.
 *
 * Sequential because each check is a handful of real adjudications on the
 * local model, and the set can be eight rules; run at once they would queue
 * behind each other anyway and the cards would all sit on "checking". One at
 * a time, the first card's verdict is on screen while the last is still
 * being judged. Stops quietly if the set was discarded or replaced meanwhile.
 */
export async function runSetPreviews(set) {
  for (const item of set.items) {
    if (state.set !== set) return;
    if (item.status !== 'pending') continue;
    item.status = 'checking';
    render();
    const { ok, j } = await post('/api/policy/preview', { rule: item.rule }).catch(() => ({ ok: false, j: null }));
    if (state.set !== set) return;
    if (item.status === 'checking') {
      item.preview = ok ? j : null;
      item.status = ok ? 'checked' : 'error';
    }
    render();
  }
  if (state.set === set) offerRegression(set);
}

/** Recent allowed prompts, offered as a regression check on a one-rule proposal. */
export const regressionSample = () => state.audit
  .filter((a) => a.decision?.verdict === 'ALLOW' && a.decision.maskedPrompt)
  .slice(0, REGRESSION_SAMPLE);

/**
 * One rule, cleanly checked: offer to replay what Warden already allowed.
 *
 * Only for a proposal of one. Replaying five real requests is five
 * adjudications per rule, and against an eight-rule set that is forty model
 * calls on a question the administrator did not ask.
 */
function offerRegression(set) {
  const inc = included(set);
  if (state.mock || inc.length !== 1 || inc[0].status !== 'checked' || flagged(inc[0]) || set.replayed) return;
  const n = regressionSample().length;
  if (!n) return;
  set.replayOffer = n;
  render();
}

async function replay(set) {
  const item = included(set)[0];
  if (!item) return;
  set.replayOffer = 0;
  set.replayed = 'running';
  render();
  const against = regressionSample().map((a) => ({ prompt: a.decision.maskedPrompt, expected: 'ALLOW' }));
  const { ok, j } = await post('/api/policy/preview', { rule: item.rule, against }).catch(() => ({ ok: false, j: null }));
  if (state.set !== set) return;
  if (!ok) { set.replayed = { error: readable(j?.error ?? 'Warden could not be reached.') }; render(); return; }
  item.preview = j;
  set.replayed = { stopped: j.rows.filter((r) => r.source === 'log' && r.isFalsePositive).map((r) => r.prompt), total: against.length };
  render();
}

export function replayMarkup() {
  const set = state.set;
  if (!set || set.revision?.set || set.result) return '';
  if (set.replayOffer) {
    return `<div class="warden-note"><p>Want me to replay the last ${set.replayOffer} requests Warden allowed and see if this rule would have stopped any?</p>${button(`Replay ${set.replayOffer} real requests`, { compact: true, id: 'regressBtn' })}</div>`;
  }
  if (set.replayed === 'running') return turn('warden', { body: `<b class="turn-title">Replaying ${plural(regressionSample().length, 'request')} Warden already allowed…</b><span class="turn-note">Each one is judged against this draft on this machine. Nothing is activated.</span>` });
  if (set.replayed?.error) return feedback({ tone: 'error', title: 'The replay did not finish', body: esc(set.replayed.error), icon: true });
  if (set.replayed?.stopped) {
    return set.replayed.stopped.length
      ? feedback({ tone: 'attention', title: `${plural(set.replayed.stopped.length, 'real request')} would have been stopped`, body: `${set.replayed.stopped.map((p) => `“${esc(p)}”`).join('<br>')}<br>Refine the draft below if these should still go through.` })
      : feedback({ tone: 'success', title: `None of those ${set.replayed.total} real requests would have been stopped`, body: 'Safe to activate.' });
  }
  return '';
}

/** Ratify one rule, and say whether the gateway took it. */
async function ratify(item) {
  const { ok, j } = await post('/api/policy/ratify', { rule: item.rule }).catch(() => ({ ok: false, j: { error: 'Warden could not be reached.' } }));
  item.status = ok ? 'active' : 'failed';
  item.error = ok ? '' : readable(j?.error ?? 'The gateway refused it.');
  return ok;
}

async function activate(set, items) {
  set.failed = false;
  set.activating = true;
  state.reviewOpen = false;
  for (const it of items) it.status = 'activating';
  render();
  for (const it of items) {
    if (state.set !== set) return;
    await ratify(it);
    render();
  }
  set.activating = false;
  await Promise.all([refreshPolicy(), refreshPeople()]);
  if (state.set !== set) return;
  const failedNow = items.filter((it) => it.status === 'failed');
  if (!failedNow.length) set.result = 'done';
  else if (active(set).length) set.result = 'partial';
  else {
    // Nothing went live: back to the drafts, with their checks as they were.
    for (const it of items) it.status = it.preview ? 'checked' : 'error';
    set.failed = true;
  }
  render();
}

export function bindSet(resetDraft) {
  const set = state.set;
  if (!set) return;
  const at = (el) => set.items[Number(el.dataset.setI)];

  const review = $('reviewActivation');
  if (review) review.onclick = () => { state.reviewOpen = true; render(); $('confirmActivation')?.focus(); };
  const closeReview = () => { state.reviewOpen = false; render(); $('reviewActivation')?.focus(); };
  if ($('closeReview')) $('closeReview').onclick = closeReview;
  const scrim = document.querySelector('[data-dialog-scrim="reviewActivation"]');
  if (scrim) scrim.onclick = (e) => { if (e.target === scrim || e.target.closest('[data-dialog-close]')) closeReview(); };
  const confirm = $('confirmActivation');
  if (confirm) confirm.onclick = () => void activate(set, included(set));
  const retry = $('retryActivation');
  if (retry) retry.onclick = () => void activate(set, included(set));
  const retryFailed = $('retryFailed');
  if (retryFailed) retryFailed.onclick = () => { set.result = null; void activate(set, set.items.filter((it) => it.status === 'failed')); };
  const back = $('leaveResult');
  if (back) back.onclick = () => { const person = state.draftFor; resetDraft(); if (person) go('people', person); else go('policy'); };
  const regress = $('regressBtn');
  if (regress) regress.onclick = () => void replay(set);

  for (const el of document.querySelectorAll('[data-act^="set-"]')) el.onclick = () => {
    el.closest('details.menu')?.removeAttribute('open');
    const item = at(el);
    if (!item) return;
    const act = el.dataset.act;
    if (act === 'set-exclude') { item.status = 'excluded'; render(); }
    else if (act === 'set-restore') {
      item.status = item.preview ? 'checked' : 'pending';
      render();
      if (item.status === 'pending') void runSetPreviews(set);
    } else if (act === 'set-edit') {
      set.editing = set.items.indexOf(item);
      set.edit = null;
      render();
    }
  };
}
