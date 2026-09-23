/**
 * Which model judges, and where rule compilation runs.
 *
 * Administrative, like everything not on the employee allowlist, and that is
 * the right direction here: choosing the adjudicator changes what the guard
 * catches, so it belongs to the same person who writes the rules; and the body
 * of a compiler PUT carries an API key.
 */
import { resolve } from 'node:path';
import { analyzerFormat } from '../../qvac/native-guards.js';
import { Router } from 'express';
import { cliCompilerConfig, detectCliTools, type CliTool } from '../../qvac/cli-compiler.js';
import { claudeStatus, CliConnectionError, testCliCompiler } from '../../qvac/cli-setup.js';
import { compilerEnvironmentError, isMock, remoteCompiler } from '../../qvac/index.js';
import { withRoleChange } from '../../qvac/coordination.js';
import { RealQvacAdapter } from '../../qvac/real.js';
import { applyCompilerSettings, selections, testEndpoint, withModelManagement } from '../../models/manager.js';
import { activeLocalModel, configuredModel, forgetRole, modelFor, modelInventory } from '../../qvac/client.js';
import { ADJUDICATOR_CHOICES, modelsDir } from '../../qvac/models.js';
import { remoteCompilerSource, validate as validateCompilerEndpoint } from '../../qvac/remote.js';
import {
  adjudicatorSettingsSchema,
  COMPILER_PROVIDERS,
  compilerSettingsSchema,
  compilerSetupRequired,
  loadAdjudicatorSettings,
  loadCompilerSettings,
  redactedCompilerSettings,
  saveAdjudicatorSettings,
} from '../../settings.js';
import { LIBRARY_BUILTINS, libraryBuiltin } from '../../setup/catalog.js';
import { installedModel } from '../../setup/model-files.js';
import { asyncRoute } from '../http.js';
import { isKevChoice, kevConfig, testKevEndpoint } from '../../qvac/kev.js';

/** Presence by the same test the resolver and the Library use: a name on disk
 * is not a model while a transfer can be writing into this directory. */
function choicePresence(choice: string) {
  const builtin = LIBRARY_BUILTINS.find((entry) => entry.adjudicatorChoice === choice);
  if (!builtin) return { builtinId: null, onDisk: isKevChoice(choice), verifiedDownload: false, downloadBlockedReason: null };
  return { builtinId: builtin.id, ...installedModel(libraryBuiltin(builtin.id)!.spec, modelsDir()) };
}

function adjudicatorInForce(): string | null {
  if (process.env['WARDEN_MODEL_ADJUDICATOR'] || selections().adjudicator) return activeLocalModel('adjudicator');
  const selected = loadAdjudicatorSettings().model;
  return isKevChoice(selected) ? selected : activeLocalModel('adjudicator');
}

export const settingsRoutes = Router();

/**
 * Which weights judge, and what is known about the alternatives.
 *
 * The measured numbers travel with the options rather than living in the
 * console's markup. The console renders what this returns, so there is one
 * place where "the 8B misses 18 more points of attacks" is written down, and
 * it is next to the thing that decides.
 */
settingsRoutes.get('/api/settings/adjudicator', (_req, res) => {
  const chosen = loadAdjudicatorSettings().model;
  res.json({
    model: chosen,
    modelId: selections().adjudicator,
    configuredModel: configuredModel('adjudicator'),
    loadedModel: activeLocalModel('adjudicator'),
    // What is actually loaded, which is not always what was chosen: the env
    // override outranks this setting and a bench run leaves it set.
    inForce: adjudicatorInForce(),
    overriddenByEnv: Boolean(process.env['WARDEN_MODEL_ADJUDICATOR']),
    // Named fields rather than a spread: the corpus percentages stay on the
    // server. They are what the choice is grounded in, not what a console has
    // any business showing — a screen whose largest type is this product's own
    // worst measurement is a screen nobody opens twice. What a person needs to
    // decide travels as `trade`, in a sentence.
    choices: ADJUDICATOR_CHOICES.map((c) => ({
      id: c.id,
      label: c.label,
      filename: c.filename,
      format: c.engine === 'system-one' ? 'system-one' : analyzerFormat(c.filename),
      engine: c.engine ?? 'qvac',
      approxMB: c.approxMB,
      perDecision: c.perDecision,
      trade: c.trade,
      builtinId: choicePresence(c.id).builtinId,
      onDisk: choicePresence(c.id).onDisk
    }))
  });
});

/**
 * Switch the seat.
 *
 * Accepts a choice whose weights are absent, because that is exactly the click
 * that starts the download: refusing it would make the picker unusable for the
 * only option anybody has to fetch. What it does not do is pretend the switch
 * happened — `needsDownload` says the file is not here, `inForce` says which
 * model is actually answering, and the guard goes on judging with the 1.7B
 * until the download lands.
 */
