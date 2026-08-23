/**
 * What the admin says, in a shape the guard can evaluate against.
 *
 * A rule stays natural language on purpose: the adjudicator pass is an LLM, and
 * "no one may request another employee's salary" generalises in ways a regex
 * never will. The structure around it — scope, roles, severity, examples — is
 * what keeps a small model accurate and the final decision explainable.
 */
import { z } from 'zod';

/** Where a rule applies: to what the employee sends, what the model returns, or both. */
export const ruleScopeSchema = z.enum(['input', 'output', 'both']);
export type RuleScope = z.infer<typeof ruleScopeSchema>;

/** What happens when a rule fires. `escalate` routes to a human instead of hard-blocking. */
export const ruleSeveritySchema = z.enum(['block', 'escalate']);
export type RuleSeverity = z.infer<typeof ruleSeveritySchema>;

/**
 * Few-shot anchors for the adjudicator.
 *
 * The compiler drafts these alongside the rule and the admin ratifies them.
 * Concrete examples move small-model accuracy far more than rule wording does,
 * and `compliant` examples are what hold the false-positive rate down: without
 * them the model learns "when in doubt, block".
 */
export const ruleExamplesSchema = z.object({
  violating: z.array(z.string()).min(1).max(4),
  compliant: z.array(z.string()).min(1).max(4)
});

export const ruleSchema = z.object({
  id: z.string().min(1),
  /** Canonical statement of the rule, as ratified by the admin. */
  text: z.string().min(1),
  scope: ruleScopeSchema,
  /** Role names this binds, or `['*']` for everyone. */
  appliesTo: z.array(z.string()).min(1),
  severity: ruleSeveritySchema,
  examples: ruleExamplesSchema,
  /**
   * What the employee should do instead, shown when this rule fires.
   *
   * Authored once, when the rule is written — never generated at decision time.
   * That distinction is the whole reason this field can exist at all: asking
   * the adjudicator for a free-text reason per decision was measured at 16/16
   * false positives, because long generations overran the token cap and left
   * truncated JSON. Here the sentence is written once by the compiler or the
   * admin, costs nothing to serve, and cannot fail to parse.
   *
   * Optional: a rule without one still explains itself from its text and its
   * compliant examples.
   */
  guidance: z.string().optional(),
  /**
   * Always adjudicate this rule, bypassing top-K retrieval.
   *
   * Retrieval picks the rules most similar to the prompt, which is right for
   * topic-specific rules but wrong for the one that catches instruction
   * override: an attacker phrases that to look like anything at all, so
   * similarity is exactly the wrong filter for it.
   */
  pinned: z.boolean().optional(),
  /** Cached embedding of `text`, used for top-K retrieval. Absent until indexed. */
  embedding: z.array(z.number()).optional()
});
export type Rule = z.infer<typeof ruleSchema>;

/** Per-role usage ceiling — the admin's lever for capping AI spend and exposure. */
export const quotaSchema = z.object({
  role: z.string().min(1),
  maxRequestsPerDay: z.number().int().positive(),
  /**
   * Ceiling on tokens the assistant has generated in the session this person
   * is prompting from.
   *
   * Per session, not per day, and the name has to keep saying so: the hook
   * reads one transcript, and one transcript is one session. A field called
   * `...PerDay` fed by a per-session number would be a console that reports a
   * daily total nobody is counting.
   *
   * Absolute, not a fraction of anything, and that is deliberate: a fraction
   * needs a denominator, the denominator is the model's context window, and
   * Warden does not know it. Guessing one would put a number nobody ratified
   * underneath a decision. An admin who knows their team runs a 200k model
   * writes 100k here and has said exactly what they meant.
   */
  maxSessionOutputTokens: z.number().int().positive().optional(),
  /** Ceiling on how full the session's context may get. Absolute, for the same reason. */
  maxContextTokens: z.number().int().positive().optional(),
  /**
   * Fraction of either ceiling at which the console warns without holding
   * anything. Warning is not a verdict and never reaches the employee's tool.
   */
  warnAtFraction: z.number().gt(0).lte(1).optional()
});
export type Quota = z.infer<typeof quotaSchema>;

export const policySpecSchema = z.object({
  /**
   * SHA-256 over the canonicalised rules and quotas. Stamped into every audit
   * entry so a past decision can be replayed against the exact policy that
   * produced it — and so tampering with the policy file is detectable.
   */
  version: z.string().length(64),
  updatedAt: z.string(),
  rules: z.array(ruleSchema),
  quotas: z.array(quotaSchema),
  /**
   * Roles the policy does not govern — whoever authors the rules rather than
   * lives under them.
   *
   * This is deliberately part of the audited policy and not a deployment flag:
   * "who is exempt" is the single most security-relevant sentence in the whole
   * spec, so it belongs inside the version hash where a change to it is
   * detectable, next to the rules it overrides.
   *
   * Defaulted rather than required so policy files written before this existed
   * still load.
   */
  exemptRoles: z.array(z.string()).default(['admin'])
});
export type PolicySpec = z.infer<typeof policySpecSchema>;

/**
 * A rule as the compiler first emits it — no id, no embedding, not yet in force.
 *
 * The model drafts; the admin ratifies. Policy authorship is never delegated to
 * the model, which matters both as a security property and as the answer to
 * "what stops someone talking the compiler into writing a permissive rule".
 */
export const ruleDraftSchema = ruleSchema.omit({ id: true, embedding: true });
export type RuleDraft = z.infer<typeof ruleDraftSchema>;

/** JSON Schema handed to the decoder as a grammar when compiling a rule. */
export const RULE_DRAFT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    scope: { type: 'string', enum: ['input', 'output', 'both'] },
    appliesTo: { type: 'array', items: { type: 'string' } },
    severity: { type: 'string', enum: ['block', 'escalate'] },
    guidance: { type: 'string' },
    examples: {
      type: 'object',
      properties: {
        violating: { type: 'array', items: { type: 'string' } },
        compliant: { type: 'array', items: { type: 'string' } }
      },
      required: ['violating', 'compliant'],
      additionalProperties: false
    }
  },
  required: ['text', 'scope', 'appliesTo', 'severity', 'guidance', 'examples'],
  additionalProperties: false
} as const satisfies Record<string, unknown>;
