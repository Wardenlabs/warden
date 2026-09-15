/** Named model connections and imports. Credentials exist only in requests. */
import { $, api, attr, del, esc, post, state } from './core.js';
import { fileSize, modelLabel } from './format.js';
import { render } from './render.js';
import { button, feedback, menuItem } from './ui.js';

export const library = { catalog: null, error: '', loading: false };
const editor = { draft: null, busy: '', note: null, pendingFile: null, controller: null, confirmDelete: null };
let jobs = [];
let timer;
let generation = 0;
const roleLabel = (role) => role === 'adjudicator' ? 'analyzer' : 'compiler';
const jobLabel = (role) => role === 'adjudicator' ? 'Analysis' : 'Compilation';
const activePage = () => ['models', 'compiler'].includes(state.view);
const safeError = (j, fallback) => typeof j?.error === 'string' ? j.error : fallback;

/** A stale navigation must not overwrite a newer list or leave a poll alive. */
export async function loadLibrary() {
  const own = ++generation;
  library.loading = true;
  try {
    const [catalog, transfers] = await Promise.all([
      api('/api/settings/models'), api('/api/settings/models/downloads')
    ]);
    if (own !== generation) return;
    library.catalog = catalog.ok ? catalog.j : null;
    library.error = catalog.ok ? '' : safeError(catalog.j, 'Your models could not be loaded. Refresh to try again.');
    jobs = transfers.ok ? transfers.j?.jobs ?? [] : [];
  } catch {
    if (own === generation) library.error = 'Warden could not be reached. Check the gateway connection and refresh.';
  } finally {
    if (own === generation) library.loading = false;
  }
  scheduleTransfers();
}

function scheduleTransfers() {
  clearTimeout(timer);
  if (!activePage() || !jobs.some((job) => ['queued', 'downloading'].includes(job.state))) return;
  timer = setTimeout(async () => {
    if (!activePage()) return;
    await loadLibrary();
    if (activePage()) render();
  }, 2000);
}

function field(id, label, value, placeholder, options = '') {
  return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" ${options} data-no-restore></div>`;
}