settingsRoutes.post('/api/settings/adjudicator', asyncRoute(async (req, res) => withModelManagement(async () => {
  // Custom IDs have their own tested activation route. This endpoint only
  // accepts the shipped choices, including the request to download one.
  const parsed = adjudicatorSettingsSchema.safeParse({ model: req.body?.model });
  if (!parsed.success) return res.status(400).json({ error: `model must be one of: ${ADJUDICATOR_CHOICES.map((c) => c.id).join(', ')}` });
  const choice = ADJUDICATOR_CHOICES.find((c) => c.id === parsed.data.model)!;
  const kev = isKevChoice(choice.id);
  const path = resolve(modelsDir(), choice.filename);
  const onDisk = kev || choicePresence(choice.id).onDisk;
  // The console's Use. Without the flag this is still the legacy request, where
  // an absent file saves a pending choice for the desktop installer to act on;
  // old clients and first-run keep that. With it, nothing is saved unless the
  // weights can be loaded now, and "saved in mock mode" is not reported as a
  // model judging requests.
  if (req.body?.requireInstalled === true) {
    const refusal = !onDisk ? 'Download this model from the Library before using it.'
      : isMock() ? 'This gateway is running the mock adapter. Restart it with real inference to use a model.'
        : !kev && process.env['WARDEN_ADAPTER'] === 'llamacpp' ? 'Model management uses the QVAC runtime. Restart without the experimental llamacpp adapter to select models.'
          : process.env['WARDEN_MODEL_ADJUDICATOR'] ? 'The environment controls this role. Remove its override before selecting a model.' : null;
    if (refusal) return res.status(409).json({ error: refusal, code: !onDisk ? 'not_installed' : 'use_unavailable' });
  }
  await withRoleChange('adjudicator', async () => {
    const previous = loadAdjudicatorSettings();
    if (isKevChoice(choice.id)) {
      try {
        await testKevEndpoint(kevConfig(choice.id));
        await forgetRole('adjudicator');
        saveAdjudicatorSettings(parsed.data);
      } catch (error) {
        saveAdjudicatorSettings(previous);
        if (!isKevChoice(previous.model)) await modelFor('adjudicator').catch(() => undefined);
        throw error;
      }
      return;
    }
    // The file can vanish between the check above and the lease.
    if (req.body?.requireInstalled === true && !choicePresence(choice.id).onDisk) throw new Error('Download this model from the Library before using it.');
    // An absent preset is a download request. Keep the current loaded model
    // serving until the desktop completes the transfer and restarts.
    if (!onDisk || isMock() || process.env['WARDEN_MODEL_ADJUDICATOR']) {
      saveAdjudicatorSettings(parsed.data);
      return;
    }
    await forgetRole('adjudicator');
    try {
      await new RealQvacAdapter().testLocal(path, 'adjudicator', analyzerFormat(choice.filename));
      saveAdjudicatorSettings(parsed.data);
      await modelFor('adjudicator');
    } catch (error) {
      await forgetRole('adjudicator');
      saveAdjudicatorSettings(previous);
      throw error;
    }
  });
  res.json({ ...parsed.data, modelId: null, onDisk, needsDownload: onDisk ? null : choice.filename,
    configuredModel: configuredModel('adjudicator'), inForce: adjudicatorInForce() });
})));

/**
 * Where rule compilation runs.
 *
 * The key is never returned; the console gets `hasKey` and the last four
 * characters, which is enough to tell "a key is saved" from "the field is
 * empty" without putting the secret back on the wire on every page load.
 */
settingsRoutes.get('/api/settings/compiler', asyncRoute(async (req, res) => {
  const source = remoteCompilerSource();
  // Which CLIs are actually on this machine, so the console can say so beside
  // the option instead of letting somebody pick one that will fail on the first
  // compile. `detectCliTools` existed and nothing called it, which is the same
  // as it not existing: an administrator picked "Claude Code on this machine"
  // and found out whether that was true a minute later, from a compile error.
  const [cliTools, claude] = await Promise.all([detectCliTools().catch(() => []), claudeStatus(req.query.refresh === '1')]);
  const setupRequired = compilerSetupRequired();
  const configurationError = compilerEnvironmentError();
  const cli = cliCompilerConfig();
  const overriddenByEnv = Boolean(process.env['WARDEN_COMPILER_CLI']?.trim() || process.env['WARDEN_COMPILER_API']?.trim() || process.env['WARDEN_MODEL_COMPILER']?.trim());
  res.json({
    cliTools,
    claude,
    setupRequired,
    configurationError,
    ...redactedCompilerSettings(loadCompilerSettings()),
    providers: COMPILER_PROVIDERS,
    // Which source is actually in force. An administrator whose saved settings
    // are overridden by the environment should see that rather than conclude
    // the page did not save.
    activeSource: overriddenByEnv ? 'env' : setupRequired ? 'setup-required' : cli ? 'settings' : source ?? 'local',
    overriddenByEnv,
    // Whether a compiler better than the local weights is actually in force —
    // a CLI or an endpoint, from the environment or from the saved settings.
    // The console was reading `provider`, which is the SAVED setting, and so a
    // gateway started with `WARDEN_COMPILER_CLI=claude` compiled every
    // sentence through the single-rule route as if the 1.7B were answering:
    // the split never ran, and the instruction that should have become five
    // rules became one. This is the adapter's own answer, not the file's.
    capable: !setupRequired && !configurationError && remoteCompiler() !== null,
    modelId: selections().compiler,
    inForce: setupRequired || configurationError ? null : remoteCompiler() ?? activeLocalModel('compiler'),
    configuredModel: cli ? cli.model || `${cli.tool} default` : configuredModel('compiler'),
    localModel: modelInventory().find((m) => m.role === 'compiler')?.name ?? 'local compiler'
  });
}));

