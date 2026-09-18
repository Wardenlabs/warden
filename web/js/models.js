/** Models: which model does each job, the library of weights and connections, and the prompt templates. */
import { $, attr, esc, post, state } from './core.js';
import { bindCompiler, clearCompilerSecret, compilerNeedsSetup, compilerSettings } from './compiler.js';
import { refreshAdjudicator, refreshCompiler } from './data.js';
import { bindGetModels } from './engine.js';
import { modelLabel, plural } from './format.js';
import { limitValue, quotaOf, saveQuota } from './limits.js';
import { bindLibrary, library, libraryMarkup, loadLibrary } from './model-library.js';
import { bindPromptEditor, closePromptEditor, hasPromptChanges, loadPrompts, promptEditor, promptEditorMarkup, promptIsDirty, togglePromptEditor } from './prompt-editor.js';
import { render } from './render.js';
import { button, disclosureRow, feedback, pageHead, statusText, tabs } from './ui.js';
import { VIEWS } from './views.js';

/**
 * Three tabs, one view.
 *
 * `sel` names the tab and nothing else: Models has no per-item page the way
 * Team has a page per person — a model opens its editor where it is listed —
 * so an unrecognised `sel` is Active rather than a fourth thing. `state.view`
 * stays `models` across all three, which is what keeps `activePage()` in
 * model-library.js and `repaint()` in prompt-editor.js true while an
 * administrator is on any of them: a transfer keeps polling from the Prompts
 * tab and its progress is fresh on the way back.
 */
const TABS = [['', 'Active'], ['library', 'Library'], ['prompts', 'Prompts']];
const tabOf = () => (state.sel === 'library' || state.sel === 'prompts' ? state.sel : '');

let refreshing = false;
/** The rule writer's full settings, open under its block: "Use another model". */
let writerOpen = false;
/** A judge being switched to, while the gateway loads it. */
let switching = null;
let judgeNote = null;
/** Which role's ceilings are open for editing, and the draft values. */
let ceilingEdit = null;

async function refreshSelections() {
  await Promise.all([refreshCompiler(), refreshAdjudicator()]);
  if (promptEditor.catalog) await loadPrompts();
}

async function enterModels() {
  const setupLink = state.view === 'compiler' || state.query?.setup === 'compiler';
  if (setupLink) { writerOpen = true; closePromptEditor(); }
  if (refreshing) return;
  refreshing = true;
  try { await Promise.all([loadLibrary(), refreshSelections()]); }
  finally {
    refreshing = false;
    if (['models', 'compiler'].includes(state.view)) render();
  }
}

// ── the page head ────────────────────────────────────────────────────────────

function judgeState() {
  const m = state.models;
  if (!m) return { text: 'status unavailable', tone: 'attention' };
  if (state.adjudicator?.overriddenByEnv) return { text: 'set by the environment · local only', tone: 'attention' };
  if (m.mock) return { text: 'demo mode · nothing is judged', tone: 'attention' };
  if (m.runtime?.ok === false || m.state === 'failed') return { text: 'unavailable · requests are held', tone: 'block' };
  return m.state === 'ready' ? { text: 'loaded · local only', tone: 'allow' } : { text: 'loads on first request · local only', tone: 'allow' };
}

function writerState() {
  const c = state.compiler;
  if (!c) return { text: 'status unavailable', tone: 'attention' };
  if (c.configurationError) return { text: 'needs attention', tone: 'block' };
  if (compilerNeedsSetup()) return { text: 'needs setup', tone: 'attention' };
  if (c.overriddenByEnv) return { text: 'set by the environment', tone: 'attention' };
  const where = state.models?.drafting?.where;
  return { text: c.provider === 'local' ? 'drafting on this machine' : `drafting ${where ? `· ${where}` : 'through the configured compiler'}`, tone: 'allow' };
}

// ── Active: two jobs ─────────────────────────────────────────────────────────

/**
 * The value is the control. Each job shows the model doing it as a Trigger /
 * Value, with its state as coloured text beside it, and the menu that changes
 * it hangs from the value. The menu offers only what is ready to be put to work
 * — downloaded built-ins and models that passed a test for this job; anything
 * else is resolved on Library, so a switch here never lands on weights nobody
 * has checked.
 */