function editorMarkup() {
  const d = editor.draft;
  if (!d) return '';
  const local = d.kind === 'local';
  const editing = Boolean(d.id);
  const endpoint = !local;
  return `<form id="customModelForm" class="model-editor library-editor" aria-labelledby="modelEditorTitle" aria-busy="${Boolean(editor.busy)}">
    <div class="model-section-head"><h2 class="section-title" id="modelEditorTitle">${editing ? 'Edit model' : 'Add your model'}</h2><button type="button" class="btn --compact" id="closeModelEditor"${editor.busy ? ' disabled' : ''}>Cancel</button></div>
    <fieldset class="model-fields"${editor.busy ? ' disabled' : ''}>
      ${editing ? '' : `<div class="field"><label for="customModelKind">Connection</label><select id="customModelKind" data-no-restore><option value="endpoint"${endpoint ? ' selected' : ''}>API endpoint · compiler</option><option value="local"${local ? ' selected' : ''}>Local GGUF · compiler or analyzer</option></select></div>`}
      ${field('customModelName', 'Name', d.name, 'e.g. My local compiler', 'required maxlength="100" autocomplete="off"')}
      ${endpoint ? `<div class="model-form-grid">${field('customModelUrl', 'API endpoint', d.baseUrl, 'https://api.example.com/v1', 'required maxlength="400" spellcheck="false" autocomplete="url"')}${field('customModelIdentifier', 'Model ID', d.model, 'Provider model name', 'required maxlength="120" spellcheck="false" autocomplete="off"')}</div>
        <div class="field"><label for="customModelKey">API key <span class="optional">(if required)</span></label><input id="customModelKey" type="password" autocomplete="off" spellcheck="false" maxlength="400" placeholder="${d.hasKey ? 'A key is saved. Leave blank to keep it.' : 'Enter a provider key'}" value=""><span class="field-help">${d.hasKey ? 'A key is saved on the gateway. ' : ''}Keys are never returned to this page. This endpoint is used only to compile administrator instructions.</span>${d.hasKey ? `<label class="check"><input id="customModelClearKey" type="checkbox"${d.clearKey ? ' checked' : ''} data-no-restore><span>Remove the saved key</span></label>` : ''}</div>`
      : editing ? `<p class="field-help">${esc(d.filename ?? 'Imported GGUF')} · ${fileSize(d.bytes ?? 0)}. To replace weights or compatibility settings, add a new model and test it first.</p>` : `
        <div class="field"><label for="customModelSource">Get the file from</label><select id="customModelSource" data-no-restore>
          <option value="upload"${d.source === 'upload' ? ' selected' : ''}>Upload from this device</option>
          ${library.catalog?.importAvailable ? `<option value="path"${d.source === 'path' ? ' selected' : ''}>File already on the gateway</option>` : ''}
          <option value="url"${d.source === 'url' ? ' selected' : ''}>Download from a URL</option>
        </select></div>
        ${d.source === 'upload' ? `<div class="field"><label for="customModelFile">GGUF file</label><input id="customModelFile" class="model-file-input" type="file" accept=".gguf" aria-describedby="modelFileHelp"><span id="modelFileHelp" class="field-help">${editor.pendingFile ? `${esc(editor.pendingFile.name)} · ${fileSize(editor.pendingFile.size)} selected` : 'Choose a .gguf model. Large files may take several minutes to upload.'}</span></div>` : d.source === 'path' ? field('customModelPath', 'Absolute file path on the gateway', d.path, '/path/to/model.gguf', 'required spellcheck="false" autocomplete="off"') : field('customModelDownload', 'Direct download URL', d.url, 'https://example.com/model.gguf', 'required spellcheck="false" autocomplete="off"')}
        <fieldset class="model-role-fields"><legend>Use it for</legend><label class="check"><input id="customModelCompiler" type="checkbox"${d.roles.includes('compiler') ? ' checked' : ''} data-no-restore><span>Compiler — writes rules</span></label><label class="check"><input id="customModelAnalyzer" type="checkbox"${d.roles.includes('adjudicator') ? ' checked' : ''} data-no-restore><span>Analyzer — checks requests locally</span></label></fieldset>
        <div class="field"><label for="customModelFormat">Response format</label><select id="customModelFormat" data-no-restore><option value="compliance"${d.format === 'compliance' ? ' selected' : ''}>General instruction model · JSON compliance</option><option value="dynaguard"${d.format === 'dynaguard' ? ' selected' : ''}>DynaGuard · PASS / FAIL</option></select><span class="field-help">DynaGuard is analyzer-only. Successful compatibility tests are required before an imported model can be used.</span></div>`}
      <div class="btn-row"><button type="submit" class="btn --primary" id="saveCustomModel">${editor.busy === 'save' ? local ? 'Importing…' : 'Saving…' : editing ? 'Save changes' : local ? d.source === 'url' ? 'Start download' : 'Import model' : 'Save connection'}</button></div>
    </fieldset>
    ${editor.busy === 'save' && local && !editing ? `<div class="transfer-status" role="status"><progress aria-label="Importing model"></progress><span>Importing the model. Keep this page open until it finishes.</span>${editor.controller ? '<button type="button" class="btn --compact" id="cancelModelUpload">Cancel upload</button>' : ''}</div>` : ''}
    ${editor.note?.scope === 'form' ? note(editor.note) : ''}
  </form>`;
}

function note(n) {
  return `<p class="form-note --${n.ok ? 'allow' : 'block'}" role="${n.ok ? 'status' : 'alert'}">${esc(n.text)}</p>`;
}

/**
 * One saved model, one row.
 *
 * The row says what an administrator sweeps a library for — what it is, which
 * job it may do, what shape its answers are, and whether it is usable — and
 * every action is in the row's ···: test for a job, use for a job, edit,
 * remove. Remove is last and cannot be pressed while the model is assigned.
 */
