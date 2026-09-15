/** The two model roles, their actual runtime selections, and your saved models. */
import { $, attr, esc, post, state } from './core.js';
import { bindCompiler, clearCompilerSecret, compilerNeedsSetup, compilerSettings } from './compiler.js';
import { refreshAdjudicator, refreshCompiler } from './data.js';
import { bindGetModels } from './engine.js';
import { modelLabel, plural } from './format.js';
import { bindLibrary, library, libraryMarkup, loadLibrary } from './model-library.js';
import { bindPromptEditor, closePromptEditor, hasPromptChanges, loadPrompts, promptEditor, promptEditorMarkup, promptIsDirty, togglePromptEditor } from './prompt-editor.js';
import { render } from './render.js';
import { go } from './router.js';
import { VIEWS } from './views.js';

let expanded = null;
let changingAnalyzer = '';
let analyzerNote = null;
let refreshing = false;

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

async function refreshSelections() {
  await Promise.all([refreshCompiler(), refreshAdjudicator()]);
  if (promptEditor.catalog) await loadPrompts();
}

async function enterModels() {
  const setupLink = state.view === 'compiler' || state.query?.setup === 'compiler';
  if (setupLink || (compilerNeedsSetup() && !promptEditor.openRole)) expanded = 'compiler';
  if (setupLink) closePromptEditor();
  if (refreshing) return;
  refreshing = true;
  try { await Promise.all([loadLibrary(), refreshSelections()]); }
  finally {
    refreshing = false;
    if (compilerNeedsSetup() && !expanded && !promptEditor.openRole) expanded = 'compiler';
    if (['models', 'compiler'].includes(state.view)) render();
  }
}

/**
 * What the runtime is doing, in the two or three words a status line has room
 * for. This is the whole of the old three-sentence runtime note: the sentences
 * that carried weight — that analysis runs here, that an unavailable analyzer
 * holds requests rather than passing them — are said by the Request judge card
 * and by the error state below, so the line itself only has to say which of
 * those is true right now.
 */
function runtimeWord() {
  const m = state.models;
  if (!m) return 'model status unavailable';
  if (m.mock) return 'demo mode';
  if (m.runtime?.ok === false || m.state === 'failed') return 'judge unavailable';
  return m.state === 'ready' ? 'judge ready' : 'judge loads on demand';
}

/** The one line under the title, per tab. Each tab answers its own question,
 *  so each says the count that belongs to it rather than a shared summary. */
function statusLine(tab) {
  const sep = '<i>·</i>';
  const runtime = runtimeWord();
  if (tab === 'library') {
    const models = library.catalog?.models ?? [];
    const active = models.filter((model) => (model.activeRoles ?? []).length).length;
    const builtIn = state.adjudicator?.choices?.length ?? 0;
    return `<span>${plural(models.length, 'model')}</span>${sep}<span class="muted">${active} active</span>${
      builtIn ? `${sep}<button type="button" class="linkbtn strong" data-go="models">${builtIn} built-in →</button>` : ''}`;
  }
  if (tab === 'prompts') {
    const templates = promptEditor.catalog?.templates ?? [];
    const customized = templates.filter((item) => item.custom).length;
    const inUse = templates.filter((item) => item.active).length;
    return `<span>${plural(templates.length, 'template')}</span>${sep}<span class="muted">${
      customized ? `${customized} customized` : 'defaults intact'}</span>${
      inUse ? `${sep}<button type="button" class="linkbtn strong" data-go="models">${inUse} in use →</button>` : ''}`;
  }
  const needsSetup = compilerNeedsSetup();
  const both = !needsSetup && !state.compiler?.configurationError;
  return `<span>2 jobs</span>${sep}<span class="muted">${both && runtime === 'judge ready' ? 'both configured' : runtime}</span>${
    needsSetup ? `${sep}<button type="button" class="linkbtn strong" data-go="models" data-q="setup=compiler">rule writer without setup →</button>` : ''
  }${sep}<button type="button" class="linkbtn" data-go="engine">Runtime details</button>`;
}

/** Title, the line, and the one control that belongs to the whole page. */
function pageHead(tab) {
  return `<header class="page-head">
    <div>
      <h1 class="page-title">Models</h1>
      <div class="page-status">${statusLine(tab)}</div>
    </div>
    <button type="button" class="btn --link" id="refreshModels"${refreshing ? ' disabled' : ''}>${refreshing ? 'Refreshing…' : 'Refresh'}</button>
  </header>`;
}

