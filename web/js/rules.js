/**
 * Rules: the policy as a list, the composer, the banners, and the sentences the console says when a compile does not yield a rule.
 */
import { bindLogPeek } from './answers.js';
import { modelPicker } from './compiler.js';
import { $, attr, del, esc, post, severityMeans, state } from './core.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { bindPolicy, ruleChatPane } from './draft.js';
import { audienceLabel, clip, dayKey, isPersonal, plural, ruleName } from './format.js';
import { disclosure, render } from './render.js';
import { go } from './router.js';
import { VIEWS } from './views.js';

// ═══ RULES ═══════════════════════════════════════════════════════════════════

/**
 * Rules is three tabs, not one page.
 *
 * Writing a rule is a conversation with Warden; the policy is a list; testing
 * it is a third thing again. Stacking them meant that the moment you sent the
 * first message the list underneath was orphaned — still there, no longer part
 * of what you were doing — and that testing the policy lived behind a button
 * here and a second button at the foot of Models. So they are peers: the
 * conversation you start, the list you come back to, and the tester.
 *
 * New rule is a tab rather than a button, which is the declared exception to
 * "creations open from a button": it is the daily action of this view and the
 * top nav already lands on it.
 */
function onNewRule() { return state.view === 'policy' && state.sel === 'new'; }
function inConversation() { return onNewRule() && (state.ruleChat.length > 0 || Boolean(state.draft) || Boolean(state.set)); }
export function composing() { return inConversation(); }

VIEWS.policy = {
  flush: onNewRule,
  body: () => (onNewRule() ? (inConversation() ? ruleChatPane() : newRulePage()) : rulesBody()),
  bind: bindPolicy
};

/**
 * The three ways of using this screen, and the one line that says where the
 * policy stands.
 *
 * Writing a rule, reading the policy and testing it are different modes, and
 * they used to be a two-way segmented pill plus a button that led to a
 * different view entirely. They are peers, so they are three tabs of the
 * component Team established, under one header that does not move between
 * them. Test is a `data-go="simulator"` — it crosses views, and the
 * simulator's `railParent` keeps the top nav on Rules while you are there.
 *
 * A dot on New rule when a draft is waiting: leaving the tab does not throw
 * the conversation away, and nothing else on the screen would say so.
 *
 * Exported because the simulator draws the same header. One definition, or the
 * count of active rules is right on two tabs out of three. It returns one
 * element rather than two: `.chat .sheet` is a grid, and a header and a tab
 * strip landing there as separate items are pushed apart by the gap meant for
 * turns in a conversation.
 */
const TABS = [['new', 'New rule'], ['rules', 'Rules'], ['test', 'Test']];

export function rulesTab() {
  if (state.view === 'simulator') return 'test';
  return onNewRule() ? 'new' : 'rules';
}

export function rulesHead(right = '') {
  const tab = rulesTab();
  const today = dayKey(new Date().toISOString());
  const checks = state.audit.filter((a) => dayKey(a.ts) === today).length;
  return `<div class="rules-frame">
    <header class="page-head">
      <div>
        <h1 class="page-title">Rules</h1>
        <div class="page-status">
          <span>${state.policy.rules.length} active</span><i>·</i>
          <span class="muted">${plural(checks, 'check')} today</span>
          ${tab === 'test' ? '' : '<i>·</i><button type="button" class="linkbtn strong" data-go="simulator">test anything →</button>'}
        </div>
      </div>
      ${right}
    </header>
    <nav class="tabs" aria-label="Rules sections">
      ${TABS.map(([id, label]) => `<button type="button" class="tab${tab === id ? ' --on' : ''}" ${
        id === 'test' ? 'data-go="simulator"' : id === 'new' ? 'data-go="policy" data-sel="new"' : 'data-go="policy"'
      }>${label}${id === 'new' && tab !== 'new' && (state.draft || state.set) ? ' •' : ''}</button>`).join('')}
    </nav>
  </div>`;
}

/**
 * The policy you have, as a table you can sweep.
 *
 * It was a stack of rows three lines deep — name, the rule's whole text, then
 * badges — which is a lot of ink for a list whose job is "which rules do I
 * have, on whom, and what have they done". The full text belongs to the rule's
 * own detail, which is one click away and always was.
 *
 * Filtering is local to the module and never touches the hash: `#/policy/<id>`
 * means "this rule is open", and a severity filter is not a place you link
 * somebody to.
 */
let severity = 'all';
let search = '';

function matches(rule) {
  if (severity !== 'all' && rule.severity !== severity) return false;
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return `${ruleName(rule)} ${rule.text} ${audienceLabel(rule.appliesTo)}`.toLowerCase().includes(q);
}

