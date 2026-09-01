/**
 * The Warden server: the proxy, the admin API, and the live-decision stream,
 * on one port.
 *
 * This file is intentionally thin. Each route delegates to a module that owns
 * the real logic (guard, policy, audit), so the surface a client sees is stable
 * even while those modules are still being built. That stability is what lets
 * the web console be built in parallel against a frozen contract.
 *
 * Routes that depend on not-yet-built modules answer from the mock adapter or a
 * clearly-marked stub, never with a lie about being finished — a stub returns
 * plausible shape, logs that it is a stub, and is replaced in place.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { adapter, adapterName, isMock, remoteCompiler } from '../qvac/index.js';
import { resolvedModel } from '../qvac/client.js';
import { detectCliTools } from '../qvac/cli-compiler.js';
import { remoteCompilerSource, validate as validateCompilerEndpoint } from '../qvac/remote.js';
import {
  COMPILER_PROVIDERS,
  compilerSettingsSchema,
  loadCompilerSettings,
  redactedCompilerSettings,
  saveCompilerSettings
} from '../settings.js';
import { dropUnrequestedSample } from '../policy/boot-migrations.js';
import { needsAdmin, requireAdmin } from './admin-auth.js';
import {
  addRole,
  clearDemoDirectory,
  discardSeededPeople,
  invalidate as invalidatePeople,
  loadDirectory,
  loadSampleCompany,
  normaliseRole,
  renameCompany,
  removeEmployee,
  removeRole,
  roles,
  rotateApiKey,
  upsertEmployee,
  findByInstallToken,
  findEmployee,
  actorForCredential
} from '../policy/people.js';
import { discardSeededRules, loadPolicy, rulesForActor, savePolicy, seedIfEmpty } from '../policy/store.js';
import { quotaSchema } from '../policy/types.js';
import { bindsActor, describeAudience } from '../policy/audience.js';
import { activityFor, connectedCount, recordActivity } from '../policy/activity.js';
import { readAppeals, recordAppeal } from '../policy/appeals.js';
import { escalationQueue, recordReview, type ReviewOutcome } from '../policy/escalations.js';
import { findDecision } from '../audit/log.js';
import { checkQuota } from '../guard/quota.js';
import type { RewriteRefusal, RewriteResult } from '../guard/rewrite.js';
import { onboardingFor, supportedTools } from '../onboarding/index.js';
import {
  forgetAll as forgetPrompts,
  promptsEnabled,
  remember as rememberPromptText,
  retentionSummary,
  textFor as promptTextFor
} from '../audit/prompts.js';

const PORT = Number(process.env['WARDEN_PORT'] ?? 8080);

/**
 * Bind every interface by default.
 *
 * Warden's deployment model is one machine holding the models with the rest of
 * the team's tools pointing at it, so localhost-only would make the product
 * undemonstrable. Set WARDEN_HOST=127.0.0.1 to keep it private — this is a
 * plaintext service with API-key auth, meant for a trusted LAN, not the open
 * internet.
 */
const HOST = process.env['WARDEN_HOST'] ?? '0.0.0.0';

/**
 * Where the read-only pieces that ship with Warden live: web/, integrations/,
 * data/seed/. In a checkout that is the repo root, resolved from this file's
 * own location so `pnpm run dev` (src/server) and `pnpm start` (dist/server)
 * both land on it whatever the working directory. The desktop app runs the
 * server with its working directory pointed at a per-user data folder and
 * passes the bundle's location here explicitly. Writable state (data/*.json,
 * warden.local.json) deliberately stays cwd-relative — that is what lets the
 * same code write next to the repo in dev and into the user's data folder in
 * the app.
 */
const ASSETS = process.env['WARDEN_ASSETS_DIR'] ?? fileURLToPath(new URL('../..', import.meta.url));

const app = express();
app.use(express.json({ limit: '4mb' }));

/**
 * The console is served by this same process, so same-origin needs no CORS at
 * all. The wildcard that used to sit here let any web page an admin happened to
 * visit read the directory and post policy changes cross-origin, with the
 * browser's origin check the only thing standing in the way. Serving web/ from
 * a separate dev port is the one case that needs an exception, and it is opt-in
 * and explicit.
 *
 * `admin-auth.ts` is now the thing standing in the way, and it is the one that
 * should be: an origin check only ever governed browsers, and the employee
 * typing the URL was never one. This stays narrow anyway — a second lock on a
 * door costs nothing, and a wildcard here would hand an attacker's page the
 * administrator's own loopback trust.
 */
const CORS_ORIGIN = process.env['WARDEN_CORS_ORIGIN'];
if (CORS_ORIGIN) {
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.header('Access-Control-Allow-Headers', 'content-type, authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    next();
  });
  app.options(/.*/, (_req, res) => res.sendStatus(204));
}

/**
 * Authorisation, ahead of every route so no route can forget it.
 *
 * Mounted here rather than annotated per handler because the failure mode of
 * the per-handler version is silent: the route someone adds next month is
 * public until they remember. `needsAdmin` decides from the path, and its list
 * is of what stays open, so anything new is closed until it is named.
 *
 * **After the CORS block, not before it.** Mounted first, two things broke at
 * once: an administrative 403 carried no `Access-Control-Allow-Origin`, so a
 * browser reported it as an opaque CORS failure rather than as the refusal it
 * is, and the preflight `OPTIONS` was itself authenticated — a preflight
 * carries no `Authorization` header by definition, so with
 * `WARDEN_ADMIN_REQUIRE_KEY=1` the documented separate-dev-port setup could
 * never complete a single request. Order is part of the behaviour of
 * middleware, and this is the order that lets a refusal be read as one.
 *
 * `OPTIONS` is skipped for the same reason: the browser is asking what it would
 * be allowed to do, not doing it. The real request that follows is still
 * checked, so nothing is granted by answering.
 *
 * See `admin-auth.ts` for what an administrator is and why loopback counts as
 * one. Before this, every policy write, key issue and audit read on this server
 * was reachable by anyone who could open the port.
 */
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' || !needsAdmin(req.path)) return next();
  requireAdmin(req, res, next);
});

/*
 * Nothing is seeded at boot. A fresh install has no company, no people and no
 * rules — which is also the only honest starting state for a thing whose job is
 * to enforce rules somebody wrote: it should not arrive holding eight it
 * invented. The console's empty states say so, and the sample company is a
 * button (POST /api/company/sample) rather than a fact about you.
 *
 * What runs here instead is the other half of that, for the installs that
 * already have one. See `boot-migrations.ts` — an upgrade does not touch the
 * user's data folder, so the sample an older build seeded outlives the fix
 * unless the boot removes it, and it may only remove what it can prove nobody
 * edited.
 */
try {
  dropUnrequestedSample(
    join(ASSETS, 'data', 'seed', 'policies.seed.json'),
    join(ASSETS, 'data', 'seed', 'company.json')
  );
} catch {
  /* a migration must never be the reason the gateway will not start */
}

/**
 * What an unrecognised key gets back.
 *
 * Shaped like a decision so the hook and the proxy can render it the same way
 * they render any other refusal, and worded for the person reading it in their
 * terminal — who is far more likely to have a stale key after a rotation than
 * to be an intruder.
 */
const UNKNOWN_KEY = {
  verdict: 'BLOCK' as const,
  auditId: 'no-key',
  error: 'unknown_api_key',
  firedRules: [],
  passes: [],
  maskedPrompt: '',
  maskedSpans: [],
  explanation:
    'Your Warden API key is not recognised by this gateway. ' +
    'Ask your administrator for a current one — they can issue a new key from People.'
};

