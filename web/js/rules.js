/**
 * Rules: the policy as a list, the composer, the banners, and the sentences the console says when a compile does not yield a rule.
 */
import { compilerLine } from './compiler.js';
import { $, api, attr, esc, severityMeans, state } from './core.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { bindPolicy, ruleChatPane } from './draft.js';
import { audienceLabel, clip, isPersonal, plural, ruleName } from './format.js';
import { limitsGrid } from './limits.js';
import { disclosure, render } from './render.js';
import { go } from './router.js';
import { VIEWS } from './views.js';

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
function onNewRule() { return state.view === 'policy' && state.sel === 'new'; }
function inConversation() { return onNewRule() && (state.ruleChat.length > 0 || Boolean(state.draft)); }
export function composing() { return inConversation(); }

VIEWS.policy = {
  flush: onNewRule,
  body: () => (onNewRule() ? (inConversation() ? ruleChatPane() : newRulePage()) : rulesBody()),
  bind: bindPolicy
};

/** The switch between the two, at the top of the column in both. A dot on the
 *  New rule side when a draft is waiting there — leaving the tab does not
 *  throw the conversation away. */
export function rulesTabs(right = '') {
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
      : '<div class="empty"><b>No rules yet, so nothing gets stopped</b><span>Every prompt your team sends goes straight through until you write one.</span></div>'}

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

/**
 * An error a person can read, out of whatever the gateway sent.
 *
 * A zod failure arrives as a JSON array of issue objects, and the console
 * printed the whole thing: forty lines of `"code": "invalid_type"` in the
 * middle of a conversation, about a schema the reader has never heard of. The
 * messages inside it are the only part with any meaning, and even those are
 * ours rather than theirs, so they are capped.
 */
export function readable(err) {
  if (!err) return 'unknown error';
  const text = String(err);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const fields = parsed.map((i) => (Array.isArray(i?.path) ? i.path.join('.') : '')).filter(Boolean);
      return fields.length
        ? `the draft was missing ${fields.slice(0, 6).join(', ')}`
        : 'the draft did not match the expected shape';
    }
  } catch {
    /* not JSON, which is the ordinary case */
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * What to say when the compiler did not write a rule, which is two answers.
 *
 * "Quiero reducir mi uso del mes 50%" is not the same kind of thing as "juan".
 * One is a request Warden can satisfy in the only currency it has for spending,
 * and refusing it flat was wrong: the point of typing a sentence is that
 * something comes back. So the gateway multiplies the limits it already has by
 * the fraction the compiler read, and this puts the arithmetic on screen with
 * a button. The other really is nothing to act on, and says so in one line.
 */
export function notARuleAnswer(j) {
  const reason = esc(j.reason || 'There is no prohibition in it.');
  if (!Array.isArray(j.limits) || j.limits.length === 0) {
    return `<b>Nothing to enforce there.</b> ${reason}`;
  }
  const pct = Math.round((1 - j.factor) * 100);
  state.pendingLimits = j.limits;
  return `<b>That is a spending target, not a rule.</b> ${reason}
    <div>Cutting every daily limit by ${pct}%:</div>
    <div class="limit-plan">${j.limits.map((row) => `
      <div class="r"><span class="k">${esc(row.role)}</span>
        <span class="v num">${row.from} → ${row.to} a day</span></div>`).join('')}</div>
    <div><button type="button" class="btn primary" id="applyLimits">Apply these limits</button></div>`;
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
export function compileFailure(j) {
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

export function bindSweeps() {
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
        '<span class="note">Nothing here came with Warden. Every rule and every person is yours.</span>');
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
           <button type="button" class="btn primary" id="getModels">Download the models</button>
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

    <div><button type="button" class="btn danger" id="delRule" data-id="${attr(rule.id)}">Remove rule</button></div>
  </div>`;
}
