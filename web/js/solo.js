/**
 * "This device": the machine Warden runs on — its tools, its address, its data — and the rules that protect it.
 */
import { $, api, attr, del, esc, post, state } from './core.js';
import { refreshCompiler, refreshHealth } from './data.js';
import { TOOL_NAMES, modelLabel, plural } from './format.js';
import { render } from './render.js';
import { go } from './router.js';
import { compileFailure, notARuleAnswer, readable } from './answers.js';
import { soloIsPureInstall } from './nav.js';
import { button, conditionBlock, dialog, effectText, feedback, listState, menu, pageHead, statusText, tabs } from './ui.js';
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
 * Whether the first run should take over instead of this screen.
 *
 * Four conditions, and each one is a way of not asking somebody a question
 * that has already been answered:
 *
 * - **A pure solo install.** Somebody who chose the team console at the splash
 *   is setting up a directory, not this machine, and must not be handed a
 *   recipe for wiring their own laptop. (Known gap: an empty directory reads as
 *   pure solo, so a team admin who has added nobody yet sees this once. The
 *   splash's answer is not written anywhere the gateway can read — see
 *   docs/specs/first-run-and-theme.md §2.2.)
 * - **Not demo.** Demo mode is the splash's other door, and it guards nothing,
 *   so there is no protection to verify. Leaving demo brings this back on its
 *   own: `/health` is re-read on every entry here.
 * - **Never completed.** Completion is durable and survives every withdrawal.
 *   Unwiring a tool changes what this screen says; it does not reopen setup.
 * - **The gateway answered.** With no identity there is nothing to ask about,
 *   and redirecting on a failed fetch would trap somebody on a screen whose own
 *   retry button lives here.
 */
