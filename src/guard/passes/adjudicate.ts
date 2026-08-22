/**
 * Pass 3 — does this message violate one specific rule?
 *
 * One narrow call per rule, never one broad call about all of them. Asked
 * "does this violate any of these eight rules", a small model produces a
 * confident answer about none of them in particular; asked about one rule with
 * that rule's own examples in front of it, it answers something usable.
 *
 * The verdict is a label from a fixed set rather than a boolean with a
 * confidence score. Measured on Qwen3: `{violates: bool, confidence: number}`
 * produced 7/8 false positives and incoherent pairings — "violates" at
 * confidence 0.00 — because filling two independent slots does not require
 * deciding anything. Forcing a single choice from an enum took false positives
 * to 0/8 on the same model and the same inputs, and removed a whole class of
 * validation failure: a label cannot fall outside its range the way a free
 * number can.
 */
import { z } from 'zod';
import type { QvacAdapter } from '../../qvac/types.js';
import type { Rule } from '../../policy/types.js';
import { isolationPreamble, type Isolated } from '../isolate.js';
import type { PassTrace } from '../types.js';

/**
 * Three labels, not two.
 *
 * `UNCLEAR` gives the model somewhere honest to put a genuinely ambiguous
 * request. Without it, uncertainty has to be expressed as one of the two
 * confident answers, and it lands on VIOLATES far more often than not.
 */
const ADJUDICATION = z.object({
  verdict: z.enum(['VIOLATES', 'COMPLIES', 'UNCLEAR']),
  reason: z.string().min(1).max(240)
});

const ADJUDICATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['VIOLATES', 'COMPLIES', 'UNCLEAR'] },
    reason: { type: 'string' }
  },
  required: ['verdict', 'reason'],
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
 * values clustered at 0.00, 0.95 and 1.00 regardless of the answer. The label
 * is the signal; these numbers exist so the aggregator and the trace have a
 * consistent scale, and they are honest about what they are.
 */
const CONFIDENCE = { VIOLATES: 0.9, COMPLIES: 0.9, UNCLEAR: 0.4 } as const;

function systemPrompt(rule: Rule, nonce: string): string {
  const shots = [
    ...rule.examples.violating.map((t) => `VIOLATES: ${t}`),
    ...rule.examples.compliant.map((t) => `COMPLIES: ${t}`)
  ].join('\n');

  return [
    'You check one message against one rule and label it.',
    '',
    `RULE: ${rule.text}`,
    '',
    'VIOLATES  - the message does what the rule prohibits.',
    'COMPLIES  - the message does not. Most messages comply, including ones that',
    '            touch the same topic without doing the prohibited thing.',
    'UNCLEAR   - genuinely cannot tell. Use this instead of guessing.',
    '',
    'Examples for this rule:',
    shots,
    '',
    isolationPreamble(nonce),
    '/no_think'
  ].join('\n');
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
      maxTokens: 96,
      // Keyed per rule: the system block (rule text plus its examples) is
      // identical on every call for that rule, so only the message needs
      // prefilling once the cache is warm.
      kvKey: `adjudicate:${rule.id}`,
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
    reason: res.value.reason
  };

  return {
    verdict,
    trace: {
      pass: `adjudicate:${rule.id}`,
      ms: Date.now() - started,
      verdict: label === 'VIOLATES'
        ? rule.severity === 'block' ? 'BLOCK' : 'ESCALATE'
        : label === 'UNCLEAR' ? 'ESCALATE' : 'ALLOW',
      detail: { label, reason: res.value.reason, repaired: res.repaired, ruleText: rule.text }
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
 * A rule whose adjudication fails does not sink the batch — it comes back as a
 * fail-closed trace, and the aggregator treats a missing verdict as ESCALATE.
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
          verdict: {
            ruleId: rule.id,
            violates: false,
            unclear: true,
            confidence: 0,
            reason: `adjudication failed: ${err instanceof Error ? err.message : String(err)}`
          } satisfies RuleVerdict,
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
    verdicts: settled.map((s) => s.verdict),
    traces: settled.map((s) => s.trace)
  };
}