function modelRow(model) {
  const id = attr(model.id);
  const active = model.activeRoles ?? [];
  const assigned = active.length > 0 || Object.values(library.catalog?.selections ?? {}).includes(model.id);
  const tested = model.testedRoles ?? [];
  const roles = model.roles ?? [];
  const pending = editor.busy.startsWith(`${model.id}:`);
  const overrides = library.catalog?.overrides ?? {};
  const items = [
    ...roles.map((role) => ({ label: editor.busy === `${model.id}:test:${role}` ? 'Testing…' : `Test for ${jobLabel(role).toLowerCase()}`, id: `test-${id}-${role}`, attrs: `data-model-test="${id}" data-role="${role}"`, disabled: Boolean(editor.busy) })),
    ...roles.filter((role) => !active.includes(role)).map((role) => ({ label: editor.busy === `${model.id}:use:${role}` ? 'Applying…' : `Use for ${jobLabel(role).toLowerCase()}`, id: `activate-${id}-${role}`, attrs: `data-model-use="${id}" data-role="${role}" title="${overrides[role] ? 'The environment controls this role. Remove its override to apply a saved model.' : tested.includes(role) ? `Use this model as the ${roleLabel(role)}` : `Test this model as the ${roleLabel(role)} first`}"`, disabled: Boolean(editor.busy || !tested.includes(role) || overrides[role]) })),
    { label: 'Edit', attrs: `data-model-edit="${id}" title="${assigned ? 'Choose another model before editing this selection.' : 'Edit this saved model'}"`, disabled: Boolean(editor.busy || assigned) },
    { label: 'Remove', destructive: true, attrs: `data-model-remove="${id}" title="${assigned ? 'Choose another model for each assigned role before removing this one.' : 'Remove this saved model'}"`, disabled: Boolean(editor.busy || assigned) }
  ];
  return `<div class="trow" role="row" data-model-id="${esc(model.id)}">
    <span class="cell-stack"><span class="mono cell-strong">${esc(model.kind === 'endpoint' ? model.model : model.filename ?? model.name)}</span><small>${esc(model.name)}${model.kind === 'endpoint' ? ` · ${esc(model.baseUrl)}` : ` · ${fileSize(model.bytes ?? 0)}`}</small></span>
    <span>${roles.map(jobName).join(', ') || '—'}</span>
    <span class="mono cell-muted">${model.kind === 'endpoint' ? 'endpoint' : esc(model.format ?? 'compliance')}</span>
    <span>${statusCell(model, active, tested, roles)}</span>
    <span class="row-menu"><details class="menu --right"><summary class="menu-trigger --dots" aria-label="More actions for ${esc(model.name)}">···</summary><div class="menu-list" role="menu">${items.map(menuItem).join('')}</div></details></span>
  </div>
  ${assigned ? '<p class="trow-note">To edit or remove this model, choose another model for each assigned role first.</p>' : ''}
  ${pending ? '<p class="trow-note" role="status">Checking compatibility may take a minute while the model loads.</p>' : ''}
  ${editor.note?.scope === model.id ? `<div class="trow-note">${note(editor.note)}</div>` : ''}
  ${editor.confirmDelete === model.id ? `<div class="trow-note model-delete-confirm" role="group" aria-label="Confirm model removal"><p>Remove <b>${esc(model.name)}</b> from this installation? Imported weights will be deleted.</p><div class="btn-row"><button type="button" class="btn --danger --compact" data-model-delete="${id}">Remove model</button><button type="button" class="btn --compact" id="cancelModelDelete">Keep model</button></div></div>` : ''}`;
}

const jobName = (role) => (role === 'adjudicator' ? 'Request judge' : 'Rule writer');

/** What the row says about whether this model can be put to work. */
function statusCell(model, active, tested, roles) {
  if (active.length) return `<span class="status-text --allow">Active · ${esc(active.map((r) => (r === 'adjudicator' ? 'judging' : 'drafting')).join(', '))}</span>`;
  if (roles.some((role) => !tested.includes(role))) return '<span class="status-text --attention">Needs test</span>';
  return `<span>${model.kind === 'endpoint' ? 'Connection saved · tested' : 'Downloaded · tested'}</span>`;
}

/**
 * The built-in weights, in the same table as your own. The judge's built-in
 * choices come from the adjudicator settings, the local rule writer from the
 * model inventory; built-ins are shipped and chosen, not tested per role, and
 * one that is not on disk says so and offers the download.
 */
