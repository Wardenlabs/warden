/**
 * "Gateway": the server itself — which installation this is, what it is
 * running, where it can be reached, and what it keeps.
 *
 * The line between this screen and "This device" does not get crossed. This
 * device answers *is my machine wired up*; Gateway answers *what is this
 * server and is it running honestly*. So there are no models here (they have
 * their own screen), no rules, no people, and nothing about the wiring of
 * whoever happens to be reading.
 *
 * The headline deliberately does not say "running". If you can read this page
 * the gateway is running — it is the thing serving the page. What can surprise
 * somebody is whether it is *judging*, which is a different question with two
 * separate ways of being no (§3.4 of docs/prd/console-f5-f6.md).
 */
import { $, attr, esc, post, state } from './core.js';
import { refreshChain, refreshHealth } from './data.js';
import { modelLabel, plural } from './format.js';
import { render } from './render.js';
import { button, conditionBlock, contextBar, feedback, groupBand, pageHead, statusText, tabs } from './ui.js';
import { VIEWS } from './views.js';

const TABS = [['', 'Overview'], ['access', 'Access'], ['retention', 'Retention']];
const tabOf = () => (state.sel === 'access' || state.sel === 'retention' ? state.sel : '');

const health = () => state.health ?? {};
const installation = () => health().installation ?? {};
const isBaseline = () => health().mode === 'baseline';

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
      label: 'This gateway',
      value: `${esc(name)}${esc(version)}${where.dataDir ? ` · <span class="mono">${esc(where.dataDir)}</span>` : ''}`
    },
    state.mock
      ? { label: 'The judge', tone: 'attention', value: 'Mock adapter · a stand-in answers, no model reads these prompts' }
      : { label: 'The judge', value: `${esc(judgeName())} · on this device, nothing leaves it` },
    isBaseline()
      ? { label: 'Mode', tone: 'attention', value: 'Baseline · the guard is off; requests are recorded and let through' }
      : { label: 'Mode', value: 'Warden · every request is judged against the rules in force' },
    {
      label: 'Hooks',
      value: health().failClosed
        ? `Wait ${deadlineSeconds()} s · then the request is refused`
        : `Wait ${deadlineSeconds()} s · then the prompt goes through unchecked`
    },
    {
      label: 'Reach',
      value: state.publicUrl
        ? 'Open to the internet · anyone holding the address reaches it'
        : 'Only from this device · no public address'
    }
  ];
  const judging = !state.mock && !isBaseline();
  return conditionBlock({
    key: 'gw:conditions',
    claim: judging ? 'Judging every request' : 'Not judging anything',
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
  const reach = state.publicUrl ? ' on a public address' : '';
  return `${name}${version}${reach}, judged by ${judgeName()}. Hooks wait ${deadlineSeconds()} s, then ${health().failClosed ? 'refuse' : 'let the prompt through'}.`;
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
    title: `${both ? 'Two things are off' : 'Something is off'}, and a gateway in this state answers every hook exactly like one that is working`,
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
  return `<div class="gw-rows">
    ${groupBand('What this gateway promises every hook')}
    <dl class="record gw-record">
      <dt>Decision deadline</dt>
      <dd>${deadlineSeconds()} s · the gateway states it, so no laptop chooses its own</dd>
      <dt>If it cannot answer</dt>
      <dd>${health().failClosed
        ? 'The request is refused'
        : 'The prompt goes through unchecked'}
        <small class="gw-note">${health().failClosed
          ? 'WARDEN_FAIL_CLOSED=1 is set here. A gateway that stops answering stops everyone working, which is the trade this setting takes.'
          : 'Open by default, so a crashed gateway does not stop everyone working. WARDEN_FAIL_CLOSED=1 refuses instead.'}</small></dd>
      <dt>Devices</dt>
      <dd${devices.tone ? ` class="--${devices.tone}"` : ''}>${esc(devices.text)}</dd>
    </dl>
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

/**
 * The public address, and the only write on this screen.
 *
 * `POST /api/gateway/expose` answers 202 and never 200: the tunnel takes
 * seconds and the gateway restarts on the far side of it, so asking is not
 * having. `expose.asked` is that in-between, and the outcome is learned from
 * `/health` once the gateway is back.
 *
 * The consequence is written beside the button and not inside a disclosure.
 * Somebody deciding whether to put their gateway on the internet is owed the
 * sentence at the moment they decide, not one click later.
 */
const expose = { asked: null, error: '', timer: null };

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
  return `<div class="gw-rows">
    ${groupBand('Where this gateway can be reached')}
    <dl class="record gw-record">
      <dt>You reached it at</dt>
      <dd><span class="mono">${esc(here)}</span>${button('Copy', { compact: true, attrs: `data-copy="${attr(here)}"` })}
        <small class="gw-note">Anyone who can reach this address still needs a key. A key is what identifies a person here; an address identifies nobody.</small></dd>
    </dl>
    ${groupBand('Public address')}
    ${publicAddress()}
  </div>`;
}

function publicAddress() {
  if (expose.asked) {
    const opening = expose.asked === 'open';
    return `<div class="gw-block">
      <p class="gw-line">${opening ? 'Opening… · asked the tunnel for an address' : 'Closing… · asked the tunnel to shut'}</p>
      <p class="disclosure-text">${opening
        ? 'The gateway accepted the request and has not come back with an address yet. Asking is not having one: nothing outside this network reaches the gateway until an address appears here.'
        : 'The address stops working once the gateway is back. Anyone who wrote it down will find it gone, which is the point.'}</p>
      ${button(opening ? 'Opening…' : 'Closing…', { kind: 'primary', busy: true })}
      ${expose.error ? feedback({ tone: 'error', icon: true, title: 'The address did not change', body: esc(expose.error) }) : ''}
    </div>`;
  }
  if (state.publicUrl) {
    return `<div class="gw-block">
      <p class="gw-line">${statusText('Open · anyone holding the address reaches this gateway.', 'allow')}</p>
      <p class="mono public-url">${esc(state.publicUrl)}</p>
      <p class="disclosure-text">They still need a key, and an address alone judges nothing. Only the address became public: the prompts, the rules and the log stay on this device. It changes every time the tunnel restarts, so a written-down address stops working.</p>
      <div class="btn-row">${button('Copy address', { attrs: `data-copy="${attr(state.publicUrl)}"` })}${button('Stop exposing', { id: 'stopExpose', disabled: !state.canLeaveDemo })}</div>
      ${expose.error ? feedback({ tone: 'error', icon: true, title: 'The address did not change', body: esc(expose.error) }) : ''}
    </div>`;
  }
  return `<div class="gw-block">
    <p class="gw-line">Closed · nobody outside this network can reach this gateway.</p>
    <p class="disclosure-text">Opening one publishes a Cloudflare address that changes every time the tunnel restarts. Anyone holding it reaches this gateway and still needs a key. Only the address becomes public: the prompts, the rules and the log stay on this device.</p>
    ${state.canLeaveDemo
      ? `${button('Open a public address', { kind: 'primary', id: 'startExpose', disabled: state.mock })}${state.mock ? '<p class="disclosure-text muted">Not while Warden is in demo mode: nothing here is really judged.</p>' : ''}`
      : '<p class="disclosure-text muted">This gateway is not running inside the desktop app, so it cannot open a tunnel for you. Put your own proxy in front of it instead.</p>'}
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
  return `<div class="gw-rows">
    ${groupBand('Prompt text')}
    <dl class="record gw-record">
      <dt>Kept for</dt>
      <dd>${p
        ? `${plural(p.days, 'day')} · ${plural(p.held, 'prompt')} held now, ${p.max} is the ceiling`
        : 'Not kept · only hashes are stored'}</dd>
      <dt>What is kept</dt>
      <dd>${p
        ? 'The masked text, so a blocked request can be read back. Never the original.'
        : 'Nothing readable. WARDEN_PROMPT_RETENTION_DAYS is 0 here.'}
        ${p ? '<small class="gw-note">Mode 0600, never synced, and expiry is checked on every read. WARDEN_PROMPT_RETENTION_DAYS=0 turns it off and deletes the file.</small>' : ''}</dd>
    </dl>
    ${groupBand('The audit log')}
    <dl class="record gw-record">
      <dt>Records</dt>
      <dd>${chain ? `${plural(chain.entries, 'record')} · hash-chained, append-only` : 'Could not be read right now'}</dd>
      <dt>Verified</dt>
      <dd${chain && !chain.ok ? ' class="--attention"' : ''}>${chainLine(chain)}${button('Verify now', { compact: true, id: 'gwVerify' })}</dd>
      <dt>What it stores</dt>
      <dd>Who asked, when, which rules fired, and a hash of the prompt. Never the text.</dd>
    </dl>
    ${dir ? `${groupBand('On disk')}<dl class="record gw-record"><dt>This installation</dt><dd><span class="mono">${esc(dir)}</span></dd></dl>` : ''}
  </div>`;
}

/**
 * The chain in one line, including the two ways it can be wrong that are not
 * the same wrong. A broken hash is alteration; a missing count is removal, and
 * `verifyChain` reports them separately precisely so this sentence can.
 */
function chainLine(chain) {
  if (!chain) return 'Not verified in this session';
  if (chain.ok) return chain.unwitnessed
    ? 'Intact · every record matches its hash, but there is no witness to prove none were removed'
    : 'Intact · every record matches its hash';
  if (chain.missing) return `${plural(chain.missing, 'record')} the witness counted are no longer in the log`;
  return `A record was altered or removed after it was written (entry ${chain.brokenAt ?? '?'})`;
}

// ── the page ─────────────────────────────────────────────────────────────────

function gatewayBody() {
  const tab = tabOf();
  return `<div class="sheet">
    ${contextBar([{ label: 'Gateway' }])}
    ${pageHead({ title: 'Gateway', sub: 'The server that holds the rules, the people, the keys and the log. One per company.' })}
    <div class="reading gw-page">
      ${conditions()}
      ${alarm()}
      ${tabs('gateway', TABS, tab, 'Gateway sections')}
      ${tab === 'access' ? accessTab() : tab === 'retention' ? retentionTab() : overviewTab()}
    </div>
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
