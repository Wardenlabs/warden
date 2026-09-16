/**
 * "This device": the machine Warden runs on — its tools, its address, its data — and the rules that protect it.
 */
import { $, api, attr, del, esc, post, state } from './core.js';
import { TOOL_NAMES, plural } from './format.js';
import { soloIsPureInstall } from './nav.js';
import { render } from './render.js';
import { compileFailure, notARuleAnswer, readable } from './answers.js';
import { button, contextBar, dialog, effectText, feedback, listState, menu, pageHead, statusText } from './ui.js';
import { VIEWS } from './views.js';

// ═══ THIS DEVICE ═════════════════════════════════════════════════════════════

/**
 * The machine, not the person. The page leads with what is true of this
 * computer — which tools on it are wired to Warden, whether the gateway is
 * reachable from outside, and what it keeps on disk — and ends with the rules
 * that protect it, which is what a person protecting their own machine came to
 * set.
 *
 * The rules half never reads `state.company` and never says employee, company
 * or role (docs/prd/solo-mode.md §5): it is a thin client over `/api/solo/*`,
 * which already scopes everything to this device's identity.
 */

const roleExempt = (role) => (state.policy?.exemptRoles ?? ['admin']).includes(role);

async function refreshSoloPresets() {
  const { ok, j } = await api('/api/solo/presets').catch(() => ({ ok: false }));
  if (ok) {
    state.soloIdentity = j.identity;
    state.soloPresets = Array.isArray(j.presets) ? j.presets : [];
    state.soloGroups = Array.isArray(j.groups) ? j.groups : [];
    state.soloLoadError = '';
  } else {
    state.soloLoadError = "Couldn't load your options — check the gateway is running and try again.";
  }
  return ok;
}

async function refreshSoloRules() {
  const { ok, j } = await api('/api/solo/rules').catch(() => ({ ok: false }));
  if (ok) {
    state.soloIdentity = j.identity;
    state.soloRules = Array.isArray(j.rules) ? j.rules : [];
    state.soloLoadError = '';
  } else {
    state.soloLoadError = "Couldn't load your options — check the gateway is running and try again.";
  }
  return ok;
}

/**
 * `/api/solo/setup` is idempotent and cheap by design (spec §6) — it returns
 * an existing identity untouched in the coexistence case and only creates one
 * the first time a pure install has nobody in it yet — so this always calls
 * it on the way in rather than trying to work out ahead of time whether it is
 * needed.
 */
async function onEnterSolo() {
  await post('/api/solo/setup').catch(() => null);
  await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
  render();
}

// ── the machine ──────────────────────────────────────────────────────────────

/**
 * The tools this gateway looked for, and whether each is actually judged.
 *
 * "Judging requests" means a real request from that tool has been checked for
 * this device's identity — read off `identity.connected`, which fills in only
 * once `/api/guard/check` has genuinely succeeded. Found on the machine and
 * wired to Warden are different facts, and the row says which one it has.
 */
const HOOK_OF = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', 'cursor-agent': 'cursor' };

function toolRows() {
  const found = state.compiler?.cliTools ?? [];
  const connected = state.soloIdentity?.connected ?? [];
  const rows = new Map();
  for (const t of found) {
    const hook = HOOK_OF[t.tool];
    if (!hook) continue;
    if (!t.found && !['claude', 'codex'].includes(t.tool)) continue;
    rows.set(hook, { name: TOOL_NAMES[hook] ?? t.label, found: t.found });
  }
  for (const c of connected) rows.set(c.tool, { ...(rows.get(c.tool) ?? { name: TOOL_NAMES[c.tool] ?? c.tool, found: true }), connected: c });
  return [...rows.values()].map((r) => {
    const status = r.connected
      ? statusText(`Judging requests · verified ${ago(Date.parse(r.connected.at))}`, 'allow')
      : r.found ? '<span class="cell-muted">Installed · not judged by Warden yet</span>' : '<span class="cell-muted">Not found on this machine</span>';
    return `<div class="setting-row"><span>${esc(r.name)}</span>${status}</div>`;
  }).join('');
}

