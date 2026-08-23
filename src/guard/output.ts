/**
 * The other half of the exchange: judging what the model said.
 *
 * `Rule.scope` has always had three values and `output` never did anything. The
 * rules that need it are the ones where the danger is in the answer rather than
 * the question — `r-legal-commitment` exists to catch the assistant committing
 * the company to something, and no phrasing of the employee's request tells you
 * whether it did.
 *
 * This is deliberately not `evaluate()` with a flag. The input path is the one
 * every measurement in this repo was taken against, and threading a second mode
 * through it would put every one of those numbers in question. It is also a
 * genuinely different job: no quota (the request paid on the way in), no
 * secret masking (rewriting what a person reads is a different feature), and a
 * different rule set by construction.
 *
 * What it shares is everything that decides: the same isolation envelope, the
 * same retrieval, the same one-narrow-question-per-rule adjudicator, and the
 * same `aggregate()` — so an output verdict is reached by the same code and can
 * only ever get stricter, exactly like an input one.
 */
import { recordDecision } from '../audit/log.js';
import { selectRules } from '../policy/index.js';
import { rulesForActor } from '../policy/store.js';
import type { PolicySpec } from '../policy/types.js';
import type { QvacAdapter } from '../qvac/types.js';
import { aggregate } from './aggregate.js';
import { isolate } from './isolate.js';
import { adjudicateAll } from './passes/adjudicate.js';
import type { Actor, Decision, PassTrace } from './types.js';

const TOP_K = Number(process.env['WARDEN_TOP_K'] ?? 3);

/**
 * Whether anything would judge this actor's answers.
 *
 * Asked before the response is relayed, because the answer decides whether the
 * gateway can stream. Screening and streaming are genuinely incompatible — you
 * cannot un-send a token — so a policy with no output rules keeps streaming
 * straight through, and one with them buys the check by waiting for the whole
 * answer. Nobody pays for a feature their policy does not use.
 */
export function screensOutput(policy: PolicySpec, actor: Actor): boolean {
  return rulesForActor(policy, actor, 'output').length > 0;
}

/**
 * Judge a model's answer against the output-scoped rules that bind this actor.
 *
 * Returns a full `Decision`, recorded in the audit log like any other — a
 * refused answer is a governance event, and the log storing the response's hash
 * rather than its text is the same trade it already makes for prompts.
 */
export async function screenOutput(
  qvac: QvacAdapter,
  args: { actor: Actor; text: string; policy: PolicySpec }
): Promise<Decision> {
  const { actor, text, policy } = args;
  const started = Date.now();
  const passes: PassTrace[] = [];

  // The model's answer is untrusted text too. It is the channel a document-borne
  // injection comes back out of, and it is the one an attacker controls when
  // they cannot reach the prompt.
  const isoStart = Date.now();
  const iso = isolate(text);
  passes.push({ pass: 'isolate:output', ms: Date.now() - isoStart, verdict: 'ALLOW', detail: iso.flags });

  const applicable = rulesForActor(policy, actor, 'output');
  const retrieveStart = Date.now();
  const selected = await selectRules(policy, applicable, iso.clean, TOP_K);
  passes.push({
    pass: 'retrieve:output',
    ms: Date.now() - retrieveStart,
    detail: {
      applicable: applicable.length,
      selected: selected.rules.map((r) => r.id),
      scores: selected.scores,
      degraded: selected.degraded
    }
  });

  const { verdicts, traces } = await adjudicateAll(qvac, iso, selected.rules);
  passes.push(...traces);

  /**
   * One interaction worth knowing about, because it is invisible from here.
   *
   * `structuralConcerns()` admits `hadMetaInstructions` only while a pinned rule
   * is in force — an admin who deletes the instruction-override rule expects the
   * behaviour to go with it. The rules handed over here are the output-scoped
   * ones, and the pinned rule in the shipped policy is scoped `input`, so that
   * signal is not admitted when judging an answer. That follows the same
   * reasoning rather than dodging it: the company scoped its override rule to
   * what employees send, so it has not asked for the signal on what the model
   * returns. Pinning an output-scoped rule turns it on.
   */
  const aggStart = Date.now();
  const result = aggregate({
    verdicts,
    rules: selected.rules,
    flags: iso.flags,
    expectedRuleIds: selected.rules.map((r) => r.id)
  });
  passes.push({
    pass: 'aggregate:output',
    ms: Date.now() - aggStart,
    verdict: result.verdict,
    detail: { fired: result.firedRules.length }
  });

  const partial = {
    verdict: result.verdict,
    policyVersion: policy.version,
    totalMs: Date.now() - started,
    firedRules: result.firedRules,
    passes,
    // The answer, not the prompt. Held on the live decision so the console's
    // trace can show what was judged; stripped before the log is written, by
    // the same line that has always stripped it.
    maskedPrompt: text,
    maskedSpans: [],
    explanation: result.explanation
  };

  const entry = recordDecision(actor, text, partial);
  return { ...partial, auditId: entry.auditId };
}
