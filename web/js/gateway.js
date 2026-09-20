
import { $, attr, esc, post, state } from './core.js';
import { refreshChain, refreshHealth } from './data.js';
import { askReach, watchReach } from './reach.js';
import { modelLabel, plural } from './format.js';
import { render } from './render.js';
import { button, conditionBlock, feedback, pageHead, tabs } from './ui.js';
import { VIEWS } from './views.js';

const TABS = [['', 'Overview'], ['access', 'Access'], ['retention', 'Data']];
const tabOf = () => (state.sel === 'access' || state.sel === 'retention' ? state.sel : '');

const health = () => state.health ?? {};
const installation = () => health().installation ?? {};
const isBaseline = () => health().mode === 'baseline';

/**
 * Bound to loopback with no public address: nobody but this machine gets in.
 *
 * "Private network only" was the screen's word for every gateway without a
 * tunnel, and on the desktop app's default bind it was false — the network
 * could not reach it either. `reach` is absent from a gateway older than the
 * field, and absent has to keep the old wording: not known is not loopback.
 */
const loopbackOnly = () => !state.publicUrl && state.reach?.listening === 'loopback';

/** The deadline this gateway hands every hook, in the words a person uses. */
function deadlineSeconds() {
  const ms = Number(health().deadlines?.decisionMs);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 90;
}

/**
 * What is actually loaded, not what was chosen. `inForce` is the weights the
 * process has open; an env override outranks the setting and a bench run
 * leaves one set, so naming the setting here would be naming a preference and
 * calling it a fact.
 */
function judgeName() {
  const a = state.adjudicator;
  const id = a?.inForce ?? a?.model ?? null;
  if (!id) return 'the local adjudicator';
  return a.choices?.find((c) => c.id === id)?.label ?? modelLabel(id);
}

// ── the conditions ───────────────────────────────────────────────────────────

/**
 * Five rows, and two of them can be a gap.
 *
 * `mock` and `baseline` are different failures that look identical from
 * outside: with the mock adapter nothing reads the prompt, and in baseline
 * mode nothing enforces what was read. A gateway in either state answers every
 * hook exactly like one that is working, which is why both get their own row
 * and why either one turns the headline.
 */
function conditions() {
  const where = installation();
  const name = where.label ? `“${where.label}”` : 'this installation';
  const version = where.version ? ` v${where.version}` : '';
  const rows = [
    {
      label: 'Gateway',
      value: `${esc(name)}${esc(version)}`
    },
    state.mock
      ? { label: 'Judge', tone: 'attention', value: 'No request judge is loaded' }
      : { label: 'Judge', value: `${esc(judgeName())} · on this device` },
    isBaseline()
      ? { label: 'Mode', tone: 'attention', value: 'Baseline · active rules are not applied' }
      : { label: 'Mode', value: 'Active rules apply to every request' },
    {
      label: 'Timeout',
      value: health().failClosed
        ? `Refuse after ${deadlineSeconds()} s`
        : `Allow unchecked after ${deadlineSeconds()} s`
    },
    {
      label: 'Access',
      value: state.publicUrl
        ? 'Public address on'
        : loopbackOnly() ? 'This computer only' : 'Private network only'
    }
  ];
  const judging = !state.mock && !isBaseline();
  return conditionBlock({
    key: 'gw:conditions',
    claim: judging ? 'Policy checks on' : 'Policy checks off',
    tone: judging ? 'allow' : 'attention',
    summary: judging ? esc(summaryLine()) : '',
    rows,
    action: judging ? '' : button('Get a judge', { kind: 'primary', attrs: 'data-go="models"' }),
    open: state.open.has('gw:conditions')
  });
}

function summaryLine() {
  const where = installation();
  const name = where.label ? `“${where.label}”` : 'This gateway';
  const version = where.version ? ` v${where.version}` : '';
  const reach = state.publicUrl ? 'public access' : loopbackOnly() ? 'this computer only' : 'private network';
  return `${name}${version} · ${judgeName()} · ${deadlineSeconds()} s timeout · ${reach}`;
}

/**
 * The one banner on this screen, and only for the state that has to shout.
 *
 * Two things can be off and each has its own sentence, because the fixes are
 * not the same: a missing model is something this console can go and get, and
 * baseline is an environment variable on the machine that started the gateway.
 * Offering a button for the second one would be offering something that does
 * not exist.
 */