// ── Live decision stream (SSE) ───────────────────────────────────────────────
// The console's right-hand trace subscribes here. Decisions are pushed as they
// happen by the guard pipeline via `emitDecision`.
const sseClients = new Set<Response>();

app.get('/api/events', (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ mock: isMock() })}\n\n`);
  sseClients.add(res);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
  _req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

/** Broadcast a decision to every connected trace viewer. */
/**
 * Prompt text for the console, held in `audit/prompts.ts` with an expiry.
 *
 * The audit log deliberately does not keep prompt text — `recordDecision`
 * strips it, because a log that kept it would be a transcript of everything
 * employees typed, and the log's own header promises it is not one. That is
 * still true and does not move.
 *
 * It is the wrong answer for the screen, though: an operations lead watching a
 * block happen has no way to see what was blocked, and a row that reads "—"
 * looks like a bug rather than a promise being kept. This used to be answered
 * by a Map of the last 300, in this file, emptied by every restart — which is
 * not a retention policy but an accident of process lifetime, and one nobody
 * could put in writing for the people being logged.
 *
 * It is now a store with a date on it: masked text only, seven days by
 * default, expiry checked on every read so a file that outlived its sweep
 * cannot serve anything, and `WARDEN_PROMPT_RETENTION_DAYS=0` for a deployment
 * that wants nothing on disk at all.
 */
function rememberPrompt(decision: unknown): void {
  if (!decision || typeof decision !== 'object') return;
  const d = decision as { auditId?: unknown; maskedPrompt?: unknown };
  if (typeof d.auditId !== 'string' || typeof d.maskedPrompt !== 'string') return;
  rememberPromptText(d.auditId, d.maskedPrompt);
}

/** Put the text back on entries the store still holds and has not expired. */
function withRememberedPrompts(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  return entries.map((e) => {
    const entry = e as { auditId?: unknown; decision?: Record<string, unknown> };
    if (typeof entry.auditId !== 'string' || !entry.decision) return e;
    const text = promptTextFor(entry.auditId);
    if (text === undefined) return e;
    return { ...entry, decision: { ...entry.decision, maskedPrompt: text } };
  });
}

export function emitDecision(decision: unknown): void {
  rememberPrompt(decision);
  const payload = `data: ${JSON.stringify({ type: 'decision', decision })}\n\n`;
  for (const client of sseClients) {
    // One dead viewer must not turn a finished guard decision into a 500.
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── Policy API ───────────────────────────────────────────────────────────────
app.get('/api/policy', (_req, res) => {
  res.json(loadPolicy());
});

app.get('/api/policy/presets', (_req, res) => {
  // Served from the preset catalog once present; empty array until then so
  // the console renders an empty catalog rather than erroring.
  res.json(readSeedJson(join(ASSETS, 'data', 'seed', 'presets.json'), []));
});

/**
 * Where rule compilation runs.
 *
 * Administrative, like everything not on the employee allowlist — the body of
 * a PUT here carries an API key, and the response would otherwise disclose
 * which provider a company uses. The key is never returned; the console gets
 * `hasKey` and the last four characters, which is enough to tell "a key is
 * saved" from "the field is empty" without putting the secret back on the wire
 * on every page load.
 */
app.get('/api/settings/compiler', asyncRoute(async (_req, res) => {
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

app.put('/api/settings/compiler', asyncRoute(async (req, res) => {
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
app.post('/api/settings/compiler/test', asyncRoute(async (req, res) => {
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

/**
 * Who to credit for a draft.
 *
 * `resolvedModel('compiler')` names the model that *would* answer, which is the
 * wrong answer whenever the mock is the adapter: a draft compiled by the demo
 * stand-in came back to the console labelled "written by QWEN3_1_7B_INST_Q4",
 * with mock text in its examples. A person evaluating Warden with no models
 * downloaded was shown a nonsense rule attributed to a real model — which reads
 * as the model being nonsense, and is the single most expensive thing this
 * console could get wrong about itself.
 *
 * The mock is a test double and it says so here, in the one field whose whole
 * job is provenance.
 */
function draftedBy(remote: string | null): string {
  if (remote) return remote;
  return isMock() ? 'the demo stand-in, not a model' : resolvedModel('compiler');
}

app.post('/api/policy/draft', asyncRoute(async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const mod = await optional<{
    compileRule: (a: unknown, t: string, p: unknown, o?: unknown) => Promise<unknown>;
  }>('../policy/compile.js');
  const compileRule = mod?.compileRule;
  if (!compileRule) return res.status(503).json({ error: 'compiler not available' });
  // `lockTo` is set when the admin writes a rule from inside one person's page.
  // They already said who it is for by being there.
  const lockTo = Array.isArray(req.body?.lockTo) ? req.body.lockTo.map(String) : undefined;
  const rule = await compileRule(adapter(), text, loadPolicy(), lockTo ? { lockTo } : {});
  // Who wrote the draft, so the administrator ratifying it can see whether it
  // came off their own machine. `null` means local, which is the default.
  const remote = remoteCompiler();
  res.json({
    ...(rule as object),
    draftedBy: draftedBy(remote),
    draftedRemotely: remote !== null
  });
}));

/**
 * The same compiler, given the sentence an administrator actually says.
 *
 * A separate route rather than a flag on `/api/policy/draft`, because that one
 * is the measured path and every prompt this repo ships has a note saying what
 * moving it cost. This adds a splitting pass in front of the compiler; a
 * specific sentence still yields exactly one rule, but paying for that extra
 * model call on every single-rule compile is a change nobody asked for. So the
 * console offers it as its own button and the old route is untouched.
 *
 * Administrative by default, like every route that is not in the employee
 * allowlist in `admin-auth.ts` — which is the direction that list is written
 * to make automatic.
 */
app.post('/api/policy/draft-set', asyncRoute(async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const mod = await optional<{
    compilePolicy: (a: unknown, t: string, p: unknown, o?: unknown) => Promise<{ statements: string[]; rules: unknown[] }>;
  }>('../policy/compile.js');
  const compilePolicy = mod?.compilePolicy;
  if (!compilePolicy) return res.status(503).json({ error: 'compiler not available' });
  const lockTo = Array.isArray(req.body?.lockTo) ? req.body.lockTo.map(String) : undefined;
  const { statements, rules } = await compilePolicy(adapter(), text, loadPolicy(), lockTo ? { lockTo } : {});
  const remote = remoteCompiler();
  res.json({
    statements,
    // Stamped per rule and not once for the set, because the administrator
    // ratifies them one at a time and the card in front of them has to be able
    // to say where that rule came from on its own.
    rules: rules.map((rule) => ({
      ...(rule as object),
      draftedBy: draftedBy(remote),
      draftedRemotely: remote !== null
    }))
  });
}));

app.post('/api/policy/preview', asyncRoute(async (req, res) => {
  const mod = await optional<{
    previewRule: (a: unknown, r: unknown, p: unknown, x?: unknown) => Promise<unknown>;
  }>('../policy/compile.js');
  const previewRule = mod?.previewRule;
  if (!previewRule) return res.status(503).json({ error: 'preview not available' });
  // `against` carries prompts the gateway already ruled on, so a candidate rule
  // can be checked for regressions against real traffic and not only against
  // the examples its own compiler invented. Capped: every case is a full
  // adjudication on the local model.
  const against = Array.isArray(req.body?.against)
    ? req.body.against
        .slice(0, 8)
        .map((c: { prompt?: unknown; expected?: unknown }) => ({
          prompt: String(c?.prompt ?? '').slice(0, 2000),
          expected: c?.expected === 'BLOCK' ? 'BLOCK' : 'ALLOW'
        }))
        .filter((c: { prompt: string }) => c.prompt.length > 0)
    : [];
  res.json(await previewRule(adapter(), req.body?.rule, loadPolicy(), against));
}));

app.post('/api/policy/ratify', asyncRoute(async (req, res) => {
  const mod = await optional<{ ratifyRule: (r: unknown) => Promise<unknown> }>('../policy/compile.js');
  const ratifyRule = mod?.ratifyRule;
  if (!ratifyRule) return res.status(503).json({ error: 'ratify not available' });
  res.json(await ratifyRule(req.body?.rule));
}));

// ── People API ───────────────────────────────────────────────────────────────
// The directory is what turns "add an employee" into something the guard acts
// on: it decides the role a caller is judged under, the quota they consume, and
// whether an `@id` rule binds them.

app.get('/api/people', (_req, res) => {
  const dir = loadDirectory();
  const policy = loadPolicy();
  res.json({
    ...dir,
    // Counting here rather than in the browser keeps one definition of "which
    // rules apply to this person" — the same one the guard uses.
    employees: dir.employees.map((e) => {
      // 'any': the admin is being shown what binds this person, which
      // includes the output-side rules no input decision will ever run.
      const applicable = rulesForActor(policy, e, 'any');
      return {
        ...e,
        ruleCount: applicable.length,
        personalRuleCount: applicable.filter((r) => r.appliesTo.includes(`@${e.id}`)).length,
        quota: policy.quotas.find((q) => q.role === e.role)?.maxRequestsPerDay ?? null,
        // What they were told to install is not what they installed. Every hook
        // call names its tool, so this is observed rather than asserted.
        connected: activityFor(e.id)
      };
    })
  });
});

/**
 * The setup for one person, filled in with their id, their key, and the address
 * this gateway is actually reachable at — which is the value most likely to be
 * copied wrong by hand, and the one whose mistakes are silent.
 */
/**
 * The company's own name, and the way out of the demo.
 *
 * Administrative, like everything not on the employee allowlist. Both are
 * destructive in the small: a rename is visible to everyone, and the reset
 * revokes the seeded keys on purpose.
 */
app.put('/api/company', asyncRoute(async (req, res) => {
  const name = String(req.body?.name ?? '');
  try {
    const dir = renameCompany(name);
    res.json({ name: dir.name });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

/**
 * Install the shipped sample company, because somebody pressed the button.
 *
 * The demo used to be the default and it is now a request. Both halves arrive
 * together — a directory of people with no rules to judge them by teaches less
 * than either half alone — and both are the committed seed files, so pressing
 * this twice gives the same company with fresh keys rather than two companies.
 *
 * Administrative, like everything not in the employee allowlist: this writes
 * the directory every key in the deployment is resolved against.
 */
app.post('/api/company/sample', asyncRoute(async (_req, res) => {
  const dir = loadSampleCompany(join(ASSETS, 'data', 'seed', 'company.json'));
  const policy = seedIfEmpty(join(ASSETS, 'data', 'seed', 'policies.seed.json'));
  invalidatePeople();
  res.json({ name: dir.name, employees: dir.employees.length, rules: policy.rules.length });
}));

/**
 * Take out everything that came with Warden, on request, wherever it is.
 *
 * The boot migration does this by itself for installs that never asked for the
 * sample, and it is deliberately careful: if it cannot prove a row is ours it
 * leaves the row alone. That carefulness has a cost, and the cost showed up on
 * a real machine. Name your company and the `demo` flag clears, which is
 * correct and also removes the evidence the migration reads, so the seven
 * invented people and the eight seeded rules sit there with nothing willing to
 * remove them. There was no button for it either: "Clear the sample team" only
 * ever appeared while the flag was set, and it only ever touched people.
 *
 * This is that button, and it does not need evidence because the person
 * pressing it is the evidence. It still only removes rows that match the files
 * we ship, so a rule you wrote or edited survives it.
 */
app.post('/api/company/sample/clear', asyncRoute(async (_req, res) => {
  const people = discardSeededPeople(join(ASSETS, 'data', 'seed', 'company.json'), true);
  const { rules, quotas } = discardSeededRules(join(ASSETS, 'data', 'seed', 'policies.seed.json'));
  invalidatePeople();
  res.json({ people, rules, quotas });
}));

/**
 * Delete every rule, because sometimes you want the slate and not the audit.
 *
 * Quotas stay: they are about spending, not about what anyone may ask, and
 * wiping somebody's daily limits because they wanted to rewrite their policy
 * would be a second thing they did not ask for. There is a confirm in front of
 * this in the console, and it goes through `savePolicy`, so the empty policy is
 * a ratified version like any other and the audit trail keeps the before.
 */
app.delete('/api/policy/rules', asyncRoute(async (_req, res) => {
  const policy = loadPolicy();
  const removed = policy.rules.length;
  const saved = savePolicy([], policy.quotas);
  res.json({ removed, version: saved.version });
}));

app.post('/api/company/reset', asyncRoute(async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
  const dir = clearDemoDirectory(name);
  // Resetting the company and leaving last week's prompts readable would be a
  // reset that kept the one thing worth clearing.
  forgetPrompts();
  res.json({ name: dir.name, employees: dir.employees.length });
}));

app.get('/api/people/:id/onboarding', (req, res) => {
  const person = findEmployee(String(req.params['id']));
  if (!person) return res.status(404).json({ error: 'no such employee' });
  res.json(onboardingFor(person, gatewayUrl(req)));
});

/** What the gateway knows how to onboard, and which of it anyone has verified. */
app.get('/api/integrations', (_req, res) => {
  res.json({ tools: supportedTools(), connectedPeople: connectedCount() });
});

app.post('/api/people', asyncRoute(async (req, res) => {
  try {
    const employee = upsertEmployee({
      id: req.body?.id ? String(req.body.id) : undefined,
      name: String(req.body?.name ?? ''),
      role: String(req.body?.role ?? '')
    });
    res.json(employee);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

app.post('/api/people/:id/key', asyncRoute(async (req, res) => {
  const rotated = rotateApiKey(String(req.params['id']));
  if (!rotated) return res.status(404).json({ error: 'no such employee' });
  res.json(rotated);
}));

app.delete('/api/people/:id', asyncRoute(async (req, res) => {
  const { removed, orphanedRules } = removeEmployee(String(req.params['id']), loadPolicy().rules);
  if (!removed) return res.status(404).json({ error: 'no such employee' });
  res.json({ removed, orphanedRules });
}));

app.post('/api/roles', asyncRoute(async (req, res) => {
  try {
    const { directory, role } = addRole(String(req.body?.role ?? ''));
    // A role with no quota is unmetered. The console always sends one, so the
    // common path leaves no unlimited role behind by accident.
    const perDay = Number(req.body?.maxRequestsPerDay ?? 0);
    if (perDay > 0) {
      const policy = loadPolicy();
      const quotas = policy.quotas
        .filter((q) => q.role !== role)
        .concat({ role, maxRequestsPerDay: Math.floor(perDay) });
      savePolicy(policy.rules, quotas);
    }
    res.json(directory);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

/**
 * Change what a role is allowed to spend.
 *
 * There was no way to do this. A quota could be set once, at the moment the
 * role was created, and after that the console rendered it as a fact — six
 * cards of numbers with no way in. An administrator who typed 20/day for
 * interns and meant 200 had to delete the role, which deletes the people in it.
 *
 * Written as an upsert on the role rather than a patch on the quota, because a
 * role with no quota row is the unmetered case and that has to be reachable
 * from here too: send nothing and the row goes, which is the same sentence as
 * "this role has no limit". Zero and blank both mean that; the schema refuses
 * a zero quota precisely so that "no limit" has exactly one representation.
 *
 * It goes through `savePolicy`, so a limit change re-hashes the policy and
 * lands in the audit trail like any other ratified change. Quotas are inside
 * the policy hash — an admin quietly raising a ceiling is a governance event.
 */
app.put('/api/quotas/:role', asyncRoute(async (req, res) => {
  const role = normaliseRole(String(req.params['role'] ?? ''));
  if (!role) return res.status(400).json({ error: 'role is required' });
  if (!roles().includes(role)) return res.status(404).json({ error: 'no such role' });

  const positive = (v: unknown): number | undefined => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const perDay = positive(req.body?.maxRequestsPerDay);
  const policy = loadPolicy();
  const rest = policy.quotas.filter((q) => q.role !== role);

  // No daily limit means no row at all, and the token ceilings go with it: a
  // quota that meters tokens but not requests is a shape the rest of the guard
  // has never seen, and inventing it here to preserve two numbers would put an
  // untested state into the policy of record.
  if (perDay === undefined) {
    const saved = savePolicy(policy.rules, rest);
    return res.json({ role, quota: null, version: saved.version });
  }

  const quota = {
    role,
    maxRequestsPerDay: perDay,
    ...(positive(req.body?.maxSessionOutputTokens) !== undefined
      ? { maxSessionOutputTokens: positive(req.body?.maxSessionOutputTokens) }
      : {}),
    ...(positive(req.body?.maxContextTokens) !== undefined
      ? { maxContextTokens: positive(req.body?.maxContextTokens) }
      : {})
  };

  const parsed = quotaSchema.safeParse(quota);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid limit' });

  const saved = savePolicy(policy.rules, rest.concat(parsed.data));
  res.json({ role, quota: parsed.data, version: saved.version });
}));

app.delete('/api/roles/:role', asyncRoute(async (req, res) => {
  try {
    const role = String(req.params['role']);
    const dir = removeRole(role);
    const policy = loadPolicy();
    savePolicy(policy.rules, policy.quotas.filter((q) => q.role !== role));
    res.json(dir);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

/** Every rule that binds one person, split by why it binds them. */
app.get('/api/people/:id/rules', (req, res) => {
  const person = findEmployee(String(req.params['id']));
  if (!person) return res.status(404).json({ error: 'no such employee' });
  const policy = loadPolicy();
  const rules = policy.rules.filter((r) => bindsActor(r.appliesTo, person));
  res.json({
    person,
    rules: rules.map((r) => ({
      id: r.id,
      text: r.text,
      severity: r.severity,
      appliesTo: r.appliesTo,
      audience: describeAudience(r.appliesTo, loadDirectory().employees),
      binding: r.appliesTo.includes(`@${person.id}`)
        ? 'personal'
        : r.appliesTo.includes(person.role)
          ? 'role'
          : 'company'
    }))
  });
});

app.delete('/api/policy/rules/:id', asyncRoute(async (req, res) => {
  const mod = await optional<{ removeRule: (id: string) => Promise<unknown> }>('../policy/compile.js');
  const removeRule = mod?.removeRule;
  if (!removeRule) return res.status(503).json({ error: 'policy editing not wired yet' });
  res.json(await removeRule(String(req.params['id'])));
}));

// ── Guard check (used by the hook CLI) ───────────────────────────────────────
app.post('/api/guard/check', asyncRoute(async (req, res) => {
  const actor = resolveActor(req);
  if (!actor) return res.status(401).json(UNKNOWN_KEY);

  const decision = await evaluateRequest(req);
  // The hook names the tool it came from; that sighting is what the console's
  // "connected" badges are built from. `actor.id` comes from the key the
  // gateway issued, so it is an employee by construction — the id no longer
  // arrives on a header that could inflate the count with strangers.
  recordActivity(actor.id, typeof req.body?.source === 'string' ? req.body.source : undefined);
  emitDecision(decision);
  res.json(decision);
}));

// ── Feedback on a refusal ────────────────────────────────────────────────────
/**
 * Everything below runs *after* a decision exists, never during one. A verdict
 * is still decided by `aggregate()` in ordinary code from the ratified rule,
 * and nothing here can change one that has already been made.
 */

/**
 * Decisions that have already been rewritten once.
 *
 * The single most important limit on this endpoint. A rewrite you can ask for
 * repeatedly is a search for a phrasing that passes, run on the attacker's
 * behalf and paid for by us; one per block is a suggestion.
 *
 * In memory, resetting with the process, like the quota counters and the
 * activity sightings. Honest about what it is: a restart returns one rewrite
 * per past block, which is a real hole and a small one next to a durable store
 * this gateway does not otherwise need. The audit log is the record.
 */
const rewritten = new Set<string>();

/**
 * Propose a version of a blocked prompt that would go through.
 *
 * The employee asks for this; it is never offered on the decision path, and a
 * refusal that nobody follows up on costs exactly what it costs today.
 *
 * The prompt has to be sent again rather than read back from the log, and that
 * is the point: the log stores its SHA-256 and not its text, so matching the
 * two proves this is the request that was actually blocked without the
 * governance record ever having held what anybody typed.
 */
app.post('/api/guard/rewrite', asyncRoute(async (req, res) => {
  const actor = resolveActor(req);
  if (!actor) return res.status(401).json(UNKNOWN_KEY);

  const auditId = typeof req.body?.auditId === 'string' ? req.body.auditId.trim() : '';
  const prompt = extractPrompt(req.body);
  if (!auditId || !prompt) {
    return res.status(400).json({ error: 'auditId and prompt are both required' });
  }

  const entry = findDecision(auditId);
  // One body for "no such decision" and "not yours", deliberately. Which of the
  // two it is, is not something a caller gets to probe for.
  if (!entry || entry.actor.id !== actor.id) {
    return res.status(403).json({ error: 'that decision is not yours to rewrite' });
  }
  if (createHash('sha256').update(prompt).digest('hex') !== entry.promptHash) {
    return res.status(400).json({ error: 'that is not the prompt this decision was made about' });
  }
  if (entry.decision.verdict === 'ALLOW') {
    return res.status(400).json({ error: 'that prompt was allowed — there is nothing to rewrite' });
  }
  const policy = loadPolicy();
  const mod = await optional<{
    suggestRewrite: (a: unknown, args: unknown) => Promise<RewriteResult>;
    rewriteGate: (args: unknown) => RewriteRefusal | null;
  }>('../guard/rewrite.js');
  if (!mod?.suggestRewrite || !mod.rewriteGate) {
    return res.status(503).json({ error: 'rewrite is not wired on this gateway', suggestion: null });
  }

  // Asked and answered for free. A refusal decided here ran nothing, so it
  // charges nothing and spends nothing — the answer is deterministic and asking
  // again returns it again.
  const gated = mod.rewriteGate({ prompt, decision: entry.decision, policy });
  if (gated) return res.json({ suggestion: null, reason: gated });

  if (rewritten.has(auditId)) {
    return res.status(409).json({
      error: 'this block has already been rewritten once',
      suggestion: null,
      reason: 'already-rewritten'
    });
  }

  // Writing a rewrite is a model call this person caused, so it is charged like
  // one. The re-check inside `suggestRewrite` charges its own: a rewrite costs
  // two units because it is two passes of the model.
  const quota = checkQuota(policy, actor);
  if (!quota.allowed) {
    return res.status(429).json({
      error: `daily limit reached for role "${actor.role}" (${quota.used}/${quota.limit})`,
      suggestion: null,
      reason: 'quota'
    });
  }

  // Burned before the call, not after: a rewrite that is only spent on success
  // is a rewrite you can retry until it succeeds. The one exception is below.
  rewritten.add(auditId);

  const result = await mod.suggestRewrite(adapter(), {
    actor,
    prompt,
    decision: entry.decision,
    policy,
    onRecheck: emitDecision
  });

  // A generation that never produced text leaked nothing, so it does not cost
  // the attempt. Everything else did produce one, and that is where the
  // information an attacker would iterate on lives.
  if (result.reason === 'model-unavailable') rewritten.delete(auditId);

  res.json(result);
}));

/**
 * "This block was wrong."
 *
 * The other half of the same problem. A refusal already tells people to quote
 * their audit id if they disagree, and until now there was nowhere to quote it.
 * No model runs and no quota is charged: this is a person disagreeing, which
 * costs nothing and is worth more than most of what does.
 */
app.post('/api/guard/appeal', asyncRoute(async (req, res) => {
  const actor = resolveActor(req);
  if (!actor) return res.status(401).json(UNKNOWN_KEY);

  const auditId = typeof req.body?.auditId === 'string' ? req.body.auditId.trim() : '';
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  if (!auditId) return res.status(400).json({ error: 'auditId is required' });

  const entry = findDecision(auditId);
  if (!entry || entry.actor.id !== actor.id) {
    return res.status(403).json({ error: 'that decision is not yours to appeal' });
  }

  const appeal = recordAppeal({ auditId, employeeId: actor.id, ...(note ? { note } : {}) });
  if (!appeal) return res.status(409).json({ error: 'you have already reported this decision' });
  res.json(appeal);
}));

/**
 * What employees have reported as wrong, newest first.
 *
 * Joined back to the rule that fired, because the rule is the object the admin
 * has to go and edit — an appeal that only said "block 3f2a was wrong" would
 * leave them looking it up by hand, and nobody does that twice.
 */
app.get('/api/appeals', (_req, res) => {
  res.json(
    readAppeals()
      /**
       * Notes on held prompts belong to the review queue, not here.
       *
       * Both write the same record — one endpoint, one place employee text is
       * kept — but the employee meant different things by them. On a block it
       * is "this was wrong"; on a held prompt it is context for a decision
       * nobody has made yet. Listing the second under "reported as wrong"
       * misrepresents what they said, to the one person who acts on it.
       */
      .filter((appeal) => findDecision(appeal.auditId)?.decision.verdict !== 'ESCALATE')
      .map((appeal) => {
      const entry = findDecision(appeal.auditId);
      const rule = entry?.decision.firedRules?.[0];
      return {
        ...appeal,
        employeeName: findEmployee(appeal.employeeId)?.name ?? appeal.employeeId,
        verdict: entry?.decision.verdict ?? null,
        ruleId: rule?.ruleId ?? null,
        ruleText: rule?.ruleText ?? null
      };
      })
  );
});

// ── Audit + escalations ──────────────────────────────────────────────────────
app.get('/api/audit', asyncRoute(async (req, res) => {
  const mod = await optional<{ readAudit: (n: number) => Promise<unknown> }>('../audit/log.js');
  const readAudit = mod?.readAudit;
  if (!readAudit) return res.json([]);
  // `slice(-NaN)` is `slice(0)`, so an unparseable limit would dump the whole
  // chain. Clamp instead.
  const raw = Number(req.query['limit'] ?? 50);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 500) : 50;
  res.json(withRememberedPrompts(await readAudit(limit)));
}));

// The chain is the product's whole evidence claim, and evidence nobody can see
// is not evidence. `pnpm run verify-audit` recomputes it from the terminal; this
// is the same check, so the console can show it too.
app.get('/api/audit/verify', asyncRoute(async (_req, res) => {
  const mod = await optional<{ verifyChain: () => unknown }>('../audit/log.js');
  const verifyChain = mod?.verifyChain;
  if (!verifyChain) return res.json({ ok: true, entries: 0 });
  res.json(verifyChain());
}));

/**
 * What is held for review.
 *
 * These two routes existed as stubs — `[]` and an `ok: true` that recorded
 * nothing — while three different surfaces told employees their prompt was
 * queued for an administrator. They are real now, and they are deliberately
 * thin: the queue is derived from the audit log rather than stored a second
 * time, and this file only joins it to the answers.
 */
app.get('/api/escalations', asyncRoute(async (_req, res) => {
  const queue = await escalationQueue();
  res.json(
    queue.map((e) => ({
      ...e,
      employeeName: findEmployee(e.employeeId)?.name ?? e.employeeId
    }))
  );
}));

app.post('/api/escalations/:id', asyncRoute(async (req, res) => {
  const auditId = String(req.params['id']).trim();
  const outcome = req.body?.outcome;
  if (outcome !== 'approved' && outcome !== 'refused') {
    return res.status(400).json({ error: 'outcome must be "approved" or "refused"' });
  }

  // Only something actually held can be answered. Recording a review against an
  // id that was never escalated would put a decision in the queue that the
  // audit log has no matching entry for.
  const queue = await escalationQueue();
  if (!queue.some((e) => e.auditId === auditId)) {
    return res.status(404).json({ error: 'no decision is held for review under that audit id' });
  }

  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  const review = recordReview({ auditId, outcome: outcome as ReviewOutcome, ...(note ? { note } : {}) });
  if (!review) return res.status(409).json({ error: 'that escalation has already been answered' });

  res.json(review);
}));

// ── OpenAI-compatible proxy ──────────────────────────────────────────────────
app.get('/v1/models', (_req, res) => {
  res.json({ object: 'list', data: [{ id: 'warden', object: 'model', owned_by: 'warden' }] });
});

app.post('/v1/chat/completions', asyncRoute(async (req, res) => {
  const mod = await optional<{ handleChatCompletion: (rq: Request, rs: Response, e: (d: unknown) => void) => Promise<void> }>('../proxy/openai.js');
  const handleChatCompletion = mod?.handleChatCompletion;
  if (!handleChatCompletion) {
    // Until the proxy lands, run the guard so the console's chat pane is live.
    const decision = await evaluateRequest(req);
    // Null means nobody could be identified, and this branch used to fall
    // straight through it into the 200 below: an unrecognised API key was
    // answered "allowed" by the one path in the product that exists to refuse.
    // The guard never ran, so there was not even a verdict to be wrong.
    if (!decision) return res.status(401).json(UNKNOWN_KEY);
    emitDecision(decision);
    if ((decision as { verdict?: string }).verdict !== 'ALLOW') {
      return res.status(403).json({ error: { code: 'policy_block', decision } });
    }
    return res.json({
      id: 'stub', object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: '[stub] allowed — proxy not available' } }]
    });
  }
  await handleChatCompletion(req, res, emitDecision);
}));

// ── red team ─────────────────────────────────────────────────────────────────
// The last run is kept on disk so the console can show results without
// re-running a suite that takes minutes against a real model.
const RT_RESULT = isMock() ? 'data/redteam-last.mock.json' : 'data/redteam-last.json';

app.get('/api/redteam/report', (_req, res) => {
  const last = readSeedJson<unknown | null>(RT_RESULT, null);
  if (!last) return res.status(404).json({ error: 'no run yet — pnpm run redteam' });
  res.json(last);
});

let redteamRunning = false;

app.post('/api/redteam/run', asyncRoute(async (_req, res) => {
  // One at a time: overlapping runners race on REPORT.md and the result file,
  // and each spawn is a full corpus of model calls. The flag follows the child
  // process, not this request — a run that outlives the 120s response window
  // still holds the slot until it exits.
  if (redteamRunning) {
    return res.status(409).json({ error: 'a run is already in progress — use Load last report' });
  }
  redteamRunning = true;
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  // A compiled build (pnpm start, the desktop app) carries the runner as plain
  // JS next to this file; a source checkout runs the TS through the repo's
  // installed tsx instead. Either is invoked through this exact runtime,
  // because shell launchers (`npx`, `npm.cmd`) differ across platforms and can
  // emit ENOENT/EINVAL on Windows when spawned without a shell.
  const compiledRunner = fileURLToPath(new URL('../redteam/runner.js', import.meta.url));
  const tsx = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const runnerArgs = existsSync(compiledRunner)
    ? [compiledRunner]
    : existsSync(tsx)
      ? [tsx, 'src/redteam/runner.ts']
      : null;
  if (!runnerArgs) {
    redteamRunning = false;
    return res.status(501).json({ error: 'the red-team runner is not part of this build' });
  }
  const child = spawn(process.execPath, runnerArgs, {
    cwd: process.cwd(),
    // The runner is a second process; sharing the server's audit file would
    // interleave two hash chains and "break" the log from ordinary use.
    // ELECTRON_RUN_AS_NODE is inert under plain Node and makes the Electron
    // binary behave as Node when the gateway runs inside the desktop app.
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WARDEN_AUDIT_PATH: 'data/audit-redteam.jsonl',
      WARDEN_BENCHMARK_POLICY:
        process.env['WARDEN_BENCHMARK_POLICY'] ?? join(ASSETS, 'data', 'seed', 'benchmark-policy.json')
    },
    stdio: 'ignore',
    detached: false,
    windowsHide: true
  });
  // The slot is released by the child ending, not by this request returning, so
  // a run that outlives the response window still holds it. Registered once,
  // before the race, because an 'error' with no listener at all — a missing
  // runtime — would take down the whole gateway rather than failing this one
  // request.
  child.once('error', () => { redteamRunning = false; });
  child.once('exit', () => { redteamRunning = false; });

  // Long enough that a mock run finishes inline; a real-model run keeps going
  // and the console picks it up from disk on the next "Load last report".
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    new Promise<{ finished: true; error?: string }>((resolve) => {
      child.once('error', (err) => resolve({ finished: true, error: err.message }));
      child.once('exit', (code) => resolve({
        finished: true,
        error: code === 0 ? undefined : `runner exited with code ${code ?? 'unknown'}`
      }));
    }),
    new Promise<{ finished: false }>((resolve) => {
      timer = setTimeout(() => resolve({ finished: false }), 120_000);
    })
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.finished && outcome.error) {
    return res.status(500).json({ error: `red-team run failed: ${outcome.error}` });
  }
  const last = readSeedJson<unknown | null>(RT_RESULT, null);
  if (!last) {
    return res.status(outcome.finished ? 500 : 202).json({
      error: outcome.finished ? 'run produced no result' : 'still running — use Load last report in a minute'
    });
  }
  res.json(last);
}));

// ── employee install ─────────────────────────────────────────────────────────
// Three manual steps become one command. Every value an employee retypes is a
// value they can get wrong, and an API key is the least forgiving of them.

/**
 * The hook, served by the gateway itself.
 *
 * Until now the onboarding pack told employees to curl it from GitHub, which
 * quietly made a public-internet round trip a prerequisite for a product whose
 * entire claim is that nothing leaves the network. On conference wifi behind a
 * captive portal, or in a demo with egress blocked, that step is where the
 * setup dies. The gateway already has the file.
 */
/**
 * The OpenCode plugin, served like the hook is.
 *
 * `warden-hook --fix` fetches this rather than carrying a copy of it: two
 * sources of the same file disagree within a release, which is the reason the
 * install script curls the hook instead of vendoring it too.
 */
app.get('/integrations/opencode/warden.js', (_req, res) => {
  try {
    res.type('application/javascript').send(
      readFileSync(join(ASSETS, 'integrations', 'opencode', 'warden.js'), 'utf8')
    );
  } catch {
    res.status(404).type('text/plain').send('// not bundled in this build\n');
  }
});

app.get('/warden-hook.mjs', (_req, res) => {
  try {
    res.type('application/javascript').send(readFileSync(join(ASSETS, 'integrations', 'warden-hook.mjs'), 'utf8'));
  } catch {
    res.status(404).json({ error: 'hook file not found next to the server' });
  }
});

app.get('/install/:credential', (req, res) => {
  const id = String(req.params['credential']);
  // Resolved against the directory rather than echoed back. A made-up id must
  // not produce a script that configures somebody the gateway has never heard
  // of — that account would be judged as a stranger, which is the exact failure
  // this route exists to prevent. The id is also never interpolated unless it
  // matches the shape `uniqueId` generates: this response is piped into `sh`,
  // so anything echoed back verbatim is one URL-encoded newline away from
  // being executed on an employee's laptop.
  // Token first: that is the form employees are given, and the only form that
  // reaches here without an administrator behind it. The id form still works
  // for the admin's own console and the quickstart, and `needsAdmin` is what
  // keeps it to them.
  const person =
    findByInstallToken(id) ?? (/^[a-z0-9][a-z0-9-]*$/.test(id) ? findEmployee(id) : null);
  if (!person) {
    return res
      .status(404)
      .type('text/plain')
      .send('# No such employee in the directory. Ask your admin for the right link.\nexit 1\n');
  }

  const url = gatewayUrl(req);
  // The key is the identity, so it has to be here. That makes this URL a
  // credential: it is only ever shown to the admin, inside the console, for a
  // person who already exists. The alternative — the employee pasting a key by
  // hand — is the step that gets mistyped.
  //
  // The name appears in a script comment and an echo, and this whole response
  // is piped into `sh`. It is admin-authored, but "admin-authored" reaches here
  // through an API, so anything that could close the comment or open a command
  // substitution is stripped rather than trusted.
  const safeName = person.name.replace(/[^\p{L}\p{N} .,()-]/gu, '');
  res.type('text/plain').send(`#!/bin/sh