settingsRoutes.put('/api/settings/compiler', asyncRoute(async (req, res) => withModelManagement(async () => {
  const body = req.body ?? {};
  const current = loadCompilerSettings();
  const sameEndpoint = String(body.baseUrl ?? '').replace(/\/+$/, '') === current.baseUrl.replace(/\/+$/, '');
  const next = compilerSettingsSchema.safeParse({
    provider: String(body.provider ?? current.provider),
    baseUrl: String(body.baseUrl ?? ''),
    // An empty key means "keep the one already saved", so the console never has
    // to hold a secret in order to change the model beside it.
    apiKey: body.clearKey === true ? '' : typeof body.apiKey === 'string' && body.apiKey.length > 0 ? body.apiKey : sameEndpoint ? current.apiKey : '',
    model: String(body.model ?? ''),
    redactNames: Boolean(body.redactNames)
  });
  if (!next.success) {
    return res.status(400).json({ error: next.error.issues.map((i) => i.message).join('; ') });
  }

  // Held to the same bar as the environment variables: https unless loopback,
  // and both halves present. Rejecting here means an unusable configuration
  // never reaches disk, so the compiler cannot be left silently broken.
  // The CLI providers are neither local nor an endpoint: there is nothing to
  // validate because there is nothing to type. Holding them to the https-and-a-
  // key bar would reject the one configuration that needs no credential.
  if (next.data.provider === 'catalog') return res.status(400).json({ error: 'Select a saved model through its Test and Use controls' });
  if (!COMPILER_PROVIDERS.some((p) => p.id === next.data.provider)) return res.status(400).json({ error: 'Unknown compiler provider' });
  if (next.data.provider !== 'local' && !next.data.provider.endsWith('-cli')) {
    try {
      validateCompilerEndpoint({ ...next.data, timeoutMs: 60_000 });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    await testEndpoint(next.data);
  }

  if (next.data.provider.endsWith('-cli')) {
    const tools = await detectCliTools();
    const selected = next.data.provider.replace(/-cli$/, '');
    if (!tools.some((tool) => (tool.tool === selected || (selected === 'cursor' && tool.tool === 'cursor-agent')) && tool.found)) {
      return res.status(400).json({ error: 'Install and sign in to this compiler CLI before selecting it', code: 'cli_not_installed' });
    }
    if (next.data.provider === 'claude-cli') {
      try { await testCliCompiler('claude', next.data.model.trim()); }
      catch (error) { return res.status(400).json({ ok: false, error: error instanceof CliConnectionError ? error.message : 'The compiler connection test failed.', code: error instanceof CliConnectionError ? error.code : 'cli_test_failed' }); }
    }
    next.data.baseUrl = '';
    next.data.apiKey = '';
  }
  res.json({ ...redactedCompilerSettings(await applyCompilerSettings(next.data)), setupRequired: compilerSetupRequired() });
})));

/**
 * Try the endpoint before committing to it.
 *
 * Without this the first sign of a wrong key or a wrong base URL is a rule
 * draft that fails a minute later, in the middle of writing policy. It sends
 * one trivial completion and reports what came back — never the roster, and
 * never anything from the policy.
 */
settingsRoutes.post('/api/settings/compiler/test', asyncRoute(async (req, res) => {
  const current = loadCompilerSettings();
  const body = req.body ?? {};
  const sameEndpoint = String(body.baseUrl ?? '').replace(/\/+$/, '') === current.baseUrl.replace(/\/+$/, '');
  const apiKey = body.clearKey === true ? '' : typeof body.apiKey === 'string' && body.apiKey.length > 0 ? body.apiKey : sameEndpoint ? current.apiKey : '';
  const started = Date.now();
  try {
    if (typeof body.provider === 'string' && body.provider.endsWith('-cli')) {
      const cliTools: Record<string, CliTool> = { 'claude-cli': 'claude', 'codex-cli': 'codex', 'gemini-cli': 'gemini', 'opencode-cli': 'opencode', 'cursor-cli': 'cursor-agent', 'copilot-cli': 'copilot' };
      const tool = cliTools[body.provider];
      if (!tool || (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 120))) return res.status(400).json({ ok: false, error: 'Choose a supported compiler and model.', code: 'invalid_compiler' });
      const model = String(body.model ?? '').trim();
      await testCliCompiler(tool, model);
      return res.json({ ok: true, ms: Date.now() - started, model, reply: 'ready' });
    }
    await testEndpoint({ baseUrl: String(body.baseUrl ?? ''), apiKey, model: String(body.model ?? ''), timeoutMs: 20_000 });
    res.json({ ok: true, ms: Date.now() - started, model: String(body.model), reply: 'ready' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : 'The compiler test failed', ...(error instanceof CliConnectionError ? { code: error.code } : {}) });
  }
}));