/**
 * One job, one card.
 *
 * Title, the line that says what the job is, the state it is in, and one
 * action — the editorial rule the whole page is now built on. Everything that
 * used to be a paragraph of caveats is either said by the description (which
 * is where the two sentences with security weight live: the rule writer sees
 * only the administrator's own instructions, and the judge never sends what
 * the team writes anywhere) or is small print under the model line.
 *
 * The editors open inline underneath, one at a time, exactly as before.
 */
function jobCard(role) {
  const compiler = role === 'compiler';
  const open = expanded === role;
  const setup = compiler && compilerNeedsSetup();
  return `<section class="job" aria-labelledby="${role}Title">
    <div class="job-head">
      <h2 id="${role}Title">${compiler ? 'Rule writer' : 'Request judge'}</h2>
      ${jobChip(role)}
    </div>
    <p class="job-what">${compiler
      ? 'Turns the policies you write into enforceable rules. It only ever sees your own instructions — never employee requests or documents.'
      : 'Checks every employee request and document against your rules. Always runs on this machine — what your team writes never leaves it.'}</p>
    <div class="job-body">
      ${setup ? compilerSettings() : jobMeta(role)}
    </div>
    ${open && !setup ? `<div id="${role}Editor" class="job-editor">${compiler ? compilerSettings() : analyzerSettings()}</div>` : ''}
  </section>`;
}

/** The state of the job, in the words the card has room for. */
function jobChip(role) {
  const chip = (kind, text) => `<span class="chip ${kind || 'static'}">${esc(text)}</span>`;
  if (role === 'compiler') {
    const c = state.compiler;
    if (c?.configurationError) return chip('bad', 'Needs attention');
    if (c?.overriddenByEnv) return chip('warn', 'Environment override');
    // A passed test with nothing applied is one click from done, and calling
    // that "Needs setup" next to three green ticks reads as a contradiction.
    if (compilerNeedsSetup()) return chip('warn', state.compilerTest?.ok ? 'Tested · apply to finish' : 'Needs setup');
    const label = (c?.providers ?? []).find((p) => p.id === c.provider)?.label;
    return chip('good', `${label ? label.replace(' on this machine', '') : 'Configured'} · connected`);
  }
  const m = state.models;
  if (state.adjudicator?.overriddenByEnv) return chip('warn', 'Environment override');
  if (!m) return chip('warn', 'Status unavailable');
  if (m.mock) return chip('warn', 'Demo mode · nothing is judged');
  if (m.runtime?.ok === false || m.state === 'failed') return chip('bad', 'Unavailable · requests are held');
  return m.state === 'ready' ? chip('good', 'Ready · runs locally') : chip('static', 'Loads on demand · runs locally');
}

/** Which model is doing the job, where, and the one button that changes it. */
function jobMeta(role) {
  const compiler = role === 'compiler';
  const active = compiler ? state.models?.drafting : state.models?.judging;
  const inForce = library.catalog?.inForce?.[role] ?? (compiler ? state.compiler?.inForce : state.adjudicator?.inForce) ?? active?.model;
  const basename = String(inForce ?? '').split(/[\\/]/).pop();
  // A saved built-in preference may still be downloading while custom weights
  // remain loaded. Resolve the running file before consulting role metadata.
  const custom = library.catalog?.models.find((model) => model.kind === 'local' && (basename === `${model.id}.gguf` || basename === model.filename))
    ?? library.catalog?.models.find((model) => model.activeRoles?.includes(role));
  const configurationError = compiler ? state.compiler?.configurationError : null;
  const open = expanded === role;
  return `<div class="job-meta">
      <span class="job-model"><b class="mono" data-active-model="${role}">${esc(configurationError ? 'Compiler unavailable' : custom?.name || modelLabel(inForce) || 'Status unavailable')}</b>${
        configurationError ? `<span class="note bad">${esc(configurationError)}</span>` : `<span>· ${esc(active?.where ?? 'refresh to read the current model')}</span>`}</span>
      <span class="job-act">
        <button type="button" class="linkbtn" data-prompt-role="${role}">Edit prompts${hasPromptChanges(role) ? ' •' : ''}</button>
        <button type="button" class="btn" id="edit-${role}" data-edit-role="${role}" aria-expanded="${open}" aria-controls="${role}Editor">${open ? 'Close' : 'Change model'}</button>
      </span>
    </div>
    ${compiler ? '' : '<span class="note job-note">PDFs, Word files, text, scans and images are read on this machine before the same rules are applied to them.</span>'}`;
}

