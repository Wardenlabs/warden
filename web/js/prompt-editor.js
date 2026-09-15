/** Full prompt templates, with per-template drafts and optimistic writes. */
import { $, api, esc, post, state } from './core.js';
import { render } from './render.js';

export const promptEditor = { catalog: null, drafts: Object.create(null), openRole: null, selected: {}, loading: false, error: '', busy: '', confirmReset: null };
let loadingRequest = null;
let unloadBound = false;
let catalogGeneration = 0;
const tokenText = (name) => `{{${name}}}`;
const currentTemplate = () => promptEditor.catalog?.templates.find((item) => item.id === promptEditor.selected[promptEditor.openRole]);
const dirty = (draft) => Boolean(draft && draft.text !== draft.base);
const repaint = () => { if (['models', 'compiler'].includes(state.view)) render(); };

function preferredTemplate(choices) {
  const active = choices.filter((item) => item.active);
  // DynaGuard's system slot can contain only a thinking marker. Its ordinary
  // message template is the useful starting point for inspecting instructions.
  return active.find((item) => item.role === 'adjudicator' && item.id.endsWith('.user') && !item.id.includes('.screen.') && !item.id.startsWith('analyzer.rewrite.')) ?? active[0] ?? choices[0];
}

function draftFor(template) {
  return promptEditor.drafts[template.id] ??= { text: template.template, base: template.template, revision: promptEditor.catalog.revision, errors: [], note: null, conflict: false, start: 0, end: 0 };
}

/** Whether one template has an edit that has not been saved. */
export function promptIsDirty(id) {
  return dirty(promptEditor.drafts[id]);
}

export function hasPromptChanges(role) {
  return (promptEditor.catalog?.templates ?? []).some((item) => (!role || item.role === role) && dirty(promptEditor.drafts[item.id]));
}

/** Refresh saved metadata without replacing text an administrator is editing. */
export function acceptPromptCatalog(catalog) {
  for (const item of catalog.templates) {
    const draft = promptEditor.drafts[item.id];
    if (!draft) continue;
    if (dirty(draft) && item.template !== draft.base) draft.conflict = true;
    else {
      if (!dirty(draft)) { draft.text = item.template; draft.base = item.template; }
      draft.revision = catalog.revision;
      draft.conflict = false;
    }
  }
  promptEditor.catalog = catalog;
  for (const role of ['compiler', 'adjudicator']) {
    const choices = catalog.templates.filter((item) => item.role === role);
    if (!choices.some((item) => item.id === promptEditor.selected[role])) promptEditor.selected[role] = preferredTemplate(choices)?.id;
  }
  catalogGeneration++;
}

export async function loadPrompts() {
  if (loadingRequest) return loadingRequest;
  if (promptEditor.busy) return;
  promptEditor.loading = true;
  promptEditor.error = '';
  const generation = catalogGeneration;
  const obsolete = () => generation !== catalogGeneration || Boolean(promptEditor.busy);
  loadingRequest = (async () => {
    try {
      const result = await api('/api/prompts');
      // A refresh may have captured its snapshot before a concurrent save.
      // Neither that snapshot nor its error may replace the newer result.
      if (obsolete()) return;
      if (!result.ok || !Array.isArray(result.j?.templates)) throw new Error(result.j?.error || 'Prompts could not be loaded.');
      acceptPromptCatalog(result.j);
    } catch (error) { if (!obsolete()) promptEditor.error = error.message || 'Warden could not be reached. Try again.'; }
    finally { promptEditor.loading = false; loadingRequest = null; repaint(); }
  })();
  return loadingRequest;
}

export function closePromptEditor() { promptEditor.openRole = null; promptEditor.confirmReset = null; }

export function togglePromptEditor(role) {
  promptEditor.openRole = promptEditor.openRole === role ? null : role;
  promptEditor.confirmReset = null;
  if (promptEditor.openRole && !promptEditor.catalog) void loadPrompts();
}

export function validatePromptTemplate(template, text) {
  const errors = [];
  if (!text.trim()) errors.push('Enter a prompt template.');
  if (text.length > 32768) errors.push('Keep the template within 32,768 characters.');
  if (text.includes('\0')) errors.push('Remove the null character from the template.');
  const required = template.requiredTokens ?? template.tokens.filter((token) => token.required).map((token) => token.name);
  const missing = required.filter((name) => !text.includes(tokenText(name)));
  if (missing.length) errors.push(`Keep the required variables: ${missing.map(tokenText).join(', ')}.`);
  const known = new Set(template.tokens.map((token) => token.name));
  const unknown = [...new Set([...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]).filter((name) => !known.has(name)))];
  if (unknown.length) errors.push(`Unknown variables: ${unknown.map(tokenText).join(', ')}. Use the variables listed below.`);
  if (/\{\{|\}\}/.test(text.replace(/\{\{[^{}]*\}\}/g, '')) || text.includes('{{}}')) errors.push('Write variables exactly as {{name}}, with matching braces and no spaces or expressions.');
  return errors;
}

