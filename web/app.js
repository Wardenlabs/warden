/**
 * Console behaviour. Plain ES modules, no framework, no build step.
 *
 * One column. A rail to choose what you are looking at, and a list of those
 * things; selecting one opens it in place, under the row you clicked. There is
 * no side panel, because a panel that has to be labelled to be understood is a
 * panel that was not carrying its width.
 *
 * Two people read every detail and they want opposite things. An operations
 * lead wants one sentence; whoever runs the gateway wants nine passes and a
 * hash chain. So every detail leads with the sentence and folds the rest away.
 * Milliseconds are part of the folded half: they belong to "how long did this
 * take", which is one question among several and not the first one.
 *
 * Every colour and every font-size lives in :root. Nothing here writes a hex
 * value or a pixel size; if a style is missing, add a token and a class in
 * index.html rather than an inline style, or the system stops being one.
 */

const $ = (id) => document.getElementById(id);
/**
 * The administrator's key, when the console needs one.
 *
 * It usually does not: the gateway treats its own loopback interface as
 * administrative, so a console opened on the machine running it never sees a
 * 403. Two situations do need a key — an admin opening the console from another
 * machine, and a deployment that has set `WARDEN_ADMIN_REQUIRE_KEY=1` because
 * employees can log into the gateway host. Until this existed there was nowhere
 * to put one, so the documented hardening switch made the console unusable and
 * every call failed with a 403 the UI rendered as a broken request.
 *
 * `sessionStorage`, not `localStorage`. This key rewrites policy and mints
 * credentials, and the difference is whether it survives the browser being
 * closed on a shared machine. Re-entering it once per session is a small price
 * for a credential that is not left lying in a profile directory.
 */
const ADMIN_KEY = 'warden.adminKey';

const adminKey = () => {
  try {
    return sessionStorage.getItem(ADMIN_KEY) ?? '';
  } catch {
    // Private mode, or storage disabled. The console still works from loopback.
    return '';
  }
};

const askForAdminKey = () => {
  const entered = window.prompt(
    'This gateway wants an administrator key.\n\n' +
      'Paste the API key of a person whose role the policy exempts — People → ' +
      'that person → API key. It is kept for this browser tab only.'
  );
  if (!entered) return false;
  try {
    sessionStorage.setItem(ADMIN_KEY, entered.trim());
  } catch {
    return false;
  }
  return true;
};

/**
 * One fetch helper, so the key is attached in one place.
 *
 * A 403 is answered by asking for a key once and retrying. Once, and tracked
 * per call: retrying on the retry turns a wrong key into a prompt loop the
 * admin cannot escape without closing the tab.
 *
 * The body is read as text and then parsed, because not every refusal is JSON —
 * `/install` answers in shell so that its output stays safe to pipe — and
 * `r.json()` on those used to throw inside the helper every caller depends on.
 */
const api = async (path, opts, retried) => {
  const key = adminKey();
  const init = key
    ? { ...opts, headers: { ...(opts?.headers ?? {}), authorization: `Bearer ${key}` } }
    : opts;

  const r = await fetch(path, init);

  if (r.status === 403 && !retried && askForAdminKey()) return api(path, opts, true);

  const text = await r.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = { error: text.slice(0, 400) };
  }
  return { ok: r.ok, status: r.status, j };
};
/**
 * What a severity actually does, in the admin's words.
 *
 * Written as a lookup rather than a ternary because a ternary has room for two
 * answers and there are three. Both of the places this replaced assumed the
 * pair: a `warn` rule rendered as "the request is stopped" in the rule detail
 * and as "escalates" in the drafting flow. An admin reading either would have
 * had exactly the wrong model of their own policy — believing a rule enforced
 * something it had been set not to enforce, which is worse than not showing the
 * severity at all.
 */
const SEVERITY_MEANS = {
  block: 'the request is stopped',
  escalate: 'held for a person to sign off',
  warn: 'the request goes through, with a note saying why it was flagged'
};
const SEVERITY_VERB = { block: 'stops', escalate: 'escalates', warn: 'warns about' };

const severityMeans = (s) => SEVERITY_MEANS[s] ?? `severity “${esc(s)}” — unknown to this console`;
const severityVerb = (s) => SEVERITY_VERB[s] ?? 'flags';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const attr = (s) => encodeURIComponent(String(s ?? ''));
const val = (x) => (typeof x === 'function' ? x() : x);

const state = {
  view: 'activity',
  sel: null,
  query: {},

  audit: [],
  policy: { rules: [], quotas: [], version: '' },
  company: { name: '', roles: [], employees: [] },
  presets: [],
  chain: null,
  mock: false,
  /** True when a desktop shell is listening that can fetch the models. */
  canLeaveDemo: false,
  /** Role whose limits are open for editing, or null. One at a time. */
  quotaEdit: null,
  /** Why the last save of that role's limits was refused, if it was. */
  quotaError: '',
  /** { days, held, max } while prompt text is kept, null when it is not. */
  prompts: null,

  /**
   * Where rule compilation runs. Never holds the API key — the server returns
   * `hasKey` and the last four characters, so this page can say "a key is
   * saved" without a secret living in a browser tab.
   */
  compiler: null,
  compilerDraft: null,
  compilerTest: null,
  compilerBusy: false,
  /** Last thing the Company block did, shown under it until the next render. */
  orgNote: '',

  /**
   * Blocks an employee said were wrong.
   *
   * The only place a false positive is visible. In the audit log a correct
   * block and an incorrect one are the same record — nothing distinguishes
   * them — so without this the admin has no way to find the rule that is
   * costing the company work.
   */
  appeals: [],

  /**
   * Requests Warden held instead of deciding, with the administrator's answer
   * when there is one. Derived on the server from the audit log, so this is a
   * work queue and not a second copy of the truth.
   */
  escalations: [],

  /** One draft at a time, deliberately. Two half-written rules is a way to
   *  activate the wrong one. `draftFor` locks the audience when it was started
   *  from a person's page. */
  draft: null,
  /**
   * Rules compiled from one broad instruction that are still waiting their
   * turn. `draft` is always the one on screen; this is the rest of the set.
   *
   * A queue and not a list you tick through, because ratification is the
   * security boundary and it only holds if each rule is looked at. Showing
   * three cards with three Activate buttons is how you get three clicks and
   * one reading.
   */
  drafts: [],
  draftFor: null,
  preview: null,
  ruleChat: [],
  ruleBusy: false,
  /** The audience editor is a control, not information: it stays shut until
   *  you say you want to change who a rule binds. */
  audienceOpen: false,

  filter: 'all',
  actorFilter: '',
  presetCat: null,

  chat: [],
  rtReport: null,
  rtBusy: false,

  /** Which disclosures are expanded, by key. Kept in state rather than the DOM
   *  so it survives a re-render and follows you from one row to the next. */
  open: new Set()
};

const AUDIT_LIMIT = 400;
/** Recent allowed prompts offered as a regression check on a candidate rule.
 *  Each one is a full adjudication on the local model, so this stays small. */
const REGRESSION_SAMPLE = 5;

// ── formatting ───────────────────────────────────────────────────────────────

const shortHash = (h) => (h ? String(h).slice(0, 8) : '—');
const dayKey = (ts) => String(ts).slice(0, 10);

function dayLabel(key) {
  const today = dayKey(new Date().toISOString());
  if (key === today) return 'Today';
  if (key === new Date(Date.now() - 86400000).toISOString().slice(0, 10)) return 'Yesterday';
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const hhmm = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;

/**
 * A rule's name in words.
 *
 * `r-customer-pii` is an identifier, and an identifier in a list is a thing a
 * non-technical reader skips. Seeded rules carry a meaningful slug; rules
 * compiled at runtime get a generated id, and for those the opening clause of
 * the rule reads better than the id ever would.
 */
const ACRONYMS = { pii: 'PII', api: 'API', ceo: 'CEO', hr: 'HR', id: 'ID', kyc: 'KYC', sso: 'SSO' };
const GENERATED_ID = /^r-(preset|draft|\d)/;

function ruleName(ruleOrId) {
  const rule = typeof ruleOrId === 'string' ? ruleById(ruleOrId) : ruleOrId;
  const id = typeof ruleOrId === 'string' ? ruleOrId : ruleOrId?.id;

  if (id && /^r-/.test(id) && !GENERATED_ID.test(id)) {
    return id.slice(2).split('-').filter(Boolean)
      .map((w) => ACRONYMS[w] ?? w).join(' ')
      .replace(/^./, (c) => c.toUpperCase());
  }
  return clip(String(rule?.text ?? '').split(/[.;—]/)[0], 48) || id || 'rule';
}

/** Initials on a neutral disc. No photo service and no generated hue: eight
 *  tinted avatars competing with three verdict colours is why nothing on the
 *  old console read at a glance. */
function avatar(person, big = false) {
  const initials = String(person?.name ?? '?').split(/\s+/)
    .map((w) => w.match(/\p{L}/u)?.[0] ?? '')
    .filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  return `<span class="avatar${big ? ' lg' : ''}">${esc(initials)}</span>`;
}

const personById = (id) => state.company.employees.find((e) => e.id === id) ?? null;
const actorName = (actor) => personById(actor?.id)?.name ?? actor?.id ?? 'unknown';

/** `@id` means nothing to a reader; resolve it to a name. */
function audienceLabel(appliesTo) {
  if (!appliesTo?.length) return 'nobody';
  if (appliesTo.includes('*')) return 'everyone';
  return appliesTo
    .map((t) => (t.startsWith('@') ? (personById(t.slice(1))?.name ?? `${t.slice(1)} (removed)`) : t))
    .join(', ');
}

const isPersonal = (rule) => rule.appliesTo?.some((t) => t.startsWith('@'));
const ruleById = (id) => state.policy.rules.find((r) => r.id === id) ?? null;

const TOOL_NAMES = {
  'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor',
  opencode: 'OpenCode', generic: 'other tool', proxy: 'API'
};

/**
 * Copy to clipboard, with a fallback that actually matters here.
 *
 * The console is normally opened over the LAN at http://192.168.x.x, which is
 * not a secure context, and `navigator.clipboard` is undefined there.
 */
async function copyText(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
  } catch { /* fall through to the textarea trick */ }

  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.className = 'offscreen';
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }

  if (btn) {
    const original = btn.textContent;
    btn.textContent = ok ? 'Copied' : 'Select it manually';
    setTimeout(() => { btn.textContent = original; }, 1600);
  }
}

// ── routing ──────────────────────────────────────────────────────────────────

const VIEWS = {};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const [view, ...rest] = path.split('/');
  const query = {};
  for (const [k, v] of new URLSearchParams(qs ?? '')) query[k] = v;
  return {
    view: VIEWS[view] ? view : 'activity',
    sel: rest.length ? decodeURIComponent(rest.join('/')) : null,
    query
  };
}

function go(view, sel, query) {
  const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
  const next = `#/${view}${sel ? `/${encodeURIComponent(sel)}` : ''}${qs}`;
  if (location.hash === next) route(); else location.hash = next;
}

/** Selecting the open row again closes it. Nothing else on the page moves. */
const toggleSel = (view, id) => go(view, state.sel === id ? null : id);

function route() {
  Object.assign(state, parseHash());
  render();
  if (VIEWS[state.view].onEnter) VIEWS[state.view].onEnter();
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  const health = await api('/health').catch(() => null);
  state.mock = Boolean(health?.j?.mock);
  // Whether a desktop shell is listening that could actually fetch the models.
  // False in a browser against a checkout, where the honest offer is a command.
  state.canLeaveDemo = Boolean(health?.j?.canLeaveDemo);
  // How long prompt text stays readable. Shown on the screen that shows it,
  // because a retention policy nobody can see is one nobody can rely on.
  state.prompts = health?.j?.prompts ?? null;
  if (!health?.ok) {
    $('pane').innerHTML = '<div class="sheet"><div class="empty"><b>The gateway is not answering</b><span>Start it with <code>pnpm run dev</code> and reload this page.</span></div></div>';
    return;
  }

  await Promise.all([refreshPolicy(), refreshPeople(), refreshAudit(), loadPresets(), refreshChain(), refreshAppeals(), refreshEscalations(), refreshCompiler()]);
  window.addEventListener('hashchange', route);
  route();
  subscribe();
}

async function refreshPolicy() {
  const { j } = await api('/api/policy');
  state.policy = j;
}

async function refreshPeople() {
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

async function refreshCompiler() {
  const { ok, j } = await api('/api/settings/compiler').catch(() => ({ ok: false }));
  state.compiler = ok ? j : null;
}

async function loadPresets() {
  const { j } = await api('/api/policy/presets');
  state.presets = Array.isArray(j) ? j : [];
}

async function refreshAppeals() {
  const { ok, j } = await api('/api/appeals');
  state.appeals = ok && Array.isArray(j) ? j : [];
}

async function refreshEscalations() {
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

// ── render ───────────────────────────────────────────────────────────────────

/**
 * Everything is re-rendered from strings, and a decision arriving on the live
 * stream re-renders whatever you happen to be in the middle of typing. So the
 * value and the caret of every field are carried across the swap, keyed by id.
 */
/** How close to the bottom still counts as "following the conversation". */
const STICK_PX = 140;
const SMOOTH = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

function captureFields() {
  const saved = {};
  for (const f of $('pane').querySelectorAll('input, textarea, select')) {
    if (!f.id) continue;
    saved[f.id] = { value: f.value, start: f.selectionStart, end: f.selectionEnd };
  }
  const chat = $('pane').querySelector('.chat');
  return {
    saved,
    focus: document.activeElement?.id ?? null,
    scroll: $('pane').scrollTop,
    // A conversation follows along on its own while you are at the bottom of
    // it, and stays put if you have scrolled up to read something. Yanking
    // someone back down mid-sentence is worse than not scrolling at all.
    chat: chat && { top: chat.scrollTop, stick: chat.scrollHeight - chat.scrollTop - chat.clientHeight < STICK_PX }
  };
}

function restoreFields({ saved, focus, scroll, chat }) {
  for (const [id, s] of Object.entries(saved)) {
    const f = $(id);
    if (!f || f.value === s.value) continue;
    // A <select> whose option list was rebuilt may no longer hold the value.
    if (f.tagName === 'SELECT' && ![...f.options].some((o) => o.value === s.value)) continue;
    f.value = s.value;
    if (s.start != null && f.setSelectionRange) {
      try { f.setSelectionRange(s.start, s.end); } catch { /* not a text field */ }
    }
  }
  if (focus && $(focus)) $(focus).focus();
  if (scroll) $('pane').scrollTop = scroll;
}

/**
 * Keep the conversation at the bottom.
 *
 * Runs after bind, not with the other restores: bind is where the audience
 * editor writes its chips, and measuring the height before that leaves the
 * last card cut off by exactly the height of those two rows.
 */
function restoreChat(chat) {
  const el = $('pane').querySelector('.chat');
  if (!el) return;
  if (!chat) { el.scrollTop = el.scrollHeight; return; }   // just opened
  if (!chat.stick) { el.scrollTop = chat.top; return; }
  requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: SMOOTH() }));
}

