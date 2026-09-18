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
    assert.match(html, /Set up rule drafting/);
    assert.match(html, /Set up the rule writer/);
    assert.match(html, /data-go="models" data-q="setup=compiler"/);
    assert.doesNotMatch(html, /keep exploring/);
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

/*
 * A name is the one field every list here sorts and searches by, and until now
 * it was the only one an administrator could not fix from the console: a role
 * changed in place from the row, a person could be removed, but a name needed
 * the directory file edited by hand. The row menu and the person page must
 * offer it, and it must not be filed with the destructive action.
 */
test('a person can be renamed from the console, and renaming is not destructive', async () => {
  await import('../web/js/team.js');
  const saved = { ...state };
  try {
    Object.assign(state, {
      view: 'people', sel: '',
      company: { name: 'Acme', roles: ['admin', 'engineer'], employees: [{ id: 'operator', name: 'Gastón', role: 'admin' }], demo: false },
      policy: { rules: [], quotas: [], exemptRoles: ['admin'] },
      loads: { ...state.loads, policy: { loading: false } },
      devices: {}, open: new Set(), query: {}
    });
    for (const [label, sel] of [['the row menu', ''], ['the person page', 'operator']]) {
      state.sel = sel;
      const html = VIEWS.people.body();
      assert.match(html, /data-act="rename"/, `${label} offers it`);
      const rename = html.indexOf('data-act="rename"');
      const remove = html.indexOf('data-act="remove"');
      assert.ok(rename < remove, `${label} keeps the destructive action last`);
      assert.ok(!/--destructive[^>]*data-act="rename"/.test(html), `${label} does not mark it destructive`);
    }
  } finally { Object.assign(state, saved); }
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

/**
 * Gateway. Four behaviours the frames settled and the screen has to keep:
 * the headline is about judging and not about being alive, a gap takes the
 * fold away with it, the hook contract is stated in words, and the public
 * address is no longer on the page about somebody's laptop.
 */
const gatewayState = () => ({
  health: { ok: true, mock: false, mode: 'warden', deadlines: { decisionMs: 90000 }, failClosed: false, installation: { label: 'warden', version: '0.2.5' } },
  mock: false, publicUrl: null, canLeaveDemo: true, chain: { ok: true, entries: 214 },
  prompts: { days: 7, held: 214, max: 5000 }, adjudicator: null, view: 'gateway', sel: null
});

test('Gateway leads with whether it is judging, not with whether it is running', async () => {
  await import('../web/js/gateway.js');
  const saved = { ...state };
  try {
    Object.assign(state, gatewayState());
    const healthy = VIEWS.gateway.body();
    assert.match(healthy, /Policy checks on/);
    // If the page renders at all the gateway is up: saying so is furniture.
    assert.ok(!/Running and enforcing|>Running</.test(healthy), 'the headline must not claim liveness the page already proves');
    assert.match(healthy, /aria-expanded="false"[^>]*>/, 'all clear folds away');
    // The fold used to be a <details> with its <summary> nested inside the
    // headline row. Only a <summary> that is the first child of its <details>
    // is the control, so the browser hid the row it was in — the claim and the
    // button with it — and drew its own "Details" triangle instead. Both have
    // to survive the block being closed, which is the state this asserts.
    assert.match(healthy, /conditions-claim[\s\S]*Policy checks on/, 'the claim is visible while it is closed');
    assert.ok(!/<details[^>]*conditions/.test(healthy), 'and it is not a <details>, which is what hid it');

    Object.assign(state, gatewayState(), { mock: true, health: { ...gatewayState().health, mock: true } });
    const blind = VIEWS.gateway.body();
    assert.match(blind, /Policy checks off/);
    assert.match(blind, /stand-in/, 'and it has to say that nothing is reading the prompts');
    // The gap is outside the fold, so no control can put it away — which is
    // the promise. What the control now hides in this state is the evidence
    // that everything else is in order, and hiding good news is what it is for.
    const gapRows = blind.slice(blind.indexOf('conditions-gaps'), blind.indexOf('conditions-body'));
    assert.match(gapRows, /stand-in/, 'the gap is in the rows that do not fold');
    assert.ok(!/conditions-gaps[\s\S]*?Decision deadline[\s\S]*?conditions-body/.test(blind),
      'and a satisfied condition is not, so the block is the size of the problem');
  } finally { Object.assign(state, saved); }
});

test('Gateway states the deadline and what happens when it passes', async () => {
  await import('../web/js/gateway.js');
  const saved = { ...state };
  try {
    Object.assign(state, gatewayState());
    const open = VIEWS.gateway.body();
    assert.match(open, /90 s/, 'the deadline comes from /health, never from a constant here');
    assert.match(open, /goes through unchecked/, 'fail-open is said in words, not implied');

    Object.assign(state, gatewayState(), { health: { ...gatewayState().health, failClosed: true, deadlines: { decisionMs: 45000 } } });
    const closed = VIEWS.gateway.body();
    assert.match(closed, /45 s/);
    assert.match(closed, /refused/);
    assert.ok(!/goes through unchecked/.test(closed), 'a fail-closed gateway must not be described as letting prompts through');
  } finally { Object.assign(state, saved); }
});

test('Gateway names baseline mode as the guard being off', async () => {
  await import('../web/js/gateway.js');
  const saved = { ...state };
  try {
    Object.assign(state, gatewayState(), { health: { ...gatewayState().health, mode: 'baseline' } });
    const body = VIEWS.gateway.body();
    assert.match(body, /Policy checks off/);
    assert.match(body, /the guard is off/);
    assert.match(body, /exactly like one that is working/, 'the whole point is that it is indistinguishable from a healthy one');
  } finally { Object.assign(state, saved); }
});

test('the public address left This device, because it is a fact about the server', async () => {
  await import('../web/js/solo.js');
  const saved = { ...state };
  try {
    Object.assign(state, deviceState(), { sel: 'tools' });
    const device = VIEWS.soloRules.body();
    assert.ok(!/Public address|public-url|startExpose/.test(device), 'This device must not carry the tunnel any more');
    assert.ok(!/Data on this machine/.test(device), 'nor what the gateway keeps on disk');
    // And the word the product settled on, which is "device" and not "machine".
    assert.ok(!/this machine/i.test(device), 'the copy says device, never machine');
  } finally { Object.assign(state, saved); }
});

/**
 * This device. The rewrite exists to kill one line — protection defined as
 * traffic seen — so the tests are about the states that line got wrong.
 */
const deviceState = (patch = {}) => ({
  ...gatewayState(),
  view: 'soloRules',
  sel: null,
  open: new Set(),
  soloIdentity: {
    id: 'you', name: 'You', role: 'solo', apiKey: 'wk-you-abcdef0123456789',
    connected: [], devices: [{ name: 'mbp', reportedAt: '2026-09-16T10:00:00.000Z', tools: [{ id: 'claude-code', wired: true }] }]
  },
  soloRules: [{ id: 'solo-1', text: 'Never paste a key', severity: 'block', applies: true }],
  soloPresets: [], soloLoadError: '', soloToggling: null, soloBusy: false, soloRuleNote: '',
  soloProtecting: false, soloProtectError: '', soloPausing: false, soloPauseError: '',
  policy: { rules: [], quotas: [], exemptRoles: ['admin'] },
  compiler: null,
  ...patch
});

test('a wired device with no traffic yet is protected, not "not protected yet"', async () => {
  await import('../web/js/solo.js');
  const saved = { ...state };
  try {
    // Wired, judge present, a rule addressed at them, and nothing sent yet.
    Object.assign(state, deviceState());
    const body = VIEWS.soloRules.body();
    assert.match(body, /Protection on/, 'setup done is setup done, with or without a prompt having been sent');
    assert.ok(!/Not protected yet/.test(body), 'the sentence that broke the first install must not come back');
    assert.match(body, /nothing judged through them yet/, 'and the absence of traffic is still reported, just not as a fault');
    assert.match(body, /aria-expanded="false"/, 'all clear folds away');
    assert.match(body, /Show details/, 'behind a control that says what it does');
    // Closed is the state that used to lose the headline and the action: see
    // the Gateway test above for what the nested <summary> did.
    assert.match(body, /conditions-claim[\s\S]*Protection on/, 'with the claim still on the screen');
    assert.match(body, /Pause protection/, 'and the action still pressable');
  } finally { Object.assign(state, saved); }
});

test('nothing wired is the gap, and the headline carries its fix', async () => {
  await import('../web/js/solo.js');
  const saved = { ...state };
  try {
    Object.assign(state, deviceState({
      soloIdentity: { id: 'you', name: 'You', role: 'solo', connected: [], devices: [{ name: 'mbp', tools: [{ id: 'claude-code', wired: false }] }] }
    }));
    const body = VIEWS.soloRules.body();
    assert.match(body, /Setup incomplete/);
    assert.match(body, /No tools connected/);
    assert.match(body, /Protect this device/);

    /*
     * The block is the size of the problem.
     *
     * Only the unmet conditions stand outside the fold; the satisfied ones are
     * behind it in the order they are named. It used to print all five rows
     * whenever any one of them was a gap, so a device that only needed a rule
     * written stood 230px tall and pushed its own tab strip halfway down the
     * page. Counting the rows either side of the fold is the cheapest way to
     * say "shows the gaps, not the conditions" in a test.
     */
    const shown = body.slice(body.indexOf('conditions-gaps'), body.indexOf('conditions-body'));
    assert.equal((shown.match(/<dt>/g) ?? []).length, 1, 'one condition is unmet, so one row stands outside the fold');
    assert.match(shown, /No tools connected/, 'and it is that one');
    const folded = body.slice(body.indexOf('conditions-body'));
    for (const good of ['Warden', 'You', 'The judge', 'Rules for you']) {
      assert.match(folded, new RegExp(`>${good}</dt>`), `${good} is satisfied here, and satisfied conditions fold`);
    }
    assert.match(body, /data-fold/, 'so the control exists here too — what it hides is the good news');
  } finally { Object.assign(state, saved); }
});

test('the two invisible conditions are on the screen: the mock judge and an exempt role nothing binds', async () => {
  await import('../web/js/solo.js');
  const saved = { ...state };
  try {
    Object.assign(state, deviceState({ mock: true }));
    const blind = VIEWS.soloRules.body();
    assert.match(blind, /Demo mode/, 'a stand-in answering is not a judgement and has to say so');
    assert.match(blind, /Get a judge/);

    Object.assign(state, deviceState({
      soloIdentity: { id: 'you', name: 'You', role: 'admin', connected: [], devices: [{ name: 'mbp', tools: [{ id: 'claude-code', wired: true }] }] },
      soloRules: [{ id: 'r1', text: 'Company rule', severity: 'block', applies: false }]
    }));
    const exempt = VIEWS.soloRules.body();
    assert.match(exempt, /No applicable rules · exempt from/, 'wiring alone protects nobody whom no rule binds');
    assert.match(exempt, /Write a rule for yourself/);
  } finally { Object.assign(state, saved); }
});

test('turning Warden off is a recorded pause, not a way to stop the gateway', async () => {
  await import('../web/js/solo.js');
  const saved = { ...state };
  try {
    Object.assign(state, deviceState());
    assert.match(VIEWS.soloRules.body(), /Pause protection/);

    Object.assign(state, deviceState({
      soloIdentity: { ...deviceState().soloIdentity, paused: { until: null, by: 'you', at: '2026-09-16T10:00:00.000Z' } }
    }));
    const off = VIEWS.soloRules.body();
    // Paused says itself once: the word in the claim, how long in the detail.
    assert.match(off, /<b>Paused<\/b>/);
    assert.match(off, /until you turn it back on/);
    assert.match(off, /still recorded, marked not judged/, 'a pause is a gap in judging, never a gap in the record');
    assert.match(off, /Resume/);
    assert.ok(!/conditions-claim[^"]*--attention/.test(off), 'a pause the person chose is not a fault and does not go amber');
  } finally { Object.assign(state, saved); }
});

/**
 * Team. The list used to answer one question — has traffic been seen — and
 * called the answer "connected", so three different situations wore the same
 * sentence and a gateway restart said it about everybody.
 */
const teamState = (employees) => ({
  view: 'people', sel: null, query: {}, open: new Set(),
  company: { name: 'Acme', roles: ['employee', 'admin'], employees },
  policy: { rules: [], quotas: [], exemptRoles: ['admin'] },
  loads: { people: { loading: false, error: '' } },
  audit: []
});
const person = (patch) => ({ id: 'ana', name: 'Ana López', role: 'employee', connected: [], devices: [], ...patch });

test('Team tells "never installed" from "took the hook out" from "wired and quiet"', async () => {
  await import('../web/js/team.js');
  const saved = { ...state };
  try {
    Object.assign(state, teamState([
      person({ id: 'never', name: 'Never Set', devices: [] }),
      person({ id: 'quiet', name: 'Quiet One', devices: [{ machineId: 'm1', name: 'quiet-mbp', lastSeen: '2026-09-16T09:00:00.000Z', hookVersion: '0.2.5', tools: [{ id: 'claude-code', wired: true }] }] }),
      person({ id: 'gone', name: 'Gone Away', devices: [{ machineId: 'm2', name: 'gone-mbp', lastSeen: '2026-09-13T09:00:00.000Z', tools: [{ id: 'claude-code', wired: false }] }] })
    ]));
    const list = VIEWS.people.body();
    assert.match(list, /Never reported/, 'nobody has ever checked in for this one');
    assert.match(list, /Unwired on gone-mbp/, 'and this one broke the seal, which is not the same thing');
    assert.match(list, /Claude Code/, 'the wired one names what it wired');
    assert.ok(!/Not connected yet/.test(list), 'the sentence that covered all three is gone');
    // Two problems with two answers, counted apart.
    assert.match(list, /1 unwired/);
    assert.match(list, /1 never set up/);
  } finally { Object.assign(state, saved); }
});

test('a rotated key is visible to the administrator who rotated it', async () => {
  await import('../web/js/team.js');
  const saved = { ...state };
  try {
    Object.assign(state, teamState([
      person({ devices: [{ machineId: 'm1', name: 'ana-mbp', lastSeen: '2026-09-16T09:00:00.000Z', pendingSince: '2026-09-16T08:00:00.000Z', tools: [{ id: 'claude-code', wired: true }] }] })
    ]), { sel: 'ana' });
    const page = VIEWS.people.body();
    assert.match(page, /key was rotated and no device has used the new one yet/);
    assert.match(page, /there is no grace period/, 'the reason the employee is being refused right now');
  } finally { Object.assign(state, saved); }
});

test('Team says an unwired hook is seen and cannot be put back', async () => {
  await import('../web/js/team.js');
  const saved = { ...state };
  try {
    Object.assign(state, teamState([
      person({ devices: [{ machineId: 'm1', name: 'ana-mbp', lastSeen: '2026-09-13T09:00:00.000Z', tools: [{ id: 'claude-code', wired: false }] }] })
    ]), { sel: 'ana' });
    const page = VIEWS.people.body();
    assert.match(page, /it cannot put it back/, 'Warden detects; it does not enforce, and the copy may not pretend otherwise');
    assert.ok(!/Force|Reinstall/i.test(page), 'no control may imply a power the product does not have');
  } finally { Object.assign(state, saved); }
});

test('while anybody is paused, the list says so and stops reporting a last-seen that means nothing', async () => {
  await import('../web/js/team.js');
  const saved = { ...state };
  try {
    Object.assign(state, teamState([
      person({ paused: { until: null, by: 'marce', reason: 'debugging her own rule', at: '2026-09-16T08:00:00.000Z' },
        devices: [{ machineId: 'm1', name: 'ana-mbp', lastSeen: '2026-09-16T09:00:00.000Z', tools: [{ id: 'claude-code', wired: true }] }] })
    ]));
    const list = VIEWS.people.body();
    assert.match(list, /is paused/, 'a gateway judging nobody must not look like one that is');
    assert.match(list, /still recorded, marked not judged/);
    assert.match(list, /by marce/, 'a pause nobody can attribute is a hole in the record');
    assert.match(list, /Paused<\/span>/, 'and the last-heard column says the thing that is true instead');
  } finally { Object.assign(state, saved); }
});

// ═══ THE FIRST RUN ═══════════════════════════════════════════════════════════
//
// The five outcomes of the last step have to stay five distinct sentences, and
// none of the four that are not "verified" may finish the flow. The screen is
// the last place these can go wrong quietly: the server refuses to write a
// verification that has not been earned, but nothing stops a screen from
// *saying* one has been.

const firstRun = await import('../web/js/first-run.js');

/** A world the flow can read: what is on the machine, what is wired, what is on. */
function world({ found = ['claude', 'codex'], wired = [], rules = [], verified = [], reported = null } = {}) {
  Object.assign(state, {
    compiler: { cliTools: found.map((tool) => ({ tool, label: tool, found: true })) },
    soloRules: rules.map((text, i) => ({ id: `r${i}`, text, severity: 'block' })),
    soloPresets: [{ id: 'solo-security-1', text: 'Credentials, API keys, access tokens and passwords must never be requested or shared.' }],
    soloIdentity: {
      id: 'you',
      verified: verified.map((tool) => ({ tool, auditId: 'a1', verdict: 'BLOCK', ruleIds: ['r0'], at: new Date().toISOString() })),
      connected: [],
      devices: [{
        machineId: 'm1',
        tools: reported ?? wired.map((id) => ({ id, wired: true })),
        reportedAt: new Date().toISOString()
      }]
    },
    firstRun: { tool: null, rule: 'preset', step: null, busy: false, error: '', seen: false, allowed: false, late: false }
  });
}

test('the step is read off the machine, never off a saved cursor', () => {
  world();
  assert.equal(firstRun.stepOf(), 1, 'nothing wired: connect a tool');
  world({ wired: ['claude-code'] });
  assert.equal(firstRun.stepOf(), 2, 'wired but no rule: turn one on');
  world({ wired: ['claude-code'], rules: ['no credentials'] });
  assert.equal(firstRun.stepOf(), 3, 'wired and a rule on: verify');
});

test('an installation that is already set up arrives at the last step, not the first', () => {
  // The upgrade case: somebody who has been using Warden for months has wiring
  // and rules already, and must not be walked through creating them again.
  world({ wired: ['claude-code'], rules: ['no credentials'] });
  assert.equal(firstRun.stepOf(), 3);
});

test('the five outcomes of the last step are five different things', () => {
  const seen = new Set();
  world({ wired: ['claude-code'], rules: ['x'] });
  seen.add(firstRun.outcomeOf());                                   // waiting

  world({ wired: ['claude-code'], rules: ['x'], verified: ['claude-code'] });
  seen.add(firstRun.outcomeOf());                                   // verified

  world({ wired: ['claude-code'], rules: ['x'] });
  state.firstRun.tool = 'claude-code'; state.firstRun.seen = true; state.firstRun.allowed = true;
  seen.add(firstRun.outcomeOf());                                   // allowed

  world({ wired: ['claude-code'], rules: ['x'] });
  state.firstRun.tool = 'claude-code'; state.firstRun.seen = true; state.firstRun.late = true;
  seen.add(firstRun.outcomeOf());                                   // no-decision

  world({ rules: ['x'], reported: [{ id: 'claude-code', wired: false }] });
  state.firstRun.tool = 'claude-code';
  seen.add(firstRun.outcomeOf());                                   // disconnected

  assert.equal(seen.size, 5, [...seen].join(', '));
});

test('an allowed request does not finish the flow: it proves the path, not the rule', () => {
  world({ wired: ['claude-code'], rules: ['x'] });
  state.firstRun.tool = 'claude-code';
  state.firstRun.seen = true;
  state.firstRun.allowed = true;
  assert.equal(firstRun.outcomeOf(), 'allowed');
  assert.notEqual(firstRun.outcomeOf(), 'verified');
});

test('a hook that timed out does not finish the flow either', () => {
  world({ wired: ['claude-code'], rules: ['x'] });
  state.firstRun.tool = 'claude-code';
  state.firstRun.seen = true;
  state.firstRun.late = true;
  assert.equal(firstRun.outcomeOf(), 'no-decision');
});

test('the last step ignores a decision from a tool that was not the one chosen', () => {
  world({ wired: ['claude-code', 'codex'], rules: ['x'] });
  state.firstRun.tool = 'claude-code';
  // Codex verified, Claude Code not. The screen is about Claude Code.
  state.soloIdentity.verified = [{ tool: 'codex', auditId: 'a', verdict: 'BLOCK', ruleIds: ['r0'], at: '2026-01-01' }];
  assert.equal(firstRun.outcomeOf(), 'waiting', 'somebody else\'s traffic is not this tool\'s proof');
});

test('nobody having reported is not the same as reporting "not wired"', () => {
  // `wired === null` is silence. Only a machine that looked and said no gets
  // the connection-failed screen; the other case keeps waiting.
  world({ rules: ['x'], reported: [{ id: 'claude-code', wired: null }] });
  state.firstRun.tool = 'claude-code';
  assert.equal(firstRun.outcomeOf(), 'waiting');
  world({ rules: ['x'], reported: [{ id: 'claude-code', wired: false }] });
  state.firstRun.tool = 'claude-code';
  assert.equal(firstRun.outcomeOf(), 'disconnected');
});

test('the credential preset is taken by its text, not by an id that is really a position', () => {
  // `solo-security-1` is built as solo-<category>-<position>, so reordering the
  // seed file points it somewhere else. Activating "whatever is first in
  // security" would be silent and wrong.
  world();
  assert.ok(firstRun.credentialPreset(), 'the real credential preset is offered');
  state.soloPresets = [{ id: 'solo-security-1', text: 'Production access must not be granted or escalated.' }];
  assert.equal(firstRun.credentialPreset(), null, 'a different rule under that id is refused');
});

test('a tool with no prompt hook is never offered as something to connect', () => {
  world({ found: ['claude', 'cursor-agent'] });
  assert.ok(!firstRun.connectable().some((t) => t.id === 'cursor'), 'the first screen has no dead ends');
});

test('no control in the first run says Force, Reinstall or Guarantee', () => {
  world({ wired: ['claude-code'], rules: ['x'] });
  const html = VIEWS.firstRun.body();
  for (const word of ['Force', 'Reinstall', 'Guarantee']) {
    assert.ok(!html.includes(word), `${word} is a promise no screen here can keep`);
  }
});

// ── Tools: three facts per tool, and the row that has no button ──────────────

test('the five tool states produce five different lines', async () => {
  await import('../web/js/solo.js');
  const saved = { ...state };
  const at = new Date().toISOString();
  // Four tools and five states, so the file shows them across two frames and
  // so does this: the wired-but-unused row is the variant.
  const tools = (cli, devices, verified = []) => deviceState({
    sel: 'tools',
    compiler: { cliTools: cli },
    soloIdentity: { id: 'you', name: 'You', role: 'solo', connected: [], verified, devices }
  });
  try {
    Object.assign(state, tools(
      [
        { tool: 'claude', label: 'Claude Code', found: true },
        { tool: 'codex', label: 'Codex', found: false },
        { tool: 'opencode', label: 'OpenCode', found: true },
        { tool: 'cursor-agent', label: 'Cursor', found: true }
      ],
      [{ name: 'mbp', reportedAt: at, tools: [{ id: 'claude-code', wired: true }, { id: 'opencode', wired: false }] }],
      [{ tool: 'claude-code', auditId: 'a', verdict: 'BLOCK', ruleIds: ['r'], at }]
    ));
    let body = VIEWS.soloRules.body();
    assert.match(body, /Judging requests · verified/, 'verified: a real request was decided by the rule');
    assert.match(body, /Not connected · no request judged/, 'reported as unwired');
    // "Not connected" is the same sentence in two states — reported missing
    // from the tool's settings, and never reported at all — so the second fact
    // is what tells them apart and is the one kind of second fact a row keeps.
    assert.match(body, /Found · not in its settings/, 'and the row says the machine reported it missing');
    assert.match(body, /Not found on this device/, 'not installed');
    assert.match(body, /Not judged, and never will be from this device/, 'no prompt hook exists for it');

    // The variant: wired, and nothing has come through it yet. This is the
    // state the whole tab exists for — neither protected nor broken.
    Object.assign(state, tools(
      [{ tool: 'claude', label: 'Claude Code', found: true }],
      [{ name: 'mbp', reportedAt: at, tools: [{ id: 'claude-code', wired: true }] }]
    ));
    body = VIEWS.soloRules.body();
    assert.match(body, /Configured · waiting for a real request/);
    assert.ok(!/Judging requests/.test(body), 'wired is not judged, and the tab must not round it up');
  } finally { Object.assign(state, saved); }
});

test('the tool that cannot be wired is offered no button at all', async () => {
  await import('../web/js/solo.js');
  const saved = { ...state };
  try {
    Object.assign(state, deviceState({
      sel: 'tools',
      compiler: { cliTools: [{ tool: 'cursor-agent', label: 'Cursor', found: true }] },
      soloIdentity: { id: 'you', name: 'You', role: 'solo', connected: [], verified: [], devices: [] }
    }));
    const body = VIEWS.soloRules.body();
    // Offering Connect on something structurally unwirable is a button that
    // cannot work, and one of those teaches that none of them do.
    assert.ok(!/data-connect/.test(body), 'no Connect');
    assert.ok(!/data-unwire/.test(body), 'no Unwire');
  } finally { Object.assign(state, saved); }
});

test('a tool nobody has reported on is not called unwired', async () => {
  await import('../web/js/solo.js');
  const saved = { ...state };
  try {
    // `wired === null` is silence, and silence is somebody's afternoon spent
    // fixing what was never broken.
    Object.assign(state, deviceState({
      sel: 'tools',
      compiler: { cliTools: [{ tool: 'claude', label: 'Claude Code', found: true }] },
      soloIdentity: { id: 'you', name: 'You', role: 'solo', connected: [], verified: [], devices: [] }
    }));
    const body = VIEWS.soloRules.body();
    assert.ok(!/not in its settings/.test(body), 'nobody looked, so nobody may say it is missing');
    assert.match(body, /Found · wiring not reported/);
  } finally { Object.assign(state, saved); }
});

test('Models omits job descriptions but keeps local state and compiler disclosure', () => {
  const saved = { ...state };
  try {
    Object.assign(state, deviceState(), {
      view: 'models', sel: null,
      models: { state: 'ready', models: [], judging: { model: 'dynaguard' } },
      compiler: compilerConfiguration({ setupRequired: false }),
      adjudicator: { choices: [] }, company: { roles: [], employees: [] }
    });
    const html = VIEWS.models.body();
    assert.doesNotMatch(html, /section-lede|Writes rules from|Judges every request|PDFs, Word files/);
    assert.match(html, /Rule writer/);
    assert.match(html, /Request judge/);
    assert.match(html, /local only/);
    state.compiler = compilerConfiguration();
    assert.doesNotMatch(VIEWS.models.body(), /Turns the policies|Checks every employee/);
    assert.match(compilerSettings(), /account and plan/);
  } finally { Object.assign(state, saved); }
});

test('Prompts explains when changes apply at the editor, not above the list', () => {
  const saved = { ...state };
  try {
    Object.assign(state, { view: 'models', sel: 'prompts' });
    acceptPromptCatalog({ revision: 'one', templates: [promptTemplate('compile-system', 'compiler')] });
    assert.doesNotMatch(VIEWS.models.body(), /section-lede|Full templates each job/);
    togglePromptEditor('compiler');
    const html = promptEditorMarkup('compiler');
    assert.doesNotMatch(html, /Edit the actual templates/);
    assert.match(html, /Changes apply to new requests/);
    assert.match(html, /Keep required variables exactly as written/);
    assert.match(html, /Save before closing or reloading/);
  } finally { Object.assign(state, saved); }
});

test('device and company sections omit introductions without losing state or consequences', async () => {
  await import('../web/js/team.js');
  const saved = { ...state };
  try {
    Object.assign(state, deviceState());
    for (const sel of ['tools', 'identity']) {
      state.sel = sel;
      assert.doesNotMatch(VIEWS.soloRules.body(), /section-lede|Nothing you type|A tool is configured/);
    }
    assert.match(VIEWS.soloRules.body(), /Copy key/);
    assert.doesNotMatch(VIEWS.soloSettings.body(), /section-lede/);
    Object.assign(state, {
      view: 'people', sel: 'company', company: { name: 'Acme', roles: [], employees: [], demo: false }
    });
    const company = VIEWS.people.body();
    assert.doesNotMatch(company, /Everyone in Team belongs/);
    assert.match(company, /Company name/);
    assert.match(company, /There is no undo/);
  } finally { Object.assign(state, saved); }
});

test('new rules lose the writing advice but keep the named audience', async () => {
  await import('../web/js/rules.js');
  const saved = { ...state };
  try {
    Object.assign(state, deviceState(), {
      view: 'policy', sel: 'new', set: null, ruleChat: [], draftFor: 'ana',
      company: { roles: ['employee'], employees: [{ id: 'ana', name: 'Ana <Admin>', role: 'employee' }] }
    });
    const html = VIEWS.policy.body();
    assert.doesNotMatch(html, /Write it like you would|One worry at a time/);
    assert.match(html, /Every rule here applies to Ana &lt;Admin&gt;/);
  } finally { Object.assign(state, saved); }
});

test('loading lists do not repeat the loading title in a second line', async () => {
  await import('../web/js/activity.js');
  await import('../web/js/inbox.js');
  await import('../web/js/rules.js');
  const saved = { ...state };
  try {
    Object.assign(state, deviceState(), { loads: {}, audit: [], escalations: [], appeals: [] });
    for (const view of ['activity', 'inbox', 'policy']) {
      Object.assign(state, { view, sel: null });
      const html = VIEWS[view].body();
      assert.match(html, /Loading/);
      assert.doesNotMatch(html, /Fetching the|feedback-body/);
    }
  } finally { Object.assign(state, saved); }
});

test('first-run titles need no subtitle when cards carry the instructions and outcome', () => {
  const saved = { ...state };
  try {
    world();
    assert.doesNotMatch(VIEWS.firstRun.body(), /first-run-lede/);
    world({ wired: ['claude-code'] });
    assert.doesNotMatch(VIEWS.firstRun.body(), /first-run-lede/);
    world({ wired: ['claude-code'], rules: ['no credentials'] });
    const waiting = VIEWS.firstRun.body();
    assert.doesNotMatch(waiting, /first-run-lede/);
    assert.match(waiting, /Do not enter any real secret/);
    assert.match(waiting, /checks the rule, but not the connection/);
    state.firstRun.tool = 'claude-code';
    state.firstRun.seen = true;
    state.firstRun.allowed = true;
    const allowed = VIEWS.firstRun.body();
    assert.match(allowed, /Rule not verified/);
    assert.doesNotMatch(allowed, /firstRunDone|first-run-lede/);
  } finally { Object.assign(state, saved); }
});

test('Inbox uses explicit recording actions and puts the consequence in the recorded result', async () => {
  await import('../web/js/inbox.js');
  const saved = { ...state };
  try {
    const at = new Date().toISOString();
    Object.assign(state, deviceState(), {
      view: 'inbox', sel: 'subtitle-review', audit: [], appeals: [],
      escalations: [{ auditId: 'subtitle-review', employeeId: 'ana', employeeName: 'Ana', at }],
      company: { roles: ['employee'], employees: [{ id: 'ana', name: 'Ana', role: 'employee' }] }
    });
    const html = VIEWS.inbox.body();
    assert.doesNotMatch(html, /Recording an answer does not resume this request/);
    state.escalations[0].review = { outcome: 'approved', at };
    const recorded = VIEWS.inbox.body();
    assert.match(recorded, /Approval recorded/);
    assert.match(recorded, /Your answer did not resume it/);
    assert.doesNotMatch(html, /Your answer will not resume it|Your note is kept if saving fails/);
    assert.match(html, /Record approval/);
  } finally { Object.assign(state, saved); }
});

test('an unaddressed launch opens the rule composer for both solo and team installations', async () => {
  const { parseHash } = await import('../web/js/router.js');
  const previousLocation = globalThis.location;
  const company = state.company;
  try {
    for (const employees of [[], [{ id: 'solo', role: 'solo' }], [{ id: 'admin', role: 'admin' }]]) {
      state.company = { ...company, employees };
      for (const hash of ['', '#/', '#/unknown']) {
        globalThis.location = { hash };
        assert.deepEqual(parseHash(), { view: 'policy', sel: 'new', query: {} });
      }
    }
  } finally {
    state.company = company;
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
  }
});

test('explicit links still reach lists, records and device setup after changing the start screen', async () => {
  const { parseHash } = await import('../web/js/router.js');
  const previousLocation = globalThis.location;
  try {
    for (const [hash, expected] of [
      ['#/policy', { view: 'policy', sel: null, query: {} }],
      ['#/policy/edit%3Acustomer-data', { view: 'policy', sel: 'edit:customer-data', query: {} }],
      ['#/activity/event-1?rule=customer-data', { view: 'activity', sel: 'event-1', query: { rule: 'customer-data' } }],
      ['#soloRules', { view: 'soloRules', sel: null, query: {} }]
    ]) {
      globalThis.location = { hash };
      assert.deepEqual(parseHash(), expected);
    }
  } finally {
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
  }
});

test('records open over their lists while creation and team settings remain full pages', async () => {
  await import('../web/js/team.js');
  await import('../web/js/inbox.js');
  const saved = { ...state };
  try {
    for (const [view, selections] of [
      ['activity', [[null, false], ['event-1', true]]],
      ['inbox', [[null, false], ['appeal-event-1', true]]],
      ['policy', [[null, false], ['new', false], ['rule-1', true], ['edit:rule-1', true]]],
      ['people', [[null, false], ['roles', false], ['company', false], ['alex', true]]]
    ]) {
      for (const [sel, expected] of selections) {
        Object.assign(state, { view, sel });
        assert.equal(VIEWS[view].detail(), expected, `${view}/${sel}`);
      }
    }
  } finally { Object.assign(state, saved); }
});