function alarm() {
  if (!state.mock && !isBaseline()) return '';
  const both = state.mock && isBaseline();
  const body = [
    state.mock ? 'The mock adapter stands in for a model nobody downloaded.' : '',
    isBaseline() ? 'Baseline is WARDEN_MODE, set on the machine that started the gateway.' : ''
  ].filter(Boolean).join(' ');
  return feedback({
    tone: 'attention',
    icon: true,
    title: both ? 'Policy checks are off for two reasons' : 'Policy checks are off',
    body: esc(body)
  });
}

// ── Overview ─────────────────────────────────────────────────────────────────

/**
 * What this gateway promises every hook, which was on no screen at all.
 *
 * The deadline and the fail policy are the pair that decides whether a prompt
 * reaches a model unchecked, and both are properties of the gateway rather
 * than of anybody's laptop — that is the whole reason `/health` states them
 * (`src/server/routes/system.ts`). Fail-open is in ordinary ink and not in
 * amber: it is a documented trade, not a misconfiguration, and painting it as
 * a fault would teach people to ignore the colour.
 */
function overviewTab() {
  const devices = deviceSummary();
  return `<div class="gw-overview">
    ${conditions()}
    ${alarm()}
    <section class="gw-facts" aria-label="Request handling">
      <div class="gw-fact"><span>Decision timeout</span><b>${deadlineSeconds()} seconds</b></div>
      <div class="gw-fact"><span>After timeout</span><b>${health().failClosed ? 'Refuse' : 'Allow unchecked'}</b></div>
      <div class="gw-fact"><span>Devices</span><b${devices.tone ? ` class="--${devices.tone}"` : ''}>${esc(devices.text)}</b></div>
    </section>
  </div>`;
}

/**
 * One line, on purpose. Which person is wired and which is not is a question
 * about people and it belongs on Team; what belongs here is whether the fleet
 * is keeping the contract above.
 */
function deviceSummary() {
  const people = state.company.employees ?? [];
  const all = people.flatMap((p) => p.devices ?? []);
  if (!all.length) return { text: 'No device has reported in yet' };
  const mine = installation().version;
  const stale = mine ? all.filter((d) => d.hookVersion && d.hookVersion !== mine) : [];
  const text = `${plural(all.length, 'device')} reporting in`;
  return stale.length
    ? { text: `${text} · ${plural(stale.length, 'device')} on a hook older than this gateway`, tone: 'attention' }
    : { text: `${text} · all on the current hook` };
}

// ── Access ───────────────────────────────────────────────────────────────────

const expose = { asked: null, error: '', timer: null };
const lan = { asked: null, error: '' };

async function watchAddress(want) {
  clearTimeout(expose.timer);
  const started = Date.now();
  const tick = async () => {
    await refreshHealth();
    const done = want ? Boolean(state.publicUrl) : !state.publicUrl;
    if (done || Date.now() - started > 120000) {
      expose.asked = null;
      if (!done) expose.error = want ? 'The tunnel did not open within two minutes. Try again.' : 'The tunnel did not close within two minutes. Try again.';
      if (state.view === 'gateway') render();
      return;
    }
    expose.timer = setTimeout(tick, 3000);
  };
  expose.timer = setTimeout(tick, 3000);
}

/**
 * The address this console was reached at, rather than a guessed one.
 *
 * `location.origin` is the honest answer to "where is this gateway": if the
 * administrator opened it over the office network, that is the address their
 * team would need, and printing `localhost` underneath it would be printing
 * the one address that only works for the person already looking at it.
 */
function accessTab() {
  const here = typeof location === 'undefined' ? '' : location.origin;
  return `<div class="gw-sections">
    ${alarm()}
    <section class="gw-section">
      <h2>Gateway address</h2>
      <div class="gw-address"><span class="mono">${esc(here)}</span>${button('Copy', { compact: true, attrs: `data-copy="${attr(here)}"` })}</div>
    </section>
    <section class="gw-section">
      <h2>Network access</h2>
      ${networkAccess()}
    </section>
    <section class="gw-section">
      <h2>Public access</h2>
      ${publicAddress()}
    </section>
  </div>`;
}

