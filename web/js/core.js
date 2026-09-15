/**
 * The console's shared ground: DOM and escaping helpers, the admin key, the one fetch helper, and `state`.
 */
export const $ = (id) => document.getElementById(id);
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
      'Paste the API key of somebody whose role the policy exempts. Team, then ' +
      'that person, then API key. It stays in this browser tab and nowhere else.'
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
export const api = async (path, opts, retried) => {
  const key = adminKey();
  // The Simulator deliberately borrows an employee's identity. A saved admin
  // key must not replace it and turn an ordinary guard check into an exemption.
  const hasIdentity = Boolean(new Headers(opts?.headers).get('authorization'));
  const init = key && !hasIdentity
    ? { ...opts, headers: { ...(opts?.headers ?? {}), authorization: `Bearer ${key}` } }
    : opts;

  const r = await fetch(path, init);

  if (r.status === 403 && !hasIdentity && !retried && askForAdminKey()) return api(path, opts, true);

  const text = await r.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = { error: text.slice(0, 400) };
  }
  return { ok: r.ok, status: r.status, j };
};

/** A JSON request. Every write the console makes is one of these, and they all read the same.
 *  `extra` takes a `method` other than POST, or `headers` for the simulator's borrowed identity. */
export const post = (path, body, extra = {}) =>
  api(path, {
    method: extra.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
    body: JSON.stringify(body ?? {})
  });
export const del = (path) => api(path, { method: 'DELETE' });
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

export const severityMeans = (s) => SEVERITY_MEANS[s] ?? `severity “${esc(s)}” — unknown to this console`;
export const severityVerb = (s) => SEVERITY_VERB[s] ?? 'flags';

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const attr = (s) => encodeURIComponent(String(s ?? ''));
export const val = (x) => (typeof x === 'function' ? x() : x);

export const state = {
  view: 'activity',
  sel: null,
  query: {},

  /** Per list: `{ loading, error }`. Absent means never requested yet. */
  loads: {},

  audit: [],
  policy: { rules: [], quotas: [], version: '' },
  company: { name: '', roles: [], employees: [] },
  presets: [],
  chain: null,
  mock: false,
  /** True when a desktop shell is listening that can fetch the models. */
  canLeaveDemo: false,
  publicUrl: null,
  /** What weights are on disk and which seat each model fills. Null until loaded. */
  models: null,
  adjudicator: null,
  /** Limits the compiler proposed and nobody has applied yet. */
  pendingLimits: null,
  // True from the moment a prompt is sent until its verdict is rendered.
  sending: false,
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
   * The rules compiled from one broad instruction, all on screen at once.
   *
   * `{ items: [{ rule, preview, status }], limits, factor }`, or null. It was
   * a queue behind `draft` — one card, activate it, the next appears — on the
   * argument that a list with several Activate buttons is how you get several
   * clicks and one reading. The owner's answer, having used it: a queue that
   * hides the set is how you never learn what the instruction became, and
   * ratifying eight rules one at a time with a check in between each is the
   * reason the set is not written. So the set is a list, each card carries
   * its own check, and there is one button for all of them — the boundary is
   * still a person reading the list and pressing it.
   */
  set: null,
  draftFor: null,
  preview: null,
  ruleChat: [],
  ruleBusy: false,
  /** The audience editor is a control, not information: it stays shut until
   *  you say you want to change who a rule binds. */
  audienceOpen: false,
  /** Whether a human has actually looked at who this draft binds, rather than
   *  `sanitiseAudience`'s `['*']` fallback reaching Activate unseen. Every new
   *  draft starts `false`; touching any chip — including re-confirming what
   *  the model already proposed — sets it `true`. A draft locked to one
   *  person's page (`draftFor`) has nothing to confirm, so it starts `true`. */
  audienceConfirmed: false,
  /** Set when Activate was pressed before the audience was confirmed, so the
   *  draft card shows why it opened the editor instead of ratifying. Cleared
   *  the moment a chip is touched. */
  audienceWarning: false,
  /** Same shape as `audienceOpen`, for severity: shut until you say you want
   *  to change it. Editing it needs no confirm step like audience does — a
   *  wrong severity does not fail open the way an unconfirmed `['*']` audience
   *  does, the compiler's guess is a reasonable default either way. */
  severityOpen: false,
  /** The check found something and the admin looked at it and chose to
   *  activate anyway — "Keep as is" on the card. Reset on every fresh check
   *  so a *new* problem is never hidden behind a dismissal of the old one. */
  issueDismissed: false,
  /** Set right before `render()` by a toggle that makes the current card
   *  taller without adding a turn to the conversation — the severity and
   *  audience pickers, dismissing an issue. Tells `restoreChat` to hold the
   *  scroll position instead of running its normal "new turn arrived, follow
   *  it down" smooth-scroll, which otherwise fired for a click that said
   *  nothing. Consumed (reset to `false`) the moment `restoreChat` reads it. */
  keepScroll: false,

  filter: 'all',
  actorFilter: '',
  presetCat: null,

  chat: [],
  rtReport: null,
  rtBusy: false,

  /** Which disclosures are expanded, by key. Kept in state rather than the DOM
   *  so it survives a re-render and follows you from one row to the next. */
  open: new Set(),

  /**
   * "This device" (`VIEWS.soloRules`, docs/specs/solo-mode.md §7) — a second,
   * narrower console for someone protecting their own machine rather than
   * administering anyone else's. Kept on its own keys rather than reusing
   * `draft`/`ruleChat`/etc. so the two flows never bleed into each other.
   */
  soloIdentity: null,
  soloPresets: [],
  soloGroups: [],
  soloRules: [],
  /** Set when a `/api/solo/presets` or `/api/solo/rules` fetch failed, so the
   *  screen can say so instead of showing "Loading…" forever — both lists
   *  start empty, which is indistinguishable from "still loading" unless
   *  something else marks the difference. Cleared the moment either call
   *  next succeeds. */
  soloLoadError: '',
  /** The preset id currently mid-toggle, so its switch can disable itself. */
  soloToggling: null,
  soloBusy: false,
  /** Rendered HTML for the last thing the free-text field said back, or ''. */
  soloRuleNote: '',
  soloProtecting: false,
  soloProtectError: '',
  /** The decision `/api/solo/test` returned after the last successful
   *  protect run — the "confirmation with evidence" the PRD asks for. */
  soloTestResult: null
};

export const AUDIT_LIMIT = 400;
/** Recent allowed prompts offered as a regression check on a candidate rule.
 *  Each one is a full adjudication on the local model, so this stays small. */
export const REGRESSION_SAMPLE = 5;
