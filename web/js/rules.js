/**
 * Rules: the policy as a list, one rule as a page, editing it in place, and the shell's notices.
 */
import { bindLogPeek, readable } from './answers.js';
import { $, del, esc, post, severityMeans, state } from './core.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { bindPolicy, ruleChatPane } from './draft.js';
import { audienceLabel, dayKey, personById, plural, ruleName } from './format.js';
import { disclosure, render } from './render.js';
import { go } from './router.js';
import {
  audienceLabels, button, dialog, effectText, feedback, filters,
  listState, menu, pageHead, search, showToast, statusText
} from './ui.js';
import { VIEWS } from './views.js';

// ═══ RULES ═══════════════════════════════════════════════════════════════════

/**
 * Rules has a full-width catalogue and a focused writing conversation.
 * `new` opens the composer; an ID or `edit:<id>` opens the shared detail
 * panel over the catalogue. The record still has its own shareable URL.
 */
function onNewRule() { return state.view === 'policy' && state.sel === 'new'; }
function inConversation() { return onNewRule() && (state.ruleChat.length > 0 || Boolean(state.draft) || Boolean(state.set)); }
export function composing() { return inConversation(); }
const editingId = () => (state.view === 'policy' && state.sel?.startsWith('edit:') ? state.sel.slice(5) : null);
const ruleById = (id) => state.policy.rules.find((r) => r.id === id) ?? null;

VIEWS.policy = {
  detail: () => Boolean(state.sel) && !onNewRule(),
  background: () => listPage(true),
  detailLabel: 'Rules',
  // The conversation fills the pane and scrolls inside itself; the result page
  // and editing one draft are ordinary pages that scroll with the pane.
  flush: () => onNewRule() && !state.set?.result && state.set?.editing == null,
  body: () => {
    if (onNewRule()) return ruleChatPane();
    if (editingId()) return editPage(ruleById(editingId()));
    if (state.sel) return detailPage(ruleById(state.sel));
    return listPage();
  },
  bind: () => {
    bindPolicy();
    if (onNewRule()) return;
    if (editingId()) bindEdit(); else if (state.sel) bindLogPeek(); else bindList();
    bindRuleActions();
  },
  holdLeave: (next) => holdEdit(next),
  keepOnEscape: () => Boolean(editingId())
};

/** Everyone a rule reaches, as role labels, with people shown by name. */
export const audience = (appliesTo, max) => audienceLabels(appliesTo, (id) => personById(id)?.name ?? `${id} (removed)`, max);

// ── what a rule has done today ───────────────────────────────────────────────

/**
 * What a rule has done today. The row and the page read it from here rather
 * than each counting for itself: the row is a summary of the page, and a
 * summary that computes its own numbers is a second implementation of them
 * waiting to disagree.
 *
 * "Today" because that is what the column says. The audit log records the
 * rules that fired, not every rule that was consulted, so these are matches,
 * never checks: a count of checks is not something the record can support.
 *
 * Disputes are the only false-positive signal the console has — in the audit
 * log a correct block and an incorrect one are the same record — so a rule
 * that has any says so in the list, not only once you open it.
 */
function ruleActivity(rule) {
  const today = dayKey(new Date().toISOString());
  const fired = (a) => (a.decision?.firedRules ?? []).some((r) => r.ruleId === rule.id);
  const hits = state.audit.filter((a) => dayKey(a.ts) === today && fired(a));
  return {
    hits,
    blocked: hits.filter((h) => h.decision?.verdict === 'BLOCK').length,
    held: hits.filter((h) => h.decision?.verdict === 'ESCALATE').length,
    waiting: state.escalations.filter((e) => e.ruleId === rule.id && !e.review).length,
    disputed: state.appeals.filter((a) => a.ruleId === rule.id)
  };
}

function activityPhrase(rule) {
  const { hits, blocked, held, waiting, disputed } = ruleActivity(rule);
  if (!hits.length) return 'Has not fired today';
  if (disputed.length) return `${blocked + held} of ${hits.length} · ${disputed.length} disputed`;
  // A warn rule stops nothing by design, so "stopped 0 of 3" would read as a
  // rule that is failing rather than one doing exactly what it was set to do.
  if (rule.severity === 'warn') return `Noted ${plural(hits.length, 'time')} · Blocked none`;
  if (rule.severity === 'escalate') return `Held ${held} of ${hits.length}${waiting ? ' · Awaiting review' : ''}`;
  return `Stopped ${blocked} of ${hits.length}`;
}

