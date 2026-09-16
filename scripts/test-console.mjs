/** Console boundary tests, with no browser/runtime dependency. The browser
 * walkthrough separately covers layout, file pickers, focus and networking. */
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { captureFieldValues, restoreFieldValues } from '../web/js/form-state.js';

const original = { document: globalThis.document, window: globalThis.window, sessionStorage: globalThis.sessionStorage, fetch: globalThis.fetch };
const elements = new Map();
globalThis.document = { addEventListener() {}, getElementById: (id) => elements.get(id) ?? null, querySelectorAll: () => [] };
globalThis.window = { prompt: () => { throw new Error('An employee request must never request an admin key.'); } };
globalThis.sessionStorage = { getItem: () => 'administrator-secret' };
const { api, post, state } = await import('../web/js/core.js');
const { documentAnalysisNotice, documentMetadataMarkup, documentReason, documentReviewPendingMarkup } = await import('../web/js/documents.js');
const { library, libraryMarkup } = await import('../web/js/model-library.js');
const { compilerNeedsSetup, compilerSetupNudge, compilerSettings, bindCompiler } = await import('../web/js/compiler.js');
const { compileFailure } = await import('../web/js/answers.js');
const { restoreSoloRuleText } = await import('../web/js/solo.js');
const { promptEditor, acceptPromptCatalog, hasPromptChanges, validatePromptTemplate, promptEditorMarkup, togglePromptEditor, closePromptEditor, loadPrompts } = await import('../web/js/prompt-editor.js');
await import('../web/js/models.js');
const { VIEWS } = await import('../web/js/views.js');

beforeEach(() => {
  elements.clear(); library.catalog = null; library.error = ''; library.loading = false;
  Object.assign(state, { compiler: null, compilerDraft: null, compilerTest: null, compilerBusy: false, view: 'activity', canLeaveDemo: false });
  Object.assign(promptEditor, { catalog: null, drafts: Object.create(null), openRole: null, selected: {}, loading: false, error: '', busy: '', confirmReset: null });
});
after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });

function field(id, type, value, extra = {}) {
  return { id, type, tagName: 'INPUT', value, checked: false, selectionStart: null, selectionEnd: null, hasAttribute: () => false, ...extra };
}
const root = (...fields) => ({ querySelectorAll: () => fields });

// These are role-boundary tests, not checks of a particular header casing.
test('the Simulator sends the employee identity even when an admin key is stored', async () => {
  let request;
  globalThis.fetch = async (path, init) => { request = { path, init }; return new Response('{"verdict":"ALLOW"}', { status: 200 }); };
  await post('/api/guard/check', { prompt: 'hello' }, { headers: { authorization: 'Bearer employee-secret' } });
  assert.equal(new Headers(request.init.headers).get('authorization'), 'Bearer employee-secret');
  assert.equal(JSON.parse(request.init.body).prompt, 'hello');
});

test('a refused employee identity is never retried using an administrator identity', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('{"error":"forbidden"}', { status: 403 }); };
  const response = await api('/api/guard/check', { headers: { Authorization: 'Bearer employee-secret' } });
  assert.equal(response.status, 403);
  assert.equal(requests, 1);
});

test('administrative calls still receive the stored admin key', async () => {
  globalThis.fetch = async (_path, init) => { assert.equal(new Headers(init.headers).get('authorization'), 'Bearer administrator-secret'); return new Response('{}'); };
  await api('/api/settings/models');
});

test('password and file values are never read into a refresh snapshot', () => {
  const secret = field('key', 'password', '');
  const file = field('file', 'file', '');
  for (const item of [secret, file]) Object.defineProperty(item, 'value', { get() { throw new Error('Sensitive value was read'); }, set() { throw new Error('Sensitive value was restored'); } });
  const publicField = field('name', 'text', 'My compiler', { selectionStart: 2, selectionEnd: 5 });
  const snapshot = captureFieldValues(root(secret, file, publicField));
  assert.deepEqual(Object.keys(snapshot), ['name']);
  restoreFieldValues(root(secret, file), { key: { value: 'secret' }, file: { value: 'C:\\fakepath\\file' } });
});

