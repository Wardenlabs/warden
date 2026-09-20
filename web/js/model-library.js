/** Named model connections and imports. Credentials exist only in requests. */
import { $, api, attr, del, esc, post, state } from './core.js';
import { refreshAdjudicator, refreshCompiler } from './data.js';
import { downloadSize, fileSize } from './format.js';
import { ICONS } from './icons.js';
import { render } from './render.js';
import { button, feedback, menuItem } from './ui.js';

export const library = { catalog: null, error: '', loading: false };
const editor = { draft: null, busy: '', note: null, pendingFile: null, controller: null, confirmDelete: null };
let jobs = [];
let timer;
let generation = 0;
/** The last status read failed: what is on screen is a memory, not a reading. */
let stale = false;
let reading = false;
/** Requests in flight per row, so a double click is one request. */
const pending = new Set();
/** A start or cancel that failed says so beside its row, not in a toast. */
const rowNotes = new Map();
/** The deep link whose row has been focused, so revisiting does nothing twice. */
let focused = null;
const BUILTIN_ACTIVE = ['connecting', 'downloading', 'retrying', 'verifying', 'cancelling'];
const isBuiltin = (job) => job.source === 'builtin';
const running = (job) => (isBuiltin(job) ? BUILTIN_ACTIVE : ['queued', 'downloading']).includes(job.state);
const builtinJob = (id) => jobs.find((job) => isBuiltin(job) && job.builtinId === id) ?? null;
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
    // A failed read is not an empty list. Emptying it made a running download
    // vanish from its row and re-enabled Download on top of it.
    if (transfers.ok) { jobs = transfers.j?.jobs ?? []; stale = false; } else stale = jobs.some(running);
  } catch {
    if (own === generation) { library.error = 'Warden could not be reached. Check the gateway connection and refresh.'; stale = jobs.some(running); }
  } finally {
    if (own === generation) library.loading = false;
  }
  scheduleTransfers();
}

/**
 * One timer, one read in flight. Two seconds while something is moving; ten
 * while nothing is, because the job belongs to the gateway and another
 * administrator may have started one this browser has never heard of. The
 * backend job does not care whether anybody is watching: leaving the page
 * stops the questions, not the download.
 */
function scheduleTransfers() {
  clearTimeout(timer);
  if (!activePage() || (typeof document !== 'undefined' && document.hidden)) return;
  timer = setTimeout(pollTransfers, stale ? 5000 : jobs.some(running) ? 2000 : 10000);
}

export function leaveLibrary() { clearTimeout(timer); generation++; focused = null; }

async function pollTransfers() {
  if (reading || !activePage()) return;
  reading = true;
  const own = generation;
  let next = null;
  try {
    const result = await api('/api/settings/models/downloads');
    if (result.ok) next = result.j?.jobs ?? [];
  } catch { /* handled as a stale read below */ }
  reading = false;
  if (own !== generation || !activePage()) return;
  if (next) await applyJobs(next);
  else if (!stale && jobs.some(running)) { stale = true; renderLibrary(); }
  scheduleTransfers();
}

const structure = (list) => list.map((job) => `${job.id}:${job.state}:${job.canCancel !== false}`).sort().join('|');

/**
 * Take a new reading. Bytes are written into the row that is already there;
 * the page is only drawn again when a job starts, ends or changes what can be
 * done to it. Drawing it every two seconds restarted the arrow's pulse on every
 * poll and closed the menu Cancel lives in a moment after it was opened.
 */
export async function applyJobs(next) {
  const before = jobs;
  const wasStale = stale;
  jobs = next;
  stale = false;
  for (const job of next.filter(isBuiltin)) {
    const previous = before.find((old) => old.id === job.id);
    if (previous?.state !== job.state) announce(job, Boolean(previous));
  }
  const finished = next.some((job) => job.state === 'complete' && before.find((old) => old.id === job.id)?.state !== 'complete');
  if (!wasStale && structure(before) === structure(next)) { for (const job of next) patchJob(job); return; }
  // A file that has just landed changes three answers at once: the catalogue,
  // the analyzer picker and the runtime inventory. Refreshing only the first
  // left Use pointing at a choice that still said "download required".
  if (finished) await refreshInstalled();
  renderLibrary();
}

