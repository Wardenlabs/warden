/**
 * Who is asking, and running the guard for them.
 *
 * Nothing an employee can type identifies them. They do not send a name and do
 * not send a role, because both were things they could edit — and a role you
 * can edit is a role you can use to pick the rules that judge you. The admin
 * issues a key, decides what it means, and can change the role behind it
 * without the employee touching their machine. Rotating the key revokes the
 * old one.
 */
import type { Request } from 'express';
import { evaluate } from '../guard/pipeline.js';
import type { Actor, Decision, ReportedUsage } from '../guard/types.js';
import { recordDecision } from '../audit/log.js';
import { actorForCredential, activePause, type Pause } from '../policy/people.js';
import { loadPolicy } from '../policy/store.js';
import { adapter } from '../qvac/index.js';
import { parseDocumentAttachments } from '../documents/index.js';
import { isLoopback } from './admin-auth.js';
import { PORT } from './config.js';
import { installationReport } from './installation.js';

/**
 * What an unrecognised key gets back.
 *
 * Shaped like a decision so the hook and the proxy can render it the same way
 * they render any other refusal, and worded for the person reading it in their
 * terminal — who is far more likely to have a stale key after a rotation than
 * to be an intruder.
 *
 * Built per request rather than held as a constant, because the two things that
 * make this sentence useful are both properties of the request. **Which
 * gateway** refused, by name and version: a key is only valid in the
 * installation that minted it, and a machine running both the desktop app and a
 * checkout has two of them fighting over one port, so "not recognised" without
 * a name sends people looking for a bad key instead of the other Warden.
 * **Where they are**: from this machine the fix is to open the console and
 * claim a key, and from another machine it is to ask the administrator, and
 * giving somebody the wrong one of those costs them the afternoon.
 */
export function unknownKey(req: Request) {
  const loopback = isLoopback(req);
  const where = installationReport(loopback);
  const said = [`The gateway "${where.label}" (v${where.version}) does not recognise this API key.`];
  if (loopback) {
    // It is on this machine, so the console is one click away and the person
    // reading this is very likely the administrator of it.
    said.push(
      `That gateway is running here: open http://localhost:${PORT} and claim a key in Team → People.`,
      'A key another Warden issued — the desktop app, or a second checkout — will not work in this one.'
    );
  } else {
    said.push('Ask your administrator for a current one — they can issue a new key from People.');
  }
  return {
    verdict: 'BLOCK' as const,
    auditId: 'no-key',
    error: 'unknown_api_key',
    firedRules: [],
    passes: [],
    maskedPrompt: '',
    maskedSpans: [],
    // One paragraph, no newlines: the hook word-wraps this string as it is.
    explanation: said.join(' ')
  };
}

/**
 * Null means refuse. There is no default identity and no assumed role: a caller
 * nobody can identify is not a caller to guess about.
 */
export function resolveActor(req: Request): Actor | null {
  const employee = actorForCredential(req.header('authorization'));
  return employee ? { id: employee.id, role: employee.role } : null;
}

export function extractPrompt(body: unknown): string {
  const b = body as { prompt?: string; user_input?: string; messages?: { role: string; content: string }[] };
  if (typeof b?.prompt === 'string') return b.prompt;
  if (typeof b?.user_input === 'string') return b.user_input;
  const lastUser = Array.isArray(b?.messages) ? b.messages.filter((m) => m && m.role === 'user').at(-1) : undefined;
  return typeof lastUser?.content === 'string' ? lastUser.content : '';
}

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
export function reportedUsage(body: unknown): ReportedUsage | undefined {
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

/**
 * Run the guard for a request, whatever shape it arrived in. The caller has
 * already resolved the actor; this only assembles the input the pipeline wants.
 *
 * Except when the actor is paused, which is decided here and nowhere else —
 * before the policy is read, before a document is parsed, and before a single
 * pass exists to be influenced. That placement is the whole point: a pause that
 * short-circuited somewhere inside the pipeline would be a thing that makes a
 * verdict, and the one rule this codebase does not bend is that verdicts come
 * out of `aggregate()` and out of nothing else. This never produces a verdict;
 * it produces a record that says none was made.
 */
export async function evaluateRequest(req: Request, actor: Actor, signal?: AbortSignal): Promise<Decision> {
  const employee = actorForCredential(req.header('authorization'));
  const paused = employee ? activePause(employee) : null;
  if (paused) return recordUnjudged(actor, extractPrompt(req.body), paused);

  return evaluate(
    adapter(),
    { actor, prompt: extractPrompt(req.body), usage: reportedUsage(req.body), documents: parseDocumentAttachments(req.body?.attachments), signal },
    loadPolicy()
  );
}

/**
 * The record a paused request leaves.
 *
 * Shaped like every other decision so that the hook, the proxy and the log all
 * read it without a special case — and carrying `notJudged`, which is the one
 * field that says it is not like the others. No pass ran, so `passes` is empty
 * and `totalMs` is the time this function took rather than a judging time it
 * would be dishonest to report. No quota is charged: `quota.ts` is never
 * reached, because a request nobody examined should not spend somebody's day's
 * allowance.
 *
 * The prompt still gets hashed into the log, exactly as it would have been. A
 * pause is a gap in what was judged, not a gap in what happened, and the
 * governance record has to show that these requests went out.
 */
function recordUnjudged(actor: Actor, prompt: string, paused: Pause): Decision {
  const started = Date.now();
  const until = paused.until
    ? `until ${paused.until}`
    : 'until somebody turns it back on';
  const partial = {
    verdict: 'ALLOW' as const,
    notJudged: 'paused' as const,
    pausedUntil: paused.until,
    policyVersion: loadPolicy().version,
    totalMs: Date.now() - started,
    firedRules: [],
    passes: [],
    maskedPrompt: '',
    maskedSpans: [],
    quota: { used: 0, limit: 0 },
    explanation: `Warden is paused for you ${until}, so this request was not checked against any rule.`
  };
  const entry = recordDecision(actor, prompt, partial);
  return { ...partial, auditId: entry.auditId };
}