function builtInRows() {
  const a = state.adjudicator;
  const customJudge = library.catalog?.selections?.adjudicator;
  const judges = (a?.choices ?? []).map((c) => {
    const selected = !customJudge && c.id === a.model;
    const status = selected && c.onDisk ? '<span class="status-text --allow">Active · judging</span>'
      : selected ? '<span class="status-text --attention">Selected · not downloaded</span>'
        : c.onDisk ? '<span>Downloaded · built-in</span>' : '<span class="cell-muted">Not downloaded</span>';
    const items = [
      ...(c.onDisk && !selected ? [{ label: 'Use for analysis', attrs: `data-judge-builtin="${esc(c.id)}"` }] : []),
      ...(!c.onDisk && !selected ? [{ label: 'Select for download', attrs: `data-judge-builtin="${esc(c.id)}"` }] : []),
      ...(!c.onDisk && state.canLeaveDemo ? [{ label: 'Download models', cls: 'js-get-models' }] : [])
    ];
    return `<div class="trow" role="row">
      <span class="cell-stack"><span class="mono cell-strong">${esc(c.filename ?? c.label)}</span><small>${esc(c.label)} · ${(c.approxMB / 1000).toFixed(1)} GB · ${esc(c.perDecision ?? 'Speed not measured')}</small></span>
      <span>Request judge</span>
      <span class="mono cell-muted">${/dynaguard/i.test(c.filename ?? c.id) ? 'dynaguard' : 'compliance'}</span>
      <span>${status}</span>
      <span class="row-menu">${items.length ? `<details class="menu --right"><summary class="menu-trigger --dots" aria-label="More actions for ${esc(c.label)}">···</summary><div class="menu-list" role="menu">${items.map(menuItem).join('')}</div></details>` : ''}</span>
    </div>`;
  });
  const localWriter = state.models?.models?.find((m) => m.role === 'compiler');
  const writerActive = state.compiler?.provider === 'local' && !library.catalog?.selections?.compiler;
  const writer = localWriter ? `<div class="trow" role="row">
      <span class="cell-stack"><span class="mono cell-strong">${esc(localWriter.name)}</span><small>${esc(modelLabel(localWriter.name))} · local rule writer</small></span>
      <span>Rule writer</span>
      <span class="mono cell-muted">compliance</span>
      <span>${writerActive && localWriter.onDisk ? '<span class="status-text --allow">Active · drafting</span>' : writerActive ? '<span class="status-text --attention">Selected · not downloaded</span>' : localWriter.onDisk ? '<span>Downloaded · built-in</span>' : '<span class="cell-muted">Not downloaded</span>'}</span>
      <span></span>
    </div>` : '';
  return judges.join('') + writer;
}

function transferMarkup() {
  if (!jobs.length) return '';
  return `<div class="model-transfers" aria-label="Model downloads">${jobs.map((job) => {
    const running = ['queued', 'downloading'].includes(job.state);
    return `<div class="model-transfer"><div><b>${esc(job.name ?? 'Model download')}</b><span>${job.state === 'complete' ? 'Imported. Test it below before use.' : job.state === 'failed' ? esc(job.error ?? 'Download failed. Add the model again to retry.') : job.state === 'cancelled' ? 'Download cancelled.' : `${fileSize(job.received ?? 0)}${job.total ? ` of ${fileSize(job.total)}` : ''} downloaded`}</span></div>${running ? `<progress aria-label="Download progress for ${esc(job.name ?? 'model')}"${job.total ? ` max="${job.total}" value="${job.received ?? 0}"` : ''}></progress><button type="button" class="btn --compact" data-cancel-download="${attr(job.id)}">Cancel</button>` : `<span class="status-text${job.state === 'failed' ? ' --block' : ''}">${esc(job.state)}</span>`}</div>`;
  }).join('')}</div>`;
}

export function libraryMarkup() {
  const models = library.catalog?.models ?? [];
  return `<section class="library" aria-label="Model library">
    ${library.error ? `${feedback({ tone: 'attention', title: 'Could not load your models', body: esc(library.error) })}<div class="list-state-action">${button('Retry loading', { kind: 'primary', id: 'retryModelLibrary' })}</div>` : ''}
    ${editorMarkup()}
    ${transferMarkup()}
    ${library.loading && !library.catalog
      ? feedback({ title: 'Loading your models…', body: 'Fetching saved weights, connections and downloads.' })
      : `<div class="table library-table" role="table" aria-label="Models">
          <div class="thead" role="row"><span>Model</span><span>Job</span><span>Format</span><span>Status</span><span></span></div>
          ${builtInRows()}
          ${models.map(modelRow).join('')}
        </div>
        ${library.catalog && !models.length && !editor.draft ? '<p class="table-foot">No models of your own yet. Add one to keep a reusable connection or your own local weights.</p>' : ''}`}
    ${editor.note?.scope === 'library' ? note(editor.note) : ''}
  </section>`;
}