test('live refresh restores public text, caret and checkbox selections', () => {
  const snapshot = captureFieldValues(root(field('name', 'text', 'Renamed model', { selectionStart: 1, selectionEnd: 4 }), field('role', 'checkbox', 'on', { checked: true })));
  let caret;
  const name = field('name', 'text', '', { setSelectionRange: (start, end) => { caret = [start, end]; } });
  const role = field('role', 'checkbox', 'on');
  restoreFieldValues(root(name, role), snapshot);
  assert.equal(name.value, 'Renamed model');
  assert.deepEqual(caret, [1, 4]);
  assert.equal(role.checked, true);
});

test('changed provider options and explicit server-owned values are not overwritten', () => {
  const provider = field('provider', 'select-one', 'new', { tagName: 'SELECT', options: [{ value: 'new' }] });
  const managed = field('managed', 'text', 'server selection', { hasAttribute: (name) => name === 'data-no-restore' });
  restoreFieldValues(root(provider, managed), { provider: { value: 'removed-provider' }, managed: { value: 'old' } });
  assert.equal(provider.value, 'new');
  assert.equal(managed.value, 'server selection');
});

test('attachment names and server explanations are rendered as text, with unreadable status', () => {
  const html = documentMetadataMarkup([{ name: '"><img src=x onerror=alert(1)>.pdf', bytes: 123, status: 'unreadable', reason: 'bad <script>alert(1)</script>' }]);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('Could not read'));
  assert.ok(!html.includes('>Read<'));
});

test('prepared attachments do not claim the document was read or policy checked', () => {
  const html = documentMetadataMarkup([{ name: 'example.txt', bytes: 42 }], { submitted: true });
  assert.ok(html.includes('Attached'));
  assert.ok(!html.includes('>Read<'));
  assert.ok(!html.includes('Allowed'));
  assert.match(documentReason('encrypted-document'), /unlocked copy/);
  assert.match(documentReason('document-reader-busy'), /try again/);
});

test('custom models cannot be applied until a successful role-specific test', () => {
  const model = { id: 'model-1', name: 'Custom', kind: 'endpoint', model: 'some-model', baseUrl: 'https://example.test/v1', roles: ['compiler'], testedRoles: [], activeRoles: [] };
  library.catalog = { models: [model], selections: { compiler: null, adjudicator: null } };
  let html = libraryMarkup();
  let activate = html.match(/<button[^>]*data-model-use="model-1"[^>]*>/)?.[0];
  assert.ok(activate?.includes(' disabled'));
  model.testedRoles = ['adjudicator'];
  assert.ok(libraryMarkup().match(/<button[^>]*data-model-use="model-1"[^>]*>/)?.[0].includes(' disabled'));
  model.testedRoles = ['compiler'];
  activate = libraryMarkup().match(/<button[^>]*data-model-use="model-1"[^>]*>/)?.[0];
  assert.ok(activate && !activate.includes(' disabled'));
});

test('an assigned model cannot be edited or removed, including an environment override', () => {
  library.catalog = { models: [{ id: 'model-1', name: '<script>x</script>', kind: 'local', roles: ['adjudicator'], testedRoles: ['adjudicator'], activeRoles: [], bytes: 100 }], selections: { compiler: null, adjudicator: 'model-1' } };
  const html = libraryMarkup();
  assert.ok(html.match(/<button[^>]*data-model-edit="model-1"[^>]*>/)?.[0].includes(' disabled'));
  assert.ok(html.match(/<button[^>]*data-model-remove="model-1"[^>]*>/)?.[0].includes(' disabled'));
  assert.ok(!html.includes('<script>'));
  assert.equal(state.sending, false);
});

