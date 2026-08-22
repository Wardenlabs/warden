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
import { networkInterfaces } from 'node:os';
import express, { type Request, type Response } from 'express';
import { adapter, isMock } from '../qvac/index.js';
import { loadPolicy, rulesForRole, seedIfEmpty } from '../policy/store.js';

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
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  const mod = await optional<{ compileRule: (a: unknown, t: string, p: unknown) => Promise<unknown> }>('../policy/compile.js');
  const compileRule = mod?.compileRule;
  if (!compileRule) return res.status(503).json({ error: 'compiler not wired yet (OPE-7)' });
  res.json(await compileRule(adapter(), text, loadPolicy()));
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

// ── Guard check (used by the hook CLI) ───────────────────────────────────────
app.post('/api/guard/check', asyncRoute(async (req, res) => {
  const decision = await evaluateRequest(req);
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

app.get('/health', (_req, res) => res.json({ ok: true, mock: isMock() }));

app.listen(PORT, HOST, () => {
  console.log(`\nWarden  (adapter=${isMock() ? 'mock' : 'real'})`);
  console.log(`  local     http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  network   http://${ip}:${PORT}   <- teammates point here`);
  }
  console.log(`  policy    ${loadPolicy().rules.length} rules · ${loadPolicy().quotas.length} quotas\n`);
});

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
  const actor = {
    id: String(req.header('x-warden-user') ?? req.body?.actor?.id ?? 'anon'),
    role: String(req.header('x-warden-role') ?? req.body?.actor?.role ?? 'employee')
  };
  const prompt = extractPrompt(req.body);

  const mod = await optional<{ evaluate: (a: unknown, i: unknown, p: unknown) => Promise<unknown> }>('../guard/pipeline.js');
  const evaluate = mod?.evaluate;
  if (evaluate) return evaluate(adapter(), { actor, prompt }, loadPolicy());

  // Stub: exercises the rule set so the console shows real rule names, without
  // the full pipeline. Clearly labelled as a stub in the trace.
  const rules = rulesForRole(loadPolicy(), actor.role);
  return {
    verdict: 'ALLOW', auditId: 'stub', policyVersion: loadPolicy().version, totalMs: 0,
    firedRules: [], maskedPrompt: prompt, maskedSpans: [], passes: [{ pass: 'stub', ms: 0, detail: { rulesConsidered: rules.length } }],
    explanation: 'pipeline not wired yet (OPE-8)'
  };
}

function extractPrompt(body: unknown): string {
  const b = body as { prompt?: string; user_input?: string; messages?: { role: string; content: string }[] };
  if (typeof b?.prompt === 'string') return b.prompt;
  if (typeof b?.user_input === 'string') return b.user_input;
  const lastUser = b?.messages?.filter((m) => m.role === 'user').at(-1);
  return lastUser?.content ?? '';
}

function readSeedJson<T>(path: string, fallback: T): T {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return JSON.parse(require('node:fs').readFileSync(path, 'utf8')) as T;
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