export function bindLibrary(onChanged) {
  if ($('addCustomModel')) $('addCustomModel').onclick = () => { editor.draft = { kind: 'endpoint', name: '', baseUrl: '', model: '', source: 'upload', path: '', url: '', roles: ['compiler', 'adjudicator'], format: 'compliance' }; editor.note = null; render(); $('customModelName')?.focus(); };
  if ($('retryModelLibrary')) $('retryModelLibrary').onclick = async () => { await loadLibrary(); render(); };
  if ($('closeModelEditor')) $('closeModelEditor').onclick = () => { editor.draft = null; editor.pendingFile = null; editor.note = null; render(); $('addCustomModel')?.focus(); };
  if ($('cancelModelDelete')) $('cancelModelDelete').onclick = () => { editor.confirmDelete = null; render(); };
  if ($('cancelModelUpload')) $('cancelModelUpload').onclick = () => editor.controller?.abort();
  const byId = (id) => library.catalog?.models.find((m) => m.id === decodeURIComponent(id));
  for (const button of document.querySelectorAll('[data-model-edit]')) button.onclick = () => { const model = byId(button.dataset.modelEdit); editor.draft = { ...model, roles: [...model.roles] }; editor.note = null; render(); $('customModelName')?.focus(); };
  for (const button of document.querySelectorAll('[data-model-remove]')) button.onclick = () => { editor.confirmDelete = decodeURIComponent(button.dataset.modelRemove); render(); $('cancelModelDelete')?.focus(); };
  for (const button of document.querySelectorAll('[data-model-test], [data-model-use], [data-model-delete]')) button.onclick = async () => {
    if (editor.busy) return;
    const action = button.hasAttribute('data-model-test') ? 'test' : button.hasAttribute('data-model-use') ? 'use' : 'delete';
    const id = decodeURIComponent(button.dataset.modelTest ?? button.dataset.modelUse ?? button.dataset.modelDelete);
    const role = button.dataset.role;
    const focusId = button.id;
    editor.busy = `${id}:${action}:${role}`;
    editor.note = null;
    editor.confirmDelete = null;
    render();
    try {
      const result = action === 'delete' ? await del(`/api/settings/models/${attr(id)}`) : await post(`/api/settings/models/${attr(id)}/${action === 'use' ? 'activate' : 'test'}`, { role });
      if (!result.ok || result.j?.ok === false) throw new Error(safeError(result.j, 'The model could not be updated. Try again.'));
      editor.note = { scope: action === 'delete' ? 'library' : id, ok: true, text: action === 'test' ? `Compatibility test passed in ${result.j.ms ?? 0} ms. You can use this model as the ${roleLabel(role)}.` : action === 'use' ? `Model applied as the ${roleLabel(role)}.` : 'Model removed.' };
      await loadLibrary();
      await onChanged();
    } catch (error) {
      editor.note = { scope: id, ok: false, text: error.message || 'Warden could not be reached. Try again.' };
      // A failed re-test invalidates an earlier success on the server. Refresh
      // its gate even after failure so Use never advertises a stale pass.
      await loadLibrary();
      await onChanged();
    } finally { editor.busy = ''; if (activePage()) { render(); $(focusId)?.focus(); } }
  };
  for (const button of document.querySelectorAll('[data-cancel-download]')) button.onclick = async () => { button.disabled = true; try { const result = await del(`/api/settings/models/downloads/${button.dataset.cancelDownload}`); if (!result.ok) editor.note = { scope: 'library', ok: false, text: safeError(result.j, 'The download could not be cancelled.') }; } catch { editor.note = { scope: 'library', ok: false, text: 'Warden could not be reached. Try again.' }; } await loadLibrary(); render(); };
  bindEditor(onChanged);
}

