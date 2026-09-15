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
  state.mock = Boolean(health?.j?.mock);
  // Whether a desktop shell is listening that could actually fetch the models.
  // False in a browser against a checkout, where the honest offer is a command.
  state.canLeaveDemo = Boolean(health?.j?.canLeaveDemo);
  // The address the team reaches this gateway at, when a tunnel is up.
  state.publicUrl = health?.j?.publicUrl ?? null;
  // How long prompt text stays readable. Shown on the screen that shows it,
  // because a retention policy nobody can see is one nobody can rely on.
  state.prompts = health?.j?.prompts ?? null;
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
  const { j } = await api('/api/people');
  state.company = j;
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
function subscribe() {
  const src = new EventSource('/api/events');
  src.onmessage = async (e) => {
    let payload; try { payload = JSON.parse(e.data); } catch { return; }
    if (payload.type !== 'decision') return;
    const { ok, j } = await api('/api/audit?limit=1');
    if (ok && j[0] && j[0].auditId !== state.audit[0]?.auditId) state.audit.unshift(j[0]);
    void refreshChain();
    // Audit events do not change model forms or the attachment composer. Keep
    // those DOM nodes intact so an arriving request cannot erase a typed key
    // or close the browser's file picker. Activity surfaces still update live.
    if (['activity', 'inbox'].includes(state.view)) render(); else renderNav();
  };
}