test('a retained custom runtime keeps its name and edit protection while a built-in download is pending', () => {
  const model = { id: 'model-1', name: 'Our analyzer', filename: 'original.gguf', kind: 'local', roles: ['adjudicator'], testedRoles: ['adjudicator'], activeRoles: ['adjudicator'], bytes: 100 };
  library.catalog = { models: [model], selections: { compiler: null, adjudicator: null }, inForce: { adjudicator: '/gateway/models/model-1.gguf' } };
  const previous = state.models;
  state.models = { state: 'ready', judging: { model: 'model-1.gguf', where: 'On this gateway' } };
  try {
    for (const actual of ['/gateway/models/model-1.gguf', 'unmapped-runtime']) {
      library.catalog.inForce.adjudicator = actual;
      // The name is read on Active and the protection is enforced on Library,
      // so each is asserted on the tab that shows it.
      state.sel = null;
      assert.match(VIEWS.models.body(), /data-active-model="adjudicator">Our analyzer<\/b>/);
      state.sel = 'library';
      const html = VIEWS.models.body();
      assert.ok(html.match(/<button[^>]*data-model-edit="model-1"[^>]*>/)?.[0].includes(' disabled'));
      assert.ok(html.match(/<button[^>]*data-model-remove="model-1"[^>]*>/)?.[0].includes(' disabled'));
    }
  } finally { state.models = previous; state.sel = null; }
});

function promptTemplate(id, role, overrides = {}) {
  return { id, role, name: id, description: 'An editable instruction.', active: true, custom: false,
    template: 'Read {{input}}.', defaultTemplate: 'Read {{input}}.',
    tokens: [{ name: 'input', required: true, description: 'The isolated request.' }],
    requiredTokens: ['input'], outputContract: '{"verdict":"PASS|FAIL"}', ...overrides };
}

test('the prompt editor escapes saved text and response contracts instead of interpreting HTML', () => {
  const attack = '</textarea><img src=x onerror=alert(1)>';
  acceptPromptCatalog({ revision: 'first', templates: [promptTemplate('compile-system', 'compiler', { template: `${attack} {{input}}`, defaultTemplate: attack, outputContract: attack })] });
  togglePromptEditor('compiler');
  const html = promptEditorMarkup('compiler');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;/textarea&gt;'));
  assert.match(html, /id="savePrompt"[^>]*disabled/);
  assert.equal(hasPromptChanges(), false);
});

test('required prompt context and unknown variables are reported before saving', () => {
  const template = promptTemplate('compile-user', 'compiler');
  assert.deepEqual(validatePromptTemplate(template, 'Literal JSON {"a":1}; {{input}}'), []);
  assert.match(validatePromptTemplate(template, 'No context.').join(' '), /required variables/);
  assert.match(validatePromptTemplate(template, '{{input}} {{unknown}}').join(' '), /Unknown variables/);
});

test('refresh preserves a draft and advances its revision when only another template changed', () => {
  const first = promptTemplate('compile-system', 'compiler');
  const second = promptTemplate('compile-user', 'compiler');
  acceptPromptCatalog({ revision: 'first', templates: [first, second] });
  togglePromptEditor('compiler'); promptEditorMarkup('compiler');
  const draft = promptEditor.drafts[first.id];
  draft.text = 'My unsaved instruction {{input}}';
  acceptPromptCatalog({ revision: 'second', templates: [first, { ...second, template: 'Saved elsewhere {{input}}' }] });
  assert.equal(draft.text, 'My unsaved instruction {{input}}');
  assert.equal(draft.base, first.template);
  assert.equal(draft.revision, 'second');
  assert.equal(draft.conflict, false);
  assert.equal(hasPromptChanges('compiler'), true);
});

