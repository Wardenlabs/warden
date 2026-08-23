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
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import express, { type Request, type Response } from 'express';
import { adapter, isMock } from '../qvac/index.js';
import {
  addRole,
  loadDirectory,
  removeEmployee,
  removeRole,
  rotateApiKey,
  upsertEmployee,
  findEmployee,
  actorForCredential
} from '../policy/people.js';
import { loadPolicy, rulesForActor, savePolicy, seedIfEmpty } from '../policy/store.js';
import { bindsActor, describeAudience } from '../policy/audience.js';
import { activityFor, connectedCount, recordActivity } from '../policy/activity.js';
import { readAppeals, recordAppeal } from '../policy/appeals.js';
import { findDecision } from '../audit/log.js';
import { checkQuota } from '../guard/quota.js';
import type { RewriteRefusal, RewriteResult } from '../guard/rewrite.js';
import { onboardingFor, supportedTools } from '../onboarding/index.js';

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

const app = express();
app.use(express.json({ limit: '4mb' }));

/**
 * The console is served by this same process, so same-origin needs no CORS at
 * all. The wildcard that used to sit here let any web page an admin happened to
 * visit read the directory and post policy changes cross-origin — the admin API
 * has no authentication, so the browser's origin check was the only thing
 * standing in the way. Serving web/ from a separate dev port is the one case
 * that needs an exception, and it is opt-in and explicit.
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

// Seed the demo policy on boot if the store is empty, so a fresh clone has
// something to show without a manual step.
try {
  seedIfEmpty('data/seed/policies.seed.json');
} catch {
  /* seed file not present yet — the store stays empty, which is a valid state */
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
export function emitDecision(decision: unknown): void {
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
  // Served from Fede's catalog (OPE-18) once present; empty array until then so
  // the console renders an empty catalog rather than erroring.
  res.json(readSeedJson('data/seed/presets.json', []));
});

app.post('/api/policy/draft', asyncRoute(async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const mod = await optional<{
    compileRule: (a: unknown, t: string, p: unknown, o?: unknown) => Promise<unknown>;
  }>('../policy/compile.js');
  const compileRule = mod?.compileRule;
  if (!compileRule) return res.status(503).json({ error: 'compiler not wired yet (OPE-7)' });
  // `lockTo` is set when the admin writes a rule from inside one person's page.
  // They already said who it is for by being there.
  const lockTo = Array.isArray(req.body?.lockTo) ? req.body.lockTo.map(String) : undefined;
  res.json(await compileRule(adapter(), text, loadPolicy(), lockTo ? { lockTo } : {}));
}));