async function refreshInstalled() {
  const own = generation;
  const [catalog] = await Promise.all([api('/api/settings/models').catch(() => ({ ok: false })), refreshAdjudicator(), refreshCompiler()]);
  if (own === generation && catalog.ok) library.catalog = catalog.j;
}

/** Transitions, once each, to a region that outlives the page being redrawn. */
function announce(job, known) {
  const text = { connecting: known ? '' : `Downloading ${job.name}.`, complete: `${job.name} downloaded.`, cancelled: `${job.name} download cancelled.`,
    failed: `${job.name} download failed.`, interrupted: `${job.name} download was interrupted.` }[job.state];
  if (!text || typeof document === 'undefined' || !document.body) return;
  let region = $('libraryLive');
  if (!region) {
    region = Object.assign(document.createElement('div'), { id: 'libraryLive', className: 'sr-only' });
    region.setAttribute('role', 'status'); region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  region.textContent = text;
}

/** The console tests have no DOM to draw a whole page into. They replace this
 * to count redraws, which is the behaviour a poll must not get wrong. */
let draw = render;
export function setLibraryRedraw(fn) { draw = fn ?? render; }

/** Redraw without losing the open menu or the focused control to it. */
function renderLibrary() {
  if (!activePage() || typeof document === 'undefined') return;
  const open = document.querySelector?.('details.menu[open] > summary[id]')?.id;
  const focus = document.activeElement?.id;
  draw();
  if (open) $(open)?.parentElement?.setAttribute('open', '');
  if (focus) $(focus)?.focus?.({ preventScroll: true });
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
        <div class="field"><label for="customModelFormat">Response format</label><select id="customModelFormat" data-no-restore><option value="compliance"${d.format === 'compliance' ? ' selected' : ''}>General instruction model · JSON compliance</option><option value="dynaguard"${d.format === 'dynaguard' ? ' selected' : ''}>DynaGuard · PASS / FAIL</option><option value="shieldstral"${d.format === 'shieldstral' ? ' selected' : ''}>Shieldstral · yes / no</option><option value="granite-guardian"${d.format === 'granite-guardian' ? ' selected' : ''}>Granite Guardian · native score</option></select><span class="field-help">Guard models are analyzer-only. Successful compatibility tests are required before an imported model can be used.</span></div>`}
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
 * What a built-in row says, from the file on disk and its latest job.
 *
 * A running job first, because that is what somebody is waiting on; then what
 * is installed and whether it is actually in force; then how the last attempt
 * ended. A cancelled job says nothing — the file is simply not there.
 */
export function builtinStatus(b, job) {
  const bytes = (n) => downloadSize(n ?? 0);
  if (job && running(job)) {
    const known = job.total > 0;
    const moved = job.received > 0 ? known ? `${bytes(job.received)} of ${bytes(job.total)}` : `${bytes(job.received)} downloaded` : '';
    const text = job.state === 'downloading' ? known ? `Downloading · ${Math.floor(job.received / job.total * 100)}%` : 'Downloading'
      : job.state === 'retrying' ? `Retrying · attempt ${job.attempt} of ${job.maxAttempts}`
        : job.state === 'verifying' ? 'Verifying…' : job.state === 'cancelling' ? 'Cancelling…' : 'Connecting…';
    return { text, detail: stale ? `Status unavailable · last read ${moved || 'before any data arrived'}` : moved, tone: stale ? 'attention' : '', arrow: stale ? 'stale' : 'live',
      progress: job.state === 'cancelling' ? null : { received: job.received ?? 0, total: known ? job.total : null } };
  }
  if (b.onDisk) {
    const active = b.activeRoles ?? [];
    if (active.length) return { text: `Active · ${active.map((r) => (r === 'adjudicator' ? 'judging' : 'drafting')).join(', ')}`, detail: '', tone: 'allow' };
    // A file Warden did not fetch itself is there, not vouched for.
    return { text: b.verifiedDownload ? 'Downloaded · built-in' : 'On disk · built-in', detail: (b.selectedRoles ?? []).length ? 'Selected · not loaded' : '', tone: '' };
  }
  if (b.downloadBlockedReason) return { text: 'Model file requires repair', detail: b.downloadBlockedReason, tone: 'attention' };
  if (job?.state === 'failed') return { text: 'Download failed', detail: job.error ?? 'Retry to continue.', tone: 'block' };
  if (job?.state === 'interrupted') return { text: 'Download interrupted', detail: job.error ?? 'The gateway stopped during this download.', tone: 'attention' };
  if ((b.selectedRoles ?? []).length) return { text: 'Selected · not downloaded', detail: '', tone: 'attention' };
  return { text: 'Not downloaded', detail: '', tone: 'muted' };
}

const toneClass = (tone) => tone === 'muted' ? 'cell-muted' : tone ? `status-text --${tone}` : '';
const progressAttrs = (p) => p ? ` role="progressbar" aria-valuemin="0"${p.total ? ` aria-valuemax="${p.total}" aria-valuenow="${Math.min(p.received, p.total)}"` : ''}` : '';

function statusMarkup(b, job) {
  const s = builtinStatus(b, job);
  const id = attr(b.id);
  return `<span class="download-status" id="builtin-status-${id}">
    <span class="download-line">${s.arrow ? `<span class="download-arrow --${s.arrow}" id="builtin-progress-${id}" aria-label="Download progress for ${esc(b.name)}"${progressAttrs(s.progress)}>${ICONS.download}</span>` : ''}<span id="builtin-status-text-${id}" class="${toneClass(s.tone)}">${esc(s.text)}</span></span>
    <small id="builtin-status-detail-${id}" title="${esc(s.detail)}">${esc(s.detail)}</small>
  </span>`;
}

/** Bytes into the existing row. Anything that is not there is a redraw's job. */
function patchJob(job) {
  if (!running(job)) return;
  if (!isBuiltin(job)) {
    const line = $(`transfer-text-${job.id}`);
    if (line) line.textContent = `${fileSize(job.received ?? 0)}${job.total ? ` of ${fileSize(job.total)}` : ''} downloaded`;
    const bar = $(`transfer-progress-${job.id}`);
    if (bar && job.total) { bar.max = job.total; bar.value = job.received ?? 0; }
    return;
  }
  const b = library.catalog?.builtins?.find((entry) => entry.id === job.builtinId);
  if (!b) return;
  const s = builtinStatus(b, job);
  const text = $(`builtin-status-text-${b.id}`);
  const detail = $(`builtin-status-detail-${b.id}`);
  const bar = $(`builtin-progress-${b.id}`);
  if (text) text.textContent = s.text;
  if (detail) { detail.textContent = s.detail; detail.title = s.detail; }
  if (bar && s.progress?.total) { bar.setAttribute('aria-valuemax', s.progress.total); bar.setAttribute('aria-valuenow', Math.min(s.progress.received, s.progress.total)); }
}

/**
 * The built-in weights, in the same table as your own: one row per file on the
 * gateway's disk, from the gateway's own inventory of them. The compiler row
 * used to be inferred from the runtime's model list, which describes whatever
 * is loaded — an imported file or an override as readily as the bundled one.
 * Qwen3 1.7B writes rules and can judge; it is one file, so it is one row.
 *
 * Download fetches that file and changes nothing else. Use stays a separate
 * item that appears once the file is here.
 */
function builtInRows() {
  const catalog = library.catalog;
  const transfer = catalog?.transfer ?? { available: false, reason: null, active: null };
  return (catalog?.builtins ?? []).map((b) => {
    const id = attr(b.id);
    const job = builtinJob(b.id);
    const choice = state.adjudicator?.choices?.find((c) => c.id === b.adjudicatorChoice);
    const busy = !job || !running(job) ? transfer.active ?? jobs.find(running) ?? null : null;
    const why = !transfer.available ? transfer.reason ?? 'Model downloads are unavailable on this gateway.'
      : b.downloadBlockedReason ? b.downloadBlockedReason
        : busy ? `${busy.name} is being transferred. Finish or cancel it first.` : stale ? 'The gateway is not answering. Download becomes available when it does.' : '';
    const items = [];
    if (job && running(job)) items.push({ label: 'Cancel download', id: `builtin-cancel-${id}`, attrs: `data-cancel-download="${attr(job.id)}" data-builtin-row="${id}"`, disabled: job.canCancel === false || pending.has(b.id) });
    else if (b.onDisk) {
      const judging = (b.activeRoles ?? []).includes('adjudicator');
      const blocked = catalog?.overrides?.adjudicator ? 'The environment controls this role. Remove its override to use a saved model.'
        : state.models?.mock ? 'This gateway is in demo mode. Restart it with real inference to use a downloaded model.' : '';
      if (b.roles.includes('adjudicator') && !judging) {
        items.push({ label: 'Use for analysis', id: `builtin-use-${id}`, attrs: `data-judge-builtin="${esc(b.adjudicatorChoice)}"`, disabled: Boolean(blocked) });
        if (blocked) items.push({ note: blocked });
      }
    } else {
      const retry = job?.state === 'failed' || job?.state === 'interrupted';
      items.push({ label: retry ? 'Retry download' : `Download · ${downloadSize(b.approxBytes, { estimate: true })}`, id: `builtin-download-${id}`, attrs: `data-builtin-download="${id}"`, disabled: Boolean(why) || pending.has(b.id) || job?.canRetry === false });
      if (why) items.push({ note: why });
    }
    const note = rowNotes.get(b.id);
    return `<div class="trow" role="row" data-builtin-id="${esc(b.id)}">
      <span class="cell-stack"><span class="mono cell-strong">${esc(b.filename)}</span><small>${esc(b.name)} · ${downloadSize(b.onDisk && b.bytes ? b.bytes : b.approxBytes, { estimate: !(b.onDisk && b.bytes) })}${choice?.perDecision ? ` · ${esc(choice.perDecision)}` : ''}</small></span>
      <span>${b.roles.map(jobName).join(', ')}</span>
      <span class="mono cell-muted">${esc(b.format)}</span>
      <span>${statusMarkup(b, job)}</span>
      <span class="row-menu">${items.length ? `<details class="menu --right"><summary class="menu-trigger --dots" id="builtin-menu-${id}" aria-label="More actions for ${esc(b.name)}">···</summary><div class="menu-list" role="menu">${items.map(menuItem).join('')}</div></details>` : ''}</span>
    </div>
    ${note ? `<div class="trow-note">${note}</div>` : ''}`;
  }).join('');
}

/** Imports of your own. A built-in shows its progress in its row, not here as well. */
function transferMarkup() {
  const custom = jobs.filter((job) => !isBuiltin(job));
  if (!custom.length) return '';
  return `<div class="model-transfers" aria-label="Model downloads">${custom.map((job) => {
    const active = running(job);
    return `<div class="model-transfer"><div><b>${esc(job.name ?? 'Model download')}</b><span>${job.state === 'complete' ? 'Imported. Test it below before use.' : job.state === 'failed' ? esc(job.error ?? 'Download failed. Add the model again to retry.') : job.state === 'cancelled' ? 'Download cancelled.' : `<span id="transfer-text-${attr(job.id)}">${fileSize(job.received ?? 0)}${job.total ? ` of ${fileSize(job.total)}` : ''} downloaded</span>`}</span></div>${active ? `<progress id="transfer-progress-${attr(job.id)}" aria-label="Download progress for ${esc(job.name ?? 'model')}"${job.total ? ` max="${job.total}" value="${job.received ?? 0}"` : ''}></progress><button type="button" class="btn --compact" data-cancel-download="${attr(job.id)}">Cancel</button>` : `<span class="status-text${job.state === 'failed' ? ' --block' : ''}">${esc(job.state)}</span>`}</div>`;
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
  // Download and Retry are the same request: this row's file, and nothing about
  // which model judges. The answer decides what the row says, so a refusal
  // stays beside the model it was about instead of passing by in a toast.
  for (const button of document.querySelectorAll('[data-builtin-download]')) button.onclick = async () => {
    const id = decodeURIComponent(button.dataset.builtinDownload);
    if (pending.has(id)) return;
    pending.add(id); rowNotes.delete(id);
    button.closest('details.menu')?.removeAttribute('open');
    let failure = '';
    try {
      const result = await post(`/api/settings/models/builtins/${attr(id)}/download`, {});
      if (result.ok && result.j?.job) jobs = [...jobs.filter((job) => !(isBuiltin(job) && job.builtinId === id)), result.j.job];
      else if (!result.ok) failure = safeError(result.j, 'The download could not be started. Try again.');
    } catch { failure = 'Warden could not be reached. Try again.'; }
    pending.delete(id);
    if (failure) rowNotes.set(id, note({ ok: false, text: failure }));
    await loadLibrary();
    if (!activePage()) return;
    render();
    $(`builtin-menu-${id}`)?.focus();
  };
  for (const button of document.querySelectorAll('[data-cancel-download]')) button.onclick = async () => {
    const row = button.dataset.builtinRow ? decodeURIComponent(button.dataset.builtinRow) : null;
    const key = row ?? button.dataset.cancelDownload;
    if (pending.has(key)) return;
    pending.add(key); button.disabled = true;
    button.closest('details.menu')?.removeAttribute('open');
    let failure = '';
    try {
      const result = await del(`/api/settings/models/downloads/${button.dataset.cancelDownload}`);
      // "Already finished" is not a failed cancel; the refresh below shows what it became.
      if (!result.ok && result.j?.code !== 'transfer_finished') failure = safeError(result.j, 'The download could not be cancelled.');
    } catch { failure = 'Warden could not be reached. Try again.'; }
    pending.delete(key);
    if (failure && row) rowNotes.set(row, note({ ok: false, text: failure }));
    else if (failure) editor.note = { scope: 'library', ok: false, text: failure };
    await loadLibrary();
    if (!activePage()) return;
    render();
    if (row) $(`builtin-menu-${row}`)?.focus();
  };
  // A link from Active or the compiler's notice names a row. Bring it into view
  // once; coming back to the same address must not start or change anything.
  const wanted = state.query?.model;
  if (wanted && focused !== wanted && library.catalog) {
    focused = wanted;
    const trigger = $(`builtin-menu-${wanted}`);
    trigger?.scrollIntoView?.({ block: 'center' });
    trigger?.focus?.({ preventScroll: true });
  }
  bindEditor(onChanged);
}

function bindEditor(onChanged) {
  const form = $('customModelForm');
  const d = editor.draft;
  if (!form || !d) return;
  for (const [id, key] of [['customModelName', 'name'], ['customModelUrl', 'baseUrl'], ['customModelIdentifier', 'model'], ['customModelPath', 'path'], ['customModelDownload', 'url']]) if ($(id)) $(id).oninput = () => { d[key] = $(id).value; $(id).setCustomValidity(''); };
  for (const [id, key] of [['customModelKind', 'kind'], ['customModelSource', 'source'], ['customModelFormat', 'format']]) if ($(id)) $(id).onchange = () => {
    d[key] = $(id).value;
    if (key === 'format' && d.format !== 'compliance') d.roles = ['adjudicator'];
    editor.note = null; render(); $(id)?.focus();
  };
  for (const [id, role] of [['customModelCompiler', 'compiler'], ['customModelAnalyzer', 'adjudicator']]) if ($(id)) $(id).onchange = () => { d.roles = $('customModelCompiler').checked ? ['compiler'] : []; if ($('customModelAnalyzer').checked) d.roles.push('adjudicator'); if (role === 'compiler' && d.roles.includes('compiler') && d.format !== 'compliance') { d.format = 'compliance'; render(); $(id)?.focus(); } };
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

// Coming back to the tab reads the gateway at once instead of waiting out a
// timer that was stopped while nobody was looking.
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else if (activePage()) void pollTransfers();
});
