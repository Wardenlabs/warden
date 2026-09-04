/**
 * "This device": the reduced console for protecting one machine rather than administering a team.
 */
import { verdictWord } from './activity.js';
import { $, api, attr, esc, severityMeans, state } from './core.js';
import { render } from './render.js';
import { go } from './router.js';
import { notARuleAnswer, readable } from './rules.js';
import { VIEWS } from './views.js';

// ═══ SOLO ════════════════════════════════════════════════════════════════════

/**
 * "This device" — the reduced console for protecting one machine rather than
 * administering a directory of people. See docs/specs/solo-mode.md §7 and
 * docs/prd/solo-mode.md §5 ("cero apariciones de 'empleado', 'compañía' o
 * 'rol'"): this view never reads `state.company`, never uses those words in
 * anything a person reads, and shares no markup with `VIEWS.people` or
 * `VIEWS.policy` — it is a thin client over `/api/solo/*`, which already does
 * the scoping to one identity.
 */

async function refreshSoloPresets() {
  const { ok, j } = await api('/api/solo/presets');
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
  const { ok, j } = await api('/api/solo/rules');
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
 * needed, which is simpler to keep correct than threading that guess through
 * every other call this view makes.
 */
async function onEnterSolo() {
  await api('/api/solo/setup', { method: 'POST' });
  await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
  render();
}

function soloPresetRow(p) {
  const busy = state.soloToggling === p.id;
  return `<label class="check">
      <input type="checkbox" data-preset="${attr(p.id)}"${p.active ? ' checked' : ''}${busy ? ' disabled' : ''}>
      <span class="dot ${esc(p.severity)}"></span>
      <span>${esc(p.text)}</span>
    </label>`;
}

function soloRuleRow(r) {
  return `<div class="row roomy">
      <span class="dot ${esc(r.severity)}"></span>
      <span class="col">
        <span class="t">${esc(r.text)}</span>
        <span class="m"><span class="badge ${esc(r.severity)}">${esc(r.severity)}</span> ${esc(severityMeans(r.severity))}</span>
      </span>
    </div>`;
}

/**
 * The evidence step (PRD §3.4): after protect runs, show the real decision
 * `/api/solo/test` returned rather than a bare "done" message. `verdict:
 * null` is a real, named answer from that endpoint — nothing is switched on
 * yet to demonstrate — not a failure, so it reads as a nudge rather than an
 * error.
 */
function soloEvidence(result) {
  if (!result) return '';
  if (result.verdict == null) {
    return `<div class="note">${result.reason === 'no active rule to test against yet'
      ? 'Nothing is switched on yet to show blocking a message — turn one of the options above on, then run this again.'
      : esc(result.reason ?? 'Could not run a check yet.')}</div>`;
  }
  const rule = result.firedRules?.[0];
  const line = result.verdict === 'ALLOW'
    ? 'Sent a real test message through — nothing here caught it.'
    : result.verdict === 'ESCALATE'
      ? 'Sent a real message that needed a second look — it is being held rather than sent, exactly as set up.'
      : 'Sent a real message that should be stopped, and it was.';
  return `<div class="group">
      <div class="detail-head"><span class="badge ${esc(result.verdict)}">${esc(verdictWord(result.verdict))}</span></div>
      <p class="summary">${esc(line)}</p>
      ${rule ? `<div class="banner">${esc(rule.ruleText ?? rule.reason ?? '')}</div>` : ''}
      ${rule?.guidance ? `<div class="note">${esc(rule.guidance)}</div>` : ''}
    </div>`;
}

function soloProtectSection() {
  if (state.soloProtecting) {
    return `<div class="leaves">
        <div class="leaves-head">Protection</div>
        <div class="note">Setting this device up — this can take a little while…</div>
      </div>`;
  }
  return `<div class="leaves">
      <div class="leaves-head">Protection</div>
      <div class="note">Wires up what's already on this device — Claude Code, Codex, whatever it finds — so what you send them gets checked here first, before it leaves.</div>
      <div class="actions"><button type="button" class="btn primary" id="soloProtect">Protect this device</button></div>
      ${state.soloProtectError ? `<div class="note bad">${esc(state.soloProtectError)}</div>` : ''}
      ${soloEvidence(state.soloTestResult)}
    </div>`;
}

function soloBody() {
  return `<div class="sheet settings">
    <p class="lede">Turn on what should never leave this device, or write your own below. Once it's set up, what you send Claude Code, Codex or similar gets checked here first.</p>

    <div class="section">
      <div class="label">Stop these automatically</div>
      <div id="soloPresetList">${state.soloGroups.length
        ? state.soloGroups.map((g) => `
            <div class="group">
              <div class="label">${esc(g.label)}</div>
              ${g.presets.map(soloPresetRow).join('')}
            </div>`).join('')
        : state.soloLoadError
          ? `<div class="note bad">${esc(state.soloLoadError)}</div>`
          : '<div class="note">Loading…</div>'}</div>
    </div>

    <div class="group">
      <div class="label">Add your own</div>
      <textarea id="soloRuleText" rows="2" placeholder="Describe what should never go out, the way you'd tell a colleague…"${state.soloBusy ? ' disabled' : ''}></textarea>
      <button type="button" class="btn primary" id="soloRuleSend"${state.soloBusy ? ' disabled' : ''}>Add this rule</button>
      ${state.soloRuleNote ? `<div class="note">${state.soloRuleNote}</div>` : ''}
    </div>

    <div class="section">
      <div class="label">What's protecting you right now</div>
      ${state.soloRules.length
        ? state.soloRules.map(soloRuleRow).join('')
        : '<div class="note">Nothing turned on yet. Switch one of the options above on, or write your own.</div>'}
    </div>

    ${soloProtectSection()}
  </div>`;
}

function bindSolo() {
  const list = $('soloPresetList');
  if (list) list.onchange = async (e) => {
    const box = e.target.closest('[data-preset]');
    if (!box) return;
    const id = decodeURIComponent(box.dataset.preset);
    state.soloToggling = id;
    render();
    await api(`/api/solo/presets/${encodeURIComponent(id)}/toggle`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: box.checked })
    });
    state.soloToggling = null;
    await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
    render();
  };

  const send = $('soloRuleSend');
  if (send) send.onclick = async () => {
    const box = $('soloRuleText');
    const text = box?.value.trim();
    if (!text || state.soloBusy) return;
    box.value = '';
    state.soloBusy = true;
    state.soloRuleNote = 'Checking it…';
    render();

    const { ok, j } = await api('/api/solo/rules', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text })
    });

    state.soloBusy = false;
    // Same compiler, same failure mode as the team console (spec §5): a
    // sentence that reads as a wish rather than a prohibition comes back
    // `notARule` rather than a rule nobody meant, and gets the identical
    // explanation `notARuleAnswer` already writes for that case there.
    if (ok && j.notARule) {
      state.soloRuleNote = notARuleAnswer(j);
    } else if (!ok) {
      state.soloRuleNote = `<b>Could not add that.</b> ${esc(readable(j?.error))}`;
    } else {
      state.soloRuleNote = '<b>Added.</b> It applies to you from now on.';
      await refreshSoloRules();
    }
    render();
  };

  const protect = $('soloProtect');
  if (protect) protect.onclick = async () => {
    state.soloProtecting = true;
    state.soloProtectError = '';
    state.soloTestResult = null;
    render();

    const setup = await api('/api/solo/protect', { method: 'POST' });
    if (!setup.ok) {
      state.soloProtecting = false;
      state.soloProtectError = setup.j?.error ?? 'Could not finish setting this up.';
      render();
      return;
    }

    // The confirmation step: run a real prompt through the guard and show
    // what happened, rather than stopping at a bare "done" (PRD §3.4).
    const test = await api('/api/solo/test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
    });
    state.soloProtecting = false;
    state.soloTestResult = test.ok ? test.j : { verdict: null, reason: test.j?.error ?? 'could not run a check' };
    await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
    render();
  };
}

VIEWS.soloRules = {
  body: soloBody,
  bind: bindSolo,
  onEnter: onEnterSolo
};

/**
 * The one place a pure solo install is allowed to say "team" — see
 * `SOLO_SETTINGS_NAV_ITEM` above for why this view exists at all. "This
 * device" stays clean of the word for as long as nobody has come looking
 * for it; here, somebody has.
 */
function soloSettingsBody() {
  return `<div class="sheet settings">
    <div class="section">
      <div class="label">This installation</div>
      <p class="note">Right now Warden is protecting one device — yours. Nobody else's prompts are checked, and nothing here is visible to anyone else.</p>
    </div>
    <div class="section">
      <div class="label">Managing a team too?</div>
      <p class="note">Add other people, give them their own install link, and write rules that apply to them — the same rules you've already got here keep working exactly as they do now.</p>
      <button type="button" class="btn primary" id="soloGoTeam" style="width:fit-content">Add people</button>
    </div>
  </div>`;
}

function bindSoloSettings() {
  const go = $('soloGoTeam');
  if (go) go.onclick = () => { location.hash = '#people'; };
}

VIEWS.soloSettings = {
  body: soloSettingsBody,
  bind: bindSoloSettings
};