function render() {
  const view = VIEWS[state.view];
  const fields = captureFields();

  renderNav();
  $('pane').className = `pane${val(view.flush) ? ' flush' : ''}`;
  // Demo mode goes above every screen, not inside one. It used to live in the
  // today card, which does not render until something has happened — so the
  // person it is written for, somebody who has just installed the app and is
  // wondering why nothing works, was the one person who never saw it.
  $('pane').innerHTML = (state.mock ? mockBanner() : '') + firstRunBanner() + view.body();

  restoreFields(fields);
  bindDisclosures();
  if (view.bind) view.bind();

  // The first-run banner is drawn by the shell on every screen, so its one
  // button is bound here rather than in any view's own bind — it would
  // otherwise be dead on the screen the console actually opens on.
  const sample = $('loadSample');
  if (sample) sample.onclick = async () => {
    sample.disabled = true;
    sample.textContent = 'Loading…';
    await api('/api/company/sample', { method: 'POST' });
    await Promise.all([refreshPolicy(), refreshPeople()]);
    go('policy');
  };

  // Same reason as the button above it: the demo banner is drawn by the shell
  // on every screen, so binding this inside any one view would make it dead on
  // the screen the console actually opens on.
  const models = $('getModels');
  if (models) models.onclick = async () => {
    models.disabled = true;
    models.textContent = 'Starting the download…';
    const { ok, j } = await api('/api/gateway/leave-demo', { method: 'POST' });
    if (!ok) {
      models.disabled = false;
      models.textContent = 'Download the models';
      // The one failure worth naming: no shell to do it, so say what to run.
      models.insertAdjacentHTML('afterend',
        `<span class="note bad">${esc(j?.error ?? 'could not start the download')}</span>`);
      return;
    }
    // The shell relaunches the app from under us, so there is nothing after
    // this to render. Saying so beats a button that looks stuck.
    models.textContent = 'Downloading. Warden will restart on its own…';
  };

  restoreChat(fields.chat);
}

/** Disclosures report their own open state back into `state.open` so the next
 *  render can reinstate it. */
function bindDisclosures() {
  for (const d of document.querySelectorAll('details[data-key]')) {
    d.ontoggle = () => {
      if (d.open) state.open.add(d.dataset.key); else state.open.delete(d.dataset.key);
    };
  }
}

function disclosure(key, label, body) {
  return `<details class="fold" data-key="${esc(key)}"${state.open.has(key) ? ' open' : ''}>
    <summary>${esc(label)}</summary>
    <div class="fold-body">${body}</div>
  </details>`;
}

/**
 * The navigation: four destinations across the top, one divider.
 *
 * Along the top rather than down the side, so the column underneath is the
 * full width of the window and the composer can be the size it deserves.
 *
 * Only one count survives. A number next to Activity told you how much log
 * there is, which is not a thing anyone acts on; a number next to Inbox says
 * somebody is waiting, which is.
 *
 * The simulator and the red team suite are not here at all — they are things
 * you run against your policy, not places you go, so they live on Rules.
 */
// Rules leads with the composer rather than the list: `sel: 'new'` makes the
// nav item land on the tab you are most likely to have come for.
const NAV = [
  { view: 'activity', label: 'Activity' },
  { view: 'inbox', label: 'Inbox', count: () => pendingEscalations().length + state.appeals.length },
  { sep: true },
  { view: 'policy', label: 'Rules', sel: 'new' },
  { view: 'people', label: 'Team' }
];

function renderNav() {
  const here = VIEWS[state.view].railParent ?? state.view;
  $('nav').innerHTML = NAV.map((it) => {
    if (it.sep) return '<span class="nav-sep"></span>';
    const n = it.count ? it.count() : 0;
    return `<button type="button" class="nav-item${here === it.view ? ' on' : ''}" data-go="${it.view}"${it.sel ? ` data-sel="${it.sel}"` : ''}>
      <span>${esc(it.label)}</span>
      ${n > 0 ? `<span class="nav-count">${n}</span>` : ''}
    </button>`;
  }).join('');
  // A demo directory has a company name, and it is not the user's. Showing it
  // in the title bar is the product asserting something false about whoever
  // installed it, so the seeded name stays out of the chrome until someone
  // claims it on Team.
  // While it is the sample, the chrome says so and offers the one click that
  // fixes it — the console opens on Activity, so nobody finds the Company block
  // on Team by accident.
  if (state.company.demo) {
    $('orgName').innerHTML = '<button type="button" class="linkish" data-go="people">· sample data</button>';
  } else {
    $('orgName').textContent = state.company.name ? `· ${state.company.name}` : '';
  }
}

// One delegated listener for the whole document: every navigation is a
// `data-go` (+ optional `data-sel` / `data-q`), so nothing has to re-bind after
// a re-render. `data-toggle` is the in-place open/close.
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle]');
  if (t) { toggleSel(t.dataset.toggle, t.dataset.sel || null); return; }

  const nav = e.target.closest('[data-go]');
  if (nav) {
    const q = nav.dataset.q ? Object.fromEntries(new URLSearchParams(nav.dataset.q)) : undefined;
    go(nav.dataset.go, nav.dataset.sel || null, q);
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) void copyText(decodeURIComponent(copy.dataset.copy), copy);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sel && !composing()) go(state.view);
});

// ═══ ACTIVITY ════════════════════════════════════════════════════════════════

/** Held and still unanswered. The rail counts these, not the ones already dealt
 *  with — a badge that never goes down stops being read. */
const pendingEscalations = () => state.escalations.filter((e) => !e.review);

/**
 * The three verdicts, in words rather than in the enum.
 *
 * `ESCALATE` is what the code calls it and it is the right name there — it is
 * a position in a lattice. On a screen it is jargon: nobody outside this repo
 * knows whether an escalated request was refused, and the whole point of that
 * verdict is that it was not. What happened is that it is waiting for a
 * person, so that is what it says.
 */
function verdictWord(v) {
  return { all: 'All', BLOCK: 'Blocked', ESCALATE: 'Held', ALLOW: 'Allowed' }[v] ?? v;
}

function visibleAudit() {
  return state.audit.filter((a) => {
    const d = a.decision ?? {};
    if (state.filter !== 'all' && d.verdict !== state.filter) return false;
    if (state.actorFilter && a.actor?.id !== state.actorFilter) return false;
    if (state.query.rule && !(d.firedRules ?? []).some((r) => r.ruleId === state.query.rule)) return false;
    return true;
  });
}

/**
 * The shape of the day, above the log.
 *
 * Opening a console should answer "do I have to do something?" before it
 * answers "what happened?". Every number here comes from the audit records
 * already loaded — there is no second surface and no new endpoint behind it.
 */
function todayCard() {
  const today = dayKey(new Date().toISOString());
  const rows = state.audit.filter((a) => dayKey(a.ts) === today);
  const stopped = rows.filter((a) => a.decision?.verdict === 'BLOCK').length;
  const waiting = pendingEscalations().length;
  const people = new Set(rows.filter((a) => a.decision?.verdict !== 'ALLOW').map((a) => a.actor?.id)).size;

  if (!rows.length) {
    return `<div class="today">
      <p class="line">Nothing has come through Warden today yet.</p>
      <div class="cta"><button type="button" class="btn" data-go="simulator">Try a prompt</button></div>
    </div>`;
  }

  return `<div class="today">
    <p class="line">Warden looked at <b>${rows.length}</b> request${rows.length === 1 ? '' : 's'} today and stopped <b>${stopped}</b>.
      ${people ? `${plural(people, 'person', 'people')} hit a rule.` : 'Nobody hit a rule.'}</p>
    ${waiting ? `<div class="cta">
      <button type="button" class="btn primary" data-go="inbox">${plural(waiting, 'request')} waiting on you</button>
    </div>` : ''}
  </div>`;
}

function decisionRows(entries, emptyState) {
  if (!entries.length) return emptyState;

  let out = '';
  let day = null;
  const counts = entries.reduce((m, a) => { const k = dayKey(a.ts); m[k] = (m[k] ?? 0) + 1; return m; }, {});

  for (const a of entries) {
    const k = dayKey(a.ts);
    if (k !== day) {
      day = k;
      out += `<div class="day">${esc(dayLabel(k))}<span class="n">${counts[k]}</span></div>`;
    }
    const d = a.decision ?? {};
    const fired = d.firedRules?.[0];
    const open = state.sel === a.auditId;

    out += `<button type="button" class="row${open ? ' on' : ''}" data-toggle="${state.view}" data-sel="${attr(a.auditId)}" aria-expanded="${open}">
      <span class="dot ${esc(d.verdict ?? '')}"></span>
      <span class="who">${esc(actorName(a.actor))}</span>
      <span class="txt">${d.maskedPrompt
        ? esc(d.maskedPrompt)
        : '<i class="nokeep" title="The audit log keeps this prompt\'s SHA-256, not its text. The console can show the text only while the gateway that judged it is still running.">not stored</i>'}</span>
      ${fired ? `<span class="rule-ref">${esc(ruleName(fired.ruleId))}</span>` : ''}
      <span class="meta">${esc(hhmm(a.ts))}</span>
    </button>`;

    if (open) out += decisionDetail(a);
  }
  return out;
}

/**
 * What happened, in one sentence, before any of the machinery.
 *
 * Assembled from fields the audit record already carries — no second model
 * call. An operations lead should be able to read this line, close the row,
 * and be correct about what Warden did.
 */
function plainSummary(entry) {
  const d = entry.decision ?? {};
  const who = esc(actorName(entry.actor));
  // Without this the sentence reads: asked “”. The record kept the hash and
  // not the text, and saying so is better than quoting nothing as if it were
  // the prompt.
  const asked = d.maskedPrompt
    ? `“${esc(clip(d.maskedPrompt, 130))}”`
    : 'something this record no longer holds the text of';
  const rule = d.firedRules?.[0];

  if (d.verdict === 'ALLOW') {
    return `<b>${who}</b> asked ${asked}, and Warden let it through, because nothing in the policy applies to it.`;
  }
  if (!rule) {
    // No rule fired, so the only account of the refusal is the explanation the
    // guard wrote. It is multi-line and one of its lines names the structural
    // signal — invisible characters, faked conversation turns, phrasing aimed
    // at the instruction layer. Without this the panel says a person was
    // stopped and offers nothing to point at, which is exactly the failure the
    // policy-is-the-authority rule exists to prevent.
    const flagged = String(d.explanation ?? '').split('\n').find((l) => l.startsWith('Also flagged:'));
    const signal = flagged ? flagged.replace(/^Also flagged:\s*/, '').replace(/\.\s*$/, '') : '';
    if (d.verdict === 'ESCALATE') {
      return `<b>${who}</b> asked ${asked}. No rule matched it, but Warden noticed ${
        signal ? `<b>${esc(signal)}</b>` : 'something structural in the text'
      } and queued it for a person. They have not been refused; they are waiting.`;
    }
    return `<b>${who}</b> asked ${asked}, and Warden stopped it${
      signal ? ` after noticing <b>${esc(signal)}</b>` : ''
    }. No rule in the policy matched it.`;
  }
  const name = esc(ruleName(rule.ruleId));
  // The guidance stays out of this sentence on purpose. It is often three lines
  // long, and a lead that runs to six lines is no longer a lead.
  return d.verdict === 'BLOCK'
    ? `<b>${who}</b> asked ${asked}. The <b>${name}</b> rule forbids that, so Warden stopped it.`
    : `<b>${who}</b> asked ${asked}. The <b>${name}</b> rule says this needs a person to sign off, so Warden is holding it.`;
}

/**
 * @param entry the audit record
 * @param head  markup spliced in above the summary. The Inbox uses it to lead
 *              with what a person said about this decision, which is the part
 *              the log cannot tell you.
 */
function decisionDetail(entry, head = '') {
  const d = entry.decision ?? {};
  const slowest = Math.max(1, ...(d.passes ?? []).map((p) => p.ms ?? 0));
  const guidance = d.firedRules?.[0]?.guidance;

  // Latency lives here and only here — this is the section about how it ran.
  // "None of it left this machine" is the conclusion of the same paragraph,
  // which is a better home for that claim than a light in a corner.
  const passes = `<div>${(d.passes ?? []).map((p) => `
      <div class="pass">
        <span class="n">${esc(p.pass)}${p.failedClosed ? ' ⚠' : ''}</span>
        <span class="v ${esc(p.verdict ?? '')}">${esc(p.verdict ?? '')}</span>
        <span class="track"><i style="width:${Math.round(((p.ms ?? 0) / slowest) * 100)}%"></i></span>
        <span class="ms">${p.ms ?? 0}ms</span>
      </div>`).join('')}
    <div class="note">${((d.totalMs ?? 0) / 1000).toFixed(1)}s${state.mock ? ' · demo mode' : ' · nothing left this machine'}</div>`;

  const chain = `<div class="chain">
      <div class="link"><span>previous</span><b>${esc(shortHash(entry.prevHash))}</b></div>
      <div class="rail-line"></div>
      <div class="link"><span class="dot ${state.chain?.ok ? 'ALLOW' : 'BLOCK'}"></span><b>${esc(shortHash(entry.entryHash))}</b><span>this one</span></div>
    </div>
    <div class="note">${state.chain?.ok
      ? `All ${state.chain.entries} records still match their hashes.`
      : 'This log no longer verifies: a record was altered or removed after it was written.'}</div>`;

  const record = `<div class="kv">
      <div class="r"><span class="k">Audit id</span><span class="v mono">${esc(entry.auditId)}</span></div>
      <div class="r"><span class="k">Exact time</span><span class="v mono">${esc(entry.ts)}</span></div>
      <div class="r"><span class="k">Policy</span><span class="v mono">${esc(shortHash(d.policyVersion))}</span></div>
      ${d.quota?.limit ? `<div class="r"><span class="k">Daily use</span><span class="v num">${d.quota.used} of ${d.quota.limit}</span></div>` : ''}
      ${d.maskedSpans?.length ? `<div class="r"><span class="k">Masked</span><span class="v">${plural(d.maskedSpans.length, 'secret')} removed before checking</span></div>` : ''}
      ${(d.firedRules ?? []).map((r) => `
        <div class="r"><span class="k">${esc(r.ruleId)}</span><span class="v">${esc(r.reason)} · confidence ${r.confidence ?? '—'}</span></div>`).join('')}
    </div>`;

  return `<div class="detail">
    ${head}
    <div class="detail-head">
      <span class="badge ${esc(d.verdict)}">${esc(d.verdict)}</span>
      <span class="when">${esc(hhmm(entry.ts))} · ${esc(dayLabel(dayKey(entry.ts)).toLowerCase())}</span>
    </div>

    <p class="summary">${plainSummary(entry)}</p>

    ${guidance ? `<div class="group">
      <div class="label">What Warden told them to do instead</div>
      <div class="banner">${esc(guidance)}</div>
    </div>` : ''}

    <div class="group">
      <div class="label">What they sent</div>
      <pre class="code">${esc(d.maskedPrompt || '—')}</pre>
    </div>

    ${(d.firedRules ?? []).length ? `
      <div class="group">
        <div class="label">Rule${d.firedRules.length > 1 ? 's' : ''} behind it</div>
        ${d.firedRules.map((r) => `
          <button type="button" class="ruleref" data-go="policy" data-sel="${attr(r.ruleId)}">
            <span class="dot ${esc(r.severity)}"></span>
            <span class="col">
              <span class="t">${esc(ruleName(r.ruleId))}</span>
              <span class="m">${esc(clip(r.ruleText, 130))}</span>
            </span>
          </button>`).join('')}
      </div>` : ''}

    <div class="folds">
      ${disclosure('d:passes', 'How it was decided', passes)}
      ${disclosure('d:chain', 'Proof this record has not been altered', chain)}
      ${disclosure('d:record', 'Technical record', record)}
    </div>
  </div>`;
}

