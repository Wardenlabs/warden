/** Compiler settings, shared by the Models screen and its older deep link. */
import { $, attr, esc, post, state } from './core.js';
import { refreshCompiler } from './data.js';
import { render } from './render.js';
import { disclosureRow, feedback } from './ui.js';

// A tested key can be applied without asking the administrator to paste it
// twice. It is scoped to the tested host and never reinserted into an input.
let testedKey = null;
/**
 * First run offers the one path that works out of the box and puts the rest of
 * the providers behind a button. The whole list as the opening screen is what
 * made "which of these am I supposed to pick" the first question the product
 * asked, when the answer for almost everybody is the CLI already signed in on
 * the machine.
 */
let choosingProvider = false;
export function clearCompilerSecret() { testedKey = null; choosingProvider = false; }

export function compilerNeedsSetup() {
  return state.compiler?.setupRequired === true && !state.compiler.overriddenByEnv;
}

/** Shared by solo and team: a setup step, with the rest of the console open. */
export function compilerSetupNudge() {
  if (!compilerNeedsSetup() || ['models', 'compiler'].includes(state.view)) return '';
  return feedback({ tone: 'attention', title: 'Set up rule drafting', body: '<div class="feedback-actions"><button type="button" class="btn --primary --compact" data-go="models" data-q="setup=compiler">Set up the rule writer</button></div>' });
}

const defaultProviderModel = (provider) => provider?.id.endsWith('-cli') ? '' : provider?.models?.[0] ?? '';

function claudeConnected(draft = compilerDraft()) {
  const test = state.compilerTest;
  return test?.ok === true && test.provider === 'claude-cli' && test.model === draft.model;
}


function compilerDraft() {
  if (!state.compilerDraft) {
    const c = state.compiler ?? {};
    const provider = (c.providers ?? []).some((p) => p.id === c.provider) ? c.provider : 'local';
    const preset = (c.providers ?? []).find((p) => p.id === provider);
    state.compilerDraft = {
      provider, baseUrl: c.baseUrl || preset?.baseUrl || '',
      model: provider.endsWith('-cli') ? c.model ?? '' : c.model || defaultProviderModel(preset), redactNames: Boolean(c.redactNames)
    };
  }
  return state.compilerDraft;
}

function localCompilerMissing() {
  return state.models?.models?.some((model) => model.role === 'compiler' && model.onDisk === false) ?? false;
}

function localCompilerNote() {
  if (!localCompilerMissing()) return '';
  const selected = state.compiler?.provider === 'local' && !compilerNeedsSetup();
  return `<div class="compiler-local-missing"><p class="form-note --attention">The local compiler model is not downloaded. ${selected ? 'Download its weights before drafting a rule.' : 'Apply this selection, then download its weights before drafting a rule.'}</p>${state.canLeaveDemo ? `<button type="button" class="btn js-get-models"${selected ? '' : ' disabled'}>Download models</button>` : '<p class="field-help">After applying, run <code>pnpm run setup</code> on the gateway to download the local compiler.</p>'}</div>`;
}

function compilerFeedback() {
  const busy = state.compilerBusy;
  if (busy === 'test') return '<p class="field-help">Testing connection…</p>';
  if (busy === 'refresh') return '<p class="field-help">Checking…</p>';
  const t = state.compilerTest;
  if (!t) return '';
  let text;
  if (t.saved) text = t.overridden ? 'Preference saved. The environment override still controls compilation.' : t.provider === 'local' && localCompilerMissing() ? 'Local compiler selected. Download its model before drafting a rule.' : 'Compiler applied. New rule drafts use this selection.';
  else if (t.ok) text = `Connection answered in ${Number.isFinite(t.ms) ? t.ms : 0} ms. Apply the compiler when you are ready.`;
  else text = String(t.error ?? 'The compiler could not be updated. Try again.');
  return `<p class="form-note --${t.ok ? 'allow' : 'block'}">${esc(text)}</p>`;
}

