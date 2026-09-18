/**
 * Activity: the decision log grouped by day, and one decision as its own page.
 */
import { $, attr, esc, state } from './core.js';
import { documentMetadataMarkup } from './documents.js';
import { refreshAudit, refreshChain } from './data.js';
import { actorName, clip, dayKey, dayLabel, fileSize, hhmm, personById, plural, ruleName, shortHash } from './format.js';
import { disclosure, render } from './render.js';
import { go } from './router.js';
import {
  VERDICT_TONE, VERDICT_WORD, badgeEffect, button, fileChip, filters, groupBand,
  listState, outcome, outcomeText, pageHead, turn, verdictText
} from './ui.js';
import { VIEWS } from './views.js';

// ═══ ACTIVITY ════════════════════════════════════════════════════════════════

/** Held and still unanswered. The sidebar counts these, not the ones already
 *  dealt with — a badge that never goes down stops being read. */
export function pendingEscalations() { return state.escalations.filter((e) => !e.review); }

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const counted = (n, one, many) => `${NUMBER_WORDS[n] ?? n} ${n === 1 ? one : many}`;

/** A masked secret is shown as the bar it is, not as the marker's text. */
export function promptMarkup(text) {
  return esc(text).replace(/\[REDACTED:([^\]]*)\]/g, (_m, kind) => `<span class="masked" role="img" aria-label="${kind} masked" title="${kind} masked before checking"></span>`);
}

export function visibleAudit() {
  return state.audit.filter((a) => {
    const d = a.decision ?? {};
    // A paused request is not in any verdict bucket. It carries ALLOW and was
    // never judged, so counting it under "Allowed" would put it behind the one
    // filter an administrator uses to mean "the policy looked and found
    // nothing".
    const unjudged = Boolean(d.notJudged);
    if (state.filter === 'paused' ? !unjudged : state.filter !== 'all' && (unjudged || d.verdict !== state.filter)) return false;
    if (state.actorFilter && a.actor?.id !== state.actorFilter) return false;
    if (state.query.rule && !(d.firedRules ?? []).some((r) => r.ruleId === state.query.rule)) return false;
    return true;
  });
}

/**
 * The shape of the day, as the page's own line of context.
 *
 * Opening a console should answer "do I have to do something?" before it
 * answers "what happened?". Every number here comes from the audit records
 * already loaded — there is no second surface and no new endpoint behind it.
 */
function todayLine() {
  const today = dayKey(new Date().toISOString());
  const rows = state.audit.filter((a) => dayKey(a.ts) === today);
  if (!rows.length) return 'Nothing has come through Warden today yet.';
  // A request that arrived while somebody was paused was not looked at, so it
  // is not in the number that says how much Warden looked at. Saying it out
  // loud on the same line, when there are any, is the difference between a
  // console that reports coverage and one that reports traffic.
  const judged = rows.filter((a) => !a.decision?.notJudged);
  const skipped = rows.length - judged.length;
  const stopped = judged.filter((a) => a.decision?.verdict === 'BLOCK').length;
  const people = new Set(judged.filter((a) => a.decision?.verdict !== 'ALLOW').map((a) => a.actor?.id)).size;
  const rule = people ? `${counted(people, 'person', 'people')} hit a rule.` : 'Nobody hit a rule.';
  const paused = skipped ? ` ${plural(skipped, 'request')} went through unchecked while Warden was paused.` : '';
  return `Warden looked at ${plural(judged.length, 'request')} today and stopped ${stopped}. ${rule}${paused}`;
}

function waitingAction() {
  const waiting = pendingEscalations().length;
  return waiting ? button(`${waiting} waiting on you →`, { kind: 'primary', attrs: 'data-go="inbox"' }) : '';
}

/**
 * What each filter's number means.
 *
 * Judged records only, for the same reason the filter excludes them: "Allowed
 * 40" has to mean forty requests the policy cleared, not thirty-nine plus one
 * that arrived while the guard was switched off.
 */
export function activityToolbarCounts() {
  const count = (v) => state.audit.filter((a) => !a.decision?.notJudged && a.decision?.verdict === v).length;
  return { ALLOW: count('ALLOW'), BLOCK: count('BLOCK'), ESCALATE: count('ESCALATE'), unjudged: state.audit.filter((a) => a.decision?.notJudged).length };
}