test('a concurrent edit to the same prompt preserves both versions and prevents accidental overwrite', () => {
  const template = promptTemplate('compile-system', 'compiler');
  acceptPromptCatalog({ revision: 'first', templates: [template] });
  togglePromptEditor('compiler'); promptEditorMarkup('compiler');
  const draft = promptEditor.drafts[template.id];
  draft.text = 'My draft {{input}}';
  acceptPromptCatalog({ revision: 'second', templates: [{ ...template, template: 'Their saved instruction {{input}}', custom: true }] });
  assert.equal(draft.text, 'My draft {{input}}');
  assert.equal(draft.base, template.template);
  assert.equal(draft.revision, 'first');
  assert.equal(draft.conflict, true);
  const html = promptEditorMarkup('compiler');
  assert.match(html, /Their saved instruction/);
  assert.match(html, /id="savePrompt"[^>]*disabled/);
  assert.match(html, /id="keepPromptDraft"/);
  assert.match(html, /id="useSavedPrompt"/);
});

test('closing and switching prompt roles retains drafts and selects the active analyzer format', () => {
  const compile = promptTemplate('compile-system', 'compiler');
  const inactive = promptTemplate('compliance-system', 'adjudicator', { active: false });
  const active = promptTemplate('dynaguard-user', 'adjudicator');
  acceptPromptCatalog({ revision: 'first', templates: [compile, inactive, active] });
  togglePromptEditor('compiler'); promptEditorMarkup('compiler');
  promptEditor.drafts[compile.id].text = 'Keep this draft {{input}}';
  closePromptEditor();
  togglePromptEditor('adjudicator');
  assert.equal(promptEditor.selected.adjudicator, active.id);
  assert.equal(hasPromptChanges('adjudicator'), false);
  togglePromptEditor('compiler');
  assert.match(promptEditorMarkup('compiler'), /Keep this draft/);
  assert.equal(hasPromptChanges('compiler'), true);
});

test('refresh updates an untouched prompt without creating a local edit', () => {
  const template = promptTemplate('compile-system', 'compiler');
  acceptPromptCatalog({ revision: 'first', templates: [template] });
  togglePromptEditor('compiler'); promptEditorMarkup('compiler');
  acceptPromptCatalog({ revision: 'second', templates: [{ ...template, template: 'Updated saved instruction {{input}}', custom: true }] });
  assert.equal(promptEditor.drafts[template.id].text, 'Updated saved instruction {{input}}');
  assert.equal(promptEditor.drafts[template.id].revision, 'second');
  assert.equal(hasPromptChanges(), false);
});

test('a delayed prompt refresh cannot overwrite a newer accepted save', async () => {
  const template = promptTemplate('compile-system', 'compiler');
  const initial = { revision: 'first', templates: [template] };
  for (const outcome of ['snapshot', 'failure']) {
    acceptPromptCatalog(initial);
    promptEditor.openRole = 'compiler'; promptEditorMarkup('compiler');
    let releaseRead, rejectRead;
    globalThis.fetch = () => new Promise((resolve, reject) => { releaseRead = resolve; rejectRead = reject; });
    const pending = loadPrompts();
    acceptPromptCatalog({ revision: 'saved', templates: [{ ...template, template: 'Newly saved instruction {{input}}', custom: true }] });
    if (outcome === 'snapshot') releaseRead(new Response(JSON.stringify(initial)));
    else rejectRead(new Error('The older refresh failed.'));
    await pending;
    assert.equal(promptEditor.catalog.revision, 'saved');
    assert.equal(promptEditor.drafts[template.id].text, 'Newly saved instruction {{input}}');
    assert.equal(promptEditor.drafts[template.id].revision, 'saved');
    assert.equal(promptEditor.error, '');
    assert.equal(hasPromptChanges(), false);
  }
});

test('a prompt refresh finishing during a write cannot rebase that write’s draft', async () => {
  const template = promptTemplate('compile-system', 'compiler');
  acceptPromptCatalog({ revision: 'first', templates: [template] });
  togglePromptEditor('compiler'); promptEditorMarkup('compiler');
  const draft = promptEditor.drafts[template.id];
  draft.text = 'Instruction being saved {{input}}';
  let releaseRead;
  globalThis.fetch = () => new Promise((resolve) => { releaseRead = resolve; });
  const pending = loadPrompts();
  promptEditor.busy = 'save';
  releaseRead(new Response(JSON.stringify({ revision: 'concurrent', templates: [{ ...template, template: 'An external edit {{input}}' }] })));
  await pending;
  assert.equal(promptEditor.catalog.revision, 'first');
  assert.equal(draft.text, 'Instruction being saved {{input}}');
  assert.equal(draft.base, template.template);
  assert.equal(draft.revision, 'first');
  assert.equal(draft.conflict, false);
});

