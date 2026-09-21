/**
 * The first run of Team: name the company, make Warden reachable, add one
 * person, and wait for their machine to say it is wired.
 *
 * docs/prd/teams-onboarding.md has the argument; two parts of it shape this
 * file.
 *
 * ## What it has to teach
 *
 * There is one Warden. A teammate installs a hook and nothing else, and from
 * then on every prompt they write travels to this gateway to be judged. So
 * "reachable" is not an installation step, it is a standing condition — and it
 * is why step 2 exists here and has no counterpart on This device, and why the
 * run walks back to it by itself if the address goes away while somebody is
 * waiting on step 4.
 *
 * ## The step is derived, never stored
 *
 * The same rule as first-run.js, for the same reason. The company's name, how
 * the gateway is reached, and who is in the directory are facts the server
 * holds; a saved "they were on step 3" would be a second copy, and somebody who
 * named their company from Team → Company would come back to a screen still
 * asking for it.
 *
 * ## What finishes it
 *
 * One of this person's machines reporting that the hook is in a tool. Not a
 * copied message, which proves nothing, and not a judged request, which is
 * This device's bar: there the person verifying is sitting at the screen, and
 * here it is somebody else, on another machine, possibly tomorrow. So this
 * step can be left, moves on its own when the report arrives, and promises
 * "connected" — never "protected".
 */
import { $, api, esc, post, state } from './core.js';
import { refreshHealth, refreshPeople, refreshPolicy } from './data.js';
import { copyText } from './format.js';
import { askReach, reachable, stopWatchingReach, teamAddress, watchReach } from './reach.js';
import { render } from './render.js';
import { go } from './router.js';
import { card, cards, screen } from './run-shell.js';
import { firstName, isExemptRole, orderedRoles, wiring } from './team.js';
import { button, feedback, roleTone } from './ui.js';
import { VIEWS } from './views.js';

// ── what the server says, and what step that makes it ────────────────────────

/**
 * Team is other people. The solo identity is the administrator's own machine,
 * which is This device's business and must not count as "somebody is set up".
 */
export const team = () => state.company.employees.filter((e) => e.role !== 'solo');

/** The person this run is about: the first one, and with two the run is over. */
export const subject = () => team()[0] ?? null;

const named = () => Boolean(state.company.name) && !state.company.demo;
const activeRules = () => state.policy.rules.length;

/** 1 to 4 — read off the world, never off a saved cursor. */
export function stepOf() {
  if (!named()) return 1;
  if (!reachable()) return 2;
  if (!team().length) return 3;
  return 4;
}

/**
 * Where step 4 stands, which is `wiring()` and nothing added: what this
 * person's machines said about themselves. Five answers, and the four that are
 * not "wired" need different words, because what the administrator does next
 * is different for each.
 */
export function outcomeOf() {
  const person = subject();
  return person ? wiring(person).kind : 'never';
}

/**
 * Whether entering Team should land here instead.
 *
 * Not in demo: with no judge there is nothing a run could promise, and public
 * access is off there anyway. Not after somebody left by the wordmark, this
 * session. Not with two people or more — that install is past its first use,
 * and People has a counter for who never set up. The sample company has seven,
 * so it needs no case of its own.
 *
 * And "done" is not stored either. It is somebody being wired; if the only
 * person there is takes the hook out, this comes back, and it should.
 */
export function teamSetupIsDue() {
  if (state.mock) return false;
  if (state.teamSetup.left) return false;
  if (team().length > 1) return false;
  return !team().some((e) => wiring(e).kind === 'wired');
}

// ── the screen ───────────────────────────────────────────────────────────────

const RAIL = {
  1: '1 of 4 · NAME YOUR COMPANY',
  2: '2 of 4 · MAKE WARDEN REACHABLE',
  3: '3 of 4 · ADD A PERSON',
  4: '4 of 4 · CONNECT THEM'
};
const OUTCOME_RAIL = {
  silent: '4 of 4 · SEEN, NOT WIRED',
  unwired: '4 of 4 · NOT WIRED',
  pending: '4 of 4 · NEW KEY',
  wired: 'SETUP COMPLETE · CONNECTED'
};

