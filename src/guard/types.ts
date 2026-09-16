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
  /** The rule in the administrator's language, when that is not English. Shown to people; never judged. */
  ruleTextLocal?: string;
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
  /**
   * The model that tool is running, as the tool itself names it.
   *
   * Reported, like everything else in this type, and therefore not evidence:
   * an employee can edit their own transcript, so this is never allowed to
   * pick rules or move a verdict. What it is good for is the question an
   * administrator actually asks — *what is my company sending, and to what* —
   * which until now the governance record could not answer. It sat one field
   * away in the same transcript entry the token counts are read from.
   */
  model?: string;
};

export type GuardInput = {
  actor: Actor;
  prompt: string;
  /** Local file paths for attachments; their OCR text is screened too. */
  attachments?: string[];
  /** Validated inline bytes from public requests. Employee paths are never accepted. */
  documents?: import('../documents/types.js').InlineDocument[];
  /** Disconnecting a client kills in-flight extraction. */
  signal?: AbortSignal;
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
  /** Complete-byte digests and extraction status, persisted with the decision. */
  documents?: import('../documents/types.js').DocumentReport[];
  /** Private transient forwarding material. Must never enter API/SSE/audit stores. */
  maskedDocuments?: import('../documents/types.js').MaskedDocument[];
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
  /**
   * Why nothing was judged, when nothing was.
   *
   * Present only on a request that never reached the pipeline — today, one
   * whose actor was paused. It is what keeps `ALLOW` meaning what it has always
   * meant: a request that went through every pass and came out the other side.
   * A record carrying this one never ran a pass, never consulted a model and
   * never charged a quota, and the console must render it as *not judged*
   * rather than as allowed. The two are the same verdict and completely
   * different facts, and a company reading its own log has to be able to tell
   * them apart years later.
   *
   * It is not an exception to the invariant in CLAUDE.md. Nothing here is a
   * model clearing a request: a pause is ordinary code cutting in front of the
   * pipeline, decided by a person, recorded with their name on it.
   */
  notJudged?: 'paused';
  /** When the pause ends, or null for "until somebody takes it off". */
  pausedUntil?: string | null;
  /** Human-readable summary of why, shown to the employee on a block. */
  explanation: string;
};

/** One ceiling and where this session sits against it. `limit: null` means unmetered. */
/**
 * A ceiling and how much of it is gone.
 *
 * `pct` is derived rather than asked for, and it is here because `used` and
 * `limit` are two numbers a person has to divide in their head — which is
 * exactly the arithmetic that stops being done when a console is glanced at
 * rather than read. Null when there is no limit: no ceiling is not 0% of one.
 */
export type BudgetGauge = {
  used: number;
  limit: number | null;
  pct: number | null;
  over: boolean;
  warn: boolean;
};

export type BudgetStatus = {
  output: BudgetGauge;
  context: BudgetGauge;
  /** The prompt's own length against the role's ceiling. Always measured; needs no report. */
  prompt: BudgetGauge;
  /** True when the client sent nothing to measure — not the same as being under. */
  unreported: boolean;
};