# Warden setup for ${safeName} (${person.role})
set -e

HOOK="$HOME/.warden-hook.mjs"
echo "Downloading the Warden hook…"
curl -fsSL "${url}/warden-hook.mjs" -o "$HOOK"
chmod +x "$HOOK"

PROFILE="$HOME/.zshrc"
[ -n "$BASH_VERSION" ] && PROFILE="$HOME/.bashrc"
[ -f "$PROFILE" ] || PROFILE="$HOME/.profile"

# Idempotent: re-running after a role change or a new gateway address replaces
# the old block instead of stacking a second, contradictory one.
if grep -q "# >>> warden >>>" "$PROFILE" 2>/dev/null; then
  echo "Updating the existing Warden block in $PROFILE"
  sed -i.warden-bak '/# >>> warden >>>/,/# <<< warden <<</d' "$PROFILE"
fi

cat >> "$PROFILE" <<'WARDEN_BLOCK'
# >>> warden >>>
export WARDEN_URL=${url}
export WARDEN_API_KEY=${person.apiKey}
# <<< warden <<<
WARDEN_BLOCK

echo ""
echo "Done. Hook at $HOOK, environment in $PROFILE."
echo "Open a new terminal (or: source $PROFILE)."

# What is on this machine, and then wiring it. --fix adds the hook to the tools
# it finds, backs up every file it touches to <file>.warden-bak first, leaves
# anything already wired alone, and prints each thing it did — so the install
# ends on an inventory that says "governed" instead of on a sentence telling
# them to go and configure three programs by hand.
#
# \`|| true\` covers a machine with no node, which would be a strange place to
# be installing a node hook but is not a reason for the install to end red.
node "$HOOK" --fix || true