// ── the list ─────────────────────────────────────────────────────────────────

/**
 * Filtering is local to the module and never touches the hash: `#/policy/<id>`
 * means "this rule is open", and a severity filter is not a place you link
 * somebody to.
 */
let severity = 'all';
let query = '';

function matches(rule) {
  if (severity !== 'all' && rule.severity !== severity) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${ruleName(rule)} ${rule.text} ${audienceLabel(rule.appliesTo)}`.toLowerCase().includes(q);
}

/*
 * No description, and no crumb.
 *
 * "Set the boundaries. Keep your team moving." was read on day one and was
 * furniture every day after, in a tool somebody opens daily; the filters under
 * it already count the rules by effect, which is the only thing that sentence
 * was ever near saying. And the sidebar item is lit: a crumb reading "Rules"
 * on the Rules page tells whoever clicked to get here nothing they did not do
 * themselves.
 *
 * `loaded` false is the page that could not read the policy. It keeps one
 * quiet action and no primary — there is no honest primary on a page whose
 * subject failed to load, and testing rules nobody could fetch is not one.
 */
const listHead = (loaded = true, strip = '') => pageHead({
  title: 'Rules',
  quiet: loaded ? button('Test rules →', { attrs: 'data-go="simulator"' }) : '',
  primary: loaded ? button('+ New rule', { kind: 'primary', attrs: 'data-go="policy" data-sel="new"' }) : '',
  strip
});

function listPage(context = false) {
  const rules = state.policy.rules;
  const load = state.loads.policy;

  if (!load || (load.loading && !rules.length)) {
    return `<div class="sheet">${listHead()}
      ${listState({ title: 'Loading workspace rules…' })}</div>`;
  }
  if (load.error) {
    return `<div class="sheet">${listHead(false)}
      ${listState({ title: 'Could not load the rules', body: 'We could not confirm the current policy state. Retry to load the latest rules.', icon: true, action: button('Retry loading', { kind: 'primary', id: 'retryRules' }) })}</div>`;
  }
  if (!rules.length) {
    return `<div class="sheet">${listHead()}
      ${listState({ title: 'No workspace rules yet', body: 'Describe what Warden should detect to create your first rule.' })}</div>`;
  }

  const shown = rules.filter(matches);
  const count = (s) => rules.filter((r) => r.severity === s).length;
  const toolbar = filters([['all', `All rules  ${rules.length}`], ['block', `Block  ${count('block')}`], ['escalate', `Escalate  ${count('escalate')}`], ['warn', `Warn  ${count('warn')}`]], severity, 'severity')
    + search('ruleSearch', query, 'Search rules…');

  const body = shown.length
    ? `<div class="table rules-table" role="table" aria-label="Rules">
        <div class="thead" role="row"><span>Rule</span><span>Applies to</span><span>Effect</span><span>Activity · Today</span><span></span></div>
        ${shown.map(ruleRow).join('')}
      </div>
      <div class="table-foot"><button type="button" class="linkbtn --danger" id="wipeRules">Delete every rule…</button></div>`
    : listState({
      title: query.trim() ? `No rules match “${query.trim()}”` : `No ${severity} rules`,
      body: `Try a different search or clear it to see all ${plural(rules.length, 'rule')}.`,
      action: button(query.trim() ? 'Clear search' : 'Show every rule', { id: 'clearRuleFilter' })
    });

  return `<div class="sheet">
    ${listHead(true, toolbar)}
    ${body}
    ${context ? '' : removeDialogMarkup()}
    ${context ? '' : wipeDialogMarkup()}
  </div>`;
}

/** The ··· on a row repeats exactly the actions of the rule's page. */
function ruleActions(rule) {
  return [
    { label: 'Edit rule', attrs: `data-go="policy" data-sel="edit:${esc(rule.id)}"` },
    { label: 'Test rule', act: 'test-rule', attrs: `data-rule="${esc(rule.id)}"` },
    { label: 'Remove rule…', act: 'remove-rule', attrs: `data-rule="${esc(rule.id)}"`, destructive: true }
  ];
}

function ruleRow(r) {
  return `<div class="trow --link" role="row" tabindex="0" data-go="policy" data-sel="${esc(r.id)}">
    <span class="rule-name"><i class="dot --allow" aria-hidden="true"></i><span class="cell-strong">${esc(ruleName(r))}</span></span>
    <span class="labels">${audience(r.appliesTo, 1)}</span>
    <span>${effectText(r.severity)}</span>
    <span class="cell-clip rule-activity">${esc(activityPhrase(r))}</span>
    <span class="row-menu">${menu(ruleActions(r), { label: `Actions for ${ruleName(r)}` })}</span>
  </div>`;
}

function bindList() {
  for (const b of document.querySelectorAll('[data-severity]')) b.onclick = () => { severity = b.dataset.severity; render(); };
  const box = $('ruleSearch');
  if (box) box.oninput = () => { query = box.value; render(); };
  const clear = $('clearRuleFilter');
  if (clear) clear.onclick = () => { severity = 'all'; query = ''; render(); };
  const retry = $('retryRules');
  if (retry) retry.onclick = async () => { retry.disabled = true; await refreshPolicy(); render(); };
  const wipe = $('wipeRules');
  if (wipe) wipe.onclick = () => { dialogs.wipe = true; render(); };
  const confirmWipe = $('confirmWipeRules');
  if (confirmWipe) confirmWipe.onclick = async () => {
    confirmWipe.disabled = true;
    const { ok, j } = await del('/api/policy/rules').catch(() => ({ ok: false, j: null }));
    if (!ok) { dialogs.wipeError = readable(j?.error ?? 'Warden could not be reached.'); render(); return; }
    dialogs.wipe = false; dialogs.wipeError = '';
    await Promise.all([refreshPolicy(), refreshPeople()]);
    render();
  };
}

// ── removing ─────────────────────────────────────────────────────────────────

/**
 * Remove, not deactivate. The frames offer a reversible "Deactivate…", and the
 * policy has no inactive state to put a rule in: `DELETE` takes it out of the
 * policy and that is all the gateway can do. So the button says what happens
 * and the dialog says it again (docs/specs/console-redesign-v2-api-gaps.md).
 */
const dialogs = { remove: null, removeError: '', wipe: false, wipeError: '' };

function removeDialogMarkup() {
  const rule = dialogs.remove && ruleById(dialogs.remove);
  if (!rule) return '';
  return dialog({
    id: 'removeRule',
    title: 'Remove this rule?',
    body: `<p><b>${esc(ruleName(rule))}</b> stops binding ${esc(audienceLabel(rule.appliesTo))} immediately. There is no inactive state to keep it in: to use it again, write it again.</p>
      ${dialogs.removeError ? feedback({ tone: 'error', title: 'The rule could not be removed', body: `${esc(dialogs.removeError)} It is still active.`, icon: true }) : ''}`,
    actions: button('Cancel', { attrs: 'data-dialog-close="removeRule"' }) + button(dialogs.removeError ? 'Retry removal' : 'Remove rule', { kind: 'danger', id: 'confirmRemoveRule' })
  });
}

function wipeDialogMarkup() {
  if (!dialogs.wipe) return '';
  return dialog({
    id: 'wipeRules',
    title: `Delete all ${plural(state.policy.rules.length, 'rule')}?`,
    body: `<p>Warden will stop nothing until you write another. Limits by role are kept.</p>
      ${dialogs.wipeError ? feedback({ tone: 'error', title: 'The rules could not be deleted', body: esc(dialogs.wipeError), icon: true }) : ''}`,
    actions: button('Cancel', { attrs: 'data-dialog-close="wipeRules"' }) + button('Delete every rule', { kind: 'danger', id: 'confirmWipeRules' })
  });
}

/** One handler for the actions a row menu and a rule's page share, and the dialogs they open. */
function bindRuleActions() {
  $('pane').onclick = (e) => {
    if (state.view !== 'policy') return;
    const remove = e.target.closest('[data-act="remove-rule"]');
    if (remove) { remove.closest('details.menu')?.removeAttribute('open'); dialogs.remove = remove.dataset.rule; dialogs.removeError = ''; render(); $('confirmRemoveRule')?.focus(); return; }
    const test = e.target.closest('[data-act="test-rule"]');
    if (test) { test.closest('details.menu')?.removeAttribute('open'); testRule(ruleById(test.dataset.rule)); return; }
    const close = e.target.closest('[data-dialog-close]');
    if (close || e.target.matches('[data-dialog-scrim]')) {
      const id = close?.dataset.dialogClose ?? e.target.dataset.dialogScrim;
      if (id === 'removeRule') { dialogs.remove = null; dialogs.removeError = ''; }
      if (id === 'wipeRules') { dialogs.wipe = false; dialogs.wipeError = ''; }
      if (id === 'leaveEdit') editor.pending = null;
      render();
    }
  };
  const confirmRemove = $('confirmRemoveRule');
  if (confirmRemove) confirmRemove.onclick = async () => {
    confirmRemove.disabled = true;
    const id = dialogs.remove;
    // Not named `del` in a local: that is the DELETE helper, and shadowing it
    // once made this click call the button element as a function and throw
    // inside an async handler nobody awaits.
    const { ok, j } = await del(`/api/policy/rules/${encodeURIComponent(id)}`).catch(() => ({ ok: false, j: { error: 'Warden could not be reached.' } }));
    if (!ok) { dialogs.removeError = readable(j?.error ?? 'The gateway refused the change.'); render(); return; }
    const name = ruleName(ruleById(id));
    dialogs.remove = null;
    await Promise.all([refreshPolicy(), refreshPeople()]);
    go('policy');
    showToast(`${name} was removed`, 'It no longer binds anyone.');
  };
}

// ── one rule ─────────────────────────────────────────────────────────────────

/** Testing a saved rule runs that rule alone, exactly as it is saved. */
function testRule(rule) {
  if (!rule) return;
  state.testDraft = { rule: { ...rule }, version: 1, back: { view: 'policy', sel: rule.id, label: 'Back to rule' }, unsaved: false };
  go('simulator', null, { draft: '1' });
}

function missingRule() {
  return `<div class="sheet">
    ${pageHead({ title: 'This rule is not in the policy', crumbs: [{ label: 'Rules', go: 'policy' }] })}
    ${listState({ title: state.loads.policy?.loading ? 'Loading the policy…' : 'Nothing to show', body: state.loads.policy?.loading ? '' : 'It was removed, or the link is from another installation.' })}</div>`;
}

/** A gateway error as a sentence, so the copy after it does not run on from it. */
export const sentence = (s) => (/[.!?]$/.test(String(s).trim()) ? String(s).trim() : `${String(s).trim()}.`);

const capital = (s) => String(s).replace(/^./, (c) => c.toUpperCase());

/**
 * Header / Detail, Management pattern: the facts on one line, what it has done
 * on the next, and the instruction the judge reads. Everything a rule carries
 * that the page does not lead with — what it is not about, what people are
 * told, the examples the judge is shown, the record — folds under it.
 */
function detailPage(rule) {
  if (!rule) return missingRule();
  const { hits, blocked, held, disputed } = ruleActivity(rule);
  const guidance = hits[0]?.decision.firedRules.find((r) => r.ruleId === rule.id)?.guidance ?? rule.guidance;
  const examples = rule.examples ?? {};
  const outcome = rule.severity === 'warn' ? 'none blocked' : `${blocked + held} ${rule.severity === 'escalate' ? 'held' : 'blocked'}`;
  return `<div class="sheet">
    ${pageHead({
      title: ruleName(rule),
      crumbs: [{ label: 'Rules', go: 'policy' }],
      primary: button('Edit rule', { kind: 'primary', attrs: `data-go="policy" data-sel="edit:${esc(rule.id)}"` }),
      quiet: button('Test rule', { attrs: `data-act="test-rule" data-rule="${esc(rule.id)}"` }),
      more: [{ label: 'Remove rule…', act: 'remove-rule', attrs: `data-rule="${esc(rule.id)}"`, destructive: true }]
    })}
    <div class="facts">
      ${statusText('Active', 'allow')}
      <span class="fact"><span class="fact-k">Applies to</span><span class="labels">${audience(rule.appliesTo)}</span></span>
      <span class="fact"><span class="fact-k">Effect</span>${statusText(capital(rule.severity), rule.severity === 'block' ? 'block' : 'attention')}</span>
    </div>
    <div class="facts --second">
      <span class="fact-k">Activity</span>
      <span class="fact-v">${hits.length ? `Today · ${plural(hits.length, 'match', 'matches')} · ${outcome}${disputed.length ? ` · ${disputed.length} disputed` : ''}` : 'Has not fired today'}</span>
      ${button('View activity →', { kind: 'link', attrs: `data-go="activity" data-q="rule=${encodeURIComponent(rule.id)}"` })}
    </div>
    <hr class="hairline">
    <section class="rule-instruction reading">
      <h2 class="section-title --big">Rule instruction</h2>
      <p>${esc(rule.text)}</p>
    </section>
    <div class="disclosures reading">
      ${rule.boundary ? disclosure('r:boundary', 'What it is not about', `<p class="disclosure-text">${esc(rule.boundary)}</p>`) : ''}
      ${guidance ? disclosure('r:told', 'What people are told when it fires', `<p class="disclosure-text">“${esc(guidance)}”</p>`) : ''}
      ${examples.violating || examples.compliant ? disclosure('r:examples', 'Examples the judge is shown', `
        <div class="example-list"><span class="kicker">Would be stopped</span>${(examples.violating ?? []).map((x) => `<p>${esc(x)}</p>`).join('') || '<p>—</p>'}</div>
        <div class="example-list"><span class="kicker">Must still go through</span>${(examples.compliant ?? []).map((x) => `<p>${esc(x)}</p>`).join('') || '<p>—</p>'}</div>`) : ''}
      ${disputed.length ? disclosure('r:disputes', 'Reported as wrong', `<p class="disclosure-text">${plural(disputed.length, 'person', 'people')} said a block by this rule was wrong.</p><div>${button('See the reports', { compact: true, attrs: 'data-go="inbox"' })}</div>`, `${disputed.length} open`) : ''}
      ${disclosure('r:id', 'Technical record', `<dl class="record"><dt>Rule id</dt><dd class="mono">${esc(rule.id)}</dd><dt>Scope</dt><dd>${esc(rule.scope ?? '—')}</dd><dt>Checked</dt><dd>${rule.pinned ? 'on every request' : 'when the request looks related'}</dd></dl>`, `<span class="mono">${esc(rule.id)}</span>`)}
    </div>
    ${removeDialogMarkup()}
  </div>`;
}

// ── editing in place ─────────────────────────────────────────────────────────

/**
 * One rule's edit, held here until it is saved or dropped.
 *
 * Saving a changed instruction recompiles before it ratifies. The judge is
 * shown the rule's own examples (src/guard/passes/shots.ts), and those were
 * written for the old sentence: ratifying new text beside old examples would
 * change how requests are judged without anyone having measured it. So a new
 * sentence goes back through the compiler with the audience locked and the
 * id kept, and the effect the administrator chose is put back on the result.
 * Changing only the effect needs no compiler and ratifies directly.
 */
export const editor = { id: null, text: '', severity: '', error: '', busy: false, invalid: false, pending: null, version: 1 };

function openEditor(rule) {
  if (editor.id === rule.id) return;
  Object.assign(editor, { id: rule.id, text: rule.text, severity: rule.severity, error: '', busy: false, invalid: false, pending: null, version: 1 });
}

const editDirty = (rule) => Boolean(rule) && editor.id === rule.id && (editor.text.trim() !== rule.text || editor.severity !== rule.severity);

function holdEdit(next) {
  const rule = ruleById(editingId());
  if (!rule || !editDirty(rule) || editor.busy) return false;
  // Test rule leaves with the edit in hand, and coming back finds it again.
  if (next.view === 'simulator' && state.testDraft?.back?.sel === `edit:${rule.id}`) return false;
  editor.pending = next;
  return true;
}

const SEVERITIES = [['block', 'Block'], ['escalate', 'Escalate'], ['warn', 'Warn']];

/** Effect as a Trigger / Value: the value is what you click to change it. */
export function effectMenu(current, attr = 'data-set-severity') {
  const word = SEVERITIES.find(([value]) => value === current)?.[1] ?? current;
  return menu(SEVERITIES.map(([value, label]) => ({ label, check: value === current, attrs: `${attr}="${value}"` })), {
    label: 'Effect', align: 'left', cls: 'effect-picker',
    trigger: `<span class="effect-text --${current === 'block' ? 'block' : 'attention'}"><i class="dot"></i>${esc(word)}</span><i class="caret" aria-hidden="true">▾</i>`,
    triggerCls: 'trigger-value --effect'
  });
}

function editPage(rule) {
  if (!rule) return missingRule();
  openEditor(rule);
  const empty = !editor.text.trim();
  const dirty = editDirty(rule);
  /*
   * No Cancel, and nothing is lost by its going.
   *
   * It called `go('policy', rule.id)`. The crumb beside the title calls the
   * same thing, and both pass through `holdLeave` in the router, which is
   * `holdEdit` here, which raises "Leave without saving?" when the draft is
   * dirty. The two paths were the same path, guard included: Cancel was the
   * crumb, repeated two nodes to its right. What is left is one quiet and one
   * primary, which is the rule with no exception carved out of it.
   */
  return `<div class="sheet">
    ${pageHead({
      title: ruleName(rule),
      crumbs: [{ label: 'Rule details', go: 'policy', sel: rule.id }],
      quiet: button('Test rule', { id: 'editTest', disabled: empty || editor.busy }),
      primary: button(editor.busy ? 'Saving…' : 'Save changes', { kind: 'primary', id: 'editSave', disabled: empty || !dirty, busy: editor.busy })
    })}
    ${editor.error ? feedback({ tone: 'error', title: 'Could not save', body: `${esc(sentence(editor.error))} Your changes are kept below — the active rule keeps enforcing the previous version. Try saving again.`, icon: true }) : ''}
    <div class="facts">
      ${statusText('Active version', 'allow')}
      <span class="fact"><span class="fact-k">Applies to</span><span class="labels">${audience(rule.appliesTo)}</span></span>
      <span class="fact"><span class="fact-k">Effect</span>${effectMenu(editor.severity)}</span>
    </div>
    <hr class="hairline">
    <div class="field rule-field${editor.invalid && empty ? ' --error' : ''}">
      <label for="editText">Rule instruction</label>
      <textarea id="editText" rows="3"${editor.busy ? ' readonly' : ''}>${esc(editor.text)}</textarea>
      ${editor.invalid && empty ? '<span class="field-help" role="alert">Enter an instruction.</span>' : ''}
    </div>
    ${leaveDialogMarkup()}
  </div>`;
}

function leaveDialogMarkup() {
  if (!editor.pending) return '';
  return dialog({
    id: 'leaveEdit',
    title: 'Leave without saving?',
    body: '<p>Your edits to this rule will be lost. The active rule never changed while you were editing — nothing you tested was applied.</p>',
    actions: button('Discard changes', { kind: 'danger', id: 'discardEdit' }) + button('Keep editing', { id: 'keepEditing' }),
    close: false
  });
}

function bindEdit() {
  const rule = ruleById(editingId());
  if (!rule) return;
  const text = $('editText');
  if (text) text.oninput = () => {
    const before = [!editor.text.trim(), editDirty(rule), editor.text.trim() !== rule.text].join();
    editor.text = text.value;
    editor.version++;
    // Re-render only when what the buttons or the helper say changes, so
    // typing keeps its caret without a redraw per keystroke.
    if (before !== [!editor.text.trim(), editDirty(rule), editor.text.trim() !== rule.text].join() || editor.error) {
      editor.invalid = !editor.text.trim();
      editor.error = '';
      render();
    }
  };
  for (const item of document.querySelectorAll('[data-set-severity]')) item.onclick = () => {
    item.closest('details.menu')?.removeAttribute('open');
    if (editor.severity !== item.dataset.setSeverity) { editor.severity = item.dataset.setSeverity; editor.version++; }
    render();
  };
  $('editTest').onclick = () => {
    if (!editor.text.trim()) { editor.invalid = true; render(); return; }
    state.testDraft = {
      rule: { ...rule, text: editor.text.trim(), severity: editor.severity },
      version: editor.version,
      back: { view: 'policy', sel: `edit:${rule.id}`, label: 'Back to edit' },
      unsaved: editDirty(rule)
    };
    go('simulator', null, { draft: '1' });
  };
  $('editSave').onclick = () => void saveEdit(rule);
  const discard = $('discardEdit');
  if (discard) discard.onclick = () => {
    const next = editor.pending;
    Object.assign(editor, { id: null, pending: null, error: '' });
    go(next.view, next.sel, next.query);
  };
  const keep = $('keepEditing');
  if (keep) { keep.onclick = () => { editor.pending = null; render(); $('editText')?.focus(); }; keep.focus(); }
}

async function saveEdit(rule) {
  if (!editor.text.trim()) { editor.invalid = true; render(); return; }
  editor.busy = true; editor.error = '';
  render();
  try {
    let next = { ...rule, severity: editor.severity };
    if (editor.text.trim() !== rule.text) {
      const { ok, j } = await post('/api/policy/draft', { text: editor.text.trim(), lockTo: rule.appliesTo });
      if (!ok || j?.notARule) {
        editor.error = j?.notARule
          ? `The compiler read that as not being a rule: ${j.reason || 'there is no prohibition in it.'}`
          : j?.kind === 'compiler-setup-required' ? 'Choose what writes your rules on Models before changing an instruction.' : readable(j?.error ?? 'Warden could not reach the gateway.');
        return;
      }
      const { draftedBy, draftedRemotely, ...compiled } = j;
      next = { ...compiled, id: rule.id, appliesTo: rule.appliesTo, severity: editor.severity, ...(rule.pinned ? { pinned: rule.pinned } : {}) };
    }
    const { ok, j } = await post('/api/policy/ratify', { rule: next });
    if (!ok) { editor.error = readable(j?.error ?? 'Warden could not reach the gateway.'); return; }
    await refreshPolicy();
    Object.assign(editor, { id: null, error: '', pending: null });
    go('policy', rule.id);
    showToast('Changes saved', 'This version is now active.');
  } catch {
    editor.error = 'Warden could not reach the gateway.';
  } finally {
    editor.busy = false;
    if (editingId()) render();
  }
}

// ── the tester's identity ────────────────────────────────────────────────────

/** Roles the policy declines to govern. Read from the policy, never guessed. */
export function isExempt(role) {
  return (state.policy.exemptRoles ?? []).includes(role);
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
 * company-wide rules at all, which is the point of it. The list just never said so.
 */
export function sendAsOptions(selected = '') {
  const people = [...state.company.employees].sort(
    (a, b) => Number(isExempt(a.role)) - Number(isExempt(b.role))
  );
  return people.map((e) => `<option value="${esc(e.id)}"${e.id === selected ? ' selected' : ''}>${esc(e.name)} · ${esc(e.role)}${
    isExempt(e.role) ? ' · exempt from company-wide rules' : ''
  }</option>`).join('');
}

// ── the shell's notices ──────────────────────────────────────────────────────

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
 * furniture. It waits for the policy to have been read: before that, "nothing
 * is being stopped" would be a guess.
 */
export function firstRunBanner() {
  const read = state.loads.policy && !state.loads.policy.loading && !state.loads.policy.error;
  if (!read || onNewRule() || state.company.employees.length || state.policy.rules.length) return '';
  return feedback({
    title: 'Nothing is being stopped yet.',
    body: `Write a rule on <button type="button" class="linkish" data-go="policy" data-sel="new">Rules</button>, or put your team in on <button type="button" class="linkish" data-go="people">Team</button>.
      <div class="feedback-actions">${button('Load the sample company instead', { id: 'loadSample', compact: true })}</div>`
  });
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
  return feedback({
    tone: 'attention',
    title: 'Demo mode',
    body: `${state.canLeaveDemo
      ? '<div class="feedback-actions"><button type="button" class="btn --primary --compact" id="getModels">Download the models</button></div>'
      : 'Run <span class="mono">pnpm run setup</span>.'}`
  });
}
