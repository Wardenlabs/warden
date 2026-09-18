/**
 * Writing rules as a conversation: the hero, the turns, refining a proposal, and editing one draft.
 */
import { $, esc, post, state } from './core.js';
import { refreshPolicy } from './data.js';
import { clip, modelLabel, personById, plural, ruleName, sendOnEnter } from './format.js';
import { bindLimits } from './limits.js';
import { render } from './render.js';
import { go } from './router.js';
import { compileFailure, notARuleAnswer, readable } from './answers.js';
import { audience, effectMenu, isExempt } from './rules.js';
import { bindSet, included, proposalsBlock, replayMarkup, resultPage, revisionBlock, runSetPreviews } from './draft-set.js';
import { ICONS } from './icons.js';
import { button, composer, feedback, menu, pageHead, roleTone, statusText, turn } from './ui.js';

// ── the conversation ─────────────────────────────────────────────────────────
//
// Writing a rule is iterative: you say it, you see what it would have done, you
// narrow it. The old form could not express that — every reword was a fresh
// compile that threw away what you had learned. Here the check is part of the
// proposal rather than a button, and refining is the same box you started in.

/** Who writes the rules, in the words the drafting line uses. */
export function compilerName() {
  const c = state.compiler;
  if (c?.provider && c.provider !== 'local') {
    return ((c.providers ?? []).find((p) => p.id === c.provider)?.label ?? 'the compiler').replace(' on this machine', '');
  }
  return state.models?.drafting ? modelLabel(state.models.drafting.model) : 'the local model';
}

/**
 * What leaves the machine while a rule is drafted, said while it happens.
 *
 * The compiler receives the administrator's sentence, the role names and the
 * directory the audience is chosen from (CLAUDE.md, "Compilation may leave the
 * machine; judging may not"). The frame names only the first two; a line about
 * what leaves that leaves something out is not a transparency line.
 */
function transparencyLine() {
  const c = state.compiler;
  if (!c?.provider || c.provider === 'local') return '';
  return `Your sentence, the role names and the team list${c.redactNames ? ' (names replaced by IDs)' : ''} go to the compiler — requests under judgement never leave this machine.`;
}

const hasProposal = () => Boolean(state.set) && !state.set.result;

function pageHeader() {
  const set = state.set;
  const revising = Boolean(set?.revision?.set);
  const started = state.ruleChat.length > 0 || hasProposal();
  const person = state.draftFor ? personById(state.draftFor) : null;
  /*
   * The header's sentence goes down into the conversation, where the hero
   * already asks the question it was answering ("What should Warden protect?")
   * and the composer is the thing you answer with. What survives the move is
   * the one part that is not encouragement: whose rules these are, and that a
   * revision leaves the current drafts alone until you choose.
   *
   * The component draws its own hairline now, so the `<hr>` that used to close
   * this block is a second line under the first.
   */
  return pageHead({
    title: revising ? 'Review revised drafts' : 'Rules',
    crumbs: person
      ? [{ label: person.name, go: 'people', sel: person.id }]
      : [],
    quiet: (started && !state.ruleBusy && !set?.activating ? button('Start over', { kind: 'link', id: 'cancelDraft' }) : '')
      + button('View rules', { attrs: 'data-go="policy"' })
  });
}

/**
 * Whose rules these are, when they are one person's.
 *
 * The header used to carry it, tacked onto a sentence of encouragement that
 * went with the rest of the descriptions. It is not encouragement: a rule
 * drafted here binds one named person and no one else, and somebody who
 * reaches this screen from a person's page has to be told once. It says it
 * where the writing happens rather than in a band above it.
 */
function scopeNote() {
  const person = state.draftFor ? personById(state.draftFor) : null;
  return person ? ` Every rule here applies to ${esc(person.name)}.` : '';
}

/** The two suggestions the hero offers, as the administrator would type them. */
const TRIES = ['Keep customer data private', 'Ask before spending more than $500'];

/**
 * The catalogue, behind the composer's "+". It used to be a row of category
 * pills under the hero; the redesign keeps the hero to one question, one box
 * and two suggestions, and a preset is still one click from the box.
 */