function analyzerSettings() {
  const a = state.adjudicator;
  if (!a) return '<p class="note bad" role="alert">Analyzer choices could not be loaded. Refresh Models to try again.</p>';
  const custom = library.catalog?.selections?.adjudicator;
  const chosen = !custom ? a.model : null;
  const selected = a.choices.find((choice) => choice.id === chosen);
  return `<div class="model-editor analyzer-editor" aria-busy="${Boolean(changingAnalyzer)}">
    <p class="note">The analyzer always runs on this gateway.</p>
    ${a.overriddenByEnv ? `<div class="banner warn"><b>Controlled by the environment.</b> ${esc(modelLabel(a.inForce))} is in force. Saved preferences apply after the environment override is removed.</div>` : ''}
    <ul class="analyzer-options">${a.choices.map((choice) => {
      const on = choice.id === chosen;
      const current = !a.overriddenByEnv && choice.onDisk && on;
      return `<li class="analyzer-option${on ? ' chosen' : ''}"><div><div class="library-model-name"><h3>${esc(choice.label)}</h3>${on ? `<span class="model-status${current ? ' good' : ' warn'}">${current ? 'Selected' : 'Saved preference'}</span>` : ''}</div><p>${esc(choice.trade)}</p><div class="model-metadata"><span>${(choice.approxMB / 1000).toFixed(1)} GB</span><span class="${choice.onDisk ? 'good' : 'warn'}">${choice.onDisk ? 'On this gateway' : 'Not downloaded'}</span><span>${esc(choice.perDecision ?? 'Speed not measured')}</span></div></div><div class="analyzer-option-action">${on && !choice.onDisk && state.canLeaveDemo ? '<button type="button" class="btn --primary js-get-models">Download model</button>' : `<button type="button" class="btn" data-analyzer-choice="${esc(choice.id)}"${changingAnalyzer || on ? ' disabled' : ''}>${changingAnalyzer === choice.id ? 'Applying…' : current ? 'Selected' : choice.onDisk ? 'Use model' : 'Select for download'}</button>`}</div></li>`;
    }).join('')}</ul>
    ${selected && !selected.onDisk ? `<p class="note warn">${esc(selected.label)} is not downloaded yet. ${state.canLeaveDemo ? 'Download it to finish applying this selection.' : 'Run the model setup on the gateway to download it.'} The card above says which model is judging now.</p>` : ''}
    ${analyzerNote ? `<p class="note ${analyzerNote.ok ? 'good' : 'bad'}" role="${analyzerNote.ok ? 'status' : 'alert'}">${esc(analyzerNote.text)}</p>` : ''}
  </div>`;
}

function activeTab() {
  return `<div class="jobs">${jobCard('compiler')}${jobCard('adjudicator')}</div>`;
}

/**
 * Prompts: a template list, and the editor behind one row.
 *
 * The prompt editor used to open inline under whichever role you were looking
 * at on what is now Active, which put a 22-rem textarea and its variable
 * reference in the middle of the page you go to to read one status. It is the
 * thing on this screen that is touched least often, so it is a tab, and the
 * tab opens on the list rather than on a text box.
 *
 * Editing keeps the machinery it always had — a draft per template, the
 * revision conflict, restore-default — by choosing the template through
 * `promptEditor.selected[role]`, which is the same field the editor's own
 * picker writes.
 */
function promptsTab() {
  const templates = promptEditor.catalog?.templates ?? [];
  if (promptEditor.openRole) {
    return `<div class="tab-back"><button type="button" class="btn --link" id="closePromptTemplate">← All templates</button></div>
      ${promptEditorMarkup(promptEditor.openRole)}`;
  }
  if (!templates.length) {
    return promptEditor.loading
      ? '<div class="model-loading" role="status"><span class="skeleton-line"></span><span class="skeleton-line short"></span><span class="sr-only">Loading prompt templates…</span></div>'
      : `<p class="note bad tab-lede" role="alert">${esc(promptEditor.error || 'No prompt templates are available. Refresh to try again.')}</p>`;
  }
  return `<p class="note tab-lede">Full templates each job uses. Edits apply to new work only; defaults stay untouched until you change them.</p>
    ${promptEditor.error ? `<p class="note bad tab-lede" role="alert">${esc(promptEditor.error)} Your drafts are kept.</p>` : ''}
    <div class="tbl prompts">
      <div class="thead"><span>Template</span><span>Job</span><span>Status</span><span></span></div>
      ${templates.map(promptRow).join('')}
    </div>`;
}

