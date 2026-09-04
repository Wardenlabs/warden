/**
 * Which model judges, and where rule compilation runs.
 *
 * Administrative, like everything not on the employee allowlist, and that is
 * the right direction here: choosing the adjudicator changes what the guard
 * catches, so it belongs to the same person who writes the rules; and the body
 * of a compiler PUT carries an API key.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router } from 'express';
import { detectCliTools } from '../../qvac/cli-compiler.js';
import { forgetRole, resolvedModel } from '../../qvac/client.js';
import { ADJUDICATOR_CHOICES, modelsDir } from '../../qvac/models.js';
import { remoteCompilerSource, validate as validateCompilerEndpoint } from '../../qvac/remote.js';
import {
  adjudicatorSettingsSchema,
  COMPILER_PROVIDERS,
  compilerSettingsSchema,
  loadAdjudicatorSettings,
  loadCompilerSettings,
  redactedCompilerSettings,
  saveAdjudicatorSettings,
  saveCompilerSettings
} from '../../settings.js';
import { asyncRoute } from '../http.js';

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
  const dir = modelsDir();
  res.json({
    model: chosen,
    // What is actually loaded, which is not always what was chosen: the env
    // override outranks this setting and a bench run leaves it set.
    inForce: resolvedModel('adjudicator'),
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
      approxMB: c.approxMB,
      perDecision: c.perDecision,
      trade: c.trade,
      onDisk: existsSync(resolve(dir, c.filename))
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
settingsRoutes.post('/api/settings/adjudicator', asyncRoute(async (req, res) => {
  const parsed = adjudicatorSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'model must be one of: default, dynaguard, base, large' });
    return;
  }
  const choice = ADJUDICATOR_CHOICES.find((c) => c.id === parsed.data.model);
  const onDisk = Boolean(choice && existsSync(resolve(modelsDir(), choice.filename)));
  const saved = saveAdjudicatorSettings(parsed.data);
  // The process caches one loaded model per role for its lifetime, so without
  // this the console would report the new seat while the old model answered.
  await forgetRole('adjudicator');
  res.json({
    ...saved,
    onDisk,
    needsDownload: onDisk ? null : (choice?.filename ?? null),
    inForce: resolvedModel('adjudicator')
  });
}));

/**
 * Where rule compilation runs.
 *
 * The key is never returned; the console gets `hasKey` and the last four
 * characters, which is enough to tell "a key is saved" from "the field is
 * empty" without putting the secret back on the wire on every page load.
 */
settingsRoutes.get('/api/settings/compiler', asyncRoute(async (_req, res) => {
  const source = remoteCompilerSource();
  // Which CLIs are actually on this machine, so the console can say so beside
  // the option instead of letting somebody pick one that will fail on the first
  // compile. `detectCliTools` existed and nothing called it, which is the same
  // as it not existing: an administrator picked "Claude Code on this machine"
  // and found out whether that was true a minute later, from a compile error.
  const cliTools = await detectCliTools().catch(() => []);
  res.json({
    cliTools,
    ...redactedCompilerSettings(loadCompilerSettings()),
    providers: COMPILER_PROVIDERS,
    // Which source is actually in force. An administrator whose saved settings
    // are overridden by the environment should see that rather than conclude
    // the page did not save.
    activeSource: source ?? 'local',
    overriddenByEnv: source === 'env',
    localModel: resolvedModel('adjudicator')
  });
}));

settingsRoutes.put('/api/settings/compiler', asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  const current = loadCompilerSettings();
  const next = compilerSettingsSchema.safeParse({
    provider: String(body.provider ?? 'local'),
    baseUrl: String(body.baseUrl ?? ''),
    // An empty key means "keep the one already saved", so the console never has
    // to hold a secret in order to change the model beside it.
    apiKey: typeof body.apiKey === 'string' && body.apiKey.length > 0 ? body.apiKey : current.apiKey,
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
  if (next.data.provider !== 'local' && !next.data.provider.endsWith('-cli')) {
    try {
      validateCompilerEndpoint({ ...next.data, timeoutMs: 60_000 });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
    if (!next.data.apiKey) return res.status(400).json({ error: 'an API key is required for a remote compiler' });
  }

  res.json(redactedCompilerSettings(saveCompilerSettings(next.data)));
}));

/**
 * Try the endpoint before committing to it.
 *
 * Without this the first sign of a wrong key or a wrong base URL is a rule
 * draft that fails a minute later, in the middle of writing policy. It sends
 * one trivial completion and reports what came back — never the roster, and
 * never anything from the policy.
 */
settingsRoutes.post('/api/settings/compiler/test', asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  const current = loadCompilerSettings();
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.length > 0 ? body.apiKey : current.apiKey;
  if (!apiKey) return res.status(400).json({ ok: false, error: 'no API key to test with' });

  let endpoint: { baseUrl: string; apiKey: string; model: string; timeoutMs: number };
  try {
    endpoint = validateCompilerEndpoint({
      baseUrl: String(body.baseUrl ?? ''),
      apiKey,
      model: String(body.model ?? '') || 'claude-sonnet-5',
      timeoutMs: 20_000
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }

  const started = Date.now();
  try {
    const upstream = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        max_tokens: 8,
        temperature: 0
      }),
      signal: AbortSignal.timeout(endpoint.timeoutMs)
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return res.json({ ok: false, status: upstream.status, error: text.slice(0, 300) });
    }
    let reply = '';
    try {
      reply = String(JSON.parse(text)?.choices?.[0]?.message?.content ?? '').trim().slice(0, 80);
    } catch {
      return res.json({ ok: false, error: 'the endpoint answered, but not in the OpenAI shape' });
    }
    res.json({ ok: true, ms: Date.now() - started, model: endpoint.model, reply });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}));
