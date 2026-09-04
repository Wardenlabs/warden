/**
 * Limits by role: the cards, the editor, and the save that goes through the policy like any ratified change.
 */
import { $, api, esc, state } from './core.js';
import { refreshPolicy } from './data.js';
import { render } from './render.js';

/** Compact number for a ceiling: 500000 -> 500k. Ceilings are round by nature. */
function tokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * One role's ceilings.
 *
 * A role with no token ceiling says so rather than showing a bar at zero — an
 * empty bar reads as "plenty left", which is the opposite of "nobody is
 * counting".
 */
function quotaCard(q) {
  const rows = [`<div class="quota-row"><span>requests</span><b>${q.maxRequestsPerDay}/day</b></div>`];
  if (q.maxSessionOutputTokens) {
    rows.push(`<div class="quota-row"><span>output</span><b>${tokens(q.maxSessionOutputTokens)}/session</b></div>`);
  }
  if (q.maxContextTokens) {
    rows.push(`<div class="quota-row"><span>context</span><b>${tokens(q.maxContextTokens)}</b></div>`);
  }
  if (!q.maxSessionOutputTokens && !q.maxContextTokens) {
    rows.push('<div class="quota-row unmetered"><span>tokens</span><b>no limit</b></div>');
  }
  return `<button type="button" class="quota" data-quota="${esc(q.role)}">
    <span class="quota-role">${esc(q.role)}</span>${rows.join('')}</button>`;
}

/**
 * Every role, with or without a limit, and one of them possibly open for edit.
 *
 * Both halves of that matter. The grid used to render `policy.quotas`, so a
 * role that had never been given a limit was simply absent — which reads as
 * "this role does not exist" rather than "nobody is counting what it spends",
 * and left no way to give it one. And every card was static text: a limit could
 * be set at the moment a role was created and never again, so an administrator
 * who typed 20 and meant 200 had to delete the role, which deletes the people
 * standing in it.
 */
export function limitsGrid() {
  const all = state.company.roles ?? [];
  const byRole = new Map(state.policy.quotas.map((q) => [q.role, q]));
  const roles = all.length ? all : state.policy.quotas.map((q) => q.role);
  if (!roles.length) return '<div class="note">No roles yet.</div>';

  return `<div class="quota-grid">${roles.map((role) => {
    if (state.quotaEdit === role) return quotaEditor(byRole.get(role) ?? { role });
    const q = byRole.get(role);
    return q
      ? quotaCard(q)
      : `<button type="button" class="quota none" data-quota="${esc(role)}">
          <span class="quota-role">${esc(role)}</span>
          <div class="quota-row unmetered"><span>requests</span><b>no limit</b></div>
        </button>`;
  }).join('')}</div>`;
}

/**
 * One role's limits, open.
 *
 * Blank means no limit, in all three boxes, because that is the same sentence
 * the policy stores — a role with no quota row is the unmetered case, and
 * giving "no limit" a second spelling (0, or an unchecked box) would put two
 * representations of one state into a file that is hashed.
 */
function quotaEditor(q) {
  // `step="1"` on the token boxes, not the round 1000 that reads better. With
  // `min="1"`, a step of 1000 makes the valid values 1, 1001, 2001… so 250000
  // is invalid and the browser refuses the submit — with a tooltip, no error,
  // and no request. Caught in a browser; it cannot be caught by reading.
  return `<form class="quota editing" id="quotaForm" data-role="${esc(q.role)}">
    <span class="quota-role">${esc(q.role)}</span>
    <label class="quota-row"><span>requests</span>
      <input type="number" min="1" step="1" id="qDay" value="${q.maxRequestsPerDay ?? ''}" placeholder="none"></label>
    <label class="quota-row"><span>output</span>
      <input type="number" min="1" step="1" id="qOut" value="${q.maxSessionOutputTokens ?? ''}" placeholder="none"></label>
    <label class="quota-row"><span>context</span>
      <input type="number" min="1" step="1" id="qCtx" value="${q.maxContextTokens ?? ''}" placeholder="none"></label>
    ${state.quotaError ? `<div class="note bad">${esc(state.quotaError)}</div>` : ''}
    <div class="quota-actions">
      <button type="submit" class="btn primary">Save</button>
      <button type="button" class="btn" id="qCancel">Cancel</button>
    </div>
  </form>`;
}

/**
 * Opening, saving and closing one role's limits.
 *
 * The save goes through the policy like any other ratified change — quotas are
 * inside the policy hash, so raising a ceiling re-versions the policy and lands
 * in the audit trail. That is the reason this is a form with a Save rather than
 * a field that writes as you type: an administrator changing what their team is
 * allowed to spend should have to mean it.
 */
export function bindLimits() {
  const grid = document.querySelector('.quota-grid');
  if (grid) grid.onclick = (e) => {
    const card = e.target.closest('[data-quota]');
    if (!card) return;
    state.quotaEdit = card.dataset.quota;
    state.quotaError = '';
    render();
  };

  const form = $('quotaForm');
  if (!form) return;

  const cancel = $('qCancel');
  if (cancel) cancel.onclick = () => { state.quotaEdit = null; state.quotaError = ''; render(); };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const num = (id) => {
      const raw = $(id)?.value.trim();
      return raw ? Number(raw) : null;
    };
    const role = form.dataset.role;
    const { ok, j } = await api(`/api/quotas/${encodeURIComponent(role)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maxRequestsPerDay: num('qDay'),
        maxSessionOutputTokens: num('qOut'),
        maxContextTokens: num('qCtx')
      })
    });
    if (!ok) {
      state.quotaError = j.error ?? 'could not save that limit';
      return render();
    }
    state.quotaError = '';
    state.quotaEdit = null;
    await refreshPolicy();
    render();
  };
}