function compilerConfiguration(overrides = {}) {
  return { provider: 'claude-cli', model: '', setupRequired: true, overriddenByEnv: false,
    providers: [
      { id: 'local', label: 'Local weights', models: [] },
      { id: 'claude-cli', label: 'Claude Code on this machine', models: ['opus', 'sonnet'] },
      { id: 'custom', label: 'Custom endpoint', baseUrl: 'https://example.test/v1', models: ['provider-model'] }
    ], cliTools: [{ tool: 'claude', found: true }],
    claude: { installed: true, auth: 'unknown', status: 'unknown', message: 'Check the connection to confirm access.' }, ...overrides };
}

test('compiler setup appears in solo and team until an explicit provider or environment is configured', () => {
  state.compiler = compilerConfiguration();
  for (const view of ['soloRules', 'soloSettings', 'activity', 'policy']) {
    state.view = view;
    const html = compilerSetupNudge();
    assert.match(html, /Choose what writes your rules/);
    assert.match(html, /Set up the rule writer/);
    assert.match(html, /data-go="models" data-q="setup=compiler"/);
    assert.match(html, /keep exploring/);
  }
  state.compiler.setupRequired = false;
  assert.equal(compilerNeedsSetup(), false);
  assert.equal(compilerSetupNudge(), '');
  state.compiler.setupRequired = true;
  state.compiler.overriddenByEnv = true;
  assert.equal(compilerSetupNudge(), '');
});

test('opening a Claude compiler keeps its blank CLI model and separates auth status from connection validation', () => {
  state.compiler = compilerConfiguration();
  const html = compilerSettings();
  assert.equal(state.compilerDraft.model, '');
  assert.match(html, /Use Claude Code on this machine/);
  assert.match(html, /claude auth login/);
  assert.ok(!html.includes('code.claude.com'), 'an installed CLI is not asked to be installed again');
  assert.ok(!html.match(/<button[^>]*id="cTest"[^>]*>/)?.[0].includes('disabled'));
  assert.ok(!html.includes('id="cSave"'));
  state.compiler.claude.auth = 'signed-in';
  assert.ok(!compilerSettings().includes('id="cSave"'));
});

