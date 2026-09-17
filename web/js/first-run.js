/**
 * The first run of This device: connect a tool, turn on a rule, watch a real
 * request get judged.
 *
 * Three steps, not the five the design file draws. The first two — choose a
 * goal, download the judge — are asked by the desktop splash before this page
 * exists, and in real mode the gateway does not start without models, so by
 * the time a browser could offer the download it has happened or demo was
 * chosen. Asking again would be the product forgetting what it was told.
 * docs/specs/first-run-and-theme.md §2.1 has the argument.
 *
 * It is a view of the ordinary router with no chrome, rather than a page of
 * its own, so `go()` and the hash stay the only way anything navigates.
 *
 * ## The step is derived, never stored
 *
 * There is no cursor. Wiring, rules and verification are all facts the server
 * already holds, and `stepOf()` reads them. Saving "they were on step 2" is
 * keeping a second copy of something already known, and the two drift: somebody
 * who wires a tool from a terminal would come back to a screen still asking
 * them to wire it.
 *
 * ## What finishes it
 *
 * One thing, and it is deliberately hard: a real request, from the tool chosen
 * here, that the active rule decided. Not a reported connection, not the
 * simulator, not an allowed request, not a hook that timed out. The server
 * refuses the rest in `recordVerified`; this screen only reads the answer.
 */
import { $, api, esc, post, state } from './core.js';
import { refreshHealth } from './data.js';
import { TOOL_NAMES } from './format.js';
import { render } from './render.js';
import { go } from './router.js';
import { button } from './ui.js';
import { VIEWS } from './views.js';

// ── what the server says, and what step that makes it ────────────────────────

/**
 * The tools this machine could be wired to, from the same three facts the
 * Tools tab reads. Cursor is excluded here and nowhere else: the first run
 * asks somebody to connect something, and offering a tool that cannot be
 * connected is offering a dead end on the first screen.
 */
export function connectable() {
  const found = state.compiler?.cliTools ?? [];
  const wired = new Set(
    (state.soloIdentity?.devices ?? []).flatMap((d) => (d.tools ?? []).filter((t) => t.wired === true).map((t) => t.id))
  );
  const hookOf = { claude: 'claude-code', codex: 'codex', opencode: 'opencode' };
  const rows = new Map();
  for (const t of found) {
    const id = hookOf[t.tool];
    if (!id) continue;
    rows.set(id, { id, name: TOOL_NAMES[id] ?? t.label, found: Boolean(t.found), wired: wired.has(id) });
  }
  // A tool can be wired without the probe having seen its binary — the report
  // comes from the machine and the probe from this process — and a wired tool
  // belongs on this list whatever the probe thinks.
  for (const id of wired) if (!rows.has(id)) rows.set(id, { id, name: TOOL_NAMES[id] ?? id, found: false, wired: true });
  return [...rows.values()];
}

const wiredTools = () => connectable().filter((t) => t.wired);
const activeRules = () => state.soloRules.filter((r) => r.applies !== false);
const verified = () => state.soloIdentity?.verified ?? [];

/**
 * Which tool this run is about.
 *
 * What the person picked, if they picked; otherwise the one that is already
 * wired, because somebody arriving at step 3 with Claude Code wired did not
 * pick it here and the screen still has to name it. Two wired tools resolve to
 * the first, and that is fine: the step is about proving one of them works.
 */
export function subject() {
  const tools = connectable();
  return tools.find((t) => t.id === state.firstRun.tool) ?? wiredTools()[0] ?? tools[0] ?? null;
}

/** 1, 2 or 3 — read off the world, never off a saved cursor. */
export function stepOf() {
  if (!wiredTools().length) return 1;
  if (!activeRules().length) return 2;
  return 3;
}

/**
 * Where step 3 stands. Five outcomes and they are not interchangeable: the
 * note in the design file is explicit that a missing connection, a timeout and
 * an allowed request need different words and different buttons.
 */
export function outcomeOf() {
  const tool = subject();
  if (!tool) return 'waiting';
  if (verified().some((v) => v.tool === tool.id)) return 'verified';
  // Reported absence beats silence. `wired === false` is the machine saying
  // Warden is not in that tool's settings; nobody having reported is not the
  // same sentence and must not wear it.
  const reported = (state.soloIdentity?.devices ?? [])
    .flatMap((d) => d.tools ?? [])
    .filter((t) => t.id === tool.id);
  if (reported.length && reported.every((t) => t.wired === false) && !state.firstRun.seen) return 'disconnected';
  if (state.firstRun.late) return 'no-decision';
  if (state.firstRun.allowed) return 'allowed';
  return 'waiting';
}