/** Filters live with the list they filter, not in the app chrome. */
function toolbar() {
  // Counted over judged records only, for the same reason the filter excludes
  // them: "Allowed 40" has to mean forty requests the policy cleared.
  const { unjudged, ...count } = activityToolbarCounts();
  const person = personById(state.actorFilter);
  const items = [{ id: '', name: 'Everyone' }, ...state.company.employees];
  return `${filters([['all', `All ${state.audit.length}`], ['BLOCK', `Blocked ${count.BLOCK}`], ['ESCALATE', `Held ${count.ESCALATE}`], ['ALLOW', `Allowed ${count.ALLOW}`], ...(unjudged ? [['paused', `Not judged ${unjudged}`]] : [])], state.filter, 'verdict')}
    <details class="menu --right person-filter">
      <summary class="menu-trigger person-trigger" aria-label="Filter by person"><span>Person · ${esc(person?.name ?? 'Everyone')}</span><i class="caret" aria-hidden="true">▾</i></summary>
      <div class="menu-list" role="menu">${items.map((p) => `<button type="button" role="menuitemradio" aria-checked="${(state.actorFilter || '') === p.id}" class="menu-item" data-actor="${esc(p.id)}"><span>${esc(p.name)}</span>${(state.actorFilter || '') === p.id ? '<b class="menu-check">✓</b>' : ''}</button>`).join('')}</div>
    </details>`;
}

/* Which rule the log is narrowed to, and how to leave. Not in the strip: it is
   a sentence about the state of the list, and the strip holds controls. */
function filterLine() {
  if (!state.query.rule) return '';
  return `<p class="filter-line">Only decisions where <b>${esc(ruleName(state.query.rule))}</b> fired · <button type="button" class="linkbtn" data-go="activity">Show every decision</button></p>`;
}

