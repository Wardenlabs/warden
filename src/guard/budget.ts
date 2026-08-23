/**
 * Pass -1.5 — session consumption against the role's ceilings.
 *
 * The counters in `quota.ts` answer "how many times today". This answers "how
 * much has this session cost", which is the question an admin actually has
 * about a coding agent: one prompt can be worth a hundred.
 *
 * Two things make this different from every other pass, and both are on
 * purpose.
 *
 * **It does not decide.** Being over budget resolves to ESCALATE, and ESCALATE
 * is not the top of the lattice. If this pass short-circuited, a prompt that
 * was both over budget and in breach of a rule would come back held instead of
 * refused — a decision made *looser* by adding a control. So this pass observes,
 * records its trace, and hands its verdict to `tighten()` alongside the
 * aggregate. The model calls it does not save are on-device anyway: QVAC
 * inference is local and free, and the budget being protected is the cloud
 * provider's.
 *
 * **It is held, not blocked.** Running out of budget mid-task and being told
 * "no" with nowhere to go is the failure mode that makes people stop using the
 * gateway rather than stop working. ESCALATE puts a person on the other end.
 */
import type { PolicySpec } from '../policy/types.js';
import type { Actor, BudgetGauge, BudgetStatus, PassTrace, ReportedUsage, Verdict } from './types.js';

/** Fraction of a ceiling at which the console warns. Warning is not a verdict. */
const DEFAULT_WARN_AT = 0.8;

export type BudgetCheck = {
  verdict: Verdict;
  status: BudgetStatus;
  /** Composed here from the ratified ceiling, never generated. Empty when under. */
  explanation: string;
  trace: PassTrace;
};

function gauge(used: number | undefined, limit: number | undefined, warnAt: number): BudgetGauge {
  // A ceiling nobody set is not a ceiling of zero. An unset limit is unmetered,
  // for the same reason an actor whose role carries no quota is unlimited:
  // absence of a rule is not a reason to refuse.
  if (!limit) return { used: used ?? 0, limit: null, over: false, warn: false };
  const u = used ?? 0;
  return { used: u, limit, over: u >= limit, warn: u >= limit * warnAt };
}

export function checkBudget(
  spec: PolicySpec,
  actor: Actor,
  usage: ReportedUsage | undefined
): BudgetCheck {
  const started = Date.now();
  const quota = spec.quotas.find((q) => q.role === actor.role);
  const warnAt = quota?.warnAtFraction ?? DEFAULT_WARN_AT;

  const output = gauge(usage?.outputTokens, quota?.maxSessionOutputTokens, warnAt);
  const context = gauge(usage?.contextTokens, quota?.maxContextTokens, warnAt);

  // Reporting nothing is not the same as being under budget, and the trace has
  // to be able to tell them apart. A tool that never reports is a tool whose
  // spend Warden cannot see — which the console should say rather than draw an
  // empty bar that reads as "plenty left".
  const unreported =
    usage?.outputTokens === undefined && usage?.contextTokens === undefined;

  const status: BudgetStatus = { output, context, unreported };
  const over = output.over || context.over;

  const reasons: string[] = [];
  if (output.over) {
    reasons.push(
      `this session has generated ${output.used.toLocaleString('en-US')} tokens, ` +
        `over the ${output.limit?.toLocaleString('en-US')} allowed for role "${actor.role}"`
    );
  }
  if (context.over) {
    reasons.push(
      `its context is ${context.used.toLocaleString('en-US')} tokens, ` +
        `over the ${context.limit?.toLocaleString('en-US')} allowed for role "${actor.role}"`
    );
  }

  return {
    verdict: over ? 'ESCALATE' : 'ALLOW',
    status,
    explanation: over
      ? `Held on budget: ${reasons.join('; ')}. Start a new session, or ask an ` +
        `administrator to raise the ceiling.`
      : '',
    trace: {
      pass: 'budget',
      ms: Date.now() - started,
      verdict: over ? 'ESCALATE' : 'ALLOW',
      detail: {
        reported: !unreported,
        source: usage?.source ?? null,
        output: { used: output.used, limit: output.limit, warn: output.warn },
        context: { used: context.used, limit: context.limit, warn: context.warn }
      }
    }
  };
}
