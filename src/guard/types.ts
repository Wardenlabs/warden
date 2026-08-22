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

export type GuardInput = {
  actor: Actor;
  prompt: string;
  /** Local file paths for attachments; their OCR text is screened too. */
  attachments?: string[];
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
  /** Human-readable summary of why, shown to the employee on a block. */
  explanation: string;
};