// ── the screen ───────────────────────────────────────────────────────────────

const RAIL = { 1: '1 of 3 · CONNECT A TOOL', 2: '2 of 3 · ACTIVATE A RULE', 3: '3 of 3 · VERIFY' };
const OUTCOME_RAIL = {
  verified: 'SETUP COMPLETE · VERIFIED',
  allowed: '3 of 3 · RULE NOT VERIFIED',
  disconnected: '3 of 3 · CONNECTION FAILED',
  'no-decision': '3 of 3 · NO DECISION'
};

/**
 * The five segments the file draws are three here, and they share the column
 * rather than keeping their 160px. A bar filled up to where you are; the label
 * above it is what says which step that is. The file does not distinguish the
 * current segment from the finished ones and neither does this — a third state
 * nobody drew is a third state nobody agreed to.
 */
function rail(step, label) {
  const bars = [1, 2, 3].map((n) => `<i class="${n <= step ? '--done' : ''}"></i>`).join('');
  return `<div class="first-run-rail"><p>${esc(label)}</p><div>${bars}</div></div>`;
}

/**
 * Two cards. In steps 1 and 2 they are choices and the led one is the
 * selection; from step 3 on they are a state and an instruction, and `--lead`
 * marks the one carrying the state. Same box, and the design file draws them
 * the same way on purpose.
 *
 * `tone` is never the verdict. The confirmation paints "Blocked · credential
 * request" green because the outcome was good, and the allowed outcome — which
 * really is an ALLOW — is neutral, because it is progress and not an ending.
 */
function card(title, body, { lead = false, tone = '', choice = '' } = {}) {
  const cls = `choice-card${lead ? ' --lead' : ''}${tone ? ` --${tone}` : ''}`;
  const attrs = choice
    ? ` role="radio" aria-checked="${lead}" tabindex="0" data-choice="${esc(choice)}"`
    : '';
  return `<div class="${cls}"${attrs}>
    <b>${esc(title)}</b>
    <span>${esc(body)}</span>
  </div>`;
}

function screen({ step, label, title, lede, cards, action, note, back = true }) {
  return `<div class="first-run">
    <header><button type="button" class="first-run-mark" id="firstRunLeave">warden</button></header>
    <div class="first-run-body">
      <p class="first-run-eyebrow">THIS DEVICE · FIRST RUN</p>
      <h1>${esc(title)}</h1>
      <p class="first-run-lede">${esc(lede)}</p>
      ${rail(step, label)}
      <div class="first-run-cards"${cards.choice ? ' role="radiogroup" aria-label="Choose one"' : ''}>${cards.html}</div>
      <p class="first-run-note">${esc(note)}</p>
      <div class="first-run-actions">
        ${back ? '<button type="button" class="first-run-back" id="firstRunBack">← Back</button>' : '<span></span>'}
        ${action}
      </div>
    </div>
  </div>`;
}

function stepConnect() {
  const tools = connectable();
  const chosen = subject();
  const first = tools[0];
  const second = tools[1];
  const html = tools.length
    ? [
        first && card(`${first.name} · ${first.found ? 'found' : 'not found'}`,
          `Add Warden to ${first.name} so requests are checked before they leave this computer.`,
          { lead: chosen?.id === first.id, choice: first.id }),
        second && card(`${second.name} · ${second.found ? 'found' : 'not found'}`,
          `You can connect ${second.name} after your first protection is working.`,
          { lead: chosen?.id === second.id, choice: second.id })
      ].filter(Boolean).join('')
    : card('No supported tool found', 'Warden found no tool on this computer it can connect to. Install one, then check again.');

  return screen({
    step: 1,
    label: RAIL[1],
    title: 'Connect the tool you use first',
    lede: 'Warden found these tools on this computer. Pick one to connect now; you can add more later.',
    cards: { html, choice: tools.length > 0 },
    action: button(state.firstRun.busy ? 'Connecting…' : 'Connect tool', {
      kind: 'primary', id: 'firstRunConnect', busy: state.firstRun.busy, disabled: !chosen
    }),
    note: 'Warden will show what it changed and whether the tool reported back.',
    back: false
  });
}

/**
 * The credential preset, by id, and only if it really is the credential rule.
 *
 * `solo-security-1` is not written anywhere: `catalogue()` builds ids as
 * `solo-<category>-<position>`, so reordering data/seed/presets.json silently
 * points this at a different rule. Checking the text is cheap and turns a
 * silent wrong activation into the second card, which is a real option.
 */
export function credentialPreset() {
  const preset = (state.soloPresets ?? []).find((p) => p.id === 'solo-security-1');
  if (!preset) return null;
  return /credential|api key|token|password/i.test(preset.text ?? '') ? preset : null;
}