function ago(ts) {
  if (!Number.isFinite(ts)) return 'recently';
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/*
 * The public address and what is kept on disk used to live here, as two
 * disclosures under the tool list. Both are facts about the server, not about
 * this computer, and putting them on the page titled "This device" meant the
 * one screen that answers "is my machine wired up" also answered "is the
 * company's gateway on the internet". They moved to `gateway.js` whole,
 * including the 202 handling the tunnel needs.
 */

// ── the rules ────────────────────────────────────────────────────────────────

let removing = null;

function rulesSection() {
  const identity = state.soloIdentity;
  const connected = identity?.connected ?? [];
  const isProtected = connected.length > 0;
  const onRules = state.soloRules.filter((r) => r.applies !== false);
  const exemptRules = state.soloRules.filter((r) => r.applies === false);
  const offPresets = state.soloPresets.filter((p) => !p.active);
  const loading = !identity && !state.soloLoadError;
  const protectLine = isProtected
    ? statusText(`Protected · ${connected.map((c) => `${TOOL_NAMES[c.tool] ?? c.tool} · ${plural(c.count, 'request')} today`).join(', ')}`, 'allow')
    : statusText('Not protected yet · no tool on this machine has sent a request through Warden', 'attention');

  const row = (r, on) => {
    const busy = state.soloToggling === r.id;
    return `<div class="trow" role="row">
      <span>${effectText(r.severity)}</span>
      <span class="${on ? 'cell-strong' : 'cell-muted'} solo-text">${esc(r.text)}</span>
      <label class="check"><input type="checkbox"${on ? ` checked data-rule-off="${attr(r.id)}"` : ` data-preset="${attr(r.id)}"`}${busy ? ' disabled' : ''} aria-label="${on ? 'Turn off' : 'Turn on'}: ${esc(r.text)}"></label>
      <span class="row-menu">${on ? menu([{ label: 'Remove', act: 'remove', attrs: `data-id="${attr(r.id)}"`, destructive: true }], { label: 'Actions for this rule' }) : ''}</span>
    </div>`;
  };

  return `<section class="device-rules">
    <div class="device-rules-head">
      <div><h2 class="section-title --big">Rules on this device</h2><p class="section-lede">${protectLine}${!soloIsPureInstall() && identity ? ` <span class="muted">· ${esc(identity.role)}${roleExempt(identity.role) ? ', exempt from company-wide rules' : ''}</span>` : ''}</p></div>
      ${isProtected ? '' : button(state.soloProtecting ? 'Setting up…' : 'Protect this device', { kind: 'primary', id: 'soloProtect', busy: state.soloProtecting })}
    </div>
    ${state.soloProtectError ? feedback({ tone: 'error', icon: true, title: 'This device is not protected yet', body: esc(state.soloProtectError) }) : ''}
    ${state.soloToggleError ? feedback({ tone: 'error', icon: true, title: 'That rule did not change', body: esc(state.soloToggleError) }) : ''}
    ${state.soloLoadError && !onRules.length && !offPresets.length
      ? listState({ tone: 'attention', title: 'Could not load the rules for this device', body: state.soloLoadError, action: button('Retry loading', { kind: 'primary', id: 'soloRetry' }) })
      : loading ? feedback({ title: 'Loading the rules for this device…', body: 'Fetching what is turned on and what is suggested.' })
        : `<div class="table device-table" role="table" aria-label="Rules on this device">
          ${onRules.map((r) => row(r, true)).join('')}
          ${exemptRules.map((r) => `<div class="trow" role="row"><span>${effectText(r.severity)}</span><span class="cell-stack"><span class="cell-muted solo-text">${esc(r.text)}</span><small>everyone · not judged for you</small></span><span></span><span></span></div>`).join('')}
          ${!onRules.length && !exemptRules.length ? '<div class="trow"><span></span><span class="cell-muted">Nothing turned on yet. Turn on a suggestion below, or write your own.</span></div>' : ''}
          ${offPresets.length ? `<div class="group-band">Suggested · ${offPresets.length}</div>${offPresets.map((p) => row(p, false)).join('')}` : ''}
        </div>
        <div class="inline-form device-add">
          <input type="text" id="soloRuleText" placeholder="Write your own rule…" autocomplete="off"${state.soloBusy ? ' disabled' : ''}>
          ${button(state.soloBusy ? 'Checking…' : 'Add rule', { id: 'soloRuleSend', busy: state.soloBusy })}
        </div>
        ${state.soloRuleNote ? `<div class="device-note">${state.soloRuleNote}</div>` : ''}`}
    ${removing ? dialog({
      id: 'soloRemove', title: 'Remove this rule?',
      body: `<p>${esc(removing.text)}</p><p>There is no catalogue to restore it from — this deletes it.</p>`,
      actions: button('Cancel', { attrs: 'data-dialog-close="soloRemove"' }) + button('Remove rule', { kind: 'danger', id: 'confirmSoloRemove' })
    }) : ''}
  </section>`;
}

function soloBody() {
  return `<div class="sheet">
    ${contextBar([{ label: 'This device' }])}
    ${pageHead({ title: 'This device', sub: 'One device: yours. What is wired here, and what is judging you.' })}
    <div class="reading device-page">
      <section class="settings-task">
        <h2 class="section-title">Tools on this device</h2>
        <p class="section-lede">Warden judges a tool’s requests only while that tool is wired to it. Checked automatically.</p>
        <div class="setting-rows">${toolRows() || '<div class="setting-row"><span class="cell-muted">No supported tool was found on this device.</span></div>'}</div>
      </section>
      ${rulesSection()}
    </div>
  </div>`;
}

/** A setup refusal did not use up the rule the person typed. A later edit
 * owns the field, so an older request must never replace that newer text. */
export function restoreSoloRuleText(originalText) {
  const input = $('soloRuleText');
  if (input && input.value === '') input.value = originalText;
}

function bindSolo() {
  const pane = $('pane');

  pane.onchange = async (e) => {
    const preset = e.target.closest('[data-preset]');
    if (preset) {
      const id = decodeURIComponent(preset.dataset.preset);
      state.soloToggling = id;
      state.soloToggleError = '';
      render();
      const r = await post(`/api/solo/presets/${encodeURIComponent(id)}/toggle`, { active: true });
      state.soloToggling = null;
      // A checkbox that goes back to where it was is the whole report a failed
      // toggle used to make. It reads as a control that does not work, which is
      // indistinguishable from a click the page never received, and both look
      // like the product is broken rather than like something went wrong.
      if (!r.ok) { state.soloToggleError = toggleFailure(r, 'turn that rule on'); render(); return; }
      await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
      render();
      return;
    }
    const off = e.target.closest('[data-rule-off]');
    if (off) {
      const id = decodeURIComponent(off.dataset.ruleOff);
      // A preset just moves back to Suggested — its text lives in the
      // catalogue, so nothing is lost and no confirmation earns its cost.
      // A rule you wrote has no such backup: unchecking it deletes it, so
      // this is the one place that asks first.
      if (!id.startsWith('solo-')) {
        off.checked = true;
        removing = state.soloRules.find((r) => r.id === id) ?? { id, text: '' };
        render();
        return;
      }
      await removeSoloRule(id, true);
    }
  };

  pane.onclick = async (e) => {
    if (state.view !== 'soloRules') return;
    const close = e.target.closest('[data-dialog-close="soloRemove"]');
    if (close || e.target.matches('[data-dialog-scrim="soloRemove"]')) { removing = null; render(); return; }
    const el = e.target.closest('[data-act="remove"]');
    if (!el) return;
    el.closest('details.menu')?.removeAttribute('open');
    const id = el.dataset.id;
    if (id.startsWith('solo-')) { await removeSoloRule(id, true); return; }
    removing = state.soloRules.find((r) => r.id === id) ?? { id, text: '' };
    render();
  };

  const confirmRemove = $('confirmSoloRemove');
  if (confirmRemove) confirmRemove.onclick = async () => { const id = removing.id; removing = null; await removeSoloRule(id, false); };

  const addRule = async () => {
    const box = $('soloRuleText');
    const originalText = box?.value;
    const text = originalText?.trim();
    if (!text || state.soloBusy) return;
    box.value = '';
    state.soloBusy = true;
    state.soloRuleNote = '';
    render();

    const { ok, j } = await post('/api/solo/rules', { text }).catch(() => ({ ok: false, j: null }));

    state.soloBusy = false;
    // Same compiler, same failure mode as the team console (spec §5): a
    // sentence that reads as a wish rather than a prohibition comes back
    // `notARule` rather than a rule nobody meant, and gets the identical
    // explanation `notARuleAnswer` already writes for that case there.
    if (ok && j.notARule) state.soloRuleNote = notARuleAnswer(j);
    else if (!ok) state.soloRuleNote = j?.kind === 'compiler-setup-required' ? compileFailure(j) : feedback({ tone: 'error', icon: true, title: 'Could not add that', body: esc(readable(j?.error)) });
    else { state.soloRuleNote = ''; await refreshSoloRules(); }
    render();
    if (!ok && j?.kind === 'compiler-setup-required') restoreSoloRuleText(originalText);
  };
  if ($('soloRuleSend')) $('soloRuleSend').onclick = addRule;
  const text = $('soloRuleText');
  if (text) text.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void addRule(); } };
  if ($('soloRetry')) $('soloRetry').onclick = () => void onEnterSolo();

  const protect = $('soloProtect');
  if (protect) protect.onclick = async () => {
    state.soloProtecting = true;
    state.soloProtectError = '';
    render();
    const setup = await post('/api/solo/protect').catch(() => ({ ok: false, j: null }));
    state.soloProtecting = false;
    if (!setup.ok) {
      state.soloProtectError = setup.j?.error ?? 'Could not finish setting this up.';
      render();
      return;
    }
    // `connected` only turns true once a real prompt has actually gone
    // through the freshly-wired hook — this deliberately does not claim
    // success on setup's say-so alone. A new terminal, then a real prompt,
    // is what moves the line from "Not protected yet" to "Protected".
    await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
    render();
  };

}