function bindEditor(onChanged) {
  const form = $('customModelForm');
  const d = editor.draft;
  if (!form || !d) return;
  for (const [id, key] of [['customModelName', 'name'], ['customModelUrl', 'baseUrl'], ['customModelIdentifier', 'model'], ['customModelPath', 'path'], ['customModelDownload', 'url']]) if ($(id)) $(id).oninput = () => { d[key] = $(id).value; $(id).setCustomValidity(''); };
  for (const [id, key] of [['customModelKind', 'kind'], ['customModelSource', 'source'], ['customModelFormat', 'format']]) if ($(id)) $(id).onchange = () => {
    d[key] = $(id).value;
    if (key === 'format' && d.format === 'dynaguard') d.roles = ['adjudicator'];
    editor.note = null; render(); $(id)?.focus();
  };
  for (const [id, role] of [['customModelCompiler', 'compiler'], ['customModelAnalyzer', 'adjudicator']]) if ($(id)) $(id).onchange = () => { d.roles = $('customModelCompiler').checked ? ['compiler'] : []; if ($('customModelAnalyzer').checked) d.roles.push('adjudicator'); if (role === 'compiler' && d.roles.includes('compiler') && d.format === 'dynaguard') { d.format = 'compliance'; render(); $(id)?.focus(); } };
  if ($('customModelFile')) $('customModelFile').onchange = () => { editor.pendingFile = $('customModelFile').files[0] ?? null; render(); $('customModelFile')?.focus(); };
  if ($('customModelClearKey')) $('customModelClearKey').onchange = () => { d.clearKey = $('customModelClearKey').checked; if (d.clearKey) $('customModelKey').value = ''; };
  if ($('customModelKey')) $('customModelKey').oninput = () => { if ($('customModelClearKey')) $('customModelClearKey').checked = false; d.clearKey = false; };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (editor.busy || !form.reportValidity()) return;
    const local = d.kind === 'local';
    const urlField = local ? d.source === 'url' ? $('customModelDownload') : null : $('customModelUrl');
    if (urlField) {
      try { const parsed = new URL(urlField.value); if (!(local ? ['https:'] : ['http:', 'https:']).includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); }
      catch { urlField.setCustomValidity(`Use ${local ? 'an HTTPS download' : 'an HTTP or HTTPS'} URL without a username or password.`); urlField.reportValidity(); return; }
    }
    if (local && !d.id && (!d.roles.length || d.source === 'upload' && !editor.pendingFile)) { editor.note = { scope: 'form', ok: false, text: !d.roles.length ? 'Choose at least one role for this model.' : 'Choose a GGUF file to import.' }; render(); return; }
    if (local && !d.id && d.source === 'upload' && (!editor.pendingFile.name.toLowerCase().endsWith('.gguf') || editor.pendingFile.size > (library.catalog?.maxUploadBytes ?? 20 * 1024 ** 3))) { editor.note = { scope: 'form', ok: false, text: `Choose a .gguf file no larger than ${fileSize(library.catalog?.maxUploadBytes ?? 20 * 1024 ** 3)}.` }; render(); return; }
    const body = local ? { kind: 'local', name: d.name.trim(), path: d.path, roles: d.roles, format: d.format } : { kind: 'endpoint', name: d.name.trim(), baseUrl: d.baseUrl.trim(), model: d.model.trim(), apiKey: $('customModelKey')?.value ?? '', clearKey: Boolean(d.clearKey) };
    editor.busy = 'save'; editor.note = null;
    if (local && !d.id && d.source === 'upload') editor.controller = new AbortController();
    render();
    try {
      let result;
      if (d.id) result = await post(`/api/settings/models/${attr(d.id)}`, local ? { name: body.name, roles: d.roles, format: d.format } : body, { method: 'PUT' });
      else if (local && d.source === 'url') result = await post('/api/settings/models/download', { name: body.name, url: d.url.trim(), roles: d.roles, format: d.format });
      else if (local && d.source === 'upload') {
        const params = new URLSearchParams({ name: body.name, roles: d.roles.join(','), format: d.format, filename: editor.pendingFile.name });
        result = await api(`/api/settings/models/upload?${params}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: editor.pendingFile, signal: editor.controller.signal });
      } else result = await post('/api/settings/models', body);
      if (!result.ok) throw new Error(safeError(result.j, 'The model could not be saved. Review the fields and try again.'));
      editor.note = { scope: 'library', ok: true, text: local && d.source === 'url' && !d.id ? 'Download started. Progress is shown below.' : 'Model saved. Run a compatibility test before applying it.' };
      editor.draft = null; editor.pendingFile = null;
      await loadLibrary(); await onChanged();
    } catch (error) { editor.note = { scope: 'form', ok: false, text: error.name === 'AbortError' ? 'Upload cancelled. Choose a file when you are ready to try again.' : error.message || 'Warden could not be reached. Try again.' }; }
    finally { body.apiKey = ''; editor.controller = null; editor.busy = ''; if (activePage()) { render(); $(editor.draft ? 'saveCustomModel' : 'addCustomModel')?.focus(); } }
  };
}