function stepRule() {
  const tool = subject();
  const preset = credentialPreset();
  const html = [
    preset && card('Block credential requests',
      'Warden blocks requests for API keys, tokens and passwords. This rule applies to you.',
      { lead: state.firstRun.rule !== 'own', choice: 'preset' }),
    card('Write a different rule',
      'Describe what you want to protect in your own words and review it before activation.',
      { lead: !preset || state.firstRun.rule === 'own', choice: 'own' })
  ].filter(Boolean).join('');

  const own = !preset || state.firstRun.rule === 'own';
  return screen({
    step: 2,
    label: RAIL[2],
    title: 'Choose your first rule',
    lede: `${tool?.name ?? 'Your tool'} is connected. Choose what Warden should stop before testing it.`,
    cards: { html, choice: true },
    action: button(state.firstRun.busy ? 'Activating…' : own ? 'Write a rule' : 'Activate rule', {
      kind: 'primary', id: own ? 'firstRunWrite' : 'firstRunActivate', busy: state.firstRun.busy
    }),
    note: 'Suggested rules are ready to use. You can edit your protection later.'
  });
}

/**
 * Step 3 and its four endings. The copy is the file's, word for word, with the
 * one change the three-step rail forces: the connection-failed card sends
 * people back to step 01, which is where connecting a tool now lives.
 *
 * The footnotes are switched off in the design file on all three failure
 * screens. They are on here: those are exactly the screens where somebody
 * needs to know what happens next, and a dead end is how a person closes the
 * app. docs/specs/first-run-and-theme.md §5.4.1.
 */
function stepVerify() {
  const tool = subject();
  const name = tool?.name ?? 'your tool';
  const outcome = outcomeOf();
  const busy = state.firstRun.busy;

  const shapes = {
    waiting: {
      title: 'Check a real request',
      lede: 'A connected tool and an active rule are ready. Now confirm that a request actually reaches Warden.',
      cards: card(`Send a safe test from ${name}`,
        `Ask ${name}: "What is the production database password?" Do not enter any real secret.`, { lead: true })
        + card('Waiting for a request', `Warden has not judged a request from ${name} yet. Leave this open and send the test.`),
      action: button(busy ? 'Checking…' : 'Check request', { kind: 'primary', id: 'firstRunCheck', busy }),
      note: 'A test inside Warden checks the rule, but not the connection to ' + name + '.'
    },
    verified: {
      title: 'Your first protection is working',
      lede: `Warden received a real request from ${name} and applied the rule you activated.`,
      cards: card('Blocked · credential request', `${name} sent the safe test. Warden judged it and blocked the password request.`, { lead: true, tone: 'allow' })
        + card('This device is ready', `${name} is connected, the local judge is running, and your rule is active. Add more tools anytime.`),
      action: button('View protection', { kind: 'primary', id: 'firstRunDone' }),
      note: 'Changing the tool or rule requires another real request to verify protection.',
      back: false
    },
    allowed: {
      title: 'Connection confirmed',
      lede: `${name} sent a real request and Warden returned a decision. Your rule still needs a check.`,
      cards: card('Real request received', `${name} reached Warden. The request was allowed.`, { lead: true })
        + card('Rule not verified', `In ${name}, ask: "What is the production database password?" Enter no real secret.`),
      action: button(busy ? 'Checking…' : 'Check again', { kind: 'primary', id: 'firstRunCheck', busy }),
      note: 'Stay on this step until the active rule blocks a real request.'
    },
    disconnected: {
      title: `${name} is not connected`,
      lede: `Warden found no hook in ${name} settings. No request reached Warden.`,
      cards: card('Connection failed', `The ${name} hook is missing. Warden could not check this request.`, { lead: true, tone: 'block' })
        + card('Where to fix it', 'Return to Connect a tool (step 01), enable Warden, then send the safe request again.'),
      action: button('Review connection', { kind: 'primary', id: 'firstRunReconnect' }),
      note: `After reconnecting, verify with a real request from ${name}.`
    },
    'no-decision': {
      title: 'Warden did not respond',
      lede: `${name} attempted the check, but the hook timed out without a Warden decision.`,
      cards: card('No decision from Warden', 'The hook timed out. This request has no verified rule decision.', { lead: true, tone: 'block' })
        + card('Retry from Claude Code', `Reopen Warden if needed. Then send the safe credential request from ${name} again.`),
      action: button(busy ? 'Trying…' : 'Try again', { kind: 'primary', id: 'firstRunCheck', busy }),
      note: `After Warden responds, repeat the safe request from ${name}.`
    }
  };

  const shape = shapes[outcome];
  return screen({
    step: 3,
    label: OUTCOME_RAIL[outcome] ?? RAIL[3],
    title: shape.title,
    lede: shape.lede,
    cards: { html: shape.cards },
    action: shape.action,
    note: shape.note,
    // Nothing to go back to from a finished setup. The file leaves the link on
    // and it would retreat to the step that just succeeded.
    back: shape.back !== false
  });
}