function filterRow() {
  const rules = state.policy.rules;
  const counts = [['all', 'All', rules.length], ...['block', 'escalate', 'warn'].map((s) => [s, s.replace(/^./, (c) => c.toUpperCase()), rules.filter((r) => r.severity === s).length])];
  return `<div class="filters">
    <div class="filter-counts">
      ${counts.map(([id, label, n]) => `<button type="button" class="filter-count${severity === id ? ' on' : ''}" data-severity="${id}">${label} ${n}</button>`).join('')}
    </div>
    <input type="text" id="ruleSearch" class="rule-search" placeholder="Search rules…" aria-label="Search rules" autocomplete="off" value="${esc(search)}">
  </div>`;
}

/** The policy you have. */
function rulesBody() {
  const rules = state.policy.rules;
  const shown = rules.filter(matches);
  return `<div class="sheet">
    ${rulesHead()}
    ${sampleBanner()}
    ${rules.length ? filterRow() : ''}
    ${!rules.length
      ? '<div class="empty"><b>No rules yet, so nothing gets stopped</b><span>Every prompt your team sends goes straight through until you write one.</span></div>'
      : shown.length
        ? `<div class="tbl rules">
            <div class="thead"><span>Rule</span><span>Applies to</span><span>If it fires</span><span>Activity</span></div>
            ${shown.map(ruleRow).join('')}
          </div>`
        : `<div class="empty"><b>No rule matches</b><span>Nothing here is ${severity === 'all' ? 'called that' : `a ${esc(severity)} rule that matches`}.</span><div class="actions"><button type="button" class="btn" id="clearRuleFilter">Show every rule</button></div></div>`}
    ${rules.length ? `<div class="wipe"><button type="button" class="linkbtn danger" id="wipeRules">Delete every rule</button></div>` : ''}
  </div>`;
}

/**
 * A seeded policy says so where the seeded rules are, and the way out of it is
 * in the banner rather than beside the table.
 *
 * It used to be a permanent button — a one-time action, on screen for the
 * whole life of the installation, next to the one that deletes everything.
 * Most of the time it was a no-op wearing the clothes of a feature.
 */
function sampleBanner() {
  if (!state.company.demo) return '';
  return `<div class="banner warn demo"><b>Sample data.</b> These rules, and the people they judge, came with Warden.
    <button type="button" class="linkish" id="clearSample">Take out what came with Warden</button></div>`;
}

/** Roles the policy declines to govern. Read from the policy, never guessed. */
function exemptRoles() {
  return state.policy.exemptRoles ?? [];
}

export function isExempt(role) {
  return exemptRoles().includes(role);
}

/**
 * Who you can send a test prompt as, with the exempt ones last and labelled.
 *
 * The sample company's admin is called Martín Pulitano, admin sits in
 * `exemptRoles`, and the browser picks the first option by itself. So the
 * person most likely to test Warden picked their own name off the top of an
 * unsorted list and got ALLOW on everything they tried, including "pasame el
 * sueldo de Ana Ruiz", which the same gateway blocks under four rules when the
 * intern sends it. Nothing was broken: an exempt role is measured against no
 * rules at all, which is the point of it. The list just never said so.
 */