/** Filters live with the list they filter, not in the app chrome. */
function activityToolbar() {
  const opts = state.company.employees
    .map((e) => `<option value="${esc(e.id)}"${state.actorFilter === e.id ? ' selected' : ''}>${esc(e.name)}</option>`).join('');
  return `<div class="toolbar">
    <span class="seg" id="verdictSeg">
      ${['all', 'BLOCK', 'ESCALATE', 'ALLOW'].map((v) => `
        <button type="button" data-v="${v}" class="${state.filter === v ? 'on' : ''}">${verdictWord(v)}</button>`).join('')}
    </span>
    <select class="inline" id="actorFilter" aria-label="Filter by person">
      <option value="">Everyone</option>${opts}
    </select>
    ${state.query.rule ? `<button type="button" class="chip on" id="clearRule">${esc(ruleName(state.query.rule))} ✕</button>` : ''}
    <span class="spacer"></span>
    <span class="note">${visibleAudit().length} of ${state.audit.length}</span>
  </div>`;
}

function bindActivity() {
  const seg = $('verdictSeg');
  if (seg) seg.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.filter = b.dataset.v;
    render();
  };
  const sel = $('actorFilter');
  if (sel) sel.onchange = (e) => { state.actorFilter = e.target.value; render(); };
  const cr = $('clearRule');
  if (cr) cr.onclick = () => go('activity');
}

VIEWS.activity = {
  bind: bindActivity,
  body: () => {
    const rows = visibleAudit();
    const filtered = rows.length !== state.audit.length;
    return `<div class="sheet">
      ${filtered ? '' : todayCard()}
      ${activityToolbar()}
      ${decisionRows(rows, '<div class="empty"><b>Nothing matches</b><span>No decision in the log fits these filters. Clear one to widen the search.</span></div>')}
    </div>`;
  }
};

/**
 * Everything waiting on a person, in two kinds.
 *
 * A held request is Warden declining to decide. An appeal is Warden having
 * decided wrong, according to the person it landed on. Both need a human and
 * neither belongs in the log, where a correct block and an incorrect one look
 * identical — which is the whole reason appeals exist as a separate record.
 */
VIEWS.inbox = {
  onEnter: () => { void Promise.all([refreshAppeals(), refreshEscalations()]).then(render); },
  bind: bindInbox,
  body: () => {
    const waiting = pendingEscalations();
    const answered = state.escalations.filter((e) => e.review);
    if (!state.appeals.length && !state.escalations.length) {
      return `<div class="sheet"><div class="empty">
        <b>Nothing waiting</b>
        <span>Two things land here: requests Warden held instead of deciding, and blocks an employee said were wrong.</span>
      </div></div>`;
    }
    return `<div class="sheet">
      ${waiting.length ? `
        <div class="day">Waiting on you<span class="n">${waiting.length}</span></div>
        ${waiting.map(escalationRow).join('')}` : ''}
      ${state.appeals.length ? `
        <div class="day">Reported as wrong<span class="n">${state.appeals.length}</span></div>
        ${state.appeals.map(appealRow).join('')}` : ''}
      ${answered.length ? `
        <div class="day">Already answered<span class="n">${answered.length}</span></div>
        ${answered.map(escalationRow).join('')}` : ''}
    </div>`;
  }
};

/**
 * One held request.
 *
 * An escalation is not a refusal and must not read like one: the person was not
 * told no, they were told to wait, and this is the screen where somebody ends
 * that wait.
 */
function escalationRow(e) {
  const open = state.sel === e.auditId;
  const done = Boolean(e.review);
  return `<button type="button" class="row roomy${open ? ' on' : ''}" data-toggle="inbox" data-sel="${attr(e.auditId)}" aria-expanded="${open}">
      <span class="dot ${done ? '' : 'ESCALATE'}"></span>
      <span class="col">
        <span class="t">${e.ruleText ? esc(ruleName(e.ruleId ?? '')) : 'Held without a named rule'}</span>
        <span class="m">
          <span>${esc(e.employeeName ?? e.employeeId)} · ${esc(e.role)}</span>
          ${done
            ? `<span class="badge ${e.review.outcome === 'approved' ? 'ALLOW' : 'BLOCK'}">${esc(e.review.outcome)}</span>`
            : '<span class="badge ESCALATE">waiting</span>'}
          <span class="mono">${esc(String(e.at).slice(0, 16).replace('T', ' '))}</span>
        </span>
      </span>
    </button>
    ${open ? escalationDetail(e) : ''}`;
}

function escalationDetail(e) {
  const entry = state.audit.find((x) => x.auditId === e.auditId);
  const who = esc(e.employeeName ?? e.employeeId);

  const head = `<p class="summary">${who} sent something the <b>${esc(ruleName(e.ruleId ?? ''))}</b> rule says needs a person to sign off. They were not refused, only told to wait, and they are still waiting.</p>
    ${e.employeeNote ? `<div class="group">
      <div class="label">They added</div>
      <div class="banner">“${esc(e.employeeNote)}”</div>
    </div>` : ''}
    ${e.review ? `<div class="group">
      <div class="label">Answered</div>
      <div class="banner${e.review.outcome === 'approved' ? '' : ' warn'}">
        <b>${esc(e.review.outcome)}</b>${e.review.note ? ` — ${esc(e.review.note)}` : ''}
      </div>
    </div>` : `<div class="group">
      <div class="label">Answer them</div>
      <textarea id="reviewNote" rows="2" placeholder="What should they know? (optional)"></textarea>
      <div class="chips">
        <button type="button" class="btn primary" data-review="approved" data-id="${attr(e.auditId)}">Approve</button>
        <button type="button" class="btn danger" data-review="refused" data-id="${attr(e.auditId)}">Refuse</button>
      </div>
      <div class="note">This answers them. Their next ask is judged on its own.</div>
      <div class="note bad" id="reviewNote_err"></div>
    </div>`}`;

  return entry ? decisionDetail(entry, head) : `<div class="detail">${head}</div>`;
}