/**
 * Whether this network can get in, and the switch for it.
 *
 * It was a checkbox in the desktop menu and nowhere else. The first run of Team
 * turns it on, but that is a screen somebody sees once; this is where it lives
 * afterwards, and where a person's page sends an administrator whose setup
 * message was refused.
 *
 * Where the switch is depends on what started this gateway: the desktop app can
 * be asked, a checkout has an environment variable, and offering a button that
 * answers 409 would be its own dead end. A gateway older than `reach` says
 * nothing here, because nothing is known.
 */
function networkAccess() {
  const reach = state.reach;
  if (!reach) return '<div class="gw-block"><p class="gw-note">This gateway does not report how it is bound.</p></div>';
  const on = reach.listening === 'network';
  const error = lan.error ? feedback({ tone: 'error', icon: true, title: 'Network access did not change', body: esc(lan.error) }) : '';
  if (lan.asked) {
    return `<div class="gw-block">
      <p class="gw-line">${lan.asked === 'on' ? 'Turning on network access…' : 'Turning off network access…'}</p>
      <p class="gw-note">Warden restarts to change what it listens on. This page reconnects by itself.</p>
      ${button(lan.asked === 'on' ? 'Turning on…' : 'Turning off…', { kind: 'primary', busy: true })}
    </div>`;
  }
  if (on) {
    return `<div class="gw-block">
      <p class="gw-line --allow">On</p>
      ${reach.lanUrl
        ? `<p class="mono public-url">${esc(reach.lanUrl)}</p><p class="gw-note">Teammates on this network connect here. A Warden key is still required.</p>`
        : '<p class="gw-note">Warden is listening, but this computer is not on a network.</p>'}
      <div class="btn-row">${reach.lanUrl ? button('Copy address', { attrs: `data-copy="${attr(reach.lanUrl)}"` }) : ''}${reach.canChange ? button('Turn off', { id: 'stopLan' }) : ''}</div>
      ${error}
    </div>`;
  }
  return `<div class="gw-block">
    <p class="gw-line">Off</p>
    <p class="gw-note">Only this computer can reach Warden, so no setup message can work for anybody else.</p>
    ${reach.canChange
      ? button('Turn on network access', { kind: 'primary', id: 'startLan' })
      : '<p class="gw-note">Start this gateway with <span class="mono">WARDEN_HOST=0.0.0.0</span> to let this network in.</p>'}
    ${error}
  </div>`;
}

