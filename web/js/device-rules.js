/** Device-scoped rule list. Mutations remain in the device controller. */
import { attr, esc, state } from './core.js';
import { button, dialog, effectText, feedback, listState } from './ui.js';

export function rulesSection(removing) {
  const identity = state.soloIdentity;
  const onRules = state.soloRules.filter((r) => r.applies !== false);
  const exemptRules = state.soloRules.filter((r) => r.applies === false);
  const offPresets = state.soloPresets.filter((p) => !p.active);
  const loading = !identity && !state.soloLoadError;

  const row = (r, on) => {
    const busy = state.soloToggling === r.id;
    return `<div class="trow" role="row">
      <span>${effectText(r.severity)}</span>
      <span class="${on ? 'cell-strong' : 'cell-muted'} solo-text">${esc(r.text)}</span>
      <span class="device-rule-action">${button(on ? 'Remove' : 'Add', { compact: true, attrs: on ? `data-act="remove" data-id="${attr(r.id)}" aria-label="Remove rule: ${esc(r.text)}"` : `data-add-preset="${attr(r.id)}" aria-label="Add rule: ${esc(r.text)}"`, busy })}</span>
    </div>`;
  };

  return `<section class="device-rules">
    ${state.soloToggleError ? feedback({ tone: 'error', icon: true, title: 'That rule did not change', body: esc(state.soloToggleError) }) : ''}
    ${state.soloLoadError && !onRules.length && !offPresets.length
      ? listState({ tone: 'attention', title: 'Could not load the rules for this device', body: state.soloLoadError, action: button('Retry loading', { kind: 'primary', id: 'soloRetry' }) })
      : loading ? feedback({ title: 'Loading the rules for this device…', body: '' })

        : `<div class="table device-table" role="table" aria-label="Rules on this device">
          <div class="device-list-heading">Applied rules <span>${onRules.length}</span></div>${onRules.map((r) => row(r, true)).join('')}
          ${exemptRules.map((r) => `<div class="trow" role="row"><span>${effectText(r.severity)}</span><span class="cell-stack"><span class="cell-muted solo-text">${esc(r.text)}</span><small>everyone</small></span><span class="cell-muted">Exempt</span></div>`).join('')}
          ${offPresets.length ? `<div class="device-list-heading">Suggested rules <span>${offPresets.length}</span></div>${offPresets.map((p) => row(p, false)).join('')}` : ''}
        </div>
        <div class="inline-form device-add">
          <input type="text" id="soloRuleText" aria-label="New rule" placeholder="Write your own rule…" autocomplete="off"${state.soloBusy ? ' disabled' : ''}>
          ${button(state.soloBusy ? 'Checking…' : 'Add rule', { id: 'soloRuleSend', busy: state.soloBusy })}
        </div>
        ${state.soloRuleNote ? `<div class="device-note">${state.soloRuleNote}</div>` : ''}`}
    ${removing ? dialog({
      id: 'soloRemove', title: 'Remove this rule?',
      body: `<p>${esc(removing.text)}</p><p>This deletes the rule.</p>`,
      actions: button('Cancel', { attrs: 'data-dialog-close="soloRemove"' }) + button('Remove rule', { kind: 'danger', id: 'confirmSoloRemove' })
    }) : ''}
  </section>`;
}