/**
 * The same four steps, first run, with the finished ones collapsed to a check.
 *
 * The guided list never collapsed: somebody who had Claude Code installed and
 * signed in still read two paragraphs telling them how to install and sign in
 * before reaching the one control that had anything to do. What is done is a
 * tick, what is next is the primary button, and the rest of the providers are
 * behind "Use another model" rather than in front of it.
 *
 * Apply is not rendered at all until the connection has been checked for the
 * model in the draft — the gate is the same one the full form has always had,
 * said by absence rather than by a disabled button.
 */
function claudeQuickSetup(draft) {
  const status = state.compiler?.claude;
  const installed = status?.installed ?? cliFor('claude-cli')?.found;
  const signedIn = status?.auth === 'signed-in';
  const connected = claudeConnected(draft);
  const busy = state.compilerBusy;
  const step = (done, label) => `<li class="${done ? '--done' : ''}"><span class="mark" aria-hidden="true">${done ? '✓' : '○'}</span>${label}</li>`;
  return `<div class="job-setup">
    <div class="job-task">
      <b>Use Claude Code on this machine · Recommended</b>
      ${connected
        ? `<button type="submit" class="btn --primary" id="cSave"${state.compilerTest?.saved ? ' disabled' : ''}>${busy === 'save' ? 'Applying…' : 'Apply the rule writer'}</button>`
        : `<button type="button" class="btn --primary" id="cTest">${busy === 'test' ? 'Testing connection…' : 'Test connection'}</button>`}
    </div>
    <p class="job-task-note">Uses your Claude Code account and plan. The check sends one short test request.</p>
    <ul class="setup-steps">
      ${step(installed === true, 'Installed')}${step(signedIn, 'Signed in')}${step(connected, 'Connection tested')}
    </ul>
    ${status?.message ? `<p class="job-note${['install-required', 'sign-in-required'].includes(status.status) ? ' --attention' : ''}" role="status">${esc(status.message)} <button type="button" class="linkish" id="cRefresh">${busy === 'refresh' ? 'Checking…' : 'Refresh status'}</button></p>` : `<p class="job-note"><button type="button" class="linkish" id="cRefresh">${busy === 'refresh' ? 'Checking…' : 'Refresh status'}</button></p>`}
    ${installed === false ? `<p class="job-note">Install the command-line app on this gateway, as the same user running Warden, then refresh its status.</p>
      <div><a class="btn" href="https://code.claude.com/docs/en/setup#install-claude-code" target="_blank" rel="noopener noreferrer">Open installation guide<span class="sr-only"> in a new tab</span></a></div>` : ''}
    ${installed !== false && !signedIn ? `<div class="claude-login-command"><code>claude auth login</code><button type="button" class="btn --compact" data-copy="${attr('claude auth login')}">Copy sign-in command</button></div>` : ''}
    <div class="disclosures">${disclosureRow('m:another', 'Use another model', '', '<div><button type="button" class="btn --compact" id="cAnother">Choose another model</button></div>', { open: state.open.has('m:another') })}</div>
  </div>`;
}

