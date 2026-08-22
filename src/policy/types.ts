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
  /** Cached embedding of `text`, used for top-K retrieval. Absent until indexed. */
  embedding: z.array(z.number()).optional()
});
export type Rule = z.infer<typeof ruleSchema>;

/** Per-role usage ceiling — the admin's lever for capping AI spend and exposure. */
export const quotaSchema = z.object({
  role: z.string().min(1),
  maxRequestsPerDay: z.number().int().positive(),
  maxTokensPerDay: z.number().int().positive().optional()
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
  quotas: z.array(quotaSchema)
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
  required: ['text', 'scope', 'appliesTo', 'severity', 'examples'],
  additionalProperties: false
} as const satisfies Record<string, unknown>;