app.post('/api/policy/preview', asyncRoute(async (req, res) => {
  const mod = await optional<{
    previewRule: (a: unknown, r: unknown, p: unknown, x?: unknown) => Promise<unknown>;
  }>('../policy/compile.js');
  const previewRule = mod?.previewRule;
  if (!previewRule) return res.status(503).json({ error: 'preview not wired yet (OPE-7)' });
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
  if (!ratifyRule) return res.status(503).json({ error: 'ratify not wired yet (OPE-7)' });
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
      const applicable = rulesForActor(policy, e);
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
    readAppeals().map((appeal) => {
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
  res.json(await readAudit(limit));
}));

// The chain is the product's whole evidence claim, and evidence nobody can see
// is not evidence. `npm run verify-audit` recomputes it from the terminal; this
// is the same check, so the console can show it too.
app.get('/api/audit/verify', asyncRoute(async (_req, res) => {
  const mod = await optional<{ verifyChain: () => unknown }>('../audit/log.js');
  const verifyChain = mod?.verifyChain;
  if (!verifyChain) return res.json({ ok: true, entries: 0 });
  res.json(verifyChain());
}));

app.get('/api/escalations', (_req, res) => res.json([]));
app.post('/api/escalations/:id', (req, res) => res.json({ id: req.params.id, ok: true }));

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
    emitDecision(decision);
    if (decision && (decision as { verdict?: string }).verdict !== 'ALLOW') {
      return res.status(403).json({ error: { code: 'policy_block', decision } });
    }
    return res.json({
      id: 'stub', object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: '[stub] allowed — proxy not wired yet (OPE-9)' } }]
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
  if (!last) return res.status(404).json({ error: 'no run yet — npm run redteam' });
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
  // Invoke the installed TSX entry point through this exact Node runtime.
  // Shell launchers (`npx`, `npm.cmd`) differ across platforms and can emit
  // ENOENT/EINVAL on Windows when spawned without a shell.
  const tsx = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsx, 'src/redteam/runner.ts'], {
    cwd: process.cwd(),
    // The runner is a second process; sharing the server's audit file would
    // interleave two hash chains and "break" the log from ordinary use.
    env: { ...process.env, WARDEN_AUDIT_PATH: 'data/audit-redteam.jsonl' },
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
app.get('/warden-hook.mjs', (_req, res) => {
  try {
    res.type('application/javascript').send(readFileSync('integrations/warden-hook.mjs', 'utf8'));
  } catch {
    res.status(404).json({ error: 'hook file not found next to the server' });
  }
});

app.get('/install/:employeeId', (req, res) => {
  const id = String(req.params['employeeId']);
  // Resolved against the directory rather than echoed back. A made-up id must
  // not produce a script that configures somebody the gateway has never heard
  // of — that account would be judged as a stranger, which is the exact failure
  // this route exists to prevent. The id is also never interpolated unless it
  // matches the shape `uniqueId` generates: this response is piped into `sh`,
  // so anything echoed back verbatim is one URL-encoded newline away from
  // being executed on an employee's laptop.
  const person = /^[a-z0-9][a-z0-9-]*$/.test(id) ? findEmployee(id) : null;
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
echo "Open a new terminal (or: source $PROFILE), then wire up your tool."
echo "Setup per tool: ${url}  ->  People  ->  ${safeName}  ->  Onboarding"
`);
});

// ── static console ───────────────────────────────────────────────────────────
app.use(express.static('web'));

// `mode` is surfaced for the same reason `mock` is: a gateway running with the
// guard switched off (`WARDEN_MODE=baseline`) must not present an identical
// green UI to one that is enforcing.
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    mock: isMock(),
    mode: process.env['WARDEN_MODE'] === 'baseline' ? 'baseline' : 'warden'
  })
);

app.listen(PORT, HOST, () => {
  console.log(`\nWarden  (adapter=${isMock() ? 'mock' : 'real'})`);
  console.log(`  local     http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  network   http://${ip}:${PORT}   <- teammates point here`);
  }
  console.log(`  policy    ${loadPolicy().rules.length} rules · ${loadPolicy().quotas.length} quotas`);
  console.log(`  console   open the local or network URL in a browser\n`);
  preloadModels();
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
  console.log('  models    preloading adjudicator + embedder…');
  void import('../qvac/client.js')
    .then(({ warmup }) => warmup(['adjudicator', 'embedder']))
    .then(() => {
      console.log(`  models    ready in ${((Date.now() - started) / 1000).toFixed(1)}s — decisions are warm\n`);
    })
    .catch((err: unknown) => {
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
 * shape-correct stub while the pipeline (OPE-8) is being built, so dependents
 * see the real contract immediately.
 */
async function evaluateRequest(req: Request): Promise<unknown> {
  const actor = resolveActor(req);
  if (!actor) return null;
  const prompt = extractPrompt(req.body);

  const mod = await optional<{ evaluate: (a: unknown, i: unknown, p: unknown) => Promise<unknown> }>('../guard/pipeline.js');
  const evaluate = mod?.evaluate;
  if (evaluate) return evaluate(adapter(), { actor, prompt }, loadPolicy());

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
function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      console.error('route error:', err);
      // The message alone, not `String(err)`: this text is rendered straight
      // into the console, and "Error: audience names nobody…" reads as a crash
      // where "audience names nobody…" reads as the instruction it is.
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  };
}