test('Claude Apply requires a successful check for the current model and error text is escaped', () => {
  state.compiler = compilerConfiguration({ claude: { installed: false, auth: 'unavailable', status: 'install-required', message: '<img src=x onerror=alert(1)>' } });
  state.compilerTest = { ok: false, error: '<script>account error</script>' };
  let html = compilerSettings();
  assert.ok(!html.includes('<img') && !html.includes('<script>'));
  assert.match(html, /code\.claude\.com\/docs\/en\/setup#install-claude-code/);
  assert.ok(!html.includes('id="cSave"'));
  state.compilerTest = { ok: true, provider: 'claude-cli', model: '', ms: 25 };
  html = compilerSettings();
  assert.ok(!html.match(/<button[^>]*id="cSave"[^>]*>/)?.[0].includes('disabled'));
  state.compilerDraft.model = 'a-different-model';
  assert.ok(!compilerSettings().includes('id="cSave"'));
});

test('existing provider and explicit model preferences survive opening the setup form', () => {
  for (const config of [compilerConfiguration({ model: 'sonnet', setupRequired: false }), compilerConfiguration({ provider: 'custom', model: 'kept-model', baseUrl: 'https://saved.test/v1', setupRequired: false, overriddenByEnv: true })]) {
    state.compiler = config; state.compilerDraft = null;
    compilerSettings();
    assert.equal(state.compilerDraft.provider, config.provider);
    assert.equal(state.compilerDraft.model, config.model);
    if (config.baseUrl) assert.equal(state.compilerDraft.baseUrl, config.baseUrl);
    assert.equal(compilerSetupNudge(), '');
  }
});

test('choosing Claude Code as the rule writer opens guided setup with a blank model instead of applying or authenticating', () => {
  state.compiler = compilerConfiguration({ provider: 'local', setupRequired: false });
  state.compilerDraft = null;
  state.view = 'models';
  const select = { id: 'cProvider', focus() {} };
  const pane = { className: '', innerHTML: '', querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML() {} };
  elements.set('compilerForm', { querySelectorAll: () => [] }); elements.set('cProvider', select); elements.set('pane', pane); elements.set('sidebar', { innerHTML: '' });
  const savedQuery = document.querySelector;
  document.querySelector = () => null;
  globalThis.fetch = () => { throw new Error('Picking Claude must not apply, install or authenticate it.'); };
  try {
    bindCompiler();
    select.onchange({ target: { value: 'claude-cli' } });
    assert.equal(state.compilerDraft.provider, 'claude-cli');
    assert.equal(state.compilerDraft.model, '');
    assert.match(compilerSettings(), /id="cModel"[^>]* value="" placeholder="Claude Code default"/);
  } finally { document.querySelector = savedQuery; elements.delete('compilerForm'); elements.delete('cProvider'); elements.delete('pane'); elements.delete('sidebar'); }
});

test('missing local weights offer download only after the local compiler is selected', () => {
  state.compiler = compilerConfiguration();
  state.compilerDraft = { provider: 'local', model: '', baseUrl: '', redactNames: false };
  const previous = state.models;
  state.models = { models: [{ role: 'compiler', onDisk: false }] };
  state.canLeaveDemo = true;
  try {
    assert.match(compilerSettings(), /class="btn js-get-models" disabled/);
    state.compiler.provider = 'local'; state.compiler.setupRequired = false;
    const html = compilerSettings();
    assert.match(html, /Download its weights before drafting/);
    assert.ok(!html.match(/<button[^>]*class="btn js-get-models"[^>]*>/)?.[0].includes('disabled'));
  } finally { state.models = previous; }
});

test('a compiler setup refusal offers configuration instead of asking to rephrase the rule', () => {
  const html = compileFailure({ kind: 'compiler-setup-required', error: 'Apply the compiler before drafting. <script>x</script>' });
  assert.match(html, /data-go="models" data-q="setup=compiler"/);
  assert.match(html, /Set up the rule writer/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('more plainly') && !html.includes('showLog'));
});

test('a solo setup refusal restores the typed rule only while its field is still empty', () => {
  const input = field('soloRuleText', 'text', '');
  elements.set(input.id, input);
  restoreSoloRuleText('  Keep customer records private.  ');
  assert.equal(input.value, '  Keep customer records private.  ');
  input.value = 'A newer rule typed while the request finished.';
  restoreSoloRuleText('The earlier request.');
  assert.equal(input.value, 'A newer rule typed while the request finished.');
  elements.clear();
  assert.doesNotThrow(() => restoreSoloRuleText('A rule on a page we left.'));
});

test('a fresh demo does not label the implicit Claude preference as applied', () => {
  state.compiler = compilerConfiguration({ setupRequired: false, activeSource: 'local' });
  const applied = /<h4>Apply the compiler<\/h4><span[^>]*>Applied<\/span>/;
  assert.doesNotMatch(compilerSettings(), applied);
  state.compiler.activeSource = 'settings';
  assert.match(compilerSettings(), applied);
  state.compiler.overriddenByEnv = true;
  assert.doesNotMatch(compilerSettings(), applied);
});

test('an invalid compiler environment shows its escaped configuration error without claiming an active model', () => {
  state.compiler = compilerConfiguration({ overriddenByEnv: true, setupRequired: false, inForce: null, configurationError: 'Fix the compiler environment. <script>bad</script>' });
  const form = compilerSettings();
  assert.match(form, /Compiler configuration needs attention/);
  assert.match(form, /Fix the compiler environment\. &lt;script&gt;/);
  assert.ok(!form.includes('<script>'));
  const previous = state.models;
  state.models = { state: 'ready', drafting: { model: 'Old compiler', where: 'Old active connection' } };
  try {
    const html = VIEWS.models.body();
    assert.match(html, /data-active-model="compiler">Compiler unavailable<\/b>/);
    assert.ok(!html.includes('Old active connection') && !html.includes('<script>'));
    assert.match(html, /Fix the compiler environment\. &lt;script&gt;/);
  } finally { state.models = previous; }
});

test('document waiting feedback explains longer policy checks without claiming a reading result', () => {
  const html = documentReviewPendingMarkup([{ name: 'scan.png' }], true);
  assert.match(html, /role="status"/);
  assert.match(html, /Files are read first, then checked against the rules/);
  assert.match(html, /few minutes/);
  assert.ok(!html.includes('The files were read') && !html.includes('Could not read'));
  assert.equal(documentReviewPendingMarkup([], true), '');
  assert.equal(documentReviewPendingMarkup([{ name: 'scan.png' }], false), '');
});

test('document analysis timeouts preserve successful OCR status and stay separate from extraction failures', () => {
  const read = { name: 'scan.png', status: 'read', method: 'ocr', chars: 220, bytes: 1024 };
  const timeout = { pass: 'adjudicate:rule-1', failedClosed: true, detail: { error: 'Document analysis timed out before all content and rules were checked. The document was not cleared.' } };
  const decision = { documents: [read], passes: [timeout] };
  const notice = documentAnalysisNotice(decision);
  assert.match(notice, /Policy analysis ran out of time/);
  assert.match(notice, /The files were read/);
  assert.match(notice, /request was not cleared/);
  const metadata = documentMetadataMarkup(decision.documents);
  assert.match(metadata, />Read<\/span>/);
  assert.match(metadata, /Offline OCR/);
  assert.ok(!metadata.includes('Could not read'));
  const unread = { ...read, status: 'unreadable', reason: 'document-reader-timeout' };
  assert.ok(!documentAnalysisNotice({ documents: [read, unread], passes: [timeout] }).includes('The files were read'));
  assert.equal(documentAnalysisNotice({ documents: [unread], passes: [{ ...timeout, pass: 'documents', detail: { error: 'document-reader-timeout' } }] }), '');
  assert.match(documentMetadataMarkup([unread]), /document reader ran out of time/);
  assert.match(documentAnalysisNotice({ documents: [read], passes: [{ ...timeout, detail: { error: 'Document analysis was cancelled before all content and rules were checked. The document was not cleared.' } }] }), /Policy analysis was cancelled/);
});

test('saving session ceilings resends the role’s daily limit, because the quota route drops what it is not sent', async () => {
  const { saveQuota } = await import('../web/js/limits.js');
  state.policy = { ...state.policy, rules: state.policy?.rules ?? [], quotas: [{ role: 'intern', maxRequestsPerDay: 40, maxSessionOutputTokens: 150000 }] };
  const sent = [];
  globalThis.fetch = async (path, init) => {
    if (init?.method === 'PUT') { sent.push({ path, body: JSON.parse(init.body) }); return new Response('{}'); }
    return new Response(JSON.stringify(state.policy));
  };
  assert.deepEqual(await saveQuota('intern', { maxPromptChars: 9000 }), { ok: true });
  assert.equal(sent[0].path, '/api/quotas/intern');
  assert.deepEqual(sent[0].body, { maxRequestsPerDay: 40, maxSessionOutputTokens: 150000, maxContextTokens: null, maxPromptChars: 9000 });
  assert.equal((await saveQuota('intern', { maxPromptChars: NaN })).ok, false);
  assert.equal(sent.length, 1);
});

test('a policy read that fails keeps the rules already shown and says the read failed', async () => {
  const { refreshPolicy } = await import('../web/js/data.js');
  state.policy = { ...state.policy, rules: [{ id: 'r-kept' }] };
  globalThis.fetch = async () => new Response('{"error":"gateway restarting"}', { status: 503 });
  await refreshPolicy();
  assert.deepEqual(state.policy.rules.map((r) => r.id), ['r-kept']);
  assert.deepEqual(state.loads.policy, { loading: false, error: 'gateway restarting' });
});

test('an exempt person is described as exempt from company-wide rules, never from every rule', async () => {
  const { sendAsOptions } = await import('../web/js/rules.js');
  const saved = { company: state.company, policy: state.policy };
  state.company = { ...state.company, employees: [{ id: 'e1', name: 'Ana', role: 'admin' }, { id: 'e2', name: 'Tomás', role: 'intern' }] };
  state.policy = { ...state.policy, exemptRoles: ['admin'] };
  try {
    const html = sendAsOptions('e1');
    assert.match(html, /Tomás · intern<\/option>.*Ana · admin · exempt from company-wide rules/s);
    assert.ok(!/every rule|all rules/i.test(html));
  } finally { Object.assign(state, saved); }
});

/*
 * A paused request carries ALLOW and was never looked at. The console has one
 * job here and it is not cosmetic: an administrator reading their own log must
 * not be told the policy was applied and found nothing, on a request no pass
 * ever touched. `notJudged` exists so the two can be told apart years later;
 * these are the places that promise is kept or broken.
 */
test('a request that arrived while Warden was paused never reads as allowed', async () => {
  const { outcome, outcomeText } = await import('../web/js/ui.js');

  assert.deepEqual(outcome({ verdict: 'ALLOW' }), { word: 'Allowed', tone: 'allow', judged: true });
  const paused = outcome({ verdict: 'ALLOW', notJudged: 'paused' });
  assert.equal(paused.judged, false);
  assert.match(paused.word, /Not judged/);
  assert.ok(!/allowed/i.test(paused.word), 'the word "allowed" must not appear on a request nobody judged');
  // Muted, never the green a cleared request gets. Nothing about it is a pass.
  assert.equal(paused.tone, 'muted');
  assert.ok(!/--allow/.test(outcomeText({ verdict: 'ALLOW', notJudged: 'paused' })));
});

test('the Allowed count and filter mean requests the policy cleared, not requests nobody read', async () => {
  const { visibleAudit, activityToolbarCounts } = await import('../web/js/activity.js');
  const saved = { audit: state.audit, filter: state.filter, actorFilter: state.actorFilter, query: state.query };
  state.audit = [
    { auditId: 'a', ts: '2026-09-16T10:00:00.000Z', actor: { id: 'ana' }, decision: { verdict: 'ALLOW' } },
    { auditId: 'b', ts: '2026-09-16T10:01:00.000Z', actor: { id: 'ana' }, decision: { verdict: 'ALLOW', notJudged: 'paused' } },
    { auditId: 'c', ts: '2026-09-16T10:02:00.000Z', actor: { id: 'ana' }, decision: { verdict: 'BLOCK' } }
  ];
  state.actorFilter = '';
  state.query = {};
  try {
    state.filter = 'ALLOW';
    assert.deepEqual(visibleAudit().map((a) => a.auditId), ['a'], 'the paused one is not behind the Allowed filter');
    state.filter = 'paused';
    assert.deepEqual(visibleAudit().map((a) => a.auditId), ['b'], 'it has a bucket of its own');
    state.filter = 'all';
    assert.deepEqual(visibleAudit().map((a) => a.auditId), ['a', 'b', 'c'], 'and "All" still means all of them');
    assert.deepEqual(activityToolbarCounts(), { ALLOW: 1, BLOCK: 1, ESCALATE: 0, unjudged: 1 });
  } finally { Object.assign(state, saved); }
});