/**
 * What to say when a toggle does not take.
 *
 * The gateway's own words when it sent any, because it knows what happened and
 * this function does not; the status only when nothing else is available, and
 * a 0 means the request never left the browser, which is its own diagnosis.
 */
function toggleFailure(r, attempt) {
  const said = typeof r.j?.error === 'string' ? r.j.error : '';
  if (said) return `Could not ${attempt}: ${said}`;
  if (!r.status) return `Could not ${attempt} — the gateway did not answer. It may have stopped.`;
  return `Could not ${attempt} — the gateway answered ${r.status}.`;
}

/** Shared by the checkbox and the "···" menu — same action, two doors in. */
async function removeSoloRule(id, isPreset) {
  state.soloToggling = id;
  state.soloToggleError = '';
  render();
  const r = isPreset
    ? await post(`/api/solo/presets/${encodeURIComponent(id)}/toggle`, { active: false })
    : await del(`/api/solo/rules/${encodeURIComponent(id)}`);
  state.soloToggling = null;
  if (!r.ok) { state.soloToggleError = toggleFailure(r, 'turn that rule off'); render(); return; }
  await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
  render();
}

VIEWS.soloRules = { body: soloBody, bind: bindSolo, onEnter: onEnterSolo };

// ── Settings, on a pure solo install ─────────────────────────────────────────

