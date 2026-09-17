/**
 * Inbox: what is waiting on a person — held requests, and blocks somebody said were wrong — each as its own page.
 */
import { GLYPH, decisionFolds, ensureEntry, findEntry, missingDecision, pendingEscalations, promptMarkup, ruleCard, whenLine } from './activity.js';
import { readable } from './answers.js';
import { $, attr, esc, post, state } from './core.js';
import { refreshAppeals, refreshEscalations } from './data.js';
import { actorName, fileSize, hhmm, personById, plural, ruleName } from './format.js';
import { render } from './render.js';
import { go } from './router.js';
import { button, confirmResult, feedback, fileChip, groupBand, listState, pageHead, turn } from './ui.js';
import { VIEWS } from './views.js';

/**
 * Everything waiting on a person, in one list and three groups.
 *
 * A held request is Warden declining to decide. An appeal is Warden having
 * decided wrong, according to the person it landed on. Both need a human and
 * neither belongs in the log, where a correct block and an incorrect one look
 * identical — which is the whole reason appeals exist as a separate record.
 *
 * Groups, not tabs: a tab that says "2" hides the other count behind a click,
 * and the question this page answers is "what needs me", all of it.
 *
 * An appeal's address is `appeal-<auditId>`. Appeals have no id of their own
 * in the API; the decision they dispute does, and one person appeals one
 * decision, so the audit id is the stable key.
 */
const APPEAL = 'appeal-';

VIEWS.inbox = {
  onEnter: () => { void Promise.all([refreshAppeals(), refreshEscalations()]).then(render); },
  bind: bindInbox,
  body: () => {
    if (!state.sel) return listPage();
    if (state.sel.startsWith(APPEAL)) return appealPage(state.appeals.find((a) => a.auditId === state.sel.slice(APPEAL.length)));
    return heldPage(state.escalations.find((e) => e.auditId === state.sel));
  }
};

const whoOf = (id, fallback) => personById(id)?.name ?? fallback ?? id;
const roleOf = (e) => personById(e.employeeId)?.role ?? e.role;

// ── the list ─────────────────────────────────────────────────────────────────

function listPage() {
  const loads = [state.loads.escalations, state.loads.appeals];
  // What the Inbox is for is said by the group bands over the list — "Waiting
  // on you", "Reported as wrong", "Answer recorded" — and by the empty state
  // when there is nothing in it. A standing sentence at the top said it a
  // fourth time, on a page somebody opens every day.
  if (loads.some((l) => !l || (l.loading && !state.escalations.length && !state.appeals.length))) {
    return `<div class="sheet">${pageHead({ title: 'Inbox' })}
      ${listState({ title: 'Loading the inbox…' })}</div>`;
  }
  if (loads.some((l) => l.error)) {
    return `<div class="sheet">${pageHead({ title: 'Inbox' })}
      ${listState({ tone: 'attention', title: 'Could not load the inbox', body: 'The queue could not be read from this machine. Nothing is lost — held requests stay held until someone answers.', action: button('Retry loading', { kind: 'primary', id: 'retryInbox' }) })}</div>`;
  }
  const waiting = pendingEscalations();
  const answered = state.escalations.filter((e) => e.review);
  if (!waiting.length && !state.appeals.length && !answered.length) {
    return `<div class="sheet">${pageHead({ title: 'Inbox' })}
      <div class="empty-center"><b>Nothing waiting</b><span>Requests that need your sign-off land here, next to blocks somebody says were wrong.</span></div></div>`;
  }
  return `<div class="sheet">
    ${pageHead({ title: 'Inbox' })}
    <div class="table inbox-table" role="table" aria-label="Inbox">
      ${waiting.length ? groupBand('Waiting on you', waiting.length) + waiting.map(heldRow).join('') : ''}
      ${state.appeals.length ? groupBand('Reported as wrong', state.appeals.length) + state.appeals.map(appealRow).join('') : ''}
      ${answered.length ? groupBand('Answer recorded', answered.length) + answered.map(heldRow).join('') : ''}
    </div>
  </div>`;
}

/** "12:12 today", "16:05 yesterday", or the date. */
const when = (ts) => {
  const line = whenLine(ts);
  return line.includes(' · ') ? line.split(' · ').reverse().join(' ') : line;
};

/**
 * One held request.
 *
 * An escalation is not a refusal and must not read like one: the person was not
 * told no, they were told to wait, and this is the page where somebody ends
 * that wait.
 */