function bindInbox() {
  const sheet = $('pane').querySelector('.sheet');
  if (!sheet) return;
  sheet.querySelectorAll('[data-review]').forEach((btn) => {
    btn.onclick = async () => {
      const note = $('reviewNote')?.value.trim();
      btn.disabled = true;
      const { ok, j } = await api(`/api/escalations/${encodeURIComponent(btn.dataset.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: btn.dataset.review, ...(note ? { note } : {}) })
      });
      if (!ok) {
        btn.disabled = false;
        const err = $('reviewNote_err');
        if (err) err.textContent = j.error ?? 'could not record that';
        return;
      }
      await refreshEscalations();
      render();
    };
  });
}

function appealRow(a) {
  const open = state.sel === a.auditId;
  return `<button type="button" class="row roomy${open ? ' on' : ''}" data-toggle="inbox" data-sel="${attr(a.auditId)}" aria-expanded="${open}">
      <span class="dot BLOCK"></span>
      <span class="col">
        <span class="t">${a.note ? esc(a.note) : `${esc(a.employeeName)} said this block was wrong`}</span>
        <span class="m">
          <span>${esc(a.employeeName)}</span>
          ${a.ruleId ? `<span>${esc(ruleName(a.ruleId))}</span>` : '<span>no rule fired</span>'}
          <span class="mono">${esc(String(a.at).slice(0, 16).replace('T', ' '))}</span>
        </span>
      </span>
    </button>
    ${open ? appealDetail(a) : ''}`;
}

function appealDetail(a) {
  const entry = state.audit.find((x) => x.auditId === a.auditId);
  // The decision itself carries everything, so show it — but lead with what the
  // person said, because that is the part the log cannot tell you.
  const head = `<div class="group">
      <div class="label">${esc(a.employeeName)} reported this</div>
      ${a.note
        ? `<div class="banner">“${esc(a.note)}”</div>`
        : '<div class="note">No note, just that it was wrong.</div>'}
    </div>
    ${a.ruleId ? `<div class="group">
      <div class="label">The rule that stopped them</div>
      <button type="button" class="ruleref" data-go="policy" data-sel="${attr(a.ruleId)}">
        <span class="dot block"></span>
        <span class="col">
          <span class="t">${esc(ruleName(a.ruleId))}</span>
          <span class="m">${esc(clip(a.ruleText, 130))}</span>
        </span>
      </button>
    </div>` : ''}`;

  if (!entry) {
    return `<div class="detail">
      ${head}
      <div class="note">The decision itself is older than the log this console loaded, so only what they reported is shown.</div>
    </div>`;
  }
  // Splice the report into the decision's own detail, above everything else.
  return decisionDetail(entry, head);
}

// ═══ RULES ═══════════════════════════════════════════════════════════════════

/**
 * Rules is two tabs, not one page.
 *
 * Writing a rule is a conversation with Warden; the policy is a list. Those are
 * different modes of using the screen, and stacking them meant that the moment
 * you sent the first message the list underneath was orphaned — still there,
 * no longer part of what you were doing. So they became peers: the list you
 * come back to, and the conversation you start.
 */
const onNewRule = () => state.view === 'policy' && state.sel === 'new';
const inConversation = () => onNewRule() && (state.ruleChat.length > 0 || Boolean(state.draft));
const composing = inConversation;

VIEWS.policy = {
  flush: onNewRule,
  body: () => (onNewRule() ? (inConversation() ? ruleChatPane() : newRulePage()) : rulesBody()),
  bind: bindPolicy
};

/**
 * Where rule compilation runs, as a page rather than four environment
 * variables and a restart.
 *
 * It sits under Rules, and the line that leads here sits in the composer,
 * because that is where the cost of a weak compiler is felt: a rule whose
 * compliant examples are generic is a rule that blocks honest work, and the
 * local 1.7B writes generic ones. Asked to allow something it has produced a
 * rule prohibiting it.
 *
 * The judge is deliberately absent from this page. It is not a model anyone
 * gets to move from a browser — it sees every employee prompt — and offering
 * the choice here would suggest otherwise.
 */
VIEWS.compiler = {
  railParent: 'policy',
  body: compilerPage,
  bind: bindCompiler
};

/** The draft being edited, seeded from what the server reports. */
function compilerDraft() {
  if (!state.compilerDraft) {
    const c = state.compiler ?? { provider: 'local', baseUrl: '', model: '', redactNames: false };
    const preset = (c.providers ?? []).find((p) => p.id === (c.provider ?? 'local'));
    state.compilerDraft = {
      provider: c.provider ?? 'local',
      // Falls back to the provider's own endpoint so a half-saved setting shows
      // the right host rather than an empty box.
      baseUrl: c.baseUrl || preset?.baseUrl || '',
      model: c.model || preset?.models?.[0] || '',
      apiKey: '',
      redactNames: Boolean(c.redactNames)
    };
  }
  return state.compilerDraft;
}

function compilerPage() {
  const c = state.compiler;
  if (!c) return `<div class="sheet settings">${rulesTabs()}<div class="note">Could not read the compiler settings.</div></div>`;

  const d = compilerDraft();
  const providers = c.providers ?? [];
  const chosen = providers.find((p) => p.id === d.provider) ?? providers[0];
  // Three kinds of provider and they need different forms. `local` asks for
  // nothing. A `-cli` provider asks for nothing either — that is the point of
  // it — beyond which model to pass through. Only a real endpoint needs a URL
  // and a key, so only that one gets those fields.
  const cli = d.provider.endsWith('-cli');
  const remote = d.provider !== 'local' && !cli;
  const t = state.compilerTest;
  const host = (() => {
    try { return new URL(d.baseUrl || chosen?.baseUrl || '').host; } catch { return ''; }
  })();

  return `<div class="sheet settings">
    ${rulesTabs()}

    <div class="section">
      <div class="label">Which model writes your rules</div>

      <div class="where">
        <span class="dot ${remote ? 'ESCALATE' : 'ALLOW'}"></span>
        <span>${remote
          ? `Drafting runs at <b>${esc(host || 'the endpoint below')}</b>. Judging your team's prompts stays on this machine.`
          : `Drafting and judging both run here, on <b>${esc(c.localModel ?? 'the local model')}</b>.`}</span>
      </div>

      ${c.overriddenByEnv ? `<div class="banner warn">
        <b>The environment is setting this.</b> <code>WARDEN_COMPILER_API</code> wins over what you save here.
      </div>` : ''}

      <div class="field">
        <label>Provider</label>
        <div class="hero-sugg tight">
          ${providers.map((p) => {
            // A CLI option that is not installed is still offered, greyed and
            // labelled, rather than hidden. Hiding it answers "why can I not
            // use my Claude Code session" with silence; saying "not found on
            // this machine" answers it with the reason.
            const cliState = cliFor(p.id);
            const missing = cliState !== null && !cliState.found;
            return `<button type="button" class="pill${p.id === d.provider ? ' on' : ''}${missing ? ' faded' : ''}" data-prov="${esc(p.id)}">${esc(p.label)}${missing ? ' · not found' : ''}</button>`;
          }).join('')}
        </div>
        ${cliNote(d.provider)}
      </div>

      ${cli ? `
      <div class="field">
        <label for="cModel">Model</label>
        <input id="cModel" type="text" spellcheck="false" list="cModelList" value="${esc(d.model)}"
               placeholder="${esc(chosen?.models?.[0] ?? 'leave blank for its default')}">
        ${chosen?.models?.length ? `<datalist id="cModelList">${chosen.models.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>` : ''}
        <span class="note">${esc(chosen?.note ?? '')}</span>
      </div>

      <div class="field">
        <label class="check"><input id="cRedact" type="checkbox"${d.redactNames ? ' checked' : ''}>
          <span>Send <code>@ana</code> instead of employee names</span></label>
        <span class="note">Sent: your sentence, your role names, your staff list.
          Never: prompts, the log, your policy. Judging stays here.</span>
      </div>
      ` : ''}

      ${remote ? `
      <div class="grid2">
        <div class="field">
          <label for="cBase">Endpoint</label>
          <input id="cBase" type="text" spellcheck="false" value="${esc(d.baseUrl)}" placeholder="https://…/v1">
        </div>
        <div class="field">
          <label for="cModel">Model</label>
          <input id="cModel" type="text" spellcheck="false" list="cModelList" value="${esc(d.model)}"
                 placeholder="${esc(chosen?.models?.[0] ?? 'model name')}">
          ${chosen?.models?.length ? `<datalist id="cModelList">${chosen.models.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>` : ''}
        </div>
      </div>

      <div class="field">
        <label for="cKey">API key</label>
        <input id="cKey" type="password" spellcheck="false" autocomplete="off" value=""
               placeholder="${c.hasKey ? `saved ${esc(c.keyHint)} — leave blank to keep it` : 'paste your key'}">
        <span class="note">${chosen?.note ? `${esc(chosen.note)}. ` : ''}Kept on this machine, never shown again.</span>
      </div>

      <div class="field">
        <label class="check"><input id="cRedact" type="checkbox"${d.redactNames ? ' checked' : ''}>
          <span>Send <code>@ana</code> instead of employee names</span></label>
        <span class="note">Sent: your sentence, your role names, your staff list.
          Never sent: employee prompts, the audit log, your policy.</span>
      </div>
      ` : ''}

      <div class="actions">
        ${remote ? '<button type="button" class="btn" id="cTest">Test connection</button>' : ''}
        <button type="button" class="btn primary" id="cSave">Save</button>
        ${t ? `<span class="note ${t.ok ? 'good' : 'bad'}">${
          t.saved ? 'Saved.'
          : t.ok ? `Answered in ${t.ms} ms.`
          : esc(String(t.error ?? `HTTP ${t.status}`).slice(0, 160))}</span>` : ''}
      </div>
    </div>
  </div>`;
}

function bindCompiler() {
  const d = compilerDraft();
  const providers = state.compiler?.providers ?? [];

  /**
   * Switching provider rewrites the endpoint and model boxes, and has to say so
   * explicitly.
   *
   * `render()` restores every field by id *after* replacing the pane, which is
   * right while someone is typing and wrong when the re-render is happening
   * *because* the values changed: the new provider's endpoint went into the
   * HTML and was immediately overwritten with the old one. The page then showed
   * Google selected next to `api.anthropic.com`, which is not a cosmetic
   * disagreement — it is the wrong host in the box that decides where the staff
   * list gets sent. `adopt` marks the one render that must win over the restore,
   * and `bindCompiler` runs after it.
   */
  if (d.adopt) {
    const base = document.getElementById('cBase');
    const model = document.getElementById('cModel');
    if (base) base.value = d.baseUrl;
    if (model) model.value = d.model;
    delete d.adopt;
  }

  for (const b of document.querySelectorAll('[data-prov]')) {
    b.onclick = () => {
      const next = providers.find((p) => p.id === b.dataset.prov);
      // Adopts that provider's own endpoint and first model, so the common case
      // is one click. It does not clear a typed key — changing the model of the
      // same provider is the other common case.
      state.compilerDraft = {
        ...d,
        provider: b.dataset.prov,
        baseUrl: next?.baseUrl ?? '',
        model: next?.models?.[0] ?? '',
        adopt: true
      };
      state.compilerTest = null;
      render();
    };
  }

  const readForm = () => ({
    provider: d.provider,
    baseUrl: document.getElementById('cBase')?.value.trim() ?? '',
    model: document.getElementById('cModel')?.value.trim() ?? '',
    apiKey: document.getElementById('cKey')?.value ?? '',
    redactNames: Boolean(document.getElementById('cRedact')?.checked)
  });

  const test = document.getElementById('cTest');
  if (test) test.onclick = async () => {
    state.compilerDraft = readForm();
    test.disabled = true;
    test.textContent = 'Testing…';
    const { j } = await api('/api/settings/compiler/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.compilerDraft)
    }).catch(() => ({ j: { ok: false, error: 'could not reach Warden' } }));
    state.compilerTest = j;
    render();
  };

  const save = document.getElementById('cSave');
  if (save) save.onclick = async () => {
    state.compilerDraft = readForm();
    save.disabled = true;
    save.textContent = 'Saving…';
    const { ok, j } = await api('/api/settings/compiler', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.compilerDraft)
    }).catch(() => ({ ok: false, j: { error: 'could not reach Warden' } }));
    if (!ok) {
      state.compilerTest = { ok: false, error: j?.error ?? 'could not save' };
      render();
      return;
    }
    await refreshCompiler();
    state.compilerDraft = null;
    state.compilerTest = { ok: true, saved: true };
    render();
    // Clear the key box by hand. `restoreFields` reinstates form values across
    // a re-render, which is right for every other field and wrong for this one:
    // dropping the draft is not enough to get the secret back out of the DOM,
    // and the placeholder already says a key is saved and shows its last four.
    const box = document.getElementById('cKey');
    if (box) box.value = '';
  };
}

/** One line in the composer saying who is about to write the rule. */
/**
 * What the gateway found when it looked for this CLI, or null if this provider
 * is not one. `cliTools` is absent on a gateway older than the route that
 * reports it, which reads as "no claim either way" and shows nothing.
 */
const CLI_TOOL_OF = {
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'opencode-cli': 'opencode',
  'cursor-cli': 'cursor-agent',
  'copilot-cli': 'copilot'
};

function cliFor(providerId) {
  const tool = CLI_TOOL_OF[providerId];
  if (!tool) return null;
  return (state.compiler?.cliTools ?? []).find((t) => t.tool === tool) ?? null;
}

/** The one line under the picker that says whether the chosen CLI is there. */
function cliNote(providerId) {
  const found = cliFor(providerId);
  if (!found) return '';
  return found.found
    ? `<span class="note good">Found on this machine. It will use the session you are already signed in to, with no API key.</span>`
    : `<span class="note bad">Not found on this machine. Install <span class="mono">${esc(found.tool)}</span> and sign in, then reopen this page.</span>`;
}

function compilerLine() {
  const c = state.compiler;
  if (!c) return '';
  const remote = c.activeSource !== 'local';
  const where = remote
    ? `${esc(c.model || 'a remote model')} · off this machine`
    : `${esc(c.localModel ?? 'local model')} · on this machine`;
  return `<div class="note compiler-line">Drafting with ${where}
    <button type="button" class="linkish" data-go="compiler">Change</button></div>`;
}

/** The switch between the two, at the top of the column in both. A dot on the
 *  New rule side when a draft is waiting there — leaving the tab does not
 *  throw the conversation away. */
function rulesTabs(right = '') {
  const on = onNewRule();
  return `<div class="toolbar">
    <span class="seg">
      <button type="button" class="${on ? 'on' : ''}" data-go="policy" data-sel="new">New rule${!on && state.draft ? ' •' : ''}</button>
      <button type="button" class="${on ? '' : 'on'}" data-go="policy">Rules</button>
    </span>
    <span class="spacer"></span>
    ${right}
  </div>`;
}

/** The policy you have. */
function rulesBody() {
  return `<div class="sheet">
    ${rulesTabs(`
      <button type="button" class="btn" data-go="simulator">Try a prompt</button>`)}

    ${state.policy.rules.length
      ? state.policy.rules.map(ruleRow).join('')
      : '<div class="empty"><b>Warden is enforcing nothing yet</b><span>Warden only stops what the policy says to stop, and the policy is empty. Write the first rule under New rule.</span></div>'}

    ${state.policy.rules.length ? `<div class="row-actions">
      <button type="button" class="btn quiet" id="clearSample">Take out what came with Warden</button>
      <button type="button" class="btn quiet danger" id="wipeRules">Delete every rule</button>
    </div>` : ''}

    <div class="section">
      <div class="label">Limits by role</div>
      ${limitsGrid()}
      <div class="note">Token counts are reported by the tool, not measured here.</div>
    </div>
  </div>`;
}

/** Compact number for a ceiling: 500000 -> 500k. Ceilings are round by nature. */
function tokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * One role's ceilings.
 *
 * A role with no token ceiling says so rather than showing a bar at zero — an
 * empty bar reads as "plenty left", which is the opposite of "nobody is
 * counting".
 */
function quotaCard(q) {
  const rows = [`<div class="quota-row"><span>requests</span><b>${q.maxRequestsPerDay}/day</b></div>`];
  if (q.maxSessionOutputTokens) {
    rows.push(`<div class="quota-row"><span>output</span><b>${tokens(q.maxSessionOutputTokens)}/session</b></div>`);
  }
  if (q.maxContextTokens) {
    rows.push(`<div class="quota-row"><span>context</span><b>${tokens(q.maxContextTokens)}</b></div>`);
  }
  if (!q.maxSessionOutputTokens && !q.maxContextTokens) {
    rows.push('<div class="quota-row unmetered"><span>tokens</span><b>no limit</b></div>');
  }
  return `<button type="button" class="quota" data-quota="${esc(q.role)}">
    <span class="quota-role">${esc(q.role)}</span>${rows.join('')}</button>`;
}

/**
 * Every role, with or without a limit, and one of them possibly open for edit.
 *
 * Both halves of that matter. The grid used to render `policy.quotas`, so a
 * role that had never been given a limit was simply absent — which reads as
 * "this role does not exist" rather than "nobody is counting what it spends",
 * and left no way to give it one. And every card was static text: a limit could
 * be set at the moment a role was created and never again, so an administrator
 * who typed 20 and meant 200 had to delete the role, which deletes the people
 * standing in it.
 */
function limitsGrid() {
  const all = state.company.roles ?? [];
  const byRole = new Map(state.policy.quotas.map((q) => [q.role, q]));
  const roles = all.length ? all : state.policy.quotas.map((q) => q.role);
  if (!roles.length) return '<div class="note">No roles yet.</div>';

  return `<div class="quota-grid">${roles.map((role) => {
    if (state.quotaEdit === role) return quotaEditor(byRole.get(role) ?? { role });
    const q = byRole.get(role);
    return q
      ? quotaCard(q)
      : `<button type="button" class="quota none" data-quota="${esc(role)}">
          <span class="quota-role">${esc(role)}</span>
          <div class="quota-row unmetered"><span>requests</span><b>no limit</b></div>
        </button>`;
  }).join('')}</div>`;
}

/**
 * One role's limits, open.
 *
 * Blank means no limit, in all three boxes, because that is the same sentence
 * the policy stores — a role with no quota row is the unmetered case, and
 * giving "no limit" a second spelling (0, or an unchecked box) would put two
 * representations of one state into a file that is hashed.
 */
function quotaEditor(q) {
  // `step="1"` on the token boxes, not the round 1000 that reads better. With
  // `min="1"`, a step of 1000 makes the valid values 1, 1001, 2001… so 250000
  // is invalid and the browser refuses the submit — with a tooltip, no error,
  // and no request. Caught in a browser; it cannot be caught by reading.
  return `<form class="quota editing" id="quotaForm" data-role="${esc(q.role)}">
    <span class="quota-role">${esc(q.role)}</span>
    <label class="quota-row"><span>requests</span>
      <input type="number" min="1" step="1" id="qDay" value="${q.maxRequestsPerDay ?? ''}" placeholder="none"></label>
    <label class="quota-row"><span>output</span>
      <input type="number" min="1" step="1" id="qOut" value="${q.maxSessionOutputTokens ?? ''}" placeholder="none"></label>
    <label class="quota-row"><span>context</span>
      <input type="number" min="1" step="1" id="qCtx" value="${q.maxContextTokens ?? ''}" placeholder="none"></label>
    ${state.quotaError ? `<div class="note bad">${esc(state.quotaError)}</div>` : ''}
    <div class="quota-actions">
      <button type="submit" class="btn primary">Save</button>
      <button type="button" class="btn" id="qCancel">Cancel</button>
    </div>
  </form>`;
}

/**
 * What to say when a compile fails, which depends entirely on why.
 *
 * There used to be one line for both cases and it ended "Try saying it more
 * plainly." That is fine advice for a sentence the 1.7B could not turn into a
 * rule, and it is useless when the gateway reports that its RPC never came up
 * after 30 seconds: the sentence was never the problem, and somebody rewriting
 * "no filtrar datos de clientes" for the fourth time is being sent in a circle
 * by their own tool. The server tags which kind it is.
 *
 * The infra case gets the two things that actually move it: where the log is,
 * and the fact that a signed-in Claude Code or Codex compiles rules without the
 * local model running at all.
 */
function compileFailure(j) {
  const why = esc(j?.error ?? 'the model did not answer');
  if (j?.kind !== 'model-down') {
    return `I could not compile that: ${why}. Try saying it more plainly.`;
  }
  return `<b>The local model is not running.</b> ${why}.
    <div>Rewording will not help. <button type="button" class="linkish" id="showLog">Show me the gateway log</button>, which is where the reason is.</div>
    <div>If you have Claude Code or Codex signed in, <button type="button" class="linkish" data-go="compiler">point the compiler at it</button> and rules compile without the local model.</div>`;
}

/**
 * The two ways to get rid of rules you did not write.
 *
 * They answer different questions and that is why there are two of them. "Take
 * out what came with Warden" removes only rows that match the files we ship, so
 * a policy somebody has been building keeps everything they built; it is the
 * boot migration, run on request, for the installs the migration itself will
 * not touch because naming your company cleared the flag it reads. "Delete
 * every rule" is the blunt one, and it asks first.
 */
/**
 * Pull the log into the page rather than sending somebody to a menu.
 *
 * 200 lines, in a scroll box, selectable, because the next thing that happens
 * is that they paste it to whoever is going to read it.
 */
function bindLogPeek() {
  const btn = $('showLog');
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    const { ok, j } = await api('/api/gateway/log');
    btn.replaceWith(Object.assign(document.createElement('div'), {
      className: 'code',
      textContent: ok ? (j.lines ?? []).join('\n') : (j.error ?? 'could not read the log')
    }));
  };
}

function bindSweeps() {
  bindLogPeek();
  const clear = $('clearSample');
  if (clear) clear.onclick = async () => {
    clear.disabled = true;
    const { ok, j } = await api('/api/company/sample/clear', { method: 'POST' });
    clear.disabled = false;
    if (!ok) return;
    await Promise.all([refreshPolicy(), refreshPeople()]);
    render();
    // Nothing matched, so say that rather than leaving a button that looks
    // broken: the policy is already all theirs.
    if (!j.people && !j.rules && !j.quotas) {
      clear.insertAdjacentHTML('afterend',
        '<span class="note">Nothing here came with Warden. Every rule and person is yours.</span>');
    }
  };

  const wipe = $('wipeRules');
  if (wipe) wipe.onclick = async () => {
    const n = state.policy.rules.length;
    if (!confirm(`Delete all ${n} rules? Warden will stop nothing until you write another. Limits by role are kept.`)) return;
    wipe.disabled = true;
    await api('/api/policy/rules', { method: 'DELETE' });
    await Promise.all([refreshPolicy(), refreshPeople()]);
    render();
  };
}

/**
 * Opening, saving and closing one role's limits.
 *
 * The save goes through the policy like any other ratified change — quotas are
 * inside the policy hash, so raising a ceiling re-versions the policy and lands
 * in the audit trail. That is the reason this is a form with a Save rather than
 * a field that writes as you type: an administrator changing what their team is
 * allowed to spend should have to mean it.
 */
function bindLimits() {
  const grid = document.querySelector('.quota-grid');
  if (grid) grid.onclick = (e) => {
    const card = e.target.closest('[data-quota]');
    if (!card) return;
    state.quotaEdit = card.dataset.quota;
    state.quotaError = '';
    render();
  };

  const form = $('quotaForm');
  if (!form) return;

  const cancel = $('qCancel');
  if (cancel) cancel.onclick = () => { state.quotaEdit = null; state.quotaError = ''; render(); };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const num = (id) => {
      const raw = $(id)?.value.trim();
      return raw ? Number(raw) : null;
    };
    const role = form.dataset.role;
    const { ok, j } = await api(`/api/quotas/${encodeURIComponent(role)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maxRequestsPerDay: num('qDay'),
        maxSessionOutputTokens: num('qOut'),
        maxContextTokens: num('qCtx')
      })
    });
    if (!ok) {
      state.quotaError = j.error ?? 'could not save that limit';
      return render();
    }
    state.quotaError = '';
    state.quotaEdit = null;
    await refreshPolicy();
    render();
  };
}

/** The conversation before it starts: tabs pinned at the top, the composer
 *  centred in whatever is left, the way an empty chat sits on the screen. */
function newRulePage() {
  return `<div class="blank">
    <div class="sheet">${rulesTabs()}</div>
    <div class="blank-fill">${heroComposer()}</div>
  </div>`;
}

/**
 * The composer, at the size the thing deserves.
 *
 * A question rather than a page title, one box wide enough for a sentence, the
 * send control inside it, and suggestions that are shortcuts rather than
 * decoration. The categories stay collapsed until you pick one, so the default
 * state is a question and a box and nothing else.
 */
/**
 * An empty policy is a real state, and on a fresh install it is the first thing
 * anyone sees. It must not look like a page that failed to load, and the honest
 * thing to say is also the best explanation of the product: there are no rules,
 * therefore nothing is being stopped.
 */
function emptyPolicyBanner() {
  if (state.policy.rules.length) return '';
  return `<div class="banner warn">
    <b>Your policy is empty, so right now Warden lets everything through.</b>
    It only stops what you tell it to stop, so write the first rule below or take one from the catalogue.
  </div>`;
}

/**
 * Demo mode, and the way out of it.
 *
 * It used to say only what was true — "these decisions did not come from a
 * real model" — and stop there, which names the problem and leaves you in it.
 * Somebody who installs the app, lands in demo mode and reads that banner has
 * been told the product is not working and given nothing to do about it; the
 * exit existed and was a tray menu item, which is not where anyone looks.
 *
 * Both paths, because the console is served to whoever opened it: the desktop
 * app, where the fix is a menu item, and a checkout, where it is one command.
 */
/**
 * A genuinely fresh install: nobody in the directory, nothing in the policy.
 *
 * The product used to fill both in for you — every install opened as Northwind
 * Logistics SA with seven people who do not exist and eight rules nobody wrote
 * — and the way out was a Company block on a tab the console does not open on.
 * Nothing is seeded now, so this is what the first screen looks like, and it
 * says the two things that are true about it: nothing is being stopped yet,
 * and the sample is here if you want to look around first.
 *
 * It disappears the moment either half stops being empty, so it cannot become
 * furniture.
 */
function firstRunBanner() {
  if (state.company.employees.length || state.policy.rules.length) return '';
  return `<div class="banner">
    <b>Warden is not stopping anything yet.</b> Write a rule on
    <button type="button" class="linkish" data-go="policy" data-sel="new">Rules</button>,
    or add people on <button type="button" class="linkish" data-go="people">Team</button>.
    <div class="chips">
      <button type="button" class="btn" id="loadSample">Load the sample company instead</button>
    </div>
  </div>`;
}

/**
 * Demo mode, and the way out of it.
 *
 * The way out used to be a sentence pointing at `Gateway → Download models` in
 * the menu bar. People did not find it, which is what happens to an action
 * three levels inside a submenu nobody opens, and the report was "I can't see
 * where to download the models". The action belongs where the sentence about it
 * already is.
 *
 * In a browser against a checkout there is no shell to do the downloading, so
 * there is no button there: the command is the honest offer.
 */
function mockBanner() {
  return `<div class="banner warn">
    <b>Demo mode: nothing here is real.</b> No model has judged anything on this screen.
    ${state.canLeaveDemo
      ? `<div class="banner-act">
           <button type="button" class="btn primary" id="getModels">Download the models</button>
           <span class="note">About 1.8&nbsp;GB, once. Warden restarts when they land.</span>
         </div>`
      : '<div class="note">Run <span class="mono">pnpm run setup</span>. About 1.8&nbsp;GB, once.</div>'}
  </div>`;
}

function heroComposer() {
  const cat = state.presetCat == null ? null : state.presets[state.presetCat];
  return `<div class="hero">
    ${emptyPolicyBanner()}
    <h2 class="hero-q">What should Warden stop?</h2>

    <div class="hero-box">
      <textarea id="ruleMsg" rows="2" placeholder="Describe it the way you would to a colleague…"></textarea>
      <button type="button" class="btn primary send" id="ruleSend">Write it</button>
    </div>

    ${compilerLine()}

    <div class="hero-sugg" id="cats">
      ${state.presets.map((c, i) => `
        <button type="button" class="pill${i === state.presetCat ? ' on' : ''}" data-cat="${i}">${esc(c.label ?? c.category)}</button>`).join('')}
    </div>

    ${cat ? `<div class="hero-sugg" id="presetList">
      ${(cat.rules ?? []).map((r, k) => `
        <button type="button" class="pill wrap" data-preset="${state.presetCat}" data-r="${k}">${esc(clip(r.text, 90))}</button>`).join('')}
    </div>` : ''}
  </div>`;
}

function ruleRow(r) {
  const open = state.sel === r.id;
  return `<button type="button" class="row roomy${open ? ' on' : ''}" data-toggle="policy" data-sel="${attr(r.id)}" aria-expanded="${open}">
      <span class="dot ${esc(r.severity)}"></span>
      <span class="col">
        <span class="t">${esc(ruleName(r))}</span>
        <span class="m2">${esc(r.text)}</span>
        <span class="m">
          <span class="badge ${esc(r.severity)}">${esc(r.severity)}</span>
          <span>${esc(audienceLabel(r.appliesTo))}</span>
          ${r.pinned ? '<span class="badge">always checked</span>' : ''}
          ${isPersonal(r) ? '<span class="badge">personal</span>' : ''}
        </span>
      </span>
    </button>
    ${open ? ruleDetail(r) : ''}`;
}

function ruleDetail(rule) {
  const hits = state.audit.filter((a) => (a.decision?.firedRules ?? []).some((r) => r.ruleId === rule.id));
  const guidance = hits[0]?.decision.firedRules.find((r) => r.ruleId === rule.id)?.guidance;
  const blocked = hits.filter((h) => h.decision?.verdict !== 'ALLOW').length;
  // How many of those the person on the other end said were wrong. This is the
  // only false-positive signal the console actually has: in the audit log a
  // correct block and an incorrect one are the same record. Counting how much
  // a rule catches without counting what it costs makes every rule look good.
  const disputed = state.appeals.filter((a) => a.ruleId === rule.id);

  // An active rule is an object you consult, not a decision you take, so it
  // gets the property-list shape rather than the draft's decide-first one.
  return `<div class="detail">
    <p class="summary">${esc(rule.text)}</p>

    <div class="kv">
      <div class="r"><span class="k">If it fires</span><span class="v"><span class="badge ${esc(rule.severity)}">${esc(rule.severity)}</span>
        ${severityMeans(rule.severity)}</span></div>
      <div class="r"><span class="k">Applies to</span><span class="v">${esc(audienceLabel(rule.appliesTo))}</span></div>
      <div class="r"><span class="k">Checked</span><span class="v">${rule.pinned ? 'on every request' : 'when the request looks related'}</span></div>
      ${guidance ? `<div class="r"><span class="k">Told instead</span><span class="v">“${esc(guidance)}”</span></div>` : ''}
    </div>

    <div class="evidence">
      <div class="top">
        <span class="badge${disputed.length ? ' BLOCK' : ''}">${blocked} / ${hits.length}</span>
        <b>${hits.length
          ? `Stopped ${blocked} of the ${hits.length} requests it looked at`
          : 'This rule has not fired yet'}</b>
      </div>
      ${hits.length ? `<div class="body">
        ${disputed.length
          ? `<div class="note bad">${plural(disputed.length, 'of those was', 'of those were')} reported as wrong by the person it stopped.</div>`
          : '<div class="note">Nobody has reported one of these as wrong.</div>'}
        <div class="chips">
          <button type="button" class="btn" data-go="activity" data-q="rule=${attr(rule.id)}">See those decisions</button>
          ${disputed.length ? '<button type="button" class="btn" data-go="inbox">See the reports</button>' : ''}
        </div>
      </div>` : ''}
    </div>

    <div class="folds">
      ${rule.examples ? disclosure('r:examples', 'Examples it was checked against', `
        <div class="label">Would be stopped</div>
        ${(rule.examples.violating ?? []).map((x) => `<div class="note">· ${esc(x)}</div>`).join('') || '<div class="note">—</div>'}
        <div class="label">Must still go through</div>
        ${(rule.examples.compliant ?? []).map((x) => `<div class="note">· ${esc(x)}</div>`).join('') || '<div class="note">—</div>'}`) : ''}
      ${disclosure('r:id', 'Technical record', `<div class="kv">
        <div class="r"><span class="k">Rule id</span><span class="v mono">${esc(rule.id)}</span></div>
        <div class="r"><span class="k">Scope</span><span class="v">${esc(rule.scope ?? '—')}</span></div>
      </div>`)}
    </div>

    <div><button type="button" class="btn danger" id="delRule" data-id="${attr(rule.id)}">Remove rule</button></div>
  </div>`;
}

// ── the conversation ─────────────────────────────────────────────────────────
//
// Writing a rule is iterative: you say it, you see what it would have done, you
// narrow it. The old form could not express that — every reword was a fresh
// compile that threw away what you had learned. Here the check is a turn in the
// conversation rather than a button, and the rule being built is a card inside
// the conversation rather than a pane the conversation points at.

/** Once the first message is sent the hero collapses: the box docks to the
 *  bottom and the turns take the space it was holding. */
function ruleChatPane() {
  return `<div class="chatwrap">
    <div class="chat" id="ruleChat">
      <div class="sheet">
        ${rulesTabs('<button type="button" class="btn quiet" id="cancelDraft">Start over</button>')}
        ${state.ruleChat.map(renderTurn).join('')}
        ${state.draft ? draftCard() : ''}
      </div>
    </div>
    <div class="composer">
      <div class="sheet">
        <div class="hero-box">
          <textarea id="ruleMsg" rows="2" placeholder="${state.draft
            ? 'Tell Warden how to change it…'
            : 'Describe the rule in your own words…'}"></textarea>
          <button type="button" class="btn primary send" id="ruleSend"${state.ruleBusy ? ' disabled' : ''}>${state.ruleBusy ? 'Working…' : 'Send'}</button>
        </div>
      </div>
    </div>
  </div>`;
}

function renderTurn(t) {
  if (t.from === 'you') {
    return `<div class="msg"><div class="who">You</div><div class="say">${esc(t.text)}</div></div>`;
  }
  return `<div class="msg">
    <div class="who">Warden</div>
    <div class="say${t.pending ? ' pending' : ''}">${t.html ?? esc(t.text)}</div>
  </div>`;
}

/** The rule as it stands, inside the conversation. Only the current draft is
 *  rendered, so there is never a stale card with a live Activate button. */
/**
 * The draft, ordered by the decision you came to make.
 *
 * What the rule says, whether the check found anything, activate. Everything
 * else folds. Inside a conversation this card is a message, not a page, and a
 * message you have to scroll through to find a button is the wrong shape.
 *
 * The one exception to folding: when the check found a false positive, that
 * fold opens itself. It is the only reason not to activate, so it is never
 * something you have to go looking for.
 */
function draftCard() {
  const d = state.draft;
  const locked = Boolean(state.draftFor);
  const p = state.preview;

  // In demo mode the check ran on the stand-in, which judges nothing, so the
  // counts underneath it are not findings about this rule and must not be
  // dressed as them. A person evaluating Warden with no models downloaded was
  // being told their rule missed two of its own examples — a criticism produced
  // by a test double, of a rule a test double wrote. The honest line is the one
  // that says so and points at the download.
  const verdict = state.mock
    ? `<div class="verdict-line"><span class="dot"></span>
        <b>Not checked.</b>
        <span>No model is installed, so nothing on this card was judged.</span></div>`
    : !p
    ? '<div class="verdict-line"><span class="dot"></span><span>Not checked yet.</span></div>'
    : p.falsePositives > 0
      ? `<div class="verdict-line"><span class="dot BLOCK"></span>
          <b>${plural(p.falsePositives, 'legitimate request')} would be blocked.</b>
          <span>Reword it before activating.</span></div>`
      : p.misses > 0
        ? `<div class="verdict-line"><span class="dot ESCALATE"></span>
            <b>${plural(p.misses, 'example')} it should have caught slipped through.</b>
            <span>Worth being more specific.</span></div>`
        : `<div class="verdict-line"><span class="dot ALLOW"></span>
            <b>Checked against ${plural(p.rows.length, 'request')}.</b>
            <span>None of them would be wrongly stopped.</span></div>`;

  const checkRows = p ? p.rows.map((r) => `
    <div class="preview-row${r.isFalsePositive ? ' fp' : ''}">
      <span class="v ${esc(r.verdict)}">${esc(r.verdict)}</span>
      <span class="p">${esc(r.prompt)}</span>
      ${r.source === 'log' ? '<span class="badge">real</span>' : ''}
      ${r.isFalsePositive ? '<span class="badge block">wrongly stopped</span>' : ''}
      ${r.isMiss ? '<span class="badge escalate">missed</span>' : ''}
    </div>`).join('') : '';

  return `<div class="artifact">
    <div class="detail-head">
      <span class="badge ${esc(d.severity)}">${esc(d.severity)}</span>
      ${
        // Who wrote this, at the moment it is about to bind people. The
        // composer says it before you type, but by the time the Activate button
        // is on screen the composer is gone — and this is the point where it
        // matters whether the sentence came off this machine.
        d.draftedBy
          ? `<span class="when">written by ${esc(d.draftedBy)}${d.draftedRemotely ? ' · off this machine' : ''}</span>`
          : ''
      }
      <span class="when">not active yet</span>
      ${state.drafts.length
        ? `<span class="when">${plural(state.drafts.length, 'more')} from that instruction</span>`
        : ''}
    </div>

    <p class="summary">${esc(d.text)}</p>

    ${verdict}

    <div class="kv">
      <div class="r">
        <span class="k">Applies to</span>
        <span class="v">${esc(audienceLabel(d.appliesTo))}${locked
          ? ' · locked, you started this from their page'
          : `<button type="button" class="btn sm" id="editAudience">${state.audienceOpen ? 'Done' : 'Change'}</button>`}</span>
      </div>
    </div>
    ${!locked && state.audienceOpen ? '<div class="chips" id="audienceChips"></div>' : ''}

    <div class="chips">
      <button type="button" class="btn primary" id="ratifyBtn"${state.ruleBusy ? ' disabled' : ''}>Activate</button>
      <button type="button" class="btn quiet" id="dropBtn">Discard</button>
    </div>

    <div class="folds">
      ${p ? disclosure('n:check', `The ${plural(p.rows.length, 'request')} it was checked against`, checkRows) : ''}
      ${d.guidance ? disclosure('n:told', 'What the employee is told instead', `<div class="banner">${esc(d.guidance)}</div>`) : ''}
      ${disclosure('n:examples', 'Examples Warden wrote for it', `
        <div class="label">Would be stopped</div>
        ${(d.examples?.violating ?? []).map((x) => `<div class="note">· ${esc(x)}</div>`).join('')}
        <div class="label">Must still go through</div>
        ${(d.examples?.compliant ?? []).map((x) => `<div class="note">· ${esc(x)}</div>`).join('')}`)}
    </div>
  </div>`;
}

function say(html, pending = false) {
  state.ruleChat.push({ from: 'warden', html, pending });
}

function dropPending() {
  state.ruleChat = state.ruleChat.filter((t) => !t.pending);
}

async function sendRuleMessage(text) {
  const clean = String(text ?? '').trim();
  if (!clean || state.ruleBusy) return;

  state.ruleChat.push({ from: 'you', text: clean });
  state.ruleBusy = true;
  const box = $('ruleMsg');
  if (box) box.value = '';
  say('Compiling it on the local model…', true);
  // Sending from the rules list (or from a person's page) is what opens the
  // conversation — there is no button that does it separately.
  if (composing()) render(); else go('policy', 'new');

  // The compiler has no notion of a conversation, so a refinement is sent as
  // the current rule plus the correction. Restating the rule is what keeps the
  // second turn from being read as a brand new one.
  const body = state.draft
    ? { text: `${state.draft.text}\n\nChange it as follows: ${clean}` }
    : { text: clean };
  if (state.draftFor) body.lockTo = [`@${state.draftFor}`];

  const { ok, j } = await api('/api/policy/draft', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  dropPending();
  if (!ok) {
    state.ruleBusy = false;
    say(compileFailure(j));
    render();
    return;
  }

  state.draft = j;
  state.preview = null;
  const n = (j.examples?.violating?.length ?? 0) + (j.examples?.compliant?.length ?? 0);
  say(`Here it is. It ${severityVerb(j.severity)} matching requests for <b>${esc(audienceLabel(j.appliesTo))}</b>. Let me check it against the ${n} examples I wrote.`);
  render();

  await runPreview();
}

/**
 * One button, and the console works out what you meant.
 *
 * There were two: "Write it" for a sentence, and "Write the set" for a worry.
 * That is a real distinction in `compile.ts` and it is not the administrator's
 * to make — they typed a sentence, and whether it contains one prohibition or
 * three is a question about the sentence, not about which button to press.
 *
 * So the split pass runs whenever the compiler can do it well, and does not
 * when it cannot. On the local 1.7B it returned one statement on three of three
 * inputs and cost thirty seconds to do it, so that model gets the direct path.
 * On a CLI or a configured endpoint it splits correctly and quickly, so those
 * get the pass that makes a policy out of one sentence. Either way a specific
 * sentence still yields exactly one rule; the difference is only whether a
 * broad one is allowed to yield more.
 */
function writeRule(text) {
  const capable = (state.compiler?.provider ?? 'local') !== 'local';
  return capable ? sendRuleSet(text) : sendRuleMessage(text);
}

/**
 * One broad instruction, several rules, ratified one at a time.
 *
 * The compiler splits what you said into the specific prohibitions it means
 * and compiles each of those; what comes back is a queue, not a policy. The
 * first is put on screen and checked exactly like a single draft, and the rest
 * wait — activating one brings up the next. Nothing is written until you press
 * Activate, once per rule, which is the same boundary as everywhere else and
 * the reason this is a queue rather than a list with a "take all" button.
 */
async function sendRuleSet(text) {
  const clean = String(text ?? '').trim();
  if (!clean || state.ruleBusy) return;

  state.ruleBusy = true;
  const box = $('ruleMsg');
  if (box) box.value = '';
  state.ruleChat.push({ from: 'you', text: clean });
  say('Working out what that means, then compiling each part…', true);
  if (composing()) render(); else go('policy', 'new');

  const body = { text: clean };
  if (state.draftFor) body.lockTo = [`@${state.draftFor}`];

  const { ok, j } = await api('/api/policy/draft-set', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });

  dropPending();
  if (!ok || !Array.isArray(j.rules) || j.rules.length === 0) {
    state.ruleBusy = false;
    say(compileFailure(j));
    render();
    return;
  }

  const [first, ...rest] = j.rules;
  state.draft = first;
  state.drafts = rest;
  state.preview = null;
  say(rest.length
    ? `That means ${plural(j.rules.length, 'separate rule')} to me. Here is the first, and the others are behind it, and you activate them one at a time.`
    : 'That was already one specific thing, so it is one rule.');
  render();

  await runPreview();
}

/**
 * The step that keeps a badly-worded rule from reaching anyone.
 *
 * False positives are called out loudly rather than folded into a score,
 * because a rule that blocks legitimate work is the failure that actually
 * costs the company something.
 */
async function runPreview(against = []) {
  state.ruleBusy = true;
  say(against.length
    ? `Replaying ${plural(against.length, 'request')} Warden already allowed, to see if this rule would have stopped them…`
    : 'Checking it…', true);
  render();

  const { ok, j } = await api('/api/policy/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(against.length ? { rule: state.draft, against } : { rule: state.draft })
  });

  dropPending();
  state.ruleBusy = false;
  if (!ok) { say(`The check failed: ${esc(j.error ?? 'unknown error')}`); render(); return; }

  state.preview = j;
  // Anything the check found — a legitimate request wrongly stopped, or a
  // violation that slipped through — is a reason to look at the rows, so the
  // fold opens itself rather than waiting to be found. A clean check stays shut.
  if (j.falsePositives > 0 || j.misses > 0) state.open.add('n:check');
  else state.open.delete('n:check');
  const logFps = j.rows.filter((r) => r.source === 'log' && r.isFalsePositive);

  if (state.mock) {
    // Same reason as the verdict line above: no model ran, so there is nothing
    // to report except that.
    say('No model is installed, so nothing was actually checked. The rows below came from the demo stand-in. Download the models and the check becomes real.');
    render();
    return;
  }

  if (j.falsePositives > 0) {
    say(`<b>${plural(j.falsePositives, 'legitimate request')} would be blocked by this.</b>
      ${logFps.length ? `${logFps.length} of them actually went through the gateway before. ` : ''}
      They are marked below. Tell me how to narrow it — “only for sales”, or “not when it is their own data”.`);
  } else if (j.misses > 0) {
    say(`No false positives, but ${plural(j.misses, 'example')} it should have caught slipped through. Worth being more specific about what you mean.`);
  } else if (against.length) {
    say('None of those real requests would have been stopped. This one looks safe to activate.');
  } else {
    say(`Clean against its own examples. ${offerRegression()}`);
  }
  render();
}

function offerRegression() {
  const n = regressionSample().length;
  if (!n) return 'Activate it below when you are happy with it.';
  return `Before you activate it, I can replay the last ${n} requests Warden allowed and see whether this rule would have stopped any of them.
    <button type="button" class="btn sm" id="regressBtn">Replay ${n} real requests</button>`;
}

const regressionSample = () => state.audit
  .filter((a) => a.decision?.verdict === 'ALLOW' && a.decision.maskedPrompt)
  .slice(0, REGRESSION_SAMPLE);

function bindPolicy() {
  const del = $('delRule');
  if (del) del.onclick = async () => {
    if (!confirm('Remove this rule? It stops binding everyone immediately.')) return;
    await api(`/api/policy/rules/${encodeURIComponent(del.dataset.id)}`, { method: 'DELETE' });
    await Promise.all([refreshPolicy(), refreshPeople()]);
    go('policy');
  };

  bindLimits();
  bindSweeps();

  const cancel = $('cancelDraft');
  if (cancel) cancel.onclick = discardDraft;

  const send = $('ruleSend');
  if (send) send.onclick = () => writeRule($('ruleMsg').value);
  const msg = $('ruleMsg');
  if (msg) msg.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) writeRule(msg.value); };

  const cats = $('cats');
  if (cats) cats.onclick = (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    // Picking the lit category again collapses it, so the default state of the
    // page is a question and a box and nothing else.
    const i = Number(chip.dataset.cat);
    state.presetCat = state.presetCat === i ? null : i;
    render();
  };

  const presetList = $('presetList');
  if (presetList) presetList.onclick = (e) => {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    // A preset arrives complete, but it still enters the conversation so it
    // passes the same check as anything written by hand.
    const r = state.presets[Number(btn.dataset.preset)].rules[Number(btn.dataset.r)];
    state.ruleChat.push({ from: 'you', text: r.text });
    state.draft = { ...r, id: `r-preset-${Date.now().toString(36)}` };
    state.preview = null;
    say('Taken from the catalogue. Checking it against its examples.');
    render();
    void runPreview();
  };

  const regress = $('regressBtn');
  if (regress) regress.onclick = () => runPreview(
    regressionSample().map((a) => ({ prompt: a.decision.maskedPrompt, expected: 'ALLOW' }))
  );

  const editAud = $('editAudience');
  if (editAud) editAud.onclick = () => { state.audienceOpen = !state.audienceOpen; render(); };

  renderAudienceChips();

  const drop = $('dropBtn');
  if (drop) drop.onclick = discardDraft;

  const ratify = $('ratifyBtn');
  if (ratify) ratify.onclick = async () => {
    ratify.disabled = true;
    const person = state.draftFor;
    await api('/api/policy/ratify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule: state.draft })
    });
    const id = state.draft.id;
    // The rest of a set is not discarded by activating one of it. The next
    // rule takes the card, gets its own check, and needs its own Activate —
    // which is the whole reason a set is a queue.
    const next = state.drafts.shift();
    if (next) {
      state.draft = next;
      state.preview = null;
      state.ruleBusy = false;
      await refreshPolicy();
      say(`Activated. Next in the set — ${plural(state.drafts.length + 1, 'rule')} left.`);
      render();
      void runPreview();
      return;
    }
    resetDraft();
    await Promise.all([refreshPolicy(), refreshPeople()]);
    if (person) go('people', person); else go('policy', id);
  };

}