function draftStatus(draft) {
  if (draft.conflict) return 'A newer version was saved. Review it before saving your draft.';
  if (dirty(draft)) return 'Unsaved changes';
  return 'No unsaved changes';
}

function errorMarkup(errors) {
  return errors.length ? `<ul class="prompt-errors">${errors.map((error) => `<li>${esc(error)}</li>`).join('')}</ul>` : '';
}

function noteMarkup(note) {
  return note ? `<p class="form-note --${note.ok ? 'allow' : 'block'}" role="${note.ok ? 'status' : 'alert'}">${esc(note.text)}</p>` : '';
}

function templateOption(item) {
  return `${item.name}${item.active ? ' · In use' : ''}${item.custom ? ' · Custom' : ''}${dirty(promptEditor.drafts[item.id]) ? ' · Unsaved' : ''}`;
}

export function promptEditorMarkup(role) {
  if (promptEditor.openRole !== role) return '';
  const name = role === 'compiler' ? 'Compiler' : 'Analyzer';
  const choices = promptEditor.catalog?.templates.filter((item) => item.role === role) ?? [];
  const template = choices.find((item) => item.id === promptEditor.selected[role]) ?? preferredTemplate(choices);
  if (template) promptEditor.selected[role] = template.id;
  const shell = `<section class="prompt-editor" id="${role}Prompts" aria-labelledby="${role}PromptsTitle" aria-busy="${promptEditor.loading || Boolean(promptEditor.busy)}"><div class="prompt-editor-heading"><div><h3 id="${role}PromptsTitle">${name} prompts</h3><p class="field-help">Edit the actual templates used by this installation. Saved changes apply to new requests.</p></div><button type="button" class="btn --link" id="refreshPrompts"${promptEditor.loading || promptEditor.busy ? ' disabled' : ''}>Refresh prompts</button></div>`;
  if (!template) return `${shell}${promptEditor.loading ? '<div class="model-loading" role="status"><span class="sr-only">Loading prompt templates</span><i class="skeleton-line"></i><i class="skeleton-line short"></i></div>' : `<p class="form-note --block" role="alert">${esc(promptEditor.error || 'No prompt templates are available. Refresh to try again.')}</p>`}</section>`;
  const draft = draftFor(template);
  const busy = Boolean(promptEditor.busy);
  return `${shell}
    ${promptEditor.error ? `<p class="form-note --block" role="alert">${esc(promptEditor.error)} Your drafts are kept.</p>` : ''}
    <form id="promptEditorForm" novalidate>
      <div class="prompt-template-picker field"><label for="promptTemplate">Prompt template</label><select id="promptTemplate" data-no-restore${busy ? ' disabled' : ''}>${choices.map((item) => `<option value="${esc(item.id)}"${item.id === template.id ? ' selected' : ''}>${esc(templateOption(item))}</option>`).join('')}</select></div>
      <div class="prompt-template-heading"><h3>${esc(template.name)}</h3><span class="model-status${template.custom ? ' warn' : ''}">${template.custom ? 'Custom prompt saved' : 'Default prompt'}</span><span class="model-status${template.active ? ' good' : ''}">${template.active ? 'In use' : 'Available for another configuration'}</span></div>
      <p class="field-help prompt-description">${esc(template.description)}</p>
      <div class="field prompt-text-field"><label for="promptTemplateText">Template text</label><textarea id="promptTemplateText" data-no-restore spellcheck="false" autocapitalize="off" autocomplete="off" maxlength="32768" aria-describedby="promptTextHelp promptValidation" aria-invalid="${draft.errors.length > 0}"${busy ? ' readonly' : ''}>${esc(draft.text)}</textarea><p class="field-help" id="promptTextHelp">${template.tokens.length ? 'Warden fills the variables below with request data. Keep required variables exactly as written.' : 'This template is used as written; it has no replaceable variables.'} Up to 32,768 characters. Ctrl+Enter or ⌘+Enter saves.</p><div id="promptValidation" role="alert">${errorMarkup(draft.errors)}</div></div>
      <div class="prompt-variables"><h4>Variables</h4><p class="field-help">Select a variable to insert it at the text cursor.</p>${template.tokens.length ? `<ul>${template.tokens.map((token) => `<li><button type="button" class="btn --link prompt-token" data-prompt-token="${esc(token.name)}"${busy ? ' disabled' : ''}><code>${esc(tokenText(token.name))}</code><span class="sr-only">Insert variable</span></button><div><span class="prompt-variable-kind">${token.required || template.requiredTokens?.includes(token.name) ? 'Required' : 'Optional'}</span><p>${esc(token.description)}</p></div></li>`).join('')}</ul>` : '<p class="field-help">This template has no variables.</p>'}</div>
      <details class="prompt-reference"><summary>Required response format · read only</summary><pre>${esc(template.outputContract)}</pre><p class="field-help">Saving a prompt does not change this response contract or certify its policy accuracy.</p></details>
      <details class="prompt-reference"><summary>View the default template</summary><pre>${esc(template.defaultTemplate)}</pre></details>
      ${draft.conflict ? `<div class="prompt-conflict" role="alert"><h4>A newer prompt is saved</h4><p>Your draft is preserved. Compare it with the saved version before choosing which to keep.</p><details class="prompt-reference"><summary>View the latest saved template</summary><pre>${esc(template.template)}</pre></details><div class="actions"><button type="button" class="btn" id="useSavedPrompt"${busy ? ' disabled' : ''}>Discard draft and use saved prompt</button><button type="button" class="btn" id="keepPromptDraft"${busy ? ' disabled' : ''}>Keep my draft</button></div></div>` : ''}
      <div class="prompt-save-row"><div class="actions"><button type="submit" class="btn --primary" id="savePrompt"${busy || !dirty(draft) || draft.conflict ? ' disabled' : ''}>${promptEditor.busy === 'save' ? 'Saving…' : 'Save prompt'}</button><button type="button" class="btn" id="discardPromptDraft"${busy || !dirty(draft) ? ' disabled' : ''}>Discard changes</button><button type="button" class="btn --link" id="restorePromptDefault"${busy || draft.conflict || (!template.custom && draft.text === template.defaultTemplate) ? ' disabled' : ''}>Restore default</button></div><span id="promptDraftStatus" class="field-help${dirty(draft) ? ' --attention' : ''}" role="status">${esc(draftStatus(draft))}</span></div>
      ${promptEditor.confirmReset === template.id ? `<div class="prompt-reset-confirm" role="group" aria-label="Restore default prompt"><p>Restore the default ${esc(template.name.toLowerCase())} for new requests? This also discards this template’s unsaved changes.</p><div class="actions"><button type="button" class="btn" id="confirmPromptReset"${busy ? ' disabled' : ''}>${promptEditor.busy === 'reset' ? 'Restoring…' : 'Restore default prompt'}</button><button type="button" class="btn --link" id="cancelPromptReset"${busy ? ' disabled' : ''}>Keep current prompt</button></div></div>` : ''}
      <div id="promptFeedback" class="prompt-feedback">${noteMarkup(draft.note)}</div>
      <p class="field-help prompt-draft-help">Unsaved drafts stay in this browser tab while you switch templates or leave Models. Save before closing or reloading the tab.</p>
    </form>
  </section>`;
}

