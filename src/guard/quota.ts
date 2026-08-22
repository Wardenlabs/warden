/**
 * Pass -2 — per-actor daily usage ceilings.
 *
 * The admin's lever for capping exposure and spend. Pure counters, checked
 * before any model runs, so a quota rejection costs nothing.
 *
 * Counts live in memory and reset with the process. For a gateway that runs
 * continuously that is adequate, and it keeps the hot path free of disk I/O;
 * durable counters are a natural follow-up but not what makes the feature
 * demonstrable.
 */
import type { PolicySpec } from '../policy/types.js';
import type { Actor, PassTrace } from './types.js';

type Counter = { day: string; requests: number };
const counters = new Map<string, Counter>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export type QuotaCheck = {
  allowed: boolean;
  used: number;
  limit: number | null;
  trace: PassTrace;
};

/**
 * Check and consume one unit of the actor's daily allowance.
 *
 * An actor whose role carries no quota is unlimited — absence of a rule is not
 * a reason to refuse. Refusing here would make adding a role a prerequisite
 * for using the product at all.
 */
export function checkQuota(spec: PolicySpec, actor: Actor): QuotaCheck {
  const started = Date.now();
  const quota = spec.quotas.find((q) => q.role === actor.role);

  if (!quota) {
    return {
      allowed: true, used: 0, limit: null,
      trace: { pass: 'quota', ms: Date.now() - started, verdict: 'ALLOW', detail: { limit: null } }
    };
  }

  const key = `${actor.id}:${actor.role}`;
  const current = counters.get(key);
  const day = today();
  const count = current && current.day === day ? current.requests : 0;

  const allowed = count < quota.maxRequestsPerDay;
  if (allowed) counters.set(key, { day, requests: count + 1 });

  return {
    allowed,
    used: allowed ? count + 1 : count,
    limit: quota.maxRequestsPerDay,
    trace: {
      pass: 'quota',
      ms: Date.now() - started,
      verdict: allowed ? 'ALLOW' : 'BLOCK',
      detail: { used: allowed ? count + 1 : count, limit: quota.maxRequestsPerDay, role: actor.role }
    }
  };
}

/** Current usage without consuming, for the console's quota bars. */
export function quotaStatus(spec: PolicySpec, actor: Actor): { used: number; limit: number | null } {
  const quota = spec.quotas.find((q) => q.role === actor.role);
  const current = counters.get(`${actor.id}:${actor.role}`);
  const used = current && current.day === today() ? current.requests : 0;
  return { used, limit: quota?.maxRequestsPerDay ?? null };
}

/** Reset counters. Used by tests and by the demo reset button. */
export function resetQuotas(): void {
  counters.clear();
}