function promptRow(item) {
  const unsaved = promptIsDirty(item.id);
  return `<div class="trow">
    <span class="c-model"><b>${esc(item.name)}</b><span class="mono">${esc(item.id)}</span></span>
    <span>${item.role === 'compiler' ? 'Rule writer' : 'Request judge'}</span>
    <span class="c-prompt-state">${unsaved ? '<span class="chip warn">Unsaved changes</span>' : item.custom ? '<span class="chip warn">Customized</span>' : '<span class="c-status">Default</span>'}${item.active ? '' : '<span class="c-status">· not in use</span>'}</span>
    <span class="c-model-act"><button type="button" class="btn" data-prompt-template="${attr(item.id)}" data-role="${esc(item.role)}">Edit</button></span>
  </div>`;
}

function modelsPage() {
  const tab = tabOf();
  return `<div class="sheet settings models-page">
    ${pageHead(tab)}
    <nav class="tabs" aria-label="Models sections">
      ${TABS.map(([sel, label]) => `<button type="button" class="tab${tab === sel ? ' --on' : ''}" data-go="models"${sel ? ` data-sel="${sel}"` : ''}>${label}${sel === 'prompts' && hasPromptChanges() ? ' •' : ''}</button>`).join('')}
    </nav>
    ${tab === 'library' ? libraryMarkup() : tab === 'prompts' ? promptsTab() : activeTab()}
  </div>`;
}

function bindModels() {
  const tab = tabOf();
  // The list needs the catalogue the per-role editor used to fetch on opening.
  if (tab === 'prompts' && !promptEditor.catalog && !promptEditor.loading) void loadPrompts();
  for (const button of document.querySelectorAll('[data-prompt-template]')) button.onclick = () => {
    const role = button.dataset.role;
    promptEditor.selected[role] = decodeURIComponent(button.dataset.promptTemplate);
    if (promptEditor.openRole !== role) togglePromptEditor(role);
    render();
    // Without preventScroll the caret lands below the fold and takes the tabs
    // and the way back off the screen with it.
    $('promptTemplateText')?.focus({ preventScroll: true });
  };
  if ($('closePromptTemplate')) $('closePromptTemplate').onclick = () => { closePromptEditor(); render(); };
  if ($('refreshModels')) $('refreshModels').onclick = () => { void enterModels(); render(); };
  for (const button of document.querySelectorAll('[data-edit-role]')) button.onclick = () => { clearCompilerSecret(); closePromptEditor(); expanded = expanded === button.dataset.editRole ? null : button.dataset.editRole; render(); $(button.id)?.focus(); };
  for (const button of document.querySelectorAll('[data-prompt-role]')) button.onclick = () => {
    const role = button.dataset.promptRole;
    clearCompilerSecret(); expanded = null;
    if (promptEditor.openRole !== role) togglePromptEditor(role);
    go('models', 'prompts');
  };
  if (expanded === 'compiler' || compilerNeedsSetup()) bindCompiler(loadLibrary);
  for (const button of document.querySelectorAll('[data-analyzer-choice]')) button.onclick = async () => {
    if (changingAnalyzer) return;
    changingAnalyzer = button.dataset.analyzerChoice; analyzerNote = null; render();
    try {
      const result = await post('/api/settings/adjudicator', { model: changingAnalyzer });
      if (!result.ok) throw new Error(typeof result.j?.error === 'string' ? result.j.error : 'The analyzer could not be changed. Try again.');
      analyzerNote = { ok: true, text: result.j.needsDownload ? 'Preference saved. Download this model to finish applying it.' : 'Analyzer applied. New requests use this selection.' };
      await Promise.all([refreshSelections(), loadLibrary()]);
    } catch (error) { analyzerNote = { ok: false, text: error.message || 'Warden could not be reached. Try again.' }; }
    finally { changingAnalyzer = ''; if (['models', 'compiler'].includes(state.view)) { render(); $('edit-adjudicator')?.focus(); } }
  };
  bindGetModels();
  bindLibrary(refreshSelections);
  bindPromptEditor();
}

VIEWS.models = { body: modelsPage, bind: bindModels, onEnter: enterModels, onLeave: clearCompilerSecret };
// Existing links from the rule composer keep working, while both roles and
// custom models remain visible from the same top-level administration page.
VIEWS.compiler = { ...VIEWS.models, railParent: 'models' };