echo "Anything it could not wire: ${url}  ->  People  ->  ${safeName}  ->  Onboarding"
`);
});

// ── static console ───────────────────────────────────────────────────────────
app.use(express.static(join(ASSETS, 'web')));

/**
 * Warmth of the models `preloadModels` owns. `cold` covers mock mode and
 * WARDEN_WARMUP=0 as well as "not started yet" — the desktop splash treats
 * anything other than `loading` as "stop waiting and open the console".
 */
let modelState: 'cold' | 'loading' | 'ready' | 'failed' = 'cold';

// `mode` is surfaced for the same reason `mock` is: a gateway running with the
// guard switched off (`WARDEN_MODE=baseline`) must not present an identical
// green UI to one that is enforcing.
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    mock: isMock(),
    // How long an administrator can read a prompt for. On /health because it
    // is a property of this deployment, and the console has to be able to say
    // it out loud on the screen where the text is shown.
    prompts: promptsEnabled() ? retentionSummary() : null,
    mode: process.env['WARDEN_MODE'] === 'baseline' ? 'baseline' : 'warden',
    models: modelState,
    // Whether there is a desktop shell listening that could actually fetch the
    // models. In a browser against a checkout there is not, and the console has
    // to offer the command instead of a button that would do nothing.
    canLeaveDemo: parentPort !== undefined
  })
);

/**
 * Leave demo mode: fetch the models and restart into real inference.
 *
 * This existed only as `Gateway → Download models & leave demo mode…` in the
 * desktop menu bar. The banner on every screen told people where that was and
 * they did not find it, which is a fair outcome for a menu three levels into a
 * submenu nobody opens — "I can't see where to download the models" is the
 * report, and the answer is a button where the sentence about it already is.
 *
 * The console window deliberately has no preload — it is the same console a
 * browser gets, and giving it Electron powers would end that. So the request
 * goes to the gateway, which already holds a message channel to the desktop
 * shell for shutdown, and the shell does the work. A browser pointed at the
 * gateway reaches the same route and gets the same thing, which is correct:
 * it is the machine holding the models that downloads them.
 *
 * Administrative like everything not on the employee allowlist. It has exactly
 * the power the menu item has, and the menu item is on the same machine.
 */
/**
 * The last lines the gateway wrote, for the screen that just failed.
 *
 * When a model will not load, the reason is in this file and nowhere else, and
 * the file is behind `Gateway -> View gateway log` in the menu bar, which is
 * the same place the download button was hiding and just as hard to find. The
 * console shows the tail instead.
 *
 * Administrative, and it is worth saying why that is enough: the log holds the
 * gateway's own stdout, which carries decisions as verdict plus rule id plus
 * timing, never prompt text. Same promise the audit chain makes.
 */
app.get('/api/gateway/log', (_req, res) => {
  const path = process.env['WARDEN_LOG_PATH'];
  if (!path) return res.status(404).json({ error: 'this gateway does not write to a log file' });
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    res.json({ path, lines: lines.slice(-200) });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'log unreadable' });
  }
});

app.post('/api/gateway/leave-demo', (_req, res) => {
  if (!parentPort) {
    return res.status(409).json({ error: 'No desktop app here. Run `pnpm run setup` instead.' });
  }
  parentPort.postMessage('leave-demo');
  res.status(202).json({ ok: true });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\nWarden  (adapter=${adapterName()})`);
  console.log(`  local     http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  network   http://${ip}:${PORT}   <- teammates point here`);
  }
  console.log(`  policy    ${loadPolicy().rules.length} rules · ${loadPolicy().quotas.length} quotas`);
  console.log(`  console   open the local or network URL in a browser\n`);
  preloadModels();
});