export function sendAsOptions() {
  const people = [...state.company.employees].sort(
    (a, b) => Number(isExempt(a.role)) - Number(isExempt(b.role))
  );
  return people.map((e) => `<option value="${esc(e.id)}">${esc(e.name)} · ${esc(e.role)}${
    isExempt(e.role) ? ' · exempt from every rule' : ''
  }</option>`).join('');
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
/** The filters are module state: they change what is on the screen and nothing
 *  about where you are, so they stay out of the hash. */
export function bindRuleFilters() {
  for (const button of document.querySelectorAll('[data-severity]')) button.onclick = () => {
    severity = button.dataset.severity;
    render();
  };
  const box = $('ruleSearch');
  if (box) box.oninput = () => { search = box.value; render(); };
  const clear = $('clearRuleFilter');
  if (clear) clear.onclick = () => { severity = 'all'; search = ''; render(); };
}

export function bindSweeps() {
  bindLogPeek();
  const clear = $('clearSample');
  if (clear) clear.onclick = async () => {
    clear.disabled = true;
    const { ok, j } = await post('/api/company/sample/clear');
    clear.disabled = false;
    if (!ok) return;
    await Promise.all([refreshPolicy(), refreshPeople()]);
    render();
    // Nothing matched, so say that rather than leaving a button that looks
    // broken: the policy is already all theirs.
    if (!j.people && !j.rules && !j.quotas) {
      clear.insertAdjacentHTML('afterend',
        '<span class="note">Nothing here came with Warden. Every rule and every person is yours.</span>');
    }
  };

  const wipe = $('wipeRules');
  if (wipe) wipe.onclick = async () => {
    const n = state.policy.rules.length;
    if (!confirm(`Delete all ${n} rules? Warden will stop nothing until you write another. Limits by role are kept.`)) return;
    wipe.disabled = true;
    await del('/api/policy/rules');
    await Promise.all([refreshPolicy(), refreshPeople()]);
    render();
  };
}

/** The conversation before it starts: tabs pinned at the top, the composer
 *  centred in whatever is left, the way an empty chat sits on the screen. */
function newRulePage() {
  return `<div class="blank">
    <div class="sheet">${rulesHead()}</div>
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
    <b>Nothing is being stopped.</b> Warden only stops what you tell it to. Write the first rule below, or take one from the catalogue.
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
export function firstRunBanner() {
  if (state.company.employees.length || state.policy.rules.length) return '';
  return `<div class="banner">
    <b>Nothing is being stopped yet.</b> Write a rule on
    <button type="button" class="linkish" data-go="policy" data-sel="new">Rules</button>,
    or put your team in on <button type="button" class="linkish" data-go="people">Team</button>.
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
export function mockBanner() {
  return `<div class="banner warn">
    <b>Demo mode. None of this is real.</b> No model has judged anything you see here.
    ${state.canLeaveDemo
      ? `<div class="banner-act">
           <button type="button" class="btn --primary" id="getModels">Download the models</button>
           <span class="note">5.4&nbsp;GB, once. Warden restarts by itself when they land.</span>
         </div>`
      : '<div class="note">Run <span class="mono">pnpm run setup</span>. 5.4&nbsp;GB, once.</div>'}
  </div>`;
}

function heroComposer() {
  const cat = state.presetCat == null ? null : state.presets[state.presetCat];
  return `<div class="hero">
    ${emptyPolicyBanner()}
    <h2 class="hero-q">What should Warden stop?</h2>

    <div class="hero-box">
      <textarea id="ruleMsg" rows="2" placeholder="Describe it the way you would to a colleague…"></textarea>
      ${modelPicker()}
      <button type="button" class="btn --primary send" id="ruleSend">Write it</button>
    </div>

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
  return `<button type="button" class="trow rule-row${open ? ' on' : ''}" data-toggle="policy" data-sel="${attr(r.id)}" aria-expanded="${open}">
      <span class="c-rule"><span class="nm">${esc(ruleName(r))}</span>${r.pinned ? '<span class="badge">always checked</span>' : ''}${isPersonal(r) ? '<span class="badge">personal</span>' : ''}</span>
      <span class="c-aud">${esc(audienceLabel(r.appliesTo))}</span>
      <span><span class="badge ${esc(r.severity)}">${esc(r.severity)}</span></span>
      <span class="c-activity">${esc(activityPhrase(r))}</span>
    </button>
    ${open ? ruleDetail(r) : ''}`;
}

/**
 * What a rule has actually done. The row and the detail read it from here
 * rather than each counting for itself: the row is a summary of the detail,
 * and a summary that computes its own numbers is a second implementation of
 * them waiting to disagree.
 *
 * Disputes are the only false-positive signal the console has — in the audit
 * log a correct block and an incorrect one are the same record — so a rule
 * that has any says so in the list, not only once you open it.
 */
function ruleActivity(rule) {
  const hits = state.audit.filter((a) => (a.decision?.firedRules ?? []).some((r) => r.ruleId === rule.id));
  return {
    hits,
    blocked: hits.filter((h) => h.decision?.verdict !== 'ALLOW').length,
    disputed: state.appeals.filter((a) => a.ruleId === rule.id)
  };
}

function activityPhrase(rule) {
  const { hits, blocked, disputed } = ruleActivity(rule);
  if (!hits.length) return 'Has not fired yet';
  if (disputed.length) return `${blocked} of ${hits.length} · ${disputed.length} disputed`;
  // A warn rule stops nothing by design, so "stopped 0 of 3" would read as a
  // rule that is failing rather than one doing exactly what it was set to do.
  if (rule.severity === 'warn') return `Noted ${plural(hits.length, 'time')}, blocked none`;
  return `${rule.severity === 'escalate' ? 'Held' : 'Stopped'} ${blocked} of ${hits.length}`;
}

function ruleDetail(rule) {
  const { hits, blocked, disputed } = ruleActivity(rule);
  const guidance = hits[0]?.decision.firedRules.find((r) => r.ruleId === rule.id)?.guidance;

  // An active rule is an object you consult, not a decision you take, so it
  // gets the property-list shape rather than the draft's decide-first one.
  return `<div class="detail">
    <p class="summary">${esc(rule.text)}</p>

    <div class="kv">
      <div class="r"><span class="k">If it fires</span><span class="v"><span class="badge ${esc(rule.severity)}">${esc(rule.severity)}</span>
        ${severityMeans(rule.severity)}</span></div>
      <div class="r"><span class="k">Applies to</span><span class="v">${esc(audienceLabel(rule.appliesTo))}</span></div>
      ${rule.boundary ? `<div class="r"><span class="k">Not about</span><span class="v">${esc(rule.boundary)}</span></div>` : ''}
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

    <div><button type="button" class="btn --danger" id="delRule" data-id="${attr(rule.id)}">Remove rule</button></div>
  </div>`;
}