function presetMenu() {
  const items = state.presets.flatMap((cat, i) => [
    { note: cat.label ?? cat.category },
    ...(cat.rules ?? []).map((r, k) => ({ label: clip(r.text, 70), attrs: `data-preset="${i}" data-r="${k}"` }))
  ]);
  if (!items.length) return '';
  return menu(items, { label: 'Start from a preset rule', trigger: '+', align: 'left', cls: '--up preset-menu', triggerCls: 'composer-attach' });
}

function heroPage() {
  return `<div class="new-rule --centred">
    <div class="sheet flush-head">${pageHeader()}</div>
    <div class="hero-fill">
      <div class="hero">
        <div class="rule-emblem" aria-hidden="true">${ICONS.brandMark}</div><h2 class="hero-q">Your AI.<br><span>Your rules.</span></h2>
        ${scopeNote() ? `<p class="hero-sub">${scopeNote().trim()}</p>` : ''}
        ${composer({ id: 'ruleMsg', sendId: 'ruleSend', placeholder: 'Describe a rule for your AI', sendLabel: 'Draft rules', disabled: true, attach: presetMenu() })}
        <div class="suggestions">${TRIES.map((t) => `<button type="button" class="suggestion" data-try="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      </div>
    </div>
  </div>`;
}

function renderTurn(t) {
  if (t.from === 'you') return turn('person', { body: esc(t.text), end: true });
  if (t.pending) {
    const note = t.note ?? transparencyLine();
    return turn('warden', { body: `<b class="turn-title">${t.html}</b>${note ? `<span class="turn-note">${esc(note)}</span>` : ''}` });
  }
  // Answers that are plates already (a decline, a failure) stand on their own.
  if (String(t.html).trimStart().startsWith('<div class="feedback')) return t.html;
  return `<div class="warden-note"><div class="warden-label">Warden</div><p>${t.html}</p></div>`;
}

function composerFor() {
  const set = state.set;
  const rev = set?.revision;
  if (rev?.set) return '';
  if (rev?.pending) return composer({ id: 'ruleMsg', sendId: 'ruleSend', placeholder: rev.text, value: rev.text, sendLabel: 'Revising…', busy: true, attach: '<span class="composer-attach" aria-hidden="true">+</span>' });
  if (rev?.error) return composer({ id: 'ruleMsg', sendId: 'ruleSend', placeholder: 'Refine this proposal…', value: rev.text, sendLabel: 'Retry refinement', attach: '<span class="composer-attach" aria-hidden="true">+</span>' });
  if (state.ruleBusy && !hasProposal()) return composer({ id: 'ruleMsg', sendId: 'ruleSend', placeholder: 'Waiting for the draft…', sendLabel: 'Draft rules', busy: true, attach: '<span class="composer-attach" aria-hidden="true">+</span>' });
  return composer({
    id: 'ruleMsg', sendId: 'ruleSend',
    placeholder: hasProposal() ? 'Refine this proposal…' : 'Describe a rule for your AI',
    sendLabel: 'Draft rules', disabled: true,
    attach: hasProposal() ? '<span class="composer-attach" aria-hidden="true">+</span>' : presetMenu()
  });
}

/**
 * The conversation pane: the header that does not scroll, the thread that
 * does, and the composer docked under it. The whole flow is the product's one
 * centred column (`.--centred`), so sending a sentence slides the box down
 * the column rather than moving it across the screen.
 */
export function ruleChatPane() {
  const set = state.set;
  if (set?.result) return resultPage();
  if (set && set.editing != null && set.items[set.editing]) return editDraftPage(set, set.items[set.editing]);
  if (!state.ruleChat.length && !set) return heroPage();
  const revising = set?.revision;
  const said = state.ruleChat.filter((t) => !(revising?.set && t.from === 'warden'));
  return `<div class="chatwrap --centred${state.ruleBusy && !hasProposal() ? ' --drafting' : ''}">
    <div class="sheet flush-head">${pageHeader()}</div>
    <div class="chat" id="ruleChat">
      <div class="thread">
        ${scopeNote() ? `<p class="thread-note">${scopeNote().trim()}</p>` : ''}
        ${said.map(renderTurn).join('')}
        ${revising?.set ? revisionBlock() : proposalsBlock()}
        ${revising?.pending ? `${turn('warden', { body: '<b class="turn-title">Revising the proposal…</b><span class="turn-note">Your current drafts stay unchanged until you accept the revised proposal. Nothing is being activated.</span>' })}
          <div class="refinement"><span class="field-label">Your refinement</span><p>${esc(revising.text)}</p></div>` : ''}
        ${replayMarkup()}
      </div>
    </div>
    <div class="chat-foot"><div class="thread">${composerFor()}</div></div>
  </div>`;
}

export function say(html, pending = false, note) {
  // The same sentence twice in a row is never two answers. A compile failure
  // was seen printed as two identical WARDEN turns; whatever path produced the
  // second, the reader gains nothing from it.
  const last = state.ruleChat.at(-1);
  if (!pending && last?.from === 'warden' && !last.pending && last.html === html) return;
  state.ruleChat.push({ from: 'warden', html, pending, ...(note ? { note } : {}) });
}

function dropPending() {
  state.ruleChat = state.ruleChat.filter((t) => !t.pending);
}

/**
 * The conversation so far, for the compiler: what the administrator said
 * before this message, and the rules on the table now. Without it every
 * message compiled as if it were the first, and "hacelo solo para ventas"
 * after a set of five became a rule about sales. A refinement is not in the
 * thread yet — it joins only if the revised drafts are accepted — so for one
 * the whole thread is history.
 */
function conversation(refining) {
  const said = state.ruleChat.filter((t) => t.from === 'you').map((t) => t.text);
  const history = (refining ? said : said.slice(0, -1)).slice(-6);
  const current = state.set ? state.set.items.filter((it) => it.status !== 'active' && it.status !== 'excluded').map((it) => it.rule.text) : [];
  return { history, current };
}

const newSet = (rules, j = {}) => ({
  items: rules.map((rule) => ({ rule, preview: null, status: 'pending' })),
  limits: j.limits ?? null,
  factor: j.factor,
  draftedBy: rules[0]?.draftedBy ?? null,
  remote: Boolean(rules[0]?.draftedRemotely)
});

function writeRule(text) {
  // `capable` is the gateway saying which compiler is in force, environment
  // included; `provider` is only what was saved from this page, and a CLI set
  // by environment variable left it at "local" and skipped the split.
  const capable = state.compiler?.capable ?? ((state.compiler?.provider ?? 'local') !== 'local');
  return compile(text, capable);
}

/**
 * Send the sentence to the compiler, and put what comes back on the table.
 *
 * A first message becomes the proposal. A message while a proposal is open is
 * a refinement, and its answer is held beside the current drafts until the
 * administrator chooses: the compiler is stateless and replacing the drafts
 * the moment it answered threw away edits and exclusions nobody agreed to lose.
 *
 * A decline is an answer, not an error. "Quiero reducir mi uso al 50%" is a
 * spending target, and the honest reply is the screen that holds spending
 * targets, not a prohibition invented to fit the shape.
 */
async function compile(text, capable) {
  const clean = String(text ?? '').trim();
  if (!clean || state.ruleBusy) return;
  const refining = hasProposal() && !state.set.failed;

  state.ruleBusy = true;
  // The field is emptied before the redraw: the redraw carries typed values
  // across, and a sent sentence left in the box reads as not sent.
  const box = $('ruleMsg');
  if (box) box.value = '';
  state.followChat = true;
  if (refining) state.set.revision = { pending: true, text: clean };
  else {
    state.ruleChat.push({ from: 'you', text: clean });
    say(`Drafting rules with ${esc(compilerName())}…`, true);
  }
  if (state.view === 'policy' && state.sel === 'new') render(); else go('policy', 'new');

  const body = { text: clean, ...conversation(refining) };
  if (state.draftFor) body.lockTo = [`@${state.draftFor}`];
  // The compiler has no notion of a conversation on the direct path, so a
  // refinement of one rule is sent as that rule plus the correction. Restating
  // the rule is what keeps the second turn from being read as a new one.
  const single = refining ? included(state.set) : [];
  if (refining && !capable && single.length === 1) body.text = `${single[0].rule.text}\n\nChange it as follows: ${clean}`;

  const { ok, j } = await post(capable ? '/api/policy/draft-set' : '/api/policy/draft', body)
    .catch(() => ({ ok: false, j: { error: 'Warden could not be reached.' } }));
  const rules = capable ? (Array.isArray(j?.rules) ? j.rules : []) : (ok && j && !j.notARule ? [j] : []);
  state.ruleBusy = false;
  dropPending();

  if (refining) {
    if (!state.set) return;
    state.set.revision = ok && rules.length
      ? { text: clean, set: newSet(rules, j) }
      : { error: true, text: clean, why: j?.notARule ? `The compiler read it as not being a rule: ${j.reason || 'there is no prohibition in it.'}` : readable(j?.error ?? 'The compiler did not answer.') };
    render();
    return;
  }
  if (!ok || !rules.length) {
    say(j?.notARule ? notARuleAnswer(j) : compileFailure(j));
    render();
    return;
  }
  state.set = newSet(rules, j);
  state.reviewOpen = false;
  state.followChat = true;
  render();
  await runSetPreviews(state.set);
}

function acceptRevision() {
  const set = state.set;
  const rev = set?.revision;
  if (!rev?.set) return;
  state.ruleChat.push({ from: 'you', text: rev.text });
  // Rules already live stay as the record they are; everything else is replaced.
  const kept = set.items.filter((it) => it.status === 'active');
  state.set = { ...rev.set, items: [...kept, ...rev.set.items] };
  render();
  void runSetPreviews(state.set);
}

// ── editing one draft ────────────────────────────────────────────────────────

/**
 * Edit draft: the same page as editing a live rule, for a rule nothing binds
 * yet. Who it applies to is chosen here, because the compiler proposes an
 * audience and a person decides it. A changed instruction goes back through
 * the compiler for the same reason as a live one: the examples it is checked
 * and judged against were written for the sentence it had.
 */
function draftEdit(set, item) {
  if (!set.edit) set.edit = { text: item.rule.text, severity: item.rule.severity, appliesTo: [...item.rule.appliesTo], version: 1, error: '', busy: false, audienceOpen: false };
  return set.edit;
}

const sameAudience = (a, b) => a.length === b.length && a.every((t) => b.includes(t));

function audiencePicker(e) {
  if (state.draftFor) return `<span class="labels">${audience(e.appliesTo)}</span><span class="fact-note">locked, you started this from their page</span>`;
  const on = new Set(e.appliesTo);
  const opts = [
    { token: '*', label: 'Everyone', tone: 'everyone' },
    ...state.company.roles.map((r) => ({ token: r, label: r, tone: roleTone(r) })),
    ...state.company.employees.map((p) => ({ token: `@${p.id}`, label: p.name, tone: 'everyone' }))
  ];
  const items = opts.map((o) => `<button type="button" role="menuitemcheckbox" aria-checked="${on.has(o.token)}" class="menu-item" data-token="${esc(o.token)}"><i class="menu-dot --${o.tone}"></i><span>${esc(o.label)}</span>${on.has(o.token) ? '<b class="menu-check">✓</b>' : ''}</button>`).join('');
  return `<details class="menu --left audience-picker"${e.audienceOpen ? ' open' : ''}>
    <summary class="menu-trigger audience-trigger" aria-label="Who this rule applies to"><span class="labels">${audience(e.appliesTo)}</span><i class="caret" aria-hidden="true">▾</i></summary>
    <div class="menu-list" role="menu">${items}</div>
  </details>`;
}

function editDraftPage(set, item) {
  const e = draftEdit(set, item);
  const empty = !e.text.trim();
  const changed = e.text.trim() !== item.rule.text;
  const dirty = changed || e.severity !== item.rule.severity || !sameAudience(e.appliesTo, item.rule.appliesTo);
  // `rulesForActor` only lets the exemption cut apply to `*` rules — a rule that
  // names an exempt role or person explicitly does bind them, on purpose
  // (docs/specs/solo-mode.md §2). A pick that reaches into it says so.
  const exemptNamed = e.appliesTo.filter((t) => t !== '*' && isExempt(t.startsWith('@') ? personById(t.slice(1))?.role ?? '' : t))
    .map((t) => (t.startsWith('@') ? personById(t.slice(1))?.name ?? t : t));
  return `<div class="sheet">
    ${pageHead({
      title: ruleName(item.rule),
      /*
       * Cancel goes, but not the way it goes when editing a saved rule.
       *
       * There, Cancel called the same `go()` the crumb calls and both passed
       * through the same leave guard, so removing the button removed nothing.
       * Here it does not: the proposal and the draft editor are the same route
       * (`policy/new`), and `set.editing` is what tells them apart, so a crumb
       * that only changed the hash would navigate to the page it is already on
       * and leave the editor open. The crumb carries the cancel instead —
       * which is what "Back to proposal" meant all along — and `bindDraftEdit`
       * is what makes it true.
       */
      crumbs: [{ label: 'Back to proposal', id: 'draftCancel' }],
      quiet: button('Test rule', { id: 'draftTest', disabled: empty || e.busy }),
      primary: button(e.busy ? 'Saving…' : 'Save draft', { kind: 'primary', id: 'draftSave', disabled: empty || !dirty, busy: e.busy })
    })}
    ${e.error ? feedback({ tone: 'error', title: 'Could not save the draft', body: `${esc(e.error)} Your changes are kept below; the proposal still has the earlier draft.`, icon: true }) : ''}
    <div class="facts">
      ${statusText('Draft · not active')}
      <span class="fact"><span class="fact-k">Applies to</span>${audiencePicker(e)}</span>
      <span class="fact"><span class="fact-k">Effect</span>${effectMenu(e.severity, 'data-draft-severity')}</span>
    </div>
    ${exemptNamed.length ? `<p class="fact-note">Includes exempt roles: ${esc(exemptNamed.join(', '))}.</p>` : ''}
    <hr class="hairline">
    <div class="field rule-field${e.invalid && empty ? ' --error' : ''}">
      <label for="draftText">Rule instruction</label>
      <textarea id="draftText" rows="3"${e.busy ? ' readonly' : ''}>${esc(e.text)}</textarea>
      ${e.invalid && empty ? '<span class="field-help" role="alert">Enter an instruction.</span>' : ''}
    </div>
  </div>`;
}

function bindDraftEdit(set) {
  const item = set.items[set.editing];
  const e = set.edit;
  if (!item || !e) return;
  const leave = () => { set.editing = null; set.edit = null; render(); };
  $('draftCancel').onclick = leave;
  const text = $('draftText');
  if (text) text.oninput = () => {
    const before = [!e.text.trim(), e.text.trim() !== item.rule.text].join();
    e.text = text.value;
    e.version++;
    if (before !== [!e.text.trim(), e.text.trim() !== item.rule.text].join()) { e.invalid = !e.text.trim(); render(); }
  };
  for (const b of document.querySelectorAll('[data-draft-severity]')) b.onclick = () => {
    b.closest('details.menu')?.removeAttribute('open');
    if (e.severity !== b.dataset.draftSeverity) { e.severity = b.dataset.draftSeverity; e.version++; }
    render();
  };
  const picker = document.querySelector('.audience-picker');
  if (picker) {
    picker.ontoggle = () => { e.audienceOpen = picker.open; };
    for (const b of picker.querySelectorAll('[data-token]')) b.onclick = () => {
      const token = b.dataset.token;
      const next = new Set(e.appliesTo);
      // "Everyone" is not one audience among many — it subsumes them.
      if (token === '*') e.appliesTo = ['*'];
      else {
        next.delete('*');
        if (next.has(token)) next.delete(token); else next.add(token);
        e.appliesTo = next.size ? [...next] : ['*'];
      }
      e.audienceOpen = true;
      e.version++;
      render();
    };
  }
  $('draftTest').onclick = () => {
    state.testDraft = {
      rule: { ...item.rule, text: e.text.trim(), severity: e.severity, appliesTo: e.appliesTo },
      version: e.version,
      back: { view: 'policy', sel: 'new', label: 'Back to edit' },
      unsaved: true
    };
    go('simulator', null, { draft: '1' });
  };
  $('draftSave').onclick = async () => {
    if (!e.text.trim()) { e.invalid = true; render(); return; }
    e.busy = true; e.error = '';
    render();
    let next = { ...item.rule, severity: e.severity, appliesTo: e.appliesTo };
    if (e.text.trim() !== item.rule.text) {
      const { ok, j } = await post('/api/policy/draft', { text: e.text.trim(), lockTo: e.appliesTo }).catch(() => ({ ok: false, j: { error: 'Warden could not be reached.' } }));
      if (!ok || j?.notARule) {
        e.busy = false;
        e.error = j?.notARule ? `The compiler read that as not being a rule: ${j.reason || 'there is no prohibition in it.'}` : readable(j?.error ?? 'The compiler did not answer.');
        render();
        return;
      }
      next = { ...j, severity: e.severity, appliesTo: e.appliesTo };
    }
    item.rule = next;
    item.preview = null;
    item.status = 'pending';
    set.editing = null;
    set.edit = null;
    render();
    void runSetPreviews(set);
  };
}

// ── bindings ─────────────────────────────────────────────────────────────────

export function bindPolicy() {
  bindLimits();
  if (!(state.view === 'policy' && state.sel === 'new')) return;
  const set = state.set;
  if (set && set.editing != null) { bindDraftEdit(set); return; }

  const apply = $('applyLimits');
  if (apply) apply.onclick = async () => {
    apply.disabled = true;
    apply.textContent = 'Applying…';
    const { ok, j } = await post('/api/quotas/apply', { limits: state.pendingLimits ?? [] }).catch(() => ({ ok: false, j: null }));
    if (!ok) { apply.disabled = false; apply.textContent = 'Apply these limits'; return; }
    state.pendingLimits = null;
    if (state.set) { state.set.factor = undefined; state.set.limits = null; }
    await refreshPolicy();
    say(`Done. ${plural(j.applied, 'role')} now on the new daily limit.`);
    render();
  };

  const cancel = $('cancelDraft');
  if (cancel) cancel.onclick = discardDraft;

  const box = $('ruleMsg');
  const send = $('ruleSend');
  if (box && send) {
    const sync = () => { if (!box.disabled) send.disabled = !box.value.trim(); };
    box.oninput = sync;
    sync();
    send.onclick = () => writeRule(box.value);
    sendOnEnter(box, () => writeRule(box.value));
  }
  for (const t of document.querySelectorAll('[data-try]')) t.onclick = () => {
    const b = $('ruleMsg');
    if (!b) return;
    b.value = t.dataset.try;
    b.dispatchEvent(new Event('input'));
    b.focus();
  };

  for (const btn of document.querySelectorAll('[data-preset]')) btn.onclick = () => {
    btn.closest('details.menu')?.removeAttribute('open');
    // A preset arrives complete, but it still enters the proposal so it passes
    // the same check and the same review as anything written by hand.
    const r = state.presets[Number(btn.dataset.preset)]?.rules?.[Number(btn.dataset.r)];
    if (!r) return;
    state.ruleChat.push({ from: 'you', text: r.text });
    say('Taken from the catalogue. It is checked against its examples like any other draft.');
    state.set = newSet([{ ...r, id: `r-preset-${Date.now().toString(36)}`, ...(state.draftFor ? { appliesTo: [`@${state.draftFor}`] } : {}) }]);
    render();
    void runSetPreviews(state.set);
  };

  const use = $('useRevision');
  if (use) use.onclick = acceptRevision;
  const keep = $('keepDrafts');
  if (keep) keep.onclick = () => { if (state.set) state.set.revision = null; render(); };

  bindSet(resetDraft);
}

export function resetDraft() {
  state.draft = null;
  state.set = null;
  state.draftFor = null;
  state.preview = null;
  state.ruleChat = [];
  state.ruleBusy = false;
  state.reviewOpen = false;
}

/** Throws away the conversation and leaves you on a blank one — you came here
 *  to write a rule, so the page you land on is still the one for writing rules.
 *  Unless you started from someone's page, in which case that is where you were. */
export function discardDraft() {
  const person = state.draftFor;
  resetDraft();
  if (person) go('people', person); else go('policy', 'new');
}