function claudeSetup(draft) {
  const status = state.compiler?.claude;
  const installed = status?.installed ?? cliFor('claude-cli')?.found;
  const signedIn = status?.auth === 'signed-in';
  const connected = claudeConnected(draft);
  const busy = state.compilerBusy;
  const authLabel = signedIn ? 'Signed in' : status?.auth === 'signed-out' ? 'Sign-in required' : installed === false ? 'Install first' : 'Not confirmed';
  const isApplied = state.compiler?.provider === 'claude-cli' && state.compiler.activeSource === 'settings' && !compilerNeedsSetup() && !state.compiler.overriddenByEnv && state.compiler.model === draft.model;
  return `<section class="claude-setup" aria-labelledby="claudeSetupHeading">
    <div class="claude-setup-head"><div><h3 id="claudeSetupHeading">${compilerNeedsSetup() ? 'Set up Claude Code to draft rules' : 'Connect Claude Code'}</h3><p class="field-help">Use a terminal on the gateway computer, as the same user running Warden. Usage follows your Claude Code account and provider plan.</p></div><button type="button" class="btn --link" id="cRefresh">${busy === 'refresh' ? 'Checking…' : 'Refresh status'}</button></div>
    ${status?.message ? `<p class="field-help${['install-required', 'sign-in-required'].includes(status.status) ? ' --attention' : ''}" role="status">${esc(status.message)}</p>` : ''}
    <ol class="claude-setup-steps">
      <li><div class="claude-step-heading"><h4>Install Claude Code</h4><span class="model-status${installed ? ' good' : ''}">${installed === true ? 'Installed' : installed === false ? 'Not found' : 'Not checked'}</span></div><p>Install the command-line app on this gateway, then refresh its status here.</p><a class="btn" href="https://code.claude.com/docs/en/setup#install-claude-code" target="_blank" rel="noopener noreferrer">Open installation guide<span class="sr-only"> in a new tab</span></a></li>
      <li><div class="claude-step-heading"><h4>Sign in</h4><span class="model-status${signedIn ? ' good' : ''}">${authLabel}</span></div><p>Run this command in the gateway’s terminal and complete the sign-in flow it opens.</p><div class="claude-login-command"><code>claude auth login</code><button type="button" class="btn --link" data-copy="${attr('claude auth login')}">Copy sign-in command</button></div></li>
      <li><div class="claude-step-heading"><h4>Check the connection</h4><span id="claudeTestStatus" class="model-status${connected ? ' good' : ''}">${connected ? 'Connection checked' : 'Not checked'}</span></div><p>Send a short test request through Claude Code. This can use your account’s allowance. An unknown sign-in status can still be checked.</p><button type="button" class="btn" id="cTest">${busy === 'test' ? 'Testing connection…' : 'Test connection'}</button></li>
      <li><div class="claude-step-heading"><h4>Apply the compiler</h4><span class="model-status${isApplied ? ' good' : ''}">${isApplied ? 'Applied' : 'Your choice'}</span></div><p>${state.compiler?.overriddenByEnv ? 'Save this preference for when the environment override is removed.' : 'Use this checked connection for new rule drafts. Employee requests continue to be analyzed locally.'}</p><button type="submit" class="btn --primary" id="cSave"${!connected || state.compilerTest?.saved ? ' disabled' : ''}>${busy === 'save' ? 'Applying…' : 'Apply compiler'}</button></li>
    </ol>
  </section>`;
}

/** The registry owns named custom connections; this form keeps the existing
 * preset and signed-in CLI choices in the same administrative surface. */