function page(shape) {
  const error = state.teamSetup.error
    ? feedback({ tone: 'error', title: 'That did not work', body: esc(state.teamSetup.error) })
    : '';
  return screen({
    kicker: 'TEAM · FIRST RUN', steps: 4, error,
    ids: { leave: 'teamSetupLeave', back: 'teamSetupBack' },
    ...shape
  });
}

function stepName() {
  const value = state.teamSetup.company;
  return page({
    step: 1, label: RAIL[1], title: 'Name your company',
    content: `<div class="field first-run-field">
      <label for="teamSetupCompany">Company name</label>
      <input type="text" id="teamSetupCompany" autocomplete="organization" value="${esc(value)}">
    </div>`,
    action: button(state.teamSetup.busy ? 'Saving…' : 'Continue', {
      kind: 'primary', id: 'teamSetupName', busy: state.teamSetup.busy, disabled: !value.trim()
    }),
    note: 'You can change it later in Team → Company.',
    back: false
  });
}

/**
 * The one step that can fail before anybody else is involved.
 *
 * The note under it is the sentence the rest of the console never says. A
 * gateway that does not answer blocks nobody: the hook gives up and lets the
 * prompt through. The gateway here is somebody's laptop, so that is not an edge
 * case, it is every evening.
 */
const REACH_NOTE = 'Warden runs on this computer. While it is off or asleep, your team’s requests are not checked.';

function stepReach() {
  const reach = state.reach;
  const lanHost = reach?.lanUrl ? reach.lanUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '') : '';
  const lanTitle = lanHost ? `Same network · ${lanHost}` : 'Same network';
  const lanBody = 'Teammates on this network connect to this computer. Nothing leaves the office.';
  const publicBody = 'Opens a public HTTPS address through Cloudflare. It changes every time Warden restarts, and everyone needs a new setup message when it does.';

  // No desktop shell: there is nobody to ask, so there is nothing to choose.
  // The two cards stay, as what the options are, and the screen says where the
  // switch actually lives rather than offering a button that would answer 409.
  if (reach && !reach.canChange) {
    return page({
      step: 2, label: RAIL[2], title: 'Choose how your team reaches Warden',
      content: cards(card(lanTitle, lanBody) + card('Anywhere · public address', publicBody))
        + feedback({ title: 'This gateway is managed outside the desktop app', body: 'Set <span class="mono">WARDEN_HOST=0.0.0.0</span> or <span class="mono">WARDEN_PUBLIC_URL</span> and restart it.' }),
      action: button(state.teamSetup.busy ? 'Checking…' : 'Check again', { kind: 'primary', id: 'teamSetupRecheck', busy: state.teamSetup.busy }),
      note: REACH_NOTE
    });
  }

  const choice = state.teamSetup.reach;
  const asked = state.teamSetup.asked;
  // Bound to the network and still no address: the machine has no network. It
  // is the LAN card's problem only, and the other card is still a way out.
  const noNetwork = reach?.listening === 'network' && !reach.lanUrl;
  const lanDead = noNetwork && choice === 'lan';
  return page({
    step: 2, label: RAIL[2], title: 'Choose how your team reaches Warden',
    content: cards(
      card(lanTitle, lanBody, { lead: choice === 'lan', choice: 'lan' })
      + card('Anywhere · public address', publicBody, { lead: choice === 'public', choice: 'public' }),
      true
    ) + (lanDead
      ? feedback({ tone: 'error', title: 'No network found', body: 'Connect this computer to a network, or use a public address.' })
      : ''),
    action: button(asked ? 'Turning on…' : 'Turn on', { kind: 'primary', id: 'teamSetupReach', busy: Boolean(asked), disabled: lanDead }),
    note: asked
      ? 'Warden restarts to listen on the network. This page reconnects by itself, and macOS may ask to allow incoming connections.'
      : REACH_NOTE
  });
}