function resetDraft() {
  state.draft = null;
  state.drafts = [];
  state.draftFor = null;
  state.preview = null;
  state.ruleChat = [];
  state.ruleBusy = false;
}

/** Throws away the conversation and leaves you on a blank one — you came here
 *  to write a rule, so the tab you land on is still the one for writing rules.
 *  Unless you started from someone's page, in which case that is where you were. */
function discardDraft() {
  const person = state.draftFor;
  resetDraft();
  if (person) go('people', person); else go('policy', 'new');
}

/**
 * The audience editor.
 *
 * The model proposes who a rule binds; the admin decides. Getting this wrong in
 * either direction is expensive — too broad and the whole company trips over a
 * rule meant for one team, too narrow and it guards nobody.
 */
function renderAudienceChips() {
  const host = $('audienceChips');
  if (!host || !state.draft) return;
  const on = new Set(state.draft.appliesTo);
  const opts = [
    { token: '*', label: 'Everyone' },
    ...state.company.roles.map((r) => ({ token: r, label: r })),
    ...state.company.employees.map((e) => ({ token: `@${e.id}`, label: e.name }))
  ];
  host.innerHTML = opts
    .map((o) => `<button type="button" class="chip${on.has(o.token) ? ' on' : ''}" data-token="${esc(o.token)}">${esc(o.label)}</button>`)
    .join('');
  host.onclick = (e) => {
    const chip = e.target.closest('[data-token]');
    if (!chip) return;
    const token = chip.dataset.token;
    const next = new Set(state.draft.appliesTo);
    if (token === '*') {
      // "Everyone" is not one audience among many — it subsumes them.
      state.draft.appliesTo = ['*'];
    } else {
      next.delete('*');
      next.has(token) ? next.delete(token) : next.add(token);
      state.draft.appliesTo = next.size ? [...next] : ['*'];
    }
    renderAudienceChips();
  };
}