function inForceName(role) {
  const compiler = role === 'compiler';
  const active = compiler ? state.models?.drafting : state.models?.judging;
  const inForce = library.catalog?.inForce?.[role] ?? (compiler ? state.compiler?.inForce : state.adjudicator?.inForce) ?? active?.model;
  const basename = String(inForce ?? '').split(/[\\/]/).pop();
  // A saved built-in preference may still be downloading while custom weights
  // remain loaded. Resolve the running file before consulting role metadata.
  const custom = library.catalog?.models.find((model) => model.kind === 'local' && (basename === `${model.id}.gguf` || basename === model.filename))
    ?? library.catalog?.models.find((model) => model.activeRoles?.includes(role));
  if (compiler && state.compiler?.configurationError) return 'Compiler unavailable';
  if (custom?.name) return custom.name;
  if (compiler && state.compiler?.provider && state.compiler.provider !== 'local' && !state.compiler.overriddenByEnv) {
    const label = (state.compiler.providers ?? []).find((p) => p.id === state.compiler.provider)?.label?.replace(' on this machine', '');
    return `${label ?? state.compiler.provider}${state.compiler.provider.endsWith('-cli') ? ` · ${state.compiler.model || 'CLI default'}` : state.compiler.model ? ` · ${state.compiler.model}` : ''}`;
  }
  return modelLabel(inForce) || 'Status unavailable';
}

function judgeChoices() {
  const a = state.adjudicator;
  const customId = library.catalog?.selections?.adjudicator;
  const builtIn = (a?.choices ?? []).filter((c) => c.onDisk || (!customId && c.id === a.model))
    .map((c) => ({ label: c.label, check: !customId && c.id === a.model, attrs: `data-judge-builtin="${esc(c.id)}"`, disabled: !c.onDisk }));
  const custom = (library.catalog?.models ?? []).filter((m) => (m.testedRoles ?? []).includes('adjudicator'))
    .map((m) => ({ label: m.name, check: (m.activeRoles ?? []).includes('adjudicator'), attrs: `data-judge-custom="${attr(m.id)}"`, disabled: Boolean(library.catalog?.overrides?.adjudicator) }));
  return [...builtIn, ...custom, { label: 'Add a model…', attrs: 'data-go="models" data-sel="library"' }];
}

function writerChoices() {
  const c = state.compiler;
  const localOnDisk = state.models?.models?.some((m) => m.role === 'compiler' && m.onDisk);
  const current = c?.provider ?? 'local';
  const items = [];
  if (current !== 'local' && current !== 'catalog') items.push({ label: inForceName('compiler'), check: true, attrs: 'data-writer-keep="1"' });
  if (localOnDisk || current === 'local') items.push({ label: 'Local weights on this machine', check: current === 'local', attrs: 'data-writer-local="1"', disabled: Boolean(c?.overriddenByEnv) });
  for (const m of (library.catalog?.models ?? []).filter((x) => (x.testedRoles ?? []).includes('compiler'))) {
    items.push({ label: m.name, check: (m.activeRoles ?? []).includes('compiler'), attrs: `data-writer-custom="${attr(m.id)}"`, disabled: Boolean(library.catalog?.overrides?.compiler) });
  }
  items.push({ label: 'Another provider or endpoint…', attrs: 'data-writer-other="1"' });
  items.push({ label: 'Add a model…', attrs: 'data-go="models" data-sel="library"' });
  return items;
}

function valueMenu(role, items, label, buttonLabel = '') {
  const name = role === 'adjudicator' && switching ? switching.label : inForceName(role);
  return `<details class="menu --${buttonLabel ? 'right' : 'left'} value-menu">
    ${buttonLabel
      ? `<summary class="btn" aria-label="${esc(label)}">${esc(buttonLabel)}<b class="sr-only" data-active-model="${role}">${esc(name)}</b></summary>`
      : `<summary class="trigger-value" aria-label="${esc(label)}"><b class="trigger-name" data-active-model="${role}">${esc(name)}</b><i aria-hidden="true">▾</i></summary>`}
    <div class="menu-list" role="menu">${items.map((it) => `<button type="button" role="menuitemradio" aria-checked="${Boolean(it.check)}" class="menu-item" ${it.attrs}${it.disabled ? ' disabled' : ''}><span>${esc(it.label)}</span>${it.check ? '<b class="menu-check">✓</b>' : ''}</button>`).join('')}</div>
  </details>`;
}