/**
 * Exit paths. The QVAC worker is a separate OS process the SDK spawns; exiting
 * without `shutdown()` leaves it orphaned — which is exactly what a plain
 * Ctrl-C did until now. The desktop app depends on this handler too: it asks
 * for a graceful stop (message or SIGTERM), waits a few seconds, then
 * force-kills whatever is left.
 */
let exiting = false;
function gracefulExit(): void {
  if (exiting) return;
  exiting = true;
  server.close();
  const finish = (): void => process.exit(0);
  // A wedged model unload must not outlive the desktop app's five-second
  // patience — leaving cleanly at four beats being force-killed at five.
  setTimeout(finish, 4000).unref();
  if (isMock()) {
    finish();
    return;
  }
  void import('../qvac/client.js')
    .then(({ shutdown }) => shutdown())
    .catch(() => undefined)
    .then(finish);
}
process.on('SIGTERM', gracefulExit);
process.on('SIGINT', gracefulExit);
// Under Electron's utilityProcess the desktop shell owns a message channel to
// this process. Plain Node has no `parentPort`, so it is feature-detected, and
// Electron wraps each message in a MessageEvent while a bare value is accepted
// too in case that wrapper ever changes.
const parentPort = (
  process as unknown as {
    parentPort?: {
      on: (ev: 'message', fn: (msg: unknown) => void) => void;
      postMessage: (msg: unknown) => void;
    };
  }
).parentPort;
parentPort?.on('message', (msg) => {
  const data = msg && typeof msg === 'object' && 'data' in msg ? (msg as { data: unknown }).data : msg;
  if (data === 'shutdown') gracefulExit();
});

