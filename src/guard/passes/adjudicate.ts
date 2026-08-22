/**
 * Pass 3 — does this message violate one specific rule?
 *
 * One narrow call per rule, never one broad call about all of them. Asked
 * "does this violate any of these eight rules", a small model produces a
 * confident answer about none of them in particular; asked about one rule with
 * that rule's own examples in front of it, it answers something usable.
 *
 * The model returns a label and nothing else. Both of those choices were forced
 * by measurement, and both are documented below, because they are the
 * difference between a guard that works and one that blocks everything.
 */
import { z } from 'zod';
import type { QvacAdapter } from '../../qvac/types.js';
import type { Rule } from '../../policy/types.js';
import { isolationPreamble, type Isolated } from '../isolate.js';
import type { PassTrace } from '../types.js';

/**
 * A label. No confidence score, and no free-text reason.
 *
 * The earlier version asked for `{violates: boolean, confidence: number}` and
 * produced 7/8 false positives with incoherent pairings — "violates" at
 * confidence 0.00 — because filling two independent slots never requires
 * deciding anything. An enum forces a choice, and took false positives to 0/8
 * on identical inputs.
 *
 * The version after that added a `reason` string, and that single field cost
 * the whole system: on a run of legitimate traffic it produced **16/16 false
 * positives**. Three ways at once. Long reasons overran the token cap, leaving
 * truncated JSON that failed validation and fell through to ESCALATE. Latency
 * went from ~2s to 7-12s per rule generating prose nobody reads. And the
 * reasons themselves were formulaic restatements of the rule — "the message
 * does not request payroll data" — carrying no information the label did not.
 *
 * So the explanation is composed in code from the rule and the label. It is
 * more accurate, it is instant, and it cannot fail to parse.
 */
const ADJUDICATION = z.object({
  verdict: z.enum(['VIOLATES', 'COMPLIES', 'UNCLEAR'])
});

const ADJUDICATION_JSON_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['VIOLATES', 'COMPLIES', 'UNCLEAR'] } },
  required: ['verdict'],
  additionalProperties: false
} as const;

export type RuleVerdict = {
  ruleId: string;
  violates: boolean;
  unclear: boolean;
  /** Derived from the label, not asked for. See note below. */
  confidence: number;
  reason: string;
};

/**
 * Confidence is assigned from the label rather than requested from the model.
 *
 * A 1.7B model's self-reported probability carries no information — measured
 * values clustered at 0.00, 0.95 and 1.00 regardless of the answer. These
 * numbers exist so the aggregator and the trace have a consistent scale, and
 * they are honest about being derived.
 */
const CONFIDENCE = { VIOLATES: 0.9, COMPLIES: 0.9, UNCLEAR: 0.4 } as const;

function systemPrompt(rule: Rule, nonce: string): string {
  const shots = [
    ...rule.examples.violating.map((t) => `VIOLATES: ${t}`),
    ...rule.examples.compliant.map((t) => `COMPLIES: ${t}`)
  ].join('\n');

  /**
   * Two clauses in here are not padding — each fixes a measured failure mode,
   * and both are generic enough to help every rule.
   *
   * *Asking about a process is not doing the thing.* Without it the adjudicator
   * labelled "cuál es el proceso para pedir un aumento?" as violating a payroll
   * rule — a question about procedure, matched on topic alone. This single line
   * took a six-case probe from 1/6 to 5/6.
   *
   * *A rule's own limits are part of the rule.* Rules qualify themselves — about
   * *another* employee, above *a threshold*, *outside* the company — and the
   * model reliably drops the qualifier and fires on the bare subject.
   */
  return [
    'You check one message against one rule and answer with a single label.',
    '',
    `RULE: ${rule.text}`,
    '',
    'VIOLATES  - the message actually does what the rule prohibits.',
    'COMPLIES  - it does not. Two things that are NOT violations, however much',
    '            they share the rule\'s subject:',
    '            · asking how a process works, what a policy says, or who to ask;',
    '            · anything outside the rule\'s own limits — if it is about another',
    '              person, a threshold, or a destination, a message that stays',
    '              inside those limits complies.',
    '            Most messages comply.',
    'UNCLEAR   - only when the message is genuinely ambiguous. If it plainly does',
    '            not do the prohibited thing, answer COMPLIES.',
    '',
    'Examples for this rule:',
    shots,
    '',
    isolationPreamble(nonce),
    '/no_think'
  ].join('\n');
}