function writerBlock() {
  const c = state.compiler;
  const s = writerState();
  if (compilerNeedsSetup()) {
    return `<section class="job-block" aria-labelledby="compilerTitle">
      <h2 class="section-title" id="compilerTitle">Rule writer</h2>
      <p class="job-warning">Setup required.</p>
      <div class="job-setup-host">${compilerSettings()}</div>
    </section>`;
  }
  return `<section class="job-block" aria-labelledby="compilerTitle">
    <h2 class="section-title" id="compilerTitle">Rule writer</h2>
    <div class="job-value">${valueMenu('compiler', writerChoices(), 'Change the rule writer')}${statusText(s.text, s.tone)}</div>
    ${c?.configurationError ? feedback({ tone: 'error', icon: true, title: 'Compiler configuration needs attention', body: esc(c.configurationError) }) : ''}
    ${writerOpen ? `<div class="job-editor">${compilerSettings()}</div>` : ''}
  </section>`;
}

function judgeBlock() {
  const s = judgeState();
  const a = state.adjudicator;
  const selected = a?.choices?.find((c) => c.id === a.model && !library.catalog?.selections?.adjudicator);
  const firstRun = compilerNeedsSetup();
  return `<section class="job-block" aria-labelledby="adjudicatorTitle">
    <h2 class="section-title" id="adjudicatorTitle">Request judge</h2>
    ${firstRun
      // While the rule writer is still being set up, the judge is the settled
      // half of the page: its state reads as one line and the change is a
      // button beside it, so the one open task stays the setup above.
      ? `<div class="job-task">${statusText(`${switching ? switching.label : inForceName('adjudicator')} · ${switching ? `loading… requests already being judged finish on ${switching.from}; new ones wait until it is ready` : s.text}`, switching ? 'attention' : s.tone)}${valueMenu('adjudicator', judgeChoices(), 'Change the request judge', 'Change model')}</div>`
      : `<div class="job-value">${valueMenu('adjudicator', judgeChoices(), 'Change the request judge')}${switching
          ? statusText(`Loading ${switching.label}… requests already being judged finish on ${switching.from}; new ones wait until it is ready.`, 'attention')
          : statusText(s.text, s.tone)}</div>`}
    ${!a ? feedback({ tone: 'error', icon: true, title: 'Analyzer choices could not be loaded', body: 'Refresh Models to try again.' }) : ''}
    ${a?.overriddenByEnv ? feedback({ tone: 'attention', title: 'Controlled by the environment', body: `${esc(modelLabel(a.inForce))} is in force. Saved preferences apply after the environment override is removed.` }) : ''}
    ${selected && !selected.onDisk ? `<p class="job-warning">${esc(selected.label)} is selected but not downloaded yet. ${state.canLeaveDemo ? '<button type="button" class="linkish js-get-models">Download models</button>' : 'Run the model setup on the gateway to download it.'}</p>` : ''}
    ${judgeNote ? `<p class="job-note --${judgeNote.ok ? 'allow' : 'block'}" role="${judgeNote.ok ? 'status' : 'alert'}">${esc(judgeNote.text)}</p>` : ''}
    <div><button type="button" class="linkish" data-go="engine">Runtime details</button></div>
  </section>`;
}

/**
 * Session ceilings, per role, where the notion of a token lives. A ceiling
 * escalates the request that hits it — it never blocks (src/guard/budget.ts).
 * The API keeps ceilings only on a role that has a daily limit, so a role
 * without one shows its ceilings as absent and points at where the limit is set.
 */
const CEILINGS = [['maxSessionOutputTokens', 'Output tokens'], ['maxContextTokens', 'Context tokens'], ['maxPromptChars', 'Prompt chars']];