function stepPerson() {
  const roles = orderedRoles();
  const role = state.teamSetup.role ?? roles[0] ?? '';
  const value = state.teamSetup.person;
  return page({
    step: 3, label: RAIL[3], title: 'Add the first person',
    content: `<div class="field first-run-field">
        <label for="teamSetupPerson">Name</label>
        <input type="text" id="teamSetupPerson" autocomplete="off" value="${esc(value)}">
      </div>
      <div class="field"><span class="field-label">Role</span>
        <div class="role-choices" role="radiogroup" aria-label="Role">${roles.map((r) => `<button type="button" role="radio" aria-checked="${r === role}" class="role-label --${roleTone(r)} role-choice${r === role ? ' --chosen' : ''}" data-setup-role="${esc(r)}">${r === role ? '✓ ' : ''}${esc(r)}</button>`).join('')}</div>
        ${isExemptRole(role) ? `<span class="field-help --attention">${esc(role)} is exempt from company-wide rules: only rules that name the role or the person apply.</span>` : ''}
      </div>`,
    action: button(state.teamSetup.busy ? 'Adding…' : 'Add person', {
      kind: 'primary', id: 'teamSetupAdd', busy: state.teamSetup.busy, disabled: !value.trim()
    }),
    note: 'They get their own connection key. You can add everyone else from Team.'
  });
}

/**
 * Step 4 and its endings. First card the instruction, second the state — the
 * grammar of This device's last step — except on the two outcomes where the
 * state is the news and leads.
 *
 * The address is on this screen and not only inside the message, because it is
 * the one value the administrator has to be able to look at and recognise as
 * wrong.
 */
function stepConnect() {
  const person = subject();
  const first = firstName(person) || 'them';
  const outcome = outcomeOf();
  const w = person ? wiring(person) : { kind: 'never' };
  const tools = (w.tools ?? []).join(', ') || 'their tool';
  const address = teamAddress();
  const busy = state.teamSetup.busy;
  const copy = button('Copy setup message', { kind: 'primary', id: 'teamSetupCopy' });
  const again = button(busy ? 'Checking…' : 'Check again', { kind: 'link', id: 'teamSetupCheck', busy });
  // Where the message goes is said here because the person reading it may never
  // have opened a terminal. The first administrator to try this run asked
  // whether the text was meant for an agent or for this console, and the card
  // said "send" without saying to whom, how, or what happens at the other end.
  const message = `Copy it and send it to ${first} privately — a direct message or an email. It is one command, pasted into the Terminal on their own computer. It carries ${first}’s key and this address: ${address}. Treat it like a password.`;

  const shapes = {
    never: {
      title: `Send ${first} their setup`,
      content: card('Send the setup message', message, { lead: true })
        + card(`Waiting for ${first}’s device`, 'Nothing has reported yet. You can leave — this updates when it does.'),
      note: `This step finishes when ${first}’s device reports back. It can take a day — nothing here needs you to wait.`
    },
    silent: {
      title: `${first}’s device reached Warden`,
      content: card('Connected, not wired', `A request arrived with ${first}’s key, but no tool has reported the hook.`, { lead: true })
        + card(`What to ask ${first}`, 'Run warden-hook --fix, then open their tool again.'),
      note: `This step finishes when one of ${first}’s tools reports the hook.`
    },
    // Worded against what the product can do, as the person's own page is:
    // Warden sees the hook go and cannot put it back.
    unwired: {
      title: `The hook is not in ${first}’s tool`,
      content: card(`${tools} is not wired`, `${first}’s device reported that Warden is no longer in ${tools}’s settings. ${first}’s requests are not being checked.`, { lead: true, tone: 'block' })
        + card('What Warden can do', `It can see this; it cannot put the hook back — it is a file on ${first}’s machine. Send the setup again, or talk to ${first}.`),
      note: `This step finishes when ${first}’s device reports the hook again.`
    },
    pending: {
      title: `${first} needs the new setup`,
      content: card(`${first}’s key was replaced`, `The message sent before no longer works, and every request from ${first} is refused until a device checks in with the new key.`, { lead: true })
        + card('Send the new setup message', message),
      note: `This step finishes when one of ${first}’s devices uses the new key.`
    }
  };

  if (outcome === 'wired') {
    // "Checked against your rules" with no rules would be technically true and
    // practically a lie: nothing is being stopped. Say that, and point at it.
    const ruled = activeRules() > 0;
    return page({
      step: 4, label: OUTCOME_RAIL.wired, title: `${first} is connected`,
      content: cards(
        card(`Wired · ${tools}`, ruled
          ? `${first}’s device reported the hook. ${first}’s requests are checked against your rules from now on.`
          : `${first}’s device reported the hook. Warden sees ${first}’s requests from now on.`, { lead: true, tone: 'allow' })
        + (ruled
          ? card('Add the rest of your team', 'Everyone gets their own key and their own setup message.')
          : card('Nothing is being stopped yet', `You have no active rules, so every request is allowed. Write one and it applies to ${first} at once.`))
      ),
      action: ruled
        ? button('View team', { kind: 'primary', id: 'teamSetupDone' })
        : button('Write a rule', { kind: 'primary', id: 'teamSetupRule' }),
      note: `If ${first}’s device stops reporting, Team says so on ${first}’s row.`,
      // Nothing to go back to from a finished setup.
      back: false
    });
  }

  const shape = shapes[outcome] ?? shapes.never;
  return page({
    step: 4, label: OUTCOME_RAIL[outcome] ?? RAIL[4], title: shape.title,
    content: cards(shape.content), action: copy, secondary: again, note: shape.note
  });
}