function heldRow(e) {
  const done = Boolean(e.review);
  return `<div class="trow --link${done ? ' --done' : ''}" role="row" tabindex="0" data-go="inbox" data-sel="${attr(e.auditId)}">
    <span class="who-cell"><i class="dot --${done ? 'muted' : 'attention'}"></i><span class="${done ? 'cell-muted' : 'cell-strong'}">${e.ruleId ? esc(ruleName(e.ruleId)) : 'Held without a named rule'}</span></span>
    <span class="cell-muted">${esc(whoOf(e.employeeId, e.employeeName))} · ${esc(roleOf(e))}</span>
    <span>${done
      ? `<span class="verdict-text --${e.review.outcome === 'approved' ? 'allow' : 'block'}">${e.review.outcome === 'approved' ? 'Approval' : 'Refusal'} recorded</span>`
      : '<span class="verdict-text --attention">↗ Waiting</span>'}</span>
    <span class="cell-muted num time-cell">${esc(done ? when(e.review.at) : when(e.at))}</span>
  </div>`;
}

function appealRow(a) {
  return `<div class="trow --link" role="row" tabindex="0" data-go="inbox" data-sel="${APPEAL}${attr(a.auditId)}">
    <span class="who-cell"><i class="dot --block"></i><span class="cell-strong">${a.note ? `“${esc(a.note)}”` : `${esc(whoOf(a.employeeId, a.employeeName))} said this block was wrong`}</span></span>
    <span class="cell-muted">${esc(whoOf(a.employeeId, a.employeeName))} · ${a.ruleId ? esc(ruleName(a.ruleId)) : 'no rule fired'}</span>
    <span><span class="verdict-text --block">⊘ Blocked</span></span>
    <span class="cell-muted num time-cell">${esc(when(a.at))}</span>
  </div>`;
}

// ── a held request ───────────────────────────────────────────────────────────

/**
 * What an answer is doing, per held request: whether it is being saved, what
 * failed, and what the gateway said when it was already answered. The note is
 * kept here so a failed save or a re-render cannot lose what was typed.
 */
const answers = new Map();
const answerOf = (id) => {
  if (!answers.has(id)) answers.set(id, { note: '', saving: null, error: null, conflict: false, justNow: false });
  return answers.get(id);
};

const waitedFor = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60000));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

