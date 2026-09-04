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
import { actorForCredential } from '../policy/people.js';
import { loadPolicy } from '../policy/store.js';
import { adapter } from '../qvac/index.js';

/**
 * What an unrecognised key gets back.
 *
 * Shaped like a decision so the hook and the proxy can render it the same way
 * they render any other refusal, and worded for the person reading it in their
 * terminal — who is far more likely to have a stale key after a rotation than
 * to be an intruder.
 */
export const UNKNOWN_KEY = {
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
  const lastUser = b?.messages?.filter((m) => m.role === 'user').at(-1);
  return lastUser?.content ?? '';
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
 */
export function evaluateRequest(req: Request, actor: Actor): Promise<Decision> {
  return evaluate(
    adapter(),
    { actor, prompt: extractPrompt(req.body), usage: reportedUsage(req.body) },
    loadPolicy()
  );
}