/**
 * Load the models the hot path needs, at boot, before anyone asks.
 *
 * Until now nothing called `warmup()`, so the first employee prompt of the day
 * paid for loading a GGUF inside the decision it was waiting on. Measured on
 * the 2026-08-23 verification run: a cold decision took 25-27s against 7s hot,
 * and a cold Codex evaluation reached 36s — past the hook's 30s deadline, so
 * the hook failed open and the prompt reached the model while Warden was still
 * deciding. That is the guard being bypassed by a stopwatch, and the load it
 * was waiting for had no reason to happen then rather than at boot.
 *
 * Deliberately not awaited: the console and the API come up immediately, and a
 * request that arrives mid-load joins the same in-flight promise rather than
 * starting a second one. A failure is logged and left alone — `modelFor` drops
 * a rejected load so the next request retries it, and a gateway that refuses to
 * start because a model is missing is worse than one that is slow.
 *
 * `adjudicator` and `embedder` are what every decision touches. `ocr` is only
 * for attachments and costs a load nobody may need.
 */
function preloadModels(): void {
  if (isMock() || process.env['WARDEN_WARMUP'] === '0') return;

  const started = Date.now();
  modelState = 'loading';
  console.log('  models    preloading adjudicator + embedder…');
  void import('../qvac/client.js')
    .then(({ warmup }) => warmup(['adjudicator', 'embedder']))
    .then(() => {
      modelState = 'ready';
      console.log(`  models    ready in ${((Date.now() - started) / 1000).toFixed(1)}s — decisions are warm\n`);
    })
    .catch((err: unknown) => {
      modelState = 'failed';
      console.error(
        `  models    preload failed (${err instanceof Error ? err.message : String(err)}).` +
        ' The first request will load them instead, and will be slow.\n'
      );
    });
}

