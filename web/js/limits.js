/**
 * Limits by role: the editor, and the save that goes through the policy like any ratified change.
 *
 * The grid of cards this used to draw lived on Rules, which is not where roles
 * are administered — Team's Roles tab already listed the same daily limit in a
 * column. The editor moved to that column rather than being deleted with the
 * grid: it is the only place in the console where a role's token ceilings can
 * be changed at all, and the duplicated thing was the number, not the form.
 */
import { $, esc, post, state } from './core.js';
import { refreshPolicy } from './data.js';
import { render } from './render.js';

/**
 * One role's limits, open.
 *
 * Blank means no limit, in all three boxes, because that is the same sentence
 * the policy stores — a role with no quota row is the unmetered case, and
 * giving "no limit" a second spelling (0, or an unchecked box) would put two
 * representations of one state into a file that is hashed.
 */
export function limitEditor(role) {
  const q = state.policy.quotas.find((item) => item.role === role) ?? { role };
  // `step="1"` on the token boxes, not the round 1000 that reads better. With
  // `min="1"`, a step of 1000 makes the valid values 1, 1001, 2001… so 250000
  // is invalid and the browser refuses the submit — with a tooltip, no error,
  // and no request. Caught in a browser; it cannot be caught by reading.
  return `<form class="quota editing" id="quotaForm" data-role="${esc(q.role)}">
    <label class="quota-row"><span>requests</span>
      <input type="number" min="1" step="1" id="qDay" value="${q.maxRequestsPerDay ?? ''}" placeholder="none"></label>
    <label class="quota-row"><span>output</span>
      <input type="number" min="1" step="1" id="qOut" value="${q.maxSessionOutputTokens ?? ''}" placeholder="none"></label>
    <label class="quota-row"><span>context</span>
      <input type="number" min="1" step="1" id="qCtx" value="${q.maxContextTokens ?? ''}" placeholder="none"></label>
    <label class="quota-row"><span>prompt chars</span>
      <input type="number" min="1" step="1" id="qPrompt" value="${q.maxPromptChars ?? ''}" placeholder="none"></label>
    ${state.quotaError ? `<div class="note bad">${esc(state.quotaError)}</div>` : ''}
    <div class="quota-actions">
      <button type="submit" class="btn --primary">Save</button>
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
  for (const button of document.querySelectorAll('[data-quota]')) button.onclick = () => {
    state.quotaEdit = button.dataset.quota;
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
    const { ok, j } = await post(`/api/quotas/${encodeURIComponent(role)}`, {
        maxRequestsPerDay: num('qDay'),
        maxSessionOutputTokens: num('qOut'),
        maxContextTokens: num('qCtx'),
        maxPromptChars: num('qPrompt')
      }, { method: 'PUT' });
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
