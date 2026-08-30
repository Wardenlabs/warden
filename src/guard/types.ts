/**
 * The guard's vocabulary, and the one invariant the whole design rests on.
 *
 * Verdicts form a strictness lattice: ALLOW < ESCALATE < BLOCK. Every LLM pass
 * in the pipeline can only move a decision *up* that lattice, never down. A
 * pass that errors, times out, or returns unparseable output resolves to
 * ESCALATE. That is what makes the guarantee structural rather than a matter of
 * how well the guard model happens to resist a given prompt: an attacker who
 * fully compromises a pass still cannot manufacture an ALLOW, because no pass
 * has the authority to grant one.
 */

import type { RuleSeverity } from '../policy/types.js';

export type Verdict = 'ALLOW' | 'ESCALATE' | 'BLOCK';

const STRICTNESS: Record<Verdict, number> = { ALLOW: 0, ESCALATE: 1, BLOCK: 2 };

/** Combine verdicts by taking the strictest. The only way passes are merged. */
export function tighten(...verdicts: Verdict[]): Verdict {
  return verdicts.reduce<Verdict>(
    (worst, v) => (STRICTNESS[v] > STRICTNESS[worst] ? v : worst),
    'ALLOW'
  );
}

export function isAtLeastAsStrict(a: Verdict, b: Verdict): boolean {
  return STRICTNESS[a] >= STRICTNESS[b];
}

/** One step of the pipeline, recorded for the live trace and the audit log. */
export type PassTrace = {
  /** Stable identifier, e.g. `quota`, `sanitize`, `isolate`, `injection`, `adjudicate:r-03`. */
  pass: string;
  ms: number;
  verdict?: Verdict;
  /** Whether this pass fell back to its fail-closed path instead of deciding. */
  failedClosed?: boolean;
  detail: unknown;
};

export type FiredRule = {
  ruleId: string;
  ruleText: string;
  reason: string;
  confidence: number;
  /** `block` refuses outright; `escalate` routes to a human. */
  severity?: RuleSeverity;
  /**
   * What to do instead, from the rule itself.
   *
   * A refusal that only says "blocked by policy" teaches people to route around
   * the gateway, because it gives them nothing to act on. These two fields turn
   * the refusal into an answer — and both are read from the ratified rule, not
   * generated per decision, so they cost nothing and cannot fail to parse.
   */
  guidance?: string;
  /** Nearby requests that are fine — the rule's own compliant examples. */
  allowedExamples?: string[];
};

/** A span of text the sanitizer masked. The secret itself is never retained. */
export type MaskedSpan = {
  kind: 'api-key' | 'token' | 'email' | 'card' | 'high-entropy';
  start: number;
  end: number;
  preview: string;
};

export type Actor = { id: string; role: string };

/**
 * What the client says the session it is prompting from has consumed.
 *
 * Reported, not measured, and the distinction is the whole caveat. Through the
 * hook Warden never talks to the provider and never sees an answer, so these
 * numbers are read by the hook off the tool's own transcript on the employee's
 * machine and sent here. They are real provider counts rather than estimates —
 * and they are also a file the employee can edit. Against someone working
 * within the policy this is a spend control; against someone attacking it, it
 * is not, exactly like the hook itself, which they could also uninstall.
 *
 * The only place Warden could count tokens authoritatively is the proxy, which
 * is the one path a Max or Plus subscription cannot be pointed down. Say
 * "reported" wherever this is described.
 */
export type ReportedUsage = {
  /** Tokens the assistant generated in this session so far. */
  outputTokens?: number;
  /** How full the session's context was on the last turn. */
  contextTokens?: number;
  /** Which tool reported it, for the trace. Never used to pick rules. */
  source?: string;
};

export type GuardInput = {
  actor: Actor;
  prompt: string;
  /** Local file paths for attachments; their OCR text is screened too. */
  attachments?: string[];
  usage?: ReportedUsage;
};

export type Decision = {
  verdict: Verdict;
  auditId: string;
  policyVersion: string;
  totalMs: number;
  firedRules: FiredRule[];
  passes: PassTrace[];
  /** Prompt after secret masking — this, never the raw text, is what goes upstream. */
  maskedPrompt: string;
  maskedSpans: MaskedSpan[];
  quota?: { used: number; limit: number };
  /** Session consumption against the role's ceilings, when the client reported any. */
  budget?: BudgetStatus;
  /**
   * Rules that fired at `warn` severity. These did not change the verdict — the
   * request goes through — and they carry why it was flagged so the employee
   * can see the concern instead of guessing at it.
   */
  warnings?: FiredRule[];
  /** Human-readable summary of why, shown to the employee on a block. */
  explanation: string;
};

/** One ceiling and where this session sits against it. `limit: null` means unmetered. */
export type BudgetGauge = { used: number; limit: number | null; over: boolean; warn: boolean };

export type BudgetStatus = {
  output: BudgetGauge;
  context: BudgetGauge;
  /** True when the client sent nothing to measure — not the same as being under. */
  unreported: boolean;
};