/**
 * The address to hand an employee.
 *
 * Taken from the request the console made, because that is by construction an
 * address that reached this server. Guessing from the interface list gets it
 * wrong on a machine with several, and an onboarding pack with the wrong host
 * fails in the least helpful way possible: silently, on someone else's laptop.
 */
function gatewayUrl(req: Request): string {
  const configured = process.env['WARDEN_PUBLIC_URL'];
  if (configured) return configured.replace(/\/$/, '');
  // The Host header is written by the caller, and this URL is interpolated into
  // shell scripts and generated configs — so only a plain host[:port] shape is
  // accepted here. Anything else falls through to an interface address rather
  // than reaching a file somebody runs.
  const rawHost = req.header('host');
  const host = rawHost && /^[A-Za-z0-9.-]+(:\d+)?$/.test(rawHost) ? rawHost : undefined;
  if (host && !/^(localhost|127\.0\.0\.1)/.test(host)) {
    /**
     * Behind a tunnel — Cloudflare, Tailscale Funnel, ngrok — the edge
     * terminates TLS and forwards plain HTTP, so the scheme this process sees
     * is not the scheme the employee needs. Hardcoding `http://` there produces
     * an install command that fails on every machine except the one that
     * generated it, which is the worst kind of wrong: it looks right in the
     * console.
     *
     * `x-forwarded-proto` is set by the tunnel, not by the client, and it is
     * only read to build a URL — nothing is authorised on it — so trusting it
     * here costs nothing even if something else sets it.
     */
    const proto = req.header('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'http';
    return `${proto === 'https' ? 'https' : 'http'}://${host}`;
  }

  // The console is open on the gateway machine itself, so localhost is what it
  // sees — but localhost is useless to everyone else. Prefer a LAN address.
  const lan = lanAddresses()[0];
  return lan ? `http://${lan}:${PORT}` : `http://${host ?? `localhost:${PORT}`}`;
}

/** Non-internal IPv4 addresses, so the banner tells teammates where to point. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((ifaces) => ifaces ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Load a module that may not exist yet.
 *
 * Routes are wired against the frozen contract before everything behind them is
 * written, so the console can be built in parallel. A missing module yields
 * null and the route answers with an explicit "not wired" status instead of
 * pretending to work.
 */
const failedImports = new Set<string>();

async function optional<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch (err) {
    // A module that exists but crashes on load is very different from one not
    // written yet, and swallowing the error made the two indistinguishable — a
    // broken transitive import would quietly demote the guard to its stub.
    // Logged once per specifier so a hot route does not flood the terminal.
    if (!failedImports.has(specifier)) {
      failedImports.add(specifier);
      console.error(`optional module ${specifier} failed to load:`, err);
    }
    return null;
  }
}