function teamSetupBody() {
  const step = state.teamSetup.step ?? stepOf();
  if (step === 1) return stepName();
  if (step === 2) return stepReach();
  if (step === 3) return stepPerson();
  return stepConnect();
}

// ── doing things ─────────────────────────────────────────────────────────────

/** Forget the manual step override, so the next render derives it again. */
function follow() {
  state.teamSetup.step = null;
  state.teamSetup.busy = false;
  render();
}

function fail(message) {
  state.teamSetup.busy = false;
  state.teamSetup.error = message;
  render();
}

function bindTeamSetup() {
  const pane = $('pane');
  pane.onclick = (e) => {
    const choice = e.target.closest('[data-choice]');
    if (choice && !state.teamSetup.asked) {
      state.teamSetup.reach = choice.dataset.choice;
      state.teamSetup.error = '';
      render();
      return;
    }
    const role = e.target.closest('[data-setup-role]');
    if (role) { state.teamSetup.role = role.dataset.setupRole; render(); }
  };
  // A radio group answers to the keyboard or it is not one.
  for (const el of document.querySelectorAll('[data-choice]')) {
    el.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      el.click();
    };
  }

  // The wordmark is the way out, and leaving finishes nothing. The flag is
  // what stops People from sending them straight back here.
  const leave = $('teamSetupLeave');
  if (leave) leave.onclick = () => { state.teamSetup.left = true; stopWatchingReach(); go('people'); };

  const back = $('teamSetupBack');
  if (back) back.onclick = () => {
    state.teamSetup.step = Math.max(1, (state.teamSetup.step ?? stepOf()) - 1);
    state.teamSetup.error = '';
    render();
  };

  // Typing does not redraw: the value goes to state so a redraw for any other
  // reason keeps it, and the button is switched in place.
  const typed = (id, key, buttonId) => {
    const input = $(id);
    if (!input) return;
    input.oninput = () => {
      state.teamSetup[key] = input.value;
      const ok = $(buttonId);
      if (ok) ok.disabled = !input.value.trim();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') $(buttonId)?.click(); };
  };
  typed('teamSetupCompany', 'company', 'teamSetupName');
  typed('teamSetupPerson', 'person', 'teamSetupAdd');

  const name = $('teamSetupName');
  if (name) name.onclick = async () => {
    const value = state.teamSetup.company.trim();
    if (!value) return;
    state.teamSetup.busy = true; state.teamSetup.error = ''; render();
    const { ok, j } = await post('/api/company', { name: value }, { method: 'PUT' }).catch(() => ({ ok: false, j: null }));
    if (!ok) return fail(j?.error ?? 'Warden could not be reached.');
    await refreshPeople();
    follow();
  };

  const turnOn = $('teamSetupReach');
  if (turnOn) turnOn.onclick = async () => {
    const kind = state.teamSetup.reach;
    state.teamSetup.error = '';
    const asked = await askReach(kind, true);
    if (!asked.ok) return fail(asked.error);
    state.teamSetup.asked = kind;
    render();
    watchReach(
      () => (kind === 'public' ? Boolean(state.reach?.publicUrl) : Boolean(state.reach?.lanUrl) || (state.reach?.listening === 'network')),
      (done) => {
        state.teamSetup.asked = null;
        if (!done) {
          state.teamSetup.error = kind === 'public'
            ? 'The public address did not open. Warden needs cloudflared installed on this computer.'
            : 'Warden did not come back listening on the network. Try again.';
        }
        if (state.view === 'teamSetup') follow();
      }
    );
  };

  const recheck = $('teamSetupRecheck');
  if (recheck) recheck.onclick = async () => {
    state.teamSetup.busy = true; render();
    await refreshHealth();
    follow();
  };

  const add = $('teamSetupAdd');
  if (add) add.onclick = async () => {
    const value = state.teamSetup.person.trim();
    if (!value) return;
    const role = state.teamSetup.role ?? orderedRoles()[0];
    state.teamSetup.busy = true; state.teamSetup.error = ''; render();
    const { ok, j } = await post('/api/people', { name: value, role }).catch(() => ({ ok: false, j: null }));
    if (!ok) return fail(j?.error ?? 'Warden could not be reached.');
    await refreshPeople();
    follow();
  };

  const copy = $('teamSetupCopy');
  if (copy) copy.onclick = async () => {
    const person = subject();
    if (!person) return;
    state.teamSetup.error = '';
    const { ok, status, j } = await api(`/api/people/${encodeURIComponent(person.id)}/onboarding`).catch(() => ({ ok: false, j: null }));
    if (ok) { await copyText(j.message, copy); return; }
    // The gateway stopped being reachable under us. That is step 2 no longer
    // being true, not an error of this one: read it again and let the step say so.
    if (status === 409 && j?.reach) { await refreshHealth(); follow(); return; }
    fail(j?.error ?? 'The setup message could not be built.');
  };

  /**
   * `Check again` sends nothing anywhere. It reads what the gateway already
   * knows, for the report that arrived while the stream was down. The stream is
   * what normally moves this step — data.js redraws this view on a `device`
   * event — and this is the fallback for an event that never came.
   */
  const check = $('teamSetupCheck');
  if (check) check.onclick = async () => {
    state.teamSetup.busy = true; render();
    await Promise.all([refreshPeople(), refreshHealth()]);
    follow();
  };

  const done = $('teamSetupDone');
  if (done) done.onclick = () => go('people');
  const rule = $('teamSetupRule');
  if (rule) rule.onclick = () => go('policy', 'new');
}

async function onEnterTeamSetup() {
  state.teamSetup.company ||= state.company.demo ? '' : state.company.name ?? '';
  await Promise.all([refreshHealth(), refreshPeople(), refreshPolicy()]);
  render();
}

VIEWS.teamSetup = {
  body: teamSetupBody, bind: bindTeamSetup, onEnter: onEnterTeamSetup,
  onLeave: stopWatchingReach, bare: true
};

/**
 * The door. People is where somebody goes to set their team up, so that is
 * where this is decided — on the list and nowhere else: Roles, Company and a
 * person's page are links somebody followed on purpose. Registered from here
 * rather than in team.js so that file does not import this one back.
 */
VIEWS.people.onEnter = () => {
  if (!state.sel && teamSetupIsDue()) go('teamSetup');
};
