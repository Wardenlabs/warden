/**
 * Inbox: held requests waiting for a person, and blocks somebody said were wrong.
 */
import { decisionDetail, pendingEscalations } from './activity.js';
import { $, api, attr, esc, state } from './core.js';
import { refreshAppeals, refreshEscalations } from './data.js';
import { clip, ruleName } from './format.js';
import { render } from './render.js';
import { go } from './router.js';
import { VIEWS } from './views.js';

/**
 * Everything waiting on a person, in two kinds.
 *
 * A held request is Warden declining to decide. An appeal is Warden having
 * decided wrong, according to the person it landed on. Both need a human and
 * neither belongs in the log, where a correct block and an incorrect one look
 * identical — which is the whole reason appeals exist as a separate record.
 */
VIEWS.inbox = {
  onEnter: () => { void Promise.all([refreshAppeals(), refreshEscalations()]).then(render); },
  bind: bindInbox,
  body: () => {
    const waiting = pendingEscalations();
    const answered = state.escalations.filter((e) => e.review);
    if (!state.appeals.length && !state.escalations.length) {
      return `<div class="sheet"><div class="empty">
        <b>Nothing waiting</b>
        <span>Held requests wait here for your call, next to blocks somebody says were wrong.</span>
      </div></div>`;
    }
    return `<div class="sheet">
      ${waiting.length ? `
        <div class="day">Waiting on you<span class="n">${waiting.length}</span></div>
        ${waiting.map(escalationRow).join('')}` : ''}
      ${state.appeals.length ? `
        <div class="day">Reported as wrong<span class="n">${state.appeals.length}</span></div>
        ${state.appeals.map(appealRow).join('')}` : ''}
      ${answered.length ? `
        <div class="day">Already answered<span class="n">${answered.length}</span></div>
        ${answered.map(escalationRow).join('')}` : ''}
    </div>`;
  }
};

/**
 * One held request.
 *
 * An escalation is not a refusal and must not read like one: the person was not
 * told no, they were told to wait, and this is the screen where somebody ends
 * that wait.
 */
function escalationRow(e) {
  const open = state.sel === e.auditId;
  const done = Boolean(e.review);
  return `<button type="button" class="row roomy${open ? ' on' : ''}" data-toggle="inbox" data-sel="${attr(e.auditId)}" aria-expanded="${open}">
      <span class="dot ${done ? '' : 'ESCALATE'}"></span>
      <span class="col">
        <span class="t">${e.ruleText ? esc(ruleName(e.ruleId ?? '')) : 'Held without a named rule'}</span>
        <span class="m">
          <span>${esc(e.employeeName ?? e.employeeId)} · ${esc(e.role)}</span>
          ${done
            ? `<span class="badge ${e.review.outcome === 'approved' ? 'ALLOW' : 'BLOCK'}">${esc(e.review.outcome)}</span>`
            : '<span class="badge ESCALATE">waiting</span>'}
          <span class="mono">${esc(String(e.at).slice(0, 16).replace('T', ' '))}</span>
        </span>
      </span>
    </button>
    ${open ? escalationDetail(e) : ''}`;
}

function escalationDetail(e) {
  const entry = state.audit.find((x) => x.auditId === e.auditId);
  const who = esc(e.employeeName ?? e.employeeId);

  const head = `<p class="summary">${who} sent something the <b>${esc(ruleName(e.ruleId ?? ''))}</b> rule says needs a person to sign off. They were not refused, only told to wait, and they are still waiting.</p>
    ${e.employeeNote ? `<div class="group">
      <div class="label">They added</div>
      <div class="banner">“${esc(e.employeeNote)}”</div>
    </div>` : ''}
    ${e.review ? `<div class="group">
      <div class="label">Answered</div>
      <div class="banner${e.review.outcome === 'approved' ? '' : ' warn'}">
        <b>${esc(e.review.outcome)}</b>${e.review.note ? ` — ${esc(e.review.note)}` : ''}
      </div>
    </div>` : `<div class="group">
      <div class="label">Answer them</div>
      <textarea id="reviewNote" rows="2" placeholder="What should they know? (optional)"></textarea>
      <div class="chips">
        <button type="button" class="btn primary" data-review="approved" data-id="${attr(e.auditId)}">Approve</button>
        <button type="button" class="btn danger" data-review="refused" data-id="${attr(e.auditId)}">Refuse</button>
      </div>
      <div class="note">This answers them. Their next ask is judged on its own.</div>
      <div class="note bad" id="reviewNote_err"></div>
    </div>`}`;

  return entry ? decisionDetail(entry, head) : `<div class="detail">${head}</div>`;
}

function bindInbox() {
  const sheet = $('pane').querySelector('.sheet');
  if (!sheet) return;
  sheet.querySelectorAll('[data-review]').forEach((btn) => {
    btn.onclick = async () => {
      const note = $('reviewNote')?.value.trim();
      btn.disabled = true;
      const { ok, j } = await api(`/api/escalations/${encodeURIComponent(btn.dataset.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: btn.dataset.review, ...(note ? { note } : {}) })
      });
      if (!ok) {
        btn.disabled = false;
        const err = $('reviewNote_err');
        if (err) err.textContent = j.error ?? 'could not record that';
        return;
      }
      await refreshEscalations();
      render();
    };
  });
}

function appealRow(a) {
  const open = state.sel === a.auditId;
  return `<button type="button" class="row roomy${open ? ' on' : ''}" data-toggle="inbox" data-sel="${attr(a.auditId)}" aria-expanded="${open}">
      <span class="dot BLOCK"></span>
      <span class="col">
        <span class="t">${a.note ? esc(a.note) : `${esc(a.employeeName)} said this block was wrong`}</span>
        <span class="m">
          <span>${esc(a.employeeName)}</span>
          ${a.ruleId ? `<span>${esc(ruleName(a.ruleId))}</span>` : '<span>no rule fired</span>'}
          <span class="mono">${esc(String(a.at).slice(0, 16).replace('T', ' '))}</span>
        </span>
      </span>
    </button>
    ${open ? appealDetail(a) : ''}`;
}

function appealDetail(a) {
  const entry = state.audit.find((x) => x.auditId === a.auditId);
  // The decision itself carries everything, so show it — but lead with what the
  // person said, because that is the part the log cannot tell you.
  const head = `<div class="group">
      <div class="label">${esc(a.employeeName)} reported this</div>
      ${a.note
        ? `<div class="banner">“${esc(a.note)}”</div>`
        : '<div class="note">No note, just that it was wrong.</div>'}
    </div>
    ${a.ruleId ? `<div class="group">
      <div class="label">The rule that stopped them</div>
      <button type="button" class="ruleref" data-go="policy" data-sel="${attr(a.ruleId)}">
        <span class="dot block"></span>
        <span class="col">
          <span class="t">${esc(ruleName(a.ruleId))}</span>
          <span class="m">${esc(clip(a.ruleText, 130))}</span>
        </span>
      </button>
    </div>` : ''}`;

  if (!entry) {
    return `<div class="detail">
      ${head}
      <div class="note">The decision itself is older than the log this console loaded, so only what they reported is shown.</div>
    </div>`;
  }
  // Splice the report into the decision's own detail, above everything else.
  return decisionDetail(entry, head);
}
