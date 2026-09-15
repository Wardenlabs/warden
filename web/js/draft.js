/**
 * Writing a rule as a conversation: the turns, the draft card, the check, the audience, and Activate.
 */
import { $, REGRESSION_SAMPLE, del, esc, post, severityVerb, state } from './core.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { audienceLabel, personById, plural, sendOnEnter } from './format.js';
import { bindModelPicker, modelPicker } from './compiler.js';
import { bindLimits } from './limits.js';
import { disclosure, render } from './render.js';
import { go } from './router.js';
import { compileFailure, limitsPlan, notARuleAnswer, readable } from './answers.js';
import { bindRuleFilters, bindSweeps, composing, isExempt, rulesHead } from './rules.js';
import { bindSet, runSetPreviews, setCards } from './draft-set.js';

// ── the conversation ─────────────────────────────────────────────────────────
//
// Writing a rule is iterative: you say it, you see what it would have done, you
// narrow it. The old form could not express that — every reword was a fresh
// compile that threw away what you had learned. Here the check is a turn in the
// conversation rather than a button, and the rule being built is a card inside
// the conversation rather than a pane the conversation points at.

/** Once the first message is sent the hero collapses: the box docks to the
 *  bottom and the turns take the space it was holding. */
export function ruleChatPane() {
  return `<div class="chatwrap">
    <div class="sheet chat-head">
      ${rulesHead('<button type="button" class="btn --link" id="cancelDraft">Start over</button>')}
    </div>
    <div class="chat" id="ruleChat">
      <div class="sheet">
        ${state.ruleChat.map(renderTurn).join('')}
        ${state.draft ? draftCard() : ''}
        ${state.set ? setCards() : ''}
      </div>
    </div>
    <div class="composer">
      <div class="sheet">
        <div class="hero-box">
          <textarea id="ruleMsg" rows="2" placeholder="${state.draft
            ? 'Tell Warden how to change it…'
            : state.set ? 'Refine the set (“solo para ventas”, “sumá…”), or describe another rule…' : 'Describe the rule in your own words…'}"></textarea>
          ${modelPicker()}
          <button type="button" class="btn --primary send" id="ruleSend"${state.ruleBusy ? ' disabled' : ''}>${state.ruleBusy ? 'Working…' : 'Send'}</button>
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
/**
 * One line saying what the check found, for a draft card or a card in a set.
 *
 * In demo mode the check ran on the stand-in, which judges nothing, so the
 * counts underneath it are not findings about this rule and must not be
 * dressed as them. A person evaluating Warden with no models downloaded was
 * being told their rule missed two of its own examples — a criticism produced
 * by a test double, of a rule a test double wrote. The honest line is the one
 * that says so and points at the download.
 */
export function verdictLine(p, checking = false) {
  if (state.mock) {
    return `<div class="verdict-line"><span class="dot"></span>
        <b>Not checked.</b>
        <span>No model is installed, so nothing on this card was judged.</span></div>`;
  }
  if (checking) return '<div class="verdict-line"><span class="dot"></span><span>Checking it against its examples…</span></div>';
  if (!p) return '<div class="verdict-line"><span class="dot"></span><span>Not checked yet.</span></div>';
  if (p.falsePositives > 0) {
    return `<div class="verdict-line"><span class="dot BLOCK"></span>
          <b>${plural(p.falsePositives, 'legitimate request')} would be blocked.</b>
          <span>Reword it before activating.</span></div>`;
  }
  if (p.misses > 0) {
    return `<div class="verdict-line"><span class="dot ESCALATE"></span>
            <b>${plural(p.misses, 'example')} it should have caught slipped through.</b>
            <span>Worth being more specific.</span></div>`;
  }
  return `<div class="verdict-line"><span class="dot ALLOW"></span>
            <b>Checked against ${plural(p.rows.length, 'request')}.</b>
            <span>None of them would be wrongly stopped.</span></div>`;
}

export function checkRowsOf(p) {
  return p ? p.rows.map((r) => `
    <div class="preview-row${r.isFalsePositive ? ' fp' : ''}">
      <span class="v ${esc(r.verdict)}">${esc(r.verdict)}</span>
      <span class="p">${esc(r.prompt)}</span>
      ${r.source === 'log' ? '<span class="badge">real</span>' : ''}
      ${r.isFalsePositive ? '<span class="badge block">wrongly stopped</span>' : ''}
      ${r.isMiss ? '<span class="badge escalate">missed</span>' : ''}
    </div>`).join('') : '';
}

export function examplesFold(key, d) {
  return disclosure(key, 'Examples Warden wrote for it', `
        <div class="label">Would be stopped</div>
        ${(d.examples?.violating ?? []).map((x) => `<div class="note">· ${esc(x)}</div>`).join('')}
        <div class="label">Must still go through</div>
        ${(d.examples?.compliant ?? []).map((x) => `<div class="note">· ${esc(x)}</div>`).join('')}`);
}

/** `warn` has no colour of its own — like `.badge.warn`, it borrows the
 *  held-for-review palette, because nothing was refused. */
function severityDotClass(sev) { return sev === 'warn' ? 'escalate' : sev; }

/**
 * What the check found, when it found something — the one part of the card
 * that is genuinely uncertain (severity and audience already carry a
 * reasonable default; this doesn't). Shown as the actual prompts that failed,
 * never just a count: a count is not something you can act on, the sentences
 * are. Silent once `state.issueDismissed` — set by "Keep as is" — until the
 * next check runs and clears it (`runPreview`), so a dismissal never hides a
 * *different* problem than the one it was said about.
 *
 * `verdictLine` still owns the mock/checking/not-checked/clean lines — this
 * only replaces its two issue branches, and only inside this card. The set
 * cards in `draft-set.js` call `verdictLine` directly and are untouched.
 */
function issueBlock(p) {
  if (state.mock || !p || state.issueDismissed) return '';
  const kind = p.falsePositives > 0 ? 'fp' : p.misses > 0 ? 'miss' : null;
  if (!kind) return '';

  const rows = p.rows.filter((r) => (kind === 'fp' ? r.isFalsePositive : r.isMiss));
  const headline = kind === 'fp'
    ? `${plural(p.falsePositives, 'legitimate request')} would be wrongly blocked`
    : `Missed ${plural(p.misses, 'request')} it should have caught`;
  // What "Make it more specific" actually sends — the same free-text refine
  // path as typing it yourself, just with the sentence already written.
  const refineText = kind === 'fp'
    ? "It's too broad — narrow it so it stops blocking legitimate requests."
    : 'Make it more specific — some things it should catch are getting through.';

  return `<div class="issue">
    <div class="issue-head"><span class="tag issue">Issue</span><b>${esc(headline)}</b></div>
    <div class="issue-examples">${rows.map((r) => `<div>"${esc(r.prompt)}"</div>`).join('')}</div>
    <div class="chips">
      <button type="button" class="btn" id="refineBtn" data-refine="${esc(refineText)}">${kind === 'fp' ? 'Narrow it' : 'Make it more specific'}</button>
      <button type="button" class="btn --link" id="keepIssueBtn">Keep as is</button>
    </div>
  </div>`;
}

/**
 * The draft, as one object inside the conversation rather than a stack of
 * separate-looking notices — a "Rule" tag on the card says so, an "Issue" tag
 * says so about the one part of it that's still undecided. Severity and
 * audience are fields you click to change, not sentences describing a
 * default nobody looked at.
 */
function draftCard() {
  const d = state.draft;
  const locked = Boolean(state.draftFor);
  const p = state.preview;
  const hasIssue = Boolean(p) && !state.mock && !state.issueDismissed && (p.falsePositives > 0 || p.misses > 0);
  const verdict = hasIssue ? '' : verdictLine(p);

  return `<div class="msg">
    <div class="who">Warden</div>
    <div class="artifact">
      <div class="card-header">
        <div class="title-block">
          <p class="summary">${esc(d.text)}</p>
          <div class="note">${
            // Same reasoning as before: this is the point Activate is on
            // screen, which is when it matters whether the sentence came off
            // this machine.
            d.draftedBy ? `written by ${esc(d.draftedBy)} · ` : ''
          }not active yet</div>
        </div>
        <span class="tag rule">Rule</span>
      </div>

      ${d.textLocal ? `<p class="note"><b>Employees will read:</b> ${esc(d.textLocal)}</p>` : ''}
      ${d.boundary ? `<p class="note"><b>Not about:</b> ${esc(d.boundary)}</p>` : ''}

      <div class="properties">
        <button type="button" class="field" id="severityToggle">
          <span class="dot ${esc(severityDotClass(d.severity))}"></span>${esc(d.severity)}<span class="chev">⌄</span>
        </button>
        ${locked
          ? `<span class="field" style="cursor:default">${esc(audienceLabel(d.appliesTo))} · locked, you started this from their page</span>`
          : `<button type="button" class="field" id="editAudience">
               <span class="dot"></span>${esc(audienceLabel(d.appliesTo))}<span class="chev">⌄</span>
             </button>`}
      </div>
      ${state.severityOpen ? '<div class="chips" id="severityChips"></div>' : ''}
      ${!locked && state.audienceOpen ? '<div class="chips" id="audienceChips"></div>' : ''}
      ${state.audienceWarning && !state.audienceConfirmed
        ? '<div class="note" id="audienceWarnNote">Choose who this rule applies to before activating it.</div>'
        : ''}

      ${verdict}
      ${issueBlock(p)}

      <div class="chips">
        <button type="button" class="btn --primary" id="ratifyBtn"${state.ruleBusy ? ' disabled' : ''}>Activate</button>
        <button type="button" class="btn --link" id="dropBtn">Discard</button>
      </div>

      <div class="folds">
        ${d.guidance ? disclosure('n:told', 'What the employee sees when this blocks them', `<div class="banner">${esc(d.guidance)}</div>`) : ''}
        ${examplesFold('n:examples', d)}
      </div>
    </div>
  </div>`;
}

export function say(html, pending = false) {
  // The same sentence twice in a row is never two answers. A compile failure
  // was seen printed as two identical WARDEN turns; whatever path produced the
  // second, the reader gains nothing from it.
  const last = state.ruleChat.at(-1);
  if (!pending && last?.from === 'warden' && !last.pending && last.html === html) return;
  state.ruleChat.push({ from: 'warden', html, pending });
}

function dropPending() {
  state.ruleChat = state.ruleChat.filter((t) => !t.pending);
}

/**
 * The conversation so far, for the compiler: what the administrator said
 * before this message, and the rules on the table now. Without it every
 * message compiled as if it were the first, and "hacelo solo para ventas"
 * after a set of five became a rule about sales. The current message is
 * already the last turn in `ruleChat`, so it is left out of the history.
 */
function conversation() {
  const said = state.ruleChat.filter((t) => t.from === 'you').map((t) => t.text);
  const history = said.slice(0, -1).slice(-6);
  const current = state.set
    ? state.set.items.filter((it) => it.status !== 'active').map((it) => it.rule.text)
    : state.draft ? [state.draft.text] : [];
  return { history, current };
}

/**
 * What both compile routes have in common once the answer is back: the
 * pending turn goes, and a decline or a failure is said and ends the turn.
 *
 * A decline is an answer, not an error. "Quiero reducir mi uso al 50%" is a
 * spending target, and the honest reply is the screen that holds spending
 * targets, not a prohibition invented to fit the shape; before the compiler
 * could decline, that sentence became a rule forbidding anyone to be limited
 * on the basis of a usage goal, which is the request inside out.
 *
 * Returns true when there is a draft to go on with.
 */
function compiled(ok, j) {
  dropPending();
  if (ok && !j?.notARule) return true;
  state.ruleBusy = false;
  say(j?.notARule ? notARuleAnswer(j) : compileFailure(j));
  render();
  return false;
}

export async function sendRuleMessage(text) {
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
    ? { text: `${state.draft.text}\n\nChange it as follows: ${clean}`, ...conversation() }
    : { text: clean, ...conversation() };
  if (state.draftFor) body.lockTo = [`@${state.draftFor}`];

  const { ok, j } = await post('/api/policy/draft', body);

  if (!compiled(ok, j)) return;

  state.draft = j;
  startDraftAudience();
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
  // `capable` is the gateway saying which compiler is in force, environment
  // included; `provider` is only what was saved from this page, and a CLI set
  // by environment variable left it at "local" and skipped the split.
  const capable = state.compiler?.capable ?? ((state.compiler?.provider ?? 'local') !== 'local');
  return capable ? sendRuleSet(text) : sendRuleMessage(text);
}

/**
 * One broad instruction, several rules, all on screen.
 *
 * The compiler splits what you said into the specific prohibitions it means
 * and compiles each of those; what comes back is a set, not a policy. Every
 * rule goes on screen as its own card, each is checked in turn against its own
 * examples, and nothing is written until you press Activate — on a card, or
 * once for the whole list after a confirm that says what is about to bind
 * whom. A spending target inside the same sentence comes back beside the rules
 * as proposed limits, with its own button, rather than being dropped because
 * a rule also compiled.
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

  const body = { text: clean, ...conversation() };
  if (state.draftFor) body.lockTo = [`@${state.draftFor}`];
  // A follow-up replaces the rules still on the table; the ones already
  // activated stay as the record they are.
  const kept = state.set ? state.set.items.filter((it) => it.status === 'active') : [];

  const { ok, j } = await post('/api/policy/draft-set', body);

  if (!compiled(ok && Array.isArray(j.rules) && j.rules.length > 0, j)) return;

  // The part of the sentence that was a spending target, if any, answered in
  // the same turn as the rules. The limits carry their own Apply button.
  const limitsNote = typeof j.factor === 'number'
    ? `<div class="note">Part of that was a spending target, not a rule.</div>${limitsPlan(j)}`
    : '';

  const followUp = kept.length > 0 || Boolean(state.set);
  if (j.rules.length === 1 && !followUp) {
    state.draft = j.rules[0];
    startDraftAudience();
    state.preview = null;
    say(`That was already one specific thing, so it is one rule.${limitsNote}`);
    render();
    await runPreview();
    return;
  }

  state.draft = null;
  state.preview = null;
  state.set = {
    items: [...kept, ...j.rules.map((rule) => ({ rule, preview: null, status: 'pending' }))],
    limits: j.limits ?? null,
    factor: j.factor
  };
  state.ruleBusy = false;
  say(followUp
    ? `Updated: ${plural(j.rules.length, 'rule')} on the table now, each checked again below.${limitsNote}`
    : `That’s ${plural(j.rules.length, 'rule')}. Each has its own check below. Activate one, or all of them once you’ve read the list.${limitsNote}`);
  render();

  await runSetPreviews(state.set);
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
  // A fresh check can find a different problem than the one just dismissed —
  // "Keep as is" answers the issue on screen, not every issue this draft will
  // ever have.
  state.issueDismissed = false;
  say(against.length
    ? `Replaying ${plural(against.length, 'request')} Warden already allowed, to see if this rule would have stopped them…`
    : 'Checking it…', true);
  render();

  const { ok, j } = await post('/api/policy/preview', against.length ? { rule: state.draft, against } : { rule: state.draft });

  dropPending();
  state.ruleBusy = false;
  if (!ok) { say(`The check failed: ${esc(readable(j.error))}`); render(); return; }

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
    say('No model installed, so nothing was checked. These rows come from the demo stand-in; download the models and the check becomes real.');
    render();
    return;
  }

  if (j.falsePositives > 0) {
    say(`<b>${plural(j.falsePositives, 'legitimate request')} would be blocked by this.</b>
      ${logFps.length ? `${logFps.length} of them actually went through the gateway before. ` : ''}
      They’re marked below. Tell me how to narrow it: “only for sales”, or “not when it’s their own data”.`);
  } else if (j.misses > 0) {
    say(`Nothing wrongly stopped, but ${plural(j.misses, 'example')} it should have caught got through. Say more precisely what you mean.`);
  } else if (against.length) {
    say('None of those real requests would have been stopped. Safe to activate.');
  } else {
    say(`Clean against its own examples. ${offerRegression()}`);
  }
  render();
}

function offerRegression() {
  const n = regressionSample().length;
  if (!n) return 'Activate it below when it reads right.';
  return `Want me to replay the last ${n} requests Warden allowed and see if this rule would have stopped any?
    <button type="button" class="btn --compact" id="regressBtn">Replay ${n} real requests</button>`;
}

function regressionSample() { return state.audit
  .filter((a) => a.decision?.verdict === 'ALLOW' && a.decision.maskedPrompt)
  .slice(0, REGRESSION_SAMPLE); }

export function bindPolicy() {
  // Not named `del`: that is the DELETE helper imported at the top of this
  // file, and a local const by the same name shadowed it, so the click called
  // the button element as a function and threw. The rule stayed exactly where
  // it was and the console said nothing, because the throw happened inside an
  // async handler nobody awaits.
  const remove = $('delRule');
  if (remove) remove.onclick = async () => {
    if (!confirm('Remove this rule? It stops binding everyone immediately.')) return;
    const { ok, j } = await del(`/api/policy/rules/${encodeURIComponent(remove.dataset.id)}`)
      .catch(() => ({ ok: false, j: { error: 'could not reach Warden' } }));
    if (!ok) {
      remove.insertAdjacentHTML('afterend', `<span class="note bad">${esc(readable(j) ?? 'could not remove it')}</span>`);
      return;
    }
    await Promise.all([refreshPolicy(), refreshPeople()]);
    go('policy');
  };

  bindLimits();
  bindSweeps();
  bindRuleFilters();
  bindModelPicker();

  const apply = $('applyLimits');
  if (apply) apply.onclick = async () => {
    apply.disabled = true;
    apply.textContent = 'Applying…';
    const { ok, j } = await post('/api/quotas/apply', { limits: state.pendingLimits ?? [] });
    if (!ok) { apply.disabled = false; apply.textContent = 'Apply these limits'; return; }
    state.pendingLimits = null;
    await refreshPolicy();
    say(`Done. ${plural(j.applied, 'role')} now on the new daily limit.`);
    render();
  };

  const cancel = $('cancelDraft');
  if (cancel) cancel.onclick = discardDraft;

  const send = $('ruleSend');
  if (send) send.onclick = () => writeRule($('ruleMsg').value);
  const msg = $('ruleMsg');
  sendOnEnter(msg, () => writeRule(msg.value));

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
    startDraftAudience();
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
  if (editAud) editAud.onclick = () => { state.audienceOpen = !state.audienceOpen; state.keepScroll = true; render(); };

  renderAudienceChips();

  const sevToggle = $('severityToggle');
  if (sevToggle) sevToggle.onclick = () => { state.severityOpen = !state.severityOpen; state.keepScroll = true; render(); };

  renderSeverityChips();

  // The two answers to "Issue" on the card: let Warden reword it (the same
  // free-text refine path as typing it yourself), or say the gap is fine and
  // move on. Neither one is a server call — refining re-enters the
  // conversation, keeping just closes the notice.
  const refine = $('refineBtn');
  if (refine) refine.onclick = () => sendRuleMessage(refine.dataset.refine);

  const keepIssue = $('keepIssueBtn');
  if (keepIssue) keepIssue.onclick = () => { state.issueDismissed = true; state.keepScroll = true; render(); };

  const drop = $('dropBtn');
  if (drop) drop.onclick = () => {
    // Discarding a card that was lifted out of a set puts it back on the
    // list as it was; the set is not what is being discarded.
    const editing = state.set?.editing;
    if (editing) {
      editing.status = editing.preview ? 'checked' : 'pending';
      state.set.editing = null;
      state.draft = null;
      state.preview = null;
      render();
      return;
    }
    discardDraft();
  };

  const ratify = $('ratifyBtn');
  if (ratify) ratify.onclick = async () => {
    // `sanitiseAudience` falls back to `['*']` on the server if this is ever
    // skipped, which is the right last-resort default but the wrong normal
    // path — a rule going live is a decision, and nobody has made it if the
    // chips were never touched. Refuse to send the request and ask instead.
    if (!state.audienceConfirmed) {
      state.audienceOpen = true;
      state.audienceWarning = true;
      render();
      return;
    }

    ratify.disabled = true;
    const person = state.draftFor;
    await post('/api/policy/ratify', { rule: state.draft });
    const id = state.draft.id;
    // A rule taken out of a set to be edited alone goes back to the set as an
    // active card, and the rest of the set stays on screen to be decided.
    if (state.set) {
      const item = state.set.editing;
      if (item) { item.rule = state.draft; item.status = 'active'; }
      state.set.editing = null;
      state.draft = null;
      state.preview = null;
      state.ruleBusy = false;
      await refreshPolicy();
      say('Activated. The rest of the set is below.');
      await settleSet();
      return;
    }
    resetDraft();
    await Promise.all([refreshPolicy(), refreshPeople()]);
    if (person) go('people', person); else go('policy', id);
  };

  bindSet();

}

/**
 * Called every time `state.draft` starts a new rule.
 *
 * Locked to a person's page is the only case with nothing to confirm — the
 * audience is fixed by context, not proposed by the model — so it is the
 * only case that starts already confirmed. Everything else, including the
 * next rule in a compiled set, starts unconfirmed even though a person is
 * mid-conversation, because the audience is a fresh proposal each time.
 */
export function startDraftAudience() {
  state.audienceConfirmed = Boolean(state.draftFor);
  state.audienceWarning = false;
  state.severityOpen = false;
  state.issueDismissed = false;
}

export function resetDraft() {
  state.draft = null;
  state.set = null;
  state.draftFor = null;
  state.preview = null;
  state.ruleChat = [];
  state.ruleBusy = false;
  state.audienceConfirmed = false;
  state.audienceWarning = false;
  state.severityOpen = false;
  state.issueDismissed = false;
}

/** Throws away the conversation and leaves you on a blank one — you came here
 *  to write a rule, so the tab you land on is still the one for writing rules.
 *  Unless you started from someone's page, in which case that is where you were. */
export function discardDraft() {
  const person = state.draftFor;
  resetDraft();
  if (person) go('people', person); else go('policy', 'new');
}

/**
 * The severity editor.
 *
 * No confirm step, unlike audience: an unconfirmed `['*']` audience fails
 * open onto everyone if it reaches Activate unseen, which is worth stopping
 * for. A severity nobody touched is just the compiler's own guess, already a
 * reasonable default either way — so this is a plain click-and-set.
 */
function renderSeverityChips() {
  const host = $('severityChips');
  if (!host || !state.draft) return;
  const options = [['block', 'Block'], ['escalate', 'Escalate'], ['warn', 'Warn']];
  host.innerHTML = options
    .map(([value, label]) => `<button type="button" class="chip${state.draft.severity === value ? ' on' : ''}" data-severity="${value}">${label}</button>`)
    .join('');
  host.onclick = (e) => {
    const chip = e.target.closest('[data-severity]');
    if (!chip) return;
    state.draft.severity = chip.dataset.severity;
    state.severityOpen = false;
    state.keepScroll = true;
    render();
  };
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

  // `rulesForActor` only lets the exemption cut apply to `*` rules — a chip
  // that names an exempt role or person explicitly does bind them, on
  // purpose (`docs/specs/solo-mode.md` §2). That is a real change from
  // "admin is exempt from everything", so a chip that reaches into it says
  // so here rather than leaving it as a silent side effect of a click.
  const roleOfToken = (token) => (token.startsWith('@') ? personById(token.slice(1))?.role : token);
  const exemptOn = opts.filter((o) => o.token !== '*' && on.has(o.token) && isExempt(roleOfToken(o.token) ?? ''));

  host.innerHTML = opts
    .map((o) => `<button type="button" class="chip${on.has(o.token) ? ' on' : ''}" data-token="${esc(o.token)}">${esc(o.label)}</button>`)
    .join('') + (exemptOn.length
      ? `<div class="note" id="audienceExemptNote" style="flex-basis:100%">This rule will also apply to ${exemptOn.map((o) => esc(o.label)).join(', ')} — normally exempt from every rule, but a rule that names them by role or by name reaches them anyway.</div>`
      : '');
  host.onclick = (e) => {
    const chip = e.target.closest('[data-token]');
    if (!chip) return;
    // Touching any chip — even re-confirming what the model already proposed
    // — is what makes the audience a decision instead of a default nobody
    // looked at. See the ratify handler, which refuses to fire until this is true.
    state.audienceConfirmed = true;
    const warnNote = $('audienceWarnNote');
    if (warnNote) warnNote.remove();
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