/**
 * The one place a pure solo install is allowed to say "team" — see
 * `SOLO_SETTINGS_NAV_ITEM` in nav.js for why this view exists at all. "This
 * device" stays clean of the word for as long as nobody has come looking for
 * it; here, somebody has. No frame of its own: a settings page in the system.
 */
function soloSettingsBody() {
  return `<div class="sheet">
    ${contextBar([{ label: 'This machine' }, { label: 'Settings' }])}
    ${pageHead({ title: 'Settings', sub: 'Warden is protecting one device: yours.' })}
    <div class="reading settings-page">
      <section class="settings-task">
        <h2 class="section-title">This installation</h2>
        <p class="section-lede">Nobody else's prompts are checked, and nothing here is visible to anyone else.</p>
        <div>${button('Manage the rule writer and the judge', { attrs: 'data-go="models"' })}</div>
      </section>
      <section class="settings-task">
        <h2 class="section-title">Managing a team too?</h2>
        <p class="section-lede">Add people, send each their install link, and write rules for them. What you've set up here keeps working as it does now.</p>
        <div>${button('Add people', { kind: 'primary', id: 'soloGoTeam' })}</div>
      </section>
    </div>
  </div>`;
}

function bindSoloSettings() {
  // Not named `go`: shadowing the router's `go` is the bug that broke rule
  // removal in draft.js for a release.
  const toTeam = $('soloGoTeam');
  if (toTeam) toTeam.onclick = () => { location.hash = '#/people'; };
}

VIEWS.soloSettings = { body: soloSettingsBody, bind: bindSoloSettings };