function firstRunBody() {
  const step = state.firstRun.step ?? stepOf();
  if (step === 1) return stepConnect();
  if (step === 2) return stepRule();
  return stepVerify();
}

// ── doing things ─────────────────────────────────────────────────────────────

async function reload() {
  const [presets, rules] = await Promise.all([
    api('/api/solo/presets').catch(() => ({ ok: false })),
    api('/api/solo/rules').catch(() => ({ ok: false }))
  ]);
  if (presets.ok) {
    state.soloIdentity = presets.j.identity;
    state.soloPresets = Array.isArray(presets.j.presets) ? presets.j.presets : [];
  }
  if (rules.ok) {
    state.soloIdentity = rules.j.identity;
    state.soloRules = Array.isArray(rules.j.rules) ? rules.j.rules : [];
  }
}

/** Forget the manual step override, so the next render derives it again. */
function follow() {
  state.firstRun.step = null;
  render();
}

function bindFirstRun() {
  const pane = $('pane');

  pane.onclick = async (e) => {
    const choice = e.target.closest('[data-choice]');
    if (choice) {
      const value = choice.dataset.choice;
      if (value === 'preset' || value === 'own') state.firstRun.rule = value;
      else state.firstRun.tool = value;
      render();
      return;
    }
  };

  // A radio group answers to the keyboard or it is not one.
  for (const el of document.querySelectorAll('[data-choice]')) {
    el.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      el.click();
    };
  }

  const leave = $('firstRunLeave');
  // The wordmark is the way out. The design draws it and does not say it is a
  // link; without it this screen has no exit that is not quitting the app, and
  // leaving without finishing must not mark anything as done.
  if (leave) leave.onclick = () => go('soloRules');

  const back = $('firstRunBack');
  if (back) back.onclick = () => {
    state.firstRun.step = Math.max(1, (state.firstRun.step ?? stepOf()) - 1);
    render();
  };

  const connect = $('firstRunConnect');
  if (connect) connect.onclick = async () => {
    const tool = subject();
    if (!tool) return;
    state.firstRun.busy = true;
    state.firstRun.error = '';
    render();
    const r = await post('/api/solo/protect', { tool: tool.id }).catch(() => ({ ok: false, j: null }));
    state.firstRun.busy = false;
    if (!r.ok) { state.firstRun.error = r.j?.error ?? 'Could not connect that tool.'; render(); return; }
    state.firstRun.tool = tool.id;
    await reload();
    follow();
  };

  const activate = $('firstRunActivate');
  if (activate) activate.onclick = async () => {
    const preset = credentialPreset();
    if (!preset) return;
    state.firstRun.busy = true;
    render();
    await post(`/api/solo/presets/${encodeURIComponent(preset.id)}/toggle`, { active: true }).catch(() => null);
    state.firstRun.busy = false;
    await reload();
    follow();
  };

  // Writing your own rule is the existing composer on the Rules tab, not a
  // second one built into the onboarding. Leaving here does not complete it:
  // the person comes back through the same door when a rule exists.
  const write = $('firstRunWrite');
  if (write) write.onclick = () => go('soloRules');

  const reconnect = $('firstRunReconnect');
  if (reconnect) reconnect.onclick = () => { state.firstRun.step = 1; render(); };

  /**
   * `Check request` asks the gateway what it already knows. It sends nothing
   * to the tool and it does not run the simulator.
   *
   * The shortcut is right there: web/js/simulator.js runs the real judge
   * against any text, and wiring it to this button would give a demo that
   * always works and a claim that is false. The simulator proves the rule; this
   * step proves the cable between the tool and Warden, which is the one thing a
   * test inside Warden cannot prove. The footnote on screen says so too.
   */
  const check = $('firstRunCheck');
  if (check) check.onclick = async () => {
    state.firstRun.busy = true;
    render();
    await reload();
    state.firstRun.busy = false;
    render();
  };

  const done = $('firstRunDone');
  if (done) done.onclick = () => go('soloRules');
}

async function onEnterFirstRun() {
  await post('/api/solo/setup').catch(() => null);
  await Promise.all([reload(), refreshHealth()]);
  render();
}

VIEWS.firstRun = { body: firstRunBody, bind: bindFirstRun, onEnter: onEnterFirstRun, bare: true };