function heldPage(e) {
  if (!e) return state.loads.escalations?.loading ? missingDecision('Inbox', 'inbox') : `<div class="sheet">
    ${pageHead({ title: 'This request is not waiting any more', crumbs: [{ label: 'Inbox', go: 'inbox' }] })}${listState({ title: 'Nothing to answer', body: 'It is not in the queue. It may have been answered from another console.' })}</div>`;
  const entry = findEntry(e.auditId);
  const a = answerOf(e.auditId);
  const first = whoOf(e.employeeId, e.employeeName).split(' ')[0];
  const d = entry?.decision ?? { verdict: 'ESCALATE', firedRules: e.ruleId ? [{ ruleId: e.ruleId, ruleText: e.ruleText, severity: 'escalate' }] : [] };
  const judged = entry ? ` · judged in ${((entry.decision.totalMs ?? 0) / 1000).toFixed(1)} s` : '';
  const added = e.employeeNote ? `<div class="turn-note">They added — “${esc(e.employeeNote)}”</div>` : '';
  const request = entry
    ? requestTurnFor(entry, added)
    : turn('person', { who: `${esc(whoOf(e.employeeId, e.employeeName))} · ${esc(roleOf(e))}`, body: `<div class="turn-text muted">The request is older than the log this page loaded.</div>${added}` });
  const done = e.review;
  const outcomeWord = (o) => (o === 'approved' ? 'Approval' : 'Refusal');

  if (done) {
    return `<div class="sheet">
      ${pageHead({
        title: `${outcomeWord(done.outcome)} recorded`,
        crumbs: [{ label: 'Inbox', go: 'inbox' }],
        tone: done.outcome === 'approved' ? 'allow' : 'block',
        meta: `Recorded ${a.justNow ? 'just now' : whenLine(done.at)} · original decision: Held at ${hhmm(e.at)}`
      })}
      <div class="exchange reading">
        ${request}
        ${ruleCard(d, { note: '<p class="turn-meta">This request did not reach the assistant. Your answer did not resume it.</p>' })}
      </div>
      ${a.conflict ? `<div class="reading answer-block">${feedback({ title: 'An answer was already recorded', body: 'Your new answer was not saved. The existing recorded answer is shown below.' })}</div>` : ''}
      ${entry && !a.conflict ? decisionFolds(entry, { chain: false, record: false }) : ''}
      <div class="reading answer-block">
        <span class="field-label">Recorded note</span>
        <p class="recorded-note">${done.note ? esc(done.note) : 'No note was added.'}</p>
        ${a.justNow && !a.conflict
          ? confirmResult({ title: 'Your answer was recorded', body: `The original request was not resumed.<br>${esc(first)} must send a new request; Warden will check it again.`, action: button('Back to Inbox', { kind: 'primary', attrs: 'data-go="inbox"' }) })
          : `<div>${button('Back to Inbox', { kind: 'primary', attrs: 'data-go="inbox"' })}</div>`}
      </div>
      ${entry && a.conflict ? decisionFolds(entry, { chain: false, record: false }) : ''}
    </div>`;
  }

  const saving = a.saving;
  const failed = a.error;
  return `<div class="sheet">
    ${pageHead({
      title: 'Held',
      crumbs: [{ label: 'Inbox', go: 'inbox' }],
      tone: 'attention',
      glyph: GLYPH.ESCALATE,
      meta: `${whenLine(e.at)} · waiting ${waitedFor(e.at)}${judged}`
    })}
    <div class="exchange reading">
      ${request}
      ${ruleCard(d)}
    </div>
    <hr class="hairline">
    <section class="reading answer-block" aria-labelledby="answerTitle">
      <h2 class="section-title --big" id="answerTitle">Record your answer</h2>
      ${failed ? feedback({ tone: 'error', icon: true, title: `${outcomeWord(failed.outcome)} couldn’t be saved`, body: `Your ${outcomeWord(failed.outcome).toLowerCase()} was not recorded. This request is still waiting for review.<br>Your note is preserved below — try saving again.${failed.why ? `<br>${esc(failed.why)}` : ''}` }) : ''}
      <p class="answer-lead">Recording an answer does not resume this request. ${esc(first)} must send a new request; Warden will check it again.</p>
      <div class="field">
        <label for="reviewNote">Note to ${esc(first)} <span class="optional">(optional)</span></label>
        <textarea id="reviewNote" rows="3" placeholder="Add context for your answer…"${saving ? ' readonly' : ''}>${esc(a.note)}</textarea>
        ${saving ? '<span class="field-help">Saving your answer…</span>' : ''}
      </div>
      <div class="btn-row">
        ${button(saving === 'approved' ? 'Saving approval…' : failed?.outcome === 'approved' ? 'Retry saving approval' : 'Record approval', { kind: 'primary', attrs: `data-review="approved" data-id="${attr(e.auditId)}"`, busy: saving === 'approved', disabled: Boolean(saving) })}
        ${button(saving === 'refused' ? 'Saving refusal…' : failed?.outcome === 'refused' ? 'Retry saving refusal' : 'Record refusal', { kind: saving ? 'quiet' : 'danger', attrs: `data-review="refused" data-id="${attr(e.auditId)}"`, busy: saving === 'refused', disabled: Boolean(saving) })}
      </div>
    </section>
    ${entry ? decisionFolds(entry, { chain: false, record: false }) : ''}
  </div>`;
}

function requestTurnFor(entry, extra) {
  const d = entry.decision ?? {};
  const role = personById(entry.actor?.id)?.role ?? entry.actor?.role;
  const files = (d.documents ?? []).map((doc) => fileChip(doc.name, fileSize(doc.bytes ?? 0))).join('');
  return turn('person', {
    who: `${esc(actorName(entry.actor))}${role ? ` · ${esc(role)}` : ''}`,
    body: `${d.maskedPrompt ? `<div class="turn-text">${promptMarkup(d.maskedPrompt)}</div>` : '<div class="turn-text muted">Not stored — the log keeps the hash, not the text</div>'}${files ? `<div class="labels">${files}</div>` : ''}${extra}`,
    cls: 'request-turn'
  });
}

// ── an appeal ────────────────────────────────────────────────────────────────

/**
 * What a person said was wrong, their words first.
 *
 * The action is "Open the rule": the rule is the thing an administrator can
 * change, and the API has no way to mark an appeal resolved, so the page does
 * not offer one.
 */