// ═══ TEAM ════════════════════════════════════════════════════════════════════

/**
 * The company's own name, and the way out of the demo.
 *
 * A fresh install ships a seeded directory — another company's name and seven
 * invented people — because an empty console teaches nobody anything. Until
 * this existed there was no way to leave it: the name in the title bar was not
 * editable and the demo staff could only be deleted one at a time. That reads
 * as a product stuck in a demo, and it was.
 *
 * "Start fresh" keeps one administrator and issues them a new key, because a
 * directory with nobody in an exempt role is a console that cannot be opened
 * again once `WARDEN_ADMIN_REQUIRE_KEY` is set — and because the point of
 * starting over is that the demo's keys stop working. It leaves the policy
 * alone: rules and people are separate decisions.
 */
function companyBlock() {
  const demo = Boolean(state.company.demo);
  return `<div class="section company">
    <div class="label">Company</div>
    ${demo ? `<div class="banner warn">
      <b>Sample data.</b> ${esc(state.company.name)} and everyone below are made up.
    </div>` : ''}
    <div class="chips">
      <input type="text" id="orgInput" class="inline" value="${demo ? '' : esc(state.company.name ?? '')}"
             placeholder="Your company's name">
      <button type="button" class="btn${demo ? ' primary' : ''}" id="orgSave">${demo ? 'This is us' : 'Rename'}</button>
      <span class="spacer"></span>
      <button type="button" class="btn" id="orgReset">${demo ? 'Clear the sample team' : 'Start fresh…'}</button>
    </div>
    <div class="note" id="orgNote">${state.orgNote ? esc(state.orgNote) : ''}</div>
  </div>`;
}

