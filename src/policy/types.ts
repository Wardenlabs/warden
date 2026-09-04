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

/**
 * What happens when a rule fires.
 *
 * `block` refuses. `escalate` routes to a human instead of refusing outright.
 * `warn` lets the request through and says why it was flagged.
 *
 * **`warn` is not a fourth verdict, and that is the whole point.** The lattice
 * is `ALLOW < ESCALATE < BLOCK` and every pass may only move a decision toward
 * stricter; adding a level between ALLOW and ESCALATE would have meant auditing
 * the forty-nine places in this codebase that compare verdicts, half of which
 * ask `!== 'ALLOW'` and would have read a warning as a refusal. So a `warn`
 * rule fires, attaches its explanation, and tightens nothing.
 *
 * That is not a loophole. Without the rule the request would be allowed too, so
 * warning can never be looser than not having written it — it is strictly more
 * information for the same verdict. And it is the admin's own choice, made
 * inside the policy hash next to the rule text, which is where a decision to
 * stop enforcing something belongs.
 *
 * It exists because of a measurement: the guard refuses 54% of legitimate work,
 * and a guard people cannot work with gets switched off, which protects
 * nothing. A rule that is right about the topic and wrong about the request —
 * the shape causing most of those refusals — is far more useful saying "this
 * looked like X, here is the rule, carry on" than blocking.
 */
export const ruleSeveritySchema = z.enum(['block', 'escalate', 'warn']);
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
   * What the rule is NOT about: the nearest legitimate work that shares its
   * vocabulary.
   *
   * Every rule says what it prohibits and, until this field, none said where
   * it stopped. The judge then fires on the words: "override the default
   * timeout" against a rule about overriding the assistant's instructions,
   * "5000ms" against a USD 5,000 threshold, "fake customer records" against
   * customer data. Measured 2026-09-04 (`docs/MEASUREMENTS.md`, "Is the problem
   * the rule format?"): one boundary sentence per rule took the shipped 1.7B
   * from 72% to 52% of honest requests refused, for two attacks, with the
   * pinned rule's refusals falling from 73 to 31. The same sentences made the
   * DynaGuard fine-tune worse, so `adjudicate.ts` reads this only under the
   * prompt forms where it helped.
   *
   * Written by the compiler and shown to the administrator at Activate, like
   * `guidance`: it widens nothing on its own, because nothing a compiler emits
   * is in force until a person ratifies it, and the card shows this sentence
   * beside the prohibition. Optional; a rule without one judges as before.
   */
  boundary: z.string().optional(),
  /**
   * The rule as the administrator would say it, in their own language.
   *
   * `text` is written in English because that is what the judge reads and
   * what every measurement was taken on. Employees are not the judge: an
   * administrator who wrote "nadie comparte el sueldo de otro" got a refusal
   * whose first sentence was in English and whose guidance and examples were
   * in Spanish, on one screen. This is the sentence people see instead of
   * `text` when it is present; the judge never reads it. Written once by the
   * compiler, like `guidance`, and empty when the administrator wrote in
   * English.
   */
  textLocal: z.string().optional(),
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
/**
 * A compiled draft, or the compiler declining to make one.
 *
 * `notARule` is the only field here the model can use to refuse the task, and
 * it exists because refusing was impossible: asked to turn "quiero reducir mi
 * uso al 50%" into a prohibition, a very capable model produced one that
 * prohibited *limiting* people, which is the administrator's sentence turned
 * inside out and then handed to them to ratify. A spending target is a role
 * limit in Warden; there was nowhere to say that.
 *
 * The rest of the fields stay required so the common path is unchanged. Nothing
 * a compiler emits is enacted without the administrator pressing Activate, so
 * this is not on the measured path the guard's numbers come from.
 */
export const ruleDraftSchema = ruleSchema
  .omit({ id: true, embedding: true })
  .partial()
  .extend({
    notARule: z.boolean().optional(),
    notARuleReason: z.string().optional(),
    /**
     * The fraction of today's limits the administrator is asking for.
     *
     * One number, and the model is asked for nothing else about it: not the
     * new limits, not which roles, not the arithmetic. "Reducir mi uso al 50%"
     * is `0.5`. Warden multiplies the quotas it already has, which is the part
     * a model has no business doing and gets wrong in a way nobody would catch.
     *
     * This exists because refusing was the wrong answer to that sentence. It
     * is not nonsense the way "juan" is nonsense; it is a request Warden can
     * satisfy, in the one currency it has for spending.
     */
    usageFactor: z.number().gt(0).lt(1).optional(),
    // `text` loses its min(1) here and gets it back in the refinement below.
    // Declining, a model writes `notARule: true` next to `text: ""`, and the
    // inherited minimum rejected the whole answer before anything could read
    // the flag: "PUYO" came back as "schema-invalid output twice" when the
    // model had in fact answered it correctly.
    text: z.string().optional()
  })
  .superRefine((draft, ctx) => {
    // A refusal carries nothing else, and a rule carries everything. Told that
    // the other fields are ignored when it declines, a capable model stops
    // emitting them, and a schema that still demanded them turned a correct
    // refusal into "Claude Code returned schema-invalid output twice".
    //
    // Only zod is relaxed. `RULE_DRAFT_JSON_SCHEMA` keeps its `required` list,
    // so the grammar-constrained local model is still forced to fill a real
    // draft; this tolerance is for the unconstrained path, which is the only
    // one that can omit a field in the first place.
    if (draft.notARule) return;
    for (const key of ['text', 'scope', 'appliesTo', 'severity', 'guidance', 'examples'] as const) {
      if (draft[key] === undefined || draft[key] === '') {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required unless notARule is true` });
      }
    }
  });
export type RuleDraft = z.infer<typeof ruleDraftSchema>;

/** JSON Schema handed to the decoder as a grammar when compiling a rule. */
/**
 * What a broad instruction splits into before any of it is compiled.
 *
 * An administrator does not say "no one may export customer contact details".
 * They say "I want people to stop leaking customer data", which names a worry
 * rather than a prohibition. A single rule carrying all of that worry is so
 * wide that the adjudicator refuses honest work under it — the failure
 * `docs/MEASUREMENTS.md` keeps recording — so the worry is split into the
 * specific things it actually means, and each of those is compiled on its own.
 *
 * Sentences and nothing else. This pass is asked for the one thing a small
 * model is reliably good at here; every structured field it might also have
 * been asked for is a field `compileRule` already knows how to get right.
 */
export const policySplitSchema = z.object({
  statements: z.array(z.string().min(1)).min(1).max(5)
});
export type PolicySplit = z.infer<typeof policySplitSchema>;

export const POLICY_SPLIT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    statements: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 }
  },
  required: ['statements'],
  additionalProperties: false
} as const satisfies Record<string, unknown>;

export const RULE_DRAFT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    // Both halves of the refusal live in the grammar, not only in the zod
    // schema. A field the decoder's grammar does not list cannot be emitted at
    // all under `additionalProperties: false`, so adding it to zod alone left
    // the local model unable to say the one thing it had just been told to say.
    notARule: { type: 'boolean' },
    notARuleReason: { type: 'string' },
    usageFactor: { type: 'number' },
    text: { type: 'string' },
    scope: { type: 'string', enum: ['input', 'output', 'both'] },
    appliesTo: { type: 'array', items: { type: 'string' } },
    severity: { type: 'string', enum: ['block', 'escalate', 'warn'] },
    guidance: { type: 'string' },
    boundary: { type: 'string' },
    textLocal: { type: 'string' },
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