function ceilingsBlock() {
  const roles = state.company.roles;
  const set = roles.filter((r) => CEILINGS.some(([k]) => quotaOf(r)[k])).length;
  const body = `<div class="table ceilings-table" role="table" aria-label="Session ceilings">
      <div class="thead" role="row"><span>Role</span>${CEILINGS.map(([, l]) => `<span>${l}</span>`).join('')}</div>
      ${roles.map((r) => {
        const q = quotaOf(r);
        if (ceilingEdit?.role === r) {
          return `<div class="trow --editing" role="row"><span class="cell-strong">${esc(r)}</span>${CEILINGS.map(([k, l]) => `<span><input type="text" inputmode="numeric" class="field-compact" id="ceil-${k}" aria-label="${l} for ${esc(r)}" value="${esc(ceilingEdit.values[k])}" placeholder="—"${ceilingEdit.busy ? ' readonly' : ''}></span>`).join('')}</div>
            <div class="inline-editor --ceilings">
              ${CEILINGS.some(([k]) => ceilingEdit.values[k].trim() !== String(q[k] ?? '')) ? button(ceilingEdit.busy ? 'Saving…' : 'Save ceilings', { kind: 'primary', compact: true, id: 'saveCeilings', busy: ceilingEdit.busy }) : ''}
              ${button('Cancel', { compact: true, id: 'cancelCeilings', disabled: ceilingEdit.busy })}
              ${ceilingEdit.error ? `<span class="inline-editor-error" role="alert">${esc(ceilingEdit.error)}</span>` : ''}
            </div>`;
        }
        const limited = Boolean(q.maxRequestsPerDay);
        return `<div class="trow${limited ? ' --link' : ''}" role="row"${limited ? ` tabindex="0" data-edit-ceilings="${esc(r)}" aria-label="Edit ceilings for ${esc(r)}"` : ''}>
          <span class="cell-strong">${esc(r)}${limited ? '' : '<small class="cell-note">needs a daily limit</small>'}</span>
          ${CEILINGS.map(([k]) => `<span class="${q[k] ? '' : 'cell-muted'} num">${q[k] ? Number(q[k]).toLocaleString() : '—'}</span>`).join('')}
        </div>`;
      }).join('')}
    </div>
    <p class="table-foot">Set a daily limit in <button type="button" class="linkish" data-go="people" data-sel="roles">Team → Roles</button> to enable session ceilings.</p>`;
  return disclosureRow('m:ceilings', 'Session ceilings', `${set ? `Set for ${plural(set, 'role')}` : 'None set'} · per role · escalate, never block`, body, { open: state.open.has('m:ceilings') || Boolean(ceilingEdit) });
}

