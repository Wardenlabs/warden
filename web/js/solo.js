/**
 * "This device": the machine Warden runs on — its tools, its address, its data — and the rules that protect it.
 */
import { $, api, attr, del, esc, post, state } from './core.js';
import { refreshChain } from './data.js';
import { TOOL_NAMES, plural } from './format.js';
import { soloIsPureInstall } from './nav.js';
import { render } from './render.js';
import { compileFailure, notARuleAnswer, readable } from './answers.js';
import { button, contextBar, dialog, disclosureRow, effectText, feedback, listState, menu, pageHead, statusText } from './ui.js';
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
  await Promise.all([refreshSoloPresets(), refreshSoloRules(), refreshChain()]);
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

/**
 * The public address. Asking for a tunnel is a 202 — asked, not done — and the
 * gateway restarts behind it, so the page says it asked, and watches /health
 * until the address appears or goes.
 */
const expose = { asked: null, error: '', timer: null };

async function watchAddress(want) {
  clearTimeout(expose.timer);
  const started = Date.now();
  const tick = async () => {
    const health = await api('/health').catch(() => null);
    if (health?.ok) state.publicUrl = health.j?.publicUrl ?? null;
    const done = want ? Boolean(state.publicUrl) : !state.publicUrl;
    if (done || Date.now() - started > 120000) {
      expose.asked = null;
      if (!done) expose.error = want ? 'The tunnel did not open within two minutes. Try again.' : 'The tunnel did not close within two minutes. Try again.';
      if (state.view === 'soloRules') render();
      return;
    }
    expose.timer = setTimeout(tick, 3000);
  };
  expose.timer = setTimeout(tick, 3000);
}

function addressBlock() {
  const on = Boolean(state.publicUrl);
  const datum = expose.asked === 'open' ? 'Opening…' : expose.asked === 'close' ? 'Closing…' : on ? '<span class="status-text --allow">Reachable on the internet</span>' : 'This machine only';
  let body;
  if (expose.asked) {
    body = `<p class="disclosure-text">Anyone with the address reaches the gateway; they still need a key. It changes every time the tunnel restarts.</p>
      ${statusText(expose.asked === 'open' ? 'Asked the tunnel to open — usually under a minute. The address will appear here.' : 'Asked the tunnel to close — the address stops working when the gateway is back.', 'attention')}`;
  } else if (on) {
    body = `<p class="mono public-url">${esc(state.publicUrl)}</p>
      <p class="disclosure-text">It changes every time the tunnel restarts. Anyone with the address reaches the gateway; they still need a key.</p>
      <div class="btn-row">${button('Copy address', { attrs: `data-copy="${attr(state.publicUrl)}"` })}${button('Stop exposing', { id: 'stopExpose', disabled: !state.canLeaveDemo })}</div>`;
  } else {
    body = `<p class="disclosure-text">Anyone with the address reaches the gateway; they still need a key. It changes every time the tunnel restarts.</p>
      ${state.canLeaveDemo
        ? `<div>${button('Put it on the internet', { id: 'startExpose', disabled: state.mock })}</div>${state.mock ? '<p class="disclosure-text muted">Not while Warden is in demo mode: nothing here is really judged.</p>' : ''}`
        : '<p class="disclosure-text muted">Open a tunnel from the Warden app, or put your own proxy in front of it.</p>'}`;
  }
  if (expose.error) body += feedback({ tone: 'error', icon: true, title: 'The address did not change', body: esc(expose.error) });
  return disclosureRow('d:address', 'Public address', datum, body, { open: state.open.has('d:address') || Boolean(expose.asked) });
}

function dataBlock() {
  const chain = state.chain;
  const p = state.prompts;
  const datum = chain ? `Log · ${plural(chain.entries, 'record')} · ${chain.ok ? 'verified' : 'does not verify'}` : 'Log';
  return disclosureRow('d:data', 'Data on this machine', datum, `
    <dl class="record">
      <dt>Decision log</dt><dd>${chain ? `${plural(chain.entries, 'record')}, each linked to the one before; ${chain.ok ? 'every record still matches its hash' : 'a record was altered or removed after it was written'}. Prompts are stored as hashes, not text.` : 'Could not be verified right now.'}</dd>
      <dt>Prompt text</dt><dd>${p ? `Masked text kept ${plural(p.days, 'day')} so an administrator can read what was blocked; ${plural(p.held, 'prompt')} held now.` : 'Not kept: only hashes are stored.'}</dd>
    </dl>
    <div>${button('Open Activity →', { kind: 'link', attrs: 'data-go="activity"' })}</div>`, { open: state.open.has('d:data') });
}

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
  const on = Boolean(state.publicUrl);
  return `<div class="sheet">
    ${contextBar([{ label: 'This machine' }])}
    ${pageHead({ title: 'This device', sub: 'Warden runs on this machine. Every request from here passes through it.' })}
    <div class="reading device-page">
      <section class="settings-task">
        <h2 class="section-title">Tools on this machine</h2>
        <p class="section-lede">Warden judges a tool’s requests only while that tool is wired to it. Checked automatically.</p>
        <div class="setting-rows">${toolRows() || '<div class="setting-row"><span class="cell-muted">No supported tool was found on this machine.</span></div>'}</div>
      </section>
      <div class="disclosures">${addressBlock()}${dataBlock()}</div>
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
      render();
      await post(`/api/solo/presets/${encodeURIComponent(id)}/toggle`, { active: true });
      state.soloToggling = null;
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

  const askExpose = async (enabled) => {
    expose.error = '';
    const { ok, j } = await post('/api/gateway/expose', { enabled }).catch(() => ({ ok: false, j: null }));
    if (!ok) { expose.error = j?.error ?? 'Warden could not be reached.'; render(); return; }
    // 202: asked, not done. The gateway restarts behind the tunnel and the
    // console learns the address from /health once it is back.
    expose.asked = enabled ? 'open' : 'close';
    render();
    void watchAddress(enabled);
  };
  if ($('startExpose')) $('startExpose').onclick = () => void askExpose(true);
  if ($('stopExpose')) $('stopExpose').onclick = () => void askExpose(false);
}

/** Shared by the checkbox and the "···" menu — same action, two doors in. */
async function removeSoloRule(id, isPreset) {
  state.soloToggling = id;
  render();
  if (isPreset) await post(`/api/solo/presets/${encodeURIComponent(id)}/toggle`, { active: false });
  else await del(`/api/solo/rules/${encodeURIComponent(id)}`);
  state.soloToggling = null;
  await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
  render();
}

VIEWS.soloRules = {
  body: soloBody,
  bind: bindSolo,
  onEnter: onEnterSolo,
  onLeave: () => clearTimeout(expose.timer)
};

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