function firstRunIsDue() {
  if (!soloIsPureInstall()) return false;
  if (state.mock) return false;
  if (!state.soloIdentity) return false;
  return !state.soloIdentity.completedFirstRun;
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
  // `/health` too: the conditions name which installation is running and
  // whether the mock is standing in for a judge, and both can have changed
  // since boot — the desktop app restarts the gateway to leave demo mode.
  await Promise.all([refreshSoloPresets(), refreshSoloRules(), refreshHealth()]);
  // Everything the decision needs is now loaded, which is why it is made here
  // and not in the router: the desktop app opens `#soloRules` explicitly and a
  // browser with no hash lands here too, so both paths come through this
  // function without desktop/main.ts having to know the flow exists. Coming
  // back from the flow re-runs this, finds the verification, and stays.
  if (firstRunIsDue()) { go('firstRun'); return; }
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

/**
 * The three facts about one tool, kept apart all the way to the screen.
 *
 * `found` is "this program is installed here" — the compiler's own CLI probe.
 * `wired` is what the machine reported about its own configuration, from
 * `devices`, on disk. `connected` is traffic the gateway actually judged, in
 * memory. A tool can be any combination of the three, and collapsing them is
 * how "installed but never wired" and "wired but quiet since Friday" ended up
 * wearing the same sentence.
 *
 * Wiring that was never reported is **absent**, not false: `wired === null`
 * means nobody knows, which is a different thing from "not wired" and gets a
 * different sentence.
 */
function toolState() {
  const found = state.compiler?.cliTools ?? [];
  const connected = state.soloIdentity?.connected ?? [];
  const devices = state.soloIdentity?.devices ?? [];
  const rows = new Map();
  const at = (id, patch) => rows.set(id, { name: TOOL_NAMES[id] ?? id, wired: null, ...(rows.get(id) ?? {}), ...patch });

  for (const t of found) {
    const hook = HOOK_OF[t.tool];
    if (!hook) continue;
    if (!t.found && !['claude', 'codex'].includes(t.tool)) continue;
    at(hook, { name: TOOL_NAMES[hook] ?? t.label, found: t.found });
  }
  // Newest report first, so an older machine cannot overwrite a fresher answer.
  for (const d of [...devices].reverse()) for (const t of d.tools ?? []) at(t.id, { wired: t.wired, reportedAt: d.reportedAt, device: d.name });
  for (const c of connected) at(c.tool, { connected: c });
  return [...rows.entries()].map(([id, r]) => ({ id, ...r }));
}

const wiredTools = () => toolState().filter((t) => t.wired === true);
const judgedTools = () => toolState().filter((t) => t.connected);

function toolLine(t) {
  if (t.wired === true) {
    return t.connected
      ? statusText(`Wired · last judged ${ago(Date.parse(t.connected.at))}`, 'allow')
      : `<span class="cell-muted">Wired · nothing judged through it yet</span>`;
  }
  if (t.wired === false) return statusText('Not wired · the hook is not in its settings', 'attention');
  if (t.connected) return statusText(`Judging requests · last seen ${ago(Date.parse(t.connected.at))}`, 'allow');
  return `<span class="cell-muted">${t.found ? 'Installed · has not reported its wiring' : 'Not found on this device'}</span>`;
}

function toolRows() {
  return toolState().map((t) => `<div class="setting-row"><span>${esc(t.name)}</span>${toolLine(t)}</div>`).join('');
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
  const onRules = state.soloRules.filter((r) => r.applies !== false);
  const exemptRules = state.soloRules.filter((r) => r.applies === false);
  const offPresets = state.soloPresets.filter((p) => !p.active);
  const loading = !identity && !state.soloLoadError;

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
    ${state.soloToggleError ? feedback({ tone: 'error', icon: true, title: 'That rule did not change', body: esc(state.soloToggleError) }) : ''}
    ${state.soloLoadError && !onRules.length && !offPresets.length
      ? listState({ tone: 'attention', title: 'Could not load the rules for this device', body: state.soloLoadError, action: button('Retry loading', { kind: 'primary', id: 'soloRetry' }) })
      : loading ? feedback({ title: 'Loading the rules for this device…', body: 'Fetching what is turned on and what is suggested.' })
        /*
         * No empty sentence, and the reason is not the layout.
         *
         * It read as orphaned because it was: an empty list here means no rule
         * is addressed at you, which is a gap, which means the conditions
         * block above is open and its `Rules for you` row is already saying
         * *"None. Nothing is addressed at you, so there is nothing to judge a
         * request against"* in amber, with the button that fixes it beside the
         * headline. `rulesRow` returns `tone: 'attention'` on every path where
         * this list can be empty, so the two are never apart.
         *
         * A second grey sentence a hundred pixels below the first, saying the
         * same thing with less of the reason, is not an empty state. The
         * Suggested band and a column of unchecked boxes are the empty state.
         */
        : `<div class="table device-table" role="table" aria-label="Rules on this device">
          ${onRules.map((r) => row(r, true)).join('')}
          ${exemptRules.map((r) => `<div class="trow" role="row"><span>${effectText(r.severity)}</span><span class="cell-stack"><span class="cell-muted solo-text">${esc(r.text)}</span><small>everyone</small></span><span></span><span></span></div>`).join('')}
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

// ── what is true of this device ──────────────────────────────────────────────

/**
 * The pause in force right now, or null. Same rule the server applies: an
 * `until` of null is indefinite, an unparseable one is treated as expired.
 */
function pausedNow() {
  const p = state.soloIdentity?.paused;
  if (!p) return null;
  if (p.until === null || p.until === undefined) return p;
  const t = Date.parse(p.until);
  return Number.isFinite(t) && t > Date.now() ? p : null;
}

/**
 * Five conditions, and the headline is their conclusion.
 *
 * This replaced a page that led with `isProtected = connected.length > 0` —
 * protection defined as traffic seen. Somebody who installed the hook,
 * downloaded the model and wrote a rule was told *"Not protected yet · no
 * tool on this machine has sent a request through Warden"*, in amber, until
 * they went and sent a prompt; and a gateway restart said it to everybody at
 * once, because the traffic lived in a Map. Wiring is now its own fact, read
 * from what the machine reported about itself, and traffic is the separate
 * line "last judged".
 *
 * Two of these conditions were invisible before and are the reason the block
 * exists rather than a status line. **The judge**: with no weights downloaded
 * the mock adapter answers, which is a stand-in and not a judgement, and every
 * screen looked identical. **Rules for you**: an exempt role is bound by no
 * company-wide rule, so a perfectly wired machine whose owner is exempt and
 * has written nothing is a machine nothing protects.
 */
function conditions() {
  const identity = state.soloIdentity;
  const where = state.health?.installation ?? {};
  const wired = wiredTools();
  const judged = judgedTools();
  const onRules = state.soloRules.filter((r) => r.applies !== false);
  const exemptRules = state.soloRules.filter((r) => r.applies === false);
  const exempt = identity && roleExempt(identity.role);

  const rows = [
    {
      label: 'Warden',
      value: `Running · ${where.label ? `“${esc(where.label)}”` : 'this installation'}${where.version ? ` v${esc(where.version)}` : ''} · this device`
    },
    // "You", always — never the name and never the role.
    //
    // This device is the screen of whoever is sitting at this machine, and by
    // construction there is no other candidate, so a name here is the page
    // telling somebody who they are. What the name looked like it was adding is
    // better placed elsewhere: the role matters for its consequences and
    // `Rules for you` states those without naming it, and both live one click
    // away on Identity. This row only has to say the gateway recognises you.
    //
    // Unresolved and not made worse by this: `resolveSoloIdentity`
    // (src/server/routes/solo.ts) picks the first exempt person when there is
    // more than one, so on such an installation "You" can be somebody else's
    // identity. The fix is deciding whose screen this is, not printing a name.
    identity
      ? { label: 'You', value: 'You · this gateway knows your key' }
      : { label: 'You', tone: 'attention', value: 'This gateway did not answer with an identity for you' },
    wiringRow(wired, judged),
    state.mock
      ? { label: 'The judge', tone: 'attention', value: 'Mock adapter · a stand-in answers, no model reads your prompts' }
      : { label: 'The judge', value: `${esc(judgeName())} · on this device, nothing leaves it` },
    rulesRow(onRules, exemptRules, exempt)
  ];

  const paused = pausedNow();
  const gaps = rows.filter((r) => r.tone === 'attention');
  return conditionBlock({
    key: 'dev:conditions',
    /*
     * Paused says itself once.
     *
     * It used to say itself four times over: an amber claim reading "Paused ·
     * nothing of yours is being judged", an amber gap row repeating it with the
     * consequence spelled out, an amber dot, and a primary button. Four alarms
     * for a state the person had just chosen on purpose, and amber elsewhere in
     * this console means something is wrong — which a pause is not. So: the
     * claim is the word, the detail is how long it lasts, and the tone is muted.
     * What the pause actually costs you is a fact like the other five, and it
     * sits with them in the evidence rather than shouting over the headline.
     */
    claim: paused ? 'Paused' : gaps.length ? 'Not judging you yet' : 'Protection is on',
    detail: paused ? pauseDetail(paused) : '',
    tone: paused ? 'muted' : gaps.length ? 'attention' : 'allow',
    summary: esc(`${wired.map((t) => t.name).join(' and ')} wired, judged by ${judgeName()} on this device, against ${plural(onRules.length, 'rule')} addressed at you.`),
    rows: paused ? [pauseRow(), ...rows] : rows,
    action: headlineAction(paused, gaps),
    open: state.open.has('dev:conditions')
  });
}

/** How long the pause lasts — the only qualifier the headline carries. */
function pauseDetail(paused) {
  return paused.until ? `until ${new Date(paused.until).toLocaleString()}` : 'until you turn it back on';
}

/**
 * What a pause costs, carried as evidence and not as an alarm.
 *
 * No `tone`, so it folds away with the other conditions instead of sitting
 * open in amber: somebody who just pressed Pause knows they paused it, and
 * somebody who comes back to the page opens the details to find out what that
 * means. The sentence is unchanged — it is the recording that makes a pause
 * safe to offer at all, and it stays written down.
 */
function pauseRow() {
  return { label: 'Paused', value: esc('Requests go through unchecked. Each one is still recorded, marked not judged.') };
}

/**
 * Wiring and traffic in one row, in that order, because they fail differently.
 * Nothing wired is a gap. Wired and quiet is not: a machine that has not been
 * asked anything today has nothing wrong with it, and calling that a fault is
 * exactly the old bug with a new coat of paint.
 */
function wiringRow(wired, judged) {
  if (!wired.length) {
    const reported = toolState().some((t) => t.wired !== null);
    return {
      label: 'Your tools',
      tone: 'attention',
      value: reported
        ? 'Nothing on this device is wired to Warden'
        : 'No tool has reported its wiring yet'
    };
  }
  const last = judged.map((t) => Date.parse(t.connected.at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return {
    label: 'Your tools',
    value: `${esc(wired.map((t) => t.name).join(', '))} · wired · ${last ? `last judged ${ago(last)}` : 'nothing judged through them yet'}`
  };
}

/**
 * What actually binds the person at this keyboard. An exempt role gets its own
 * sentence: company-wide rules exist and do not judge them, so a count of
 * "rules in the policy" would be the most reassuring possible way to be wrong.
 */
function rulesRow(onRules, exemptRules, exempt) {
  if (onRules.length) {
    // One rule, so say which one. The design's row reads "1 rule on · blocks
    // credential requests", and what it is after is what the rule protects
    // rather than how many there are — a count answers a question nobody with
    // one rule is asking. The console has no summary of a rule and must not
    // invent one, so this shows the rule's own sentence, which is also the
    // sentence the judge reads.
    if (onRules.length === 1) {
      return { label: 'Rules for you', value: `1 rule on · ${esc(onRules[0].text)}` };
    }
    // Past one, the texts stop fitting and the useful fact is the shape of the
    // set: how many, and how many of them refuse outright.
    const blocks = onRules.filter((r) => r.severity === 'block').length;
    const escalates = onRules.filter((r) => r.severity === 'escalate').length;
    const parts = [blocks ? `${blocks} block` : '', escalates ? `${escalates} escalate${escalates === 1 ? 's' : ''}` : ''].filter(Boolean);
    return { label: 'Rules for you', value: `${plural(onRules.length, 'rule')} on${parts.length ? ` · ${esc(parts.join(', '))}` : ''}` };
  }
  return {
    label: 'Rules for you',
    tone: 'attention',
    value: exempt && exemptRules.length
      ? `None. ${plural(exemptRules.length, 'company-wide rule')} exist and your role is exempt from them, so nothing judges you.`
      : 'None. Nothing is addressed at you, so there is nothing to judge a request against.'
  };
}

/**
 * One action, and it belongs to the headline.
 *
 * A row whose gap this button resolves does not also carry a button — two ways
 * to do the same thing is how somebody presses the wrong one. Turning Warden
 * off is `POST /api/solo/pause` with no end date, which is what an indefinite
 * pause is: off until somebody turns it on, recorded, with a name on it.
 */
function headlineAction(paused, gaps) {
  // Resume weighs the same as Pause. It was `kind: 'primary'`, which made the
  // one button on a paused page the loudest thing on the screen; the pair is
  // one switch and a switch does not get louder in one of its positions.
  if (paused) return button(state.soloPausing ? 'Resuming…' : 'Resume', { id: 'soloResume', busy: state.soloPausing });
  const first = gaps[0];
  // "Pause protection" rather than "Turn Warden off": same POST, same
  // indefinite pause, same record with a name on it. The word changed because
  // nothing here switches the gateway off — it is serving this page.
  if (!first) return button(state.soloPausing ? 'Pausing…' : 'Pause protection', { id: 'soloPause', busy: state.soloPausing });
  if (first.label === 'Your tools') return button(state.soloProtecting ? 'Setting up…' : 'Protect this device', { kind: 'primary', id: 'soloProtect', busy: state.soloProtecting });
  if (first.label === 'The judge') return button('Get a judge', { kind: 'primary', attrs: 'data-go="models"' });
  if (first.label === 'Rules for you') return button('Write a rule for yourself', { kind: 'primary', id: 'soloFocusRule' });
  return '';
}

function judgeName() {
  const a = state.adjudicator;
  const id = a?.inForce ?? a?.model ?? null;
  if (!id) return 'the local adjudicator';
  return a.choices?.find((c) => c.id === id)?.label ?? modelLabel(id);
}

// ── the page ─────────────────────────────────────────────────────────────────

const TABS = [['', 'Rules'], ['tools', 'Tools'], ['identity', 'Identity']];
const tabOf = () => (state.sel === 'tools' || state.sel === 'identity' ? state.sel : '');

/**
 * Tools that cannot be wired here, ever, and it is not about this machine.
 *
 * Cursor has no prompt hook to write into: there is nothing in `integrations/`
 * for it and there will not be, because that is somebody else's product
 * decision. The hook knows this — `AGENTS` in integrations/warden-hook.mjs
 * carries `governable: false` — but it cannot tell us: `reportWiring()` filters
 * ungovernable tools out before it builds the report, and including them would
 * mean sending a row whose `wired: false` is a fact about nothing.
 *
 * So the list is here, and the day somebody writes that integration this is the
 * line to delete. The console test on the impossible row is what fails if they
 * forget.
 */
const UNGOVERNABLE = new Set(['cursor']);

/**
 * One tool, as two stacked facts and at most one button.
 *
 * The middle state is why this tab exists. Two states force a lie in both
 * directions — a tool nobody has tested gets called protected, or a
 * perfectly-wired tool nobody has used yet gets called broken — so *configured*
 * says the cable is in and *verified* says current went through it. The second
 * line always names where the fact came from, so nobody has to take the
 * screen's word for it.
 */
function toolFacts(t) {
  const verified = (state.soloIdentity?.verified ?? []).find((v) => v.tool === t.id);
  const reported = t.reportedAt ? `reported ${ago(Date.parse(t.reportedAt))}` : 'reported by this machine';

  // "No prompt hook exists" is what "never will be from this device" means.
  if (UNGOVERNABLE.has(t.id)) {
    return {
      top: `<span class="cell-muted">Not judged, and never will be from this device</span>`,
      under: '',
      action: ''
    };
  }
  if (t.wired === true && verified) {
    return {
      top: statusText(`Judging requests · verified ${ago(Date.parse(verified.at))}`, 'allow'),
      under: `Wired · ${reported}`,
      action: button('Unwire', { compact: true, attrs: `data-unwire="${attr(t.id)}"`, busy: state.soloWiring === t.id })
    };
  }
  if (t.wired === true) {
    return {
      top: statusText('Configured · waiting for a real request', 'attention'),
      under: `Wired · ${reported}`,
      action: button('Unwire', { compact: true, attrs: `data-unwire="${attr(t.id)}"`, busy: state.soloWiring === t.id })
    };
  }
  /*
   * These two keep their second fact where the others lost theirs, and the
   * reason is that here it is not an explanation of the line above it — it is
   * the only thing telling the two states apart. Both read "Not connected · no
   * request judged" on top, and the difference between them is whether the
   * machine reported Warden missing from the tool's settings or has not
   * reported at all. Silence is not absence; conflating them is somebody's
   * afternoon spent fixing what was never broken. What went is the tail that
   * explained the fact rather than stating it.
   */
  // Reported absence. Silence (`wired === null`) is not this: it falls through.
  if (t.wired === false) {
    return {
      top: statusText('Not connected · no request judged', 'attention'),
      under: 'Found · not in its settings',
      action: button('Connect', { compact: true, attrs: `data-connect="${attr(t.id)}"`, busy: state.soloWiring === t.id })
    };
  }
  if (t.found) {
    return {
      top: statusText('Not connected · no request judged', 'attention'),
      under: 'Found · wiring not reported',
      action: button('Connect', { compact: true, attrs: `data-connect="${attr(t.id)}"`, busy: state.soloWiring === t.id })
    };
  }
  // An instruction beside the button that carries it out is the button said
  // twice, once in a voice that cannot be pressed.
  return {
    top: `<span class="cell-muted">Not found on this device</span>`,
    under: '',
    action: button('Check again', { compact: true, id: 'soloProbe', busy: state.soloProbing })
  };
}

function toolsTab() {
  const rows = toolState().map((t) => {
    const { top, under, action } = toolFacts(t);
    return `<div class="tool-row">
      <span class="tool-name">${esc(t.name)}</span>
      <span class="tool-facts">${top}${under ? `<small>${esc(under)}</small>` : ''}</span>
      <span class="tool-action">${action}</span>
    </div>`;
  }).join('');

  return `<section class="settings-task">
    ${state.soloWireError ? feedback({ tone: 'error', icon: true, title: 'That tool did not change', body: esc(state.soloWireError) }) : ''}
    <div class="tool-rows">${rows || '<div class="tool-row"><span class="cell-muted">No supported tool was found on this device.</span></div>'}</div>
  </section>`;
}

function identityTab() {
  const identity = state.soloIdentity;
  if (!identity) return feedback({ tone: 'attention', title: 'This gateway did not say who you are', body: 'Reload the page, or check that the gateway is still running.' });
  const exempt = roleExempt(identity.role);
  return `<section class="settings-task">
    <dl class="record">
      <dt>Name</dt><dd>${esc(identity.name || identity.id)}</dd>
      <dt>Role</dt><dd>${esc(identity.role)}${exempt ? ' · exempt from company-wide rules' : ''}</dd>
      <dt>Key</dt><dd><span class="mono">${esc(maskKey(identity.apiKey))}</span>${identity.apiKey ? button('Copy key', { compact: true, attrs: `data-copy="${attr(`export WARDEN_API_KEY=${identity.apiKey}`)}"` }) : ''}</dd>
    </dl>
  </section>`;
}

/** A key, with the middle hidden. The prefix says whose, the tail says which. */
const maskKey = (key) => {
  const k = String(key ?? '');
  const cut = k.indexOf('-', 3);
  return cut > 0 && k.length > cut + 12 ? `${k.slice(0, cut + 1)}${'•'.repeat(16)}${k.slice(-6)}` : k || 'not issued yet';
};

/*
 * There is no band here saying a request was just blocked, and that is a
 * decision rather than an omission.
 *
 * There was one: drawn from the verification record, shown for a day, green.
 * The trouble is where it was shown. The person who made that block happen was
 * sitting in Claude Code or Cursor when their prompt came back refused — they
 * already watched it happen, in the window it happened in, with the rule's own
 * sentence attached. This page then told them about it again, hours later, in
 * the one place on the screen that is supposed to say what is true *now*, and
 * it stayed there while they read the five conditions underneath it.
 *
 * What a block leaves behind belongs in the record, not in the headline:
 * Activity has every one of them with its rule and its time, and "last judged"
 * in the conditions block is the live version of the same fact. If proof that
 * setup worked is wanted again, it belongs to first run, which is where that
 * question is actually being asked.
 */

/**
 * The wide column, not the 760px reading one.
 *
 * Every content block in the three This device frames measures 1120 — the
 * condition rows, the tab strip and the tab content alike — which is the
 * --w-table token, and the same width `.sheet` around it already uses. The
 * rule list is where the old width showed: a rule is a row carrying a badge, a
 * sentence, a checkbox and a menu, and at 760 the sentence wrapped while a
 * third of the window sat empty beside it. The reading width is for prose, and
 * this page is a table of facts.
 */
/*
 * No strip in the header here, and on Gateway for the same reason.
 *
 * `conditions()` goes between the title and the tabs, and what it says is true
 * whichever tab is open. A switch that sits above a block it does not switch
 * is claiming to govern it; down here the switch belongs to the content that
 * actually changes under it.
 */
function soloBody() {
  const tab = tabOf();
  const gaps = gapsBySection();
  return `<div class="sheet">
    ${pageHead({ title: 'This device' })}
    <div class="reading-wide device-page">
      ${conditions()}
      ${state.soloProtectError ? feedback({ tone: 'error', icon: true, title: 'This device is not protected yet', body: esc(state.soloProtectError) }) : ''}
      ${state.soloPauseError ? feedback({ tone: 'error', icon: true, title: 'Warden did not change', body: esc(state.soloPauseError) }) : ''}
      ${tabs('soloRules', TABS.map(([sel, label]) => [sel, label, gaps[sel || 'rules']]), tab, 'This device sections')}
      ${tab === 'tools' ? toolsTab() : tab === 'identity' ? identityTab() : rulesSection()}
    </div>
  </div>`;
}

/**
 * Which tab each unmet condition lives behind.
 *
 * The conditions block says a gap exists; until now nothing said which section
 * to open to fix it, so somebody reading "Not judging you yet" had three tabs
 * and no reason to prefer one. Read off the same rows the block is built from,
 * so the dot and the amber row can never disagree.
 */
function gapsBySection() {
  const identity = state.soloIdentity;
  const onRules = state.soloRules.filter((r) => r.applies !== false);
  const exemptRules = state.soloRules.filter((r) => r.applies === false);
  return {
    rules: rulesRow(onRules, exemptRules, identity && roleExempt(identity.role)).tone === 'attention',
    tools: wiringRow(wiredTools(), judgedTools()).tone === 'attention',
    identity: !identity
  };
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

    /*
     * Connect and Unwire, per row.
     *
     * They exist here and have no counterpart on Team, and the asymmetry is
     * the whole argument: on This device the gateway runs on the same computer
     * as the tool, and that computer belongs to whoever is reading the screen.
     * `protect` has always written files into this `$HOME`. On Team the hook
     * lives in an employee's own home directory on a machine the gateway never
     * touches, so the button would be decoration that fails — which teaches
     * people that every control in this console is decoration.
     */
    const wire = e.target.closest('[data-connect], [data-unwire]');
    if (wire) {
      const connect = 'connect' in wire.dataset;
      const tool = connect ? wire.dataset.connect : wire.dataset.unwire;
      state.soloWiring = tool;
      state.soloWireError = '';
      render();
      const r = await post(connect ? '/api/solo/protect' : '/api/solo/unprotect', { tool })
        .catch(() => ({ ok: false, j: null }));
      state.soloWiring = null;
      if (!r.ok) {
        state.soloWireError = r.j?.error
          ?? `Could not ${connect ? 'connect' : 'unwire'} that tool — the gateway did not answer.`;
        render();
        return;
      }
      // The row moves when the machine reports what it wrote, which --fix and
      // --unfix both do before they exit. Re-reading is how this page hears it.
      await refreshSoloRules();
      render();
      return;
    }

    // Re-run the CLI probe. The only thing that can change a "not found" row is
    // somebody having installed the tool since the console last looked.
    if (e.target.closest('#soloProbe')) {
      state.soloProbing = true;
      render();
      await refreshCompiler();
      state.soloProbing = false;
      render();
      return;
    }

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
    // The wiring row moves as soon as this machine reports what it wrote,
    // which the hook does on its next prompt; it no longer waits for traffic
    // before admitting the setup worked.
    await Promise.all([refreshSoloPresets(), refreshSoloRules()]);
    render();
  };

  /**
   * The switch, which is an indefinite pause and not a second mechanism.
   *
   * `until: null` is off until somebody turns it on, and it goes through
   * `setPause`, so it carries a name and a time and every request that goes
   * out meanwhile is recorded as not judged. There is no path here that stops
   * the gateway: the console is served by it, and a button that killed the
   * process would take the page with it.
   */
  const switchWarden = async (off) => {
    state.soloPausing = true;
    state.soloPauseError = '';
    render();
    const r = off
      ? await post('/api/solo/pause', { until: null }).catch(() => ({ ok: false, j: null }))
      : await del('/api/solo/pause').catch(() => ({ ok: false, j: null }));
    state.soloPausing = false;
    if (!r.ok) {
      state.soloPauseError = r.j?.error ?? `Could not turn Warden ${off ? 'off' : 'on'} — the gateway did not answer.`;
      render();
      return;
    }
    await refreshSoloRules();
    render();
  };
  if ($('soloPause')) $('soloPause').onclick = () => void switchWarden(true);
  if ($('soloResume')) $('soloResume').onclick = () => void switchWarden(false);

  // The gap is "nothing is addressed at you"; the fix is the field on the
  // Rules tab, so the headline's button goes there and puts the caret in it.
  const focusRule = $('soloFocusRule');
  if (focusRule) focusRule.onclick = () => {
    if (tabOf() !== '') { go('soloRules'); return; }
    $('soloRuleText')?.focus();
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
    ${pageHead({ title: 'Settings', crumbs: [{ label: 'This machine', go: 'soloRules' }] })}
    <div class="reading settings-page">
      <section class="settings-task">
        <h2 class="section-title">This installation</h2>
        <!-- The header's sentence, moved to the section it is about. Prose
             belongs in the reading column under a heading, not in a header
             where it has to be true of the whole page forever. -->
        <div>${button('Manage the rule writer and the judge', { attrs: 'data-go="models"' })}</div>
      </section>
      <section class="settings-task">
        <h2 class="section-title">Managing a team too?</h2>
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

