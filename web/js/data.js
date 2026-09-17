/**
 * Fetching what the console shows, and the live stream that tells it to fetch again.
 */
import { $, AUDIT_LIMIT, api, state } from './core.js';
import { render } from './render.js';
import { renderNav } from './nav.js';
import { route } from './router.js';

// ── boot ─────────────────────────────────────────────────────────────────────

export async function boot() {
  const health = await api('/health').catch(() => null);
  takeHealth(health?.j);
  if (!health?.ok) {
    $('pane').innerHTML = '<div class="sheet"><div class="empty"><b>The gateway is not answering</b><span>Start it with <code>pnpm run dev</code> and reload this page.</span></div></div>';
    return;
  }

  // The directory and the model settings decide where an empty hash lands and
  // what the shell says above every page, so they are read before the first
  // render. The lists are read after it, each marking itself loading, so a
  // slow log shows the page that is waiting for it rather than a blank window.
  await Promise.all([refreshPeople(), refreshCompiler(), refreshAdjudicator()]);
  window.addEventListener('hashchange', route);
  route();
  const lists = [refreshPolicy(), refreshAudit(), loadPresets(), refreshChain(), refreshAppeals(), refreshEscalations()];
  for (const list of lists) void list.then(() => render());
  await Promise.allSettled(lists);
  subscribe();
}

/**
 * What `/health` said, spread into the fields the console reads.
 *
 * One place, because the same payload is now read at boot, every time the
 * Gateway screen is opened, and every three seconds while a tunnel is coming
 * up — and three copies of "which of these fields matter" is how one of them
 * drifts. A failed read leaves the previous answer alone rather than blanking
 * the screen: a gateway that did not reply to one poll has not changed what it
 * is running.
 */
function takeHealth(j) {
  if (!j) return;
  state.health = j;
  state.mock = Boolean(j.mock);
  // Whether a desktop shell is listening that could actually fetch the models.
  // False in a browser against a checkout, where the honest offer is a command.
  state.canLeaveDemo = Boolean(j.canLeaveDemo);
  // The address the team reaches this gateway at, when a tunnel is up.
  state.publicUrl = j.publicUrl ?? null;
  // How long prompt text stays readable. Shown on the screen that shows it,
  // because a retention policy nobody can see is one nobody can rely on.
  state.prompts = j.prompts ?? null;
}

/** Ask the gateway again what it is. Used on entering Gateway, and while a
 *  tunnel is opening — `/api/gateway/expose` answers "asked", never "done". */
export async function refreshHealth() {
  const { ok, j } = await api('/health').catch(() => ({ ok: false, j: null }));
  if (ok) takeHealth(j);
  return ok;
}

/**
 * Whether a list is still being read and whether its last read failed, per
 * list. Before this the console could not tell "no rules" from "the policy
 * did not answer" — a failed read left an empty array behind and the page said
 * nothing was being stopped, which is the one sentence a failure must never
 * produce. A failed refresh keeps whatever was read before; the page says the
 * read failed and offers the same request again.
 */
const loading = (key) => { state.loads[key] = { loading: true, error: '' }; };
const loaded = (key, ok, j) => {
  state.loads[key] = { loading: false, error: ok ? '' : String(j?.error ?? 'The gateway did not answer.') };
  return ok;
};
const settle = async (key, path) => {
  loading(key);
  const result = await api(path).catch(() => ({ ok: false, j: null }));
  return loaded(key, result.ok, result.j) ? result.j : null;
};

export async function refreshPolicy() {
  const j = await settle('policy', '/api/policy');
  if (j && Array.isArray(j.rules)) state.policy = j;
}

export async function refreshPeople() {
  const j = await settle('people', '/api/people');
  if (j && Array.isArray(j.employees)) state.company = j;
}

export async function refreshAudit(limit = AUDIT_LIMIT) {
  const j = await settle('audit', `/api/audit?limit=${limit}`);
  if (Array.isArray(j)) state.audit = j;
}

/** The chain no longer sits in a corner as ambient status. It is fetched so
 *  the decision that someone actually asks about can prove itself. */