function updateDraftControls(template, draft) {
  if ($('savePrompt')) $('savePrompt').disabled = Boolean(promptEditor.busy) || !dirty(draft) || draft.conflict;
  if ($('discardPromptDraft')) $('discardPromptDraft').disabled = Boolean(promptEditor.busy) || !dirty(draft);
  if ($('restorePromptDefault')) $('restorePromptDefault').disabled = Boolean(promptEditor.busy) || draft.conflict || (!template.custom && draft.text === template.defaultTemplate);
  if ($('promptDraftStatus')) { $('promptDraftStatus').textContent = draftStatus(draft); $('promptDraftStatus').className = `field-help${dirty(draft) ? ' --attention' : ''}`; }
  const option = [...($('promptTemplate')?.options ?? [])].find((item) => item.value === template.id);
  if (option) option.textContent = templateOption(template);
  if ($('promptValidation')) $('promptValidation').innerHTML = errorMarkup(draft.errors);
  if ($('promptFeedback')) $('promptFeedback').innerHTML = noteMarkup(draft.note);
  $('promptTemplateText')?.setAttribute('aria-invalid', String(draft.errors.length > 0));
}

async function writePrompt(action) {
  const template = currentTemplate();
  if (!template || promptEditor.busy) return;
  const draft = draftFor(template);
  if (draft.conflict) return;
  if (action === 'save') {
    draft.errors = validatePromptTemplate(template, draft.text);
    if (draft.errors.length) { updateDraftControls(template, draft); $('promptTemplateText')?.focus(); return; }
  }
  catalogGeneration++;
  promptEditor.busy = action;
  draft.note = null;
  repaint();
  try {
    const endpoint = `/api/prompts/${encodeURIComponent(template.id)}${action === 'reset' ? '/reset' : ''}`;
    const result = await post(endpoint, { revision: draft.revision, ...(action === 'save' ? { template: draft.text } : {}) }, { method: action === 'reset' ? 'POST' : 'PUT' });
    if (result.status === 409) {
      // Read the new global revision, preserving every independent draft.
      const latest = await api('/api/prompts');
      if (latest.ok && Array.isArray(latest.j?.templates)) acceptPromptCatalog(latest.j);
      draft.note = { ok: false, text: draft.conflict ? 'Your draft was not saved. Review the newer version above.' : 'Another prompt changed. Your draft is kept. Refresh if needed, then review and save again.' };
      return;
    }
    if (!result.ok || !Array.isArray(result.j?.templates)) {
      draft.errors = result.j?.field === 'template' ? [result.j.error || 'This template is not valid. Check its variables.'] : [];
      throw new Error(result.j?.error || 'The prompt could not be saved. Your draft is kept.');
    }
    const saved = result.j.templates.find((item) => item.id === template.id);
    if (!saved) throw new Error('The saved template was not returned. Refresh to check its status; your draft is kept.');
    Object.assign(draft, { text: saved.template, base: saved.template, revision: result.j.revision, errors: [], conflict: false });
    acceptPromptCatalog(result.j);
    draft.note = { ok: true, text: action === 'reset' ? 'Default restored. New requests use this template.' : 'Prompt saved. New requests use this template.' };
    promptEditor.confirmReset = null;
  } catch (error) { draft.note = { ok: false, text: error.message || 'Warden could not be reached. Your draft is kept.' }; }
  finally { promptEditor.busy = ''; repaint(); $('savePrompt')?.focus(); }
}