function publicAddress() {
  if (expose.asked) {
    const opening = expose.asked === 'open';
    return `<div class="gw-block">
      <p class="gw-line">${opening ? 'Opening public access…' : 'Closing public access…'}</p>
      ${button(opening ? 'Opening…' : 'Closing…', { kind: 'primary', busy: true })}
      ${expose.error ? feedback({ tone: 'error', icon: true, title: 'The address did not change', body: esc(expose.error) }) : ''}
    </div>`;
  }
  if (state.publicUrl) {
    return `<div class="gw-block">
      <p class="gw-line --allow">On</p>
      <p class="mono public-url">${esc(state.publicUrl)}</p>
      <p class="gw-note">A Warden key is still required. The address changes after a restart.</p>
      <div class="btn-row">${button('Copy address', { attrs: `data-copy="${attr(state.publicUrl)}"` })}${button('Stop exposing', { id: 'stopExpose', disabled: !state.canLeaveDemo })}</div>
      ${expose.error ? feedback({ tone: 'error', icon: true, title: 'The address did not change', body: esc(expose.error) }) : ''}
    </div>`;
  }
  return `<div class="gw-block">
    <p class="gw-line">Off</p>
    <p class="gw-note">${loopbackOnly() ? 'Nobody outside this computer can reach Warden.' : 'Only devices on this network can reach Warden.'}</p>
    ${state.canLeaveDemo
      ? `${button('Turn on public access', { kind: 'primary', id: 'startExpose', disabled: state.mock })}${state.mock ? '<p class="gw-note">Unavailable in demo mode.</p>' : ''}`
      : '<p class="gw-note">Public access is managed outside the desktop app for this gateway.</p>'}
    ${expose.error ? feedback({ tone: 'error', icon: true, title: 'The address did not change', body: esc(expose.error) }) : ''}
  </div>`;
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * What this gateway keeps and for how long, said where somebody can act on it.
 *
 * The two stores are deliberately separate sentences. The audit log is the
 * governance record and holds a hash of every prompt and never the text; the
 * prompt store is masked text with a date on it, so an administrator can read
 * what was blocked. Collapsing them into "logs" is how a company ends up
 * unable to say what it keeps.
 */
function retentionTab() {
  const p = state.prompts;
  const chain = state.chain;
  const dir = installation().dataDir;
  return `<div class="gw-sections">
    ${alarm()}
    <section class="gw-section">
      <h2>Prompt history</h2>
      <dl class="record gw-record">
        <dt>Retention</dt><dd>${p ? plural(p.days, 'day') : 'Off'}</dd>
        <dt>Stored</dt><dd>${p ? `${plural(p.held, 'masked prompt')} · ${p.max} maximum` : 'None · only hashes are kept'}
          ${p ? '<small class="gw-note">Original prompt text is never stored.</small>' : ''}</dd>
      </dl>
    </section>
    <section class="gw-section">
      <h2>Decision log</h2>
      <dl class="record gw-record">
        <dt>Records</dt><dd>${chain ? `${plural(chain.entries, 'record')} · append-only` : 'Unavailable'}</dd>
        <dt>Integrity</dt><dd${chain && !chain.ok ? ' class="--attention"' : ''}>${chainLine(chain)}${button('Verify now', { compact: true, id: 'gwVerify' })}</dd>
        <dt>Contains</dt><dd>Person, time, matched rules and prompt hash</dd>
      </dl>
    </section>
    ${dir ? `<section class="gw-section"><h2>Storage</h2><p class="mono gw-path">${esc(dir)}</p></section>` : ''}
  </div>`;
}

/**
 * The chain in one line, including the two ways it can be wrong that are not
 * the same wrong. A broken hash is alteration; a missing count is removal, and
 * `verifyChain` reports them separately precisely so this sentence can.
 */
function chainLine(chain) {
  if (!chain) return 'Not checked';
  if (chain.ok) return chain.unwitnessed
    ? 'Verified locally · no external witness'
    : 'Verified';
  if (chain.missing) return `${plural(chain.missing, 'record')} the witness counted are no longer in the log`;
  return `A record was altered or removed after it was written (entry ${chain.brokenAt ?? '?'})`;
}

// ── the page ─────────────────────────────────────────────────────────────────

function gatewayBody() {
  const tab = tabOf();
  const content = tab === 'access' ? accessTab() : tab === 'retention' ? retentionTab() : overviewTab();
  return `<div class="sheet gateway-page">
    ${pageHead({ title: 'Gateway', strip: tabs('gateway', TABS, tab, 'Gateway sections') })}
    <div class="gateway-content">${content}</div>
  </div>`;
}

function bindGateway() {
  const askExpose = async (enabled) => {
    expose.error = '';
    const { ok, j } = await post('/api/gateway/expose', { enabled }).catch(() => ({ ok: false, j: null }));
    if (!ok) { expose.error = j?.error ?? 'Warden could not be reached.'; render(); return; }
    expose.asked = enabled ? 'open' : 'close';
    render();
    void watchAddress(enabled);
  };
  const askLan = async (enabled) => {
    lan.error = '';
    const asked = await askReach('lan', enabled);
    if (!asked.ok) { lan.error = asked.error; render(); return; }
    lan.asked = enabled ? 'on' : 'off';
    render();
    watchReach(
      () => (state.reach?.listening === 'network') === enabled,
      (done) => {
        lan.asked = null;
        if (!done) lan.error = 'Warden did not come back with the new setting within two minutes. Try again.';
        if (state.view === 'gateway') render();
      }
    );
  };
  if ($('startLan')) $('startLan').onclick = () => void askLan(true);
  if ($('stopLan')) $('stopLan').onclick = () => void askLan(false);
  if ($('startExpose')) $('startExpose').onclick = () => void askExpose(true);
  if ($('stopExpose')) $('stopExpose').onclick = () => void askExpose(false);

  const verify = $('gwVerify');
  if (verify) verify.onclick = async () => { await refreshChain(); render(); };
}

async function onEnterGateway() {
  await Promise.all([refreshHealth(), refreshChain()]);
  render();
}

VIEWS.gateway = {
  body: gatewayBody,
  bind: bindGateway,
  onEnter: onEnterGateway,
  onLeave: () => clearTimeout(expose.timer)
};