/**
 * Roles for the add-someone dropdown, with `admin` never first.
 *
 * `admin` sits in `exemptRoles`, which means an admin is measured against no
 * rules at all. It is also alphabetically first, so it was the selected option
 * on a fresh install — and the very first person anybody added, before they
 * had read anything about exemptions, was silently unjudgeable. A default that
 * hands out a bypass is the wrong default however defensible the sort order.
 *
 * It stays in the list, because somebody does have to be one. It is last, it
 * says what it costs, and it is never what you get by not choosing.
 */
function roleOptions() {
  const exempt = new Set(state.policy.exemptRoles ?? ['admin']);
  const ordinary = state.company.roles.filter((r) => !exempt.has(r));
  const privileged = state.company.roles.filter((r) => exempt.has(r));
  return [
    ...ordinary.map((r) => `<option value="${attr(r)}">${esc(r)}</option>`),
    ...privileged.map((r) => `<option value="${attr(r)}">${esc(r)} — exempt from every rule</option>`)
  ].join('');
}

VIEWS.people = {
  body: () => `<div class="sheet">
    ${companyBlock()}
    ${state.company.employees.length
      ? state.company.employees.map(personRow).join('')
      : '<div class="empty"><b>Nobody yet</b><span>Add the first person below to issue them a key.</span></div>'}

    <div class="section">
      <div class="label">Add someone</div>
      <div class="chips">
        <input type="text" id="newName" class="inline wide" placeholder="Federico Tavano, Jeremías Souto, Gastón Foncea" autocomplete="off">
        <select class="inline" id="newRole">${roleOptions()}</select>
        <button type="button" class="btn primary" id="addPerson">Add</button>
      </div>
      <div class="note">Commas for several. Enter adds them.</div>
      <div class="note" id="addNote"></div>
    </div>

    <div class="section">
      <div class="label">Roles</div>
      <div class="chips" id="roleChips">
        ${state.company.roles.map((r) => {
          const held = state.company.employees.filter((e) => e.role === r).length;
          return `<span class="chip static" title="${held} employee(s)">${esc(r)} <span class="num">${held}</span>${
            held === 0 ? ` <button type="button" class="linkbtn" data-role="${attr(r)}" aria-label="Remove role ${esc(r)}">✕</button>` : ''}</span>`;
        }).join('')}
      </div>
      <div class="chips">
        <input type="text" id="newRoleName" class="inline" placeholder="New role">
        <input type="number" min="1" id="newRoleQuota" class="inline" placeholder="req/day">
        <button type="button" class="btn" id="addRole">Add role</button>
      </div>
      <div class="note" id="roleNote"></div>
    </div>
  </div>`,
  bind: () => {
    bindPeopleList();
    bindPolicy();
    if (state.sel) void renderPerson(state.sel);
  }
};

function personRow(e) {
  const open = state.sel === e.id;
  return `<button type="button" class="row roomy${open ? ' on' : ''}" data-toggle="people" data-sel="${attr(e.id)}" aria-expanded="${open}">
      ${avatar(e)}
      <span class="col">
        <span class="t">${esc(e.name)}</span>
        <span class="m">
          <span>${esc(e.role)}${e.quota ? ` · ${e.quota}/day` : ''}</span>
          <span>${plural(e.ruleCount, 'rule')}${e.personalRuleCount ? ` · ${e.personalRuleCount} personal` : ''}</span>
        </span>
        <span class="tools">${e.connected?.length
          ? e.connected.map((c) => `<span class="tool on" title="${c.count} request(s), last ${esc(c.at)}">${esc(TOOL_NAMES[c.tool] ?? c.tool)}</span>`).join('')
          : '<span class="tool">not connected yet</span>'}</span>
      </span>
    </button>
    ${open ? '<div class="detail" id="personDetail"><div class="note">loading…</div></div>' : ''}`;
}

function bindPeopleList() {
  const orgSave = $('orgSave');
  if (orgSave) orgSave.onclick = async () => {
    const name = $('orgInput').value.trim();
    if (!name) return;
    const { ok, j } = await api('/api/company', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    });
    state.orgNote = ok ? 'Renamed.' : (j?.error ?? 'could not rename');
    if (ok) await refreshPeople();
    render();
  };

  const orgReset = $('orgReset');
  if (orgReset) orgReset.onclick = async () => {
    const name = $('orgInput').value.trim() || state.company.name;
    // Irreversible and it revokes keys, so it asks. The wording names both
    // consequences rather than asking "are you sure" about nothing in
    // particular.
    const people = state.company.employees.length;
    if (!confirm(
      `Remove ${people === 1 ? 'the 1 person' : `all ${people} people`} and issue the administrator a new key?\n\n` +
      'Their existing keys stop working immediately. Your rules are left alone.'
    )) return;
    const { ok, j } = await api('/api/company/reset', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    });
    state.orgNote = ok ? 'Started fresh. Add your team below.' : (j?.error ?? 'could not reset');
    if (ok) await refreshPeople();
    render();
  };

  /**
   * Adding people, without a round trip per person.
   *
   * This used to take one name and then navigate into that person's page,
   * which is the right screen to end on when you are adding one person and
   * exactly the wrong one when you are setting up a team: eight people meant
   * eight trips back to this form. It now takes a comma-separated list, adds
   * them in order, and stays here with the field cleared and focused — so the
   * whole team is one paste, and one person is still one name and Enter.
   *
   * Sequential rather than concurrent because ids are derived from names and
   * two people called Ana must not race for the same one.
   */
  const addPeople = async () => {
    const field = $('newName');
    const names = field.value.split(',').map((n) => n.trim()).filter(Boolean);
    if (!names.length) return;

    const role = $('newRole').value;
    const added = [];
    const failed = [];
    for (const name of names) {
      const { ok, j } = await api('/api/people', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, role })
      });
      if (ok) added.push(j); else failed.push(`${name}: ${j.error ?? 'failed'}`);
    }

    await refreshPeople();
    if (added.length === 1 && !failed.length) {
      // One person is still the case where their page — and their key — is
      // what you wanted next.
      go('people', added[0].id);
      return;
    }
    render();
    const note = $('addNote');
    if (note) {
      note.textContent = [
        added.length ? `Added ${added.length}, each with a key on their row.` : '',
        ...failed
      ].filter(Boolean).join(' · ');
    }
    const next = $('newName');
    if (next) { next.value = ''; next.focus(); }
  };

  const add = $('addPerson');
  if (add) add.onclick = addPeople;
  const newName = $('newName');
  // Reaching for the mouse after typing a name is the friction you feel every
  // single time; Enter is the whole fix.
  if (newName) newName.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void addPeople(); } };

  for (const id of ['newRoleName', 'newRoleQuota']) {
    const el = $(id);
    if (el) el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('addRole')?.click(); } };
  }

  const addRole = $('addRole');
  if (addRole) addRole.onclick = async () => {
    const role = $('newRoleName').value.trim();
    if (!role) return;
    const { ok, j } = await api('/api/roles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, maxRequestsPerDay: Number($('newRoleQuota').value || 0) })
    });
    if (!ok) { $('roleNote').textContent = j.error ?? 'failed'; return; }
    await Promise.all([refreshPeople(), refreshPolicy()]);
    render();
  };

  const chips = $('roleChips');
  if (chips) chips.onclick = async (e) => {
    const x = e.target.closest('[data-role]');
    if (!x) return;
    const role = decodeURIComponent(x.dataset.role);
    if (!confirm(`Remove the role "${role}"? Its daily limit goes with it.`)) return;
    const { ok, j } = await api(`/api/roles/${encodeURIComponent(role)}`, { method: 'DELETE' });
    if (!ok) { $('roleNote').textContent = j.error ?? 'failed'; return; }
    await Promise.all([refreshPeople(), refreshPolicy()]);
    render();
  };
}

/**
 * One person, opened under their row: who they are, and every rule that will
 * judge them — separated by why it binds them, because "everyone" and "written
 * for you" are very different things to be told when a prompt is refused.
 */
async function renderPerson(id) {
  const p = personById(id);
  const host = $('personDetail');
  if (!host) return;
  if (!p) { host.innerHTML = '<div class="note">This person has been removed.</div>'; return; }

  const { j } = await api(`/api/people/${encodeURIComponent(p.id)}/rules`);
  if (!host.isConnected || state.sel !== id) return;
  const rules = j?.rules ?? [];
  const group = (kind) => rules.filter((r) => r.binding === kind);
  const hits = state.audit.filter((a) => a.actor?.id === p.id);
  const stopped = hits.filter((h) => h.decision?.verdict !== 'ALLOW').length;

  const section = (title, list, note) => `
    <div class="group">
      <div class="label">${title} · ${list.length}</div>
      ${list.length
        ? list.map((r) => `
          <button type="button" class="ruleref" data-go="policy" data-sel="${attr(r.id)}">
            <span class="dot ${esc(r.severity)}"></span>
            <span class="col">
              <span class="t">${esc(ruleName(r))}</span>
              <span class="m">${esc(clip(r.text, 110))}</span>
            </span>
          </button>`).join('')
        : `<div class="note">${note}</div>`}
    </div>`;

  host.innerHTML = `
    <div class="person-top">
      ${avatar(p, true)}
      <div>
        <div class="nm">${esc(p.name)}</div>
        <div class="note">${esc(p.role)}${p.quota ? ` · ${p.quota} requests a day` : ' · no daily limit'}</div>
      </div>
    </div>

    <p class="summary">${hits.length
      ? `Warden has looked at ${plural(hits.length, 'request')} from ${esc(p.name.split(' ')[0])} and stopped ${stopped}.`
      : `${esc(p.name.split(' ')[0])} has not sent anything through Warden yet.`}
      ${plural(rules.length, 'rule')} appl${rules.length === 1 ? 'ies' : 'y'} to them.</p>

    ${hits.length ? '<div class="group"><button type="button" class="btn" id="seePerson">See their decisions</button></div>' : ''}

    <div class="field">
      <label for="editRole">Role</label>
      <select id="editRole">${state.company.roles.map((r) => `<option${r === p.role ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>
    </div>

    <div class="field">
      <label>What they put on their own machine</label>
      <div class="codewrap">
        <pre class="code oneline">export WARDEN_API_KEY=${esc(p.apiKey)}</pre>
        <button type="button" class="btn sm copy" data-copy="${attr('export WARDEN_API_KEY=' + p.apiKey)}">Copy</button>
      </div>
      <div class="note">This key is their identity. A new one revokes the old.</div>
    </div>

    <div class="chips">
      <button type="button" class="btn" id="rotateKey">New key</button>
      <button type="button" class="btn danger" id="removePerson">Remove from team</button>
    </div>
    <div class="note" id="personNote"></div>

    <div class="group">
      <div class="label">Write a rule just for ${esc(p.name.split(' ')[0])}</div>
      <textarea id="personRuleText" rows="2" placeholder="e.g. cannot request data from other teams"></textarea>
      <button type="button" class="btn primary" id="personCompile">Write this rule</button>
    </div>

    <div class="folds">
      ${disclosure('p:onboarding', 'Setup instructions to send them', '<div id="onboarding"><div class="note">loading…</div></div>')}
    </div>

    ${section('Written for them', group('personal'), 'No personal rules, only the company and role ones below.')}
    ${section(`Because they are ${esc(p.role)}`, group('role'), 'No rules target this role.')}
    ${section('Everyone', group('company'), 'No company-wide rules.')}`;

  bindDisclosures();

  $('editRole').onchange = async (e) => {
    const { ok, j } = await api('/api/people', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id, name: p.name, role: e.target.value })
    });
    $('personNote').textContent = ok ? `Now judged as ${j.role}.` : (j.error ?? 'failed');
    if (ok) { await refreshPeople(); void renderPerson(p.id); }
  };

  $('rotateKey').onclick = async () => {
    if (!confirm('Issue a new key? Their current one stops working immediately.')) return;
    await api(`/api/people/${encodeURIComponent(p.id)}/key`, { method: 'POST' });
    await refreshPeople();
    void renderPerson(p.id);
  };

  $('removePerson').onclick = async () => {
    if (!confirm(`Remove ${p.name}? Their key stops working immediately.`)) return;
    const { ok, j } = await api(`/api/people/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    if (!ok) { $('personNote').textContent = j.error ?? 'failed'; return; }
    await refreshPeople();
    go('people');
    // Rules written only for someone who has left still exist and now bind
    // nobody. Saying so beats leaving dead policy in the list unremarked.
    if (j.orphanedRules?.length) {
      const pane = $('pane').querySelector('.sheet');
      if (pane) pane.insertAdjacentHTML('afterbegin',
        `<div class="banner warn">${j.orphanedRules.length} rule(s) were written only for ${esc(j.removed.name)} and now apply to nobody. Retarget or remove them under Rules.</div>`);
    }
  };

  const seen = $('seePerson');
  if (seen) seen.onclick = () => { state.actorFilter = p.id; go('activity'); };

  $('personCompile').onclick = () => {
    const text = $('personRuleText').value.trim();
    if (!text) return;
    state.draftFor = p.id;
    state.ruleChat = [];
    void sendRuleMessage(text);
  };

  void renderOnboarding(p);
}

/**
 * The setup for one person, per tool, with their values already in it.
 *
 * Generated on the server rather than assembled here, so the console and a
 * pasted chat message say the same thing, and so the gateway address is one the
 * server knows is reachable rather than one the admin typed from memory.
 */
async function renderOnboarding(person) {
  const host = $('onboarding');
  if (!host) return;
  const { ok, j } = await api(`/api/people/${encodeURIComponent(person.id)}/onboarding`);
  if (!host.isConnected) return;
  if (!ok) { host.innerHTML = `<div class="note">${esc(j.error ?? 'failed')}</div>`; return; }

  const tools = j.integrations;
  const step = (st) => `
    <div class="group">
      <div class="note"><b>${esc(st.title)}</b></div>
      ${st.note ? `<div class="note">${esc(st.note)}</div>` : ''}
      <div class="codewrap">
        <pre class="code">${esc(st.code)}</pre>
        <button type="button" class="btn sm copy" data-copy="${attr(st.code)}">Copy</button>
      </div>
    </div>`;

  host.innerHTML = `
    <div><button type="button" class="btn" id="copyAll">Copy the whole message</button></div>
    <div class="label">Everyone does this first</div>
    ${j.common.map(step).join('')}
    <div class="label">Then their tool</div>
    <div class="chips" id="toolTabs">
      ${tools.map((t, i) => `<button type="button" class="chip${i === 0 ? ' on' : ''}" data-tool="${i}">${esc(t.name)}</button>`).join('')}
    </div>
    <div id="toolBody"></div>`;

  const showTool = (i) => {
    const t = tools[i];
    $('toolBody').innerHTML = `
      <div class="group">
        <div class="chips">
          <span class="chip static">${t.kind === 'hook' ? 'checks before the prompt leaves the machine' : 'routes through the gateway'}</span>
          <span class="chip static">${t.worksOnSubscription ? 'works on a subscription' : 'needs an API key'}</span>
          <span class="badge ${t.verified ? 'ALLOW' : 'BLOCK'}">${t.verified ? 'verified working' : 'unverified'}</span>
        </div>
        <div class="note">${esc(t.summary)}</div>
        ${t.steps.map(step).join('')}
      </div>`;
  };
  showTool(0);

  $('toolTabs').onclick = (e) => {
    const chip = e.target.closest('[data-tool]');
    if (!chip) return;
    [...$('toolTabs').children].forEach((c) => c.classList.toggle('on', c === chip));
    showTool(Number(chip.dataset.tool));
  };

  $('copyAll').onclick = (e) => copyText(j.message, e.target);
}

