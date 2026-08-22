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
  findEmployee
} from '../policy/people.js';
import { loadPolicy, rulesForActor, savePolicy, seedIfEmpty } from '../policy/store.js';
import { bindsActor, describeAudience } from '../policy/audience.js';
import { activityFor, connectedCount, recordActivity } from '../policy/activity.js';
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

// Local-first tool: allow the web console (a different dev port) to call the API.
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'content-type, authorization, x-warden-user, x-warden-role');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  next();
});
app.options(/.*/, (_req, res) => res.sendStatus(204));

// Seed the demo policy on boot if the store is empty, so a fresh clone has
// something to show without a manual step.
try {
  seedIfEmpty('data/seed/policies.seed.json');
} catch {
  /* seed file not present yet — the store stays empty, which is a valid state */
}

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
  for (const client of sseClients) client.write(payload);
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
  const mod = await optional<{ previewRule: (a: unknown, r: unknown, p: unknown) => Promise<unknown> }>('../policy/compile.js');
  const previewRule = mod?.previewRule;
  if (!previewRule) return res.status(503).json({ error: 'preview not wired yet (OPE-7)' });
  res.json(await previewRule(adapter(), req.body?.rule, loadPolicy()));
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
  const decision = await evaluateRequest(req);
  // The hook names the tool it came from; that sighting is what the console's
  // "connected" badges are built from.
  recordActivity(
    String(req.header('x-warden-user') ?? req.body?.actor?.id ?? ''),
    typeof req.body?.source === 'string' ? req.body.source : undefined
  );
  emitDecision(decision);
  res.json(decision);
}));

// ── Audit + escalations ──────────────────────────────────────────────────────
app.get('/api/audit', asyncRoute(async (req, res) => {
  const mod = await optional<{ readAudit: (n: number) => Promise<unknown> }>('../audit/log.js');
  const readAudit = mod?.readAudit;
  if (!readAudit) return res.json([]);
  res.json(await readAudit(Number(req.query['limit'] ?? 50)));
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
const RT_RESULT = 'data/redteam-last.json';

app.get('/api/redteam/report', (_req, res) => {
  const last = readSeedJson<unknown | null>(RT_RESULT, null);
  if (!last) return res.status(404).json({ error: 'no run yet — npm run redteam' });
  res.json(last);
});

app.post('/api/redteam/run', asyncRoute(async (_req, res) => {
  const { spawn } = await import('node:child_process');
  const child = spawn('npx', ['tsx', 'src/redteam/runner.ts'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
    detached: false
  });
  // Long enough that a mock run finishes inline; a real-model run keeps going
  // and the console picks it up from disk on the next "Load last report".
  const finished = await Promise.race([
    new Promise<boolean>((r) => child.on('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 120_000))
  ]);
  const last = readSeedJson<unknown | null>(RT_RESULT, null);
  if (!last) {
    return res.status(finished ? 500 : 202).json({
      error: finished ? 'run produced no result' : 'still running — use Load last report in a minute'
    });
  }
  res.json(last);
}));

// ── static console ───────────────────────────────────────────────────────────
app.use(express.static('web'));

app.get('/health', (_req, res) => res.json({ ok: true, mock: isMock() }));

app.listen(PORT, HOST, () => {
  console.log(`\nWarden  (adapter=${isMock() ? 'mock' : 'real'})`);
  console.log(`  local     http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  network   http://${ip}:${PORT}   <- teammates point here`);
  }
  console.log(`  policy    ${loadPolicy().rules.length} rules · ${loadPolicy().quotas.length} quotas`);
  console.log(`  console   open the local or network URL in a browser\n`);
});

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
  const host = req.header('host');
  if (host && !/^(localhost|127\.0\.0\.1)/.test(host)) return `http://${host}`;
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
async function optional<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
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
  const prompt = extractPrompt(req.body);

  const mod = await optional<{ evaluate: (a: unknown, i: unknown, p: unknown) => Promise<unknown> }>('../guard/pipeline.js');
  const evaluate = mod?.evaluate;
  if (evaluate) return evaluate(adapter(), { actor, prompt }, loadPolicy());

  // Stub: exercises the rule set so the console shows real rule names, without
  // the full pipeline. Clearly labelled as a stub in the trace.
  const rules = rulesForActor(loadPolicy(), actor);
  return {
    verdict: 'ALLOW', auditId: 'stub', policyVersion: loadPolicy().version, totalMs: 0,
    firedRules: [], maskedPrompt: prompt, maskedSpans: [], passes: [{ pass: 'stub', ms: 0, detail: { rulesConsidered: rules.length } }],
    explanation: 'pipeline not wired yet (OPE-8)'
  };
}

/**
 * Who is asking.
 *
 * The directory has the last word on the role. An employee sets WARDEN_ROLE on
 * their own machine, so a claimed role is a request, not a fact — if the header
 * decided it, anyone could pick the rule set they are judged against by editing
 * their shell profile. A caller the directory has never seen keeps the role they
 * claim, because a visitor with no entry is better judged by a plausible role
 * than by none at all.
 */
function resolveActor(req: Request): { id: string; role: string } {
  const id = String(req.header('x-warden-user') ?? req.body?.actor?.id ?? 'anon');
  const claimed = String(req.header('x-warden-role') ?? req.body?.actor?.role ?? 'employee');
  try {
    const known = findEmployee(id);
    if (known) return { id: known.id, role: known.role };
  } catch {
    /* no directory on disk yet — fall through to the claimed role */
  }
  return { id, role: claimed };
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
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    });
  };
}