/** A readable explanation, composed rather than generated. */
function explain(rule: Rule, label: 'VIOLATES' | 'COMPLIES' | 'UNCLEAR'): string {
  switch (label) {
    case 'VIOLATES':
      return `the request does what this rule prohibits`;
    case 'UNCLEAR':
      return `could not clearly tell whether this rule applies`;
    case 'COMPLIES':
      return `no conflict with this rule`;
  }
}

/** Judge one message against one rule. */
export async function adjudicate(
  qvac: QvacAdapter,
  iso: Isolated,
  rule: Rule
): Promise<{ verdict: RuleVerdict; trace: PassTrace }> {
  const started = Date.now();

  const res = await qvac.completeJSON(
    {
      role: 'adjudicator',
      system: systemPrompt(rule, iso.nonce),
      user: `${iso.envelope}\n\nLabel the message against the rule.`,
      // The answer is one enum value. Anything longer means the model has left
      // the schema, and cutting it off beats waiting for it to wander back.
      maxTokens: 24,
      /**
       * No KV cache key here, deliberately.
       *
       * An earlier version passed `kvKey: adjudicate:<ruleId>`, reasoning that
       * the system block is identical for every call about that rule so only
       * the message would need prefilling. That is not what the cache stores:
       * it keys conversation state including the user turn, so reusing the key
       * across different messages replays the previous verdict. Measured
       * directly — three probes through one rule returned VIOLATES, VIOLATES,
       * VIOLATES, including for a message listed in that rule's own compliant
       * examples; the same rule and prompt without the key returned COMPLIES.
       *
       * It was the root cause of a 100% false-positive rate, and the failure
       * mode is silent: every answer is well-formed, plausible, and wrong.
       * Prompt-processing time is worth paying to avoid that.
       */
      timeoutMs: 25_000
    },
    ADJUDICATION,
    ADJUDICATION_JSON_SCHEMA
  );

  const label = res.value.verdict;
  const verdict: RuleVerdict = {
    ruleId: rule.id,
    violates: label === 'VIOLATES',
    unclear: label === 'UNCLEAR',
    confidence: CONFIDENCE[label],
    reason: explain(rule, label)
  };

  return {
    verdict,
    trace: {
      pass: `adjudicate:${rule.id}`,
      ms: Date.now() - started,
      verdict: label === 'VIOLATES'
        ? rule.severity === 'block' ? 'BLOCK' : 'ESCALATE'
        : 'ALLOW',
      detail: { label, repaired: res.repaired, ruleText: rule.text }
    }
  };
}

/**
 * Judge a message against several rules at once.
 *
 * Concurrency is what makes multi-rule policy viable: the adjudicator model is
 * loaded with `parallel: 4`, so four of these share one model instance instead
 * of queueing. Sequentially, eight rules at ~2s each would put every prompt
 * behind a sixteen-second wait.
 *
 * A rule whose adjudication fails yields a trace but **no verdict**. That
 * asymmetry is deliberate: the aggregator compares the verdicts it received
 * against the rules it expected, and escalates on the difference. Returning a
 * placeholder verdict instead would make a crashed pass indistinguishable from
 * a clean one — a fail-open hole in the middle of a fail-closed design.
 */
export async function adjudicateAll(
  qvac: QvacAdapter,
  iso: Isolated,
  rules: Rule[]
): Promise<{ verdicts: RuleVerdict[]; traces: PassTrace[] }> {
  const settled = await Promise.all(
    rules.map(async (rule) => {
      const started = Date.now();
      try {
        return await adjudicate(qvac, iso, rule);
      } catch (err) {
        return {
          verdict: null,
          trace: {
            pass: `adjudicate:${rule.id}`,
            ms: Date.now() - started,
            verdict: 'ESCALATE' as const,
            failedClosed: true,
            detail: { error: err instanceof Error ? err.message : String(err) }
          } satisfies PassTrace
        };
      }
    })
  );

  return {
    verdicts: settled.map((s) => s.verdict).filter((v): v is RuleVerdict => v !== null),
    traces: settled.map((s) => s.trace)
  };
}