/**
 * Run the guard for a request, whatever shape it arrived in. Falls back to a
 * shape-correct stub while the pipeline is unavailable, so dependents
 * see the real contract immediately.
 */
/**
 * The session consumption the client claims, cleaned before it is believed.
 *
 * Everything here arrives from the employee's machine, so it is read the way
 * every other client field is: shape-checked, never trusted for identity, and
 * never able to make a verdict looser. A negative or absurd number is dropped
 * rather than clamped — a client sending nonsense is a client Warden cannot
 * measure, and `unreported` says exactly that instead of drawing a bar.
 *
 * There is no path here that widens a ceiling. The numbers only ever push a
 * decision toward ESCALATE.
 */
function reportedUsage(
  body: unknown
): { outputTokens?: number; contextTokens?: number; source?: string; model?: string } | undefined {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>)['usage'] : undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;

  const count = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
      ? Math.floor(v)
      : undefined;

  const outputTokens = count(u['outputTokens']);
  const contextTokens = count(u['contextTokens']);
  const source = typeof u['source'] === 'string' ? u['source'].slice(0, 40) : undefined;
  /**
   * Truncated and never trusted, like `source` beside it.
   *
   * A model name is self-reported by a tool reading a file on the employee's
   * own machine, so it belongs in the record and nowhere near a decision.
   * Bounded because it lands in the audit log: an unbounded string from a
   * caller is a way to write megabytes into the governance chain one request
   * at a time.
   */
  const model = typeof u['model'] === 'string' ? u['model'].slice(0, 60) : undefined;
  if (outputTokens === undefined && contextTokens === undefined) return undefined;

  return {
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(source ? { source } : {}),
    ...(model ? { model } : {})
  };
}

async function evaluateRequest(req: Request): Promise<unknown> {
  const actor = resolveActor(req);
  if (!actor) return null;
  const prompt = extractPrompt(req.body);

  const mod = await optional<{ evaluate: (a: unknown, i: unknown, p: unknown) => Promise<unknown> }>('../guard/pipeline.js');
  const evaluate = mod?.evaluate;
  if (evaluate) {
    return evaluate(adapter(), { actor, prompt, usage: reportedUsage(req.body) }, loadPolicy());
  }

  // Stub: exercises the rule set so the console shows real rule names, without
  // the full pipeline. Clearly labelled as a stub in the trace — and it
  // escalates, because "the guard could not run" must never read as "the guard
  // cleared it". An ALLOW here would be the early-allow the whole design
  // forbids, reachable by nothing more than a broken import. The prompt is not
  // echoed back either: no sanitize pass ran, so nothing here may claim to be
  // masked text.
  const rules = rulesForActor(loadPolicy(), actor);
  return {
    verdict: 'ESCALATE', auditId: 'stub', policyVersion: loadPolicy().version, totalMs: 0,
    firedRules: [], maskedPrompt: '', maskedSpans: [],
    passes: [{ pass: 'stub', ms: 0, verdict: 'ESCALATE', failedClosed: true, detail: { rulesConsidered: rules.length } }],
    explanation: 'The guard pipeline is unavailable — held for review rather than assumed clean.'
  };
}

/**
 * Who is asking. The API key is the entire answer.
 *
 * Nothing an employee can type identifies them. They do not send a name and do
 * not send a role, because both were things they could edit — and a role you
 * can edit is a role you can use to pick the rules that judge you. The admin
 * issues a key, decides what it means, and can change the role behind it
 * without the employee touching their machine. Rotating the key revokes the
 * old one.
 *
 * Null means refuse. There is no default identity and no assumed role: a caller
 * nobody can identify is not a caller to guess about.
 */
function resolveActor(req: Request): { id: string; role: string } | null {
  const employee = actorForCredential(req.header('authorization'));
  return employee ? { id: employee.id, role: employee.role } : null;
}

function extractPrompt(body: unknown): string {
  const b = body as { prompt?: string; user_input?: string; messages?: { role: string; content: string }[] };
  if (typeof b?.prompt === 'string') return b.prompt;
  if (typeof b?.user_input === 'string') return b.user_input;
  const lastUser = b?.messages?.filter((m) => m.role === 'user').at(-1);
  return lastUser?.content ?? '';
}

/**
 * Read an optional JSON file, falling back when it is absent.
 *
 * Several files here are authored by the team rather than generated, so a
 * missing one is a normal state during a build-out, not an error worth failing
 * a request over.
 */
function readSeedJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Wrap an async route so a rejected promise becomes a 500 instead of a hang. */
/**
 * Is this failure the model not running, rather than the model not answering?
 *
 * They read identically in a stack trace and they need opposite advice from the
 * person in front of the console. A prompt the model could not turn into a rule
 * is worth rephrasing; a worker process that never started is not, and telling
 * somebody to "try saying it more plainly" when the SDK's RPC timed out after
 * 30 seconds sends them to rewrite a sentence that was never the problem.
 *
 * Matched on the SDK's own wording plus our load timeout and cooldown, because
 * neither carries a code. It is a heuristic and it errs toward the infra
 * reading: a false positive costs one line of unnecessary advice about the
 * gateway log, a false negative sends somebody in a circle.
 */
function looksLikeModelDown(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('rpc initialization') ||
    m.includes('worker process') ||
    m.includes('failed to load') ||
    m.includes('not being retried') ||
    m.includes('plugin not found') ||
    m.includes('loading the') ||
    m.includes('model not found')
  );
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      console.error('route error:', err);
      // The message alone, not `String(err)`: this text is rendered straight
      // into the console, and "Error: audience names nobody…" reads as a crash
      // where "audience names nobody…" reads as the instruction it is.
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({
          error: message,
          // The console renders different advice for each, so the classification
          // happens here where the error is, not by matching strings in the UI.
          kind: looksLikeModelDown(message) ? 'model-down' : 'other'
        });
      }
    });
  };
}