export function bindPromptEditor() {
  if (!unloadBound && window.addEventListener) {
    window.addEventListener('beforeunload', (event) => { if (hasPromptChanges()) { event.preventDefault(); event.returnValue = ''; } });
    unloadBound = true;
  }
  if ($('refreshPrompts')) $('refreshPrompts').onclick = () => { void loadPrompts(); repaint(); };
  const template = currentTemplate();
  const textarea = $('promptTemplateText');
  if (!template || !textarea) return;
  const draft = draftFor(template);
  textarea.setSelectionRange(draft.start, draft.end);
  const rememberCursor = () => { draft.start = textarea.selectionStart; draft.end = textarea.selectionEnd; };
  rememberCursor();
  textarea.onselect = rememberCursor;
  textarea.onclick = rememberCursor;
  textarea.onkeyup = rememberCursor;
  textarea.oninput = () => { draft.text = textarea.value; draft.note = null; if (draft.errors.length) draft.errors = validatePromptTemplate(template, draft.text); rememberCursor(); updateDraftControls(template, draft); };
  textarea.onkeydown = (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (dirty(draft)) void writePrompt('save'); } };
  $('promptTemplate').onchange = (event) => { promptEditor.selected[promptEditor.openRole] = event.target.value; promptEditor.confirmReset = null; repaint(); $('promptTemplate')?.focus(); };
  $('promptEditorForm').onsubmit = (event) => { event.preventDefault(); void writePrompt('save'); };
  for (const button of document.querySelectorAll('[data-prompt-token]')) button.onclick = () => {
    const token = tokenText(button.dataset.promptToken);
    textarea.setRangeText(token, draft.start, draft.end, 'end');
    textarea.oninput(); textarea.focus();
  };
  const useSaved = () => { Object.assign(draft, { text: template.template, base: template.template, revision: promptEditor.catalog.revision, errors: [], note: null, conflict: false, start: 0, end: 0 }); promptEditor.confirmReset = null; repaint(); $('promptTemplateText')?.focus(); };
  $('discardPromptDraft').onclick = useSaved;
  if ($('useSavedPrompt')) $('useSavedPrompt').onclick = useSaved;
  if ($('keepPromptDraft')) $('keepPromptDraft').onclick = () => { draft.base = template.template; draft.revision = promptEditor.catalog.revision; draft.conflict = false; draft.note = { ok: true, text: 'Your draft is kept. Save to replace the latest saved prompt.' }; repaint(); $('promptTemplateText')?.focus(); };
  $('restorePromptDefault').onclick = () => { promptEditor.confirmReset = template.id; repaint(); $('confirmPromptReset')?.focus(); };
  if ($('cancelPromptReset')) $('cancelPromptReset').onclick = () => { promptEditor.confirmReset = null; repaint(); $('restorePromptDefault')?.focus(); };
  if ($('confirmPromptReset')) $('confirmPromptReset').onclick = () => { void writePrompt('reset'); };
}