export function compilerSettings() {
  const c = state.compiler;
  if (!c) return '<p class="form-note --block" role="alert">Compiler settings could not be loaded. Refresh Models to try again.</p>';
  const d = compilerDraft();
  const chosen = (c.providers ?? []).find((p) => p.id === d.provider);
  const cli = d.provider.endsWith('-cli');
  const claude = d.provider === 'claude-cli';
  const remote = d.provider !== 'local' && !cli;
  const busy = state.compilerBusy;
  if (claude && compilerNeedsSetup() && !choosingProvider) {
    return `<form id="compilerForm" aria-label="Rule writer setup" aria-busy="${Boolean(busy)}">
      ${c.configurationError ? feedback({ tone: 'error', icon: true, title: 'Compiler configuration needs attention.', body: esc(c.configurationError) }) : ''}
      ${claudeQuickSetup(d)}
      <div id="compilerFeedback" role="status" aria-live="polite">${compilerFeedback()}</div>
    </form>`;
  }
  return `<form id="compilerForm" class="model-editor" aria-label="Compiler settings" aria-busy="${Boolean(busy)}">
    ${remote || cli ? disclosureRow('compiler:privacy', 'Data shared', '', '<p class="disclosure-text">Remote providers receive instructions, role names and the team list. Employee requests are analyzed locally.</p>', { open: state.open.has('compiler:privacy') }) : ''}
    ${c.configurationError ? feedback({ tone: 'error', icon: true, title: 'Compiler configuration needs attention.', body: esc(c.configurationError) }) : ''}
    ${c.overriddenByEnv ? feedback({ tone: 'attention', title: 'Controlled by the environment.', body: 'Your saved preference will apply after the environment override is removed.' }) : ''}
    <fieldset class="model-fields"${busy ? ' disabled' : ''}>
      <div class="field">
        <label for="cProvider">Provider</label>
        <select id="cProvider" data-no-restore>${(c.providers ?? []).map((p) => `<option value="${esc(p.id)}"${p.id === d.provider ? ' selected' : ''}>${esc(p.label)}${cliFor(p.id)?.found === false ? ' · not installed' : ''}</option>`).join('')}</select>
        ${claude ? '' : cliNote(d.provider)}
      </div>
      ${remote ? `<div class="field"><label for="cBase">API endpoint</label><input id="cBase" type="text" spellcheck="false" autocomplete="url" required value="${esc(d.baseUrl)}" placeholder="https://api.example.com/v1"></div>` : ''}
      ${remote || cli ? `<div class="field">
        <label for="cModel">Model ${cli ? '<span class="optional">(optional)</span>' : ''}</label>
        <input id="cModel" type="text" spellcheck="false" list="cModelList"${remote ? ' required' : ''} value="${esc(d.model)}" placeholder="${esc(cli ? claude ? 'Claude Code default' : 'CLI default' : chosen?.models?.[0] ?? 'Provider default')}">
        <datalist id="cModelList">${(chosen?.models ?? []).map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>

      </div>` : localCompilerNote()}
      ${remote ? `<div class="field"><label for="cKey">API key <span class="optional">(if required)</span></label><input id="cKey" type="password" autocomplete="off" spellcheck="false" value="" placeholder="${testedKey ? 'Tested key ready to apply.' : c.hasKey ? 'A key is saved. Leave blank to keep it.' : 'Enter a provider key'}"></div>` : ''}
      ${remote || cli ? `<div class="field"><label class="check"><input id="cRedact" type="checkbox"${d.redactNames ? ' checked' : ''}><span>Hide employee names from this provider</span></label></div>` : ''}
      ${claude ? claudeSetup(d) : `<div class="actions">
        ${remote ? '<button type="button" class="btn" id="cTest">Test connection</button>' : ''}
        <button type="submit" class="btn --primary" id="cSave">${busy === 'save' ? 'Applying…' : 'Apply compiler'}</button>
      </div>`}
    </fieldset>
    <div id="compilerFeedback" role="status" aria-live="polite">${compilerFeedback()}</div>
  </form>`;
}

export function bindCompiler(onChanged = async () => {}) {
  if (!$('compilerForm')) return;
  const d = compilerDraft();
  if (d.adopt) {
    if ($('cBase')) $('cBase').value = d.baseUrl;
    if ($('cModel')) $('cModel').value = d.model;
    delete d.adopt;
  }
  if ($('cAnother')) $('cAnother').onclick = () => { choosingProvider = true; render(); $('cProvider')?.focus(); };
  if ($('cProvider')) $('cProvider').onchange = (event) => {
    testedKey = null;
    const next = (state.compiler?.providers ?? []).find((p) => p.id === event.target.value);
    if (!next) return;
    state.compilerDraft = { provider: next.id, baseUrl: next.baseUrl ?? '', model: defaultProviderModel(next), redactNames: Boolean($('cRedact')?.checked), adopt: true };
    state.compilerTest = null;
    render();
    $('cProvider')?.focus();
  };
  const readForm = () => ({
    provider: d.provider, baseUrl: $('cBase')?.value.trim() ?? '', model: $('cModel')?.value.trim() ?? '',
    redactNames: Boolean($('cRedact')?.checked)
  });
  // Public fields survive background audit refreshes. The secret is read only
  // at submission and lives in that request, never in long-lived UI state.
  for (const f of $('compilerForm').querySelectorAll('input:not([type="password"])')) f.oninput = () => {
    Object.assign(d, readForm()); state.compilerTest = null;
    if (f.id === 'cBase') { testedKey = null; if ($('cKey')) $('cKey').value = ''; }
    if ($('cSave') && d.provider === 'claude-cli') $('cSave').disabled = true;
    if ($('compilerFeedback')) $('compilerFeedback').innerHTML = '';
    if ($('claudeTestStatus')) { $('claudeTestStatus').textContent = 'Not checked'; $('claudeTestStatus').className = 'model-status'; }
  };
  async function submit(mode) {
    if (state.compilerBusy || !$('compilerForm').reportValidity()) return;
    const fields = readForm();
    if (mode === 'save' && fields.provider === 'claude-cli' && !claudeConnected(fields)) {
      state.compilerTest = { ok: false, error: 'Check the Claude Code connection before applying this compiler.' };
      render(); $('cTest')?.focus(); return;
    }
    const sameHost = testedKey?.provider === fields.provider && testedKey?.baseUrl === fields.baseUrl;
    const body = { ...fields, apiKey: $('cKey')?.value || (sameHost ? testedKey.key : '') };
    state.compilerDraft = readForm();
    state.compilerBusy = mode;
    state.compilerTest = null;
    render();
    try {
      const result = await post(`/api/settings/compiler${mode === 'test' ? '/test' : ''}`, body, mode === 'save' ? { method: 'PUT' } : {});
      if (!result.ok || result.j?.ok === false) {
        state.compilerTest = { ok: false, error: typeof result.j?.error === 'string' ? result.j.error : 'The provider did not answer. Check the endpoint, model and key, then try again.' };
      } else if (mode === 'test') {
        testedKey = body.apiKey ? { key: body.apiKey, provider: body.provider, baseUrl: body.baseUrl } : null;
        state.compilerTest = { ...result.j, ok: true, provider: fields.provider, model: fields.model };
      } else {
        testedKey = null;
        await refreshCompiler();
        await onChanged();
        state.compilerDraft = null;
        state.compilerTest = { ok: true, saved: true, provider: fields.provider, model: fields.model, overridden: Boolean(state.compiler?.overriddenByEnv) };
      }
      if (fields.provider === 'claude-cli' && mode === 'test') await refreshCompiler(true);
    } catch {
      state.compilerTest = { ok: false, error: 'Warden could not be reached. Check the gateway connection and try again.' };
    } finally {
      body.apiKey = '';
      state.compilerBusy = false;
      render();
      $(mode === 'test' ? 'cTest' : 'cSave')?.focus();
    }
  }
  if ($('cTest')) $('cTest').onclick = () => void submit('test');
  if ($('cRefresh')) $('cRefresh').onclick = async () => {
    if (state.compilerBusy) return;
    state.compilerBusy = 'refresh'; state.compilerTest = null; render();
    try { await refreshCompiler(true); }
    finally { state.compilerBusy = false; render(); $('cRefresh')?.focus(); }
  };
  $('compilerForm').onsubmit = (event) => { event.preventDefault(); void submit('save'); };
}

/** One line in the composer saying who is about to write the rule. */
/**
 * What the gateway found when it looked for this CLI, or null if this provider
 * is not one. `cliTools` is absent on a gateway older than the route that
 * reports it, which reads as "no claim either way" and shows nothing.
 */
const CLI_TOOL_OF = {
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'opencode-cli': 'opencode',
  'cursor-cli': 'cursor-agent',
  'copilot-cli': 'copilot'
};

function cliFor(providerId) {
  const tool = CLI_TOOL_OF[providerId];
  if (!tool) return null;
  return (state.compiler?.cliTools ?? []).find((t) => t.tool === tool) ?? null;
}

/** The one line under the picker that says whether the chosen CLI is there. */
function cliNote(providerId) {
  const found = cliFor(providerId);
  if (!found) return '';
  return found.found
    ? ''
    : `<span class="form-note --block">Not on this machine. Install <span class="mono">${esc(found.tool)}</span>, sign in, then come back to this page.</span>`;
}