function activeTab() {
  return `<div class="reading models-active">
    ${writerBlock()}
    ${judgeBlock()}
    ${compilerNeedsSetup() ? '' : `<div class="disclosures">${ceilingsBlock()}</div>`}
  </div>`;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

/**
 * A template list, and the editor behind one row.
 *
 * Editing keeps the machinery it always had — a draft per template, the
 * revision conflict, restore-default — by choosing the template through
 * `promptEditor.selected[role]`, which is the same field the editor's own
 * picker writes.
 */
function promptsTab() {
  const templates = promptEditor.catalog?.templates ?? [];
  if (promptEditor.openRole) {
    return `<div class="prompt-back">${button('← All templates', { kind: 'link', id: 'closePromptTemplate' })}</div>
      ${promptEditorMarkup(promptEditor.openRole)}`;
  }
  if (!templates.length) {
    return promptEditor.loading
      ? feedback({ title: 'Loading prompt templates…' })
      : `${feedback({ tone: 'attention', title: 'Could not load the prompt templates', body: esc(promptEditor.error || 'No prompt templates are available.') })}<div class="list-state-action">${button('Retry loading', { kind: 'primary', id: 'refreshPrompts' })}</div>`;
  }
  /*
   * The tab's own lede, out of the page header.
   *
   * Two of the three descriptions the header used to cycle through were the
   * tab's name said again — "Two jobs run Warden", "Saved weights and
   * connections" — and those are gone. This one is not: what an edit here does
   * and does not touch is a caveat about the screen's consequences, and it was
   * only ever visible while this tab was open anyway.
   */
  return `${promptEditor.error ? feedback({ tone: 'error', icon: true, title: 'Prompts could not be refreshed', body: `${esc(promptEditor.error)} Your drafts are kept.` }) : ''}
    <div class="table prompts-table" role="table" aria-label="Prompt templates">
      <div class="thead" role="row"><span>Template</span><span>Job</span><span>Status</span><span></span></div>
      ${templates.map(promptRow).join('')}
    </div>`;
}

function promptRow(item) {
  const unsaved = promptIsDirty(item.id);
  return `<div class="trow" role="row">
    <span class="mono cell-clip" title="${esc(item.name)}">${esc(item.id)}</span>
    <span>${item.role === 'compiler' ? 'Rule writer' : 'Request judge'}</span>
    <span>${unsaved ? '<span class="status-text --attention">Unsaved changes</span>' : item.custom ? '<b class="cell-strong">Customized</b>' : '<span class="cell-muted">Default</span>'}${item.active ? '' : '<span class="cell-muted"> · not in use</span>'}</span>
    <span class="row-menu">${button('Edit', { kind: 'link', compact: true, attrs: `data-prompt-template="${attr(item.id)}" data-role="${esc(item.role)}"` })}</span>
  </div>`;
}

// ── the page ─────────────────────────────────────────────────────────────────

function modelsPage() {
  const tab = tabOf();
  // One sentence per tab, and the lit tab was already saying which one you were
  // on. The strip carries the same information in the words you clicked.
  return `<div class="sheet models-page">
    ${pageHead({
      title: 'Models',
      primary: tab === 'library' ? button('Add model', { kind: 'primary', id: 'addCustomModel', disabled: !library.catalog }) : '',
      strip: tabs('models', TABS.map(([sel, label]) => [sel, label, sel === 'prompts' && hasPromptChanges()]), tab, 'Models sections')
    })}
    ${tab === 'library' ? libraryMarkup() : tab === 'prompts' ? promptsTab() : activeTab()}
  </div>`;
}

async function switchJudge(label, from, request) {
  if (switching) return;
  switching = { label, from };
  judgeNote = null;
  render();
  try {
    const result = await request();
    if (!result.ok || result.j?.ok === false) throw new Error(typeof result.j?.error === 'string' ? result.j.error : 'The judge could not be changed. The previous judge is still in force.');
    judgeNote = { ok: true, text: result.j?.needsDownload ? `${label} is selected. Download it to finish applying it; ${from} judges until then.` : `${label} is judging new requests.` };
    await Promise.all([refreshSelections(), loadLibrary()]);
  } catch (error) {
    judgeNote = { ok: false, text: error.message || 'Warden could not be reached. The previous judge is still in force.' };
  } finally {
    switching = null;
    if (['models', 'compiler'].includes(state.view)) render();
  }
}

function bindModels() {
  const tab = tabOf();
  // The list needs the catalogue the per-role editor used to fetch on opening.
  if (tab === 'prompts' && !promptEditor.catalog && !promptEditor.loading) void loadPrompts();
  for (const b of document.querySelectorAll('[data-prompt-template]')) b.onclick = () => {
    const role = b.dataset.role;
    promptEditor.selected[role] = decodeURIComponent(b.dataset.promptTemplate);
    if (promptEditor.openRole !== role) togglePromptEditor(role);
    render();
    // Without preventScroll the caret lands below the fold and takes the tabs
    // and the way back off the screen with it.
    $('promptTemplateText')?.focus({ preventScroll: true });
  };
  if ($('closePromptTemplate')) $('closePromptTemplate').onclick = () => { closePromptEditor(); render(); };

  const from = () => inForceName('adjudicator');
  for (const b of document.querySelectorAll('[data-judge-builtin]')) b.onclick = () => {
    b.closest('details.menu')?.removeAttribute('open');
    const choice = state.adjudicator?.choices?.find((c) => c.id === b.dataset.judgeBuiltin);
    if (!choice || b.getAttribute('aria-checked') === 'true') return;
    void switchJudge(choice.label, from(), () => post('/api/settings/adjudicator', { model: choice.id }));
  };
  for (const b of document.querySelectorAll('[data-judge-custom]')) b.onclick = () => {
    b.closest('details.menu')?.removeAttribute('open');
    const model = library.catalog?.models.find((m) => m.id === decodeURIComponent(b.dataset.judgeCustom));
    if (!model || b.getAttribute('aria-checked') === 'true') return;
    void switchJudge(model.name, from(), () => post(`/api/settings/models/${attr(model.id)}/activate`, { role: 'adjudicator' }));
  };

  const writerCustom = document.querySelectorAll('[data-writer-custom]');
  for (const b of writerCustom) b.onclick = async () => {
    b.closest('details.menu')?.removeAttribute('open');
    if (b.getAttribute('aria-checked') === 'true') return;
    b.disabled = true;
    const result = await post(`/api/settings/models/${b.dataset.writerCustom}/activate`, { role: 'compiler' }).catch(() => ({ ok: false, j: null }));
    if (!result.ok) { writerOpen = true; state.compilerTest = { ok: false, error: result.j?.error ?? 'The rule writer could not be changed.' }; }
    await Promise.all([refreshSelections(), loadLibrary()]);
    render();
  };
  const local = document.querySelector('[data-writer-local]');
  if (local) local.onclick = async () => {
    local.closest('details.menu')?.removeAttribute('open');
    if (local.getAttribute('aria-checked') === 'true') return;
    const result = await post('/api/settings/compiler', { provider: 'local', baseUrl: '', model: '', apiKey: '', redactNames: Boolean(state.compiler?.redactNames) }, { method: 'PUT' }).catch(() => ({ ok: false, j: null }));
    if (!result.ok) { writerOpen = true; state.compilerTest = { ok: false, error: result.j?.error ?? 'The rule writer could not be changed.' }; }
    state.compilerDraft = null;
    await Promise.all([refreshSelections(), loadLibrary()]);
    render();
  };
  const other = document.querySelector('[data-writer-other]');
  if (other) other.onclick = () => { other.closest('details.menu')?.removeAttribute('open'); clearCompilerSecret(); writerOpen = true; render(); $('cProvider')?.focus(); };
  for (const keep of document.querySelectorAll('[data-writer-keep]')) keep.onclick = () => keep.closest('details.menu')?.removeAttribute('open');

  if (writerOpen || compilerNeedsSetup()) bindCompiler(loadLibrary);

  for (const row of document.querySelectorAll('[data-edit-ceilings]')) {
    const open = () => {
      const q = quotaOf(row.dataset.editCeilings);
      ceilingEdit = { role: row.dataset.editCeilings, busy: false, error: '', values: Object.fromEntries(CEILINGS.map(([k]) => [k, String(q[k] ?? '')])) };
      state.open.add('m:ceilings');
      render();
      $('ceil-maxSessionOutputTokens')?.focus();
    };
    row.onclick = open;
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  }
  if (ceilingEdit) {
    for (const [k] of CEILINGS) {
      const field = $(`ceil-${k}`);
      if (!field) continue;
      field.oninput = () => {
        const q = quotaOf(ceilingEdit.role);
        const before = CEILINGS.some(([key]) => ceilingEdit.values[key].trim() !== String(q[key] ?? ''));
        ceilingEdit.values[k] = field.value;
        ceilingEdit.error = '';
        if (before !== CEILINGS.some(([key]) => ceilingEdit.values[key].trim() !== String(q[key] ?? ''))) render();
      };
      field.onkeydown = (e) => { if (e.key === 'Enter') $('saveCeilings')?.click(); if (e.key === 'Escape') { ceilingEdit = null; render(); } };
    }
  }
  if ($('cancelCeilings')) $('cancelCeilings').onclick = () => { ceilingEdit = null; render(); };
  if ($('saveCeilings')) $('saveCeilings').onclick = async () => {
    ceilingEdit.busy = true; render();
    const changes = Object.fromEntries(CEILINGS.map(([k]) => [k, limitValue(ceilingEdit.values[k])]));
    const result = await saveQuota(ceilingEdit.role, changes);
    if (!result.ok) { ceilingEdit.busy = false; ceilingEdit.error = result.error; render(); return; }
    ceilingEdit = null;
    render();
  };

  bindGetModels();
  bindLibrary(refreshSelections);
  bindPromptEditor();
}

VIEWS.models = { body: modelsPage, bind: bindModels, onEnter: enterModels, onLeave: () => { clearCompilerSecret(); writerOpen = false; ceilingEdit = null; } };
// The old compiler page's address still works — the composer's picker and older
// links point at it — and lands on Active with the rule writer's settings open.
VIEWS.compiler = { ...VIEWS.models, railParent: 'models' };