function decisionRows(entries) {
  let out = '';
  let day = null;
  const counts = entries.reduce((m, a) => { const k = dayKey(a.ts); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  for (const a of entries) {
    const k = dayKey(a.ts);
    if (k !== day) { day = k; out += groupBand(dayLabel(k), counts[k]); }
    const d = a.decision ?? {};
    const fired = d.firedRules?.[0];
    const files = d.documents?.length ? ` · ${plural(d.documents.length, 'file')}` : '';
    out += `<div class="trow --link" role="row" tabindex="0" data-go="activity" data-sel="${attr(a.auditId)}">
      <span class="who-cell"><i class="dot --${outcome(d).tone}"></i><span class="cell-strong">${esc(actorName(a.actor))}</span></span>
      ${d.maskedPrompt
        ? `<span class="cell-clip request-cell">“${promptMarkup(clip(d.maskedPrompt, 140))}”${files}</span>`
        : `<span class="cell-muted" title="The audit log keeps this prompt's SHA-256, not its text.">Not retained${files}</span>`}
      <span class="cell-muted">${fired ? esc(ruleName(fired.ruleId)) : '—'}</span>
      <span>${outcomeText(d)}</span>
      <span class="cell-muted num">${esc(hhmm(a.ts))}</span>
    </div>`;
  }
  return out;
}

function listPage() {
  const load = state.loads.audit;
  /*
   * The three loading headers lose their second line for the same reason each
   * time: the plate below says "Loading the log…", "Could not load the log" or
   * "No decisions yet" in its title, and the header's line was a second, vaguer
   * version of it 40px higher. `todayLine()` goes for the other reason — the
   * shape of the day is the filters and the Time column, which are the things
   * you would act on it with.
   */
  if (!load || (load.loading && !state.audit.length)) {
    return `<div class="sheet">${pageHead({ title: 'Activity' })}
      ${listState({ title: 'Loading the log…' })}</div>`;
  }
  if (load.error) {
    return `<div class="sheet">${pageHead({ title: 'Activity' })}
      ${listState({ tone: 'attention', title: 'Could not load the log', body: 'The record could not be read from this machine. Your rules still apply — requests keep being judged while this page recovers.', action: button('Retry loading', { kind: 'primary', id: 'retryAudit' }) })}</div>`;
  }
  if (!state.audit.length) {
    return `<div class="sheet">${pageHead({ title: 'Activity' })}
      ${listState({ title: 'No decisions yet', body: 'The moment a request runs through Warden, its decision lands here — allowed, held, or blocked.' })}</div>`;
  }
  const rows = visibleAudit();
  const who = personById(state.actorFilter);
  return `<div class="sheet">
    ${pageHead({ title: 'Activity', primary: waitingAction(), strip: toolbar() })}
    ${filterLine()}
    ${rows.length
      ? `<div class="table activity-table" role="table" aria-label="Decisions">
          <div class="thead" role="row"><span>Who</span><span>Request</span><span>Rule</span><span>Verdict</span><span>Time</span></div>
          ${decisionRows(rows)}
        </div>`
      : listState({
        title: 'No decisions match',
        body: who ? `Nothing from ${who.name.split(' ')[0]} in this view. Clear the filters to see the full log.` : 'Nothing in this view. Clear the filters to see the full log.',
        action: button('Clear filters', { id: 'clearFilters' })
      })}
  </div>`;
}

function bindList() {
  for (const b of document.querySelectorAll('[data-verdict]')) b.onclick = () => { state.filter = b.dataset.verdict; render(); };
  for (const b of document.querySelectorAll('[data-actor]')) b.onclick = () => { b.closest('details.menu')?.removeAttribute('open'); state.actorFilter = b.dataset.actor; render(); };
  const clear = $('clearFilters');
  if (clear) clear.onclick = () => { state.filter = 'all'; state.actorFilter = ''; if (state.query.rule) go('activity'); else render(); };
  const retry = $('retryAudit');
  if (retry) retry.onclick = async () => { retry.disabled = true; await Promise.all([refreshAudit(), refreshChain()]); render(); };
}

// ── one decision ─────────────────────────────────────────────────────────────

/**
 * Adjudicators report whether a rule matched; the rule's configured effect is
 * applied later by aggregate. Calling a warning-rule match "Held" describes an
 * action that never happened and can contradict the final Allowed verdict.
 */
export function passOutcome(p) {
  if (String(p.pass ?? '').startsWith('adjudicate:')) {
    const label = p.detail?.label;
    if (label === 'VIOLATES') return { word: 'Matched', tone: 'attention' };
    if (label === 'COMPLIES') return { word: 'Clear', tone: 'allow' };
    if (label === 'UNCLEAR') return { word: 'Unclear', tone: 'attention' };
  }
  return { word: VERDICT_WORD[p.verdict] ?? p.verdict ?? '', tone: VERDICT_TONE[p.verdict] ?? 'muted' };
}

const PASS_LABELS = {
  quota: 'Daily limit',
  budget: 'Session limits',
  sanitize: 'Secrets',
  isolate: 'Prompt safety',
  'isolate:output': 'Output safety',
  retrieve: 'Rules considered',
  'retrieve:output': 'Output rules considered',
  documents: 'Files',
  ocr: 'Scanned files',
  injection: 'Instruction safety',
  aggregate: 'Final decision'
};

/** Human labels and useful outcomes replace internal pipeline identifiers. */
export function passPresentation(p) {
  const raw = String(p.pass ?? '');
  const result = passOutcome(p);
  if (raw.startsWith('adjudicate:')) {
    const id = raw.slice('adjudicate:'.length);
    return { label: p.detail?.ruleText ? ruleName({ id, text: p.detail.ruleText }) : ruleName(id), ...result };
  }
  const selected = Array.isArray(p.detail?.selected) ? p.detail.selected.length : 0;
  if (raw.startsWith('retrieve')) return { label: PASS_LABELS[raw] ?? 'Rules considered', word: `${selected} checked`, tone: 'muted' };
  if (raw === 'sanitize') {
    const masked = Number(p.detail?.masked ?? 0);
    return { label: PASS_LABELS[raw], word: masked ? `${masked} masked` : 'Clear', tone: masked ? 'attention' : 'allow' };
  }
  if (raw === 'quota' && p.detail?.limit == null) return { label: PASS_LABELS[raw], word: 'No limit', tone: 'muted' };
  if (raw === 'budget' && p.detail?.reported === false && result.word === 'Allowed') return { label: PASS_LABELS[raw], word: 'No limits reached', tone: 'allow' };
  return {
    label: PASS_LABELS[raw] ?? raw.replaceAll(':', ' ').replace(/^./, (c) => c.toUpperCase()),
    ...result
  };
}

/** Explain rule coverage before showing the individual checks. */
export function ruleCoverageMarkup(passes, subject = 'this person') {
  const retrieve = (passes ?? []).find((p) => p.pass === 'retrieve');
  if (!retrieve) return '';
  const applicable = Number(retrieve.detail?.applicable ?? 0);
  const selected = Array.isArray(retrieve.detail?.selected) ? retrieve.detail.selected.length : 0;
  const elsewhere = Math.max(0, (state.policy.rules?.length ?? 0) - applicable);
  let checked = selected === applicable
    ? applicable === 0 ? 'None needed to be checked.' : applicable === 1 ? 'It was checked.' : `All ${applicable} were checked.`
    : `Warden checked the ${selected} most related ${selected === 1 ? 'rule' : 'rules'} for this request.`;
  if (elsewhere) checked += ` The other ${elsewhere} ${elsewhere === 1 ? 'rule applies' : 'rules apply'} to other people.`;
  return `<p class="pass-summary"><b>${applicable} ${applicable === 1 ? 'rule applies' : 'rules apply'} to ${esc(subject)}.</b> ${esc(checked)}</p>`;
}

/** One row of evidence, plus the cause when a pass failed closed. */
export function passRow(p, _slowest) {
  const why = p.failedClosed && p.detail?.error ? String(p.detail.error) : '';
  const result = passPresentation(p);
  return `<div class="pass">
      <span class="pass-name">${esc(result.label)}${p.failedClosed ? ' ⚠' : ''}</span>
      <span class="pass-verdict --${result.tone}">${esc(result.word)}</span>
      <span class="pass-ms num">${p.ms ?? 0} ms</span>
    </div>${why ? `<div class="pass-why">${esc(why)}</div>` : ''}`;
}

const seconds = (ms) => `${((ms ?? 0) / 1000).toFixed(1)} s`;
const where = () => (state.mock ? 'demo mode' : 'nothing left this machine');

/** "12:41 today", "16:05 yesterday", "09:15 · 3 Sep 2026". */
export function whenLine(ts) {
  const label = dayLabel(dayKey(ts));
  return /^(Today|Yesterday)$/.test(label) ? `${hhmm(ts)} ${label.toLowerCase()}` : `${hhmm(ts)} · ${label}`;
}

/**
 * The folds a decision page ends with, each with the state it reports on the
 * right: how it ran, whether the record still proves itself, and the record.
 * "Nothing left this machine" lives in the first and nowhere else — it is the
 * conclusion of how the decision was made.
 */
export function decisionFolds(entry, { chain = true, record = true } = {}) {
  const d = entry.decision ?? {};
  const passes = d.passes ?? [];
  const slowest = Math.max(1, ...passes.map((p) => p.ms ?? 0));
  const docs = d.documents ?? [];
  const how = disclosure(`d:passes:${entry.auditId}`, 'How it was decided',
    `${docs.length ? documentMetadataMarkup(docs) : ''}${ruleCoverageMarkup(passes, actorName(entry.actor))}<div class="passes">${passes.map((p) => passRow(p, slowest)).join('') || '<p class="disclosure-text">No passes were recorded.</p>'}</div>`,
    `${plural(passes.length, 'pass', 'passes')} · ${seconds(d.totalMs)} · ${where()}`);
  const proof = chain ? disclosure(`d:chain:${entry.auditId}`, 'Proof this record has not been altered', `
    <div class="chain">
      <div class="chain-link"><span>previous</span><b class="mono">${esc(shortHash(entry.prevHash))}</b></div>
      <div class="chain-line"></div>
      <div class="chain-link"><span class="dot --${state.chain?.ok ? 'allow' : 'block'}"></span><b class="mono">${esc(shortHash(entry.entryHash))}</b><span>this one</span></div>
    </div>
    <p class="disclosure-text">${state.chain?.ok
      ? `All ${state.chain.entries} records still match their hashes.`
      : 'This log no longer verifies: a record was altered or removed after it was written.'}</p>`,
  state.chain ? (state.chain.ok ? `All ${state.chain.entries} records match their hashes` : 'The log does not verify') : '') : '';
  const tech = record ? disclosure(`d:record:${entry.auditId}`, 'Technical record', `<dl class="record">
      <dt>Audit id</dt><dd class="mono">${esc(entry.auditId)}</dd>
      <dt>Exact time</dt><dd class="mono">${esc(entry.ts)}</dd>
      <dt>Policy</dt><dd class="mono">${esc(shortHash(d.policyVersion))}</dd>
      ${d.quota?.limit ? `<dt>Daily use</dt><dd class="num">${d.quota.used} of ${d.quota.limit}</dd>` : ''}
      ${d.maskedSpans?.length ? `<dt>Masked</dt><dd>${plural(d.maskedSpans.length, 'secret')} removed before checking</dd>` : ''}
      ${docs.map((doc) => `<dt>${esc(doc.name)}</dt><dd class="mono">SHA-256 ${esc(doc.sha256)}</dd>`).join('')}
      ${(d.firedRules ?? []).map((r) => `<dt>${esc(r.ruleId)}</dt><dd>${esc(r.reason)} · confidence ${r.confidence ?? '—'}</dd>`).join('')}
    </dl>`, `${esc(shortHash(entry.auditId))} · policy ${esc(shortHash(d.policyVersion))}`) : '';
  return `<div class="disclosures">${how}${proof}${tech}</div>`;
}

/** The request as a turn by the person who sent it. */
export function requestTurn(entry, { who, extra = '', cls = '' } = {}) {
  const d = entry.decision ?? {};
  const person = personById(entry.actor?.id);
  const role = person?.role ?? entry.actor?.role;
  const heading = who ?? `${esc(actorName(entry.actor))}${role ? ` · ${esc(role)}` : ''}`;
  const files = (d.documents ?? []).map((doc) => fileChip(doc.name, fileSize(doc.bytes ?? 0))).join('');
  const masked = d.maskedSpans?.length ? `<div class="turn-meta">${plural(d.maskedSpans.length, 'secret')} masked before checking</div>` : '';
  const text = d.maskedPrompt ? `<div class="turn-text">${promptMarkup(d.maskedPrompt)}</div>` : '<div class="turn-text muted">Not retained</div>';
  return turn('person', { who: heading, body: `${text}${files ? `<div class="labels">${files}</div>` : ''}${masked}${extra}`, cls: `request-turn ${cls}` });
}

/**
 * Warden's side of the exchange: the rule that fired and why. It exists only
 * when Warden intervened — an allowed request has no rule card, because no
 * rule did anything to it.
 */
export function ruleCard(d, { note = '' } = {}) {
  const fired = d.firedRules ?? [];
  const rule = fired[0];
  if (!rule) {
    // No rule fired, so the only account of the decision is the explanation the
    // guard wrote. One of its lines names the structural signal — invisible
    // characters, faked conversation turns, phrasing aimed at the instruction
    // layer. Without it the page says a person was stopped and offers nothing
    // to point at.
    const flagged = String(d.explanation ?? '').split('\n').find((l) => l.startsWith('Also flagged:'));
    const signal = flagged ? flagged.replace(/^Also flagged:\s*/, '').replace(/\.\s*$/, '') : '';
    return `<article class="turn --warden rule-card"><div class="turn-head"><b>No rule matched</b>${badgeEffect(d.verdict === 'BLOCK' ? 'block' : 'escalate')}</div>
      <p class="rule-card-reason">${signal ? `Warden noticed ${esc(signal)}.` : esc(d.explanation || 'Warden noticed something structural in the text.')}</p>${note}</article>`;
  }
  const others = fired.slice(1);
  return `<article class="turn --warden rule-card">
    <div class="turn-head"><b>${esc(ruleName(rule.ruleId))}</b>${badgeEffect(rule.severity)}</div>
    <p class="rule-card-reason">${esc(rule.reason || rule.ruleText)}</p>
    ${rule.guidance ? `<p class="turn-meta">They were told: “${esc(rule.guidance)}”</p>` : ''}
    ${others.length ? `<p class="turn-meta">${plural(others.length, 'other rule')} also matched</p>` : ''}
    ${note}
  </article>`;
}

export const GLYPH = { BLOCK: '⊘', ESCALATE: '↗', ALLOW: '✓' };

function detailPage(entry) {
  if (!entry) return missingDecision('Activity', 'activity');
  const d = entry.decision ?? {};
  const v = d.verdict;
  // A paused request never reached a pass. Every sentence below that describes
  // judging has to go, or this page tells somebody the policy was applied.
  const unjudged = d.notJudged === 'paused';
  const title = unjudged ? 'Not judged' : v === 'ESCALATE' ? 'Held for review' : VERDICT_WORD[v] ?? v;
  const held = v === 'ESCALATE' ? state.escalations.find((e) => e.auditId === entry.auditId) : null;
  const firstName = actorName(entry.actor).split(' ')[0];
  const person = personById(entry.actor?.id);
  const action = v === 'ESCALATE' && held && !held.review
    ? button('Answer in Inbox', { attrs: `data-go="inbox" data-sel="${attr(entry.auditId)}"` })
    : d.firedRules?.[0] && v !== 'ALLOW' && !unjudged ? button('Open the rule', { attrs: `data-go="policy" data-sel="${attr(d.firedRules[0].ruleId)}"` }) : '';
  let after = '';
  if (unjudged) {
    const until = d.pausedUntil
      ? `until ${esc(whenLine(d.pausedUntil))}`
      : 'until somebody turns it back on';
    after = `<p class="exchange-note">Warden was paused for ${esc(firstName)} ${until}, so this request went out without being checked against any rule. </p>`;
  } else if (v === 'ALLOW') {
    after = '';
  } else if (held) {
    after = held.review
      ? `<p class="exchange-note">${held.review.outcome === 'approved' ? 'Approval' : 'Refusal'} recorded ${esc(whenLine(held.review.at))}${held.review.note ? ` — “${esc(held.review.note)}”` : ''}.</p>`
      : `<p class="exchange-note">Awaiting review · ${esc(hhmm(held.at))}</p>`;
  }
  return `<div class="sheet">
    ${pageHead({
      title,
      crumbs: [{ label: 'Activity', go: 'activity' }],
      tone: unjudged ? 'muted' : VERDICT_TONE[v],
      glyph: unjudged ? '⏸' : GLYPH[v],
      // When it happened and how long it took. One record's identity, not a
      // sentence about decisions in general — this is the case §2.2 of the
      // spec carved the `meta` slot out for.
      meta: unjudged ? `${whenLine(entry.ts)} · no rule was run` : `${whenLine(entry.ts)} · judged in ${seconds(d.totalMs)}`,
      quiet: action
    })}
    <div class="exchange reading">
      ${requestTurn(entry)}
      ${v === 'ALLOW' || unjudged ? '' : ruleCard(d)}
    </div>
    ${after}
    ${decisionFolds(entry)}
  </div>`;
}

export function missingDecision(label, view) {
  const loading = state.loads.audit?.loading || fetchingOlder;
  return `<div class="sheet">
    ${pageHead({ title: loading ? 'Loading this decision…' : 'This decision is not in the log', crumbs: [{ label, go: view }] })}
    ${listState({ title: loading ? 'Looking further back in the log…' : 'Nothing to show', body: loading ? 'It is older than the decisions this page loaded first.' : 'The link may be from another installation, or the record is beyond what the log keeps.' })}</div>`;
}

/**
 * A decision older than the loaded page is looked for, once, further back.
 * There is no endpoint for one record, and `/api/audit` takes a limit; asking
 * for more is the whole of the lookup.
 */
let fetchingOlder = false;
const lookedFor = new Set();
async function findOlder(id) {
  if (fetchingOlder || lookedFor.has(id) || state.loads.audit?.loading) return;
  lookedFor.add(id);
  fetchingOlder = true;
  render();
  await refreshAudit(5000);
  fetchingOlder = false;
  if (state.view === 'activity' || state.view === 'inbox') render();
}
export const findEntry = (id) => state.audit.find((a) => a.auditId === id) ?? null;
export function ensureEntry(id) {
  if (id && !findEntry(id) && state.loads.audit && !state.loads.audit.loading) void findOlder(id);
}

VIEWS.activity = {
  detail: () => Boolean(state.sel),
  background: listPage,
  detailLabel: 'Activity',
  bind: () => { if (state.sel) ensureEntry(state.sel); else bindList(); },
  body: () => (state.sel ? detailPage(findEntry(state.sel)) : listPage())
};
