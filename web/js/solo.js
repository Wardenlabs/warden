/**
 * "This device": the reduced console for protecting one machine rather than administering a team.
 */
import { $, api, attr, del, esc, post, state } from './core.js';
import { TOOL_NAMES, plural } from './format.js';
import { soloIsPureInstall } from './nav.js';
import { render } from './render.js';
import { compileFailure, notARuleAnswer, readable } from './answers.js';
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
 *
 * One list, one page. There used to be four stacked sections — presets to
 * tick, a free-text box, what's on, a "Protect this device" button with no
 * memory of what it last did — each with its own kicker and a paragraph
 * under it. Read the whole thing once with fresh eyes and it was a small
 * essay standing in for a status check. What's here instead: a one-line
 * header that says whether this device is actually protected right now
 * (never a one-off test result — see `pageHead` below), and one list where
 * every rule that touches you lives, on or off, yours or not.
 */

const roleExempt = (role) => (state.policy?.exemptRoles ?? ['admin']).includes(role);

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
  await post('/api/solo/setup');
  await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
  render();
}

// ── the page head ────────────────────────────────────────────────────────────

/**
 * "Protected" means one real request from one real tool has actually been
 * judged here — read off `identity.connected` (`policy/activity.js`), which
 * only fills in once `/api/guard/check` has genuinely succeeded. It is
 * deliberately not "a rule is switched on" and it is not the result of a
 * synthetic test this screen ran on itself: either of those can be true while
 * Claude Code was never actually wired up, which is exactly the gap that used
 * to make this screen say "protected" about a laptop that was not.
 */
function pageHead() {
  const identity = state.soloIdentity;
  const connected = identity?.connected ?? [];
  const isProtected = connected.length > 0;
  const toolsLine = isProtected
    ? connected.map((c) => `${TOOL_NAMES[c.tool] ?? c.tool} · ${plural(c.count, 'request')} today`).join(', ')
    : 'not connected yet';

  const action = isProtected
    ? `<button type="button" class="btn --primary" id="soloFocusRule">Add rule</button>`
    : `<button type="button" class="btn --primary" id="soloProtect"${state.soloProtecting ? ' disabled' : ''}>${state.soloProtecting ? 'Setting up…' : 'Protect this device'}</button>`;

  return `<header class="page-head">
    <div>
      <h1 class="page-title">This device</h1>
      <div class="page-status">
        <span class="dot ${isProtected ? 'allow' : 'escalate'}"></span>
        <span>${isProtected ? 'Protected' : 'Not protected yet'}</span>
        <i>·</i>
        <span class="muted">${esc(toolsLine)}</span>
        ${!soloIsPureInstall() && identity ? `<i>·</i><span class="muted">${esc(identity.role)}${roleExempt(identity.role) ? ' · exempt from company-wide rules' : ''}</span>` : ''}
      </div>
    </div>
    ${action}
  </header>
  ${state.soloProtectError ? `<div class="note bad under">${esc(state.soloProtectError)}</div>` : ''}`;
}

// ── the rules list ───────────────────────────────────────────────────────────

/**
 * A rule this identity actually wrote or turned on — bound to `@you`. Whether
 * it started as a preset or was typed by hand only matters at the moment of
 * removing it (see `bindSolo`'s confirm), which is where that distinction is
 * made, not here — a tag repeating it on every row would be trivia standing
 * in the way of the one thing this row says: this is judging you right now.
 */
function ruleOnRow(r) {
  const busy = state.soloToggling === r.id;
  return `<div class="row">
    <span class="dot ${esc(r.severity)}"></span>
    <span class="txt on">${esc(r.text)}</span>
    <label class="check">
      <input type="checkbox" checked data-rule-off="${attr(r.id)}"${busy ? ' disabled' : ''}>
    </label>
    ${menu(r.id, [['remove', 'Remove', 'danger']])}
  </div>`;
}

/**
 * A company-wide rule that would bind anyone else, but not you — only ever
 * shown when your role is exempt from it. No control here, on purpose:
 * unlike a preset or a rule you wrote, this is not yours to turn off. See the
 * comment on `/api/solo/rules` for why the server sends it at all.
 */
function ruleExemptRow(r) {
  return `<div class="row">
    <span class="dot"></span>
    <span class="txt">${esc(r.text)}</span>
    <span class="meta">everyone · not judged for you</span>
  </div>`;
}

/** A preset not turned on yet — no tag needed, "Suggested" above already says what these are. */
function presetOffRow(p) {
  const busy = state.soloToggling === p.id;
  return `<div class="row">
    <span class="dot"></span>
    <span class="txt">${esc(p.text)}</span>
    <label class="check">
      <input type="checkbox" data-preset="${attr(p.id)}"${busy ? ' disabled' : ''}>
    </label>
  </div>`;
}

/** The "···" menu — mirrors `team.js`'s, kept local: one tiny helper is
 *  cheaper to duplicate than to thread an export across two unrelated views. */
function menu(id, items) {
  return `<details class="menu">
    <summary aria-label="More">···</summary>
    <div class="menu-list">
      ${items.map(([act, label, cls]) => `<button type="button" class="menu-item${cls ? ` --${cls === 'danger' ? 'destructive' : cls}` : ''}" data-act="${act}" data-id="${attr(id)}">${label}</button>`).join('')}
    </div>
  </details>`;
}