// ═══ SIMULATOR ═══════════════════════════════════════════════════════════════

const backToRules = '<button type="button" class="btn quiet" data-go="policy">← Rules</button>';

VIEWS.simulator = {
  railParent: 'policy',
  flush: true,
  body: () => `<div class="chatwrap">
    <div class="chat" id="chat">
      <div class="sheet">
        <div class="toolbar" style="padding-top:0">
          ${backToRules}
          <span class="spacer"></span>
          <span class="label">Send as</span>
          <select class="inline" id="who" aria-label="Employee to send as">
            ${state.company.employees.map((e) => `<option value="${esc(e.id)}">${esc(e.name)} · ${esc(e.role)}</option>`).join('')}
          </select>
        </div>
        ${state.chat.length
          ? state.chat.map(renderMessage).join('')
          : '<div class="empty"><b>See what Warden would do</b><span>Pick someone and send a prompt as them. Nothing here is privileged; it goes through the gateway on their own key, like any other request.</span></div>'}
      </div>
    </div>
    <div class="composer">
      <div class="sheet">
        <div class="hero-box">
          <textarea id="prompt" rows="2" placeholder="Write a prompt as this employee…"></textarea>
          <button type="button" class="btn primary send" id="send">Send</button>
        </div>
      </div>
    </div>
  </div>`,
  bind: () => {
    const send = $('send');
    if (send) send.onclick = doSend;
    const prompt = $('prompt');
    if (prompt) prompt.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doSend(); };
    bindFollowUps();
  }
};

function renderMessage(m, i) {
  if (m.from === 'employee') {
    return `<div class="msg"><div class="who">${esc(m.who)}</div><div class="say">${esc(m.text)}</div></div>`;
  }
  // The pass list travels with the answer instead of living in a side panel —
  // same disclosure, same place in the hierarchy, as a decision in Activity.
  const slowest = Math.max(1, ...(m.passes ?? []).map((p) => p.ms ?? 0));
  const passes = (m.passes ?? []).length ? `<div class="folds">${disclosure(`s:${i}`, 'How it was decided', `
    <div>${m.passes.map((p) => `
      <div class="pass">
        <span class="n">${esc(p.pass)}</span>
        <span class="v ${esc(p.verdict ?? '')}">${esc(p.verdict ?? '')}</span>
        <span class="track"><i style="width:${Math.round(((p.ms ?? 0) / slowest) * 100)}%"></i></span>
        <span class="ms">${p.ms ?? 0}ms</span>
      </div>`).join('')}</div>
    <div class="note">${((m.totalMs ?? 0) / 1000).toFixed(1)}s${state.mock ? ' · demo mode' : ' · nothing left this machine'}</div>`)}</div>` : '';

  return `<div class="msg">
    <div class="who">Warden</div>
    <div class="verdict ${esc(m.verdict)}">${esc(m.label)}</div>
    ${m.why ? `<div class="why">${m.why}</div>` : ''}
    ${followUpControls(m, i)}
    ${passes}
  </div>`;
}

async function doSend() {
  const box = $('prompt');
  const text = box.value.trim();
  if (!text) return;
  const who = $('who').value || 'anon';
  const person = personById(who);
  box.value = '';

  state.chat.push({ from: 'employee', who: person ? `${person.name} · ${person.role}` : who, text });
  render();

  // The person's own API key, exactly as their laptop would send it. The
  // console deliberately has no privileged way to assert an identity — it
  // exercises the same path an employee's tool does, so a break here breaks
  // the demo too.
  const { j } = await api('/api/guard/check', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(person?.apiKey ? { authorization: `Bearer ${person.apiKey}` } : {})
    },
    body: JSON.stringify({ prompt: text, source: 'console' })
  });

  if (j?.error === 'unknown_api_key') {
    state.chat.push({ from: 'warden', verdict: 'BLOCK', label: 'Key not recognised', why: `<div>${esc(j.explanation)}</div>` });
    render();
    return;
  }

  const rule = j.firedRules?.[0];
  const label = { ALLOW: 'Allowed', BLOCK: 'Stopped', ESCALATE: 'Held for a person' }[j.verdict] ?? j.verdict;

  let why = '';
  if (rule) {
    // A refusal that only names the rule leaves the person holding a question
    // with nowhere to take it. What they can do instead is the part that keeps
    // them working with the gateway rather than around it.
    why += `<div><b>${esc(ruleName(rule.ruleId))}:</b> ${esc(rule.ruleText)}</div>`;
    why += rule.guidance
      ? `<div><b>They are told:</b> ${esc(rule.guidance)}</div>`
      : `<div><b>Why:</b> ${esc(rule.reason)}</div>`;
    if (rule.allowedExamples?.length) {
      why += `<div><b>These would go through:</b>${rule.allowedExamples.map((x) => `<div>· ${esc(x)}</div>`).join('')}</div>`;
    }
  }
  if (j.maskedSpans?.length) why += `<div>${plural(j.maskedSpans.length, 'secret')} masked before checking.</div>`;
  if (j.quota?.limit) why += `<div>Used ${j.quota.used} of ${j.quota.limit} today.</div>`;
  if (j.auditId) why += `<div><button type="button" class="linkbtn" data-go="activity" data-sel="${attr(j.auditId)}">See the full record</button></div>`;

  // A refusal with nowhere to go is what makes people work around the gateway.
  // These two are the way out, and they belong to the employee: the console
  // shows them because the simulator is where it stands in for one.
  state.chat.push({
    from: 'warden', verdict: j.verdict, label, why,
    passes: j.passes, totalMs: j.totalMs,
    ...(j.verdict !== 'ALLOW' && j.auditId && person
      ? { followUp: { auditId: j.auditId, prompt: text, who: person.id } }
      : {})
  });
  render();
}

// ── the two ways out of a refusal ────────────────────────────────────────────

const REWRITE_REFUSAL = {
  'no-rule': 'No specific rule fired, so there is nothing to rewrite against.',
  'no-honest-rewrite': 'There is no honest rewrite of this one, because the phrasing reached for the assistant’s own instructions, and no version of that is inside the rules.',
  'too-long': 'Too long to restate. A rewrite has to be a request someone could have typed.',
  'model-unavailable': 'The model did not answer, so nothing was suggested. Nothing was spent, so you can ask again.',
  'nothing-left': 'Once the prohibited part is taken out there is no request left to make.',
  'still-blocked': 'The rewrite did not survive its own re-check, so it was not offered.',
  'already-rewritten': 'One rewrite per block, and you have used this one.'
};

/** Renders under a refusal in the simulator, on the message that owns it. */
function followUpControls(m, i) {
  if (!m.followUp) return '';
  const s = m.rewrite;
  return `<div class="group" data-follow="${i}">
    ${s?.suggestion ? `
      <div class="label">Warden suggests asking it this way</div>
      <div class="banner">${esc(s.suggestion)}</div>
      <button type="button" class="btn" data-use-rewrite="${i}">Put this in the box</button>` : ''}
    ${s?.reason ? `<div class="note">${esc(REWRITE_REFUSAL[s.reason] ?? s.reason)}</div>` : ''}
    ${m.appealed
      ? '<div class="note good">Reported. An administrator sees it in their Inbox, next to the rule that stopped you.</div>'
      : `<div class="chips">
          ${s ? '' : `<button type="button" class="btn" data-rewrite="${i}"${m.busy ? ' disabled' : ''}>${m.busy === 'rewrite' ? 'Asking…' : 'Suggest a rewrite'}</button>`}
          <button type="button" class="btn" data-appeal="${i}"${m.busy ? ' disabled' : ''}>This block was wrong</button>
        </div>
        ${m.appealOpen ? `
          <textarea id="appealNote" rows="2" placeholder="What were you actually trying to do? (optional)"></textarea>
          <button type="button" class="btn primary" data-send-appeal="${i}"${m.busy ? ' disabled' : ''}>${m.busy === 'appeal' ? 'Sending…' : 'Send the report'}</button>` : ''}
        ${m.error ? `<div class="note bad">${esc(m.error)}</div>` : ''}`}
  </div>`;
}

function bindFollowUps() {
  const at = (el) => state.chat[Number(el.dataset.rewrite ?? el.dataset.appeal ?? el.dataset.sendAppeal ?? el.dataset.useRewrite)];
  const keyOf = (m) => personById(m.followUp.who)?.apiKey;

  document.querySelectorAll('[data-rewrite]').forEach((b) => { b.onclick = () => void askRewrite(at(b)); });
  document.querySelectorAll('[data-appeal]').forEach((b) => {
    b.onclick = () => { const m = at(b); m.appealOpen = !m.appealOpen; m.error = null; render(); };
  });
  document.querySelectorAll('[data-send-appeal]').forEach((b) => { b.onclick = () => void sendAppeal(at(b)); });
  document.querySelectorAll('[data-use-rewrite]').forEach((b) => {
    b.onclick = () => { const box = $('prompt'); if (box) { box.value = at(b).rewrite.suggestion; box.focus(); } };
  });

  async function askRewrite(m) {
    m.busy = 'rewrite'; m.error = null; render();
    const { ok, j } = await api('/api/guard/rewrite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyOf(m)}` },
      body: JSON.stringify({ auditId: m.followUp.auditId, prompt: m.followUp.prompt })
    });
    m.busy = null;
    // A refusal comes back as a reason rather than an error, and both 200 and
    // 409 carry one; only a shapeless failure is worth showing as an error.
    if (j?.suggestion || j?.reason) m.rewrite = { suggestion: j.suggestion ?? null, reason: j.reason ?? null };
    else if (!ok) m.error = j?.error ?? 'could not ask for a rewrite';
    render();
  }

  async function sendAppeal(m) {
    m.busy = 'appeal'; m.error = null; render();
    const note = $('appealNote')?.value.trim();
    const { ok, j } = await api('/api/guard/appeal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyOf(m)}` },
      body: JSON.stringify({ auditId: m.followUp.auditId, ...(note ? { note } : {}) })
    });
    m.busy = null;
    if (!ok) { m.error = j?.error ?? 'could not send that'; render(); return; }
    m.appealed = true;
    m.appealOpen = false;
    await refreshAppeals();
    render();
  }
}

// ═══ RED TEAM ════════════════════════════════════════════════════════════════

/**
 * The corpus run. Off the console's main path on purpose.
 *
 * It is a developer's screen wearing an administrator's clothes: it replays 160
 * canned attacks written against the *sample* policy, takes minutes of local
 * inference to do it, and tells you about this repo's corpus rather than about
 * the rules you wrote. An administrator pressing "Try to break it" expects
 * their own policy tested and does not get that.
 *
 * Still here, still reachable, still what `pnpm run redteam` renders — it just
 * no longer sits in the toolbar next to things that are about your policy.
 */
VIEWS.redteam = {
  railParent: 'policy',
  body: () => {
    const s = state.rtReport;
    const toolbar = `<div class="toolbar">
      ${backToRules}
      <span class="spacer"></span>
      <button type="button" class="btn" id="loadRt">Load last report</button>
      <button type="button" class="btn primary" id="runRt"${state.rtBusy ? ' disabled' : ''}>${state.rtBusy ? 'Running…' : 'Run suite'}</button>
    </div>`;

    if (!s) {
      return `<div class="sheet">${toolbar}<div class="empty"><b>No report yet</b><span>Run the suite, or load the most recent report, to see how the guard holds up against known attacks.</span></div></div>`;
    }
    const attacks = (s.warden ?? []).filter((c) => !c.isControl);
    const controls = (s.warden ?? []).filter((c) => c.isControl);
    const sum = (rows, k) => rows.reduce((n, c) => n + c[k], 0);
    const caught = sum(attacks, 'correct'), atotal = sum(attacks, 'total');
    const fp = sum(controls, 'falsePositives'), ctotal = sum(controls, 'total');
    const pc = (n, d) => (d ? Math.round((n / d) * 100) : 0);

    return `<div class="sheet">
      ${toolbar}
      <div class="group">
        ${s.adapter === 'mock' ? '<div class="banner warn">Demo mode: these numbers measure nothing.</div>' : ''}
        <p class="summary">Warden stopped <b>${caught} of ${atotal}</b> attacks, and wrongly stopped <b>${fp} of ${ctotal}</b> legitimate requests.</p>
        <div class="stats">
          <div class="stat"><div class="n good">${pc(caught, atotal)}%</div><div class="k">attacks stopped</div></div>
          <div class="stat"><div class="n${fp ? ' warn' : ' good'}">${pc(fp, ctotal)}%</div><div class="k">wrongly stopped</div></div>
        </div>
      </div>
      <div class="section">
        <table>
          <thead><tr><th>Attack class</th><th class="n">Warden</th><th class="n">No guard</th></tr></thead>
          <tbody>
          ${(s.warden ?? []).map((c) => {
            const b = (s.baseline ?? []).find((x) => x.class === c.class);
            const rate = pc(c.correct, c.total);
            const colour = rate > 70 ? 'var(--allow)' : rate > 40 ? 'var(--escalate)' : 'var(--block)';
            return `<tr>
              <td>${esc(c.class)}${c.isControl ? ' <span class="note">(control)</span>' : ''}</td>
              <td class="n">${rate}%<div class="bar"><i style="width:${rate}%;background:${colour}"></i></div></td>
              <td class="n">${b ? `${pc(b.correct, b.total)}%` : '—'}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  },
  bind: () => {
    const load = $('loadRt');
    if (load) load.onclick = async () => {
      const { ok, j } = await api('/api/redteam/report');
      if (ok) { state.rtReport = j; render(); }
    };
    const run = $('runRt');
    if (run) run.onclick = async () => {
      state.rtBusy = true; render();
      const { ok, j } = await api('/api/redteam/run', { method: 'POST' });
      state.rtBusy = false;
      if (ok) state.rtReport = j;
      render();
    };
  },
  onEnter: () => { if (!state.rtReport) void autoLoadRedteam(); }
};

async function autoLoadRedteam() {
  const { ok, j } = await api('/api/redteam/report');
  if (ok && j) { state.rtReport = j; render(); }
}

boot();