export async function refreshChain() {
  const { ok, j } = await api('/api/audit/verify').catch(() => ({ ok: false }));
  state.chain = ok ? j : null;
}

export async function refreshCompiler(refreshCliStatus = false) {
  const { ok, j } = await api(`/api/settings/compiler${refreshCliStatus ? '?refresh=1' : ''}`).catch(() => ({ ok: false }));
  state.compiler = ok ? j : null;
  const inv = await api('/api/models').catch(() => ({ ok: false }));
  state.models = inv.ok ? inv.j : null;
}

export async function refreshAdjudicator() {
  const { ok, j } = await api('/api/settings/adjudicator').catch(() => ({ ok: false }));
  state.adjudicator = ok ? j : null;
}

async function loadPresets() {
  const { j } = await api('/api/policy/presets');
  state.presets = Array.isArray(j) ? j : [];
}

export async function refreshAppeals() {
  const j = await settle('appeals', '/api/appeals');
  if (Array.isArray(j)) state.appeals = j;
}

export async function refreshEscalations() {
  const j = await settle('escalations', '/api/escalations');
  if (Array.isArray(j)) state.escalations = j;
}

/**
 * The live stream.
 *
 * The event carries the decision but not the audit envelope — no actor, no
 * hash links — so a new decision is a cue to pull the head of the log rather
 * than something to render straight from the wire. One small request per
 * decision buys rows identical to the historical ones.
 */
/**
 * What an arriving decision means to the first run, if it is open.
 *
 * It reacts **only** to the tool chosen on step 1. A decision from anything
 * else is somebody's other window, and treating it as proof would tell a person
 * their setup is verified on evidence about a tool they did not connect — the
 * worst available way for this screen to be wrong. The envelope carries the
 * tool for exactly this; the `Decision` does not and should not.
 *
 * Nothing here decides that the run is finished. A real verification is written
 * on the server, under conditions this page cannot check, and the screen reads
 * it back. What is recorded here is only what the server cannot tell it later:
 * that an allowed request went past, or that a decision arrived after the
 * hook's deadline. Both are gone by the next poll, and both are outcomes the
 * flow has to be able to name.
 */
/**
 * Re-read who this device is, and what it has verified.
 *
 * Lives here rather than in first-run.js because the live stream is here and
 * importing a screen into the data layer is how a cycle starts.
 */
async function refreshSoloIdentity() {
  const { ok, j } = await api('/api/solo/rules').catch(() => ({ ok: false }));
  if (!ok) return;
  state.soloIdentity = j.identity;
  state.soloRules = Array.isArray(j.rules) ? j.rules : [];
}

function noteFirstRunDecision(payload) {
  const chosen = state.firstRun?.tool;
  if (!chosen || payload.source !== chosen) return;
  state.firstRun.seen = true;
  state.firstRun.late = Boolean(payload.late);
  state.firstRun.allowed = payload.decision?.verdict === 'ALLOW';
}

function subscribe() {
  const src = new EventSource('/api/events');
  src.onmessage = async (e) => {
    let payload; try { payload = JSON.parse(e.data); } catch { return; }
    if (payload.type !== 'decision') return;
    noteFirstRunDecision(payload);
    const { ok, j } = await api('/api/audit?limit=1');
    if (ok && j[0] && j[0].auditId !== state.audit[0]?.auditId) state.audit.unshift(j[0]);
    void refreshChain();
    // The first run is waiting for exactly this. The verification itself is
    // written on the server, so the page has to go and read it rather than
    // conclude anything from the event — and this is what makes step 3 move on
    // its own, with `Check request` left as the manual fallback for an event
    // that never arrived. `renderNav` would be wrong here: there is no nav.
    if (state.view === 'firstRun') { await refreshSoloIdentity(); render(); return; }
    // Audit events do not change model forms or the attachment composer. Keep
    // those DOM nodes intact so an arriving request cannot erase a typed key
    // or close the browser's file picker. Activity surfaces still update live.
    if (['activity', 'inbox'].includes(state.view)) render(); else renderNav();
  };
}