function soloBody() {
  const onRules = state.soloRules.filter((r) => r.applies !== false);
  const exemptRules = state.soloRules.filter((r) => r.applies === false);
  const offPresets = state.soloPresets.filter((p) => !p.active);

  if (state.soloLoadError && !onRules.length && !offPresets.length) {
    return `<div class="sheet settings">${pageHead()}<div class="note bad">${esc(state.soloLoadError)}</div></div>`;
  }

  return `<div class="sheet settings">
    ${pageHead()}

    <div class="tbl solo-rules">
      ${onRules.map(ruleOnRow).join('')}
      ${exemptRules.map(ruleExemptRow).join('')}
      ${!onRules.length && !exemptRules.length
        ? '<div class="empty"><b>Nothing turned on yet.</b><span>Turn on a preset below, or write your own.</span></div>'
        : ''}
    </div>

    ${offPresets.length ? `
      <div class="label under">Suggested</div>
      <div class="tbl solo-rules">${offPresets.map(presetOffRow).join('')}</div>
    ` : ''}

    <div class="row solo-add">
      <span class="dot"></span>
      <input type="text" id="soloRuleText" class="grow" placeholder="Write your own rule…" autocomplete="off"${state.soloBusy ? ' disabled' : ''}>
      <button type="button" class="btn --link" id="soloRuleSend"${state.soloBusy ? ' disabled' : ''}>Add</button>
    </div>
    ${state.soloRuleNote ? `<div class="note under">${state.soloRuleNote}</div>` : ''}
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
      const isPreset = id.startsWith('solo-');
      // A preset just moves back to Suggested — its text lives in the
      // catalogue, so nothing is lost and no confirmation earns its cost.
      // A rule you wrote has no such backup: unchecking it deletes it, so
      // this is the one place that asks first.
      if (!isPreset && !confirm('Remove this rule? There is no catalogue to restore it from — this deletes it.')) {
        off.checked = true;
        return;
      }
      await removeSoloRule(id, isPreset);
    }
  };

  pane.onclick = async (e) => {
    const el = e.target.closest('[data-act="remove"]');
    if (!el) return;
    el.closest('details.menu')?.removeAttribute('open');
    const id = el.dataset.id;
    const isPreset = id.startsWith('solo-');
    if (!isPreset && !confirm('Remove this rule? There is no catalogue to restore it from — this deletes it.')) return;
    await removeSoloRule(id, isPreset);
  };

  const addRule = async () => {
    const box = $('soloRuleText');
    const originalText = box?.value;
    const text = originalText?.trim();
    if (!text || state.soloBusy) return;
    box.value = '';
    state.soloBusy = true;
    state.soloRuleNote = 'Checking it…';
    render();

    const { ok, j } = await post('/api/solo/rules', { text });

    state.soloBusy = false;
    // Same compiler, same failure mode as the team console (spec §5): a
    // sentence that reads as a wish rather than a prohibition comes back
    // `notARule` rather than a rule nobody meant, and gets the identical
    // explanation `notARuleAnswer` already writes for that case there.
    if (ok && j.notARule) {
      state.soloRuleNote = notARuleAnswer(j);
    } else if (!ok) {
      state.soloRuleNote = j?.kind === 'compiler-setup-required' ? compileFailure(j) : `<b>Could not add that.</b> ${esc(readable(j?.error))}`;
    } else {
      state.soloRuleNote = '';
      await refreshSoloRules();
    }
    render();
    if (!ok && j?.kind === 'compiler-setup-required') restoreSoloRuleText(originalText);
  };
  const send = $('soloRuleSend');
  if (send) send.onclick = addRule;
  const text = $('soloRuleText');
  if (text) text.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void addRule(); } };

  const focusRule = $('soloFocusRule');
  if (focusRule) focusRule.onclick = () => $('soloRuleText')?.focus();

  const protect = $('soloProtect');
  if (protect) protect.onclick = async () => {
    state.soloProtecting = true;
    state.soloProtectError = '';
    render();

    const setup = await post('/api/solo/protect');
    state.soloProtecting = false;
    if (!setup.ok) {
      state.soloProtectError = setup.j?.error ?? 'Could not finish setting this up.';
      render();
      return;
    }
    // `connected` only turns true once a real prompt has actually gone
    // through the freshly-wired hook — this deliberately does not claim
    // success on setup's say-so alone. A new terminal, then a real prompt,
    // is what moves the header from "Not protected yet" to "Protected".
    await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
    render();
  };
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
      <p class="note">Warden is protecting one device: yours. Nobody else's prompts are checked, and nothing here is visible to anyone else.</p>
      <button type="button" class="btn" data-go="models">Manage compiler and analyzer models</button>
    </div>
    <div class="section">
      <div class="label">Managing a team too?</div>
      <p class="note">Add people, send each their install link, and write rules for them. What you've set up here keeps working as it does now.</p>
      <button type="button" class="btn --primary" id="soloGoTeam" style="width:fit-content">Add people</button>
    </div>
  </div>`;
}

function bindSoloSettings() {
  // Not named `go`: the router's `go` is imported here, and shadowing it is
  // the bug that broke rule removal in draft.js for a release.
  const toTeam = $('soloGoTeam');
  if (toTeam) toTeam.onclick = () => { location.hash = '#people'; };
}

VIEWS.soloSettings = {
  body: soloSettingsBody,
  bind: bindSoloSettings
};
