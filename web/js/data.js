/**
 * Fetching what the console shows, and the live stream that tells it to fetch again.
 */
import { $, AUDIT_LIMIT, api, state } from './core.js';
import { render } from './render.js';
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

  await Promise.all([refreshPolicy(), refreshPeople(), refreshAudit(), loadPresets(), refreshChain(), refreshAppeals(), refreshEscalations(), refreshCompiler(), refreshAdjudicator()]);
  window.addEventListener('hashchange', route);
  route();
  subscribe();
}

export async function refreshPolicy() {
  const { j } = await api('/api/policy');
  state.policy = j;
}

export async function refreshPeople() {
  const { j } = await api('/api/people');
  state.company = j;
}

async function refreshAudit() {
  const { ok, j } = await api(`/api/audit?limit=${AUDIT_LIMIT}`);
  state.audit = ok && Array.isArray(j) ? j : [];
}

/** The chain no longer sits in a corner as ambient status. It is fetched so
 *  the decision that someone actually asks about can prove itself. */
async function refreshChain() {
  const { ok, j } = await api('/api/audit/verify').catch(() => ({ ok: false }));
  state.chain = ok ? j : null;
}

export async function refreshCompiler() {
  const { ok, j } = await api('/api/settings/compiler').catch(() => ({ ok: false }));
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
  const { ok, j } = await api('/api/appeals');
  state.appeals = ok && Array.isArray(j) ? j : [];
}

export async function refreshEscalations() {
  const { ok, j } = await api('/api/escalations');
  state.escalations = ok && Array.isArray(j) ? j : [];
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
    render();
  };
}