function appealPage(a) {
  if (!a) return missingDecision('Inbox', 'inbox');
  const entry = findEntry(a.auditId);
  const name = whoOf(a.employeeId, a.employeeName);
  const first = name.split(' ')[0];
  const role = personById(a.employeeId)?.role;
  const blockedAt = entry ? hhmm(entry.ts) : null;
  const ruleHits = a.ruleId ? state.audit.filter((x) => (x.decision?.firedRules ?? []).some((r) => r.ruleId === a.ruleId) && x.decision?.verdict === 'BLOCK').length : 0;
  const disputes = a.ruleId ? state.appeals.filter((x) => x.ruleId === a.ruleId).length : 0;
  const d = entry?.decision;
  /*
   * The BLOCK badge that used to sit above the title is gone with the line it
   * was on. The title says the word — "says this block was wrong" — and the
   * decision itself is one card below, under its own kicker, where the badge
   * would be telling somebody about the thing they are looking at. Who and
   * when stays, as the record's identity.
   */
  return `<div class="sheet">
    ${pageHead({
      title: `${first} says this block was wrong.`,
      crumbs: [{ label: 'Inbox', go: 'inbox' }],
      meta: `${name}${role ? ` · ${role}` : ''}${blockedAt ? ` · blocked at ${blockedAt}` : ''} · reported at ${hhmm(a.at)}`,
      quiet: a.ruleId ? button('Open the rule', { attrs: `data-go="policy" data-sel="${attr(a.ruleId)}"` }) : ''
    })}
    <div class="exchange reading">
      ${turn('person', { who: `${esc(name)} · reported at ${esc(hhmm(a.at))}`, body: `<div class="turn-text">${a.note ? `“${esc(a.note)}”` : 'No note, just that it was wrong.'}</div>` })}
      <span class="kicker exchange-kicker">The decision they dispute</span>
      ${entry ? `<article class="turn --warden dispute-card">
          <div class="turn-who">What they sent · ${esc(hhmm(entry.ts))}</div>
          ${d.maskedPrompt ? `<div class="turn-text">${promptMarkup(d.maskedPrompt)}</div>` : '<div class="turn-text muted">Not stored — the log keeps the hash, not the text</div>'}
          ${(d.documents ?? []).length ? `<div class="labels">${d.documents.map((doc) => fileChip(doc.name, fileSize(doc.bytes ?? 0))).join('')}</div>` : ''}
        </article>
        ${ruleCard(d, { note: a.ruleId ? `<p class="turn-meta">${plural(ruleHits, 'block')} by this rule in the loaded log · ${disputes} disputed</p>` : '' })}`
      : '<p class="exchange-note">The decision itself is older than the log this console loaded, so only what they reported is shown.</p>'}
    </div>
    ${entry ? decisionFolds(entry, { chain: false, record: false }) : ''}
  </div>`;
}

// ── bindings ─────────────────────────────────────────────────────────────────

function bindInbox() {
  if (state.sel?.startsWith(APPEAL)) ensureEntry(state.sel.slice(APPEAL.length));
  else if (state.sel) ensureEntry(state.sel);

  const retry = $('retryInbox');
  if (retry) retry.onclick = async () => { retry.disabled = true; await Promise.all([refreshAppeals(), refreshEscalations()]); render(); };

  const note = $('reviewNote');
  if (note && state.sel) note.oninput = () => { answerOf(state.sel).note = note.value; };

  document.querySelectorAll('[data-review]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const a = answerOf(id);
      const outcome = btn.dataset.review;
      a.note = $('reviewNote')?.value ?? a.note;
      a.saving = outcome;
      a.error = null;
      render();
      const note = a.note.trim();
      const { ok, status, j } = await post(`/api/escalations/${encodeURIComponent(id)}`, { outcome, ...(note ? { note } : {}) })
        .catch(() => ({ ok: false, status: 0, j: { error: 'Warden could not be reached.' } }));
      a.saving = null;
      if (status === 409) {
        // Somebody answered first. Theirs stands; say so and show it.
        a.conflict = true;
        a.justNow = true;
        await refreshEscalations();
        render();
        return;
      }
      if (!ok) {
        a.error = { outcome, why: readable(j?.error ?? '') };
        render();
        return;
      }
      a.justNow = true;
      await refreshEscalations();
      if (state.view === 'inbox' && state.sel === id) render(); else go('inbox', id);
    };
  });
}
